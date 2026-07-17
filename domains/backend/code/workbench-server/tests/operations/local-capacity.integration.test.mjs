import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionBroker,
  InMemoryExecutionPersistence,
  ProductToolGateway,
  StdioToolGatewayServer,
} from "../../src/execution/index.mjs";
import { AgentContainerSandbox, createAgentContainerBackend } from "../../src/runtime/index.mjs";
import { createWorkbenchServer } from "../../src/server.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const enabled = process.env.WORKBENCH_CAPACITY_INTEGRATION === "1";
const image = process.env.WORKBENCH_AGENT_IMAGE;
const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const database = "looloomi_capacity_test";

test("single-machine budget sustains four sessions, eight isolated workers, and sub-250ms read p95", {
  skip: !enabled,
  timeout: 180_000,
}, async (t) => {
  assert.match(image ?? "", /^(?:[^@]+@)?sha256:[a-f0-9]{64}$/);
  const root = await mkdtemp(join(tmpdir(), "looloomi-capacity-"));
  const persistence = new InMemoryExecutionPersistence();
  let modelCalls = 0;
  let releaseWorkers;
  const allWorkersArrived = new Promise((resolve) => { releaseWorkers = resolve; });
  const gateway = new ProductToolGateway({
    persistence,
    modelExecutor: async () => {
      modelCalls += 1;
      if (modelCalls === 8) releaseWorkers();
      await Promise.race([
        allWorkersArrived,
        new Promise((_, reject) => setTimeout(() => reject(new Error("capacity_worker_barrier_timeout")), 30_000)),
      ]);
      return { text: JSON.stringify({ response: "capacity-ok" }) };
    },
  });
  const sandbox = new AgentContainerSandbox({
    image,
    gatewayServer: new StdioToolGatewayServer({ gateway }),
    tempRoot: join(root, "sandbox"),
  });
  const broker = new ExecutionBroker({
    persistence,
    idFactory: (() => { let sequence = 0; return (kind) => `${kind}-${++sequence}`; })(),
  });
  const backendFailures = new Map();
  const containerBackend = createAgentContainerBackend({ sandbox });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "container",
    backend: {
      async execute(context) {
        try { return await containerBackend.execute(context); }
        catch (error) {
          backendFailures.set(context.request.invocationId, error?.code ?? error?.name ?? "unknown");
          throw error;
        }
      },
    },
  });

  const workerResults = await Promise.all(Array.from({ length: 8 }, (_, index) => broker.execute({
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: `invocation-capacity-${index}`,
    attemptId: `attempt-capacity-${index}`,
    workspaceId: "workspace-capacity",
    controller: { kind: "agent_turn", controllerId: `turn-capacity-${index}`, fence: 1 },
    mode: "bounded_agent",
    isolation: "container",
    goal: "Return the capacity result.",
    input: { session: index % 4 },
    limits: {
      timeoutMs: 60_000, maxSteps: 4, maxModelRequests: 2, maxChildren: 0,
      maxInputBytes: 100_000, maxOutputBytes: 100_000,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
      additionalProperties: false,
    },
    evidenceRequirements: [],
    metadata: { sessionId: `capacity-session-${index % 4}` },
  })));
  assert.equal(modelCalls, 8, JSON.stringify({
    results: workerResults.map((result) => ({ status: result.status, error: result.error })),
    backendFailures: Object.fromEntries(backendFailures),
  }));
  assert(workerResults.every((result) => result.status === "completed"));
  assert.deepEqual(new Set(workerResults.map((result) => result.output.response)), new Set(["capacity-ok"]));
  assert.equal((await sandbox.scavenge()).containersRemoved, 0);

  const store = new ProductMongoStore({ uri, dbName: database });
  await store.connect();
  await store.dropTestDatabase();
  const composed = createWorkbenchServer({
    store,
    bootstrapCatalog: false,
    distDirectory: null,
    gatewayModelExecutor: async () => ({ text: JSON.stringify({ response: "unused" }) }),
    env: {
      ...process.env,
      WORKBENCH_TEST_MODE: "1",
      WECHAT_AGENT_TEST_MODE: "1",
      WECHAT_AGENT_RUNTIME_ROOT: join(root, "agent-runtime"),
      WORKBENCH_AGENT_IMAGE: image,
      PI_OFFLINE: "1",
    },
  });
  t.after(async () => {
    await composed.close();
    await store.dropTestDatabase();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await composed.ready;
  const port = await listen(composed.server);
  const durations = [];
  for (let index = 0; index < 44; index += 1) {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/workbench/v1/workspace`, {
      headers: {
        "X-Workbench-Test-User": `capacity-user-${index % 4}`,
        "X-Workbench-Test-Workspace": `capacity-workspace-${index % 4}`,
      },
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    if (index >= 4) durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 < 250, `local_read_p95_exceeded:${p95.toFixed(2)}`);
  process.stdout.write(`capacity_sessions=4 workers=8 local_read_p95_ms=${p95.toFixed(2)}\n`);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}
