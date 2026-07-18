import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "../dist/index.js";
import {
  compileWorkflowRequestExample,
  commitLoopImportRequestExample,
  createLoopImportRequestExample,
  createSkillTestRequestExample,
  createSkillValidationRequestExample,
  errorEnvelopeExample,
  executionPlanExample,
  mutationRequestExamples,
  publicContractExamples,
  runEventExample,
  saveWorkflowRevisionRequestExample,
  skillDefinitionExample,
  skillTestCaseExample,
  skillTestRunExample,
  skillValidationRecordExample,
  skillVersionListResponseExample,
  skillVersionSummaryExample,
  skillDraftPackageExample,
  skillDraftPackageResponseExample,
  replaceSkillDraftPackageRequestExample,
  workspaceResponseExample,
  inputFormExample,
  outputDefinitionExample,
  portableLoopPackageExample,
  loopImportResponseExample,
  runSettingsExample,
  workflowGraphExample,
  workflowDetailResponseExample,
  workflowRevisionExample,
} from "../examples/canonical-examples.mjs";

const formatErrors = (schema, value) =>
  JSON.stringify(contracts.Errors(schema, value), null, 2);

test("every canonical public example validates", () => {
  for (const example of publicContractExamples) {
    const schema = contracts[example.schema];
    assert.ok(schema, `missing exported schema ${example.schema}`);
    assert.equal(
      contracts.Check(schema, example.value),
      true,
      `${example.name} failed validation:\n${formatErrors(schema, example.value)}`,
    );
  }
});

test("required fields and unknown mutation fields are rejected", () => {
  const missingSkillId = structuredClone(skillDefinitionExample);
  delete missingSkillId.skillId;
  assert.equal(contracts.Check(contracts.SkillDefinitionSchema, missingSkillId), false);

  const missingRevisionId = structuredClone(compileWorkflowRequestExample);
  delete missingRevisionId.data.workflowRevisionId;
  assert.equal(
    contracts.Check(contracts.CompileWorkflowRequestSchema, missingRevisionId),
    false,
  );

  for (const endpoint of Object.values(contracts.WORKBENCH_V1_ENDPOINTS)) {
    if (!endpoint.mutation) {
      continue;
    }

    const example = mutationRequestExamples[endpoint.operationId];
    assert.ok(example, `missing mutation example for ${endpoint.operationId}`);
    assert.ok(endpoint.requestBodySchema, `${endpoint.operationId} has no body schema`);

    const unknownEnvelopeField = { ...structuredClone(example), unexpected: true };
    assert.equal(
      contracts.Check(endpoint.requestBodySchema, unknownEnvelopeField),
      false,
      `${endpoint.operationId} accepted an unknown envelope field`,
    );

    const unknownDataField = structuredClone(example);
    unknownDataField.data.unexpected = true;
    assert.equal(
      contracts.Check(endpoint.requestBodySchema, unknownDataField),
      false,
      `${endpoint.operationId} accepted an unknown mutation data field`,
    );
  }
});

test("validation errors come from the TypeBox value runtime", () => {
  const invalid = structuredClone(saveWorkflowRevisionRequestExample);
  invalid.data.runSettings.maxParallelism = 2;

  assert.equal(contracts.Check(contracts.SaveWorkflowRevisionRequestSchema, invalid), false);
  const errors = contracts.Errors(contracts.SaveWorkflowRevisionRequestSchema, invalid);
  assert.ok(Array.isArray(errors));
  assert.ok(errors.length > 0);
  assert.ok(errors.every((error) => typeof error.instancePath === "string"));
});

test("public examples do not expose internal boundary fields", () => {
  const forbiddenKeys = new Set([
    "tool",
    "toolid",
    "toolname",
    "provider",
    "providerid",
    "providername",
    "providerpayload",
    "rawpayload",
    "credentialref",
    "endpoint",
    "artifact",
    "artifactpath",
    "storagepath",
    "base64",
    "contentbase64",
    "dataurl",
    "authorization",
    "containerid",
    "containerpath",
    "environment",
    "imagedigest",
    "secret",
    "secretid",
    "secrettoken",
    "schemapath",
    "daemontoken",
    "requestedby",
    "objectid",
    "packageobjectid",
    "packagehash",
    "executionref",
  ]);

  const visit = (value, path = "$") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      assert.equal(
        forbiddenKeys.has(key.toLowerCase()),
        false,
        `forbidden public field ${path}.${key}`,
      );
      visit(entry, `${path}.${key}`);
    }
  };

  for (const example of publicContractExamples) {
    visit(example.value, example.name);
  }
});

test("error envelope has the frozen strict shape", () => {
  assert.deepEqual(Object.keys(errorEnvelopeExample).sort(), [
    "code",
    "details",
    "message",
    "requestId",
    "retryable",
  ]);
  assert.equal(contracts.Check(contracts.ErrorEnvelopeSchema, errorEnvelopeExample), true);

  const missingRequestId = structuredClone(errorEnvelopeExample);
  delete missingRequestId.requestId;
  assert.equal(contracts.Check(contracts.ErrorEnvelopeSchema, missingRequestId), false);

  const unknown = { ...errorEnvelopeExample, status: 409 };
  assert.equal(contracts.Check(contracts.ErrorEnvelopeSchema, unknown), false);
});

test("run event sequence and identity shape is strict", () => {
  assert.equal(contracts.Check(contracts.RunEventSchema, runEventExample), true);

  for (const sequence of [0, -1, 1.5]) {
    assert.equal(
      contracts.Check(contracts.RunEventSchema, { ...runEventExample, sequence }),
      false,
      `accepted invalid sequence ${sequence}`,
    );
  }

  const missingEventId = structuredClone(runEventExample);
  delete missingEventId.eventId;
  assert.equal(contracts.Check(contracts.RunEventSchema, missingEventId), false);

  assert.equal(
    contracts.Check(contracts.RunEventSchema, {
      ...runEventExample,
      internalDelta: "not public",
    }),
    false,
  );
});

test("ExecutionPlanV2 fixes execution mode, limits, capabilities, schema, and evidence per step", () => {
  const step = {
    ...structuredClone(executionPlanExample.steps[0]),
    executionMode: "deterministic_skill",
    isolation: "process",
    limits: {
      timeoutMs: 60_000,
      maxSteps: 1,
      maxModelRequests: 0,
      maxChildren: 0,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxImageCount: 0,
      maxCostUsdMicros: 0,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    evidenceRequirements: [{
      requirementId: "output:node-input",
      kind: "output",
      required: true,
      description: "Return the node output.",
    }],
  };
  const plan = {
    ...structuredClone(executionPlanExample),
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    modelRoutingState: "not_applicable",
    steps: [step],
    pinnedSkills: [],
    reviewGates: [],
    primaryOutput: { nodeId: "node-input", portId: "value" },
  };
  assert.equal(contracts.Check(contracts.ExecutionPlanV2Schema, plan), true);
  assert.equal(contracts.Check(contracts.ExecutionPlanV1Schema, executionPlanExample), true);
  const missingLimits = structuredClone(plan);
  delete missingLimits.steps[0].limits;
  assert.equal(contracts.Check(contracts.ExecutionPlanV2Schema, missingLimits), false);
});

test("workspace Connection contracts are product-safe, revisioned, and explicitly rebound", () => {
  const now = "2026-07-14T00:00:00.000Z";
  const connection = {
    schemaVersion: "workbench-v1",
    connectionId: "connection-calendar-team",
    workspaceId: "workspace-alpha",
    capabilityKey: "calendar-read",
    label: "Team calendar",
    configuration: {
      accountLabel: "Operations calendar",
      permissionSummary: "Read events from calendars selected by this workspace.",
    },
    status: "connected",
    validation: {
      status: "valid",
      checkedAt: now,
      message: "Connection setup is ready.",
    },
    revision: 2,
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(contracts.Check(contracts.WorkspaceConnectionPublicSchema, connection), true);

  for (const unsafe of [
    { ...structuredClone(connection), secret: "do-not-expose" },
    { ...structuredClone(connection), configuration: { ...connection.configuration, token: "do-not-expose" } },
  ]) {
    assert.equal(contracts.Check(contracts.WorkspaceConnectionPublicSchema, unsafe), false);
  }

  const createRequest = {
    schemaVersion: "workbench-api-v1",
    data: {
      capabilityKey: "calendar-read",
      label: "Team calendar",
      configuration: connection.configuration,
    },
  };
  assert.equal(contracts.Check(contracts.CreateConnectionRequestSchema, createRequest), true);
  assert.equal(contracts.Check(contracts.CreateConnectionRequestSchema, {
    ...structuredClone(createRequest),
    data: { ...createRequest.data, secret: "do-not-accept" },
  }), false);

  const updateRequest = {
    schemaVersion: "workbench-api-v1",
    data: { label: "Primary calendar", enabled: true },
  };
  assert.equal(contracts.Check(contracts.UpdateConnectionRequestSchema, updateRequest), true);
  assert.equal(contracts.Check(contracts.ValidateConnectionRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: {},
  }), true);

  const binding = { requirementId: "calendar-read", connectionId: connection.connectionId };
  assert.equal(contracts.Check(contracts.ConnectionBindingSchema, binding), true);
  assert.equal(contracts.Check(contracts.InstallReleaseRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { connectionIds: [], connectionBindings: [binding] },
  }), true);
  assert.equal(contracts.Check(contracts.StartFromReleaseRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { name: "Calendar brief", connectionBindings: [binding] },
  }), true);

  const endpoints = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS;
  assert.deepEqual(endpoints.updateConnection.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
  assert.deepEqual(endpoints.validateConnection.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
  assert.deepEqual(endpoints.getConnection.responseHeaders, ["ETag"]);
});

test("execution plan freezes sequential pinned execution", () => {
  assert.equal(contracts.Check(contracts.ExecutionPlanV1Schema, executionPlanExample), true);
  assert.equal(executionPlanExample.maxParallelism, 1);
  assert.ok(executionPlanExample.pinnedSkills.length > 0);
  assert.ok(executionPlanExample.steps.every((step) => Array.isArray(step.dependsOn)));
  assert.ok(executionPlanExample.steps.every((step) => Array.isArray(step.inputBindings)));
  assert.ok(executionPlanExample.reviewGates.length > 0);
  assert.equal(executionPlanExample.primaryOutput.nodeId, "node-output");

  assert.equal(
    contracts.Check(contracts.ExecutionPlanV1Schema, {
      ...executionPlanExample,
      maxParallelism: 2,
    }),
    false,
  );
});

test("workflow runs are pinned to an immutable execution plan hash", () => {
  const runExample = publicContractExamples.find(
    (example) => example.schema === "WorkflowRunSchema",
  )?.value;
  assert.ok(runExample);
  assert.equal(runExample.executionPlanContentHash, executionPlanExample.contentHash);
  const queuedWithoutFinal = structuredClone(runExample);
  queuedWithoutFinal.status = "queued";
  queuedWithoutFinal.authoritativeReadModel = { available: false, version: 0 };
  assert.equal(contracts.Check(contracts.WorkflowRunSchema, queuedWithoutFinal), true);

  const executionPlanV2Run = structuredClone(queuedWithoutFinal);
  executionPlanV2Run.executionPlanVersion = contracts.EXECUTION_PLAN_V2_SCHEMA_VERSION;
  assert.equal(contracts.Check(contracts.WorkflowRunSchema, executionPlanV2Run), true);

  const unknownExecutionPlanRun = structuredClone(queuedWithoutFinal);
  unknownExecutionPlanRun.executionPlanVersion = "workbench-execution-plan-v3";
  assert.equal(contracts.Check(contracts.WorkflowRunSchema, unknownExecutionPlanRun), false);

  const unpinnedRun = structuredClone(runExample);
  delete unpinnedRun.executionPlanContentHash;
  assert.equal(contracts.Check(contracts.WorkflowRunSchema, unpinnedRun), false);
});

test("first-slice endpoint metadata covers the frozen API and excludes proposals", () => {
  const endpointSignatures = new Set(
    Object.values(contracts.WORKBENCH_V1_ENDPOINTS).map(
      ({ method, path }) => `${method} ${path}`,
    ),
  );

  const expected = [
    "GET /api/workbench/v1/workspace",
    "GET /api/workbench/v1/skills",
    "GET /api/workbench/v1/skills/{skillId}",
    "GET /api/workbench/v1/templates",
    "GET /api/workbench/v1/templates/{templateId}",
    "POST /api/workbench/v1/templates/{templateId}/workflows",
    "GET /api/workbench/v1/workflows",
    "GET /api/workbench/v1/workflows/{workflowId}",
    "GET /api/workbench/v1/workflows/{workflowId}/revisions/{revisionId}",
    "POST /api/workbench/v1/workflows/{workflowId}/revisions",
    "POST /api/workbench/v1/workflows/{workflowId}/compile",
    "POST /api/workbench/v1/workflows/{workflowId}/runs",
    "GET /api/workbench/v1/workflows/{workflowId}/runs",
    "GET /api/workbench/v1/runs/{runId}",
    "GET /api/workbench/v1/runs/{runId}/events",
    "POST /api/workbench/v1/runs/{runId}/review-decisions",
  ];

  assert.deepEqual([...endpointSignatures].sort(), expected.sort());
  assert.ok(
    Object.values(contracts.WORKBENCH_V1_ENDPOINTS).every((endpoint) =>
      endpoint.path.startsWith(contracts.WORKBENCH_API_PREFIX),
    ),
  );
  assert.ok(
    Object.values(contracts.WORKBENCH_V1_ENDPOINTS).every(
      (endpoint) => !endpoint.path.includes("/proposals"),
    ),
  );
});

test("mutation, revision, ETag, and event cursor header contracts are explicit", () => {
  const mutations = Object.values(contracts.WORKBENCH_V1_ENDPOINTS).filter(
    (endpoint) => endpoint.mutation,
  );
  assert.ok(mutations.length > 0);
  assert.ok(
    mutations.every((endpoint) =>
      endpoint.requiredRequestHeaders.includes("Idempotency-Key"),
    ),
  );

  const save = contracts.WORKBENCH_V1_ENDPOINTS.saveWorkflowRevision;
  assert.ok(save.requiredRequestHeaders.includes("If-Match"));
  assert.ok(save.responseHeaders.includes("ETag"));
  assert.equal(
    contracts.Check(save.requestHeadersSchema, {
      "Idempotency-Key": "idem-save-001",
      "If-Match": '"revision-reviewed-brief-1"',
    }),
    true,
  );
  assert.equal(
    contracts.Check(save.requestHeadersSchema, {
      "Idempotency-Key": "idem-save-001",
    }),
    false,
  );
  assert.equal(
    contracts.Check(save.responseHeadersSchema, {
      ETag: '"revision-reviewed-brief-2"',
    }),
    true,
  );

  const events = contracts.WORKBENCH_V1_ENDPOINTS.getRunEvents;
  assert.ok(events.optionalRequestHeaders.includes("Last-Event-ID"));
  assert.equal(
    contracts.Check(events.requestHeadersSchema, { "Last-Event-ID": "42" }),
    true,
  );
});

test("workspace bootstrap carries a product session CSRF token", () => {
  assert.equal(
    contracts.Check(contracts.WorkspaceResponseSchema, workspaceResponseExample),
    true,
  );
  assert.ok(workspaceResponseExample.data.session.csrfToken.length >= 32);

  const missingToken = structuredClone(workspaceResponseExample);
  delete missingToken.data.session.csrfToken;
  assert.equal(contracts.Check(contracts.WorkspaceResponseSchema, missingToken), false);
});

test("V1 lifecycle contracts preserve immutable versions and product-safe records", () => {
  const now = "2026-07-10T00:00:00.000Z";
  const risk = { level: "low", externalAction: false, summary: "Read-only summary." };
  const executionRef = {
    capabilityId: "capability-meeting-summary",
    taskIntent: "meeting_summary",
    adapterVersion: "1.0.0",
    executionMode: "agent",
  };
  const connectionRequirement = {
    requirementId: "calendar-read",
    label: "Calendar access",
    required: false,
    permissionSummary: "Read calendars chosen by the workspace.",
  };
  const definition = {
    goal: "Turn meeting notes into a reviewed action list.",
    context: "Internal meetings only.",
    constraints: ["Do not publish externally."],
    doneWhen: ["An owner and due date are proposed for each action."],
    verify: ["A reviewer approves the action list."],
    expectedResult: "A reviewed action list.",
    stopRules: ["Stop if source notes are missing."],
  };
  const skillVersion = {
    schemaVersion: "workbench-v1",
    skillVersionId: "skill-version-meeting-summary-1",
    skillId: "skill-meeting-summary",
    workspaceId: "workspace-alpha",
    version: "1.0.0",
    packageObjectId: "object-skill-package-1",
    packageHash: "sha256:0123456789abcdef",
    contentHash: "sha256:fedcba9876543210",
    manifest: {},
    name: "Meeting summary",
    description: "Summarizes approved meeting material.",
    category: "meetings",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk,
    dependencies: [],
    connectionRequirements: [connectionRequirement],
    validation: { validationId: "validation-1", status: "passed", diagnostics: [], testedAt: now },
    executionRef,
    publishedBy: "user-owner",
    publishedAt: now,
  };
  const skillDraft = {
    schemaVersion: "workbench-v1",
    skillDraftId: "skill-draft-meeting-summary-1",
    skillId: "skill-meeting-summary",
    workspaceId: "workspace-alpha",
    baseVersionId: null,
    revision: 1,
    name: "Meeting summary",
    description: "Summarizes approved meeting material.",
    category: "meetings",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk,
    dependencies: [],
    connectionRequirements: [connectionRequirement],
    files: [{
      path: "SKILL.md",
      objectId: "object-skill-package-1",
      contentHash: "sha256:0123456789abcdef",
      mediaType: "text/markdown",
      sizeBytes: 128,
    }],
    executionRef,
    updatedBy: "user-owner",
    createdAt: now,
    updatedAt: now,
  };
  const release = {
    schemaVersion: "workbench-v1",
    releaseId: "release-meeting-summary-1",
    sourceWorkspaceId: "workspace-alpha",
    assetKind: "skill",
    assetId: "skill-meeting-summary",
    versionId: "skill-version-meeting-summary-1",
    contentHash: "sha256:fedcba9876543210",
    visibility: "workspace",
    startingPoint: false,
    releaseNotes: "Initial release.",
    dependencies: [],
    publishedBy: "user-owner",
    publishedAt: now,
  };
  const proposal = {
    schemaVersion: "workbench-v1",
    proposalId: "proposal-meeting-loop-1",
    workspaceId: "workspace-alpha",
    workflowId: "workflow-meeting-actions",
    baseRevisionId: workflowRevisionExample.revisionId,
    summary: "Add one meeting summary step.",
    operations: [{ op: "updateDefinition", definition }],
    diagnostics: [],
    permissionImpact: [connectionRequirement],
    status: "proposed",
    createdBy: "user-owner",
    createdAt: now,
    decidedAt: null,
  };
  const snapshot = {
    schemaVersion: "workbench-v1",
    runId: "run-meeting-1",
    workspaceId: "workspace-alpha",
    workflowId: workflowRevisionExample.workflowId,
    workflowRevisionId: workflowRevisionExample.revisionId,
    loopVersionId: null,
    graph: workflowGraphExample,
    inputForm: inputFormExample,
    outputDefinition: outputDefinitionExample,
    runSettings: runSettingsExample,
    planHash: "sha256:0011223344556677",
    skillVersions: [skillVersion],
    resourceObjectIds: [],
    connectionIds: [],
    createdAt: now,
  };
  const upload = {
    schemaVersion: "workbench-v1",
    uploadId: "upload-meeting-skill-1",
    workspaceId: "workspace-alpha",
    requestedBy: "user-owner",
    state: "ready_draft",
    objectId: "object-skill-package-1",
    filename: "meeting-action-extractor.zip",
    sizeBytes: 128,
    mediaType: "application/zip",
    findings: [],
    inspection: {
      status: "passed",
      contentHash: "sha256:0123456789abcdef",
      manifest: {
        name: "meeting-action-extractor",
        description: "Extract actions from supplied meeting notes.",
        compatibility: "Local only",
        disableModelInvocation: true,
      },
      inventory: [{ path: "SKILL.md", sizeBytes: 128, kind: "instructions" }],
      diagnostics: [],
    },
    createdAt: now,
    updatedAt: now,
  };

  assert.equal(contracts.Check(contracts.ProductSessionSchema, {
    schemaVersion: "workbench-v1",
    sessionId: "session-alpha",
    userId: "user-owner",
    activeWorkspaceId: "workspace-alpha",
    expiresAt: now,
  }), true);
  assert.equal(contracts.Check(contracts.SkillDraftSchema, skillDraft), true);
  assert.equal(contracts.Check(contracts.SkillVersionSchema, skillVersion), true);
  const skillAssetSummary = {
    skill: {
      schemaVersion: "workbench-v1",
      skillId: skillVersion.skillId,
      visibility: "private",
      lifecycle: "ready",
      currentDraftId: skillDraft.skillDraftId,
      latestPublishedVersionId: skillVersion.skillVersionId,
      allowedActions: ["create_version", "retire"],
      createdAt: now,
      updatedAt: now,
    },
    draft: {
      schemaVersion: skillDraft.schemaVersion,
      skillDraftId: skillDraft.skillDraftId,
      skillId: skillDraft.skillId,
      baseVersionId: skillDraft.baseVersionId,
      revision: skillDraft.revision,
      name: skillDraft.name,
      description: skillDraft.description,
      category: skillDraft.category,
      inputSchema: skillDraft.inputSchema,
      outputSchema: skillDraft.outputSchema,
      risk: skillDraft.risk,
      dependencies: skillDraft.dependencies,
      connectionRequirements: skillDraft.connectionRequirements,
      fileCount: skillDraft.files.length,
      createdAt: skillDraft.createdAt,
      updatedAt: skillDraft.updatedAt,
    },
    latestVersion: {
      schemaVersion: skillVersion.schemaVersion,
      skillVersionId: skillVersion.skillVersionId,
      skillId: skillVersion.skillId,
      version: skillVersion.version,
      name: skillVersion.name,
      description: skillVersion.description,
      category: skillVersion.category,
      inputSchema: skillVersion.inputSchema,
      outputSchema: skillVersion.outputSchema,
      risk: skillVersion.risk,
      dependencies: skillVersion.dependencies,
      connectionRequirements: skillVersion.connectionRequirements,
      validation: { status: skillVersion.validation.status, testedAt: skillVersion.validation.testedAt },
      publishedAt: skillVersion.publishedAt,
    },
  };
  assert.equal(contracts.Check(contracts.SkillAssetSummarySchema, skillAssetSummary), true);
  for (const [target, field, value] of [
    ["skill", "workspaceId", "workspace-alpha"],
    ["skill", "ownerId", "user-owner"],
    ["draft", "files", skillDraft.files],
    ["draft", "executionRef", executionRef],
    ["latestVersion", "packageObjectId", "object-skill-package-1"],
    ["latestVersion", "packageHash", "sha256:internal"],
    ["latestVersion", "contentHash", "sha256:internal"],
    ["latestVersion", "manifest", {}],
    ["latestVersion", "executionRef", executionRef],
  ]) {
    const unsafe = structuredClone(skillAssetSummary);
    unsafe[target][field] = value;
    assert.equal(
      contracts.Check(contracts.SkillAssetSummarySchema, unsafe),
      false,
      `SkillAssetSummary accepted forbidden ${target}.${field}`,
    );
  }
  assert.equal(contracts.Check(contracts.LoopDefinitionSchema, definition), true);
  assert.equal(contracts.Check(contracts.WorkspaceAssetReleaseSchema, release), true);
  assert.equal(contracts.Check(contracts.LifecycleBuilderProposalSchema, proposal), true);
  assert.equal(contracts.Check(contracts.RunExecutionSnapshotSchema, snapshot), true);
  const runJob = {
    schemaVersion: "workbench-v1",
    runJobId: "job-meeting-1",
    runId: "run-meeting-1",
    workspaceId: "workspace-alpha",
    status: "leased",
    fence: 1,
    checkpointSequence: 0,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2026-07-10T00:00:30.000Z",
    heartbeatAt: now,
    queuedAt: now,
    updatedAt: now,
  };
  assert.equal(contracts.Check(contracts.RunJobSchema, runJob), true);
  assert.equal(typeof contracts.RunLeaseSchema, "object");
  assert.equal(contracts.Check(contracts.RunLeaseSchema, {
    schemaVersion: "workbench-v1",
    runId: "run-meeting-1",
    runJobId: "job-meeting-1",
    workspaceId: "workspace-alpha",
    workerId: "worker-a",
    fence: 1,
    status: "active",
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: "2026-07-10T00:00:30.000Z",
    releasedAt: null,
    updatedAt: now,
  }), true);
  assert.equal(contracts.Check(contracts.RunLeaseSchema, {
    schemaVersion: "workbench-v1",
    runId: "run-meeting-cancelled",
    runJobId: "job-meeting-cancelled",
    workspaceId: "workspace-alpha",
    workerId: "worker-a",
    fence: 2,
    status: "cancelled",
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: "2026-07-10T00:00:30.000Z",
    releasedAt: "2026-07-10T00:00:02.000Z",
    updatedAt: "2026-07-10T00:00:02.000Z",
  }), true);
  assert.equal(contracts.Check(contracts.UploadSessionSchema, upload), true);

  const mutableVersion = structuredClone(skillVersion);
  delete mutableVersion.packageHash;
  assert.equal(contracts.Check(contracts.SkillVersionSchema, mutableVersion), false);

  const proposalWithTenant = structuredClone(proposal);
  proposalWithTenant.operations[0].workspaceId = "workspace-other";
  assert.equal(contracts.Check(contracts.LifecycleBuilderProposalSchema, proposalWithTenant), false);

  const internalUpload = structuredClone(upload);
  internalUpload.inspection.packageBytes = "must not be public";
  assert.equal(contracts.Check(contracts.UploadSessionSchema, internalUpload), false);
});

test("V1 lifecycle endpoint metadata is additive and protects writes", () => {
  const endpoints = Object.values(contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS);
  assert.ok(endpoints.length >= 20);
  assert.ok(endpoints.every((endpoint) => endpoint.path.startsWith(contracts.WORKBENCH_API_PREFIX)));
  assert.ok(endpoints.some((endpoint) => endpoint.path.includes("/proposals")));
  assert.ok(endpoints.some((endpoint) => endpoint.path.includes("/team-library")));
  assert.ok(endpoints.some((endpoint) => endpoint.path.includes("/uploads")));
  assert.ok(endpoints.some((endpoint) => endpoint.path.includes("/runs/{runId}/cancel")));
  const fork = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS.forkTeamLibraryLoop;
  assert.equal(fork.method, "POST");
  assert.equal(fork.path, `${contracts.WORKBENCH_API_PREFIX}/team-library/{releaseId}/fork`);
  assert.equal(fork.successStatus, 201);
  assert.deepEqual(fork.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.equal(fork.requestBodySchema, contracts.StartFromReleaseRequestSchema);
  assert.equal(fork.responseBodySchema, contracts.CreateLoopResponseSchema);
  const preview = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getLoopSkillUpdatePreview;
  assert.equal(preview.method, "GET");
  assert.equal(
    preview.path,
    `${contracts.WORKBENCH_API_PREFIX}/loops/{workflowId}/skill-updates/{skillVersionId}`,
  );
  assert.deepEqual(preview.requiredRequestHeaders, []);
  assert.deepEqual(preview.responseHeaders, ["ETag"]);
  assert.equal(
    contracts.Check(contracts.LoopSkillUpdatePreviewResponseSchema, {
      schemaVersion: "workbench-api-v1",
      data: {
        workflowId: "workflow-meeting-actions",
        workflowRevisionId: "revision-meeting-actions-1",
        workflowName: "Meeting actions",
        skillId: "skill-meeting-actions",
        currentVersion: {
          skillVersionId: "skill-version-meeting-actions-v1",
          version: "1.0.0",
          name: "Meeting actions",
          description: "Find follow-up work in meeting notes.",
          risk: { level: "low", externalAction: false, summary: "No external action." },
          connectionRequirements: [],
        },
        targetVersion: {
          skillVersionId: "skill-version-meeting-actions-v2",
          version: "2.0.0",
          name: "Meeting actions",
          description: "Find owners and dates in meeting notes.",
          risk: { level: "low", externalAction: false, summary: "No external action." },
          connectionRequirements: [],
        },
        affectedNodes: [{ nodeId: "node-skill", title: "Extract action items" }],
        changes: [{ field: "purpose", changed: true, summary: "The Skill description or name changed.", severity: "info" }],
        requiresTestRun: true,
      },
      requestId: "request-loop-update-preview",
    }),
    true,
  );
  assert.ok(
    endpoints.filter((endpoint) => endpoint.mutation).every((endpoint) =>
      endpoint.requiredRequestHeaders.includes("Idempotency-Key"),
    ),
  );
  assert.ok(
    endpoints.filter((endpoint) => endpoint.path.includes("publish") || endpoint.path.includes("proposals")).every(
      (endpoint) => endpoint.requiredRequestHeaders.includes("If-Match"),
    ),
  );
});

test("uploaded Skill test and validation records are exact-hash, strict, and bounded", () => {
  assert.equal(contracts.Check(contracts.SkillTestCaseSchema, skillTestCaseExample), true);
  assert.equal(contracts.Check(contracts.SkillTestRunSchema, skillTestRunExample), true);
  assert.equal(
    contracts.Check(contracts.SkillValidationRecordSchema, skillValidationRecordExample),
    true,
  );

  for (const timeoutSeconds of [0, 121, 1.5]) {
    assert.equal(
      contracts.Check(contracts.SkillTestCaseSchema, {
        ...skillTestCaseExample,
        timeoutSeconds,
      }),
      false,
      `accepted unsafe timeout ${timeoutSeconds}`,
    );
  }

  assert.equal(
    contracts.Check(contracts.SkillTestCaseSchema, {
      ...skillTestCaseExample,
      input: ["not", "an", "object"],
    }),
    false,
  );
  assert.equal(
    contracts.Check(contracts.SkillTestCaseSchema, {
      ...skillTestCaseExample,
      expectedOutput: "not an object",
    }),
    false,
  );
  assert.equal(
    contracts.Check(contracts.SkillTestCaseSchema, {
      ...skillTestCaseExample,
      unexpected: true,
    }),
    false,
  );

  for (const [schema, value] of [
    [contracts.SkillTestRunSchema, { ...skillTestRunExample, status: "succeeded" }],
    [contracts.SkillTestRunSchema, { ...skillTestRunExample, imageDigest: "sha256:internal" }],
    [contracts.SkillTestRunSchema, { ...skillTestRunExample, containerId: "internal-worker" }],
    [contracts.SkillTestRunSchema, { ...skillTestRunExample, environment: { TOKEN: "secret" } }],
    [contracts.SkillValidationRecordSchema, { ...skillValidationRecordExample, status: "complete" }],
    [contracts.SkillValidationRecordSchema, { ...skillValidationRecordExample, provider: "internal" }],
    [
      contracts.SkillValidationRecordSchema,
      {
        ...skillValidationRecordExample,
        runtimeSummary: {
          ...skillValidationRecordExample.runtimeSummary,
          containerPath: "/internal/package",
        },
      },
    ],
    [
      contracts.SkillValidationRecordSchema,
      {
        ...skillValidationRecordExample,
        runtimeSummary: {
          ...skillValidationRecordExample.runtimeSummary,
          tool: "internal-executor",
        },
      },
    ],
  ]) {
    assert.equal(contracts.Check(schema, value), false);
  }

  const testWithoutPackageHash = structuredClone(skillTestRunExample);
  delete testWithoutPackageHash.packageHash;
  assert.equal(contracts.Check(contracts.SkillTestRunSchema, testWithoutPackageHash), false);

  const validationWithoutDraftRevision = structuredClone(skillValidationRecordExample);
  delete validationWithoutDraftRevision.draftRevision;
  assert.equal(
    contracts.Check(contracts.SkillValidationRecordSchema, validationWithoutDraftRevision),
    false,
  );
});

test("Skill validation requests require passed-run references and explicit permission acknowledgement", () => {
  assert.equal(
    contracts.Check(contracts.CreateSkillTestRequestSchema, createSkillTestRequestExample),
    true,
  );
  assert.equal(
    contracts.Check(
      contracts.CreateSkillValidationRequestSchema,
      createSkillValidationRequestExample,
    ),
    true,
  );

  const unknownTestField = structuredClone(createSkillTestRequestExample);
  unknownTestField.data.unexpected = true;
  assert.equal(contracts.Check(contracts.CreateSkillTestRequestSchema, unknownTestField), false);

  for (const invalidData of [
    { testRunIds: [], permissionAcknowledged: true },
    { testRunIds: [skillTestRunExample.testRunId], permissionAcknowledged: false },
    {
      testRunIds: [skillTestRunExample.testRunId, skillTestRunExample.testRunId],
      permissionAcknowledged: true,
    },
    {
      testRunIds: [skillTestRunExample.testRunId],
      permissionAcknowledged: true,
      unexpected: true,
    },
  ]) {
    assert.equal(
      contracts.Check(contracts.CreateSkillValidationRequestSchema, {
        ...createSkillValidationRequestExample,
        data: invalidData,
      }),
      false,
    );
  }

  const legacyEvidence = {
    validationId: "validation-legacy-1",
    status: "passed",
    diagnostics: [],
    testedAt: "2026-07-10T10:00:00.000Z",
  };
  assert.equal(contracts.Check(contracts.SkillValidationEvidenceSchema, legacyEvidence), true);
  assert.equal(contracts.Check(contracts.SkillValidationEvidenceSchema, {
    ...legacyEvidence,
    contentHash: skillTestRunExample.contentHash,
    testRunIds: [skillTestRunExample.testRunId],
  }), true);
});

test("Skill version summaries expose only product-safe history fields", () => {
  assert.equal(
    contracts.Check(contracts.SkillVersionSummarySchema, skillVersionSummaryExample),
    true,
  );
  assert.equal(
    contracts.Check(contracts.SkillVersionListResponseSchema, skillVersionListResponseExample),
    true,
  );

  const forbiddenFields = {
    workspaceId: "workspace-internal",
    packageObjectId: "object-internal",
    packageHash: "sha256:internal",
    contentHash: "sha256:internal",
    manifest: {},
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    executionRef: { capabilityId: "internal" },
    provider: "internal-provider",
    tool: "internal-tool",
    artifactPath: "/internal/artifact",
  };
  for (const [field, value] of Object.entries(forbiddenFields)) {
    assert.equal(
      contracts.Check(contracts.SkillVersionSummarySchema, {
        ...skillVersionSummaryExample,
        [field]: value,
      }),
      false,
      `SkillVersionSummary accepted forbidden field ${field}`,
    );
  }
});

test("Skill version history endpoint uses the product list contract", () => {
  const endpoint = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillVersions;
  assert.equal(endpoint.method, "GET");
  assert.equal(endpoint.path, "/api/workbench/v1/skills/{skillId}/versions");
  assert.equal(endpoint.mutation, false);
  assert.equal(endpoint.responseBodySchema, contracts.SkillVersionListResponseSchema);
});

test("Skill draft package contracts are strict, bounded, and product-safe", () => {
  assert.equal(contracts.Check(contracts.SkillDraftPackageSchema, skillDraftPackageExample), true);
  assert.equal(
    contracts.Check(contracts.SkillDraftPackageResponseSchema, skillDraftPackageResponseExample),
    true,
  );
  assert.equal(
    contracts.Check(contracts.ReplaceSkillDraftPackageRequestSchema, replaceSkillDraftPackageRequestExample),
    true,
  );
  const executablePackage = structuredClone(skillDraftPackageExample);
  executablePackage.files.push({
    path: "skill.runtime.json",
    kind: "runtime_manifest",
    sizeBytes: 201,
    content: '{"runtime":"python3.12"}\n',
  });
  assert.equal(contracts.Check(contracts.SkillDraftPackageSchema, executablePackage), true);

  for (const forbidden of [
    ["workspaceId", "workspace-private"],
    ["objectId", "object-private"],
    ["contentHash", "sha256:private"],
    ["executionRef", { capabilityId: "private" }],
    ["provider", "private-provider"],
    ["tool", "private-tool"],
    ["artifactPath", "/private/artifact"],
  ]) {
    const unsafe = structuredClone(skillDraftPackageExample);
    unsafe[forbidden[0]] = forbidden[1];
    assert.equal(
      contracts.Check(contracts.SkillDraftPackageSchema, unsafe),
      false,
      `SkillDraftPackage accepted forbidden ${forbidden[0]}`,
    );
  }

  const unsafeFile = structuredClone(skillDraftPackageExample);
  unsafeFile.files[0].objectId = "object-private";
  assert.equal(contracts.Check(contracts.SkillDraftPackageSchema, unsafeFile), false);

  for (const invalid of [
    { ...skillDraftPackageExample, files: skillDraftPackageExample.files.slice(0, 1) },
    { ...skillDraftPackageExample, files: [...skillDraftPackageExample.files, skillDraftPackageExample.files[0]] },
    {
      ...skillDraftPackageExample,
      files: [{ ...skillDraftPackageExample.files[0], kind: "binary" }, skillDraftPackageExample.files[1]],
    },
    {
      ...skillDraftPackageExample,
      files: [{ ...skillDraftPackageExample.files[0], sizeBytes: 1048577 }, skillDraftPackageExample.files[1]],
    },
  ]) {
    assert.equal(contracts.Check(contracts.SkillDraftPackageSchema, invalid), false);
  }

  for (const invalidRequest of [
    { schemaVersion: "workbench-api-v1", data: {} },
    { ...replaceSkillDraftPackageRequestExample, data: { uploadId: "upload-2", objectId: "object-private" } },
    { ...replaceSkillDraftPackageRequestExample, extra: true },
  ]) {
    assert.equal(contracts.Check(contracts.ReplaceSkillDraftPackageRequestSchema, invalidRequest), false);
  }
});

test("Skill draft package endpoints share one path and PUT freezes revision mutation semantics", () => {
  const { getSkillDraftPackage: read, replaceSkillDraftPackage: replace } = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS;
  const path = "/api/workbench/v1/skills/{skillId}/drafts/{draftId}/package";
  assert.equal(read.method, "GET");
  assert.equal(replace.method, "PUT");
  assert.equal(read.path, path);
  assert.equal(replace.path, path);
  assert.equal(read.responseBodySchema, contracts.SkillDraftPackageResponseSchema);
  assert.equal(replace.requestBodySchema, contracts.ReplaceSkillDraftPackageRequestSchema);
  assert.equal(replace.responseBodySchema, contracts.SkillDraftResponseSchema);
  assert.deepEqual(replace.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
  assert.deepEqual(replace.responseHeaders, ["ETag"]);
});

test("Skill test and validation endpoints freeze paths and revision headers", () => {
  const endpoints = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS;
  const expected = [
    [
      endpoints.createSkillTest,
      "POST",
      "/api/workbench/v1/skills/{skillId}/drafts/{draftId}/tests",
    ],
    [
      endpoints.getSkillTestRun,
      "GET",
      "/api/workbench/v1/skills/{skillId}/tests/{testRunId}",
    ],
    [
      endpoints.createSkillValidation,
      "POST",
      "/api/workbench/v1/skills/{skillId}/drafts/{draftId}/validations",
    ],
    [
      endpoints.getSkillValidation,
      "GET",
      "/api/workbench/v1/skills/{skillId}/validations/{validationId}",
    ],
  ];

  for (const [endpoint, method, path] of expected) {
    assert.equal(endpoint.method, method);
    assert.equal(endpoint.path, path);
  }

  for (const endpoint of [endpoints.createSkillTest, endpoints.createSkillValidation]) {
    assert.deepEqual(endpoint.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
    assert.equal(endpoint.successStatus, 202);
    assert.equal(
      contracts.Check(endpoint.requestHeadersSchema, {
        "Idempotency-Key": "idem-skill-validation-1",
        "If-Match": '"skill-draft-revision-3"',
      }),
      true,
    );
    assert.equal(
      contracts.Check(endpoint.requestHeadersSchema, {
        "Idempotency-Key": "idem-skill-validation-1",
      }),
      false,
    );
    assert.equal(
      contracts.Check(endpoint.requestHeadersSchema, {
        "If-Match": '"skill-draft-revision-3"',
      }),
      false,
    );
  }
});

test("upload promotion permission acknowledgement is optional and strict", () => {
  const legacyRequest = {
    schemaVersion: "workbench-api-v1",
    data: {},
  };
  assert.equal(contracts.Check(contracts.PromoteUploadRequestSchema, legacyRequest), true);
  assert.equal(contracts.Check(contracts.PromoteUploadRequestSchema, {
    ...legacyRequest,
    data: { permissionAcknowledged: true },
  }), true);
  assert.equal(contracts.Check(contracts.PromoteUploadRequestSchema, {
    ...legacyRequest,
    data: { permissionAcknowledged: false },
  }), false);
});

test("resumable upload and repository import contracts expose only product progress", () => {
  const upload = {
    schemaVersion: "workbench-v1",
    uploadId: "upload-public-1",
    state: "needs_decision",
    filename: "reviewer.skill",
    sizeBytes: 700000,
    mediaType: "application/vnd.looloomi.skill-package+json",
    ingestMethod: "resumable",
    transfer: {
      chunkSizeBytes: 524288,
      totalChunks: 2,
      receivedChunks: [0, 1],
      receivedBytes: 700000,
      complete: true,
    },
    findings: [],
    inspection: {
      status: "needs_review",
      manifest: {
        name: "reviewer",
        description: "Review supplied text.",
        compatibility: null,
        disableModelInvocation: true,
        runtime: {
          runtime: "python3.12",
          entrypoint: "scripts/main.py",
          protocol: { stdin: "json", stdout: "json" },
          permissions: {
            network: false,
            connections: [],
            externalActions: false,
            filesystem: "scratch-only",
          },
        },
      },
      inventory: [
        { path: "SKILL.md", sizeBytes: 128, kind: "instructions" },
        { path: "skill.runtime.json", sizeBytes: 201, kind: "runtime_manifest" },
      ],
      diagnostics: [],
    },
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:01.000Z",
  };
  assert.equal(contracts.Check(contracts.UploadSessionPublicSchema, upload), true);
  for (const [field, value] of Object.entries({
    workspaceId: "workspace-private",
    requestedBy: "user-private",
    objectId: "object-private",
    contentHash: `sha256:${"a".repeat(64)}`,
    executionRef: { capabilityId: "private" },
  })) {
    assert.equal(
      contracts.Check(contracts.UploadSessionPublicSchema, { ...upload, [field]: value }),
      false,
      `public upload accepted ${field}`,
    );
  }
  const endpoints = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS;
  assert.equal(endpoints.uploadChunk.method, "PUT");
  assert.equal(endpoints.uploadChunk.path, "/api/workbench/v1/uploads/{uploadId}/chunks/{chunkIndex}");
  assert.equal(endpoints.completeUpload.path, "/api/workbench/v1/uploads/{uploadId}/complete");
  assert.equal(endpoints.importSkillRepository.path, "/api/workbench/v1/uploads/repository");
  assert.equal(contracts.Check(contracts.UploadChunkRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { contentBase64: Buffer.from("chunk").toString("base64") },
  }), true);
  assert.equal(contracts.Check(contracts.ImportSkillRepositoryRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      repositoryUrl: "https://github.com/openai/example",
      ref: "main",
      skillDirectory: "skills/reviewer",
    },
  }), true);
});

test("forked Loop provenance is public, typed, and additive", () => {
  const workflow = structuredClone(workflowDetailResponseExample.data);
  workflow.sourceWorkflow = {
    workflowId: "workflow-upstream-loop",
    revisionId: "revision-upstream-loop-3",
  };
  workflow.sourceRelease = {
    releaseId: "release-upstream-loop-3",
    sourceWorkspaceId: workflow.workspaceId,
    versionId: "loop-version-upstream-loop-3",
    forkedAt: "2026-07-13T08:00:00.000Z",
  };
  assert.equal(
    contracts.Check(contracts.WorkflowSchema, workflow),
    true,
    formatErrors(contracts.WorkflowSchema, workflow),
  );

  const invalid = structuredClone(workflow);
  delete invalid.sourceRelease.releaseId;
  assert.equal(contracts.Check(contracts.WorkflowSchema, invalid), false);
});

test("portable Loop V1 package is strict, local-reference-only, and dependency exact", () => {
  assert.equal(
    contracts.Check(contracts.PortableLoopPackageV1Schema, portableLoopPackageExample),
    true,
    formatErrors(contracts.PortableLoopPackageV1Schema, portableLoopPackageExample),
  );

  const visitSchema = (schema, location = "PortableLoopPackageV1Schema") => {
    if (schema === null || typeof schema !== "object") {
      return;
    }
    if (schema.type === "object") {
      assert.equal(
        schema.additionalProperties,
        false,
        `${location} is not additionalProperties false`,
      );
    }
    for (const [key, value] of Object.entries(schema)) {
      if (key !== "$id") {
        visitSchema(value, `${location}.${key}`);
      }
    }
  };
  visitSchema(contracts.PortableLoopPackageV1Schema);

  const forbiddenKeys = new Set([
    "workspace",
    "workspaceid",
    "user",
    "userid",
    "connectionid",
    "secret",
    "run",
    "runid",
    "release",
    "releaseid",
    "install",
    "installationid",
    "provider",
    "providerid",
    "artifact",
    "artifactpath",
    "path",
  ]);
  const visitValue = (value, location = "portableLoopPackageExample") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visitValue(entry, `${location}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      assert.equal(
        forbiddenKeys.has(key.toLowerCase()),
        false,
        `portable package contains forbidden field ${location}.${key}`,
      );
      visitValue(entry, `${location}.${key}`);
    }
  };
  visitValue(portableLoopPackageExample);

  for (const forbiddenField of forbiddenKeys) {
    assert.equal(
      contracts.Check(contracts.PortableLoopPackageV1Schema, {
        ...portableLoopPackageExample,
        [forbiddenField]: "forbidden",
      }),
      false,
      `portable package accepted ${forbiddenField}`,
    );
  }

  const missingVersion = structuredClone(portableLoopPackageExample);
  delete missingVersion.requirements.skills[0].version;
  assert.equal(contracts.Check(contracts.PortableLoopPackageV1Schema, missingVersion), false);

  const missingHash = structuredClone(portableLoopPackageExample);
  delete missingHash.requirements.skills[0].contentHash;
  assert.equal(contracts.Check(contracts.PortableLoopPackageV1Schema, missingHash), false);

  const directSkillIdentity = structuredClone(portableLoopPackageExample);
  directSkillIdentity.graph.nodes.find((node) => node.kind === "Skill").skillRef = {
    skillId: "skill-research-brief",
    version: "1.0.0",
  };
  assert.equal(
    contracts.Check(contracts.PortableLoopPackageV1Schema, directSkillIdentity),
    false,
  );

  const directMaterialIdentity = structuredClone(portableLoopPackageExample);
  directMaterialIdentity.graph.nodes.find((node) => node.kind === "Material").configuration = {
    resourceIds: ["resource-private-1"],
  };
  assert.equal(
    contracts.Check(contracts.PortableLoopPackageV1Schema, directMaterialIdentity),
    false,
  );

  for (const [section, field, value] of [
    ["skills", "workspaceId", "workspace-private"],
    ["connections", "connectionId", "connection-private"],
    ["connections", "secret", "private"],
    ["materials", "path", "private/file.md"],
  ]) {
    const invalid = structuredClone(portableLoopPackageExample);
    invalid.requirements[section][0][field] = value;
    assert.equal(
      contracts.Check(contracts.PortableLoopPackageV1Schema, invalid),
      false,
      `portable requirement accepted ${section}.${field}`,
    );
  }

  for (const archiveField of ["archive", "entries", "files"]) {
    assert.equal(
      contracts.Check(contracts.PortableLoopPackageV1Schema, {
        ...portableLoopPackageExample,
        [archiveField]: [],
      }),
      false,
      `portable package accepted archive field ${archiveField}`,
    );
  }

  const binaryMaterial = structuredClone(portableLoopPackageExample);
  binaryMaterial.embeddedMaterials[0].mediaType = "application/octet-stream";
  assert.equal(contracts.Check(contracts.PortableLoopPackageV1Schema, binaryMaterial), false);

  const base64Material = structuredClone(portableLoopPackageExample);
  base64Material.embeddedMaterials[0].contentBase64 = "AA==";
  assert.equal(contracts.Check(contracts.PortableLoopPackageV1Schema, base64Material), false);

  const materialWithPath = structuredClone(portableLoopPackageExample);
  materialWithPath.embeddedMaterials[0].path = "materials/private.md";
  assert.equal(contracts.Check(contracts.PortableLoopPackageV1Schema, materialWithPath), false);

  const oversizedMaterial = structuredClone(portableLoopPackageExample);
  oversizedMaterial.embeddedMaterials[0].content = "x".repeat(262145);
  assert.equal(contracts.Check(contracts.PortableLoopPackageV1Schema, oversizedMaterial), false);
});

test("Loop import DTO requires explicit strict Skill, material, and connection mappings", () => {
  assert.equal(
    contracts.Check(contracts.CreateLoopImportRequestSchema, createLoopImportRequestExample),
    true,
  );
  assert.equal(
    contracts.Check(contracts.LoopImportResponseSchema, loopImportResponseExample),
    true,
  );
  assert.equal(
    contracts.Check(contracts.CommitLoopImportRequestSchema, commitLoopImportRequestExample),
    true,
  );

  for (const mappingField of ["skillMappings", "materialMappings", "connectionMappings"]) {
    const missing = structuredClone(commitLoopImportRequestExample);
    delete missing.data[mappingField];
    assert.equal(
      contracts.Check(contracts.CommitLoopImportRequestSchema, missing),
      false,
      `commit accepted missing ${mappingField}`,
    );
  }

  const implicitSkill = structuredClone(commitLoopImportRequestExample);
  implicitSkill.data.skillMappings[0].version = "latest";
  assert.equal(contracts.Check(contracts.CommitLoopImportRequestSchema, implicitSkill), false);

  const unknownMapping = structuredClone(commitLoopImportRequestExample);
  unknownMapping.data.connectionMappings[0].secret = "private";
  assert.equal(contracts.Check(contracts.CommitLoopImportRequestSchema, unknownMapping), false);

  const workspaceMaterialMapping = structuredClone(commitLoopImportRequestExample);
  workspaceMaterialMapping.data.materialMappings[0].resolution = {
    kind: "workspaceMaterial",
    resourceId: "resource-research-guidance-1",
  };
  assert.equal(
    contracts.Check(contracts.CommitLoopImportRequestSchema, workspaceMaterialMapping),
    true,
  );

  const mismatchedRequirementKind = structuredClone(loopImportResponseExample);
  mismatchedRequirementKind.data.requirementStates[0].kind = "material";
  assert.equal(contracts.Check(contracts.LoopImportResponseSchema, mismatchedRequirementKind), false);
});

test("portable Loop import/export endpoint metadata freezes paths, revisions, and headers", () => {
  const endpoints = contracts.WORKBENCH_V1_LIFECYCLE_ENDPOINTS;

  assert.equal(endpoints.createLoopImport.method, "POST");
  assert.equal(endpoints.createLoopImport.path, "/api/workbench/v1/loop-imports");
  assert.equal(endpoints.createLoopImport.successStatus, 202);
  assert.deepEqual(endpoints.createLoopImport.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.deepEqual(endpoints.createLoopImport.responseHeaders, ["ETag"]);

  assert.equal(endpoints.getLoopImport.method, "GET");
  assert.equal(endpoints.getLoopImport.path, "/api/workbench/v1/loop-imports/{importId}");
  assert.deepEqual(endpoints.getLoopImport.requiredRequestHeaders, []);
  assert.deepEqual(endpoints.getLoopImport.responseHeaders, ["ETag"]);

  assert.equal(endpoints.commitLoopImport.method, "POST");
  assert.equal(
    endpoints.commitLoopImport.path,
    "/api/workbench/v1/loop-imports/{importId}/commit",
  );
  assert.deepEqual(
    endpoints.commitLoopImport.requiredRequestHeaders,
    ["Idempotency-Key", "If-Match"],
  );
  assert.equal(
    contracts.Check(endpoints.commitLoopImport.requestHeadersSchema, {
      "Idempotency-Key": "idem-loop-import-1",
      "If-Match": '"loop-import-reviewed-brief-1"',
    }),
    true,
  );
  assert.equal(
    contracts.Check(endpoints.commitLoopImport.requestHeadersSchema, {
      "Idempotency-Key": "idem-loop-import-1",
    }),
    false,
  );
  assert.deepEqual(endpoints.commitLoopImport.responseHeaders, ["ETag"]);

  assert.equal(endpoints.exportLoop.method, "GET");
  assert.equal(endpoints.exportLoop.path, "/api/workbench/v1/loops/{workflowId}/export");
  assert.equal(
    endpoints.exportLoop.responseMediaType,
    "application/vnd.looloomi.loop-package+json",
  );
  assert.equal(
    endpoints.exportLoop.responseBodySchema,
    contracts.PortableLoopPackageV1Schema,
  );
  assert.deepEqual(endpoints.exportLoop.requiredRequestHeaders, []);
  assert.deepEqual(endpoints.exportLoop.optionalRequestHeaders, ["If-None-Match"]);
  assert.equal(
    contracts.Check(endpoints.exportLoop.requestHeadersSchema, {
      "If-None-Match": '"sha256:abcdef0123456789"',
    }),
    true,
  );
  assert.equal(
    contracts.Check(endpoints.exportLoop.requestHeadersSchema, {}),
    true,
  );
  assert.equal(
    contracts.Check(endpoints.exportLoop.requestHeadersSchema, {
      "If-None-Match": 'W/"sha256:abcdef0123456789"',
    }),
    false,
  );
  assert.deepEqual(endpoints.exportLoop.responseHeaders, ["ETag", "Content-Disposition"]);
  assert.equal(
    contracts.Check(endpoints.exportLoop.responseHeadersSchema, {
      ETag: '"sha256:abcdef0123456789"',
      "Content-Disposition": 'attachment; filename="weekly-brief.loop.json"',
    }),
    true,
  );
  assert.equal(
    contracts.Check(endpoints.exportLoop.responseHeadersSchema, {
      ETag: '"sha256:abcdef0123456789"',
      "Content-Disposition": 'attachment; filename="weekly-brief.zip"',
    }),
    false,
  );
  assert.equal(
    contracts.Check(endpoints.exportLoop.responseHeadersSchema, {
      ETag: 'W/"sha256:abcdef0123456789"',
      "Content-Disposition": 'attachment; filename="weekly-brief.loop.json"',
    }),
    false,
  );
  assert.equal(
    contracts.Check(endpoints.exportLoop.querySchema, {
      revisionId: "revision-reviewed-brief-1",
    }),
    true,
  );
  assert.equal(contracts.Check(endpoints.exportLoop.querySchema, {}), false);
  assert.equal(
    contracts.Check(endpoints.exportLoop.querySchema, {
      revisionId: "revision-reviewed-brief-1",
      latest: true,
    }),
    false,
  );
});

test("uploads accept explicit Loop kind while preserving the legacy Skill default", () => {
  const legacy = {
    schemaVersion: "workbench-api-v1",
    data: {
      filename: "reviewer.skill",
      sizeBytes: 128,
      mediaType: "application/vnd.looloomi.skill-package+json",
    },
  };
  assert.equal(contracts.Check(contracts.CreateUploadRequestSchema, legacy), true);
  assert.equal(contracts.CreateUploadDataSchema.properties.assetKind.default, "skill");
  assert.equal(contracts.UploadSessionPublicSchema.properties.assetKind.default, "skill");
  assert.equal(
    contracts.Check(contracts.CreateUploadRequestSchema, {
      ...legacy,
      data: {
        ...legacy.data,
        filename: "weekly-brief.loop.json",
        mediaType: "application/vnd.looloomi.loop-package+json",
        assetKind: "loop",
      },
    }),
    true,
  );
  assert.equal(
    contracts.Check(contracts.CreateUploadRequestSchema, {
      ...legacy,
      data: { ...legacy.data, assetKind: "workflow" },
    }),
    false,
  );
});
