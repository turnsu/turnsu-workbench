import { Type, type Static } from "typebox";

import {
  AgentSessionIdSchema,
  ArtifactIdSchema,
  ContentHashSchema,
  HandoffCapsuleIdSchema,
  ModelProfileIdSchema,
  ProjectIdSchema,
  ScopeIdSchema,
  StableIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  WorkItemAccessGrantIdSchema,
  WorkItemContinuationIdSchema,
  WorkItemDecisionIdSchema,
  WorkItemIdSchema,
  WorkThreadEntryIdSchema,
  WorkThreadIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { ArtifactMediaTypeSchema } from "./artifacts.js";
import { AgentMessageTurnInputSchema, AgentTurnSchema } from "./agents.js";
import { AuthUsernameSchema } from "./auth.js";
import { WorkspaceRoleSchema } from "./lifecycle.js";
import { strictObject, stringEnum } from "./schema.js";

export const WorkItemStatusSchema = stringEnum([
  "draft",
  "ready",
  "active",
  "waiting_review",
  "completed",
  "blocked",
  "cancelled",
]);

export const WorkItemPrioritySchema = stringEnum([
  "low",
  "medium",
  "high",
  "urgent",
]);

export const WorkItemMemberRoleSchema = stringEnum([
  "accountable_owner",
  "requestor",
  "assignee",
  "reviewer",
  "participant",
  "watcher",
]);

export const WorkItemAccessLevelSchema = stringEnum([
  "owner",
  "contribute",
  "read",
]);

export const ProjectStatusSchema = stringEnum([
  "active",
  "archived",
]);

export const ProjectMemberRoleSchema = stringEnum([
  "owner",
  "member",
]);

/**
 * A deliberately narrow, current-workspace-only directory for choosing an
 * explicit Work Item recipient. It is not a general people search and never
 * exposes invitation emails, external identities, account state, or private
 * session data.
 */
export const WorkItemPromotionParticipantSchema = strictObject({
  userId: UserIdSchema,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  username: AuthUsernameSchema,
  role: WorkspaceRoleSchema,
});

const SafeSummarySchema = Type.String({
  minLength: 1,
  maxLength: 8_000,
  pattern: "\\S",
});

const SafeTitleSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "\\S",
});

const SafeObjectiveSchema = Type.String({
  minLength: 1,
  maxLength: 2_000,
  pattern: "\\S",
});

export const WorkItemAffectedObjectRefSchema = strictObject({
  kind: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][a-z0-9_]*$",
  }),
  id: StableIdSchema,
});

export const WorkItemDecisionInputSchema = strictObject({
  question: Type.String({ minLength: 1, maxLength: 1_000, pattern: "\\S" }),
  options: Type.Array(
    Type.String({ minLength: 1, maxLength: 1_000, pattern: "\\S" }),
    { minItems: 1, maxItems: 16, uniqueItems: true },
  ),
  chosenOutcome: Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S" }),
  rationale: Type.Optional(Type.String({ maxLength: 4_000 })),
  evidenceRefs: Type.Optional(Type.Array(StableIdSchema, {
    maxItems: 32,
    uniqueItems: true,
  })),
  affectedObjects: Type.Optional(Type.Array(WorkItemAffectedObjectRefSchema, {
    maxItems: 64,
    uniqueItems: true,
  })),
});

export const WorkItemDecisionSchema = strictObject({
  decisionId: WorkItemDecisionIdSchema,
  workItemId: WorkItemIdSchema,
  question: Type.String({ minLength: 1, maxLength: 1_000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
  }),
  chosenOutcome: Type.String({ minLength: 1, maxLength: 2_000 }),
  rationale: Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()]),
  evidenceRefs: Type.Array(StableIdSchema, { maxItems: 32, uniqueItems: true }),
  affectedObjects: Type.Array(WorkItemAffectedObjectRefSchema, {
    maxItems: 64,
    uniqueItems: true,
  }),
  authorUserId: UserIdSchema,
  approverUserId: Type.Union([UserIdSchema, Type.Null()]),
  supersedesDecisionId: Type.Union([WorkItemDecisionIdSchema, Type.Null()]),
  createdAt: UtcTimestampSchema,
});

export const WorkItemArtifactRefSchema = strictObject({
  artifactId: ArtifactIdSchema,
  mediaType: ArtifactMediaTypeSchema,
  contentHash: ContentHashSchema,
  storageVersion: Type.String({ minLength: 1, maxLength: 512 }),
  publishedAt: UtcTimestampSchema,
});

export const WorkItemAccessGrantSchema = strictObject({
  grantId: WorkItemAccessGrantIdSchema,
  workItemId: WorkItemIdSchema,
  userId: UserIdSchema,
  access: WorkItemAccessLevelSchema,
  status: stringEnum(["active", "revoked"]),
  createdAt: UtcTimestampSchema,
  revokedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
});

export const WorkItemMemberSchema = strictObject({
  userId: UserIdSchema,
  roles: Type.Array(WorkItemMemberRoleSchema, {
    minItems: 1,
    maxItems: 6,
    uniqueItems: true,
  }),
  accessGrant: WorkItemAccessGrantSchema,
});

export const ProjectMemberSchema = strictObject({
  userId: UserIdSchema,
  role: ProjectMemberRoleSchema,
});

export const ProjectSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  projectId: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  scopeId: ScopeIdSchema,
  title: SafeTitleSchema,
  objective: SafeObjectiveSchema,
  status: ProjectStatusSchema,
  accountableOwnerUserId: UserIdSchema,
  members: Type.Array(ProjectMemberSchema, { minItems: 1, maxItems: 64 }),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  archivedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
});

export const HandoffCapsuleSchema = strictObject({
  handoffId: HandoffCapsuleIdSchema,
  workItemId: WorkItemIdSchema,
  summary: SafeSummarySchema,
  contentHash: ContentHashSchema,
  createdByUserId: UserIdSchema,
  createdAt: UtcTimestampSchema,
});

export const WorkThreadEntryKindSchema = stringEnum([
  "handoff",
  "decision",
  "artifact",
  "comment",
]);

export const WorkThreadFileReferenceSchema = strictObject({
  projectId: ProjectIdSchema,
  revisionId: StableIdSchema,
  path: Type.String({ minLength: 1, maxLength: 512 }),
  contentHash: ContentHashSchema,
  byteLength: Type.Integer({ minimum: 0, maximum: 8388608 }),
});

export const WorkThreadEntrySchema = strictObject({
  entryId: WorkThreadEntryIdSchema,
  fileReferences: Type.Optional(Type.Array(WorkThreadFileReferenceSchema, { maxItems: 4 })),
  workItemId: WorkItemIdSchema,
  workThreadId: WorkThreadIdSchema,
  sequence: Type.Integer({ minimum: 1 }),
  kind: WorkThreadEntryKindSchema,
  summary: SafeSummarySchema,
  handoffId: Type.Union([HandoffCapsuleIdSchema, Type.Null()]),
  decisionId: Type.Union([WorkItemDecisionIdSchema, Type.Null()]),
  artifactId: Type.Union([ArtifactIdSchema, Type.Null()]),
  contentHash: ContentHashSchema,
  createdByUserId: UserIdSchema,
  occurredAt: UtcTimestampSchema,
});

export const WorkItemSourceSchema = Type.Union([
  strictObject({ kind: Type.Literal("private_agent_task") }),
  strictObject({ kind: Type.Literal("team_work_item") }),
]);

export const WorkItemSchema = strictObject({
  schemaVersion: WorkbenchSchemaVersionSchema,
  workItemId: WorkItemIdSchema,
  workspaceId: WorkspaceIdSchema,
  projectId: Type.Union([ProjectIdSchema, Type.Null()]),
  title: SafeTitleSchema,
  objective: SafeObjectiveSchema,
  status: WorkItemStatusSchema,
  priority: WorkItemPrioritySchema,
  accountableOwnerUserId: UserIdSchema,
  requestorUserId: UserIdSchema,
  members: Type.Array(WorkItemMemberSchema, { minItems: 1, maxItems: 64 }),
  source: WorkItemSourceSchema,
  dueAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  workThreadId: WorkThreadIdSchema,
  authorizedBranchRefs: Type.Array(StableIdSchema, { maxItems: 64, uniqueItems: true }),
  linkedLoopRef: Type.Union([StableIdSchema, Type.Null()]),
  runRefs: Type.Array(StableIdSchema, { maxItems: 256, uniqueItems: true }),
  artifactRefs: Type.Array(WorkItemArtifactRefSchema, { maxItems: 256, uniqueItems: true }),
  decisionRefs: Type.Array(WorkItemDecisionIdSchema, { maxItems: 128, uniqueItems: true }),
  proposalRefs: Type.Array(StableIdSchema, { maxItems: 128, uniqueItems: true }),
  blockedReason: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]),
  nextAction: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]),
  createdByUserId: UserIdSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  completedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
});

export const SubmitWorkItemResultDataSchema = strictObject({
  entryId: WorkThreadEntryIdSchema, contentHash: ContentHashSchema, confirm: Type.Literal(true),
});
export const ReviewWorkItemResultDataSchema = strictObject({
  ...SubmitWorkItemResultDataSchema.properties,
  decision: stringEnum(["accept", "request_changes"]), feedback: Type.String({maxLength:8000}),
});
export const WorkItemResultReviewSchema = strictObject({
  decision: stringEnum(["accept", "request_changes"]), feedback: Type.String(),
  reviewerUserId: UserIdSchema, reviewedAt: UtcTimestampSchema,
});
export const WorkItemResultSubmissionSchema = strictObject({
  submissionId: StableIdSchema, entry: WorkThreadEntrySchema, submittedByUserId: UserIdSchema,
  submittedAt: UtcTimestampSchema, status: stringEnum(["pending", "accepted", "changes_requested"]),
  review: Type.Union([WorkItemResultReviewSchema, Type.Null()]),
});
export const WorkItemResultsSchema = strictObject({
  currentSubmission: Type.Union([WorkItemResultSubmissionSchema, Type.Null()]),
  history: Type.Array(WorkItemResultSubmissionSchema),
});

export const WorkItemDetailSchema = strictObject({
  resultReview: Type.Optional(WorkItemResultsSchema),
  workItem: WorkItemSchema,
  handoffCapsule: HandoffCapsuleSchema,
  decisions: Type.Array(WorkItemDecisionSchema, { maxItems: 128 }),
});

export const WorkItemShareInputSchema = strictObject({
  userId: UserIdSchema,
  access: Type.Optional(Type.Union([
    Type.Literal("contribute"),
    Type.Literal("read"),
  ])),
});

/**
 * A Work Thread comment is product-safe shared text, not a private Session
 * transcript or a Worker result. The server supplies author, sequence,
 * command lineage, and timestamp from the authenticated context.
 */
export const CreateWorkItemThreadCommentDataSchema = strictObject({
  content: SafeSummarySchema,
  fileRevisionIds: Type.Optional(Type.Array(StableIdSchema, { maxItems: 4, uniqueItems: true })),
  sourceWorkItemIds: Type.Optional(Type.Array(WorkItemIdSchema, { maxItems: 64, uniqueItems: true })),
});

export const ProjectMemberInputSchema = strictObject({
  userId: UserIdSchema,
});

export const CreateProjectDataSchema = strictObject({
  title: SafeTitleSchema,
  objective: SafeObjectiveSchema,
  members: Type.Optional(Type.Array(ProjectMemberInputSchema, {
    maxItems: 63,
    uniqueItems: true,
  })),
});

export const ReviseProjectMembersDataSchema = strictObject({
  members: Type.Array(ProjectMemberInputSchema, {
    maxItems: 63,
    uniqueItems: true,
  }),
});

export const TeamWorkItemMemberInputSchema = strictObject({
  userId: UserIdSchema,
  access: Type.Union([Type.Literal("contribute"), Type.Literal("read")]),
  roles: Type.Array(Type.Union([
    Type.Literal("assignee"),
    Type.Literal("reviewer"),
    Type.Literal("participant"),
    Type.Literal("watcher"),
  ]), { minItems: 1, maxItems: 4, uniqueItems: true }),
});

export const CreateTeamWorkItemDataSchema = strictObject({
  projectId: Type.Optional(Type.Union([ProjectIdSchema, Type.Null()])),
  title: SafeTitleSchema,
  objective: SafeObjectiveSchema,
  summary: SafeSummarySchema,
  priority: Type.Optional(WorkItemPrioritySchema),
  dueAt: Type.Optional(Type.Union([UtcTimestampSchema, Type.Null()])),
  members: Type.Optional(Type.Array(TeamWorkItemMemberInputSchema, {
    maxItems: 63,
    uniqueItems: true,
  })),
});

/**
 * The first Agent Turn for a new Team Work Item is part of the same accepted
 * Product Command.  It accepts only the same safe Work fields plus a pinned
 * chat model and a normal governed Turn input; it never carries a private
 * Session pointer or raw transcript.
 */
export const CreateTeamWorkItemAgentEntryDataSchema = strictObject({
  ...CreateTeamWorkItemDataSchema.properties,
  modelProfileId: ModelProfileIdSchema,
  initialTask: AgentMessageTurnInputSchema,
});

/**
 * The first Turn on a member's existing Work Item continuation is accepted
 * together with the continuation branch. The client supplies only a governed
 * chat input and model choice; the server derives the Work/Handoff lineage.
 */
export const CreateWorkItemContinuationAgentEntryDataSchema = strictObject({
  modelProfileId: ModelProfileIdSchema,
  initialTask: AgentMessageTurnInputSchema,
});

export const UpdateTeamWorkItemDataSchema = strictObject({
  // Assign an existing contributor without replacing membership or granting access.
  // Used alone or with nextAction; Product rejects other combined mutations.
  assigneeUserId: Type.Optional(UserIdSchema),
  status: Type.Optional(WorkItemStatusSchema),
  priority: Type.Optional(WorkItemPrioritySchema),
  accountableOwnerUserId: Type.Optional(UserIdSchema),
  dueAt: Type.Optional(Type.Union([UtcTimestampSchema, Type.Null()])),
  blockedReason: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S" }), Type.Null()])),
  nextAction: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2_000, pattern: "\\S" }), Type.Null()])),
  members: Type.Optional(Type.Array(TeamWorkItemMemberInputSchema, {
    maxItems: 63,
    uniqueItems: true,
  })),
});

export const PromoteAgentSessionToWorkItemDataSchema = strictObject({
  title: SafeTitleSchema,
  objective: SafeObjectiveSchema,
  summary: SafeSummarySchema,
  priority: Type.Optional(WorkItemPrioritySchema),
  participants: Type.Optional(Type.Array(WorkItemShareInputSchema, {
    maxItems: 7,
    uniqueItems: true,
  })),
  decisions: Type.Optional(Type.Array(WorkItemDecisionInputSchema, {
    maxItems: 32,
    uniqueItems: true,
  })),
  artifactIds: Type.Optional(Type.Array(ArtifactIdSchema, {
    maxItems: 64,
    uniqueItems: true,
  })),
});

export const WorkItemPromotionSchema = strictObject({
  workItem: WorkItemSchema,
  handoffCapsule: HandoffCapsuleSchema,
  decisions: Type.Array(WorkItemDecisionSchema, { maxItems: 32 }),
  initialThreadEntry: WorkThreadEntrySchema,
});

/**
 * A user-owned continuation is a dedicated Work Item branch record, not a
 * legacy Agent object branch. It points only to the receiving member's own
 * Main Session and the already shared Handoff Capsule.
 */
export const WorkItemContinuationSchema = strictObject({
  continuationId: WorkItemContinuationIdSchema,
  workItemId: WorkItemIdSchema,
  agentSessionId: AgentSessionIdSchema,
  handoffId: HandoffCapsuleIdSchema,
  createdAt: UtcTimestampSchema,
});

export const TeamWorkItemAgentEntrySchema = strictObject({
  workItem: WorkItemSchema,
  continuation: WorkItemContinuationSchema,
  turn: AgentTurnSchema,
});

export const WorkItemContinuationAgentEntrySchema = strictObject({
  continuation: WorkItemContinuationSchema,
  turn: AgentTurnSchema,
});

export type WorkItem = Static<typeof WorkItemSchema>;
export type Project = Static<typeof ProjectSchema>;
export type WorkItemDetail = Static<typeof WorkItemDetailSchema>;
export type WorkItemPromotion = Static<typeof WorkItemPromotionSchema>;
export type WorkItemAccessGrant = Static<typeof WorkItemAccessGrantSchema>;
export type WorkItemContinuation = Static<typeof WorkItemContinuationSchema>;
export type TeamWorkItemAgentEntry = Static<typeof TeamWorkItemAgentEntrySchema>;
export type WorkItemContinuationAgentEntry = Static<typeof WorkItemContinuationAgentEntrySchema>;

/** Versioned files are scoped to Project membership, never private Agent history. */
export const ProjectFileRevisionSchema = strictObject({
  deleted: Type.Boolean(),
  revisionId: Type.String({ minLength: 1, maxLength: 128 }),
  projectId: ProjectIdSchema,
  path: Type.String({ minLength: 1, maxLength: 512 }),
  baseRevisionId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  contentHash: ContentHashSchema,
  byteLength: Type.Integer({ minimum: 0, maximum: 8388608 }),
  mediaType: Type.String({ minLength: 3, maxLength: 200 }),
  outcome: stringEnum(['synced', 'conflict']),
  createdByUserId: UserIdSchema,
  createdAt: UtcTimestampSchema,
});
export const ProjectFileHeadSchema = strictObject({
  ...ProjectFileRevisionSchema.properties,
  headRevisionId: Type.String({ minLength: 1, maxLength: 128 }),
});
export const ProjectFileContentSchema = strictObject({
  ...ProjectFileRevisionSchema.properties,
  contentBase64: Type.String({ maxLength: 11184812 }),
});
export const CommitProjectFileDataSchema = strictObject({
  deleted: Type.Optional(Type.Boolean()),
  path: Type.String({ minLength: 1, maxLength: 512 }),
  baseRevisionId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  mediaType: Type.String({ minLength: 3, maxLength: 200 }),
  contentBase64: Type.String({ maxLength: 11184812 }),
  resolvesRevisionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16, uniqueItems: true })),
});
export const ProjectFileCommitSchema = strictObject({
  revision: ProjectFileRevisionSchema,
  headRevisionId: Type.String({ minLength: 1, maxLength: 128 }),
});
