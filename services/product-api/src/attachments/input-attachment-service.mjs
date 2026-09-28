import { createHash, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_CHARACTERS = 120_000;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const RETRYABLE = new Set([
  "attachment_processing_unavailable",
  "attachment_processing_failed",
]);

export function createInputAttachmentService(options) {
  return new InputAttachmentService(options);
}

export class InputAttachmentService {
  #store;
  #persistence;
  #objectStore;
  #extractionSandbox;
  #clock;
  #idFactory;

  constructor({
    store,
    persistence = null,
    objectStore,
    extractionSandbox = null,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!persistence && (!store?.connect || !store?.authorizeWorkspace || !store?.runIdempotentExternalMutation)) {
      throw new TypeError("attachment_store_required");
    }
    if (persistence) assertPersistence(persistence);
    if (!objectStore?.put || !objectStore?.promote || !objectStore?.read || !objectStore?.deleteObject) {
      throw new TypeError("attachment_object_store_required");
    }
    this.#store = store;
    this.#persistence = persistence;
    this.#objectStore = objectStore;
    this.#extractionSandbox = extractionSandbox;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  capabilities() {
    const image = [...IMAGE_TYPES].sort();
    const extracted = [...TEXT_TYPES, ...DOCUMENT_TYPES].sort();
    return Object.freeze({
      maxBytes: MAX_BYTES,
      readyMediaTypes: this.#extractionSandbox?.extract
        ? [...image, ...extracted].sort()
        : image,
      unavailableMediaTypes: this.#extractionSandbox?.extract ? [] : extracted,
    });
  }

  async create({
    workspaceId,
    requestedBy,
    idempotencyKey,
    fileName,
    mediaType,
    content,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    signal,
  }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const bytes = Buffer.from(content ?? []);
    validateUpload({ fileName, mediaType, bytes, ttlSeconds });
    validateMediaSignature(mediaType, bytes);
    const contentHash = hash(bytes);
    return this.#runIdempotentExternalMutation({
      // Personal attachments use an actor-scoped idempotency namespace so
      // collaborators cannot replay another user's cached private response.
      scope: `create-input-attachment:${requestedBy}`,
      key: idempotencyKey,
      request: { fileName: fileName.trim(), mediaType, contentHash, ttlSeconds },
      workspaceId,
      effectivePrincipalId: requestedBy,
      operationIdKind: "attachment",
      recover: async (attachmentId) => {
        const existing = await this.#getAttachment({ workspaceId, attachmentId });
        return existing
          ? this.#processingResult(existing, await this.#representations(attachmentId, workspaceId))
          : null;
      },
    }, async (attachmentId) => this.#createOperation({
      attachmentId,
      workspaceId,
      requestedBy,
      fileName: fileName.trim(),
      mediaType,
      bytes,
      contentHash,
      ttlSeconds,
      signal,
    }));
  }

  async list({ workspaceId, requestedBy, cursor = null, limit = 50 }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    await this.#expireDue({ workspaceId, ownerUserId: requestedBy });
    const decoded = decodeCursor(cursor);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 100));
    if (this.#persistence) {
      const rows = await this.#persistence.listAttachments({
        workspaceId,
        ownerUserId: requestedBy,
        cursor: decoded,
        limit: bounded + 1,
      });
      return pageAttachments(rows, bounded);
    }
    const filter = {
      workspaceId,
      ownerUserId: requestedBy,
      deletedAt: null,
      ...(decoded ? {
        $or: [
          { updatedAt: { $lt: decoded.updatedAt } },
          { updatedAt: decoded.updatedAt, attachmentId: { $lt: decoded.attachmentId } },
        ],
      } : {}),
    };
    const rows = await this.#store.repositories.attachments.collection
      .find(filter)
      .sort({ updatedAt: -1, attachmentId: -1 })
      .limit(bounded + 1)
      .toArray();
    const hasMore = rows.length > bounded;
    const data = rows.slice(0, bounded).map(publicAttachment);
    const last = data.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor: hasMore && last
          ? encodeCursor({ updatedAt: last.updatedAt, attachmentId: last.attachmentId })
          : null,
      },
    };
  }

  async get({ workspaceId, requestedBy, attachmentId }) {
    const attachment = await this.#ownedAttachment({
      workspaceId,
      requestedBy,
      attachmentId,
      allowUnavailable: true,
    });
    return this.#processingResult(attachment, await this.#representations(attachmentId, workspaceId));
  }

  async retry({ workspaceId, requestedBy, attachmentId, signal }) {
    const attachment = await this.#ownedAttachment({
      workspaceId,
      requestedBy,
      attachmentId,
      allowUnavailable: true,
      minimumRole: "member",
    });
    if (!["failed", "blocked"].includes(attachment.processing?.status) || !attachment.processing?.retryable) {
      throw error("attachment_retry_not_allowed", "This attachment cannot be retried.");
    }
    return this.#processAndPatch({ attachment, signal });
  }

  async delete({ workspaceId, requestedBy, attachmentId }) {
    const attachment = await this.#ownedAttachment({
      workspaceId,
      requestedBy,
      attachmentId,
      allowUnavailable: true,
      minimumRole: "member",
    });
    if (attachment.deletedAt) return publicAttachment(attachment);
    // Delete governed bytes first. If storage is unavailable, leave the
    // metadata active so the operation/TTL scavenger can be retried instead
    // of reporting a false physical deletion.
    await this.#deleteAttachmentObjects(attachment);
    const now = timestamp(this.#clock);
    const deleted = await this.#patchAttachment({
      workspaceId: attachment.workspaceId,
      attachmentId,
      patch: {
        processing: {
          status: "deleted",
          code: "attachment_deleted",
          message: "The attachment was deleted.",
          retryable: false,
        },
        deletedAt: now,
        updatedAt: now,
      },
    });
    return publicAttachment(deleted);
  }

  async resolveForTurn({ workspaceId, requestedBy, refs, signal }) {
    const parts = [];
    for (const ref of refs ?? []) {
      const attachment = await this.#validateRef({
        workspaceId,
        requestedBy,
        ref,
      });
      if (IMAGE_TYPES.has(attachment.mediaType)) {
        const stored = await this.#objectStore.read({
          workspaceId,
          objectId: attachment.objectId,
          signal,
        });
        validateStoredObject(stored, attachment);
        validateMediaSignature(attachment.mediaType, stored.bytes);
        parts.push({
          type: "image",
          mediaType: attachment.mediaType,
          dataBase64: stored.bytes.toString("base64"),
          attachment: toRef(attachment),
        });
        continue;
      }
      const representations = await this.#representations(attachment.attachmentId, attachment.workspaceId);
      const representation = representations.find((item) => item.representationObjectId);
      if (!representation) {
        throw error("attachment_processing_failed", "The attachment has no readable representation.");
      }
      const stored = await this.#objectStore.read({
        workspaceId,
        objectId: representation.representationObjectId,
        signal,
      });
      if (stored.object.contentHash !== representation.contentHash) {
        throw error("attachment_integrity_failed", "The attachment representation failed integrity validation.");
      }
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(stored.bytes)
        .slice(0, MAX_CONTEXT_CHARACTERS);
      parts.push({
        type: "text",
        text: [
          `[Attachment: ${attachment.fileName}; ${attachment.mediaType}; ${attachment.contentHash}]`,
          text,
        ].join("\n"),
        attachment: toRef(attachment),
      });
    }
    return parts;
  }

  async readText({ workspaceId, requestedBy, ref, offset = 0, limit = 16_000, signal }) {
    if (!Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 32_000) {
      throw error("attachment_range_invalid", "Choose a nonnegative offset and between 1 and 32000 characters.");
    }
    const attachment = await this.#validateRef({ workspaceId, requestedBy, ref });
    if (IMAGE_TYPES.has(attachment.mediaType)) {
      throw error("attachment_text_unavailable", "This image requires a model with image input support.");
    }
    const representations = await this.#representations(attachment.attachmentId, workspaceId);
    const representation = representations.find((item) => item.representationObjectId);
    if (!representation) throw error("attachment_processing_failed", "The attachment has no readable representation.");
    const stored = await this.#objectStore.read({ workspaceId, objectId: representation.representationObjectId, signal });
    if (stored.object.contentHash !== representation.contentHash) {
      throw error("attachment_integrity_failed", "The attachment representation failed integrity validation.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes);
    if (offset > text.length) throw error("attachment_range_invalid", "The offset exceeds the file's text length.");
    const end = Math.min(offset + limit, text.length);
    return { attachmentId: attachment.attachmentId, fileName: attachment.fileName,
      contentHash: attachment.contentHash, text: text.slice(offset, end), offset,
      nextOffset: end < text.length ? end : null, totalCharacters: text.length };
  }

  async resolveMaterialBindings({ workspaceId, requestedBy, bindings, signal }) {
    const resolved = [];
    for (const binding of bindings ?? []) {
      if (binding?.source?.kind === "attachment") {
        const attachment = await this.#validateRef({
          workspaceId,
          requestedBy,
          ref: binding.source.attachment,
        });
        const stored = await this.#objectStore.read({
          workspaceId,
          objectId: attachment.objectId,
          signal,
        });
        validateStoredObject(stored, attachment);
        let contextText;
        if (!IMAGE_TYPES.has(attachment.mediaType)) {
          const representations = await this.#representations(attachment.attachmentId, attachment.workspaceId);
          const representation = representations.find((item) => item.representationObjectId);
          if (!representation) {
            throw error(
              "attachment_processing_failed",
              "The attachment has no readable representation.",
            );
          }
          const derived = await this.#objectStore.read({
            workspaceId,
            objectId: representation.representationObjectId,
            signal,
          });
          if (
            derived.object.state !== "promoted"
            || derived.object.contentHash !== representation.contentHash
          ) {
            throw error(
              "attachment_integrity_failed",
              "The attachment representation failed integrity validation.",
            );
          }
          contextText = new TextDecoder("utf-8", { fatal: true })
            .decode(derived.bytes)
            .slice(0, MAX_CONTEXT_CHARACTERS);
        }
        resolved.push({
          materialKey: binding.materialKey,
          kind: "attachment",
          mediaType: attachment.mediaType,
          contentHash: attachment.contentHash,
          bytes: Buffer.from(stored.bytes),
          ...(contextText ? { contextText } : {}),
          attachment: toRef(attachment),
        });
      } else {
        resolved.push(structuredClone(binding));
      }
    }
    return resolved;
  }

  async expireDue() {
    if (!this.#persistence) await this.#store.connect();
    return this.#expireDue({});
  }

  async #createOperation(input) {
    const objectId = `object-${input.attachmentId}`;
    let object;
    try {
      object = await this.#objectStore.put({
        workspaceId: input.workspaceId,
        objectId,
        bytes: input.bytes,
        contentHash: input.contentHash,
        mediaType: input.mediaType,
        metadata: {
          source: "input-attachment",
          attachmentId: input.attachmentId,
          ownerUserId: input.requestedBy,
        },
        state: "quarantined",
        signal: input.signal,
      });
      const now = timestamp(this.#clock);
      await this.#objectStore.promote({
        workspaceId: input.workspaceId,
        objectId,
      });
      const attachment = {
        schemaVersion: "workbench-v1",
        attachmentId: input.attachmentId,
        version: 1,
        workspaceId: input.workspaceId,
        ownerUserId: input.requestedBy,
        scope: "personal",
        fileName: input.fileName,
        mediaType: input.mediaType,
        sizeBytes: input.bytes.byteLength,
        contentHash: input.contentHash,
        source: "user_upload",
        objectId,
        processing: {
          status: "processing",
          code: null,
          message: "Processing attachment.",
          retryable: false,
        },
        expiresAt: new Date(Date.parse(now) + input.ttlSeconds * 1000).toISOString(),
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await this.#insertAttachment(attachment);
      return this.#processAndPatch({ attachment: inserted, signal: input.signal });
    } catch (failure) {
      if (object?.state === "quarantined" || object?.existed === false) {
        await this.#objectStore.deleteObject({
          workspaceId: input.workspaceId,
          objectId,
        }).catch(() => {});
      }
      throw failure;
    }
  }

  async #processAndPatch({ attachment, signal }) {
    try {
      let representation;
      if (IMAGE_TYPES.has(attachment.mediaType)) {
        representation = {
          kind: "binary_reference",
          text: "",
          evidence: [],
        };
      } else {
        if (!this.#extractionSandbox?.extract) {
          throw error(
            "attachment_processing_unavailable",
            "The attachment extraction sandbox is unavailable.",
          );
        }
        const stored = await this.#objectStore.read({
          workspaceId: attachment.workspaceId,
          objectId: attachment.objectId,
          signal,
        });
        validateStoredObject(stored, attachment);
        representation = await this.#extractionSandbox.extract({
          bytes: stored.bytes,
          mediaType: attachment.mediaType,
          signal,
        });
      }
      const record = await this.#persistRepresentation(attachment, representation, signal);
      const now = timestamp(this.#clock);
      const ready = await this.#patchAttachment({
        workspaceId: attachment.workspaceId,
        attachmentId: attachment.attachmentId,
        patch: {
          processing: {
            status: "ready",
            code: null,
            message: "Attachment is ready.",
            retryable: false,
          },
          updatedAt: now,
        },
      });
      return this.#processingResult(ready, [record]);
    } catch (failure) {
      const code = normalizeProcessingCode(failure?.code);
      const now = timestamp(this.#clock);
      const next = await this.#patchAttachment({
        workspaceId: attachment.workspaceId,
        attachmentId: attachment.attachmentId,
        patch: {
          processing: {
            status: RETRYABLE.has(code) ? "failed" : "blocked",
            code,
            message: safeMessage(failure),
            retryable: RETRYABLE.has(code),
          },
          updatedAt: now,
        },
      });
      return this.#processingResult(next, await this.#representations(attachment.attachmentId, attachment.workspaceId));
    }
  }

  async #persistRepresentation(attachment, representation, signal) {
    const existing = await this.#representations(attachment.attachmentId, attachment.workspaceId);
    if (existing.length > 0) return existing[0];
    const representationId = this.#idFactory("attachment-representation");
    let representationObjectId = null;
    let contentHash = attachment.contentHash;
    let characterCount = 0;
    let byteLength = 0;
    if (representation.kind !== "binary_reference") {
      const bytes = Buffer.from(String(representation.text), "utf8");
      characterCount = String(representation.text).length;
      byteLength = bytes.byteLength;
      contentHash = hash(bytes);
      representationObjectId = `object-${representationId}`;
      await this.#objectStore.put({
        workspaceId: attachment.workspaceId,
        objectId: representationObjectId,
        bytes,
        contentHash,
        mediaType: "text/plain",
        metadata: {
          source: "attachment-derived-representation",
          attachmentId: attachment.attachmentId,
        },
        state: "quarantined",
        signal,
      });
    }
    const record = {
      schemaVersion: "workbench-v1",
      representationId,
      attachmentId: attachment.attachmentId,
      version: attachment.version,
      attachment: toRef(attachment),
      kind: representation.kind,
      contentHash,
      characterCount,
      byteLength,
      evidence: Array.isArray(representation.evidence)
        ? representation.evidence.slice(0, 10_000)
        : [],
      representationObjectId,
      createdAt: timestamp(this.#clock),
    };
    try {
      if (representationObjectId) {
        await this.#objectStore.promote({
          workspaceId: attachment.workspaceId,
          objectId: representationObjectId,
        });
      }
      const inserted = await this.#insertRepresentation(record, attachment.workspaceId);
      return inserted;
    } catch (failure) {
      if (representationObjectId) {
        await this.#objectStore.deleteObject({
          workspaceId: attachment.workspaceId,
          objectId: representationObjectId,
        }).catch(() => {});
      }
      throw failure;
    }
  }

  async #validateRef({ workspaceId, requestedBy, ref }) {
    if (!ref || typeof ref !== "object") {
      throw error("attachment_forbidden", "An attachment reference is required.");
    }
    const attachment = await this.#ownedAttachment({
      workspaceId,
      requestedBy,
      attachmentId: ref.attachmentId,
    });
    if (
      attachment.version !== ref.version ||
      attachment.contentHash !== ref.contentHash ||
      attachment.mediaType !== ref.mediaType
    ) {
      throw error("attachment_integrity_failed", "The attachment reference no longer matches its immutable version.");
    }
    return attachment;
  }

  async #ownedAttachment({
    workspaceId,
    requestedBy,
    attachmentId,
    allowUnavailable = false,
    minimumRole = "viewer",
  }) {
    await this.#authorize(workspaceId, requestedBy, minimumRole);
    const attachment = await this.#getAttachment({ workspaceId, attachmentId });
    if (!attachment || attachment.ownerUserId !== requestedBy) {
      throw error("attachment_forbidden", "This attachment is not available to the current user.");
    }
    const now = Date.parse(timestamp(this.#clock));
    if (!attachment.deletedAt && Date.parse(attachment.expiresAt) <= now) {
      const expiredAt = await this.#expireAttachment(attachment);
      attachment.processing = {
        status: "expired",
        code: "attachment_expired",
        message: "The attachment expired.",
        retryable: false,
      };
      attachment.deletedAt = expiredAt;
      attachment.updatedAt = expiredAt;
    }
    if (!allowUnavailable && attachment.processing?.status !== "ready") {
      throw error(
        attachment.processing?.code ?? "attachment_processing_failed",
        attachment.processing?.message ?? "The attachment is not ready.",
      );
    }
    return attachment;
  }

  async #representations(attachmentId, workspaceId) {
    if (this.#persistence) return this.#persistence.listRepresentations({ workspaceId, attachmentId });
    await this.#store.connect();
    return this.#store.repositories.attachmentRepresentations.collection
      .find({ attachmentId })
      .sort({ createdAt: 1, representationId: 1 })
      .toArray();
  }

  async #expireDue({ workspaceId, ownerUserId } = {}) {
    const now = timestamp(this.#clock);
    if (this.#persistence) {
      let expired = 0;
      const failures = [];
      let cursor = null;
      while (true) {
        const rows = await this.#persistence.listExpiredAttachments({
          workspaceId, ownerUserId, cursor, limit: 1000,
        });
        for (const attachment of rows) {
          try {
            await this.#expireAttachment(attachment);
            expired += 1;
          } catch (failure) {
            failures.push({ attachmentId: attachment.attachmentId, code: typeof failure?.code === "string" ? failure.code : "attachment_delete_failed" });
          }
        }
        if (rows.length < 1000) break;
        const last = rows.at(-1);
        cursor = { expiresAt: last.expiresAt, attachmentId: last.attachmentId };
      }
      return { expired, failed: failures.length, failures };
    }
    const baseFilter = {
      deletedAt: null,
      expiresAt: { $lte: now },
      ...(workspaceId ? { workspaceId } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
    };
    let expired = 0;
    const failures = [];
    let after = null;
    while (true) {
      const filter = after
        ? {
            ...baseFilter,
            $or: [
              { expiresAt: { $gt: after.expiresAt } },
              { expiresAt: after.expiresAt, attachmentId: { $gt: after.attachmentId } },
            ],
          }
        : baseFilter;
      const rows = await this.#store.repositories.attachments.collection
        .find(filter)
        .sort({ expiresAt: 1, attachmentId: 1 })
        .limit(1000)
        .toArray();
      for (const attachment of rows) {
        try {
          await this.#expireAttachment(attachment);
          expired += 1;
        } catch (failure) {
          failures.push({
            attachmentId: attachment.attachmentId,
            code: typeof failure?.code === "string"
              ? failure.code
              : "attachment_delete_failed",
          });
        }
      }
      if (rows.length < 1000) break;
      const last = rows.at(-1);
      after = { expiresAt: last.expiresAt, attachmentId: last.attachmentId };
    }
    return { expired, failed: failures.length, failures };
  }

  async #expireAttachment(attachment) {
    const now = timestamp(this.#clock);
    // A failed physical delete must remain eligible for the next TTL sweep.
    await this.#deleteAttachmentObjects(attachment);
    await this.#patchAttachment({
      workspaceId: attachment.workspaceId,
      attachmentId: attachment.attachmentId,
      patch: {
        processing: {
          status: "expired",
          code: "attachment_expired",
          message: "The attachment expired.",
          retryable: false,
        },
        deletedAt: now,
        updatedAt: now,
      },
    });
    return now;
  }

  async #deleteAttachmentObjects(attachment) {
    const representations = await this.#representations(attachment.attachmentId, attachment.workspaceId);
    await Promise.all([
      this.#objectStore.deleteObject({
        workspaceId: attachment.workspaceId,
        objectId: attachment.objectId,
      }),
      ...representations
        .filter((item) => item.representationObjectId)
        .map((item) => this.#objectStore.deleteObject({
          workspaceId: attachment.workspaceId,
          objectId: item.representationObjectId,
        })),
    ]);
  }

  async #authorize(workspaceId, requestedBy, minimumRole) {
    if (this.#persistence) return this.#persistence.authorizeWorkspace({ workspaceId, userId: requestedBy, minimumRole });
    await this.#store.connect();
    return this.#store.authorizeWorkspace({
      userId: requestedBy,
      workspaceId,
      minimumRole,
    });
  }

  #processingResult(attachment, representations) {
    return {
      attachment: publicAttachment(attachment),
      representations: representations.map((representation) => publicRepresentation(representation, attachment)),
    };
  }

  async #runIdempotentExternalMutation(input, mutation) {
    if (this.#persistence) return this.#persistence.runIdempotentExternalMutation(input, mutation);
    return this.#store.runIdempotentExternalMutation(input, mutation);
  }

  async #getAttachment(input) {
    if (this.#persistence) return this.#persistence.getAttachment(input);
    return this.#store.repositories.attachments.get(input.attachmentId, { workspaceId: input.workspaceId });
  }

  async #insertAttachment(attachment) {
    if (this.#persistence) return this.#persistence.insertAttachment(attachment);
    return this.#store.repositories.attachments.insert(attachment);
  }

  async #patchAttachment(input) {
    if (this.#persistence) return this.#persistence.patchAttachment(input);
    return this.#store.repositories.attachments.patch(input.attachmentId, input.patch, { workspaceId: input.workspaceId });
  }

  async #insertRepresentation(record, workspaceId) {
    if (this.#persistence) return this.#persistence.insertRepresentation({ workspaceId, record });
    return this.#store.repositories.attachmentRepresentations.insert(record);
  }
}

function validateUpload({ fileName, mediaType, bytes, ttlSeconds }) {
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 255) {
    throw error("attachment_file_name_invalid", "A valid attachment name is required.");
  }
  if (![...IMAGE_TYPES, ...TEXT_TYPES, ...DOCUMENT_TYPES].includes(mediaType)) {
    throw error("attachment_format_unsupported", "This attachment format is not supported.");
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) {
    throw error("attachment_too_large", "The attachment exceeds the 16 MB limit.");
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 2_592_000) {
    throw error("attachment_ttl_invalid", "The attachment retention period is invalid.");
  }
}

function assertPersistence(value) {
  const methods = [
    "authorizeWorkspace", "runIdempotentExternalMutation", "getAttachment",
    "listAttachments", "listExpiredAttachments", "insertAttachment",
    "patchAttachment", "listRepresentations", "insertRepresentation",
  ];
  if (methods.some((method) => typeof value?.[method] !== "function")) {
    throw new TypeError("attachment_persistence_required");
  }
}

function pageAttachments(rows, limit) {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(publicAttachment);
  const last = data.at(-1);
  return {
    data,
    page: {
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor({ updatedAt: last.updatedAt, attachmentId: last.attachmentId })
        : null,
    },
  };
}

function validateMediaSignature(mediaType, bytes) {
  const matches = (
    (mediaType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) ||
    (mediaType === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    (mediaType === "application/pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (DOCUMENT_TYPES.has(mediaType) && mediaType !== "application/pdf" && bytes.subarray(0, 2).toString("ascii") === "PK") ||
    TEXT_TYPES.has(mediaType)
  );
  if (!matches) throw error("attachment_mime_mismatch", "The file content does not match its declared media type.");
}

function validateStoredObject(stored, attachment) {
  if (
    stored.object.state !== "promoted" ||
    stored.object.contentHash !== attachment.contentHash ||
    stored.object.sizeBytes !== attachment.sizeBytes ||
    stored.object.mediaType !== attachment.mediaType
  ) {
    throw error("attachment_integrity_failed", "The attachment failed integrity validation.");
  }
}

function publicAttachment(attachment) {
  const value = structuredClone(attachment);
  delete value._id;
  delete value.objectId;
  return value;
}

function publicRepresentation(representation, attachment) {
  return {
    schemaVersion: representation.schemaVersion,
    representationId: representation.representationId,
    attachment: toRef(attachment),
    kind: representation.kind,
    contentHash: representation.contentHash,
    characterCount: representation.characterCount,
    evidence: structuredClone(representation.evidence),
    createdAt: representation.createdAt,
  };
}

function toRef(attachment) {
  return {
    attachmentId: attachment.attachmentId,
    version: attachment.version,
    contentHash: attachment.contentHash,
    mediaType: attachment.mediaType,
  };
}

function normalizeProcessingCode(value) {
  const allowed = new Set([
    "attachment_format_unsupported",
    "attachment_ocr_required",
    "attachment_too_large",
    "attachment_limit_exceeded",
    "attachment_integrity_failed",
    "attachment_mime_mismatch",
    "attachment_macro_forbidden",
    "attachment_path_traversal",
    "attachment_malicious_package",
    "attachment_processing_unavailable",
    "attachment_processing_failed",
  ]);
  return allowed.has(value) ? value : "attachment_processing_failed";
}

function safeMessage(errorValue) {
  const code = normalizeProcessingCode(errorValue?.code);
  const defaults = {
    attachment_ocr_required: "This PDF needs OCR before it can be used.",
    attachment_format_unsupported: "This attachment format is not supported.",
    attachment_too_large: "The attachment is too large to process.",
    attachment_integrity_failed: "The attachment failed its integrity check.",
    attachment_mime_mismatch: "The attachment content does not match its declared media type.",
    attachment_processing_unavailable: "The attachment extraction sandbox is unavailable.",
    attachment_macro_forbidden: "Files containing macros are not allowed.",
    attachment_path_traversal: "The attachment package contains an unsafe path.",
    attachment_malicious_package: "The attachment package is not safe to process.",
    attachment_limit_exceeded: "The attachment exceeds a processing limit.",
    attachment_processing_failed: "Attachment processing failed.",
  };
  return defaults[code];
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function timestamp(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : String(value);
}

function error(code, message) {
  return new ProductStoreError(code, message);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed?.updatedAt !== "string" ||
      typeof parsed?.attachmentId !== "string"
    ) throw new Error("invalid");
    return parsed;
  } catch {
    throw error("cursor_invalid", "The attachment cursor is invalid.");
  }
}
