import { createHash } from "node:crypto";

import { ProductStoreError } from "../errors.mjs";
import { canonicalRequestHash } from "../serialization.mjs";

/**
 * Product-owned receipt port for a mutation whose durable effect is committed
 * by a separate semantic owner. It is intentionally narrower than a Store or
 * repository: callers receive only a stable operation id and never a UoW/SQL
 * handle. The recover function is the authoritative replay test.
 */
export class PostgresExternalMutationPort {
  #store;
  #sql;
  #clock;

  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function") {
      throw new TypeError("postgres_external_mutation_port_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async run({ scope, key, request, workspaceId, effectivePrincipalId, recover } = {}, mutation) {
    for (const [value, code] of [
      [scope, "idempotency_scope_required"], [key, "idempotency_key_required"],
      [workspaceId, "workspace_id_required"], [effectivePrincipalId, "principal_id_required"],
    ]) required(value, code);
    if (typeof mutation !== "function" || typeof recover !== "function") {
      throw new TypeError("postgres_external_mutation_handlers_required");
    }
    const requestHash = canonicalRequestHash(request);
    const claim = await this.#transaction(async (query) => {
      const inserted = (await query(`INSERT INTO public.product_idempotency_receipts (
        workspace_id, effective_principal_id, operation_scope, idempotency_key,
        request_hash, response, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
      ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
      DO NOTHING
      RETURNING request_hash, response`,
      [workspaceId, effectivePrincipalId, scope, key, requestHash, iso(this.#clock())])).rows[0];
      if (inserted) return { inserted: true, receipt: inserted };
      const receipt = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts
        WHERE workspace_id = $1 AND effective_principal_id = $2
          AND operation_scope = $3 AND idempotency_key = $4`,
      [workspaceId, effectivePrincipalId, scope, key])).rows[0];
      return { inserted: false, receipt };
    });
    if (!claim.receipt) throw coded("idempotency_record_incomplete");
    if (claim.receipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
    if (claim.receipt.response !== null) return structuredClone(claim.receipt.response);

    const operationId = stableOperationId({ workspaceId, effectivePrincipalId, scope, key });
    const recovered = await recover(operationId);
    if (recovered) return this.#complete({ workspaceId, effectivePrincipalId, scope, key, requestHash, response: recovered });
    if (!claim.inserted) throw coded("idempotency_operation_in_progress");
    try {
      const response = await mutation(operationId);
      return this.#complete({ workspaceId, effectivePrincipalId, scope, key, requestHash, response });
    } catch (error) {
      await this.#transaction((query) => query(`DELETE FROM public.product_idempotency_receipts
        WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3
          AND idempotency_key = $4 AND request_hash = $5 AND response IS NULL`,
      [workspaceId, effectivePrincipalId, scope, key, requestHash])).catch(() => {});
      throw error;
    }
  }

  async #complete({ workspaceId, effectivePrincipalId, scope, key, requestHash, response }) {
    return this.#transaction(async (query) => {
      const row = (await query(`UPDATE public.product_idempotency_receipts
        SET response = $6::jsonb, completed_at = $7::timestamptz
        WHERE workspace_id = $1 AND effective_principal_id = $2
          AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5
          AND response IS NULL
        RETURNING response`,
      [workspaceId, effectivePrincipalId, scope, key, requestHash, JSON.stringify(response), iso(this.#clock())])).rows[0];
      if (row?.response !== undefined) return structuredClone(row.response);
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts
        WHERE workspace_id = $1 AND effective_principal_id = $2
          AND operation_scope = $3 AND idempotency_key = $4`,
      [workspaceId, effectivePrincipalId, scope, key])).rows[0];
      if (!existing || existing.request_hash !== requestHash || existing.response === null) {
        throw coded("idempotency_record_incomplete");
      }
      return structuredClone(existing.response);
    });
  }

  #transaction(work) {
    return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values)));
  }
}

function stableOperationId({ workspaceId, effectivePrincipalId, scope, key }) {
  const digest = createHash("sha256").update(`${workspaceId}\u0000${effectivePrincipalId}\u0000${scope}\u0000${key}`).digest("hex");
  return `operation-${digest.slice(0, 40)}`;
}
function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function coded(code) { return new ProductStoreError(code, code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_external_mutation_clock_invalid"); return date.toISOString(); }
