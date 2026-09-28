import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "worker-transcript-envelope-v1";
const STORED_MEDIA_TYPE = "application/octet-stream";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_CLEANUP_LIMIT = 100;
const ALLOWED_MEDIA_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "text/plain",
]);
const REPOSITORY_METHODS = Object.freeze([
  "createPending",
  "get",
  "list",
  "transition",
]);

export const WORKER_TRANSCRIPT_ARTIFACT_REPOSITORY_METHODS = REPOSITORY_METHODS;

export class WorkerTranscriptArtifactError extends Error {
  constructor(code, message = code, { retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkerTranscriptArtifactError";
    this.code = code;
    this.retryable = retryable;
    this.productSafe = true;
  }
}

export function createWorkerTranscriptArtifactService(options) {
  return new WorkerTranscriptArtifactService(options);
}

/**
 * Product-owned encrypted storage for sensitive Worker transcripts.
 *
 * The injected repository stores metadata only. The injected ObjectStore sees
 * ciphertext only, and the encryption key remains private to this service
 * instance. Callers must supply the exact inherited user/workspace/object scope
 * again for every read or delete.
 */
export class WorkerTranscriptArtifactService {
  #repository;
  #objectStore;
  #audit;
  #key;
  #keyId;
  #clock;
  #idFactory;
  #randomBytes;
  #maxBytes;
  #disposed = false;

  constructor({
    repository,
    objectStore,
    audit,
    encryptionKey,
    keyId,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    randomBytesFactory = randomBytes,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    assertPort(repository, REPOSITORY_METHODS, "worker_transcript_repository_required");
    assertPort(
      objectStore,
      ["put", "promote", "read", "deleteObject"],
      "worker_transcript_object_store_required",
    );
    if (typeof audit !== "function") throw new TypeError("worker_transcript_audit_required");
    if (typeof clock !== "function" || typeof idFactory !== "function" || typeof randomBytesFactory !== "function") {
      throw new TypeError("worker_transcript_service_factory_invalid");
    }
    if (!Buffer.isBuffer(encryptionKey) && !(encryptionKey instanceof Uint8Array)) {
      throw new TypeError("worker_transcript_encryption_key_required");
    }
    if (encryptionKey.byteLength !== 32) throw new TypeError("worker_transcript_encryption_key_invalid");
    validateId(keyId, "worker_transcript_key_id_invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("worker_transcript_size_limit_invalid");
    this.#repository = repository;
    this.#objectStore = objectStore;
    this.#audit = audit;
    this.#key = Buffer.from(encryptionKey);
    this.#keyId = keyId;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#randomBytes = randomBytesFactory;
    this.#maxBytes = maxBytes;
  }

  async commit({
    workspaceId,
    ownerUserId,
    objectScope,
    invocationId,
    attemptId,
    content,
    mediaType = "application/json",
    ttlSeconds = DEFAULT_TTL_SECONDS,
    signal,
  } = {}) {
    this.#assertActive();
    const scope = normalizeScope(objectScope);
    validateId(workspaceId, "worker_transcript_workspace_invalid");
    validateId(ownerUserId, "worker_transcript_owner_invalid");
    validateId(invocationId, "worker_transcript_execution_invalid");
    validateId(attemptId, "worker_transcript_execution_invalid");
    validateMediaType(mediaType);
    validateTtl(ttlSeconds);
    const plaintext = await collectBoundedBytes(content, this.#maxBytes, signal);
    const createdAt = timestamp(this.#clock);
    const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString();
    const transcriptArtifactId = this.#idFactory("worker-transcript");
    validateId(transcriptArtifactId, "worker_transcript_id_invalid");
    const objectId = `object-${transcriptArtifactId}`;
    validateObjectStoreId(objectId);
    const contentHash = digest(plaintext);
    const aad = buildAad({
      transcriptArtifactId,
      workspaceId,
      ownerUserId,
      objectScope: scope,
      invocationId,
      attemptId,
      mediaType,
      contentHash,
      expiresAt,
    });
    const encrypted = encrypt({
      plaintext,
      key: this.#key,
      iv: this.#randomBytes(12),
      aad,
    });
    const ciphertextHash = digest(encrypted.ciphertext);
    const pending = {
      schemaVersion: "workbench-v1",
      transcriptArtifactId,
      artifactKind: "worker_transcript",
      workspaceId,
      ownerUserId,
      objectScope: scope,
      invocationId,
      attemptId,
      sensitivity: "sensitive",
      state: "pending",
      objectId,
      mediaType,
      byteLength: plaintext.byteLength,
      contentHash,
      ciphertextByteLength: encrypted.ciphertext.byteLength,
      ciphertextHash,
      encryption: {
        envelopeVersion: ENVELOPE_VERSION,
        algorithm: "AES-256-GCM",
        keyId: this.#keyId,
        ivBase64: encrypted.iv.toString("base64"),
        authTagBase64: encrypted.authTag.toString("base64"),
        aadHash: digest(aad),
      },
      expiresAt,
      createdAt,
      updatedAt: createdAt,
      readyAt: null,
      deletedAt: null,
      deletionReason: null,
    };
    let objectStored = false;
    let pendingCreated = false;
    try {
      const stored = await this.#objectStore.put({
        workspaceId,
        objectId,
        bytes: encrypted.ciphertext,
        contentHash: ciphertextHash,
        mediaType: STORED_MEDIA_TYPE,
        metadata: {
          source: "worker-transcript-artifact",
          transcriptArtifactId,
          encryption: "AES-256-GCM",
        },
        state: "quarantined",
        signal,
      });
      objectStored = true;
      assertStoredObject(stored, pending, "quarantined");
      await this.#repository.createPending(structuredClone(pending));
      pendingCreated = true;
      const promoted = await this.#objectStore.promote({ workspaceId, objectId });
      assertStoredObject(promoted, pending, "promoted");
      const readyAt = timestamp(this.#clock);
      const ready = await this.#repository.transition({
        workspaceId,
        transcriptArtifactId,
        expectedState: "pending",
        nextState: "ready",
        patch: { readyAt, updatedAt: readyAt },
      });
      if (!ready) throw failure("worker_transcript_metadata_transition_failed", true);
      return safeRef(ready);
    } catch (error) {
      if (objectStored) {
        await this.#objectStore.deleteObject({ workspaceId, objectId }).catch(() => {});
      }
      if (pendingCreated) {
        const deletedAt = safeTimestamp(this.#clock);
        await this.#repository.transition({
          workspaceId,
          transcriptArtifactId,
          expectedState: "pending",
          nextState: "deleted",
          patch: {
            deletedAt,
            updatedAt: deletedAt,
            deletionReason: "commit_failed",
          },
        }).catch(() => {});
      }
      throw normalizeError(error, "worker_transcript_write_failed");
    }
  }

  async read({
    workspaceId,
    requestedBy,
    objectScope,
    transcriptArtifactId,
    signal,
  } = {}) {
    this.#assertActive();
    const access = normalizeAccess({ workspaceId, requestedBy, objectScope, transcriptArtifactId });
    const record = await this.#repository.get({ workspaceId, transcriptArtifactId });
    if (!record || record.state !== "ready" || !sameScope(record, access)) {
      await this.#auditDenied(access, "worker_transcript_forbidden");
      throw forbidden();
    }
    const now = timestamp(this.#clock);
    if (isExpired(record, now)) {
      await this.#deleteRecord(record, { reason: "retention_expired", actorUserId: null }).catch(() => {});
      await this.#auditDenied(access, "worker_transcript_expired", record);
      throw new WorkerTranscriptArtifactError(
        "worker_transcript_expired",
        "The Worker transcript artifact has expired.",
      );
    }
    try {
      const stored = await this.#objectStore.read({
        workspaceId,
        objectId: record.objectId,
        signal,
      });
      assertStoredObject(stored.object, record, "promoted");
      if (!Buffer.isBuffer(stored.bytes) && !(stored.bytes instanceof Uint8Array)) {
        throw failure("worker_transcript_integrity_failed");
      }
      const ciphertext = Buffer.from(stored.bytes);
      if (digest(ciphertext) !== record.ciphertextHash) {
        throw failure("worker_transcript_integrity_failed");
      }
      const aad = buildAad(record);
      if (record.encryption?.envelopeVersion !== ENVELOPE_VERSION
        || record.encryption?.algorithm !== "AES-256-GCM"
        || record.encryption?.aadHash !== digest(aad)
        || record.encryption?.keyId !== this.#keyId) {
        throw failure("worker_transcript_integrity_failed");
      }
      const plaintext = decrypt({
        ciphertext,
        key: this.#key,
        iv: decodeEnvelopeBytes(record.encryption.ivBase64, 12),
        authTag: decodeEnvelopeBytes(record.encryption.authTagBase64, 16),
        aad,
      });
      if (plaintext.byteLength !== record.byteLength || digest(plaintext) !== record.contentHash) {
        throw failure("worker_transcript_integrity_failed");
      }
      await this.#emitAudit({
        action: "worker_transcript_artifact.read",
        outcome: "allowed",
        reasonCode: null,
        record,
        actorUserId: requestedBy,
      });
      return {
        artifact: safeRef(record),
        mediaType: record.mediaType,
        bytes: plaintext,
      };
    } catch (error) {
      const normalized = normalizeError(error, "worker_transcript_integrity_failed");
      await this.#emitAudit({
        action: "worker_transcript_artifact.read",
        outcome: "error",
        reasonCode: normalized.code,
        record,
        actorUserId: requestedBy,
      }).catch(() => {});
      throw normalized;
    }
  }

  async delete({
    workspaceId,
    requestedBy,
    objectScope,
    transcriptArtifactId,
    reason = "user_deleted",
  } = {}) {
    this.#assertActive();
    const access = normalizeAccess({ workspaceId, requestedBy, objectScope, transcriptArtifactId });
    const record = await this.#repository.get({ workspaceId, transcriptArtifactId });
    if (!record) return { deleted: false };
    if (!sameScope(record, access)) {
      await this.#auditDenied(access, "worker_transcript_forbidden", record);
      throw forbidden();
    }
    if (record.state === "deleted") return { deleted: false };
    if (record.state !== "ready") throw failure("worker_transcript_state_invalid");
    let deleted;
    try {
      deleted = await this.#deleteRecord(record, {
        reason: safeReason(reason),
        actorUserId: requestedBy,
      });
    } catch (error) {
      throw normalizeError(error, "worker_transcript_delete_failed");
    }
    return { deleted, ...(deleted ? { artifact: safeRef({ ...record, state: "deleted" }) } : {}) };
  }

  async cleanupExpired({
    workspaceId,
    before = timestamp(this.#clock),
    limit = DEFAULT_CLEANUP_LIMIT,
  } = {}) {
    this.#assertActive();
    if (workspaceId !== undefined) validateId(workspaceId, "worker_transcript_workspace_invalid");
    const cutoff = normalizeTimestamp(before, "worker_transcript_cleanup_time_invalid");
    validateLimit(limit);
    const records = await this.#repository.list({
      ...(workspaceId ? { workspaceId } : {}),
      states: ["ready"],
      expiresBefore: cutoff,
      limit,
    });
    if (!Array.isArray(records)) throw failure("worker_transcript_repository_invalid");
    const result = { inspected: records.length, deleted: 0, failed: 0, failures: [] };
    for (const record of records) {
      if (record.state !== "ready" || !isExpired(record, cutoff)) continue;
      try {
        if (await this.#deleteRecord(record, { reason: "retention_expired", actorUserId: null })) {
          result.deleted += 1;
        }
      } catch (error) {
        result.failed += 1;
        result.failures.push({
          transcriptArtifactId: safeAuditId(record.transcriptArtifactId),
          code: normalizeError(error, "worker_transcript_delete_failed").code,
        });
      }
    }
    return result;
  }

  dispose() {
    if (this.#disposed) return;
    this.#key.fill(0);
    this.#disposed = true;
  }

  async #deleteRecord(record, { reason, actorUserId }) {
    await this.#objectStore.deleteObject({
      workspaceId: record.workspaceId,
      objectId: record.objectId,
    });
    const deletedAt = timestamp(this.#clock);
    const deleted = await this.#repository.transition({
      workspaceId: record.workspaceId,
      transcriptArtifactId: record.transcriptArtifactId,
      expectedState: "ready",
      nextState: "deleted",
      patch: {
        deletedAt,
        updatedAt: deletedAt,
        deletionReason: safeReason(reason),
      },
    });
    if (!deleted) return false;
    await this.#emitAudit({
      action: reason === "retention_expired"
        ? "worker_transcript_artifact.expired"
        : "worker_transcript_artifact.deleted",
      outcome: "allowed",
      reasonCode: reason,
      record: deleted,
      actorUserId,
    });
    return true;
  }

  async #auditDenied(access, reasonCode, record = null) {
    await this.#emitAudit({
      action: "worker_transcript_artifact.read",
      outcome: "denied",
      reasonCode,
      record: record ?? {
        transcriptArtifactId: access.transcriptArtifactId,
        workspaceId: access.workspaceId,
        objectScope: access.objectScope,
        invocationId: null,
        attemptId: null,
      },
      actorUserId: access.requestedBy,
    }).catch(() => {});
  }

  async #emitAudit({ action, outcome, reasonCode, record, actorUserId }) {
    try {
      await this.#audit({
        schemaVersion: "workbench-v1",
        action,
        outcome,
        reasonCode,
        transcriptArtifactId: safeAuditId(record.transcriptArtifactId),
        workspaceId: safeAuditId(record.workspaceId),
        actorUserId: actorUserId === null ? null : safeAuditId(actorUserId),
        objectScope: normalizeScope(record.objectScope),
        invocationId: record.invocationId ? safeAuditId(record.invocationId) : null,
        attemptId: record.attemptId ? safeAuditId(record.attemptId) : null,
        occurredAt: timestamp(this.#clock),
      });
    } catch (error) {
      throw new WorkerTranscriptArtifactError(
        "worker_transcript_audit_failed",
        "Worker transcript access could not be audited.",
        { retryable: true, cause: error },
      );
    }
  }

  #assertActive() {
    if (this.#disposed) {
      throw new WorkerTranscriptArtifactError(
        "worker_transcript_service_disposed",
        "The Worker transcript artifact service is unavailable.",
      );
    }
  }
}

function assertPort(value, methods, code) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) throw new TypeError(code);
}

function normalizeAccess({ workspaceId, requestedBy, objectScope, transcriptArtifactId }) {
  validateId(workspaceId, "worker_transcript_workspace_invalid");
  validateId(requestedBy, "worker_transcript_owner_invalid");
  validateId(transcriptArtifactId, "worker_transcript_id_invalid");
  return {
    workspaceId,
    requestedBy,
    objectScope: normalizeScope(objectScope),
    transcriptArtifactId,
  };
}

function normalizeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("worker_transcript_scope_invalid");
  }
  validateId(value.objectKind, "worker_transcript_scope_invalid");
  validateId(value.objectId, "worker_transcript_scope_invalid");
  return { objectKind: value.objectKind, objectId: value.objectId };
}

function sameScope(record, access) {
  return record.workspaceId === access.workspaceId
    && record.ownerUserId === access.requestedBy
    && record.objectScope?.objectKind === access.objectScope.objectKind
    && record.objectScope?.objectId === access.objectScope.objectId;
}

function validateId(value, code) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw failure(code);
}

function validateObjectStoreId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw failure("worker_transcript_object_id_invalid");
  }
}

function validateMediaType(value) {
  if (!ALLOWED_MEDIA_TYPES.has(value)) throw failure("worker_transcript_media_type_invalid");
}

function validateTtl(value) {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    throw failure("worker_transcript_ttl_invalid");
  }
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw failure("worker_transcript_cleanup_limit_invalid");
  }
}

async function collectBoundedBytes(value, maxBytes, signal) {
  if (signal?.aborted) throw failure("worker_transcript_write_cancelled");
  const chunks = [];
  let total = 0;
  let iterable;
  if (typeof value === "string") iterable = [Buffer.from(value, "utf8")];
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) iterable = [value];
  else if (value && (typeof value[Symbol.asyncIterator] === "function" || typeof value[Symbol.iterator] === "function")) {
    iterable = value;
  } else {
    throw failure("worker_transcript_content_invalid");
  }
  for await (const chunk of iterable) {
    if (signal?.aborted) throw failure("worker_transcript_write_cancelled");
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw failure("worker_transcript_content_invalid");
    }
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw failure("worker_transcript_too_large");
    chunks.push(bytes);
  }
  if (total < 1) throw failure("worker_transcript_content_invalid");
  return Buffer.concat(chunks, total);
}

function encrypt({ plaintext, key, iv, aad }) {
  if (!Buffer.isBuffer(iv) || iv.byteLength !== 12) throw new TypeError("worker_transcript_iv_invalid");
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decrypt({ ciphertext, key, iv, authTag, aad }) {
  try {
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw failure("worker_transcript_integrity_failed", false, error);
  }
}

function buildAad(value) {
  return Buffer.from(JSON.stringify({
    envelopeVersion: ENVELOPE_VERSION,
    transcriptArtifactId: value.transcriptArtifactId,
    workspaceId: value.workspaceId,
    ownerUserId: value.ownerUserId,
    objectScope: normalizeScope(value.objectScope),
    invocationId: value.invocationId,
    attemptId: value.attemptId,
    mediaType: value.mediaType,
    contentHash: value.contentHash,
    expiresAt: value.expiresAt,
  }), "utf8");
}

function decodeEnvelopeBytes(value, expectedBytes) {
  if (typeof value !== "string" || value.length < 1) throw failure("worker_transcript_integrity_failed");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    throw failure("worker_transcript_integrity_failed");
  }
  return decoded;
}

function assertStoredObject(value, record, expectedState) {
  if (!value || value.state !== expectedState
    || value.workspaceId !== record.workspaceId
    || value.objectId !== record.objectId
    || value.contentHash !== record.ciphertextHash
    || value.sizeBytes !== record.ciphertextByteLength
    || value.mediaType !== STORED_MEDIA_TYPE) {
    throw failure("worker_transcript_integrity_failed");
  }
}

function isExpired(record, now) {
  const expires = Date.parse(record?.expiresAt);
  return !Number.isFinite(expires) || expires <= Date.parse(now);
}

function safeRef(record) {
  return Object.freeze({
    schemaVersion: "workbench-v1",
    kind: "worker_transcript",
    transcriptArtifactId: record.transcriptArtifactId,
    sensitivity: "sensitive",
    expiresAt: record.expiresAt,
  });
}

function safeReason(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw failure("worker_transcript_delete_reason_invalid");
  }
  return value;
}

function safeAuditId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : "invalid";
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function timestamp(clock) {
  return normalizeTimestamp(clock(), "worker_transcript_clock_invalid");
}

function safeTimestamp(clock) {
  try {
    return timestamp(clock);
  } catch {
    return new Date().toISOString();
  }
}

function normalizeTimestamp(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw failure(code);
  return new Date(value).toISOString();
}

function forbidden() {
  return new WorkerTranscriptArtifactError(
    "worker_transcript_forbidden",
    "This Worker transcript artifact is not available to the current principal.",
  );
}

function failure(code, retryable = false, cause) {
  return new WorkerTranscriptArtifactError(code, code, { retryable, cause });
}

function normalizeError(error, fallbackCode) {
  if (error instanceof WorkerTranscriptArtifactError) return error;
  return new WorkerTranscriptArtifactError(fallbackCode, fallbackCode, {
    retryable: true,
    cause: error,
  });
}

export const WORKER_TRANSCRIPT_ARTIFACT_LIMITS = Object.freeze({
  defaultTtlSeconds: DEFAULT_TTL_SECONDS,
  minTtlSeconds: MIN_TTL_SECONDS,
  maxTtlSeconds: MAX_TTL_SECONDS,
  defaultMaxBytes: DEFAULT_MAX_BYTES,
});
