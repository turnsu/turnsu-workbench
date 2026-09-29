import assert from "node:assert/strict";
import test from "node:test";

import { DeviceRemoteWorkerTransport } from "../../src/devices/device-remote-worker-transport.mjs";
import {
  DEVICE_LOCAL_DETERMINISTIC_CAPABILITY,
  DEVICE_WORKER_PROTOCOL_VERSION,
  DeviceWorkerConnectionRegistry,
} from "../../src/devices/device-worker-connection-registry.mjs";
import { createRemoteExecutionBackend } from "../../src/execution/remote-execution-backend.mjs";

let id = 0;

function binding(overrides = {}) {
  return {
    deviceId: "device-alice",
    workspaceId: "workspace-alpha",
    actor: { userId: "alice" },
    ownerUserId: "alice",
    clientSessionId: "native-session-alice",
    capabilityInventory: [DEVICE_LOCAL_DETERMINISTIC_CAPABILITY],
    workerProtocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
    ...overrides,
  };
}

function request(overrides = {}) {
  const invocationId = overrides.invocationId ?? `device-invocation-${++id}`;
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId: `attempt-${invocationId}`,
    workspaceId: "workspace-alpha",
    actor: { userId: "alice" },
    controller: { kind: "workflow_run", controllerId: "run-alpha", fence: 7 },
    mode: "deterministic_skill",
    isolation: "remote",
    goal: "Run the fixed local deterministic capability.",
    input: { echo: invocationId },
    limits: {
      timeoutMs: 5_000, maxSteps: 1, maxModelRequests: 0, maxChildren: 0,
      maxInputBytes: 10_000, maxOutputBytes: 10_000, maxImageCount: 0, maxCostUsdMicros: 0,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false,
      filesystem: "none", externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: { echo: { type: "string" } },
      required: ["echo"],
      additionalProperties: false,
    },
    evidenceRequirements: [],
    metadata: { executionRef: { capabilityId: DEVICE_LOCAL_DETERMINISTIC_CAPABILITY } },
    ...overrides,
  };
}

function lease(input) {
  return {
    capabilityLeaseId: `lease-${input.invocationId}`,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    fence: 7,
    status: "active",
    capabilities: structuredClone(input.capabilities),
    expiresAt: "2026-08-14T00:00:00.000Z",
  };
}

function connect(registry, value = binding()) {
  const sent = [];
  let closed = null;
  const connection = registry.accept({
    binding: value,
    send: (message) => sent.push(message),
    terminate: (reason) => { closed = reason; },
  });
  connection.receive(JSON.stringify({
    type: "device.ready",
    protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
    supportedModes: ["deterministic_skill"],
  }));
  return { connection, sent, closed: () => closed };
}

test("registered Desktop transport selects only the effective principal and never sends selection identity to the Worker", async () => {
  const registry = new DeviceWorkerConnectionRegistry({ idFactory: (kind) => `${kind}-${++id}` });
  const alice = connect(registry);
  const bob = connect(registry, binding({ deviceId: "device-bob", ownerUserId: "bob", clientSessionId: "native-session-bob" }));
  const transport = new DeviceRemoteWorkerTransport({ registry });
  const input = request();

  assert.deepEqual(await transport.probe(), { available: true, supportedModes: ["deterministic_skill"] });
  const dispatched = await transport.dispatch({
    request: input,
    lease: lease(input),
    dispatchContext: { workspaceId: input.workspaceId, ownerUserId: "alice" },
  });
  assert.equal(dispatched.deviceId, "device-alice");
  assert.equal(alice.sent.filter((message) => message.type === "device.dispatch").length, 1);
  assert.equal(bob.sent.filter((message) => message.type === "device.dispatch").length, 0);
  const delivery = alice.sent.find((message) => message.type === "device.dispatch");
  assert.equal(JSON.stringify(delivery).includes("native-session-alice"), false);
  assert.equal(JSON.stringify(delivery).includes('"ownerUserId"'), false);
  assert.equal(delivery.request.actor, undefined);
  assert.equal(delivery.request.metadata.executionRef.capabilityId, DEVICE_LOCAL_DETERMINISTIC_CAPABILITY);
});

test("restricted Desktop transport refuses network, connections, arbitrary capability IDs, and cross-user selection", async () => {
  const registry = new DeviceWorkerConnectionRegistry({ idFactory: (kind) => `${kind}-${++id}` });
  connect(registry);
  const transport = new DeviceRemoteWorkerTransport({ registry });
  const input = request();
  await assert.rejects(
    transport.dispatch({
      request: request({ capabilities: { ...input.capabilities, network: true } }),
      lease: lease(input),
      dispatchContext: { workspaceId: input.workspaceId, ownerUserId: "alice" },
    }),
    (error) => error?.code === "remote_backend_unavailable",
  );
  await assert.rejects(
    transport.dispatch({
      request: request({ metadata: { executionRef: { capabilityId: "arbitrary_shell" } } }),
      lease: lease(input),
      dispatchContext: { workspaceId: input.workspaceId, ownerUserId: "alice" },
    }),
    (error) => error?.code === "remote_backend_unavailable",
  );
  await assert.rejects(
    transport.dispatch({
      request: input,
      lease: lease(input),
      dispatchContext: { workspaceId: input.workspaceId, ownerUserId: "mallory" },
    }),
    (error) => error?.code === "remote_backend_unavailable",
  );
});

test("Device revoke closes the outbound stream and fences late Worker events", async () => {
  const registry = new DeviceWorkerConnectionRegistry({ idFactory: (kind) => `${kind}-${++id}` });
  const worker = connect(registry);
  const transport = new DeviceRemoteWorkerTransport({ registry });
  const input = request();
  const dispatched = await transport.dispatch({
    request: input,
    lease: lease(input),
    dispatchContext: { workspaceId: input.workspaceId, ownerUserId: "alice" },
  });
  const events = transport.streamEvents({ remoteExecutionId: dispatched.remoteExecutionId });
  const pending = events.next();
  assert.equal(registry.disconnectDevice("device-alice", { reason: "device_revoked" }), true);
  await assert.rejects(pending, (error) => error?.code === "remote_transport_disconnected");
  assert.equal(worker.closed(), "device_revoked");
  worker.connection.receive(JSON.stringify({
    type: "device.event",
    remoteExecutionId: dispatched.remoteExecutionId,
    event: { eventId: "late", sequence: 1, type: "execution.result", payload: {}, result: {} },
  }));
  assert.throws(
    () => transport.streamEvents({ remoteExecutionId: dispatched.remoteExecutionId }),
    (error) => error?.code === "remote_backend_unavailable",
  );
});

test("Device messages flow through the existing remote backend validation, not directly into Product persistence", async () => {
  const registry = new DeviceWorkerConnectionRegistry({ idFactory: (kind) => `${kind}-${++id}` });
  const worker = connect(registry);
  const transport = new DeviceRemoteWorkerTransport({ registry });
  const backend = createRemoteExecutionBackend({ transport, maxResumeAttempts: 0 });
  const input = request();
  const emitted = [];
  const running = backend.execute({
    request: input,
    lease: lease(input),
    emit: async (type, payload) => emitted.push({ type, payload }),
    checkpoint: async () => {},
  });
  let delivery;
  while (!delivery) {
    delivery = worker.sent.find((message) => message.type === "device.dispatch");
    if (!delivery) await new Promise((resolve) => setImmediate(resolve));
  }
  worker.connection.receive(JSON.stringify({
    type: "device.event",
    remoteExecutionId: delivery.remoteExecutionId,
    event: { eventId: "device-started", sequence: 1, type: "worker.started", payload: {}, checkpoint: { phase: "started" } },
  }));
  worker.connection.receive(JSON.stringify({
    type: "device.event",
    remoteExecutionId: delivery.remoteExecutionId,
    event: {
      eventId: "device-result", sequence: 2, type: "execution.result", payload: {},
      result: {
        output: { echo: input.input.echo },
        summary: "Desktop deterministic capability completed.",
        evidence: [],
        usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
      },
    },
  }));
  const result = await running;
  assert.deepEqual(result.output, { echo: input.input.echo });
  assert.deepEqual(emitted.map((entry) => entry.type), ["execution.remote_event", "execution.remote_event"]);
});
