import { Type } from "typebox";

import {
  AgentBranchIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  ExecutionAttemptIdSchema,
  InvocationIdSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
  RunIdSchema,
} from "./common.js";
import {
  AgentDefinitionSchema,
  AgentHandoffSchema,
  AgentObjectKindSchema,
  AgentSessionEventSchema,
  AgentSessionSchema,
  AgentMessageTurnInputSchema,
  AgentTurnSchema,
  ImageGenerationModelTaskInputSchema,
} from "./agents.js";
import { ArtifactRefSchema } from "./artifacts.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  IdempotencyHeadersSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./http.js";
import {
  ExecutionEventSchema,
  ExecutionIsolationSchema,
  ExecutionModeSchema,
  ExecutionStatusSchema,
} from "./execution.js";
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

export const CreateAgentSessionRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  definitionId: Type.String({ minLength: 1, maxLength: 128 }),
  lastUsedModelProfileId: Type.Optional(ModelProfileIdSchema),
  objectKind: Type.Optional(AgentObjectKindSchema),
  objectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  branchId: Type.Optional(AgentBranchIdSchema),
}), "CreateAgentSessionRequest");

export const AgentMessageTurnRequestDataSchema = strictObject({
  kind: Type.Literal("agent_message"),
  modelProfileRevisionId: ModelProfileRevisionIdSchema,
  input: AgentMessageTurnInputSchema,
});

export const ModelTaskTurnRequestDataSchema = strictObject({
  kind: Type.Literal("model_task"),
  modelProfileRevisionId: ModelProfileRevisionIdSchema,
  input: ImageGenerationModelTaskInputSchema,
});

export const AgentTurnRequestDataSchema = Type.Union([
  AgentMessageTurnRequestDataSchema,
  ModelTaskTurnRequestDataSchema,
]);

export const CreateAgentTurnRequestSchema = MutationRequestEnvelopeSchema(
  AgentTurnRequestDataSchema,
  "CreateAgentTurnRequest",
);

export const CancelAgentTurnRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
}), "CancelAgentTurnRequest");

export const ConfirmAgentHandoffRequestSchema = MutationRequestEnvelopeSchema(strictObject({}), "ConfirmAgentHandoffRequest");

export const AgentDefinitionListResponseSchema = ListResponseEnvelopeSchema(AgentDefinitionSchema, "AgentDefinitionListResponse");
export const AgentSessionResponseSchema = ResponseEnvelopeSchema(AgentSessionSchema, "AgentSessionResponse");
export const AgentTurnResponseSchema = ResponseEnvelopeSchema(AgentTurnSchema, "AgentTurnResponse");
export const AgentTurnListResponseSchema = ListResponseEnvelopeSchema(AgentTurnSchema, "AgentTurnListResponse");
export const AgentSessionEventListResponseSchema = ListResponseEnvelopeSchema(AgentSessionEventSchema, "AgentSessionEventListResponse");
export const AgentHandoffListResponseSchema = ListResponseEnvelopeSchema(AgentHandoffSchema, "AgentHandoffListResponse");
export const AgentHandoffResponseSchema = ResponseEnvelopeSchema(AgentHandoffSchema, "AgentHandoffResponse");

export const ExecutionInvocationSummarySchema = strictObject({
  invocationId: InvocationIdSchema,
  attemptId: ExecutionAttemptIdSchema,
  mode: ExecutionModeSchema,
  isolation: ExecutionIsolationSchema,
  status: ExecutionStatusSchema,
  requestedModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
  actualModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
  artifactRefs: Type.Array(ArtifactRefSchema, { uniqueItems: true, maxItems: 256 }),
  createdAt: Type.String({ format: "date-time", pattern: "Z$" }),
  startedAt: Type.Union([Type.String({ format: "date-time", pattern: "Z$" }), Type.Null()]),
  finishedAt: Type.Union([Type.String({ format: "date-time", pattern: "Z$" }), Type.Null()]),
});
export const ExecutionInvocationListResponseSchema = ListResponseEnvelopeSchema(ExecutionInvocationSummarySchema, "ExecutionInvocationListResponse");
export const ExecutionEventListResponseSchema = ListResponseEnvelopeSchema(ExecutionEventSchema, "ExecutionEventListResponse");

const AgentSessionPathSchema = strictObject({ sessionId: AgentSessionIdSchema });
const AgentTurnPathSchema = strictObject({ sessionId: AgentSessionIdSchema, turnId: AgentTurnIdSchema });
const AgentHandoffPathSchema = strictObject({ sessionId: AgentSessionIdSchema, handoffId: Type.String({ minLength: 1, maxLength: 128 }) });
const RunPathSchema = strictObject({ runId: RunIdSchema });
const AfterQuerySchema = strictObject({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) });

export const WORKBENCH_V1_AGENT_ENDPOINTS = {
  listAgentDefinitions: {
    ...readMetadata,
    operationId: "listAgentDefinitions",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-definitions`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AgentDefinitionListResponseSchema,
  },
  createAgentSession: {
    ...mutationMetadata,
    operationId: "createAgentSession",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateAgentSessionRequestSchema,
    responseBodySchema: AgentSessionResponseSchema,
  },
  getAgentSession: {
    ...readMetadata,
    operationId: "getAgentSession",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AgentSessionResponseSchema,
  },
  createAgentTurn: {
    ...mutationMetadata,
    operationId: "createAgentTurn",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/turns`,
    successStatus: 202,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateAgentTurnRequestSchema,
    responseBodySchema: AgentTurnResponseSchema,
  },
  listAgentTurns: {
    ...readMetadata,
    operationId: "listAgentTurns",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/turns`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: AfterQuerySchema,
    responseBodySchema: AgentTurnListResponseSchema,
  },
  getAgentTurn: {
    ...readMetadata,
    operationId: "getAgentTurn",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/turns/{turnId}`,
    pathParamsSchema: AgentTurnPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AgentTurnResponseSchema,
  },
  cancelAgentTurn: {
    ...mutationMetadata,
    operationId: "cancelAgentTurn",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/turns/{turnId}/cancel`,
    successStatus: 202,
    pathParamsSchema: AgentTurnPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CancelAgentTurnRequestSchema,
    responseBodySchema: AgentTurnResponseSchema,
  },
  listAgentSessionEvents: {
    ...readMetadata,
    operationId: "listAgentSessionEvents",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/events`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: AfterQuerySchema,
    responseBodySchema: AgentSessionEventListResponseSchema,
  },
  listAgentHandoffs: {
    ...readMetadata,
    operationId: "listAgentHandoffs",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/handoffs`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AgentHandoffListResponseSchema,
  },
  confirmAgentHandoff: {
    ...mutationMetadata,
    operationId: "confirmAgentHandoff",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/handoffs/{handoffId}/confirm`,
    pathParamsSchema: AgentHandoffPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ConfirmAgentHandoffRequestSchema,
    responseBodySchema: AgentHandoffResponseSchema,
  },
  listRunInvocations: {
    ...readMetadata,
    operationId: "listRunInvocations",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/invocations`,
    pathParamsSchema: RunPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ExecutionInvocationListResponseSchema,
  },
  listRunExecutionEvents: {
    ...readMetadata,
    operationId: "listRunExecutionEvents",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/execution-events`,
    pathParamsSchema: RunPathSchema,
    querySchema: AfterQuerySchema,
    responseBodySchema: ExecutionEventListResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
