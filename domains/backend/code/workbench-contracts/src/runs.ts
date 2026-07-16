import { Type, type Static } from "typebox";

import {
  EXECUTION_PLAN_V1_SCHEMA_VERSION,
  ContentHashSchema,
  EventIdSchema,
  EvidenceIdSchema,
  IdempotencyKeySchema,
  JsonObjectSchema,
  NodeIdSchema,
  NodeRunIdSchema,
  RequestIdSchema,
  ResourceRefSchema,
  ReviewDecisionIdSchema,
  RunEventV1SchemaVersionSchema,
  RunIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  VersionSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const WorkflowRunStatusSchema = stringEnum([
  "queued",
  "running",
  "waiting_review",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const NodeRunStatusSchema = stringEnum([
  "queued",
  "running",
  "waiting_review",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const ProductFailureSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  retryable: Type.Boolean(),
  requestId: Type.Optional(RequestIdSchema),
});

export const NodeRunSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    nodeRunId: NodeRunIdSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema,
    attempt: Type.Integer({ minimum: 1 }),
    status: NodeRunStatusSchema,
    summary: Type.String({ maxLength: 2000 }),
    failure: Type.Optional(ProductFailureSchema),
    startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    completedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "NodeRun" },
);

export const ReviewDecisionValueSchema = stringEnum([
  "approve",
  "revise",
  "reject",
]);

export const ReviewDecisionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    decisionId: ReviewDecisionIdSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema,
    decision: ReviewDecisionValueSchema,
    comment: Type.Optional(Type.String({ maxLength: 4000 })),
    requestedChanges: Type.Array(
      Type.String({ minLength: 1, maxLength: 1000 }),
    ),
    decidedBy: UserIdSchema,
    decidedAt: UtcTimestampSchema,
    idempotencyKey: IdempotencyKeySchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "ReviewDecision" },
);

export const AuthoritativeReadModelRefSchema = strictObject({
  available: Type.Boolean(),
  version: Type.Integer({ minimum: 0 }),
});

export const WorkflowRunSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    retryOf: Type.Optional(RunIdSchema),
    inputs: JsonObjectSchema,
    resourceRefs: Type.Array(ResourceRefSchema),
    executionPlanVersion: Type.Literal(EXECUTION_PLAN_V1_SCHEMA_VERSION),
    executionPlanContentHash: ContentHashSchema,
    status: WorkflowRunStatusSchema,
    currentNodeId: Type.Union([NodeIdSchema, Type.Null()]),
    idempotencyKey: IdempotencyKeySchema,
    nodeRuns: Type.Array(NodeRunSchema),
    reviewDecisions: Type.Array(ReviewDecisionSchema),
    authoritativeReadModel: AuthoritativeReadModelRefSchema,
    queuedAt: UtcTimestampSchema,
    startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    finishedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkflowRun" },
);

export const RunEventTypeSchema = stringEnum([
  "run.queued",
  "run.started",
  "node.started",
  "node.progress",
  "node.completed",
  "node.failed",
  "review.requested",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export const RunEventStatusSchema = stringEnum([
  "queued",
  "running",
  "waiting_review",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

export const RunEventSchema = strictObject(
  {
    schemaVersion: RunEventV1SchemaVersionSchema,
    sequence: Type.Integer({ minimum: 1 }),
    eventId: EventIdSchema,
    type: RunEventTypeSchema,
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    nodeId: Type.Optional(NodeIdSchema),
    status: RunEventStatusSchema,
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    occurredAt: UtcTimestampSchema,
  },
  { $id: "RunEvent" },
);

export const FinalAnswerSchema = strictObject({
  format: stringEnum(["markdown", "text", "json"]),
  content: Type.String({ minLength: 1, maxLength: 1000000 }),
  createdAt: UtcTimestampSchema,
});

export const EvidenceGapSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  nodeId: Type.Optional(NodeIdSchema),
});

export const ReviewPacketSchema = strictObject({
  nodeId: NodeIdSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  items: Type.Array(Type.String({ minLength: 1, maxLength: 1000 })),
  canRequestChanges: Type.Boolean(),
});

export const RecoveryActionReadModelSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 500 }),
});

export const EvidenceRefSchema = strictObject({
  evidenceId: EvidenceIdSchema,
  label: Type.String({ minLength: 1, maxLength: 200 }),
  kind: stringEnum(["source", "resource", "observation"]),
  citation: Type.String({ minLength: 1, maxLength: 2000 }),
});

export const RunReadModelSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    status: WorkflowRunStatusSchema,
    currentNodeId: Type.Union([NodeIdSchema, Type.Null()]),
    nodeTimeline: Type.Array(NodeRunSchema),
    finalAnswer: Type.Union([FinalAnswerSchema, Type.Null()]),
    evidenceGaps: Type.Array(EvidenceGapSchema),
    reviewPacket: Type.Union([ReviewPacketSchema, Type.Null()]),
    reviewDecisions: Type.Array(ReviewDecisionSchema),
    failure: Type.Union([ProductFailureSchema, Type.Null()]),
    recoveryActions: Type.Array(RecoveryActionReadModelSchema),
    followUpPrompts: Type.Array(
      Type.String({ minLength: 1, maxLength: 2000 }),
    ),
    resourceRefs: Type.Array(ResourceRefSchema),
    evidenceRefs: Type.Array(EvidenceRefSchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "RunReadModel" },
);

export const RunComparisonEntrySchema = strictObject(
  {
    runId: RunIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    status: WorkflowRunStatusSchema,
    skillVersions: Type.Array(VersionSchema),
    reviewed: Type.Boolean(),
    finalAnswer: Type.Union([FinalAnswerSchema, Type.Null()]),
    finishedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "RunComparisonEntry" },
);

export const RunComparisonSchema = strictObject(
  {
    left: RunComparisonEntrySchema,
    right: RunComparisonEntrySchema,
    workflowRevisionChanged: Type.Boolean(),
    skillVersionsChanged: Type.Boolean(),
    finalAnswerChanged: Type.Boolean(),
  },
  { $id: "RunComparison" },
);

export type WorkflowRunStatus = Static<typeof WorkflowRunStatusSchema>;
export type NodeRun = Static<typeof NodeRunSchema>;
export type ReviewDecision = Static<typeof ReviewDecisionSchema>;
export type WorkflowRun = Static<typeof WorkflowRunSchema>;
export type RunEvent = Static<typeof RunEventSchema>;
export type RunReadModel = Static<typeof RunReadModelSchema>;
export type RunComparisonEntry = Static<typeof RunComparisonEntrySchema>;
export type RunComparison = Static<typeof RunComparisonSchema>;
