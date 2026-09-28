import { Type, type Static } from "typebox";

import {
  NodeIdSchema,
  NodeRunIdSchema,
  RunIdSchema,
} from "./common.js";
import {
  EmptyObjectSchema,
  MUTATION_ENDPOINT_METADATA,
  MutationRequestEnvelopeSchema,
  READ_ENDPOINT_METADATA,
  ResponseEnvelopeSchema,
  WORKBENCH_API_PREFIX,
  type WorkbenchEndpointMetadata,
} from "./endpoint-core.js";
import {
  ReviewDecisionSchema,
  ReviewDecisionValueSchema,
  RunReadModelSchema,
  WorkflowRunSchema,
} from "./runs.js";
import { strictObject } from "./schema.js";

export const RunPathParamsSchema = strictObject({ runId: RunIdSchema });

export const RunDetailResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    run: WorkflowRunSchema,
    readModel: RunReadModelSchema,
  }),
  "RunDetailResponse",
);

export const ReviewDecisionDataSchema = strictObject({
  nodeId: NodeIdSchema,
  expectedNodeRunId: Type.Optional(NodeRunIdSchema),
  decision: ReviewDecisionValueSchema,
  comment: Type.Optional(Type.String({ maxLength: 4000 })),
  requestedChanges: Type.Array(
    Type.String({ minLength: 1, maxLength: 1000 }),
  ),
});
export const ReviewDecisionRequestSchema = MutationRequestEnvelopeSchema(
  ReviewDecisionDataSchema,
  "ReviewDecisionRequest",
);
export const ReviewDecisionResponseSchema = ResponseEnvelopeSchema(
  strictObject({
    decision: ReviewDecisionSchema,
    run: WorkflowRunSchema,
  }),
  "ReviewDecisionResponse",
);

export const RunCommandDataSchema = strictObject({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
});
export const RunCommandRequestSchema = MutationRequestEnvelopeSchema(
  RunCommandDataSchema,
  "RunCommandRequest",
);
export const RunCommandResponseSchema = ResponseEnvelopeSchema(
  strictObject({ runId: RunIdSchema }),
  "RunCommandResponse",
);

export const WORKBENCH_V1_RUN_ENDPOINTS = {
  getRun: {
    ...READ_ENDPOINT_METADATA,
    operationId: "getRun",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}`,
    pathParamsSchema: RunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: RunDetailResponseSchema,
  },
  submitReviewDecision: {
    ...MUTATION_ENDPOINT_METADATA,
    operationId: "submitReviewDecision",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/review-decisions`,
    pathParamsSchema: RunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ReviewDecisionRequestSchema,
    responseBodySchema: ReviewDecisionResponseSchema,
  },
  cancelRun: {
    ...MUTATION_ENDPOINT_METADATA,
    operationId: "cancelRun",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/cancel`,
    successStatus: 202,
    pathParamsSchema: RunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RunCommandRequestSchema,
    responseBodySchema: RunCommandResponseSchema,
  },
  retryRun: {
    ...MUTATION_ENDPOINT_METADATA,
    operationId: "retryRun",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/runs/{runId}/retry`,
    successStatus: 202,
    pathParamsSchema: RunPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RunCommandRequestSchema,
    responseBodySchema: RunCommandResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

export type ReviewDecisionRequest = Static<typeof ReviewDecisionRequestSchema>;
export type RunCommandRequest = Static<typeof RunCommandRequestSchema>;
