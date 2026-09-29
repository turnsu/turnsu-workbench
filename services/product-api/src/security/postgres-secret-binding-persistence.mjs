/**
 * Narrow PostgreSQL read port for SecretBinding ownership and revision state.
 * Secret values never enter this adapter or the Product Store.
 */
export class PostgresSecretBindingPersistence {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_secret_binding_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async getSecretBinding({ workspaceId, secretBindingId, ownerKind, ownerId } = {}) {
    return this.#store.withTransaction(async (uow) => (
      await this.#sql.query(uow, `SELECT workspace_id, owner_kind, payload, secret_source, store_binding_ref,
          store_binding_revision, credential_fingerprint, status, expires_at
        FROM public.secret_bindings
        WHERE workspace_id = $1 AND secret_binding_id = $2
          AND owner_kind = $3 AND owner_id = $4`, [
        workspaceId, secretBindingId, ownerKind, ownerId,
      ])
    ).rows[0] ?? null);
  }
}
