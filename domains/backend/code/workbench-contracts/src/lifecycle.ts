import { Type, type Static } from "typebox";

import {
  AuditEventIdSchema,
  CheckpointIdSchema,
  ConnectionIdSchema,
  ContentHashSchema,
  DataSchemaSchema,
  DiagnosticSchema,
  InstallationIdSchema,
  JsonObjectSchema,
  LoopVersionIdSchema,
  MembershipIdSchema,
  ObjectIdSchema,
  ProposalIdSchema,
  ReleaseIdSchema,
  ResourceIdSchema,
  RunAttemptIdSchema,
  RunCommandIdSchema,
  RunIdSchema,
  RunJobIdSchema,
  SessionIdSchema,
  SkillDraftIdSchema,
  SkillIdSchema,
  SkillVersionIdSchema,
  UploadIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  VersionSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { PinnedSkillRefSchema, SkillDependencySchema, SkillExecutionRefSchema, SkillRiskSchema } from "./skills.js";
import { strictObject, stringEnum } from "./schema.js";
import {
  BuilderOperationSchema,
  InputFormSchema,
  OutputDefinitionSchema,
  RunSettingsSchema,
  WorkflowDefinitionSchema,
  WorkflowGraphSchema,
} from "./workflows.js";

export const WorkspaceRoleSchema = stringEnum([
  "owner",
  "maintainer",
  "member",
  "viewer",
]);

export const AssetVisibilitySchema = stringEnum(["private", "workspace"]);
export const AssetLifecycleSchema = stringEnum([
  "draft",
  "ready",
  "shared",
  "blocked",
  "deprecated",
]);

export const ProductUserSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    userId: UserIdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "ProductUser" },
);

export const ProductWorkspaceSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    workspaceId: WorkspaceIdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    createdBy: UserIdSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "ProductWorkspace" },
);

export const WorkspaceMembershipSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    membershipId: MembershipIdSchema,
    workspaceId: WorkspaceIdSchema,
    userId: UserIdSchema,
    role: WorkspaceRoleSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkspaceMembership" },
);

export const ProductSessionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    sessionId: SessionIdSchema,
    userId: UserIdSchema,
    activeWorkspaceId: WorkspaceIdSchema,
    expiresAt: UtcTimestampSchema,
  },
  { $id: "ProductSession" },
);

export const SkillDraftFileSchema = strictObject({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  objectId: ObjectIdSchema,
  contentHash: ContentHashSchema,
  mediaType: Type.String({ minLength: 1, maxLength: 128 }),
  sizeBytes: Type.Integer({ minimum: 0, maximum: 1073741824 }),
});

export const ConnectionRequirementSchema = strictObject(
  {
    requirementId: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    required: Type.Boolean(),
    permissionSummary: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { $id: "ConnectionRequirement" },
);

export const SkillDraftSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillDraftId: SkillDraftIdSchema,
    skillId: SkillIdSchema,
    workspaceId: WorkspaceIdSchema,
    baseVersionId: Type.Union([SkillVersionIdSchema, Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    inputSchema: DataSchemaSchema,
    outputSchema: DataSchemaSchema,
    risk: SkillRiskSchema,
    dependencies: Type.Array(SkillDependencySchema),
    connectionRequirements: Type.Array(ConnectionRequirementSchema),
    files: Type.Array(SkillDraftFileSchema),
    executionRef: Type.Optional(SkillExecutionRefSchema),
    updatedBy: UserIdSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "SkillDraft" },
);

export const SkillValidationStatusSchema = stringEnum([
  "not_started",
  "running",
  "passed",
  "failed",
  "blocked",
]);

export const SkillTestRunIdSchema = Type.String({
  title: "Skill test run identifier",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const SkillValidationIdSchema = Type.String({
  title: "Skill validation identifier",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const SkillValidationEvidenceSchema = strictObject({
  validationId: Type.String({ minLength: 1, maxLength: 128 }),
  status: SkillValidationStatusSchema,
  diagnostics: Type.Array(DiagnosticSchema),
  testedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  contentHash: Type.Optional(ContentHashSchema),
  testRunIds: Type.Optional(
    Type.Array(SkillTestRunIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
  ),
});

export const SkillTestCaseSchema = strictObject(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    purpose: Type.String({ minLength: 1, maxLength: 2000 }),
    input: JsonObjectSchema,
    expectedOutput: Type.Optional(JsonObjectSchema),
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 120 }),
  },
  { $id: "SkillTestCase" },
);

export const SkillTestRunStatusSchema = stringEnum([
  "queued",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);

export const SkillTestRunSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    testRunId: SkillTestRunIdSchema,
    workspaceId: WorkspaceIdSchema,
    skillId: SkillIdSchema,
    skillDraftId: SkillDraftIdSchema,
    packageHash: ContentHashSchema,
    contentHash: ContentHashSchema,
    testCase: SkillTestCaseSchema,
    status: SkillTestRunStatusSchema,
    diagnostics: Type.Array(DiagnosticSchema),
    outputPreview: Type.Union([JsonObjectSchema, Type.Null()]),
    startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    completedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "SkillTestRun" },
);

export const SkillTestRunPublicSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    testRunId: SkillTestRunIdSchema,
    skillId: SkillIdSchema,
    skillDraftId: SkillDraftIdSchema,
    testCase: SkillTestCaseSchema,
    status: SkillTestRunStatusSchema,
    diagnostics: Type.Array(DiagnosticSchema),
    outputPreview: Type.Union([JsonObjectSchema, Type.Null()]),
    startedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    completedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "SkillTestRunPublic" },
);

export const SkillValidationRecordStatusSchema = stringEnum([
  "queued",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);

export const SkillPublicRuntimeSummarySchema = strictObject(
  {
    runtimeLabel: Type.String({ minLength: 1, maxLength: 100 }),
    permissionSummary: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { $id: "SkillPublicRuntimeSummary" },
);

export const SkillValidationRecordSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    validationId: SkillValidationIdSchema,
    workspaceId: WorkspaceIdSchema,
    skillId: SkillIdSchema,
    skillDraftId: SkillDraftIdSchema,
    draftRevision: Type.Integer({ minimum: 1 }),
    contentHash: ContentHashSchema,
    testRunIds: Type.Array(SkillTestRunIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    permissionAcknowledged: Type.Literal(true),
    status: SkillValidationRecordStatusSchema,
    diagnostics: Type.Array(DiagnosticSchema),
    runtimeSummary: SkillPublicRuntimeSummarySchema,
    createdAt: UtcTimestampSchema,
    completedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "SkillValidationRecord" },
);

export const SkillValidationRecordPublicSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    validationId: SkillValidationIdSchema,
    skillId: SkillIdSchema,
    skillDraftId: SkillDraftIdSchema,
    draftRevision: Type.Integer({ minimum: 1 }),
    testRunIds: Type.Array(SkillTestRunIdSchema, { minItems: 1, uniqueItems: true }),
    permissionAcknowledged: Type.Literal(true),
    status: SkillValidationRecordStatusSchema,
    diagnostics: Type.Array(DiagnosticSchema),
    runtimeSummary: SkillPublicRuntimeSummarySchema,
    createdAt: UtcTimestampSchema,
    completedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "SkillValidationRecordPublic" },
);

export const SkillVersionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillVersionId: SkillVersionIdSchema,
    skillId: SkillIdSchema,
    workspaceId: WorkspaceIdSchema,
    version: VersionSchema,
    packageObjectId: ObjectIdSchema,
    packageHash: ContentHashSchema,
    contentHash: ContentHashSchema,
    manifest: JsonObjectSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    inputSchema: DataSchemaSchema,
    outputSchema: DataSchemaSchema,
    risk: SkillRiskSchema,
    dependencies: Type.Array(SkillDependencySchema),
    connectionRequirements: Type.Array(ConnectionRequirementSchema),
    validation: SkillValidationEvidenceSchema,
    executionRef: SkillExecutionRefSchema,
    publishedBy: UserIdSchema,
    publishedAt: UtcTimestampSchema,
  },
  { $id: "SkillVersion" },
);

export const SkillVersionSummarySchema = strictObject(
  {
    skillVersionId: SkillVersionIdSchema,
    skillId: SkillIdSchema,
    version: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    validation: strictObject({
      status: SkillValidationStatusSchema,
      testedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    }),
    publishedBy: UserIdSchema,
    publishedAt: UtcTimestampSchema,
  },
  { $id: "SkillVersionSummary" },
);

export const SkillRetirementSchema = strictObject(
  {
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    retiredAt: UtcTimestampSchema,
    retiredBy: UserIdSchema,
  },
  { $id: "SkillRetirement" },
);

export const SkillRetirementPublicSchema = strictObject({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  retiredAt: UtcTimestampSchema,
});

export const SkillSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillId: SkillIdSchema,
    workspaceId: WorkspaceIdSchema,
    ownerId: UserIdSchema,
    visibility: AssetVisibilitySchema,
    lifecycle: AssetLifecycleSchema,
    retirement: Type.Optional(SkillRetirementSchema),
    currentDraftId: Type.Union([SkillDraftIdSchema, Type.Null()]),
    latestPublishedVersionId: Type.Union([SkillVersionIdSchema, Type.Null()]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "Skill" },
);

export const SkillAssetRecordSummarySchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillId: SkillIdSchema,
    visibility: AssetVisibilitySchema,
    lifecycle: AssetLifecycleSchema,
    retirement: Type.Optional(SkillRetirementPublicSchema),
    currentDraftId: Type.Union([SkillDraftIdSchema, Type.Null()]),
    latestPublishedVersionId: Type.Union([SkillVersionIdSchema, Type.Null()]),
    allowedActions: Type.Array(
      stringEnum(["edit", "publish", "create_version", "retire"]),
      { maxItems: 4, uniqueItems: true },
    ),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "SkillAssetRecordSummary" },
);

export const SkillDraftSummarySchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillDraftId: SkillDraftIdSchema,
    skillId: SkillIdSchema,
    baseVersionId: Type.Union([SkillVersionIdSchema, Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    inputSchema: DataSchemaSchema,
    outputSchema: DataSchemaSchema,
    risk: SkillRiskSchema,
    dependencies: Type.Array(SkillDependencySchema),
    connectionRequirements: Type.Array(ConnectionRequirementSchema),
    fileCount: Type.Integer({ minimum: 0 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "SkillDraftSummary" },
);

export const SkillDraftPackageFileSchema = strictObject(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    kind: stringEnum(["instructions", "runtime_manifest", "executable"]),
    sizeBytes: Type.Integer({ minimum: 0, maximum: 1048576 }),
    content: Type.String({ maxLength: 1048576 }),
  },
  { $id: "SkillDraftPackageFile" },
);

export const SkillDraftPackageSchema = strictObject(
  {
    skillId: SkillIdSchema,
    skillDraftId: SkillDraftIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    files: Type.Array(SkillDraftPackageFileSchema, { minItems: 2, maxItems: 3, uniqueItems: true }),
  },
  { $id: "SkillDraftPackage" },
);

export const SkillPublishedVersionSummarySchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    skillVersionId: SkillVersionIdSchema,
    skillId: SkillIdSchema,
    version: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    inputSchema: DataSchemaSchema,
    outputSchema: DataSchemaSchema,
    risk: SkillRiskSchema,
    dependencies: Type.Array(SkillDependencySchema),
    connectionRequirements: Type.Array(ConnectionRequirementSchema),
    validation: strictObject({
      status: SkillValidationStatusSchema,
      testedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    }),
    publishedAt: UtcTimestampSchema,
  },
  { $id: "SkillPublishedVersionSummary" },
);

export const SkillVersionListItemPublicSchema = strictObject(
  {
    skillVersionId: SkillVersionIdSchema,
    skillId: SkillIdSchema,
    version: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    category: Type.String({ minLength: 1, maxLength: 100 }),
    validation: strictObject({
      status: SkillValidationStatusSchema,
      testedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    }),
    publishedAt: UtcTimestampSchema,
  },
  { $id: "SkillVersionListItemPublic" },
);

export const SkillAssetSummarySchema = strictObject(
  {
    skill: SkillAssetRecordSummarySchema,
    draft: Type.Union([SkillDraftSummarySchema, Type.Null()]),
    latestVersion: Type.Union([SkillPublishedVersionSummarySchema, Type.Null()]),
  },
  { $id: "SkillAssetSummary" },
);

export const SkillUsageWorkflowSchema = strictObject({
  workflowId: WorkflowIdSchema,
  revisionId: WorkflowRevisionIdSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  visibility: AssetVisibilitySchema,
  state: Type.String({ minLength: 1, maxLength: 64 }),
});

export const SkillUsageImpactSchema = strictObject(
  {
    skillId: SkillIdSchema,
    latestVersionId: Type.Union([SkillVersionIdSchema, Type.Null()]),
    latestVersion: Type.Union([VersionSchema, Type.Null()]),
    affectedWorkflows: Type.Array(SkillUsageWorkflowSchema),
  },
  { $id: "SkillUsageImpact" },
);

export const SkillVersionDiffEntrySchema = strictObject({
  field: Type.String({ minLength: 1, maxLength: 64 }),
  changed: Type.Boolean(),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  severity: stringEnum(["info", "warning"]),
});

export const SkillVersionDiffSchema = strictObject(
  {
    skillId: SkillIdSchema,
    fromVersionId: SkillVersionIdSchema,
    fromVersion: VersionSchema,
    toVersionId: SkillVersionIdSchema,
    toVersion: VersionSchema,
    entries: Type.Array(SkillVersionDiffEntrySchema, { minItems: 1 }),
  },
  { $id: "SkillVersionDiff" },
);

export const LoopSkillUpdateVersionSchema = strictObject(
  {
    skillVersionId: SkillVersionIdSchema,
    version: VersionSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    risk: SkillRiskSchema,
    connectionRequirements: Type.Array(ConnectionRequirementSchema),
  },
  { $id: "LoopSkillUpdateVersion" },
);

export const LoopSkillUpdateAffectedNodeSchema = strictObject(
  {
    nodeId: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { $id: "LoopSkillUpdateAffectedNode" },
);

export const LoopSkillUpdatePreviewSchema = strictObject(
  {
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    workflowName: Type.String({ minLength: 1, maxLength: 200 }),
    skillId: SkillIdSchema,
    currentVersion: LoopSkillUpdateVersionSchema,
    targetVersion: LoopSkillUpdateVersionSchema,
    affectedNodes: Type.Array(LoopSkillUpdateAffectedNodeSchema, { minItems: 1 }),
    changes: Type.Array(SkillVersionDiffEntrySchema, { minItems: 1 }),
    requiresTestRun: Type.Literal(true),
  },
  { $id: "LoopSkillUpdatePreview" },
);

export const LoopDefinitionSchema = WorkflowDefinitionSchema;

export const LoopVersionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    loopVersionId: LoopVersionIdSchema,
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    workspaceId: WorkspaceIdSchema,
    version: VersionSchema,
    definition: LoopDefinitionSchema,
    pinnedSkills: Type.Array(PinnedSkillRefSchema),
    contentHash: ContentHashSchema,
    releasedBy: UserIdSchema,
    releasedAt: UtcTimestampSchema,
  },
  { $id: "LoopVersion" },
);

export const WorkspaceAssetKindSchema = stringEnum(["skill", "loop"]);
export const UploadAssetKindSchema = Type.Union(
  [Type.Literal("skill"), Type.Literal("loop")],
  { default: "skill" },
);

export const WorkspaceAssetReleaseSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    releaseId: ReleaseIdSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    assetKind: WorkspaceAssetKindSchema,
    assetId: Type.String({ minLength: 1, maxLength: 128 }),
    versionId: Type.Union([SkillVersionIdSchema, LoopVersionIdSchema]),
    version: Type.Optional(VersionSchema),
    contentHash: ContentHashSchema,
    visibility: AssetVisibilitySchema,
    startingPoint: Type.Boolean(),
    releaseNotes: Type.String({ maxLength: 4000 }),
    dependencies: Type.Array(SkillDependencySchema),
    publishedBy: UserIdSchema,
    publishedAt: UtcTimestampSchema,
  },
  { $id: "WorkspaceAssetRelease" },
);

export const AssetInstallationStateSchema = stringEnum([
  "installed",
  "update_available",
  "update_draft_created",
  "removed",
]);

export const AssetInstallationSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    installationId: InstallationIdSchema,
    workspaceId: WorkspaceIdSchema,
    releaseId: ReleaseIdSchema,
    assetKind: WorkspaceAssetKindSchema,
    upstreamAssetId: Type.String({ minLength: 1, maxLength: 128 }),
    pinnedVersionId: Type.Union([SkillVersionIdSchema, LoopVersionIdSchema]),
    state: AssetInstallationStateSchema,
    installedBy: UserIdSchema,
    installedAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "AssetInstallation" },
);

export const UploadStateSchema = stringEnum([
  "selecting",
  "uploading",
  "quarantined",
  "scanning",
  "parsing",
  "needs_decision",
  "ready_draft",
  "failed",
  "promoted",
]);

export const ScanFindingSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  severity: stringEnum(["info", "warning", "error"]),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

export const SkillPackageInventoryKindSchema = stringEnum([
  "instructions",
  "executable",
  "runtime_manifest",
  "reference",
  "asset",
  "agent_metadata",
  "other",
]);

export const SkillRuntimeManifestPreviewSchema = strictObject({
  runtime: Type.Literal("python3.12"),
  entrypoint: Type.Literal("scripts/main.py"),
  protocol: strictObject({
    stdin: Type.Literal("json"),
    stdout: Type.Literal("json"),
  }),
  permissions: strictObject({
    network: Type.Literal(false),
    connections: Type.Tuple([]),
    externalActions: Type.Literal(false),
    filesystem: Type.Literal("scratch-only"),
  }),
});

export const SkillPackageInventoryEntrySchema = strictObject({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  sizeBytes: Type.Integer({ minimum: 0, maximum: 1073741824 }),
  kind: SkillPackageInventoryKindSchema,
});

export const SkillPackageManifestPreviewSchema = strictObject({
  name: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  description: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
  compatibility: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
  disableModelInvocation: Type.Boolean(),
  runtime: Type.Optional(SkillRuntimeManifestPreviewSchema),
});

export const SkillPackageInspectionSchema = strictObject({
  status: stringEnum(["passed", "needs_review", "failed"]),
  contentHash: ContentHashSchema,
  manifest: Type.Union([SkillPackageManifestPreviewSchema, Type.Null()]),
  inventory: Type.Array(SkillPackageInventoryEntrySchema),
  diagnostics: Type.Array(ScanFindingSchema),
});

export const SkillPackageInspectionPublicSchema = strictObject({
  status: stringEnum(["passed", "needs_review", "failed"]),
  manifest: Type.Union([SkillPackageManifestPreviewSchema, Type.Null()]),
  inventory: Type.Array(SkillPackageInventoryEntrySchema),
  diagnostics: Type.Array(ScanFindingSchema),
});

export const UploadTransferPublicSchema = strictObject({
  chunkSizeBytes: Type.Integer({ minimum: 0, maximum: 1048576 }),
  totalChunks: Type.Integer({ minimum: 0, maximum: 256 }),
  receivedChunks: Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { uniqueItems: true }),
  receivedBytes: Type.Integer({ minimum: 0, maximum: 12582912 }),
  complete: Type.Boolean(),
});

export const UploadSessionPublicSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    uploadId: UploadIdSchema,
    assetKind: Type.Optional(UploadAssetKindSchema),
    state: UploadStateSchema,
    filename: Type.String({ minLength: 1, maxLength: 512 }),
    sizeBytes: Type.Integer({ minimum: 0, maximum: 12582912 }),
    mediaType: Type.String({ minLength: 1, maxLength: 128 }),
    ingestMethod: stringEnum(["files", "resumable", "repository"]),
    transfer: UploadTransferPublicSchema,
    findings: Type.Array(ScanFindingSchema),
    inspection: Type.Optional(SkillPackageInspectionPublicSchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "UploadSessionPublic" },
);

export const SkillPublishReleasePublicSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    releaseId: ReleaseIdSchema,
    assetKind: Type.Literal("skill"),
    assetId: SkillIdSchema,
    versionId: SkillVersionIdSchema,
    version: Type.Optional(VersionSchema),
    visibility: AssetVisibilitySchema,
    startingPoint: Type.Boolean(),
    releaseNotes: Type.String({ maxLength: 4000 }),
    dependencies: Type.Array(SkillDependencySchema),
    publishedAt: UtcTimestampSchema,
  },
  { $id: "SkillPublishReleasePublic" },
);

export const UploadSessionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    uploadId: UploadIdSchema,
    assetKind: Type.Optional(UploadAssetKindSchema),
    workspaceId: WorkspaceIdSchema,
    requestedBy: UserIdSchema,
    state: UploadStateSchema,
    objectId: Type.Union([ObjectIdSchema, Type.Null()]),
    filename: Type.String({ minLength: 1, maxLength: 512 }),
    sizeBytes: Type.Integer({ minimum: 0, maximum: 1073741824 }),
    mediaType: Type.String({ minLength: 1, maxLength: 128 }),
    findings: Type.Array(ScanFindingSchema),
    inspection: Type.Optional(SkillPackageInspectionSchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "UploadSession" },
);

export const ProductObjectSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    objectId: ObjectIdSchema,
    workspaceId: WorkspaceIdSchema,
    contentHash: ContentHashSchema,
    sizeBytes: Type.Integer({ minimum: 0, maximum: 1073741824 }),
    mediaType: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: UtcTimestampSchema,
  },
  { $id: "ProductObject" },
);

export const WorkspaceResourceSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    resourceId: ResourceIdSchema,
    workspaceId: WorkspaceIdSchema,
    version: VersionSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    mediaType: Type.String({ minLength: 1, maxLength: 128 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    contentHash: ContentHashSchema,
    readiness: strictObject({ status: Type.Literal("ready") }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkspaceResource" },
);

export const WorkspaceConnectionSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    connectionId: ConnectionIdSchema,
    workspaceId: WorkspaceIdSchema,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    status: stringEnum(["connected", "needs_setup", "disabled"]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkspaceConnection" },
);

export const LifecycleBuilderOperationSchema = Type.Union([
  BuilderOperationSchema,
  strictObject({ op: Type.Literal("updateDefinition"), definition: LoopDefinitionSchema }),
  strictObject({ op: Type.Literal("pinSkillVersion"), skill: PinnedSkillRefSchema }),
  strictObject({ op: Type.Literal("unpinSkillVersion"), skillId: SkillIdSchema }),
]);

export const LifecycleBuilderProposalSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    proposalId: ProposalIdSchema,
    workspaceId: WorkspaceIdSchema,
    workflowId: WorkflowIdSchema,
    baseRevisionId: WorkflowRevisionIdSchema,
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    operations: Type.Array(LifecycleBuilderOperationSchema),
    diagnostics: Type.Array(DiagnosticSchema),
    permissionImpact: Type.Array(ConnectionRequirementSchema),
    status: stringEnum(["proposed", "applied", "dismissed", "conflicted", "invalid"]),
    createdBy: UserIdSchema,
    createdAt: UtcTimestampSchema,
    decidedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
  },
  { $id: "LifecycleBuilderProposal" },
);

export const RunExecutionSnapshotSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    runId: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    workflowId: WorkflowIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    loopVersionId: Type.Union([LoopVersionIdSchema, Type.Null()]),
    graph: WorkflowGraphSchema,
    inputForm: InputFormSchema,
    outputDefinition: OutputDefinitionSchema,
    runSettings: RunSettingsSchema,
    planHash: ContentHashSchema,
    skillVersions: Type.Array(SkillVersionSchema),
    resourceObjectIds: Type.Array(ObjectIdSchema),
    connectionIds: Type.Array(ConnectionIdSchema),
    createdAt: UtcTimestampSchema,
  },
  { $id: "RunExecutionSnapshot" },
);

export const RunJobSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    runJobId: RunJobIdSchema,
    runId: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    status: stringEnum(["queued", "leased", "running", "paused", "completed", "failed", "cancelled"]),
    fence: Type.Integer({ minimum: 0 }),
    checkpointSequence: Type.Integer({ minimum: 0 }),
    leaseOwner: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    leaseExpiresAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    heartbeatAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    queuedAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "RunJob" },
);

export const RunLeaseSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    runId: RunIdSchema,
    runJobId: RunJobIdSchema,
    workspaceId: WorkspaceIdSchema,
    workerId: Type.String({ minLength: 1, maxLength: 128 }),
    fence: Type.Integer({ minimum: 1 }),
    status: stringEnum(["active", "released", "cancelled"]),
    acquiredAt: UtcTimestampSchema,
    heartbeatAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    releasedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    updatedAt: UtcTimestampSchema,
  },
  { $id: "RunLease" },
);

export const RunCheckpointSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    checkpointId: CheckpointIdSchema,
    runId: RunIdSchema,
    attemptId: RunAttemptIdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    state: JsonObjectSchema,
    createdAt: UtcTimestampSchema,
  },
  { $id: "RunCheckpoint" },
);

export const RunCommandSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    runCommandId: RunCommandIdSchema,
    runId: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    command: stringEnum(["cancel", "retry"]),
    requestedBy: UserIdSchema,
    requestedAt: UtcTimestampSchema,
  },
  { $id: "RunCommand" },
);

export const AuditEventSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    auditEventId: AuditEventIdSchema,
    workspaceId: WorkspaceIdSchema,
    actorId: UserIdSchema,
    action: Type.String({ minLength: 1, maxLength: 128 }),
    entityKind: Type.String({ minLength: 1, maxLength:128 }),
    entityId: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: UtcTimestampSchema,
  },
  { $id: "AuditEvent" },
);

export type ProductUser = Static<typeof ProductUserSchema>;
export type ProductWorkspace = Static<typeof ProductWorkspaceSchema>;
export type WorkspaceMembership = Static<typeof WorkspaceMembershipSchema>;
export type ProductSession = Static<typeof ProductSessionSchema>;
export type SkillDraft = Static<typeof SkillDraftSchema>;
export type SkillTestCase = Static<typeof SkillTestCaseSchema>;
export type SkillTestRun = Static<typeof SkillTestRunSchema>;
export type SkillPublicRuntimeSummary = Static<typeof SkillPublicRuntimeSummarySchema>;
export type SkillValidationRecord = Static<typeof SkillValidationRecordSchema>;
export type SkillVersion = Static<typeof SkillVersionSchema>;
export type SkillVersionSummary = Static<typeof SkillVersionSummarySchema>;
export type SkillRetirement = Static<typeof SkillRetirementSchema>;
export type Skill = Static<typeof SkillSchema>;
export type SkillAssetRecordSummary = Static<typeof SkillAssetRecordSummarySchema>;
export type SkillDraftSummary = Static<typeof SkillDraftSummarySchema>;
export type SkillDraftPackageFile = Static<typeof SkillDraftPackageFileSchema>;
export type SkillDraftPackage = Static<typeof SkillDraftPackageSchema>;
export type SkillPublishedVersionSummary = Static<typeof SkillPublishedVersionSummarySchema>;
export type SkillAssetSummary = Static<typeof SkillAssetSummarySchema>;
export type SkillUsageImpact = Static<typeof SkillUsageImpactSchema>;
export type SkillVersionDiff = Static<typeof SkillVersionDiffSchema>;
export type LoopSkillUpdatePreview = Static<typeof LoopSkillUpdatePreviewSchema>;
export type LoopDefinition = Static<typeof LoopDefinitionSchema>;
export type LoopVersion = Static<typeof LoopVersionSchema>;
export type WorkspaceAssetRelease = Static<typeof WorkspaceAssetReleaseSchema>;
export type AssetInstallation = Static<typeof AssetInstallationSchema>;
export type UploadSession = Static<typeof UploadSessionSchema>;
export type ProductObject = Static<typeof ProductObjectSchema>;
export type WorkspaceResource = Static<typeof WorkspaceResourceSchema>;
export type WorkspaceConnection = Static<typeof WorkspaceConnectionSchema>;
export type LifecycleBuilderProposal = Static<typeof LifecycleBuilderProposalSchema>;
export type RunExecutionSnapshot = Static<typeof RunExecutionSnapshotSchema>;
export type RunJob = Static<typeof RunJobSchema>;
export type RunLease = Static<typeof RunLeaseSchema>;
export type RunCheckpoint = Static<typeof RunCheckpointSchema>;
export type RunCommand = Static<typeof RunCommandSchema>;
export type AuditEvent = Static<typeof AuditEventSchema>;
