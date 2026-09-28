import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("review Inbox migration binds a pending personal-scope review to its authorized owner", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "021_g3b_review_inbox_projection");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /'workflow_run_review'/);
  assert.match(sql, /review\.status = 'pending'/);
  assert.match(sql, /run\.status = 'waiting_review'/);
  assert.match(sql, /scope\.owner_user_id = NEW\.recipient_user_id/);
  assert.match(sql, /recipient_grant\.can_approve/);
  assert.doesNotMatch(sql, /Mongo|repository fallback/i);
});
