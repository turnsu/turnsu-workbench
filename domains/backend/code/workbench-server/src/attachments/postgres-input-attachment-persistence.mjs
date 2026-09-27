import { createHash } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";

const ROLE_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/**
 * PostgreSQL persistence boundary for personal InputAttachments. It owns only
 * attachment identity, metadata, representations, and receipt state; binary
 * bytes continue to live in the governed object store.
 */
export class PostgresInputAttachmentPersistence {
  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function") {
      throw new TypeError("postgres_input_attachment_store_required");
    }
    this.store = store;
    this.clock = clock;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async authorizeWorkspace({ workspaceId, userId, minimumRole }) {
    const row = await this.#transaction(async (query) => (await query(`
      SELECT role, status FROM public.workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
    `, [workspaceId, userId])).rows[0]);
    if (!row || row.status !== "active" || ROLE_RANK[row.role] < ROLE_RANK[minimumRole]) {
      throw new ProductStoreError("attachment_forbidden", "This attachment is not available to the current user.");
    }
    return { workspaceId, userId, role: row.role };
  }

  async runIdempotentExternalMutation({
    scope,
    key,
    request,
    workspaceId,
    effectivePrincipalId,
    recover,
  } = {}, mutation) {
    if (typeof mutation !== "function" || typeof recover !== "function") {
      throw new TypeError("postgres_attachment_idempotency_handlers_required");
    }
    const requestHash = canonicalRequestHash(request);
    const operationId = stableOperationId({ workspaceId, effectivePrincipalId, scope, key });
    const claim = await this.#transaction(async (query) => {
      const inserted = (await query(`
        INSERT INTO public.product_idempotency_receipts (
          workspace_id, effective_principal_id, operation_scope, idempotency_key,
          request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
        ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
        DO NOTHING
        RETURNING request_hash, response, created_at
      `, [workspaceId, effectivePrincipalId, scope, key, requestHash, timestamp(this.clock)])).rows[0];
      if (inserted) return { inserted: true, row: inserted };
      const existing = (await query(`
        SELECT request_hash, response, created_at
          FROM public.product_idempotency_receipts
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
      `, [workspaceId, effectivePrincipalId, scope, key])).rows[0];
      return { inserted: false, row: existing };
    });
    if (!claim.row) throw coded("idempotency_record_incomplete");
    if (claim.row.request_hash !== requestHash) throw coded("idempotency_key_reused");
    if (claim.row.response != null) return structuredClone(claim.row.response);

    const recovered = await recover(operationId);
    if (recovered) return this.#completeReceipt({ workspaceId, effectivePrincipalId, scope, key, response: recovered });
    if (!claim.inserted) {
      throw coded("idempotency_operation_in_progress");
    }
    try {
      const response = await mutation(operationId);
      return this.#completeReceipt({ workspaceId, effectivePrincipalId, scope, key, response });
    } catch (error) {
      await this.#transaction((query) => query(`
        DELETE FROM public.product_idempotency_receipts
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
           AND request_hash = $5 AND response IS NULL
      `, [workspaceId, effectivePrincipalId, scope, key, requestHash])).catch(() => {});
      throw error;
    }
  }

  async getAttachment({ workspaceId, attachmentId }) {
    return this.#transaction(async (query) => attachmentFromRow((await query(`
      SELECT * FROM public.input_attachments
       WHERE workspace_id = $1 AND attachment_id = $2
       ORDER BY attachment_version DESC LIMIT 1
    `, [workspaceId, attachmentId])).rows[0]));
  }

  async listAttachments({ workspaceId, ownerUserId, cursor = null, limit = 51 }) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.input_attachments
       WHERE workspace_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
         AND (
           $3::timestamptz IS NULL
           OR updated_at < $3::timestamptz
           OR (updated_at = $3::timestamptz AND attachment_id < $4)
         )
       ORDER BY updated_at DESC, attachment_id DESC
       LIMIT $5
    `, [workspaceId, ownerUserId, cursor?.updatedAt ?? null, cursor?.attachmentId ?? null, safeLimit(limit)])).rows.map(attachmentFromRow));
  }

  async listExpiredAttachments({ workspaceId = null, ownerUserId = null, cursor = null, limit = 1000 }) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.input_attachments
       WHERE deleted_at IS NULL AND expires_at <= clock_timestamp()
         AND ($1::text IS NULL OR workspace_id = $1)
         AND ($2::text IS NULL OR owner_user_id = $2)
         AND (
           $3::timestamptz IS NULL
           OR expires_at > $3::timestamptz
           OR (expires_at = $3::timestamptz AND attachment_id > $4)
         )
       ORDER BY expires_at ASC, attachment_id ASC
       LIMIT $5
    `, [workspaceId, ownerUserId, cursor?.expiresAt ?? null, cursor?.attachmentId ?? null, safeLimit(limit)])).rows.map(attachmentFromRow));
  }

  async insertAttachment(attachment) {
    return this.#transaction(async (query) => {
      await insertObject(query, {
        workspaceId: attachment.workspaceId,
        objectId: attachment.objectId,
        objectKind: "attachment_source",
        contentHash: attachment.contentHash,
        sizeBytes: attachment.sizeBytes,
        mediaType: attachment.mediaType,
        createdAt: attachment.createdAt,
        payload: { source: "input_attachment", attachmentId: attachment.attachmentId },
      });
      const row = (await query(`
        INSERT INTO public.input_attachments (
          workspace_id, attachment_id, attachment_version, owner_user_id,
          schema_version, scope_kind, file_name, media_type, size_bytes,
          content_hash, object_id, source, processing_status, processing_code,
          processing_message, processing_retryable, expires_at, deleted_at,
          created_at, updated_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, 'personal', $6, $7, $8,
          $9, $10, 'user_upload', $11, $12,
          $13, $14, $15::timestamptz, NULL,
          $16::timestamptz, $17::timestamptz, '{}'::jsonb
        ) RETURNING *
      `, attachmentValues(attachment))).rows[0];
      return attachmentFromRow(row);
    });
  }

  async patchAttachment({ workspaceId, attachmentId, patch }) {
    return this.#transaction(async (query) => attachmentFromRow((await query(`
      UPDATE public.input_attachments
         SET processing_status = $3,
             processing_code = $4,
             processing_message = $5,
             processing_retryable = $6,
             deleted_at = $7::timestamptz,
             row_revision = row_revision + 1,
             updated_at = $8::timestamptz
       WHERE workspace_id = $1 AND attachment_id = $2 AND deleted_at IS NOT DISTINCT FROM $9::timestamptz
       RETURNING *
    `, [
      workspaceId, attachmentId, patch.processing.status, patch.processing.code ?? null,
      patch.processing.message, patch.processing.retryable === true, patch.deletedAt ?? null,
      patch.updatedAt, null,
    ])).rows[0]));
  }

  async listRepresentations({ workspaceId, attachmentId }) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.attachment_derived_representations
       WHERE workspace_id = $1 AND attachment_id = $2
       ORDER BY created_at ASC, representation_id ASC
    `, [workspaceId, attachmentId])).rows.map(representationFromRow));
  }

  async insertRepresentation({ workspaceId, record }) {
    return this.#transaction(async (query) => {
      if (record.representationObjectId) {
        await insertObject(query, {
          workspaceId,
          objectId: record.representationObjectId,
          objectKind: "attachment_representation",
          contentHash: record.contentHash,
          sizeBytes: record.byteLength,
          mediaType: "text/plain",
          createdAt: record.createdAt,
          payload: { source: "attachment_representation", attachmentId: record.attachmentId },
        });
      }
      const row = (await query(`
        INSERT INTO public.attachment_derived_representations (
          workspace_id, representation_id, attachment_id, attachment_version,
          attachment_content_hash, schema_version, representation_kind, content_hash,
          character_count, representation_object_id, representation_object_kind,
          evidence, created_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10::text, CASE WHEN $10::text IS NULL THEN NULL ELSE 'attachment_representation' END,
          $11::jsonb, $12::timestamptz, '{}'::jsonb
        ) RETURNING *
      `, [
        workspaceId, record.representationId, record.attachmentId, record.version,
        record.attachment.contentHash, record.schemaVersion, record.kind, record.contentHash,
        record.characterCount, record.representationObjectId ?? null,
        JSON.stringify(record.evidence ?? []), record.createdAt,
      ])).rows[0];
      return representationFromRow(row);
    });
  }

  async #completeReceipt({ workspaceId, effectivePrincipalId, scope, key, response }) {
    return this.#transaction(async (query) => {
      const row = (await query(`
        UPDATE public.product_idempotency_receipts
           SET response = $5::jsonb, completed_at = $6::timestamptz
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
           AND response IS NULL
         RETURNING response
      `, [workspaceId, effectivePrincipalId, scope, key, JSON.stringify(response), timestamp(this.clock)])).rows[0];
      if (row?.response) return structuredClone(row.response);
      const existing = (await query(`
        SELECT response FROM public.product_idempotency_receipts
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
      `, [workspaceId, effectivePrincipalId, scope, key])).rows[0];
      if (!existing?.response) throw coded("idempotency_record_incomplete");
      return structuredClone(existing.response);
    });
  }

  #transaction(work) {
    return this.store.withTransaction((uow) => work((text, values) => this.sql.query(uow, text, values)));
  }
}

async function insertObject(query, { workspaceId, objectId, objectKind, contentHash, sizeBytes, mediaType, createdAt, payload }) {
  await query(`
    INSERT INTO public.product_objects (
      workspace_id, object_id, schema_version, object_kind, content_hash,
      size_bytes, media_type, storage_backend, storage_key, storage_version,
      state, created_at, payload
    ) VALUES (
      $1, $2::text, 'workbench-v1', $3, $4,
      $5, $6, 'governed_object_store', $2, $4,
      'promoted', $7::timestamptz, $8::jsonb
    ) ON CONFLICT (workspace_id, object_id) DO NOTHING
  `, [workspaceId, objectId, objectKind, contentHash, sizeBytes, mediaType, createdAt, JSON.stringify(payload)]);
}

function attachmentValues(value) {
  return [
    value.workspaceId, value.attachmentId, value.version, value.ownerUserId,
    value.schemaVersion, value.fileName, value.mediaType, value.sizeBytes,
    value.contentHash, value.objectId, value.processing.status, value.processing.code,
    value.processing.message, value.processing.retryable === true, value.expiresAt,
    value.createdAt, value.updatedAt,
  ];
}

function attachmentFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    attachmentId: row.attachment_id,
    version: Number(row.attachment_version),
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    scope: row.scope_kind,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    contentHash: row.content_hash,
    source: row.source,
    objectId: row.object_id,
    processing: {
      status: row.processing_status,
      code: row.processing_code,
      message: row.processing_message,
      retryable: row.processing_retryable === true,
    },
    expiresAt: iso(row.expires_at),
    deletedAt: iso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function representationFromRow(row) {
  return {
    schemaVersion: row.schema_version,
    representationId: row.representation_id,
    attachmentId: row.attachment_id,
    version: Number(row.attachment_version),
    kind: row.representation_kind,
    contentHash: row.content_hash,
    characterCount: Number(row.character_count),
    byteLength: null,
    evidence: structuredClone(row.evidence ?? []),
    representationObjectId: row.representation_object_id ?? null,
    createdAt: iso(row.created_at),
  };
}

function stableOperationId({ workspaceId, effectivePrincipalId, scope, key }) {
  const digest = createHash("sha256")
    .update(`${workspaceId}\u0000${effectivePrincipalId}\u0000${scope}\u0000${key}`)
    .digest("hex");
  return `attachment-${digest}`;
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_attachment_clock_invalid");
  return date.toISOString();
}

function safeLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 50;
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function coded(code) {
  const error = new ProductStoreError(code, code);
  error.code = code;
  return error;
}
