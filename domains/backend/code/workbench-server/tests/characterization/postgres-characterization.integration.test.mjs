import assert from "node:assert/strict";
import test from "node:test";

import { postgresScenariosForSuite } from "./postgres-regression-manifest.mjs";
import { withPostgresScenario } from "./postgres-scenario-factory.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const scenarios = postgresScenariosForSuite("core");

test("PostgreSQL core semantics pass the permanent regression scenarios", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async () => {
  for (const scenario of scenarios) {
    const outcome = await withPostgresScenario({ scenarioId: scenario.id }, scenario.run);
    assert.equal(outcome.result === "passed" || outcome.result?.status === "passed", true, scenario.id);
    assert.equal(Object.values(outcome.invariants).every(Boolean), true, scenario.id);
  }
});
