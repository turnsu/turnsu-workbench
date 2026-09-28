import { Type, type Static } from "typebox";

import {
  ContentHashSchema,
  DataSchemaSchema,
  DiagnosticSchema,
  ExecutionPlanV1SchemaVersionSchema,
  ExecutionPlanV2SchemaVersionSchema,
  NodeIdSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
  ResourceIdSchema,
  UtcTimestampSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { ModelCapabilitySchema } from "./models.js";
import { strictObject, stringEnum } from "./schema.js";
import { PinnedSkillRefSchema } from "./skills.js";
import {
  EvidenceRequirementSchema,
  ExecutionCapabilitiesSchema,
  ExecutionIsolationSchema,
  ExecutionLimitsSchema,
} from "./execution.js";
import {
  InputBindingSchema,
  PrimaryOutputSchema,
  WorkflowNodeKindSchema,
} from "./workflows.js";

export const ExecutionPlanStepSchema = strictObject({
  nodeId: NodeIdSchema,
  kind: WorkflowNodeKindSchema,
  skillRef: Type.Optional(PinnedSkillRefSchema),
  dependsOn: Type.Array(NodeIdSchema, { uniqueItems: true }),
  inputBindings: Type.Array(InputBindingSchema),
});

export const ExecutionReviewGateSchema = strictObject({
  nodeId: NodeIdSchema,
  dependsOn: Type.Array(NodeIdSchema, { uniqueItems: true }),
  instructions: Type.String({ minLength: 1, maxLength: 2000 }),
});

export const ExecutionPlanV1Schema = strictObject(
  {
    schemaVersion: ExecutionPlanV1SchemaVersionSchema,
    planVersion: Type.Literal("1"),
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    generatedAt: UtcTimestampSchema,
    contentHash: ContentHashSchema,
    maxParallelism: Type.Literal(1),
    pinnedSkills: Type.Array(PinnedSkillRefSchema),
    steps: Type.Array(ExecutionPlanStepSchema, { minItems: 1 }),
    reviewGates: Type.Array(ExecutionReviewGateSchema),
    primaryOutput: PrimaryOutputSchema,
  },
  { $id: "ExecutionPlanV1" },
);

const ExecutionPlanV2StepBaseProperties = {
  nodeId: NodeIdSchema,
  kind: WorkflowNodeKindSchema,
  skillRef: Type.Optional(PinnedSkillRefSchema),
  dependsOn: Type.Array(NodeIdSchema, { uniqueItems: true }),
  inputBindings: Type.Array(InputBindingSchema),
  isolation: ExecutionIsolationSchema,
  limits: ExecutionLimitsSchema,
  capabilities: ExecutionCapabilitiesSchema,
  resultSchema: DataSchemaSchema,
  evidenceRequirements: Type.Array(EvidenceRequirementSchema, { maxItems: 64 }),
};

export const NonModelExecutionPlanV2StepSchema = strictObject({
  ...ExecutionPlanV2StepBaseProperties,
  executionMode: Type.Literal("deterministic_skill"),
});

export const PinnedModelExecutionPlanV2StepSchema = strictObject({
  ...ExecutionPlanV2StepBaseProperties,
  executionMode: stringEnum([
    "model_call",
    "bounded_agent",
    "agent_orchestrator",
  ]),
  modelRoutingState: Type.Literal("pinned"),
  modelProfileRevisionId: ModelProfileRevisionIdSchema,
  modelCapability: ModelCapabilitySchema,
  parameterSchema: DataSchemaSchema,
  fallbackModelProfileRevisionIds: Type.Array(ModelProfileRevisionIdSchema, {
    uniqueItems: true,
    maxItems: 8,
  }),
});

export const LegacyUnpinnedExecutionPlanV2StepSchema = strictObject({
  ...ExecutionPlanV2StepBaseProperties,
  executionMode: stringEnum(["bounded_agent", "agent_orchestrator"]),
  modelRoutingState: Type.Literal("legacy_unpinned"),
  legacyModelProfileId: Type.Optional(ModelProfileIdSchema),
  legacyFallbackModelProfileIds: Type.Optional(Type.Array(ModelProfileIdSchema, {
    uniqueItems: true,
    maxItems: 8,
  })),
});

export const ExecutionPlanV2StepSchema = Type.Union([
  NonModelExecutionPlanV2StepSchema,
  PinnedModelExecutionPlanV2StepSchema,
  LegacyUnpinnedExecutionPlanV2StepSchema,
]);

export const ExecutionPlanV2Schema = strictObject(
  {
    schemaVersion: ExecutionPlanV2SchemaVersionSchema,
    planVersion: Type.Literal("2"),
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    generatedAt: UtcTimestampSchema,
    contentHash: ContentHashSchema,
    maxParallelism: Type.Integer({ minimum: 1, maximum: 64 }),
    modelRoutingState: stringEnum([
      "pinned",
      "legacy_unpinned",
      "not_applicable",
    ]),
    pinnedSkills: Type.Array(PinnedSkillRefSchema),
    steps: Type.Array(ExecutionPlanV2StepSchema, { minItems: 1 }),
    reviewGates: Type.Array(ExecutionReviewGateSchema),
    primaryOutput: PrimaryOutputSchema,
  },
  { $id: "ExecutionPlanV2" },
);

export const ExecutionPlanSchema = Type.Union([
  ExecutionPlanV1Schema,
  ExecutionPlanV2Schema,
]);

export const RequiredRunInputSchema = strictObject({
  inputKey: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  schema: DataSchemaSchema,
  required: Type.Boolean(),
});

export const MissingBindingSchema = strictObject({
  nodeId: NodeIdSchema,
  targetPort: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const MissingResourceSchema = strictObject({
  resourceId: ResourceIdSchema,
  label: Type.String({ minLength: 1, maxLength: 200 }),
  nodeId: Type.Optional(NodeIdSchema),
});

export const UnavailableSkillSchema = strictObject({
  skillRef: PinnedSkillRefSchema,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  nodeId: Type.Optional(NodeIdSchema),
});

export const InvalidCycleSchema = strictObject({
  nodeIds: Type.Array(NodeIdSchema, { minItems: 2 }),
});

export const PortSchemaMismatchSchema = strictObject({
  sourceNodeId: NodeIdSchema,
  sourcePort: Type.String({ minLength: 1, maxLength: 128 }),
  targetNodeId: NodeIdSchema,
  targetPort: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const RecoveryActionSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 500 }),
  nodeId: Type.Optional(NodeIdSchema),
});

const CompileResultProperties = {
  schemaVersion: WorkbenchSchemaVersionSchema,
  workflowId: WorkflowIdSchema,
  workflowRevisionId: WorkflowRevisionIdSchema,
  orderedSteps: Type.Array(NodeIdSchema, { uniqueItems: true }),
  requiredRunInputs: Type.Array(RequiredRunInputSchema),
  missingBindings: Type.Array(MissingBindingSchema),
  missingResources: Type.Array(MissingResourceSchema),
  unavailableSkills: Type.Array(UnavailableSkillSchema),
  orphanNodeIds: Type.Array(NodeIdSchema, { uniqueItems: true }),
  unreachableNodeIds: Type.Array(NodeIdSchema, { uniqueItems: true }),
  invalidCycles: Type.Array(InvalidCycleSchema),
  portSchemaMismatches: Type.Array(PortSchemaMismatchSchema),
  reviewGates: Type.Array(NodeIdSchema, { uniqueItems: true }),
  outputNodes: Type.Array(NodeIdSchema, { uniqueItems: true }),
  warnings: Type.Array(DiagnosticSchema),
  recoveryActions: Type.Array(RecoveryActionSchema),
  compiledAt: UtcTimestampSchema,
};

export const ReadyCompileResultSchema = strictObject({
  ...CompileResultProperties,
  status: Type.Literal("ready"),
  executionPlan: ExecutionPlanSchema,
});

export const BlockedCompileResultSchema = strictObject({
  ...CompileResultProperties,
  status: Type.Literal("blocked"),
});

export const InvalidCompileResultSchema = strictObject({
  ...CompileResultProperties,
  status: Type.Literal("invalid"),
});

export const CompileResultSchema = Type.Union(
  [
    ReadyCompileResultSchema,
    BlockedCompileResultSchema,
    InvalidCompileResultSchema,
  ],
  { $id: "CompileResult" },
);

export type ExecutionPlanStep = Static<typeof ExecutionPlanStepSchema>;
export type ExecutionPlanV1 = Static<typeof ExecutionPlanV1Schema>;
export type ExecutionPlanV2Step = Static<typeof ExecutionPlanV2StepSchema>;
export type ExecutionPlanV2 = Static<typeof ExecutionPlanV2Schema>;
export type CompileResult = Static<typeof CompileResultSchema>;
