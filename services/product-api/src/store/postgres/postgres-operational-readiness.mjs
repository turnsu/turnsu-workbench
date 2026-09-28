import { createHash } from "node:crypto";

import { POSTGRES_MIGRATIONS } from "./migrations/index.mjs";

const MEMORY_CANDIDATE_STATUSES = Object.freeze(["pending", "promoted", "rejected"]);
const INVOCATION_STATUSES = Object.freeze([
  "queued", "running", "completed", "failed", "cancelled", "blocked", "partial", "timeout",
  "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
]);

// This is deliberately a narrow operations owner.  HTTP and application code
// receive safe health, ledger, and aggregate values, never a PostgreSQL client.
export class PostgresOperationalReadiness {
  #store;
  #adapter;

  constructor({ store } = {}) {
    if (!store || store.persistenceDriver !== "postgres"
      || typeof store.connect !== "function"
      || typeof store.withTransaction !== "function"
      || typeof store.bindAdapter !== "function") {
      throw new TypeError("postgres_operational_readiness_store_required");
    }
    this.#store = store;
    this.#adapter = store.bindAdapter(({ execute }) => Object.freeze({
      async readAppliedMigrations({ uow }) {
        const result = await execute(uow, `
          SELECT version, checksum
            FROM public.product_schema_migrations
           WHERE status = 'applied'
           ORDER BY version ASC
        `);
        return result.rows.map((row) => ({ version: row.version, checksum: row.checksum }));
      },
      async readMetrics({ uow }) {
        const [overview, memoryCandidates, invocations, attemptDurations] = await Promise.all([
          execute(uow, `
            SELECT
              (SELECT COUNT(*) FROM public.workflow_run_jobs WHERE status = 'queued') AS run_queued,
              (SELECT COUNT(*) FROM public.workflow_run_jobs WHERE status = 'claimed') AS run_claimed,
              (SELECT COUNT(*) FROM public.agent_turns WHERE status = 'queued') AS turn_queued,
              (SELECT COUNT(*) FROM public.agent_turns WHERE status = 'running') AS turn_running,
              (SELECT COUNT(*) FROM public.capability_leases WHERE status = 'active') AS active_leases,
              (SELECT EXTRACT(EPOCH FROM GREATEST(
                interval '0 seconds', clock_timestamp() - MIN(issued_at)
              )) FROM public.capability_leases WHERE status = 'active') AS oldest_lease_age_seconds
          `),
          execute(uow, `
            SELECT status, COUNT(*) AS count
              FROM public.memory_candidates
             WHERE status IN ('pending', 'promoted', 'rejected')
             GROUP BY status
          `),
          execute(uow, `
            SELECT status, COUNT(*) AS count
              FROM public.execution_invocations
             WHERE status IN (
               'queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'partial', 'timeout',
               'permission_denied', 'sandbox_unavailable', 'remote_backend_unavailable'
             )
             GROUP BY status
          `),
          execute(uow, `
            SELECT
              COUNT(*) AS count,
              COALESCE(SUM(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000), 0) AS sum
              FROM public.execution_attempts
             WHERE started_at IS NOT NULL
               AND finished_at IS NOT NULL
               AND finished_at >= started_at
          `),
        ]);
        return {
          overview: overview.rows[0] ?? {},
          memoryCandidates: memoryCandidates.rows,
          invocations: invocations.rows,
          attemptDurations: attemptDurations.rows[0] ?? {},
        };
      },
    }));
  }

  async probe() {
    await this.#store.connect();
    return { ok: true };
  }

  async verifyMigrations() {
    try {
      const [expected, applied] = await Promise.all([
        expectedMigrationLedger(),
        this.#store.withTransaction((uow) => this.#adapter.readAppliedMigrations({ uow })),
      ]);
      return { ok: migrationLedgersMatch(expected, applied) };
    } catch {
      return { ok: false };
    }
  }

  async collectMetrics() {
    const result = await this.#store.withTransaction((uow) => this.#adapter.readMetrics({ uow }));
    return Object.freeze({
      runQueued: numeric(result.overview.run_queued),
      runClaimed: numeric(result.overview.run_claimed),
      turnQueued: numeric(result.overview.turn_queued),
      turnRunning: numeric(result.overview.turn_running),
      activeLeases: numeric(result.overview.active_leases),
      oldestActiveLeaseAgeSeconds: numeric(result.overview.oldest_lease_age_seconds),
      memoryCandidates: statusCounts(result.memoryCandidates, MEMORY_CANDIDATE_STATUSES),
      invocations: statusCounts(result.invocations, INVOCATION_STATUSES),
      attemptDurationCount: numeric(result.attemptDurations.count),
      attemptDurationSum: numeric(result.attemptDurations.sum),
    });
  }
}

async function expectedMigrationLedger() {
  const entries = await Promise.all(POSTGRES_MIGRATIONS.map(async (migration) => {
    const sql = migration.sql ?? await migration.loadSql();
    return Object.freeze({
      version: migration.version,
      checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    });
  }));
  return entries.sort((left, right) => left.version.localeCompare(right.version));
}

function migrationLedgersMatch(expected, applied) {
  if (expected.length !== applied.length) return false;
  return expected.every((item, index) => (
    item.version === applied[index]?.version && item.checksum === applied[index]?.checksum
  ));
}

function statusCounts(rows, statuses) {
  const values = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const row of rows) {
    if (Object.hasOwn(values, row?.status)) values[row.status] = numeric(row.count);
  }
  return Object.freeze(values);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
