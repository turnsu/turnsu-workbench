import { Type } from "typebox";

import {
  ArtifactIdSchema,
  StrongEntityTagSchema,
} from "./common.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./http.js";
import {
  ArtifactMediaTypeSchema,
  ArtifactMetadataSchema,
} from "./artifacts.js";
import { strictObject } from "./schema.js";

export const ArtifactMetadataResponseSchema = ResponseEnvelopeSchema(
  ArtifactMetadataSchema,
  "ArtifactMetadataResponse",
);

export const ArtifactContentResponseHeadersSchema = strictObject({
  "Content-Type": ArtifactMediaTypeSchema,
  "Content-Length": Type.String({ pattern: "^[1-9][0-9]*$" }),
  ETag: StrongEntityTagSchema,
  "Cache-Control": Type.Literal("private, max-age=31536000, immutable"),
  "X-Content-Type-Options": Type.Literal("nosniff"),
});

const ArtifactPathSchema = strictObject({ artifactId: ArtifactIdSchema });

const metadataRead = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

export const WORKBENCH_V1_ARTIFACT_ENDPOINTS = {
  getArtifactMetadata: {
    ...metadataRead,
    operationId: "getArtifactMetadata",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/artifacts/{artifactId}`,
    pathParamsSchema: ArtifactPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ArtifactMetadataResponseSchema,
  },
  getArtifactContent: {
    mutation: false,
    successStatus: 200,
    operationId: "getArtifactContent",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/artifacts/{artifactId}/content`,
    responseMediaType: "application/octet-stream",
    pathParamsSchema: ArtifactPathSchema,
    querySchema: EmptyObjectSchema,
    requestHeadersSchema: EmptyHeadersSchema,
    responseHeadersSchema: ArtifactContentResponseHeadersSchema,
    requiredRequestHeaders: [],
    optionalRequestHeaders: [],
    responseHeaders: [
      "Content-Type",
      "Content-Length",
      "ETag",
      "Cache-Control",
      "X-Content-Type-Options",
    ],
    // Binary bytes are never represented as JSON, strings, data URLs, or Base64.
    responseBodySchema: Type.Never(),
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
