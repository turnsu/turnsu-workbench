import { ProductStoreError } from "../store/errors.mjs";
import { readPinnedSkillVersion } from "./postgres-published-skill-reader.mjs";

/** PostgreSQL read boundary for governed Skill assets and their private Drafts. */
export class PostgresSkillReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) throw new TypeError("postgres_skill_read_model_store_required");
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async listSkillAssets({ workspaceId, query = {} } = {}) {
    required(workspaceId, "workspace_id_required");
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT asset.*, draft.skill_draft_id, draft.draft_revision, draft.base_version_id,
          draft.content_hash AS draft_content_hash, draft.updated_by AS draft_updated_by,
          draft.created_at AS draft_created_at, draft.updated_at AS draft_updated_at,
          draft.definition AS draft_definition, draft.payload AS draft_payload,
          latest_version.skill_version_id AS latest_skill_version_id,
          latest_version.version AS latest_version,
          latest_version.schema_version AS latest_schema_version,
          latest_version.package_hash AS latest_package_hash,
          latest_version.content_hash AS latest_content_hash,
          latest_version.published_at AS latest_published_at,
          latest_version.definition AS latest_definition,
          latest_version.payload AS latest_payload,
          latest_validation.status AS latest_validation_status,
          latest_validation.completed_at AS latest_validation_completed_at,
          latest_binding.capability_id AS latest_binding_capability_id,
          latest_binding.task_intent AS latest_binding_task_intent,
          latest_binding.adapter_version AS latest_binding_adapter_version,
          latest_binding.execution_mode AS latest_binding_execution_mode,
          latest_binding.executor_kind AS latest_binding_executor_kind,
          latest_binding.trust_tier AS latest_binding_trust_tier,
          latest_binding.runtime_id AS latest_binding_runtime_id,
          latest_binding.image_digest AS latest_binding_image_digest
        FROM public.skill_assets asset LEFT JOIN public.skill_drafts draft
          ON draft.workspace_id = asset.workspace_id AND draft.skill_draft_id = asset.current_draft_id
        LEFT JOIN public.skill_versions latest_version
          ON latest_version.workspace_id = asset.workspace_id
          AND latest_version.skill_id = asset.skill_id
          AND latest_version.skill_version_id = asset.latest_published_version_id
        LEFT JOIN public.skill_validations latest_validation
          ON latest_validation.workspace_id = latest_version.workspace_id
          AND latest_validation.validation_id = latest_version.validation_id
        LEFT JOIN public.skill_execution_bindings latest_binding
          ON latest_binding.workspace_id = latest_version.workspace_id
          AND latest_binding.execution_binding_id = latest_version.execution_binding_id
        WHERE asset.workspace_id = $1 ORDER BY asset.updated_at DESC, asset.skill_id DESC LIMIT $2`, [workspaceId, limit])).rows;
      return rows.map((row) => Object.freeze({ skill: skillView(row), draft: draftView(row), latestVersion: latestVersionView(row) }));
    });
  }

  async getSkillDraft({ workspaceId, skillId, draftId } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillId, "skill_id_required"); required(draftId, "skill_draft_id_required");
    return this.#find({ workspaceId, skillId, draftId });
  }

  async getSkill({ workspaceId, skillId } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillId, "skill_id_required");
    return this.#transact(async (sql) => {
      const row = (await sql(`SELECT * FROM public.skill_assets
        WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId])).rows[0];
      if (!row) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
      return skillView(row);
    });
  }

  async listSkillVersions({ workspaceId, skillId, limit } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillId, "skill_id_required");
    const boundedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT version.*, validation.status AS validation_status,
          validation.completed_at AS validation_completed_at,
          binding.capability_id AS binding_capability_id, binding.task_intent AS binding_task_intent,
          binding.adapter_version AS binding_adapter_version, binding.execution_mode AS binding_execution_mode,
          binding.executor_kind AS binding_executor_kind, binding.trust_tier AS binding_trust_tier,
          binding.runtime_id AS binding_runtime_id, binding.image_digest AS binding_image_digest
        FROM public.skill_versions version
        LEFT JOIN public.skill_validations validation
          ON validation.workspace_id = version.workspace_id AND validation.validation_id = version.validation_id
        LEFT JOIN public.skill_execution_bindings binding
          ON binding.workspace_id = version.workspace_id AND binding.execution_binding_id = version.execution_binding_id
        WHERE version.workspace_id = $1 AND version.skill_id = $2
        ORDER BY published_at DESC, skill_version_id DESC LIMIT $3`, [workspaceId, skillId, boundedLimit])).rows;
      return rows.map(versionView);
    });
  }

  async getSkillReleaseAccess({ workspaceId, skillId, version } = {}) {
    return this.#transact(async (query) => {
      const pinned = await readPinnedSkillVersion({ query, workspaceId, ref: { skillId, version } });
      return pinned?.workspaceReleaseVersionId ?? null;
    });
  }

  async getSkillVersionByRef({ workspaceId, skillId, version } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillId, "skill_id_required"); required(version, "skill_version_required");
    return this.#transact(async (query) => (await readPinnedSkillVersion({ query, workspaceId, ref: { skillId, version } }))?.version ?? null);
  }

  async getSkillVersion({ workspaceId, skillVersionId } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillVersionId, "skill_version_id_required");
    return this.#transact(async (query) => {
      const row = (await query("SELECT skill_id, version FROM public.skill_versions WHERE workspace_id = $1 AND skill_version_id = $2", [workspaceId, skillVersionId])).rows[0];
      return row ? (await readPinnedSkillVersion({ query, workspaceId, ref: { skillId: row.skill_id, version: row.version } }))?.version ?? null : null;
    });
  }

  async getSkillVersionDiff({ workspaceId, skillId, fromVersionId, toVersionId } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillId, "skill_id_required");
    required(fromVersionId, "skill_version_id_required"); required(toVersionId, "skill_version_id_required");
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT * FROM public.skill_versions
        WHERE workspace_id = $1 AND skill_id = $2 AND skill_version_id = ANY($3::text[])`, [workspaceId, skillId, [fromVersionId, toVersionId]])).rows;
      const versions = new Map(rows.map((row) => [row.skill_version_id, versionView(row)]));
      const from = versions.get(fromVersionId), to = versions.get(toVersionId);
      if (!from || !to) throw new ProductStoreError("skill_version_not_found", "A selected Skill version was not found.", { skillId });
      const fromInputs = schemaFields(from.inputSchema), toInputs = schemaFields(to.inputSchema);
      const fromOutputs = schemaFields(from.outputSchema), toOutputs = schemaFields(to.outputSchema);
      const fromDependencies = labels(from.dependencies), toDependencies = labels(to.dependencies);
      const fromConnections = labels(from.connectionRequirements, "label"), toConnections = labels(to.connectionRequirements, "label");
      return Object.freeze({
        skillId,
        fromVersionId: from.skillVersionId,
        fromVersion: from.version,
        toVersionId: to.skillVersionId,
        toVersion: to.version,
        entries: [
          diffEntry("purpose", from.description !== to.description || from.name !== to.name, "The Skill description or name changed."),
          diffEntry("required_information", changed(fromInputs, toInputs), `Needs: ${toInputs.join(", ") || "no named fields"}.`),
          diffEntry("creates", changed(fromOutputs, toOutputs), `Creates: ${toOutputs.join(", ") || "no named fields"}.`),
          diffEntry("risk", changed(from.risk, to.risk), `Risk: ${to.risk?.level ?? "unknown"}. ${clipped(to.risk?.summary, 300)}`, "warning"),
          diffEntry("dependencies", changed(fromDependencies, toDependencies), `Uses: ${toDependencies.join(", ") || "none"}.`),
          diffEntry("connections", changed(fromConnections, toConnections), `Connections: ${toConnections.join(", ") || "none"}.`, "warning"),
          diffEntry("package", from.packageHash !== to.packageHash, "The approved Skill package changed.", "warning"),
        ],
      });
    });
  }

  async getSkillUsageImpact({ workspaceId, skillId } = {}) {
    required(workspaceId, "workspace_id_required"); required(skillId, "skill_id_required");
    return this.#transact(async (sql) => {
      const [latest, rows] = await Promise.all([
        sql(`SELECT skill_version_id, version FROM public.skill_versions
          WHERE workspace_id = $1 AND skill_id = $2
          ORDER BY published_at DESC, skill_version_id DESC LIMIT 1`, [workspaceId, skillId]),
        sql(`SELECT workflow.workflow_id, workflow.name, workflow.visibility, workflow.status, workflow.lifecycle,
            revision.revision_id, revision.graph
          FROM public.workflows workflow
          JOIN public.workflow_revisions revision
            ON revision.workspace_id = workflow.workspace_id
            AND revision.workflow_id = workflow.workflow_id
            AND revision.revision_id = workflow.current_revision_id
          WHERE workflow.workspace_id = $1`, [workspaceId]),
      ]);
      const affectedWorkflows = rows.rows
        .filter((row) => (row.graph?.nodes ?? []).some((node) => node?.kind === "Skill" && node?.skillRef?.skillId === skillId))
        .map((row) => Object.freeze({
          workflowId: row.workflow_id,
          revisionId: row.revision_id,
          name: row.name,
          visibility: row.visibility ?? "private",
          state: row.lifecycle ?? row.status ?? "draft",
        }));
      return Object.freeze({
        skillId,
        latestVersionId: latest.rows[0]?.skill_version_id ?? null,
        latestVersion: latest.rows[0]?.version ?? null,
        affectedWorkflows,
      });
    });
  }

  async getDraftById({ workspaceId, draftId } = {}) {
    required(workspaceId, "workspace_id_required"); required(draftId, "skill_draft_id_required");
    return this.#find({ workspaceId, skillId: null, draftId, nullable: true });
  }

  async #find({ workspaceId, skillId, draftId, nullable = false }) {
    return this.#transact(async (sql) => {
      const row = (await sql(`SELECT asset.*, draft.skill_draft_id, draft.draft_revision, draft.base_version_id,
          draft.content_hash AS draft_content_hash, draft.updated_by AS draft_updated_by,
          draft.created_at AS draft_created_at, draft.updated_at AS draft_updated_at,
          draft.definition AS draft_definition, draft.payload AS draft_payload
        FROM public.skill_drafts draft JOIN public.skill_assets asset
          ON asset.workspace_id = draft.workspace_id AND asset.skill_id = draft.skill_id
        WHERE draft.workspace_id = $1 AND draft.skill_draft_id = $2 AND ($3::text IS NULL OR draft.skill_id = $3)`, [workspaceId, draftId, skillId])).rows[0];
      if (!row && nullable) return null;
      if (!row) throw new ProductStoreError("skill_draft_not_found", "Skill draft not found.", { skillId, draftId });
      return Object.freeze({ skill: skillView(row), draft: draftView(row) });
    });
  }

  #transact(work) { return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values))); }
}

function skillView(row) { return Object.freeze({ ...(row.payload ?? {}), schemaVersion: row.schema_version, skillId: row.skill_id, workspaceId: row.workspace_id, scopeId: row.scope_id, ownerId: row.owner_user_id, visibility: row.visibility, lifecycle: row.lifecycle, currentDraftId: row.current_draft_id ?? null, latestPublishedVersionId: row.latest_published_version_id ?? null, accessGrants: [], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }); }
function draftView(row) { if (!row.skill_draft_id) return null; return Object.freeze({ ...(row.draft_payload ?? {}), ...(row.draft_definition ?? {}), schemaVersion: row.schema_version, skillDraftId: row.skill_draft_id, skillId: row.skill_id, workspaceId: row.workspace_id, baseVersionId: row.base_version_id ?? null, revision: Number(row.draft_revision), contentHash: row.draft_content_hash, updatedBy: row.draft_updated_by, createdAt: iso(row.draft_created_at), updatedAt: iso(row.draft_updated_at) }); }
function versionView(row) {
  const validation = row.validation_status
    ? { status: row.validation_status, testedAt: iso(row.validation_completed_at) }
    : structuredClone(row.definition?.validation ?? row.payload?.validation ?? {});
  const executionRef = row.binding_capability_id || row.latest_binding_capability_id
    ? bindingView(row, row.binding_capability_id ? "binding_" : "latest_binding_")
    : row.definition?.executionRef ?? row.payload?.executionRef;
  return Object.freeze({ ...(row.payload ?? {}), ...(row.definition ?? {}), schemaVersion: row.schema_version, skillVersionId: row.skill_version_id, skillId: row.skill_id, workspaceId: row.workspace_id, version: row.version, packageHash: row.package_hash, contentHash: row.content_hash, validation, ...(executionRef ? { executionRef } : {}), publishedAt: iso(row.published_at) });
}
function latestVersionView(row) {
  if (!row.latest_skill_version_id) return null;
  return versionView({
    workspace_id: row.workspace_id,
    skill_id: row.skill_id,
    skill_version_id: row.latest_skill_version_id,
    version: row.latest_version,
    schema_version: row.latest_schema_version,
    package_hash: row.latest_package_hash,
    content_hash: row.latest_content_hash,
    published_at: row.latest_published_at,
    definition: row.latest_definition,
    payload: row.latest_payload,
    validation_status: row.latest_validation_status,
    validation_completed_at: row.latest_validation_completed_at,
    latest_binding_capability_id: row.latest_binding_capability_id,
    latest_binding_task_intent: row.latest_binding_task_intent,
    latest_binding_adapter_version: row.latest_binding_adapter_version,
    latest_binding_execution_mode: row.latest_binding_execution_mode,
    latest_binding_executor_kind: row.latest_binding_executor_kind,
    latest_binding_trust_tier: row.latest_binding_trust_tier,
    latest_binding_runtime_id: row.latest_binding_runtime_id,
    latest_binding_image_digest: row.latest_binding_image_digest,
  });
}
function bindingView(row, prefix) {
  const field = (name) => row[`${prefix}${name}`];
  return Object.freeze({
    capabilityId: field("capability_id"), taskIntent: field("task_intent"), adapterVersion: field("adapter_version"),
    executionMode: field("execution_mode"), executorKind: field("executor_kind"), trustTier: field("trust_tier"),
    ...(field("runtime_id") ? { runtimeId: field("runtime_id") } : {}),
    ...(field("image_digest") ? { imageDigest: field("image_digest") } : {}),
  });
}
function schemaFields(schema) { return Object.keys(schema?.properties ?? {}).sort(); }
function labels(values, label = "name") { return (Array.isArray(values) ? values : []).map((value) => typeof value === "string" ? value : value?.[label] ?? value?.name ?? "").filter(Boolean).sort(); }
function changed(left, right) { return JSON.stringify(left) !== JSON.stringify(right); }
function clipped(value, limit) { const text = typeof value === "string" ? value.trim() : ""; return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`; }
function diffEntry(kind, changedValue, summary, severity = "info") { return Object.freeze({ kind, changed: changedValue, summary, severity }); }
function required(value, code) { if (typeof value !== "string" || !value) throw new TypeError(code); }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
