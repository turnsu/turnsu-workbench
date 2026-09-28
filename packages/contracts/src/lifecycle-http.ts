import { Type, type TSchema } from "typebox";

import {
  ConnectionIdSchema,
  ContentHashSchema,
  CursorPageRequestSchema,
  DiagnosticSchema,
  EntityTagSchema,
  InstallationIdSchema,
  InstallationUpdateDraftIdSchema,
  LoopImportIdSchema,
  LoopVersionIdSchema,
  ModelProfileIdSchema,
  ObjectIdSchema,
  ResourceIdSchema,
  ProposalIdSchema,
  ReleaseIdSchema,
  RunIdSchema,
  SkillDraftIdSchema,
  SkillIdSchema,
  SkillVersionIdSchema,
  StrongEntityTagSchema,
  UploadIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  WorkbenchSchemaVersionSchema,
  WorkspaceIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
} from "./common.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  EntityTagResponseHeadersSchema,
  IdempotencyHeadersSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  RevisionMutationHeadersSchema,
  SaveWorkflowRevisionDataSchema,
  StartRunDataSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./http.js";
import { RunCommandDataSchema, RunCommandRequestSchema, WORKBENCH_V1_RUN_ENDPOINTS } from "./runs-http.js";
import { AgentSessionSchema } from "./agents.js";
import { AttachmentMediaTypeSchema, AttachmentRefSchema } from "./attachments.js";
import {
  AssetInstallationSchema,
  InstallationUpdateDraftSchema,
  InstallationUpdateImpactSchema,
  LifecycleBuilderProposalSchema,
  LoopDefinitionSchema,
  LoopSkillUpdatePreviewSchema,
  LoopVersionSchema,
  ProductObjectSchema,
  ProductSessionSchema,
  ProductWorkspaceSchema,
  SkillDraftSchema,
  SkillDraftSummarySchema,
  SkillDraftPackageSchema,
  SkillAssetSummarySchema,
  RegisteredToolPackageSchema,
  SkillRuntimeCatalogItemSchema,
  SkillTestCaseSchema,
  SkillTestRunIdSchema,
  SkillTestRunSchema,
  SkillTestRunPublicSchema,
  SkillUsageImpactSchema,
  SkillValidationIdSchema,
  SkillValidationRecordSchema,
  SkillValidationRecordPublicSchema,
  SkillVersionDiffSchema,
  SkillSchema,
  SkillVersionSummarySchema,
  SkillVersionListItemPublicSchema,
  SkillVersionSchema,
  UploadAssetKindSchema,
  UploadSessionSchema,
  UploadSessionPublicSchema,
  SkillAssetRecordSummarySchema,
  SkillPublishedVersionSummarySchema,
  SkillPublishReleasePublicSchema,
  WorkspaceAssetReleaseSchema,
  WorkspaceAssetKindSchema,
  WorkspaceResourceSchema,
  WorkspaceMembershipSchema,
  WorkspaceRoleSchema,
  StagedLoopDraftSchema,
  StagedLoopProposalSchema,
} from "./lifecycle.js";
import {
  PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
  PortableConnectionRefSchema,
  PortableLoopPackageV1Schema,
  PortableMaterialRefSchema,
  PortableSkillRefSchema,
} from "./portable-loop.js";
import { strictObject } from "./schema.js";
import { RunComparisonSchema, WorkflowRunSchema, WorkflowRunStatusSchema } from "./runs.js";
import { WorkflowRevisionSchema, WorkflowSchema } from "./workflows.js";

const readMetadata = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const mutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: IdempotencyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key"],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const revisionMutationMetadata = {
  ...mutationMetadata,
  requestHeadersSchema: RevisionMutationHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key", "If-Match"],
} as const;

const connectionReadMetadata = {
  ...readMetadata,
  responseHeadersSchema: EntityTagResponseHeadersSchema,
  responseHeaders: ["ETag"],
} as const;

const connectionMutationMetadata = {
  ...mutationMetadata,
  responseHeadersSchema: EntityTagResponseHeadersSchema,
  responseHeaders: ["ETag"],
} as const;

const connectionRevisionMutationMetadata = {
  ...revisionMutationMetadata,
  responseHeadersSchema: EntityTagResponseHeadersSchema,
  responseHeaders: ["ETag"],
} as const;

const pageQuery = strictObject({ ...CursorPageRequestSchema.properties });
const libraryQuery = strictObject({ ...CursorPageRequestSchema.properties, assetKind: Type.Optional(WorkspaceAssetKindSchema) });
const SkillPathParamsSchema = strictObject({ skillId: SkillIdSchema });
const SkillDraftPathParamsSchema = strictObject({
  skillId: SkillIdSchema,
  draftId: SkillDraftIdSchema,
});
const SkillTestRunPathParamsSchema = strictObject({
  skillId: SkillIdSchema,
  testRunId: SkillTestRunIdSchema,
});
const SkillValidationPathParamsSchema = strictObject({
  skillId: SkillIdSchema,
  validationId: SkillValidationIdSchema,
});
const SkillVersionDiffPathParamsSchema = strictObject({
  skillId: SkillIdSchema,
  fromVersionId: SkillVersionIdSchema,
  toVersionId: SkillVersionIdSchema,
});
const WorkflowPathParamsSchema = strictObject({ workflowId: WorkflowIdSchema });
const LoopSkillUpdatePreviewPathParamsSchema = strictObject({
  workflowId: WorkflowIdSchema,
  skillVersionId: SkillVersionIdSchema,
});
const LoopImportPathParamsSchema = strictObject({ importId: LoopImportIdSchema });
const LoopExportQuerySchema = strictObject({ revisionId: WorkflowRevisionIdSchema });
const ProposalPathParamsSchema = strictObject({
  workflowId: WorkflowIdSchema,
  proposalId: ProposalIdSchema,
});
const StagedProposalPathParamsSchema = strictObject({ proposalId: ProposalIdSchema });
const ReleasePathParamsSchema = strictObject({ releaseId: ReleaseIdSchema });
const InstallationPathParamsSchema = strictObject({ installationId: InstallationIdSchema });
const InstallationUpdateDraftPathParamsSchema = strictObject({
  updateDraftId: InstallationUpdateDraftIdSchema,
});
const UploadPathParamsSchema = strictObject({ uploadId: UploadIdSchema });
const UploadChunkPathParamsSchema = strictObject({
  uploadId: UploadIdSchema,
  chunkIndex: Type.String({ pattern: "^(0|[1-9][0-9]{0,2})$" }),
});
const ObjectPathParamsSchema = strictObject({ objectId: ObjectIdSchema });
const ResourcePathParamsSchema = strictObject({ resourceId: ResourceIdSchema });
const ConnectionPathParamsSchema = strictObject({ connectionId: ConnectionIdSchema });
const RunPathParamsSchema = strictObject({ runId: RunIdSchema });
const RunComparisonPathParamsSchema = strictObject({ runId: RunIdSchema, otherRunId: RunIdSchema });

export const ConnectionBindingSchema = strictObject(
  {
    requirementId: Type.String({ minLength: 1, maxLength: 128 }),
    connectionId: ConnectionIdSchema,
  },
  { $id: "ConnectionBinding" },
);

export const V1SessionWorkspaceResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    session: ProductSessionSchema,
    workspace: ProductWorkspaceSchema,
    membership: WorkspaceMembershipSchema,
  }),
  "V1SessionWorkspaceResponse",
);

export const V1MembershipListResponseSchema = ListResponseEnvelopeSchema(
  WorkspaceMembershipSchema,
  "V1MembershipListResponse",
);

export const AddMembershipDataSchema = strictObject({
  userId: UserIdSchema,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  role: WorkspaceRoleSchema,
});
export const AddMembershipRequestSchema = MutationRequestEnvelopeSchema(
  AddMembershipDataSchema,
  "AddMembershipRequest",
);

export const CreateSkillDataSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  category: Type.String({ minLength: 1, maxLength: 100 }),
  uploadId: Type.Optional(UploadIdSchema),
});
export const SkillAssetListResponseSchema = ListResponseEnvelopeSchema(
  SkillAssetSummarySchema,
  "SkillAssetListResponse",
);
export const SkillRuntimeCatalogResponseSchema = ListResponseEnvelopeSchema(
  SkillRuntimeCatalogItemSchema,
  "SkillRuntimeCatalogResponse",
);
export const RegisteredToolCatalogResponseSchema = ListResponseEnvelopeSchema(
  RegisteredToolPackageSchema,
  "RegisteredToolCatalogResponse",
);
export const StartLoopAgentTaskRequestSchema = MutationRequestEnvelopeSchema(
  StartRunDataSchema,
  "StartLoopAgentTaskRequest",
);
export const StartLoopAgentTaskResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    session: AgentSessionSchema,
    run: WorkflowRunSchema,
  }),
  "StartLoopAgentTaskResponse",
);
export const CreateSkillRequestSchema = MutationRequestEnvelopeSchema(
  CreateSkillDataSchema,
  "CreateSkillRequest",
);
export const CreateSkillResponseSchema = ResponseEnvelopeSchema(
  strictObject({ skill: SkillAssetRecordSummarySchema, draft: SkillDraftSummarySchema }),
  "CreateSkillResponse",
);

export const PublishSkillDataSchema = strictObject({
  version: Type.String({ minLength: 1, maxLength: 64 }),
  releaseNotes: Type.String({ maxLength: 4000 }),
});
export const PublishSkillRequestSchema = MutationRequestEnvelopeSchema(
  PublishSkillDataSchema,
  "PublishSkillRequest",
);
export const PublishSkillResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    skill: SkillAssetRecordSummarySchema,
    version: SkillPublishedVersionSummarySchema,
    release: SkillPublishReleasePublicSchema,
  }),
  "PublishSkillResponse",
);

export const CreateNextSkillDraftDataSchema = strictObject({
  baseVersionId: SkillVersionIdSchema,
});
export const CreateNextSkillDraftRequestSchema = MutationRequestEnvelopeSchema(
  CreateNextSkillDraftDataSchema,
  "CreateNextSkillDraftRequest",
);
export const SkillDraftResponseSchema = ResponseEnvelopeSchema(
  SkillDraftSummarySchema,
  "SkillDraftResponse",
);
export const SkillDraftPackageResponseSchema = ResponseEnvelopeSchema(
  SkillDraftPackageSchema,
  "SkillDraftPackageResponse",
);
export const ReplaceSkillDraftPackageDataSchema = strictObject({
  uploadId: UploadIdSchema,
});
export const ReplaceSkillDraftPackageRequestSchema = MutationRequestEnvelopeSchema(
  ReplaceSkillDraftPackageDataSchema,
  "ReplaceSkillDraftPackageRequest",
);
export const UpdateSkillDraftDataSchema = Type.Partial(
  Type.Pick(SkillDraftSchema, [
    "name",
    "description",
    "category",
    "inputSchema",
    "outputSchema",
    "risk",
    "dependencies",
    "connectionRequirements",
  ]),
  { $id: "UpdateSkillDraftData", minProperties: 1 },
);
export const UpdateSkillDraftRequestSchema = MutationRequestEnvelopeSchema(
  UpdateSkillDraftDataSchema,
  "UpdateSkillDraftRequest",
);
export const CreateSkillTestDataSchema = strictObject({
  testCase: SkillTestCaseSchema,
});
export const CreateSkillTestRequestSchema = MutationRequestEnvelopeSchema(
  CreateSkillTestDataSchema,
  "CreateSkillTestRequest",
);
export const SkillTestRunResponseSchema = ResponseEnvelopeSchema(
  SkillTestRunPublicSchema,
  "SkillTestRunResponse",
);
export const CreateSkillValidationDataSchema = strictObject({
  testRunIds: Type.Array(SkillTestRunIdSchema, {
    minItems: 1,
    uniqueItems: true,
  }),
  permissionAcknowledged: Type.Literal(true),
});
export const CreateSkillValidationRequestSchema = MutationRequestEnvelopeSchema(
  CreateSkillValidationDataSchema,
  "CreateSkillValidationRequest",
);
export const SkillValidationResponseSchema = ResponseEnvelopeSchema(
  SkillValidationRecordPublicSchema,
  "SkillValidationResponse",
);
export const SkillUsageResponseSchema = ResponseEnvelopeSchema(
  SkillUsageImpactSchema,
  "SkillUsageResponse",
);
export const SkillVersionDiffResponseSchema = ResponseEnvelopeSchema(
  SkillVersionDiffSchema,
  "SkillVersionDiffResponse",
);
export const SkillVersionListResponseSchema = ListResponseEnvelopeSchema(
  SkillVersionListItemPublicSchema,
  "SkillVersionListResponse",
);

export const DeprecateSkillDataSchema = strictObject({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});
export const DeprecateSkillRequestSchema = MutationRequestEnvelopeSchema(
  DeprecateSkillDataSchema,
  "DeprecateSkillRequest",
);
export const RunComparisonResponseSchema = ResponseEnvelopeSchema(
  RunComparisonSchema,
  "RunComparisonResponse",
);
export const RecentWorkItemSchema = strictObject(
  {
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    status: WorkflowRunStatusSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "RecentWorkItem" },
);
export const RecentWorkListResponseSchema = ListResponseEnvelopeSchema(
  RecentWorkItemSchema,
  "RecentWorkListResponse",
);

export const CreateLoopDataSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  definition: LoopDefinitionSchema,
});
export const CreateLoopRequestSchema = MutationRequestEnvelopeSchema(
  CreateLoopDataSchema,
  "CreateLoopRequest",
);
export const CreateLoopResponseSchema = ResponseEnvelopeSchema(
  strictObject({ workflow: WorkflowSchema, revision: WorkflowRevisionSchema }),
  "CreateLoopResponse",
);
export const CreateLoopFromReleaseRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
  "CreateLoopFromReleaseRequest",
);

export const CreateLoopImportDataSchema = strictObject({
  uploadId: UploadIdSchema,
});
export const CreateLoopImportRequestSchema = MutationRequestEnvelopeSchema(
  CreateLoopImportDataSchema,
  "CreateLoopImportRequest",
);

const LoopImportRequirementStatusSchema = Type.Union([
  Type.Literal("unmapped"),
  Type.Literal("mapped"),
  Type.Literal("unavailable"),
]);
export const LoopImportRequirementStateSchema = Type.Union(
  [
    strictObject({
      ref: PortableSkillRefSchema,
      kind: Type.Literal("skill"),
      status: LoopImportRequirementStatusSchema,
    }),
    strictObject({
      ref: PortableConnectionRefSchema,
      kind: Type.Literal("connection"),
      status: LoopImportRequirementStatusSchema,
    }),
    strictObject({
      ref: PortableMaterialRefSchema,
      kind: Type.Literal("material"),
      status: LoopImportRequirementStatusSchema,
    }),
  ],
  { $id: "LoopImportRequirementState" },
);

export const LoopImportSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    importId: LoopImportIdSchema,
    uploadId: UploadIdSchema,
    status: Type.Union([
      Type.Literal("parsing"),
      Type.Literal("needs_mapping"),
      Type.Literal("ready"),
      Type.Literal("committed"),
      Type.Literal("failed"),
    ]),
    sourceContentHash: Type.Union([ContentHashSchema, Type.Null()]),
    portableLoop: Type.Union([PortableLoopPackageV1Schema, Type.Null()]),
    requirementStates: Type.Array(LoopImportRequirementStateSchema),
    diagnostics: Type.Array(DiagnosticSchema),
    committedWorkflowId: Type.Union([WorkflowIdSchema, Type.Null()]),
    committedRevisionId: Type.Union([
      WorkflowRevisionIdSchema,
      Type.Null(),
    ]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "LoopImport" },
);
export const LoopImportResponseSchema = ResponseEnvelopeSchema(
  LoopImportSchema,
  "LoopImportResponse",
);

export const LoopImportSkillMappingSchema = strictObject({
  requirementRef: PortableSkillRefSchema,
  skillVersionId: SkillVersionIdSchema,
});
export const LoopImportMaterialMappingSchema = strictObject({
  requirementRef: PortableMaterialRefSchema,
  resolution: Type.Union([
    strictObject({
      kind: Type.Literal("workspaceMaterial"),
      resourceId: ResourceIdSchema,
    }),
    strictObject({
      kind: Type.Literal("embeddedMaterial"),
      contentHash: ContentHashSchema,
    }),
  ]),
});
export const LoopImportConnectionMappingSchema = strictObject({
  requirementRef: PortableConnectionRefSchema,
  connectionId: ConnectionIdSchema,
});
export const CommitLoopImportDataSchema = strictObject({
  skillMappings: Type.Array(LoopImportSkillMappingSchema, {
    uniqueItems: true,
  }),
  materialMappings: Type.Array(LoopImportMaterialMappingSchema, {
    uniqueItems: true,
  }),
  connectionMappings: Type.Array(LoopImportConnectionMappingSchema, {
    uniqueItems: true,
  }),
});
export const CommitLoopImportRequestSchema = MutationRequestEnvelopeSchema(
  CommitLoopImportDataSchema,
  "CommitLoopImportRequest",
);
export const PortableLoopPackageResponseSchema = PortableLoopPackageV1Schema;
export const PortableLoopExportRequestHeadersSchema = strictObject({
  "If-None-Match": Type.Optional(
    Type.Union([StrongEntityTagSchema, Type.Literal("*")]),
  ),
});
export const PortableLoopExportResponseHeadersSchema = strictObject({
  ETag: StrongEntityTagSchema,
  "Content-Disposition": Type.String({
    pattern: '^attachment; filename="[A-Za-z0-9][A-Za-z0-9._-]{0,190}\\.loop\\.json"$',
  }),
});

export const DuplicateLoopDataSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
});
export const DuplicateLoopRequestSchema = MutationRequestEnvelopeSchema(
  DuplicateLoopDataSchema,
  "DuplicateLoopRequest",
);

export const SaveLoopRevisionDataSchema = strictObject({
  ...SaveWorkflowRevisionDataSchema.properties,
  definition: LoopDefinitionSchema,
});
export const SaveLoopRevisionRequestSchema = MutationRequestEnvelopeSchema(
  SaveLoopRevisionDataSchema,
  "SaveLoopRevisionRequest",
);

export const CreateLoopSkillUpdateDataSchema = strictObject({
  skillId: SkillIdSchema,
  fromVersion: Type.String({ minLength: 1, maxLength: 64 }),
  toVersion: Type.String({ minLength: 1, maxLength: 64 }),
  connectionBindings: Type.Optional(Type.Array(ConnectionBindingSchema, { uniqueItems: true })),
});
export const CreateLoopSkillUpdateRequestSchema = MutationRequestEnvelopeSchema(
  CreateLoopSkillUpdateDataSchema,
  "CreateLoopSkillUpdateRequest",
);
export const LoopSkillUpdatePreviewResponseSchema = ResponseEnvelopeSchema(
  LoopSkillUpdatePreviewSchema,
  "LoopSkillUpdatePreviewResponse",
);

export const GenerateProposalDataSchema = strictObject({
  instruction: Type.String({ minLength: 1, maxLength: 8000 }),
  modelProfileId: Type.Optional(ModelProfileIdSchema),
});
export const GenerateProposalRequestSchema = MutationRequestEnvelopeSchema(
  GenerateProposalDataSchema,
  "GenerateProposalRequest",
);
export const ProposalResponseSchema = ResponseEnvelopeSchema(
  LifecycleBuilderProposalSchema,
  "LifecycleBuilderProposalResponse",
);
export const GenerateStagedLoopProposalDataSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  sourceText: Type.String({ minLength: 1, maxLength: 8000 }),
  definition: LoopDefinitionSchema,
  modelProfileId: Type.Optional(ModelProfileIdSchema),
});
export const GenerateStagedLoopProposalRequestSchema = MutationRequestEnvelopeSchema(
  GenerateStagedLoopProposalDataSchema,
  "GenerateStagedLoopProposalRequest",
);
export const StagedLoopProposalResponseSchema = ResponseEnvelopeSchema(
  StagedLoopProposalSchema,
  "StagedLoopProposalResponse",
);
export const CommitStagedLoopProposalDataSchema = strictObject({
  draft: StagedLoopDraftSchema,
});
export const CommitStagedLoopProposalRequestSchema = MutationRequestEnvelopeSchema(
  CommitStagedLoopProposalDataSchema,
  "CommitStagedLoopProposalRequest",
);
export const CommitStagedLoopProposalResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    workflow: WorkflowSchema,
    revision: WorkflowRevisionSchema,
    proposal: StagedLoopProposalSchema,
  }),
  "CommitStagedLoopProposalResponse",
);
export const DismissStagedLoopProposalRequestSchema = MutationRequestEnvelopeSchema(
  EmptyObjectSchema,
  "DismissStagedLoopProposalRequest",
);
export const ApplyProposalDataSchema = strictObject({
  baseRevisionId: Type.String({ minLength: 1, maxLength: 128 }),
});
export const ApplyProposalRequestSchema = MutationRequestEnvelopeSchema(
  ApplyProposalDataSchema,
  "ApplyProposalRequest",
);

export const PublishLoopDataSchema = strictObject({
  version: Type.String({ minLength: 1, maxLength: 64 }),
  releaseNotes: Type.String({ maxLength: 4000 }),
  startingPoint: Type.Boolean(),
});
// An owner's reviewed report of local work, not proof of managed cloud execution.
export const RecordLocalLoopTrialDataSchema = strictObject({
  workflowRevisionId: WorkflowRevisionIdSchema,
  revisionContentHash: ContentHashSchema,
  localTrialId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" }),
  agentKind: Type.Union([Type.Literal("codex"), Type.Literal("claude"), Type.Literal("pi")]),
  inputSummary: Type.String({ maxLength: 16000 }),
  output: Type.String({ minLength: 1, maxLength: 64000 }),
  reviewNote: Type.String({ minLength: 1, maxLength: 4000 }),
  confirm: Type.Literal(true),
  reportedCompletedAt: UtcTimestampSchema,
});
export const LocalLoopTrialReceiptSchema = strictObject({
  trialId: ObjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  workflowId: WorkflowIdSchema,
  ...Type.Omit(RecordLocalLoopTrialDataSchema, ["confirm"]).properties,
  outputHash: ContentHashSchema,
  provenance: Type.Literal("member_attested_local"),
  reviewState: Type.Literal("human_reviewed"),
  reviewedBy: UserIdSchema,
  recordedAt: UtcTimestampSchema,
  visibility: Type.Literal("private"),
  cloudReady: Type.Literal(false),
});
export const RecordLocalLoopTrialRequestSchema = MutationRequestEnvelopeSchema(RecordLocalLoopTrialDataSchema, "RecordLocalLoopTrialRequest");
export const RecordLocalLoopTrialResponseSchema = ResponseEnvelopeSchema(LocalLoopTrialReceiptSchema, "RecordLocalLoopTrialResponse");
export const NativeLoopRecipeSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 8000 }),
  ...Type.Omit(SaveLoopRevisionDataSchema, ["baseRevisionId", "saveReason"]).properties,
});
export const NativeLoopSkillPinSchema = strictObject({
  skillId: SkillIdSchema, skillVersionId: SkillVersionIdSchema,
  version: Type.String({ minLength: 1, maxLength: 128 }), contentHash: ContentHashSchema,
  releaseId: ReleaseIdSchema, sourceWorkspaceId: WorkspaceIdSchema,
  packageHash: ContentHashSchema, packageObjectHash: ContentHashSchema,
});
const nativeLoopExecutionProperties = {
  executionMode: Type.Literal("native_agent"),
  executionSemantics: Type.Literal("agent_guided_recipe"),
  cloudReady: Type.Literal(false),
};
export const PublishNativeLoopDataSchema = strictObject({
  trialId: ObjectIdSchema, workflowRevisionId: WorkflowRevisionIdSchema, revisionContentHash: ContentHashSchema,
  version: Type.String({ minLength: 1, maxLength: 64 }), releaseNotes: Type.String({ maxLength: 4000 }), confirm: Type.Literal(true),
});
export const PublishNativeLoopRequestSchema = MutationRequestEnvelopeSchema(PublishNativeLoopDataSchema, "PublishNativeLoopRequest");
export const PublishNativeLoopResponseSchema = ResponseEnvelopeSchema(strictObject({
  release: WorkspaceAssetReleaseSchema,
  nativeLoopVersion: strictObject({ versionId: LoopVersionIdSchema, workflowId: WorkflowIdSchema,
    version: Type.String({ minLength: 1, maxLength: 64 }), contentHash: ContentHashSchema, ...nativeLoopExecutionProperties }),
}), "PublishNativeLoopResponse");
export const NativeLoopPackageSchema = strictObject({
  releaseId: ReleaseIdSchema, sourceWorkspaceId: WorkspaceIdSchema, versionId: LoopVersionIdSchema,
  version: Type.String({ minLength: 1, maxLength: 64 }), contentHash: ContentHashSchema,
  ...nativeLoopExecutionProperties, recipe: NativeLoopRecipeSchema, skillPins: Type.Array(NativeLoopSkillPinSchema, { minItems: 1, maxItems: 20 }),
});
export const NativeLoopPackageResponseSchema = ResponseEnvelopeSchema(NativeLoopPackageSchema, "NativeLoopPackageResponse");
export const PublishLoopRequestSchema = MutationRequestEnvelopeSchema(
  PublishLoopDataSchema,
  "PublishLoopRequest",
);
export const PublishLoopResponseSchema = ResponseEnvelopeSchema(
  strictObject({ loopVersion: LoopVersionSchema, release: WorkspaceAssetReleaseSchema }),
  "PublishLoopResponse",
);

export const InstallReleaseDataSchema = strictObject({
  connectionIds: Type.Array(ConnectionIdSchema),
  connectionBindings: Type.Optional(Type.Array(ConnectionBindingSchema, { uniqueItems: true })),
});
export const InstallReleaseRequestSchema = MutationRequestEnvelopeSchema(
  InstallReleaseDataSchema,
  "InstallReleaseRequest",
);
export const InstallationResponseSchema = ResponseEnvelopeSchema(
  AssetInstallationSchema,
  "AssetInstallationResponse",
);
export const InstallSystemCatalogDefaultPackRequestSchema = MutationRequestEnvelopeSchema(
  EmptyObjectSchema,
  "InstallSystemCatalogDefaultPackRequest",
);
export const InstallSystemCatalogDefaultPackResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    schemaVersion: WorkbenchSchemaVersionSchema,
    sourceWorkspaceId: WorkspaceIdSchema,
    installations: Type.Array(AssetInstallationSchema, { minItems: 1, maxItems: 32 }),
  }),
  "InstallSystemCatalogDefaultPackResponse",
);
export const InstallationListResponseSchema = ListResponseEnvelopeSchema(
  AssetInstallationSchema,
  "InstallationListResponse",
);
export const AdoptInstallationReleaseDataSchema = strictObject({
  releaseId: ReleaseIdSchema,
  connectionBindings: Type.Optional(Type.Array(ConnectionBindingSchema, { uniqueItems: true })),
});
export const AdoptInstallationReleaseRequestSchema = MutationRequestEnvelopeSchema(
  AdoptInstallationReleaseDataSchema,
  "AdoptInstallationReleaseRequest",
);
export const InstallationUpdateImpactQuerySchema = strictObject({
  releaseId: ReleaseIdSchema,
});
export const InstallationUpdateImpactResponseSchema = ResponseEnvelopeSchema(
  InstallationUpdateImpactSchema,
  "InstallationUpdateImpactResponse",
);
export const CreateInstallationUpdateDraftDataSchema = strictObject({
  releaseId: ReleaseIdSchema,
  connectionBindings: Type.Optional(
    Type.Array(ConnectionBindingSchema, { uniqueItems: true, maxItems: 128 }),
  ),
});
export const CreateInstallationUpdateDraftRequestSchema =
  MutationRequestEnvelopeSchema(
    CreateInstallationUpdateDraftDataSchema,
    "CreateInstallationUpdateDraftRequest",
  );
export const InstallationUpdateDraftResponseSchema = ResponseEnvelopeSchema(
  InstallationUpdateDraftSchema,
  "InstallationUpdateDraftResponse",
);
export const InstallationUpdateDraftDecisionRequestSchema =
  MutationRequestEnvelopeSchema(
    strictObject({
      connectionBindings: Type.Optional(
        Type.Array(ConnectionBindingSchema, { uniqueItems: true, maxItems: 128 }),
      ),
    }),
    "InstallationUpdateDraftDecisionRequest",
  );
export const StartFromReleaseDataSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  connectionBindings: Type.Optional(Type.Array(ConnectionBindingSchema, { uniqueItems: true })),
});
export const StartFromReleaseRequestSchema = MutationRequestEnvelopeSchema(
  StartFromReleaseDataSchema,
  "StartFromReleaseRequest",
);

export const CreateUploadDataSchema = strictObject({
  filename: Type.String({ minLength: 1, maxLength: 512 }),
  sizeBytes: Type.Integer({ minimum: 0, maximum: 1073741824 }),
  mediaType: Type.String({ minLength: 1, maxLength: 128 }),
  assetKind: Type.Optional(UploadAssetKindSchema),
  ingestMethod: Type.Optional(Type.Union([
    Type.Literal("files"),
    Type.Literal("resumable"),
  ])),
});
export const CreateUploadRequestSchema = MutationRequestEnvelopeSchema(
  CreateUploadDataSchema,
  "CreateUploadRequest",
);
export const UploadPackageFileSchema = strictObject({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  contentBase64: Type.String({ minLength: 1, maxLength: 1398104, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
});
export const UploadPackageDataSchema = strictObject({
  files: Type.Array(UploadPackageFileSchema, { minItems: 1, maxItems: 256 }),
});
export const UploadPackageRequestSchema = MutationRequestEnvelopeSchema(
  UploadPackageDataSchema,
  "UploadPackageRequest",
);
const SkillDraftScaffoldInputSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  identifier: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
  })),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  required: Type.Boolean(),
  acceptedMediaTypes: Type.Optional(Type.Array(AttachmentMediaTypeSchema, {
    minItems: 1,
    maxItems: 9,
    uniqueItems: true,
  })),
});
const SkillDraftScaffoldParameterSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 1000 }),
  required: Type.Boolean(),
  type: Type.Union([
    Type.Literal("string"),
    Type.Literal("number"),
    Type.Literal("boolean"),
    Type.Literal("json"),
    Type.Literal("markdown"),
  ]),
});
const SkillDraftScaffoldOutputSchema = strictObject({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 1000 }),
  type: Type.Union([
    Type.Literal("string"),
    Type.Literal("number"),
    Type.Literal("boolean"),
    Type.Literal("json"),
    Type.Literal("markdown"),
    Type.Literal("file"),
  ]),
});
export const ScaffoldSkillDraftPackageDataSchema = strictObject({
  definitionType: Type.Union([Type.Literal("prompt"), Type.Literal("script")]),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  category: Type.String({ minLength: 1, maxLength: 100 }),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 12, uniqueItems: true }),
  materials: Type.Array(SkillDraftScaffoldInputSchema, { maxItems: 64 }),
  parameters: Type.Array(SkillDraftScaffoldParameterSchema, { maxItems: 64 }),
  outputs: Type.Array(SkillDraftScaffoldOutputSchema, { minItems: 1, maxItems: 64 }),
  smoke: strictObject({
    purpose: Type.String({ maxLength: 2000 }),
    input: Type.String({ maxLength: 20_000 }),
    expectedOutcome: Type.String({ maxLength: 4000 }),
  }),
  runtime: Type.Optional(strictObject({
    runtimeId: Type.String({ minLength: 1, maxLength: 128 }),
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 120 }),
    memoryMiB: Type.Integer({ minimum: 64, maximum: 512, multipleOf: 64 }),
  })),
});
export const ScaffoldSkillDraftPackageRequestSchema = MutationRequestEnvelopeSchema(
  ScaffoldSkillDraftPackageDataSchema,
  "ScaffoldSkillDraftPackageRequest",
);
export const ScaffoldSkillDraftPackageResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    filename: Type.String({ minLength: 1, maxLength: 512 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: 4_194_304 }),
    files: Type.Array(UploadPackageFileSchema, { minItems: 1, maxItems: 3 }),
  }),
  "ScaffoldSkillDraftPackageResponse",
);
export const UploadResponseSchema = ResponseEnvelopeSchema(
  UploadSessionPublicSchema,
  "UploadSessionResponse",
);
export const UploadChunkDataSchema = strictObject({
  contentBase64: Type.String({ minLength: 1, maxLength: 699052, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
});
export const UploadChunkRequestSchema = MutationRequestEnvelopeSchema(
  UploadChunkDataSchema,
  "UploadChunkRequest",
);
export const CompleteUploadRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({}),
  "CompleteUploadRequest",
);
export const ImportSkillRepositoryDataSchema = strictObject({
  repositoryUrl: Type.String({ minLength: 19, maxLength: 512 }),
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  skillDirectory: Type.Optional(Type.String({ maxLength: 320 })),
});
export const ImportSkillRepositoryRequestSchema = MutationRequestEnvelopeSchema(
  ImportSkillRepositoryDataSchema,
  "ImportSkillRepositoryRequest",
);
export const PromoteUploadDataSchema = strictObject({
  skillId: Type.Optional(SkillIdSchema),
  permissionAcknowledged: Type.Optional(Type.Literal(true)),
});
export const PromoteUploadRequestSchema = MutationRequestEnvelopeSchema(
  PromoteUploadDataSchema,
  "PromoteUploadRequest",
);

export const ConnectionConfigurationSchema = strictObject(
  {
    accountLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    permissionSummary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { $id: "ConnectionConfiguration" },
);
export const WorkspaceConnectionPublicSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    connectionId: ConnectionIdSchema,
    workspaceId: WorkspaceIdSchema,
    capabilityKey: Type.String({ minLength: 1, maxLength: 128 }),
    driverKey: Type.String({ minLength: 1, maxLength: 128 }),
    driverBackend: Type.Union([
      Type.Literal("production"),
      Type.Literal("test"),
    ]),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    configuration: ConnectionConfigurationSchema,
    credentialState: Type.Union([
      Type.Literal("unbound"),
      Type.Literal("bound"),
      Type.Literal("expired"),
    ]),
    status: Type.Union([
      Type.Literal("connected"),
      Type.Literal("needs_setup"),
      Type.Literal("checking"),
      Type.Literal("disabled"),
    ]),
    validation: strictObject({
      status: Type.Union([
        Type.Literal("never_checked"),
        Type.Literal("checking"),
        Type.Literal("valid"),
        Type.Literal("invalid"),
      ]),
      checkedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
      message: Type.String({ minLength: 1, maxLength: 1000 }),
      principal: Type.Optional(Type.String({ maxLength: 200 })),
      scopes: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
          uniqueItems: true,
          maxItems: 128,
        }),
      ),
      effects: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
          uniqueItems: true,
          maxItems: 128,
        }),
      ),
      expiresAt: Type.Optional(
        Type.Union([UtcTimestampSchema, Type.Null()]),
      ),
    }),
    revision: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkspaceConnectionPublic" },
);
export const CreateConnectionDataSchema = strictObject({
  capabilityKey: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  configuration: ConnectionConfigurationSchema,
});
export const CreateConnectionRequestSchema = MutationRequestEnvelopeSchema(
  CreateConnectionDataSchema,
  "CreateConnectionRequest",
);
export const UpdateConnectionDataSchema = Type.Partial(
  strictObject({
    label: Type.String({ minLength: 1, maxLength: 200 }),
    configuration: ConnectionConfigurationSchema,
    enabled: Type.Boolean(),
  }),
  { $id: "UpdateConnectionData", minProperties: 1 },
);
export const UpdateConnectionRequestSchema = MutationRequestEnvelopeSchema(
  UpdateConnectionDataSchema,
  "UpdateConnectionRequest",
);
export const ValidateConnectionRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({}),
  "ValidateConnectionRequest",
);
export const BindConnectionCredentialRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    secretRef: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
    }),
  }),
  "BindConnectionCredentialRequest",
);
export const ConnectionResponseSchema = ResponseEnvelopeSchema(
  WorkspaceConnectionPublicSchema,
  "WorkspaceConnectionResponse",
);
export const CreateResourceDataSchema = strictObject({
  label: Type.String({ minLength: 1, maxLength: 200 }),
  mediaType: Type.Union([
    Type.Literal("text/plain"),
    Type.Literal("text/markdown"),
    Type.Literal("text/csv"),
  ]),
  contentBase64: Type.String({ minLength: 1, maxLength: 1398104, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
});
export const CreateResourceRequestSchema = MutationRequestEnvelopeSchema(
  CreateResourceDataSchema,
  "CreateResourceRequest",
);
export const CreateResourceFromAttachmentRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    label: Type.String({ minLength: 1, maxLength: 200 }),
    attachment: AttachmentRefSchema,
  }),
  "CreateResourceFromAttachmentRequest",
);
export const ResourceResponseSchema = ResponseEnvelopeSchema(
  WorkspaceResourceSchema,
  "WorkspaceResourceResponse",
);
export const ResourceListResponseSchema = ListResponseEnvelopeSchema(
  WorkspaceResourceSchema,
  "WorkspaceResourceListResponse",
);

export { RunCommandDataSchema, RunCommandRequestSchema };

function endpoint<T extends WorkbenchEndpointMetadata>(value: T): T {
  return value;
}

export const WORKBENCH_V1_STAGED_LOOP_ENDPOINTS = {
  getStagedLoopProposal: endpoint({
    ...readMetadata,
    operationId: "getStagedLoopProposal",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/loop-draft-proposals/{proposalId}`,
    pathParamsSchema: StagedProposalPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: StagedLoopProposalResponseSchema,
  }),
  generateStagedLoopProposal: endpoint({
    ...mutationMetadata,
    operationId: "generateStagedLoopProposal",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loop-draft-proposals`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: GenerateStagedLoopProposalRequestSchema,
    responseBodySchema: StagedLoopProposalResponseSchema,
  }),
  commitStagedLoopProposal: endpoint({
    ...mutationMetadata,
    operationId: "commitStagedLoopProposal",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loop-draft-proposals/{proposalId}/commit`,
    successStatus: 201,
    pathParamsSchema: StagedProposalPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CommitStagedLoopProposalRequestSchema,
    responseBodySchema: CommitStagedLoopProposalResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  dismissStagedLoopProposal: endpoint({
    ...mutationMetadata,
    operationId: "dismissStagedLoopProposal",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loop-draft-proposals/{proposalId}/dismiss`,
    pathParamsSchema: StagedProposalPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DismissStagedLoopProposalRequestSchema,
    responseBodySchema: StagedLoopProposalResponseSchema,
  }),
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

const WORKBENCH_V1_LIFECYCLE_BASE_ENDPOINTS = {
  getActiveSession: endpoint({
    ...readMetadata,
    operationId: "getActiveSession",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/session`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: V1SessionWorkspaceResponseSchema,
  }),
  listRecentWork: endpoint({
    ...readMetadata,
    operationId: "listRecentWork",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/recent-work`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: pageQuery,
    responseBodySchema: RecentWorkListResponseSchema,
  }),
  listMemberships: endpoint({
    ...readMetadata,
    operationId: "listMemberships",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workspace/memberships`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: pageQuery,
    responseBodySchema: V1MembershipListResponseSchema,
  }),
  createSkill: endpoint({
    ...mutationMetadata,
    operationId: "createSkill",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateSkillRequestSchema,
    responseBodySchema: CreateSkillResponseSchema,
  }),
  listSkillAssets: endpoint({
    ...readMetadata,
    operationId: "listSkillAssets",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skill-assets`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: pageQuery,
    responseBodySchema: SkillAssetListResponseSchema,
  }),
  listSkillRuntimes: endpoint({
    ...readMetadata,
    operationId: "listSkillRuntimes",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skill-runtimes`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillRuntimeCatalogResponseSchema,
  }),
  listRegisteredToolPackages: endpoint({
    ...readMetadata,
    operationId: "listRegisteredToolPackages",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/registered-tool-packages`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: RegisteredToolCatalogResponseSchema,
  }),
  scaffoldSkillDraftPackage: endpoint({
    ...mutationMetadata,
    operationId: "scaffoldSkillDraftPackage",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skill-draft-packages/scaffold`,
    successStatus: 200,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ScaffoldSkillDraftPackageRequestSchema,
    responseBodySchema: ScaffoldSkillDraftPackageResponseSchema,
  }),
  startLoopAgentTask: endpoint({
    ...mutationMetadata,
    operationId: "startLoopAgentTask",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loops/{workflowId}/agent-tasks`,
    successStatus: 202,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: StartLoopAgentTaskRequestSchema,
    responseBodySchema: StartLoopAgentTaskResponseSchema,
  }),
  getSkillDraft: endpoint({
    ...readMetadata,
    operationId: "getSkillDraft",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts/{draftId}`,
    pathParamsSchema: SkillDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ResponseEnvelopeSchema(SkillDraftSummarySchema),
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  updateSkillDraft: endpoint({
    ...revisionMutationMetadata,
    operationId: "updateSkillDraft",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts/{draftId}`,
    pathParamsSchema: SkillDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UpdateSkillDraftRequestSchema,
    responseBodySchema: SkillDraftResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  getSkillDraftPackage: endpoint({
    ...readMetadata,
    operationId: "getSkillDraftPackage",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts/{draftId}/package`,
    pathParamsSchema: SkillDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillDraftPackageResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  replaceSkillDraftPackage: endpoint({
    ...revisionMutationMetadata,
    operationId: "replaceSkillDraftPackage",
    method: "PUT",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts/{draftId}/package`,
    pathParamsSchema: SkillDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ReplaceSkillDraftPackageRequestSchema,
    responseBodySchema: SkillDraftResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  createSkillTest: endpoint({
    ...revisionMutationMetadata,
    operationId: "createSkillTest",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts/{draftId}/tests`,
    successStatus: 202,
    pathParamsSchema: SkillDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateSkillTestRequestSchema,
    responseBodySchema: SkillTestRunResponseSchema,
  }),
  getSkillTestRun: endpoint({
    ...readMetadata,
    operationId: "getSkillTestRun",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/tests/{testRunId}`,
    pathParamsSchema: SkillTestRunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillTestRunResponseSchema,
  }),
  cancelSkillTest: endpoint({
    ...mutationMetadata,
    operationId: "cancelSkillTest",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/tests/{testRunId}/cancel`,
    successStatus: 202,
    pathParamsSchema: SkillTestRunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RunCommandRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(SkillTestRunIdSchema),
  }),
  createSkillValidation: endpoint({
    ...revisionMutationMetadata,
    operationId: "createSkillValidation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts/{draftId}/validations`,
    successStatus: 202,
    pathParamsSchema: SkillDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateSkillValidationRequestSchema,
    responseBodySchema: SkillValidationResponseSchema,
  }),
  getSkillValidation: endpoint({
    ...readMetadata,
    operationId: "getSkillValidation",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/validations/{validationId}`,
    pathParamsSchema: SkillValidationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillValidationResponseSchema,
  }),
  createNextSkillDraft: endpoint({
    ...revisionMutationMetadata,
    operationId: "createNextSkillDraft",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/drafts`,
    successStatus: 201,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateNextSkillDraftRequestSchema,
    responseBodySchema: SkillDraftResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  getSkillUsage: endpoint({
    ...readMetadata,
    operationId: "getSkillUsage",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/usage`,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillUsageResponseSchema,
  }),
  listSkillVersions: endpoint({
    ...readMetadata,
    operationId: "listSkillVersions",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/versions`,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: pageQuery,
    responseBodySchema: SkillVersionListResponseSchema,
  }),
  getSkillVersionDiff: endpoint({
    ...readMetadata,
    operationId: "getSkillVersionDiff",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/versions/{fromVersionId}/diff/{toVersionId}`,
    pathParamsSchema: SkillVersionDiffPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillVersionDiffResponseSchema,
  }),
  publishSkill: endpoint({
    ...revisionMutationMetadata,
    operationId: "publishSkill",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/publish`,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: PublishSkillRequestSchema,
    responseBodySchema: PublishSkillResponseSchema,
  }),
  deprecateSkill: endpoint({
    ...mutationMetadata,
    operationId: "deprecateSkill",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}/deprecate`,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DeprecateSkillRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(SkillAssetRecordSummarySchema),
  }),
  createLoop: endpoint({
    ...mutationMetadata,
    operationId: "createLoop",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loops`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateLoopRequestSchema,
    responseBodySchema: CreateLoopResponseSchema,
  }),
  saveLoopRevision: endpoint({
    ...revisionMutationMetadata,
    operationId: "saveLoopRevision",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loops/{workflowId}/revisions`,
    successStatus: 201,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: SaveLoopRevisionRequestSchema,
    responseBodySchema: CreateLoopResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  }),
  recordLocalLoopTrial: endpoint({
    ...revisionMutationMetadata,
    operationId: "recordLocalLoopTrial",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/local-trials`,
    successStatus: 201,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RecordLocalLoopTrialRequestSchema,
    responseBodySchema: RecordLocalLoopTrialResponseSchema,
  }),
  publishNativeLoop: endpoint({
    ...revisionMutationMetadata, operationId: "publishNativeLoop", method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loops/{workflowId}/native-publish`, successStatus: 201,
    pathParamsSchema: WorkflowPathParamsSchema, querySchema: EmptyObjectSchema,
    requestBodySchema: PublishNativeLoopRequestSchema, responseBodySchema: PublishNativeLoopResponseSchema,
  }),
  getNativeLoopPackage: endpoint({
    ...readMetadata, operationId: "getNativeLoopPackage", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/team-library/{releaseId}/native-loop-package`,
    pathParamsSchema: ReleasePathParamsSchema, querySchema: EmptyObjectSchema, responseBodySchema: NativeLoopPackageResponseSchema,
  }),
  publishLoop: endpoint({
    ...revisionMutationMetadata,
    operationId: "publishLoop",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/loops/{workflowId}/publish`,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: PublishLoopRequestSchema,
    responseBodySchema: PublishLoopResponseSchema,
  }),
  listTeamLibrary: endpoint({
    ...readMetadata,
    operationId: "listTeamLibrary",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/team-library`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: libraryQuery,
    responseBodySchema: ListResponseEnvelopeSchema(WorkspaceAssetReleaseSchema),
  }),
  getNativeSkillPackage: endpoint({
    ...readMetadata,
    operationId: "getNativeSkillPackage",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/team-library/{releaseId}/native-skill-package`,
    pathParamsSchema: ReleasePathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ResponseEnvelopeSchema(Type.Object({
      releaseId: ReleaseIdSchema,
      versionId: SkillVersionIdSchema,
      version: Type.String({ minLength: 1, maxLength: 64 }),
      skillName: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }),
      contentHash: ContentHashSchema,
      packageHash: ContentHashSchema,
      packageObjectHash: ContentHashSchema,
      compatibility: Type.Union([Type.String(), Type.Null()]),
      packageContentBase64: Type.String({ maxLength: 16777216 }),
    }, { additionalProperties: false })),
  }),
  listSystemCatalog: endpoint({
    ...readMetadata,
    operationId: "listSystemCatalog",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/system-catalog`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: libraryQuery,
    responseBodySchema: ListResponseEnvelopeSchema(WorkspaceAssetReleaseSchema),
  }),
  installRelease: endpoint({
    ...mutationMetadata,
    operationId: "installRelease",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/team-library/{releaseId}/install`,
    successStatus: 201,
    pathParamsSchema: ReleasePathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: InstallReleaseRequestSchema,
    responseBodySchema: InstallationResponseSchema,
  }),
  createLoopFromRelease: endpoint({
    ...mutationMetadata,
    operationId: "createLoopFromRelease",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/team-library/{releaseId}/workflows`,
    successStatus: 201,
    pathParamsSchema: ReleasePathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateLoopFromReleaseRequestSchema,
    responseBodySchema: CreateLoopResponseSchema,
  }),
  installDefaultSystemCatalog: endpoint({
    ...mutationMetadata,
    operationId: "installDefaultSystemCatalog",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/system-catalog/default-pack/install`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: InstallSystemCatalogDefaultPackRequestSchema,
    responseBodySchema: InstallSystemCatalogDefaultPackResponseSchema,
  }),
  getInstallation: endpoint({
    ...readMetadata,
    operationId: "getInstallation",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/installations/{installationId}`,
    pathParamsSchema: InstallationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: InstallationResponseSchema,
  }),
  listInstallations: endpoint({
    ...readMetadata,
    operationId: "listInstallations",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/installations`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: pageQuery,
    responseBodySchema: InstallationListResponseSchema,
  }),
  getInstallationUpdateImpact: endpoint({
    ...readMetadata,
    operationId: "getInstallationUpdateImpact",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/installations/{installationId}/update-impact`,
    pathParamsSchema: InstallationPathParamsSchema,
    querySchema: InstallationUpdateImpactQuerySchema,
    responseBodySchema: InstallationUpdateImpactResponseSchema,
  }),
  createInstallationUpdateDraft: endpoint({
    ...mutationMetadata,
    operationId: "createInstallationUpdateDraft",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/installations/{installationId}/update-drafts`,
    successStatus: 201,
    pathParamsSchema: InstallationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateInstallationUpdateDraftRequestSchema,
    responseBodySchema: InstallationUpdateDraftResponseSchema,
  }),
  getInstallationUpdateDraft: endpoint({
    ...readMetadata,
    operationId: "getInstallationUpdateDraft",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/installation-update-drafts/{updateDraftId}`,
    pathParamsSchema: InstallationUpdateDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: InstallationUpdateDraftResponseSchema,
  }),
  refreshInstallationUpdateDraft: endpoint({
    ...mutationMetadata,
    operationId: "refreshInstallationUpdateDraft",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/installation-update-drafts/{updateDraftId}/refresh`,
    pathParamsSchema: InstallationUpdateDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: InstallationUpdateDraftDecisionRequestSchema,
    responseBodySchema: InstallationUpdateDraftResponseSchema,
  }),
  confirmInstallationUpdateDraft: endpoint({
    ...mutationMetadata,
    operationId: "confirmInstallationUpdateDraft",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/installation-update-drafts/{updateDraftId}/confirm`,
    pathParamsSchema: InstallationUpdateDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: InstallationUpdateDraftDecisionRequestSchema,
    responseBodySchema: InstallationUpdateDraftResponseSchema,
  }),
  keepCurrentInstallationVersion: endpoint({
    ...mutationMetadata,
    operationId: "keepCurrentInstallationVersion",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/installation-update-drafts/{updateDraftId}/keep-current`,
    pathParamsSchema: InstallationUpdateDraftPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: InstallationUpdateDraftDecisionRequestSchema,
    responseBodySchema: InstallationUpdateDraftResponseSchema,
  }),
  createUpload: endpoint({
    ...mutationMetadata,
    operationId: "createUpload",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/uploads`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateUploadRequestSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  importSkillRepository: endpoint({
    ...mutationMetadata,
    operationId: "importSkillRepository",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/uploads/repository`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ImportSkillRepositoryRequestSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  uploadPackage: endpoint({
    ...mutationMetadata,
    operationId: "uploadPackage",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/uploads/{uploadId}/package`,
    pathParamsSchema: UploadPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UploadPackageRequestSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  uploadChunk: endpoint({
    ...mutationMetadata,
    operationId: "uploadChunk",
    method: "PUT",
    path: `${WORKBENCH_API_PREFIX}/uploads/{uploadId}/chunks/{chunkIndex}`,
    pathParamsSchema: UploadChunkPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UploadChunkRequestSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  completeUpload: endpoint({
    ...mutationMetadata,
    operationId: "completeUpload",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/uploads/{uploadId}/complete`,
    pathParamsSchema: UploadPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CompleteUploadRequestSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  getUpload: endpoint({
    ...readMetadata,
    operationId: "getUpload",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/uploads/{uploadId}`,
    pathParamsSchema: UploadPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  promoteUpload: endpoint({
    ...mutationMetadata,
    operationId: "promoteUpload",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/uploads/{uploadId}/promote`,
    pathParamsSchema: UploadPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: PromoteUploadRequestSchema,
    responseBodySchema: UploadResponseSchema,
  }),
  getObject: endpoint({
    ...readMetadata,
    operationId: "getObject",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/objects/{objectId}`,
    pathParamsSchema: ObjectPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ResponseEnvelopeSchema(ProductObjectSchema),
  }),
  listResources: endpoint({
    ...readMetadata,
    operationId: "listResources",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/resources`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: pageQuery,
    responseBodySchema: ResourceListResponseSchema,
  }),
  createResource: endpoint({
    ...mutationMetadata,
    operationId: "createResource",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/resources`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateResourceRequestSchema,
    responseBodySchema: ResourceResponseSchema,
  }),
  createResourceFromAttachment: endpoint({
    ...mutationMetadata,
    operationId: "createResourceFromAttachment",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/resources/from-attachment`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateResourceFromAttachmentRequestSchema,
    responseBodySchema: ResourceResponseSchema,
  }),
  getResource: endpoint({
    ...readMetadata,
    operationId: "getResource",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/resources/{resourceId}`,
    pathParamsSchema: ResourcePathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ResourceResponseSchema,
  }),
  listConnections: endpoint({
    ...readMetadata,
    operationId: "listConnections",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/connections`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: pageQuery,
    responseBodySchema: ListResponseEnvelopeSchema(WorkspaceConnectionPublicSchema),
  }),
  createConnection: endpoint({
    ...connectionMutationMetadata,
    operationId: "createConnection",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/connections`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateConnectionRequestSchema,
    responseBodySchema: ConnectionResponseSchema,
  }),
  getConnection: endpoint({
    ...connectionReadMetadata,
    operationId: "getConnection",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/connections/{connectionId}`,
    pathParamsSchema: ConnectionPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ConnectionResponseSchema,
  }),
  updateConnection: endpoint({
    ...connectionRevisionMutationMetadata,
    operationId: "updateConnection",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/connections/{connectionId}`,
    pathParamsSchema: ConnectionPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UpdateConnectionRequestSchema,
    responseBodySchema: ConnectionResponseSchema,
  }),
  validateConnection: endpoint({
    ...connectionRevisionMutationMetadata,
    operationId: "validateConnection",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/connections/{connectionId}/validate`,
    pathParamsSchema: ConnectionPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ValidateConnectionRequestSchema,
    responseBodySchema: ConnectionResponseSchema,
  }),
  bindConnectionCredential: endpoint({
    ...connectionRevisionMutationMetadata,
    operationId: "bindConnectionCredential",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/connections/{connectionId}/credential-binding`,
    pathParamsSchema: ConnectionPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: BindConnectionCredentialRequestSchema,
    responseBodySchema: ConnectionResponseSchema,
  }),
  cancelRun: WORKBENCH_V1_RUN_ENDPOINTS.cancelRun,
  retryRun: WORKBENCH_V1_RUN_ENDPOINTS.retryRun,
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

export const WORKBENCH_V1_LIFECYCLE_ENDPOINTS:
  typeof WORKBENCH_V1_LIFECYCLE_BASE_ENDPOINTS & typeof WORKBENCH_V1_STAGED_LOOP_ENDPOINTS = Object.assign(
  {},
  WORKBENCH_V1_LIFECYCLE_BASE_ENDPOINTS,
  WORKBENCH_V1_STAGED_LOOP_ENDPOINTS,
);

export function lifecycleEndpointKeys(): readonly string[] {
  return Object.keys(WORKBENCH_V1_LIFECYCLE_ENDPOINTS);
}

export type LifecycleEndpointMetadata = (typeof WORKBENCH_V1_LIFECYCLE_ENDPOINTS)[keyof typeof WORKBENCH_V1_LIFECYCLE_ENDPOINTS];
export type LifecycleEndpointSchema = TSchema;
export { EntityTagSchema, LoopVersionIdSchema };
