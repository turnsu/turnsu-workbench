import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";

const ROLE_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/** PostgreSQL owner for immutable Workspace Resource metadata. */
export class PostgresTextResourcePersistence {
  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function") {
      throw new TypeError("postgres_text_resource_store_required");
    }
    this.store = store;
    this.clock = clock;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async authorizeWorkspace({ workspaceId, userId, minimumRole }) {
    const row = await this.#transact(async (query) => (await query(`
      SELECT role, status FROM public.workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
    `, [workspaceId, userId])).rows[0]);
    if (!row || row.status !== "active" || ROLE_RANK[row.role] < ROLE_RANK[minimumRole]) {
      throw new ProductStoreError("resource_forbidden", "This material is not available to the current user.");
    }
    return { workspaceId, userId, role: row.role };
  }

  async runIdempotentMutation({ scope, key, request, workspaceId, effectivePrincipalId } = {}, mutation) {
    if (typeof mutation !== "function") throw new TypeError("postgres_resource_idempotency_mutation_required");
    const requestHash = canonicalRequestHash(request);
    return this.#transact(async (query, uow) => {
      const receipt = (await query(`
        INSERT INTO public.product_idempotency_receipts (
          workspace_id, effective_principal_id, operation_scope, idempotency_key,
          request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
        ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [workspaceId, effectivePrincipalId, scope, key, requestHash, timestamp(this.clock)])).rows[0];
      if (!receipt || receipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
      if (receipt.response != null) return structuredClone(receipt.response);
      const response = await mutation(uow);
      await query(`
        UPDATE public.product_idempotency_receipts
           SET response = $5::jsonb, completed_at = $6::timestamptz
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
      `, [workspaceId, effectivePrincipalId, scope, key, JSON.stringify(response), timestamp(this.clock)]);
      return structuredClone(response);
    });
  }

  async insertResource({ resource, uow = undefined } = {}) {
    return this.#transact(async (query) => {
      await query(`
        INSERT INTO public.product_objects (
          workspace_id, object_id, schema_version, object_kind, content_hash,
          size_bytes, media_type, storage_backend, storage_key, storage_version,
          state, created_at, payload
        ) VALUES (
          $1, $2, 'workbench-v1', 'resource_content', $3,
          $4, $5, 'governed_object_store', $2, $3,
          'promoted', $6::timestamptz, $7::jsonb
        ) ON CONFLICT (workspace_id, object_id) DO NOTHING
      `, [
        resource.workspaceId, resource.objectId, resource.contentHash, resource.sizeBytes,
        resource.mediaType, resource.createdAt,
        JSON.stringify({ source: "workspace_resource", resourceId: resource.resourceId }),
      ]);
      const source = resource.source ?? { kind: "text_entry" };
      const row = (await query(`
        INSERT INTO public.workspace_resources (
          workspace_id, resource_id, resource_version, created_by,
          schema_version, label, media_type, size_bytes, content_hash,
          object_id, source_kind, source_attachment_id, source_attachment_version,
          source_attachment_content_hash, readiness_status, created_at, updated_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, 'ready', $15::timestamptz, $16::timestamptz, $17::jsonb
        ) RETURNING *
      `, [
        resource.workspaceId, resource.resourceId, resource.version, resource.createdBy,
        resource.schemaVersion, resource.label, resource.mediaType, resource.sizeBytes, resource.contentHash,
        resource.objectId, source.kind, source.kind === "attachment" ? source.attachment?.attachmentId ?? null : null,
        source.kind === "attachment" ? source.attachment?.version ?? null : null,
        source.kind === "attachment" ? source.attachment?.contentHash ?? null : null,
        resource.createdAt, resource.updatedAt,
        JSON.stringify({
          sourceMediaType: source.sourceMediaType ?? null,
          derivedText: source.derivedText === true,
        }),
      ])).rows[0];
      return resourceFromRow(row);
    }, uow);
  }

  async listResources({ workspaceId }) {
    return this.#transact(async (query) => (await query(`
      SELECT * FROM public.workspace_resources
       WHERE workspace_id = $1 AND readiness_status = 'ready'
       ORDER BY updated_at DESC, resource_id ASC, resource_version ASC
    `, [workspaceId])).rows.map(resourceFromRow));
  }

  async getResource({ workspaceId, resourceId, version = null }) {
    return this.#transact(async (query) => resourceFromRow((await query(`
      SELECT * FROM public.workspace_resources
       WHERE workspace_id = $1 AND resource_id = $2
         AND ($3::text IS NULL OR resource_version = $3)
       ORDER BY resource_version DESC LIMIT 1
    `, [workspaceId, resourceId, version])).rows[0]));
  }

  #transact(work, uow = undefined) {
    return this.store.withTransaction((unit) => work((text, values) => this.sql.query(unit, text, values), unit), uow ? { uow } : {});
  }
}

function resourceFromRow(row) {
  if (!row) return null;
  const payload = row.payload ?? {};
  const source = row.source_kind === "attachment"
    ? {
      kind: "attachment",
      attachment: {
        attachmentId: row.source_attachment_id,
        version: Number(row.source_attachment_version),
        contentHash: row.source_attachment_content_hash,
        mediaType: payload.sourceMediaType ?? row.media_type,
      },
      sourceMediaType: payload.sourceMediaType ?? row.media_type,
      derivedText: payload.derivedText === true,
    }
    : { kind: "text_entry" };
  return {
    schemaVersion: row.schema_version, resourceId: row.resource_id, workspaceId: row.workspace_id,
    createdBy: row.created_by,
    version: row.resource_version, label: row.label, mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes), contentHash: row.content_hash, objectId: row.object_id,
    source, readiness: { status: row.readiness_status },
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function timestamp(clock) {
  const date = new Date(clock());
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_resource_clock_invalid");
  return date.toISOString();
}
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
