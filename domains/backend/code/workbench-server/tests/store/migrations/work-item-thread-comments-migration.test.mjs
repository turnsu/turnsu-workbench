import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Work Thread comment migration requires a local-write command and product-safe entry shape", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "013_g5_work_item_thread_comments");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /'work_item_thread_entry'/);
  assert.match(sql, /effect_class = 'write_local'/);
  assert.match(sql, /target_kind = 'work_thread_entry'/);
  assert.match(sql, /entry_kind IN \('handoff', 'decision', 'artifact', 'comment'\)/);
  assert.match(sql, /ADD COLUMN product_command_id/);
  assert.match(sql, /work_thread_entries_command_fk/);
  assert.match(sql, /validate_work_thread_entry_command/);
  assert.doesNotMatch(sql, /ADD COLUMN\s+(?:source_session_id|transcript|raw_transcript|worker_log|provider_payload)/i);
});
