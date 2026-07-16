import assert from "node:assert/strict";
import test from "node:test";

import { ProductAgentProposalService } from "../../src/agents/index.mjs";

test("Agent proposal storage derives object identity from the personal Module Session", async () => {
  const records = [];
  const store = {
    repositories: null,
    async connect() {
      this.repositories = {
        agentObjectProposals: {
          async insert(value) { records.push(structuredClone(value)); return structuredClone(value); },
        },
      };
    },
  };
  const service = new ProductAgentProposalService({
    store,
    clock: () => "2026-07-17T01:00:00.000Z",
    idFactory: () => "agent-proposal-alpha",
  });
  const session = {
    sessionId: "agent-session-alpha",
    definitionId: "loop_creator",
    userId: "alice",
    workspaceId: "workspace-alpha",
    scope: {
      kind: "module",
      objectKind: "workflow",
      objectId: "workflow-alpha",
      branchId: "agent-branch-alpha",
      baseVersionId: "revision-alpha",
    },
  };
  const saved = await service.createFromAgent({
    session,
    turn: { turnId: "agent-turn-alpha", sessionId: session.sessionId },
    proposal: {
      summary: "Update the definition.",
      objectId: "attacker-controlled-object",
      operations: [{ op: "replace", path: "/definition/goal", value: "A governed goal" }],
      evidenceRefs: ["artifact-alpha", "artifact-alpha"],
      validationResult: { status: "passed", diagnostics: [] },
    },
  });

  assert.equal(saved.proposalId, "agent-proposal-alpha");
  assert.equal(saved.objectId, "workflow-alpha");
  assert.equal(saved.branchId, "agent-branch-alpha");
  assert.equal(saved.baseVersionId, "revision-alpha");
  assert.equal(saved.createdBy, "alice");
  assert.deepEqual(saved.evidenceRefs, ["artifact-alpha"]);
  assert.equal(records.length, 1);
});

test("Agent proposal storage rejects invalid paths and failed worker validation", async () => {
  const service = new ProductAgentProposalService({
    store: {
      async connect() {},
      repositories: { agentObjectProposals: { async insert(value) { return value; } } },
    },
    clock: () => "2026-07-17T01:00:00.000Z",
    idFactory: () => "agent-proposal-alpha",
  });
  const session = {
    sessionId: "agent-session-alpha",
    definitionId: "skill_creator",
    userId: "alice",
    workspaceId: "workspace-alpha",
    scope: {
      kind: "module",
      objectKind: "skill_draft",
      objectId: "skill-draft-alpha",
      branchId: "agent-branch-alpha",
      baseVersionId: "skill-draft-alpha:1",
    },
  };
  await assert.rejects(service.createFromAgent({
    session,
    turn: { turnId: "agent-turn-alpha", sessionId: session.sessionId },
    proposal: {
      summary: "Unsafe path.",
      operations: [{ op: "replace", path: "not-a-json-pointer", value: true }],
      evidenceRefs: [],
      validationResult: { status: "passed", diagnostics: [] },
    },
  }), { code: "agent_proposal_operation_invalid" });
  await assert.rejects(service.createFromAgent({
    session,
    turn: { turnId: "agent-turn-alpha", sessionId: session.sessionId },
    proposal: {
      summary: "Failed validation.",
      operations: [{ op: "replace", path: "/description", value: "changed" }],
      evidenceRefs: [],
      validationResult: { status: "failed", diagnostics: [] },
    },
  }), { code: "agent_proposal_validation_failed" });
});
