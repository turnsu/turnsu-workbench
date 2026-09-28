import { Type, type Static } from "typebox";

import {
  DurableMemoryIdSchema,
  JsonObjectSchema,
  MemoryCandidateIdSchema,
  MemoryEventIdSchema,
  MemoryTombstoneIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const MemoryScopeKindSchema = stringEnum(["personal", "object", "workspace"]);
export const MemoryCandidateStatusSchema = stringEnum(["pending", "promoted", "rejected", "expired"]);
export const MemoryScopeSchema = Type.Union([
  strictObject({ kind: Type.Literal("personal"), ownerUserId: UserIdSchema }),
  strictObject({
    kind: Type.Literal("object"),
    objectKind: stringEnum(["workflow", "skill_draft"]),
    objectId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  strictObject({ kind: Type.Literal("workspace") }),
]);

export const MemorySubjectSchema = strictObject({
  kind: Type.String({ minLength: 1, maxLength: 64 }),
  subjectId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const MemoryEvidenceSchema = strictObject({
  kind: stringEnum(["canonical_object", "artifact", "citation", "validation"]),
  ref: Type.String({ minLength: 1, maxLength: 512 }),
  hash: Type.String({ minLength: 1, maxLength: 128 }),
});

export const MemorySourceSchema = strictObject({
  kind: stringEnum(["canonical_object", "agent", "worker", "external", "transcript"]),
  sourceId: Type.String({ minLength: 1, maxLength: 128 }),
  versionId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  verified: Type.Boolean(),
});

const MemoryCoreProperties = {
  workspaceId: WorkspaceIdSchema,
  scope: MemoryScopeSchema,
  subject: MemorySubjectSchema,
  statement: Type.String({ minLength: 1, maxLength: 20_000 }),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { uniqueItems: true, maxItems: 64 }),
  source: MemorySourceSchema,
  evidence: Type.Array(MemoryEvidenceSchema, { minItems: 1, maxItems: 64 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  sensitivity: stringEnum(["low", "moderate", "high"]),
  expiresAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  createdBy: Type.String({ minLength: 1, maxLength: 128 }),
  policyVersion: Type.String({ minLength: 1, maxLength: 64 }),
};

export const MemoryCandidateSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    candidateId: MemoryCandidateIdSchema,
    ...MemoryCoreProperties,
    submittedByKind: stringEnum(["agent", "worker", "user", "system"]),
    status: MemoryCandidateStatusSchema,
    createdAt: UtcTimestampSchema,
    decidedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "MemoryCandidate" },
);

export const DurableMemorySchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    memoryId: DurableMemoryIdSchema,
    candidateId: MemoryCandidateIdSchema,
    ...MemoryCoreProperties,
    status: Type.Literal("active"),
    promotedBy: Type.String({ minLength: 1, maxLength: 128 }),
    promotionMode: stringEnum(["manual", "policy"]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "DurableMemory" },
);

export const MemoryPromotionDecisionSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  candidateId: MemoryCandidateIdSchema,
  decision: stringEnum(["approved", "rejected"]),
  automatic: Type.Boolean(),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  decidedBy: Type.String({ minLength: 1, maxLength: 128 }),
  policyVersion: Type.String({ minLength: 1, maxLength: 64 }),
  decidedAt: UtcTimestampSchema,
});

export const MemoryQuerySchema = strictObject({
  workspaceId: WorkspaceIdSchema,
  scopes: Type.Array(MemoryScopeKindSchema, { minItems: 1, uniqueItems: true, maxItems: 3 }),
  subject: Type.Optional(MemorySubjectSchema),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { uniqueItems: true, maxItems: 64 }),
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
});

export const MemoryResultSchema = strictObject({
  memory: DurableMemorySchema,
  score: Type.Number({ minimum: 0 }),
  matchedBy: Type.Array(stringEnum(["text", "tag", "confidence", "recency"]), { uniqueItems: true }),
});

export const MemoryDeletionTombstoneSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  tombstoneId: MemoryTombstoneIdSchema,
  workspaceId: WorkspaceIdSchema,
  memoryIdHash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  scopeKind: MemoryScopeKindSchema,
  deletedBy: UserIdSchema,
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  policyVersion: Type.String({ minLength: 1, maxLength: 64 }),
  deletedAt: UtcTimestampSchema,
});

export const MemoryEventSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  memoryEventId: MemoryEventIdSchema,
  workspaceId: WorkspaceIdSchema,
  candidateId: Type.Union([MemoryCandidateIdSchema, Type.Null()]),
  memoryId: Type.Union([DurableMemoryIdSchema, Type.Null()]),
  type: stringEnum(["candidate.submitted", "candidate.approved", "candidate.rejected", "memory.deleted"]),
  actorId: Type.String({ minLength: 1, maxLength: 128 }),
  metadata: JsonObjectSchema,
  createdAt: UtcTimestampSchema,
});

export type MemoryCandidate = Static<typeof MemoryCandidateSchema>;
export type DurableMemory = Static<typeof DurableMemorySchema>;
export type MemoryPromotionDecision = Static<typeof MemoryPromotionDecisionSchema>;
export type MemoryQuery = Static<typeof MemoryQuerySchema>;
export type MemoryResult = Static<typeof MemoryResultSchema>;
export type MemoryDeletionTombstone = Static<typeof MemoryDeletionTombstoneSchema>;
