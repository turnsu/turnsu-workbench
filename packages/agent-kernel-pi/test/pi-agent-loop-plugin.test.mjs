import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createPiBackedAgentRuntime } from "../../agent-runtime/kernels/pi/pi-kernel-adapter.mjs";
import { createMinimalAgentKernel, createExecutionGrant, createToolPipeline } from "../../agent-kernel/src/index.mjs";
import { MemorySessionPort } from "../../agent-testkit/src/index.mjs";
import { createPiAgentLoopPlugin } from "../src/index.mjs";

const agentRuntimeRoot = resolve(import.meta.dirname, "../../agent-runtime");
const projectRoot = resolve(agentRuntimeRoot, "../..");

test("PiAgentLoopPlugin rebuilds a Pi cache from SessionPort replay and streams safe text deltas", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "pi-loop-plugin-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const created = [];
  const loop = createPiAgentLoopPlugin({
    createRuntime: () => {
      const session = new FakePiSession({ reply: `Pi reply ${created.length + 1}` });
      created.push(session);
      return fakePiRuntime({ runtimeRoot, session });
    },
  });
  const sessions = new MemorySessionPort();
  const kernel = createMinimalAgentKernel({ loop, sessionPort: sessions });
  t.after(() => kernel.dispose());
  const session = { sessionId: "session-pi", branchId: "branch-pi" };

  const first = await collect(kernel.run(request("run-pi-one", session, { message: "first ask" })));
  assert.deepEqual(first.map((event) => event.type), ["message.delta", "message", "run.completed"]);
  assert.match(created[0].prompts[0], /first ask/);
  assert.deepEqual(sessions.read(session).map((event) => event.payload.text), ["Pi reply 1"]);

  const second = await collect(kernel.resume(session, {
    runId: "run-pi-two",
    executionGrant: grant("grant-pi-two"),
    input: { message: "second ask" },
  }));
  assert.deepEqual(second.map((event) => event.type), ["message.delta", "message", "run.completed"]);
  assert.match(created[1].prompts[0], /Pi reply 1/);
  assert.match(created[1].prompts[0], /second ask/);
  assert.equal(created[0].disposed, true, "a prior Pi cache is disposable and not a Session authority");

  assert.deepEqual(await kernel.compact(session), { summary: "compacted" });
  assert.equal(created[1].compactions.length, 1);
});

test("PiAgentLoopPlugin cancellation calls Pi abort and emits a safe cancelled terminal event", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "pi-loop-cancel-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  let session;
  let started;
  const startedPromise = new Promise((resolveStarted) => { started = resolveStarted; });
  const loop = createPiAgentLoopPlugin({
    createRuntime: () => {
      session = new FakePiSession({ waitForAbort: true, onPrompt: () => started() });
      return fakePiRuntime({ runtimeRoot, session });
    },
  });
  const kernel = createMinimalAgentKernel({ loop, sessionPort: new MemorySessionPort() });
  t.after(() => kernel.dispose());
  const output = collect(kernel.run(request("run-pi-cancel", { sessionId: "session-cancel", branchId: "branch-cancel" })));
  await startedPromise;
  assert.deepEqual(await kernel.cancel("run-pi-cancel"), { cancelled: true });
  assert.deepEqual((await output).map((event) => event.type), ["run.cancelled"]);
  assert.equal(session.aborted, true);
});

test("PiAgentLoopPlugin refuses an active Pi tool surface until Stage 4 installs the Product bridge", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "pi-loop-tools-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const loop = createPiAgentLoopPlugin({
    createRuntime: () => fakePiRuntime({
      runtimeRoot,
      session: new FakePiSession({ activeTools: ["legacy.direct.tool"] }),
    }),
  });
  const kernel = createMinimalAgentKernel({ loop, sessionPort: new MemorySessionPort() });
  t.after(() => kernel.dispose());
  const events = await collect(kernel.run(request("run-pi-direct-tool", { sessionId: "session-tools", branchId: "branch-tools" })));
  assert.deepEqual(events.map((event) => event.type), ["run.failed"]);
  assert.equal(events[0].payload.code, "pi_tool_surface_unbridged");
});

test("PiAgentLoopPlugin accepts an active Pi tool only after the runtime binds the Kernel Tool Pipeline", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "pi-loop-tool-bridge-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const bindings = [];
  const loop = createPiAgentLoopPlugin({
    createRuntime: () => {
      const session = new FakePiSession({ reply: "Bridged tool loop", activeTools: ["product_tool_0"] });
      const runtime = fakePiRuntime({ runtimeRoot, session });
      runtime.bindKernelTools = async (binding) => { bindings.push(binding); };
      return runtime;
    },
  });
  const kernel = createMinimalAgentKernel({ loop, sessionPort: new MemorySessionPort() });
  t.after(() => kernel.dispose());
  const events = await collect(kernel.run(request("run-pi-tool-bridge", {
    sessionId: "session-tool-bridge", branchId: null,
  })));
  assert.deepEqual(events.map((event) => event.type), ["message.delta", "message", "run.completed"]);
  assert.equal(bindings.length, 1);
  assert.equal(typeof bindings[0].tools.execute, "function");
  assert.equal(bindings[0].executionGrant.grantId, "grant-run-pi-tool-bridge");
});

test("PiAgentLoopPlugin stops its private Pi loop when the Kernel Tool Pipeline is waiting for approval", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "pi-loop-tool-approval-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  let binding = null;
  let stoppedForApproval = false;
  const session = new FakePiSession({
    activeTools: ["product_tool_0"],
    waitForAbort: true,
    onPrompt: () => {
      void binding.tools.execute({
        toolId: "product_tool_0",
        effectClass: "external_write",
        input: { title: "requires Product approval" },
      });
    },
  });
  const loop = createPiAgentLoopPlugin({
    createRuntime: () => {
      const runtime = fakePiRuntime({ runtimeRoot, session });
      runtime.bindKernelTools = async (value) => { binding = value; };
      runtime.stopForApproval = () => {
        stoppedForApproval = true;
        void session.abort();
      };
      runtime.waitingForApproval = () => stoppedForApproval;
      return runtime;
    },
  });
  const toolPipeline = createToolPipeline({
    validate: async (call) => call,
    systemGuard: { check: async () => ({ status: "allowed" }) },
    approval: { request: async () => ({ status: "pending", approvalId: "approval-pi-a" }) },
    gateway: { execute: async () => { throw new Error("gateway_must_not_execute_before_approval"); } },
  });
  const kernel = createMinimalAgentKernel({ loop, sessionPort: new MemorySessionPort(), toolPipeline });
  t.after(() => kernel.dispose());
  const events = await collect(kernel.run({
    runId: "run-pi-tool-approval",
    session: { sessionId: "session-pi-tool-approval", branchId: null },
    executionGrant: createExecutionGrant({
      grantId: "grant-pi-tool-approval",
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: ["product_tool_0"],
      allowedEffectClasses: ["external_write"],
      maxToolCalls: 1,
    }),
    input: { message: "create the governed object" },
  }));

  assert.equal(stoppedForApproval, true);
  assert.equal(session.aborted, true);
  assert.deepEqual(events.map((event) => event.type), [
    "tool.requested", "approval.pending", "tool.pending", "pi.waiting", "run.waiting",
  ]);
});

function fakePiRuntime({ runtimeRoot, session }) {
  return createPiBackedAgentRuntime({
    projectRoot,
    agentRuntimeRoot,
    piAgentDir: join(runtimeRoot, `pi-agent-${Math.random().toString(36).slice(2)}`),
    piExtensionPath: join(agentRuntimeRoot, "extensions", "workflow-conformance", "extension.ts"),
    piSkillPath: join(agentRuntimeRoot, "skills"),
    piPromptPath: join(agentRuntimeRoot, "prompts"),
    projectToolNames: [],
    createResourceLoader: () => ({ async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) }),
    createSessionManager: () => ({ kind: "test" }),
    createSession: async () => ({ session, extensionsResult: { extensions: [], errors: [] } }),
  });
}

class FakePiSession {
  #listeners = new Set();
  #abortResolve = null;

  constructor({ reply = "", activeTools = [], waitForAbort = false, onPrompt = () => {} } = {}) {
    this.reply = reply;
    this.activeTools = activeTools;
    this.waitForAbort = waitForAbort;
    this.onPrompt = onPrompt;
    this.messages = [];
    this.prompts = [];
    this.compactions = [];
    this.aborted = false;
    this.disposed = false;
  }

  getActiveToolNames() { return [...this.activeTools]; }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(value) {
    this.prompts.push(value);
    this.onPrompt();
    if (this.waitForAbort) {
      await new Promise((resolve) => { this.#abortResolve = resolve; });
      return;
    }
    for (const listener of this.#listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: this.reply } });
    }
    this.messages.push({ role: "assistant", content: [{ type: "text", text: this.reply }] });
  }

  async compact(instructions) {
    this.compactions.push(instructions);
    return { summary: "compacted" };
  }

  async abort() {
    this.aborted = true;
    this.#abortResolve?.();
  }

  dispose() { this.disposed = true; }
  getAllTools() { return []; }
}

function request(runId, session, input = { message: "ask" }) {
  return { runId, session, executionGrant: grant(`grant-${runId}`), input };
}

function grant(grantId) {
  return createExecutionGrant({
    grantId,
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: ["none"],
    allowedEffectClasses: ["read"],
    maxToolCalls: 1,
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
