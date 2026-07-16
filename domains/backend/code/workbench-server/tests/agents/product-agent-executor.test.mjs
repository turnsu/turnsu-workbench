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
    message: "Help with this object.",
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
  assert.equal(requests[0].capabilities.network, false);
  assert.equal(requests[0].capabilities.externalActions, false);
  assert.deepEqual(result, { response: "I coordinated the work." });
});

test("Module Agent output is persisted as a proposal and never mutates the canonical object", async () => {
  const created = [];
  const executor = createProductAgentExecutor({
    proposalService: {
      async createFromAgent(value) {
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
