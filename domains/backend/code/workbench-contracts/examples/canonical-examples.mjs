const WORKBENCH_SCHEMA_VERSION = "workbench-v1";
const API_SCHEMA_VERSION = "workbench-api-v1";
const EXECUTION_PLAN_SCHEMA_VERSION = "workbench-execution-plan-v1";
const RUN_EVENT_SCHEMA_VERSION = "workbench-run-event-v1";
const NOW = "2026-07-10T10:00:00.000Z";

const stringDataSchema = {
  type: "string",
  minLength: 1,
};

const skillInputDataSchema = {
  type: "object",
  properties: {
    topic: stringDataSchema,
  },
  required: ["topic"],
  additionalProperties: false,
};

const skillOutputDataSchema = {
  type: "object",
  properties: {
    brief: stringDataSchema,
  },
  required: ["brief"],
  additionalProperties: false,
};

export const pinnedSkillRefExample = {
  skillId: "skill-research-brief",
  version: "1.0.0",
};

export const skillDefinitionExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  skillId: pinnedSkillRefExample.skillId,
  version: pinnedSkillRefExample.version,
  name: "Research brief",
  description: "Produces a concise evidence-backed research brief.",
  category: "research",
  display: {
    defaultLocale: "en",
    localized: {
      en: {
        name: "Research brief",
        description: "Produces a concise evidence-backed research brief.",
      },
    },
  },
  status: "ready",
  inputSchema: skillInputDataSchema,
  outputSchema: skillOutputDataSchema,
  risk: {
    level: "medium",
    externalAction: false,
    summary: "Reads supplied context and returns analysis.",
  },
  dependencies: [],
  setupChecks: [
    {
      checkId: "check-execution-ready",
      label: "Execution readiness",
      status: "passed",
      message: "The execution capability is available.",
    },
  ],
  executionRef: {
    capabilityId: "research.brief",
    taskIntent: "produce_research_brief",
    adapterVersion: "1.0.0",
    executionMode: "agent",
  },
  usageCount: 1,
  readiness: {
    status: "ready",
    diagnostics: [],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

const retryPolicy = {
  maxAttempts: 1,
  backoffMilliseconds: 0,
};

const noReviewPolicy = {
  mode: "none",
};

const nodeDisplay = {
  collapsed: false,
};

export const inputNodeExample = {
  nodeId: "node-input",
  kind: "Input",
  title: "Topic",
  description: "Collect the research topic.",
  position: { x: 80, y: 120 },
  inputPorts: [],
  outputPorts: [
    {
      portId: "topic",
      name: "Topic",
      schema: stringDataSchema,
      required: true,
    },
  ],
  inputBindings: [],
  configuration: {
    fieldIds: ["topic"],
  },
  reviewPolicy: noReviewPolicy,
  retryPolicy,
  timeoutSeconds: 30,
  display: nodeDisplay,
};

export const skillNodeExample = {
  nodeId: "node-skill",
  kind: "Skill",
  title: "Draft brief",
  description: "Run the pinned research skill.",
  position: { x: 360, y: 120 },
  skillRef: pinnedSkillRefExample,
  inputPorts: [
    {
      portId: "request",
      name: "Request",
      schema: stringDataSchema,
      required: true,
    },
  ],
  outputPorts: [
    {
      portId: "brief",
      name: "Brief",
      schema: stringDataSchema,
      required: true,
    },
  ],
  inputBindings: [
    {
      targetPort: "request",
      source: {
        kind: "nodeOutput",
        nodeId: "node-input",
        portId: "topic",
      },
    },
  ],
  configuration: {},
  reviewPolicy: noReviewPolicy,
  retryPolicy,
  timeoutSeconds: 300,
  display: nodeDisplay,
};

export const reviewNodeExample = {
  nodeId: "node-review",
  kind: "ReviewGate",
  title: "Review brief",
  description: "Require an explicit decision before publishing.",
  position: { x: 640, y: 120 },
  inputPorts: [
    {
      portId: "candidate",
      name: "Candidate",
      schema: stringDataSchema,
      required: true,
    },
  ],
  outputPorts: [
    {
      portId: "approved",
      name: "Approved",
      schema: stringDataSchema,
      required: true,
    },
  ],
  inputBindings: [
    {
      targetPort: "candidate",
      source: {
        kind: "nodeOutput",
        nodeId: "node-skill",
        portId: "brief",
      },
    },
  ],
  configuration: {
    instructions: "Confirm the evidence and conclusion.",
    allowRevision: true,
  },
  reviewPolicy: {
    mode: "required",
    instructions: "Approve, request a revision, or reject.",
  },
  retryPolicy,
  timeoutSeconds: 86400,
  display: nodeDisplay,
};

export const outputNodeExample = {
  nodeId: "node-output",
  kind: "Output",
  title: "Final brief",
  description: "Publish the reviewed result.",
  position: { x: 920, y: 120 },
  inputPorts: [
    {
      portId: "content",
      name: "Content",
      schema: stringDataSchema,
      required: true,
    },
  ],
  outputPorts: [
    {
      portId: "final",
      name: "Final",
      schema: stringDataSchema,
      required: true,
    },
  ],
  inputBindings: [
    {
      targetPort: "content",
      source: {
        kind: "nodeOutput",
        nodeId: "node-review",
        portId: "approved",
      },
    },
  ],
  configuration: {
    format: "markdown",
  },
  reviewPolicy: noReviewPolicy,
  retryPolicy,
  timeoutSeconds: 30,
  display: nodeDisplay,
};

export const workflowEdgeExamples = [
  {
    edgeId: "edge-input-skill",
    sourceNodeId: "node-input",
    sourcePort: "topic",
    targetNodeId: "node-skill",
    targetPort: "request",
  },
  {
    edgeId: "edge-skill-review",
    sourceNodeId: "node-skill",
    sourcePort: "brief",
    targetNodeId: "node-review",
    targetPort: "candidate",
  },
  {
    edgeId: "edge-review-output",
    sourceNodeId: "node-review",
    sourcePort: "approved",
    targetNodeId: "node-output",
    targetPort: "content",
  },
];

export const workflowGraphExample = {
  nodes: [
    inputNodeExample,
    skillNodeExample,
    reviewNodeExample,
    outputNodeExample,
  ],
  edges: workflowEdgeExamples,
};

export const inputFormExample = {
  fields: [
    {
      fieldId: "topic",
      label: "Topic",
      description: "The subject to research.",
      schema: stringDataSchema,
      required: true,
    },
  ],
};

export const outputDefinitionExample = {
  primary: {
    nodeId: "node-output",
    portId: "final",
  },
  expectedOutputs: [
    {
      nodeId: "node-output",
      portId: "final",
      label: "Final brief",
      mediaType: "text/markdown",
    },
  ],
};

export const runSettingsExample = {
  maxParallelism: 1,
  defaultTimeoutSeconds: 300,
  workflowFallbackAllowed: false,
};

export const publicModelProfileRevisionSummaryExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  revisionId: "model-revision-deepseek-chat-3",
  profileId: "model-profile-deepseek-chat",
  revisionNumber: 3,
  modelDisplayName: "DeepSeek Chat",
  providerDisplay: {
    key: "deepseek",
    label: "DeepSeek",
  },
  capabilities: ["chat", "tool_calling", "structured_output"],
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
  createdAt: NOW,
};

export const modelProfileSummaryExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  profileId: publicModelProfileRevisionSummaryExample.profileId,
  displayName: "DeepSeek Chat",
  currentRevisionId: publicModelProfileRevisionSummaryExample.revisionId,
  currentRevision: publicModelProfileRevisionSummaryExample,
  scope: "global",
  enabled: true,
  readiness: "ready",
  readinessReason: null,
  selectable: true,
  defaultForCapabilities: ["chat"],
  createdAt: NOW,
  updatedAt: NOW,
};

export const artifactRefExample = {
  artifactId: "artifact-image-1",
  mediaType: "image/png",
};

export const artifactMetadataExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  artifactId: artifactRefExample.artifactId,
  workspaceId: "workspace-local",
  state: "ready",
  mediaType: artifactRefExample.mediaType,
  byteLength: 1024,
  contentHash: "sha256:1122334455667788",
  dimensions: { width: 1024, height: 1024 },
  source: {
    kind: "agent_turn",
    sessionId: "agent-session-main-1",
    turnId: "agent-turn-image-1",
    invocationId: "invocation-image-1",
    attemptId: "attempt-image-1",
  },
  requestedModelRevisionId: "model-revision-stability-image-1",
  actualModelRevisionId: "model-revision-stability-image-1",
  createdAt: NOW,
  expiresAt: null,
};

export const workflowTemplateExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  templateId: "template-reviewed-brief",
  templateVersion: "1.0.0",
  name: "Reviewed research brief",
  description: "Draft, review, and publish a research brief.",
  category: "research",
  display: {
    defaultLocale: "en",
    localized: {
      en: {
        name: "Reviewed research brief",
        description: "Draft, review, and publish a research brief.",
      },
    },
  },
  inputForm: inputFormExample,
  graph: workflowGraphExample,
  includedSkills: [pinnedSkillRefExample],
  expectedOutputs: outputDefinitionExample.expectedOutputs,
  reviewPolicy: {
    required: true,
    gateNodeIds: ["node-review"],
  },
  availability: {
    status: "available",
    diagnostics: [],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

export const workflowExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  workflowId: "workflow-reviewed-brief",
  workspaceId: "workspace-local",
  name: "Weekly research brief",
  description: "A saved reviewed research workflow.",
  status: "ready",
  archived: false,
  currentRevisionId: "revision-reviewed-brief-1",
  sourceTemplate: {
    templateId: workflowTemplateExample.templateId,
    templateVersion: workflowTemplateExample.templateVersion,
  },
  latestCompile: {
    revisionId: "revision-reviewed-brief-1",
    status: "ready",
    compiledAt: NOW,
  },
  latestRun: {
    runId: "run-reviewed-brief-1",
    status: "completed",
    updatedAt: NOW,
  },
  createdAt: NOW,
  updatedAt: NOW,
};

export const workflowRevisionExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  revisionId: "revision-reviewed-brief-1",
  workflowId: workflowExample.workflowId,
  revisionNumber: 1,
  baseRevisionId: null,
  graph: workflowGraphExample,
  inputForm: inputFormExample,
  outputDefinition: outputDefinitionExample,
  resourceRefs: [],
  runSettings: runSettingsExample,
  contentHash: "sha256:9b5d6f9f4af02311",
  authoredBy: "user-local",
  saveReason: "Create the first runnable revision.",
  compile: {
    status: "ready",
    diagnostics: [],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

export const builderProposalExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  proposalId: "proposal-parallelism-1",
  workflowId: workflowExample.workflowId,
  baseRevisionId: workflowRevisionExample.revisionId,
  prompt: "Keep this workflow sequential.",
  summary: "Retain sequential execution settings.",
  operations: [
    {
      op: "updateWorkflowSettings",
      runSettings: runSettingsExample,
    },
  ],
  compileDiagnostics: [],
  status: "proposed",
  createdAt: NOW,
  decidedAt: null,
};

export const executionPlanExample = {
  schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
  planVersion: "1",
  workflowId: workflowExample.workflowId,
  workflowRevisionId: workflowRevisionExample.revisionId,
  generatedAt: NOW,
  contentHash: workflowRevisionExample.contentHash,
  maxParallelism: 1,
  pinnedSkills: [pinnedSkillRefExample],
  steps: [
    {
      nodeId: "node-input",
      kind: "Input",
      dependsOn: [],
      inputBindings: [],
    },
    {
      nodeId: "node-skill",
      kind: "Skill",
      skillRef: pinnedSkillRefExample,
      dependsOn: ["node-input"],
      inputBindings: skillNodeExample.inputBindings,
    },
    {
      nodeId: "node-review",
      kind: "ReviewGate",
      dependsOn: ["node-skill"],
      inputBindings: reviewNodeExample.inputBindings,
    },
    {
      nodeId: "node-output",
      kind: "Output",
      dependsOn: ["node-review"],
      inputBindings: outputNodeExample.inputBindings,
    },
  ],
  reviewGates: [
    {
      nodeId: "node-review",
      dependsOn: ["node-skill"],
      instructions: "Approve, request a revision, or reject.",
    },
  ],
  primaryOutput: {
    nodeId: "node-output",
    portId: "final",
  },
};

export const compileResultExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  workflowId: workflowExample.workflowId,
  workflowRevisionId: workflowRevisionExample.revisionId,
  status: "ready",
  orderedSteps: executionPlanExample.steps.map((step) => step.nodeId),
  requiredRunInputs: [
    {
      inputKey: "topic",
      label: "Topic",
      schema: stringDataSchema,
      required: true,
    },
  ],
  missingBindings: [],
  missingResources: [],
  unavailableSkills: [],
  orphanNodeIds: [],
  unreachableNodeIds: [],
  invalidCycles: [],
  portSchemaMismatches: [],
  reviewGates: ["node-review"],
  outputNodes: ["node-output"],
  warnings: [],
  recoveryActions: [],
  executionPlan: executionPlanExample,
  compiledAt: NOW,
};

export const nodeRunExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  nodeRunId: "node-run-skill-1",
  runId: "run-reviewed-brief-1",
  nodeId: "node-skill",
  attempt: 1,
  status: "completed",
  summary: "The draft brief completed.",
  startedAt: NOW,
  completedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

export const reviewDecisionExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  decisionId: "decision-review-1",
  runId: nodeRunExample.runId,
  nodeId: "node-review",
  decision: "approve",
  comment: "Evidence and conclusion are clear.",
  requestedChanges: [],
  decidedBy: "user-local",
  decidedAt: NOW,
  idempotencyKey: "idem-review-001",
  createdAt: NOW,
  updatedAt: NOW,
};

export const workflowRunExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  runId: nodeRunExample.runId,
  workflowId: workflowExample.workflowId,
  workflowRevisionId: workflowRevisionExample.revisionId,
  inputs: {
    topic: "Public evidence for digital identity",
  },
  resourceRefs: [],
  executionPlanVersion: EXECUTION_PLAN_SCHEMA_VERSION,
  executionPlanContentHash: executionPlanExample.contentHash,
  status: "completed",
  currentNodeId: null,
  idempotencyKey: "idem-run-001",
  nodeRuns: [nodeRunExample],
  reviewDecisions: [reviewDecisionExample],
  authoritativeReadModel: {
    available: true,
    version: 1,
  },
  queuedAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

export const runEventExample = {
  schemaVersion: RUN_EVENT_SCHEMA_VERSION,
  sequence: 42,
  eventId: "event-42",
  type: "node.completed",
  runId: workflowRunExample.runId,
  workflowId: workflowExample.workflowId,
  workflowRevisionId: workflowRevisionExample.revisionId,
  nodeId: "node-skill",
  status: "completed",
  summary: "The draft brief completed.",
  occurredAt: NOW,
};

export const runReadModelExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  runId: workflowRunExample.runId,
  workflowId: workflowExample.workflowId,
  workflowRevisionId: workflowRevisionExample.revisionId,
  status: "completed",
  currentNodeId: null,
  nodeTimeline: [nodeRunExample],
  finalAnswer: {
    format: "markdown",
    content: "# Research brief\n\nThe reviewed conclusion is ready.",
    createdAt: NOW,
  },
  evidenceGaps: [],
  reviewPacket: {
    nodeId: "node-review",
    title: "Review brief",
    summary: "Review the draft before publishing.",
    items: ["Confirm the cited evidence.", "Confirm the conclusion."],
    canRequestChanges: true,
  },
  reviewDecisions: [reviewDecisionExample],
  failure: null,
  recoveryActions: [],
  followUpPrompts: ["Run the same revision with a narrower topic."],
  resourceRefs: [],
  evidenceRefs: [
    {
      evidenceId: "evidence-public-1",
      label: "Public source summary",
      kind: "source",
      citation: "Public source, accessed 2026-07-10",
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

export const errorEnvelopeExample = {
  code: "workflow_revision_conflict",
  message: "This workflow changed after you opened it.",
  details: {
    workflowId: workflowExample.workflowId,
    expectedRevision: 1,
    currentRevision: 2,
  },
  retryable: false,
  requestId: "request-123",
};

export const workspaceResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    workspace: {
      workspaceId: "workspace-local",
      name: "Local workspace",
      capabilities: {
        builderProposal: false,
        resources: false,
        maxParallelism: 1,
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    session: {
      csrfToken: "csrf-local-workbench-session-token-0001",
      expiresAt: "2026-07-10T18:00:00.000Z",
    },
  },
  requestId: "request-workspace-1",
};

const page = {
  nextCursor: null,
  hasMore: false,
};

export const skillCatalogItemExample = {
  ...Object.fromEntries(
    Object.entries(skillDefinitionExample).filter(([key]) => key !== "executionRef"),
  ),
  execution: {
    executionMode: skillDefinitionExample.executionRef.executionMode,
  },
};

export const skillListResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: [skillCatalogItemExample],
  page,
  requestId: "request-skills-1",
};

export const skillDetailResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: skillCatalogItemExample,
  requestId: "request-skill-1",
};

export const templateListResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: [workflowTemplateExample],
  page,
  requestId: "request-templates-1",
};

export const templateDetailResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: workflowTemplateExample,
  requestId: "request-template-1",
};

export const useTemplateRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    templateVersion: workflowTemplateExample.templateVersion,
    name: workflowExample.name,
  },
};

export const useTemplateResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    workflow: workflowExample,
    revision: workflowRevisionExample,
  },
  requestId: "request-use-template-1",
};

export const workflowListResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: [workflowExample],
  page,
  requestId: "request-workflows-1",
};

export const workflowDetailResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: workflowExample,
  requestId: "request-workflow-1",
};

export const workflowRevisionResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: workflowRevisionExample,
  requestId: "request-revision-1",
};

export const saveWorkflowRevisionRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    baseRevisionId: workflowRevisionExample.revisionId,
    graph: workflowGraphExample,
    inputForm: inputFormExample,
    outputDefinition: outputDefinitionExample,
    resourceRefs: [],
    runSettings: runSettingsExample,
    saveReason: "Save the reviewed graph.",
  },
};

export const saveWorkflowRevisionResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    workflow: workflowExample,
    revision: workflowRevisionExample,
  },
  requestId: "request-save-revision-1",
};

export const compileWorkflowRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    workflowRevisionId: workflowRevisionExample.revisionId,
  },
};

export const compileWorkflowResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: compileResultExample,
  requestId: "request-compile-1",
};

export const startRunRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    workflowRevisionId: workflowRevisionExample.revisionId,
    inputs: workflowRunExample.inputs,
    resourceRefs: [],
  },
};

export const startRunResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: workflowRunExample,
  requestId: "request-start-run-1",
};

export const runHistoryResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: [workflowRunExample],
  page,
  requestId: "request-run-history-1",
};

export const runDetailResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    run: workflowRunExample,
    readModel: runReadModelExample,
  },
  requestId: "request-run-detail-1",
};

export const runEventsResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    events: [runEventExample],
    nextSequence: 43,
    hasMore: false,
  },
  requestId: "request-run-events-1",
};

export const reviewDecisionRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    nodeId: "node-review",
    decision: "approve",
    comment: "Evidence and conclusion are clear.",
    requestedChanges: [],
  },
};

export const reviewDecisionResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    decision: reviewDecisionExample,
    run: workflowRunExample,
  },
  requestId: "request-review-decision-1",
};

export const skillTestCaseExample = {
  name: "Extract one meeting action",
  purpose: "Confirm the uploaded Skill returns a structured action from supplied notes.",
  input: {
    meetingNotes: "Ari will send the launch brief by Friday.",
  },
  expectedOutput: {
    actionCount: 1,
  },
  timeoutSeconds: 30,
};

export const skillTestRunExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  testRunId: "skill-test-run-meeting-actions-1",
  workspaceId: "workspace-alpha",
  skillId: "skill-meeting-actions",
  skillDraftId: "skill-draft-meeting-actions-3",
  packageHash: "sha256:0123456789abcdef",
  contentHash: "sha256:fedcba9876543210",
  testCase: skillTestCaseExample,
  status: "passed",
  diagnostics: [],
  outputPreview: {
    actionCount: 1,
  },
  startedAt: "2026-07-10T09:59:58.000Z",
  completedAt: NOW,
};

export const skillValidationRecordExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  validationId: "skill-validation-meeting-actions-1",
  workspaceId: "workspace-alpha",
  skillId: "skill-meeting-actions",
  skillDraftId: "skill-draft-meeting-actions-3",
  draftRevision: 3,
  contentHash: skillTestRunExample.contentHash,
  testRunIds: [skillTestRunExample.testRunId],
  permissionAcknowledged: true,
  status: "passed",
  diagnostics: [],
  runtimeSummary: {
    runtimeLabel: "Python 3.12",
    permissionSummary: "No network, workspace connections, or external actions.",
  },
  createdAt: "2026-07-10T09:59:57.000Z",
  completedAt: NOW,
};

export const createSkillTestRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    testCase: skillTestCaseExample,
  },
};

export const skillTestRunResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    schemaVersion: skillTestRunExample.schemaVersion,
    testRunId: skillTestRunExample.testRunId,
    skillId: skillTestRunExample.skillId,
    skillDraftId: skillTestRunExample.skillDraftId,
    testCase: skillTestRunExample.testCase,
    status: skillTestRunExample.status,
    diagnostics: skillTestRunExample.diagnostics,
    outputPreview: skillTestRunExample.outputPreview,
    startedAt: skillTestRunExample.startedAt,
    completedAt: skillTestRunExample.completedAt,
  },
  requestId: "request-skill-test-run-1",
};

export const createSkillValidationRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    testRunIds: [skillTestRunExample.testRunId],
    permissionAcknowledged: true,
  },
};

export const skillValidationResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    schemaVersion: skillValidationRecordExample.schemaVersion,
    validationId: skillValidationRecordExample.validationId,
    skillId: skillValidationRecordExample.skillId,
    skillDraftId: skillValidationRecordExample.skillDraftId,
    draftRevision: skillValidationRecordExample.draftRevision,
    testRunIds: skillValidationRecordExample.testRunIds,
    permissionAcknowledged: skillValidationRecordExample.permissionAcknowledged,
    status: skillValidationRecordExample.status,
    diagnostics: skillValidationRecordExample.diagnostics,
    runtimeSummary: skillValidationRecordExample.runtimeSummary,
    createdAt: skillValidationRecordExample.createdAt,
    completedAt: skillValidationRecordExample.completedAt,
  },
  requestId: "request-skill-validation-1",
};

export const skillVersionSummaryExample = {
  skillVersionId: "skill-version-meeting-actions-1",
  skillId: "skill-meeting-actions",
  version: "1.0.0",
  name: "Meeting action extractor",
  description: "Finds clear owners and due dates in reviewed meeting notes.",
  category: "meetings",
  validation: {
    status: "passed",
    testedAt: NOW,
  },
  publishedBy: "user-owner",
  publishedAt: NOW,
};

export const skillVersionListResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: [{
    skillVersionId: skillVersionSummaryExample.skillVersionId,
    skillId: skillVersionSummaryExample.skillId,
    version: skillVersionSummaryExample.version,
    name: skillVersionSummaryExample.name,
    description: skillVersionSummaryExample.description,
    category: skillVersionSummaryExample.category,
    validation: skillVersionSummaryExample.validation,
    publishedAt: skillVersionSummaryExample.publishedAt,
  }],
  page,
  requestId: "request-skill-versions-1",
};

export const skillDraftExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  skillDraftId: "skill-draft-meeting-actions-3",
  skillId: "skill-meeting-actions",
  workspaceId: "workspace-alpha",
  baseVersionId: null,
  revision: 4,
  name: "Meeting action extractor",
  description: "Finds clear owners and due dates in reviewed meeting notes.",
  category: "meetings",
  inputSchema: skillInputDataSchema,
  outputSchema: skillOutputDataSchema,
  risk: { level: "low", externalAction: false, summary: "Reads supplied notes only." },
  dependencies: [],
  connectionRequirements: [],
  files: [{
    path: "package.skill-package",
    objectId: "object-skill-package-2",
    contentHash: "sha256:0123456789abcdef",
    mediaType: "application/vnd.looloomi.skill-package+json",
    sizeBytes: 512,
  }],
  updatedBy: "user-owner",
  createdAt: NOW,
  updatedAt: NOW,
};

export const skillDraftPackageExample = {
  skillId: "skill-meeting-actions",
  skillDraftId: "skill-draft-meeting-actions-3",
  revision: 3,
  files: [
    {
      path: "SKILL.md",
      kind: "instructions",
      sizeBytes: 96,
      content: "---\nname: meeting-actions\ndescription: Finds meeting actions.\n---\n\n# Instructions\n",
    },
    {
      path: "scripts/main.py",
      kind: "executable",
      sizeBytes: 29,
      content: "print({\"actions\": []})\n",
    },
  ],
};

export const skillDraftPackageResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: skillDraftPackageExample,
  requestId: "request-skill-draft-package-1",
};

export const replaceSkillDraftPackageRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: { uploadId: "upload-skill-package-2" },
};

const portableMaterialNodeExample = {
  nodeId: "node-material",
  kind: "Material",
  title: "Research guidance",
  description: "Resolve the material selected during import.",
  position: { x: 80, y: 300 },
  inputPorts: [],
  outputPorts: [{
    portId: "content",
    name: "Content",
    schema: stringDataSchema,
    required: true,
  }],
  inputBindings: [],
  configuration: { materialRefs: ["material:research-guidance"] },
  reviewPolicy: noReviewPolicy,
  retryPolicy,
  timeoutSeconds: 30,
  display: nodeDisplay,
};

const portableSkillNodeExample = {
  ...skillNodeExample,
  skillRef: "skill:research-brief",
  inputPorts: [
    ...skillNodeExample.inputPorts,
    {
      portId: "guidance",
      name: "Guidance",
      schema: stringDataSchema,
      required: true,
    },
  ],
  inputBindings: [
    ...skillNodeExample.inputBindings,
    {
      targetPort: "guidance",
      source: {
        kind: "nodeOutput",
        nodeId: "node-material",
        portId: "content",
      },
    },
  ],
};

export const portableLoopPackageExample = {
  schemaVersion: "portable-loop-package-v1",
  name: "Weekly research brief",
  description: "A portable reviewed research workflow.",
  definition: {
    goal: "Produce a concise evidence-backed research brief.",
    context: "Use the supplied topic and research guidance.",
    constraints: ["Use only supplied material."],
    doneWhen: ["The brief has been explicitly reviewed."],
    verify: ["Confirm the brief addresses the requested topic."],
    expectedResult: "A reviewed Markdown research brief.",
    stopRules: ["Stop when required material is unavailable."],
  },
  graph: {
    nodes: [
      inputNodeExample,
      portableMaterialNodeExample,
      portableSkillNodeExample,
      reviewNodeExample,
      outputNodeExample,
    ],
    edges: [
      workflowEdgeExamples[0],
      {
        edgeId: "edge-material-skill",
        sourceNodeId: "node-material",
        sourcePort: "content",
        targetNodeId: "node-skill",
        targetPort: "guidance",
      },
      workflowEdgeExamples[1],
      workflowEdgeExamples[2],
    ],
  },
  inputForm: inputFormExample,
  outputDefinition: outputDefinitionExample,
  requirements: {
    skills: [{
      ref: "skill:research-brief",
      skillId: "skill-research-brief",
      version: "1.0.0",
      contentHash: "sha256:0123456789abcdef",
      connectionRefs: ["connection:evidence-catalog-read"],
    }],
    connections: [{
      ref: "connection:evidence-catalog-read",
      capabilityKey: "evidence-catalog-read",
      label: "Evidence catalog",
      required: true,
      permissionSummary: "Read approved evidence selected by the importing workspace.",
    }],
    materials: [{
      ref: "material:research-guidance",
      label: "Research guidance",
      description: "Workspace-selected guidance for the brief.",
      required: true,
      acceptedMediaTypes: ["text/markdown", "text/plain"],
    }],
  },
  embeddedMaterials: [{
    materialRef: "material:research-guidance",
    mediaType: "text/markdown",
    encoding: "utf-8",
    content: "# Guidance\n\nKeep the brief concise and evidence-backed.\n",
    byteLength: 56,
    contentHash: "sha256:1122334455667788",
  }],
  executionSettings: runSettingsExample,
};

export const createLoopImportRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: { uploadId: "upload-loop-reviewed-brief-1" },
};

export const loopImportExample = {
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  importId: "loop-import-reviewed-brief-1",
  uploadId: "upload-loop-reviewed-brief-1",
  status: "needs_mapping",
  sourceContentHash: "sha256:abcdef0123456789",
  portableLoop: portableLoopPackageExample,
  requirementStates: [
    { ref: "skill:research-brief", kind: "skill", status: "unmapped" },
    {
      ref: "connection:evidence-catalog-read",
      kind: "connection",
      status: "unmapped",
    },
    {
      ref: "material:research-guidance",
      kind: "material",
      status: "unmapped",
    },
  ],
  diagnostics: [],
  committedWorkflowId: null,
  committedRevisionId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

export const loopImportResponseExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: loopImportExample,
  requestId: "request-loop-import-1",
};

export const commitLoopImportRequestExample = {
  schemaVersion: API_SCHEMA_VERSION,
  data: {
    skillMappings: [{
      requirementRef: "skill:research-brief",
      skillVersionId: "skill-version-research-brief-1",
    }],
    materialMappings: [{
      requirementRef: "material:research-guidance",
      resolution: {
        kind: "embeddedMaterial",
        contentHash: "sha256:1122334455667788",
      },
    }],
    connectionMappings: [{
      requirementRef: "connection:evidence-catalog-read",
      connectionId: "connection-evidence-catalog-1",
    }],
  },
};

export const portableLoopPackageResponseExample = {
  ...portableLoopPackageExample,
};

export const mutationRequestExamples = {
  useTemplate: useTemplateRequestExample,
  saveWorkflowRevision: saveWorkflowRevisionRequestExample,
  compileWorkflow: compileWorkflowRequestExample,
  startRun: startRunRequestExample,
  submitReviewDecision: reviewDecisionRequestExample,
};

export const publicContractExamples = [
  { name: "model profile summary", schema: "ModelProfileSummarySchema", value: modelProfileSummaryExample },
  { name: "Artifact metadata", schema: "ArtifactMetadataSchema", value: artifactMetadataExample },
  { name: "Skill catalog item", schema: "SkillCatalogItemSchema", value: skillCatalogItemExample },
  { name: "input workflow node", schema: "WorkflowNodeSchema", value: inputNodeExample },
  { name: "skill workflow node", schema: "WorkflowNodeSchema", value: skillNodeExample },
  { name: "review workflow node", schema: "WorkflowNodeSchema", value: reviewNodeExample },
  { name: "output workflow node", schema: "WorkflowNodeSchema", value: outputNodeExample },
  { name: "workflow edge", schema: "WorkflowEdgeSchema", value: workflowEdgeExamples[0] },
  { name: "workflow template", schema: "WorkflowTemplateSchema", value: workflowTemplateExample },
  { name: "workflow", schema: "WorkflowSchema", value: workflowExample },
  { name: "workflow revision", schema: "WorkflowRevisionSchema", value: workflowRevisionExample },
  { name: "builder proposal", schema: "BuilderProposalSchema", value: builderProposalExample },
  { name: "execution plan", schema: "ExecutionPlanV1Schema", value: executionPlanExample },
  { name: "compile result", schema: "CompileResultSchema", value: compileResultExample },
  { name: "node run", schema: "NodeRunSchema", value: nodeRunExample },
  { name: "review decision", schema: "ReviewDecisionSchema", value: reviewDecisionExample },
  { name: "workflow run", schema: "WorkflowRunSchema", value: workflowRunExample },
  { name: "run event", schema: "RunEventSchema", value: runEventExample },
  { name: "run read model", schema: "RunReadModelSchema", value: runReadModelExample },
  { name: "error envelope", schema: "ErrorEnvelopeSchema", value: errorEnvelopeExample },
  { name: "workspace response", schema: "WorkspaceResponseSchema", value: workspaceResponseExample },
  { name: "skill list response", schema: "SkillListResponseSchema", value: skillListResponseExample },
  { name: "skill detail response", schema: "SkillDetailResponseSchema", value: skillDetailResponseExample },
  { name: "template list response", schema: "TemplateListResponseSchema", value: templateListResponseExample },
  { name: "template detail response", schema: "TemplateDetailResponseSchema", value: templateDetailResponseExample },
  { name: "use template request", schema: "UseTemplateRequestSchema", value: useTemplateRequestExample },
  { name: "use template response", schema: "UseTemplateResponseSchema", value: useTemplateResponseExample },
  { name: "workflow list response", schema: "WorkflowListResponseSchema", value: workflowListResponseExample },
  { name: "workflow detail response", schema: "WorkflowDetailResponseSchema", value: workflowDetailResponseExample },
  { name: "workflow revision response", schema: "WorkflowRevisionResponseSchema", value: workflowRevisionResponseExample },
  { name: "save revision request", schema: "SaveWorkflowRevisionRequestSchema", value: saveWorkflowRevisionRequestExample },
  { name: "save revision response", schema: "SaveWorkflowRevisionResponseSchema", value: saveWorkflowRevisionResponseExample },
  { name: "compile request", schema: "CompileWorkflowRequestSchema", value: compileWorkflowRequestExample },
  { name: "compile response", schema: "CompileWorkflowResponseSchema", value: compileWorkflowResponseExample },
  { name: "start run request", schema: "StartRunRequestSchema", value: startRunRequestExample },
  { name: "start run response", schema: "StartRunResponseSchema", value: startRunResponseExample },
  { name: "run history response", schema: "RunHistoryResponseSchema", value: runHistoryResponseExample },
  { name: "run detail response", schema: "RunDetailResponseSchema", value: runDetailResponseExample },
  { name: "run events response", schema: "RunEventsResponseSchema", value: runEventsResponseExample },
  { name: "review decision request", schema: "ReviewDecisionRequestSchema", value: reviewDecisionRequestExample },
  { name: "review decision response", schema: "ReviewDecisionResponseSchema", value: reviewDecisionResponseExample },
  { name: "Skill test case", schema: "SkillTestCaseSchema", value: skillTestCaseExample },
  { name: "create Skill test request", schema: "CreateSkillTestRequestSchema", value: createSkillTestRequestExample },
  { name: "Skill test run response", schema: "SkillTestRunResponseSchema", value: skillTestRunResponseExample },
  { name: "create Skill validation request", schema: "CreateSkillValidationRequestSchema", value: createSkillValidationRequestExample },
  { name: "Skill validation response", schema: "SkillValidationResponseSchema", value: skillValidationResponseExample },
  { name: "Skill version list response", schema: "SkillVersionListResponseSchema", value: skillVersionListResponseExample },
  { name: "Skill draft package", schema: "SkillDraftPackageSchema", value: skillDraftPackageExample },
  { name: "Skill draft package response", schema: "SkillDraftPackageResponseSchema", value: skillDraftPackageResponseExample },
  { name: "replace Skill draft package request", schema: "ReplaceSkillDraftPackageRequestSchema", value: replaceSkillDraftPackageRequestExample },
  { name: "portable Loop package", schema: "PortableLoopPackageV1Schema", value: portableLoopPackageExample },
  { name: "create Loop import request", schema: "CreateLoopImportRequestSchema", value: createLoopImportRequestExample },
  { name: "Loop import response", schema: "LoopImportResponseSchema", value: loopImportResponseExample },
  { name: "commit Loop import request", schema: "CommitLoopImportRequestSchema", value: commitLoopImportRequestExample },
  { name: "portable Loop package response", schema: "PortableLoopPackageResponseSchema", value: portableLoopPackageResponseExample },
];
