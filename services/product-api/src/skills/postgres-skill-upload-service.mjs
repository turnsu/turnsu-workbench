import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";
import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";
import {
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  parseSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
} from "./skill-package-format.mjs";

const memberRank = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });
const allowedIngest = new Set(["files", "repository", "resumable"]);
const RESUMABLE_CHUNK_BYTES = 512 * 1024;

/**
 * Product owns upload authority, progress and receipts in PostgreSQL; the
 * injected object store holds immutable chunks and content-addressed packages.
 */
export class PostgresSkillUploadService {
  constructor({ store, objectStore, clock = () => new Date().toISOString(), idFactory } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !objectStore?.put || !objectStore?.promote || !objectStore?.read || typeof idFactory !== "function") {
      throw new TypeError("postgres_skill_upload_dependencies_invalid");
    }
    this.store = store; this.objectStore = objectStore; this.clock = clock; this.idFactory = idFactory;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async createUpload({ workspaceId, requestedBy, idempotencyKey, filename, sizeBytes, mediaType, assetKind = "skill", ingestMethod = "files" } = {}) {
    required(workspaceId, "workspace_id_required"); required(requestedBy, "user_id_required"); required(idempotencyKey, "idempotency_key_required"); required(filename, "upload_filename_required"); required(mediaType, "upload_media_type_required");
    if (assetKind !== "skill") throw coded("upload_asset_kind_invalid");
    if (!allowedIngest.has(ingestMethod)) throw coded("upload_ingest_method_unavailable");
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 12 * 1024 * 1024) throw coded("upload_size_invalid");
    const request = { filename, sizeBytes, mediaType, assetKind, ingestMethod };
    const totalChunks = ingestMethod === "resumable" ? Math.max(1, Math.ceil(sizeBytes / RESUMABLE_CHUNK_BYTES)) : 0;
    const payload = ingestMethod === "resumable" ? { transfer: { receivedChunks: [] } } : {};
    return this.#mutation({ workspaceId, principal: requestedBy, scope: "create-skill-upload", idempotencyKey, request }, async ({ query, now }) => {
      const uploadId = this.idFactory("upload");
      await query(`INSERT INTO public.upload_sessions (
          workspace_id, upload_id, requested_by, schema_version, asset_kind, state,
          file_name, size_bytes, media_type, ingest_method, received_bytes,
          total_chunks, received_chunks, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', 'skill', 'selecting', $4, $5, $6, $7, 0, $9, 0, $8::timestamptz, $8::timestamptz, $10::jsonb)`, [workspaceId, uploadId, requestedBy, filename, sizeBytes, mediaType, ingestMethod, now, totalChunks, JSON.stringify(payload)]);
      return uploadView({ workspace_id: workspaceId, upload_id: uploadId, requested_by: requestedBy, schema_version: "workbench-v1", asset_kind: "skill", state: "selecting", file_name: filename, size_bytes: sizeBytes, media_type: mediaType, ingest_method: ingestMethod, received_bytes: 0, total_chunks: totalChunks, received_chunks: 0, created_at: now, updated_at: now, payload });
    });
  }

  async uploadChunk({ workspaceId, requestedBy, uploadId, idempotencyKey, chunkIndex, content } = {}) {
    uploadArguments({ workspaceId, requestedBy, uploadId, idempotencyKey });
    if (!(content instanceof Uint8Array)) throw coded("upload_chunk_invalid");
    const bytes = Buffer.from(content);
    return this.#mutation({ workspaceId, principal: requestedBy, scope: `upload-skill-chunk:${uploadId}:${chunkIndex}`, idempotencyKey,
      request: { uploadId, chunkIndex, contentHash: hashSkillPackageObject(bytes) } }, async ({ query, now }) => {
      const upload = await ownedUpload(query, { workspaceId, requestedBy, uploadId, lock: true });
      if (upload.state !== "selecting" || upload.ingest_method !== "resumable") throw coded("upload_state_invalid");
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.total_chunks) throw coded("upload_chunk_invalid");
      const expected = Math.min(RESUMABLE_CHUNK_BYTES, Number(upload.size_bytes) - chunkIndex * RESUMABLE_CHUNK_BYTES);
      if (bytes.length !== expected) throw coded("upload_chunk_size_invalid");
      // The row lock serializes progress with completion. A crash after the
      // filesystem write is safe: retry verifies the same immutable bytes.
      const transfer = await this.objectStore.writeUploadChunk({ workspaceId, uploadId, chunkIndex,
        totalChunks: upload.total_chunks, expectedSizeBytes: Number(upload.size_bytes), bytes });
      const payload = { ...upload.payload, transfer: { receivedChunks: transfer.receivedChunkIndexes } };
      const row = (await query(`UPDATE public.upload_sessions SET received_bytes = $4, received_chunks = $5,
          updated_at = $6::timestamptz, payload = $7::jsonb
        WHERE workspace_id = $1 AND upload_id = $2 AND requested_by = $3 RETURNING *`,
      [workspaceId, uploadId, requestedBy, transfer.receivedBytes, transfer.receivedChunkIndexes.length, now, JSON.stringify(payload)])).rows[0];
      return uploadView(row);
    });
  }

  async completeUpload({ workspaceId, requestedBy, uploadId, idempotencyKey } = {}) {
    uploadArguments({ workspaceId, requestedBy, uploadId, idempotencyKey });
    const result = await this.#mutation({ workspaceId, principal: requestedBy, scope: `complete-skill-upload:${uploadId}`, idempotencyKey,
      request: { uploadId } }, async ({ query, now }) => {
      const upload = await ownedUpload(query, { workspaceId, requestedBy, uploadId, lock: true });
      if (upload.ingest_method !== "resumable") throw coded("upload_state_invalid");
      if (upload.state !== "selecting") {
        if (upload.object_id && upload.payload?.inspection) return uploadView(upload);
        throw coded("upload_state_invalid");
      }
      if (upload.received_chunks !== upload.total_chunks || Number(upload.received_bytes) !== Number(upload.size_bytes)) throw coded("upload_incomplete");
      const assembled = await this.objectStore.assembleUpload({ workspaceId, uploadId });
      let files;
      try { files = parseSkillPackage(assembled.bytes); } catch { throw coded("upload_package_invalid"); }
      return this.#recordInspection({ query, now, workspaceId, requestedBy, uploadId, upload, files });
    });
    // Cleanup follows the durable receipt; completion replay never needs chunks.
    await this.objectStore.cleanupUpload?.({ workspaceId, uploadId }).catch(() => {});
    return result;
  }

  async inspectUpload({ workspaceId, requestedBy, uploadId, idempotencyKey, files } = {}) {
    required(workspaceId, "workspace_id_required"); required(requestedBy, "user_id_required"); required(uploadId, "upload_id_required"); required(idempotencyKey, "idempotency_key_required");
    const bytes = formatSkillPackage(files);
    const objectHash = hashSkillPackageObject(bytes);
    const inspection = inspectSkillPackage({ files });
    return this.#mutation({ workspaceId, principal: requestedBy, scope: `inspect-skill-upload:${uploadId}`, idempotencyKey, request: { uploadId, objectHash, packageHash: inspection.contentHash } }, async ({ query, now }) => {
      const upload = await ownedUpload(query, { workspaceId, requestedBy, uploadId, lock: true });
      if (upload.state !== "selecting" || upload.ingest_method === "resumable") throw coded("upload_state_invalid");
      return this.#recordInspection({ query, now, workspaceId, requestedBy, uploadId, upload, files });
    });
  }

  async #recordInspection({ query, now, workspaceId, requestedBy, uploadId, upload, files }) {
    const inspection = inspectSkillPackage({ files });
    const bytes = formatSkillPackage(files);
    const objectHash = hashSkillPackageObject(bytes);
    const objectId = objectIdForSkillPackage(objectHash);
    // Authorization and the upload lock precede writes. Content-addressed
    // bytes may be shared by another upload, so rollback must not delete them.
    const stored = await this.objectStore.put({ workspaceId, objectId, bytes, contentHash: objectHash, mediaType: SKILL_PACKAGE_MEDIA_TYPE, metadata: { source: "skill-upload" }, state: "quarantined" });
    await query(`INSERT INTO public.product_objects (
            workspace_id, object_id, schema_version, object_kind, content_hash, size_bytes,
            media_type, storage_backend, storage_key, storage_version, state, created_at, payload
          ) VALUES ($1, $2, 'workbench-v1', 'skill_package', $3, $4, $5, 'filesystem', $6, 'workbench-object-store-v1', 'quarantined', $7::timestamptz, '{}'::jsonb)
          ON CONFLICT (workspace_id, object_id) DO NOTHING`, [workspaceId, objectId, objectHash, stored.sizeBytes, stored.mediaType, `skill-package:${objectId}`, now]);
    const state = inspection.status === "passed" ? "ready_draft" : inspection.status === "needs_review" ? "needs_decision" : "failed";
    const payload = { ...upload.payload, inspection: inspectionView(inspection) };
    const row = (await query(`UPDATE public.upload_sessions SET state = $4, size_bytes = $5, received_bytes = $5,
            object_id = $6, object_kind = 'skill_package', object_content_hash = $7, package_hash = $8,
            inspection_status = $9, updated_at = $10::timestamptz, payload = $11::jsonb
          WHERE workspace_id = $1 AND upload_id = $2 AND requested_by = $3
          RETURNING *`, [workspaceId, uploadId, requestedBy, state, stored.sizeBytes, objectId, objectHash, inspection.contentHash, inspection.status, now, JSON.stringify(payload)])).rows[0];
    return uploadView(row);
  }

  async promoteUpload({ workspaceId, requestedBy, uploadId, idempotencyKey, permissionAcknowledged = false } = {}) {
    required(workspaceId, "workspace_id_required"); required(requestedBy, "user_id_required"); required(uploadId, "upload_id_required"); required(idempotencyKey, "idempotency_key_required");
    const upload = await this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await member(query, workspaceId, requestedBy);
      return ownedUpload(query, { workspaceId, requestedBy, uploadId, lock: true });
    });
    if (!upload.object_id || !["ready_draft", "needs_decision", "promoted"].includes(upload.state)) throw coded("upload_promotion_blocked");
    if (upload.state === "needs_decision" && permissionAcknowledged !== true) throw coded("skill_permission_acknowledgement_required");
    const object = await this.objectStore.promote({ workspaceId, objectId: upload.object_id });
    return this.#mutation({ workspaceId, principal: requestedBy, scope: `promote-skill-upload:${uploadId}`, idempotencyKey, request: { uploadId, objectHash: object.contentHash, permissionAcknowledged: permissionAcknowledged === true } }, async ({ query, now }) => {
      const current = await ownedUpload(query, { workspaceId, requestedBy, uploadId, lock: true });
      if (current.state === "promoted") return uploadView(current);
      if (!current.object_id || current.object_id !== upload.object_id || current.object_content_hash !== object.contentHash || (current.state === "needs_decision" && permissionAcknowledged !== true)) throw coded("upload_promotion_blocked");
      await query(`UPDATE public.product_objects SET state = 'promoted'
        WHERE workspace_id = $1 AND object_id = $2 AND object_kind = 'skill_package' AND content_hash = $3 AND state IN ('quarantined', 'promoted')`, [workspaceId, object.objectId, object.contentHash]);
      const row = (await query(`UPDATE public.upload_sessions SET state = 'promoted', updated_at = $4::timestamptz
        WHERE workspace_id = $1 AND upload_id = $2 AND requested_by = $3 RETURNING *`, [workspaceId, uploadId, requestedBy, now])).rows[0];
      return uploadView(row);
    });
  }

  async getUpload({ workspaceId, requestedBy, uploadId } = {}) {
    required(workspaceId, "workspace_id_required"); required(requestedBy, "user_id_required"); required(uploadId, "upload_id_required");
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await member(query, workspaceId, requestedBy);
      return uploadView(await ownedUpload(query, { workspaceId, requestedBy, uploadId }));
    });
  }

  async resolvePromotedPackage({ workspaceId, requestedBy, uploadId } = {}) {
    required(workspaceId, "workspace_id_required"); required(requestedBy, "user_id_required"); required(uploadId, "upload_id_required");
    const upload = await this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await member(query, workspaceId, requestedBy);
      return ownedUpload(query, { workspaceId, requestedBy, uploadId });
    });
    if (upload.state !== "promoted" || !upload.object_id || !upload.object_content_hash) throw coded("skill_package_not_promoted");
    const loaded = await this.objectStore.read({ workspaceId, objectId: upload.object_id });
    if (loaded.object.state !== "promoted" || loaded.object.contentHash !== upload.object_content_hash || loaded.object.mediaType !== SKILL_PACKAGE_MEDIA_TYPE) throw coded("skill_package_unavailable");
    return Object.freeze({ uploadId, objectId: loaded.object.objectId, contentHash: loaded.object.contentHash, mediaType: loaded.object.mediaType, sizeBytes: loaded.object.sizeBytes });
  }

  async #mutation({ workspaceId, principal, scope, idempotencyKey, request }, work) {
    const requestHash = canonicalRequestHash(request);
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await member(query, workspaceId, principal);
      // Concurrent retries must wait for the first receipt instead of racing
      // its unique-key insertion. Authorization is checked even on replay.
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([workspaceId, principal, scope, idempotencyKey])]);
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts
        WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, principal, scope, idempotencyKey])).rows[0];
      if (existing) { if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused"); if (!existing.response) throw coded("idempotency_record_incomplete"); return structuredClone(existing.response); }
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, principal, scope, idempotencyKey, requestHash, now]);
      const response = await work({ query, now });
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, principal, scope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }
}

async function member(query, workspaceId, userId) {
  const row = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, userId])).rows[0];
  if (!row || memberRank[row.role] < memberRank.member) throw coded("skill_creation_forbidden");
}
async function ownedUpload(query, { workspaceId, requestedBy, uploadId, lock = false }) {
  const row = (await query(`SELECT * FROM public.upload_sessions WHERE workspace_id = $1 AND upload_id = $2 AND requested_by = $3${lock ? " FOR UPDATE" : ""}`, [workspaceId, uploadId, requestedBy])).rows[0];
  if (!row) throw coded("upload_not_found");
  return row;
}
function inspectionView(inspection) { return { status: inspection.status, contentHash: inspection.contentHash, manifest: structuredClone(inspection.manifest ?? null), inventory: structuredClone(inspection.inventory ?? []), diagnostics: structuredClone(inspection.diagnostics ?? []) }; }
function uploadView(row) {
  const inspection = row.payload?.inspection;
  const resumable = row.ingest_method === "resumable";
  return Object.freeze({ schemaVersion: row.schema_version, uploadId: row.upload_id, assetKind: row.asset_kind, state: row.state,
    filename: row.file_name, sizeBytes: Number(row.size_bytes), mediaType: row.media_type, ingestMethod: row.ingest_method,
    transfer: { chunkSizeBytes: resumable ? RESUMABLE_CHUNK_BYTES : 0, totalChunks: Number(row.total_chunks),
      receivedChunks: structuredClone(row.payload?.transfer?.receivedChunks ?? []), receivedBytes: Number(row.received_bytes),
      complete: resumable ? Number(row.received_chunks) === Number(row.total_chunks) && Number(row.received_bytes) === Number(row.size_bytes)
        : ["ready_draft", "needs_decision", "failed", "promoted"].includes(row.state) },
    findings: structuredClone(inspection?.diagnostics ?? []),
    ...(inspection ? { inspection: { status: inspection.status, manifest: inspection.manifest, inventory: inspection.inventory, diagnostics: structuredClone(inspection.diagnostics ?? []) } } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function uploadArguments({ workspaceId, requestedBy, uploadId, idempotencyKey }) {
  required(workspaceId, "workspace_id_required"); required(requestedBy, "user_id_required");
  required(uploadId, "upload_id_required"); required(idempotencyKey, "idempotency_key_required");
}
function required(value, code) { if (typeof value !== "string" || !value.trim()) throw coded(code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_skill_upload_clock_invalid"); return date.toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
