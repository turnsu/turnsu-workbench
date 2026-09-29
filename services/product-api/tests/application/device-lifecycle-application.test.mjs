import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const device = {
  schemaVersion: "workbench-v1",
  deviceId: "device-alpha",
  workspaceId: "workspace-alpha",
  ownerUserId: "alice",
  displayName: "Alice Mac",
  platform: "macos",
  architecture: "arm64",
  appVersion: "0.3.0",
  workerProtocolVersion: "workbench-device-worker-v1",
  publicIdentity: `sha256:${"a".repeat(64)}`,
  capabilityInventory: ["file_read"],
  registrationStatus: "active",
  health: "ready",
  lastSeenAt: "2026-08-13T01:00:00.000Z",
  updateRequired: false,
  revision: 1,
  createdAt: "2026-08-13T01:00:00.000Z",
  updatedAt: "2026-08-13T01:00:00.000Z",
  revokedAt: null,
};

test("application exposes Device operations only through authenticated Product and native Desktop contexts", async () => {
  const calls = [];
  const roleChecks = [];
  const lifecycle = {
    async listDevices(input) { calls.push(["list", input]); return [device]; },
    async getDevice(input) { calls.push(["get", input]); return { data: device }; },
    async registerDevice(input) { calls.push(["register", input]); return { data: device }; },
    async heartbeatDevice(input) { calls.push(["heartbeat", input]); return { data: device }; },
    async revokeDevice(input) { calls.push(["revoke", input]); return { data: { ...device, registrationStatus: "revoked", health: "revoked", revision: 2, revokedAt: device.updatedAt } }; },
    async notifyCommittedDeviceRevocation(input) { calls.push(["notify-revoked", input]); return true; },
  };
  const application = createWorkbenchApplication({
    store: {
      async connect() {},
      async authorizeWorkspace(input) { roleChecks.push(input); return { role: input.minimumRole === "admin" ? "admin" : "member" }; },
      async runIdempotentMutation(_options, mutation) { return mutation({ kind: "transaction" }); },
    },
    deviceLifecycle: lifecycle,
  });
  const native = {
    userId: "alice", activeWorkspaceId: "workspace-alpha",
    clientKind: "desktop", clientSessionId: "native-session-alice", devicePublicKey: "A".repeat(43),
  };
  const request = { data: { displayName: "Alice Mac" } };

  assert.deepEqual((await application.listDevices({ auth: native })).data, [device]);
  await application.getDevice({ deviceId: device.deviceId, auth: native });
  await application.registerDevice({ idempotencyKey: "register-device-1", request, auth: native });
  await application.heartbeatDevice({ deviceId: device.deviceId, idempotencyKey: "heartbeat-device-1", request, auth: native });
  await application.revokeDevice({ deviceId: device.deviceId, idempotencyKey: "revoke-device-1", request: { data: {} }, auth: native });
  assert.deepEqual(calls.map(([kind]) => kind), ["list", "get", "register", "heartbeat", "revoke", "notify-revoked"]);
  assert.deepEqual(calls.at(-1)[1], {
    deviceId: device.deviceId,
    workspaceId: "workspace-alpha",
    ownerUserId: "alice",
  });
  assert.ok(roleChecks.some((value) => value.minimumRole === "admin"));

  await assert.rejects(
    application.registerDevice({ idempotencyKey: "browser-register", request, auth: { userId: "alice", activeWorkspaceId: "workspace-alpha" } }),
    (error) => error?.code === "device_native_session_required",
  );
});
