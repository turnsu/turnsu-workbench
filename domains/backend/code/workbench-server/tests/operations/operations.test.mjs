import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createJsonLogger,
  createOperationsHttpHandler,
  createProductReadiness,
  EXPECTED_MIGRATIONS,
  MetricsRegistry,
  ReadinessRegistry,
} from "../../src/operations/index.mjs";

class MockResponse extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.body = ""; }
  writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = headers; }
  end(value = "") { this.body += value; this.emit("finish"); }
}

function request(url, method = "GET") {
  return { url, method, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

function loggerFixture() {
  let output = "";
  const stream = { write(value) { output += value; } };
  return {
    logger: createJsonLogger({ stream, clock: () => "2026-07-17T00:00:00.000Z" }),
    output: () => output,
  };
}

test("metrics are deterministic and JSON logging drops unknown or unsafe fields", () => {
  const metrics = new MetricsRegistry();
  metrics.increment("workbench_requests_total", { status: "200" });
  metrics.observe("workbench_request_duration_ms", { operation: "readyz" }, 12.5);
  assert.match(metrics.renderPrometheus(), /workbench_requests_total\{status="200"\} 1/);
  assert.match(metrics.renderPrometheus(), /workbench_request_duration_ms_sum\{operation="readyz"\} 12\.500000/);

  const fixture = loggerFixture();
  fixture.logger.info("http.request.completed", {
    requestId: "request-safe",
    operation: "getRun",
    statusCode: 200,
    authorization: "Bearer must-not-log",
    code: "unsafe value with spaces",
  });
  const record = JSON.parse(fixture.output());
  assert.equal(record.requestId, "request-safe");
  assert.equal(record.statusCode, 200);
  assert.equal(fixture.output().includes("must-not-log"), false);
  assert.equal(Object.hasOwn(record, "authorization"), false);
  assert.equal(Object.hasOwn(record, "code"), false);
});

test("readiness differentiates required failure from optional capability", async () => {
  const registry = new ReadinessRegistry({ timeoutMs: 100 });
  registry.register("mongo", async () => ({ ok: true }));
  registry.register("provider", async () => ({ available: false }), { required: false });
  let report = await registry.check();
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks, [
    { name: "mongo", status: "ok" },
    { name: "provider", status: "optional" },
  ]);
  registry.register("sandbox", async () => ({ available: false }));
  report = await registry.check();
  assert.equal(report.ready, false);
  assert.deepEqual(report.checks.at(-1), { name: "sandbox", status: "failed" });
});

test("operations endpoints expose only bounded liveness, readiness, and Prometheus data", async () => {
  const metrics = new MetricsRegistry();
  const fixture = loggerFixture();
  const store = {
    async connect() { throw new Error("mongo unavailable with secret Bearer must-not-log"); },
  };
  const handler = createOperationsHttpHandler({
    readiness: { async check() { return { ready: false, checks: [{ name: "mongo", status: "failed" }] }; } },
    metrics,
    store,
    logger: fixture.logger,
    clock: (() => { let now = 0; return () => ++now; })(),
  });

  const health = new MockResponse();
  assert.equal(await handler(request("/healthz"), health), true);
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "alive" });

  const ready = new MockResponse();
  await handler(request("/readyz"), ready);
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(JSON.parse(ready.body), { status: "not_ready", checks: { mongo: "failed" } });

  const prometheus = new MockResponse();
  await handler(request("/metrics"), prometheus);
  assert.equal(prometheus.statusCode, 200);
  assert.match(prometheus.body, /workbench_mongo_up 0/);
  assert.equal(prometheus.body.includes("secret"), false);
  assert.equal(fixture.output().includes("must-not-log"), false);
});

test("production readiness verifies Mongo primary, exact migrations, sandbox, and provider", async () => {
  const rows = EXPECTED_MIGRATIONS.map(({ version, checksum }) => ({ version, checksum, status: "applied" }));
  const db = {
    collection(name) {
      assert.equal(name, "product_schema_migrations");
      return { find() { return { async toArray() { return rows; } }; } };
    },
  };
  const store = {
    async connect() { return db; },
    async health() { return { ok: true, writablePrimary: true }; },
  };
  const readiness = createProductReadiness({
    store,
    startupState: { ready: true, error: null },
    agentSandbox: { async probe() { return { available: true }; } },
    providerProbe: async () => ({ available: true }),
    requireAgent: true,
    requireProvider: true,
    requireMigrations: true,
  });
  const report = await readiness.check();
  assert.equal(report.ready, true);
  assert.ok(report.checks.every((item) => item.status === "ok"));

  rows.pop();
  const missing = await readiness.check();
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.checks.find((item) => item.name === "migrations"), {
    name: "migrations",
    status: "failed",
  });
});
