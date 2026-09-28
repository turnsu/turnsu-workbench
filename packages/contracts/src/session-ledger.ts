import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import {
  AgentBranchIdSchema,
  ArtifactIdSchema,
  AutomationIdSchema,
  ContentHashSchema,
  EventIdSchema,
  ExecutionAttemptIdSchema,
  InvocationIdSchema,
  ProductCommandIdSchema,
  RunIdSchema,
  ScopeIdSchema,
  SessionIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
  WorkItemIdSchema,
} from "./common.js";
import {
  AuthorizationSourceSchema,
  PrincipalRefSchema,
} from "./authority.js";
import { strictObject, stringEnum } from "./schema.js";

export const SESSION_KINDS = [
  "personal_task",
  "work_branch",
  "module_creation",
  "automation",
  "skill_creation",
  "worker",
] as const;

export const SESSION_PAYLOAD_CLASSES = [
  "private",
  "product_safe",
  "internal",
] as const;

export const SessionKindSchema = stringEnum(SESSION_KINDS);
export const SessionPayloadClassSchema = stringEnum(SESSION_PAYLOAD_CLASSES);

const ProductSafeNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_]*$",
});

/**
 * Opaque pointer to an immutable or append-only Product payload version. `id`
 * must not point at a mutable Turn or Run record whose content can change after
 * append. Session events never embed transcript, Worker output, Provider
 * payload, or arbitrary event data.
 */
export const PayloadRefSchema = strictObject(
  {
    id: StableIdSchema,
    kind: ProductSafeNameSchema,
    state: ProductSafeNameSchema,
    contentHash: ContentHashSchema,
  },
  { $id: "SessionPayloadRef" },
);

/**
 * A root branch is rooted by the containing event's sessionId and therefore
 * carries only its branchId. Forked branches identify the exact parent
 * position and governed Handoff Capsule used to continue; the referenced
 * transcript remains in its source Session.
 */
export const SessionBranchRefSchema = Type.Union(
  [
    strictObject({
      branchId: AgentBranchIdSchema,
    }),
    strictObject({
      branchId: AgentBranchIdSchema,
      rootSessionId: SessionIdSchema,
      parentSessionId: SessionIdSchema,
      forkedFromSequence: Type.Integer({ minimum: 1 }),
      handoffId: StableIdSchema,
    }),
  ],
  { $id: "SessionBranchRef" },
);

/**
 * Cross-domain identifiers only. Lifecycle state stays authoritative in the
 * corresponding Product Command, Run, Automation, or Execution ledger.
 */
export const SessionEventLineageSchema = strictObject(
  {
    workItemId: Type.Optional(WorkItemIdSchema),
    handoffId: Type.Optional(StableIdSchema),
    artifactId: Type.Optional(ArtifactIdSchema),
    automationId: Type.Optional(AutomationIdSchema),
    runId: Type.Optional(RunIdSchema),
    productCommandId: Type.Optional(ProductCommandIdSchema),
    turnId: Type.Optional(StableIdSchema),
    invocationId: Type.Optional(InvocationIdSchema),
    attemptId: Type.Optional(ExecutionAttemptIdSchema),
  },
  { $id: "SessionEventLineage", minProperties: 1 },
);

const SessionEventProperties = {
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  sessionKind: SessionKindSchema,
  sessionSequence: Type.Integer({ minimum: 1 }),
  scopeId: ScopeIdSchema,
  actor: PrincipalRefSchema,
  authorizer: AuthorizationSourceSchema,
  branch: Type.Optional(SessionBranchRefSchema),
  lineage: Type.Optional(SessionEventLineageSchema),
  payloadClass: SessionPayloadClassSchema,
  payloadRef: PayloadRefSchema,
  occurredAt: UtcTimestampSchema,
};

export const SessionEventSchema = strictObject(
  SessionEventProperties,
  { $id: "SessionEvent" },
);

/**
 * Cross-field validation that TypeBox cannot express: a fork must cite the
 * same governed Handoff Capsule in its branch provenance and event lineage.
 */
export function checkSessionEventSemantics(
  value: unknown,
): value is SessionEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as SessionEvent;
  if (!event.branch || !("parentSessionId" in event.branch)) return true;
  return event.lineage?.handoffId === event.branch.handoffId;
}

/**
 * Projection envelope for Session-domain replay and outbox consumers. `seq`
 * orders the whole Session ledger; `sessionSequence` orders one Session. It is
 * not a second authority over SessionEvent or any referenced domain object.
 */
export const SessionDomainEnvelopeSchema = strictObject(
  {
    domain: Type.Literal("session"),
    seq: Type.Integer({ minimum: 1 }),
    ...SessionEventProperties,
  },
  { $id: "SessionDomainEnvelope" },
);

/** Initial consumers use seq=0; committed Session-domain events start at 1. */
export const SessionWatermarkSchema = strictObject(
  {
    domain: Type.Literal("session"),
    scopeId: ScopeIdSchema,
    seq: Type.Integer({ minimum: 0 }),
  },
  { $id: "SessionWatermark" },
);

export type SessionKind = Static<typeof SessionKindSchema>;
export type SessionPayloadClass = Static<typeof SessionPayloadClassSchema>;
export type PayloadRef = Static<typeof PayloadRefSchema>;
export type SessionBranchRef = Static<typeof SessionBranchRefSchema>;
export type SessionEventLineage = Static<typeof SessionEventLineageSchema>;
export type SessionEvent = Static<typeof SessionEventSchema>;
export type SessionDomainEnvelope = Static<
  typeof SessionDomainEnvelopeSchema
>;
export type SessionWatermark = Static<typeof SessionWatermarkSchema>;
