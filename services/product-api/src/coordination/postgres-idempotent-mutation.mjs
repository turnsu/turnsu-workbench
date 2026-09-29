import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";

/**
 * Authenticated Product mutation receipt port. Unlike public registration,
 * every receipt is bound to an existing workspace membership, so it can be
 * used by Application operations after authorization has been resolved.
 */
export function createPostgresIdempotentMutationPort({ store, clock = () => new Date() } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function") {
    throw new TypeError("postgres_idempotent_mutation_store_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query: (uow, text, values = []) => execute(uow, { text, values }),
  }));
  return Object.freeze({
    async run({ scope, key, request, workspaceId, effectivePrincipalId, authorize } = {}, mutation) {
      for (const [value, code] of [
        [scope, "idempotency_scope_required"], [key, "idempotency_key_required"],
        [workspaceId, "workspace_id_required"], [effectivePrincipalId, "idempotency_effective_principal_required"],
      ]) {
        if (typeof value !== "string" || !value) throw new ProductStoreError(code, code);
      }
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof mutation !== "function") {
        throw new ProductStoreError("idempotency_request_body_required", "A mutation request is required.");
      }
      const requestHash = canonicalRequestHash(request);
      return store.withTransaction(async (uow) => {
        // Object-level permission must be current even when returning a prior mutation receipt.
        if (authorize) await authorize(uow);
        const createdAt = timestamp(clock());
        const receipt = (await sql.query(uow, `
          INSERT INTO public.product_idempotency_receipts (
            workspace_id, effective_principal_id, operation_scope, idempotency_key,
            request_hash, response, created_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
          ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
          DO UPDATE SET operation_scope = EXCLUDED.operation_scope
          RETURNING request_hash, response
        `, [workspaceId, effectivePrincipalId, scope, key, requestHash, createdAt])).rows[0];
        if (receipt.request_hash !== requestHash) {
          throw new ProductStoreError("idempotency_key_reused", "The idempotency key was already used with a different request body.");
        }
        if (receipt.response !== null) return structuredClone(receipt.response);
        const response = await mutation(uow);
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          throw new ProductStoreError("idempotency_response_invalid", "The mutation response must be an object.");
        }
        await sql.query(uow, `
          UPDATE public.product_idempotency_receipts
             SET response = $5::jsonb, completed_at = $6::timestamptz
           WHERE workspace_id = $1 AND effective_principal_id = $2
             AND operation_scope = $3 AND idempotency_key = $4
        `, [workspaceId, effectivePrincipalId, scope, key, JSON.stringify(response), timestamp(clock())]);
        return structuredClone(response);
      });
    },
  });
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_idempotent_mutation_clock_invalid");
  return date.toISOString();
}
