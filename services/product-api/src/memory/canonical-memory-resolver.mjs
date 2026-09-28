import {
  canonicalRequestHash,
  canonicalSkillDraftContentHash,
} from "../store/serialization.mjs";
import { ProductMemoryError } from "./product-memory-service.mjs";

const SUPPORTED_OBJECT_KINDS = new Set(["workflow", "skill_draft", "skill_version"]);

export class CanonicalMemoryResolver {
  constructor({ store } = {}) {
    if (!store || typeof store.connect !== "function") throw new TypeError("canonical_memory_store_required");
    this.store = store;
  }

  async resolve({ workspaceId, objectKind, objectId, versionId, factPath, expectedEvidenceHash } = {}) {
    if (![workspaceId, objectKind, objectId, versionId, factPath].every((value) => typeof value === "string" && value.length > 0)) {
      throw new ProductMemoryError("canonical_memory_reference_invalid");
    }
    if (!SUPPORTED_OBJECT_KINDS.has(objectKind)) {
      throw new ProductMemoryError("canonical_memory_object_kind_unsupported");
    }
    await this.store.connect();
    const resolved = objectKind === "workflow"
      ? await this.#workflow({ workspaceId, objectId, versionId, factPath })
      : objectKind === "skill_draft"
        ? await this.#skillDraft({ workspaceId, objectId, versionId, factPath })
        : await this.#skillVersion({ workspaceId, objectId, versionId, factPath });
    if (expectedEvidenceHash && expectedEvidenceHash !== resolved.evidence[0].hash) {
      throw new ProductMemoryError("canonical_memory_evidence_mismatch");
    }
    return resolved;
  }

  async #workflow({ workspaceId, objectId, versionId, factPath }) {
    let current;
    try {
      current = await this.store.getWorkflow(objectId, { workspaceId });
    } catch (error) {
      if (error?.code === "workflow_not_found") throw new ProductMemoryError("canonical_memory_object_not_found");
      throw error;
    }
    if (current?.workflow?.currentRevisionId !== versionId) {
      throw new ProductMemoryError("canonical_memory_version_stale");
    }
    const revisions = requiredRepository(this.store, "workflowRevisions", "get");
    const compileResults = requiredRepository(this.store, "compileResults", "getLatest");
    const [revision, compileResult] = await Promise.all([
      revisions.get(objectId, versionId),
      compileResults.getLatest(versionId),
    ]);
    if (!revision || revision.workflowId !== objectId || revision.revisionId !== versionId) {
      throw new ProductMemoryError("canonical_memory_object_not_found");
    }
    if (
      compileResult?.status !== "ready"
      || compileResult?.workflowRevisionId !== versionId
      || compileResult?.executionPlan?.workflowId !== objectId
      || compileResult?.executionPlan?.workflowRevisionId !== versionId
    ) {
      throw new ProductMemoryError("canonical_memory_validation_required");
    }
    return verifiedResult({
      objectKind: "workflow",
      objectId,
      versionId,
      factPath,
      canonicalObject: revision,
      subject: { kind: "workflow", subjectId: objectId },
      objectHash: canonicalRequestHash(revision),
      validationHash: canonicalRequestHash({
        status: compileResult.status,
        workflowRevisionId: compileResult.workflowRevisionId,
        diagnostics: compileResult.diagnostics ?? [],
        executionPlan: compileResult.executionPlan,
      }),
      objectRef: `product:workflow/${objectId}/revisions/${versionId}`,
      validationRef: `product:workflow/${objectId}/revisions/${versionId}/compile`,
    });
  }

  async #skillDraft({ workspaceId, objectId, versionId, factPath }) {
    const drafts = requiredRepository(this.store, "skillDrafts", "get");
    const validations = requiredRepository(this.store, "skillValidations", "getExactPassed");
    const draft = await drafts.get(objectId, { workspaceId });
    if (!draft) throw new ProductMemoryError("canonical_memory_object_not_found");
    const currentVersionId = `${draft.skillDraftId}:${draft.revision}`;
    if (versionId !== currentVersionId) throw new ProductMemoryError("canonical_memory_version_stale");
    const contentHash = canonicalSkillDraftContentHash(draft);
    const validation = await validations.getExactPassed({
      workspaceId,
      skillId: draft.skillId,
      skillDraftId: draft.skillDraftId,
      draftRevision: draft.revision,
      contentHash,
    });
    if (!validation || validation.status !== "passed" || validation.contentHash !== contentHash) {
      throw new ProductMemoryError("canonical_memory_validation_required");
    }
    return verifiedResult({
      objectKind: "skill_draft",
      objectId,
      versionId,
      factPath,
      canonicalObject: draft,
      subject: { kind: "skill_draft", subjectId: objectId },
      objectHash: contentHash,
      validationHash: canonicalRequestHash(validation),
      objectRef: `product:skill-draft/${objectId}/revisions/${draft.revision}`,
      validationRef: `product:skill-draft/${objectId}/validations/${validation.validationId}`,
    });
  }

  async #skillVersion({ workspaceId, objectId, versionId, factPath }) {
    const versions = requiredRepository(this.store, "skillVersions", "get");
    const version = await versions.get(versionId, { workspaceId });
    if (!version || version.skillId !== objectId || version.skillVersionId !== versionId) {
      throw new ProductMemoryError("canonical_memory_object_not_found");
    }
    if (version.validation?.status !== "passed" || !version.validation?.validationId || !version.validation?.contentHash) {
      throw new ProductMemoryError("canonical_memory_validation_required");
    }
    return verifiedResult({
      objectKind: "skill_version",
      objectId,
      versionId,
      factPath,
      canonicalObject: version,
      subject: { kind: "skill", subjectId: objectId },
      objectHash: canonicalRequestHash(version),
      validationHash: canonicalRequestHash(version.validation),
      objectRef: `product:skill/${objectId}/versions/${versionId}`,
      validationRef: `product:skill/${objectId}/versions/${versionId}/validation`,
    });
  }
}

function requiredRepository(store, name, method) {
  const repository = store.repositories?.[name];
  if (!repository || typeof repository[method] !== "function") {
    throw new TypeError(`canonical_memory_repository_missing:${name}.${method}`);
  }
  return repository;
}

function verifiedResult({
  objectKind,
  objectId,
  versionId,
  factPath,
  canonicalObject,
  subject,
  objectHash,
  validationHash,
  objectRef,
  validationRef,
}) {
  const statement = canonicalScalar(canonicalObject, factPath);
  return {
    source: { kind: "canonical_object", sourceId: objectId, versionId, verified: true },
    evidence: [
      { kind: "canonical_object", ref: objectRef, hash: objectHash },
      { kind: "validation", ref: validationRef, hash: validationHash },
    ],
    statement,
    subject,
    verification: { objectKind, objectId, versionId, factPath },
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
  if (!["string", "number", "boolean"].includes(typeof current) || (typeof current === "number" && !Number.isFinite(current))) {
    throw new ProductMemoryError("canonical_memory_fact_not_scalar");
  }
  const statement = String(current).trim();
  if (!statement || statement.length > 20_000) throw new ProductMemoryError("canonical_memory_fact_invalid");
  return statement;
}
