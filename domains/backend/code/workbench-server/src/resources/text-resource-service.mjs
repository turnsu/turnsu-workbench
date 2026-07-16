import { createHash, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";

const SUPPORTED_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "application/json"]);
const MAX_BYTES = 1024 * 1024;

export function createTextResourceService(options) {
  return new TextResourceService(options);
}

export class TextResourceService {
  #store;
  #objectStore;
  #clock;
  #idFactory;

  constructor({ store, objectStore, clock = () => new Date().toISOString(), idFactory = (kind) => `${kind}-${randomUUID()}` } = {}) {
    if (!store?.connect || !store?.authorizeWorkspace || !store?.runIdempotentMutation) {
      throw new TypeError("text_resource_store_required");
    }
    if (!objectStore?.put || !objectStore?.promote || !objectStore?.read) {
      throw new TypeError("text_resource_object_store_required");
    }
    this.#store = store;
    this.#objectStore = objectStore;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  async create({ workspaceId, requestedBy, idempotencyKey, label, mediaType, content }) {
    const prepared = await this.#prepare({ workspaceId, requestedBy, label, mediaType, content });
    try {
      return await this.#store.runIdempotentMutation({
        scope: "create-text-resource", key: idempotencyKey, workspaceId,
        request: { label: prepared.label, mediaType, contentHash: prepared.contentHash },
      }, async (session) => {
        const resource = this.#resourceRecord({ workspaceId, mediaType, prepared });
        return publicResource(await this.#store.repositories.resources.insert(resource, { session }));
      });
    } catch (failure) {
      if (!prepared.object.existed) {
        await this.#objectStore.deleteQuarantine?.({ workspaceId, objectId: prepared.objectId }).catch(() => {});
      }
      throw failure;
    }
  }

  async createInSession({ workspaceId, requestedBy, session, label, mediaType, content }) {
    if (!session) throw new TypeError("text_resource_session_required");
    const prepared = await this.#prepare({ workspaceId, requestedBy, label, mediaType, content });
    const resource = this.#resourceRecord({ workspaceId, mediaType, prepared });
    return publicResource(await this.#store.repositories.resources.insert(resource, { session }));
  }

  async list({ workspaceId, requestedBy }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    return (await this.#store.repositories.resources.list({ workspaceId })).map(publicResource);
  }

  async get({ workspaceId, requestedBy, resourceId }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    const resource = await this.#store.repositories.resources.get(resourceId, { workspaceId });
    if (!resource) throw error("resource_not_found", "This material was not found.");
    return publicResource(resource);
  }

  async readText({ workspaceId, resourceId, version }) {
    await this.#store.connect();
    const resource = await this.#store.repositories.resources.get(resourceId, { workspaceId });
    if (!resource || resource.version !== version || resource.readiness?.status !== "ready") {
      throw error("resource_not_ready", "This material is not ready to use.");
    }
    const stored = await this.#objectStore.read({ workspaceId, objectId: resource.objectId });
    if (stored.object.state !== "promoted" || stored.object.contentHash !== resource.contentHash) {
      throw error("resource_integrity_failed", "This material is no longer available.");
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes); } catch { throw error("resource_text_invalid", "This material could not be read as text."); }
  }

  async #authorize(workspaceId, userId, minimumRole) {
    await this.#store.connect();
    return this.#store.authorizeWorkspace({ userId, workspaceId, minimumRole });
  }

  async #prepare({ workspaceId, requestedBy, label, mediaType, content }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    if (typeof label !== "string" || !label.trim()) throw error("resource_label_required", "A resource name is required.");
    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) throw error("resource_media_type_unsupported", "Only plain text, Markdown, and JSON material can be added.");
    const bytes = Buffer.from(content);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw error("resource_size_invalid", "Text material must be between 1 byte and 1 MB.");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw error("resource_text_invalid", "Text material must be valid UTF-8."); }
    if (!text.trim()) throw error("resource_text_empty", "Text material cannot be empty.");
    const contentHash = hash(bytes);
    const objectId = `object-resource-${hash(`${workspaceId}\u0000${contentHash}`).slice(7)}`;
    const normalizedLabel = label.trim();
    const object = await this.#objectStore.put({
      workspaceId, objectId, bytes, contentHash, mediaType,
      metadata: { source: "text-resource", label: normalizedLabel }, state: "quarantined",
    });
    await this.#objectStore.promote({ workspaceId, objectId });
    return { label: normalizedLabel, contentHash, objectId, object };
  }

  #resourceRecord({ workspaceId, mediaType, prepared }) {
    const now = timestamp(this.#clock);
    return {
      schemaVersion: "workbench-v1", resourceId: this.#idFactory("resource"), workspaceId,
      version: "1.0.0", label: prepared.label, mediaType, sizeBytes: prepared.object.sizeBytes,
      contentHash: prepared.object.contentHash, objectId: prepared.objectId,
      readiness: { status: "ready" }, createdAt: now, updatedAt: now,
    };
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
