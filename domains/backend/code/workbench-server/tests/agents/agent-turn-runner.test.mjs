import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentTurnRunner,
  InMemoryAgentPersistence,
} from "../../src/agents/index.mjs";

const NOW = "2026-07-16T12:00:00.000Z";

function fixture({ executor, executionBroker } = {}) {
  let id = 0;
  const persistence = new InMemoryAgentPersistence();
  const runner = new AgentTurnRunner({
    persistence,
    executor: executor ?? { async execute({ turn }) { return { response: `done:${turn.message}` }; } },
    executionBroker,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++id}`,
    resolveBaseVersion: async ({ objectKind, objectId }) => `${objectKind}-version:${objectId}`,
  });
  return { runner, persistence };
}

test("module sessions, branches, transcripts, and permissions are isolated per collaborator", async () => {
  const { runner } = fixture();
  const alice = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const bob = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "bob",
    workspaceId: "workspace-alpha",
  });

  assert.notEqual(alice.sessionId, bob.sessionId);
  assert.notEqual(alice.scope.branchId, bob.scope.branchId);
  const turn = await runner.enqueueTurn({
    sessionId: alice.sessionId,
    message: "Alice-only draft change",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.waitForIdle(alice.sessionId);

  assert.equal(await runner.getSession(alice.sessionId, { userId: "bob", workspaceId: "workspace-alpha" }), null);
  assert.equal(await runner.getTurn(alice.sessionId, turn.turnId, { userId: "bob", workspaceId: "workspace-alpha" }), null);
  assert.equal((await runner.listMessages(alice.sessionId, { userId: "alice", workspaceId: "workspace-alpha" })).length, 2);
  assert.equal(await runner.listMessages(alice.sessionId, { userId: "bob", workspaceId: "workspace-alpha" }), null);
});

test("module session creation can resume only the current user's explicit active branch", async () => {
  const { runner } = fixture();
  const created = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const resumed = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    branchId: created.scope.branchId,
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(resumed.sessionId, created.sessionId);

  await assert.rejects(runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    branchId: created.scope.branchId,
    userId: "bob",
    workspaceId: "workspace-alpha",
  }), { code: "agent_branch_not_found" });
});

test("concurrent Module Session creation converges on one active personal branch", async () => {
  const { runner, persistence } = fixture();
  const request = {
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  };
  const [left, right] = await Promise.all([
    runner.createSession(request),
    runner.createSession(request),
  ]);
  assert.equal(left.sessionId, right.sessionId);
  assert.equal(left.scope.branchId, right.scope.branchId);
  assert.equal([...persistence.branches.values()].filter((branch) => branch.status === "active").length, 1);
});

test("turns in one session execute FIFO while different sessions can run concurrently", async () => {
  const order = [];
  const blockers = new Map();
  const { runner } = fixture({
    executor: {
      async execute({ session, turn }) {
        order.push(`start:${session.userId}:${turn.message}`);
        if (blockers.has(turn.message)) await blockers.get(turn.message);
        order.push(`end:${session.userId}:${turn.message}`);
        return { response: `done:${turn.message}` };
      },
    },
  });
  let releaseFirst;
  blockers.set("first", new Promise((resolve) => { releaseFirst = resolve; }));
  const alice = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const bob = await runner.createSession({ definitionId: "main", userId: "bob", workspaceId: "workspace-alpha" });
  await runner.enqueueTurn({ sessionId: alice.sessionId, message: "first", userId: "alice", workspaceId: "workspace-alpha" });
  await runner.enqueueTurn({ sessionId: alice.sessionId, message: "second", userId: "alice", workspaceId: "workspace-alpha" });
  await runner.enqueueTurn({ sessionId: bob.sessionId, message: "parallel", userId: "bob", workspaceId: "workspace-alpha" });
  await new Promise((resolve) => setImmediate(resolve));

  assert(order.includes("start:alice:first"));
  assert(order.includes("end:bob:parallel"));
  assert(!order.includes("start:alice:second"));
  releaseFirst();
  await Promise.all([runner.waitForIdle(alice.sessionId), runner.waitForIdle(bob.sessionId)]);
  assert(order.indexOf("end:alice:first") < order.indexOf("start:alice:second"));
});

test("one turn launches bounded workers concurrently with product-owned invocation records", async () => {
  const entered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executionBroker = {
    async execute(request) {
      entered.push(request);
      if (entered.length === 2) release();
      await gate;
      return { invocationId: request.invocationId, status: "completed", output: { ok: true } };
    },
  };
  const { runner } = fixture({
    executionBroker,
    executor: {
      async execute({ runWorkers }) {
        const results = await runWorkers([
          { goal: "worker one", isolation: "process" },
          { goal: "worker two", isolation: "process" },
        ]);
        return { response: "workers complete", workerResults: results };
      },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const queued = await runner.enqueueTurn({ sessionId: session.sessionId, message: "parallelize", userId: "alice", workspaceId: "workspace-alpha" });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, queued.turnId, { userId: "alice", workspaceId: "workspace-alpha" });

  assert.equal(entered.length, 2);
  assert.notEqual(entered[0].invocationId, entered[1].invocationId);
  assert(entered.every((request) => request.controller.kind === "agent_turn" && request.controller.controllerId === queued.turnId));
  assert.equal(completed.result.invocationIds.length, 2);
});

test("steer affects only the running turn and does not create another turn", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const steers = [];
  const { runner } = fixture({
    executor: {
      async execute() { started(); await gate; return { response: "steered" }; },
      async steer({ message }) { steers.push(message); },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const turn = await runner.enqueueTurn({ sessionId: session.sessionId, message: "start", userId: "alice", workspaceId: "workspace-alpha" });
  await startedPromise;
  await runner.steer({ sessionId: session.sessionId, turnId: turn.turnId, message: "focus", userId: "alice", workspaceId: "workspace-alpha" });
  release();
  await runner.waitForIdle(session.sessionId);

  assert.deepEqual(steers, ["focus"]);
  assert.equal((await runner.listMessages(session.sessionId, { userId: "alice", workspaceId: "workspace-alpha" })).filter((item) => item.kind === "turn").length, 1);
});

test("module handoff is a capsule and never copies its transcript", async () => {
  const { runner } = fixture({
    executor: {
      async execute() {
        return {
          response: "proposal ready",
          handoff: {
            importantState: ["Proposal is ready"],
            decisions: ["Keep deterministic default"],
            risks: ["Provider unavailable"],
            artifactRefs: ["artifact-1"],
            transcript: ["must not leak"],
          },
        };
      },
    },
  });
  const main = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const module = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-a",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn({ sessionId: module.sessionId, message: "change it", userId: "alice", workspaceId: "workspace-alpha" });
  await runner.waitForIdle(module.sessionId);
  const [handoff] = await runner.listHandoffs({ sessionId: main.sessionId, userId: "alice", workspaceId: "workspace-alpha" });

  assert.deepEqual(handoff.importantState, ["Proposal is ready"]);
  assert.equal(Object.hasOwn(handoff, "transcript"), false);
});

test("turn cancellation records intent, cancels child invocations, then aborts the active executor", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const cancelledInvocations = [];
  const executionBroker = {
    async execute(request, { signal }) {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { invocationId: request.invocationId, status: "cancelled" };
    },
    async cancel(invocationId) { cancelledInvocations.push(invocationId); },
  };
  const { runner } = fixture({
    executionBroker,
    executor: {
      async execute({ runWorkers }) {
        await runWorkers([{ goal: "long worker", isolation: "process" }]);
        return { response: "late result" };
      },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const turn = await runner.enqueueTurn({ sessionId: session.sessionId, message: "start", userId: "alice", workspaceId: "workspace-alpha" });
  await startedPromise;
  await runner.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId, userId: "alice", workspaceId: "workspace-alpha", reason: "stop" });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, turn.turnId, { userId: "alice", workspaceId: "workspace-alpha" });

  assert.equal(cancelledInvocations.length, 1);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.result.response, "Turn cancelled.");
});
