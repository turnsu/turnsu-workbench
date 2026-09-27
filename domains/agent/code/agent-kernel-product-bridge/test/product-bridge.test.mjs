import assert from "node:assert/strict";
import test from "node:test";

import {
  KERNEL_EVENT_SCHEMA_VERSION,
  MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
  createExecutionGrant,
  createMinimalAgentKernel,
} from "../../agent-kernel/src/index.mjs";
import { MemorySessionPort, createScriptedAgentLoop } from "../../agent-kernel-testkit/src/index.mjs";
import {
  ProductKernelEventObserver,
  createProductKernelProfile,
  createProductToolPipeline,
  createProductSessionPort,
} from "../src/index.mjs";

test("ProductSessionPort persists and replays only model-visible events through its injected Product ledger", async () => {
  const calls = [];
  const events = [];
  const session = { sessionId: "product-session", branchId: "product-branch" };
  const port = createProductSessionPort({
    session,
    ledger: {
      async appendModelVisibleEvent({ session: received, event }) {
        calls.push({ session: received, event });
        events.push(structuredClone(event));
        return { cursor: events.length, eventId: event.eventId };
      },
      async *replayModelVisibleEvents() {
        for (const event of events) yield structuredClone(event);
      },
      async checkpointModelVisibleEvents() { return { cursor: events.length }; },
    },
  });
  const event = modelEvent({ session, eventId: "product-event-one" });

  assert.deepEqual(await port.append(event), { cursor: 1, eventId: "product-event-one" });
  assert.equal(calls.length, 1);
  assert.deepEqual(await collect(port.replay(session)), [event]);
  assert.deepEqual(await port.checkpoint(session), { cursor: 1 });

  await assert.rejects(
    () => port.append(modelEvent({ session: { sessionId: "other-session", branchId: "product-branch" }, eventId: "wrong-session" })),
    (error) => error?.code === "product_session_scope_mismatch",
  );
});

test("ProductKernelEventObserver records safe telemetry metadata and Artifact references without a second transcript", async () => {
  const telemetry = [];
  const artifacts = [];
  const observer = new ProductKernelEventObserver({
    telemetry: { async record(event) { telemetry.push(event); } },
    artifacts: { async recordReferences(event) { artifacts.push(event); } },
  });
  const route = await observer.observe({
    schemaVersion: KERNEL_EVENT_SCHEMA_VERSION,
    eventId: "kernel-event-artifact",
    runId: "kernel-run-artifact",
    session: { sessionId: "product-session", branchId: null },
    sequence: 3,
    type: "artifact.available",
    modelVisible: true,
    payload: { artifactRefs: [{ artifactId: "artifact-one" }], privateTranscript: "never-in-telemetry" },
    occurredAt: "2026-08-14T00:00:00.000Z",
  });

  assert.deepEqual(route.destinations, ["session_ledger", "telemetry", "artifact"]);
  assert.equal(telemetry.length, 1);
  assert.equal(JSON.stringify(telemetry[0]).includes("privateTranscript"), false);
  assert.deepEqual(artifacts, [{
    event: telemetry[0],
    artifactRefs: [{ artifactId: "artifact-one" }],
  }]);
});

test("Product Tool Pipeline binds every allowed call to the active Product Gateway lease", async (t) => {
  const calls = [];
  const pipeline = createProductToolPipeline({
    binding: { invocationId: "invocation-1", attemptId: "attempt-1", capabilityLeaseId: "lease-1" },
    toolPolicy: {
      async resolve() {
        calls.push("policy");
        return {
          toolId: "notes.read",
          effectClass: "read",
          gatewayToolId: "product.notes.read",
          connectionId: "connection-1",
          requiresApproval: true,
        };
      },
    },
    systemSecurity: {
      async check() { calls.push("guard"); return { status: "allowed" }; },
    },
    approvals: {
      async request() { calls.push("approval"); return { status: "approved" }; },
    },
    gateway: {
      async handle(message, binding) {
        calls.push({ message, binding });
        return { result: "from-product-gateway" };
      },
    },
    now: () => "2026-08-14T00:00:00.000Z",
  });
  const sessions = new MemorySessionPort();
  const kernelSession = { sessionId: "pipeline-session", branchId: null };
  const loop = createScriptedAgentLoop({
    onRun: async function* (input) {
      const result = await input.tools.execute({
        toolId: "notes.read",
        effectClass: "read",
        input: { query: "safe" },
      });
      yield { type: "structured.output", modelVisible: true, payload: result };
    },
  });
  const kernel = createMinimalAgentKernel({
    loop,
    sessionPort: sessions,
    toolPipeline: pipeline,
  });
  t.after(() => kernel.dispose());
  const result = await collect(kernel.run({
    runId: "pipeline-run",
    session: kernelSession,
    executionGrant: createExecutionGrant({
      grantId: "pipeline-grant",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["notes.read"],
      allowedEffectClasses: ["read"],
      maxToolCalls: 1,
    }),
    input: { message: "read notes" },
  }));

  assert.deepEqual(result.map((event) => event.type), ["tool.requested", "tool.result", "structured.output", "run.completed"]);
  assert.deepEqual(calls.slice(0, 3), ["policy", "guard", "policy"]);
  assert.equal(calls.includes("approval"), true);
  const gatewayCall = calls.find((entry) => typeof entry === "object");
  assert.deepEqual(gatewayCall, {
    message: {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      capabilityLeaseId: "lease-1",
      operation: "tool",
      toolId: "product.notes.read",
      connectionId: "connection-1",
      input: { query: "safe" },
      signal: gatewayCall.message.signal,
    },
    binding: { invocationId: "invocation-1", attemptId: "attempt-1", capabilityLeaseId: "lease-1" },
  });
  assert.deepEqual(sessions.read(kernelSession).map((event) => event.type), ["tool.requested", "tool.result", "structured.output"]);
});

test("Product Tool Pipeline preserves a Product security deny before approval or gateway", async (t) => {
  const calls = [];
  const pipeline = createProductToolPipeline({
    binding: { invocationId: "invocation-2", attemptId: "attempt-2", capabilityLeaseId: "lease-2" },
    toolPolicy: { async resolve() { calls.push("policy"); return {
      toolId: "notes.write", effectClass: "write_local", gatewayToolId: "product.notes.write", requiresApproval: true,
    }; } },
    systemSecurity: { async check() { calls.push("guard"); return { status: "denied", code: "workspace_policy_denied" }; } },
    approvals: { async request() { calls.push("approval"); return { status: "approved" }; } },
    gateway: { async handle() { calls.push("gateway"); return {}; } },
    now: () => "2026-08-14T00:00:00.000Z",
  });
  let outcome;
  const loop = createScriptedAgentLoop({
    onRun: async function* (input) {
      outcome = await input.tools.execute({ toolId: "notes.write", effectClass: "write_local", input: { text: "x" } });
    },
  });
  const kernel = createMinimalAgentKernel({ loop, sessionPort: new MemorySessionPort(), toolPipeline: pipeline });
  t.after(() => kernel.dispose());
  await collect(kernel.run({
    runId: "pipeline-denied-run",
    session: { sessionId: "pipeline-denied-session", branchId: null },
    executionGrant: createExecutionGrant({
      grantId: "pipeline-denied-grant",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["notes.write"],
      allowedEffectClasses: ["write_local"],
      maxToolCalls: 1,
    }),
    input: null,
  }));
  assert.deepEqual(calls, ["policy", "guard"]);
  assert.deepEqual(outcome, {
    status: "denied",
    toolId: "notes.write",
    effectClass: "write_local",
    code: "workspace_policy_denied",
  });
});

test("Product Kernel Profile supplies the T1 Session, Tool, Loop, and event-observer ports to a real Kernel run", async () => {
  const session = { sessionId: "profile-session", branchId: null };
  const actualSessions = new MemorySessionPort();
  const observed = [];
  let disposed = 0;
  const actualLoop = {
    async *run(input) {
      const tool = await input.tools.execute({
        toolId: "profile.tool",
        effectClass: "read",
        input: { value: 1 },
      });
      yield { type: "message", modelVisible: true, payload: { role: "assistant", text: tool.output.text } };
    },
    async cancel() {},
    async dispose() { disposed += 1; },
  };
  const actualPipeline = {
    async execute({ call, emit }) {
      emit({ type: "tool.result", modelVisible: true, payload: {
        status: "completed", toolId: call.toolId, effectClass: call.effectClass, output: { text: "profile result" },
      } });
      return { status: "completed", output: { text: "profile result" } };
    },
  };
  const composed = createProductKernelProfile({
    id: "product-profile-proof",
    revision: "1",
    loop: actualLoop,
    sessionPort: actualSessions,
    toolPipeline: actualPipeline,
    eventObserver: { async observe(event) { observed.push(event); } },
  });
  const kernel = createMinimalAgentKernel({
    loop: {
      async *run() { throw new Error("profile_loop_was_not_used"); },
      async cancel() {},
      async dispose() { throw new Error("fallback_loop_must_not_dispose"); },
    },
    sessionPort: {
      async append() { throw new Error("profile_session_port_was_not_used"); },
      async *replay() { throw new Error("profile_session_port_was_not_used"); },
    },
    toolPipeline: { async execute() { throw new Error("profile_tool_pipeline_was_not_used"); } },
    profile: composed.profile,
    rootServices: composed.rootServices,
    idFactory: (kind) => `${kind}-profile-proof`,
    clock: () => "2026-08-14T00:00:00.000Z",
  });
  const events = await collect(kernel.run({
    runId: "profile-run",
    session,
    executionGrant: createExecutionGrant({
      grantId: "profile-grant",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["profile.tool"],
      allowedEffectClasses: ["read"],
      maxToolCalls: 1,
    }),
    input: { message: "run through the Product Profile" },
  }));

  assert.deepEqual(events.map((event) => event.type), ["tool.result", "message", "run.completed"]);
  assert.deepEqual(actualSessions.read(session).map((event) => event.type), ["tool.result", "message"]);
  assert.deepEqual(observed.map((event) => event.type), ["tool.result", "message", "run.completed"]);
  assert.deepEqual(kernel.capabilities().profile.plugins.map((plugin) => plugin.id), [
    "product-session-bridge", "product-tool-bridge", "product-kernel-event-observer", "product-agent-loop",
  ]);
  await kernel.dispose();
  assert.equal(disposed, 1);
});

test("Product Profile accepts only T2 first-party plugins and never lets them provide Product or Kernel authority", () => {
  const dependencies = {
    loop: { async *run() {}, async cancel() {} },
    sessionPort: new MemorySessionPort(),
    toolPipeline: { async execute() {} },
  };
  for (const plugin of [
    {
      id: "forged-system-plugin", version: "1", trust: "T1", lifetime: "profile", provides: ["business.forged"], setup() {},
    },
    {
      id: "forged-kernel-plugin", version: "1", trust: "T2", lifetime: "profile", provides: ["kernel.session_port"], setup() {},
    },
    {
      id: "forged-product-plugin", version: "1", trust: "T2", lifetime: "profile", provides: ["product.secret"], setup() {},
    },
  ]) {
    assert.throws(
      () => createProductKernelProfile({ ...dependencies, firstPartyPlugins: [plugin] }),
      (error) => error?.code === "product_first_party_plugin_invalid",
    );
  }
});

function modelEvent({ session, eventId }) {
  return Object.freeze({
    schemaVersion: MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
    eventId,
    runId: "product-run",
    session: Object.freeze({ ...session }),
    sequence: 1,
    type: "message",
    payload: Object.freeze({ role: "assistant", text: "Product replay" }),
    occurredAt: "2026-08-14T00:00:00.000Z",
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
