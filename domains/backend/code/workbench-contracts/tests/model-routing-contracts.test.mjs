import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "../dist/index.js";
import {
  artifactMetadataExample,
  artifactRefExample,
  executionPlanExample,
  modelProfileSummaryExample,
  skillNodeExample,
} from "../examples/canonical-examples.mjs";

const now = "2026-07-18T00:00:00.000Z";

const chatRevision = {
  schemaVersion: "workbench-v1",
  revisionId: "model-revision-chat-3",
  profileId: "model-profile-chat",
  revisionNumber: 3,
  provider: "deepseek",
  protocol: "openai_compatible_chat",
  providerModelId: "deepseek-chat",
  capabilities: ["chat", "tool_calling", "structured_output"],
  parameterSchemaVersion: "1",
  parameterSupport: {
    kind: "chat",
    temperature: true,
    maxOutputTokens: true,
    tools: true,
    responseSchema: true,
  },
  limits: {
    kind: "chat",
    maxInputTokens: 64_000,
    maxOutputTokens: 8_000,
  },
  policyVersion: "1",
  configHash: "sha256:0123456789abcdef",
  createdAt: now,
};

const stabilityRevision = {
  schemaVersion: "workbench-v1",
  revisionId: "model-revision-stability-1",
  profileId: "model-profile-stability",
  revisionNumber: 1,
  provider: "stability",
  protocol: "stability_image_v2",
  providerModelId: "stable-image-core",
  capabilities: ["image_generation"],
  parameterSchemaVersion: "1",
  parameterSupport: {
    kind: "image_generation",
    negativePrompt: true,
    aspectRatios: ["1:1", "16:9", "9:16"],
    seed: true,
    outputFormats: ["png", "jpeg", "webp"],
  },
  limits: {
    kind: "image_generation",
    maxImageCount: 1,
    maxOutputBytes: 10_000_000,
    maxCostUsdMicros: 250_000,
  },
  policyVersion: "1",
  configHash: "sha256:fedcba9876543210",
  createdAt: now,
};

const modelCallLimits = {
  timeoutMs: 60_000,
  maxSteps: 1,
  maxModelRequests: 1,
  maxChildren: 0,
  maxInputBytes: 100_000,
  maxOutputBytes: 10_000_000,
  maxImageCount: 1,
  maxCostUsdMicros: 250_000,
};

const noCapabilities = {
  toolAllowlist: [],
  connectionIds: [],
  network: false,
  filesystem: "none",
  externalActions: false,
};

const imageInput = {
  prompt: "A clean product diagram on a white background.",
  negativePrompt: "No watermarks.",
  aspectRatio: "1:1",
  seed: 42,
  outputFormat: "png",
};

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  imageCount: 1,
  costUsdMicros: 200_000,
};

test("model identifiers, provider protocols, capabilities, and readiness are strict", () => {
  for (const schema of [
    contracts.ModelProfileIdSchema,
    contracts.ModelProfileRevisionIdSchema,
    contracts.ArtifactIdSchema,
  ]) {
    assert.equal(contracts.Check(schema, "stable-id:1"), true);
    assert.equal(contracts.Check(schema, "not allowed/id"), false);
  }

  assert.equal(contracts.Check(contracts.ModelProfileRevisionSchema, chatRevision), true);
  assert.equal(contracts.Check(contracts.ModelProfileRevisionSchema, stabilityRevision), true);
  assert.equal(contracts.Check(contracts.ModelReadinessSchema, "degraded"), true);
  assert.equal(contracts.Check(contracts.ModelReadinessSchema, "healthy"), false);

  assert.equal(contracts.Check(contracts.ModelProfileRevisionSchema, {
    ...chatRevision,
    protocol: "anthropic_messages",
  }), false);
  assert.equal(contracts.Check(contracts.ModelProfileRevisionSchema, {
    ...chatRevision,
    capabilities: ["chat", "image_generation"],
  }), false);
  assert.equal(contracts.Check(contracts.ModelProfileRevisionSchema, {
    ...stabilityRevision,
    provider: "openai",
  }), false);
  assert.equal(contracts.Check(contracts.ModelProfileRevisionSchema, {
    ...stabilityRevision,
    capabilities: ["image_generation", "chat"],
  }), false);

  assert.equal(
    contracts.modelRevisionSupportsCapabilities(
      chatRevision,
      contracts.AGENT_CONTROLLER_REQUIRED_MODEL_CAPABILITIES,
    ),
    true,
  );
  assert.equal(
    contracts.modelRevisionSupportsCapabilities(
      stabilityRevision,
      contracts.AGENT_CONTROLLER_REQUIRED_MODEL_CAPABILITIES,
    ),
    false,
  );
});

test("public model summaries expose only explicit display and normalized selection data", () => {
  assert.equal(
    contracts.Check(contracts.ModelProfileSummarySchema, modelProfileSummaryExample),
    true,
  );

  for (const [target, field, value] of [
    ["profile", "provider", "deepseek"],
    ["revision", "protocol", "openai_compatible_chat"],
    ["revision", "providerModelId", "deepseek-chat"],
    ["revision", "endpoint", "https://provider.invalid/v1"],
    ["revision", "credentialRef", "keychain:model"],
    ["revision", "providerPayload", { internal: true }],
  ]) {
    const unsafe = structuredClone(modelProfileSummaryExample);
    (target === "profile" ? unsafe : unsafe.currentRevision)[field] = value;
    assert.equal(
      contracts.Check(contracts.ModelProfileSummarySchema, unsafe),
      false,
      `public model summary accepted ${target}.${field}`,
    );
  }

  assert.equal(modelProfileSummaryExample.currentRevision.providerDisplay.label, "DeepSeek");
});

test("model catalog filters are capability/context/revision-aware and query-string safe", () => {
  const query = {
    capabilities: "chat,tool_calling",
    context: "agent_controller",
    readiness: "ready",
    selectedRevisionId: "model-revision-chat-3",
    limit: 25,
  };
  assert.equal(contracts.Check(contracts.ModelCatalogQuerySchema, query), true);
  assert.equal(contracts.Check(contracts.ModelCatalogQuerySchema, {
    ...query,
    capabilities: ["chat", "tool_calling"],
  }), false);
  assert.equal(contracts.Check(contracts.ModelCatalogQuerySchema, {
    ...query,
    capabilities: "chat,image_editing",
  }), false);
  assert.equal(contracts.Check(contracts.ModelCatalogQuerySchema, {
    ...query,
    selectedProfileId: "model-profile-chat",
  }), false);
});

test("typed Chat and image inputs/results reject provider extras and raw image content", () => {
  const chatInput = {
    messages: [{ role: "user", content: "Summarize this." }],
    tools: [],
    responseSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  };
  assert.equal(contracts.Check(contracts.ChatInputSchema, chatInput), true);
  assert.equal(contracts.Check(contracts.ImageGenerationInputSchema, imageInput), true);
  assert.equal(contracts.Check(contracts.ChatInputSchema, {
    ...chatInput,
    providerPayload: {},
  }), false);
  assert.equal(contracts.Check(contracts.ImageGenerationInputSchema, {
    ...imageInput,
    providerOptions: {},
  }), false);

  const imageResult = {
    kind: "image_generation",
    artifactRefs: [artifactRefExample],
    seed: 42,
    format: "png",
    dimensions: { width: 1024, height: 1024 },
    safetyStatus: "passed",
    usage,
    requestedModelRevisionId: stabilityRevision.revisionId,
    actualModelRevisionId: stabilityRevision.revisionId,
  };
  assert.equal(contracts.Check(contracts.ImageGenerationResultSchema, imageResult), true);
  for (const field of ["base64", "contentBase64", "providerPayload", "storagePath"]) {
    assert.equal(contracts.Check(contracts.ImageGenerationResultSchema, {
      ...imageResult,
      [field]: "unsafe",
    }), false, `image result accepted ${field}`);
  }
});

test("Agent Turn requests discriminate execution kind and require an immutable revision", () => {
  const agentMessage = {
    schemaVersion: "workbench-api-v1",
    data: {
      kind: "agent_message",
      modelProfileRevisionId: chatRevision.revisionId,
      input: { message: "Improve the workflow completion criteria." },
    },
  };
  const modelTask = {
    schemaVersion: "workbench-api-v1",
    data: {
      kind: "model_task",
      modelProfileRevisionId: stabilityRevision.revisionId,
      input: { task: "image_generation", ...imageInput },
    },
  };
  assert.equal(contracts.Check(contracts.CreateAgentTurnRequestSchema, agentMessage), true);
  assert.equal(contracts.Check(contracts.CreateAgentTurnRequestSchema, modelTask), true);

  const missingRevision = structuredClone(agentMessage);
  delete missingRevision.data.modelProfileRevisionId;
  assert.equal(contracts.Check(contracts.CreateAgentTurnRequestSchema, missingRevision), false);
  assert.equal(contracts.Check(contracts.CreateAgentTurnRequestSchema, {
    ...modelTask,
    data: { ...modelTask.data, kind: "agent_message" },
  }), false);
  assert.equal(contracts.Check(contracts.CreateAgentTurnRequestSchema, {
    ...modelTask,
    data: { ...modelTask.data, input: { ...modelTask.data.input, contentBase64: "AA==" } },
  }), false);
});

test("Session model mutation is preference-only and current Turn reads expose pinned routes", () => {
  const session = {
    schemaVersion: "workbench-v1",
    sessionId: "agent-session-main-1",
    definitionId: "main",
    userId: "user-1",
    workspaceId: "workspace-1",
    scope: { kind: "main" },
    status: "active",
    lastUsedModelProfileId: "model-profile-chat",
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(contracts.Check(contracts.AgentSessionSchema, session), true);
  assert.equal(contracts.Check(contracts.AgentSessionSchema, {
    ...session,
    modelProfileId: "ambiguous-old-authority",
  }), false);

  const preferenceRequest = {
    schemaVersion: "workbench-api-v1",
    data: { modelProfileId: "model-profile-chat" },
  };
  assert.equal(
    contracts.Check(contracts.SelectAgentSessionModelRequestSchema, preferenceRequest),
    true,
  );

  const turn = {
    schemaVersion: "workbench-v1",
    turnId: "agent-turn-1",
    sessionId: session.sessionId,
    sequence: 1,
    status: "queued",
    modelRoutingState: "pinned",
    kind: "model_task",
    input: { task: "image_generation", ...imageInput },
    requestedModelRevisionId: stabilityRevision.revisionId,
    actualModelRevisionId: null,
    artifactRefs: [],
    result: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
  assert.equal(contracts.Check(contracts.AgentTurnSchema, turn), true);

  const legacy = {
    schemaVersion: "workbench-v1",
    turnId: "agent-turn-legacy-1",
    sessionId: session.sessionId,
    sequence: 1,
    status: "completed",
    modelRoutingState: "legacy_unpinned",
    message: "Historical request",
    result: {
      response: "Historical response",
      proposalId: null,
      handoffId: null,
      invocationIds: [],
    },
    queuedAt: now,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
  };
  assert.equal(contracts.Check(contracts.AgentTurnSchema, legacy), true);
  delete legacy.modelRoutingState;
  assert.equal(contracts.Check(contracts.AgentTurnSchema, legacy), false);
});

test("model_call is typed, cost-bounded, childless, and tool-free", () => {
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-image-1",
    attemptId: "attempt-image-1",
    workspaceId: "workspace-1",
    controller: { kind: "agent_turn", controllerId: "agent-turn-1", fence: 1 },
    mode: "model_call",
    isolation: "process",
    goal: "Generate one image.",
    input: imageInput,
    modelProfileRevisionId: stabilityRevision.revisionId,
    fallbackModelProfileRevisionIds: [],
    modelCapability: "image_generation",
    limits: modelCallLimits,
    capabilities: noCapabilities,
    resultSchema: { type: "object", properties: {}, required: [] },
    evidenceRequirements: [],
    metadata: {},
  };
  assert.equal(contracts.Check(contracts.ExecutionRequestSchema, request), true);
  assert.equal(contracts.Check(contracts.ExecutionRequestSchema, {
    ...request,
    limits: { ...request.limits, maxChildren: 1 },
  }), false);
  assert.equal(contracts.Check(contracts.ExecutionRequestSchema, {
    ...request,
    capabilities: { ...request.capabilities, toolAllowlist: ["unsafe-tool"] },
  }), false);
  assert.equal(contracts.Check(contracts.ExecutionRequestSchema, {
    ...request,
    limits: { ...request.limits, maxImageCount: 17 },
  }), false);
  assert.equal(contracts.Check(contracts.ExecutionRequestSchema, {
    ...request,
    limits: { ...request.limits, maxCostUsdMicros: -1 },
  }), false);

  const invocation = {
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    modelProfileRevisionId: request.modelProfileRevisionId,
    capability: request.modelCapability,
    typedInput: request.input,
    limits: request.limits,
    capabilityLeaseId: "lease-image-1",
    idempotencyKey: "model-call-image-1",
  };
  assert.equal(contracts.Check(contracts.ModelInvocationRequestSchema, invocation), true);
});

test("model-backed Skills require a capability and Workflow drafts use capability-specific profiles", () => {
  const modelExecutionRef = {
    capabilityId: "image.generate",
    taskIntent: "generate_image",
    adapterVersion: "1",
    executionMode: "model",
    requiredModelCapability: "image_generation",
  };
  assert.equal(contracts.Check(contracts.SkillExecutionRefSchema, modelExecutionRef), true);
  const missingCapability = structuredClone(modelExecutionRef);
  delete missingCapability.requiredModelCapability;
  assert.equal(contracts.Check(contracts.SkillExecutionRefSchema, missingCapability), false);
  assert.equal(contracts.Check(contracts.SkillExecutionRefSchema, {
    ...modelExecutionRef,
    executionMode: "agent",
  }), false);

  const currentSettings = {
    maxParallelism: 1,
    defaultTimeoutSeconds: 300,
    agentControllerModelProfileId: "model-profile-chat",
    imageGenerationModelProfileId: "model-profile-stability",
    workflowFallbackAllowed: false,
  };
  assert.equal(contracts.Check(contracts.RunSettingsSchema, currentSettings), true);
  assert.equal(contracts.Check(contracts.WorkflowNodeSchema, {
    ...skillNodeExample,
    configuration: { modelProfileId: "model-profile-stability" },
  }), true);
  assert.equal(contracts.Check(contracts.RunSettingsSchema, {
    maxParallelism: 1,
    defaultTimeoutSeconds: 300,
    modelProfileId: "legacy-profile",
  }), false);
  assert.equal(contracts.Check(contracts.RunSettingsSchema, {
    maxParallelism: 1,
    defaultTimeoutSeconds: 300,
    modelRoutingState: "legacy_unpinned",
    modelProfileId: "legacy-profile",
    fallbackModelProfileIds: ["legacy-fallback"],
  }), true);
  assert.equal(contracts.Check(contracts.RunSettingsSchema, {
    ...currentSettings,
    imageGenerationModelProfileId: null,
  }), false);
});

test("ExecutionPlanV2 pins capability-compatible revision routes and marks legacy projections", () => {
  const step = {
    ...structuredClone(executionPlanExample.steps[1]),
    executionMode: "model_call",
    isolation: "process",
    limits: modelCallLimits,
    capabilities: noCapabilities,
    resultSchema: { type: "object", properties: {}, required: [] },
    evidenceRequirements: [],
    modelRoutingState: "pinned",
    modelProfileRevisionId: stabilityRevision.revisionId,
    modelCapability: "image_generation",
    parameterSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
    fallbackModelProfileRevisionIds: [],
  };
  const plan = {
    ...structuredClone(executionPlanExample),
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    modelRoutingState: "pinned",
    steps: [step],
    reviewGates: [],
  };
  assert.equal(contracts.Check(contracts.ExecutionPlanV2Schema, plan), true);
  const missingRevision = structuredClone(plan);
  delete missingRevision.steps[0].modelProfileRevisionId;
  assert.equal(contracts.Check(contracts.ExecutionPlanV2Schema, missingRevision), false);

  const legacyPlan = structuredClone(plan);
  legacyPlan.modelRoutingState = "legacy_unpinned";
  legacyPlan.steps[0].executionMode = "bounded_agent";
  legacyPlan.steps[0].modelRoutingState = "legacy_unpinned";
  legacyPlan.steps[0].legacyModelProfileId = "legacy-profile";
  delete legacyPlan.steps[0].modelProfileRevisionId;
  delete legacyPlan.steps[0].modelCapability;
  delete legacyPlan.steps[0].parameterSchema;
  delete legacyPlan.steps[0].fallbackModelProfileRevisionIds;
  assert.equal(contracts.Check(contracts.ExecutionPlanV2Schema, legacyPlan), true);
  delete legacyPlan.steps[0].modelRoutingState;
  assert.equal(contracts.Check(contracts.ExecutionPlanV2Schema, legacyPlan), false);
});

test("Run node timeline exposes only safe requested/actual model and Artifact history", () => {
  const nodeRun = {
    schemaVersion: "workbench-v1",
    nodeRunId: "node-run-image-1",
    runId: "run-image-1",
    nodeId: "node-image-1",
    attempt: 1,
    status: "completed",
    summary: "Generated one image Artifact.",
    requestedModelRevisionId: stabilityRevision.revisionId,
    actualModelRevisionId: "model-revision-stability-fallback-1",
    artifactRefs: [artifactRefExample],
    fallbackUsed: true,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(contracts.Check(contracts.NodeRunSchema, nodeRun), true);
  for (const [field, value] of [
    ["providerPayload", { raw: true }],
    ["credentialRef", "keychain:stability"],
    ["storagePath", "/private/object-store/image.png"],
    ["contentBase64", "AA=="],
  ]) {
    assert.equal(contracts.Check(contracts.NodeRunSchema, {
      ...nodeRun,
      [field]: value,
    }), false, `Run node timeline accepted ${field}`);
  }

  assert.equal(contracts.Check(contracts.NodeRunSchema, {
    ...nodeRun,
    actualModelRevisionId: null,
    artifactRefs: [],
    fallbackUsed: false,
    status: "running",
    completedAt: null,
  }), true);
});

test("Artifact metadata and content endpoints are authorized-reference-only and never JSON Base64", () => {
  assert.equal(contracts.Check(contracts.ArtifactMetadataSchema, artifactMetadataExample), true);
  for (const [field, value] of [
    ["storagePath", "/private/object-store/image.png"],
    ["objectId", "internal-object-1"],
    ["contentBase64", "AA=="],
    ["providerPayload", { raw: true }],
    ["credentialRef", "keychain:stability"],
  ]) {
    assert.equal(contracts.Check(contracts.ArtifactMetadataSchema, {
      ...artifactMetadataExample,
      [field]: value,
    }), false, `Artifact metadata accepted ${field}`);
  }

  const endpoints = contracts.WORKBENCH_V1_ARTIFACT_ENDPOINTS;
  assert.equal(endpoints.getArtifactMetadata.path, "/api/workbench/v1/artifacts/{artifactId}");
  assert.equal(endpoints.getArtifactContent.path, "/api/workbench/v1/artifacts/{artifactId}/content");
  assert.equal(endpoints.getArtifactContent.responseMediaType, "application/octet-stream");
  assert.equal(contracts.Check(endpoints.getArtifactContent.responseBodySchema, "data:image/png;base64,AA=="), false);
  assert.equal(contracts.Check(endpoints.getArtifactContent.responseBodySchema, { contentBase64: "AA==" }), false);
  assert.equal(contracts.Check(endpoints.getArtifactContent.responseHeadersSchema, {
    "Content-Type": "image/png",
    "Content-Length": "1024",
    ETag: '"sha256:1122334455667788"',
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  }), true);
});
