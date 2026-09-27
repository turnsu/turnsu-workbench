import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Device execution lease migration binds the existing Execution authority to one active Desktop connection", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "030_g3_device_execution_leases");
  assert.ok(migration);
  const sql = await migration.loadSql();

  assert.match(sql, /CREATE TABLE public\.device_execution_leases/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, device_id\)[\s\S]*public\.devices/);
  assert.match(sql, /FOREIGN KEY \(invocation_id, attempt_id, capability_lease_id\)[\s\S]*public\.capability_leases/);
  assert.match(sql, /FOREIGN KEY \(capacity_lease_id\)[\s\S]*public\.capacity_leases/);
  assert.match(sql, /UNIQUE \(invocation_id, attempt_id\)/);
  assert.match(sql, /invocation_row\.isolation <> 'remote'/);
  assert.match(sql, /invocation_row\.mode <> 'deterministic_skill'/);
  assert.match(sql, /local_deterministic_skill/);
  assert.match(sql, /device_execution_leases_transition_guard/);
  assert.match(sql, /capability_leases_device_execution_revoke/);
  assert.match(sql, /devices_device_execution_revoke/);
  assert.match(sql, /native_client_sessions_device_execution_revoke/);
  assert.match(sql, /workspace_memberships_device_execution_revoke/);
  assert.doesNotMatch(sql, /Mongo|generic worker endpoint|raw private key/iu);
});
