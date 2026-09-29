import assert from "node:assert/strict";
import test from "node:test";

import { createProductAgentExecutor } from "../../src/agents/index.mjs";

const mainSession = {
  schemaVersion: "workbench-v1",
  sessionId: "agent-session-main",
  definitionId: "main",
  userId: "alice",
  workspaceId: "workspace-alpha",
  scope: { kind: "main" },
  status: "active",
  lastUsedModelProfileId: "deepseek-default",
  modelPreferenceState: "preference_only",
  activeTurnId: "agent-turn-main",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

const moduleSession = {
  ...mainSession,
  sessionId: "agent-session-module",
  definitionId: "loop_creator",
  activeTurnId: "agent-turn-module",
  scope: {
    kind: "module",
    objectKind: "workflow",
    objectId: "workflow-alpha",
    branchId: "agent-branch-alpha",
    baseVersionId: "revision-alpha",
  },
};

function turn(session, overrides = {}) {
  return {
    schemaVersion: "workbench-v1",
    turnId: session.activeTurnId,
    sessionId: session.sessionId,
    sequence: 1,
    status: "running",
    kind: "agent_message",
    modelRoutingState: "pinned",
    requestedModelRevisionId: "model-revision-chat-1",
    actualModelRevisionId: null,
    artifactRefs: [],
    modelCapability: "tool_calling",
    input: { message: "Help with this object." },
    result: null,
    queuedAt: "2026-07-17T00:00:00.000Z",
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

test("Main Agent turns always dispatch through one bounded container worker", async () => {
  const executor = createProductAgentExecutor();
  let requests;
  const result = await executor.execute({
    session: mainSession,
    turn: turn(mainSession),
    messages: [{ role: "user", kind: "turn", content: "Coordinate this work." }],
    async runWorkers(value) {
      requests = value;
      return [{
        status: "completed",
        output: { response: "I coordinated the work." },
        requestedModelRevisionId: "model-revision-chat-1",
        actualModelRevisionId: "model-revision-chat-1",
        artifactRefs: [],
        usage: {
          steps: 2,
          modelRequests: 1,
          inputBytes: 128,
          outputBytes: 64,
          imageCount: 0,
          costUsdMicros: 250,
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
        summary: "Agent completed.",
      }];
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, "bounded_agent");
  assert.equal(requests[0].isolation, "container");
  assert.equal(requests[0].metadata.definitionId, "main");
  assert.equal(requests[0].metadata.agentSessionId, mainSession.sessionId);
  assert.equal(requests[0].metadata.agentTurnId, mainSession.activeTurnId);
  assert.equal(requests[0].metadata.modelProfileRevisionId, "model-revision-chat-1");
  assert.equal(requests[0].metadata.modelCapability, "tool_calling");
  assert.deepEqual(requests[0].metadata.fallbackModelProfileRevisionIds, []);
  assert.equal(requests[0].capabilities.network, false);
  assert.equal(requests[0].capabilities.externalActions, false);
  assert.deepEqual(result, {
    response: "I coordinated the work.",
    requestedModelRevisionId: "model-revision-chat-1",
    actualModelRevisionId: "model-revision-chat-1",
    artifactRefs: [],
    usage: {
      steps: 2,
      modelRequests: 1,
      inputBytes: 128,
      outputBytes: 64,
      imageCount: 0,
      costUsdMicros: 250,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    },
  });
});

test("Module Agent output is prepared for atomic proposal settlement and never mutates the canonical object", async () => {
  const created = [];
  const executor = createProductAgentExecutor({
    proposalService: {
      async prepareFromAgent(value) {
        created.push(value);
        return { proposalId: "agent-proposal-alpha" };
      },
    },
  });
  const workerProposal = {
    summary: "Change the goal description.",
    operations: [{ op: "replace", path: "/definition/goal", value: "A governed goal" }],
    evidenceRefs: ["artifact-alpha"],
    validationResult: { status: "passed", diagnostics: [] },
  };
  const result = await executor.execute({
    session: moduleSession,
    turn: turn(moduleSession),
    messages: [{ role: "user", kind: "turn", content: "Improve the goal." }],
    async runWorkers() {
      return [{
        status: "completed",
        requestedModelRevisionId: "model-revision-chat-1",
        actualModelRevisionId: "model-revision-chat-1",
        artifactRefs: [],
        output: {
          response: "I prepared a proposal.",
          proposal: workerProposal,
          handoff: {
            importantState: ["Proposal prepared"],
            decisions: ["Keep the outer graph fixed"],
            risks: [],
            artifactRefs: ["artifact-alpha"],
          },
        },
        summary: "Agent completed.",
      }];
    },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].session.sessionId, moduleSession.sessionId);
  assert.equal(created[0].proposal, workerProposal);
  assert.equal(result.proposalId, "agent-proposal-alpha");
  assert.equal(result.response, "I prepared a proposal.");
  assert.deepEqual(result.handoff.importantState, ["Proposal prepared"]);
});

test("unavailable product execution is reported as a blocked Turn instead of a missing executor", async () => {
  const executor = createProductAgentExecutor();
  const result = await executor.execute({
    session: mainSession,
    turn: turn(mainSession),
    messages: [],
    async runWorkers() {
      return [{ status: "sandbox_unavailable", summary: "The required sandbox is unavailable." }];
    },
  });
  assert.deepEqual(result, {
    status: "blocked",
    response: "The required sandbox is unavailable.",
  });
});

test("interactive Agent execution rejects an unexpected cross-revision fallback", async () => {
  const executor = createProductAgentExecutor();
  await assert.rejects(() => executor.execute({
    session: mainSession,
    turn: turn(mainSession),
    messages: [],
    async runWorkers() {
      return [{
        status: "completed",
        requestedModelRevisionId: "model-revision-chat-1",
        actualModelRevisionId: "model-revision-chat-fallback",
        artifactRefs: [],
        output: { response: "unexpected fallback" },
      }];
    },
  }), { code: "product_agent_model_route_unverified" });
});

test("Module Agent cancellation prevents proposal preparation after its worker returns", async () => {
  let prepared = false;
  const controller = new AbortController();
  const executor = createProductAgentExecutor({
    proposalService: {
      async prepareFromAgent() {
        prepared = true;
        return { proposalId: "proposal-too-late" };
      },
    },
  });
  await assert.rejects(executor.execute({
    session: moduleSession,
    turn: turn(moduleSession),
    messages: [],
    signal: controller.signal,
    async runWorkers() {
      controller.abort();
      return [{
        status: "completed",
        requestedModelRevisionId: "model-revision-chat-1",
        actualModelRevisionId: "model-revision-chat-1",
        artifactRefs: [],
        output: {
          response: "Too late.",
          proposal: {
            summary: "Too late.",
            operations: [{ op: "replace", path: "/definition/goal", value: "late" }],
            evidenceRefs: [],
            validationResult: { status: "passed", diagnostics: [] },
          },
        },
      }];
    },
  }), { code: "agent_turn_cancelled" });
  assert.equal(prepared, false);
});
