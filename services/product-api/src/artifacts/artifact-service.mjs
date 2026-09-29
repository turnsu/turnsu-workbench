import { createHash, randomUUID } from "node:crypto";

import { ObjectStoreError } from "../storage/filesystem-object-store.mjs";
import { ArtifactImageValidationError, validateImageBytes } from "./image-validation.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const READY_ATTEMPT_STATUSES = new Set(["completed", "succeeded", "partial"]);
const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RECONCILE_ITEMS = 100;
const PUBLIC_CACHE_CONTROL = "private, max-age=31536000, immutable";
const REPOSITORY_METHODS = Object.freeze([
  "createPending",
  "get",
  "list",
  "transition",
  "delete",
]);

export const ARTIFACT_METADATA_REPOSITORY_METHODS = REPOSITORY_METHODS;

export class ArtifactServiceError extends Error {
  constructor(code, message = code, { retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactServiceError";
    this.code = code;
    this.retryable = retryable;
    this.productSafe = true;
  }
}

export function createArtifactService(options) {
  return new ArtifactService(options);
}

export class ArtifactService {
  #metadata;
  #execution;
  #objects;
  #clock;
  #idFactory;
  #maxArtifactBytes;
  #imageLimits;

  constructor({
    metadataRepository,
    executionPersistence,
    objectStore,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
    imageLimits = {},
  } = {}) {
    assertPort(metadataRepository, REPOSITORY_METHODS, "artifact_metadata_repository_required");
    assertPort(executionPersistence, ["getInvocation", "getAttempt", "getActiveLease"], "artifact_execution_checker_required");
    assertPort(objectStore, ["put", "stat", "read", "list", "promote", "deleteObject"], "artifact_object_store_required");
    if (typeof clock !== "function" || typeof idFactory !== "function") throw new TypeError("artifact_service_factory_invalid");
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) throw new TypeError("artifact_size_limit_invalid");
    this.#metadata = metadataRepository;
    this.#execution = executionPersistence;
    this.#objects = objectStore;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxArtifactBytes = maxArtifactBytes;
    this.#imageLimits = normalizeImageLimits(imageLimits);
  }

  async commitImage({
    workspaceId,
    execution,
    bytes,
    mediaType,
    expectedDimensions = null,
    format = null,
    seed = null,
    safetyStatus = null,
    source,
    requestedModelRevisionId,
    actualModelRevisionId,
    expiresAt = null,
    signal,
  } = {}) {
    validateId(workspaceId, "artifact_workspace_invalid");
    const executionRef = normalizeExecutionRef(execution);
    const artifactSource = normalizeSource(source, executionRef);
    validateId(requestedModelRevisionId, "artifact_model_revision_invalid");
    validateId(actualModelRevisionId, "artifact_model_revision_invalid");
    const createdAt = timestamp(this.#clock);
    const expiration = normalizeExpiration(expiresAt, createdAt);
    const content = await collectBoundedBytes(bytes, this.#maxArtifactBytes, signal);
    let dimensions;
    try {
      dimensions = validateImageBytes(content, mediaType, this.#imageLimits);
    } catch (error) {
      throw normalizeError(error);
    }
    assertExpectedDimensions(expectedDimensions, dimensions);
    const generation = normalizeGeneration({ mediaType, format, seed, safetyStatus });
    const artifactId = this.#idFactory("artifact");
    validateId(artifactId, "artifact_id_invalid");
    const contentHash = hash(content);
    const objectId = artifactObjectId(contentHash);
    const pending = {
      schemaVersion: "workbench-v1",
      artifactId,
      workspaceId,
      objectId,
      state: "pending",
      mediaType,
      byteLength: content.byteLength,
      contentHash,
      dimensions,
      generation,
      source: artifactSource,
      requestedModelRevisionId,
      actualModelRevisionId,
      invocationId: executionRef.invocationId,
      attemptId: executionRef.attemptId,
      fence: executionRef.fence,
      capabilityLeaseId: executionRef.capabilityLeaseId,
      execution: executionRef,
      ownerUserId: null,
      objectScope: scopeForSource(artifactSource),
      expiresAt: expiration,
      createdAt,
      updatedAt: createdAt,
      failureCode: null,
    };
    let pendingCreated = false;
    let objectStored = false;
    try {
      const authority = await this.#requireActiveExecution(workspaceId, executionRef, artifactSource);
      pending.ownerUserId = authority.ownerUserId;
      const stored = await this.#objects.put({
        workspaceId,
        objectId,
        bytes: content,
        contentHash,
        mediaType,
        metadata: { source: "product-artifact", artifactId },
        state: "quarantined",
        signal,
      });
      objectStored = true;
      if (stored.contentHash !== contentHash || stored.sizeBytes !== content.byteLength || stored.mediaType !== mediaType) {
        throw failure("artifact_object_integrity_failed");
      }
      await this.#requireActiveExecution(workspaceId, executionRef);
      await this.#metadata.createPending(structuredClone(pending));
      pendingCreated = true;
      const promoted = await this.#objects.promote({ workspaceId, objectId });
      if (promoted.state !== "promoted" || promoted.contentHash !== contentHash) {
        throw failure("artifact_promotion_failed", true);
      }
      await this.#requireActiveExecution(workspaceId, executionRef);
      const readyAt = timestamp(this.#clock);
      const ready = await this.#metadata.transition({
        workspaceId,
        artifactId,
        expectedState: "pending",
        nextState: "ready",
        expectedFence: executionRef.fence,
        patch: { readyAt, updatedAt: readyAt },
      });
      if (!ready) throw failure("artifact_metadata_transition_failed", true);
      if (await this.#executionState(workspaceId, executionRef) !== "active") {
        await this.#metadata.delete({ workspaceId, artifactId, expectedStates: ["ready"], reason: "execution_fenced" });
        throw new ArtifactServiceError("artifact_execution_fenced", "The execution can no longer attach artifacts.");
      }
      return publicArtifact(ready);
    } catch (error) {
      if (pendingCreated) {
        await this.#markFailed(pending, normalizeFailureCode(error)).catch(() => {});
      }
      if (objectStored) {
        await this.#deleteObjectIfUnreferenced(pending).catch(() => {});
      }
      throw normalizeError(error);
    }
  }

  async getMetadata({ workspaceId, artifactId, requestedBy, authorizedObjectScopes = [] } = {}) {
    const record = await this.#readyRecord(workspaceId, artifactId, {
      requestedBy,
      authorizedObjectScopes,
    });
    return publicArtifact(record);
  }

  async getAuthorizationDescriptor({ workspaceId, artifactId } = {}) {
    validateAddress(workspaceId, artifactId);
    const record = await this.#metadata.get({ workspaceId, artifactId });
    if (!sameWorkspace(record, workspaceId) || record.state !== "ready") throw notFound();
    return {
      ownerUserId: record.ownerUserId,
      objectScope: structuredClone(record.objectScope),
    };
  }

  async readContent({
    workspaceId,
    artifactId,
    requestedBy,
    authorizedObjectScopes = [],
    signal,
  } = {}) {
    const record = await this.#readyRecord(workspaceId, artifactId, {
      requestedBy,
      authorizedObjectScopes,
    });
    let stored;
    try {
      stored = await this.#objects.read({ workspaceId, objectId: record.objectId, signal });
    } catch (error) {
      if (error instanceof ObjectStoreError && error.code === "object_not_found") throw notFound();
      throw normalizeError(error, "artifact_read_failed");
    }
    if (stored.object.state !== "promoted"
      || stored.object.contentHash !== record.contentHash
      || stored.object.sizeBytes !== record.byteLength
      || stored.object.mediaType !== record.mediaType) {
      throw failure("artifact_integrity_failed");
    }
    return {
      artifact: publicArtifact(record),
      bytes: stored.bytes,
      headers: {
        "Content-Type": record.mediaType,
        "Content-Length": String(record.byteLength),
        ETag: `"${record.contentHash}"`,
        "Cache-Control": PUBLIC_CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
      },
    };
  }

  async delete({ workspaceId, artifactId, reason = "retention" } = {}) {
    validateAddress(workspaceId, artifactId);
    const current = await this.#metadata.get({ workspaceId, artifactId });
    if (!sameWorkspace(current, workspaceId)) return { deleted: false };
    const deleted = await this.#metadata.delete({
      workspaceId,
      artifactId,
      expectedStates: [current.state],
      reason: safeReason(reason),
    });
    if (!deleted) return { deleted: false };
    await this.#deleteObjectIfUnreferenced(current);
    return { deleted: true };
  }

  async cleanupExpired({ workspaceId, now = timestamp(this.#clock), limit = DEFAULT_MAX_RECONCILE_ITEMS } = {}) {
    validateId(workspaceId, "artifact_workspace_invalid");
    validateLimit(limit);
    const records = await this.#metadata.list({
      workspaceId,
      states: ["ready"],
      expiresBefore: String(now),
      limit,
    });
    let deleted = 0;
    for (const record of records) {
      if (!sameWorkspace(record, workspaceId) || !record.expiresAt || record.expiresAt > now) continue;
      const result = await this.delete({ workspaceId, artifactId: record.artifactId, reason: "retention_expired" });
      if (result.deleted) deleted += 1;
    }
    return { inspected: records.length, deleted };
  }

  async cleanupAttempt({ workspaceId, invocationId, attemptId, limit = DEFAULT_MAX_RECONCILE_ITEMS } = {}) {
    validateId(workspaceId, "artifact_workspace_invalid");
    validateId(invocationId, "artifact_execution_invalid");
    validateId(attemptId, "artifact_execution_invalid");
    validateLimit(limit);
    const records = await this.#metadata.list({ workspaceId, invocationId, attemptId, limit });
    let deleted = 0;
    for (const record of records) {
      if (!sameWorkspace(record, workspaceId)
        || record.execution?.invocationId !== invocationId
        || record.execution?.attemptId !== attemptId) continue;
      const result = await this.delete({ workspaceId, artifactId: record.artifactId, reason: "execution_cleanup" });
      if (result.deleted) deleted += 1;
    }
    return { inspected: records.length, deleted };
  }

  async reconcile({ workspaceId, updatedBefore = timestamp(this.#clock), limit = DEFAULT_MAX_RECONCILE_ITEMS } = {}) {
    validateId(workspaceId, "artifact_workspace_invalid");
    validateLimit(limit);
    const records = await this.#metadata.list({
      workspaceId,
      states: ["pending", "ready", "failed"],
      updatedBefore: String(updatedBefore),
      limit,
    });
    const result = { inspected: records.length, recovered: 0, deleted: 0, failed: 0, orphansDeleted: 0 };
    for (const record of records) {
      if (!sameWorkspace(record, workspaceId)) continue;
      if (record.state === "pending") await this.#reconcilePending(record, result);
      else if (record.state === "ready") await this.#reconcileReady(record, result);
      else if (record.state === "failed") {
        const deletion = await this.delete({ workspaceId, artifactId: record.artifactId, reason: "artifact_reconciliation" });
        if (deletion.deleted) result.deleted += 1;
      }
    }
    const objects = await this.#objects.list({ workspaceId });
    for (const object of objects) {
      if (object.metadata?.source !== "product-artifact" || typeof object.metadata.artifactId !== "string") continue;
      const references = await this.#metadata.list({
        workspaceId,
        objectId: object.objectId,
        states: ["pending", "ready"],
        limit: 1,
      });
      if (references.some((record) => sameWorkspace(record, workspaceId) && record.objectId === object.objectId)) continue;
      await this.#objects.deleteObject({ workspaceId, objectId: object.objectId });
      result.orphansDeleted += 1;
    }
    return result;
  }

  async #reconcilePending(record, result) {
    const executionState = await this.#executionState(record.workspaceId, record.execution);
    if (executionState === "invalid") {
      await this.#markFailed(record, "artifact_execution_fenced").catch(() => {});
      await this.#deleteObjectIfUnreferenced(record).catch(() => {});
      result.failed += 1;
      return;
    }
    let object;
    try {
      object = await this.#objects.stat({ workspaceId: record.workspaceId, objectId: record.objectId });
    } catch (error) {
      if (!(error instanceof ObjectStoreError) || error.code !== "object_not_found") throw error;
      await this.#markFailed(record, "artifact_object_missing");
      await this.#deleteObjectIfUnreferenced(record).catch(() => {});
      result.failed += 1;
      return;
    }
    if (object.contentHash !== record.contentHash || object.sizeBytes !== record.byteLength || object.mediaType !== record.mediaType) {
      await this.#markFailed(record, "artifact_integrity_failed");
      await this.#deleteObjectIfUnreferenced(record).catch(() => {});
      result.failed += 1;
      return;
    }
    if (object.state === "quarantined") {
      object = await this.#objects.promote({ workspaceId: record.workspaceId, objectId: record.objectId });
    }
    if (object.state !== "promoted") throw failure("artifact_promotion_failed", true);
    if (executionState === "active" && await this.#executionState(record.workspaceId, record.execution) !== "active") {
      await this.#markFailed(record, "artifact_execution_fenced").catch(() => {});
      await this.#deleteObjectIfUnreferenced(record).catch(() => {});
      result.failed += 1;
      return;
    }
    const readyAt = timestamp(this.#clock);
    const ready = await this.#metadata.transition({
      workspaceId: record.workspaceId,
      artifactId: record.artifactId,
      expectedState: "pending",
      nextState: "ready",
      expectedFence: record.fence,
      patch: { readyAt, updatedAt: readyAt },
    });
    if (ready) result.recovered += 1;
  }

  async #reconcileReady(record, result) {
    if (await this.#executionState(record.workspaceId, record.execution) !== "invalid") return;
    const deleted = await this.delete({
      workspaceId: record.workspaceId,
      artifactId: record.artifactId,
      reason: "execution_fenced",
    });
    if (deleted.deleted) result.deleted += 1;
  }

  async #markFailed(record, failureCode) {
    const now = timestamp(this.#clock);
    return this.#metadata.transition({
      workspaceId: record.workspaceId,
      artifactId: record.artifactId,
      expectedState: "pending",
      nextState: "failed",
      expectedFence: record.fence,
      patch: { failureCode, updatedAt: now },
    });
  }

  async #deleteObjectIfUnreferenced(record) {
    const references = await this.#metadata.list({
      workspaceId: record.workspaceId,
      objectId: record.objectId,
      states: ["pending", "ready"],
      limit: 1,
    });
    if (references.some((candidate) => sameWorkspace(candidate, record.workspaceId)
      && candidate.objectId === record.objectId
      && ["pending", "ready"].includes(candidate.state))) return { deleted: false, retained: true };
    return this.#objects.deleteObject({ workspaceId: record.workspaceId, objectId: record.objectId });
  }

  async #readyRecord(workspaceId, artifactId, { requestedBy, authorizedObjectScopes }) {
    validateAddress(workspaceId, artifactId);
    validateId(requestedBy, "artifact_principal_invalid");
    const scopes = normalizeAuthorizedScopes(authorizedObjectScopes);
    const record = await this.#metadata.get({ workspaceId, artifactId });
    if (!sameWorkspace(record, workspaceId)
      || record.state !== "ready"
      || !canReadArtifact(record, requestedBy, scopes)) throw notFound();
    return record;
  }

  async #requireActiveExecution(workspaceId, executionRef, source = null) {
    if (await this.#executionState(workspaceId, executionRef) !== "active") {
      throw new ArtifactServiceError("artifact_execution_fenced", "The execution can no longer attach artifacts.");
    }
    if (!source) return null;
    const invocation = await this.#execution.getInvocation(executionRef.invocationId);
    const ownerUserId = invocation?.request?.actor?.userId;
    validateId(ownerUserId, "artifact_execution_owner_invalid");
    if (!sourceMatchesInvocation(source, invocation)) throw failure("artifact_source_invalid");
    return { ownerUserId };
  }

  async #executionState(workspaceId, executionRef) {
    if (!executionRef) return "invalid";
    const [invocation, attempt] = await Promise.all([
      this.#execution.getInvocation(executionRef.invocationId),
      this.#execution.getAttempt(executionRef.attemptId),
    ]);
    if (!invocation || !attempt
      || invocation.workspaceId !== workspaceId
      || invocation.invocationId !== executionRef.invocationId
      || invocation.attemptId !== executionRef.attemptId
      || invocation.executionFence !== executionRef.fence
      || attempt.invocationId !== executionRef.invocationId
      || attempt.attemptId !== executionRef.attemptId
      || attempt.fence !== executionRef.fence) return "invalid";
    if (READY_ATTEMPT_STATUSES.has(invocation.status) && READY_ATTEMPT_STATUSES.has(attempt.status)) return "succeeded";
    if (invocation.status !== "running" || attempt.status !== "running") return "invalid";
    const lease = await this.#execution.getActiveLease(
      executionRef.invocationId,
      executionRef.attemptId,
      timestamp(this.#clock),
    );
    if (!lease
      || lease.capabilityLeaseId !== executionRef.capabilityLeaseId
      || lease.invocationId !== executionRef.invocationId
      || lease.attemptId !== executionRef.attemptId
      || lease.workspaceId !== workspaceId
      || lease.fence !== executionRef.fence
      || lease.status !== "active") return "invalid";
    return "active";
  }
}

function assertPort(value, methods, code) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) throw new TypeError(code);
}

function validateAddress(workspaceId, artifactId) {
  validateId(workspaceId, "artifact_workspace_invalid");
  validateId(artifactId, "artifact_id_invalid");
}

function validateId(value, code) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new ArtifactServiceError(code, "The artifact address is invalid.");
}

function normalizeExecutionRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("artifact_execution_invalid");
  for (const key of ["invocationId", "attemptId", "capabilityLeaseId"]) validateId(value[key], "artifact_execution_invalid");
  if (!Number.isSafeInteger(value.fence) || value.fence < 1) throw failure("artifact_execution_invalid");
  return {
    invocationId: value.invocationId,
    attemptId: value.attemptId,
    capabilityLeaseId: value.capabilityLeaseId,
    fence: value.fence,
  };
}

function normalizeSource(value, executionRef) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.invocationId !== executionRef.invocationId
    || value.attemptId !== executionRef.attemptId) throw failure("artifact_source_invalid");
  if (value.kind === "agent_turn") {
    validateId(value.sessionId, "artifact_source_invalid");
    validateId(value.turnId, "artifact_source_invalid");
    return {
      kind: "agent_turn",
      sessionId: value.sessionId,
      turnId: value.turnId,
      invocationId: value.invocationId,
      attemptId: value.attemptId,
    };
  }
  if (value.kind === "workflow_run") {
    validateId(value.runId, "artifact_source_invalid");
    validateId(value.nodeId, "artifact_source_invalid");
    return {
      kind: "workflow_run",
      runId: value.runId,
      nodeId: value.nodeId,
      invocationId: value.invocationId,
      attemptId: value.attemptId,
    };
  }
  throw failure("artifact_source_invalid");
}

function scopeForSource(source) {
  return source.kind === "agent_turn"
    ? { objectKind: "agent_session", objectId: source.sessionId }
    : { objectKind: "workflow_run", objectId: source.runId };
}

function sourceMatchesInvocation(source, invocation) {
  if (!invocation?.request || invocation.request.actor?.userId === undefined) return false;
  if (source.kind === "agent_turn") {
    return invocation.controller?.kind === "agent_turn"
      && invocation.controller.controllerId === source.turnId
      && invocation.request.lineage?.sessionId === source.sessionId;
  }
  return source.kind === "workflow_run"
    && invocation.controller?.kind === "workflow_run"
    && invocation.controller.controllerId === source.runId;
}

function normalizeAuthorizedScopes(value) {
  if (!Array.isArray(value)) throw failure("artifact_scope_invalid");
  return value.map((scope) => {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw failure("artifact_scope_invalid");
    }
    validateId(scope.objectKind, "artifact_scope_invalid");
    validateId(scope.objectId, "artifact_scope_invalid");
    return { objectKind: scope.objectKind, objectId: scope.objectId };
  });
}

function canReadArtifact(record, requestedBy, authorizedObjectScopes) {
  if (record.ownerUserId === requestedBy) return true;
  return authorizedObjectScopes.some((scope) => (
    record.objectScope?.objectKind === scope.objectKind
    && record.objectScope?.objectId === scope.objectId
  ));
}

function normalizeImageLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("artifact_image_limits_invalid");
  const result = {};
  for (const key of ["maxWidth", "maxHeight", "maxPixels"]) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new TypeError("artifact_image_limits_invalid");
    result[key] = value[key];
  }
  return result;
}

async function collectBoundedBytes(input, limit, signal) {
  if (typeof input === "string") throw failure("artifact_bytes_invalid");
  const chunks = [];
  let size = 0;
  let iterable;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) iterable = [input];
  else if (input && (typeof input[Symbol.asyncIterator] === "function" || typeof input[Symbol.iterator] === "function")) iterable = input;
  else throw failure("artifact_bytes_invalid");
  for await (const chunk of iterable) {
    if (signal?.aborted) throw new ArtifactServiceError("artifact_write_cancelled", "Artifact creation was cancelled.");
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw failure("artifact_bytes_invalid");
    const data = Buffer.from(chunk);
    size += data.byteLength;
    if (size > limit) throw failure("artifact_too_large");
    chunks.push(data);
  }
  if (size === 0) throw failure("artifact_bytes_invalid");
  return Buffer.concat(chunks, size);
}

function assertExpectedDimensions(expected, actual) {
  if (expected === null || expected === undefined) return;
  if (!expected || typeof expected !== "object"
    || expected.width !== actual.width || expected.height !== actual.height) {
    throw failure("artifact_image_dimensions_mismatch");
  }
}

function normalizeGeneration({ mediaType, format, seed, safetyStatus }) {
  const derivedFormat = mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpeg" : "webp";
  if (format !== null && format !== undefined && format !== derivedFormat && !(format === "jpg" && derivedFormat === "jpeg")) {
    throw failure("artifact_image_format_mismatch");
  }
  if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw failure("artifact_seed_invalid");
  if (safetyStatus !== null && (typeof safetyStatus !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(safetyStatus))) {
    throw failure("artifact_safety_status_invalid");
  }
  return {
    format: derivedFormat,
    ...(seed === null ? {} : { seed }),
    ...(safetyStatus === null ? {} : { safetyStatus }),
  };
}

function normalizeExpiration(value, createdAt) {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.parse(createdAt)) throw failure("artifact_expiration_invalid");
  return new Date(parsed).toISOString();
}

function publicArtifact(record) {
  return {
    schemaVersion: "workbench-v1",
    artifactId: record.artifactId,
    workspaceId: record.workspaceId,
    state: "ready",
    mediaType: record.mediaType,
    byteLength: record.byteLength,
    contentHash: record.contentHash,
    dimensions: structuredClone(record.dimensions),
    source: structuredClone(record.source),
    requestedModelRevisionId: record.requestedModelRevisionId,
    actualModelRevisionId: record.actualModelRevisionId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
  };
}

function artifactObjectId(contentHash) {
  return `object-artifact-${contentHash.slice("sha256:".length)}`;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function timestamp(clock) {
  const value = clock();
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError("artifact_clock_invalid");
  return new Date(text).toISOString();
}

function sameWorkspace(record, workspaceId) {
  return Boolean(record && record.workspaceId === workspaceId);
}

function safeReason(value) {
  const text = String(value || "retention");
  return /^[a-z][a-z0-9_]{0,63}$/.test(text) ? text : "artifact_cleanup";
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw failure("artifact_limit_invalid");
}

function notFound() {
  return new ArtifactServiceError("artifact_not_found", "The requested artifact was not found.");
}

function failure(code, retryable = false) {
  return new ArtifactServiceError(code, "The artifact could not be stored.", { retryable });
}

function normalizeFailureCode(error) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "artifact_write_failed";
}

function normalizeError(error, fallbackCode = "artifact_write_failed") {
  if (error instanceof ArtifactServiceError) return error;
  if (error instanceof ArtifactImageValidationError) {
    return new ArtifactServiceError(error.code, error.message, { cause: error });
  }
  if (error instanceof ObjectStoreError) {
    const code = error.code === "object_too_large" ? "artifact_too_large" : fallbackCode;
    return new ArtifactServiceError(code, "The artifact could not be stored.", {
      retryable: error.retryable === true,
      cause: error,
    });
  }
  return new ArtifactServiceError(fallbackCode, "The artifact could not be stored.", { cause: error });
}
