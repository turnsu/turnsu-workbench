import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentBranchSchema,
  AgentBranchStatusSchema,
  Check,
  WORKBENCH_V1_AGENT_ENDPOINTS,
  WORKBENCH_V1_MODEL_ENDPOINTS,
} from "../dist/index.js";

const agentBranch = {
  schemaVersion: "workbench-v1",
  branchId: "agent-branch-a",
  userId: "user-a",
  workspaceId: "workspace-a",
  objectKind: "workflow",
  objectId: "workflow-a",
  baseVersionId: "workflow-revision-a",
  status: "active",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

test("Agent branches expose every persisted lifecycle state without internal snapshots", () => {
  for (const status of ["active", "conflicting", "merged", "rejected", "closed"]) {
    assert.equal(Check(AgentBranchStatusSchema, status), true, `${status} is a valid branch state`);
    assert.equal(Check(AgentBranchSchema, { ...agentBranch, status }), true);
  }

  assert.equal(Check(AgentBranchStatusSchema, "proposed"), false);
  assert.equal(Check(AgentBranchSchema, {
    ...agentBranch,
    baseSnapshot: { privateDraftState: true },
  }), false, "product-safe branch responses exclude the internal merge base snapshot");
});

test("Agent branch active and closed states remain backward compatible", () => {
  assert.equal(Check(AgentBranchSchema, agentBranch), true);
  assert.equal(Check(AgentBranchSchema, { ...agentBranch, status: "closed" }), true);
});

test("formal Agent, handoff, Run execution detail endpoints are additive and mutation-protected", () => {
  const endpoints = WORKBENCH_V1_AGENT_ENDPOINTS;
  assert.equal(endpoints.listAgentDefinitions.path, "/api/workbench/v1/agent-definitions");
  assert.equal(endpoints.createAgentSession.path, "/api/workbench/v1/agent-sessions");
  assert.equal(endpoints.listAgentSessions.path, "/api/workbench/v1/agent-sessions");
  assert.equal(endpoints.listAgentSessions.method, "GET");
  assert.equal(endpoints.updateAgentSession.path, "/api/workbench/v1/agent-sessions/{sessionId}");
  assert.equal(endpoints.updateAgentSession.method, "PATCH");
  assert.equal(Check(endpoints.listAgentSessions.querySchema, {
    search: "launch review",
    archived: true,
    taskStatus: "blocked",
    limit: 25,
  }), true);
  assert.equal(Check(endpoints.updateAgentSession.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: { title: "Renamed task", archived: true },
  }), true);
  assert.equal(Check(endpoints.updateAgentSession.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {},
  }), false);
  assert.equal(Check(endpoints.updateAgentSession.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: { archived: true, cancelActiveTurn: true },
  }), false);
  assert.equal(endpoints.createAgentTurn.successStatus, 202);
  assert.equal(endpoints.listAgentTurns.method, "GET");
  assert.equal(endpoints.listAgentTurns.path, "/api/workbench/v1/agent-sessions/{sessionId}/turns");
  assert.equal(endpoints.getAgentSessionQueue.path, "/api/workbench/v1/agent-sessions/{sessionId}/queue");
  assert.equal(Check(endpoints.getAgentSessionQueue.querySchema, { limit: 25 }), true);
  assert.equal(Check(endpoints.listAgentTurns.querySchema, { after: 4, limit: 25 }), true);
  assert.equal(endpoints.cancelAgentTurn.successStatus, 202);
  assert.equal(Check(endpoints.getAgentSessionQueue.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      sessionId: "agent-session-a",
      runningTurnId: null,
      queuedTurnCount: 1,
      items: [{
        admissionId: "admission-a",
        commandId: "product-command-a",
        invocationId: null,
        sessionId: "agent-session-a",
        turnId: "agent-turn-a",
        reasonCode: "waiting_session_turn",
        position: 1,
        estimatedWaitSeconds: 30,
        approximate: true,
        cancellable: true,
        cancelAction: {
          method: "POST",
          path: "/api/workbench/v1/agent-sessions/agent-session-a/turns/agent-turn-a/cancel",
        },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
      page: { nextCursor: null, hasMore: false },
    },
    requestId: "request-queue-a",
  }), true);
  assert.equal(endpoints.listRunInvocations.path, "/api/workbench/v1/runs/{runId}/invocations");
  assert.equal(endpoints.listRunExecutionEvents.path, "/api/workbench/v1/runs/{runId}/execution-events");
  assert.equal(Check(endpoints.listRunInvocations.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [{
      invocationId: "invocation-run-usage",
      attemptId: "attempt-run-usage",
      mode: "deterministic_skill",
      isolation: "container",
      status: "completed",
      requestedModelRevisionId: null,
      actualModelRevisionId: null,
      artifactRefs: [],
      usage: {
        steps: 1,
        modelRequests: 0,
        inputBytes: 64,
        outputBytes: 32,
        imageCount: 0,
        costUsdMicros: 0,
      },
      createdAt: "2026-07-28T10:00:00.000Z",
      startedAt: "2026-07-28T10:00:00.000Z",
      finishedAt: "2026-07-28T10:00:01.000Z",
    }],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-run-usage",
  }), true);
  for (const endpoint of Object.values(endpoints).filter((value) => value.mutation)) {
    assert(endpoint.requiredRequestHeaders.includes("Idempotency-Key"));
  }
});

test("model profiles are selectable without exposing credentials or provider wire configuration", () => {
  assert.equal(WORKBENCH_V1_MODEL_ENDPOINTS.listModelProfiles.path, "/api/workbench/v1/model-profiles");
  assert.equal(WORKBENCH_V1_MODEL_ENDPOINTS.selectAgentSessionModel.path, "/api/workbench/v1/agent-sessions/{sessionId}/model");
  const request = {
    schemaVersion: "workbench-api-v1",
    data: { modelProfileId: "deepseek-default" },
  };
  assert.equal(Check(WORKBENCH_V1_MODEL_ENDPOINTS.selectAgentSessionModel.requestBodySchema, request), true);
  assert.equal(Check(WORKBENCH_V1_MODEL_ENDPOINTS.selectAgentSessionModel.requestBodySchema, {
    ...request,
    data: { ...request.data, apiKey: "must-not-pass" },
  }), false);
});

test("Agent session creation and turns reject shared-object or internal execution controls", () => {
  const createSession = {
    schemaVersion: "workbench-api-v1",
    data: {
      definitionId: "loop_creator",
      objectKind: "workflow",
      objectId: "workflow-a",
      lastUsedModelProfileId: "deepseek-default",
    },
  };
  const createTurn = {
    schemaVersion: "workbench-api-v1",
    data: {
      kind: "agent_message",
      modelProfileId: "deepseek-default",
      input: { message: "Improve the completion criteria." },
    },
  };
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.createAgentSession.requestBodySchema, createSession), true);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.createAgentTurn.requestBodySchema, createTurn), true);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.createAgentSession.requestBodySchema, {
    ...createSession,
    data: { ...createSession.data, sharedSession: true },
  }), false);
  assert.equal(Check(WORKBENCH_V1_AGENT_ENDPOINTS.createAgentTurn.requestBodySchema, {
    ...createTurn,
    data: { ...createTurn.data, workerBackend: "host-process" },
  }), false);
});
