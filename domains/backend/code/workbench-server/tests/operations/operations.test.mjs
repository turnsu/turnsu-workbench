import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createJsonLogger,
  createOperationsHttpHandler,
  createProductReadiness,
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
  registry.register("postgres", async () => ({ ok: true }));
  registry.register("provider", async () => ({ available: false }), { required: false });
  let report = await registry.check();
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks, [
    { name: "postgres", status: "ok" },
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
    persistenceDriver: "postgres",
    createOperationalReadiness() {
      return { async collectMetrics() { throw new Error("database unavailable with secret Bearer must-not-log"); } };
    },
  };
  const handler = createOperationsHttpHandler({
    readiness: { async check() { return { ready: false, checks: [{ name: "postgres", status: "failed" }] }; } },
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
  assert.deepEqual(JSON.parse(ready.body), { status: "not_ready", checks: { postgres: "failed" } });

  const prometheus = new MockResponse();
  await handler(request("/metrics"), prometheus);
  assert.equal(prometheus.statusCode, 200);
  assert.match(prometheus.body, /workbench_postgres_up 0/);
  assert.equal(prometheus.body.includes("secret"), false);
  assert.equal(fixture.output().includes("must-not-log"), false);
});

test("PostgreSQL readiness and metrics consume the bound operational owner", async () => {
  let probeCalls = 0;
  let migrationCalls = 0;
  let metricCalls = 0;
  const operationalOwner = {
    async probe() { probeCalls += 1; return { ok: true }; },
    async verifyMigrations() { migrationCalls += 1; return { ok: true }; },
    async collectMetrics() {
      metricCalls += 1;
      return {
        runQueued: 2,
        runClaimed: 1,
        turnQueued: 3,
        turnRunning: 4,
        activeLeases: 5,
        oldestActiveLeaseAgeSeconds: 6,
        memoryCandidates: { pending: 7, promoted: 8, rejected: 9 },
        invocations: {
          queued: 1, running: 2, completed: 3, failed: 4, cancelled: 5, blocked: 6,
          partial: 7, timeout: 8, permission_denied: 9, sandbox_unavailable: 10,
          remote_backend_unavailable: 11,
        },
        attemptDurationCount: 12,
        attemptDurationSum: 13,
      };
    },
  };
  const store = {
    persistenceDriver: "postgres",
    createOperationalReadiness() { return operationalOwner; },
    async health() { throw new Error("generic_health_must_not_be_called"); },
    async connect() { throw new Error("generic_connect_must_not_be_called"); },
  };
  const readiness = createProductReadiness({
    store,
    startupState: { ready: true, error: null },
    requireMigrations: true,
  });
  const report = await readiness.check();
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks.slice(0, 3), [
    { name: "startup", status: "ok" },
    { name: "postgres", status: "ok" },
    { name: "migrations", status: "ok" },
  ]);
  assert.equal(probeCalls, 1);
  assert.equal(migrationCalls, 1);

  const metrics = new MetricsRegistry();
  const fixture = loggerFixture();
  const handler = createOperationsHttpHandler({
    readiness,
    metrics,
    store,
    logger: fixture.logger,
  });
  const response = new MockResponse();
  await handler(request("/metrics"), response);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /workbench_postgres_up 1/);
  assert.match(response.body, /workbench_run_queue_depth 2/);
  assert.match(response.body, /workbench_execution_attempt_duration_ms_sum 13/);
  assert.equal(metricCalls, 1);
});
