import { Type } from "typebox";

import { EntityTagSchema, ScopeIdSchema } from "./common.js";
import {
  PermissionModeConfigSchema,
  ProductScopeSchema,
  ScopeObservationTierSchema,
} from "./scopes.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  RevisionMutationHeadersSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import { strictObject } from "./schema.js";

const privateReadMetadata = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("private, no-store"),
  }),
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

const privateRevisionMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: RevisionMutationHeadersSchema,
  responseHeadersSchema: strictObject({
    "Cache-Control": Type.Literal("private, no-store"),
    ETag: EntityTagSchema,
  }),
  requiredRequestHeaders: ["Idempotency-Key", "If-Match"],
  optionalRequestHeaders: [],
  responseHeaders: ["Cache-Control", "ETag"],
} as const;

const ScopePathParamsSchema = strictObject({ scopeId: ScopeIdSchema });
export const ReviseScopePolicyDataSchema = strictObject({
  observationTier: ScopeObservationTierSchema,
  defaultPermission: PermissionModeConfigSchema,
});
export const ReviseScopePolicyRequestSchema = MutationRequestEnvelopeSchema(
  ReviseScopePolicyDataSchema,
  "ReviseScopePolicyRequest",
);
export const ScopeResponseSchema = ResponseEnvelopeSchema(ProductScopeSchema, "ScopeResponse");
export const ScopeListResponseSchema = ListResponseEnvelopeSchema(ProductScopeSchema, "ScopeListResponse");

export const WORKBENCH_V1_SCOPE_ENDPOINTS = {
  listScopes: {
    ...privateReadMetadata,
    operationId: "listScopes",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/scopes`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ScopeListResponseSchema,
  },
  getScope: {
    ...privateEntityReadMetadata,
    operationId: "getScope",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/scopes/{scopeId}`,
    pathParamsSchema: ScopePathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ScopeResponseSchema,
  },
  reviseScopePolicy: {
    ...privateRevisionMutationMetadata,
    operationId: "reviseScopePolicy",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/scopes/{scopeId}/policy`,
    pathParamsSchema: ScopePathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ReviseScopePolicyRequestSchema,
    responseBodySchema: ScopeResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
