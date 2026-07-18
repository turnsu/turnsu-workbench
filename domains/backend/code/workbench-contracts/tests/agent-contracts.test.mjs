import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_AGENT_ENDPOINTS,
  WORKBENCH_V1_MODEL_ENDPOINTS,
} from "../dist/index.js";

test("formal Agent, handoff, Run execution detail endpoints are additive and mutation-protected", () => {
  const endpoints = WORKBENCH_V1_AGENT_ENDPOINTS;
  assert.equal(endpoints.listAgentDefinitions.path, "/api/workbench/v1/agent-definitions");
  assert.equal(endpoints.createAgentSession.path, "/api/workbench/v1/agent-sessions");
  assert.equal(endpoints.createAgentTurn.successStatus, 202);
  assert.equal(endpoints.listAgentTurns.method, "GET");
  assert.equal(endpoints.listAgentTurns.path, "/api/workbench/v1/agent-sessions/{sessionId}/turns");
  assert.equal(Check(endpoints.listAgentTurns.querySchema, { after: 4, limit: 25 }), true);
  assert.equal(endpoints.cancelAgentTurn.successStatus, 202);
  assert.equal(endpoints.listRunInvocations.path, "/api/workbench/v1/runs/{runId}/invocations");
  assert.equal(endpoints.listRunExecutionEvents.path, "/api/workbench/v1/runs/{runId}/execution-events");
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
      modelProfileRevisionId: "model-revision-deepseek-3",
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
