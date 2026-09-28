import { Type } from "typebox";

import { DurableMemoryIdSchema, MemoryCandidateIdSchema } from "./common.js";
import {
  DurableMemorySchema,
  MemoryCandidateSchema,
  MemoryCandidateStatusSchema,
  MemoryDeletionTombstoneSchema,
  MemoryScopeKindSchema,
} from "./memory.js";
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
  mutation: false, successStatus: 200, responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema, responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [], optionalRequestHeaders: [], responseHeaders: [],
} as const;
const mutationMetadata = {
  mutation: true, successStatus: 200, responseMediaType: "application/json",
  requestHeadersSchema: IdempotencyHeadersSchema, responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key"], optionalRequestHeaders: [], responseHeaders: [],
} as const;

export const MemoryDecisionRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
}), "MemoryDecisionRequest");
export const DeleteMemoryRequestSchema = MutationRequestEnvelopeSchema(strictObject({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
}), "DeleteMemoryRequest");

export const MemoryCandidateListResponseSchema = ListResponseEnvelopeSchema(MemoryCandidateSchema, "MemoryCandidateListResponse");
export const MemoryCandidateResponseSchema = ResponseEnvelopeSchema(MemoryCandidateSchema, "MemoryCandidateResponse");
export const DurableMemoryListResponseSchema = ListResponseEnvelopeSchema(DurableMemorySchema, "DurableMemoryListResponse");
export const MemoryDeletionResponseSchema = ResponseEnvelopeSchema(MemoryDeletionTombstoneSchema, "MemoryDeletionResponse");

const CandidatePathSchema = strictObject({ candidateId: MemoryCandidateIdSchema });
const MemoryPathSchema = strictObject({ memoryId: DurableMemoryIdSchema });
const CandidateQuerySchema = strictObject({
  scope: Type.Optional(MemoryScopeKindSchema),
  status: Type.Optional(MemoryCandidateStatusSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});
const MemoryQueryParamsSchema = strictObject({
  scope: Type.Optional(MemoryScopeKindSchema),
  subjectKind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  subjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  tags: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const WORKBENCH_V1_MEMORY_ENDPOINTS = {
  listMemoryCandidates: {
    ...readMetadata, operationId: "listMemoryCandidates", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/memory-candidates`, pathParamsSchema: EmptyObjectSchema,
    querySchema: CandidateQuerySchema, responseBodySchema: MemoryCandidateListResponseSchema,
  },
  approveMemoryCandidate: {
    ...mutationMetadata, operationId: "approveMemoryCandidate", method: "POST",
    path: `${WORKBENCH_API_PREFIX}/memory-candidates/{candidateId}/approve`, pathParamsSchema: CandidatePathSchema,
    querySchema: EmptyObjectSchema, requestBodySchema: MemoryDecisionRequestSchema,
    responseBodySchema: MemoryCandidateResponseSchema,
  },
  rejectMemoryCandidate: {
    ...mutationMetadata, operationId: "rejectMemoryCandidate", method: "POST",
    path: `${WORKBENCH_API_PREFIX}/memory-candidates/{candidateId}/reject`, pathParamsSchema: CandidatePathSchema,
    querySchema: EmptyObjectSchema, requestBodySchema: MemoryDecisionRequestSchema,
    responseBodySchema: MemoryCandidateResponseSchema,
  },
  listMemories: {
    ...readMetadata, operationId: "listMemories", method: "GET",
    path: `${WORKBENCH_API_PREFIX}/memories`, pathParamsSchema: EmptyObjectSchema,
    querySchema: MemoryQueryParamsSchema, responseBodySchema: DurableMemoryListResponseSchema,
  },
  deleteMemory: {
    ...mutationMetadata, operationId: "deleteMemory", method: "DELETE",
    path: `${WORKBENCH_API_PREFIX}/memories/{memoryId}`, pathParamsSchema: MemoryPathSchema,
    querySchema: EmptyObjectSchema, requestBodySchema: DeleteMemoryRequestSchema,
    responseBodySchema: MemoryDeletionResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
