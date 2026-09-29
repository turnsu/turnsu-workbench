import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("personal scope activation migration keeps later members distinct from the workspace seed", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "009_g4_personal_scope_activation");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /membership_activation/);
  assert.match(sql, /product_scopes_creation_mode/);
  assert.match(sql, /membership\.status = 'active'/);
  assert.match(sql, /personal\.owner_user_id = scope_row\.owner_user_id/);
});
