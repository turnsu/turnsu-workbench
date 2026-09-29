import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeviceProductClient,
  createNativeDeviceProductClient,
} from "../dist/devices.js";

const accessToken = "A".repeat(43);
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

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

test("native Device client registers through the shared bearer transport without exposing a browser credential path", async () => {
  let captured;
  const client = createNativeDeviceProductClient({
    baseUrl: "https://workspace.example.test",
    accessToken: () => accessToken,
    fetch: async (url, init) => {
      captured = { url, init };
      return response({ schemaVersion: "workbench-api-v1", data: device, requestId: "request-device-register" }, 201);
    },
  });

  const result = await client.call("registerDevice", {
    headers: { "Idempotency-Key": "device-register-1" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        displayName: "Alice Mac",
        platform: "macos",
        architecture: "arm64",
        appVersion: "0.3.0",
        workerProtocolVersion: "workbench-device-worker-v1",
        capabilityInventory: ["file_read", "notification"],
      },
    },
  });

  assert.equal(captured.url, "https://workspace.example.test/api/workbench/v1/devices");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.headers.get("Authorization"), `Bearer ${accessToken}`);
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), null);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.publicIdentity, device.publicIdentity);
});

test("browser Device client keeps inventory reads in the cookie/CSRF Product transport", async () => {
  let captured;
  const client = createDeviceProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: [device],
        page: { nextCursor: null, hasMore: false },
        requestId: "request-device-list",
      });
    },
  });

  const result = await client.call("listDevices", {});
  assert.equal(captured.url, "/api/workbench/v1/devices");
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(captured.init.headers.get("Authorization"), null);
  assert.deepEqual(result.body.data, [device]);
});
