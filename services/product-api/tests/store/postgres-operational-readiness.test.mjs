import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PostgresOperationalReadiness } from "../../src/store/postgres/postgres-operational-readiness.mjs";
import { POSTGRES_MIGRATIONS } from "../../src/store/postgres/migrations/index.mjs";

async function migrationRows() {
  return Promise.all(POSTGRES_MIGRATIONS.map(async (migration) => {
    const sql = migration.sql ?? await migration.loadSql();
    return {
      version: migration.version,
      checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    };
  }));
}

function fixture({ ledger } = {}) {
  const calls = [];
  const store = {
    persistenceDriver: "postgres",
    async connect() { calls.push("connect"); return this; },
    async withTransaction(work) { calls.push("transaction"); return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, query) {
          calls.push(query);
          if (query.includes("product_schema_migrations")) return { rows: ledger };
          if (query.includes("workflow_run_jobs")) {
            return { rows: [{
              run_queued: "2", run_claimed: "1", turn_queued: "3", turn_running: "4",
              active_leases: "5", oldest_lease_age_seconds: "6.5",
            }] };
          }
          if (query.includes("memory_candidates")) {
            return { rows: [{ status: "pending", count: "7" }] };
          }
          if (query.includes("execution_invocations")) {
            return { rows: [{ status: "completed", count: "8" }] };
          }
          if (query.includes("execution_attempts")) return { rows: [{ count: "9", sum: "10.5" }] };
          throw new Error("unexpected_operational_query");
        },
      });
    },
  };
  return { store, calls };
}

test("Postgres operational readiness verifies the exact migration ledger and returns bounded metrics", async () => {
  const ledger = await migrationRows();
  const { store, calls } = fixture({ ledger });
  const readiness = new PostgresOperationalReadiness({ store });

  assert.deepEqual(await readiness.probe(), { ok: true });
  assert.deepEqual(await readiness.verifyMigrations(), { ok: true });
  assert.deepEqual(await readiness.collectMetrics(), {
    runQueued: 2,
    runClaimed: 1,
    turnQueued: 3,
    turnRunning: 4,
    activeLeases: 5,
    oldestActiveLeaseAgeSeconds: 6.5,
    memoryCandidates: { pending: 7, promoted: 0, rejected: 0 },
    invocations: {
      queued: 0, running: 0, completed: 8, failed: 0, cancelled: 0, blocked: 0,
      partial: 0, timeout: 0, permission_denied: 0, sandbox_unavailable: 0,
      remote_backend_unavailable: 0,
    },
    attemptDurationCount: 9,
    attemptDurationSum: 10.5,
  });
  assert.ok(calls.includes("connect"));
  assert.ok(calls.some((query) => typeof query === "string" && query.includes("clock_timestamp()")));
});

test("Postgres operational readiness fails closed for an incomplete migration ledger", async () => {
  const ledger = await migrationRows();
  const { store } = fixture({ ledger: ledger.slice(0, -1) });
  const readiness = new PostgresOperationalReadiness({ store });
  assert.deepEqual(await readiness.verifyMigrations(), { ok: false });
});
