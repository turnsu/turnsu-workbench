import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const auth = { userId: "user-owner", activeWorkspaceId: "workspace-team", role: "owner" };
const project = {
  schemaVersion: "workbench-v1",
  projectId: "project-launch",
  workspaceId: "workspace-team",
  scopeId: "scope-project-launch",
  title: "Launch",
  objective: "Ship the team launch safely.",
  status: "active",
  accountableOwnerUserId: "user-owner",
  members: [{ userId: "user-owner", role: "owner" }],
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  archivedAt: null,
};
const workItem = {
  schemaVersion: "workbench-v1",
  workItemId: "work-item-launch",
  workspaceId: "workspace-team",
  projectId: "project-launch",
  title: "Launch review",
  objective: "Prepare the decision-ready launch review.",
  status: "ready",
  priority: "high",
  accountableOwnerUserId: "user-owner",
  requestorUserId: "user-owner",
  members: [{
    userId: "user-owner",
    roles: ["accountable_owner", "requestor"],
    accessGrant: {
      grantId: "work-item-grant-owner",
      workItemId: "work-item-launch",
      userId: "user-owner",
      access: "owner",
      status: "active",
      createdAt: "2026-08-13T00:00:00.000Z",
      revokedAt: null,
    },
  }],
  source: { kind: "team_work_item" },
  dueAt: null,
  workThreadId: "work-thread-launch",
  authorizedBranchRefs: [],
  linkedLoopRef: null,
  runRefs: [],
  artifactRefs: [],
  decisionRefs: [],
  proposalRefs: [],
  blockedReason: null,
  nextAction: null,
  createdByUserId: "user-owner",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  completedAt: null,
};

function fixture() {
  const calls = [];
  const scheduled = [];
  const lifecycle = {
    async listProjects(input) { calls.push(["listProjects", input]); return [project]; },
    async createProject(input) { calls.push(["createProject", input]); return { data: project, etag: '"projectv1:project-launch:1"' }; },
    async getProject(input) { calls.push(["getProject", input]); return { data: project, etag: '"projectv1:project-launch:1"' }; },
    async reviseProjectMembers(input) { calls.push(["reviseProjectMembers", input]); return { data: project, etag: '"projectv1:project-launch:2"' }; },
    async listWorkItems(input) { calls.push(["listWorkItems", input]); return [workItem]; },
    async createTeamWorkItem(input) { calls.push(["createTeamWorkItem", input]); return { data: workItem, etag: '"workv1:work-item-launch:1"' }; },
    async createTeamWorkItemAgentEntry(input) {
      calls.push(["createTeamWorkItemAgentEntry", input]);
      return {
        data: {
          workItem,
          continuation: {
            continuationId: "work-item-continuation-launch",
            workItemId: workItem.workItemId,
            agentSessionId: "agent-session-launch",
            handoffId: "handoff-launch",
            createdAt: "2026-08-13T00:00:00.000Z",
          },
          turn: {
            schemaVersion: "workbench-v1",
            turnId: "agent-turn-launch",
            sessionId: "agent-session-launch",
            productCommandId: "product-command-launch",
            cancellationCommandId: null,
            sequence: 1,
            kind: "agent_message",
            status: "queued",
            internalStatus: null,
            modelRoutingState: "pinned",
            requestedModelRevisionId: "model-revision-launch",
            actualModelRevisionId: null,
            sessionEpoch: 1,
            turnFence: 1,
            input: { message: "Draft the launch plan." },
            result: null,
            artifactRefs: [],
            invocationIds: [],
            queuedAt: "2026-08-13T00:00:00.000Z",
            startedAt: null,
            finishedAt: null,
            updatedAt: "2026-08-13T00:00:00.000Z",
          },
        },
        etag: '"workv1:work-item-launch:1"',
      };
    },
    async createContinuationAgentEntry(input) {
      calls.push(["createContinuationAgentEntry", input]);
      return {
        continuation: {
          continuationId: "work-item-continuation-launch",
          workItemId: workItem.workItemId,
          agentSessionId: "agent-session-launch",
          handoffId: "handoff-launch",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        turn: {
          schemaVersion: "workbench-v1",
          turnId: "agent-turn-continuation-entry",
          sessionId: "agent-session-launch",
          productCommandId: "product-command-continuation-entry",
          cancellationCommandId: null,
          sequence: 1,
          kind: "agent_message",
          status: "queued",
          internalStatus: null,
          modelRoutingState: "pinned",
          requestedModelRevisionId: "model-revision-launch",
          actualModelRevisionId: null,
          sessionEpoch: 1,
          turnFence: 1,
          input: { message: "Continue the launch work." },
          result: null,
          artifactRefs: [],
          invocationIds: [],
          queuedAt: "2026-08-13T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      };
    },
    async updateTeamWorkItem(input) { calls.push(["updateTeamWorkItem", input]); return { data: workItem, etag: '"workv1:work-item-launch:2"' }; },
  };
  const store = { async connect() {} };
  const idempotentMutationPort = {
    async run(_options, mutation) { return mutation({ kind: "test-uow" }); },
  };
  return {
    calls,
    application: createWorkbenchApplication({
      store,
      workItemLifecycle: lifecycle,
      agentTurnRunner: { schedule(sessionId) { scheduled.push(sessionId); } },
      idempotentMutationPort,
    }),
    scheduled,
  };
}

test("Team Work application exposes Project and direct Work Item commands through one lifecycle owner", async () => {
  const { application, calls, scheduled } = fixture();
  const listedProjects = await application.listProjects({ auth });
  assert.equal(listedProjects.data[0].projectId, project.projectId);
  assert.deepEqual(listedProjects.responseHeaders, { "Cache-Control": "no-store" });

  const createdProject = await application.createProject({
    auth,
    idempotencyKey: "project-create",
    request: { schemaVersion: "workbench-api-v1", data: { title: project.title, objective: project.objective } },
  });
  assert.equal(createdProject.data.projectId, project.projectId);
  assert.equal(createdProject.etag, '"projectv1:project-launch:1"');

  const listedWork = await application.listWorkItems({ auth, query: { projectId: project.projectId } });
  assert.equal(listedWork.data[0].source.kind, "team_work_item");

  const createdWork = await application.createTeamWorkItem({
    auth,
    idempotencyKey: "work-create",
    request: { schemaVersion: "workbench-api-v1", data: {
      projectId: project.projectId,
      title: workItem.title,
      objective: workItem.objective,
      summary: "Only product-safe handoff context is shared.",
    } },
  });
  assert.equal(createdWork.data.workItemId, workItem.workItemId);
  assert.equal(createdWork.etag, '"workv1:work-item-launch:1"');

  const agentEntry = await application.createTeamWorkItemAgentEntry({
    auth,
    idempotencyKey: "work-agent-entry",
    request: { schemaVersion: "workbench-api-v1", data: {
      projectId: project.projectId,
      title: workItem.title,
      objective: workItem.objective,
      summary: "Only product-safe handoff context is shared.",
      modelProfileId: "model-profile-launch",
      initialTask: { message: "Draft the launch plan." },
    } },
  });
  assert.equal(agentEntry.data.continuation.agentSessionId, "agent-session-launch");
  assert.deepEqual(scheduled, ["agent-session-launch"]);

  const updatedWork = await application.updateTeamWorkItem({
    auth,
    workItemId: workItem.workItemId,
    idempotencyKey: "work-update",
    ifMatch: '"workv1:work-item-launch:1"',
    request: { schemaVersion: "workbench-api-v1", data: { status: "active" } },
  });
  assert.equal(updatedWork.etag, '"workv1:work-item-launch:2"');
  assert.equal(calls.some(([name]) => name === "createTeamWorkItem"), true);
  assert.equal(calls.some(([name]) => name === "createTeamWorkItemAgentEntry"), true);
  const continuationEntry = await application.createWorkItemContinuationAgentEntry({
    auth,
    workItemId: workItem.workItemId,
    idempotencyKey: "work-continuation-agent-entry",
    request: { schemaVersion: "workbench-api-v1", data: {
      modelProfileId: "model-profile-launch",
      initialTask: { message: "Continue the launch work." },
    } },
  });
  assert.equal(continuationEntry.data.continuation.workItemId, workItem.workItemId);
  assert.equal(continuationEntry.data.turn.productCommandId, "product-command-continuation-entry");
  assert.equal(calls.some(([name]) => name === "createContinuationAgentEntry"), true);
  assert.deepEqual(scheduled, ["agent-session-launch", "agent-session-launch"]);
  assert.equal(calls.some(([name]) => name === "updateTeamWorkItem"), true);
});
