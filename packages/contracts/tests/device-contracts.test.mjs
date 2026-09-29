import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  DeviceResponseSchema,
  WORKBENCH_V1_DEVICE_ENDPOINTS,
} from "../dist/index.js";

const device = {
  schemaVersion: "workbench-v1",
  deviceId: "device-alice-mac",
  workspaceId: "workspace-alpha",
  ownerUserId: "alice",
  displayName: "Alice Mac",
  platform: "macos",
  architecture: "arm64",
  appVersion: "0.3.0",
  workerProtocolVersion: "workbench-device-worker-v1",
  publicIdentity: `sha256:${"a".repeat(64)}`,
  capabilityInventory: ["file_read", "notification"],
  registrationStatus: "active",
  health: "ready",
  lastSeenAt: "2026-08-13T01:00:00.000Z",
  updateRequired: false,
  revision: 1,
  createdAt: "2026-08-13T01:00:00.000Z",
  updatedAt: "2026-08-13T01:00:00.000Z",
  revokedAt: null,
};

test("Device contracts keep native proof private while defining the shared Product API", () => {
  const endpoints = WORKBENCH_V1_DEVICE_ENDPOINTS;
  assert.equal(endpoints.registerDevice.path, "/api/workbench/v1/devices");
  assert.equal(endpoints.registerDevice.successStatus, 201);
  assert.deepEqual(endpoints.registerDevice.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.equal(endpoints.heartbeatDevice.path, "/api/workbench/v1/devices/{deviceId}/heartbeat");
  assert.equal(endpoints.revokeDevice.path, "/api/workbench/v1/devices/{deviceId}/revoke");
  assert.equal(Check(DeviceResponseSchema, {
    schemaVersion: "workbench-api-v1",
    data: device,
    requestId: "request-device",
  }), true);
  assert.equal(Check(DeviceResponseSchema, {
    schemaVersion: "workbench-api-v1",
    data: { ...device, nativeClientSessionId: "must-not-leak" },
    requestId: "request-device",
  }), false);
  assert.equal(Check(endpoints.registerDevice.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      displayName: "Alice Mac",
      platform: "macos",
      architecture: "arm64",
      appVersion: "0.3.0",
      workerProtocolVersion: "workbench-device-worker-v1",
      capabilityInventory: ["file_read", "notification"],
    },
  }), true);
  assert.equal(Check(endpoints.registerDevice.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      displayName: "Alice Mac",
      platform: "macos",
      architecture: "arm64",
      appVersion: "0.3.0",
      workerProtocolVersion: "workbench-device-worker-v1",
      capabilityInventory: ["file_read"],
      devicePublicKey: "must-not-be-client-supplied",
    },
  }), false);
});
