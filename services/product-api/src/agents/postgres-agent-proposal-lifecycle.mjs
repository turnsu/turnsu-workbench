import { mergeSkillDraftProposal } from "./agent-proposal-merge.mjs";
import {
  applyWorkflowAgentOperations,
  mergeWorkflowProposal,
} from "../proposals/three-way-proposal-merge.mjs";
import { canonicalRequestHash, canonicalSkillDraftContentHash } from "../store/serialization.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import { PostgresAgentSessionDecisionCommandIntake } from "../coordination/postgres-agent-session-decision-command-intake.mjs";

const MEMBER_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/**
 * Narrow PG mutation owner for Module Agent proposal decisions. Each decision
 * remains scoped to the proposal creator's private branch. The first canonical
 * paths are a Skill Draft merge and a dependency-free private Loop merge. A
 * revision, proposal, branch, Session, event and receipt commit together.
 * Pinned or shared Loops fail closed until their publish/compile owner is
 * migrated; this path never falls back to a legacy repository.
 */
export class PostgresAgentProposalLifecycle {
  #store;
  #sql;
  #clock;
  #idFactory;
  #commandAuthorizer;
  #commandIntake;

  constructor({ store, clock = () => new Date().toISOString(), idFactory, commandAuthorizer, commandIntake } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function" || typeof idFactory !== "function"
      || typeof commandAuthorizer?.authorizeAgentProposalApply !== "function"
      || typeof commandAuthorizer?.authorizeAgentProposalReject !== "function") {
      throw new TypeError("postgres_agent_proposal_lifecycle_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#commandAuthorizer = commandAuthorizer;
    this.#commandIntake = commandIntake ?? new PostgresAgentSessionDecisionCommandIntake({ store });
    if (typeof this.#commandIntake.accept !== "function") {
      throw new TypeError("postgres_agent_proposal_lifecycle_command_intake_required");
    }
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async reject({ sessionId, proposalId, idempotencyKey, request, context } = {}) {
    for (const [value, code] of [
      [sessionId, "agent_session_id_required"], [proposalId, "agent_proposal_id_required"],
      [idempotencyKey, "idempotency_key_required"], [context?.workspaceId, "workspace_id_required"],
      [context?.userId, "user_id_required"],
    ]) required(value, code);
    const scope = `reject-agent-proposal:${context.userId}:${sessionId}:${proposalId}`;
    const requestHash = canonicalRequestHash(request);
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      const membership = (await query(`
        SELECT role FROM public.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE
      `, [context.workspaceId, context.userId])).rows[0];
      if (!membership || MEMBER_RANK[membership.role] < MEMBER_RANK.member) throw coded("workspace_role_forbidden");

      const receipt = (await query(`
        INSERT INTO public.product_idempotency_receipts (
          workspace_id, effective_principal_id, operation_scope, idempotency_key,
          request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
        ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, iso(this.#clock())])).rows[0];
      if (receipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
      if (receipt.response !== null) return structuredClone(receipt.response);

      const proposal = (await query(`
        SELECT * FROM public.agent_object_proposals
         WHERE proposal_id = $1 AND session_id = $2 AND workspace_id = $3
           AND user_id = $4 AND created_by = $4 FOR UPDATE
      `, [proposalId, sessionId, context.workspaceId, context.userId])).rows[0];
      if (!proposal) throw coded("agent_proposal_not_found");
      if (!["proposed", "conflicting"].includes(proposal.status)) throw coded("agent_proposal_state_invalid");

      const branch = (await query(`
        SELECT status FROM public.agent_branches
         WHERE branch_id = $1 AND workspace_id = $2 AND user_id = $3
           AND object_kind = $4 AND object_id = $5 AND base_version_id = $6 FOR UPDATE
      `, [proposal.branch_id, context.workspaceId, context.userId,
        proposal.object_kind, proposal.object_id, proposal.base_version_id])).rows[0];
      if (!branch || !["active", "conflicting"].includes(branch.status)) throw coded("agent_proposal_base_unavailable");

      const session = (await query(`
        SELECT status, active_turn_id, event_sequence FROM public.agent_sessions
         WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3 AND branch_id = $4 FOR UPDATE
      `, [sessionId, context.workspaceId, context.userId, proposal.branch_id])).rows[0];
      if (!session || session.status !== "active") throw coded("agent_proposal_not_found");
      if (session.active_turn_id !== null) throw coded("agent_proposal_state_invalid");

      const decidedAt = iso(this.#clock());
      const targetRevision = Number(session.event_sequence) + 1;
      const authority = await this.#commandAuthorizer.authorizeAgentProposalReject({
        workspaceId: context.workspaceId,
        userId: context.userId,
        sessionId,
        proposalId,
        targetRevision,
        uow,
      });
      const accepted = await this.#commandIntake.accept({
        principal: context,
        command: {
          commandId: this.#idFactory("product-command"),
          kind: "agent_proposal_reject",
          targetId: proposalId,
          targetRevision,
          ...authority,
        },
        at: decidedAt,
        uow,
        persistTarget: async ({ command }) => {
          await query(`UPDATE public.agent_branches
            SET status = 'rejected', updated_at = $4::timestamptz
            WHERE branch_id = $1 AND workspace_id = $2 AND user_id = $3`,
          [proposal.branch_id, context.workspaceId, context.userId, decidedAt]);
          const closed = (await query(`UPDATE public.agent_sessions
            SET status = 'closed', task_status = 'completed', active_turn_id = NULL,
                event_sequence = event_sequence + 1, updated_at = $4::timestamptz
            WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3
            RETURNING event_sequence`, [sessionId, context.workspaceId, context.userId, decidedAt])).rows[0];
          if (!closed || Number(closed.event_sequence) !== targetRevision) throw coded("agent_proposal_not_found");
          const rejected = (await query(`UPDATE public.agent_object_proposals
            SET status = 'rejected', decided_at = $4::timestamptz
            WHERE proposal_id = $1 AND workspace_id = $2 AND user_id = $3 AND status IN ('proposed', 'conflicting')
            RETURNING *`, [proposalId, context.workspaceId, context.userId, decidedAt])).rows[0];
          if (!rejected) throw coded("agent_proposal_state_invalid");
          const eventId = this.#idFactory("agent-event");
          await query(`INSERT INTO public.agent_session_events (
            event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
          ) VALUES ($1, $2, $3, 'workbench-v1', $4, 'agent.proposal.rejected', 'completed', $5, $6::timestamptz, $7::jsonb)`,
          [eventId, sessionId, proposal.turn_id, targetRevision,
            "Module Agent proposal rejected.", decidedAt, JSON.stringify({
              proposalId,
              branchId: proposal.branch_id,
              productCommandId: command.commandId,
            })]);
          await recordDecisionEvent({
            query,
            idFactory: this.#idFactory,
            context,
            command,
            sessionId,
            eventId,
            targetId: proposalId,
            targetRevision,
            actionKind: "agent_proposal_reject",
            statusAfter: "rejected",
            createdAt: decidedAt,
          });
          return proposalView(rejected);
        },
      });
      const response = accepted.target;
      await query(`UPDATE public.product_idempotency_receipts
        SET response = $6::jsonb, completed_at = $7::timestamptz
        WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3
          AND idempotency_key = $4 AND request_hash = $5`,
      [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, JSON.stringify(response), decidedAt]);
      return response;
    });
  }

  async apply({ sessionId, proposalId, idempotencyKey, request, context } = {}) {
    for (const [value, code] of [
      [sessionId, "agent_session_id_required"], [proposalId, "agent_proposal_id_required"],
      [idempotencyKey, "idempotency_key_required"], [context?.workspaceId, "workspace_id_required"],
      [context?.userId, "user_id_required"],
    ]) required(value, code);
    const scope = `apply-agent-proposal:${context.userId}:${sessionId}:${proposalId}`;
    const requestHash = canonicalRequestHash(request);
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      await requireMember(query, context);
      const receipt = await beginReceipt({
        query, context, scope, idempotencyKey, requestHash, now: iso(this.#clock()),
      });
      if (receipt.response !== null) return structuredClone(receipt.response);

      const proposal = await lockedProposal(query, { proposalId, sessionId, context });
      if (!proposal || proposal.status !== "proposed") throw coded(proposal ? "agent_proposal_state_invalid" : "agent_proposal_not_found");
      if (proposal.payload?.validationResult?.status !== "passed") throw coded("agent_proposal_validation_failed");
      const branch = await lockedBranch(query, { proposal, context });
      if (!branch || branch.status !== "active") throw coded("agent_proposal_base_unavailable");
      const session = await lockedSession(query, { sessionId, proposal, context, includeEventSequence: true });
      if (!session || session.status !== "active") throw coded("agent_proposal_not_found");
      if (session.active_turn_id !== null) throw coded("agent_proposal_state_invalid");

      const decidedAt = iso(this.#clock());
      const targetRevision = Number(session.event_sequence) + 1;
      const authority = await this.#commandAuthorizer.authorizeAgentProposalApply({
        workspaceId: context.workspaceId,
        userId: context.userId,
        sessionId,
        proposalId,
        targetRevision,
        uow,
      });
      const outcome = await this.#commandIntake.accept({
        principal: context,
        command: {
          commandId: this.#idFactory("product-command"),
          kind: "agent_proposal_apply",
          targetId: proposalId,
          targetRevision,
          ...authority,
        },
        at: decidedAt,
        uow,
        persistTarget: async ({ command }) => {
          const merged = proposal.object_kind === "skill_draft"
            ? await this.#applySkillDraft({ query, proposal, branch, context, decidedAt })
            : proposal.object_kind === "workflow"
              ? await this.#applyWorkflow({ query, proposal, branch, context, decidedAt })
              : (() => { throw coded("agent_proposal_object_lifecycle_unavailable"); })();
          if (merged.status === "conflicted") {
            const conflicting = await this.#persistConflict({
              query, proposal, branch, sessionId, context, conflicts: merged.conflicts, decidedAt,
              command, targetRevision,
            });
            await recordDecisionEvent({
              query,
              idFactory: this.#idFactory,
              context,
              command,
              sessionId,
              eventId: conflicting.sessionEventId,
              targetId: proposalId,
              targetRevision,
              actionKind: "agent_proposal_apply",
              statusAfter: "conflicting",
              createdAt: decidedAt,
            });
            return conflicting.proposal;
          }

          const accepted = await this.#closeAccepted({
            query, proposal, sessionId, context, decidedAt, command, targetRevision,
          });
          await recordDecisionEvent({
            query,
            idFactory: this.#idFactory,
            context,
            command,
            sessionId,
            eventId: accepted.sessionEventId,
            targetId: proposalId,
            targetRevision,
            actionKind: "agent_proposal_apply",
            statusAfter: "accepted",
            createdAt: decidedAt,
          });
          return accepted.proposal;
        },
      });
      await completeReceipt({ query, context, scope, idempotencyKey, requestHash, response: outcome.target, completedAt: decidedAt });
      return outcome.target;
    });
  }

  async #applySkillDraft({ query, proposal, branch, context, decidedAt }) {
    const row = (await query(`
      SELECT draft.*, asset.owner_user_id, asset.current_draft_id, asset.lifecycle AS asset_lifecycle,
             asset.payload AS asset_payload
        FROM public.skill_drafts draft
        JOIN public.skill_assets asset
          ON asset.workspace_id = draft.workspace_id AND asset.skill_id = draft.skill_id
       WHERE draft.workspace_id = $1 AND draft.skill_draft_id = $2
       FOR UPDATE
    `, [context.workspaceId, proposal.object_id])).rows[0];
    if (!row || row.owner_user_id !== context.userId || row.current_draft_id !== proposal.object_id
      || !["draft", "tested"].includes(row.asset_lifecycle)) {
      throw coded("agent_proposal_base_unavailable");
    }
    const base = branch.payload?.baseSnapshot;
    if (!isSkillDraftBase(base, proposal)) throw coded("agent_proposal_base_unavailable");
    const current = skillDraftView(row);
    let merge;
    try {
      merge = mergeSkillDraftProposal({ base, current, operations: proposal.payload?.operations });
    } catch (error) {
      throw coded(error?.code === "agent_proposal_path_forbidden" ? error.code : "agent_proposal_operation_invalid");
    }
    if (merge.status === "conflicted") return merge;

    const definition = {
      ...current,
      ...merge.patch,
      schemaVersion: "workbench-v1",
      skillDraftId: row.skill_draft_id,
      skillId: row.skill_id,
      workspaceId: context.workspaceId,
      baseVersionId: row.base_version_id ?? null,
      revision: Number(row.draft_revision) + 1,
      files: structuredClone(row.definition?.files ?? []),
      updatedBy: context.userId,
      createdAt: iso(row.created_at),
      updatedAt: decidedAt,
    };
    const contentHash = canonicalSkillDraftContentHash(definition);
    await query("SET CONSTRAINTS ALL DEFERRED");
    await query(`
      INSERT INTO public.skill_draft_revision_snapshots (
        workspace_id, skill_id, skill_draft_id, draft_revision, schema_version,
        package_object_id, package_object_kind, package_object_hash, package_hash,
        content_hash, created_by, created_at, definition
      ) VALUES ($1, $2, $3, $4, 'workbench-internal-v1', $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::jsonb)
    `, [context.workspaceId, row.skill_id, row.skill_draft_id, definition.revision,
      row.package_object_id ?? null, row.package_object_kind ?? null, row.package_object_hash ?? null,
      row.package_hash ?? null, contentHash, context.userId, decidedAt, JSON.stringify(definition)]);
    const updated = await query(`
      UPDATE public.skill_drafts
         SET draft_revision = $4, content_hash = $5, updated_by = $6,
             updated_at = $7::timestamptz, definition = $8::jsonb
       WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3
         AND draft_revision = $9
       RETURNING skill_draft_id
    `, [context.workspaceId, row.skill_id, row.skill_draft_id, definition.revision, contentHash,
      context.userId, decidedAt, JSON.stringify(definition), Number(row.draft_revision)]);
    if (!updated.rows[0]) throw coded("skill_draft_conflict");
    await query(`
      UPDATE public.skill_assets
         SET name_normalized = $3, lifecycle = 'draft', updated_at = $4::timestamptz,
             payload = $5::jsonb
       WHERE workspace_id = $1 AND skill_id = $2
    `, [context.workspaceId, row.skill_id, normalize(definition.name), decidedAt,
      JSON.stringify({ ...(row.asset_payload ?? {}), name: definition.name })]);
    return { status: "merged" };
  }

  async #applyWorkflow({ query, proposal, branch, context, decidedAt }) {
    const workflow = (await query(`SELECT * FROM public.workflows
      WHERE workspace_id = $1 AND workflow_id = $2 FOR UPDATE`,
    [context.workspaceId, proposal.object_id])).rows[0];
    if (!workflow || workflow.owner_user_id !== context.userId || workflow.visibility !== "private") {
      throw coded("agent_proposal_workflow_lifecycle_unavailable");
    }
    const currentRow = (await query(`SELECT * FROM public.workflow_revisions
      WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3 FOR UPDATE`,
    [context.workspaceId, proposal.object_id, workflow.current_revision_id])).rows[0];
    if (!currentRow) throw coded("agent_proposal_base_unavailable");
    const base = branch.payload?.baseSnapshot;
    if (!isWorkflowBase(base, proposal)) throw coded("agent_proposal_base_unavailable");
    const current = workflowRevisionView(currentRow);
    let merge;
    try {
      merge = mergeWorkflowProposal({
        base,
        current,
        proposed: applyWorkflowAgentOperations(base, proposal.payload?.operations),
      });
    } catch {
      throw coded("agent_proposal_operation_invalid");
    }
    if (merge.status === "conflicted") return merge;
    if (hasUnmigratedWorkflowDependencies(merge.merged)) {
      throw coded("workflow_reference_lifecycle_unavailable");
    }
    const revisionId = this.#idFactory("revision");
    const revisionNumber = Number(workflow.current_revision_number) + 1;
    const revision = {
      ...merge.merged,
      schemaVersion: "workbench-v1",
      revisionId,
      workflowId: proposal.object_id,
      revisionNumber,
      baseRevisionId: current.revisionId,
      contentHash: canonicalRequestHash({
        graph: merge.merged.graph,
        inputForm: merge.merged.inputForm,
        outputDefinition: merge.merged.outputDefinition,
        resourceRefs: merge.merged.resourceRefs,
        runSettings: merge.merged.runSettings,
        definition: merge.merged.definition ?? null,
      }),
      authoredBy: context.userId,
      saveReason: `Applied confirmed Agent proposal ${proposal.proposal_id}.`,
      compile: { status: "blocked", diagnostics: [] },
      createdAt: decidedAt,
      updatedAt: decidedAt,
    };
    await query("SET CONSTRAINTS ALL DEFERRED");
    await query(`INSERT INTO public.workflow_revisions (
      workspace_id, revision_id, workflow_id, revision_number, base_revision_id,
      base_revision_number, schema_version, graph, input_form, output_definition,
      resource_refs, run_settings, definition, content_hash, authored_by, save_reason,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'workbench-v1', $7::jsonb, $8::jsonb,
      $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15,
      $16::timestamptz, $16::timestamptz)`,
    [context.workspaceId, revisionId, proposal.object_id, revisionNumber, current.revisionId,
      Number(current.revisionNumber), JSON.stringify(revision.graph), JSON.stringify(revision.inputForm),
      JSON.stringify(revision.outputDefinition), JSON.stringify(revision.resourceRefs),
      JSON.stringify(revision.runSettings), JSON.stringify(revision.definition ?? null),
      revision.contentHash, context.userId, revision.saveReason, decidedAt]);
    const updated = await query(`UPDATE public.workflows
      SET current_revision_id = $3, current_revision_number = $4, write_version = $5,
          status = 'blocked', lifecycle = 'blocked', updated_at = $6::timestamptz
      WHERE workspace_id = $1 AND workflow_id = $2
        AND current_revision_id = $7 AND write_version = $8 AND visibility = 'private'
      RETURNING workflow_id`,
    [context.workspaceId, proposal.object_id, revisionId, revisionNumber, Number(workflow.write_version) + 1,
      decidedAt, current.revisionId, Number(workflow.write_version)]);
    if (!updated.rows[0]) throw coded("workflow_revision_conflict");
    return { status: "merged" };
  }

  async #persistConflict({ query, proposal, branch, sessionId, context, conflicts, decidedAt, command, targetRevision }) {
    const payload = { ...(proposal.payload ?? {}), conflicts: structuredClone(conflicts) };
    await query(`UPDATE public.agent_branches
      SET status = 'conflicting', updated_at = $4::timestamptz
      WHERE branch_id = $1 AND workspace_id = $2 AND user_id = $3`,
    [proposal.branch_id, context.workspaceId, context.userId, decidedAt]);
    const progressed = (await query(`UPDATE public.agent_sessions
      SET event_sequence = event_sequence + 1, updated_at = $4::timestamptz
      WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3
      RETURNING event_sequence`, [sessionId, context.workspaceId, context.userId, decidedAt])).rows[0];
    if (!progressed || Number(progressed.event_sequence) !== targetRevision) throw coded("agent_proposal_not_found");
    const proposalRow = (await query(`UPDATE public.agent_object_proposals
      SET status = 'conflicting', decided_at = NULL, payload = $4::jsonb
      WHERE proposal_id = $1 AND workspace_id = $2 AND user_id = $3 AND status = 'proposed'
      RETURNING *`, [proposal.proposal_id, context.workspaceId, context.userId, JSON.stringify(payload)])).rows[0];
    if (!proposalRow) throw coded("agent_proposal_state_invalid");
    const eventId = this.#idFactory("agent-event");
    await query(`INSERT INTO public.agent_session_events (
      event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
    ) VALUES ($1, $2, $3, 'workbench-v1', $4, 'agent.proposal.conflicting', 'blocked', $5, $6::timestamptz, $7::jsonb)`,
    [eventId, sessionId, proposal.turn_id, targetRevision,
      "Module Agent proposal needs conflict resolution.", decidedAt,
      JSON.stringify({
        proposalId: proposal.proposal_id,
        branchId: proposal.branch_id,
        conflictCount: conflicts.length,
        productCommandId: command.commandId,
      })]);
    return { proposal: proposalView(proposalRow), sessionEventId: eventId };
  }

  async #closeAccepted({ query, proposal, sessionId, context, decidedAt, command, targetRevision }) {
    await query(`UPDATE public.agent_branches
      SET status = 'merged', updated_at = $4::timestamptz
      WHERE branch_id = $1 AND workspace_id = $2 AND user_id = $3`,
    [proposal.branch_id, context.workspaceId, context.userId, decidedAt]);
    const closed = (await query(`UPDATE public.agent_sessions
      SET status = 'closed', task_status = 'completed', active_turn_id = NULL,
          event_sequence = event_sequence + 1, updated_at = $4::timestamptz
      WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3
      RETURNING event_sequence`, [sessionId, context.workspaceId, context.userId, decidedAt])).rows[0];
    if (!closed || Number(closed.event_sequence) !== targetRevision) throw coded("agent_proposal_not_found");
    const accepted = (await query(`UPDATE public.agent_object_proposals
      SET status = 'accepted', decided_at = $4::timestamptz
      WHERE proposal_id = $1 AND workspace_id = $2 AND user_id = $3 AND status = 'proposed'
      RETURNING *`, [proposal.proposal_id, context.workspaceId, context.userId, decidedAt])).rows[0];
    if (!accepted) throw coded("agent_proposal_state_invalid");
    const eventId = this.#idFactory("agent-event");
    await query(`INSERT INTO public.agent_session_events (
      event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
    ) VALUES ($1, $2, $3, 'workbench-v1', $4, 'agent.proposal.accepted', 'completed', $5, $6::timestamptz, $7::jsonb)`,
    [eventId, sessionId, proposal.turn_id, targetRevision,
      "Module Agent proposal applied to the private Skill Draft.", decidedAt,
      JSON.stringify({
        proposalId: proposal.proposal_id,
        branchId: proposal.branch_id,
        productCommandId: command.commandId,
      })]);
    return { proposal: proposalView(accepted), sessionEventId: eventId };
  }
}

async function requireMember(query, context) {
  const membership = (await query(`
    SELECT role FROM public.workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE
  `, [context.workspaceId, context.userId])).rows[0];
  if (!membership || MEMBER_RANK[membership.role] < MEMBER_RANK.member) throw coded("workspace_role_forbidden");
}

async function beginReceipt({ query, context, scope, idempotencyKey, requestHash, now }) {
  const receipt = (await query(`
    INSERT INTO public.product_idempotency_receipts (
      workspace_id, effective_principal_id, operation_scope, idempotency_key,
      request_hash, response, created_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
    ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
    DO UPDATE SET operation_scope = EXCLUDED.operation_scope
    RETURNING request_hash, response
  `, [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, now])).rows[0];
  if (receipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
  return receipt;
}

async function completeReceipt({ query, context, scope, idempotencyKey, requestHash, response, completedAt }) {
  await query(`UPDATE public.product_idempotency_receipts
    SET response = $6::jsonb, completed_at = $7::timestamptz
    WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3
      AND idempotency_key = $4 AND request_hash = $5`,
  [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, JSON.stringify(response), completedAt]);
}

async function recordDecisionEvent({
  query,
  idFactory,
  context,
  command,
  sessionId,
  eventId,
  targetId,
  targetRevision,
  actionKind,
  statusAfter,
  createdAt,
}) {
  await query(`INSERT INTO public.agent_session_decision_events (
    workspace_id, decision_event_id, product_command_id, session_id, session_event_id,
    target_kind, target_id, target_revision, action_kind, status_after, actor_user_id, created_at, payload
  ) VALUES ($1, $2, $3, $4, $5, 'agent_proposal', $6, $7, $8, $9, $10, $11::timestamptz, '{}'::jsonb)`,
  [
    context.workspaceId,
    idFactory("agent-session-decision"),
    command.commandId,
    sessionId,
    eventId,
    targetId,
    targetRevision,
    actionKind,
    statusAfter,
    context.userId,
    createdAt,
  ]);
}

async function lockedProposal(query, { proposalId, sessionId, context }) {
  return (await query(`SELECT * FROM public.agent_object_proposals
    WHERE proposal_id = $1 AND session_id = $2 AND workspace_id = $3
      AND user_id = $4 AND created_by = $4 FOR UPDATE`,
  [proposalId, sessionId, context.workspaceId, context.userId])).rows[0];
}

async function lockedBranch(query, { proposal, context }) {
  return (await query(`SELECT * FROM public.agent_branches
    WHERE branch_id = $1 AND workspace_id = $2 AND user_id = $3
      AND object_kind = $4 AND object_id = $5 AND base_version_id = $6 FOR UPDATE`,
  [proposal.branch_id, context.workspaceId, context.userId,
    proposal.object_kind, proposal.object_id, proposal.base_version_id])).rows[0];
}

async function lockedSession(query, { sessionId, proposal, context, includeEventSequence = false }) {
  return (await query(`SELECT status, active_turn_id${includeEventSequence ? ", event_sequence" : ""} FROM public.agent_sessions
    WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3 AND branch_id = $4 FOR UPDATE`,
  [sessionId, context.workspaceId, context.userId, proposal.branch_id])).rows[0];
}

function skillDraftView(row) {
  return {
    ...(row.definition ?? {}), schemaVersion: row.schema_version, skillDraftId: row.skill_draft_id,
    skillId: row.skill_id, workspaceId: row.workspace_id, baseVersionId: row.base_version_id ?? null,
    revision: Number(row.draft_revision), contentHash: row.content_hash, updatedBy: row.updated_by,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function isSkillDraftBase(base, proposal) {
  return base && base.skillDraftId === proposal.object_id
    && `${base.skillDraftId}:${Number(base.revision)}` === proposal.base_version_id;
}

function isWorkflowBase(base, proposal) {
  return base && base.workflowId === proposal.object_id && base.revisionId === proposal.base_version_id;
}

function workflowRevisionView(row) {
  return {
    schemaVersion: row.schema_version, revisionId: row.revision_id, workflowId: row.workflow_id,
    revisionNumber: Number(row.revision_number), baseRevisionId: row.base_revision_id ?? null,
    graph: structuredClone(row.graph), inputForm: structuredClone(row.input_form),
    outputDefinition: structuredClone(row.output_definition), resourceRefs: structuredClone(row.resource_refs ?? []),
    runSettings: structuredClone(row.run_settings), ...(row.definition == null ? {} : { definition: structuredClone(row.definition) }),
    contentHash: row.content_hash, authoredBy: row.authored_by, saveReason: row.save_reason,
    compile: { status: "blocked", diagnostics: [] }, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function hasUnmigratedWorkflowDependencies(revision) {
  return (revision.resourceRefs ?? []).length > 0
    || (revision.graph?.nodes ?? []).some((node) => node?.kind === "Skill");
}

function normalize(value) { return String(value).normalize("NFKC").trim().toLowerCase(); }

function proposalView(row) {
  return {
    ...(row.payload ?? {}), schemaVersion: row.schema_version, proposalId: row.proposal_id,
    workspaceId: row.workspace_id, userId: row.user_id, sessionId: row.session_id, turnId: row.turn_id,
    branchId: row.branch_id, definitionId: row.definition_id, objectKind: row.object_kind,
    objectId: row.object_id, baseVersionId: row.base_version_id, status: row.status,
    createdBy: row.created_by, createdAt: iso(row.created_at), decidedAt: row.decided_at ? iso(row.decided_at) : null,
  };
}

function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function coded(code) { return new ProductStoreError(code, code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_agent_proposal_clock_invalid"); return date.toISOString(); }
