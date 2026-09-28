import { Type } from "typebox";

import {
  AgentSessionIdSchema,
  CursorPageRequestSchema,
  ProjectIdSchema,
  WorkItemAccessGrantIdSchema,
  WorkItemIdSchema,
  WorkThreadEntryIdSchema,
  WorkflowIdSchema,
  RunIdSchema,
  UserIdSchema,
  JsonObjectSchema,
  UtcTimestampSchema,
  ReleaseIdSchema,
  LoopVersionIdSchema,
} from "./common.js";
import { StartRunDataSchema } from "./http.js";
import { FinalAnswerSchema, WorkflowRunStatusSchema } from "./runs.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  IdempotencyHeadersSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import {
  PromoteAgentSessionToWorkItemDataSchema,
  CreateWorkItemThreadCommentDataSchema,
  CreateWorkItemContinuationAgentEntryDataSchema,
  CreateProjectDataSchema,
  CreateTeamWorkItemAgentEntryDataSchema,
  CreateTeamWorkItemDataSchema,
  ProjectSchema,
  ProjectFileHeadSchema, ProjectFileContentSchema, CommitProjectFileDataSchema, ProjectFileCommitSchema,
  ReviseProjectMembersDataSchema,
  UpdateTeamWorkItemDataSchema,
  SubmitWorkItemResultDataSchema,
  ReviewWorkItemResultDataSchema,
  WorkItemAccessGrantSchema,
  WorkItemContinuationSchema,
  WorkItemDecisionInputSchema,
  WorkItemDecisionSchema,
  WorkItemDetailSchema,
  WorkItemPromotionParticipantSchema,
  WorkItemPromotionSchema,
  WorkItemSchema,
  TeamWorkItemAgentEntrySchema,
  WorkItemContinuationAgentEntrySchema,
  WorkThreadEntrySchema,
} from "./work-items.js";
import { strictObject } from "./schema.js";

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

const noStoreHeaders = strictObject({
  "Cache-Control": Type.Literal("no-store"),
});

const privateReadMetadata = {
  ...readMetadata,
  responseHeadersSchema: noStoreHeaders,
  responseHeaders: ["Cache-Control"],
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

const AgentSessionPathSchema = strictObject({ sessionId: AgentSessionIdSchema });
const WorkItemPathSchema = strictObject({ workItemId: WorkItemIdSchema });

export const WorkItemWorkflowRunSchema = strictObject({
  workItemId: WorkItemIdSchema, runId: RunIdSchema, requestedByUserId: UserIdSchema,
  workflowName: Type.String({ minLength: 1, maxLength: 200 }),
  status: WorkflowRunStatusSchema, inputs: JsonObjectSchema,
  sourceReleaseId: Type.Union([ReleaseIdSchema, Type.Null()]),
  sourceVersionId: Type.Union([LoopVersionIdSchema, Type.Null()]),
  finalAnswer: Type.Union([FinalAnswerSchema, Type.Null()]),
  createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema,
});
export const StartWorkItemLoopRunRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  ...StartRunDataSchema.properties,
  workflowId: WorkflowIdSchema,
  shareFinalOutput: Type.Literal(true),
}), "StartWorkItemLoopRunRequest");
const ProjectPathSchema = strictObject({ projectId: ProjectIdSchema });
const WorkItemAccessGrantPathSchema = strictObject({
  workItemId: WorkItemIdSchema,
  grantId: WorkItemAccessGrantIdSchema,
});

export const PromoteAgentSessionToWorkItemRequestSchema = MutationRequestEnvelopeSchema(
  PromoteAgentSessionToWorkItemDataSchema,
  "PromoteAgentSessionToWorkItemRequest",
);

export const RevokeWorkItemAccessGrantRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({}),
  "RevokeWorkItemAccessGrantRequest",
);

export const CreateWorkItemContinuationRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({}),
  "CreateWorkItemContinuationRequest",
);

export const CreateWorkItemContinuationAgentEntryRequestSchema = MutationRequestEnvelopeSchema(
  CreateWorkItemContinuationAgentEntryDataSchema,
  "CreateWorkItemContinuationAgentEntryRequest",
);

export const CreateWorkItemThreadCommentRequestSchema = MutationRequestEnvelopeSchema(
  CreateWorkItemThreadCommentDataSchema,
  "CreateWorkItemThreadCommentRequest",
);

export const RecordWorkItemDecisionRequestSchema = MutationRequestEnvelopeSchema(
  WorkItemDecisionInputSchema,
  "RecordWorkItemDecisionRequest",
);
export const CreateProjectRequestSchema = MutationRequestEnvelopeSchema(
  CreateProjectDataSchema,
  "CreateProjectRequest",
);
export const ReviseProjectMembersRequestSchema = MutationRequestEnvelopeSchema(
  ReviseProjectMembersDataSchema,
  "ReviseProjectMembersRequest",
);
export const CreateTeamWorkItemRequestSchema = MutationRequestEnvelopeSchema(
  CreateTeamWorkItemDataSchema,
  "CreateTeamWorkItemRequest",
);
export const CreateTeamWorkItemAgentEntryRequestSchema = MutationRequestEnvelopeSchema(
  CreateTeamWorkItemAgentEntryDataSchema,
  "CreateTeamWorkItemAgentEntryRequest",
);
export const UpdateTeamWorkItemRequestSchema = MutationRequestEnvelopeSchema(
  UpdateTeamWorkItemDataSchema,
  "UpdateTeamWorkItemRequest",
);

const privateMutationMetadata = {
  ...mutationMetadata,
  responseHeadersSchema: noStoreHeaders,
  responseHeaders: ["Cache-Control"],
} as const;

const privateEntityMutationMetadata = {
  ...privateMutationMetadata,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("no-store"),
    ETag: Type.String({ minLength: 3, maxLength: 256 }),
  }),
  responseHeaders: ["Cache-Control", "ETag"],
} as const;

const privateEntityReadMetadata = {
  ...privateReadMetadata,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("no-store"),
    ETag: Type.String({ minLength: 3, maxLength: 256 }),
  }),
  responseHeaders: ["Cache-Control", "ETag"],
} as const;

const privateRevisionMutationMetadata = {
  ...privateMutationMetadata,
  requestHeadersSchema: strictObject({
    "Idempotency-Key": IdempotencyHeadersSchema.properties["Idempotency-Key"],
    "If-Match": Type.String({ minLength: 3, maxLength: 256 }),
  }),
  requiredRequestHeaders: ["Idempotency-Key", "If-Match"],
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("no-store"),
    ETag: Type.String({ minLength: 3, maxLength: 256 }),
  }),
  responseHeaders: ["Cache-Control", "ETag"],
} as const;

const ProjectListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("archived")])),
});
const WorkItemListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  projectId: Type.Optional(ProjectIdSchema),
  status: Type.Optional(Type.Union([
    Type.Literal("draft"),
    Type.Literal("ready"),
    Type.Literal("active"),
    Type.Literal("waiting_review"),
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("cancelled"),
  ])),
});
const WorkItemReferenceQuerySchema = strictObject({
  targetWorkItemId: Type.Optional(WorkItemIdSchema),
});

export const WORKBENCH_V1_WORK_ITEM_ENDPOINTS = {
  listProjectFiles: {
    ...privateReadMetadata, operationId: "listProjectFiles", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/projects/{projectId}/files`, pathParamsSchema: ProjectPathSchema,
    querySchema: CursorPageRequestSchema, responseBodySchema: ListResponseEnvelopeSchema(ProjectFileHeadSchema, "ProjectFilesResponse"),
  },
  readProjectFile: {
    ...privateReadMetadata, operationId: "readProjectFile", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/projects/{projectId}/files/{revisionId}`,
    pathParamsSchema: strictObject({ projectId: ProjectIdSchema, revisionId: Type.String({ minLength: 1, maxLength: 128 }) }),
    querySchema: EmptyObjectSchema, responseBodySchema: ResponseEnvelopeSchema(ProjectFileContentSchema, "ProjectFileContentResponse"),
  },
  commitProjectFile: {
    ...mutationMetadata, responseHeadersSchema: noStoreHeaders, responseHeaders: ["Cache-Control"],
    operationId: "commitProjectFile", method: "POST",
    path: `${WORKBENCH_API_PREFIX}/projects/{projectId}/files`, pathParamsSchema: ProjectPathSchema, querySchema: EmptyObjectSchema,
    requestBodySchema: MutationRequestEnvelopeSchema(CommitProjectFileDataSchema, "CommitProjectFileRequest"),
    responseBodySchema: ResponseEnvelopeSchema(ProjectFileCommitSchema, "CommitProjectFileResponse"),
  },
  listProjects: {
    ...privateReadMetadata,
    operationId: "listProjects",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/projects`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: ProjectListQuerySchema,
    responseBodySchema: ListResponseEnvelopeSchema(ProjectSchema, "ProjectListResponse"),
  },
  createProject: {
    ...privateEntityMutationMetadata,
    operationId: "createProject",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/projects`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateProjectRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(ProjectSchema, "CreateProjectResponse"),
  },
  getProject: {
    ...privateEntityReadMetadata,
    operationId: "getProject",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/projects/{projectId}`,
    pathParamsSchema: ProjectPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ResponseEnvelopeSchema(ProjectSchema, "ProjectResponse"),
  },
  reviseProjectMembers: {
    ...privateRevisionMutationMetadata,
    operationId: "reviseProjectMembers",
    method: "PUT",
    path: `${WORKBENCH_API_PREFIX}/projects/{projectId}/members`,
    pathParamsSchema: ProjectPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ReviseProjectMembersRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(ProjectSchema, "ReviseProjectMembersResponse"),
  },
  listWorkItems: {
    ...privateReadMetadata,
    operationId: "listWorkItems",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/work-items`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: WorkItemListQuerySchema,
    responseBodySchema: ListResponseEnvelopeSchema(WorkItemSchema, "WorkItemListResponse"),
  },
  createTeamWorkItem: {
    ...privateEntityMutationMetadata,
    operationId: "createTeamWorkItem",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateTeamWorkItemRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(WorkItemSchema, "CreateTeamWorkItemResponse"),
  },
  createTeamWorkItemAgentEntry: {
    ...privateEntityMutationMetadata,
    operationId: "createTeamWorkItemAgentEntry",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/agent-entry`,
    successStatus: 202,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateTeamWorkItemAgentEntryRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      TeamWorkItemAgentEntrySchema,
      "CreateTeamWorkItemAgentEntryResponse",
    ),
  },
  submitWorkItemResult: {
    ...privateRevisionMutationMetadata, operationId: "submitWorkItemResult", method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/results`,
    pathParamsSchema: WorkItemPathSchema, querySchema: EmptyObjectSchema,
    requestBodySchema: MutationRequestEnvelopeSchema(SubmitWorkItemResultDataSchema),
    responseBodySchema: ResponseEnvelopeSchema(WorkItemDetailSchema),
  },
  reviewWorkItemResult: {
    ...privateRevisionMutationMetadata, operationId: "reviewWorkItemResult", method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/results/{submissionId}/review`,
    pathParamsSchema: strictObject({...WorkItemPathSchema.properties, submissionId: Type.String({minLength:1,maxLength:128,pattern:"^[A-Za-z0-9][A-Za-z0-9._:-]*$"})}), querySchema: EmptyObjectSchema,
    requestBodySchema: MutationRequestEnvelopeSchema(ReviewWorkItemResultDataSchema),
    responseBodySchema: ResponseEnvelopeSchema(WorkItemDetailSchema),
  },
  updateTeamWorkItem: {
    ...privateRevisionMutationMetadata,
    operationId: "updateTeamWorkItem",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}`,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UpdateTeamWorkItemRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(WorkItemSchema, "UpdateTeamWorkItemResponse"),
  },
  listWorkItemLoopRuns: {
    ...privateReadMetadata, operationId: "listWorkItemLoopRuns", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/loop-runs`,
    pathParamsSchema: WorkItemPathSchema, querySchema: EmptyObjectSchema,
    responseBodySchema: ListResponseEnvelopeSchema(WorkItemWorkflowRunSchema, "WorkItemLoopRunListResponse"),
  },
  startWorkItemLoopRun: {
    ...privateMutationMetadata, operationId: "startWorkItemLoopRun", method: "POST", successStatus: 202,
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/loop-runs`,
    pathParamsSchema: WorkItemPathSchema, querySchema: EmptyObjectSchema,
    requestBodySchema: StartWorkItemLoopRunRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(strictObject({ workItemId: WorkItemIdSchema, runId: RunIdSchema }), "StartWorkItemLoopRunResponse"),
  },
  promoteAgentSessionToWorkItem: {
    ...mutationMetadata,
    operationId: "promoteAgentSessionToWorkItem",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/promote-to-work-item`,
    successStatus: 201,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: PromoteAgentSessionToWorkItemRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      WorkItemPromotionSchema,
      "PromoteAgentSessionToWorkItemResponse",
    ),
  },
  listWorkItemPromotionParticipants: {
    ...privateReadMetadata,
    operationId: "listWorkItemPromotionParticipants",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/work-items/promotion-participants`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ListResponseEnvelopeSchema(
      WorkItemPromotionParticipantSchema,
      "WorkItemPromotionParticipantListResponse",
    ),
  },
  getWorkItem: {
    ...privateEntityReadMetadata,
    operationId: "getWorkItem",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}`,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: WorkItemReferenceQuerySchema,
    responseBodySchema: ResponseEnvelopeSchema(WorkItemDetailSchema, "WorkItemDetailResponse"),
  },
  getWorkItemThreadEntry: {
    ...privateReadMetadata, operationId: "getWorkItemThreadEntry", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/thread-entries/{entryId}`,
    pathParamsSchema: strictObject({...WorkItemPathSchema.properties, entryId:WorkThreadEntryIdSchema}),
    querySchema: WorkItemReferenceQuerySchema,
    responseBodySchema: ResponseEnvelopeSchema(WorkThreadEntrySchema, "WorkItemThreadEntryResponse"),
  },
  listWorkItemThreadEntries: {
    ...privateReadMetadata,
    operationId: "listWorkItemThreadEntries",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/thread-entries`,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: strictObject({ ...CursorPageRequestSchema.properties,
      ...WorkItemReferenceQuerySchema.properties,
      order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
    }),
    responseBodySchema: ListResponseEnvelopeSchema(
      WorkThreadEntrySchema,
      "WorkItemThreadEntryListResponse",
    ),
  },
  createWorkItemThreadComment: {
    ...privateMutationMetadata,
    operationId: "createWorkItemThreadComment",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/thread-entries`,
    successStatus: 201,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateWorkItemThreadCommentRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      WorkThreadEntrySchema,
      "CreateWorkItemThreadCommentResponse",
    ),
  },
  recordWorkItemDecision: {
    ...privateMutationMetadata,
    operationId: "recordWorkItemDecision",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/decisions`,
    successStatus: 201,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RecordWorkItemDecisionRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      WorkItemDecisionSchema,
      "RecordWorkItemDecisionResponse",
    ),
  },
  createWorkItemContinuation: {
    ...privateMutationMetadata,
    operationId: "createWorkItemContinuation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/continuations`,
    successStatus: 201,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateWorkItemContinuationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      WorkItemContinuationSchema,
      "CreateWorkItemContinuationResponse",
    ),
  },
  createWorkItemContinuationAgentEntry: {
    ...privateMutationMetadata,
    operationId: "createWorkItemContinuationAgentEntry",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/agent-entry`,
    successStatus: 202,
    pathParamsSchema: WorkItemPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateWorkItemContinuationAgentEntryRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      WorkItemContinuationAgentEntrySchema,
      "CreateWorkItemContinuationAgentEntryResponse",
    ),
  },
  revokeWorkItemAccessGrant: {
    ...mutationMetadata,
    operationId: "revokeWorkItemAccessGrant",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/work-items/{workItemId}/access-grants/{grantId}/revoke`,
    pathParamsSchema: WorkItemAccessGrantPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RevokeWorkItemAccessGrantRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      WorkItemAccessGrantSchema,
      "RevokeWorkItemAccessGrantResponse",
    ),
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
