import { scenarios as canonicalMutationScenarios } from "./scenarios/canonical-mutations.mjs";
import { scenarios as sessionLedgerScenarios } from "./scenarios/session-ledger.mjs";
import { scenarios as executionAuthorityScenarios } from "./scenarios/execution-authority.mjs";
import { scenarios as runnerRecoveryScenarios } from "./scenarios/runner-recovery.mjs";
import { scenarios as memoryLifecycleScenarios } from "./scenarios/memory-lifecycle.mjs";
import { scenarios as backupRestoreScenarios } from "./scenarios/backup-restore.mjs";

export const POSTGRES_CORE_SCENARIO_IDS = Object.freeze([
  "tx.command-target-rollback",
  "idempotency.concurrent-command",
  "etag.canonical-cas",
  "cursor.keyset-and-event-resume",
  "queue.fifo-single-claim",
  "execution.lease-fence-takeover",
  "events.concurrent-total-order",
]);

export const POSTGRES_DURABILITY_SCENARIO_IDS = Object.freeze([
  "runner.sigkill-durable-boundaries",
  "retention.ttl-cleanup",
  "memory.full-text-ranking",
  "memory.physical-delete-tombstone",
  "store.backup-restore",
]);

export const POSTGRES_REGRESSION_SCENARIO_IDS = Object.freeze([
  ...POSTGRES_CORE_SCENARIO_IDS,
  ...POSTGRES_DURABILITY_SCENARIO_IDS,
]);

const declared = [
  ...canonicalMutationScenarios,
  ...sessionLedgerScenarios,
  ...executionAuthorityScenarios,
  ...runnerRecoveryScenarios,
  ...memoryLifecycleScenarios,
  ...backupRestoreScenarios,
];
const byId = new Map();

for (const scenario of declared) {
  if (!scenario || typeof scenario.id !== "string" || typeof scenario.run !== "function") {
    throw new TypeError("postgres_regression_scenario_invalid");
  }
  if (byId.has(scenario.id)) throw new TypeError(`postgres_regression_scenario_duplicate:${scenario.id}`);
  byId.set(scenario.id, Object.freeze(scenario));
}
for (const id of POSTGRES_REGRESSION_SCENARIO_IDS) {
  if (!byId.has(id)) throw new TypeError(`postgres_regression_scenario_missing:${id}`);
}
for (const id of byId.keys()) {
  if (!POSTGRES_REGRESSION_SCENARIO_IDS.includes(id)) {
    throw new TypeError(`postgres_regression_scenario_unknown:${id}`);
  }
}

export const postgresRegressionScenarios = Object.freeze(
  POSTGRES_REGRESSION_SCENARIO_IDS.map((id) => byId.get(id)),
);

export function postgresScenariosForSuite(suite = "full") {
  const ids = suite === "core"
    ? POSTGRES_CORE_SCENARIO_IDS
    : suite === "durability"
      ? POSTGRES_DURABILITY_SCENARIO_IDS
      : suite === "full"
        ? POSTGRES_REGRESSION_SCENARIO_IDS
        : null;
  if (!ids) throw new TypeError(`postgres_regression_suite_unknown:${suite}`);
  return Object.freeze(ids.map((id) => byId.get(id)));
}
