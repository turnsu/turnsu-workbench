import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import WebSocket from "ws";

import { DeviceWorkerGateway } from "../../src/devices/device-worker-gateway.mjs";
import {
  DEVICE_LOCAL_DETERMINISTIC_CAPABILITY,
  DEVICE_WORKER_PROTOCOL_VERSION,
  DeviceWorkerConnectionRegistry,
} from "../../src/devices/device-worker-connection-registry.mjs";

const binding = Object.freeze({
  deviceId: "device-alice",
  workspaceId: "workspace-alpha",
  ownerUserId: "alice",
  clientSessionId: "native-session-alice",
  capabilityInventory: [DEVICE_LOCAL_DETERMINISTIC_CAPABILITY],
  workerProtocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
});
const loopbackEnabled = process.env.WORKBENCH_LOOPBACK_INTEGRATION === "1";

function startGateway({ authenticate = async () => nativeSession(), resolveBinding = async () => binding } = {}) {
  const registry = new DeviceWorkerConnectionRegistry({ idFactory: (kind) => `${kind}-test` });
  const gateway = new DeviceWorkerGateway({
    authService: { authenticateNativeAccessToken: authenticate },
    deviceLifecycle: { authenticateWorkerConnection: resolveBinding },
    registry,
  });
  const server = http.createServer((_request, response) => response.end("ok"));
  gateway.attach(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        registry,
        server,
        url: `ws://127.0.0.1:${port}/internal/workbench/v1/device-worker?deviceId=device-alice`,
        async close() {
          gateway.close();
          await new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function nativeSession() {
  return {
    userId: "alice",
    activeWorkspaceId: "workspace-alpha",
    clientKind: "desktop",
    clientSessionId: "native-session-alice",
    devicePublicKey: "A".repeat(43),
  };
}

function open(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => reject(Object.assign(new Error(body), { statusCode: response.statusCode })));
    });
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.once("error", reject);
  });
}

test("Device gateway accepts only a native bearer bound to the registered Device, then enables outbound worker readiness", {
  skip: loopbackEnabled ? false : "set WORKBENCH_LOOPBACK_INTEGRATION=1 to bind an ephemeral local-only test port",
}, async (t) => {
  const host = await startGateway();
  t.after(() => host.close());
  const socket = await open(host.url, { headers: { Authorization: `Bearer ${"a".repeat(40)}` } });
  assert.deepEqual(await nextMessage(socket), {
    type: "device.connected",
    protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
    deviceId: "device-alice",
    connectionId: "device-connection-test",
  });
  const acknowledgement = nextMessage(socket);
  socket.send(JSON.stringify({
    type: "device.ready",
    protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
    supportedModes: ["deterministic_skill"],
  }));
  assert.deepEqual(await acknowledgement, {
    type: "device.ready_ack",
    protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
    deviceId: "device-alice",
    connectionId: "device-connection-test",
  });
  assert.deepEqual(await host.registry.probe(), { available: true, supportedModes: ["deterministic_skill"] });
  socket.close();
});

test("Device gateway rejects browser origin, bad native bearer, and a mismatched registered Device before socket acceptance", {
  skip: loopbackEnabled ? false : "set WORKBENCH_LOOPBACK_INTEGRATION=1 to bind an ephemeral local-only test port",
}, async (t) => {
  const host = await startGateway({
    resolveBinding: async () => { throw Object.assign(new Error("not bound"), { code: "device_native_session_required" }); },
  });
  t.after(() => host.close());
  await assert.rejects(
    open(host.url),
    (error) => error?.statusCode === 401 && String(error.message).includes("native_access_token_invalid"),
  );
  await assert.rejects(
    open(host.url, { headers: { Authorization: `Bearer ${"a".repeat(40)}`, Origin: "https://evil.example" } }),
    (error) => error?.statusCode === 403 && String(error.message).includes("origin_forbidden"),
  );
  await assert.rejects(
    open(host.url, { headers: { Authorization: `Bearer ${"a".repeat(40)}` } }),
    (error) => error?.statusCode === 401 && String(error.message).includes("native_access_token_invalid"),
  );
});

test("Device gateway rejects binary and malformed messages instead of treating them as Worker events", {
  skip: loopbackEnabled ? false : "set WORKBENCH_LOOPBACK_INTEGRATION=1 to bind an ephemeral local-only test port",
}, async (t) => {
  const host = await startGateway();
  t.after(() => host.close());
  const socket = await open(host.url, { headers: { Authorization: `Bearer ${"a".repeat(40)}` } });
  await nextMessage(socket);
  const protocolError = nextMessage(socket);
  socket.send(Buffer.from("not-json"));
  assert.deepEqual(await protocolError, { type: "device.protocol_error", code: "device_binary_message_forbidden" });
  await new Promise((resolve) => socket.once("close", resolve));
  assert.deepEqual(await host.registry.probe(), { available: false, supportedModes: ["deterministic_skill"] });
});
