import { Type, type Static } from "typebox";

import {
  AgentBranchIdSchema,
  AgentDefinitionIdSchema,
  AgentMessageIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  InvocationIdSchema,
  MergeConflictIdSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
  ProductCommandIdSchema,
  ProposalIdSchema,
  RunIdSchema,
  JsonValueSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkbenchSchemaVersionSchema,
  WorkItemIdSchema,
  WorkItemContinuationIdSchema,
} from "./common.js";
import { ArtifactRefSchema } from "./artifacts.js";
import { AttachmentRefSchema } from "./attachments.js";
import {
  ImageGenerationInputSchema,
  ImageGenerationResultSchema,
} from "./models.js";
import { strictObject, stringEnum } from "./schema.js";

export const AgentDefinitionKindSchema = stringEnum(["main", "module"]);
export const AgentObjectKindSchema = stringEnum(["skill_draft", "workflow"]);
export const AgentBranchStatusSchema = stringEnum([
  "active",
  "conflicting",
  "merged",
  "rejected",
  "closed",
]);
export const AgentTurnKindSchema = stringEnum(["agent_message", "model_task"]);

export const AgentDefinitionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    definitionId: AgentDefinitionIdSchema,
    kind: AgentDefinitionKindSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    objectKinds: Type.Array(AgentObjectKindSchema, { uniqueItems: true }),
    canHandoffToMain: Type.Boolean(),
  },
  { $id: "AgentDefinition" },
);

export const AgentSessionScopeSchema = Type.Union([
  strictObject({ kind: Type.Literal("main") }),
  strictObject({
    kind: Type.Literal("module"),
    objectKind: AgentObjectKindSchema,
    objectId: Type.String({ minLength: 1, maxLength: 128 }),
    branchId: AgentBranchIdSchema,
    baseVersionId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
]);

export const AgentBranchSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    branchId: AgentBranchIdSchema,
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    objectKind: AgentObjectKindSchema,
    objectId: Type.String({ minLength: 1, maxLength: 128 }),
    baseVersionId: Type.String({ minLength: 1, maxLength: 128 }),
    status: AgentBranchStatusSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "AgentBranch" },
);

export const AgentTaskStatusSchema = stringEnum([
  "idle",
  "queued",
  "running",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);

export const AgentTaskSourceSchema = Type.Union([
  strictObject({ kind: Type.Literal("manual") }),
  strictObject({
    kind: Type.Literal("loop_run"),
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    runId: RunIdSchema,
  }),
]);

export const AgentSessionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    sessionId: AgentSessionIdSchema,
    definitionId: AgentDefinitionIdSchema,
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    scope: AgentSessionScopeSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    source: AgentTaskSourceSchema,
    workItemContext: Type.Optional(strictObject({
      workItemId: WorkItemIdSchema,
      continuationId: WorkItemContinuationIdSchema,
    })),
    taskStatus: AgentTaskStatusSchema,
    archived: Type.Boolean(),
    status: stringEnum(["active", "closed"]),
    lastUsedModelProfileId: Type.Union([ModelProfileIdSchema, Type.Null()]),
    modelPreferenceState: stringEnum(["preference_only", "legacy_unpinned"]),
    activeTurnId: Type.Union([AgentTurnIdSchema, Type.Null()]),
    sessionEpoch: Type.Optional(Type.Integer({ minimum: 1 })),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "AgentSession" },
);

export const AgentTurnStatusSchema = stringEnum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);

export const AgentMessageTurnInputSchema = strictObject({
  message: Type.String({ maxLength: 20_000 }),
  attachments: Type.Optional(
    Type.Array(AttachmentRefSchema, {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
  ),
});

export const ImageGenerationModelTaskInputSchema = strictObject({
  task: Type.Literal("image_generation"),
  ...ImageGenerationInputSchema.properties,
});

export const AgentTurnInputSchema = Type.Union([
  AgentMessageTurnInputSchema,
  ImageGenerationModelTaskInputSchema,
]);

export const AgentTurnUsageSchema = strictObject({
  steps: Type.Integer({ minimum: 0 }),
  modelRequests: Type.Integer({ minimum: 0 }),
  inputBytes: Type.Integer({ minimum: 0 }),
  outputBytes: Type.Integer({ minimum: 0 }),
  imageCount: Type.Integer({ minimum: 0, maximum: 16 }),
  costUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
  inputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
  totalTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000_000_000 })),
});

export const AgentMessageTurnResultSchema = strictObject({
  kind: Type.Literal("agent_message"),
  response: Type.String({ minLength: 1, maxLength: 20_000 }),
  proposalId: Type.Union([ProposalIdSchema, Type.Null()]),
  handoffId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  invocationIds: Type.Array(InvocationIdSchema, { uniqueItems: true, maxItems: 256 }),
  requestedModelRevisionId: ModelProfileRevisionIdSchema,
  actualModelRevisionId: ModelProfileRevisionIdSchema,
  artifactRefs: Type.Array(ArtifactRefSchema, { uniqueItems: true, maxItems: 256 }),
  usage: Type.Optional(AgentTurnUsageSchema),
});

export const ModelTaskTurnResultSchema = strictObject({
  kind: Type.Literal("model_task"),
  result: ImageGenerationResultSchema,
  invocationIds: Type.Array(InvocationIdSchema, { uniqueItems: true, maxItems: 256 }),
  requestedModelRevisionId: ModelProfileRevisionIdSchema,
  actualModelRevisionId: ModelProfileRevisionIdSchema,
  artifactRefs: Type.Array(ArtifactRefSchema, {
    minItems: 1,
    uniqueItems: true,
    maxItems: 16,
  }),
  usage: Type.Optional(AgentTurnUsageSchema),
});

export const AgentTurnResultSchema = Type.Union([
  AgentMessageTurnResultSchema,
  ModelTaskTurnResultSchema,
]);

const AgentTurnBaseProperties = {
  schemaVersion: WorkbenchSchemaVersionSchema,
  turnId: AgentTurnIdSchema,
  sessionId: AgentSessionIdSchema,
  productCommandId: Type.Optional(ProductCommandIdSchema),
  cancellationCommandId: Type.Optional(ProductCommandIdSchema),
  sessionEpoch: Type.Optional(Type.Integer({ minimum: 1 })),
  turnFence: Type.Optional(Type.Integer({ minimum: 1 })),
  sequence: Type.Integer({ minimum: 1 }),
  status: AgentTurnStatusSchema,
  modelRoutingState: Type.Literal("pinned"),
  requestedModelRevisionId: ModelProfileRevisionIdSchema,
  actualModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
  artifactRefs: Type.Array(ArtifactRefSchema, { uniqueItems: true, maxItems: 256 }),
  queuedAt: UtcTimestampSchema,
  startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  finishedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  updatedAt: UtcTimestampSchema,
};

export const AgentMessageTurnSchema = strictObject({
  ...AgentTurnBaseProperties,
  kind: Type.Literal("agent_message"),
  input: AgentMessageTurnInputSchema,
  result: Type.Union([AgentMessageTurnResultSchema, Type.Null()]),
});

export const ModelTaskTurnSchema = strictObject({
  ...AgentTurnBaseProperties,
  kind: Type.Literal("model_task"),
  input: ImageGenerationModelTaskInputSchema,
  result: Type.Union([ModelTaskTurnResultSchema, Type.Null()]),
});

export const LegacyAgentTurnResultSchema = strictObject({
  response: Type.String({ minLength: 1, maxLength: 20_000 }),
  proposalId: Type.Union([ProposalIdSchema, Type.Null()]),
  handoffId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  invocationIds: Type.Array(InvocationIdSchema, { uniqueItems: true, maxItems: 256 }),
});

export const LegacyUnpinnedAgentTurnSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  turnId: AgentTurnIdSchema,
  sessionId: AgentSessionIdSchema,
  sequence: Type.Integer({ minimum: 1 }),
  status: AgentTurnStatusSchema,
  modelRoutingState: Type.Literal("legacy_unpinned"),
  message: Type.String({ minLength: 1, maxLength: 20_000 }),
  result: Type.Union([LegacyAgentTurnResultSchema, Type.Null()]),
  queuedAt: UtcTimestampSchema,
  startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  finishedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  updatedAt: UtcTimestampSchema,
});

export const AgentTurnSchema = Type.Union(
  [AgentMessageTurnSchema, ModelTaskTurnSchema, LegacyUnpinnedAgentTurnSchema],
  { $id: "AgentTurn" },
);

export const AgentMessageSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  messageId: AgentMessageIdSchema,
  sessionId: AgentSessionIdSchema,
  turnId: AgentTurnIdSchema,
  sequence: Type.Integer({ minimum: 1 }),
  role: stringEnum(["user", "assistant", "system"]),
  kind: stringEnum(["turn", "steer", "result"]),
  content: Type.String({ minLength: 1, maxLength: 20_000 }),
  createdAt: UtcTimestampSchema,
});

export const AgentSessionEventSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  eventId: Type.String({ minLength: 1, maxLength: 128 }),
  sessionId: AgentSessionIdSchema,
  turnId: Type.Union([AgentTurnIdSchema, Type.Null()]),
  sequence: Type.Integer({ minimum: 1 }),
  type: Type.String({ minLength: 1, maxLength: 128 }),
  status: AgentTurnStatusSchema,
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  occurredAt: UtcTimestampSchema,
});

export const AgentHandoffSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  handoffId: Type.String({ minLength: 1, maxLength: 128 }),
  sourceSessionId: AgentSessionIdSchema,
  targetSessionId: AgentSessionIdSchema,
  status: stringEnum(["pending", "confirmed", "dismissed"]),
  importantState: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 64 }),
  decisions: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 64 }),
  risks: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 64 }),
  artifactRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 }),
  createdAt: UtcTimestampSchema,
  confirmedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
});

export const MergeConflictSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  mergeConflictId: MergeConflictIdSchema,
  workspaceId: WorkspaceIdSchema,
  proposalId: ProposalIdSchema,
  objectKind: AgentObjectKindSchema,
  objectId: Type.String({ minLength: 1, maxLength: 128 }),
  path: Type.String({ minLength: 1, maxLength: 1000 }),
  baseValueHash: Type.String({ minLength: 1, maxLength: 100 }),
  currentValueHash: Type.String({ minLength: 1, maxLength: 100 }),
  proposedValueHash: Type.String({ minLength: 1, maxLength: 100 }),
  status: stringEnum(["open", "resolved"]),
  createdAt: UtcTimestampSchema,
  resolvedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
});

export const AgentProposalOperationSchema = strictObject({
  op: stringEnum(["add", "replace", "remove"]),
  path: Type.String({ minLength: 1, maxLength: 1000, pattern: "^/" }),
  value: Type.Optional(JsonValueSchema),
});

export const AgentProposalValidationResultSchema = strictObject({
  status: stringEnum(["passed", "failed", "not_run"]),
  diagnostics: Type.Array(Type.Record(Type.String(), JsonValueSchema), { maxItems: 128 }),
});

export const AgentObjectProposalSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  proposalId: ProposalIdSchema,
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  sessionId: AgentSessionIdSchema,
  turnId: AgentTurnIdSchema,
  definitionId: AgentDefinitionIdSchema,
  objectKind: AgentObjectKindSchema,
  objectId: Type.String({ minLength: 1, maxLength: 128 }),
  branchId: AgentBranchIdSchema,
  baseVersionId: Type.String({ minLength: 1, maxLength: 128 }),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  operations: Type.Array(AgentProposalOperationSchema, { minItems: 1, maxItems: 256 }),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { uniqueItems: true, maxItems: 256 }),
  validationResult: AgentProposalValidationResultSchema,
  status: stringEnum(["proposed", "conflicting", "accepted", "rejected", "superseded"]),
  createdBy: UserIdSchema,
  createdAt: UtcTimestampSchema,
  decidedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
});

export type AgentDefinition = Static<typeof AgentDefinitionSchema>;
export type AgentBranch = Static<typeof AgentBranchSchema>;
export type AgentSession = Static<typeof AgentSessionSchema>;
export type AgentTurn = Static<typeof AgentTurnSchema>;
export type AgentSessionEvent = Static<typeof AgentSessionEventSchema>;
export type AgentHandoff = Static<typeof AgentHandoffSchema>;
export type MergeConflict = Static<typeof MergeConflictSchema>;
export type AgentObjectProposal = Static<typeof AgentObjectProposalSchema>;
