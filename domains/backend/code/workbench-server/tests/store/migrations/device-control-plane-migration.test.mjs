import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Device control-plane migration binds a desktop native session, Product command, and immutable lifecycle event", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "029_g3_device_control_plane");
  assert.ok(migration);
  const sql = await migration.loadSql();

  assert.match(sql, /CREATE TABLE public\.devices/);
  assert.match(sql, /CREATE TABLE public\.device_lifecycle_events/);
  assert.match(sql, /CREATE FUNCTION public\.device_capability_inventory_valid/);
  assert.match(sql, /FOREIGN KEY \(native_client_session_id\)[\s\S]*native_client_sessions/);
  assert.match(sql, /session_row\.client_kind <> 'desktop'/);
  assert.match(sql, /expected_fingerprint <> NEW\.public_identity_fingerprint/);
  assert.match(sql, /'device_register', 'device_revoke'/);
  assert.match(sql, /target_kind = 'device'/);
  assert.match(sql, /devices_native_session_binding_guard/);
  assert.match(sql, /NEW\.revision <> OLD\.revision \+ 1/);
  assert.match(sql, /NEW\.device_id, NEW\.workspace_id, NEW\.owner_user_id,[\s\S]*NEW\.native_client_session_id/);
  assert.doesNotMatch(sql, /NEW\.device_id, NEW\.workspace_id, NEW\.owner_user_id,[\s\S]*NEW\.device_id, NEW\.workspace_id, NEW\.owner_user_id/);
  assert.match(sql, /product_commands_device_target_guard/);
  assert.match(sql, /device_lifecycle_events_immutable/);
  assert.doesNotMatch(sql, /Mongo|repository fallback|raw private key|worker endpoint/iu);
});
