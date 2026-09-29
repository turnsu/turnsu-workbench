import assert from "node:assert/strict";
import test from "node:test";

import { ProductClientProtocolError } from "../dist/index.js";
import { createWorkItemProductClient } from "../dist/work-items.js";

const workItemId = "work-item-launch";
const handoff = {
  handoffId: "handoff-launch",
  workItemId,
  summary: "The team can continue with the published launch review.",
  contentHash: `sha256:${"a".repeat(64)}`,
  createdByUserId: "user-owner",
  createdAt: "2026-08-11T00:00:00.000Z",
};
const grant = {
  grantId: "work-item-grant-owner",
  workItemId,
  userId: "user-owner",
  access: "owner",
  status: "active",
  createdAt: "2026-08-11T00:00:00.000Z",
  revokedAt: null,
};
const workItem = {
  schemaVersion: "workbench-v1",
  workItemId,
  workspaceId: "workspace-team",
  projectId: null,
  title: "Launch review",
  objective: "Coordinate the team launch review.",
  status: "ready",
  priority: "high",
  accountableOwnerUserId: "user-owner",
  requestorUserId: "user-owner",
  members: [{
    userId: "user-owner",
    roles: ["accountable_owner", "requestor"],
    accessGrant: grant,
  }],
  source: { kind: "private_agent_task" },
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
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
};
const promotionEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    workItem,
    handoffCapsule: handoff,
    decisions: [],
    initialThreadEntry: {
      entryId: "work-thread-entry-launch",
      workItemId,
      workThreadId: "work-thread-launch",
      sequence: 1,
      kind: "handoff",
      summary: handoff.summary,
      handoffId: handoff.handoffId,
      decisionId: null,
      artifactId: null,
      contentHash: `sha256:${"b".repeat(64)}`,
      createdByUserId: "user-owner",
      occurredAt: "2026-08-11T00:00:00.000Z",
    },
  },
  requestId: "request-work-item-promotion",
};

function jsonResponse(body, status = 201, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("shared Loop execution accepts the durable Run receipt without an unrelated entity ETag", async () => {
  const captures = [];
  const client = createWorkItemProductClient({
    csrfToken: () => "csrf-team-work",
    fetch: async (url, init) => {
      captures.push({ url, init });
      return jsonResponse({ schemaVersion: "workbench-api-v1", data: { workItemId, runId: "run-shared" }, requestId: "request-shared" }, 202, { "Cache-Control": "no-store" });
    },
  });
  const result = await client.call("startWorkItemLoopRun", {
    pathParams: { workItemId }, headers: { "Idempotency-Key": "shared-run-once" },
    body: { schemaVersion: "workbench-api-v1", data: {
      workflowId: "workflow-own-copy", workflowRevisionId: "revision-fixed", inputs: { goal: "Team result" }, resourceRefs: [], shareFinalOutput: true,
    } },
  });
  assert.equal(result.body.data.runId, "run-shared");
  assert.equal(captures.length, 1);
  assert.match(String(captures[0].url), /work-items\/work-item-launch\/loop-runs$/);
});

const promotionParticipantsEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: [{
    userId: "user-teammate",
    displayName: "Teammate",
    username: "teammate",
    role: "member",
  }],
  page: { nextCursor: null, hasMore: false },
  requestId: "request-work-item-participants",
};

const workItemDetailEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    workItem,
    handoffCapsule: handoff,
    decisions: [],
  },
  requestId: "request-work-item-detail",
};

const continuationEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    continuationId: "work-item-continuation-teammate",
    workItemId,
    agentSessionId: "agent-session-teammate",
    handoffId: handoff.handoffId,
    createdAt: "2026-08-11T00:00:00.000Z",
  },
  requestId: "request-work-item-continuation",
};

const commentEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    entryId: "work-thread-entry-comment",
    workItemId,
    workThreadId: "work-thread-launch",
    sequence: 2,
    kind: "comment",
    summary: "The teammate is ready to validate provider readiness.",
    handoffId: null,
    decisionId: null,
    artifactId: null,
    contentHash: `sha256:${"d".repeat(64)}`,
    createdByUserId: "user-teammate",
    occurredAt: "2026-08-11T00:00:00.000Z",
  },
  requestId: "request-work-item-comment",
};

const decisionEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: {
    decisionId: "work-item-decision-provider-readiness",
    workItemId,
    question: "Which readiness action should the team take?",
    options: ["Proceed", "Validate first"],
    chosenOutcome: "Validate first",
    rationale: "The accountable owner accepts the validation time.",
    evidenceRefs: ["evidence-provider-readiness"],
    affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
    authorUserId: "user-owner",
    approverUserId: "user-owner",
    supersedesDecisionId: null,
    createdAt: "2026-08-12T00:00:00.000Z",
  },
  requestId: "request-work-item-decision",
};

const project = {
  schemaVersion: "workbench-v1",
  projectId: "project-launch",
  workspaceId: "workspace-team",
  scopeId: "scope-project-launch",
  title: "Launch program",
  objective: "Coordinate the team launch outcome.",
  status: "active",
  accountableOwnerUserId: "user-owner",
  members: [{ userId: "user-owner", role: "owner" }],
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  archivedAt: null,
};
const projectEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: project,
  requestId: "request-project",
};
const projectListEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: [project],
  page: { nextCursor: null, hasMore: false },
  requestId: "request-project-list",
};
const teamWorkItem = {
  ...workItem,
  projectId: project.projectId,
  source: { kind: "team_work_item" },
};
const teamWorkItemEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: teamWorkItem,
  requestId: "request-team-work-item",
};
const teamWorkItemListEnvelope = {
  schemaVersion: "workbench-api-v1",
  data: [teamWorkItem],
  page: { nextCursor: null, hasMore: false },
  requestId: "request-team-work-item-list",
};

test("Work Item ProductClient uses the typed Project and direct Team Work Item endpoints", async () => {
  const captures = [];
  const responses = [
    jsonResponse(projectListEnvelope, 200, { "Cache-Control": "no-store" }),
    jsonResponse(projectEnvelope, 201, { "Cache-Control": "no-store", ETag: '"projectv1:project-launch:1"' }),
    jsonResponse(teamWorkItemListEnvelope, 200, { "Cache-Control": "no-store" }),
    jsonResponse(teamWorkItemEnvelope, 201, { "Cache-Control": "no-store", ETag: '"workv1:work-item-launch:1"' }),
  ];
  const client = createWorkItemProductClient({
    csrfToken: () => "csrf-team-work",
    fetch: async (url, init) => {
      captures.push({ url, init });
      return responses.shift();
    },
  });
  const projects = await client.call("listProjects", {});
  assert.equal(projects.body.data[0].projectId, project.projectId);
  const createdProject = await client.call("createProject", {
    headers: { "Idempotency-Key": "create-project" },
    body: { schemaVersion: "workbench-api-v1", data: {
      title: project.title,
      objective: project.objective,
    } },
  });
  const listedWork = await client.call("listWorkItems", { query: { projectId: project.projectId } });
  assert.equal(listedWork.body.data[0].source.kind, "team_work_item");
  const createdWork = await client.call("createTeamWorkItem", {
    headers: { "Idempotency-Key": "create-team-work" },
    body: { schemaVersion: "workbench-api-v1", data: {
      projectId: project.projectId,
      title: teamWorkItem.title,
      objective: teamWorkItem.objective,
      summary: "Only explicit product-safe context is shared.",
    } },
  });
  assert.deepEqual(captures.map((capture) => capture.url), [
    "/api/workbench/v1/projects",
    "/api/workbench/v1/projects",
    "/api/workbench/v1/work-items?projectId=project-launch",
    "/api/workbench/v1/work-items",
  ]);
});

test("Work Item ProductClient sends the atomic promotion through the canonical endpoint", async () => {
  let captured;
  const client = createWorkItemProductClient({
    csrfToken: () => "csrf-work-item",
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(promotionEnvelope);
    },
  });
  const result = await client.call("promoteAgentSessionToWorkItem", {
    pathParams: { sessionId: "agent-session-private" },
    headers: { "Idempotency-Key": "promote-private-task" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        title: "Launch review",
        objective: "Coordinate the team launch review.",
        summary: handoff.summary,
        participants: [{ userId: "user-teammate", access: "contribute" }],
      },
    },
  });

  assert.equal(captured.url, "/api/workbench/v1/agent-sessions/agent-session-private/promote-to-work-item");
  assert.equal(captured.init.headers.get("Idempotency-Key"), "promote-private-task");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-work-item");
  assert.equal(result.body.data.workItem.workItemId, workItemId);
});

test("Work Item ProductClient rejects a browser attempt to send private transcript fields", async () => {
  let calls = 0;
  const client = createWorkItemProductClient({
    fetch: async () => {
      calls += 1;
      return jsonResponse(promotionEnvelope);
    },
  });
  await assert.rejects(
    client.call("promoteAgentSessionToWorkItem", /** @type {never} */ ({
      pathParams: { sessionId: "agent-session-private" },
      headers: { "Idempotency-Key": "promote-private-task" },
      body: {
        schemaVersion: "workbench-api-v1",
        data: {
          title: "Launch review",
          objective: "Coordinate the team launch review.",
          summary: handoff.summary,
          rawTranscript: "private provider payload",
        },
      },
    })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_body",
  );
  assert.equal(calls, 0);
});

test("Work Item ProductClient lists only the typed promotion participant directory", async () => {
  let captured;
  const client = createWorkItemProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(promotionParticipantsEnvelope, 200, { "Cache-Control": "no-store" });
    },
  });
  const result = await client.call("listWorkItemPromotionParticipants", {});
  assert.equal(captured.url, "/api/workbench/v1/work-items/promotion-participants");
  assert.equal(captured.init.method, "GET");
  assert.deepEqual(result.body.data, promotionParticipantsEnvelope.data);
});

test("Work Item ProductClient keeps authorized handoff reads no-store", async () => {
  let captured;
  const client = createWorkItemProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(workItemDetailEnvelope, 200, {
        "Cache-Control": "no-store",
        ETag: '"workv1:work-item-launch:1"',
      });
    },
  });
  const result = await client.call("getWorkItem", {
    pathParams: { workItemId },
  });
  assert.equal(captured.url, `/api/workbench/v1/work-items/${workItemId}`);
  assert.equal(captured.init.method, "GET");
  assert.equal(result.body.data.handoffCapsule.summary, handoff.summary);
  assert.deepEqual(result.headers, {
    "Cache-Control": "no-store",
    ETag: '"workv1:work-item-launch:1"',
  });

  const cacheable = createWorkItemProductClient({
    fetch: async () => jsonResponse(workItemDetailEnvelope, 200),
  });
  await assert.rejects(
    cacheable.call("getWorkItem", { pathParams: { workItemId } }),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_headers",
  );
});

test("Work Item ProductClient creates a personal continuation without accepting private source fields", async () => {
  let captured;
  const client = createWorkItemProductClient({
    csrfToken: () => "csrf-work-item",
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(continuationEnvelope, 201, { "Cache-Control": "no-store" });
    },
  });
  const result = await client.call("createWorkItemContinuation", {
    pathParams: { workItemId },
    headers: { "Idempotency-Key": "continue-work-item" },
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(captured.url, `/api/workbench/v1/work-items/${workItemId}/continuations`);
  assert.equal(captured.init.headers.get("Idempotency-Key"), "continue-work-item");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-work-item");
  assert.equal(result.body.data.agentSessionId, "agent-session-teammate");
  assert.deepEqual(result.headers, { "Cache-Control": "no-store" });

  await assert.rejects(
    client.call("createWorkItemContinuation", /** @type {never} */ ({
      pathParams: { workItemId },
      headers: { "Idempotency-Key": "continue-work-item-private" },
      body: {
        schemaVersion: "workbench-api-v1",
        data: { sourceSessionId: "agent-session-private" },
      },
    })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_body",
  );
});

test("Work Item ProductClient posts a safe comment with the canonical local-write endpoint", async () => {
  let captured;
  const client = createWorkItemProductClient({
    csrfToken: () => "csrf-work-item",
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(commentEnvelope, 201, { "Cache-Control": "no-store" });
    },
  });
  const result = await client.call("createWorkItemThreadComment", {
    pathParams: { workItemId },
    headers: { "Idempotency-Key": "work-thread-comment" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: { content: "The teammate is ready to validate provider readiness." },
    },
  });
  assert.equal(captured.url, `/api/workbench/v1/work-items/${workItemId}/thread-entries`);
  assert.equal(captured.init.headers.get("Idempotency-Key"), "work-thread-comment");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-work-item");
  assert.equal(result.body.data.kind, "comment");
  assert.deepEqual(result.headers, { "Cache-Control": "no-store" });

  await assert.rejects(
    client.call("createWorkItemThreadComment", /** @type {never} */ ({
      pathParams: { workItemId },
      headers: { "Idempotency-Key": "work-thread-comment-private" },
      body: {
        schemaVersion: "workbench-api-v1",
        data: {
          content: "The teammate is ready to validate provider readiness.",
          rawTranscript: "private provider payload",
        },
      },
    })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_body",
  );
});

test("Work Item ProductClient records an owner-governed Decision through the canonical endpoint", async () => {
  let captured;
  const client = createWorkItemProductClient({
    csrfToken: () => "csrf-work-item",
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(decisionEnvelope, 201, { "Cache-Control": "no-store" });
    },
  });
  const result = await client.call("recordWorkItemDecision", {
    pathParams: { workItemId },
    headers: { "Idempotency-Key": "record-work-item-decision" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        question: "Which readiness action should the team take?",
        options: ["Proceed", "Validate first"],
        chosenOutcome: "Validate first",
      },
    },
  });
  assert.equal(captured.url, `/api/workbench/v1/work-items/${workItemId}/decisions`);
  assert.equal(captured.init.headers.get("Idempotency-Key"), "record-work-item-decision");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-work-item");
  assert.equal(result.body.data.approverUserId, "user-owner");
  assert.deepEqual(result.headers, { "Cache-Control": "no-store" });

  await assert.rejects(
    client.call("recordWorkItemDecision", /** @type {never} */ ({
      pathParams: { workItemId },
      headers: { "Idempotency-Key": "record-work-item-decision-forged-author" },
      body: {
        schemaVersion: "workbench-api-v1",
        data: {
          question: "Which readiness action should the team take?",
          options: ["Proceed", "Validate first"],
          chosenOutcome: "Validate first",
          authorUserId: "user-forged",
        },
      },
    })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_body",
  );
});
