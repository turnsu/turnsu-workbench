import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_AGENT_ENDPOINTS,
  WORKBENCH_V1_MODEL_ENDPOINTS,
} from "@looloomi/workbench-contracts";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

const NOW = "2026-07-16T12:00:00.000Z";
const ORIGIN = "http://127.0.0.1";

class MockResponse extends EventEmitter {
  constructor() { super(); this.status = null; this.headers = {}; this.body = ""; }
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; }
  write(value) { this.body += value; }
  end(value = "") { this.body += value; this.emit("finish"); }
}

function request({ method = "GET", url, headers = {}, body }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) };
  req[Symbol.asyncIterator] = async function* iterator() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}

async function invoke(handler, options) {
  const response = new MockResponse();
  await handler(request(options), response);
  return response;
}

function setup(application) {
  const sessionStore = new WorkbenchSessionStore({
    clock: () => new Date(NOW),
    tokenFactory: () => "agent-http-session-token",
    csrfTokenFactory: () => "agent-http-csrf-token-abcdefghijklmnopqrstuvwxyz",
  });
  const session = sessionStore.issue({ userId: "user-a", activeWorkspaceId: "workspace-a" });
  return {
    session,
    handler: createWorkbenchHttpHandler({ application, sessionStore, origin: ORIGIN, requestIdFactory: () => "request-agent-http" }),
  };
}

function headers(session, idempotencyKey) {
  return {
    Cookie: `workbench_session=${session.token}`,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": session.csrfToken,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  };
}

const sessionValue = {
  schemaVersion: "workbench-v1",
  sessionId: "agent-session-a",
  definitionId: "loop_creator",
  userId: "user-a",
  workspaceId: "workspace-a",
  scope: { kind: "module", objectKind: "workflow", objectId: "workflow-a", branchId: "agent-branch-a", baseVersionId: "revision-a" },
  title: "Improve workflow",
  source: { kind: "manual" },
  taskStatus: "idle",
  archived: false,
  status: "active",
  lastUsedModelProfileId: "deepseek-default",
  modelPreferenceState: "preference_only",
  activeTurnId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const turnValue = {
  schemaVersion: "workbench-v1",
  turnId: "agent-turn-a",
  sessionId: sessionValue.sessionId,
  sequence: 1,
  status: "queued",
  modelRoutingState: "pinned",
  kind: "agent_message",
  requestedModelRevisionId: "model-revision-deepseek-1",
  actualModelRevisionId: null,
  artifactRefs: [],
  input: { message: "Improve it" },
  result: null,
  queuedAt: NOW,
  startedAt: null,
  finishedAt: null,
  updatedAt: NOW,
};
const proposalValue = {
  schemaVersion: "workbench-v1",
  proposalId: "agent-proposal-a",
  workspaceId: "workspace-a",
  userId: "user-a",
  sessionId: sessionValue.sessionId,
  turnId: turnValue.turnId,
  definitionId: "loop_creator",
  objectKind: "workflow",
  objectId: "workflow-a",
  branchId: "agent-branch-a",
  baseVersionId: "revision-a",
  summary: "Improve the workflow definition.",
  operations: [{ op: "replace", path: "/definition/goal", value: "Improved goal" }],
  evidenceRefs: [],
  validationResult: { status: "passed", diagnostics: [] },
  status: "proposed",
  createdBy: "user-a",
  createdAt: NOW,
  decidedAt: null,
};

test("formal Agent session and asynchronous turn routes dispatch contract-valid responses", async () => {
  const calls = [];
  const application = {
    async listAgentDefinitions() { return { data: [{ schemaVersion: "workbench-v1", definitionId: "main", kind: "main", label: "Main Agent", description: "Main workspace Agent.", objectKinds: [], canHandoffToMain: false }], page: { nextCursor: null, hasMore: false } }; },
    async listModelProfiles() {
      return {
        data: [{
          schemaVersion: "workbench-v1",
          profileId: "deepseek-default",
          displayName: "DeepSeek",
          currentRevisionId: "model-revision-deepseek-1",
          currentRevision: {
            schemaVersion: "workbench-v1",
            revisionId: "model-revision-deepseek-1",
            profileId: "deepseek-default",
            revisionNumber: 1,
            modelDisplayName: "DeepSeek Chat",
            providerDisplay: { key: "deepseek", label: "DeepSeek" },
            capabilities: ["chat", "tool_calling", "structured_output"],
            parameterSupport: {
              kind: "chat", temperature: true, maxOutputTokens: true, tools: true, responseSchema: true,
            },
            limits: { kind: "chat", maxInputTokens: 128_000, maxOutputTokens: 8_192 },
            createdAt: NOW,
          },
          enabled: true,
          readiness: "ready",
          readinessReason: null,
          selectable: true,
          defaultForCapabilities: ["chat", "tool_calling", "structured_output"],
          scope: "global",
          createdAt: NOW,
          updatedAt: NOW,
        }],
        page: { nextCursor: null, hasMore: false },
      };
    },
    async createAgentSession(input) { calls.push(input); return sessionValue; },
    async listAgentSessions(input) { calls.push(input); return { data: [sessionValue], page: { nextCursor: null, hasMore: false } }; },
    async updateAgentSession(input) {
      calls.push(input);
      return { ...sessionValue, title: input.request.data.title, archived: input.request.data.archived };
    },
    async selectAgentSessionModel(input) {
      calls.push(input);
      return { ...sessionValue, lastUsedModelProfileId: input.request.data.modelProfileId };
    },
    async getAgentSession() { return sessionValue; },
    async getAgentSessionQueue() {
      return {
        sessionId: sessionValue.sessionId,
        runningTurnId: null,
        queuedTurnCount: 1,
        items: [{
          admissionId: "admission-a",
          commandId: "product-command-a",
          invocationId: null,
          sessionId: sessionValue.sessionId,
          turnId: turnValue.turnId,
          reasonCode: "waiting_session_turn",
          position: 1,
          estimatedWaitSeconds: 30,
          approximate: true,
          cancellable: true,
          cancelAction: {
            method: "POST",
            path: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/turns/${turnValue.turnId}/cancel`,
          },
          createdAt: NOW,
          updatedAt: NOW,
        }],
        page: { nextCursor: null, hasMore: false },
      };
    },
    async createAgentTurn(input) { calls.push(input); return turnValue; },
    async getAgentTurn() { return turnValue; },
    async cancelAgentTurn() { return { ...turnValue, status: "cancelled", result: null, finishedAt: NOW }; },
    async listAgentSessionEvents() { return { data: [], page: { nextCursor: null, hasMore: false } }; },
    async getAgentProposal(input) { calls.push(input); return proposalValue; },
    async applyAgentProposal(input) { calls.push(input); return { ...proposalValue, status: "accepted", decidedAt: NOW }; },
    async rejectAgentProposal(input) { calls.push(input); return { ...proposalValue, status: "rejected", decidedAt: NOW }; },
  };
  const { handler, session } = setup(application);

  const definitions = await invoke(handler, { url: "/api/workbench/v1/agent-definitions", headers: { Cookie: `workbench_session=${session.token}` } });
  assert.equal(definitions.status, 200, definitions.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.listAgentDefinitions.responseBodySchema, JSON.parse(definitions.body)), true);

  const profiles = await invoke(handler, { url: "/api/workbench/v1/model-profiles", headers: { Cookie: `workbench_session=${session.token}` } });
  assert.equal(profiles.status, 200, profiles.body);
  assert.equal(Check(WORKBENCH_V1_MODEL_ENDPOINTS.listModelProfiles.responseBodySchema, JSON.parse(profiles.body)), true);

  const createdSession = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/agent-sessions",
    headers: headers(session, "create-session-a"),
    body: { schemaVersion: "workbench-api-v1", data: { definitionId: "loop_creator", objectKind: "workflow", objectId: "workflow-a" } },
  });
  assert.equal(createdSession.status, 201, createdSession.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.createAgentSession.responseBodySchema, JSON.parse(createdSession.body)), true);

  const listedSessions = await invoke(handler, {
    url: "/api/workbench/v1/agent-sessions?definitionId=loop_creator&taskStatus=blocked&search=launch&archived=true",
    headers: { Cookie: `workbench_session=${session.token}` },
  });
  assert.equal(listedSessions.status, 200, listedSessions.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.listAgentSessions.responseBodySchema, JSON.parse(listedSessions.body)), true);
  const listCall = calls.find((call) => call.query?.search === "launch");
  assert.equal(listCall.query.archived, true);
  assert.equal(listCall.query.taskStatus, "blocked");

  const updatedSession = await invoke(handler, {
    method: "PATCH",
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}`,
    headers: headers(session, "update-agent-session-a"),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { title: "Renamed task", archived: true },
    },
  });
  assert.equal(updatedSession.status, 200, updatedSession.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.updateAgentSession.responseBodySchema, JSON.parse(updatedSession.body)), true);
  assert.equal(JSON.parse(updatedSession.body).data.archived, true);

  const queue = await invoke(handler, {
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/queue?limit=25`,
    headers: { Cookie: `workbench_session=${session.token}` },
  });
  assert.equal(queue.status, 200, queue.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.getAgentSessionQueue.responseBodySchema, JSON.parse(queue.body)), true);
  assert.equal(JSON.parse(queue.body).data.items[0].reasonCode, "waiting_session_turn");

  const selectedModel = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/model`,
    headers: headers(session, "select-model-a"),
    body: { schemaVersion: "workbench-api-v1", data: { modelProfileId: "claude-sonnet" } },
  });
  assert.equal(selectedModel.status, 200, selectedModel.body);
  assert.equal(JSON.parse(selectedModel.body).data.lastUsedModelProfileId, "claude-sonnet");

  const createdTurn = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/turns`,
    headers: headers(session, "create-turn-a"),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        kind: "agent_message",
        modelProfileId: "deepseek-default",
        input: { message: "Improve it" },
      },
    },
  });
  assert.equal(createdTurn.status, 202, createdTurn.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.createAgentTurn.responseBodySchema, JSON.parse(createdTurn.body)), true);
  assert.equal(calls.find((call) => call.turnId === undefined && call.request?.data?.kind)?.sessionId, sessionValue.sessionId);

  const proposal = await invoke(handler, {
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/proposals/${proposalValue.proposalId}`,
    headers: { Cookie: `workbench_session=${session.token}` },
  });
  assert.equal(proposal.status, 200, proposal.body);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.getAgentProposal.responseBodySchema, JSON.parse(proposal.body)), true);

  const appliedProposal = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/proposals/${proposalValue.proposalId}/apply`,
    headers: headers(session, "apply-agent-proposal-a"),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(appliedProposal.status, 200, appliedProposal.body);
  assert.equal(JSON.parse(appliedProposal.body).data.status, "accepted");

  const rejectedProposal = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/proposals/${proposalValue.proposalId}/reject`,
    headers: headers(session, "reject-agent-proposal-a"),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(rejectedProposal.status, 200, rejectedProposal.body);
  assert.equal(JSON.parse(rejectedProposal.body).data.status, "rejected");
});

test("Agent mutations require browser security and do not expose a generic Worker execution route", async () => {
  const { handler, session } = setup({ async createAgentTurn() { throw new Error("must not dispatch"); } });
  const missingIdempotency = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}/turns`,
    headers: { ...headers(session, "unused"), "Idempotency-Key": undefined },
    body: { schemaVersion: "workbench-api-v1", data: { message: "Improve it" } },
  });
  assert.equal(missingIdempotency.status, 400);

  const worker = await invoke(handler, { method: "POST", url: "/api/workbench/v1/workers/execute", headers: headers(session, "worker") });
  assert.equal(worker.status, 404);
});

test("temporary Loop task source read failures stay retryable and never masquerade as blocked", async () => {
  const error = new Error("The Loop task status is temporarily unavailable.");
  error.code = "agent_task_source_unavailable";
  const { handler, session } = setup({
    async getAgentSession() { throw error; },
  });
  const response = await invoke(handler, {
    url: `/api/workbench/v1/agent-sessions/${sessionValue.sessionId}`,
    headers: { Cookie: `workbench_session=${session.token}` },
  });
  const body = JSON.parse(response.body);
  assert.equal(response.status, 503);
  assert.equal(body.code, "agent_task_source_unavailable");
  assert.equal(body.retryable, true);
  assert.notEqual(body.code, "blocked");
});
