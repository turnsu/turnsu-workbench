import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  ExecutionCapacityAuthoritySchema,
  ExecutionLineageSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  RealtimeAudioExecutionRequestSchema,
  RealtimeModelLimitsSchema,
  RealtimeStreamReadySchema,
  RealtimeStreamUpdateSchema,
} from "../dist/index.js";

test("execution lineage and capacity authority are typed without weakening V1 compatibility", () => {
  const lineage = {
    productCommandId: "product-command-1",
    sessionId: "agent-session-1",
    turnId: "agent-turn-1",
    parentInvocationId: "invocation-parent-1",
  };
  const capacityAuthority = {
    admissionId: "admission-1",
    capacityLeaseId: "capacity-lease-1",
    fence: 1,
  };
  assert.equal(Check(ExecutionLineageSchema, lineage), true);
  assert.equal(Check(ExecutionCapacityAuthoritySchema, capacityAuthority), true);
  assert.equal(Check(ExecutionCapacityAuthoritySchema, {
    ...capacityAuthority,
    fence: 0,
  }), false);

  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-child-1",
    attemptId: "attempt-child-1",
    workspaceId: "workspace-1",
    actor: { userId: "user-1" },
    lineage,
    capacityAuthority,
    controller: {
      kind: "agent_turn",
      controllerId: "agent-turn-1",
      fence: 1,
    },
    mode: "bounded_agent",
    isolation: "container",
    goal: "Perform bounded work.",
    input: {},
    limits: {
      timeoutMs: 60_000,
      maxSteps: 8,
      maxModelRequests: 4,
      maxChildren: 0,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxImageCount: 0,
      maxCostUsdMicros: 10_000_000,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    evidenceRequirements: [],
    metadata: {},
  };
  assert.equal(Check(ExecutionRequestSchema, request), true);
  assert.equal(Check(ExecutionRequestSchema, {
    ...request,
    actor: { userId: "user-1", role: "admin" },
  }), false);
});

test("realtime audio is an explicit streaming mode with no fallback or persisted SDP", () => {
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-realtime-1",
    attemptId: "attempt-realtime-1",
    workspaceId: "workspace-1",
    actor: { userId: "user-1" },
    lineage: {
      productCommandId: "product-command-realtime-1",
      sessionId: "agent-session-realtime-1",
      turnId: "agent-turn-realtime-1",
    },
    capacityAuthority: {
      admissionId: "admission-realtime-1",
      capacityLeaseId: "capacity-lease-realtime-1",
      fence: 1,
    },
    controller: {
      kind: "skill_creation_turn",
      controllerId: "agent-turn-realtime-1",
      fence: 1,
    },
    mode: "realtime_audio",
    isolation: "process",
    modelProfileRevisionId: "model-revision-realtime-1",
    modelCapability: "realtime_audio",
    fallbackModelProfileRevisionIds: [],
    goal: "Hold a governed realtime creation conversation.",
    limits: {
      timeoutMs: 900_000,
      maxSteps: 100,
      maxModelRequests: 100,
      maxChildren: 0,
      maxDepth: 0,
      maxSpawnedChildren: 0,
      maxInputTokens: 120_000,
      maxOutputTokens: 32_000,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 2_000_000,
      maxImageCount: 0,
      maxCostUsdMicros: 10_000_000,
    },
    capabilities: {
      toolAllowlist: ["propose_skill_creation_patch"],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: { type: "object", additionalProperties: true },
    evidenceRequirements: [],
    metadata: { creationSessionId: "skill-creation-session-1" },
  };

  assert.equal(Check(RealtimeAudioExecutionRequestSchema, request), true);
  assert.equal(Check(ExecutionRequestSchema, request), true);
  assert.equal(Object.hasOwn(request, "input"), false);
  assert.equal(Check(RealtimeAudioExecutionRequestSchema, {
    ...request,
    fallbackModelProfileRevisionIds: ["model-revision-fallback"],
  }), false);
  assert.equal(Check(RealtimeAudioExecutionRequestSchema, {
    ...request,
    isolation: "remote",
  }), false);
  assert.equal(Check(RealtimeAudioExecutionRequestSchema, {
    ...request,
    actor: undefined,
  }), false);
  assert.equal(Check(RealtimeAudioExecutionRequestSchema, {
    ...request,
    lineage: { productCommandId: request.lineage.productCommandId },
  }), false);

  const ready = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    status: "running",
    isolation: "process",
    sdpAnswer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    startedAt: "2026-08-04T00:00:00.000Z",
  };
  assert.equal(Check(RealtimeStreamReadySchema, ready), true);
  assert.equal(Check(RealtimeStreamReadySchema, {
    ...ready,
    authority: {
      attemptId: request.attemptId,
      capabilityLeaseId: "capability-lease-realtime-1",
      fence: 1,
    },
  }), false);
  assert.equal(Check(RealtimeStreamReadySchema, { ...ready, status: "completed" }), false);
  assert.equal(Check(RealtimeStreamUpdateSchema, {
    kind: "session_instructions",
    instructions: "Ask only for missing Skill fields.",
  }), true);
  assert.equal(Check(RealtimeStreamUpdateSchema, {
    kind: "provider_payload",
    payload: {},
  }), false);
});

test("realtime limits and execution results retain governed token usage without breaking legacy results", () => {
  assert.equal(Check(RealtimeModelLimitsSchema, {
    kind: "realtime",
    maxSessionSeconds: 900,
    maxInputTokens: 120_000,
    maxOutputTokens: 32_000,
    maxCostUsdMicros: 10_000_000,
    pricing: {
      pricingVersion: "pricing-2026-08-04",
      basis: "aggregate_token_ceiling",
      currency: "USD",
      inputUsdMicrosPerMillionTokens: 1_000_000,
      outputUsdMicrosPerMillionTokens: 2_000_000,
    },
  }), true);

  const result = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-realtime-usage-1",
    attemptId: "attempt-realtime-usage-1",
    status: "completed",
    isolation: "process",
    requestedModelRevisionId: "model-revision-realtime-1",
    actualModelRevisionId: "model-revision-realtime-1",
    artifactRefs: [],
    summary: "Realtime conversation finished.",
    evidence: [],
    usage: {
      steps: 2,
      modelRequests: 2,
      inputBytes: 0,
      outputBytes: 128,
      imageCount: 0,
      costUsdMicros: 42,
      inputTokens: 20,
      outputTokens: 11,
      totalTokens: 31,
      audioInputTokens: 15,
      audioOutputTokens: 8,
      cachedInputTokens: 4,
    },
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:01:00.000Z",
  };
  assert.equal(Check(ExecutionResultSchema, result), true);

  const legacy = structuredClone(result);
  for (const key of [
    "inputTokens", "outputTokens", "totalTokens",
    "audioInputTokens", "audioOutputTokens", "cachedInputTokens",
  ]) delete legacy.usage[key];
  assert.equal(Check(ExecutionResultSchema, legacy), true);
});
