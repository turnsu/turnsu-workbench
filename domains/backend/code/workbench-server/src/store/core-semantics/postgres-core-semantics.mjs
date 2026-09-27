import {
  canonicalRequestHash,
  formatSkillDraftEtag,
  formatWorkflowEtag,
} from "../serialization.mjs";

/**
 * PostgreSQL implementation of the narrow product-semantic surface used by
 * the characterization suite.  It is intentionally made of named product
 * operations, not a Mongo-to-SQL repository translator.  The only SQL access
 * is supplied by ProductPostgresStore.bindAdapter inside a UoW.
 */
export function createPostgresCoreSemantics({ store, principal, scopeId, clock = () => new Date().toISOString() }) {
  if (!store || typeof store.bindAdapter !== "function" || typeof store.withTransaction !== "function") {
    throw new TypeError("postgres_core_semantics_store_required");
  }
  if (!principal?.workspaceId || !principal?.userId || !scopeId) {
    throw new TypeError("postgres_core_semantics_principal_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, { text, values }); },
  }));
  const transact = (work) => store.withTransaction((uow) => work((text, values) => sql.query(uow, text, values)));
  const now = () => clock();
  const policyId = `${principal.workspaceId}-policy`;
  const grantId = `${principal.workspaceId}-grant`;

  const withReceipt = async ({ operationScope, idempotencyKey, request }, mutation) => transact(async (query) => {
    const requestHash = canonicalRequestHash(request);
    const existing = (await query(`
      SELECT request_hash, response
        FROM public.product_idempotency_receipts
       WHERE workspace_id = $1 AND effective_principal_id = $2
         AND operation_scope = $3 AND idempotency_key = $4
       FOR UPDATE
    `, [principal.workspaceId, principal.userId, operationScope, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) throw coded("idempotency_request_conflict");
      if (existing.response === null) throw coded("idempotency_record_incomplete");
      return existing.response;
    }
    const createdAt = now();
    await query(`
      INSERT INTO public.product_idempotency_receipts (
        workspace_id, effective_principal_id, operation_scope, idempotency_key,
        request_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [principal.workspaceId, principal.userId, operationScope, idempotencyKey, requestHash, createdAt]);
    const response = await mutation(query, createdAt);
    await query(`
      UPDATE public.product_idempotency_receipts
         SET response = $5::jsonb, completed_at = $6
       WHERE workspace_id = $1 AND effective_principal_id = $2
         AND operation_scope = $3 AND idempotency_key = $4
    `, [principal.workspaceId, principal.userId, operationScope, idempotencyKey, JSON.stringify(response), now()]);
    return response;
  });

  const readWorkflow = (query, workflowId, { lock = false } = {}) => query(`
    SELECT workflow_id, lifecycle, current_revision_id, current_revision_number, write_version,
           name, description, status, visibility
      FROM public.workflows
     WHERE workspace_id = $1 AND workflow_id = $2
     ${lock ? "FOR UPDATE" : ""}
  `, [principal.workspaceId, workflowId]).then(({ rows }) => rows[0] ?? null);
  const workflowView = (row) => ({
    workflow: {
      workflowId: row.workflow_id,
      lifecycle: row.lifecycle,
      currentRevisionId: row.current_revision_id,
      currentRevisionNumber: row.current_revision_number,
      name: row.name,
      description: row.description,
      status: row.status,
      visibility: row.visibility,
    },
    etag: formatWorkflowEtag({
      workflowId: row.workflow_id,
      writeVersion: row.write_version,
      currentRevisionId: row.current_revision_id,
    }),
  });
  const revisionView = (row) => ({
    revisionId: row.revision_id,
    workflowId: row.workflow_id,
    revisionNumber: Number(row.revision_number),
    baseRevisionId: row.base_revision_id,
    baseRevisionNumber: row.base_revision_number === null ? null : Number(row.base_revision_number),
    graph: row.graph,
    inputForm: row.input_form,
    outputDefinition: row.output_definition,
    resourceRefs: row.resource_refs,
    runSettings: row.run_settings,
    definition: row.definition,
  });

  // This is an explicit test-fixture helper, kept off the semantic port
  // returned below. Production composition must establish authority through
  // its own user/workspace provisioning path before it obtains this adapter.
  const ensureFoundation = async () => transact(async (query) => {
    const timestamp = iso((await query("SELECT clock_timestamp() AS now")).rows[0].now);
    await query(`INSERT INTO public.product_users (user_id, schema_version, display_name, created_at, updated_at)
      VALUES ($1, 'workbench-v1', 'Characterization user', $2, $2) ON CONFLICT (user_id) DO NOTHING`, [principal.userId, timestamp]);
    await query(`INSERT INTO public.product_workspaces (workspace_id, schema_version, name, created_by, created_at, updated_at)
      VALUES ($1, 'workbench-v1', 'Characterization workspace', $2, $3, $3) ON CONFLICT (workspace_id) DO NOTHING`, [principal.workspaceId, principal.userId, timestamp]);
    await query(`INSERT INTO public.workspace_memberships (membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at)
      VALUES ($1, $2, $3, 'workbench-v1', 'owner', $4, $4) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [`${principal.workspaceId}-membership`, principal.workspaceId, principal.userId, timestamp]);
    await query(`INSERT INTO public.workspace_principals (workspace_id, principal_id, principal_kind, user_id, membership_id, created_at, updated_at)
      VALUES ($1, $2, 'user', $2, $3, $4, $4) ON CONFLICT (workspace_id, principal_id) DO NOTHING`, [principal.workspaceId, principal.userId, `${principal.workspaceId}-membership`, timestamp]);
    await query("SET CONSTRAINTS ALL DEFERRED");
    await query(`INSERT INTO public.product_scopes (workspace_id, scope_id, schema_version, scope_kind, owner_user_id, owner_principal_id,
      current_policy_revision_id, created_by_principal_id, created_by_principal_kind, creation_mode, created_at, updated_at)
      VALUES ($1, $2, 'workbench-v1', 'personal', $3, $3, $4, $3, 'user', 'workspace_initial_seed', $5, $5)
      ON CONFLICT (workspace_id, scope_id) DO NOTHING`, [principal.workspaceId, scopeId, principal.userId, policyId, timestamp]);
    await query(`INSERT INTO public.scope_policy_revisions (workspace_id, scope_id, policy_revision_id, revision, observation_tier,
      permission_mode, policy_content_hash, created_by_principal_id, created_by_principal_kind, created_at)
      VALUES ($1, $2, $3, 1, 'private', 'interactive', $4, $5, 'user', $6)
      ON CONFLICT (workspace_id, scope_id, policy_revision_id) DO NOTHING`, [principal.workspaceId, scopeId, policyId,
      `sha256:${"a".repeat(64)}`, principal.userId, timestamp]);
    await query(`INSERT INTO public.scope_principal_grants (workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
      capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind, issuance_kind, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'user', 'operation', ARRAY['object.execute']::text[], true, $4, 'user', 'scope_creation', $5, $5)
      ON CONFLICT (workspace_id, grant_id) DO NOTHING`, [principal.workspaceId, scopeId, grantId, principal.userId, timestamp]);
  });

  const ledger = Object.freeze({
    async createSession(session) {
      await transact(async (query) => {
        await query(`
          INSERT INTO public.agent_sessions (
            session_id, workspace_id, user_id, schema_version, definition_id, scope_kind,
            source_kind, title, task_status, archived, status, model_preference_state,
            session_epoch, created_at, updated_at, payload
          ) VALUES ($1, $2, $3, 'workbench-v1', $4, 'main', 'manual', $5, $6, $7,
            'active', 'preference_only', $8, $9, $10, $11::jsonb)
          ON CONFLICT (session_id) DO NOTHING
        `, [session.sessionId, principal.workspaceId, principal.userId, session.definitionId,
          session.title, session.taskStatus, session.archived, session.sessionEpoch,
          session.createdAt, session.updatedAt, JSON.stringify(session)]);
      });
      return session;
    },
    async listSessions({ taskStatus, archived = false, cursor = null, limit = 100 } = {}) {
      const decoded = decodeCursor(cursor);
      const rows = await transact(async (query) => (await query(`
        SELECT session_id, task_status, archived, updated_at, created_at, payload
          FROM public.agent_sessions
         WHERE workspace_id = $1 AND user_id = $2
           AND ($3::text IS NULL OR task_status = $3) AND archived = $4
           AND ($5::timestamptz IS NULL OR (updated_at, session_id) < ($5::timestamptz, $6::text))
         ORDER BY updated_at DESC, session_id DESC
         LIMIT $7
      `, [principal.workspaceId, principal.userId, taskStatus ?? null, archived,
        decoded?.updatedAt ?? null, decoded?.id ?? null, Math.min(limit, 200) + 1])).rows);
      const page = rows.slice(0, limit).map((row) => ({
        ...(row.payload ?? {}), sessionId: row.session_id, taskStatus: row.task_status,
        archived: row.archived, updatedAt: iso(row.updated_at), createdAt: iso(row.created_at),
      }));
      page.page = { nextCursor: rows.length > limit ? encodeCursor({
        updatedAt: iso(rows[limit - 1].updated_at), id: rows[limit - 1].session_id,
      }) : null };
      return page;
    },
    async createTurn(turn) {
      return transact(async (query) => {
        const session = (await query(`
          UPDATE public.agent_sessions SET turn_sequence = turn_sequence + 1, updated_at = $3
           WHERE session_id = $1 AND workspace_id = $2
           RETURNING turn_sequence
        `, [turn.sessionId, principal.workspaceId, turn.queuedAt])).rows[0];
        if (!session) throw coded("agent_session_not_found");
        await query(`
          INSERT INTO public.agent_turns (
            turn_id, session_id, workspace_id, user_id, schema_version, kind, sequence, status,
            model_routing_state, session_epoch, turn_fence, queued_at, updated_at, payload
          ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'legacy_unpinned', $5, 'queued',
            'legacy_unpinned', $6, $7, $8, $8, $9::jsonb)
        `, [turn.turnId, turn.sessionId, principal.workspaceId, principal.userId,
          session.turn_sequence, turn.sessionEpoch, turn.turnFence, turn.queuedAt, JSON.stringify(turn)]);
        return { ...turn, sequence: Number(session.turn_sequence), requestedModelRevisionId: null };
      });
    },
    async appendEvent(sessionId, eventFactory) {
      return transact(async (query) => {
        const session = (await query(`
          UPDATE public.agent_sessions SET event_sequence = event_sequence + 1
           WHERE session_id = $1 AND workspace_id = $2 RETURNING event_sequence
        `, [sessionId, principal.workspaceId])).rows[0];
        if (!session) throw coded("agent_session_not_found");
        const event = eventFactory(Number(session.event_sequence));
        await query(`
          INSERT INTO public.agent_session_events (
            event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
          ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8, $9::jsonb)
        `, [event.eventId, sessionId, event.turnId, event.sequence, event.type, event.status,
          event.summary, event.occurredAt, JSON.stringify(event)]);
        return event;
      });
    },
    async listEvents(sessionId, { cursor = null, limit = 100 } = {}) {
      const decoded = decodeCursor(cursor);
      const rows = await transact(async (query) => (await query(`
        SELECT event_id, sequence, type, status, summary, occurred_at, payload
          FROM public.agent_session_events
         WHERE session_id = $1
           AND EXISTS (
             SELECT 1 FROM public.agent_sessions
              WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3
           )
           AND ($4::bigint IS NULL OR sequence > $4::bigint)
         ORDER BY sequence ASC LIMIT $5
      `, [sessionId, principal.workspaceId, principal.userId,
        decoded?.sequence ?? null, Math.min(limit, 200) + 1])).rows);
      const page = rows.slice(0, limit).map((row) => ({
        ...(row.payload ?? {}), eventId: row.event_id, sequence: Number(row.sequence), type: row.type,
        status: row.status, summary: row.summary, occurredAt: iso(row.occurred_at),
      }));
      page.page = { nextCursor: rows.length > limit ? encodeCursor({ sequence: Number(rows[limit - 1].sequence) }) : null };
      return page;
    },
    async claimNextTurn(sessionId, startedAt) {
      return transact(async (query) => {
        const session = (await query(`
          SELECT session_epoch FROM public.agent_sessions
           WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3
             AND status = 'active' AND active_turn_id IS NULL
           FOR UPDATE SKIP LOCKED
        `, [sessionId, principal.workspaceId, principal.userId])).rows[0];
        if (!session) return null;
        const queued = (await query(`
          SELECT turn_id, sequence, session_epoch, turn_fence, payload
            FROM public.agent_turns WHERE session_id = $1 AND workspace_id = $2 AND status = 'queued'
           ORDER BY sequence ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        `, [sessionId, principal.workspaceId])).rows[0];
        if (!queued) return null;
        const claimed = (await query(`
          UPDATE public.agent_turns SET status = 'running', started_at = $2, updated_at = $2
           WHERE turn_id = $1 AND workspace_id = $3 AND status = 'queued'
           RETURNING turn_id, sequence, session_epoch, turn_fence, payload
        `, [queued.turn_id, startedAt, principal.workspaceId])).rows[0];
        if (!claimed) return null;
        await query(`
          UPDATE public.agent_sessions SET active_turn_id = $2, task_status = 'running', updated_at = $3
           WHERE session_id = $1 AND workspace_id = $4 AND user_id = $5
        `, [sessionId, claimed.turn_id, startedAt, principal.workspaceId, principal.userId]);
        return {
          ...(claimed.payload ?? {}), turnId: claimed.turn_id, sequence: Number(claimed.sequence),
          sessionEpoch: claimed.session_epoch, turnFence: claimed.turn_fence,
          requestedModelRevisionId: null,
        };
      });
    },
    async settleTurn(input) {
      return transact(async (query) => {
        const turn = (await query(`
          SELECT session_id, payload FROM public.agent_turns
           WHERE turn_id = $1 AND session_epoch = $2 AND turn_fence = $3 AND status = 'running'
             AND workspace_id = $4
             AND EXISTS (
               SELECT 1 FROM public.agent_sessions
                WHERE session_id = public.agent_turns.session_id
                  AND workspace_id = $4 AND user_id = $5
             )
           FOR UPDATE
        `, [input.turnId, input.sessionEpoch, input.turnFence,
          principal.workspaceId, principal.userId])).rows[0];
        if (!turn) throw coded("agent_turn_terminal_transition_conflict");
        const session = (await query(`
          UPDATE public.agent_sessions
             SET active_turn_id = NULL, task_status = $2, message_sequence = message_sequence + 1,
                 event_sequence = event_sequence + 1, updated_at = $3
           WHERE session_id = $1 AND workspace_id = $4 AND user_id = $5
           RETURNING message_sequence, event_sequence
        `, [turn.session_id, input.status, input.finishedAt,
          principal.workspaceId, principal.userId])).rows[0];
        if (!session) throw coded("agent_session_not_found");
        await query(`
          UPDATE public.agent_turns SET status = $2, finished_at = $3, updated_at = $3
           WHERE turn_id = $1 AND workspace_id = $4
        `, [input.turnId, input.status, input.finishedAt, principal.workspaceId]);
        await query(`
          INSERT INTO public.agent_messages (
            message_id, session_id, turn_id, schema_version, sequence, role, kind, content, created_at, payload
          ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8, $9::jsonb)
        `, [input.message.messageId, turn.session_id, input.turnId, session.message_sequence,
          input.message.role, input.message.kind, input.message.content, input.message.createdAt, JSON.stringify(input.message)]);
        await query(`
          INSERT INTO public.agent_session_events (
            event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
          ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8, $9::jsonb)
        `, [input.event.eventId, turn.session_id, input.turnId, session.event_sequence,
          input.event.type, input.event.status, input.event.summary, input.event.occurredAt, JSON.stringify(input.event)]);
        return { ...(turn.payload ?? {}), turnId: input.turnId, status: input.status };
      });
    },
    async listTurns(sessionId, { after = 0, limit = 100 } = {}) {
      const rows = await transact(async (query) => (await query(`
        SELECT turn_id, sequence, status, session_epoch, turn_fence, payload
          FROM public.agent_turns WHERE session_id = $1 AND workspace_id = $2 AND sequence > $3
           AND EXISTS (
             SELECT 1 FROM public.agent_sessions
              WHERE session_id = $1 AND workspace_id = $2 AND user_id = $4
           )
         ORDER BY sequence ASC LIMIT $5
      `, [sessionId, principal.workspaceId, after, principal.userId,
        Math.min(limit, 200)])).rows);
      return rows.map((row) => ({
        ...(row.payload ?? {}), turnId: row.turn_id, sequence: Number(row.sequence), status: row.status,
        sessionEpoch: row.session_epoch, turnFence: row.turn_fence, requestedModelRevisionId: null,
      }));
    },
  });

  return Object.freeze({
    // Deprecated fixture hook; removed from production composition before the
    // PostgreSQL cutover. Characterization uses it only to establish an
    // isolated authenticated authority root.
    ensureFoundation,
    async createSkillDraft(input) {
      const response = await withReceipt({
        operationScope: "create-skill", idempotencyKey: input.idempotencyKey, request: input,
      }, async (query, timestamp) => {
        const definition = {
          skillDraftId: input.draftId ?? input.skillDraftId,
          skillId: input.skillId,
          name: input.name,
          description: input.description,
          category: "characterization",
          inputSchema: { materials: [], parameters: [] },
          outputSchema: { fields: [] }, risk: {}, dependencies: [], connectionRequirements: [], files: [],
        };
        const draftId = definition.skillDraftId;
        const contentHash = canonicalRequestHash(definition);
        await query("SET CONSTRAINTS ALL DEFERRED");
        await query(`
          INSERT INTO public.skill_assets (
            workspace_id, skill_id, scope_id, owner_user_id, schema_version, name_normalized,
            visibility, lifecycle, current_draft_id, created_at, updated_at, payload
          ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, 'private', 'draft', $6, $7, $7, $8::jsonb)
        `, [principal.workspaceId, input.skillId, scopeId, principal.userId,
          input.name.toLowerCase(), draftId, timestamp, JSON.stringify({ name: input.name })]);
        await query(`
          INSERT INTO public.skill_drafts (
            workspace_id, skill_draft_id, skill_id, schema_version, draft_revision, content_hash,
            updated_by, created_at, updated_at, definition, payload
          ) VALUES ($1, $2, $3, 'workbench-v1', 1, $4, $5, $6, $6, $7::jsonb, '{}'::jsonb)
        `, [principal.workspaceId, draftId, input.skillId, contentHash, principal.userId, timestamp, JSON.stringify(definition)]);
        await query(`
          INSERT INTO public.skill_draft_revision_snapshots (
            workspace_id, skill_id, skill_draft_id, draft_revision, schema_version, content_hash,
            created_by, created_at, definition
          ) VALUES ($1, $2, $3, 1, 'workbench-internal-v1', $4, $5, $6, $7::jsonb)
        `, [principal.workspaceId, input.skillId, draftId, contentHash, principal.userId, timestamp, JSON.stringify(definition)]);
        return { draft: { skillDraftId: draftId, revision: 1, description: input.description } };
      });
      return response;
    },
    async applySkillDraftDecision(input) {
      return withReceipt({
        operationScope: "characterization-proposal-decision", idempotencyKey: input.commandKey, request: input,
      }, async (query, timestamp) => {
        const row = (await query(`
          SELECT draft_revision, definition FROM public.skill_drafts
           WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 FOR UPDATE
        `, [principal.workspaceId, input.skillId, input.draftId])).rows[0];
        if (!row) throw coded("skill_draft_not_found");
        const nextRevision = Number(row.draft_revision) + 1;
        const definition = { ...(row.definition ?? {}), description: input.description };
        const contentHash = canonicalRequestHash(definition);
        await query(`
          UPDATE public.skill_drafts SET draft_revision = $4, definition = $5::jsonb,
            content_hash = $6, updated_by = $7, updated_at = $8
           WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3
        `, [principal.workspaceId, input.skillId, input.draftId, nextRevision,
          JSON.stringify(definition), contentHash, principal.userId, timestamp]);
        await query(`
          INSERT INTO public.skill_draft_revision_snapshots (
            workspace_id, skill_id, skill_draft_id, draft_revision, schema_version, content_hash,
            created_by, created_at, definition
          ) VALUES ($1, $2, $3, $4, 'workbench-internal-v1', $5, $6, $7, $8::jsonb)
        `, [principal.workspaceId, input.skillId, input.draftId, nextRevision, contentHash,
          principal.userId, timestamp, JSON.stringify(definition)]);
        if (input.forceRollback) throw coded("characterization_forced_rollback");
        return { draft: { skillDraftId: input.draftId, revision: nextRevision, description: input.description } };
      });
    },
    async getSkillDraft({ skillId, draftId }) {
      return transact(async (query) => {
        const row = (await query(`
          SELECT skill_draft_id, draft_revision, definition FROM public.skill_drafts
           WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3
        `, [principal.workspaceId, skillId, draftId])).rows[0];
        if (!row) throw coded("skill_draft_not_found");
        return { draft: { skillDraftId: row.skill_draft_id, revision: Number(row.draft_revision), description: row.definition.description } };
      });
    },
    async createLoop(input) {
      const workflowId = semanticId("workflow", input.idempotencyKey);
      const revisionId = semanticId("revision", input.idempotencyKey);
      return withReceipt({ operationScope: "create-loop", idempotencyKey: input.idempotencyKey, request: input }, async (query, timestamp) => {
        const revision = initialRevision({ workflowId, revisionId, definition: input.definition });
        await query("SET CONSTRAINTS ALL DEFERRED");
        await query(`
          INSERT INTO public.workflows (
            workspace_id, workflow_id, scope_id, owner_user_id, schema_version, name, description,
            status, lifecycle, visibility, current_revision_id, current_revision_number, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, 'draft', 'draft', 'private', $7, 1, $8, $8)
        `, [principal.workspaceId, workflowId, scopeId, principal.userId, input.name, input.description, revisionId, timestamp]);
        await insertRevision(query, principal, revision, timestamp);
        return {
          workflow: { workflowId, lifecycle: "draft", currentRevisionId: revisionId },
          revision,
        };
      });
    },
    async getLoop(workflowId) {
      return transact(async (query) => {
        const row = await readWorkflow(query, workflowId);
        if (!row) throw coded("workflow_not_found");
        return workflowView(row);
      });
    },
    async listLoops() {
      return transact(async (query) => (await query(`
        SELECT workflow_id, lifecycle, current_revision_id, current_revision_number, write_version,
               name, description, status, visibility
          FROM public.workflows WHERE workspace_id = $1 ORDER BY workflow_id ASC LIMIT 10
      `, [principal.workspaceId])).rows.map((row) => workflowView(row).workflow));
    },
    async listLoopRevisions(workflowId) {
      return transact(async (query) => (await query(`
        SELECT revision_id, workflow_id, revision_number, base_revision_id, base_revision_number,
               graph, input_form, output_definition, resource_refs, run_settings, definition
          FROM public.workflow_revisions
         WHERE workspace_id = $1 AND workflow_id = $2 ORDER BY revision_number ASC
      `, [principal.workspaceId, workflowId])).rows.map(revisionView));
    },
    async saveLoopRevision(input) {
      return withReceipt({ operationScope: "save-loop-revision", idempotencyKey: input.idempotencyKey, request: input }, async (query, timestamp) => {
        const workflow = await readWorkflow(query, input.workflowId, { lock: true });
        if (!workflow) throw coded("workflow_not_found");
        const current = workflowView(workflow);
        if (current.etag !== input.ifMatch) throw coded("workflow_revision_conflict");
        const revision = {
          revisionId: input.revisionId,
          workflowId: input.workflowId,
          revisionNumber: Number(workflow.current_revision_number) + 1,
          baseRevisionId: workflow.current_revision_id,
          baseRevisionNumber: Number(workflow.current_revision_number),
          graph: input.request.graph,
          inputForm: input.request.inputForm,
          outputDefinition: input.request.outputDefinition,
          resourceRefs: input.request.resourceRefs,
          runSettings: input.request.runSettings,
          definition: input.request.definition,
        };
        await insertRevision(query, principal, revision, timestamp, input.request.saveReason);
        const nextWriteVersion = Number(workflow.write_version) + 1;
        await query(`
          UPDATE public.workflows SET current_revision_id = $3, current_revision_number = $4,
            write_version = $5, updated_at = $6
           WHERE workspace_id = $1 AND workflow_id = $2
        `, [principal.workspaceId, input.workflowId, revision.revisionId, revision.revisionNumber,
          nextWriteVersion, timestamp]);
        return {
          revision,
          etag: formatWorkflowEtag({ workflowId: input.workflowId, writeVersion: nextWriteVersion, currentRevisionId: revision.revisionId }),
        };
      });
    },
    ledger,
    // Run control is filled by the G3A adapter below; keeping it under the
    // same semantic object prevents a test-only facade from bypassing the
    // ProductPostgresStore UoW boundary.
    runControl: createPostgresRunControl({ transact, principal, scopeId, now }),
  });
}

function initialRevision({ workflowId, revisionId, definition }) {
  return {
    revisionId, workflowId, revisionNumber: 1, baseRevisionId: null, baseRevisionNumber: null,
    graph: {}, inputForm: {}, outputDefinition: {}, resourceRefs: [], runSettings: {}, definition,
  };
}

async function insertRevision(query, principal, revision, timestamp, saveReason = "Characterization canonical mutation.") {
  const contentHash = canonicalRequestHash({
    ...revision, revisionId: undefined, createdAt: undefined, updatedAt: undefined,
  });
  await query(`
    INSERT INTO public.workflow_revisions (
      workspace_id, revision_id, workflow_id, revision_number, base_revision_id, base_revision_number,
      schema_version, graph, input_form, output_definition, resource_refs, run_settings, definition,
      content_hash, authored_by, save_reason, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'workbench-v1', $7::jsonb, $8::jsonb, $9::jsonb,
      $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $16)
  `, [principal.workspaceId, revision.revisionId, revision.workflowId, revision.revisionNumber,
    revision.baseRevisionId, revision.baseRevisionNumber, JSON.stringify(revision.graph),
    JSON.stringify(revision.inputForm), JSON.stringify(revision.outputDefinition),
    JSON.stringify(revision.resourceRefs), JSON.stringify(revision.runSettings), JSON.stringify(revision.definition),
    contentHash, principal.userId, saveReason, timestamp]);
}

function createPostgresRunControl({ transact, principal, scopeId, now }) {
  const policyId = `${principal.workspaceId}-policy`;
  const grantId = `${principal.workspaceId}-grant`;
  const ensureExecution = async (query, runId, state = "queued") => {
    const sessionId = semanticId("execution-session", runId);
    const commandId = semanticId("execution-command", runId);
    const decisionId = semanticId("execution-decision", runId);
    const approvalId = semanticId("execution-approval", runId);
    const attemptId = semanticId("execution-attempt", runId);
    const admissionId = semanticId("execution-admission", runId);
    const capacityId = semanticId("execution-capacity", runId);
    const capabilityId = semanticId("execution-capability", runId);
    const timestamp = iso((await query("SELECT clock_timestamp() AS now")).rows[0].now);
    const expiry = plusMilliseconds(timestamp, 60_000);
    const digest = canonicalRequestHash({ runId, operation: "characterization-execution" });
    await query("SET CONSTRAINTS ALL DEFERRED");
    await query(`
      INSERT INTO public.agent_sessions (
        session_id, workspace_id, user_id, schema_version, definition_id, scope_kind,
        source_kind, title, task_status, archived, status, model_preference_state,
        session_epoch, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, 'workbench-v1', 'main', 'main', 'manual',
        'Execution characterization', 'queued', false, 'active', 'legacy_unpinned',
        1, $4, $4, '{}'::jsonb)
      ON CONFLICT (session_id) DO NOTHING
    `, [sessionId, principal.workspaceId, principal.userId, timestamp]);
    await insertAuthorizationDecision(query, {
      workspaceId: principal.workspaceId, scopeId, policyId, grantId,
      userId: principal.userId, approvalId, decisionId, actionId: "agent_turn", digest, timestamp,
    });
    await query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind, authorization_decision_id,
        policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
        kind, session_id, turn_id, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
        'workbench-v1', 'agent_turn', $8, $9, 'accepted', $10, $10)
      ON CONFLICT (command_id) DO NOTHING
    `, [commandId, principal.workspaceId, scopeId, principal.userId, decisionId, policyId,
      digest, sessionId, runId, timestamp]);
    await query(`
      INSERT INTO public.agent_turns (
        turn_id, session_id, workspace_id, user_id, schema_version, product_command_id,
        kind, sequence, status, model_routing_state, session_epoch, turn_fence,
        queued_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, 'legacy_unpinned', 1, 'queued',
        'legacy_unpinned', 1, 1, $6, $6, '{}'::jsonb)
      ON CONFLICT (turn_id) DO NOTHING
    `, [runId, sessionId, principal.workspaceId, principal.userId, commandId, timestamp]);
    await query(`
      INSERT INTO public.admission_waiting (
        admission_id, command_id, workspace_id, schema_version, kind, invocation_id,
        state, created_at, updated_at
      ) VALUES ($1, $2, $3, 'workbench-v1', 'execution_invocation', $4,
        'waiting_capacity', $5, $5)
      ON CONFLICT (admission_id) DO NOTHING
    `, [admissionId, commandId, principal.workspaceId, runId, timestamp]);
    await query(`
      INSERT INTO public.capacity_leases (
        capacity_lease_id, admission_id, command_id, workspace_id, schema_version,
        backend_key, provider_key, fence, lease_duration_ms, status, issued_at,
        expires_at, updated_at, dimensions
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'deterministic_skill:process',
        'provider:none', 1, 60000, 'active', $5, $6, $5, '[]'::jsonb)
      ON CONFLICT (capacity_lease_id) DO NOTHING
    `, [capacityId, admissionId, commandId, principal.workspaceId, timestamp, expiry]);
    await query(`
      INSERT INTO public.execution_invocations (
        invocation_id, workspace_id, schema_version, attempt_id, product_command_id,
        lineage_session_id, lineage_turn_id, controller_kind, controller_id, controller_fence,
        mode, isolation, status, execution_fence, capacity_admission_id, capacity_lease_id,
        capacity_fence, capacity_backend_key, capacity_provider_key, capability_lease_id,
        started_at, created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-execution-fabric-v1', $3, $4, $5, $1,
        'agent_turn', $1, 0, 'deterministic_skill', 'process', $6, 0, $7, $8, 1,
        'deterministic_skill:process', 'provider:none', $9,
        CASE WHEN $6 = 'running' THEN $10::timestamptz ELSE NULL END, $10, $10, '{}'::jsonb)
      ON CONFLICT (invocation_id) DO NOTHING
    `, [runId, principal.workspaceId, attemptId, commandId, sessionId, state,
      admissionId, capacityId, capabilityId, timestamp]);
    await query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number, status, fence,
        started_at, created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-execution-fabric-v1', 1, $3, 0,
        CASE WHEN $3 = 'running' THEN $4::timestamptz ELSE NULL END, $4, $4, '{}'::jsonb)
      ON CONFLICT (attempt_id) DO NOTHING
    `, [attemptId, runId, state, timestamp]);
    await query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id, schema_version,
        fence, status, issued_at, expires_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'workbench-execution-fabric-v1', 0, 'active', $5, $6, $5, '{}'::jsonb)
      ON CONFLICT (capability_lease_id) DO NOTHING
    `, [capabilityId, runId, attemptId, principal.workspaceId, timestamp, expiry]);
  };

  const executionRow = (query, runId, lock = false) => query(`
    SELECT invocation_id, attempt_id, status, execution_fence, capability_lease_id,
           payload, updated_at
      FROM public.execution_invocations
     WHERE workspace_id = $1 AND invocation_id = $2
     ${lock ? "FOR UPDATE" : ""}
  `, [principal.workspaceId, runId]).then(({ rows }) => rows[0] ?? null);
  const runJobView = (row) => ({
    status: row.status, fence: Number(row.execution_fence),
    leaseOwner: row.payload?.leaseOwner ?? null,
  });

  return Object.freeze({
    async createRunJob(job) {
      await transact((query) => ensureExecution(query, job.runId, "queued"));
      return this.getRunJob(job.runId);
    },
    async createRun(run) {
      await transact((query) => ensureExecution(query, run.runId, "running"));
      return this.getRun(run.runId);
    },
    async claimRunJob(runId, { workerId, now: claimedAt, leaseExpiresAt }) {
      return transact(async (query) => {
        await ensureExecution(query, runId, "queued");
        const current = await executionRow(query, runId, true);
        const lease = (await query(`
          SELECT capability_lease_id, fence, status, expires_at
            FROM public.capability_leases
           WHERE capability_lease_id = $1 FOR UPDATE
        `, [current.capability_lease_id])).rows[0];
        if (!lease || !["queued", "running"].includes(current.status)
          || (current.status === "running"
            && new Date(current.payload?.logicalLeaseExpiresAt ?? lease.expires_at) > new Date(claimedAt))) {
          return null;
        }
        const databaseTimestamp = await databaseNow(query);
        const effectiveClaimedAt = current.status === "running"
          ? laterTimestamp(databaseTimestamp, plusMilliseconds(iso(lease.expires_at), 1))
          : databaseTimestamp;
        const leaseDuration = Math.max(1, Date.parse(leaseExpiresAt) - Date.parse(claimedAt));
        const effectiveLeaseExpiresAt = plusMilliseconds(effectiveClaimedAt, leaseDuration);
        const nextFence = Number(current.execution_fence) + 1;
        const nextAttemptId = semanticId("execution-attempt", `${runId}:${nextFence}`);
        const nextCapabilityId = semanticId("execution-capability", `${runId}:${nextFence}`);
        const payload = {
          ...(current.payload ?? {}), leaseOwner: workerId, logicalLeaseExpiresAt: leaseExpiresAt,
        };
        await query(`
          UPDATE public.execution_attempts SET status = 'timeout', finished_at = $2, updated_at = $2
           WHERE attempt_id = $1 AND status IN ('queued', 'running')
        `, [current.attempt_id, effectiveClaimedAt]);
        await query(`
          UPDATE public.capability_leases SET status = 'expired', updated_at = $2
           WHERE capability_lease_id = $1 AND status = 'active'
        `, [current.capability_lease_id, effectiveClaimedAt]);
        await query(`
          INSERT INTO public.execution_attempts (
            attempt_id, invocation_id, schema_version, attempt_number, status, fence,
            started_at, created_at, updated_at, payload
          ) VALUES ($1, $2, 'workbench-execution-fabric-v1', $3, 'running', $3, $4, $4, $4, '{}'::jsonb)
        `, [nextAttemptId, runId, nextFence + 1, effectiveClaimedAt]);
        await query(`
          INSERT INTO public.capability_leases (
            capability_lease_id, invocation_id, attempt_id, workspace_id, schema_version,
            fence, status, issued_at, expires_at, updated_at, payload
          ) VALUES ($1, $2, $3, $4, 'workbench-execution-fabric-v1', $5, 'active', $6, $7, $6, $8::jsonb)
        `, [nextCapabilityId, runId, nextAttemptId, principal.workspaceId, nextFence,
          effectiveClaimedAt, effectiveLeaseExpiresAt, JSON.stringify({ workerId })]);
        const updated = (await query(`
          UPDATE public.execution_invocations
             SET attempt_id = $3, capability_lease_id = $4, status = 'running',
                 execution_fence = $5, started_at = coalesce(started_at, $6), updated_at = $6,
                 payload = $7::jsonb
           WHERE workspace_id = $1 AND invocation_id = $2
           RETURNING invocation_id, attempt_id, status, execution_fence, capability_lease_id, payload, updated_at
        `, [principal.workspaceId, runId, nextAttemptId, nextCapabilityId, nextFence,
          effectiveClaimedAt, JSON.stringify(payload)])).rows[0];
        return runJobView(updated);
      });
    },
    async acquireLease({ runId, workerId, fence }) {
      return transact(async (query) => {
        const row = await executionRow(query, runId);
        if (!row || row.execution_fence !== fence || row.payload?.leaseOwner !== workerId) return null;
        const lease = (await query(`SELECT status FROM public.capability_leases WHERE capability_lease_id = $1`, [row.capability_lease_id])).rows[0];
        return lease?.status === "active" ? { status: "active", workerId, fence } : null;
      });
    },
    async abandonRunJob(runId, { workerId, fence, now: abandonedAt }) {
      return transact(async (query) => {
        const row = await executionRow(query, runId, true);
        if (!row || row.status !== "running" || Number(row.execution_fence) !== fence || row.payload?.leaseOwner !== workerId) return null;
        const timestamp = laterTimestamp(await databaseNow(query), iso(row.updated_at));
        await query(`UPDATE public.capability_leases SET status = 'revoked', revoked_at = $2, updated_at = $2
          WHERE capability_lease_id = $1 AND status = 'active'`, [row.capability_lease_id, timestamp]);
        const updated = (await query(`UPDATE public.execution_invocations
          SET status = 'queued', payload = (payload - 'leaseOwner' - 'logicalLeaseExpiresAt'), updated_at = $3
          WHERE workspace_id = $1 AND invocation_id = $2
          RETURNING invocation_id, attempt_id, status, execution_fence, capability_lease_id, payload, updated_at`,
        [principal.workspaceId, runId, timestamp])).rows[0];
        return runJobView(updated);
      });
    },
    async assertActiveFence(runId, { workerId, fence, now: checkedAt }) {
      return transact(async (query) => {
        const row = await executionRow(query, runId);
        if (!row || row.status !== "running" || Number(row.execution_fence) !== fence || row.payload?.leaseOwner !== workerId) return null;
        const lease = (await query(`
          SELECT status, expires_at FROM public.capability_leases WHERE capability_lease_id = $1
        `, [row.capability_lease_id])).rows[0];
        return lease?.status === "active"
          && new Date(row.payload?.logicalLeaseExpiresAt ?? lease.expires_at) > new Date(checkedAt)
          ? { fence } : null;
      });
    },
    async heartbeatLease(runId, { workerId, fence, heartbeatAt, expiresAt }) {
      return transact(async (query) => {
        const row = await executionRow(query, runId, true);
        if (!row || row.status !== "running" || Number(row.execution_fence) !== fence
          || row.payload?.leaseOwner !== workerId
          || new Date(row.payload?.logicalLeaseExpiresAt ?? 0) <= new Date(heartbeatAt)) {
          return null;
        }
        const lease = (await query(`
          SELECT status FROM public.capability_leases
           WHERE capability_lease_id = $1 FOR UPDATE
        `, [row.capability_lease_id])).rows[0];
        if (lease?.status !== "active") return null;
        const timestamp = laterTimestamp(await databaseNow(query), iso(row.updated_at));
        const duration = Math.max(1, Date.parse(expiresAt) - Date.parse(heartbeatAt));
        const updated = (await query(`
          UPDATE public.capability_leases SET expires_at = $2, updated_at = $3
           WHERE capability_lease_id = $1 AND status = 'active'
           RETURNING capability_lease_id
        `, [row.capability_lease_id, plusMilliseconds(timestamp, duration), timestamp])).rows[0];
        return updated ? { workerId, fence, status: "active" } : null;
      });
    },
    async finishRunJob(runId, { workerId, fence, status, now: finishedAt }) {
      return transact(async (query) => {
        const row = await executionRow(query, runId, true);
        if (!row || row.status !== "running" || Number(row.execution_fence) !== fence || row.payload?.leaseOwner !== workerId) return null;
        const lease = (await query(`SELECT status, expires_at FROM public.capability_leases WHERE capability_lease_id = $1 FOR UPDATE`, [row.capability_lease_id])).rows[0];
        if (!lease || lease.status !== "active") return null;
        const timestamp = laterTimestamp(await databaseNow(query), iso(row.updated_at));
        await query(`UPDATE public.execution_attempts SET status = $2, finished_at = $3, updated_at = $3 WHERE attempt_id = $1`, [row.attempt_id, status, timestamp]);
        await query(`UPDATE public.capability_leases SET status = 'revoked', revoked_at = $2, updated_at = $2 WHERE capability_lease_id = $1`, [row.capability_lease_id, timestamp]);
        const updated = (await query(`
          UPDATE public.execution_invocations SET status = $3, finished_at = $4, updated_at = $4
           WHERE workspace_id = $1 AND invocation_id = $2
           RETURNING invocation_id, attempt_id, status, execution_fence, capability_lease_id, payload, updated_at
        `, [principal.workspaceId, runId, status, timestamp])).rows[0];
        return runJobView(updated);
      });
    },
    async releaseLease(runId, { workerId, fence, releasedAt }) {
      return transact(async (query) => {
        const row = await executionRow(query, runId, true);
        if (!row || Number(row.execution_fence) !== fence || row.payload?.leaseOwner !== workerId) return null;
        const timestamp = laterTimestamp(await databaseNow(query), iso(row.updated_at));
        const lease = (await query(`
          UPDATE public.capability_leases SET status = 'revoked', revoked_at = $2, updated_at = $2
           WHERE capability_lease_id = $1 AND status = 'active'
           RETURNING capability_lease_id
        `, [row.capability_lease_id, timestamp])).rows[0];
        await query(`
          UPDATE public.execution_invocations
             SET payload = (payload - 'leaseOwner' - 'logicalLeaseExpiresAt'), updated_at = $3
           WHERE workspace_id = $1 AND invocation_id = $2
        `, [principal.workspaceId, runId, timestamp]);
        return lease ? { status: "released", workerId, fence } : { status: "released", workerId, fence };
      });
    },
    async getRunJob(runId) {
      return transact(async (query) => {
        const row = await executionRow(query, runId);
        return row ? runJobView(row) : null;
      });
    },
    async appendRunEvent(event) {
      return transact(async (query) => {
        await ensureExecution(query, event.runId, "running");
        const invocation = await executionRow(query, event.runId, true);
        const timestamp = await databaseNow(query);
        const sequence = Number(invocation.execution_fence) >= 0
          ? (await query(`
              UPDATE public.execution_invocations SET event_sequence = event_sequence + 1, updated_at = $3
               WHERE workspace_id = $1 AND invocation_id = $2 RETURNING event_sequence, attempt_id
            `, [principal.workspaceId, event.runId, timestamp])).rows[0]
          : null;
        const appended = { ...event, sequence: Number(sequence.event_sequence) };
        await query(`
          INSERT INTO public.execution_events (
            event_id, invocation_id, attempt_id, schema_version, sequence, type, status, occurred_at, payload
          ) VALUES ($1, $2, $3, 'workbench-execution-fabric-v1', $4, $5, $6, $7, $8::jsonb)
        `, [event.eventId, event.runId, sequence.attempt_id, appended.sequence,
          event.type, event.status, timestamp, JSON.stringify(event)]);
        return appended;
      });
    },
    async listRunEvents(runId) {
      return transact(async (query) => (await query(`
        SELECT event_id, sequence, type, status, occurred_at, payload
          FROM public.execution_events
         WHERE invocation_id = $1
           AND EXISTS (
             SELECT 1 FROM public.execution_invocations
              WHERE invocation_id = $1 AND workspace_id = $2
           )
         ORDER BY sequence ASC
      `, [runId, principal.workspaceId])).rows.map((row) => ({
        ...(row.payload ?? {}), eventId: row.event_id, sequence: Number(row.sequence),
        type: row.type, status: row.status, occurredAt: iso(row.occurred_at),
      })));
    },
    async getRun(runId) {
      return transact(async (query) => {
        const row = await executionRow(query, runId);
        return row ? { status: row.status } : null;
      });
    },
  });
}

async function insertAuthorizationDecision(query, {
  workspaceId, scopeId, policyId, grantId, userId, approvalId, decisionId, actionId, digest, timestamp,
}) {
  const expiry = plusMilliseconds(timestamp, 60 * 60_000);
  await query(`
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest,
      permission_mode, destructive_rule_version, disposition, approval_id,
      reason_code, decided_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
      'principal', $5, 'user', $6, $7, 'execute', $8,
      'interactive', 'authority-v1', 'approval_required', $2,
      'approval_required', $9, $10)
    ON CONFLICT (workspace_id, authorization_decision_id) DO NOTHING
  `, [workspaceId, approvalId, scopeId, policyId, userId, grantId, actionId, digest, timestamp, expiry]);
  await query(`
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest,
      permission_mode, destructive_rule_version, disposition, approval_id,
      reason_code, decided_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
      'principal', $5, 'user', $6, $7, 'execute', $8,
      'interactive', 'authority-v1', 'authorized', $9,
      'approved', $10, $11)
    ON CONFLICT (workspace_id, authorization_decision_id) DO NOTHING
  `, [workspaceId, decisionId, scopeId, policyId, userId, grantId, actionId, digest,
    approvalId, timestamp, expiry]);
}

function semanticId(prefix, value) {
  return `${prefix}-${canonicalRequestHash(String(value)).slice(7, 39)}`;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw coded("agent_cursor_invalid"); }
}

function iso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

function plusMilliseconds(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function databaseNow(query) {
  const row = (await query("SELECT clock_timestamp() AS now")).rows[0];
  return iso(row.now);
}

function laterTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
