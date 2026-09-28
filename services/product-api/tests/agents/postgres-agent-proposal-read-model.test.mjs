import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresAgentProposalReadModel } from "../../src/agents/postgres-agent-proposal-read-model.mjs";

function storeWith(rows) {
  return {
    async connect() {},
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => { assert.match(text, /FROM public\.agent_object_proposals/); assert.deepEqual(values, ["proposal-alpha", "session-alpha", "workspace-alpha", "alice"]); return { rows }; } }); },
    async withTransaction(work) { return work({}); },
  };
}
const proposal = { proposal_id: "proposal-alpha", workspace_id: "workspace-alpha", user_id: "alice", session_id: "session-alpha", turn_id: "turn-alpha", branch_id: "branch-alpha", schema_version: "workbench-v1", definition_id: "loop_creator", object_kind: "workflow", object_id: "workflow-alpha", base_version_id: "revision-alpha", status: "proposed", created_by: "alice", created_at: "2026-08-10T00:00:00.000Z", decided_at: null, payload: { summary: "Add a review step", operations: [{ op: "add", path: "/graph/nodes/-", value: {} }], evidenceRefs: [], validationResult: { status: "passed", diagnostics: [] } } };

test("PostgreSQL Agent proposal read model is session, workspace, and principal scoped", async () => {
  const model = new PostgresAgentProposalReadModel({ store: storeWith([proposal]) });
  const result = await model.getProposal({ proposalId: "proposal-alpha", sessionId: "session-alpha", workspaceId: "workspace-alpha", userId: "alice" });
  assert.equal(result.objectId, "workflow-alpha");
  assert.equal(result.summary, "Add a review step");
});

test("Application reads an Agent proposal through the injected PostgreSQL owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    agentTurnRunner: { async getSession() { return { scope: { branchId: "branch-alpha" } }; } },
    workflowReadModel: { async getWorkflow() { return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, etag: '"workflow:workflow-alpha:1"' }; } },
    agentProposalReadModel: { async getProposal(input) { calls.push(input); return { proposalId: "proposal-alpha", sessionId: "session-alpha", userId: "alice", createdBy: "alice", branchId: "branch-alpha", objectKind: "workflow", objectId: "workflow-alpha" }; } },
  });
  const result = await application.getAgentProposal({ sessionId: "session-alpha", proposalId: "proposal-alpha", auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(result.proposalId, "proposal-alpha");
  assert.deepEqual(calls, [{ proposalId: "proposal-alpha", sessionId: "session-alpha", workspaceId: "workspace-alpha", userId: "alice" }]);
});
