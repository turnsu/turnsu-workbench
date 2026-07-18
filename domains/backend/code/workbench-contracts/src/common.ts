import { Type, type Static } from "typebox";

import { strictObject, stringEnum } from "./schema.js";

export const WORKBENCH_SCHEMA_VERSION = "workbench-v1" as const;
export const WORKBENCH_API_SCHEMA_VERSION = "workbench-api-v1" as const;
export const EXECUTION_PLAN_V1_SCHEMA_VERSION =
  "workbench-execution-plan-v1" as const;
export const EXECUTION_PLAN_V2_SCHEMA_VERSION =
  "workbench-execution-plan-v2" as const;
export const EXECUTION_FABRIC_SCHEMA_VERSION =
  "workbench-execution-fabric-v1" as const;
export const RUN_EVENT_V1_SCHEMA_VERSION = "workbench-run-event-v1" as const;

export const WorkbenchSchemaVersionSchema = Type.Literal(
  WORKBENCH_SCHEMA_VERSION,
);
export const WorkbenchApiSchemaVersionSchema = Type.Literal(
  WORKBENCH_API_SCHEMA_VERSION,
);
export const ExecutionPlanV1SchemaVersionSchema = Type.Literal(
  EXECUTION_PLAN_V1_SCHEMA_VERSION,
);
export const ExecutionPlanV2SchemaVersionSchema = Type.Literal(
  EXECUTION_PLAN_V2_SCHEMA_VERSION,
);
export const ExecutionFabricSchemaVersionSchema = Type.Literal(
  EXECUTION_FABRIC_SCHEMA_VERSION,
);
export const RunEventV1SchemaVersionSchema = Type.Literal(
  RUN_EVENT_V1_SCHEMA_VERSION,
);

const stableId = (title: string) =>
  Type.String({
    title,
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  });

export const StableIdSchema = stableId("Stable identifier");
export const RequestIdSchema = stableId("Request identifier");
export const WorkspaceIdSchema = stableId("Workspace identifier");
export const SkillIdSchema = stableId("Skill identifier");
export const TemplateIdSchema = stableId("Template identifier");
export const WorkflowIdSchema = stableId("Workflow identifier");
export const WorkflowRevisionIdSchema = stableId("Workflow revision identifier");
export const NodeIdSchema = stableId("Workflow node identifier");
export const EdgeIdSchema = stableId("Workflow edge identifier");
export const ResourceIdSchema = stableId("Resource identifier");
export const ProposalIdSchema = stableId("Builder proposal identifier");
export const RunIdSchema = stableId("Workflow run identifier");
export const NodeRunIdSchema = stableId("Node run identifier");
export const ReviewDecisionIdSchema = stableId("Review decision identifier");
export const EventIdSchema = stableId("Run event identifier");
export const UserIdSchema = stableId("User identifier");
export const SessionIdSchema = stableId("Session identifier");
export const MembershipIdSchema = stableId("Workspace membership identifier");
export const SkillDraftIdSchema = stableId("Skill draft identifier");
export const SkillVersionIdSchema = stableId("Skill version identifier");
export const LoopVersionIdSchema = stableId("Loop version identifier");
export const ReleaseIdSchema = stableId("Workspace asset release identifier");
export const InstallationIdSchema = stableId("Asset installation identifier");
export const UploadIdSchema = stableId("Upload session identifier");
export const LoopImportIdSchema = stableId("Loop import identifier");
export const ObjectIdSchema = stableId("Stored object identifier");
export const ConnectionIdSchema = stableId("Workspace connection identifier");
export const RunJobIdSchema = stableId("Run job identifier");
export const CheckpointIdSchema = stableId("Run checkpoint identifier");
export const RunCommandIdSchema = stableId("Run command identifier");
export const RunAttemptIdSchema = stableId("Run attempt identifier");
export const AuditEventIdSchema = stableId("Audit event identifier");
export const EvidenceIdSchema = stableId("Evidence identifier");
export const InvocationIdSchema = stableId("Execution invocation identifier");
export const ExecutionAttemptIdSchema = stableId("Execution attempt identifier");
export const CapabilityLeaseIdSchema = stableId("Capability lease identifier");
export const AgentDefinitionIdSchema = stableId("Agent definition identifier");
export const AgentSessionIdSchema = stableId("Agent session identifier");
export const AgentTurnIdSchema = stableId("Agent turn identifier");
export const AgentMessageIdSchema = stableId("Agent message identifier");
export const AgentBranchIdSchema = stableId("Agent branch identifier");
export const MergeConflictIdSchema = stableId("Merge conflict identifier");
export const MemoryCandidateIdSchema = stableId("Memory candidate identifier");
export const DurableMemoryIdSchema = stableId("Durable memory identifier");
export const MemoryEventIdSchema = stableId("Memory event identifier");
export const MemoryTombstoneIdSchema = stableId("Memory tombstone identifier");
export const ModelProfileIdSchema = stableId("Model profile identifier");
export const ModelProfileRevisionIdSchema = stableId(
  "Immutable model profile revision identifier",
);
export const ArtifactIdSchema = stableId("Artifact identifier");

export const VersionSchema = Type.String({ minLength: 1, maxLength: 64 });
export const ContentHashSchema = Type.String({
  pattern: "^sha256:[a-f0-9]{16,64}$",
});
export const UtcTimestampSchema = Type.String({
  format: "date-time",
  pattern: "Z$",
});
export const CursorSchema = Type.String({ minLength: 1, maxLength: 512 });
export const IdempotencyKeySchema = Type.String({ minLength: 1, maxLength: 255 });
export const EntityTagSchema = Type.String({
  minLength: 3,
  maxLength: 256,
  pattern: "^(W/)?\"[^\"]+\"$",
});
export const StrongEntityTagSchema = Type.String({
  minLength: 3,
  maxLength: 256,
  pattern: "^\"[^\"]+\"$",
});

export const JsonPrimitiveSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const JsonValueSchema = Type.Union([
  JsonPrimitiveSchema,
  Type.Array(Type.Unknown()),
  Type.Record(Type.String(), Type.Unknown(), { additionalProperties: false }),
]);

export const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema, {
  additionalProperties: false,
});

export const DataSchemaSchema = strictObject(
  {
    type: stringEnum([
      "null",
      "boolean",
      "number",
      "integer",
      "string",
      "array",
      "object",
    ]),
    title: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    properties: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), { additionalProperties: false }),
    ),
    required: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    ),
    items: Type.Optional(Type.Unknown()),
    enum: Type.Optional(Type.Array(JsonValueSchema, { minItems: 1 })),
    additionalProperties: Type.Optional(Type.Boolean()),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
    pattern: Type.Optional(Type.String()),
    format: Type.Optional(Type.String({ minLength: 1 })),
  },
  { $id: "DataSchema" },
);

export const DiagnosticSeveritySchema = stringEnum([
  "info",
  "warning",
  "error",
]);

export const DiagnosticSchema = strictObject(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    severity: DiagnosticSeveritySchema,
    nodeId: Type.Optional(NodeIdSchema),
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    recoveryAction: Type.Optional(
      Type.String({ minLength: 1, maxLength: 1000 }),
    ),
  },
  { $id: "Diagnostic" },
);

export const ResourceRefSchema = strictObject(
  {
    resourceId: ResourceIdSchema,
    version: VersionSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { $id: "ResourceRef" },
);

export const CursorPageRequestSchema = strictObject(
  {
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { $id: "CursorPageRequest" },
);

export const CursorPageSchema = strictObject(
  {
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
    hasMore: Type.Boolean(),
  },
  { $id: "CursorPage" },
);

export const ErrorDetailsSchema = Type.Record(Type.String(), JsonValueSchema, {
  additionalProperties: false,
});

export const ErrorEnvelopeSchema = strictObject(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    details: ErrorDetailsSchema,
    retryable: Type.Boolean(),
    requestId: RequestIdSchema,
  },
  { $id: "ErrorEnvelope" },
);

export type StableId = Static<typeof StableIdSchema>;
export type UtcTimestamp = Static<typeof UtcTimestampSchema>;
export type JsonValue = Static<typeof JsonValueSchema>;
export type DataSchema = Static<typeof DataSchemaSchema>;
export type Diagnostic = Static<typeof DiagnosticSchema>;
export type ResourceRef = Static<typeof ResourceRefSchema>;
export type CursorPageRequest = Static<typeof CursorPageRequestSchema>;
export type CursorPage = Static<typeof CursorPageSchema>;
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;
