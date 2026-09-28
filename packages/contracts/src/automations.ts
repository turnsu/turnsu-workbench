import { Type, type Static } from "typebox";

import {
  AutomationGrantIdSchema,
  AutomationIdSchema,
  AutomationOccurrenceIdSchema,
  ConnectionIdSchema,
  ContentHashSchema,
  LoopVersionIdSchema,
  ModelProfileRevisionIdSchema,
  PolicyRevisionIdSchema,
  ProductCommandIdSchema,
  ResourceIdSchema,
  RunIdSchema,
  ScopeIdSchema,
  SecretBindingIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  VersionSchema,
  WorkbenchSchemaVersionSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { WorkspaceFeatureDecisionSchema } from "./readiness.js";
import { strictObject, stringEnum } from "./schema.js";
import {
  EFFECT_CLASSES,
  EffectClassSchema,
  PermissionModeConfigSchema,
} from "./scopes.js";
import { WorkflowRunStatusSchema } from "./runs.js";

export const AUTOMATION_STATES = [
  "draft",
  "checking",
  "active",
  "paused",
  "blocked",
  "archived",
] as const;

export const AUTOMATION_GRANT_STATES = [
  "active",
  "revoked",
  "expired",
  "revalidation_required",
] as const;

export const AUTOMATION_OCCURRENCE_STATES = [
  "due",
  "accepted",
  "misfired",
  "skipped",
  "blocked",
] as const;

export const AutomationStateSchema = stringEnum(AUTOMATION_STATES);
export const AutomationGrantStateSchema = stringEnum(AUTOMATION_GRANT_STATES);
export const AutomationOccurrenceStateSchema = stringEnum(
  AUTOMATION_OCCURRENCE_STATES,
);

const ReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9_]*$",
});

const LocalScheduleDateSchema = Type.String({
  format: "date",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
});

export const AutomationOccurrenceDedupeKeySchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

/** V1 accepts one fixed local time per day: `minute hour * * *`. */
export const DailyCronExpressionSchema = Type.String({
  minLength: 9,
  maxLength: 13,
  pattern:
    "^(?:[0-9]|[0-5][0-9]) (?:[0-9]|[01][0-9]|2[0-3]) \\* \\* \\*$",
});

/** UTC and Area/Location names are admitted here; runtime checks the IANA registry. */
export const IanaTimezoneSchema = Type.Union([
  Type.Literal("UTC"),
  Type.String({
    minLength: 3,
    maxLength: 128,
    pattern: "^[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)+$",
  }),
]);

export const DailyCronTriggerSchema = strictObject(
  {
    kind: Type.Literal("daily_cron"),
    expression: DailyCronExpressionSchema,
    timezone: IanaTimezoneSchema,
  },
  { $id: "DailyCronTrigger" },
);

/**
 * The initial Automation schema consumes only immutable Workspace Resources.
 * Artifact inputs need their own durable authority and consumption path, so
 * they remain unavailable rather than being accepted by the public contract
 * and failing later in persistence.
 */
export const AutomationInputSourceSchema = strictObject(
  {
    kind: Type.Literal("resource"),
    resourceId: ResourceIdSchema,
    version: VersionSchema,
    contentHash: ContentHashSchema,
  },
  { $id: "AutomationInputSource" },
);

export const AutomationInputBindingSchema = strictObject(
  {
    bindingId: StableIdSchema,
    inputKey: StableIdSchema,
    source: AutomationInputSourceSchema,
  },
  { $id: "AutomationInputBinding" },
);

/** Product-safe binding metadata; secret locators and fingerprints are excluded. */
export const AutomationConnectionBindingSchema = strictObject(
  {
    requirementId: StableIdSchema,
    connectionId: ConnectionIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    secretBindingId: SecretBindingIdSchema,
    storeBindingRevision: Type.Integer({ minimum: 1 }),
  },
  { $id: "AutomationConnectionBinding" },
);

/**
 * A create/revise request selects a current Connection by requirement.  The
 * server resolves and pins its immutable revision and secret binding; clients
 * must never provide those internal values themselves.
 */
export const AutomationConnectionSelectionSchema = strictObject(
  {
    requirementId: StableIdSchema,
    connectionId: ConnectionIdSchema,
  },
  { $id: "AutomationConnectionSelection" },
);

/**
 * A safe, immutable input pin shown while creating an Automation.  The
 * caller may submit this exact pin, but cannot substitute a different
 * Resource or invent a hidden mapping.
 */
export const AutomationCandidateInputBindingSchema = strictObject(
  {
    bindingId: StableIdSchema,
    inputKey: StableIdSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    source: AutomationInputSourceSchema,
  },
  { $id: "AutomationCandidateInputBinding" },
);

/** Product-safe Connection requirements for one finalized Loop version. */
const ConnectionPermissionEffectSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9_.:-]*$",
});

export const AutomationConnectionRequirementSchema = strictObject(
  {
    requirementId: StableIdSchema,
    capabilityKey: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1, maxLength: 1000 }),
    // These are driver-level credential permissions such as `calendar.read`,
    // not the Product's broad permission-mode effect classes. The server
    // verifies them against the selected Connection revision before pinning.
    requiredEffects: Type.Array(ConnectionPermissionEffectSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    // The candidate deliberately gives the browser only Connection IDs that
    // are currently consumable in this scope for this exact requirement. A
    // caller must still select one explicitly; the server rechecks it in the
    // create/revise transaction.
    eligibleConnectionIds: Type.Array(ConnectionIdSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { $id: "AutomationConnectionRequirement" },
);

/**
 * A finalized Loop version the current owner may bind to an Automation.
 * It contains only product-safe labels and immutable dependency pins.
 */
export const AutomationCandidateSchema = strictObject(
  {
    loopVersionId: LoopVersionIdSchema,
    workflowId: StableIdSchema,
    scopeId: ScopeIdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 2000 }),
    version: VersionSchema,
    inputBindings: Type.Array(AutomationCandidateInputBindingSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    connectionRequirements: Type.Array(AutomationConnectionRequirementSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { $id: "AutomationCandidate" },
);

export const AutomationModelPolicySchema = strictObject(
  {
    policyRevisionId: PolicyRevisionIdSchema,
    modelProfileRevisionIds: Type.Array(ModelProfileRevisionIdSchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { $id: "AutomationModelPolicy" },
);

export const AutomationBudgetPolicySchema = strictObject(
  {
    maxCostUsdMicros: Type.Integer({
      minimum: 0,
      maximum: 1_000_000_000_000,
    }),
    maxRuntimeSeconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
  },
  { $id: "AutomationBudgetPolicy" },
);

export const AutomationApprovalPolicySchema = strictObject(
  {
    policyRevisionId: PolicyRevisionIdSchema,
    permissionMode: PermissionModeConfigSchema,
  },
  { $id: "AutomationApprovalPolicy" },
);

export const AutomationMisfirePolicySchema = Type.Union(
  [
    strictObject({
      kind: Type.Literal("skip"),
      maxLatenessSeconds: Type.Literal(0),
    }),
    strictObject({
      kind: Type.Literal("run_once"),
      maxLatenessSeconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
    }),
  ],
  { $id: "AutomationMisfirePolicy" },
);

export const AutomationDedupePolicySchema = strictObject(
  { kind: Type.Literal("scheduled_occurrence") },
  { $id: "AutomationDedupePolicy" },
);

/**
 * Execution resolves the Workflow revision from this immutable LoopVersion and
 * verifies loopContentHash before intake; no second Workflow pin is stored here.
 */
const immutableLoopPinFields = {
  loopVersionId: LoopVersionIdSchema,
  loopContentHash: ContentHashSchema,
};

export const DailyCronAutomationSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    variant: Type.Literal("daily_cron_v1"),
    automationId: AutomationIdSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: ScopeIdSchema,
    ownerId: UserIdSchema,
    /** Human-readable name selected by the Automation owner. */
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    ...immutableLoopPinFields,
    triggerRevision: Type.Integer({ minimum: 1 }),
    trigger: DailyCronTriggerSchema,
    inputBindings: Type.Array(AutomationInputBindingSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    connectionBindings: Type.Array(AutomationConnectionBindingSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    executionLocationPolicy: Type.Literal("cloud"),
    modelPolicy: AutomationModelPolicySchema,
    budgetPolicy: AutomationBudgetPolicySchema,
    approvalPolicy: AutomationApprovalPolicySchema,
    misfirePolicy: AutomationMisfirePolicySchema,
    dedupePolicy: AutomationDedupePolicySchema,
    grantId: AutomationGrantIdSchema,
    grantRevision: Type.Integer({ minimum: 1 }),
    /** Owner-visible expiry for the currently pinned Automation Grant. */
    grantExpiresAt: UtcTimestampSchema,
    /** Optional owner-visible review deadline for the current Grant. */
    grantReviewAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    status: AutomationStateSchema,
    blockedReasonCode: Type.Union([ReasonCodeSchema, Type.Null()]),
    nextRunAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    lastRunAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    lastOutcome: Type.Union([
      stringEnum([
        "completed",
        "failed",
        "cancelled",
        "blocked",
        "partial",
        "effect_outcome_unknown",
      ]),
      Type.Null(),
    ]),
    failureStreak: Type.Integer({ minimum: 0 }),
    revision: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "DailyCronAutomation" },
);

/** Discriminated by trigger.kind; V1 intentionally contains only Daily Cron. */
export const AutomationSchema = Type.Union([DailyCronAutomationSchema], {
  $id: "Automation",
});

export const AutomationGrantSchema = strictObject(
  {
    grantId: AutomationGrantIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    automationId: AutomationIdSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: ScopeIdSchema,
    ownerId: UserIdSchema,
    ...immutableLoopPinFields,
    policyRevisionId: PolicyRevisionIdSchema,
    allowedConnectionIds: Type.Array(ConnectionIdSchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    allowedEffectClasses: Type.Array(EffectClassSchema, {
      minItems: 1,
      maxItems: EFFECT_CLASSES.length,
      uniqueItems: true,
    }),
    budgetPolicy: AutomationBudgetPolicySchema,
    status: AutomationGrantStateSchema,
    authorizedByPrincipalId: StableIdSchema,
    expiresAt: UtcTimestampSchema,
    reviewAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "AutomationGrant" },
);

/** The only V1 inputs used to derive an occurrence dedupe key. */
export const AutomationOccurrenceDedupeInputSchema = strictObject(
  {
    automationId: AutomationIdSchema,
    triggerRevision: Type.Integer({ minimum: 1 }),
    localScheduleDate: LocalScheduleDateSchema,
  },
  { $id: "AutomationOccurrenceDedupeInput" },
);

const occurrenceFields = {
  occurrenceId: AutomationOccurrenceIdSchema,
  automationId: AutomationIdSchema,
  /** Present only after the occurrence was accepted into a Workflow Run. */
  workflowId: Type.Union([StableIdSchema, Type.Null()]),
  triggerRevision: Type.Integer({ minimum: 1 }),
  scheduledFor: UtcTimestampSchema,
  localScheduleDate: LocalScheduleDateSchema,
  dedupeKey: AutomationOccurrenceDedupeKeySchema,
  /**
   * The current Workflow Run state for an accepted occurrence.  This is a
   * read projection only: clients still use the Run and Inbox command APIs
   * for any state transition.
   */
  runStatus: Type.Union([WorkflowRunStatusSchema, Type.Null()]),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
};

export const AutomationOccurrenceSchema = Type.Union(
  [
    strictObject({
      ...occurrenceFields,
      status: Type.Literal("due"),
      commandId: Type.Null(),
      runId: Type.Null(),
      reasonCode: Type.Null(),
    }),
    strictObject({
      ...occurrenceFields,
      status: Type.Literal("accepted"),
      commandId: ProductCommandIdSchema,
      runId: RunIdSchema,
      reasonCode: Type.Null(),
    }),
    strictObject({
      ...occurrenceFields,
      status: Type.Literal("misfired"),
      commandId: Type.Null(),
      runId: Type.Null(),
      reasonCode: ReasonCodeSchema,
    }),
    strictObject({
      ...occurrenceFields,
      status: Type.Literal("skipped"),
      commandId: Type.Null(),
      runId: Type.Null(),
      reasonCode: ReasonCodeSchema,
    }),
    strictObject({
      ...occurrenceFields,
      status: Type.Literal("blocked"),
      commandId: Type.Null(),
      runId: Type.Null(),
      reasonCode: ReasonCodeSchema,
    }),
  ],
  { $id: "AutomationOccurrence" },
);

export const AutomationReadinessSchema = strictObject(
  {
    automationId: AutomationIdSchema,
    decision: WorkspaceFeatureDecisionSchema,
    evaluatedAt: UtcTimestampSchema,
  },
  { $id: "AutomationReadiness" },
);

export type DailyCronTrigger = Static<typeof DailyCronTriggerSchema>;
export type AutomationInputSource = Static<
  typeof AutomationInputSourceSchema
>;
export type AutomationInputBinding = Static<
  typeof AutomationInputBindingSchema
>;
export type AutomationConnectionBinding = Static<
  typeof AutomationConnectionBindingSchema
>;
export type AutomationConnectionSelection = Static<
  typeof AutomationConnectionSelectionSchema
>;
export type AutomationCandidateInputBinding = Static<
  typeof AutomationCandidateInputBindingSchema
>;
export type AutomationConnectionRequirement = Static<
  typeof AutomationConnectionRequirementSchema
>;
export type AutomationCandidate = Static<typeof AutomationCandidateSchema>;
export type AutomationModelPolicy = Static<typeof AutomationModelPolicySchema>;
export type AutomationBudgetPolicy = Static<
  typeof AutomationBudgetPolicySchema
>;
export type AutomationApprovalPolicy = Static<
  typeof AutomationApprovalPolicySchema
>;
export type AutomationMisfirePolicy = Static<
  typeof AutomationMisfirePolicySchema
>;
export type AutomationDedupePolicy = Static<
  typeof AutomationDedupePolicySchema
>;
export type DailyCronAutomation = Static<typeof DailyCronAutomationSchema>;
export type Automation = Static<typeof AutomationSchema>;
export type AutomationGrant = Static<typeof AutomationGrantSchema>;
export type AutomationOccurrenceDedupeInput = Static<
  typeof AutomationOccurrenceDedupeInputSchema
>;
export type AutomationOccurrence = Static<typeof AutomationOccurrenceSchema>;
export type AutomationReadiness = Static<typeof AutomationReadinessSchema>;
