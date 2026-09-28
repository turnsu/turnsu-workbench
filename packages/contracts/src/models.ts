import { Type, type Static } from "typebox";

import { ArtifactRefSchema } from "./artifacts.js";
import {
  ContentHashSchema,
  DataSchemaSchema,
  JsonObjectSchema,
  ModelProfileIdSchema,
  ModelProfileRevisionIdSchema,
  UtcTimestampSchema,
  VersionSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";
import {
  AttachmentRefSchema,
} from "./attachments.js";

export const ModelProviderSchema = stringEnum([
  "deepseek",
  "openai",
  "anthropic",
  "gemini",
  "stability",
  "custom",
]);

export const ModelProtocolSchema = stringEnum([
  "openai_compatible_chat",
  "openai_realtime",
  "anthropic_messages",
  "gemini_generate_content",
  "stability_image_v2",
]);

export const ModelCapabilitySchema = stringEnum([
  "chat",
  "tool_calling",
  "structured_output",
  "image_input",
  "image_generation",
  "realtime_audio_input",
  "realtime_audio_output",
  "realtime_turn_detection",
  "realtime_barge_in",
]);

export const ModelReadinessSchema = stringEnum([
  "ready",
  "degraded",
  "unavailable",
  "disabled",
]);

export const ModelSelectionContextSchema = stringEnum([
  "agent_controller",
  "builder",
  "workflow_agent",
  "workflow_model_task",
  "direct_model_task",
  "skill_creation",
]);

export const ModelErrorCodeSchema = stringEnum([
  "model_route_unresolved",
  "model_profile_not_found",
  "model_profile_forbidden",
  "model_capability_mismatch",
  "model_revision_unavailable",
  "model_cost_budget_exceeded",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_content_rejected",
  "provider_timeout",
  "provider_response_invalid",
  "artifact_write_failed",
  "cancelled",
]);

export const ModelOutputFormatSchema = stringEnum(["png", "jpeg", "webp"]);
export const ModelAspectRatioSchema = stringEnum([
  "16:9",
  "1:1",
  "21:9",
  "2:3",
  "3:2",
  "4:5",
  "5:4",
  "9:16",
  "9:21",
]);

export const ChatModelCapabilitySchema = stringEnum([
  "chat",
  "tool_calling",
  "structured_output",
  "image_input",
]);

export const ChatParameterSupportSchema = strictObject({
  kind: Type.Literal("chat"),
  temperature: Type.Boolean(),
  maxOutputTokens: Type.Boolean(),
  tools: Type.Boolean(),
  responseSchema: Type.Boolean(),
});

export const ImageGenerationParameterSupportSchema = strictObject({
  kind: Type.Literal("image_generation"),
  negativePrompt: Type.Boolean(),
  aspectRatios: Type.Array(ModelAspectRatioSchema, {
    minItems: 1,
    uniqueItems: true,
  }),
  seed: Type.Boolean(),
  outputFormats: Type.Array(ModelOutputFormatSchema, {
    minItems: 1,
    uniqueItems: true,
  }),
});

export const RealtimeParameterSupportSchema = strictObject({
  kind: Type.Literal("realtime"),
  voices: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
  turnDetection: Type.Array(
    stringEnum(["semantic_vad", "server_vad"]),
    { minItems: 1, maxItems: 2, uniqueItems: true },
  ),
  toolCalling: Type.Boolean(),
  reasoningEffort: Type.Boolean(),
});

export const ModelParameterSupportSchema = Type.Union([
  ChatParameterSupportSchema,
  ImageGenerationParameterSupportSchema,
  RealtimeParameterSupportSchema,
]);

export const ChatModelLimitsSchema = strictObject({
  kind: Type.Literal("chat"),
  maxInputTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  maxOutputTokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
});

export const ImageGenerationModelLimitsSchema = strictObject({
  kind: Type.Literal("image_generation"),
  maxImageCount: Type.Integer({ minimum: 1, maximum: 16 }),
  maxOutputBytes: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  maxCostUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
});

export const RealtimeTokenPricingSchema = strictObject({
  pricingVersion: VersionSchema,
  basis: Type.Literal("aggregate_token_ceiling"),
  currency: Type.Literal("USD"),
  inputUsdMicrosPerMillionTokens: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
  outputUsdMicrosPerMillionTokens: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
});

export const RealtimeModelLimitsSchema = strictObject({
  kind: Type.Literal("realtime"),
  maxSessionSeconds: Type.Integer({ minimum: 60, maximum: 3600 }),
  maxInputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
  maxOutputTokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  maxCostUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
  pricing: Type.Optional(RealtimeTokenPricingSchema),
});

export const ModelRevisionLimitsSchema = Type.Union([
  ChatModelLimitsSchema,
  ImageGenerationModelLimitsSchema,
  RealtimeModelLimitsSchema,
]);

const ModelRevisionIdentityProperties = {
  schemaVersion: WorkbenchSchemaVersionSchema,
  revisionId: ModelProfileRevisionIdSchema,
  profileId: ModelProfileIdSchema,
  revisionNumber: Type.Integer({ minimum: 1 }),
  providerModelId: Type.String({ minLength: 1, maxLength: 256 }),
  parameterSchemaVersion: VersionSchema,
  policyVersion: VersionSchema,
  configHash: ContentHashSchema,
  createdAt: UtcTimestampSchema,
};

const ChatRevisionProperties = {
  ...ModelRevisionIdentityProperties,
  capabilities: Type.Array(ChatModelCapabilitySchema, {
    minItems: 1,
    maxItems: 4,
    uniqueItems: true,
    contains: Type.Literal("chat"),
    minContains: 1,
  }),
  parameterSupport: ChatParameterSupportSchema,
  limits: ChatModelLimitsSchema,
};

export const OpenAiCompatibleModelProfileRevisionSchema = strictObject({
  ...ChatRevisionProperties,
  provider: stringEnum(["deepseek", "openai", "custom"]),
  protocol: Type.Literal("openai_compatible_chat"),
});

export const AnthropicModelProfileRevisionSchema = strictObject({
  ...ChatRevisionProperties,
  provider: Type.Literal("anthropic"),
  protocol: Type.Literal("anthropic_messages"),
});

export const GeminiModelProfileRevisionSchema = strictObject({
  ...ChatRevisionProperties,
  provider: Type.Literal("gemini"),
  protocol: Type.Literal("gemini_generate_content"),
});

export const StabilityModelProfileRevisionSchema = strictObject({
  ...ModelRevisionIdentityProperties,
  provider: Type.Literal("stability"),
  protocol: Type.Literal("stability_image_v2"),
  capabilities: Type.Tuple([Type.Literal("image_generation")]),
  parameterSupport: ImageGenerationParameterSupportSchema,
  limits: ImageGenerationModelLimitsSchema,
});

export const OpenAiRealtimeModelProfileRevisionSchema = strictObject({
  ...ModelRevisionIdentityProperties,
  provider: Type.Literal("openai"),
  protocol: Type.Literal("openai_realtime"),
  capabilities: Type.Intersect([
    Type.Array(ModelCapabilitySchema, {
      minItems: 6,
      maxItems: 7,
      uniqueItems: true,
      contains: Type.Literal("chat"),
      minContains: 1,
    }),
    Type.Array(ModelCapabilitySchema, {
      contains: Type.Literal("tool_calling"),
      minContains: 1,
    }),
    Type.Array(ModelCapabilitySchema, {
      contains: Type.Literal("realtime_audio_input"),
      minContains: 1,
    }),
    Type.Array(ModelCapabilitySchema, {
      contains: Type.Literal("realtime_audio_output"),
      minContains: 1,
    }),
    Type.Array(ModelCapabilitySchema, {
      contains: Type.Literal("realtime_turn_detection"),
      minContains: 1,
    }),
    Type.Array(ModelCapabilitySchema, {
      contains: Type.Literal("realtime_barge_in"),
      minContains: 1,
    }),
  ]),
  parameterSupport: RealtimeParameterSupportSchema,
  limits: RealtimeModelLimitsSchema,
});

export const ModelProfileRevisionSchema = Type.Union(
  [
    OpenAiCompatibleModelProfileRevisionSchema,
    AnthropicModelProfileRevisionSchema,
    GeminiModelProfileRevisionSchema,
    StabilityModelProfileRevisionSchema,
    OpenAiRealtimeModelProfileRevisionSchema,
  ],
  { $id: "ModelProfileRevision" },
);

export const PublicModelProviderDisplaySchema = strictObject({
  key: ModelProviderSchema,
  label: Type.String({ minLength: 1, maxLength: 100 }),
});

export const PublicModelProfileRevisionSummarySchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    revisionId: ModelProfileRevisionIdSchema,
    profileId: ModelProfileIdSchema,
    revisionNumber: Type.Integer({ minimum: 1 }),
    modelDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
    providerDisplay: PublicModelProviderDisplaySchema,
    capabilities: Type.Array(ModelCapabilitySchema, {
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
    }),
    parameterSupport: ModelParameterSupportSchema,
    limits: ModelRevisionLimitsSchema,
    createdAt: UtcTimestampSchema,
  },
  { $id: "PublicModelProfileRevisionSummary" },
);

const PublicModelProfileSummaryProperties = {
  schemaVersion: WorkbenchSchemaVersionSchema,
  profileId: ModelProfileIdSchema,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  currentRevisionId: ModelProfileRevisionIdSchema,
  currentRevision: PublicModelProfileRevisionSummarySchema,
  enabled: Type.Boolean(),
  readiness: ModelReadinessSchema,
  readinessReason: Type.Union([
    Type.String({ minLength: 1, maxLength: 1000 }),
    Type.Null(),
  ]),
  selectable: Type.Boolean(),
  defaultForCapabilities: Type.Array(ModelCapabilitySchema, {
    uniqueItems: true,
    maxItems: 9,
  }),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
};

export const GlobalModelProfileSummarySchema = strictObject({
  ...PublicModelProfileSummaryProperties,
  scope: Type.Literal("global"),
});

export const WorkspaceModelProfileSummarySchema = strictObject({
  ...PublicModelProfileSummaryProperties,
  scope: Type.Literal("workspace"),
  workspaceId: WorkspaceIdSchema,
});

export const ModelProfileSummarySchema = Type.Union(
  [GlobalModelProfileSummarySchema, WorkspaceModelProfileSummarySchema],
  { $id: "ModelProfileSummary" },
);

export const DefaultModelProfileIdsByCapabilitySchema = strictObject({
  chat: Type.Optional(ModelProfileIdSchema),
  tool_calling: Type.Optional(ModelProfileIdSchema),
  structured_output: Type.Optional(ModelProfileIdSchema),
  image_input: Type.Optional(ModelProfileIdSchema),
  image_generation: Type.Optional(ModelProfileIdSchema),
  realtime_audio_input: Type.Optional(ModelProfileIdSchema),
  realtime_audio_output: Type.Optional(ModelProfileIdSchema),
  realtime_turn_detection: Type.Optional(ModelProfileIdSchema),
  realtime_barge_in: Type.Optional(ModelProfileIdSchema),
});

export const WorkspaceModelRoutingPolicySchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    workspaceId: WorkspaceIdSchema,
    defaultProfileIdsByCapability: DefaultModelProfileIdsByCapabilitySchema,
    workflowFallbackAllowed: Type.Boolean(),
    policyVersion: VersionSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "WorkspaceModelRoutingPolicy" },
);

export const ChatTextContentPartSchema = strictObject({
  type: Type.Literal("text"),
  text: Type.String({ minLength: 1, maxLength: 100_000 }),
  attachment: Type.Optional(AttachmentRefSchema),
});

export const ChatImageContentPartSchema = strictObject({
  type: Type.Literal("image"),
  mediaType: Type.Union([
    Type.Literal("image/png"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/webp"),
  ]),
  dataBase64: Type.String({
    minLength: 1,
    maxLength: 22_369_624,
    pattern: "^[A-Za-z0-9+/]*={0,2}$",
  }),
  attachment: AttachmentRefSchema,
});

export const ChatUserContentPartSchema = Type.Union([
  ChatTextContentPartSchema,
  ChatImageContentPartSchema,
]);

export const ChatMessageSchema = Type.Union([
  strictObject({
    role: stringEnum(["system", "assistant"]),
    content: Type.String({ minLength: 1, maxLength: 100_000 }),
  }),
  strictObject({
    role: Type.Literal("user"),
    content: Type.Union([
      Type.String({ minLength: 1, maxLength: 100_000 }),
      Type.Array(ChatUserContentPartSchema, { minItems: 1, maxItems: 64 }),
    ]),
  }),
  strictObject({
    role: Type.Literal("tool"),
    toolCallId: Type.String({ minLength: 1, maxLength: 128 }),
    content: Type.String({ minLength: 1, maxLength: 100_000 }),
  }),
]);

export const ChatToolDefinitionSchema = strictObject({
  name: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  inputSchema: DataSchemaSchema,
});

export const ChatInputSchema = strictObject(
  {
    messages: Type.Array(ChatMessageSchema, { minItems: 1, maxItems: 512 }),
    tools: Type.Array(ChatToolDefinitionSchema, {
      maxItems: 128,
    }),
    responseSchema: Type.Optional(DataSchemaSchema),
  },
  { $id: "ChatInput" },
);

export const ImageGenerationInputSchema = strictObject(
  {
    prompt: Type.String({ minLength: 1, maxLength: 10_000 }),
    negativePrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
    aspectRatio: Type.Optional(ModelAspectRatioSchema),
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_294 })),
    outputFormat: Type.Optional(ModelOutputFormatSchema),
  },
  { $id: "ImageGenerationInput" },
);

export const ModelInputSchema = Type.Union([ChatInputSchema, ImageGenerationInputSchema]);

export const ModelUsageSchema = strictObject({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Integer({ minimum: 0 }),
  imageCount: Type.Integer({ minimum: 0, maximum: 16 }),
  costUsdMicros: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
});

export const ModelToolCallSchema = strictObject({
  toolCallId: Type.String({ minLength: 1, maxLength: 128 }),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  arguments: JsonObjectSchema,
});

export const ChatResultSchema = strictObject(
  {
    kind: Type.Literal("chat"),
    content: Type.String({ maxLength: 100_000 }),
    toolCalls: Type.Array(ModelToolCallSchema, { maxItems: 128 }),
    usage: ModelUsageSchema,
    requestedModelRevisionId: ModelProfileRevisionIdSchema,
    actualModelRevisionId: ModelProfileRevisionIdSchema,
  },
  { $id: "ChatResult" },
);

export const ImageDimensionsSchema = strictObject({
  width: Type.Integer({ minimum: 1, maximum: 32_768 }),
  height: Type.Integer({ minimum: 1, maximum: 32_768 }),
});

export const ImageGenerationResultSchema = strictObject(
  {
    kind: Type.Literal("image_generation"),
    artifactRefs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    seed: Type.Union([
      Type.Integer({ minimum: 0, maximum: 4_294_967_294 }),
      Type.Null(),
    ]),
    format: ModelOutputFormatSchema,
    dimensions: ImageDimensionsSchema,
    safetyStatus: stringEnum(["passed", "filtered", "flagged"]),
    usage: ModelUsageSchema,
    requestedModelRevisionId: ModelProfileRevisionIdSchema,
    actualModelRevisionId: ModelProfileRevisionIdSchema,
  },
  { $id: "ImageGenerationResult" },
);

export const ModelResultSchema = Type.Union([
  ChatResultSchema,
  ImageGenerationResultSchema,
]);

export const AGENT_CONTROLLER_REQUIRED_MODEL_CAPABILITIES = [
  "chat",
  "tool_calling",
] as const;

export function modelRevisionSupportsCapabilities(
  revision: Pick<ModelProfileRevision, "capabilities">,
  requiredCapabilities: readonly ModelCapability[],
) {
  const available = new Set(revision.capabilities);
  return requiredCapabilities.every((capability) => available.has(capability));
}

export type ModelProvider = Static<typeof ModelProviderSchema>;
export type ModelProtocol = Static<typeof ModelProtocolSchema>;
export type ModelCapability = Static<typeof ModelCapabilitySchema>;
export type ModelReadiness = Static<typeof ModelReadinessSchema>;
export type ModelProfileRevision = Static<typeof ModelProfileRevisionSchema>;
export type PublicModelProfileRevisionSummary = Static<
  typeof PublicModelProfileRevisionSummarySchema
>;
export type ModelProfileSummary = Static<typeof ModelProfileSummarySchema>;
export type WorkspaceModelRoutingPolicy = Static<
  typeof WorkspaceModelRoutingPolicySchema
>;
export type ChatInput = Static<typeof ChatInputSchema>;
export type ImageGenerationInput = Static<typeof ImageGenerationInputSchema>;
export type ModelInput = Static<typeof ModelInputSchema>;
export type ModelUsage = Static<typeof ModelUsageSchema>;
export type ChatResult = Static<typeof ChatResultSchema>;
export type ImageGenerationResult = Static<typeof ImageGenerationResultSchema>;
export type ModelResult = Static<typeof ModelResultSchema>;
