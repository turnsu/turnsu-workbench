import { ProductStoreError } from "../store/errors.mjs";
import { formatWorkflowEtag } from "../store/serialization.mjs";

/** PostgreSQL read boundary for canonical Workflows and immutable revisions. */
export class PostgresWorkflowReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) throw new TypeError("postgres_workflow_read_model_store_required");
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async listWorkflows({ workspaceId, query = {} } = {}) {
    required(workspaceId, "workspace_id_required");
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT * FROM public.workflows
        WHERE workspace_id = $1 AND ($2::boolean OR archived = false)
        ORDER BY updated_at DESC, workflow_id DESC LIMIT $3`, [workspaceId, query.includeArchived === true, limit])).rows;
      return rows.map(workflowView);
    });
  }

  async getWorkflow({ workflowId, workspaceId } = {}) {
    required(workflowId, "workflow_id_required"); required(workspaceId, "workspace_id_required");
    return this.#transact(async (sql) => {
      const row = (await sql("SELECT * FROM public.workflows WHERE workspace_id = $1 AND workflow_id = $2", [workspaceId, workflowId])).rows[0];
      if (!row) throw notFound(workflowId);
      const workflow = workflowView(row);
      const revision = await this.#revision(sql, { workspaceId, workflowId, revisionId: workflow.currentRevisionId });
      return Object.freeze({ workflow, revision, etag: formatWorkflowEtag(workflow) });
    });
  }

  async getWorkflowRevision({ workflowId, revisionId, workspaceId } = {}) {
    required(workflowId, "workflow_id_required"); required(revisionId, "workflow_revision_id_required"); required(workspaceId, "workspace_id_required");
    return this.#transact((sql) => this.#revision(sql, { workspaceId, workflowId, revisionId }));
  }

  async #revision(sql, { workspaceId, workflowId, revisionId }) {
    const row = (await sql("SELECT * FROM public.workflow_revisions WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3", [workspaceId, workflowId, revisionId])).rows[0];
    if (!row) throw new ProductStoreError("workflow_revision_not_found", "Workflow revision not found.", { workflowId, revisionId });
    const compile = (await sql(`SELECT status, warnings FROM public.compile_results
      WHERE workspace_id = $1 AND workflow_id = $2 AND workflow_revision_id = $3
      ORDER BY compiled_at DESC, compile_result_id DESC LIMIT 1`, [workspaceId, workflowId, revisionId])).rows[0];
    return revisionView(row, compile);
  }

  #transact(work) { return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values))); }
}

function workflowView(row) {
  return Object.freeze({ ...(row.payload ?? {}), schemaVersion: row.schema_version, workflowId: row.workflow_id, workspaceId: row.workspace_id, scopeId: row.scope_id, ownerId: row.owner_user_id, name: row.name, description: row.description, status: row.status, lifecycle: row.lifecycle, visibility: row.visibility, archived: row.archived === true, currentRevisionId: row.current_revision_id, revisionNumber: Number(row.current_revision_number), writeVersion: Number(row.write_version), latestCompileResultId: row.latest_compile_result_id ?? null, latestRunId: row.latest_run_id ?? null, accessGrants: [],
    ...(row.source_release_id ? { sourceRelease: { releaseId: row.source_release_id, sourceWorkspaceId: row.source_release_workspace_id, versionId: row.source_release_version_id, forkedAt: iso(row.created_at) } } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function revisionView(row, compile = null) {
  return Object.freeze({ schemaVersion: row.schema_version, revisionId: row.revision_id, workflowId: row.workflow_id, revisionNumber: Number(row.revision_number), baseRevisionId: row.base_revision_id ?? null, graph: structuredClone(row.graph), inputForm: structuredClone(row.input_form), outputDefinition: structuredClone(row.output_definition), resourceRefs: structuredClone(row.resource_refs ?? []), runSettings: structuredClone(row.run_settings), definition: row.definition == null ? null : structuredClone(row.definition), contentHash: row.content_hash, authoredBy: row.authored_by, saveReason: row.save_reason, compile: { status: compile?.status ?? "blocked", diagnostics: structuredClone(compile?.warnings ?? []) }, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function required(value, code) { if (typeof value !== "string" || !value) throw new TypeError(code); }
function notFound(workflowId) { return new ProductStoreError("workflow_not_found", "Workflow not found.", { workflowId }); }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
