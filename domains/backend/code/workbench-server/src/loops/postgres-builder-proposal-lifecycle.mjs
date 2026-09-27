import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash, formatWorkflowEtag } from "../store/serialization.mjs";
import { applyBuilderOperations } from "../proposals/apply-builder-operations.mjs";
import { mergeWorkflowProposal } from "../proposals/three-way-proposal-merge.mjs";
import { Check, WorkflowRevisionSchema } from "@looloomi/workbench-contracts";

import { requireWorkflowReferences } from "./postgres-workflow-references.mjs";

const MEMBER_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/** Read and review decision boundary for durable Builder proposals. */
export class PostgresBuilderProposalReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_builder_proposal_read_model_store_required");
    }
    this.#store = store;
    this.#sql = adapter(store);
  }

  async getStaged({ proposalId, workspaceId, userId, now = new Date().toISOString() } = {}) {
    required(proposalId, "builder_proposal_id_required");
    const proposal = await this.#read({ proposalId, workspaceId, userId, kind: "staged_loop_draft" });
    if (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.parse(now)) throw coded("builder_proposal_expired");
    return proposal;
  }

  async getWorkflowProposal({ proposalId, workflowId, workspaceId, userId } = {}) {
    required(proposalId, "builder_proposal_id_required"); required(workflowId, "workflow_id_required");
    return this.#read({ proposalId, workflowId, workspaceId, userId, kind: "workflow_change" });
  }

  async #read({ proposalId, workflowId = null, workspaceId, userId, kind }) {
    required(workspaceId, "workspace_id_required"); required(userId, "user_id_required");
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#sql.query(uow, `SELECT * FROM public.builder_proposals
        WHERE workspace_id = $1 AND proposal_id = $2
          AND created_by_principal_id = $3 AND created_by_principal_kind = 'user'
          AND kind = $4 AND ($5::text IS NULL OR workflow_id = $5)`,
      [workspaceId, proposalId, userId, kind, workflowId])).rows[0];
      if (!row || row.generation_status !== "completed") throw coded("builder_proposal_not_found");
      return builderProposalView(row);
    });
  }
}

/** Owns only a Builder proposal dismissal; canonical Loop data never changes. */
export class PostgresBuilderProposalLifecycle {
  #store;
  #sql;
  #clock;
  #commandIntake;
  #commandAuthorizer;

  constructor({ store, clock = () => new Date().toISOString(), commandIntake = null, commandAuthorizer = null } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function") {
      throw new TypeError("postgres_builder_proposal_lifecycle_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#commandIntake = commandIntake;
    this.#commandAuthorizer = commandAuthorizer;
    this.#sql = adapter(store);
  }

  async beginStagedGeneration({ proposalId, context, request, expiresInMs = 86_400_000 } = {}) {
    for (const [value, code] of [[proposalId, "builder_proposal_id_required"], [context?.workspaceId, "workspace_id_required"], [context?.userId, "user_id_required"]]) required(value, code);
    if (!this.#commandIntake?.accept || !this.#commandAuthorizer?.authorizeBuilderProposal) {
      throw coded("builder_proposal_generation_lifecycle_unavailable");
    }
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 7 * 86_400_000) {
      throw coded("builder_proposal_expiry_invalid");
    }
    const authorization = await this.#commandAuthorizer.authorizeBuilderProposal({
      workspaceId: context.workspaceId,
      userId: context.userId,
      proposalId,
      input: { sourceText: request?.data?.sourceText, name: request?.data?.name, definition: request?.data?.definition },
    });
    const createdAt = iso(this.#clock());
    const expiresAt = new Date(Date.parse(createdAt) + expiresInMs).toISOString();
    const commandId = builderCommandId(proposalId);
    const execution = builderExecutionIdentity(proposalId);
    const accepted = await this.#commandIntake.accept({
      principal: context,
      command: {
        schemaVersion: "workbench-v1", commandId, kind: "builder_proposal",
        sessionId: `builder-${proposalId}`.slice(0, 128),
        turnId: `builder-${proposalId}`.slice(0, 128),
        scopeId: authorization.scopeId, authorizationDecisionId: authorization.authorizationDecisionId,
        argumentDigest: authorization.argumentDigest,
      },
      at: createdAt,
      persistTarget: async ({ uow }) => {
        const query = (text, values = []) => this.#sql.query(uow, text, values);
        const row = (await query(`INSERT INTO public.builder_proposals (
          workspace_id, proposal_id, scope_id, created_by_principal_id, created_by_principal_kind,
          product_command_id, schema_version, kind, workflow_id, base_revision_id,
          planned_invocation_id, planned_attempt_id, source_invocation_id, source_attempt_id,
          status, generation_status, summary, prompt, staged_draft, operations, diagnostics,
          permission_impact, expires_at, created_at, decided_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $5, 'workbench-v1', 'staged_loop_draft', NULL, NULL,
          $6, $7, NULL, NULL, 'generating', 'accepted', 'Generating Loop proposal.', NULL,
          '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $8::timestamptz,
          $9::timestamptz, NULL, $10::jsonb)
        RETURNING *`, [context.workspaceId, proposalId, authorization.scopeId, context.userId, commandId,
          execution.invocationId, execution.attemptId, expiresAt, createdAt,
          JSON.stringify({ requestHash: canonicalRequestHash(request) })])).rows[0];
        return builderProposalView(row);
      },
      loadTarget: async ({ uow }) => this.#loadGenerated({ uow, proposalId, context }),
    });
    return { proposal: accepted.target, command: accepted.command, execution };
  }

  async startGeneration({ proposalId, context } = {}) {
    for (const [value, code] of [[proposalId, "builder_proposal_id_required"], [context?.workspaceId, "workspace_id_required"], [context?.userId, "user_id_required"]]) required(value, code);
    if (!this.#commandIntake?.start) throw coded("builder_proposal_generation_lifecycle_unavailable");
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      const proposal = await this.#loadGenerated({ uow, proposalId, context, lock: true });
      if (proposal.generationStatus !== "accepted") throw coded("builder_proposal_state_invalid");
      const now = iso(this.#clock());
      const command = await this.#commandIntake.start({ principal: context, commandId: proposal.productCommandId, at: now, uow });
      const row = (await query(`UPDATE public.builder_proposals
        SET generation_status = 'running'
        WHERE workspace_id = $1 AND proposal_id = $2 AND generation_status = 'accepted'
        RETURNING *`, [context.workspaceId, proposalId])).rows[0];
      if (!row) throw coded("builder_proposal_state_invalid");
      return { proposal: builderProposalView(row), command, execution: { invocationId: row.planned_invocation_id, attemptId: row.planned_attempt_id } };
    });
  }

  async completeStagedGeneration({ proposalId, context, result } = {}) {
    for (const [value, code] of [[proposalId, "builder_proposal_id_required"], [context?.workspaceId, "workspace_id_required"], [context?.userId, "user_id_required"]]) required(value, code);
    if (!this.#commandIntake?.settle) throw coded("builder_proposal_generation_lifecycle_unavailable");
    const candidate = stagedGenerationResult(result);
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      const proposal = await this.#loadGenerated({ uow, proposalId, context, lock: true });
      if (proposal.generationStatus !== "running") throw coded("builder_proposal_state_invalid");
      if (candidate.invocationId !== proposal.plannedInvocationId || candidate.attemptId !== proposal.plannedAttemptId) {
        throw coded("builder_proposal_execution_identity_mismatch");
      }
      const now = iso(this.#clock());
      const status = candidate.diagnostics.some((diagnostic) => diagnostic?.severity === "error") ? "invalid" : "proposed";
      const row = (await query(`UPDATE public.builder_proposals
        SET source_invocation_id = $3, source_attempt_id = $4, status = $5,
            generation_status = 'completed', summary = $6, staged_draft = $7::jsonb,
            operations = $8::jsonb, diagnostics = $9::jsonb, permission_impact = $10::jsonb,
            decided_at = CASE WHEN $5 = 'invalid' THEN $11::timestamptz ELSE NULL END
        WHERE workspace_id = $1 AND proposal_id = $2 AND generation_status = 'running'
        RETURNING *`, [context.workspaceId, proposalId, candidate.invocationId, candidate.attemptId, status,
        candidate.summary, JSON.stringify(candidate.draft), JSON.stringify(candidate.operations),
        JSON.stringify(candidate.diagnostics), JSON.stringify(candidate.permissionImpact), now])).rows[0];
      if (!row) throw coded("builder_proposal_state_invalid");
      const command = await this.#commandIntake.settle({ principal: context, commandId: proposal.productCommandId, status: "completed", at: now, uow });
      return { proposal: builderProposalView(row), command };
    });
  }

  async failStagedGeneration({ proposalId, context, status = "blocked" } = {}) {
    for (const [value, code] of [[proposalId, "builder_proposal_id_required"], [context?.workspaceId, "workspace_id_required"], [context?.userId, "user_id_required"]]) required(value, code);
    if (!["failed", "blocked"].includes(status) || !this.#commandIntake?.settle) throw coded("builder_proposal_generation_lifecycle_unavailable");
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      const proposal = await this.#loadGenerated({ uow, proposalId, context, lock: true });
      if (!["accepted", "running"].includes(proposal.generationStatus)) return proposal;
      const now = iso(this.#clock());
      const row = (await query(`UPDATE public.builder_proposals
        SET status = 'invalid', generation_status = $3, summary = 'Loop proposal generation is unavailable.',
            decided_at = $4::timestamptz
        WHERE workspace_id = $1 AND proposal_id = $2 AND generation_status IN ('accepted', 'running')
        RETURNING *`, [context.workspaceId, proposalId, status, now])).rows[0];
      if (!row) throw coded("builder_proposal_state_invalid");
      await this.#commandIntake.settle({ principal: context, commandId: proposal.productCommandId, status, at: now, uow });
      return builderProposalView(row);
    });
  }

  async dismiss({ proposalId, workflowId = null, staged = false, idempotencyKey, request, context, ifMatch = null } = {}) {
    required(proposalId, "builder_proposal_id_required"); required(idempotencyKey, "idempotency_key_required");
    required(context?.workspaceId, "workspace_id_required"); required(context?.userId, "user_id_required");
    const kind = staged ? "staged_loop_draft" : "workflow_change";
    if (!staged) required(workflowId, "workflow_id_required");
    const scope = staged
      ? `dismiss-staged-loop-proposal:${proposalId}`
      : `dismiss-builder-proposal:${workflowId}:${proposalId}`;
    const requestHash = canonicalRequestHash(staged ? request : { ifMatch, request });
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      await requireMember(query, context);
      const receipt = await beginReceipt({ query, context, scope, idempotencyKey, requestHash, now: iso(this.#clock()) });
      if (receipt.response !== null) return structuredClone(receipt.response);
      const proposal = (await query(`SELECT * FROM public.builder_proposals
        WHERE workspace_id = $1 AND proposal_id = $2
          AND created_by_principal_id = $3 AND created_by_principal_kind = 'user'
          AND kind = $4 AND ($5::text IS NULL OR workflow_id = $5)
        FOR UPDATE`, [context.workspaceId, proposalId, context.userId, kind, workflowId])).rows[0];
      if (!proposal || proposal.generation_status !== "completed") throw coded("builder_proposal_not_found");
      if (!["proposed", "invalid"].includes(proposal.status)) throw coded("builder_proposal_state_invalid");
      if (!staged) await requireWorkflowBase(query, { workflowId, proposal, context, ifMatch });
      const decidedAt = iso(this.#clock());
      const dismissed = (await query(`UPDATE public.builder_proposals
        SET status = 'dismissed', decided_at = $3::timestamptz
        WHERE workspace_id = $1 AND proposal_id = $2 AND status IN ('proposed', 'invalid')
        RETURNING *`, [context.workspaceId, proposalId, decidedAt])).rows[0];
      if (!dismissed) throw coded("builder_proposal_state_invalid");
      const response = builderProposalView(dismissed);
      await completeReceipt({ query, context, scope, idempotencyKey, requestHash, response, completedAt: decidedAt });
      return response;
    });
  }

  async apply({ proposalId, workflowId, idempotencyKey, ifMatch, request, context } = {}) {
    for (const [value, code] of [
      [proposalId, "builder_proposal_id_required"], [workflowId, "workflow_id_required"],
      [idempotencyKey, "idempotency_key_required"], [ifMatch, "workflow_etag_required"],
      [context?.workspaceId, "workspace_id_required"], [context?.userId, "user_id_required"],
    ]) required(value, code);
    const scope = `apply-builder-proposal:${workflowId}:${proposalId}`;
    const requestHash = canonicalRequestHash({ ifMatch, request });
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      await requireMember(query, context);
      const receipt = await beginReceipt({ query, context, scope, idempotencyKey, requestHash, now: iso(this.#clock()) });
      if (receipt.response !== null) return structuredClone(receipt.response);
      const proposal = (await query(`SELECT * FROM public.builder_proposals
        WHERE workspace_id = $1 AND proposal_id = $2 AND workflow_id = $3
          AND created_by_principal_id = $4 AND created_by_principal_kind = 'user'
          AND kind = 'workflow_change'
        FOR UPDATE`, [context.workspaceId, proposalId, workflowId, context.userId])).rows[0];
      if (!proposal || proposal.generation_status !== "completed") throw coded("builder_proposal_not_found");
      if (proposal.status !== "proposed") throw coded("builder_proposal_state_invalid");
      const workflow = (await query(`SELECT * FROM public.workflows
        WHERE workspace_id = $1 AND workflow_id = $2 FOR UPDATE`,
      [context.workspaceId, workflowId])).rows[0];
      if (!workflow || workflow.visibility !== "private") throw coded("builder_proposal_workflow_lifecycle_unavailable");
      if (workflow.current_revision_id !== proposal.base_revision_id
        || formatWorkflowEtag({ workflowId, currentRevisionId: workflow.current_revision_id, writeVersion: Number(workflow.write_version) }) !== ifMatch) {
        throw coded("workflow_revision_conflict");
      }
      const baseRow = (await query(`SELECT * FROM public.workflow_revisions
        WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3 FOR UPDATE`,
      [context.workspaceId, workflowId, proposal.base_revision_id])).rows[0];
      if (!baseRow) throw coded("workflow_revision_not_found");
      const base = workflowRevisionView(baseRow);
      let merge;
      try {
        merge = mergeWorkflowProposal({ base, current: base, proposed: applyBuilderOperations(base, proposal.operations ?? []) });
      } catch {
        throw coded("builder_proposal_invalid");
      }
      if (merge.status === "conflicted") throw coded("builder_proposal_state_invalid");
      const references = await requireWorkflowReferences({ query, workspaceId: context.workspaceId, userId: context.userId, revision: merge.merged });
      merge = { ...merge, merged: { ...merge.merged, resourceRefs: references.resourceRefs } };
      const decidedAt = iso(this.#clock());
      const revisionId = `revision-${proposalId}`.slice(0, 128);
      const revisionNumber = Number(workflow.current_revision_number) + 1;
      const revision = {
        ...merge.merged,
        schemaVersion: "workbench-v1", revisionId, workflowId, revisionNumber,
        baseRevisionId: base.revisionId,
        contentHash: canonicalRequestHash({
          graph: merge.merged.graph, inputForm: merge.merged.inputForm,
          outputDefinition: merge.merged.outputDefinition, resourceRefs: merge.merged.resourceRefs,
          runSettings: merge.merged.runSettings, definition: merge.merged.definition ?? null,
        }),
        authoredBy: context.userId,
        saveReason: `Applied confirmed workflow changes ${proposalId}.`,
        compile: { status: "blocked", diagnostics: [] }, createdAt: decidedAt, updatedAt: decidedAt,
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
      [context.workspaceId, revisionId, workflowId, revisionNumber, base.revisionId, Number(base.revisionNumber),
        JSON.stringify(revision.graph), JSON.stringify(revision.inputForm), JSON.stringify(revision.outputDefinition),
        JSON.stringify(revision.resourceRefs), JSON.stringify(revision.runSettings), JSON.stringify(revision.definition ?? null),
        revision.contentHash, context.userId, revision.saveReason, decidedAt]);
      const advanced = (await query(`UPDATE public.workflows
        SET current_revision_id = $3, current_revision_number = $4, write_version = $5,
            status = 'blocked', lifecycle = 'blocked', latest_compile_result_id = NULL, updated_at = $6::timestamptz
        WHERE workspace_id = $1 AND workflow_id = $2 AND current_revision_id = $7
          AND write_version = $8 AND visibility = 'private'
        RETURNING workflow_id`,
      [context.workspaceId, workflowId, revisionId, revisionNumber, Number(workflow.write_version) + 1,
        decidedAt, base.revisionId, Number(workflow.write_version)])).rows[0];
      if (!advanced) throw coded("workflow_revision_conflict");
      const applied = (await query(`UPDATE public.builder_proposals
        SET status = 'applied', decided_at = $3::timestamptz
        WHERE workspace_id = $1 AND proposal_id = $2 AND status = 'proposed'
        RETURNING *`, [context.workspaceId, proposalId, decidedAt])).rows[0];
      if (!applied) throw coded("builder_proposal_state_invalid");
      const response = builderProposalView(applied);
      await completeReceipt({ query, context, scope, idempotencyKey, requestHash, response, completedAt: decidedAt });
      return response;
    });
  }

  async commitStaged({ proposalId, idempotencyKey, request, context } = {}) {
    for (const [value, code] of [
      [proposalId, "builder_proposal_id_required"], [idempotencyKey, "idempotency_key_required"],
      [context?.workspaceId, "workspace_id_required"], [context?.userId, "user_id_required"],
    ]) required(value, code);
    const scope = `commit-staged-loop-proposal:${proposalId}`;
    const requestHash = canonicalRequestHash(request);
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      await requireMember(query, context);
      const receipt = await beginReceipt({ query, context, scope, idempotencyKey, requestHash, now: iso(this.#clock()) });
      if (receipt.response !== null) return structuredClone(receipt.response);
      const proposal = (await query(`SELECT * FROM public.builder_proposals
        WHERE workspace_id = $1 AND proposal_id = $2
          AND created_by_principal_id = $3 AND created_by_principal_kind = 'user'
          AND kind = 'staged_loop_draft'
        FOR UPDATE`, [context.workspaceId, proposalId, context.userId])).rows[0];
      if (!proposal || proposal.generation_status !== "completed") throw coded("builder_proposal_not_found");
      if (!['proposed', 'invalid'].includes(proposal.status)) throw coded("builder_proposal_state_invalid");
      if (!proposal.expires_at || Date.parse(proposal.expires_at) <= Date.parse(this.#clock())) throw coded("builder_proposal_expired");
      const reviewedDraft = stagedDraft(request?.data?.draft);
      const references = await requireWorkflowReferences({ query, workspaceId: context.workspaceId, userId: context.userId, revision: reviewedDraft });
      const draft = { ...reviewedDraft, resourceRefs: references.resourceRefs };
      const personalScope = (await query(`SELECT scope_id FROM public.product_scopes
        WHERE workspace_id = $1 AND owner_user_id = $2 AND scope_kind = 'personal'
          AND status = 'active' LIMIT 1 FOR SHARE`,
      [context.workspaceId, context.userId])).rows[0];
      if (!personalScope) throw coded("personal_scope_not_found");
      const committedAt = iso(this.#clock());
      const workflowId = `workflow-${proposalId}`.slice(0, 128);
      const revisionId = `revision-${proposalId}`.slice(0, 128);
      const revision = {
        schemaVersion: "workbench-v1", revisionId, workflowId, revisionNumber: 1, baseRevisionId: null,
        graph: draft.graph, inputForm: draft.inputForm, outputDefinition: draft.outputDefinition,
        resourceRefs: draft.resourceRefs, runSettings: draft.runSettings,
        ...(draft.definition == null ? {} : { definition: draft.definition }),
        contentHash: canonicalRequestHash({
          graph: draft.graph, inputForm: draft.inputForm, outputDefinition: draft.outputDefinition,
          resourceRefs: draft.resourceRefs, runSettings: draft.runSettings, definition: draft.definition ?? null,
        }),
        authoredBy: context.userId, saveReason: `Created from staged proposal ${proposalId}.`,
        compile: { status: "blocked", diagnostics: [] }, createdAt: committedAt, updatedAt: committedAt,
      };
      if (!Check(WorkflowRevisionSchema, revision)) throw coded("builder_proposal_invalid");
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version, name, description,
        status, lifecycle, visibility, archived, current_revision_id, current_revision_number,
        write_version, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, 'draft', 'draft', 'private', false,
        $7, 1, 1, $8::timestamptz, $8::timestamptz, '{}'::jsonb)`,
      [context.workspaceId, workflowId, personalScope.scope_id, context.userId,
        draft.name, draft.description, revisionId, committedAt]);
      await query(`INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, base_revision_id,
        base_revision_number, schema_version, graph, input_form, output_definition,
        resource_refs, run_settings, definition, content_hash, authored_by, save_reason,
        created_at, updated_at
      ) VALUES ($1, $2, $3, 1, NULL, NULL, 'workbench-v1', $4::jsonb, $5::jsonb,
        $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12,
        $13::timestamptz, $13::timestamptz)`,
      [context.workspaceId, revisionId, workflowId, JSON.stringify(revision.graph),
        JSON.stringify(revision.inputForm), JSON.stringify(revision.outputDefinition),
        JSON.stringify(revision.resourceRefs), JSON.stringify(revision.runSettings), JSON.stringify(revision.definition ?? null),
        revision.contentHash, context.userId, revision.saveReason, committedAt]);
      const applied = (await query(`UPDATE public.builder_proposals
        SET status = 'applied', decided_at = $3::timestamptz, staged_draft = $4::jsonb
        WHERE workspace_id = $1 AND proposal_id = $2 AND status IN ('proposed', 'invalid')
        RETURNING *`, [context.workspaceId, proposalId, committedAt, JSON.stringify(draft)])).rows[0];
      if (!applied) throw coded("builder_proposal_state_invalid");
      const workflow = {
        schemaVersion: "workbench-v1", workflowId, workspaceId: context.workspaceId,
        scopeId: personalScope.scope_id, ownerId: context.userId, name: draft.name, description: draft.description,
        status: "draft", lifecycle: "draft", visibility: "private", archived: false,
        currentRevisionId: revisionId, revisionNumber: 1, writeVersion: 1,
        createdAt: committedAt, updatedAt: committedAt,
      };
      const response = { workflow, revision, proposal: builderProposalView(applied), etag: formatWorkflowEtag(workflow) };
      await completeReceipt({ query, context, scope, idempotencyKey, requestHash, response, completedAt: committedAt });
      return response;
    });
  }

  async #loadGenerated({ uow, proposalId, context, lock = false }) {
    const query = (text, values = []) => this.#sql.query(uow, text, values);
    const row = (await query(`SELECT * FROM public.builder_proposals
      WHERE workspace_id = $1 AND proposal_id = $2
        AND created_by_principal_id = $3 AND created_by_principal_kind = 'user'
        AND kind = 'staged_loop_draft'${lock ? " FOR UPDATE" : ""}`,
    [context.workspaceId, proposalId, context.userId])).rows[0];
    if (!row) throw coded("builder_proposal_not_found");
    return builderProposalView(row);
  }
}

function adapter(store) {
  return store.bindAdapter(({ execute }) => Object.freeze({
    query: (uow, text, values = []) => execute(uow, { text, values }),
  }));
}

async function requireMember(query, context) {
  const member = (await query(`SELECT role FROM public.workspace_memberships
    WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`,
  [context.workspaceId, context.userId])).rows[0];
  if (!member || MEMBER_RANK[member.role] < MEMBER_RANK.member) throw coded("workspace_role_forbidden");
}

async function requireWorkflowBase(query, { workflowId, proposal, context, ifMatch }) {
  const workflow = (await query(`SELECT workflow_id, current_revision_id, write_version
    FROM public.workflows WHERE workspace_id = $1 AND workflow_id = $2 FOR SHARE`,
  [context.workspaceId, workflowId])).rows[0];
  if (!workflow) throw coded("workflow_not_found");
  if (workflow.current_revision_id !== proposal.base_revision_id
    || formatWorkflowEtag({ workflowId, currentRevisionId: workflow.current_revision_id, writeVersion: Number(workflow.write_version) }) !== ifMatch) {
    throw coded("workflow_revision_conflict");
  }
}

async function beginReceipt({ query, context, scope, idempotencyKey, requestHash, now }) {
  const row = (await query(`INSERT INTO public.product_idempotency_receipts (
    workspace_id, effective_principal_id, operation_scope, idempotency_key,
    request_hash, response, created_at, completed_at
  ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
  ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
  DO UPDATE SET operation_scope = EXCLUDED.operation_scope
  RETURNING request_hash, response`,
  [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, now])).rows[0];
  if (row.request_hash !== requestHash) throw coded("idempotency_key_reused");
  return row;
}

async function completeReceipt({ query, context, scope, idempotencyKey, requestHash, response, completedAt }) {
  await query(`UPDATE public.product_idempotency_receipts
    SET response = $6::jsonb, completed_at = $7::timestamptz
    WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3
      AND idempotency_key = $4 AND request_hash = $5`,
  [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, JSON.stringify(response), completedAt]);
}

function builderProposalView(row) {
  return {
    ...(row.payload ?? {}), schemaVersion: row.schema_version, proposalId: row.proposal_id,
    productCommandId: row.product_command_id, invocationId: row.source_invocation_id ?? null,
    plannedInvocationId: row.planned_invocation_id ?? null, plannedAttemptId: row.planned_attempt_id ?? null,
    sourceAttemptId: row.source_attempt_id ?? null, generationStatus: row.generation_status,
    workspaceId: row.workspace_id, ...(row.workflow_id ? { workflowId: row.workflow_id } : {}),
    ...(row.base_revision_id ? { baseRevisionId: row.base_revision_id } : {}),
    ...(row.kind === "staged_loop_draft" ? { kind: "staged_loop_draft", draft: structuredClone(row.staged_draft) } : {}),
    summary: row.summary, operations: structuredClone(row.operations ?? []), diagnostics: structuredClone(row.diagnostics ?? []),
    permissionImpact: structuredClone(row.permission_impact ?? []), status: row.status,
    createdBy: row.created_by_principal_id, createdAt: iso(row.created_at),
    expiresAt: row.expires_at ? iso(row.expires_at) : null, decidedAt: row.decided_at ? iso(row.decided_at) : null,
  };
}

function builderCommandId(proposalId) { return `builder-command-${proposalId}`.slice(0, 128); }
function builderExecutionIdentity(proposalId) {
  return {
    invocationId: `invocation-${proposalId}`.slice(0, 128),
    attemptId: `attempt-${proposalId}-1`.slice(0, 128),
  };
}

function stagedGenerationResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("builder_proposal_invalid");
  for (const [field, code] of [[value.invocationId, "builder_proposal_invocation_required"], [value.attemptId, "builder_proposal_attempt_required"], [value.summary, "builder_proposal_summary_required"]]) {
    if (typeof field !== "string" || !field) throw coded(code);
  }
  if (!Array.isArray(value.operations) || !Array.isArray(value.diagnostics) || !Array.isArray(value.permissionImpact)) {
    throw coded("builder_proposal_invalid");
  }
  return {
    invocationId: value.invocationId, attemptId: value.attemptId,
    summary: value.summary.slice(0, 2000), draft: stagedDraft(value.draft),
    operations: structuredClone(value.operations), diagnostics: structuredClone(value.diagnostics),
    permissionImpact: structuredClone(value.permissionImpact),
  };
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

function stagedDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200
    || typeof value.description !== "string" || value.description.length > 2000
    || !value.graph || !value.inputForm || !value.outputDefinition || !value.runSettings
    || !Array.isArray(value.resourceRefs)) {
    throw coded("builder_proposal_invalid");
  }
  return {
    name: value.name.trim(), description: value.description, graph: structuredClone(value.graph),
    inputForm: structuredClone(value.inputForm), outputDefinition: structuredClone(value.outputDefinition),
    resourceRefs: structuredClone(value.resourceRefs), runSettings: structuredClone(value.runSettings),
    ...(value.definition == null ? {} : { definition: structuredClone(value.definition) }),
  };
}
function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function coded(code) { return new ProductStoreError(code, code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_builder_proposal_clock_invalid"); return date.toISOString(); }
