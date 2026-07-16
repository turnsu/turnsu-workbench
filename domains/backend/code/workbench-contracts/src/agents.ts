import { Type, type Static } from "typebox";

import {
  AgentBranchIdSchema,
  AgentDefinitionIdSchema,
  AgentMessageIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  InvocationIdSchema,
  MergeConflictIdSchema,
  ProposalIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const AgentDefinitionKindSchema = stringEnum(["main", "module"]);
export const AgentObjectKindSchema = stringEnum(["skill_draft", "workflow"]);

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

export const AgentSessionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    sessionId: AgentSessionIdSchema,
    definitionId: AgentDefinitionIdSchema,
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    scope: AgentSessionScopeSchema,
    status: stringEnum(["active", "closed"]),
    activeTurnId: Type.Union([AgentTurnIdSchema, Type.Null()]),
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

export const AgentTurnResultSchema = strictObject({
  response: Type.String({ minLength: 1, maxLength: 20_000 }),
  proposalId: Type.Union([ProposalIdSchema, Type.Null()]),
  handoffId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  invocationIds: Type.Array(InvocationIdSchema, { uniqueItems: true, maxItems: 256 }),
});

export const AgentTurnSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    turnId: AgentTurnIdSchema,
    sessionId: AgentSessionIdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    status: AgentTurnStatusSchema,
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    result: Type.Union([AgentTurnResultSchema, Type.Null()]),
    queuedAt: UtcTimestampSchema,
    startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    finishedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    updatedAt: UtcTimestampSchema,
  },
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

export type AgentDefinition = Static<typeof AgentDefinitionSchema>;
export type AgentSession = Static<typeof AgentSessionSchema>;
export type AgentTurn = Static<typeof AgentTurnSchema>;
export type AgentSessionEvent = Static<typeof AgentSessionEventSchema>;
export type AgentHandoff = Static<typeof AgentHandoffSchema>;
export type MergeConflict = Static<typeof MergeConflictSchema>;
