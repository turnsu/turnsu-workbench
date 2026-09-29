import { Type } from "typebox";

import { CursorPageRequestSchema } from "./common.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import { InboxItemSchema } from "./inbox.js";
import { strictObject } from "./schema.js";

const readMetadata = {
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

export const InboxReadModelSchema = strictObject(
  {
    items: Type.Array(InboxItemSchema),
    count: Type.Integer({ minimum: 0 }),
    page: strictObject({
      nextCursor: Type.Union([
        Type.String({ minLength: 1, maxLength: 512 }),
        Type.Null(),
      ]),
      hasMore: Type.Boolean(),
    }),
  },
  { $id: "InboxReadModel" },
);

export const InboxResponseSchema = ResponseEnvelopeSchema(
  InboxReadModelSchema,
  "InboxResponse",
);

export const WORKBENCH_V1_INBOX_ENDPOINTS = {
  getInbox: {
    ...readMetadata,
    operationId: "getInbox",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/inbox`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: strictObject({ ...CursorPageRequestSchema.properties }),
    responseBodySchema: InboxResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
