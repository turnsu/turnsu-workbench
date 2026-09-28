import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Work Item Decision migration binds the decision Thread event to a local-write command", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "014_g5_work_item_decision_records");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /'work_item_decision_record'/);
  assert.match(sql, /target_kind = 'work_item_decision'/);
  assert.match(sql, /command_row\.target_id = NEW\.decision_id/);
  assert.match(sql, /NEW\.entry_kind = 'decision'/);
  assert.match(sql, /work_item_thread_entry/);
  assert.match(sql, /NEW\.entry_kind = 'comment'/);
});
