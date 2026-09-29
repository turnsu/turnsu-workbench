import { Type, type Static } from "typebox";

import {
  ContentHashSchema,
  DataSchemaSchema,
  DiagnosticSchema,
  EdgeIdSchema,
  JsonValueSchema,
  LoopVersionIdSchema,
  ModelProfileIdSchema,
  NodeIdSchema,
  ProposalIdSchema,
  ReleaseIdSchema,
  ResourceIdSchema,
  ResourceRefSchema,
  RunIdSchema,
  TemplateIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  VersionSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";
import {
  LocalizedDisplaySchema,
  PinnedSkillRefSchema,
} from "./skills.js";

export const WorkflowNodeKindSchema = stringEnum([
  "Input",
  "Skill",
  "Material",
  "Transform",
  "ReviewGate",
  "Output",
]);

export const CanvasPositionSchema = strictObject({
  x: Type.Number(),
  y: Type.Number(),
});

export const WorkflowPortSchema = strictObject({
  portId: Type.String({ minLength: 1, maxLength: 128 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  schema: DataSchemaSchema,
  required: Type.Boolean(),
});

export const RunInputBindingSourceSchema = strictObject({
  kind: Type.Literal("runInput"),
  inputKey: Type.String({ minLength: 1, maxLength: 128 }),
});

export const NodeOutputBindingSourceSchema = strictObject({
  kind: Type.Literal("nodeOutput"),
  nodeId: NodeIdSchema,
  portId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const LiteralBindingSourceSchema = strictObject({
  kind: Type.Literal("literal"),
  value: JsonValueSchema,
});

export const ResourceBindingSourceSchema = strictObject({
  kind: Type.Literal("resource"),
  resourceId: ResourceIdSchema,
});

export const InputBindingSourceSchema = Type.Union([
  RunInputBindingSourceSchema,
  NodeOutputBindingSourceSchema,
  LiteralBindingSourceSchema,
  ResourceBindingSourceSchema,
]);

export const InputBindingSchema = strictObject({
  targetPort: Type.String({ minLength: 1, maxLength: 128 }),
  source: InputBindingSourceSchema,
});

export const NodeReviewPolicySchema = strictObject({
  mode: stringEnum(["none", "required"]),
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
});

export const ReviewRevisionTargetSchema = strictObject({
  nodeId: NodeIdSchema,
  portId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const RetryPolicySchema = strictObject({
  maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
  backoffMilliseconds: Type.Integer({ minimum: 0, maximum: 3600000 }),
});

export const NodeConditionSchema = strictObject({
  nodeId: NodeIdSchema,
  portId: Type.String({ minLength: 1, maxLength: 128 }),
  operator: stringEnum(["equals", "notEquals", "exists"]),
  value: Type.Optional(JsonValueSchema),
});

export const NodeDisplaySchema = strictObject({
  collapsed: Type.Boolean(),
  accent: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
});

const WorkflowNodeBaseProperties = {
  nodeId: NodeIdSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  position: CanvasPositionSchema,
  inputPorts: Type.Array(WorkflowPortSchema),
  outputPorts: Type.Array(WorkflowPortSchema),
  inputBindings: Type.Array(InputBindingSchema),
  reviewPolicy: NodeReviewPolicySchema,
  retryPolicy: RetryPolicySchema,
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
  condition: Type.Optional(NodeConditionSchema),
  display: NodeDisplaySchema,
};

export const InputNodeSchema = strictObject({
  ...WorkflowNodeBaseProperties,
  kind: Type.Literal("Input"),
  configuration: strictObject({
    fieldIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      uniqueItems: true,
    }),
  }),
});

export const SkillNodeSchema = strictObject({
  ...WorkflowNodeBaseProperties,
  kind: Type.Literal("Skill"),
  skillRef: PinnedSkillRefSchema,
  configuration: strictObject({
    modelProfileId: Type.Optional(ModelProfileIdSchema),
  }),
});

export const MaterialNodeSchema = strictObject({
  ...WorkflowNodeBaseProperties,
  kind: Type.Literal("Material"),
  configuration: strictObject({
    resourceIds: Type.Array(ResourceIdSchema, { uniqueItems: true }),
  }),
});

export const TransformNodeSchema = strictObject({
  ...WorkflowNodeBaseProperties,
  kind: Type.Literal("Transform"),
  configuration: strictObject({
    mode: stringEnum(["mapping", "boundedAgent"]),
    expression: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  }),
});

export const ReviewGateNodeSchema = strictObject({
  ...WorkflowNodeBaseProperties,
  kind: Type.Literal("ReviewGate"),
  configuration: strictObject({
    instructions: Type.String({ minLength: 1, maxLength: 2000 }),
    allowRevision: Type.Boolean(),
    revisionTarget: Type.Optional(ReviewRevisionTargetSchema),
  }),
});

export const OutputNodeSchema = strictObject({
  ...WorkflowNodeBaseProperties,
  kind: Type.Literal("Output"),
  configuration: strictObject({
    format: stringEnum(["markdown", "text", "json"]),
  }),
});

export const WorkflowNodeSchema = Type.Union(
  [
    InputNodeSchema,
    SkillNodeSchema,
    MaterialNodeSchema,
    TransformNodeSchema,
    ReviewGateNodeSchema,
    OutputNodeSchema,
  ],
  { $id: "WorkflowNode" },
);

export const WorkflowEdgeSchema = strictObject(
  {
    edgeId: EdgeIdSchema,
    sourceNodeId: NodeIdSchema,
    sourcePort: Type.String({ minLength: 1, maxLength: 128 }),
    targetNodeId: NodeIdSchema,
    targetPort: Type.String({ minLength: 1, maxLength: 128 }),
    mappingExpression: Type.Optional(
      Type.String({ minLength: 1, maxLength: 4000 }),
    ),
  },
  { $id: "WorkflowEdge" },
);

export const WorkflowGraphSchema = strictObject({
  nodes: Type.Array(WorkflowNodeSchema),
  edges: Type.Array(WorkflowEdgeSchema),
});

export const InputFormFieldSchema = strictObject({
  fieldId: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  schema: DataSchemaSchema,
  required: Type.Boolean(),
});

export const InputFormSchema = strictObject({
  fields: Type.Array(InputFormFieldSchema),
});

export const WorkflowDefinitionSchema = strictObject(
  {
    goal: Type.String({ minLength: 1, maxLength: 8000 }),
    context: Type.String({ maxLength: 8000 }),
    constraints: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    doneWhen: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    verify: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
    expectedResult: Type.String({ minLength: 1, maxLength: 8000 }),
    stopRules: Type.Array(Type.String({ minLength: 1, maxLength: 2000 })),
  },
  { $id: "WorkflowDefinition" },
);

export const ExpectedOutputSchema = strictObject({
  nodeId: NodeIdSchema,
  portId: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  mediaType: Type.String({ minLength: 1, maxLength: 128 }),
});

export const PrimaryOutputSchema = strictObject({
  nodeId: NodeIdSchema,
  portId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const OutputDefinitionSchema = strictObject({
  primary: PrimaryOutputSchema,
  expectedOutputs: Type.Array(ExpectedOutputSchema, { minItems: 1 }),
});

const RunSettingsBaseProperties = {
  maxParallelism: Type.Literal(1),
  defaultTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 86400 }),
};

export const CapabilitySpecificRunSettingsSchema = strictObject({
  ...RunSettingsBaseProperties,
  agentControllerModelProfileId: Type.Optional(ModelProfileIdSchema),
  imageGenerationModelProfileId: Type.Optional(ModelProfileIdSchema),
  workflowFallbackAllowed: Type.Boolean(),
});

export const LegacyUnpinnedRunSettingsSchema = strictObject({
  ...RunSettingsBaseProperties,
  modelRoutingState: Type.Literal("legacy_unpinned"),
  modelProfileId: ModelProfileIdSchema,
  fallbackModelProfileIds: Type.Optional(Type.Array(ModelProfileIdSchema, {
    uniqueItems: true,
    maxItems: 8,
  })),
});

export const RunSettingsSchema = Type.Union([
  CapabilitySpecificRunSettingsSchema,
  LegacyUnpinnedRunSettingsSchema,
]);

export const TemplateReviewPolicySchema = strictObject({
  required: Type.Boolean(),
  gateNodeIds: Type.Array(NodeIdSchema, { uniqueItems: true }),
});

export const TemplateAvailabilitySchema = strictObject({
  status: stringEnum(["available", "blocked", "incompatible"]),
  diagnostics: Type.Array(DiagnosticSchema),
});

export const WorkflowTemplateSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    templateId: TemplateIdSchema,
    templateVersion: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    display: LocalizedDisplaySchema,
    inputForm: InputFormSchema,
    graph: WorkflowGraphSchema,
    includedSkills: Type.Array(PinnedSkillRefSchema),
    expectedOutputs: Type.Array(ExpectedOutputSchema, { minItems: 1 }),
    reviewPolicy: TemplateReviewPolicySchema,
    availability: TemplateAvailabilitySchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkflowTemplate" },
);

export const WorkflowStatusSchema = stringEnum(["draft", "ready", "blocked"]);
export const WorkflowLifecycleSchema = stringEnum([
  "draft",
  "ready",
  "shared",
  "blocked",
  "deprecated",
]);
export const WorkflowVisibilitySchema = stringEnum(["private", "workspace"]);
export const CompileStatusSchema = stringEnum(["ready", "blocked", "invalid"]);
export const RunStatusSummarySchema = stringEnum([
  "queued",
  "running",
  "waiting_review",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const SourceTemplateRefSchema = strictObject({
  templateId: TemplateIdSchema,
  templateVersion: VersionSchema,
});

export const SourceWorkflowRefSchema = strictObject({
  workflowId: WorkflowIdSchema,
  revisionId: WorkflowRevisionIdSchema,
});

export const SourceReleaseRefSchema = strictObject({
  releaseId: ReleaseIdSchema,
  sourceWorkspaceId: WorkspaceIdSchema,
  versionId: LoopVersionIdSchema,
  forkedAt: UtcTimestampSchema,
});

export const LatestCompileSummarySchema = strictObject({
  revisionId: WorkflowRevisionIdSchema,
  status: CompileStatusSchema,
  compiledAt: UtcTimestampSchema,
});

export const LatestRunSummarySchema = strictObject({
  runId: RunIdSchema,
  status: RunStatusSummarySchema,
  updatedAt: UtcTimestampSchema,
});

export const WorkflowSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    workflowId: WorkflowIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 2000 }),
    status: WorkflowStatusSchema,
    archived: Type.Boolean(),
    ownerId: Type.Optional(UserIdSchema),
    visibility: Type.Optional(WorkflowVisibilitySchema),
    lifecycle: Type.Optional(WorkflowLifecycleSchema),
    currentRevisionId: WorkflowRevisionIdSchema,
    sourceTemplate: Type.Optional(SourceTemplateRefSchema),
    sourceWorkflow: Type.Optional(SourceWorkflowRefSchema),
    sourceRelease: Type.Optional(SourceReleaseRefSchema),
    latestCompile: Type.Optional(LatestCompileSummarySchema),
    latestRun: Type.Optional(LatestRunSummarySchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "Workflow" },
);

export const RevisionCompileSummarySchema = strictObject({
  status: CompileStatusSchema,
  diagnostics: Type.Array(DiagnosticSchema),
});

export const WorkflowRevisionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    revisionId: WorkflowRevisionIdSchema,
    workflowId: WorkflowIdSchema,
    revisionNumber: Type.Integer({ minimum: 1 }),
    baseRevisionId: Type.Union([WorkflowRevisionIdSchema, Type.Null()]),
    graph: WorkflowGraphSchema,
    inputForm: InputFormSchema,
    outputDefinition: OutputDefinitionSchema,
    resourceRefs: Type.Array(ResourceRefSchema),
    runSettings: RunSettingsSchema,
    definition: Type.Optional(WorkflowDefinitionSchema),
    contentHash: ContentHashSchema,
    authoredBy: UserIdSchema,
    saveReason: Type.String({ minLength: 1, maxLength: 1000 }),
    compile: RevisionCompileSummarySchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkflowRevision" },
);

export const BuilderOperationSchema = Type.Union([
  strictObject({ op: Type.Literal("addNode"), node: WorkflowNodeSchema }),
  strictObject({ op: Type.Literal("removeNode"), nodeId: NodeIdSchema }),
  strictObject({
    op: Type.Literal("updateNode"),
    nodeId: NodeIdSchema,
    node: WorkflowNodeSchema,
  }),
  strictObject({ op: Type.Literal("connectNodes"), edge: WorkflowEdgeSchema }),
  strictObject({ op: Type.Literal("disconnectNodes"), edgeId: EdgeIdSchema }),
  strictObject({
    op: Type.Literal("updateWorkflowSettings"),
    runSettings: RunSettingsSchema,
  }),
  strictObject({
    op: Type.Literal("attachResource"),
    resourceRef: ResourceRefSchema,
  }),
  strictObject({
    op: Type.Literal("detachResource"),
    resourceId: ResourceIdSchema,
  }),
]);

export const BuilderProposalSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    proposalId: ProposalIdSchema,
    workflowId: WorkflowIdSchema,
    baseRevisionId: WorkflowRevisionIdSchema,
    prompt: Type.String({ minLength: 1, maxLength: 8000 }),
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    operations: Type.Array(BuilderOperationSchema),
    compileDiagnostics: Type.Array(DiagnosticSchema),
    status: stringEnum([
      "proposed",
      "applied",
      "dismissed",
      "conflicted",
      "invalid",
    ]),
    createdAt: UtcTimestampSchema,
    decidedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "BuilderProposal" },
);

export type WorkflowNode = Static<typeof WorkflowNodeSchema>;
export type WorkflowEdge = Static<typeof WorkflowEdgeSchema>;
export type WorkflowGraph = Static<typeof WorkflowGraphSchema>;
export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;
export type WorkflowTemplate = Static<typeof WorkflowTemplateSchema>;
export type Workflow = Static<typeof WorkflowSchema>;
export type WorkflowRevision = Static<typeof WorkflowRevisionSchema>;
export type BuilderProposal = Static<typeof BuilderProposalSchema>;
