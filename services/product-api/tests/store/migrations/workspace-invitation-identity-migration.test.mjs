import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("workspace invitation identity migration requires hashes, outbox receipts, and activation lineage", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "010_g4_workspace_invitation_identity");
  assert.ok(migration);
  const sql = await migration.loadSql();
  for (const table of [
    "workspace_invitations",
    "email_outbox",
    "email_delivery_receipts",
    "external_identities",
    "oauth_login_transactions",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`, "u"));
  }
  assert.match(sql, /token_hash ~ '\^sha256:\[a-f0-9\]\{64\}\$'/u);
  assert.match(sql, /membership_activation_lineage_required/u);
  assert.doesNotMatch(sql, /raw_invitation_token|invitation_token text/iu);
});
