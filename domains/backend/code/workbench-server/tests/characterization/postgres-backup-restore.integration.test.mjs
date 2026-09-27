import assert from "node:assert/strict";
import test from "node:test";

import { postgresScenariosForSuite } from "./postgres-regression-manifest.mjs";
import { withPostgresScenario } from "./postgres-scenario-factory.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const backupScenario = postgresScenariosForSuite("durability")
  .find(({ id }) => id === "store.backup-restore");

test("PostgreSQL Product backup driver encrypts, authenticates, restores, and reads an isolated _test target", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async () => {
  let identity = null;
  const outcome = await withPostgresScenario({
    scenarioId: backupScenario.id,
    recordRuntimeIdentity(value) { identity = value; },
  }, backupScenario.run);
  assert.equal(outcome.result.status, "passed");
  assert.equal(Object.values(outcome.invariants).every(Boolean), true);
  assert.equal(identity.database, "postgres");
});
