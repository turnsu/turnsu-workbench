import { Type } from "typebox";

import {
  EntityTagSchema,
  AutomationIdSchema,
  ScopeIdSchema,
} from "./common.js";
import {
  AutomationBudgetPolicySchema,
  AutomationCandidateSchema,
  AutomationConnectionSelectionSchema,
  AutomationInputBindingSchema,
  AutomationMisfirePolicySchema,
  AutomationOccurrenceSchema,
  AutomationSchema,
  DailyCronTriggerSchema,
} from "./automations.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  IdempotencyHeadersSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  RevisionMutationHeadersSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import { strictObject } from "./schema.js";

const privateReadHeaders = strictObject({
  "Cache-Control": Type.Literal("private, no-store"),
});

const privateReadMetadata = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: privateReadHeaders,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: ["Cache-Control"],
} as const;

const privateEntityReadMetadata = {
  ...privateReadMetadata,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("private, no-store"),
    ETag: EntityTagSchema,
  }),
  responseHeaders: ["Cache-Control", "ETag"],
} as const;

const privateMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: IdempotencyHeadersSchema,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("private, no-store"),
    ETag: EntityTagSchema,
  }),
  requiredRequestHeaders: ["Idempotency-Key"],
  optionalRequestHeaders: [],
  responseHeaders: ["Cache-Control", "ETag"],
} as const;

const privateRevisionMutationMetadata = {
  ...privateMutationMetadata,
  requestHeadersSchema: RevisionMutationHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key", "If-Match"],
} as const;

const ScopePathParamsSchema = strictObject({ scopeId: ScopeIdSchema });
const AutomationPathParamsSchema = strictObject({ automationId: AutomationIdSchema });

const AutomationInputDataSchema = strictObject({
  displayName: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  loopVersionId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  trigger: DailyCronTriggerSchema,
  inputBindings: Type.Array(AutomationInputBindingSchema, { maxItems: 128, uniqueItems: true }),
  connectionBindings: Type.Array(AutomationConnectionSelectionSchema, { maxItems: 128, uniqueItems: true }),
  budgetPolicy: AutomationBudgetPolicySchema,
  misfirePolicy: AutomationMisfirePolicySchema,
  grantExpiresAt: Type.String({ format: "date-time", pattern: "Z$" }),
  grantReviewAt: Type.Optional(Type.Union([
    Type.String({ format: "date-time", pattern: "Z$" }),
    Type.Null(),
  ])),
});

export const CreateAutomationDataSchema = strictObject({
  scopeId: ScopeIdSchema,
  ...AutomationInputDataSchema.properties,
});
export const ReviseAutomationDataSchema = AutomationInputDataSchema;
export const CreateAutomationRequestSchema = MutationRequestEnvelopeSchema(
  CreateAutomationDataSchema,
  "CreateAutomationRequest",
);
export const ReviseAutomationRequestSchema = MutationRequestEnvelopeSchema(
  ReviseAutomationDataSchema,
  "ReviseAutomationRequest",
);
export const AutomationStateTransitionRequestSchema = MutationRequestEnvelopeSchema(
  EmptyObjectSchema,
  "AutomationStateTransitionRequest",
);

const AutomationListQuerySchema = strictObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  status: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("paused"),
    Type.Literal("archived"),
  ])),
});
const AutomationCandidateListQuerySchema = strictObject({
  scopeId: Type.Optional(ScopeIdSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const OccurrenceListQuerySchema = strictObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const AutomationResponseSchema = ResponseEnvelopeSchema(
  AutomationSchema,
  "AutomationResponse",
);
export const AutomationListResponseSchema = ListResponseEnvelopeSchema(
  AutomationSchema,
  "AutomationListResponse",
);
export const AutomationOccurrenceListResponseSchema = ListResponseEnvelopeSchema(
  AutomationOccurrenceSchema,
  "AutomationOccurrenceListResponse",
);
export const AutomationCandidateListResponseSchema = ListResponseEnvelopeSchema(
  AutomationCandidateSchema,
  "AutomationCandidateListResponse",
);

export const WORKBENCH_V1_AUTOMATION_ENDPOINTS = {
  listAutomations: {
    ...privateReadMetadata,
    operationId: "listAutomations",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/automations`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: AutomationListQuerySchema,
    responseBodySchema: AutomationListResponseSchema,
  },
  createAutomation: {
    ...privateMutationMetadata,
    operationId: "createAutomation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/automations`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateAutomationRequestSchema,
    responseBodySchema: AutomationResponseSchema,
  },
  listAutomationCandidates: {
    ...privateReadMetadata,
    operationId: "listAutomationCandidates",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/automations/candidates`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: AutomationCandidateListQuerySchema,
    responseBodySchema: AutomationCandidateListResponseSchema,
  },
  getAutomation: {
    ...privateEntityReadMetadata,
    operationId: "getAutomation",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/automations/{automationId}`,
    pathParamsSchema: AutomationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AutomationResponseSchema,
  },
  reviseAutomation: {
    ...privateRevisionMutationMetadata,
    operationId: "reviseAutomation",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/automations/{automationId}`,
    pathParamsSchema: AutomationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ReviseAutomationRequestSchema,
    responseBodySchema: AutomationResponseSchema,
  },
  activateAutomation: {
    ...privateRevisionMutationMetadata,
    operationId: "activateAutomation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/automations/{automationId}/activate`,
    pathParamsSchema: AutomationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: AutomationStateTransitionRequestSchema,
    responseBodySchema: AutomationResponseSchema,
  },
  pauseAutomation: {
    ...privateRevisionMutationMetadata,
    operationId: "pauseAutomation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/automations/{automationId}/pause`,
    pathParamsSchema: AutomationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: AutomationStateTransitionRequestSchema,
    responseBodySchema: AutomationResponseSchema,
  },
  archiveAutomation: {
    ...privateRevisionMutationMetadata,
    operationId: "archiveAutomation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/automations/{automationId}/archive`,
    pathParamsSchema: AutomationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: AutomationStateTransitionRequestSchema,
    responseBodySchema: AutomationResponseSchema,
  },
  listAutomationOccurrences: {
    ...privateReadMetadata,
    operationId: "listAutomationOccurrences",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/automations/{automationId}/occurrences`,
    pathParamsSchema: AutomationPathParamsSchema,
    querySchema: OccurrenceListQuerySchema,
    responseBodySchema: AutomationOccurrenceListResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
