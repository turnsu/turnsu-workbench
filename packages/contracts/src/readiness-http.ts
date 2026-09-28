import { Type } from "typebox";

import {
  EmptyObjectSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import { WorkspaceFeatureReadinessSchema } from "./readiness.js";
import { strictObject } from "./schema.js";

const PrivateNoStoreHeadersSchema = strictObject({
  "Cache-Control": Type.Literal("private, no-store"),
});

export const WorkspaceFeatureReadinessResponseSchema = ResponseEnvelopeSchema(
  WorkspaceFeatureReadinessSchema,
  "WorkspaceFeatureReadinessResponse",
);

export const WORKBENCH_V1_READINESS_ENDPOINTS = {
  getWorkspaceFeatureReadiness: {
    mutation: false,
    successStatus: 200,
    responseMediaType: "application/json",
    operationId: "getWorkspaceFeatureReadiness",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workspace/feature-readiness`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestHeadersSchema: EmptyObjectSchema,
    responseBodySchema: WorkspaceFeatureReadinessResponseSchema,
    responseHeadersSchema: PrivateNoStoreHeadersSchema,
    requiredRequestHeaders: [],
    optionalRequestHeaders: [],
    responseHeaders: ["Cache-Control"],
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
