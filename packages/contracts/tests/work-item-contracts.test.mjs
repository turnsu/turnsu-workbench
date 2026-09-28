import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_WORK_ITEM_ENDPOINTS,
} from "../dist/index.js";

const request = {
  schemaVersion: "workbench-api-v1",
  data: {
    title: "Prepare launch review",
    objective: "Give the team a decision-ready launch review.",
    summary: "The private task found two launch risks and one approved mitigation.",
    priority: "high",
    participants: [{ userId: "user-teammate", access: "contribute" }],
    decisions: [{
      question: "Which release window should the team use?",
      options: ["Tuesday", "Thursday"],
      chosenOutcome: "Thursday",
      rationale: "It leaves time for the regression fix.",
      evidenceRefs: ["evidence-release-window"],
      affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
    }],
    artifactIds: ["artifact-launch-preview"],
  },
};

test("Work Item promotion exposes only explicit product-safe sharing fields", () => {
  const endpoints = WORKBENCH_V1_WORK_ITEM_ENDPOINTS;
  assert.equal(endpoints.listProjects.path, "/api/workbench/v1/projects");
  assert.equal(endpoints.createProject.successStatus, 201);
  assert.deepEqual(endpoints.createProject.responseHeaders, ["Cache-Control", "ETag"]);
  assert.equal(Check(endpoints.createProject.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      title: "Launch program",
      objective: "Coordinate the team launch outcome.",
      members: [{ userId: "user-teammate" }],
    },
  }), true);
  assert.equal(Check(endpoints.createProject.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      title: "Launch program",
      objective: "Coordinate the team launch outcome.",
      sourceSessionId: "private-agent-session",
    },
  }), false, "a Project cannot carry a private Session pointer");
  assert.equal(endpoints.reviseProjectMembers.method, "PUT");
  assert.deepEqual(endpoints.reviseProjectMembers.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
  assert.equal(endpoints.listWorkItems.path, "/api/workbench/v1/work-items");
  assert.equal(endpoints.createTeamWorkItem.successStatus, 201);
  assert.deepEqual(endpoints.createTeamWorkItem.responseHeaders, ["Cache-Control", "ETag"]);
  assert.equal(Check(endpoints.createTeamWorkItem.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      projectId: "project-launch",
      title: "Launch review",
      objective: "Prepare the team launch review.",
      summary: "Only explicit product-safe context is shared.",
      members: [{
        userId: "user-teammate",
        access: "contribute",
        roles: ["assignee"],
      }],
    },
  }), true);
  assert.equal(Check(endpoints.createTeamWorkItem.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      title: "Launch review",
      objective: "Prepare the team launch review.",
      summary: "Only explicit product-safe context is shared.",
      members: [{ userId: "user-teammate", access: "read", roles: [] }],
    },
  }), false, "a Work Item member cannot have access without an explicit role");
  assert.equal(Check(endpoints.createTeamWorkItem.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      title: "Launch review",
      objective: "Prepare the team launch review.",
      summary: "Only explicit product-safe context is shared.",
      rawTranscript: "private provider payload",
    },
  }), false, "a direct Team Work Item cannot accept a raw transcript");
  assert.equal(endpoints.createTeamWorkItemAgentEntry.path, "/api/workbench/v1/work-items/agent-entry");
  assert.equal(endpoints.createTeamWorkItemAgentEntry.successStatus, 202);
  assert.deepEqual(endpoints.createTeamWorkItemAgentEntry.responseHeaders, ["Cache-Control", "ETag"]);
  assert.equal(Check(endpoints.createTeamWorkItemAgentEntry.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      projectId: "project-launch",
      title: "Launch review",
      objective: "Prepare the team launch review.",
      summary: "Only product-safe context becomes shared Work context.",
      modelProfileId: "model-profile-chat",
      initialTask: { message: "Draft the launch approval from the supplied brief." },
    },
  }), true);
  assert.equal(Check(endpoints.createTeamWorkItemAgentEntry.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      title: "Launch review",
      objective: "Prepare the team launch review.",
      summary: "Only product-safe context becomes shared Work context.",
      modelProfileId: "model-profile-chat",
      initialTask: { message: "Draft it." },
      rawTranscript: "private provider payload",
    },
  }), false, "an atomic Team Work entry cannot accept a private transcript");
  assert.deepEqual(endpoints.updateTeamWorkItem.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
  assert.equal(
    endpoints.promoteAgentSessionToWorkItem.path,
    "/api/workbench/v1/agent-sessions/{sessionId}/promote-to-work-item",
  );
  assert.equal(endpoints.promoteAgentSessionToWorkItem.successStatus, 201);
  assert.deepEqual(endpoints.promoteAgentSessionToWorkItem.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.equal(Check(endpoints.promoteAgentSessionToWorkItem.requestBodySchema, request), true);
  assert.equal(Check(endpoints.promoteAgentSessionToWorkItem.requestBodySchema, {
    ...request,
    data: { ...request.data, sourceSessionId: "agent-session-private" },
  }), false, "the client cannot place a private session pointer in a shared promotion request");
  assert.equal(Check(endpoints.promoteAgentSessionToWorkItem.requestBodySchema, {
    ...request,
    data: { ...request.data, rawTranscript: "private tool output" },
  }), false, "the client cannot attach a private transcript to a Work Item");
  assert.equal(
    endpoints.listWorkItemPromotionParticipants.path,
    "/api/workbench/v1/work-items/promotion-participants",
  );
  assert.deepEqual(endpoints.listWorkItemPromotionParticipants.responseHeaders, ["Cache-Control"]);
  assert.equal(Check(endpoints.listWorkItemPromotionParticipants.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [{
      userId: "user-teammate",
      displayName: "Teammate",
      username: "teammate",
      role: "member",
    }],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-work-item-participants",
  }), true);
  assert.equal(Check(endpoints.listWorkItemPromotionParticipants.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [{
      userId: "user-teammate",
      displayName: "Teammate",
      username: "teammate",
      role: "member",
      email: "teammate@example.test",
    }],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-work-item-participants",
  }), false, "participant selection must not expose an invitation email");
  assert.equal(endpoints.getWorkItem.method, "GET");
  assert.deepEqual(endpoints.getWorkItem.responseHeaders, ["Cache-Control", "ETag"]);
  assert.equal(endpoints.listWorkItemThreadEntries.method, "GET");
  assert.deepEqual(endpoints.listWorkItemThreadEntries.responseHeaders, ["Cache-Control"]);
  assert.equal(endpoints.createWorkItemThreadComment.method, "POST");
  assert.equal(endpoints.createWorkItemThreadComment.path, "/api/workbench/v1/work-items/{workItemId}/thread-entries");
  assert.equal(endpoints.createWorkItemThreadComment.successStatus, 201);
  assert.deepEqual(endpoints.createWorkItemThreadComment.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.deepEqual(endpoints.createWorkItemThreadComment.responseHeaders, ["Cache-Control"]);
  assert.equal(Check(endpoints.createWorkItemThreadComment.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: { content: "The teammate is ready to validate provider readiness." },
  }), true);
  assert.equal(Check(endpoints.createWorkItemThreadComment.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      content: "The teammate is ready to validate provider readiness.",
      sourceSessionId: "agent-session-private",
    },
  }), false, "a Work Thread comment cannot carry a private Session pointer");
  assert.equal(Check(endpoints.createWorkItemThreadComment.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      entryId: "work-thread-entry-comment",
      workItemId: "work-item-launch",
      workThreadId: "work-thread-launch",
      sequence: 2,
      kind: "comment",
      summary: "The teammate is ready to validate provider readiness.",
      handoffId: null,
      decisionId: null,
      artifactId: null,
      contentHash: `sha256:${"c".repeat(64)}`,
      createdByUserId: "user-teammate",
      occurredAt: "2026-08-11T00:00:00.000Z",
    },
    requestId: "request-work-item-comment",
  }), true);
  assert.equal(endpoints.recordWorkItemDecision.method, "POST");
  assert.equal(endpoints.recordWorkItemDecision.path, "/api/workbench/v1/work-items/{workItemId}/decisions");
  assert.equal(endpoints.recordWorkItemDecision.successStatus, 201);
  assert.deepEqual(endpoints.recordWorkItemDecision.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.deepEqual(endpoints.recordWorkItemDecision.responseHeaders, ["Cache-Control"]);
  assert.equal(Check(endpoints.recordWorkItemDecision.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      question: "Which readiness action should the team take?",
      options: ["Proceed", "Validate first"],
      chosenOutcome: "Validate first",
      rationale: "The accountable owner accepts the validation time.",
      evidenceRefs: ["evidence-provider-readiness"],
      affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
    },
  }), true);
  assert.equal(Check(endpoints.recordWorkItemDecision.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      question: "Which readiness action should the team take?",
      options: ["Proceed", "Validate first"],
      chosenOutcome: "Validate first",
      authorUserId: "user-supplied-author",
    },
  }), false, "the server derives Decision author and approver from accountable ownership");
  assert.equal(endpoints.createWorkItemContinuation.path, "/api/workbench/v1/work-items/{workItemId}/continuations");
  assert.equal(endpoints.createWorkItemContinuation.successStatus, 201);
  assert.deepEqual(endpoints.createWorkItemContinuation.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.deepEqual(endpoints.createWorkItemContinuation.responseHeaders, ["Cache-Control"]);
  assert.equal(Check(endpoints.createWorkItemContinuation.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {},
  }), true);
  assert.equal(Check(endpoints.createWorkItemContinuation.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: { sourceSessionId: "agent-session-private" },
  }), false, "a continuation is derived server-side and cannot accept a private Session pointer");
  assert.equal(endpoints.createWorkItemContinuationAgentEntry.path, "/api/workbench/v1/work-items/{workItemId}/agent-entry");
  assert.equal(endpoints.createWorkItemContinuationAgentEntry.successStatus, 202);
  assert.equal(Check(endpoints.createWorkItemContinuationAgentEntry.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      modelProfileId: "model-profile-chat",
      initialTask: { message: "Continue only from the shared handoff." },
    },
  }), true);
  assert.equal(Check(endpoints.createWorkItemContinuationAgentEntry.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      modelProfileId: "model-profile-chat",
      initialTask: { message: "Continue", sourceSessionId: "private-session" },
    },
  }), false, "the continuation entry never accepts a private Session pointer");
  assert.equal(Check(endpoints.createWorkItemContinuation.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      continuationId: "work-item-continuation-teammate",
      workItemId: "work-item-launch",
      agentSessionId: "agent-session-teammate",
      handoffId: "handoff-launch",
      createdAt: "2026-08-11T00:00:00.000Z",
    },
    requestId: "request-work-item-continuation",
  }), true);
  assert.equal(endpoints.revokeWorkItemAccessGrant.method, "POST");
});

test('shared comments accept bounded version identifiers but never client-supplied file contents or metadata', () => {
  const schema = WORKBENCH_V1_WORK_ITEM_ENDPOINTS.createWorkItemThreadComment.requestBodySchema;
  const body = data => ({ schemaVersion: 'workbench-api-v1', data });
  assert.equal(Check(schema, body({ content: '使用这份资料', fileRevisionIds: ['project-file-revision-one'] })), true);
  assert.equal(Check(schema, body({ content: '重复', fileRevisionIds: ['same', 'same'] })), false);
  assert.equal(Check(schema, body({ content: '过多', fileRevisionIds: ['a', 'b', 'c', 'd', 'e'] })), false);
  assert.equal(Check(schema, body({ content: '伪造', fileReferences: [{ path: 'private.txt', text: 'private content' }] })), false);
});
