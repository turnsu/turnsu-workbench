import { Type } from "typebox";

import {
  AttachmentIdSchema,
  CursorPageRequestSchema,
} from "./common.js";
import {
  AttachmentProcessingResultSchema,
  InputAttachmentSchema,
} from "./attachments.js";
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

export const CreateAttachmentDataSchema = strictObject({
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  mediaType: Type.String({ minLength: 1, maxLength: 128 }),
  contentBase64: Type.String({
    minLength: 1,
    maxLength: 22_369_624,
    pattern: "^[A-Za-z0-9+/]*={0,2}$",
  }),
  ttlSeconds: Type.Optional(
    Type.Integer({ minimum: 300, maximum: 2_592_000 }),
  ),
});

export const CreateAttachmentRequestSchema = MutationRequestEnvelopeSchema(
  CreateAttachmentDataSchema,
  "CreateAttachmentRequest",
);
export const RetryAttachmentRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({}),
  "RetryAttachmentRequest",
);
export const DeleteAttachmentRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({}),
  "DeleteAttachmentRequest",
);
export const AttachmentResponseSchema = ResponseEnvelopeSchema(
  InputAttachmentSchema,
  "AttachmentResponse",
);
export const AttachmentProcessingResponseSchema = ResponseEnvelopeSchema(
  AttachmentProcessingResultSchema,
  "AttachmentProcessingResponse",
);
export const AttachmentListResponseSchema = ListResponseEnvelopeSchema(
  InputAttachmentSchema,
  "AttachmentListResponse",
);

const AttachmentPathSchema = strictObject({
  attachmentId: AttachmentIdSchema,
});

export const WORKBENCH_V1_ATTACHMENT_ENDPOINTS = {
  createAttachment: {
    ...mutationMetadata,
    operationId: "createAttachment",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/attachments`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateAttachmentRequestSchema,
    responseBodySchema: AttachmentProcessingResponseSchema,
  },
  listAttachments: {
    ...readMetadata,
    operationId: "listAttachments",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/attachments`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: strictObject({ ...CursorPageRequestSchema.properties }),
    responseBodySchema: AttachmentListResponseSchema,
  },
  getAttachment: {
    ...readMetadata,
    operationId: "getAttachment",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/attachments/{attachmentId}`,
    pathParamsSchema: AttachmentPathSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: AttachmentProcessingResponseSchema,
  },
  retryAttachment: {
    ...mutationMetadata,
    operationId: "retryAttachment",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/attachments/{attachmentId}/retry`,
    pathParamsSchema: AttachmentPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RetryAttachmentRequestSchema,
    responseBodySchema: AttachmentProcessingResponseSchema,
  },
  deleteAttachment: {
    ...mutationMetadata,
    operationId: "deleteAttachment",
    method: "DELETE",
    path: `${WORKBENCH_API_PREFIX}/attachments/{attachmentId}`,
    pathParamsSchema: AttachmentPathSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: DeleteAttachmentRequestSchema,
    responseBodySchema: AttachmentResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
