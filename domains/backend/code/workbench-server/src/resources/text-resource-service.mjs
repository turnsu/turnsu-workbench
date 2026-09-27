import { createHash, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";

const SUPPORTED_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const MAX_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function createTextResourceService(options) {
  return new TextResourceService(options);
}

export class TextResourceService {
  #store;
  #persistence;
  #objectStore;
  #clock;
  #idFactory;

  constructor({ store, persistence = null, objectStore, clock = () => new Date().toISOString(), idFactory = (kind) => `${kind}-${randomUUID()}` } = {}) {
    if (!persistence && (!store?.connect || !store?.authorizeWorkspace || !store?.runIdempotentMutation)) {
      throw new TypeError("text_resource_store_required");
    }
    if (persistence) assertPersistence(persistence);
    if (!objectStore?.put || !objectStore?.promote || !objectStore?.read) {
      throw new TypeError("text_resource_object_store_required");
    }
    this.#store = store;
    this.#persistence = persistence;
    this.#objectStore = objectStore;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  capabilities() {
    return Object.freeze({
      maxBytes: MAX_BYTES,
      mediaTypes: [...SUPPORTED_MEDIA_TYPES].sort(),
    });
  }

  async create({ workspaceId, requestedBy, idempotencyKey, label, mediaType, content }) {
    const prepared = await this.#prepare({ workspaceId, requestedBy, label, mediaType, content });
    try {
      return await this.#runIdempotentMutation({
        scope: "create-text-resource", key: idempotencyKey, workspaceId,
        effectivePrincipalId: requestedBy,
        request: { label: prepared.label, mediaType, contentHash: prepared.contentHash },
      }, async (session) => {
        const resource = this.#resourceRecord({ workspaceId, requestedBy, mediaType, prepared });
        return publicResource(await this.#insertResource(resource, session));
      });
    } catch (failure) {
      if (!prepared.object.existed) {
        await this.#objectStore.deleteQuarantine?.({ workspaceId, objectId: prepared.objectId }).catch(() => {});
      }
      throw failure;
    }
  }

  async createFromAttachment({
    workspaceId,
    requestedBy,
    idempotencyKey,
    label,
    resolvedAttachment,
  }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    if (typeof label !== "string" || !label.trim()) {
      throw error("resource_label_required", "A resource name is required.");
    }
    const source = resolvedAttachment?.attachment;
    const sourceBytes = Buffer.from(resolvedAttachment?.bytes ?? []);
    if (
      !source
      || sourceBytes.byteLength < 1
      || sourceBytes.byteLength > MAX_ATTACHMENT_BYTES
      || source.contentHash !== resolvedAttachment.contentHash
      || source.mediaType !== resolvedAttachment.mediaType
    ) {
      throw error("resource_attachment_invalid", "The attachment cannot be promoted to a workspace material.");
    }
    const derivedText = typeof resolvedAttachment.contextText === "string"
      && resolvedAttachment.contextText.length > 0;
    if (!derivedText && !IMAGE_MEDIA_TYPES.has(source.mediaType)) {
      throw error("resource_attachment_invalid", "The attachment has no governed text representation.");
    }
    const bytes = derivedText
      ? Buffer.from(resolvedAttachment.contextText, "utf8")
      : sourceBytes;
    const mediaType = derivedText ? "text/plain" : source.mediaType;
    const prepared = await this.#prepareBytes({
      workspaceId,
      label,
      mediaType,
      bytes,
      metadata: {
        source: "attachment-resource",
        attachmentId: source.attachmentId,
      },
      maximumBytes: MAX_ATTACHMENT_BYTES,
    });
    try {
      return await this.#runIdempotentMutation({
        scope: `create-attachment-resource:${requestedBy}`,
        key: idempotencyKey,
        workspaceId,
        effectivePrincipalId: requestedBy,
        request: {
          label: prepared.label,
          attachmentId: source.attachmentId,
          attachmentContentHash: source.contentHash,
          resourceContentHash: prepared.contentHash,
        },
      }, async (session) => {
        const resource = this.#resourceRecord({
          workspaceId,
          requestedBy,
          mediaType,
          prepared,
          source: {
            kind: "attachment",
            attachment: structuredClone(source),
            sourceMediaType: source.mediaType,
            derivedText,
          },
        });
        return publicResource(await this.#insertResource(resource, session));
      });
    } catch (failure) {
      if (!prepared.object.existed) {
        await this.#objectStore.deleteQuarantine?.({
          workspaceId,
          objectId: prepared.objectId,
        }).catch(() => {});
      }
      throw failure;
    }
  }

  async createInSession({ workspaceId, requestedBy, session, label, mediaType, content }) {
    if (!session) throw new TypeError("text_resource_session_required");
    const prepared = await this.#prepare({ workspaceId, requestedBy, label, mediaType, content });
    const resource = this.#resourceRecord({ workspaceId, requestedBy, mediaType, prepared });
    return publicResource(await this.#insertResource(resource, session));
  }

  async list({ workspaceId, requestedBy }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    return (await this.#listResources(workspaceId)).map(publicResource);
  }

  async get({ workspaceId, requestedBy, resourceId }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    const resource = await this.#getResource(workspaceId, resourceId);
    if (!resource) throw error("resource_not_found", "This material was not found.");
    return publicResource(resource);
  }

  async readText({ workspaceId, resourceId, version }) {
    const content = await this.readContent({ workspaceId, resourceId, version });
    if (!content.contextText) {
      throw error("resource_text_invalid", "This material does not contain governed text.");
    }
    return content.contextText;
  }

  async readContent({ workspaceId, resourceId, version }) {
    if (!this.#persistence) await this.#store.connect();
    const resource = await this.#getResource(workspaceId, resourceId);
    if (!resource || resource.version !== version || resource.readiness?.status !== "ready") {
      throw error("resource_not_ready", "This material is not ready to use.");
    }
    const stored = await this.#objectStore.read({ workspaceId, objectId: resource.objectId });
    if (stored.object.state !== "promoted" || stored.object.contentHash !== resource.contentHash) {
      throw error("resource_integrity_failed", "This material is no longer available.");
    }
    let contextText = null;
    if (
      resource.mediaType.startsWith("text/")
      || resource.mediaType === "application/json"
      || resource.source?.derivedText === true
    ) {
      try {
        contextText = new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes);
      } catch {
        throw error("resource_text_invalid", "This material could not be read as text.");
      }
    }
    return {
      resource: publicResource(resource),
      bytes: Buffer.from(stored.bytes),
      contextText,
    };
  }

  async #authorize(workspaceId, userId, minimumRole) {
    if (this.#persistence) return this.#persistence.authorizeWorkspace({ workspaceId, userId, minimumRole });
    await this.#store.connect();
    return this.#store.authorizeWorkspace({ userId, workspaceId, minimumRole });
  }

  async #prepare({ workspaceId, requestedBy, label, mediaType, content }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    if (typeof label !== "string" || !label.trim()) throw error("resource_label_required", "A resource name is required.");
    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) throw error("resource_media_type_unsupported", "Only plain text, Markdown, and JSON material can be added.");
    const bytes = Buffer.from(content);
    return this.#prepareBytes({
      workspaceId,
      label,
      mediaType,
      bytes,
      metadata: { source: "text-resource", label: label.trim() },
      maximumBytes: MAX_BYTES,
      requireText: true,
    });
  }

  async #prepareBytes({
    workspaceId,
    label,
    mediaType,
    bytes,
    metadata,
    maximumBytes,
    requireText = false,
  }) {
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
      throw error("resource_size_invalid", "Material size is outside the allowed limit.");
    }
    let text;
    if (requireText || mediaType.startsWith("text/") || mediaType === "application/json") {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw error("resource_text_invalid", "Text material must be valid UTF-8."); }
      if (!text.trim()) throw error("resource_text_empty", "Text material cannot be empty.");
    }
    const contentHash = hash(bytes);
    const objectId = `object-resource-${hash(`${workspaceId}\u0000${contentHash}`).slice(7)}`;
    const normalizedLabel = label.trim();
    const object = await this.#objectStore.put({
      workspaceId, objectId, bytes, contentHash, mediaType,
      metadata, state: "quarantined",
    });
    await this.#objectStore.promote({ workspaceId, objectId });
    return { label: normalizedLabel, contentHash, objectId, object };
  }

  #resourceRecord({ workspaceId, requestedBy, mediaType, prepared, source = { kind: "text_entry" } }) {
    const now = timestamp(this.#clock);
    return {
      schemaVersion: "workbench-v1", resourceId: this.#idFactory("resource"), workspaceId, createdBy: requestedBy,
      version: "1.0.0", label: prepared.label, mediaType, sizeBytes: prepared.object.sizeBytes,
      contentHash: prepared.object.contentHash, objectId: prepared.objectId,
      source, readiness: { status: "ready" }, createdAt: now, updatedAt: now,
    };
  }

  async #runIdempotentMutation(input, mutation) {
    if (this.#persistence) return this.#persistence.runIdempotentMutation(input, mutation);
    return this.#store.runIdempotentMutation(input, mutation);
  }

  async #insertResource(resource, uow = undefined) {
    if (this.#persistence) return this.#persistence.insertResource({ resource, uow });
    return this.#store.repositories.resources.insert(resource, uow ? { session: uow } : {});
  }

  async #listResources(workspaceId) {
    if (this.#persistence) return this.#persistence.listResources({ workspaceId });
    return this.#store.repositories.resources.list({ workspaceId });
  }

  async #getResource(workspaceId, resourceId) {
    if (this.#persistence) return this.#persistence.getResource({ workspaceId, resourceId, version: null });
    return this.#store.repositories.resources.get(resourceId, { workspaceId });
  }
}

function assertPersistence(value) {
  for (const method of ["authorizeWorkspace", "runIdempotentMutation", "insertResource", "listResources", "getResource"]) {
    if (typeof value?.[method] !== "function") throw new TypeError("text_resource_persistence_required");
  }
}

function hash(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function timestamp(clock) { const value = clock(); return value instanceof Date ? value.toISOString() : String(value); }
function error(code, message) { return new ProductStoreError(code, message); }
function publicResource(resource) {
  const value = structuredClone(resource);
  delete value.objectId;
  return value;
}
