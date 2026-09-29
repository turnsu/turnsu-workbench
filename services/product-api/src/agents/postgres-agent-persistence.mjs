import {
  agentSessionQueryFingerprint,
  assertSettlementProposal,
  decodeAgentCursor,
  decodeAgentSessionCursor,
  encodeAgentCursor,
  pagedAgentItems,
  publicSession,
  publicTurn,
} from "./agent-persistence.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);
const MAX_WAITING_TURNS_PER_USER = 3;

// Private navigation context comes from the existing continuation relation.
// It confers no shared-work access; each Work Item read/write checks its grant.
const SESSION_WITH_WORK_CONTEXT = `agent_sessions.*, (
  SELECT jsonb_build_object('workItemId', continuation.work_item_id,
    'continuationId', continuation.continuation_id)
  FROM public.work_item_continuations continuation
  WHERE continuation.workspace_id = agent_sessions.workspace_id
    AND continuation.agent_session_id = agent_sessions.session_id
    AND continuation.user_id = agent_sessions.user_id
) AS work_item_context`;

/**
 * PostgreSQL owner for the Agent session ledger.  The public surface is the
 * existing AgentPersistence semantic contract: it deliberately exposes no
 * repository, collection or raw SQL capability to AgentTurnRunner.
 */
export class PostgresAgentPersistence {
  #store;
  #commandIntake;
  #sql;
  #clock;
  #recoveryCancellationIntents = [];

  constructor({ store, commandIntake, clock = () => new Date().toISOString() } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_agent_persistence_store_required");
    }
    for (const method of ["accept", "start", "settle", "acceptCancellation", "requeue"]) {
      if (typeof commandIntake?.[method] !== "function") {
        throw new TypeError("postgres_agent_persistence_command_intake_required");
      }
    }
    if (typeof clock !== "function") throw new TypeError("postgres_agent_persistence_clock_invalid");
    this.#store = store;
    this.#commandIntake = commandIntake;
    this.#clock = clock;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async findSession(query) {
    return this.#transact(async (sql) => sessionView((await sql(`
      SELECT * FROM public.agent_sessions
       WHERE workspace_id = $1 AND user_id = $2 AND definition_id = $3
         AND scope_kind = $4 AND status = 'active'
         AND ($5::text IS NULL OR object_kind = $5)
         AND ($6::text IS NULL OR object_id = $6)
         AND ($7::text IS NULL OR branch_id = $7)
       ORDER BY updated_at DESC, created_at DESC, session_id DESC LIMIT 1
    `, [query.workspaceId, query.userId, query.definitionId, query.scope.kind,
      query.scope.objectKind ?? null, query.scope.objectId ?? null, query.scope.branchId ?? null])).rows[0]));
  }

  async createBranch(branch, options = {}) {
    return this.#transact(async (sql) => {
      await sql(`
        INSERT INTO public.agent_branches (
          branch_id, workspace_id, user_id, schema_version, object_kind, object_id,
          base_version_id, status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7,
          $8::timestamptz, $9::timestamptz, $10::jsonb)
        ON CONFLICT (branch_id) DO NOTHING
      `, [branch.branchId, branch.workspaceId, branch.userId, branch.objectKind, branch.objectId,
        branch.baseVersionId, branch.status, branch.createdAt, branch.updatedAt, JSON.stringify(branch)]);
      return branchView((await sql("SELECT * FROM public.agent_branches WHERE branch_id = $1", [branch.branchId])).rows[0]);
    }, options.uow);
  }

  async createModuleSession(branch, agentSession, options = {}) {
    return this.#transact(async (sql) => {
      const existing = await this.#findModuleSession(sql, agentSession);
      if (existing) return sessionView(existing);
      await sql(`
        INSERT INTO public.agent_branches (
          branch_id, workspace_id, user_id, schema_version, object_kind, object_id,
          base_version_id, status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7,
          $8::timestamptz, $9::timestamptz, $10::jsonb)
        ON CONFLICT (branch_id) DO NOTHING
      `, [branch.branchId, branch.workspaceId, branch.userId, branch.objectKind, branch.objectId,
        branch.baseVersionId, branch.status, branch.createdAt, branch.updatedAt, JSON.stringify(branch)]);
      return sessionView(await this.#insertSession(sql, agentSession));
    }, options.uow);
  }

  async createSession(session, options = {}) {
    return this.#transact(async (sql) => {
      const existing = session.source?.kind === "loop_run"
        ? (await sql(`SELECT * FROM public.agent_sessions
             WHERE workspace_id = $1 AND source_run_id = $2 LIMIT 1`,
          [session.workspaceId, session.source.runId])).rows[0]
        : (await sql("SELECT * FROM public.agent_sessions WHERE session_id = $1 LIMIT 1", [session.sessionId])).rows[0];
      if (existing) return sessionView(existing);
      return sessionView(await this.#insertSession(sql, session));
    }, options.uow);
  }

  async listSessions({
    definitionId, taskStatus, search, archived = false, projectLoopTaskStatus = false, cursor, limit = 100,
  } = {}, access = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const fingerprint = agentSessionQueryFingerprint({ definitionId, taskStatus, search, archived, projectLoopTaskStatus }, access);
    const decoded = decodeAgentSessionCursor(cursor, fingerprint);
    const snapshotAt = decoded?.snapshotAt ?? iso(this.#clock());
    const normalizedSearch = String(search ?? "").trim() || null;
    return this.#transact(async (sql) => {
      if (decoded) {
        const changed = (await sql(`
          SELECT 1 FROM public.agent_sessions
           WHERE workspace_id = $1 AND user_id = $2
             AND created_at <= $3::timestamptz AND updated_at >= $3::timestamptz LIMIT 1
        `, [access.workspaceId, access.userId, snapshotAt])).rows[0];
        if (changed) throw cursorError("agent_cursor_stale", "cursor_stale", true);
      }
      const rows = (await sql(`
        SELECT ${SESSION_WITH_WORK_CONTEXT} FROM public.agent_sessions
         WHERE workspace_id = $1 AND user_id = $2
           AND ($3::text IS NULL OR definition_id = $3)
           AND archived = $4 AND created_at <= $5::timestamptz
           AND ($6::text IS NULL OR title ILIKE '%' || $6 || '%')
           AND ($7::text IS NULL OR (
             CASE WHEN $8 THEN CASE WHEN source_kind = 'loop_run' THEN task_status ELSE task_status END
             ELSE task_status END = $7))
           AND ($9::timestamptz IS NULL
             OR (created_at, session_id) < ($9::timestamptz, $10::text))
         ORDER BY created_at DESC, session_id DESC LIMIT $11
      `, [access.workspaceId, access.userId, definitionId ?? null, archived === true, snapshotAt,
        normalizedSearch, taskStatus ?? null, projectLoopTaskStatus === true,
        decoded?.createdAt ?? null, decoded?.sessionId ?? null, boundedLimit + 1])).rows;
      const selected = rows.slice(0, boundedLimit).map(sessionView);
      const hasMore = rows.length > boundedLimit;
      return pagedAgentItems(selected, {
        snapshotAt,
        nextCursor: hasMore ? encodeAgentCursor("sessions", {
          version: 2, snapshotAt, queryFingerprint: fingerprint,
          createdAt: selected.at(-1).createdAt, sessionId: selected.at(-1).sessionId,
        }) : null,
        hasMore,
      });
    });
  }

  async findSessionByRunId(runId, access = {}) {
    return this.#transact(async (sql) => sessionView((await sql(`
      SELECT * FROM public.agent_sessions
       WHERE workspace_id = $1 AND user_id = $2 AND source_kind = 'loop_run' AND source_run_id = $3 LIMIT 1
    `, [access.workspaceId, access.userId, runId])).rows[0]));
  }

  async getSession(sessionId, access = {}, options = {}) {
    return this.#transact(async (sql) => sessionView((await sql(`
      SELECT ${SESSION_WITH_WORK_CONTEXT} FROM public.agent_sessions
       WHERE session_id = $1
         AND ($2::text IS NULL OR workspace_id = $2)
         AND ($3::text IS NULL OR user_id = $3)
    `, [sessionId, access.workspaceId ?? null, access.userId ?? null])).rows[0]), options.uow);
  }

  // A continuation is not an Agent object branch. This narrow check protects
  // the receiving member's normal Main Session at both intake and execution
  // time when its Work Item grant has been revoked or its account disabled.
  async assertWorkItemContinuationAccess({ sessionId, workspaceId, userId } = {}, options = {}) {
    return this.#transact(async (sql) => {
      const continuation = (await sql(`
        SELECT continuation_id, work_item_id, access_grant_id
          FROM public.work_item_continuations
         WHERE workspace_id = $1 AND agent_session_id = $2 AND user_id = $3
         FOR SHARE
      `, [workspaceId, sessionId, userId])).rows[0];
      if (!continuation) return false;
      const grant = (await sql(`
        SELECT grant_row.access_level
          FROM public.work_item_access_grants grant_row
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = grant_row.workspace_id
           AND membership.user_id = grant_row.user_id
           AND membership.status = 'active'
          JOIN public.product_users user_account
            ON user_account.user_id = grant_row.user_id
           AND user_account.disabled = false
         WHERE grant_row.workspace_id = $1
           AND grant_row.work_item_id = $2
           AND grant_row.user_id = $3
           AND grant_row.grant_id = $4
           AND grant_row.status = 'active'
         FOR SHARE OF grant_row, membership, user_account
      `, [
        workspaceId,
        continuation.work_item_id,
        userId,
        continuation.access_grant_id,
      ])).rows[0];
      if (!grant || !["owner", "contribute"].includes(grant.access_level)) {
        throw blockedCoded("work_item_continuation_access_revoked");
      }
      return true;
    }, options.uow);
  }

  async getWorkItemContinuationContext(sessionId, access = {}) {
    return this.#transact(async (sql) => {
      const continuation = (await sql(`
        SELECT continuation_id, continuation_context, created_at
          FROM public.work_item_continuations
         WHERE workspace_id = $1 AND agent_session_id = $2 AND user_id = $3
         FOR SHARE
      `, [access.workspaceId, sessionId, access.userId])).rows[0];
      if (!continuation) return null;
      const grant = (await sql(`
        SELECT grant_row.access_level
          FROM public.work_item_access_grants grant_row
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = grant_row.workspace_id
           AND membership.user_id = grant_row.user_id
           AND membership.status = 'active'
          JOIN public.product_users user_account
            ON user_account.user_id = grant_row.user_id
           AND user_account.disabled = false
          JOIN public.work_item_continuations active_continuation
            ON active_continuation.workspace_id = grant_row.workspace_id
           AND active_continuation.work_item_id = grant_row.work_item_id
           AND active_continuation.user_id = grant_row.user_id
           AND active_continuation.access_grant_id = grant_row.grant_id
         WHERE active_continuation.continuation_id = $1
           AND grant_row.status = 'active'
         FOR SHARE OF grant_row, membership, user_account, active_continuation
      `, [continuation.continuation_id])).rows[0];
      if (!grant || !["owner", "contribute"].includes(grant.access_level)) {
        throw blockedCoded("work_item_continuation_access_revoked");
      }
      return {
        schemaVersion: "workbench-v1",
        messageId: `work-item-continuation-context:${continuation.continuation_id}`,
        sessionId,
        turnId: `work-item-continuation:${continuation.continuation_id}`,
        sequence: 0,
        role: "system",
        kind: "work_item_handoff",
        content: String(continuation.continuation_context),
        createdAt: iso(continuation.created_at),
      };
    });
  }

  async updateSession({ sessionId, title, archived, updatedAt }, access = {}, options = {}) {
    return this.#transact(async (sql) => sessionView((await sql(`
      UPDATE public.agent_sessions
         SET title = COALESCE($4::text, title), archived = COALESCE($5::boolean, archived),
             updated_at = $6::timestamptz
       WHERE session_id = $1
         AND ($2::text IS NULL OR workspace_id = $2)
         AND ($3::text IS NULL OR user_id = $3)
       RETURNING *
    `, [sessionId, access.workspaceId ?? null, access.userId ?? null,
      title === undefined ? null : title, archived === undefined ? null : archived, updatedAt])).rows[0]), options.uow);
  }

  async updateSessionModel(sessionId, modelProfileId, updatedAt) {
    return this.#transact(async (sql) => sessionView((await sql(`
      UPDATE public.agent_sessions
         SET last_used_model_profile_id = $2, model_preference_state = 'preference_only', updated_at = $3::timestamptz
       WHERE session_id = $1 AND status = 'active' RETURNING *
    `, [sessionId, modelProfileId, updatedAt])).rows[0]));
  }

  async getBranch(branchId) {
    return this.#transact(async (sql) => branchView((await sql(
      "SELECT * FROM public.agent_branches WHERE branch_id = $1", [branchId],
    )).rows[0]));
  }

  async createQueuedTurn({ turn, message, event, command, admission, modelProfileId = null, transactionSession = null }) {
    return this.#transact(async (sql, uow) => {
      const persistTarget = async () => {
        const existing = (await sql("SELECT * FROM public.agent_turns WHERE turn_id = $1 FOR UPDATE", [turn.turnId])).rows[0];
        if (existing) {
          if (existing.product_command_id !== command?.commandId) throw coded("agent_turn_identity_conflict");
          return turnView(existing);
        }
        const session = (await sql(`SELECT * FROM public.agent_sessions
          WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3 AND status = 'active' FOR UPDATE`,
        [turn.sessionId, command.workspaceId, command.userId])).rows[0];
        if (!session) throw coded("agent_session_not_found");
        if (admission) {
          const count = (await sql(`
            SELECT count(*)::int AS count FROM public.admission_waiting waiting
             JOIN public.product_commands product_command
               ON product_command.command_id = waiting.command_id
            WHERE waiting.workspace_id = $1 AND product_command.quota_user_id = $2
              AND waiting.queue_slot_held = true AND waiting.state IN ('waiting_session_turn', 'waiting_capacity')
          `, [admission.workspaceId, admission.userId])).rows[0];
          if (Number(count?.count ?? 0) >= MAX_WAITING_TURNS_PER_USER) throw queueFull(turn.sessionId);
        }
        const updated = (await sql(`
          UPDATE public.agent_sessions
             SET turn_sequence = turn_sequence + 1, message_sequence = message_sequence + 1,
                 event_sequence = event_sequence + 1, updated_at = $2::timestamptz,
                 task_status = CASE WHEN active_turn_id IS NULL THEN 'queued' ELSE 'running' END,
                 title = CASE WHEN turn_sequence = 0 AND title IN ('Untitled task', 'New task', '新任务')
                   THEN left(regexp_replace($3::text, '\\s+', ' ', 'g'), 72) ELSE title END,
                 last_used_model_profile_id = COALESCE($4::text, last_used_model_profile_id),
                 model_preference_state = CASE WHEN $4::text IS NULL THEN model_preference_state ELSE 'preference_only' END
           WHERE session_id = $1 RETURNING *
        `, [turn.sessionId, turn.updatedAt, message.content, modelProfileId])).rows[0];
        const queued = (await sql(`
          INSERT INTO public.agent_turns (
            turn_id, session_id, workspace_id, user_id, schema_version, product_command_id,
            kind, sequence, status, model_routing_state, required_model_capability,
            requested_model_revision_id, actual_model_revision_id, session_epoch, turn_fence,
            queued_at, started_at, finished_at, updated_at, payload
          ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, $7, 'queued', 'pinned', $8,
            $9, NULL, $10, $11, $12::timestamptz, NULL, NULL, $12::timestamptz, $13::jsonb)
          RETURNING *
        `, [turn.turnId, turn.sessionId, command.workspaceId, command.userId, command.commandId,
          turn.kind, updated.turn_sequence, turn.modelCapability, turn.requestedModelRevisionId,
          turn.sessionEpoch, turn.turnFence, turn.queuedAt, JSON.stringify({ ...turn, invocationIds: [] })])).rows[0];
        await sql(`INSERT INTO public.agent_messages (
          message_id, session_id, turn_id, schema_version, sequence, role, kind, content, created_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
        [message.messageId, message.sessionId, message.turnId, updated.message_sequence, message.role,
          message.kind, message.content, message.createdAt, JSON.stringify(message)]);
        await sql(`INSERT INTO public.agent_session_events (
          event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
        [event.eventId, event.sessionId, event.turnId, updated.event_sequence, event.type, event.status,
          event.summary, event.occurredAt, JSON.stringify(event)]);
        if (admission) await sql(`INSERT INTO public.admission_waiting (
          admission_id, command_id, workspace_id, schema_version, kind, invocation_id, session_id, turn_id,
          state, queue_slot_held, created_at, updated_at, released_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', 'command_turn', NULL, $4, $5,
          'waiting_session_turn', true, $6::timestamptz, $6::timestamptz, NULL, $7::jsonb)`,
        [admission.admissionId, command.commandId, admission.workspaceId, admission.sessionId,
          admission.turnId, admission.createdAt, JSON.stringify({ userId: admission.userId })]);
        return turnView(queued);
      };
      const accepted = await this.#commandIntake.accept({
        principal: { workspaceId: command.workspaceId, userId: command.userId }, command, persistTarget,
        loadTarget: async () => turnView((await sql(
          "SELECT * FROM public.agent_turns WHERE turn_id = $1", [turn.turnId],
        )).rows[0]), at: command.createdAt ?? turn.queuedAt, uow,
      });
      return accepted.target;
    }, transactionSession);
  }

  async appendMessage(message) {
    return this.#transact(async (sql) => {
      const session = (await sql(`UPDATE public.agent_sessions SET message_sequence = message_sequence + 1
        WHERE session_id = $1 RETURNING message_sequence`, [message.sessionId])).rows[0];
      if (!session) throw coded("agent_session_not_found");
      await sql(`INSERT INTO public.agent_messages (
        message_id, session_id, turn_id, schema_version, sequence, role, kind, content, created_at, payload
      ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
      [message.messageId, message.sessionId, message.turnId, session.message_sequence, message.role,
        message.kind, message.content, message.createdAt, JSON.stringify(message)]);
      return { ...message, sequence: Number(session.message_sequence) };
    });
  }

  async listMessages(sessionId, access = {}) {
    if (!await this.getSession(sessionId, access)) return null;
    return this.#transact(async (sql) => (await sql(`
      SELECT message_id, sequence, role, kind, content, created_at, payload
        FROM public.agent_messages WHERE session_id = $1 ORDER BY sequence DESC LIMIT 10000
    `, [sessionId])).rows.reverse().map(messageView));
  }

  async listSessionAttachmentRefs({ sessionId, throughTurnId, workspaceId, userId, attachmentId = null, limit = 50 }) {
    if (!sessionId || !throughTurnId || !workspaceId || !userId) throw coded("attachment_forbidden");
    const bounded = Math.min(50, Math.max(1, Number(limit) || 50));
    return this.#transact(async (sql) => {
      const current = (await sql(`SELECT current_turn.sequence FROM public.agent_turns current_turn
        JOIN public.workspace_memberships member ON member.workspace_id = current_turn.workspace_id
          AND member.user_id = current_turn.user_id AND member.status = 'active'
        JOIN public.product_users account ON account.user_id = current_turn.user_id AND account.disabled = false
        WHERE current_turn.turn_id = $1 AND current_turn.session_id = $2
          AND current_turn.workspace_id = $3 AND current_turn.user_id = $4`,
      [throughTurnId, sessionId, workspaceId, userId])).rows[0];
      if (!current) throw coded("attachment_forbidden");
      const rows = (await sql(`SELECT ref FROM (
        SELECT DISTINCT ON (attachment.value->>'attachmentId') attachment.value AS ref, history.sequence
          FROM public.agent_turns history
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(history.payload#>'{input,attachments}', '[]'::jsonb)) attachment(value)
         WHERE history.session_id = $1 AND history.workspace_id = $2 AND history.user_id = $3
           AND history.sequence <= $4 AND ($5::text IS NULL OR attachment.value->>'attachmentId' = $5)
         ORDER BY attachment.value->>'attachmentId', history.sequence DESC
      ) scoped ORDER BY sequence DESC, ref->>'attachmentId' LIMIT $6`,
      [sessionId, workspaceId, userId, current.sequence, attachmentId, bounded + 1])).rows;
      return { refs: rows.slice(0, bounded).map((row) => row.ref), hasMore: rows.length > bounded };
    });
  }

  async appendEvent(sessionId, eventFactory) {
    return this.#transact(async (sql) => {
      const session = (await sql(`UPDATE public.agent_sessions SET event_sequence = event_sequence + 1
        WHERE session_id = $1 RETURNING event_sequence`, [sessionId])).rows[0];
      if (!session) throw coded("agent_session_not_found");
      const event = eventFactory(Number(session.event_sequence));
      await this.#insertEvent(sql, event, Number(session.event_sequence));
      return event;
    });
  }

  /**
   * The Product-facing append point for Harness model-visible events.  It
   * reuses agent_session_events and its immutable Session-domain projection;
   * the Kernel never receives a repository or SQL capability.  eventId is
   * the Kernel's retry identity, so a duplicate retry returns the original
   * event without consuming another Session sequence.
   */
  async appendModelVisibleEvent({ sessionId, turnId, productCommandId, event } = {}) {
    assertModelVisibleEventTarget({ sessionId, turnId, productCommandId, event });
    return this.#transact(async (sql) => {
      const existing = (await sql(`SELECT schema_version, event_id, session_id, turn_id, sequence, type, status, summary, occurred_at, payload
        FROM public.agent_session_events WHERE event_id = $1 FOR SHARE`, [event.eventId])).rows[0];
      if (existing) {
        // This internal replay port still needs the immutable lineage and
        // model-visible event; only the public list strips that envelope.
        const value = { ...structuredClone(existing.payload), ...eventView(existing) };
        if (!sameModelVisibleEvent(value, event)) throw coded("agent_kernel_event_identity_conflict");
        return value;
      }
      const turn = (await sql(`SELECT session_id, product_command_id FROM public.agent_turns
        WHERE turn_id = $1 FOR SHARE`, [turnId])).rows[0];
      if (!turn || turn.session_id !== sessionId) throw coded("agent_session_not_found");
      if (turn.product_command_id !== productCommandId) throw coded("agent_kernel_event_command_mismatch");
      const session = (await sql(`UPDATE public.agent_sessions SET event_sequence = event_sequence + 1
        WHERE session_id = $1 RETURNING event_sequence`, [sessionId])).rows[0];
      if (!session) throw coded("agent_session_not_found");
      const sequence = Number(session.event_sequence);
      await this.#insertEvent(sql, event, sequence);
      return { ...structuredClone(event), sequence };
    });
  }

  async listEvents(sessionId, queryOrAfter = {}, limitOrAccess = 500, accessMaybe = {}) {
    const query = typeof queryOrAfter === "object" ? queryOrAfter : { after: queryOrAfter, limit: limitOrAccess };
    const access = typeof queryOrAfter === "object" ? limitOrAccess : accessMaybe;
    if (!await this.getSession(sessionId, access)) return null;
    const boundedLimit = Math.min(Math.max(Number(query.limit) || 500, 1), 1000);
    const decoded = decodeAgentCursor("events", query.cursor);
    const forward = Number.isInteger(query.after) || decoded?.direction === "forward";
    const boundary = forward ? Math.max(Number(query.after ?? -1), Number(decoded?.afterSequence ?? -1))
      : Number(decoded?.beforeSequence ?? Number.MAX_SAFE_INTEGER);
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT schema_version, event_id, session_id, turn_id, sequence, type, status, summary, occurred_at
        FROM public.agent_session_events WHERE session_id = $1 AND sequence ${forward ? ">" : "<"} $2
        ORDER BY sequence ${forward ? "ASC" : "DESC"} LIMIT $3`, [sessionId, boundary, boundedLimit + 1])).rows;
      const selected = rows.slice(0, boundedLimit);
      if (!forward) selected.reverse();
      const values = selected.map(eventView);
      const hasMore = rows.length > boundedLimit;
      return pagedAgentItems(values, { nextCursor: hasMore ? encodeAgentCursor("events", forward
        ? { direction: "forward", afterSequence: values.at(-1).sequence }
        : { direction: "backward", beforeSequence: values[0].sequence }) : null, hasMore });
    });
  }

  // Internal replay consumes the same authorized ledger page, without expanding
  // the public event summary projection with model context.
  async listModelVisibleEvents(sessionId, query = {}, access = {}) {
    const page = await this.listEvents(sessionId, query, access);
    if (!page || !page.length) return page;
    return this.#transact(async sql => {
      const rows = (await sql(`SELECT event_id,payload->'modelVisibleEvent' AS model_event
        FROM public.agent_session_events WHERE session_id=$1 AND event_id=ANY($2::text[])`,
      [sessionId, page.map(event => event.eventId)])).rows;
      const events = new Map(rows.map(row => [row.event_id, row.model_event]));
      return pagedAgentItems(page.map(event => ({ ...event, modelVisibleEvent: events.get(event.eventId) ?? null })), page.page);
    });
  }

  async getTurn(sessionId, turnId, access = {}) {
    if (!await this.getSession(sessionId, access)) return null;
    return this.#transact(async (sql) => turnView((await sql(
      "SELECT * FROM public.agent_turns WHERE session_id = $1 AND turn_id = $2", [sessionId, turnId],
    )).rows[0]));
  }

  async listTurns(sessionId, { after, cursor, limit = 100 } = {}, access = {}) {
    if (!await this.getSession(sessionId, access)) return null;
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const decoded = decodeAgentCursor("turns", cursor);
    const forward = Number.isInteger(after) || decoded?.direction === "forward";
    const boundary = forward ? Math.max(Number(after ?? -1), Number(decoded?.afterSequence ?? -1))
      : Number(decoded?.beforeSequence ?? Number.MAX_SAFE_INTEGER);
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT * FROM public.agent_turns WHERE session_id = $1 AND sequence ${forward ? ">" : "<"} $2
        ORDER BY sequence ${forward ? "ASC" : "DESC"} LIMIT $3`, [sessionId, boundary, boundedLimit + 1])).rows;
      const selected = rows.slice(0, boundedLimit);
      if (!forward) selected.reverse();
      const values = selected.map(turnView);
      const hasMore = rows.length > boundedLimit;
      return pagedAgentItems(values, { nextCursor: hasMore ? encodeAgentCursor("turns", forward
        ? { direction: "forward", afterSequence: values.at(-1).sequence }
        : { direction: "backward", beforeSequence: values[0].sequence }) : null, hasMore });
    });
  }

  async claimNextTurn(sessionId, startedAt, eventFactory = null) {
    return this.#transact(async (sql, uow) => {
      const session = (await sql(`SELECT * FROM public.agent_sessions WHERE session_id = $1
        AND status = 'active' AND active_turn_id IS NULL FOR UPDATE SKIP LOCKED`, [sessionId])).rows[0];
      if (!session) return null;
      const queued = (await sql(`SELECT * FROM public.agent_turns WHERE session_id = $1 AND status = 'queued'
        ORDER BY sequence ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [sessionId])).rows[0];
      if (!queued) return null;
      const nextEventSequence = Number(session.event_sequence) + (typeof eventFactory === "function" ? 1 : 0);
      const claimed = (await sql(`UPDATE public.agent_turns SET status = 'running', started_at = $2::timestamptz,
        updated_at = $2::timestamptz WHERE turn_id = $1 AND status = 'queued' RETURNING *`,
      [queued.turn_id, startedAt])).rows[0];
      if (!claimed) return null;
      await sql(`UPDATE public.agent_sessions SET active_turn_id = $2, task_status = 'running', updated_at = $3::timestamptz,
        event_sequence = $4 WHERE session_id = $1`, [sessionId, claimed.turn_id, startedAt, nextEventSequence]);
      if (claimed.product_command_id) {
        await this.#commandIntake.start({ principal: { workspaceId: session.workspace_id, userId: session.user_id },
          commandId: claimed.product_command_id, at: startedAt, uow });
        await sql(`UPDATE public.admission_waiting SET state = 'running', queue_slot_held = false, updated_at = $2::timestamptz
          WHERE command_id = $1 AND state = 'waiting_session_turn'`, [claimed.product_command_id, startedAt]);
      }
      if (typeof eventFactory === "function") await this.#insertEvent(sql, eventFactory(nextEventSequence, runnerTurn(claimed)), nextEventSequence);
      return runnerTurn(claimed);
    });
  }

  async addInvocation(turnId, invocationId, updatedAt) {
    return this.#transact(async (sql) => {
      const row = (await sql("SELECT payload FROM public.agent_turns WHERE turn_id = $1 FOR UPDATE", [turnId])).rows[0];
      if (!row) return null;
      const invocationIds = [...new Set([...(row.payload?.invocationIds ?? []), invocationId])];
      await sql("UPDATE public.agent_turns SET payload = jsonb_set(payload, '{invocationIds}', $2::jsonb), updated_at = $3::timestamptz WHERE turn_id = $1",
        [turnId, JSON.stringify(invocationIds), updatedAt]);
      return null;
    });
  }

  async getTurnInvocations(turnId) {
    return this.#transact(async (sql) => (await sql("SELECT payload FROM public.agent_turns WHERE turn_id = $1", [turnId])).rows[0]?.payload?.invocationIds ?? []);
  }

  async settleTurn({ turnId, sessionEpoch, turnFence, status, result, finishedAt, routing = {}, message, event, handoff = null, proposal = null }) {
    return this.#transact(async (sql, uow) => {
      const current = (await sql("SELECT * FROM public.agent_turns WHERE turn_id = $1 FOR UPDATE", [turnId])).rows[0];
      if (!current) return null;
      if (!['running', 'cancellation_requested'].includes(current.internal_status ?? current.status)) return turnView(current);
      const cancelled = current.internal_status === "cancellation_requested";
      if (!cancelled && ((sessionEpoch !== undefined && Number(current.session_epoch) !== Number(sessionEpoch))
        || (turnFence !== undefined && Number(current.turn_fence) !== Number(turnFence)))) return turnView(current);
      const effectiveStatus = cancelled ? "cancelled" : status;
      const session = (await sql(`UPDATE public.agent_sessions
        SET active_turn_id = NULL, task_status = $2, message_sequence = message_sequence + 1,
            event_sequence = event_sequence + 1, updated_at = $3::timestamptz
        WHERE session_id = $1 AND active_turn_id = $4 RETURNING *`,
      [current.session_id, effectiveStatus, finishedAt, turnId])).rows[0];
      if (!session) return null;
      const payload = { ...(current.payload ?? {}), result: cancelled ? null : result,
        artifactRefs: cancelled ? [] : (routing.artifactRefs ?? []) };
      const settled = (await sql(`UPDATE public.agent_turns SET status = $2, internal_status = NULL,
        actual_model_revision_id = $3, finished_at = $4::timestamptz, updated_at = $4::timestamptz,
        payload = $5::jsonb WHERE turn_id = $1 RETURNING *`, [turnId, effectiveStatus,
        cancelled ? null : (routing.actualModelRevisionId ?? null), finishedAt, JSON.stringify(payload)])).rows[0];
      const terminalMessage = cancelled ? { ...message, content: "Turn cancelled." } : message;
      const terminalEvent = {
        ...(cancelled ? { ...event, type: "turn.cancelled", status: "cancelled", summary: "Turn cancelled." } : event),
        ...(settled.product_command_id ? { productCommandId: settled.product_command_id } : {}),
      };
      await this.#insertMessage(sql, terminalMessage, Number(session.message_sequence));
      await this.#insertEvent(sql, terminalEvent, Number(session.event_sequence));
      if (handoff && effectiveStatus === "completed") await this.#insertHandoff(sql, handoff);
      if (proposal && effectiveStatus === "completed") {
        assertSettlementProposal(proposal, turnView(settled), result);
        await this.#insertProposal(sql, proposal);
      }
      if (settled.product_command_id) {
        await this.#commandIntake.settle({ principal: { workspaceId: session.workspace_id, userId: session.user_id },
          commandId: settled.product_command_id, status: effectiveStatus, at: finishedAt, uow });
        await sql(`UPDATE public.admission_waiting SET state = $2, queue_slot_held = false, updated_at = $3::timestamptz,
          released_at = $3::timestamptz WHERE command_id = $1`,
        [settled.product_command_id, effectiveStatus === "cancelled" ? "cancelled" : "released", finishedAt]);
      }
      return turnView(settled);
    });
  }

  requestCancelWithEvent(turnId, cancelledAt, eventFactory, { command = null, transactionSession = null } = {}) {
    return this.#requestCancellation({ turnId, cancelledAt, eventFactory, command, transactionSession });
  }

  async requestCancel(turnId, cancelledAt, { transactionSession = null } = {}) {
    return (await this.#requestCancellation({ turnId, cancelledAt, eventFactory: null, transactionSession })).turn;
  }

  async #requestCancellation({ turnId, cancelledAt, eventFactory, command, transactionSession }) {
    return this.#transact(async (sql, uow) => {
      const current = (await sql("SELECT * FROM public.agent_turns WHERE turn_id = $1 FOR UPDATE", [turnId])).rows[0];
      if (!current || TERMINAL.has(current.status)) return { turn: turnView(current), event: null, replayed: true };
      if (current.cancellation_command_id) return { turn: turnView(current), event: null, replayed: true };
      const session = (await sql("SELECT * FROM public.agent_sessions WHERE session_id = $1 AND status = 'active' FOR UPDATE", [current.session_id])).rows[0];
      if (!session) throw coded("agent_session_not_found");
      const cancellationCommand = command ?? (current.product_command_id ? {
        schemaVersion: "workbench-v1", commandId: `cancel:${current.product_command_id}`,
        kind: "cancel_agent_turn", targetCommandId: current.product_command_id,
        workspaceId: session.workspace_id, userId: session.user_id, sessionId: current.session_id, turnId: current.turn_id,
      } : null);
      const persistTarget = async () => {
        const queued = current.status === "queued";
        const turn = (await sql(`UPDATE public.agent_turns SET status = CASE WHEN $2 THEN 'cancelled' ELSE status END,
          internal_status = CASE WHEN $2 THEN NULL ELSE 'cancellation_requested' END,
          cancellation_command_id = $3, turn_fence = CASE WHEN $2 THEN turn_fence ELSE turn_fence + 1 END,
          finished_at = CASE WHEN $2 THEN $4::timestamptz ELSE NULL END, updated_at = $4::timestamptz
          WHERE turn_id = $1 AND cancellation_command_id IS NULL RETURNING *`,
        [turnId, queued, cancellationCommand?.commandId ?? null, cancelledAt])).rows[0];
        if (!turn) return null;
        const updated = (await sql(`UPDATE public.agent_sessions SET task_status = $2,
          event_sequence = event_sequence + $3, updated_at = $4::timestamptz WHERE session_id = $1 RETURNING *`,
        [current.session_id, queued ? "cancelled" : "running", typeof eventFactory === "function" ? 1 : 0, cancelledAt])).rows[0];
        let event = null;
        if (typeof eventFactory === "function") {
          event = eventFactory(Number(updated.event_sequence), turnView(turn));
          await this.#insertEvent(sql, event, Number(updated.event_sequence));
        }
        if (turn.product_command_id) await sql(`UPDATE public.admission_waiting SET state = $2, queue_slot_held = false,
          updated_at = $3::timestamptz, released_at = CASE WHEN $2 = 'cancelled' THEN $3::timestamptz ELSE released_at END
          WHERE command_id = $1`, [turn.product_command_id, queued ? "cancelled" : "cancellation_requested", cancelledAt]);
        return { turn: turnView(turn), event };
      };
      if (!cancellationCommand || !current.product_command_id) return { ...(await persistTarget()), replayed: false };
      const accepted = await this.#commandIntake.acceptCancellation({
        principal: { workspaceId: session.workspace_id, userId: session.user_id }, command: cancellationCommand,
        targetCommandId: current.product_command_id,
        targetStatus: current.status === "queued" ? "cancelled" : "cancellation_requested",
        persistTarget, at: cancellationCommand.createdAt ?? cancelledAt, uow,
      });
      return { ...accepted.target, replayed: accepted.replayed };
    }, transactionSession);
  }

  async findMainSession(userId, workspaceId) {
    return this.#transact(async (sql) => sessionView((await sql(`SELECT * FROM public.agent_sessions
      WHERE user_id = $1 AND workspace_id = $2 AND definition_id = 'main' AND status = 'active'
        AND source_kind <> 'loop_run' ORDER BY updated_at DESC, created_at DESC LIMIT 1`, [userId, workspaceId])).rows[0]));
  }

  async createHandoff(handoff) { return this.#transact(async (sql) => {
    const source = (await sql("SELECT workspace_id, user_id FROM public.agent_sessions WHERE session_id = $1", [handoff.sourceSessionId])).rows[0];
    if (!source) throw coded("agent_handoff_source_invalid");
    const persisted = { ...handoff, workspaceId: source.workspace_id, userId: source.user_id };
    await this.#insertHandoff(sql, persisted);
    return handoffView((await sql("SELECT * FROM public.agent_handoffs WHERE handoff_id = $1", [handoff.handoffId])).rows[0]);
  }); }
  async listHandoffs(targetSessionId) { return this.#transact(async (sql) => (await sql(
    "SELECT * FROM public.agent_handoffs WHERE target_session_id = $1 ORDER BY created_at DESC LIMIT 500", [targetSessionId],
  )).rows.map(handoffView)); }
  async confirmHandoff(targetSessionId, handoffId, confirmedAt) { return this.#transact(async (sql) => {
    const updated = (await sql(`UPDATE public.agent_handoffs SET status = 'confirmed', confirmed_at = $3::timestamptz
      WHERE target_session_id = $1 AND handoff_id = $2 AND status = 'pending' RETURNING *`,
    [targetSessionId, handoffId, confirmedAt])).rows[0];
    return handoffView(updated ?? (await sql("SELECT * FROM public.agent_handoffs WHERE target_session_id = $1 AND handoff_id = $2", [targetSessionId, handoffId])).rows[0]);
  }); }

  async getLatestContextEvent(sessionId, { status } = {}) { return this.#transact(async (sql) => contextView((await sql(`
    SELECT * FROM public.agent_context_events WHERE session_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC, context_event_id DESC LIMIT 1`, [sessionId, status ?? null])).rows[0])); }
  async appendContextEvent(event) { return this.#transact(async (sql) => {
    const existing = event.status === "completed" ? (await sql(`SELECT * FROM public.agent_context_events
      WHERE session_id = $1 AND status = 'completed' AND source_hash = $2 AND prompt_revision = $3
        AND model_profile_revision_id = $4 LIMIT 1`, [event.sessionId, event.sourceHash, event.promptRevision, event.modelProfileRevisionId])).rows[0] : null;
    if (existing) return contextView(existing);
    const inserted = (await sql(`INSERT INTO public.agent_context_events (
      context_event_id, session_id, workspace_id, user_id, schema_version, status, through_message_sequence,
      source_hash, prompt_revision, model_profile_revision_id, product_command_id, turn_id, invocation_id,
      failure_code, retry_after, created_at, payload
    ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::timestamptz, $16::jsonb)
    RETURNING *`, [event.contextEventId, event.sessionId, event.workspaceId, event.userId, event.status,
      event.throughMessageSequence, event.sourceHash, event.promptRevision, event.modelProfileRevisionId,
      event.productCommandId ?? null, event.turnId, event.invocationId ?? null, event.failureCode ?? null,
      event.retryAfter ?? null, event.createdAt, JSON.stringify(event)])).rows[0];
    return contextView(inserted);
  }); }
  async deleteContextEvents(sessionId) { return this.#transact(async (sql) => {
    const deleted = await sql("DELETE FROM public.agent_context_events WHERE session_id = $1", [sessionId]);
    return { deletedCount: deleted.rowCount ?? 0 };
  }); }

  async recover() {
    this.#recoveryCancellationIntents = [];
    return this.#transact(async (sql, uow) => {
      const sessions = (await sql(`SELECT * FROM public.agent_sessions WHERE status = 'active'
        AND (active_turn_id IS NOT NULL OR task_status = 'queued') FOR UPDATE`)).rows;
      const ready = [];
      for (const session of sessions) {
        const turn = session.active_turn_id ? (await sql("SELECT * FROM public.agent_turns WHERE turn_id = $1 FOR UPDATE", [session.active_turn_id])).rows[0] : null;
        if (turn?.internal_status === "cancellation_requested") {
          this.#recoveryCancellationIntents.push({ sessionId: session.session_id, turnId: turn.turn_id,
            invocationIds: turn.payload?.invocationIds ?? [], requestedAt: iso(turn.updated_at),
            productCommandId: turn.cancellation_command_id ?? turn.product_command_id ?? null });
        } else if (turn?.status === "running") {
          await sql(`UPDATE public.agent_turns SET status = 'queued', started_at = NULL, internal_status = NULL,
            updated_at = $2::timestamptz WHERE turn_id = $1`, [turn.turn_id, session.updated_at]);
          if (turn.product_command_id) {
            await this.#commandIntake.requeue({ principal: { workspaceId: session.workspace_id, userId: session.user_id },
              commandId: turn.product_command_id, at: iso(session.updated_at), uow });
            await sql(`UPDATE public.admission_waiting SET state = 'waiting_session_turn', queue_slot_held = true,
              updated_at = $2::timestamptz, released_at = NULL WHERE command_id = $1`, [turn.product_command_id, session.updated_at]);
          }
          await sql("UPDATE public.agent_sessions SET active_turn_id = NULL, task_status = 'queued' WHERE session_id = $1", [session.session_id]);
        }
        const queued = (await sql("SELECT 1 FROM public.agent_turns WHERE session_id = $1 AND status = 'queued' LIMIT 1", [session.session_id])).rows[0];
        if (queued) ready.push(session.session_id);
      }
      return ready;
    });
  }

  takeRecoveryCancellationIntents() {
    const values = structuredClone(this.#recoveryCancellationIntents);
    this.#recoveryCancellationIntents = [];
    return values;
  }

  async #insertSession(sql, session) {
    return (await sql(`INSERT INTO public.agent_sessions (
      session_id, workspace_id, user_id, schema_version, definition_id, scope_kind,
      object_kind, object_id, branch_id, base_version_id, source_kind, source_workflow_id,
      source_workflow_revision_id, source_run_id, title, task_status, archived, status,
      last_used_model_profile_id, model_preference_state, active_turn_id, session_epoch,
      turn_sequence, message_sequence, event_sequence, created_at, updated_at, payload
    ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, NULL, $20, 0, 0, 0, $21::timestamptz, $22::timestamptz, $23::jsonb)
    RETURNING *`, [session.sessionId, session.workspaceId, session.userId, session.definitionId,
      session.scope.kind, session.scope.objectKind ?? null, session.scope.objectId ?? null,
      session.scope.branchId ?? null, session.scope.baseVersionId ?? null, session.source?.kind ?? "manual",
      session.source?.workflowId ?? null, session.source?.workflowRevisionId ?? null, session.source?.runId ?? null,
      session.title, session.taskStatus, session.archived === true, session.status,
      session.lastUsedModelProfileId ?? null, session.modelPreferenceState ?? "preference_only",
      session.sessionEpoch ?? 1, session.createdAt, session.updatedAt, JSON.stringify(session)])).rows[0];
  }

  async #findModuleSession(sql, session) { return (await sql(`SELECT * FROM public.agent_sessions
    WHERE user_id = $1 AND workspace_id = $2 AND definition_id = $3 AND scope_kind = 'module'
      AND object_id = $4 AND branch_id = $5 AND status = 'active' LIMIT 1`,
  [session.userId, session.workspaceId, session.definitionId, session.scope.objectId, session.scope.branchId])).rows[0]; }
  async #insertMessage(sql, message, sequence) { return sql(`INSERT INTO public.agent_messages (
    message_id, session_id, turn_id, schema_version, sequence, role, kind, content, created_at, payload
  ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
  [message.messageId, message.sessionId, message.turnId, sequence, message.role, message.kind,
    message.content, message.createdAt, JSON.stringify(message)]); }
  async #insertEvent(sql, event, sequence) { return sql(`INSERT INTO public.agent_session_events (
    event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
  ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
  [event.eventId, event.sessionId, event.turnId ?? null, sequence, event.type, event.status,
    event.summary, event.occurredAt, JSON.stringify(event)]); }
  async #insertHandoff(sql, handoff) { return sql(`INSERT INTO public.agent_handoffs (
    handoff_id, workspace_id, user_id, source_session_id, target_session_id, schema_version,
    status, created_at, confirmed_at, payload
  ) VALUES ($1, $2, $3, $4, $5, 'workbench-v1', $6, $7::timestamptz, $8::timestamptz, $9::jsonb)`,
  [handoff.handoffId, handoff.workspaceId, handoff.userId, handoff.sourceSessionId, handoff.targetSessionId,
    handoff.status, handoff.createdAt, handoff.confirmedAt ?? null, JSON.stringify(handoff)]); }
  async #insertProposal(sql, proposal) { return sql(`INSERT INTO public.agent_object_proposals (
    proposal_id, workspace_id, user_id, session_id, turn_id, branch_id, schema_version, definition_id,
    object_kind, object_id, base_version_id, status, created_by, created_at, decided_at, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, 'workbench-v1', $7, $8, $9, $10, $11, $12, $13::timestamptz, NULL, $14::jsonb)`,
  [proposal.proposalId, proposal.workspaceId, proposal.userId, proposal.sessionId, proposal.turnId,
    proposal.branchId, proposal.definitionId, proposal.objectKind, proposal.objectId, proposal.baseVersionId,
    proposal.status, proposal.createdBy, proposal.createdAt, JSON.stringify(proposal)]); }
  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
  #transact(work, uow = null) { return this.#store.withTransaction((transaction) => work((text, values = []) => this.#query(transaction, text, values), transaction), uow ? { uow } : {}); }
}

function assertModelVisibleEventTarget({ sessionId, turnId, productCommandId, event }) {
  if (typeof sessionId !== "string" || !sessionId
    || typeof turnId !== "string" || !turnId
    || typeof productCommandId !== "string" || !productCommandId
    || !event || typeof event !== "object"
    || event.sessionId !== sessionId
    || event.turnId !== turnId
    || event.productCommandId !== productCommandId
    || typeof event.eventId !== "string" || !event.eventId
    || !event.modelVisibleEvent || typeof event.modelVisibleEvent !== "object") {
    throw coded("agent_kernel_event_invalid");
  }
}

function sameModelVisibleEvent(existing, event) {
  return existing.sessionId === event.sessionId
    && existing.turnId === event.turnId
    && existing.productCommandId === event.productCommandId
    && existing.modelVisibleEvent?.eventId === event.modelVisibleEvent?.eventId;
}

function sessionView(row) {
  if (!row) return null;
  const { workItemContext: _payloadContext, ...payload } = row.payload ?? {};
  return publicSession({ ...payload,
    ...(row.work_item_context ? { workItemContext: row.work_item_context } : {}),
    sessionId: row.session_id, workspaceId: row.workspace_id, userId: row.user_id,
    definitionId: row.definition_id, scope: row.scope_kind === "module" ? { kind: "module", objectKind: row.object_kind,
      objectId: row.object_id, branchId: row.branch_id, baseVersionId: row.base_version_id } : { kind: "main" },
    source: row.source_kind === "loop_run" ? { kind: "loop_run", workflowId: row.source_workflow_id,
      workflowRevisionId: row.source_workflow_revision_id, runId: row.source_run_id } : { kind: "manual" },
    title: row.title, taskStatus: row.task_status, archived: row.archived, status: row.status,
    lastUsedModelProfileId: row.last_used_model_profile_id, modelPreferenceState: row.model_preference_state,
    activeTurnId: row.active_turn_id, sessionEpoch: Number(row.session_epoch), turnSequence: Number(row.turn_sequence),
    messageSequence: Number(row.message_sequence), eventSequence: Number(row.event_sequence), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function turnView(row) {
  if (!row) return null;
  return publicTurn({ ...(row.payload ?? {}), turnId: row.turn_id, sessionId: row.session_id, productCommandId: row.product_command_id,
    cancellationCommandId: row.cancellation_command_id, sequence: Number(row.sequence), kind: row.kind, status: row.status,
    internalStatus: row.internal_status, modelRoutingState: row.model_routing_state,
    requestedModelRevisionId: row.requested_model_revision_id, actualModelRevisionId: row.actual_model_revision_id,
    sessionEpoch: Number(row.session_epoch), turnFence: Number(row.turn_fence), queuedAt: iso(row.queued_at),
    startedAt: row.started_at ? iso(row.started_at) : null, finishedAt: row.finished_at ? iso(row.finished_at) : null, updatedAt: iso(row.updated_at) });
}
function branchView(row) { return row ? { ...(row.payload ?? {}), branchId: row.branch_id, workspaceId: row.workspace_id,
  userId: row.user_id, objectKind: row.object_kind, objectId: row.object_id, baseVersionId: row.base_version_id,
  status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } : null; }
function messageView(row) { return { ...(row.payload ?? {}), messageId: row.message_id, sequence: Number(row.sequence),
  role: row.role, kind: row.kind, content: row.content, createdAt: iso(row.created_at) }; }
// Event payloads retain internal command lineage for the database guards.
// Project the canonical public event explicitly rather than forwarding that
// private envelope (which also fails the strict HTTP response contract).
function eventView(row) { return { schemaVersion: row.schema_version,
  eventId: row.event_id, sessionId: row.session_id, turnId: row.turn_id,
  sequence: Number(row.sequence), type: row.type, status: row.status,
  summary: row.summary, occurredAt: iso(row.occurred_at) }; }
function contextView(row) { return row ? { ...(row.payload ?? {}), contextEventId: row.context_event_id, status: row.status,
  throughMessageSequence: Number(row.through_message_sequence), sourceHash: row.source_hash, promptRevision: row.prompt_revision,
  modelProfileRevisionId: row.model_profile_revision_id, createdAt: iso(row.created_at) } : null; }
function handoffView(row) { return row ? { ...(row.payload ?? {}), handoffId: row.handoff_id, workspaceId: row.workspace_id,
  userId: row.user_id, sourceSessionId: row.source_session_id, targetSessionId: row.target_session_id, status: row.status,
  createdAt: iso(row.created_at), confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null } : null; }
function runnerTurn(row) { const value = { ...(row.payload ?? {}), turnId: row.turn_id, sessionId: row.session_id,
  productCommandId: row.product_command_id, sequence: Number(row.sequence), status: row.status, kind: row.kind,
  modelRoutingState: row.model_routing_state, requestedModelRevisionId: row.requested_model_revision_id,
  sessionEpoch: Number(row.session_epoch), turnFence: Number(row.turn_fence), queuedAt: iso(row.queued_at),
  startedAt: row.started_at ? iso(row.started_at) : null, updatedAt: iso(row.updated_at) };
  delete value.invocationIds; delete value.internalStatus; return value; }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
function coded(code) { const error = new Error(code); error.code = code; return error; }
function blockedCoded(code) { const error = coded(code); error.status = "blocked"; return error; }
function queueFull(sessionId) { const error = coded("admission_queue_full"); error.status = "conflict"; error.retryable = true;
  error.details = { reasonCode: "admission_queue_full", recoveryAction: "inspect_queue", method: "GET",
    path: `/api/workbench/v1/agent-sessions/${encodeURIComponent(sessionId)}/queue` }; return error; }
function cursorError(code, publicCode, retryable) { const error = coded(code); error.code = publicCode; error.retryable = retryable; return error; }
