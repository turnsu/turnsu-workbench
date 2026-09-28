import { Type, type Static } from "typebox";

import {
  AdmissionIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  CapabilityLeaseIdSchema,
  CapacityLeaseIdSchema,
  DataSchemaSchema,
  EventIdSchema,
  ExecutionAttemptIdSchema,
  ExecutionFabricSchemaVersionSchema,
  IdempotencyKeySchema,
  InvocationIdSchema,
  JsonObjectSchema,
  JsonValueSchema,
  ModelProfileRevisionIdSchema,
  ProductCommandIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { ArtifactRefSchema } from "./artifacts.js";
import {
  ChatInputSchema,
  ImageGenerationInputSchema,
  ModelCapabilitySchema,
  ModelInputSchema,
} from "./models.js";
import { strictObject, stringEnum } from "./schema.js";

export const ExecutionModeSchema = stringEnum([
  "deterministic_skill",
  "model_call",
  "realtime_audio",
  "bounded_agent",
  "agent_orchestrator",
]);

export const ExecutionIsolationSchema = stringEnum([
  "process",
  "container",
  "remote",
]);

export const ExecutionStatusSchema = stringEnum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "partial",
  "effect_outcome_unknown",
  "timeout",
  "permission_denied",
  "sandbox_unavailable",
  "remote_backend_unavailable",
]);

export const ExecutionLimitsSchema = strictObject({
  timeoutMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }),
  maxSteps: Type.Integer({ minimum: 1, maximum: 10_000 }),
  maxModelRequests: Type.Integer({ minimum: 0, maximum: 10_000 }),
  maxChildren: Type.Integer({ minimum: 0, maximum: 256 }),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
  maxSpawnedChildren: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  maxToolResultChars: Type.Optional(Type.Integer({ minimum: 1024, maximum: 4_000_000 })),
  maxInputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maxInputBytes: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  maxOutputBytes: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  maxImageCount: Type.Integer({ minimum: 0, maximum: 16 }),
  maxCostUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
});

export const ModelCallExecutionLimitsSchema = strictObject({
  timeoutMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }),
  maxSteps: Type.Literal(1),
  maxModelRequests: Type.Integer({ minimum: 1, maximum: 100 }),
  maxChildren: Type.Literal(0),
  maxInputBytes: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  maxOutputBytes: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  maxImageCount: Type.Integer({ minimum: 0, maximum: 16 }),
  maxCostUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
});

export const ExecutionCapabilitiesSchema = strictObject({
  toolAllowlist: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    uniqueItems: true,
    maxItems: 128,
  }),
  connectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    uniqueItems: true,
    maxItems: 128,
  }),
  network: Type.Boolean(),
  filesystem: stringEnum(["none", "scratch_readonly", "scratch_write"]),
  externalActions: Type.Boolean(),
});

export const ModelCallExecutionCapabilitiesSchema = strictObject({
  toolAllowlist: Type.Tuple([]),
  connectionIds: Type.Tuple([]),
  network: Type.Literal(false),
  filesystem: Type.Literal("none"),
  externalActions: Type.Literal(false),
});

export const EvidenceRequirementSchema = strictObject({
  requirementId: Type.String({ minLength: 1, maxLength: 128 }),
  kind: stringEnum(["output", "artifact", "citation", "validation"]),
  required: Type.Boolean(),
  description: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const ExecutionControllerSchema = strictObject({
  kind: stringEnum(["workflow_run", "agent_turn", "skill_creation_turn", "skill_test", "member_agent_request"]),
  controllerId: Type.String({ minLength: 1, maxLength: 128 }),
  fence: Type.Integer({ minimum: 0 }),
});

export const ExecutionActorSchema = strictObject({
  userId: UserIdSchema,
});

export const ExecutionLineageSchema = strictObject({
  productCommandId: ProductCommandIdSchema,
  sessionId: Type.Optional(AgentSessionIdSchema),
  turnId: Type.Optional(AgentTurnIdSchema),
  parentInvocationId: Type.Optional(InvocationIdSchema),
});

const AdmittedRealtimeExecutionLineageSchema = strictObject({
  productCommandId: ProductCommandIdSchema,
  sessionId: AgentSessionIdSchema,
  turnId: AgentTurnIdSchema,
  parentInvocationId: Type.Optional(InvocationIdSchema),
});

export const ExecutionCapacityAuthoritySchema = strictObject({
  admissionId: AdmissionIdSchema,
  capacityLeaseId: CapacityLeaseIdSchema,
  fence: Type.Integer({ minimum: 1 }),
});

const ExecutionRequestBaseProperties = {
  schemaVersion: ExecutionFabricSchemaVersionSchema,
  invocationId: InvocationIdSchema,
  attemptId: ExecutionAttemptIdSchema,
  workspaceId: WorkspaceIdSchema,
  actor: Type.Optional(ExecutionActorSchema),
  lineage: Type.Optional(ExecutionLineageSchema),
  capacityAuthority: Type.Optional(ExecutionCapacityAuthoritySchema),
  controller: strictObject({...ExecutionControllerSchema.properties,kind:stringEnum(["workflow_run","agent_turn","skill_creation_turn","skill_test"])}),
  isolation: ExecutionIsolationSchema,
  goal: Type.String({ minLength: 1, maxLength: 8000 }),
  resultSchema: DataSchemaSchema,
  evidenceRequirements: Type.Array(EvidenceRequirementSchema, { maxItems: 64 }),
  metadata: JsonObjectSchema,
};

export const NonModelExecutionRequestSchema = strictObject({
  ...ExecutionRequestBaseProperties,
  mode: stringEnum([
    "deterministic_skill",
    "bounded_agent",
    "agent_orchestrator",
  ]),
  input: JsonValueSchema,
  limits: ExecutionLimitsSchema,
  capabilities: ExecutionCapabilitiesSchema,
});

// The provider pays through its own native account; Product does not know a monetary budget.
export const MemberAgentExecutionRequestSchema = strictObject({
  ...ExecutionRequestBaseProperties,
  actor: ExecutionActorSchema,
  lineage: strictObject({productCommandId:ProductCommandIdSchema}),
  controller: strictObject({kind:Type.Literal("member_agent_request"),controllerId:Type.String({minLength:1,maxLength:128}),fence:Type.Literal(1)}),
  mode:Type.Literal("bounded_agent"),isolation:Type.Literal("remote"),input:JsonValueSchema,
  metadata:strictObject({profile:Type.Literal("pi-declared-text-v1"),requestDigest:Type.String({pattern:"^sha256:[a-f0-9]{64}$"}),usageAccounting:Type.Literal("local_unmetered")}),
  limits:strictObject({...ExecutionLimitsSchema.properties,maxCostUsdMicros:Type.Null(),timeoutMs:Type.Integer({minimum:1000,maximum:300000}),maxModelRequests:Type.Integer({minimum:1,maximum:8}),maxOutputTokens:Type.Integer({minimum:1,maximum:4096}),maxOutputBytes:Type.Integer({minimum:1,maximum:64000}),maxChildren:Type.Literal(0)}),
  capabilities:strictObject({toolAllowlist:Type.Tuple([Type.Literal("read_input"),Type.Literal("write_result")]),connectionIds:Type.Tuple([]),network:Type.Literal(false),filesystem:Type.Literal("none"),externalActions:Type.Literal(false)}),
});

const ModelCallExecutionRequestProperties = {
  ...ExecutionRequestBaseProperties,
  mode: Type.Literal("model_call"),
  modelProfileRevisionId: ModelProfileRevisionIdSchema,
  fallbackModelProfileRevisionIds: Type.Array(ModelProfileRevisionIdSchema, {
    uniqueItems: true,
    maxItems: 8,
  }),
  limits: ModelCallExecutionLimitsSchema,
  capabilities: ModelCallExecutionCapabilitiesSchema,
};

export const ChatModelCallExecutionRequestSchema = strictObject({
  ...ModelCallExecutionRequestProperties,
  modelCapability: stringEnum(["chat", "tool_calling", "structured_output", "image_input"]),
  input: ChatInputSchema,
});

export const ImageModelCallExecutionRequestSchema = strictObject({
  ...ModelCallExecutionRequestProperties,
  modelCapability: Type.Literal("image_generation"),
  input: ImageGenerationInputSchema,
});

export const ModelCallExecutionRequestSchema = Type.Union([
  ChatModelCallExecutionRequestSchema,
  ImageModelCallExecutionRequestSchema,
]);

export const RealtimeAudioExecutionRequestSchema = strictObject({
  ...ExecutionRequestBaseProperties,
  actor: ExecutionActorSchema,
  lineage: AdmittedRealtimeExecutionLineageSchema,
  mode: Type.Literal("realtime_audio"),
  isolation: Type.Literal("process"),
  modelProfileRevisionId: ModelProfileRevisionIdSchema,
  modelCapability: Type.Literal("realtime_audio"),
  fallbackModelProfileRevisionIds: Type.Tuple([]),
  limits: ExecutionLimitsSchema,
  capabilities: ExecutionCapabilitiesSchema,
});

export const ExecutionRequestSchema = Type.Union(
  [
    NonModelExecutionRequestSchema,
    MemberAgentExecutionRequestSchema,
    ModelCallExecutionRequestSchema,
    RealtimeAudioExecutionRequestSchema,
  ],
  { $id: "ExecutionRequest" },
);

export const RealtimeStreamReadySchema = strictObject(
  {
    schemaVersion: ExecutionFabricSchemaVersionSchema,
    invocationId: InvocationIdSchema,
    attemptId: ExecutionAttemptIdSchema,
    status: Type.Literal("running"),
    isolation: Type.Literal("process"),
    sdpAnswer: Type.String({ minLength: 1, maxLength: 256_000 }),
    startedAt: UtcTimestampSchema,
  },
  { $id: "RealtimeStreamReady" },
);

export const RealtimeStreamUpdateSchema = strictObject({
  kind: Type.Literal("session_instructions"),
  instructions: Type.String({ maxLength: 60_000 }),
});

export const ModelInvocationRequestSchema = strictObject(
  {
    invocationId: InvocationIdSchema,
    attemptId: ExecutionAttemptIdSchema,
    workspaceId: WorkspaceIdSchema,
    modelProfileRevisionId: ModelProfileRevisionIdSchema,
    capability: ModelCapabilitySchema,
    typedInput: ModelInputSchema,
    limits: ModelCallExecutionLimitsSchema,
    capabilityLeaseId: CapabilityLeaseIdSchema,
    idempotencyKey: IdempotencyKeySchema,
  },
  { $id: "ModelInvocationRequest" },
);

export const ExecutionEventSchema = strictObject(
  {
    schemaVersion: ExecutionFabricSchemaVersionSchema,
    eventId: EventIdSchema,
    invocationId: InvocationIdSchema,
    attemptId: ExecutionAttemptIdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    type: Type.String({ minLength: 1, maxLength: 128 }),
    status: ExecutionStatusSchema,
    payload: JsonObjectSchema,
    occurredAt: UtcTimestampSchema,
  },
  { $id: "ExecutionEvent" },
);

const MeteredExecutionResultSchema = strictObject(
  {
    schemaVersion: ExecutionFabricSchemaVersionSchema,
    invocationId: InvocationIdSchema,
    attemptId: ExecutionAttemptIdSchema,
    status: ExecutionStatusSchema,
    isolation: ExecutionIsolationSchema,
    requestedModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
    actualModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
    artifactRefs: Type.Array(ArtifactRefSchema, { uniqueItems: true, maxItems: 256 }),
    output: Type.Optional(JsonValueSchema),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" })),
    evidence: Type.Array(JsonObjectSchema, { maxItems: 256 }),
    usage: strictObject({
      steps: Type.Integer({ minimum: 0 }),
      modelRequests: Type.Integer({ minimum: 0 }),
      inputBytes: Type.Integer({ minimum: 0 }),
      outputBytes: Type.Integer({ minimum: 0 }),
      imageCount: Type.Integer({ minimum: 0, maximum: 16 }),
      costUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
      inputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
      outputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
      totalTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000_000_000 })),
      audioInputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
      audioOutputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
      cachedInputTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000_000 })),
    }),
    startedAt: UtcTimestampSchema,
    finishedAt: UtcTimestampSchema,
  },
  { $id: "MeteredExecutionResult" },
);

export const ExecutionResultSchema = Type.Union([
  MeteredExecutionResultSchema,
  strictObject({...MeteredExecutionResultSchema.properties,
    isolation:Type.Literal("remote"),usageAccounting:Type.Literal("local_unmetered"),
    usage:strictObject({steps:Type.Null(),modelRequests:Type.Null(),costUsdMicros:Type.Null(),
      inputBytes:Type.Integer({minimum:0}),outputBytes:Type.Integer({minimum:0}),imageCount:Type.Literal(0)})}),
],{$id:"ExecutionResult"});

export const ExecutionCheckpointSchema = strictObject(
  {
    schemaVersion: ExecutionFabricSchemaVersionSchema,
    checkpointId: Type.String({ minLength: 1, maxLength: 128 }),
    invocationId: InvocationIdSchema,
    attemptId: ExecutionAttemptIdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    fence: Type.Integer({ minimum: 0 }),
    state: JsonObjectSchema,
    createdAt: UtcTimestampSchema,
  },
  { $id: "ExecutionCheckpoint" },
);

export const CapabilityLeaseSchema = strictObject(
  {
    schemaVersion: ExecutionFabricSchemaVersionSchema,
    capabilityLeaseId: CapabilityLeaseIdSchema,
    invocationId: InvocationIdSchema,
    attemptId: ExecutionAttemptIdSchema,
    workspaceId: WorkspaceIdSchema,
    fence: Type.Integer({ minimum: 0 }),
    status: stringEnum(["active", "revoked", "expired"]),
    capabilities: ExecutionCapabilitiesSchema,
    issuedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    revokedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "CapabilityLease" },
);

export type ExecutionMode = Static<typeof ExecutionModeSchema>;
export type ExecutionIsolation = Static<typeof ExecutionIsolationSchema>;
export type ExecutionLimits = Static<typeof ExecutionLimitsSchema>;
export type ModelCallExecutionLimits = Static<
  typeof ModelCallExecutionLimitsSchema
>;
export type ExecutionCapabilities = Static<typeof ExecutionCapabilitiesSchema>;
export type ExecutionRequest = Static<typeof ExecutionRequestSchema>;
export type RealtimeAudioExecutionRequest = Static<
  typeof RealtimeAudioExecutionRequestSchema
>;
export type RealtimeStreamReady = Static<typeof RealtimeStreamReadySchema>;
export type RealtimeStreamUpdate = Static<typeof RealtimeStreamUpdateSchema>;
export type ModelInvocationRequest = Static<typeof ModelInvocationRequestSchema>;
export type ExecutionEvent = Static<typeof ExecutionEventSchema>;
export type ExecutionResult = Static<typeof ExecutionResultSchema>;
export type ExecutionCheckpoint = Static<typeof ExecutionCheckpointSchema>;
export type CapabilityLease = Static<typeof CapabilityLeaseSchema>;
