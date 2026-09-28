import { Type, type Static } from "typebox";

import {
  AdmissionIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  CursorPageSchema,
  ExecutionAttemptIdSchema,
  InvocationIdSchema,
  ProductCommandIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const ProductCommandStatusSchema = stringEnum([
  "accepted",
  "running",
  "cancellation_requested",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);

export const ProductCommandSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    commandId: ProductCommandIdSchema,
    kind: stringEnum([
      "agent_turn",
      "cancel_agent_turn",
      "skill_creation_turn",
      "cancel_skill_creation_turn",
      "skill_creation_realtime_call",
      "finish_skill_creation_realtime_call",
      "cancel_skill_creation_realtime_call",
      "builder_proposal",
      "skill_test",
      "cancel_skill_test",
      "skill_validation",
      "workflow_run",
      "workflow_run_step",
    ]),
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    sessionId: AgentSessionIdSchema,
    turnId: AgentTurnIdSchema,
    invocationId: Type.Optional(InvocationIdSchema),
    attemptId: Type.Optional(ExecutionAttemptIdSchema),
    targetCommandId: Type.Optional(ProductCommandIdSchema),
    status: ProductCommandStatusSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    finishedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "ProductCommand" },
);

export const AgentAdmissionQueueItemSchema = strictObject(
  {
    admissionId: AdmissionIdSchema,
    commandId: ProductCommandIdSchema,
    invocationId: Type.Union([InvocationIdSchema, Type.Null()]),
    sessionId: AgentSessionIdSchema,
    turnId: AgentTurnIdSchema,
    reasonCode: stringEnum(["waiting_session_turn", "waiting_capacity"]),
    position: Type.Integer({ minimum: 1 }),
    estimatedWaitSeconds: Type.Integer({ minimum: 0 }),
    approximate: Type.Literal(true),
    cancellable: Type.Boolean(),
    cancelAction: Type.Union([
      strictObject({
        method: Type.Literal("POST"),
        path: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
      Type.Null(),
    ]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "AgentAdmissionQueueItem" },
);

export const AgentSessionQueueReadModelSchema = strictObject(
  {
    sessionId: AgentSessionIdSchema,
    runningTurnId: Type.Union([AgentTurnIdSchema, Type.Null()]),
    queuedTurnCount: Type.Integer({ minimum: 0 }),
    items: Type.Array(AgentAdmissionQueueItemSchema, { maxItems: 100 }),
    page: CursorPageSchema,
  },
  { $id: "AgentSessionQueueReadModel" },
);

export const AdmissionWaitingStateSchema = stringEnum([
  "waiting_session_turn",
  "waiting_capacity",
  "running",
  "cancellation_requested",
  "released",
  "cancelled",
]);

export const AdmissionWaitingRecordSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    admissionId: AdmissionIdSchema,
    commandId: ProductCommandIdSchema,
    kind: stringEnum(["command_turn", "execution_invocation"]),
    invocationId: Type.Union([InvocationIdSchema, Type.Null()]),
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    sessionId: Type.Union([AgentSessionIdSchema, Type.Null()]),
    turnId: Type.Union([AgentTurnIdSchema, Type.Null()]),
    state: AdmissionWaitingStateSchema,
    queueSlotHeld: Type.Boolean(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    releasedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "AdmissionWaitingRecord" },
);

export type ProductCommand = Static<typeof ProductCommandSchema>;
export type AdmissionWaitingRecord = Static<typeof AdmissionWaitingRecordSchema>;
export type AgentAdmissionQueueItem = Static<typeof AgentAdmissionQueueItemSchema>;
export type AgentSessionQueueReadModel = Static<typeof AgentSessionQueueReadModelSchema>;
