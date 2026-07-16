import { Type, type Static, type TSchema } from "typebox";

import { CompileResultSchema } from "./compiler.js";
import {
  CursorPageRequestSchema,
  CursorPageSchema,
  EntityTagSchema,
  IdempotencyKeySchema,
  JsonObjectSchema,
  RequestIdSchema,
  ResourceRefSchema,
  RunIdSchema,
  SkillIdSchema,
  TemplateIdSchema,
  UtcTimestampSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceIdSchema,
  WorkbenchApiSchemaVersionSchema,
} from "./common.js";
import {
  ReviewDecisionSchema,
  ReviewDecisionValueSchema,
  RunEventSchema,
  RunReadModelSchema,
  WorkflowRunSchema,
  WorkflowRunStatusSchema,
} from "./runs.js";
import { strictObject } from "./schema.js";
import {
  SkillDefinitionSchema,
  SkillCatalogItemSchema,
  SkillStatusSchema,
} from "./skills.js";
import {
  InputFormSchema,
  OutputDefinitionSchema,
  RunSettingsSchema,
  WorkflowGraphSchema,
  WorkflowRevisionSchema,
  WorkflowSchema,
  WorkflowStatusSchema,
  WorkflowTemplateSchema,
} from "./workflows.js";

export const WORKBENCH_API_PREFIX = "/api/workbench/v1" as const;

export function MutationRequestEnvelopeSchema<const Data extends TSchema>(
  data: Data,
  id?: string,
) {
  return strictObject(
    {
      schemaVersion: WorkbenchApiSchemaVersionSchema,
      data,
    },
    id === undefined ? {} : { $id: id },
  );
}

export function ResponseEnvelopeSchema<const Data extends TSchema>(
  data: Data,
  id?: string,
) {
  return strictObject(
    {
      schemaVersion: WorkbenchApiSchemaVersionSchema,
      data,
      requestId: RequestIdSchema,
    },
    id === undefined ? {} : { $id: id },
  );
}

export function ListResponseEnvelopeSchema<const Item extends TSchema>(
  item: Item,
  id?: string,
) {
  return strictObject(
    {
      schemaVersion: WorkbenchApiSchemaVersionSchema,
      data: Type.Array(item),
      page: CursorPageSchema,
      requestId: RequestIdSchema,
    },
    id === undefined ? {} : { $id: id },
  );
}

export type MutationRequestEnvelope<Data> = {
  schemaVersion: "workbench-api-v1";
  data: Data;
};

export type ResponseEnvelope<Data> = {
  schemaVersion: "workbench-api-v1";
  data: Data;
  requestId: string;
};

export const EmptyObjectSchema = strictObject({});
export const EmptyHeadersSchema = strictObject({});

export const IdempotencyHeadersSchema = strictObject({
  "Idempotency-Key": IdempotencyKeySchema,
});

export const RevisionMutationHeadersSchema = strictObject({
  "Idempotency-Key": IdempotencyKeySchema,
  "If-Match": EntityTagSchema,
});

export const EventCursorHeadersSchema = strictObject({
  "Last-Event-ID": Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
});

export const EntityTagResponseHeadersSchema = strictObject({
  ETag: EntityTagSchema,
});

export const WorkspaceCapabilitiesSchema = strictObject({
  builderProposal: Type.Literal(false),
  resources: Type.Literal(false),
  maxParallelism: Type.Literal(1),
});

export const WorkspaceSchema = strictObject({
  workspaceId: WorkspaceIdSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  capabilities: WorkspaceCapabilitiesSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});

export const WorkspaceSessionSchema = strictObject({
  csrfToken: Type.String({ minLength: 32, maxLength: 256 }),
  expiresAt: UtcTimestampSchema,
});

export const WorkspaceBootstrapSchema = strictObject({
  workspace: WorkspaceSchema,
  session: WorkspaceSessionSchema,
});

export const WorkspaceResponseSchema = ResponseEnvelopeSchema(
  WorkspaceBootstrapSchema,
  "WorkspaceResponse",
);
export const SkillListResponseSchema = ListResponseEnvelopeSchema(
  SkillCatalogItemSchema,
  "SkillListResponse",
);
export const SkillDetailResponseSchema = ResponseEnvelopeSchema(
  SkillCatalogItemSchema,
  "SkillDetailResponse",
);
export const TemplateListResponseSchema = ListResponseEnvelopeSchema(
  WorkflowTemplateSchema,
  "TemplateListResponse",
);
export const TemplateDetailResponseSchema = ResponseEnvelopeSchema(
  WorkflowTemplateSchema,
  "TemplateDetailResponse",
);
export const WorkflowListResponseSchema = ListResponseEnvelopeSchema(
  WorkflowSchema,
  "WorkflowListResponse",
);
export const WorkflowDetailResponseSchema = ResponseEnvelopeSchema(
  WorkflowSchema,
  "WorkflowDetailResponse",
);
export const WorkflowRevisionResponseSchema = ResponseEnvelopeSchema(
  WorkflowRevisionSchema,
  "WorkflowRevisionResponse",
);

export const UseTemplateDataSchema = strictObject({
  templateVersion: Type.String({ minLength: 1, maxLength: 64 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
});
export const UseTemplateRequestSchema = MutationRequestEnvelopeSchema(
  UseTemplateDataSchema,
  "UseTemplateRequest",
);
export const UseTemplateResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    workflow: WorkflowSchema,
    revision: WorkflowRevisionSchema,
  }),
  "UseTemplateResponse",
);

export const SaveWorkflowRevisionDataSchema = strictObject({
  baseRevisionId: WorkflowRevisionIdSchema,
  graph: WorkflowGraphSchema,
  inputForm: InputFormSchema,
  outputDefinition: OutputDefinitionSchema,
  resourceRefs: Type.Array(ResourceRefSchema),
  runSettings: RunSettingsSchema,
  saveReason: Type.String({ minLength: 1, maxLength: 1000 }),
});
export const SaveWorkflowRevisionRequestSchema = MutationRequestEnvelopeSchema(
  SaveWorkflowRevisionDataSchema,
  "SaveWorkflowRevisionRequest",
);
export const SaveWorkflowRevisionResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    workflow: WorkflowSchema,
    revision: WorkflowRevisionSchema,
  }),
  "SaveWorkflowRevisionResponse",
);

export const CompileWorkflowDataSchema = strictObject({
  workflowRevisionId: WorkflowRevisionIdSchema,
});
export const CompileWorkflowRequestSchema = MutationRequestEnvelopeSchema(
  CompileWorkflowDataSchema,
  "CompileWorkflowRequest",
);
export const CompileWorkflowResponseSchema = ResponseEnvelopeSchema(
  CompileResultSchema,
  "CompileWorkflowResponse",
);

export const StartRunDataSchema = strictObject({
  workflowRevisionId: WorkflowRevisionIdSchema,
  inputs: JsonObjectSchema,
  resourceRefs: Type.Array(ResourceRefSchema),
});
export const StartRunRequestSchema = MutationRequestEnvelopeSchema(
  StartRunDataSchema,
  "StartRunRequest",
);
export const StartRunResponseSchema = ResponseEnvelopeSchema(
  WorkflowRunSchema,
  "StartRunResponse",
);
export const RunHistoryResponseSchema = ListResponseEnvelopeSchema(
  WorkflowRunSchema,
  "RunHistoryResponse",
);
export const RunDetailResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    run: WorkflowRunSchema,
    readModel: RunReadModelSchema,
  }),
  "RunDetailResponse",
);

export const RunEventsPageSchema = strictObject({
  events: Type.Array(RunEventSchema),
  nextSequence: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
});
export const RunEventsResponseSchema = ResponseEnvelopeSchema(
  RunEventsPageSchema,
  "RunEventsResponse",
);

export const ReviewDecisionDataSchema = strictObject({
  nodeId: Type.String({ minLength: 1, maxLength: 128 }),
  decision: ReviewDecisionValueSchema,
  comment: Type.Optional(Type.String({ maxLength: 4000 })),
  requestedChanges: Type.Array(
    Type.String({ minLength: 1, maxLength: 1000 }),
  ),
});
export const ReviewDecisionRequestSchema = MutationRequestEnvelopeSchema(
  ReviewDecisionDataSchema,
  "ReviewDecisionRequest",
);
export const ReviewDecisionResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    decision: ReviewDecisionSchema,
    run: WorkflowRunSchema,
  }),
  "ReviewDecisionResponse",
);

export const SkillPathParamsSchema = strictObject({ skillId: SkillIdSchema });
export const TemplatePathParamsSchema = strictObject({
  templateId: TemplateIdSchema,
});
export const WorkflowPathParamsSchema = strictObject({
  workflowId: WorkflowIdSchema,
});
export const WorkflowRevisionPathParamsSchema = strictObject({
  workflowId: WorkflowIdSchema,
  revisionId: WorkflowRevisionIdSchema,
});
export const RunPathParamsSchema = strictObject({ runId: RunIdSchema });

export const SkillListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  status: Type.Optional(SkillStatusSchema),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});
export const TemplateListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});
export const WorkflowListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  status: Type.Optional(WorkflowStatusSchema),
  archived: Type.Optional(Type.Boolean()),
});
export const RunHistoryQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  status: Type.Optional(WorkflowRunStatusSchema),
});
export const RunEventsQuerySchema = strictObject({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
});

export interface WorkbenchEndpointMetadata {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `${typeof WORKBENCH_API_PREFIX}${string}`;
  mutation: boolean;
  successStatus: 200 | 201 | 202;
  responseMediaType:
    | "application/json"
    | "text/event-stream"
    | "application/vnd.looloomi.loop-package+json";
  pathParamsSchema: TSchema;
  querySchema: TSchema;
  requestHeadersSchema: TSchema;
  requestBodySchema?: TSchema;
  responseBodySchema: TSchema;
  responseHeadersSchema: TSchema;
  requiredRequestHeaders: readonly string[];
  optionalRequestHeaders: readonly string[];
  responseHeaders: readonly string[];
}

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

export const WORKBENCH_V1_ENDPOINTS = {
  workspace: {
    ...readMetadata,
    operationId: "workspace",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workspace`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: WorkspaceResponseSchema,
  },
  listSkills: {
    ...readMetadata,
    operationId: "listSkills",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: SkillListQuerySchema,
    responseBodySchema: SkillListResponseSchema,
  },
  getSkill: {
    ...readMetadata,
    operationId: "getSkill",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}`,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillDetailResponseSchema,
  },
  listTemplates: {
    ...readMetadata,
    operationId: "listTemplates",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/templates`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: TemplateListQuerySchema,
    responseBodySchema: TemplateListResponseSchema,
  },
  getTemplate: {
    ...readMetadata,
    operationId: "getTemplate",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/templates/{templateId}`,
    pathParamsSchema: TemplatePathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: TemplateDetailResponseSchema,
  },
  useTemplate: {
    ...mutationMetadata,
    operationId: "useTemplate",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/templates/{templateId}/workflows`,
    successStatus: 201,
    pathParamsSchema: TemplatePathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UseTemplateRequestSchema,
    responseBodySchema: UseTemplateResponseSchema,
  },
  listWorkflows: {
    ...readMetadata,
    operationId: "listWorkflows",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workflows`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: WorkflowListQuerySchema,
    responseBodySchema: WorkflowListResponseSchema,
  },
  getWorkflow: {
    ...readMetadata,
    operationId: "getWorkflow",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}`,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: WorkflowDetailResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  },
  getWorkflowRevision: {
    ...readMetadata,
    operationId: "getWorkflowRevision",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/revisions/{revisionId}`,
    pathParamsSchema: WorkflowRevisionPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: WorkflowRevisionResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    responseHeaders: ["ETag"],
  },
  saveWorkflowRevision: {
    ...mutationMetadata,
    operationId: "saveWorkflowRevision",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/revisions`,
    successStatus: 201,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestHeadersSchema: RevisionMutationHeadersSchema,
    requestBodySchema: SaveWorkflowRevisionRequestSchema,
    responseBodySchema: SaveWorkflowRevisionResponseSchema,
    responseHeadersSchema: EntityTagResponseHeadersSchema,
    requiredRequestHeaders: ["Idempotency-Key", "If-Match"],
    responseHeaders: ["ETag"],
  },
  compileWorkflow: {
    ...mutationMetadata,
    operationId: "compileWorkflow",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/compile`,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CompileWorkflowRequestSchema,
    responseBodySchema: CompileWorkflowResponseSchema,
  },
  startRun: {
    ...mutationMetadata,
    operationId: "startRun",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/runs`,
    successStatus: 202,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: StartRunRequestSchema,
    responseBodySchema: StartRunResponseSchema,
  },
  listWorkflowRuns: {
    ...readMetadata,
    operationId: "listWorkflowRuns",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/runs`,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: RunHistoryQuerySchema,
    responseBodySchema: RunHistoryResponseSchema,
  },
  getRun: {
    ...readMetadata,
    operationId: "getRun",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}`,
    pathParamsSchema: RunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: RunDetailResponseSchema,
  },
  getRunEvents: {
    ...readMetadata,
    operationId: "getRunEvents",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/events`,
    responseMediaType: "text/event-stream",
    pathParamsSchema: RunPathParamsSchema,
    querySchema: RunEventsQuerySchema,
    requestHeadersSchema: EventCursorHeadersSchema,
    responseBodySchema: RunEventSchema,
    optionalRequestHeaders: ["Last-Event-ID"],
  },
  submitReviewDecision: {
    ...mutationMetadata,
    operationId: "submitReviewDecision",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/review-decisions`,
    pathParamsSchema: RunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ReviewDecisionRequestSchema,
    responseBodySchema: ReviewDecisionResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

export type Workspace = Static<typeof WorkspaceSchema>;
export type UseTemplateRequest = Static<typeof UseTemplateRequestSchema>;
export type SaveWorkflowRevisionRequest = Static<
  typeof SaveWorkflowRevisionRequestSchema
>;
export type CompileWorkflowRequest = Static<typeof CompileWorkflowRequestSchema>;
export type StartRunRequest = Static<typeof StartRunRequestSchema>;
export type ReviewDecisionRequest = Static<typeof ReviewDecisionRequestSchema>;
