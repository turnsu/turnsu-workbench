import assert from "node:assert/strict";
import test from "node:test";

import { postgresScenariosForSuite } from "./postgres-regression-manifest.mjs";
import { withPostgresScenario } from "./postgres-scenario-factory.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const scenario = postgresScenariosForSuite("durability")
  .find(({ id }) => id === "runner.sigkill-durable-boundaries");

test("PostgreSQL Runner survives real SIGKILL at each durable boundary", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
  timeout: 120_000,
}, async () => {
  assert.ok(scenario);
  const outcome = await withPostgresScenario({
    scenarioId: scenario.id,
    recordRuntimeIdentity() {},
  }, scenario.run);
  assert.equal(outcome.result.status, "passed");
  assert.equal(Object.values(outcome.invariants).every(Boolean), true);
});
