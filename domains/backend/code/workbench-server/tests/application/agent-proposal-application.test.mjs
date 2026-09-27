import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const NOW = "2026-07-29T09:00:00.000Z";

function skillDraft({ description = "Base description", revision = 3 } = {}) {
  return {
    schemaVersion: "workbench-v1",
    skillDraftId: "skill-draft-a",
    skillId: "skill-a",
    revision,
    baseVersionId: null,
    name: "Research",
    description,
    category: "research",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    risk: { level: "low", externalAction: false, summary: "Read only." },
    dependencies: [],
    connectionRequirements: [],
    files: [],
    executionRef: null,
    updatedBy: "user-a",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture({ currentDraft = skillDraft(), operation, allowCollaborator = false } = {}) {
  const baseDraft = skillDraft();
  const proposal = {
    schemaVersion: "workbench-v1",
    proposalId: "agent-proposal-a",
    workspaceId: "workspace-a",
    userId: "user-a",
    sessionId: "agent-session-a",
    turnId: "agent-turn-a",
    definitionId: "skill_creator",
    objectKind: "skill_draft",
    objectId: "skill-draft-a",
    branchId: "agent-branch-a",
    baseVersionId: "skill-draft-a:3",
    summary: "Update the Skill draft.",
    operations: [operation ?? {
      op: "replace",
      path: "/category",
      value: "analysis",
    }],
    evidenceRefs: [],
    validationResult: { status: "passed", diagnostics: [] },
    status: "proposed",
    createdBy: "user-a",
    createdAt: NOW,
    decidedAt: null,
  };
  const branch = {
    branchId: "agent-branch-a",
    workspaceId: "workspace-a",
    userId: "user-a",
    objectKind: "skill_draft",
    objectId: "skill-draft-a",
    baseVersionId: proposal.baseVersionId,
    baseSnapshot: baseDraft,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const conflicts = [];
  const updates = [];
  const idempotencyScopes = [];
  const agentSession = {
    sessionId: proposal.sessionId,
    workspaceId: proposal.workspaceId,
    userId: proposal.userId,
    status: "active",
    taskStatus: "completed",
  };
  const repo = (record, idField) => ({
    async get(id, { workspaceId } = {}) {
      return record[idField] === id && (!workspaceId || record.workspaceId === workspaceId)
        ? structuredClone(record)
        : null;
    },
    async patch(id, patch) {
      assert.equal(id, record[idField]);
      Object.assign(record, structuredClone(patch));
      return structuredClone(record);
    },
  });
  const store = {
    async connect() {},
    async authorizeWorkspace({ userId, workspaceId }) {
      if (
        workspaceId !== "workspace-a"
        || (!allowCollaborator && userId !== "user-a")
      ) {
        const error = new Error("forbidden");
        error.code = "workspace_access_forbidden";
        throw error;
      }
      return { role: "member" };
    },
    async runIdempotentMutation(options, mutation) {
      idempotencyScopes.push(options.scope);
      return mutation({ transaction: true });
    },
    async getSkillDraft({ skillId, draftId, workspaceId }) {
      if (
        skillId !== "skill-a"
        || draftId !== currentDraft.skillDraftId
        || workspaceId !== "workspace-a"
      ) return null;
      return {
        skill: {
          skillId,
          workspaceId,
          ownerId: "user-a",
          lifecycle: "draft",
          currentDraftId: draftId,
        },
        draft: structuredClone(currentDraft),
      };
    },
    async updateSkillDraft(input) {
      updates.push(structuredClone(input));
      return {
        draft: {
          ...structuredClone(currentDraft),
          ...structuredClone(input.request.data),
          revision: currentDraft.revision + 1,
        },
      };
    },
    repositories: {
      agentObjectProposals: repo(proposal, "proposalId"),
      agentBranches: repo(branch, "branchId"),
      agentSessions: repo(agentSession, "sessionId"),
      skillDrafts: {
        async get(id) {
          return id === currentDraft.skillDraftId ? structuredClone(currentDraft) : null;
        },
      },
      skillAssets: {
        async get(id) {
          return id === "skill-a"
            ? {
                skillId: "skill-a",
                workspaceId: "workspace-a",
                ownerId: "user-a",
                lifecycle: "draft",
                currentDraftId: "skill-draft-a",
              }
            : null;
        },
      },
      mergeConflicts: {
        collection: { async updateMany() {} },
        async insert(value) {
          conflicts.push(structuredClone(value));
          return value;
        },
      },
      auditEvents: { async append(value) { return value; } },
    },
  };
  const agentTurnRunner = {
    async getSession(sessionId, context) {
      if (sessionId !== proposal.sessionId || context.userId !== proposal.userId) return null;
      return {
        sessionId,
        userId: proposal.userId,
        workspaceId: proposal.workspaceId,
        scope: { kind: "module", branchId: proposal.branchId },
      };
    },
  };
  return {
    application: createWorkbenchApplication({
      store,
      agentTurnRunner,
      clock: () => NOW,
      idFactory: (kind) => `${kind}-${conflicts.length + 1}`,
    }),
    proposal,
    branch,
    agentSession,
    conflicts,
    updates,
    idempotencyScopes,
  };
}

const auth = { userId: "user-a", activeWorkspaceId: "workspace-a" };
const request = { schemaVersion: "workbench-api-v1", data: {} };

test("confirmed Skill Agent proposal applies a validated patch and closes its personal branch", async () => {
  const {
    application,
    proposal,
    branch,
    agentSession,
    updates,
    idempotencyScopes,
  } = fixture();

  const result = await application.applyAgentProposal({
    sessionId: proposal.sessionId,
    proposalId: proposal.proposalId,
    idempotencyKey: "apply-agent-proposal-a",
    request,
    auth,
  });

  assert.equal(result.status, "accepted");
  assert.equal(branch.status, "merged");
  assert.equal(agentSession.status, "closed");
  assert.deepEqual(updates[0].request.data, { category: "analysis" });
  assert.deepEqual(idempotencyScopes, [
    `apply-agent-proposal:${proposal.userId}:${proposal.sessionId}:${proposal.proposalId}`,
  ]);
});

test("same-field Skill Agent conflict leaves the canonical draft unchanged", async () => {
  const { application, proposal, conflicts, updates } = fixture({
    currentDraft: skillDraft({
      description: "Collaborator description",
      revision: 4,
    }),
    operation: {
      op: "replace",
      path: "/description",
      value: "Agent description",
    },
  });

  const result = await application.applyAgentProposal({
    sessionId: proposal.sessionId,
    proposalId: proposal.proposalId,
    idempotencyKey: "apply-conflicting-agent-proposal-a",
    request,
    auth,
  });

  assert.equal(result.status, "conflicting");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, "/description");
  assert.equal(updates.length, 0);
});

test("Agent proposal lookup does not reveal another user's personal branch", async () => {
  const { application, proposal } = fixture();

  await assert.rejects(
    application.getAgentProposal({
      sessionId: proposal.sessionId,
      proposalId: proposal.proposalId,
      auth: { userId: "user-b", activeWorkspaceId: "workspace-a" },
    }),
    (error) => ["workspace_access_forbidden", "agent_proposal_not_found"].includes(error.code),
  );
});

test("Agent proposal authorization runs before idempotency cache lookup for another collaborator", async () => {
  const { application, proposal, idempotencyScopes } = fixture({ allowCollaborator: true });

  await assert.rejects(
    application.rejectAgentProposal({
      sessionId: proposal.sessionId,
      proposalId: proposal.proposalId,
      idempotencyKey: "shared-key",
      request,
      auth: { userId: "user-b", activeWorkspaceId: "workspace-a" },
    }),
    (error) => error.code === "agent_proposal_not_found",
  );
  assert.deepEqual(idempotencyScopes, []);
});

test("a read-only Loop collaborator cannot apply a personal Agent proposal to the canonical Loop", async () => {
  let mutationCalls = 0;
  let saveCalls = 0;
  const proposal = {
    schemaVersion: "workbench-v1",
    proposalId: "proposal-read-only",
    workspaceId: "workspace-a",
    userId: "user-b",
    createdBy: "user-b",
    sessionId: "session-read-only",
    turnId: "turn-read-only",
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    branchId: "branch-read-only",
    baseVersionId: "revision-1",
    summary: "Try to change a shared Loop.",
    operations: [{ op: "replace", path: "/definition/goal", value: "Changed" }],
    evidenceRefs: [],
    validationResult: { status: "passed", diagnostics: [] },
    status: "proposed",
    createdAt: NOW,
    decidedAt: null,
  };
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async listActiveObjectAccessGrants() { return []; },
    async getWorkflow(workflowId) {
      return {
        workflow: {
          workflowId,
          workspaceId: "workspace-a",
          ownerId: "user-a",
          visibility: "workspace",
          currentRevisionId: "revision-1",
        },
        etag: '"revision-1"',
      };
    },
    async runIdempotentMutation(_options, mutation) {
      mutationCalls += 1;
      return mutation({ transaction: true });
    },
    async saveWorkflowRevision() {
      saveCalls += 1;
      throw new Error("save_must_not_run");
    },
    repositories: {
      agentObjectProposals: {
        async get(id) { return id === proposal.proposalId ? structuredClone(proposal) : null; },
      },
      agentBranches: {
        async get() { throw new Error("branch_must_not_be_read"); },
      },
    },
  };
  const application = createWorkbenchApplication({
    store,
    agentTurnRunner: {
      async getSession() {
        return {
          sessionId: proposal.sessionId,
          userId: proposal.userId,
          workspaceId: proposal.workspaceId,
          scope: { kind: "module", branchId: proposal.branchId },
        };
      },
    },
  });

  await assert.rejects(
    () => application.applyAgentProposal({
      sessionId: proposal.sessionId,
      proposalId: proposal.proposalId,
      idempotencyKey: "read-only-apply",
      request,
      auth: { userId: "user-b", activeWorkspaceId: "workspace-a" },
    }),
    (error) => error?.code === "agent_object_forbidden",
  );
  assert.equal(mutationCalls, 0);
  assert.equal(saveCalls, 0);
});
