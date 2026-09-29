import { Type } from "typebox";

import {
  AgentBranchIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
  CursorPageRequestSchema,
  ExecutionAttemptIdSchema,
  InvocationIdSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
  ProposalIdSchema,
  RunIdSchema,
} from "./common.js";
import { AgentSessionQueueReadModelSchema } from "./coordination.js";
import {
  AgentDefinitionSchema,
  AgentHandoffSchema,
  AgentObjectProposalSchema,
  AgentObjectKindSchema,
  AgentSessionEventSchema,
  AgentSessionSchema,
  AgentTaskStatusSchema,
  AgentMessageTurnInputSchema,
  AgentTurnSchema,
  AgentTurnUsageSchema,
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
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  lastUsedModelProfileId: Type.Optional(ModelProfileIdSchema),
  objectKind: Type.Optional(AgentObjectKindSchema),
  objectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  branchId: Type.Optional(AgentBranchIdSchema),
}), "CreateAgentSessionRequest");

export const UpdateAgentSessionRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" })),
  archived: Type.Optional(Type.Boolean()),
}, { minProperties: 1 }), "UpdateAgentSessionRequest");

export const AgentMessageTurnRequestDataSchema = strictObject({
  kind: Type.Literal("agent_message"),
  modelProfileId: ModelProfileIdSchema,
  input: AgentMessageTurnInputSchema,
});

export const ModelTaskTurnRequestDataSchema = strictObject({
  kind: Type.Literal("model_task"),
  modelProfileId: ModelProfileIdSchema,
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

export const DecideAgentToolApprovalRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
}), "DecideAgentToolApprovalRequest");

export const ConfirmAgentHandoffRequestSchema = MutationRequestEnvelopeSchema(strictObject({}), "ConfirmAgentHandoffRequest");
export const DecideAgentProposalRequestSchema = MutationRequestEnvelopeSchema(strictObject({}), "DecideAgentProposalRequest");

export const AgentDefinitionListResponseSchema = ListResponseEnvelopeSchema(AgentDefinitionSchema, "AgentDefinitionListResponse");
export const AgentSessionResponseSchema = ResponseEnvelopeSchema(AgentSessionSchema, "AgentSessionResponse");
export const AgentSessionQueueResponseSchema = ResponseEnvelopeSchema(
  AgentSessionQueueReadModelSchema,
  "AgentSessionQueueResponse",
);
export const AgentSessionListResponseSchema = ListResponseEnvelopeSchema(AgentSessionSchema, "AgentSessionListResponse");
export const AgentTurnResponseSchema = ResponseEnvelopeSchema(AgentTurnSchema, "AgentTurnResponse");
export const AgentTurnListResponseSchema = ListResponseEnvelopeSchema(AgentTurnSchema, "AgentTurnListResponse");
export const AgentSessionEventListResponseSchema = ListResponseEnvelopeSchema(AgentSessionEventSchema, "AgentSessionEventListResponse");
export const AgentHandoffListResponseSchema = ListResponseEnvelopeSchema(AgentHandoffSchema, "AgentHandoffListResponse");
export const AgentHandoffResponseSchema = ResponseEnvelopeSchema(AgentHandoffSchema, "AgentHandoffResponse");
export const AgentObjectProposalResponseSchema = ResponseEnvelopeSchema(
  AgentObjectProposalSchema,
  "AgentObjectProposalResponse",
);
export const AgentToolApprovalDecisionResponseSchema = ResponseEnvelopeSchema(strictObject({
  approvalId: Type.String({ minLength: 1, maxLength: 128 }),
  status: Type.Union([
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("expired"),
  ]),
  resumeTurnId: Type.Optional(AgentTurnIdSchema),
  commandId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
}), "AgentToolApprovalDecisionResponse");

export const ExecutionInvocationSummarySchema = strictObject({
  invocationId: InvocationIdSchema,
  attemptId: ExecutionAttemptIdSchema,
  mode: ExecutionModeSchema,
  isolation: ExecutionIsolationSchema,
  status: ExecutionStatusSchema,
  requestedModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
  actualModelRevisionId: Type.Union([ModelProfileRevisionIdSchema, Type.Null()]),
  artifactRefs: Type.Array(ArtifactRefSchema, { uniqueItems: true, maxItems: 256 }),
  usage: Type.Optional(AgentTurnUsageSchema),
  createdAt: Type.String({ format: "date-time", pattern: "Z$" }),
  startedAt: Type.Union([Type.String({ format: "date-time", pattern: "Z$" }), Type.Null()]),
  finishedAt: Type.Union([Type.String({ format: "date-time", pattern: "Z$" }), Type.Null()]),
});
export const ExecutionInvocationListResponseSchema = ListResponseEnvelopeSchema(ExecutionInvocationSummarySchema, "ExecutionInvocationListResponse");
export const ExecutionEventListResponseSchema = ListResponseEnvelopeSchema(ExecutionEventSchema, "ExecutionEventListResponse");

const AgentSessionPathSchema = strictObject({ sessionId: AgentSessionIdSchema });
const AgentTurnPathSchema = strictObject({ sessionId: AgentSessionIdSchema, turnId: AgentTurnIdSchema });
const AgentHandoffPathSchema = strictObject({ sessionId: AgentSessionIdSchema, handoffId: Type.String({ minLength: 1, maxLength: 128 }) });
const AgentProposalPathSchema = strictObject({
  sessionId: AgentSessionIdSchema,
  proposalId: ProposalIdSchema,
});
const AgentToolApprovalPathSchema = strictObject({
  approvalId: Type.String({ minLength: 1, maxLength: 128 }),
});
const RunPathSchema = strictObject({ runId: RunIdSchema });
const AgentHistoryQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  after: Type.Optional(Type.Integer({ minimum: 0 })),
});
const AgentSessionListQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  definitionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  taskStatus: Type.Optional(AgentTaskStatusSchema),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" })),
  archived: Type.Optional(Type.Boolean()),
});

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
  listAgentSessions: {
    ...readMetadata,
    operationId: "listAgentSessions",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: AgentSessionListQuerySchema,
    responseBodySchema: AgentSessionListResponseSchema,
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
  updateAgentSession: {
    ...mutationMetadata,
    operationId: "updateAgentSession",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UpdateAgentSessionRequestSchema,
    responseBodySchema: AgentSessionResponseSchema,
  },
  getAgentSessionQueue: {
    ...readMetadata,
    operationId: "getAgentSessionQueue",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/queue`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: CursorPageRequestSchema,
    responseBodySchema: AgentSessionQueueResponseSchema,
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
    querySchema: AgentHistoryQuerySchema,
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
    querySchema: AgentHistoryQuerySchema,
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
  getAgentProposal: {
    ...readMetadata,
    operationId: "getAgentProposal",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/proposals/{proposalId}`,
    pathParamsSchema: AgentProposalPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AgentObjectProposalResponseSchema,
  },
  applyAgentProposal: {
    ...mutationMetadata,
    operationId: "applyAgentProposal",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/proposals/{proposalId}/apply`,
    pathParamsSchema: AgentProposalPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DecideAgentProposalRequestSchema,
    responseBodySchema: AgentObjectProposalResponseSchema,
  },
  rejectAgentProposal: {
    ...mutationMetadata,
    operationId: "rejectAgentProposal",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/proposals/{proposalId}/reject`,
    pathParamsSchema: AgentProposalPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DecideAgentProposalRequestSchema,
    responseBodySchema: AgentObjectProposalResponseSchema,
  },
  decideAgentToolApproval: {
    ...mutationMetadata,
    operationId: "decideAgentToolApproval",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-tool-approvals/{approvalId}/decision`,
    pathParamsSchema: AgentToolApprovalPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DecideAgentToolApprovalRequestSchema,
    responseBodySchema: AgentToolApprovalDecisionResponseSchema,
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
    querySchema: AgentHistoryQuerySchema,
    responseBodySchema: ExecutionEventListResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
