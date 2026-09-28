import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("review rejection migration uses a completed Workflow Run cancellation command and closes held execution authority", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "022_g3b_review_rejection_command");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /reject_workflow_run_review/);
  assert.match(sql, /run\.cancellation_requested/);
  assert.match(sql, /run\.cancelled/);
  assert.match(sql, /workflow_run_review_effect_outcome_unresolved/);
  assert.match(sql, /capability_leases/);
  assert.match(sql, /capacity_leases/);
  assert.doesNotMatch(sql, /Mongo|repository fallback/i);
});
