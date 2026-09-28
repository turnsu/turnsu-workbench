import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash, formatWorkflowEtag } from "../store/serialization.mjs";

import { requireWorkflowReferences } from "./postgres-workflow-references.mjs";
import { requireLoopPublicationReferences } from "./postgres-loop-publication-references.mjs";
import { loadLoopReleaseDraft } from "./postgres-loop-release-draft.mjs";
import { recordLocalLoopTrial } from "./postgres-local-loop-trials.mjs";
import { publishNativeLoop, getNativeLoopPackage } from "./postgres-native-loop-releases.mjs";

const roleRank = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });
const textSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 10000 });

/** PG owner for the blank private Loop Draft created before Builder opens. */
export class PostgresLoopDraftLifecycle {
  constructor({ store, clock = () => new Date().toISOString(), idFactory } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof idFactory !== "function") throw new TypeError("postgres_loop_draft_lifecycle_dependencies_invalid");
    this.store = store; this.clock = clock; this.idFactory = idFactory;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async createLoopFromRelease({ releaseId, ...input } = {}) {
    required(releaseId, "release_id_required");
    const result = await this.createLoop({ ...input, sourceReleaseId: releaseId });
    // The timestamp is the creation time of this copy, including receipt replays.
    result.workflow.sourceRelease.forkedAt = result.workflow.createdAt;
    return result;
  }

  async createLoop({ idempotencyKey, request, workspaceId, authoredBy, sourceReleaseId = null } = {}) {
    const data = request?.data;
    for (const [value, code] of [[workspaceId, "workspace_id_required"], [authoredBy, "user_id_required"], [idempotencyKey, "idempotency_key_required"]]) required(value, code);
    if (!sourceReleaseId) {
      required(data?.name, "workflow_name_required");
      if (!data.definition || typeof data.definition !== "object") throw coded("loop_definition_required");
    }
    const requestHash = canonicalRequestHash(sourceReleaseId ? { sourceReleaseId, request } : request);
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!membership || roleRank[membership.role] < roleRank.member) throw coded("loop_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = 'create-loop' AND idempotency_key = $3 FOR UPDATE`, [workspaceId, authoredBy, idempotencyKey])).rows[0];
      if (existing) { if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused"); if (!existing.response) throw coded("idempotency_record_incomplete"); return structuredClone(existing.response); }
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, 'create-loop', $3, $4, NULL, $5::timestamptz, NULL)`, [workspaceId, authoredBy, idempotencyKey, requestHash, now]);
      const scope = (await query(`SELECT scope_id FROM public.product_scopes WHERE workspace_id = $1 AND owner_user_id = $2 AND scope_kind = 'personal' AND status = 'active' LIMIT 1 FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!scope) throw coded("personal_scope_not_found");
      const source = sourceReleaseId ? await loadLoopReleaseDraft({ query, workspaceId, userId: authoredBy, releaseId: sourceReleaseId }) : null;
      if (source) source.sourceRelease.forkedAt = now;
      const name = data?.name ?? source?.name, description = source?.description ?? data?.description ?? "";
      const workflowId = this.idFactory("workflow"), revisionId = this.idFactory("revision"), draft = source ?? { ...blankDraft(), resourceRefs: [], definition: structuredClone(data.definition) };
      const revision = { schemaVersion: "workbench-v1", revisionId, workflowId, revisionNumber: 1, baseRevisionId: null,
        graph: draft.graph, inputForm: draft.inputForm, outputDefinition: draft.outputDefinition, runSettings: draft.runSettings,
        resourceRefs: draft.resourceRefs, definition: draft.definition, compile: { status: "blocked", diagnostics: [] } };
      const contentHash = canonicalRequestHash(revision);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.workflows (workspace_id, workflow_id, scope_id, owner_user_id, schema_version, name, description, status, lifecycle, visibility, archived, current_revision_id, current_revision_number, write_version, created_at, updated_at, payload, source_release_workspace_id, source_release_id, source_release_version_id) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, 'draft', 'draft', 'private', false, $7, 1, 1, $8::timestamptz, $8::timestamptz, '{}'::jsonb, $9, $10, $11)`, [workspaceId, workflowId, scope.scope_id, authoredBy, name, description, revisionId, now, source ? workspaceId : null, source?.sourceRelease.releaseId ?? null, source?.sourceRelease.versionId ?? null]);
      const saveReason = source ? "Created from a fixed team release." : "Created from a goal.";
      await query(`INSERT INTO public.workflow_revisions (workspace_id, revision_id, workflow_id, revision_number, base_revision_id, base_revision_number, schema_version, graph, input_form, output_definition, resource_refs, run_settings, definition, content_hash, authored_by, save_reason, created_at, updated_at) VALUES ($1, $2, $3, 1, NULL, NULL, 'workbench-v1', $4::jsonb, $5::jsonb, $6::jsonb, $12::jsonb, $7::jsonb, $8::jsonb, $9, $10, $13, $11::timestamptz, $11::timestamptz)`, [workspaceId, revisionId, workflowId, JSON.stringify(draft.graph), JSON.stringify(draft.inputForm), JSON.stringify(draft.outputDefinition), JSON.stringify(draft.runSettings), JSON.stringify(draft.definition), contentHash, authoredBy, now, JSON.stringify(draft.resourceRefs), saveReason]);
      const response = { workflow: { schemaVersion: "workbench-v1", workflowId, workspaceId, name, description, status: "draft", lifecycle: "draft", visibility: "private", archived: false, currentRevisionId: revisionId, revisionNumber: 1, writeVersion: 1, ownerId: authoredBy, ...(source ? { sourceRelease: source.sourceRelease } : {}), createdAt: now, updatedAt: now }, revision: { ...revision, contentHash, authoredBy, saveReason, createdAt: now, updatedAt: now } };
      await query(`UPDATE public.product_idempotency_receipts SET response = $5::jsonb, completed_at = $6::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = 'create-loop' AND idempotency_key = $3 AND request_hash = $4`, [workspaceId, authoredBy, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  async saveWorkflowRevision({ workflowId, idempotencyKey, ifMatch, request, workspaceId, authoredBy } = {}) {
    for (const [value, code] of [[workflowId, "workflow_id_required"], [workspaceId, "workspace_id_required"], [authoredBy, "user_id_required"], [idempotencyKey, "idempotency_key_required"], [ifMatch, "workflow_etag_required"]]) required(value, code);
    const data = request?.data;
    if (!data || typeof data !== "object" || typeof data.baseRevisionId !== "string" || !data.baseRevisionId) throw coded("base_revision_id_required");
    if (!data.graph || !data.inputForm || !data.outputDefinition || !data.runSettings || !Array.isArray(data.resourceRefs)) throw coded("save_revision_request_required");
    const requestHash = canonicalRequestHash({ ifMatch, request });
    const operationScope = `save-workflow-revision:${workflowId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!membership || roleRank[membership.role] < roleRank.member) throw coded("loop_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, authoredBy, operationScope, idempotencyKey])).rows[0];
      if (existing) { if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused"); if (!existing.response) throw coded("idempotency_record_incomplete"); return structuredClone(existing.response); }
      const workflow = (await query(`SELECT * FROM public.workflows WHERE workspace_id = $1 AND workflow_id = $2 FOR UPDATE`, [workspaceId, workflowId])).rows[0];
      if (!workflow) throw coded("workflow_not_found");
      if (workflow.owner_user_id !== authoredBy) throw coded("workflow_not_found");
      if (workflow.visibility === "workspace") throw new ProductStoreError("workflow_revision_edit_requires_private", "Create a private copy before editing a shared Workflow.");
      const currentEtag = workflowEtag(workflow);
      if (ifMatch !== currentEtag || data.baseRevisionId !== workflow.current_revision_id) throw coded("workflow_revision_conflict");
      const base = (await query(`SELECT revision_number FROM public.workflow_revisions WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3 FOR SHARE`, [workspaceId, workflowId, data.baseRevisionId])).rows[0];
      if (!base) throw coded("workflow_revision_not_found");
      const references = await requireWorkflowReferences({ query, workspaceId, userId: authoredBy, revision: data });
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, now]);
      const revisionId = this.idFactory("revision");
      const revisionNumber = Number(workflow.current_revision_number) + 1;
      const definition = data.definition ?? null;
      const revision = { schemaVersion: "workbench-v1", revisionId, workflowId, revisionNumber, baseRevisionId: data.baseRevisionId, graph: structuredClone(data.graph), inputForm: structuredClone(data.inputForm), outputDefinition: structuredClone(data.outputDefinition), resourceRefs: references.resourceRefs, runSettings: structuredClone(data.runSettings), definition, contentHash: canonicalRequestHash({ graph: data.graph, inputForm: data.inputForm, outputDefinition: data.outputDefinition, resourceRefs: references.resourceRefs, runSettings: data.runSettings, definition }), authoredBy, saveReason: String(data.saveReason || "Updated in Builder."), compile: { status: "blocked", diagnostics: [] }, createdAt: now, updatedAt: now };
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.workflow_revisions (workspace_id, revision_id, workflow_id, revision_number, base_revision_id, base_revision_number, schema_version, graph, input_form, output_definition, resource_refs, run_settings, definition, content_hash, authored_by, save_reason, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 'workbench-v1', $7::jsonb, $8::jsonb, $9::jsonb, $16::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15::timestamptz, $15::timestamptz)`, [workspaceId, revisionId, workflowId, revisionNumber, data.baseRevisionId, Number(base.revision_number), JSON.stringify(revision.graph), JSON.stringify(revision.inputForm), JSON.stringify(revision.outputDefinition), JSON.stringify(revision.runSettings), JSON.stringify(definition), revision.contentHash, authoredBy, revision.saveReason, now, JSON.stringify(revision.resourceRefs)]);
      const writeVersion = Number(workflow.write_version) + 1;
      await query(`UPDATE public.workflows SET current_revision_id = $3, current_revision_number = $4, write_version = $5, latest_compile_result_id = NULL, status = 'draft', lifecycle = 'draft', updated_at = $6::timestamptz WHERE workspace_id = $1 AND workflow_id = $2 AND current_revision_id = $7 AND write_version = $8`, [workspaceId, workflowId, revisionId, revisionNumber, writeVersion, now, data.baseRevisionId, Number(workflow.write_version)]);
      const nextWorkflow = { schemaVersion: workflow.schema_version, workflowId, workspaceId, scopeId: workflow.scope_id, ownerId: workflow.owner_user_id, name: workflow.name, description: workflow.description, status: "draft", lifecycle: "draft", visibility: workflow.visibility, archived: workflow.archived === true, currentRevisionId: revisionId, revisionNumber, writeVersion, createdAt: iso(workflow.created_at), updatedAt: now };
      const response = { workflow: nextWorkflow, revision, etag: formatWorkflowEtag(nextWorkflow) };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  recordLocalLoopTrial(input) { return recordLocalLoopTrial(this, input); }
  publishNativeLoop(input) { return publishNativeLoop(this, input); }
  getNativeLoopPackage(input) { return getNativeLoopPackage(this, input); }

  /** Publishes a tested revision and its exact, audience-compatible dependencies. */
  async publishLoop({ workflowId, idempotencyKey, ifMatch, request, workspaceId, releasedBy } = {}) {
    for (const [value, code] of [[workflowId, "workflow_id_required"], [idempotencyKey, "idempotency_key_required"], [ifMatch, "workflow_etag_required"], [workspaceId, "workspace_id_required"], [releasedBy, "user_id_required"], [request?.data?.version, "loop_version_required"]]) required(value, code);
    if (typeof request.data.releaseNotes !== "string" || typeof request.data.startingPoint !== "boolean") throw coded("loop_publish_request_invalid");
    const requestHash = canonicalRequestHash({ ifMatch, request });
    const operationScope = `publish-loop:${workflowId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, releasedBy])).rows[0];
      if (!membership || roleRank[membership.role] < roleRank.member) throw coded("loop_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, releasedBy, operationScope, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (!existing.response) throw coded("idempotency_record_incomplete");
        return structuredClone(existing.response);
      }
      const workflow = (await query(`SELECT * FROM public.workflows WHERE workspace_id = $1 AND workflow_id = $2 FOR UPDATE`, [workspaceId, workflowId])).rows[0];
      if (!workflow || workflow.owner_user_id !== releasedBy) throw coded("workflow_not_found");
      if (ifMatch !== workflowEtag(workflow)) throw coded("workflow_revision_conflict");
      if (workflow.visibility !== "private" || workflow.lifecycle !== "ready" || workflow.status !== "ready" || !workflow.latest_compile_result_id) throw coded("loop_compile_required");
      const revision = (await query(`SELECT * FROM public.workflow_revisions WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3 FOR SHARE`, [workspaceId, workflowId, workflow.current_revision_id])).rows[0];
      if (!revision?.definition) throw coded("loop_definition_required");
      const compile = (await query(`SELECT * FROM public.compile_results WHERE workspace_id = $1 AND compile_result_id = $2 AND workflow_id = $3 AND workflow_revision_id = $4 AND status = 'ready' FOR SHARE`, [workspaceId, workflow.latest_compile_result_id, workflowId, workflow.current_revision_id])).rows[0];
      if (!compile?.execution_plan_id) throw coded("loop_compile_required");
      const plan = (await query(`SELECT plan_id, content_hash, pins_finalized, plan_document FROM public.execution_plans WHERE workspace_id = $1 AND plan_id = $2 AND compile_result_id = $3 AND workflow_id = $4 AND workflow_revision_id = $5 FOR SHARE`, [workspaceId, compile.execution_plan_id, compile.compile_result_id, workflowId, workflow.current_revision_id])).rows[0];
      if (!plan || plan.pins_finalized !== true) throw coded("loop_compile_required");
      const references = await requireLoopPublicationReferences({ query, workspaceId, userId: releasedBy, revision, plan: plan.plan_document });
      const completedRun = (await query(`SELECT run_id FROM public.workflow_runs WHERE workspace_id = $1 AND workflow_id = $2 AND workflow_revision_id = $3 AND compile_result_id = $4 AND execution_plan_id = $5 AND status = 'completed' ORDER BY finished_at DESC, run_id DESC LIMIT 1 FOR SHARE`, [workspaceId, workflowId, workflow.current_revision_id, compile.compile_result_id, plan.plan_id])).rows[0];
      if (!completedRun) throw coded("loop_test_run_required");
      const duplicate = (await query(`SELECT loop_version_id FROM public.loop_versions WHERE workspace_id = $1 AND workflow_id = $2 AND version = $3 FOR SHARE`, [workspaceId, workflowId, request.data.version])).rows[0];
      if (duplicate) throw coded("loop_version_exists");
      const now = iso(this.clock());
      const loopVersionId = this.idFactory("loop-version"), releaseId = this.idFactory("release");
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, releasedBy, operationScope, idempotencyKey, requestHash, now]);
      await query(`INSERT INTO public.loop_versions (workspace_id, loop_version_id, workflow_id, workflow_revision_id, schema_version, version, workflow_revision_content_hash, compile_result_id, execution_plan_id, compile_status, validation_run_id, definition, content_hash, pins_finalized, released_by, released_at, payload) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, $7, $8, 'ready', $9, $10::jsonb, $6, false, $11, $12::timestamptz, '{}'::jsonb)`, [workspaceId, loopVersionId, workflowId, workflow.current_revision_id, request.data.version, revision.content_hash, compile.compile_result_id, plan.plan_id, completedRun.run_id, JSON.stringify(revision.definition), releasedBy, now]);
      for (const { version } of references.skills.values()) {
        await query(`INSERT INTO public.loop_version_skill_pins (workspace_id, loop_version_id, workflow_id, skill_id, skill_version_id, version, content_hash, schema_version)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'workbench-internal-v1')`,
        [workspaceId, loopVersionId, workflowId, version.skillId, version.skillVersionId, version.version, version.contentHash]);
      }
      for (const ref of references.resourceRefs) {
        await query(`INSERT INTO public.loop_version_resource_pins (workspace_id, loop_version_id, workflow_id, resource_id, resource_version, content_hash, schema_version)
          VALUES ($1, $2, $3, $4, $5, $6, 'workbench-internal-v1')`,
        [workspaceId, loopVersionId, workflowId, ref.resourceId, ref.version, ref.contentHash]);
      }
      await query(`UPDATE public.loop_versions SET pins_finalized = true WHERE workspace_id = $1 AND workflow_id = $2 AND loop_version_id = $3 AND pins_finalized = false`, [workspaceId, workflowId, loopVersionId]);
      await query(`INSERT INTO public.workspace_asset_releases (source_workspace_id, release_id, schema_version, asset_kind, loop_workflow_id, loop_version_id, version, content_hash, visibility, domain, starting_point, release_notes, dependencies, published_by, published_at, payload) VALUES ($1, $2, 'workbench-v1', 'loop', $3, $4, $5, $6, 'workspace', 'product', $7, $8, $11::jsonb, $9, $10::timestamptz, '{}'::jsonb)`, [workspaceId, releaseId, workflowId, loopVersionId, request.data.version, revision.content_hash, request.data.startingPoint, request.data.releaseNotes, releasedBy, now, JSON.stringify(references.dependencies)]);
      const writeVersion = Number(workflow.write_version) + 1;
      const shared = await query(`UPDATE public.workflows SET visibility = 'workspace', lifecycle = 'shared', write_version = $3, updated_at = $4::timestamptz WHERE workspace_id = $1 AND workflow_id = $2 AND current_revision_id = $5 AND write_version = $6 AND status = 'ready'`, [workspaceId, workflowId, writeVersion, now, workflow.current_revision_id, Number(workflow.write_version)]);
      if (shared.rowCount !== 1) throw coded("workflow_revision_conflict");
      const loopVersion = { schemaVersion: "workbench-v1", workspaceId, loopVersionId, workflowId, workflowRevisionId: workflow.current_revision_id, version: request.data.version, definition: structuredClone(revision.definition), pinnedSkills: references.pinnedSkills, contentHash: revision.content_hash, releasedBy, releasedAt: now };
      const release = { schemaVersion: "workbench-v1", sourceWorkspaceId: workspaceId, releaseId, assetKind: "loop", assetId: workflowId, versionId: loopVersionId, version: request.data.version, contentHash: revision.content_hash, visibility: "workspace", domain: "product", startingPoint: request.data.startingPoint, releaseNotes: request.data.releaseNotes, dependencies: references.dependencies, publishedBy: releasedBy, publishedAt: now };
      const response = { loopVersion, release };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, releasedBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }
}
function blankDraft() { return { graph: { nodes: [{ nodeId: "node-input", title: "Goal", description: "The outcome this Loop should produce.", position: { x: 0, y: 0 }, inputPorts: [], outputPorts: [{ portId: "goal", name: "Goal", schema: textSchema, required: true }], inputBindings: [], reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 60, display: { collapsed: false }, kind: "Input", configuration: { fieldIds: ["goal"] } }, { nodeId: "node-output", title: "Result", description: "The current Loop result.", position: { x: 420, y: 0 }, inputPorts: [{ portId: "result", name: "Result", schema: textSchema, required: true }], outputPorts: [{ portId: "result", name: "Result", schema: textSchema, required: true }], inputBindings: [{ targetPort: "result", source: { kind: "nodeOutput", nodeId: "node-input", portId: "goal" } }], reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 60, display: { collapsed: false }, kind: "Output", configuration: { format: "markdown" } }], edges: [{ edgeId: "edge-input-output", sourceNodeId: "node-input", sourcePort: "goal", targetNodeId: "node-output", targetPort: "result" }] }, inputForm: { fields: [{ fieldId: "goal", label: "Goal", description: "What should this Loop produce?", schema: textSchema, required: true }] }, outputDefinition: { primary: { nodeId: "node-output", portId: "result" }, expectedOutputs: [{ nodeId: "node-output", portId: "result", label: "Result", mediaType: "text/markdown" }] }, runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 60, workflowFallbackAllowed: false } }; }
function required(value, code) { if (typeof value !== "string" || !value.trim()) throw coded(code); }
function workflowEtag(row) {
  return formatWorkflowEtag({
    workflowId: row.workflow_id,
    writeVersion: Number(row.write_version),
    currentRevisionId: row.current_revision_id,
  });
}
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_loop_clock_invalid"); return date.toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
