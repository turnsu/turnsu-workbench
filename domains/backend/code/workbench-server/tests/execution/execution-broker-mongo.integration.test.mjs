import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionBroker,
  MongoExecutionPersistence,
} from "../../src/execution/index.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DB = process.env.MONGODB_DB ?? "looloomi_execution_atomic_test";

test("Mongo terminal settlement keeps invocation, attempt, and lease atomic during cancellation", { skip: !ENABLED }, async (t) => {
  assert.match(DB, /_test$/);
  const store = new ProductMongoStore({ uri: URI, dbName: DB });
  await store.connect();
  await store.db.dropDatabase();
  await store.close();
  const liveStore = new ProductMongoStore({ uri: URI, dbName: DB });
  t.after(async () => {
    await liveStore.connect();
    await liveStore.db.dropDatabase();
    await liveStore.close();
  });

  const basePersistence = new MongoExecutionPersistence({ store: liveStore });
  let enterSettlement;
  let releaseSettlement;
  const settlementEntered = new Promise((resolve) => { enterSettlement = resolve; });
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve; });
  const persistence = new Proxy(basePersistence, {
    get(target, property) {
      if (property === "completeAttempt") {
        return async (...args) => {
          enterSettlement();
          await settlementGate;
          return target.completeAttempt(...args);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let id = 0;
  const broker = new ExecutionBroker({
    persistence,
    clock: () => "2026-07-17T02:00:00.000Z",
    idFactory: (kind) => `${kind}-${++id}`,
  });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: { ok: true },
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const request = executionRequest();
  const executing = broker.execute(request);
  await settlementEntered;
  const cancelling = broker.cancel(request.invocationId, { reason: "race" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseSettlement();
  const [executionResult, cancellationResult] = await Promise.all([executing, cancelling]);

  const [invocation, attempt, lease] = await Promise.all([
    basePersistence.getInvocation(request.invocationId),
    basePersistence.getAttempt(request.attemptId),
    liveStore.repositories.capabilityLeases.collection.findOne({ invocationId: request.invocationId }),
  ]);
  assert.equal(executionResult.status, "cancelled");
  assert.equal(cancellationResult.status, "cancelled");
  assert.equal(invocation.status, "cancelled");
  assert.equal(attempt.status, "cancelled");
  assert.equal(invocation.result.status, attempt.result.status);
  assert.equal(invocation.executionFence, attempt.fence);
  assert.equal(lease.status, "revoked");
});

function executionRequest() {
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-mongo-race",
    attemptId: "attempt-mongo-race",
    workspaceId: "workspace-alpha",
    controller: { kind: "agent_turn", controllerId: "turn-alpha", fence: 1 },
    mode: "bounded_agent",
    isolation: "process",
    goal: "Exercise atomic settlement.",
    input: {},
    limits: { timeoutMs: 5000, maxSteps: 4, maxModelRequests: 2, maxChildren: 0, maxInputBytes: 1000, maxOutputBytes: 1000 },
    capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
    resultSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    evidenceRequirements: [],
    metadata: {},
  };
}
