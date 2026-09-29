import { Type, type Static } from "typebox";

import { CompileResultSchema } from "./compiler.js";
import {
  CursorPageRequestSchema,
  JsonObjectSchema,
  NodeIdSchema,
  ResourceRefSchema,
  RunIdSchema,
  SkillIdSchema,
  TemplateIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
} from "./common.js";
import {
  EmptyObjectSchema,
  EntityTagResponseHeadersSchema,
  EventCursorHeadersSchema,
  ListResponseEnvelopeSchema,
  MUTATION_ENDPOINT_METADATA,
  MutationRequestEnvelopeSchema,
  READ_ENDPOINT_METADATA,
  ResponseEnvelopeSchema,
  RevisionMutationHeadersSchema,
  WORKBENCH_API_PREFIX,
  type WorkbenchEndpointMetadata,
} from "./endpoint-core.js";
import { SkillMaterialBindingSchema } from "./attachments.js";
import {
  RunEventSchema,
  WorkflowRunSchema,
  WorkflowRunStatusSchema,
} from "./runs.js";
import {
  ReviewDecisionRequestSchema,
  ReviewDecisionResponseSchema,
  RunDetailResponseSchema,
  RunPathParamsSchema,
  WORKBENCH_V1_RUN_ENDPOINTS,
} from "./runs-http.js";
import { strictObject } from "./schema.js";
import {
  SkillDefinitionSchema,
  SkillCatalogItemSchema,
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
import { WORKBENCH_V1_WORKSPACE_ENDPOINTS } from "./workspace-http.js";

export * from "./endpoint-core.js";
export * from "./workspace-http.js";
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
  materialBindings: Type.Optional(
    Type.Array(
      strictObject({
        nodeId: NodeIdSchema,
        binding: SkillMaterialBindingSchema,
      }),
      { maxItems: 128 },
    ),
  ),
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
export const RunEventsPageSchema = strictObject({
  events: Type.Array(RunEventSchema),
  nextSequence: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
});
export const RunEventsResponseSchema = ResponseEnvelopeSchema(
  RunEventsPageSchema,
  "RunEventsResponse",
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

export const SkillListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
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

export const WORKBENCH_V1_ENDPOINTS = {
  workspace: WORKBENCH_V1_WORKSPACE_ENDPOINTS.workspace,
  listSkills: {
    ...READ_ENDPOINT_METADATA,
    operationId: "listSkills",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: SkillListQuerySchema,
    responseBodySchema: SkillListResponseSchema,
  },
  getSkill: {
    ...READ_ENDPOINT_METADATA,
    operationId: "getSkill",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/skills/{skillId}`,
    pathParamsSchema: SkillPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: SkillDetailResponseSchema,
  },
  listTemplates: {
    ...READ_ENDPOINT_METADATA,
    operationId: "listTemplates",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/templates`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: TemplateListQuerySchema,
    responseBodySchema: TemplateListResponseSchema,
  },
  getTemplate: {
    ...READ_ENDPOINT_METADATA,
    operationId: "getTemplate",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/templates/{templateId}`,
    pathParamsSchema: TemplatePathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: TemplateDetailResponseSchema,
  },
  listWorkflows: {
    ...READ_ENDPOINT_METADATA,
    operationId: "listWorkflows",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workflows`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: WorkflowListQuerySchema,
    responseBodySchema: WorkflowListResponseSchema,
  },
  getWorkflow: {
    ...READ_ENDPOINT_METADATA,
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
    ...READ_ENDPOINT_METADATA,
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
    ...MUTATION_ENDPOINT_METADATA,
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
    ...MUTATION_ENDPOINT_METADATA,
    operationId: "compileWorkflow",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/compile`,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CompileWorkflowRequestSchema,
    responseBodySchema: CompileWorkflowResponseSchema,
  },
  startRun: {
    ...MUTATION_ENDPOINT_METADATA,
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
    ...READ_ENDPOINT_METADATA,
    operationId: "listWorkflowRuns",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workflows/{workflowId}/runs`,
    pathParamsSchema: WorkflowPathParamsSchema,
    querySchema: RunHistoryQuerySchema,
    responseBodySchema: RunHistoryResponseSchema,
  },
  getRun: WORKBENCH_V1_RUN_ENDPOINTS.getRun,
  getRunEvents: {
    ...READ_ENDPOINT_METADATA,
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
  submitReviewDecision: WORKBENCH_V1_RUN_ENDPOINTS.submitReviewDecision,
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

export type UseTemplateRequest = Static<typeof UseTemplateRequestSchema>;
export type SaveWorkflowRevisionRequest = Static<
  typeof SaveWorkflowRevisionRequestSchema
>;
export type CompileWorkflowRequest = Static<typeof CompileWorkflowRequestSchema>;
export type StartRunRequest = Static<typeof StartRunRequestSchema>;
export type { ReviewDecisionRequest } from "./runs-http.js";
