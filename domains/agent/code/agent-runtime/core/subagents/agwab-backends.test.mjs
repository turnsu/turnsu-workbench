import assert from "node:assert/strict";
import test from "node:test";

import { createAgwaSubagentBackend } from "./agwab-subagent-backend.mjs";
import { createAgwaWorkflowBackend } from "./agwab-workflow-backend.mjs";

function request(overrides = {}) {
  return {
    invocationId: "invocation-a",
    goal: "Perform bounded work.",
    input: {},
    limits: { timeoutMs: 5000, maxSteps: 8, maxModelRequests: 4, maxChildren: 0 },
    capabilities: { toolAllowlist: ["read"], connectionIds: [], network: false, filesystem: "none", externalActions: false },
    metadata: { model: "test/model", outerNodeId: "node-agent" },
    ...overrides,
  };
}

test("pi-subagent adapter uses the public API, fixed authority, and product-safe output", async () => {
  const calls = [];
  const backend = createAgwaSubagentBackend({
    cwd: "/sandbox",
    providerProbe: async () => ({ ready: true, model: "test/model" }),
    api: {
      async runSubagent(input) { calls.push(input); return { runId: "run-child", status: "pending" }; },
      async waitForSubagent() { return { outcome: "terminal", snapshot: { status: "completed", metadata: { usage: { modelRequests: 1 } } } }; },
      async getSubagentLogs() { return { logText: { output: '{"answer":"ok"}' }, metadata: {} }; },
      async interruptSubagent() { return { status: "cancelled" }; },
      async reconcileSubagentRun() { return { status: "completed" }; },
    },
  });
  const result = await backend.execute({ request: request(), emit() {} });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { answer: "ok" });
  assert.deepEqual(calls[0].tools, ["read"]);
  assert.equal(calls[0].agentScope, "global");
  assert.deepEqual(calls[0].extensions, []);
  assert.deepEqual(calls[0].toolResultBudget, { maxTotalChars: 320_000 });
  assert.equal(JSON.stringify(result).includes("/sandbox"), false);
});

test("pi-subagent adapter forwards the Product-owned tool result budget", async () => {
  const calls = [];
  const backend = createAgwaSubagentBackend({
    cwd: "/sandbox",
    providerProbe: async () => ({ ready: true, model: "test/model" }),
    api: {
      async runSubagent(input) { calls.push(input); return { runId: "run-budget", status: "completed" }; },
      async getSubagentLogs() { return { logText: { output: "{}" }, metadata: {} }; },
      async interruptSubagent() {},
      async reconcileSubagentRun() {},
    },
  });
  await backend.execute({ request: request({
    limits: { ...request().limits, maxToolResultChars: 1_024 },
  }) });
  assert.deepEqual(calls[0].toolResultBudget, { maxTotalChars: 1_024 });
});

test("pi-subagent adapter blocks explicitly when provider configuration is absent", async () => {
  const backend = createAgwaSubagentBackend({ cwd: "/sandbox" });
  await assert.rejects(
    () => backend.execute({ request: request() }),
    (error) => error?.code === "provider_unavailable" && error?.status === "blocked",
  );
});

test("pi-subagent adapter rejects the unsupported inline backend without fallback", () => {
  assert.throws(
    () => createAgwaSubagentBackend({ cwd: "/sandbox", backend: "inline" }),
    (error) => error?.message === "agwab_subagent_inline_backend_unsupported",
  );
});

test("pi-workflow adapter keeps the outer graph immutable and exposes dynamic children", async () => {
  const calls = [];
  const workflowRun = {
    runId: "workflow-run-a",
    status: "completed",
    taskSummary: { pending: 0, running: 0, blocked: 0, completed: 2, failed: 0, skipped: 0, interrupted: 0, total: 2 },
    tasks: [
      { taskId: "task-research", specId: "research", displayName: "Research", status: "completed", lastMessage: "evidence" },
      { taskId: "task-review", specId: "review", displayName: "Review", status: "completed", lastMessage: "approved" },
    ],
  };
  const backend = createAgwaWorkflowBackend({
    cwd: "/sandbox",
    providerProbe: async () => ({ ready: true }),
    api: {
      async runDynamicTask(cwd, options) { calls.push({ cwd, options }); return workflowRun; },
      async waitForRun() { return workflowRun; },
      async stopRun() { return { run: { ...workflowRun, status: "interrupted" } }; },
      async refreshRun() { return workflowRun; },
      async resumeRun() { return { run: workflowRun }; },
    },
  });
  const result = await backend.execute({ request: request({
    limits: { timeoutMs: 5000, maxSteps: 8, maxModelRequests: 4, maxChildren: 2 },
    metadata: {
      model: "test/model",
      outerNodeId: "node-agent",
      allowReusableProposal: true,
      admittedChildConcurrency: 2,
    },
    resultSchema: {
      type: "object", properties: { brief: { type: "string" } },
      required: ["brief"], additionalProperties: false,
    },
  }), emit() {} });

  assert.equal(result.status, "completed");
  assert.equal(result.children.length, 2);
  assert.equal(result.outerGraphChanged, false);
  assert.equal(result.nextLoopProposal.kind, "loop_revision_proposal");
  assert.deepEqual(result.output, { brief: "approved" });
  assert.equal(calls[0].options.runtimeOverrides.worktreePolicy, "off");
  assert.equal(calls[0].options.runtimeOverrides.maxConcurrency, 2);
  assert.equal(JSON.stringify(result).includes("/sandbox"), false);
});

test("pi-workflow adapter resumes an existing valid run instead of relaunching completed children", async () => {
  let launches = 0;
  let resumes = 0;
  const completed = {
    runId: "workflow-run-existing", status: "completed",
    taskSummary: { pending: 0, running: 0, blocked: 0, completed: 1, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{ taskId: "task-existing", specId: "existing", displayName: "Existing", status: "completed" }],
  };
  const backend = createAgwaWorkflowBackend({
    cwd: "/sandbox",
    providerProbe: async () => ({ ready: true }),
    api: {
      async runDynamicTask() { launches += 1; return completed; },
      async refreshRun() { return completed; },
      async resumeRun() { resumes += 1; return { run: completed }; },
      async waitForRun() { return completed; },
      async stopRun() {},
    },
  });
  await backend.execute({ request: request({
    limits: { timeoutMs: 5000, maxSteps: 4, maxModelRequests: 2, maxChildren: 1 },
    metadata: { model: "test/model", outerNodeId: "node-agent", resumeRunId: completed.runId },
  }) });

  assert.equal(launches, 0);
  assert.equal(resumes, 0);
});

test("pi-workflow adapter streams task diffs before the parent run completes", async () => {
  const updates = [];
  let resolveWait;
  const waiting = new Promise((resolve) => { resolveWait = resolve; });
  const running = {
    runId: "workflow-run-live", status: "running",
    taskSummary: { pending: 0, running: 1, blocked: 0, completed: 0, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{ taskId: "task-live", specId: "live", displayName: "Live", status: "running", lastMessage: "working" }],
  };
  const completed = {
    ...running,
    status: "completed",
    taskSummary: { pending: 0, running: 0, blocked: 0, completed: 1, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{ ...running.tasks[0], status: "completed", lastMessage: '{"answer":"done"}' }],
  };
  const backend = createAgwaWorkflowBackend({
    cwd: "/sandbox",
    pollIntervalMs: 10,
    providerProbe: async () => ({ ready: true }),
    api: {
      async runDynamicTask() { return running; },
      async waitForRun() { return waiting; },
      async refreshRun() { resolveWait(completed); return completed; },
      async stopRun() {},
      async resumeRun() { return { run: running }; },
    },
  });
  const result = await backend.execute({
    request: request({
      limits: { timeoutMs: 5000, maxSteps: 4, maxModelRequests: 2, maxChildren: 1 },
      resultSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    }),
    reportChild(update) { updates.push(update); },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(updates.map((update) => update.status), ["running", "completed"]);
  assert(updates.every((update) => update.checkpoint.agwaRunId === "workflow-run-live"));
});

test("pi-workflow adapter uses the exact bounded subagent session as the product child identity", async () => {
  const updates = [];
  const sessionId = "piwf.0123456789abcdef.synthesize-r0";
  const completed = {
    runId: "workflow-run-with-a-long-identity-that-requires-bounding",
    status: "completed",
    taskSummary: { pending: 0, running: 0, blocked: 0, completed: 1, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{
      taskId: "dynamic.synthesize-r0",
      specId: "dynamic.synthesize-r0",
      displayName: "Synthesize",
      status: "completed",
      lastMessage: "done",
      artifactGraph: { enabled: true },
      backendFiles: { sessionId },
    }],
  };
  const backend = createAgwaWorkflowBackend({
    cwd: "/sandbox",
    providerProbe: async () => ({ ready: true }),
    api: {
      async runDynamicTask() { return completed; },
      async waitForRun() { return completed; },
      async stopRun() {},
      async refreshRun() { return completed; },
      async resumeRun() { return { run: completed }; },
    },
  });

  await backend.execute({
    request: request({ limits: { timeoutMs: 5000, maxSteps: 4, maxModelRequests: 2, maxChildren: 1 } }),
    reportChild(update) { updates.push(update); },
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].childRef, sessionId);
  assert.equal(updates[0].checkpoint.taskRef, "dynamic.synthesize-r0");
});

test("pi-workflow parent cancellation cascades to the active AgwaB run", async () => {
  let resolveWait;
  let stopped = 0;
  const waiting = new Promise((resolve) => { resolveWait = resolve; });
  const running = {
    runId: "workflow-run-cancel", status: "running",
    taskSummary: { pending: 0, running: 1, blocked: 0, completed: 0, failed: 0, skipped: 0, interrupted: 0, total: 1 },
    tasks: [{ taskId: "task-running", specId: "running", displayName: "Running", status: "running" }],
  };
  const backend = createAgwaWorkflowBackend({
    cwd: "/sandbox",
    providerProbe: async () => ({ ready: true }),
    api: {
      async runDynamicTask() { return running; },
      async waitForRun() { return waiting; },
      async stopRun() {
        stopped += 1;
        const finalRun = { ...running, status: "interrupted", tasks: [{ ...running.tasks[0], status: "interrupted" }] };
        resolveWait(finalRun);
        return { run: finalRun };
      },
      async refreshRun() { return running; },
      async resumeRun() { return { run: running }; },
    },
  });
  const controller = new AbortController();
  const executing = backend.execute({ request: request({
    limits: { timeoutMs: 5000, maxSteps: 4, maxModelRequests: 2, maxChildren: 1 },
  }), signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  const reason = new Error("cancelled");
  reason.status = "cancelled";
  controller.abort(reason);

  await assert.rejects(() => executing, (error) => error === reason);
  assert.equal(stopped, 1);
});
