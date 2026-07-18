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
    executor: executor ?? {
      async execute({ turn }) {
        return {
          response: `done:${turn.input.message}`,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
    executionBroker,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++id}`,
    resolveBaseVersion: async ({ objectKind, objectId }) => `${objectKind}-version:${objectId}`,
    resolveModelSelection: async ({ modelProfileRevisionId, requiredCapabilities }) => ({
      revisionId: modelProfileRevisionId,
      capability: requiredCapabilities.includes("tool_calling") ? "tool_calling" : requiredCapabilities[0],
    }),
  });
  return { runner, persistence };
}

function agentTurn(sessionId, message, userId = "alice", revisionId = "model-revision-chat-1") {
  return {
    sessionId,
    kind: "agent_message",
    modelProfileRevisionId: revisionId,
    input: { message },
    userId,
    workspaceId: "workspace-alpha",
  };
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
  const turn = await runner.enqueueTurn(agentTurn(alice.sessionId, "Alice-only draft change"));
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

test("Session model selection is only a last-used preference", async () => {
  const { runner } = fixture();
  const session = await runner.createSession({
    definitionId: "main",
    modelProfileId: "deepseek-default",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(session.lastUsedModelProfileId, "deepseek-default");
  assert.equal(session.modelPreferenceState, "preference_only");
  const updated = await runner.selectModel({
    sessionId: session.sessionId,
    modelProfileId: "claude-sonnet",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(updated.lastUsedModelProfileId, "claude-sonnet");
  assert.equal((await runner.getSession(session.sessionId, {
    userId: "alice", workspaceId: "workspace-alpha",
  })).lastUsedModelProfileId, "claude-sonnet");
});

test("a queued Turn keeps its exact revision after the Session preference changes", async () => {
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const seen = [];
  const { runner } = fixture({
    executor: {
      async execute({ turn }) {
        seen.push(turn.requestedModelRevisionId);
        if (seen.length === 1) {
          firstStarted();
          await firstGate;
        }
        return {
          response: "done",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    lastUsedModelProfileId: "profile-old",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn(agentTurn(session.sessionId, "first", "alice", "model-revision-chat-1"));
  await firstStartedPromise;
  const queued = await runner.enqueueTurn(agentTurn(
    session.sessionId,
    "second",
    "alice",
    "model-revision-chat-2",
  ));
  await runner.selectModel({
    sessionId: session.sessionId,
    lastUsedModelProfileId: "profile-new",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  releaseFirst();
  await runner.waitForIdle(session.sessionId);

  assert.deepEqual(seen, ["model-revision-chat-1", "model-revision-chat-2"]);
  const completed = await runner.getTurn(
    session.sessionId,
    queued.turnId,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.equal(completed.requestedModelRevisionId, "model-revision-chat-2");
  assert.equal(completed.actualModelRevisionId, "model-revision-chat-2");
});

test("Turn enqueue rejects a resolver that substitutes another revision", async () => {
  let id = 0;
  const runner = new AgentTurnRunner({
    persistence: new InMemoryAgentPersistence(),
    executor: { async execute() { return {}; } },
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++id}`,
    resolveBaseVersion: async () => "version-1",
    resolveModelSelection: async () => ({ revisionId: "model-revision-substitute" }),
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await assert.rejects(
    runner.enqueueTurn(agentTurn(session.sessionId, "do not reroute")),
    { code: "agent_model_revision_not_exact" },
  );
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
  const routes = [];
  const blockers = new Map();
  const { runner } = fixture({
    executor: {
      async execute({ session, turn }) {
        const message = turn.input.message;
        routes.push(`${session.userId}:${turn.requestedModelRevisionId}`);
        order.push(`start:${session.userId}:${message}`);
        if (blockers.has(message)) await blockers.get(message);
        order.push(`end:${session.userId}:${message}`);
        return {
          response: `done:${message}`,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  let releaseFirst;
  blockers.set("first", new Promise((resolve) => { releaseFirst = resolve; }));
  const alice = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const bob = await runner.createSession({ definitionId: "main", userId: "bob", workspaceId: "workspace-alpha" });
  await runner.enqueueTurn(agentTurn(alice.sessionId, "first"));
  await runner.enqueueTurn(agentTurn(alice.sessionId, "second", "alice", "model-revision-chat-2"));
  await runner.enqueueTurn(agentTurn(bob.sessionId, "parallel", "bob", "model-revision-chat-3"));
  await new Promise((resolve) => setImmediate(resolve));

  assert(order.includes("start:alice:first"));
  assert(order.includes("end:bob:parallel"));
  assert(!order.includes("start:alice:second"));
  releaseFirst();
  await Promise.all([runner.waitForIdle(alice.sessionId), runner.waitForIdle(bob.sessionId)]);
  assert(order.indexOf("end:alice:first") < order.indexOf("start:alice:second"));
  assert(routes.includes("alice:model-revision-chat-2"));
  assert(routes.includes("bob:model-revision-chat-3"));
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
        return {
          response: "workers complete",
          workerResults: results,
          requestedModelRevisionId: "model-revision-chat-1",
          actualModelRevisionId: "model-revision-chat-1",
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "parallelize"));
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, queued.turnId, { userId: "alice", workspaceId: "workspace-alpha" });

  assert.equal(entered.length, 2);
  assert.notEqual(entered[0].invocationId, entered[1].invocationId);
  assert(entered.every((request) => request.controller.kind === "agent_turn" && request.controller.controllerId === queued.turnId));
  assert.equal(completed.result.invocationIds.length, 2);
});

test("model_task shares FIFO but dispatches one direct image model_call without Pi capabilities or fallback", async () => {
  const requests = [];
  const artifactRefs = [{ artifactId: "artifact-image-1", mediaType: "image/png" }];
  const executionBroker = {
    async execute(request) {
      requests.push(request);
      return {
        schemaVersion: "workbench-execution-fabric-v1",
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        status: "completed",
        isolation: "process",
        output: {
          kind: "image_generation",
          artifactRefs,
          seed: 7,
          format: "png",
          dimensions: { width: 1024, height: 1024 },
          safetyStatus: "passed",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            imageCount: 1,
            costUsdMicros: 1000,
          },
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
        },
        requestedModelRevisionId: request.modelProfileRevisionId,
        actualModelRevisionId: request.modelProfileRevisionId,
        artifactRefs,
      };
    },
  };
  const { runner } = fixture({ executionBroker });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const queued = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "model_task",
    modelProfileRevisionId: "model-revision-image-1",
    input: {
      task: "image_generation",
      prompt: "A small blue circle",
      aspectRatio: "1:1",
      outputFormat: "png",
    },
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(
    session.sessionId,
    queued.turnId,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, "model_call");
  assert.equal(requests[0].isolation, "process");
  assert.equal(requests[0].modelCapability, "image_generation");
  assert.deepEqual(requests[0].fallbackModelProfileRevisionIds, []);
  assert.deepEqual(requests[0].capabilities, {
    toolAllowlist: [],
    connectionIds: [],
    network: false,
    filesystem: "none",
    externalActions: false,
  });
  assert.equal(requests[0].limits.maxSteps, 1);
  assert.equal(requests[0].limits.maxChildren, 0);
  assert.equal(requests[0].limits.maxImageCount, 1);
  assert.equal(completed.result.kind, "model_task");
  assert.equal(completed.actualModelRevisionId, "model-revision-image-1");
  assert.deepEqual(completed.artifactRefs, artifactRefs);
  assert.deepEqual(completed.result.artifactRefs, artifactRefs);
  assert.equal(completed.result.invocationIds.length, 1);
});

test("cancelling a running model_task cancels its invocation and rejects a late model result", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const cancelled = [];
  const executionBroker = {
    async execute(request, { signal }) {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return {
        status: "completed",
        requestedModelRevisionId: request.modelProfileRevisionId,
        actualModelRevisionId: request.modelProfileRevisionId,
        artifactRefs: [{ artifactId: "late-artifact", mediaType: "image/png" }],
        output: {
          kind: "image_generation",
          artifactRefs: [{ artifactId: "late-artifact", mediaType: "image/png" }],
          seed: null,
          format: "png",
          dimensions: { width: 512, height: 512 },
          safetyStatus: "passed",
          usage: {
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            imageCount: 1, costUsdMicros: 1000,
          },
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
        },
      };
    },
    async cancel(invocationId) { cancelled.push(invocationId); },
  };
  const { runner } = fixture({ executionBroker });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "model_task",
    modelProfileRevisionId: "model-revision-image-1",
    input: { task: "image_generation", prompt: "Cancel this image." },
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await startedPromise;
  await runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "stop",
  });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(
    session.sessionId,
    turn.turnId,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.equal(cancelled.length, 1);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.result, null);
  assert.equal(completed.actualModelRevisionId, null);
  assert.deepEqual(completed.artifactRefs, []);
});

test("Turn history is authorized, sequence ordered, and bounded", async () => {
  const { runner } = fixture();
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn(agentTurn(session.sessionId, "one"));
  await runner.enqueueTurn(agentTurn(session.sessionId, "two"));
  await runner.waitForIdle(session.sessionId);

  const items = await runner.listTurns(
    session.sessionId,
    { after: 1, limit: 100_000 },
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.deepEqual(items.map((item) => item.sequence), [2]);
  assert.equal(await runner.listTurns(
    session.sessionId,
    {},
    { userId: "bob", workspaceId: "workspace-alpha" },
  ), null);
});

test("legacy Session and Turn reads are projected as legacy_unpinned without invented revisions", async () => {
  const persistence = new InMemoryAgentPersistence();
  persistence.sessions.set("legacy-session", {
    schemaVersion: "workbench-v1",
    sessionId: "legacy-session",
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
    scope: { kind: "main" },
    status: "active",
    modelProfileId: "legacy-profile",
    activeTurnId: null,
    turnSequence: 1,
    messageSequence: 0,
    eventSequence: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  persistence.turns.set("legacy-turn", {
    schemaVersion: "workbench-v1",
    turnId: "legacy-turn",
    sessionId: "legacy-session",
    sequence: 1,
    status: "completed",
    message: "legacy message",
    result: {
      response: "legacy response",
      proposalId: null,
      handoffId: null,
      invocationIds: [],
    },
    queuedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    updatedAt: NOW,
  });

  const session = await persistence.getSession("legacy-session", {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await persistence.getTurn("legacy-session", "legacy-turn", {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(session.lastUsedModelProfileId, "legacy-profile");
  assert.equal(session.modelPreferenceState, "legacy_unpinned");
  assert.equal(Object.hasOwn(session, "modelProfileId"), false);
  assert.equal(turn.modelRoutingState, "legacy_unpinned");
  assert.equal(Object.hasOwn(turn, "requestedModelRevisionId"), false);
  assert.equal(Object.hasOwn(turn, "actualModelRevisionId"), false);
});

test("steer affects only the running turn and does not create another turn", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const steers = [];
  const { runner } = fixture({
    executor: {
      async execute({ turn }) {
        started();
        await gate;
        return {
          response: "steered",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
      async steer({ message }) { steers.push(message); },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "start"));
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
      async execute({ turn }) {
        return {
          response: "proposal ready",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
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
  await runner.enqueueTurn(agentTurn(module.sessionId, "change it"));
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
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "start"));
  await startedPromise;
  await runner.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId, userId: "alice", workspaceId: "workspace-alpha", reason: "stop" });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, turn.turnId, { userId: "alice", workspaceId: "workspace-alpha" });

  assert.equal(cancelledInvocations.length, 1);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.result, null);
});
