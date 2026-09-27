import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMinimalKernelPiWorker } from "./kernel-pi-worker.mjs";

const basePayload = (overrides = {}) => ({
  schemaVersion: "workbench-execution-fabric-v1",
  invocationId: "kernel-invocation-a",
  attemptId: "kernel-attempt-a",
  mode: "bounded_agent",
  goal: "Return a governed response.",
  input: {
    value: 1,
    kernelSessionReplay: {
      schemaVersion: "agent-kernel-session-replay-v1",
      session: { sessionId: "kernel-session-a", branchId: null },
      events: [],
      checkpoint: { cursor: 0 },
    },
  },
  limits: { timeoutMs: 10_000, maxSteps: 4, maxModelRequests: 2, maxChildren: 0, maxInputBytes: 10_000, maxOutputBytes: 10_000 },
  capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
  resultSchema: {
    type: "object",
    properties: { response: { type: "string" } },
    required: ["response"],
    additionalProperties: false,
  },
  evidenceRequirements: [],
  metadata: { agentSessionId: "kernel-session-a", agentTurnId: "kernel-turn-a" },
  agentKernel: { profileId: "product-pi", profileRevision: "product-pi-first-party-v1" },
  gateway: { transport: "stdio-jsonl-v1", capabilityLeaseId: "kernel-lease-a" },
  executionGrant: {
    schemaVersion: "agent-kernel-execution-grant-v1",
    grantId: "kernel-grant-a",
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: [],
    allowedEffectClasses: [],
    maxToolCalls: 0,
    scopeRef: "kernel-session-a",
  },
  toolEffects: {},
  ...overrides,
});

async function runtime(t) {
  const root = await mkdtemp(join(tmpdir(), "looloomi-kernel-pi-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd: root, agentDir: join(root, "pi-agent") };
}

test("minimal Pi Worker sends model-visible output through the Product event protocol before returning", async (t) => {
  const events = [];
  const calls = [];
  const rpc = {
    async call(message) {
      calls.push(message);
      return { text: JSON.stringify({ response: "Kernel-backed Pi completed." }) };
    },
    async sendEvent(type, payload) { events.push({ type, payload }); },
  };
  const result = await runMinimalKernelPiWorker(basePayload(), rpc, await runtime(t));
  assert.deepEqual(result.output, { response: "Kernel-backed Pi completed." });
  assert.equal(calls[0].operation, "model");
  const persisted = events.find((event) => event.type === "kernel.model_visible");
  assert.equal(persisted.payload.modelVisibleEvent.type, "message");
  assert.deepEqual(persisted.payload.modelVisibleEvent.payload, {
    role: "assistant",
    text: JSON.stringify({ response: "Kernel-backed Pi completed." }),
  });
  const telemetryTypes = events.filter((event) => event.type === "kernel.telemetry")
    .map((event) => event.payload.type);
  for (const expected of ["planner.ready", "workflow.prepared", "message", "render.intent", "run.completed"]) {
    assert.ok(telemetryTypes.includes(expected), `expected Profile event ${expected}`);
  }
});

test("minimal Pi Worker rebuilds its private Pi cache from Product Session replay", async (t) => {
  const calls = [];
  const rpc = {
    async call(message) {
      calls.push(message);
      return { text: JSON.stringify({ response: "Replayed Product Session context." }) };
    },
    async sendEvent() {},
  };
  await runMinimalKernelPiWorker(basePayload({
    input: {
      value: 1,
      kernelSessionReplay: {
        schemaVersion: "agent-kernel-session-replay-v1",
        session: { sessionId: "kernel-session-a", branchId: null },
        events: [{
          schemaVersion: "agent-kernel-model-visible-event-v1",
          eventId: "kernel-history-a",
          runId: "kernel-history-run-a",
          session: { sessionId: "kernel-session-a", branchId: null },
          sequence: 1,
          type: "message",
          payload: { role: "assistant", text: "Durable Product history." },
          occurredAt: "2026-08-14T00:00:00.000Z",
        }],
        checkpoint: { cursor: 7 },
      },
    },
  }), rpc, await runtime(t));
  assert.equal(JSON.stringify(calls[0].input.context.messages).includes("Durable Product history."), true);
});

test("Main Agent text preserves literal newlines and quotes without asking the model for JSON", async (t) => {
  const text = 'First step: describe your goal.\n\nThen review the "result" before sharing.';
  const calls = [];
  const result = await runMinimalKernelPiWorker(basePayload({
    metadata: { agentSessionId: "kernel-session-a", responseFormat: "text" },
  }), {
    async call(message) { calls.push(message); return { text }; },
    async sendEvent() {},
  }, await runtime(t));
  assert.deepEqual(result.output, { response: text });
  assert.equal(result.status, "completed");
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(JSON.stringify(calls[0].input.context).includes("matching resultSchema"), false);
});

test("invalid structured output fails but retains its private transcript and actual usage", async (t) => {
  const options = await runtime(t);
  await assert.rejects(() => runMinimalKernelPiWorker(basePayload(), {
    async call() { return { text: 'Invalid JSON with a literal\nnewline' }; },
    async sendEvent() {},
  }, options), (error) => {
    assert.equal(error.code, "agent_output_invalid_json");
    assert.equal(error.usage.modelRequests, 1);
    assert.equal(JSON.parse(error.workerTranscript.content).backend, "minimal-kernel-pi");
    return true;
  });
});

test("minimal Pi Worker sends an allowed Tool through Kernel grant and Product Gateway RPC", async (t) => {
  const calls = [];
  const events = [];
  let modelCalls = 0;
  const rpc = {
    async call(message) {
      calls.push(message);
      if (message.operation === "tool") return { body: "governed tool result" };
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: [{ type: "toolCall", id: "tool-call-1", name: "lark.docs.fetch", arguments: { doc: "doc-1" } }],
          stopReason: "toolUse",
        };
      }
      return { text: JSON.stringify({ response: "Used a Kernel-governed Tool." }) };
    },
    async sendEvent(type, payload) { events.push({ type, payload }); },
  };
  const result = await runMinimalKernelPiWorker(basePayload({
    capabilities: {
      toolAllowlist: ["lark.docs.fetch"],
      connectionIds: ["connection-lark"],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    executionGrant: {
      schemaVersion: "agent-kernel-execution-grant-v1",
      grantId: "kernel-grant-tool",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["lark.docs.fetch"],
      allowedEffectClasses: ["read"],
      maxToolCalls: 1,
      scopeRef: "kernel-session-a",
    },
    toolEffects: { "lark.docs.fetch": "read" },
  }), rpc, await runtime(t));
  assert.deepEqual(result.output, { response: "Used a Kernel-governed Tool." });
  assert.deepEqual(calls.map((call) => call.operation), ["model", "tool", "model"]);
  assert.deepEqual({ ...calls[1], signal: "checked-below" }, {
    operation: "tool",
    invocationId: "kernel-invocation-a",
    attemptId: "kernel-attempt-a",
    capabilityLeaseId: "kernel-lease-a",
    toolId: "lark.docs.fetch",
    connectionId: "connection-lark",
    input: { doc: "doc-1" },
    signal: "checked-below",
  });
  assert.deepEqual(events.filter((event) => event.type === "kernel.model_visible")
    .map((event) => event.payload.modelVisibleEvent.type), ["tool.requested", "tool.result", "message"]);
});

test("native Pi can read Product-owned materials without an external connection", async (t) => {
  const calls = [];
  let modelCalls = 0;
  const rpc = { async call(message) {
    calls.push(message);
    if (message.operation === "tool") return { files: [{ fileName: "brief.md" }] };
    if (++modelCalls === 1) return { content: [{ type: "text", text: "I will inspect the attached file." }, { type: "toolCall", id: "read-materials",
      name: "turnsu_materials", arguments: { action: "list" } }], stopReason: "toolUse" };
    return { text: JSON.stringify({ response: "Read the task materials." }) };
  }, async sendEvent() {} };
  const result = await runMinimalKernelPiWorker(basePayload({
    capabilities: { toolAllowlist: ["turnsu_materials"], connectionIds: [], network: false, filesystem: "none", externalActions: false },
    executionGrant: { schemaVersion: "agent-kernel-execution-grant-v1", grantId: "material-read-grant",
      expiresAt: "2035-01-01T00:00:00.000Z", allowedToolIds: ["turnsu_materials"], allowedEffectClasses: ["read"],
      maxToolCalls: 1, scopeRef: "kernel-session-a" },
    toolEffects: { turnsu_materials: "read" },
  }), rpc, await runtime(t));
  assert.equal(result.output.response, "Read the task materials.");
  assert.match(result.workerTranscript.content, /I will inspect the attached file\./);
  assert.deepEqual(calls.map((call) => call.operation), ["model", "tool", "model"]);
  assert.equal(calls[1].connectionId, undefined);
  assert.deepEqual(calls[1].input, { action: "list" });
});

test("first-party business tool policy can only shrink an approved Product Tool surface", async (t) => {
  const calls = [];
  const rpc = {
    async call(message) {
      calls.push(message);
      throw new Error("model_must_not_run_after_business_policy_deny");
    },
    async sendEvent() {},
  };
  const workerOptions = await runtime(t);
  await assert.rejects(
    () => runMinimalKernelPiWorker(basePayload({
      capabilities: {
        toolAllowlist: ["office.document.draft"],
        connectionIds: [],
        network: false,
        filesystem: "none",
        externalActions: false,
      },
      executionGrant: {
        schemaVersion: "agent-kernel-execution-grant-v1",
        grantId: "kernel-grant-office-policy",
        expiresAt: "2035-01-01T00:00:00.000Z",
        allowedToolIds: ["office.document.draft"],
        allowedEffectClasses: ["external_write"],
        maxToolCalls: 1,
        scopeRef: "kernel-session-a",
      },
      toolEffects: { "office.document.draft": "external_write" },
    }), rpc, workerOptions),
    (error) => error?.code === "pi_business_tool_effect_denied" && error?.status === "failed",
  );
  assert.equal(calls.length, 0, "the T2 policy rejects before a model or Product Gateway call");
});

test("minimal Pi Worker stops an external Tool at Product approval without dispatching the effect", async (t) => {
  const calls = [];
  const events = [];
  const rpc = {
    async call(message) {
      calls.push(message);
      if (message.operation === "approval") {
        return { status: "pending", approvalId: "tool-approval-pending-a" };
      }
      if (message.operation === "tool") {
        throw new Error("external_effect_must_not_dispatch_before_product_approval");
      }
      return {
        content: [{
          type: "toolCall",
          id: "tool-call-pending-a",
          name: "lark.task.create",
          arguments: { title: "Await approval" },
        }],
        stopReason: "toolUse",
      };
    },
    async sendEvent(type, payload) { events.push({ type, payload }); },
  };
  const result = await runMinimalKernelPiWorker(basePayload({
    capabilities: {
      toolAllowlist: ["lark.task.create"],
      connectionIds: ["connection-lark"],
      network: false,
      filesystem: "none",
      externalActions: true,
    },
    executionGrant: {
      schemaVersion: "agent-kernel-execution-grant-v1",
      grantId: "kernel-grant-external-pending",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["lark.task.create"],
      allowedEffectClasses: ["external_write"],
      maxToolCalls: 1,
      scopeRef: "kernel-session-a",
    },
    toolEffects: { "lark.task.create": "external_write" },
  }), rpc, await runtime(t));

  assert.equal(result.status, "blocked");
  assert.equal(result.approvalId, "tool-approval-pending-a");
  assert.deepEqual(calls.map((call) => call.operation), ["model", "approval"]);
  assert.deepEqual(calls[1], {
    operation: "approval",
    invocationId: "kernel-invocation-a",
    attemptId: "kernel-attempt-a",
    capabilityLeaseId: "kernel-lease-a",
    toolId: "lark.task.create",
    effectClass: "external_write",
    connectionId: "connection-lark",
    input: { title: "Await approval" },
  });
  assert.deepEqual(events.filter((event) => event.type === "kernel.model_visible")
    .map((event) => event.payload.modelVisibleEvent.type), ["tool.requested", "approval.pending", "tool.pending"]);
});

test("minimal Pi Worker resumes only through Product approval before dispatching an external Tool", async (t) => {
  const calls = [];
  const events = [];
  let modelCalls = 0;
  const approval = {
    approvalId: "tool-approval-approved-a",
    toolId: "lark.task.create",
    inputDigest: `sha256:${"a".repeat(64)}`,
  };
  const rpc = {
    async call(message) {
      calls.push(message);
      if (message.operation === "approval") {
        assert.equal(message.resumeApprovalId, approval.approvalId);
        return { status: "approved", approvalId: approval.approvalId };
      }
      if (message.operation === "tool") return { body: "created through the approved Product Gateway" };
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: [{
            type: "toolCall",
            id: "tool-call-approved-a",
            name: "lark.task.create",
            arguments: { title: "Approved task" },
          }],
          stopReason: "toolUse",
        };
      }
      return { text: JSON.stringify({ response: "Approved external Tool completed." }) };
    },
    async sendEvent(type, payload) { events.push({ type, payload }); },
  };
  const result = await runMinimalKernelPiWorker(basePayload({
    metadata: {
      agentSessionId: "kernel-session-a",
      agentTurnId: "kernel-turn-a",
      toolApprovalResume: approval,
    },
    capabilities: {
      toolAllowlist: ["lark.task.create"],
      connectionIds: ["connection-lark"],
      network: false,
      filesystem: "none",
      externalActions: true,
    },
    executionGrant: {
      schemaVersion: "agent-kernel-execution-grant-v1",
      grantId: "kernel-grant-external-approved",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["lark.task.create"],
      allowedEffectClasses: ["external_write"],
      maxToolCalls: 1,
      scopeRef: "kernel-session-a",
    },
    toolEffects: { "lark.task.create": "external_write" },
  }), rpc, await runtime(t));

  assert.deepEqual(result.output, { response: "Approved external Tool completed." });
  assert.deepEqual(calls.map((call) => call.operation), ["model", "approval", "tool", "model"]);
  assert.equal(calls[2].externalAction, true);
  assert.deepEqual(events.filter((event) => event.type === "kernel.model_visible")
    .map((event) => event.payload.modelVisibleEvent.type), ["tool.requested", "tool.result", "message"]);
});
