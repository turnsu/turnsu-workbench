import { canonicalRequestHash } from "../store/serialization.mjs";
import { ProductMemoryError } from "./product-memory-service.mjs";

const SUPPORTED_OBJECT_KINDS = new Set(["workflow", "skill_draft", "skill_version"]);

/**
 * PostgreSQL implementation of the existing CanonicalMemoryResolver contract.
 * It reads an immutable object and its validation evidence in one Product-owned
 * transaction; callers receive a verified fact, never SQL or storage rows.
 */
export class PostgresCanonicalMemoryResolver {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_canonical_memory_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async resolve({ workspaceId, objectKind, objectId, versionId, factPath, expectedEvidenceHash } = {}) {
    if (![workspaceId, objectKind, objectId, versionId, factPath].every(required)) {
      throw new ProductMemoryError("canonical_memory_reference_invalid");
    }
    if (!SUPPORTED_OBJECT_KINDS.has(objectKind)) {
      throw new ProductMemoryError("canonical_memory_object_kind_unsupported");
    }
    const resolved = await this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      if (objectKind === "workflow") return resolveWorkflow({ query, workspaceId, objectId, versionId, factPath });
      if (objectKind === "skill_draft") return resolveSkillDraft({ query, workspaceId, objectId, versionId, factPath });
      return resolveSkillVersion({ query, workspaceId, objectId, versionId, factPath });
    });
    if (expectedEvidenceHash && expectedEvidenceHash !== resolved.evidence[0].hash) {
      throw new ProductMemoryError("canonical_memory_evidence_mismatch");
    }
    return resolved;
  }
}

async function resolveWorkflow({ query, workspaceId, objectId, versionId, factPath }) {
  const workflow = (await query(`
    SELECT current_revision_id FROM public.workflows
     WHERE workspace_id = $1 AND workflow_id = $2
  `, [workspaceId, objectId])).rows[0];
  if (!workflow) throw new ProductMemoryError("canonical_memory_object_not_found");
  if (workflow.current_revision_id !== versionId) throw new ProductMemoryError("canonical_memory_version_stale");
  const row = (await query(`
    SELECT revision.*, compile.status AS compile_status, compile.warnings AS compile_warnings,
           plan.plan_document, plan.workflow_id AS plan_workflow_id,
           plan.workflow_revision_id AS plan_workflow_revision_id
      FROM public.workflow_revisions revision
      LEFT JOIN LATERAL (
        SELECT * FROM public.compile_results result
         WHERE result.workspace_id = revision.workspace_id
           AND result.workflow_id = revision.workflow_id
           AND result.workflow_revision_id = revision.revision_id
         ORDER BY result.compiled_at DESC, result.compile_result_id DESC LIMIT 1
      ) compile ON true
      LEFT JOIN public.execution_plans plan
        ON plan.workspace_id = compile.workspace_id AND plan.plan_id = compile.execution_plan_id
     WHERE revision.workspace_id = $1 AND revision.workflow_id = $2 AND revision.revision_id = $3
  `, [workspaceId, objectId, versionId])).rows[0];
  if (!row) throw new ProductMemoryError("canonical_memory_object_not_found");
  if (row.compile_status !== "ready" || !row.plan_document
    || row.plan_workflow_id !== objectId || row.plan_workflow_revision_id !== versionId) {
    throw new ProductMemoryError("canonical_memory_validation_required");
  }
  const revision = workflowRevisionView(row);
  return verifiedResult({
    objectKind: "workflow", objectId, versionId, factPath, canonicalObject: revision,
    subject: { kind: "workflow", subjectId: objectId },
    objectHash: canonicalRequestHash(revision),
    validationHash: canonicalRequestHash({
      status: row.compile_status, workflowRevisionId: versionId,
      diagnostics: row.compile_warnings ?? [], executionPlan: row.plan_document,
    }),
    objectRef: `product:workflow/${objectId}/revisions/${versionId}`,
    validationRef: `product:workflow/${objectId}/revisions/${versionId}/compile`,
  });
}

async function resolveSkillDraft({ query, workspaceId, objectId, versionId, factPath }) {
  const row = (await query(`
    SELECT draft.*, asset.scope_id, asset.owner_user_id
      FROM public.skill_drafts draft
      JOIN public.skill_assets asset
        ON asset.workspace_id = draft.workspace_id AND asset.skill_id = draft.skill_id
     WHERE draft.workspace_id = $1 AND draft.skill_draft_id = $2
  `, [workspaceId, objectId])).rows[0];
  if (!row) throw new ProductMemoryError("canonical_memory_object_not_found");
  const draft = skillDraftView(row);
  if (versionId !== `${draft.skillDraftId}:${draft.revision}`) throw new ProductMemoryError("canonical_memory_version_stale");
  const validation = (await query(`
    SELECT * FROM public.skill_validations
     WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3
       AND draft_revision = $4 AND content_hash = $5 AND status = 'passed'
     ORDER BY completed_at DESC, validation_id DESC LIMIT 1
  `, [workspaceId, draft.skillId, draft.skillDraftId, draft.revision, draft.contentHash])).rows[0];
  if (!validation) throw new ProductMemoryError("canonical_memory_validation_required");
  return verifiedResult({
    objectKind: "skill_draft", objectId, versionId, factPath, canonicalObject: draft,
    subject: { kind: "skill_draft", subjectId: objectId }, objectHash: draft.contentHash,
    validationHash: canonicalRequestHash(skillValidationView(validation)),
    objectRef: `product:skill-draft/${objectId}/revisions/${draft.revision}`,
    validationRef: `product:skill-draft/${objectId}/validations/${validation.validation_id}`,
  });
}

async function resolveSkillVersion({ query, workspaceId, objectId, versionId, factPath }) {
  const row = (await query(`
    SELECT version.*, validation.status AS validation_status, validation.validation_id,
           validation.content_hash AS validation_content_hash,
           source.runtime_probe_status, source.runtime_probe_digest
      FROM public.skill_versions version
      LEFT JOIN public.skill_validations validation
        ON validation.workspace_id = version.workspace_id
       AND validation.validation_id = version.validation_id
       AND validation.status = 'passed'
      LEFT JOIN public.skill_system_catalog_sources source
        ON source.workspace_id = version.workspace_id
       AND source.catalog_source_id = version.system_catalog_source_id
     WHERE version.workspace_id = $1 AND version.skill_id = $2 AND version.skill_version_id = $3
  `, [workspaceId, objectId, versionId])).rows[0];
  if (!row) throw new ProductMemoryError("canonical_memory_object_not_found");
  const validatedDraft = row.source_kind === "validated_draft"
    && row.validation_status === "passed" && row.validation_content_hash;
  const verifiedSystemSource = row.source_kind === "system_catalog"
    && row.runtime_probe_status === "ready" && row.runtime_probe_digest;
  if (!validatedDraft && !verifiedSystemSource) throw new ProductMemoryError("canonical_memory_validation_required");
  const validation = validatedDraft
    ? { status: "passed", validationId: row.validation_id, contentHash: row.validation_content_hash }
    : { status: "passed", validationId: row.system_catalog_source_id, contentHash: row.runtime_probe_digest };
  const version = skillVersionView(row, validation);
  return verifiedResult({
    objectKind: "skill_version", objectId, versionId, factPath, canonicalObject: version,
    subject: { kind: "skill", subjectId: objectId }, objectHash: canonicalRequestHash(version),
    validationHash: canonicalRequestHash(validation),
    objectRef: `product:skill/${objectId}/versions/${versionId}`,
    validationRef: `product:skill/${objectId}/versions/${versionId}/validation`,
  });
}

function verifiedResult({ objectKind, objectId, versionId, factPath, canonicalObject, subject, objectHash, validationHash, objectRef, validationRef }) {
  return {
    source: { kind: "canonical_object", sourceId: objectId, versionId, verified: true },
    evidence: [
      { kind: "canonical_object", ref: objectRef, hash: objectHash },
      { kind: "validation", ref: validationRef, hash: validationHash },
    ],
    statement: canonicalScalar(canonicalObject, factPath), subject,
    verification: { objectKind, objectId, versionId, factPath },
  };
}

function workflowRevisionView(row) {
  return {
    schemaVersion: row.schema_version, revisionId: row.revision_id, workflowId: row.workflow_id,
    revisionNumber: Number(row.revision_number), baseRevisionId: row.base_revision_id ?? null,
    graph: clone(row.graph), inputForm: clone(row.input_form), outputDefinition: clone(row.output_definition),
    resourceRefs: clone(row.resource_refs ?? []), runSettings: clone(row.run_settings),
    definition: row.definition == null ? null : clone(row.definition), contentHash: row.content_hash,
    authoredBy: row.authored_by, saveReason: row.save_reason,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function skillDraftView(row) {
  return {
    ...(row.payload ?? {}), ...(row.definition ?? {}), schemaVersion: row.schema_version,
    skillDraftId: row.skill_draft_id, skillId: row.skill_id, workspaceId: row.workspace_id,
    baseVersionId: row.base_version_id ?? null, revision: Number(row.draft_revision), contentHash: row.content_hash,
    updatedBy: row.updated_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function skillVersionView(row, validation) {
  return {
    ...(row.payload ?? {}), schemaVersion: row.schema_version, skillVersionId: row.skill_version_id,
    skillId: row.skill_id, workspaceId: row.workspace_id, version: row.version,
    packageObjectId: row.package_object_id, packageHash: row.package_hash, contentHash: row.content_hash,
    definition: clone(row.definition), validation, publishedAt: iso(row.published_at),
  };
}

function skillValidationView(row) {
  return {
    ...(row.payload ?? {}), validationId: row.validation_id, skillId: row.skill_id,
    skillDraftId: row.skill_draft_id, draftRevision: Number(row.draft_revision), contentHash: row.content_hash,
    status: row.status, diagnostics: clone(row.diagnostics ?? []), runtimeSummary: clone(row.runtime_summary ?? {}),
    completedAt: iso(row.completed_at),
  };
}

function canonicalScalar(value, pointer) {
  if (!pointer.startsWith("/")) throw new ProductMemoryError("canonical_memory_fact_path_invalid");
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?![01])/u.test(encoded)) throw new ProductMemoryError("canonical_memory_fact_path_invalid");
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      throw new ProductMemoryError("canonical_memory_fact_not_found");
    }
    current = current[key];
  }
  if (!["string", "number", "boolean"].includes(typeof current)
    || (typeof current === "number" && !Number.isFinite(current))) {
    throw new ProductMemoryError("canonical_memory_fact_not_scalar");
  }
  const statement = String(current).trim();
  if (!statement || statement.length > 20_000) throw new ProductMemoryError("canonical_memory_fact_invalid");
  return statement;
}

function required(value) { return typeof value === "string" && value.length > 0; }
function clone(value) { return structuredClone(value); }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
