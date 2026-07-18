import { Type } from "typebox";

import {
  AgentSessionIdSchema,
  CursorPageRequestSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
} from "./common.js";
import { AgentSessionSchema } from "./agents.js";
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
  ModelProfileSummarySchema,
  ModelReadinessSchema,
  ModelSelectionContextSchema,
} from "./models.js";
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

export const UpdateAgentSessionModelPreferenceRequestSchema =
  MutationRequestEnvelopeSchema(
    strictObject({
      modelProfileId: ModelProfileIdSchema,
    }),
    "UpdateAgentSessionModelPreferenceRequest",
  );

// Temporary endpoint compatibility. This mutates only a Session preference and
// never changes the immutable revision pinned by a queued or running Turn.
export const SelectAgentSessionModelRequestSchema =
  UpdateAgentSessionModelPreferenceRequestSchema;

export const ModelCatalogQuerySchema = strictObject({
  ...CursorPageRequestSchema.properties,
  capabilities: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^(chat|tool_calling|structured_output|image_generation)(,(chat|tool_calling|structured_output|image_generation))*$",
  })),
  context: Type.Optional(ModelSelectionContextSchema),
  readiness: Type.Optional(ModelReadinessSchema),
  selectedRevisionId: Type.Optional(ModelProfileRevisionIdSchema),
});

export const ModelProfileListResponseSchema = ListResponseEnvelopeSchema(
  ModelProfileSummarySchema,
  "ModelProfileListResponse",
);

const AgentSessionPathSchema = strictObject({ sessionId: AgentSessionIdSchema });

export const WORKBENCH_V1_MODEL_ENDPOINTS = {
  listModelProfiles: {
    ...readMetadata,
    operationId: "listModelProfiles",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/model-profiles`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: ModelCatalogQuerySchema,
    responseBodySchema: ModelProfileListResponseSchema,
  },
  selectAgentSessionModel: {
    ...mutationMetadata,
    operationId: "selectAgentSessionModel",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/agent-sessions/{sessionId}/model`,
    pathParamsSchema: AgentSessionPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: SelectAgentSessionModelRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(AgentSessionSchema, "SelectAgentSessionModelResponse"),
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
