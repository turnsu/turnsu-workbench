import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./http.js";
import { ProductCommandIdSchema } from "./common.js";
import { ProductTraceSchema } from "./traces.js";
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

export const ProductTraceResponseSchema = ResponseEnvelopeSchema(
  ProductTraceSchema,
  "ProductTraceResponse",
);

export const WORKBENCH_V1_TRACE_ENDPOINTS = {
  getProductTrace: {
    ...readMetadata,
    operationId: "getProductTrace",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/traces/{productCommandId}`,
    pathParamsSchema: strictObject({ productCommandId: ProductCommandIdSchema }),
    querySchema: EmptyObjectSchema,
    responseBodySchema: ProductTraceResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
