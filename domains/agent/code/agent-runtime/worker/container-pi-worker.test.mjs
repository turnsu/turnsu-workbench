import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runContainerPiWorker } from "./container-pi-worker.mjs";

const payload = (overrides = {}) => ({
  schemaVersion: "workbench-execution-fabric-v1",
  invocationId: "invocation-worker-a",
  attemptId: "attempt-worker-a",
  mode: "bounded_agent",
  goal: "Return a governed response.",
  input: { value: 1 },
  limits: { timeoutMs: 10_000, maxSteps: 4, maxModelRequests: 2, maxChildren: 0, maxInputBytes: 10_000, maxOutputBytes: 10_000 },
  capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
  resultSchema: {
    type: "object",
    properties: { response: { type: "string" } },
    required: ["response"],
    additionalProperties: false,
  },
  evidenceRequirements: [],
  metadata: {},
  runtimeVersions: { pi: "0.80.7", subagent: "0.4.8", workflow: "0.8.1" },
  gateway: { transport: "stdio-jsonl-v1", capabilityLeaseId: "lease-worker-a" },
  ...overrides,
});

async function tempRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "looloomi-container-pi-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd: root, agentDir: join(root, "pi-agent") };
}

test("container Pi Worker uses the Gateway model and returns schema-checked JSON", async (t) => {
  const calls = [];
  const events = [];
  const rpc = {
    async call(message) {
      calls.push(message);
      return { text: JSON.stringify({ response: "Gateway-backed Pi completed." }) };
    },
    async sendEvent(type, value) { events.push({ type, value }); },
  };
  const result = await runContainerPiWorker(payload(), rpc, await tempRuntime(t));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { response: "Gateway-backed Pi completed." });
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(calls[0].operation, "model");
  assert.equal(JSON.stringify(calls).includes("apiKey"), false);
  assert.deepEqual(events.map((event) => event.type), [
    "session.started",
    "agwab.subagent.launching",
    "agwab.subagent.completed",
    "session.completed",
  ]);
});

test("container Pi Worker exposes only allowlisted tools and routes execution through the Gateway", async (t) => {
  const calls = [];
  let modelCall = 0;
  const rpc = {
    async call(message) {
      calls.push(message);
      if (message.operation === "tool") return { items: ["governed-result"] };
      modelCall += 1;
      if (modelCall === 1) {
        return {
          content: [{ type: "toolCall", id: "tool-call-1", name: "search", arguments: { query: "safe" } }],
          stopReason: "toolUse",
        };
      }
      assert.equal(JSON.stringify(message.input.context).includes("governed-result"), true);
      return { text: JSON.stringify({ response: "Used one governed tool." }) };
    },
    async sendEvent() {},
  };
  const result = await runContainerPiWorker(payload({
    capabilities: { toolAllowlist: ["search"], connectionIds: [], network: false, filesystem: "none", externalActions: false },
  }), rpc, await tempRuntime(t));
  assert.deepEqual(calls.map((call) => call.operation), ["model", "tool", "model"]);
  assert.equal(result.usage.steps, 3);
  assert.equal(result.usage.modelRequests, 2);
  assert.deepEqual(result.output, { response: "Used one governed tool." });
});

test("container Pi Worker rejects a model result that does not match the product result schema", async (t) => {
  const rpc = {
    async call() { return { text: JSON.stringify({ wrong: true }) }; },
    async sendEvent() {},
  };
  await assert.rejects(
    runContainerPiWorker(payload(), rpc, await tempRuntime(t)),
    { code: "agent_output_schema_mismatch", status: "failed" },
  );
});

test("container orchestrator streams AgwaB child lifecycle through the product protocol", async (t) => {
  const children = [];
  let resolveWait;
  const waiting = new Promise((resolve) => { resolveWait = resolve; });
  const running = {
    runId: "workflow-container-live",
    status: "running",
    taskSummary: { pending: 0, running: 1, blocked: 0, completed: 0, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{ taskId: "task-live", specId: "live", displayName: "Live", status: "running", lastMessage: "working" }],
  };
  const completed = {
    ...running,
    status: "completed",
    taskSummary: { pending: 0, running: 0, blocked: 0, completed: 1, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{ ...running.tasks[0], status: "completed", lastMessage: '{"answer":"done"}' }],
  };
  const rpc = {
    async call() { throw new Error("fake workflow should not call the model Gateway"); },
    async sendEvent() {},
    async sendChild(update) {
      children.push(update);
      return {
        childRef: update.childRef,
        invocationId: "invocation-child-live",
        attemptId: "attempt-child-live",
        capabilityLeaseId: "lease-child-live",
        capabilities: structuredClone(update.capabilities),
        status: update.status,
      };
    },
  };
  const result = await runContainerPiWorker(payload({
    mode: "agent_orchestrator",
    limits: { ...payload().limits, maxChildren: 1 },
    metadata: { outerNodeId: "node-orchestrator" },
    resultSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  }), rpc, {
    ...await tempRuntime(t),
    workflowApi: {
      async runDynamicTask() { return running; },
      async waitForRun() { return waiting; },
      async refreshRun() { resolveWait(completed); return completed; },
      async stopRun() {},
      async resumeRun() { return { run: running }; },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outerGraphChanged, false);
  assert.deepEqual(children.map((child) => child.status), ["running", "completed"]);
  assert(children.every((child) => child.capabilities.toolAllowlist.length === 0));
});
