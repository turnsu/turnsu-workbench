import { ProductStoreError } from "../errors.mjs";

/**
 * Read-only owner for the public, immutable ProductObject metadata contract.
 * Object bytes and storage coordinates remain deliberately outside this view.
 */
export class PostgresProductObjectReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_product_object_read_model_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async getObject({ workspaceId, objectId } = {}) {
    required(workspaceId, "workspace_id_required");
    required(objectId, "object_id_required");
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#sql.query(uow, `SELECT schema_version, object_id, workspace_id,
          content_hash, size_bytes, media_type, created_at
        FROM public.product_objects
        WHERE workspace_id = $1 AND object_id = $2 AND state <> 'deleted'`, [workspaceId, objectId])).rows[0];
      if (!row) throw new ProductStoreError("object_not_found", "The stored object was not found.");
      return Object.freeze({
        schemaVersion: row.schema_version,
        objectId: row.object_id,
        workspaceId: row.workspace_id,
        contentHash: row.content_hash,
        sizeBytes: Number(row.size_bytes),
        mediaType: row.media_type,
        createdAt: iso(row.created_at),
      });
    });
  }
}

function required(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}
