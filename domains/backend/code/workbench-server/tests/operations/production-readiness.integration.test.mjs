import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { MongoClient } from "mongodb";

import { createJsonLogger } from "../../src/operations/index.mjs";
import { startWorkbenchServer } from "../../src/server.mjs";
import {
  agentExecutionFabricMigration,
  agentProposalsAndActiveBranchesMigration,
  backfillDefaultWorkspaceMigration,
  productMemoryMigration,
  ProductMigrationRunner,
  runnerTerminalTransitionsMigration,
} from "../../src/store/migrations/index.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const enabled = process.env.WORKBENCH_PRODUCTION_READINESS_INTEGRATION === "1";
const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const dbName = process.env.MONGODB_DB ?? "looloomi_production_readiness_test";
const agentImage = process.env.WORKBENCH_AGENT_IMAGE
  ?? "looloomi-agent-worker@sha256:823530d008c582a26dd57bb7efe5b3f181f8702505577875eb427217f59b69a6";
const skillImage = process.env.WORKBENCH_DOCKER_IMAGE
  ?? "python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891";

test("strict local-production readiness and metrics pass against authenticated Mongo, Docker, and controlled Provider", {
  skip: !enabled,
  timeout: 120_000,
}, async (t) => {
  assert.match(dbName, /_test$/);
  const root = await mkdtemp("/private/tmp/looloomi-production-ready-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = await controlledProvider();
  t.after(() => closeHttp(provider.server));

  const migrationClient = new MongoClient(uri);
  await migrationClient.connect();
  t.after(async () => {
    await migrationClient.db(dbName).dropDatabase().catch(() => {});
    await migrationClient.close();
  });
  await migrationClient.db(dbName).dropDatabase();
  const migration = new ProductMigrationRunner({
    db: migrationClient.db(dbName),
    migrations: [
      backfillDefaultWorkspaceMigration,
      runnerTerminalTransitionsMigration,
      agentExecutionFabricMigration,
      productMemoryMigration,
      agentProposalsAndActiveBranchesMigration,
    ],
  });
  await migration.run({
    context: { defaultWorkspaceId: "workspace-local", defaultOwnerId: "user-local" },
  });

  const store = new ProductMongoStore({ uri, dbName, serverSelectionTimeoutMS: 5_000 });
  const logger = createJsonLogger({ stream: { write() {} } });
  const running = await startWorkbenchServer({
    store,
    logger,
    port: 0,
    distDirectory: `${root}/missing-static-is-acceptable-for-ops`,
    env: {
      PATH: process.env.PATH,
      WORKBENCH_LOCAL_PRODUCTION: "1",
      WORKBENCH_AGENT_IMAGE: agentImage,
      WORKBENCH_DOCKER_IMAGE: skillImage,
      WORKBENCH_MODEL_BASE_URL: provider.baseUrl,
      WORKBENCH_MODEL_API_KEY: "controlled-provider-secret",
      WORKBENCH_MODEL: "controlled/model",
      WORKBENCH_OBJECT_STORE_ROOT: `${root}/objects`,
      WORKBENCH_EXECUTION_ROOT: `${root}/executions`,
      WORKBENCH_AGENT_SANDBOX_ROOT: `${root}/agent-sandbox`,
      WORKBENCH_LOG_LEVEL: "info",
    },
  });
  t.after(() => running.close());
  const address = running.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "alive" });
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  const readiness = await ready.json();
  assert.equal(readiness.status, "ready");
  assert.ok(Object.values(readiness.checks).every((status) => status === "ok"));

  const metrics = await (await fetch(`${base}/metrics`)).text();
  for (const name of [
    "workbench_mongo_up 1",
    "workbench_agent_turn_queue_depth",
    "workbench_execution_invocations_total",
    "workbench_execution_attempt_duration_ms_count",
    "workbench_memory_candidates_total",
  ]) assert.ok(metrics.includes(name), name);
  assert.equal(metrics.includes("controlled-provider-secret"), false);
  assert.ok(provider.requests >= 1);
});

async function controlledProvider() {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    if (req.headers.authorization !== "Bearer controlled-provider-secret") {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/v1/models") {
      const body = JSON.stringify({ object: "list", data: [{ id: "controlled/model" }] });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() { return state.requests; },
  };
}

function closeHttp(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
