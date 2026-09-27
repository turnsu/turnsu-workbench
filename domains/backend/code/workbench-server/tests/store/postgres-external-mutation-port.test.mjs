import assert from "node:assert/strict";
import test from "node:test";

import { PostgresExternalMutationPort } from "../../src/store/postgres/postgres-external-mutation-port.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const NOW = "2026-08-11T02:00:00.000Z";

test("PostgreSQL external mutation port binds a recovered Product result to one authenticated receipt", async () => {
  const calls = [];
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push({ text, values: config.values });
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) {
            return { rows: [{ request_hash: config.values[4], response: null }] };
          }
          if (text.includes("UPDATE public.product_idempotency_receipts")) {
            return { rows: [{ response: { status: "promoted", candidateId: "candidate-alpha" } }] };
          }
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  const port = new PostgresExternalMutationPort({ store, clock: () => NOW });
  let mutationOperationId = null;
  const result = await port.run({
    scope: "approve-memory-candidate:alice:candidate-alpha", key: "approve-alpha",
    request: { schemaVersion: "workbench-api-v1", data: { reason: "Verified" } },
    workspaceId: "workspace-alpha", effectivePrincipalId: "alice",
    recover: async () => null,
  }, async (operationId) => {
    mutationOperationId = operationId;
    return { status: "promoted", candidateId: "candidate-alpha" };
  });
  assert.deepEqual(result, { status: "promoted", candidateId: "candidate-alpha" });
  assert.match(mutationOperationId, /^operation-[a-f0-9]{40}$/);
  assert.equal(calls.some(({ text }) => text.includes("SELECT request_hash")), false);
});

test("Memory approval uses the injected PostgreSQL receipt port rather than an unavailable legacy Store method", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    externalMutationPort: {
      async run(options, mutation) {
        calls.push(options);
        return mutation("operation-alpha");
      },
    },
    memoryService: {
      async getCandidate() { return { status: "pending" }; },
      async approveCandidate(input) { return { candidateId: input.candidateId, status: "promoted" }; },
    },
  });
  const result = await application.approveMemoryCandidate({
    candidateId: "candidate-alpha", idempotencyKey: "approve-alpha",
    request: { schemaVersion: "workbench-api-v1", data: { reason: "Verified" } },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "owner" },
  });
  assert.deepEqual(result, { candidateId: "candidate-alpha", status: "promoted" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "approve-memory-candidate:alice:candidate-alpha");
});
