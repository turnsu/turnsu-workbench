import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("public Workflow Run cancellation migration records intent before fenced execution settlement", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => (
    version === "023_g3b_workflow_run_cancellation_command"
  ));
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /request_workflow_run_cancellation/);
  assert.match(sql, /run\.cancellation_requested/);
  assert.match(sql, /run\.cancelled/);
  assert.match(sql, /workflow_run_review_decision_required/);
  assert.match(sql, /workflow_run_cancellation_queue_state_invalid/);
  assert.match(sql, /workflow_run_cancellation_lease_state_invalid/);
  assert.match(sql, /cancellation_command_id::text \|\| ':run\.cancellation_requested'/);
  assert.match(sql, /cancellation_command_id::text \|\| ':run\.cancelled'/);
  assert.doesNotMatch(sql, /Mongo|repository fallback|UPDATE public\.workflow_runs\s+SET status/i);
});
