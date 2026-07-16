import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionBroker,
  InMemoryExecutionPersistence,
  LoopbackRemoteWorkerTransport,
  REMOTE_WORKER_TRANSPORT_METHODS,
  RemoteWorkerTransport,
  assertRemoteWorkerTransport,
  createRemoteExecutionBackend,
} from "../../src/execution/index.mjs";

const NOW = "2026-07-16T12:00:00.000Z";
let id = 0;

function request(overrides = {}) {
  const invocationId = overrides.invocationId ?? `remote-invocation-${++id}`;
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId: overrides.attemptId ?? `attempt-${invocationId}`,
    workspaceId: "workspace-alpha",
    controller: { kind: "workflow_run", controllerId: "run-alpha", fence: 5 },
    mode: "deterministic_skill",
    isolation: "remote",
    goal: "Execute one pinned step on a registered remote backend.",
    input: { text: invocationId },
    limits: {
      timeoutMs: 5000,
      maxSteps: 1,
      maxModelRequests: 0,
      maxChildren: 0,
      maxInputBytes: 10000,
      maxOutputBytes: 10000,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: { echo: { type: "string" } },
      required: ["echo"],
      additionalProperties: false,
    },
    evidenceRequirements: [],
    metadata: { executionRef: { capabilityId: "echo" } },
    ...overrides,
  };
}

function createBroker(transport) {
  const persistence = new InMemoryExecutionPersistence();
  let sequence = 0;
  const broker = new ExecutionBroker({
    persistence,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++sequence}`,
  });
  broker.registerBackend({
    mode: "deterministic_skill",
    isolation: "remote",
    backend: createRemoteExecutionBackend({ transport }),
  });
  return { broker, persistence };
}

test("RemoteWorkerTransport requires the complete seven-method boundary", () => {
  assert.deepEqual(REMOTE_WORKER_TRANSPORT_METHODS, [
    "probe", "dispatch", "streamEvents", "checkpoint", "cancel", "resume", "dispose",
  ]);
  assert.throws(() => assertRemoteWorkerTransport({ probe() {} }), /remote_worker_transport_invalid/);
  assert.throws(() => assertRemoteWorkerTransport(new RemoteWorkerTransport()), /remote_worker_transport_invalid/);
  const transport = new LoopbackRemoteWorkerTransport();
  assert.equal(assertRemoteWorkerTransport(transport), transport);
});

test("remote events are reordered and deduplicated before entering the product timeline", async () => {
  const transport = new LoopbackRemoteWorkerTransport({
    scenarioFactory: (input) => ({
      streams: [[
        { eventId: "event-2", sequence: 2, type: "worker.progress", payload: { percent: 50, deviceId: "hidden" } },
        { eventId: "event-1", sequence: 1, type: "worker.started", payload: {}, checkpoint: { phase: "started", deviceName: "hidden" } },
        { eventId: "event-2", sequence: 2, type: "worker.progress", payload: { percent: 50, deviceId: "hidden" } },
        {
          eventId: "event-3",
          sequence: 3,
          type: "execution.result",
          payload: {},
          result: {
            output: { echo: input.input.text, remoteExecutionId: "must-not-leak" },
            summary: "Remote execution completed.",
            evidence: [{ kind: "output", deviceId: "must-not-leak" }],
            usage: { steps: 1, modelRequests: 0, inputBytes: 10, outputBytes: 10 },
            deviceId: "must-not-leak",
          },
        },
      ]],
    }),
  });
  const { broker, persistence } = createBroker(transport);
  const input = request({
    metadata: {
      executionRef: { capabilityId: "echo", taskIntent: "echo", adapterVersion: "1.0.0", executionMode: "deterministic" },
      outerNodeId: "node-echo",
      providerSecret: "must-not-cross",
      hostPath: "/private/source",
    },
  });
  const result = await broker.execute(input);

  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { echo: input.input.text });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  const remoteEvents = persistence.events.get(input.invocationId)
    .filter((event) => event.type === "execution.remote_event");
  assert.deepEqual(remoteEvents.map((event) => event.payload.remoteSequence), [1, 2, 3]);
  assert.equal(JSON.stringify(remoteEvents).includes("hidden"), false);
  assert.deepEqual(transport.calls.dispatch[0].request.metadata, {
    executionRef: input.metadata.executionRef,
    outerNodeId: "node-echo",
  });
  assert.equal(JSON.stringify(transport.calls.dispatch[0]).includes("must-not-cross"), false);
  assert.equal(JSON.stringify(transport.calls.dispatch[0]).includes("/private/source"), false);
  assert.equal(transport.calls.dispose.length, 1);
});

test("a disconnected stream checkpoints and resumes after the last committed sequence", async () => {
  const transport = new LoopbackRemoteWorkerTransport({
    scenarioFactory: (input) => ({
      streams: [
        [
          { eventId: "event-1", sequence: 1, type: "worker.started", payload: {}, checkpoint: { phase: "started" } },
          { disconnect: true },
        ],
        [{
          eventId: "event-2",
          sequence: 2,
          type: "execution.result",
          payload: {},
          result: {
            output: { echo: input.input.text },
            usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
          },
        }],
      ],
    }),
  });
  const { broker, persistence } = createBroker(transport);
  const input = request();
  const result = await broker.execute(input);

  assert.equal(result.status, "completed");
  assert.equal(transport.calls.checkpoint.length, 1);
  assert.equal(transport.calls.resume.length, 1);
  assert.equal(transport.calls.resume[0].afterSequence, 1);
  assert.deepEqual(transport.calls.resume[0].checkpoint, { cursor: 1 });
  assert.deepEqual(transport.calls.streamEvents.map((call) => call.afterSequence), [0, 1]);
  assert.ok(persistence.checkpoints.get(input.invocationId)
    .some((item) => item.state.phase === "remote_recovering" && item.state.remoteSequence === 1));
});

test("Broker cancellation cascades once to the remote execution and fences its result", async () => {
  const transport = new LoopbackRemoteWorkerTransport({
    scenarioFactory: () => ({ streams: [[{ waitForCancel: true }]] }),
  });
  const { broker, persistence } = createBroker(transport);
  const input = request();
  const running = broker.execute(input);
  while (transport.calls.streamEvents.length === 0) await new Promise((resolve) => setImmediate(resolve));

  const cancelled = await broker.cancel(input.invocationId, { reason: "user_cancelled" });
  const result = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(result.status, "cancelled");
  assert.equal(transport.calls.cancel.length, 1);
  assert.equal(transport.calls.dispose.length, 1);
  assert.equal((await persistence.getAttempt(input.attemptId)).fence, 2);
});

test("an explicitly registered but unavailable transport reports unavailable without dispatch", async () => {
  const transport = new LoopbackRemoteWorkerTransport({ available: false });
  const { broker } = createBroker(transport);
  const result = await broker.execute(request());
  assert.equal(result.status, "remote_backend_unavailable");
  assert.equal(transport.calls.dispatch.length, 0);
});
