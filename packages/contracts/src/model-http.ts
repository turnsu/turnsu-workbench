import { Type } from "typebox";

import {
  AgentSessionIdSchema,
  CursorPageRequestSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
  UserIdSchema,
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
} from "./endpoint-core.js";
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
  profileId: Type.Optional(ModelProfileIdSchema),
  capabilities: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(chat|tool_calling|structured_output|image_input|image_generation|realtime_audio_input|realtime_audio_output|realtime_turn_detection|realtime_barge_in)(,(chat|tool_calling|structured_output|image_input|image_generation|realtime_audio_input|realtime_audio_output|realtime_turn_detection|realtime_barge_in))*$",
  })),
  context: Type.Optional(ModelSelectionContextSchema),
  readiness: Type.Optional(ModelReadinessSchema),
  selectedRevisionId: Type.Optional(ModelProfileRevisionIdSchema),
});

export const ModelProfileListResponseSchema = ListResponseEnvelopeSchema(
  ModelProfileSummarySchema,
  "ModelProfileListResponse",
);

export const CreateModelProfileRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    displayName: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
    provider: Type.Union([Type.Literal("deepseek"), Type.Literal("openai")]),
    providerModelId: Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" }),
    // A mounted Secret Store reference. Raw API keys never enter Product HTTP.
    secretRef: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}:[1-9][0-9]{0,8}$", maxLength: 138 }),
    makeDefault: Type.Boolean(),
    // Omitted means the authenticated administrator. A supplied member must
    // be active in the same workspace; this grants no access to their tasks.
    forUserId: Type.Optional(UserIdSchema),
  }),
  "CreateModelProfileRequest",
);

const AgentSessionPathSchema = strictObject({ sessionId: AgentSessionIdSchema });

export const WORKBENCH_V1_MODEL_ENDPOINTS = {
  createModelProfile: {
    ...mutationMetadata,
    responseHeadersSchema: strictObject({ "Cache-Control": Type.Literal("private, no-store") }),
    responseHeaders: ["Cache-Control"],
    successStatus: 201,
    operationId: "createModelProfile",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/model-profiles`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateModelProfileRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(strictObject({
      profileId: ModelProfileIdSchema,
      revisionId: ModelProfileRevisionIdSchema,
    }), "CreateModelProfileResponse"),
  },
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
