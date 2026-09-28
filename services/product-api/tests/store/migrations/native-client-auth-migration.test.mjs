import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("native client auth migration stores only token hashes and keeps PKCE/device bounds executable in PostgreSQL", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "025_g1_native_client_auth");
  assert.ok(migration);
  const sql = await migration.loadSql();
  for (const table of [
    "native_authorizations",
    "native_client_sessions",
    "native_refresh_tokens",
    "native_access_tokens",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`, "u"));
  }
  assert.match(sql, /authorization_code_hash ~ '\^sha256:\[a-f0-9\]\{64\}\$'/u);
  assert.match(sql, /token_hash ~ '\^sha256:\[a-f0-9\]\{64\}\$'/u);
  assert.match(sql, /length\(device_public_key\) BETWEEN 43 AND 256/u);
  assert.match(sql, /length\(code_challenge\) BETWEEN 43 AND 128/u);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.doesNotMatch(sql, /raw_(?:authorization_)?code|raw_refresh|Mongo|repository fallback/iu);
});
