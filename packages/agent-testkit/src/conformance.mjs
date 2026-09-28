import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentKernelError,
  assertAgentKernelPort,
  composeKernelProfile,
  createExecutionGrant,
  createRenderIntent,
  createToolPipeline,
} from "../../agent-kernel/src/index.mjs";
import { MemorySessionPort } from "./memory-session-port.mjs";
import { createScriptedAgentLoop, waitForAbort } from "./scripted-agent-loop.mjs";

/**
 * Runs the same behavioral contract against Pi, future DSH, and the minimal
 * implementation.  It intentionally tests observable event/session behavior,
 * not private fields or source text.
 */
export function defineAgentKernelConformance({ name, createKernel } = {}) {
  if (typeof name !== "string" || !name || typeof createKernel !== "function") {
    throw new TypeError("agent_kernel_conformance_invalid");
  }

  test(`${name}: single turn persists each model-visible event exactly once`, async (t) => {
    const sessions = new MemorySessionPort();
    const loop = createScriptedAgentLoop({
      onRun: async function* () {
        yield { type: "message", modelVisible: true, payload: { role: "assistant", text: "hello" } };
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions }));
    t.after(() => kernel.dispose());
    const session = sessionRef("single");
    const events = await collect(kernel.run(runRequest({ runId: "run-single", session })));
    assert.deepEqual(events.map((event) => event.type), ["message", "run.completed"]);
    assert.deepEqual(sessions.read(session).map((event) => event.type), ["message"]);
    assert.equal(events[0].sequence, 1);
    assert.ok(Object.isFrozen(events[0]));
  });

  test(`${name}: multi-turn resume reuses the SessionPort without inventing a second log`, async (t) => {
    const sessions = new MemorySessionPort();
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        yield {
          type: "message",
          modelVisible: true,
          payload: { role: "assistant", text: input.mode === "resume" ? "second" : "first" },
        };
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions }));
    t.after(() => kernel.dispose());
    const session = sessionRef("multi");
    await collect(kernel.run(runRequest({ runId: "run-multi-one", session })));
    await collect(kernel.resume(session, {
      runId: "run-multi-two",
      executionGrant: grant("grant-multi-two"),
      input: { message: "continue" },
    }));
    assert.deepEqual(sessions.read(session).map((event) => event.payload.text), ["first", "second"]);
    assert.deepEqual(loop.runs.map((input) => input.mode), ["run", "resume"]);
  });

  test(`${name}: unified Tool Pipeline preserves grant -> guard -> approval -> gateway order`, async (t) => {
    const calls = [];
    const pipeline = createToolPipeline({
      validate: async (call) => {
        calls.push("validate");
        return call;
      },
      systemGuard: { check: async () => { calls.push("guard"); return { status: "allowed" }; } },
      approval: { request: async () => { calls.push("approval"); return { status: "approved" }; } },
      gateway: {
        execute: async ({ call }) => {
          calls.push("gateway");
          return { status: "completed", output: { echoed: call.input.text } };
        },
      },
    });
    let result = null;
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        result = await input.tools.execute({
          toolId: "notes.read",
          effectClass: "read",
          input: { text: "tool-proof" },
        });
        yield { type: "structured.output", modelVisible: true, payload: result };
      },
    });
    const sessions = new MemorySessionPort();
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions, toolPipeline: pipeline }));
    t.after(() => kernel.dispose());
    const events = await collect(kernel.run(runRequest({
      runId: "run-tool",
      session: sessionRef("tool"),
      executionGrant: grant("grant-tool", { allowedToolIds: ["notes.read"], allowedEffectClasses: ["read"], maxToolCalls: 1 }),
    })));
    assert.deepEqual(calls, ["validate", "guard", "approval", "gateway"]);
    assert.deepEqual(events.map((event) => event.type), ["tool.requested", "tool.result", "structured.output", "run.completed"]);
    assert.equal(result.status, "completed");
    assert.ok(Object.isFrozen(result));
  });

  test(`${name}: a grant denial is monotonic and never reaches guard, approval, or gateway`, async (t) => {
    const calls = [];
    const pipeline = createToolPipeline({
      validate: async (call) => { calls.push("validate"); return call; },
      systemGuard: { check: async () => { calls.push("guard"); return { status: "allowed" }; } },
      approval: { request: async () => { calls.push("approval"); return { status: "approved" }; } },
      gateway: { execute: async () => { calls.push("gateway"); return { status: "completed", output: {} }; } },
    });
    let result = null;
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        result = await input.tools.execute({ toolId: "notes.write", effectClass: "write_local", input: {} });
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort(), toolPipeline: pipeline }));
    t.after(() => kernel.dispose());
    const events = await collect(kernel.run(runRequest({
      runId: "run-monotonic-deny",
      session: sessionRef("monotonic-deny"),
      executionGrant: grant("grant-monotonic-deny", { allowedToolIds: ["notes.read"], allowedEffectClasses: ["read"] }),
    })));
    assert.deepEqual(calls, ["validate"]);
    assert.equal(result.status, "denied");
    assert.equal(result.code, "execution_grant_denied");
    assert.deepEqual(events.map((event) => event.type), ["tool.requested", "tool.denied", "run.completed"]);
  });

  test(`${name}: an absent bridge Tool Pipeline fails closed instead of creating a generic executor`, async (t) => {
    let result = null;
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        result = await input.tools.execute({ toolId: "notes.read", effectClass: "read", input: {} });
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort() }));
    t.after(() => kernel.dispose());
    const events = await collect(kernel.run(runRequest({ runId: "run-no-tool-bridge", session: sessionRef("no-tool-bridge") })));
    assert.equal(result.status, "denied");
    assert.equal(result.code, "kernel_tool_pipeline_unavailable");
    assert.deepEqual(events.map((event) => event.type), ["tool.requested", "tool.denied", "run.completed"]);
  });

  test(`${name}: a pending approval stays pending and resume creates the later completion`, async (t) => {
    const pipeline = createToolPipeline({
      validate: async (call) => call,
      systemGuard: { check: async () => ({ status: "allowed" }) },
      approval: { request: async () => ({ status: "pending", approvalId: "approval-1" }) },
      gateway: { execute: async () => { throw new Error("gateway_must_not_run_before_approval"); } },
    });
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        if (input.mode === "resume") {
          yield { type: "message", modelVisible: true, payload: { role: "assistant", text: "approved continuation" } };
          return;
        }
        const result = await input.tools.execute({ toolId: "notes.write", effectClass: "write_local", input: { text: "hold" } });
        assert.equal(result.status, "pending");
      },
    });
    const sessions = new MemorySessionPort();
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions, toolPipeline: pipeline }));
    t.after(() => kernel.dispose());
    const session = sessionRef("approval");
    const first = await collect(kernel.run(runRequest({
      runId: "run-approval-pending",
      session,
      executionGrant: grant("grant-approval", { allowedToolIds: ["notes.write"], allowedEffectClasses: ["write_local"] }),
    })));
    assert.deepEqual(first.map((event) => event.type), ["tool.requested", "approval.pending", "tool.pending", "run.waiting"]);
    const resumed = await collect(kernel.resume(session, {
      runId: "run-approval-resume",
      executionGrant: grant("grant-approval-resume"),
      input: { approvalId: "approval-1" },
    }));
    assert.deepEqual(resumed.map((event) => event.type), ["message", "run.completed"]);
    assert.deepEqual(sessions.read(session).map((event) => event.type), ["tool.requested", "approval.pending", "tool.pending", "message"]);
  });

  test(`${name}: cancellation reaches the active Loop and records a safe terminal event`, async (t) => {
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        yield { type: "message", modelVisible: true, payload: { role: "assistant", text: "working" } };
        await waitForAbort(input.signal);
        yield { type: "run.cancelled", modelVisible: false, payload: { code: "cancelled_by_user" } };
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort() }));
    t.after(() => kernel.dispose());
    const iterator = kernel.run(runRequest({ runId: "run-cancel", session: sessionRef("cancel") }))[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, "message");
    assert.deepEqual(await kernel.cancel("run-cancel"), { cancelled: true });
    assert.equal((await iterator.next()).value.type, "run.cancelled");
    assert.equal((await iterator.next()).done, true);
    assert.deepEqual(loop.cancellations, ["run-cancel"]);
  });

  test(`${name}: compaction delegates through the same SessionRef contract`, async (t) => {
    const loop = createScriptedAgentLoop({
      onRun: async function* () {},
      onCompact: async (session) => ({ compacted: true, sessionId: session.sessionId }),
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort() }));
    t.after(() => kernel.dispose());
    const session = sessionRef("compact");
    assert.deepEqual(await kernel.compact(session), { compacted: true, sessionId: "session-compact" });
    assert.deepEqual(loop.compactions, [session]);
  });

  test(`${name}: structured output remains immutable and model-visible`, async (t) => {
    const output = { format: "json", value: { answer: 42 } };
    const loop = createScriptedAgentLoop({
      onRun: async function* () {
        yield { type: "structured.output", modelVisible: true, payload: output };
      },
    });
    const sessions = new MemorySessionPort();
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions }));
    t.after(() => kernel.dispose());
    const session = sessionRef("structured");
    const events = await collect(kernel.run(runRequest({ runId: "run-structured", session })));
    output.value.answer = 0;
    assert.deepEqual(events[0].payload, { format: "json", value: { answer: 42 } });
    assert.deepEqual(sessions.read(session)[0].payload, { format: "json", value: { answer: 42 } });
  });

  test(`${name}: versioned Render Intent is data-only and can be logged as a Kernel event`, async (t) => {
    const intent = createRenderIntent({
      intentId: "intent-result-card",
      version: "1",
      kind: "result.card",
      payload: { title: "Safe result" },
    });
    const loop = createScriptedAgentLoop({
      onRun: async function* () {
        yield { type: "render.intent", modelVisible: true, payload: intent };
      },
    });
    const sessions = new MemorySessionPort();
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions }));
    t.after(() => kernel.dispose());
    const session = sessionRef("render-intent");
    const events = await collect(kernel.run(runRequest({ runId: "run-render-intent", session })));
    assert.equal(events[0].type, "render.intent");
    assert.deepEqual(sessions.read(session)[0].payload, intent);
    assert.ok(Object.isFrozen(events[0].payload));
  });

  test(`${name}: provider failures become safe Kernel events without provider payload leakage`, async (t) => {
    const loop = createScriptedAgentLoop({
      onRun: async function* () {
        const error = new Error("provider returned api_key=do-not-leak");
        error.code = "provider_unavailable";
        throw error;
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort() }));
    t.after(() => kernel.dispose());
    const events = await collect(kernel.run(runRequest({ runId: "run-provider-failure", session: sessionRef("provider") })));
    assert.deepEqual(events.map((event) => event.type), ["run.failed"]);
    assert.equal(events[0].payload.code, "provider_unavailable");
    assert.ok(!JSON.stringify(events[0]).includes("api_key"));
  });

  test(`${name}: a subagent lives in a child Context and leaves no live Effect`, async (t) => {
    let childDisposed = false;
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        const child = input.context.child({ scope: "subagent:research" });
        child.effect(() => { childDisposed = true; });
        yield { type: "subagent.started", modelVisible: false, payload: { subagentId: "research-1" } };
        await child.dispose();
        yield { type: "subagent.completed", modelVisible: true, payload: { subagentId: "research-1", summary: "done" } };
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort() }));
    t.after(() => kernel.dispose());
    const events = await collect(kernel.run(runRequest({ runId: "run-subagent", session: sessionRef("subagent") })));
    assert.deepEqual(events.map((event) => event.type), ["subagent.started", "subagent.completed", "run.completed"]);
    assert.equal(childDisposed, true);
  });

  test(`${name}: uncertain side effects are not upgraded into success`, async (t) => {
    const pipeline = createToolPipeline({
      validate: async (call) => call,
      systemGuard: { check: async () => ({ status: "allowed" }) },
      approval: { request: async () => ({ status: "approved" }) },
      gateway: { execute: async () => ({ status: "uncertain", effectId: "effect-unknown", code: "effect_outcome_unknown" }) },
    });
    let result;
    const loop = createScriptedAgentLoop({
      onRun: async function* (input) {
        result = await input.tools.execute({ toolId: "notes.send", effectClass: "external_write", input: { text: "send" } });
      },
    });
    const sessions = new MemorySessionPort();
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: sessions, toolPipeline: pipeline }));
    t.after(() => kernel.dispose());
    const session = sessionRef("uncertain");
    const events = await collect(kernel.run(runRequest({
      runId: "run-uncertain",
      session,
      executionGrant: grant("grant-uncertain", { allowedToolIds: ["notes.send"], allowedEffectClasses: ["external_write"] }),
    })));
    assert.equal(result.status, "uncertain");
    assert.deepEqual(events.map((event) => event.type), ["tool.requested", "effect.uncertain", "run.completed"]);
    assert.deepEqual(sessions.read(session).map((event) => event.type), ["tool.requested", "effect.uncertain"]);
  });

  test(`${name}: production Profile keeps T0/T1 providers pinned and unloads every Effect`, async (t) => {
    assert.throws(() => composeKernelProfile({
      id: "profile-conflict",
      revision: "1",
      plugins: [
        plugin({ id: "system-gateway", trust: "T1", provides: ["system.gateway"] }),
        plugin({ id: "workspace-override", trust: "T2", provides: ["system.gateway"] }),
      ],
    }), errorWithCode("kernel_service_provider_conflict"));
    assert.throws(() => composeKernelProfile({
      id: "profile-ephemeral",
      revision: "1",
      mode: "production_locked",
      plugins: [plugin({ id: "ephemeral", trust: "T4", lifetime: "ephemeral", contentHash: `sha256:${"a".repeat(64)}` })],
    }), errorWithCode("kernel_profile_ephemeral_plugin_forbidden"));

    let setupCount = 0;
    let disposeCount = 0;
    let observedMessages = 0;
    const profile = {
      id: "profile-lifecycle",
      revision: "1",
      plugins: [plugin({
        id: "system-observer",
        trust: "T1",
        provides: ["system.observer"],
        setup: (ctx) => {
          setupCount += 1;
          ctx.provide("system.observer", { active: true });
          ctx.on("message", () => { observedMessages += 1; });
          return () => { disposeCount += 1; };
        },
      })],
    };
    const loop = createScriptedAgentLoop({
      onRun: async function* () {
        yield { type: "message", modelVisible: true, payload: { role: "assistant", text: "observed" } };
      },
    });
    const kernel = assertAgentKernelPort(await createKernel({ loop, sessionPort: new MemorySessionPort(), profile }));
    t.after(() => kernel.dispose());
    await collect(kernel.run(runRequest({ runId: "run-profile-one", session: sessionRef("profile-one") })));
    await collect(kernel.run(runRequest({ runId: "run-profile-two", session: sessionRef("profile-two") })));
    assert.equal(setupCount, 1);
    assert.equal(observedMessages, 2);
    assert.equal(kernel.capabilities().profile.plugins[0].id, "system-observer");
    await kernel.dispose();
    assert.equal(disposeCount, 1);
  });
}

function runRequest({ runId, session, executionGrant = grant(`grant-${runId}`), input = { message: "test" } } = {}) {
  return { runId, session, executionGrant, input };
}

function sessionRef(name) {
  return { sessionId: `session-${name}`, branchId: `branch-${name}` };
}

function grant(grantId, overrides = {}) {
  return createExecutionGrant({
    grantId,
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: ["notes.read", "notes.write", "notes.send"],
    allowedEffectClasses: ["read", "write_local", "external_write"],
    maxToolCalls: 4,
    ...overrides,
  });
}

function plugin({ id, trust = "T2", lifetime = "profile", contentHash, requires = [], provides = [], setup = () => {} } = {}) {
  return { id, version: "1", trust, lifetime, contentHash, requires, provides, setup };
}

function errorWithCode(code) {
  return (error) => error instanceof AgentKernelError && error.code === code;
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}
