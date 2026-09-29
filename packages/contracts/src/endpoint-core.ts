import { Type, type TSchema } from "typebox";

import {
  CursorPageSchema,
  EntityTagSchema,
  IdempotencyKeySchema,
  RequestIdSchema,
  WorkbenchApiSchemaVersionSchema,
} from "./common.js";
import { strictObject } from "./schema.js";

export const WORKBENCH_API_PREFIX = "/api/workbench/v1" as const;

export function MutationRequestEnvelopeSchema<const Data extends TSchema>(
  data: Data,
  id?: string,
) {
  return strictObject(
    {
      schemaVersion: WorkbenchApiSchemaVersionSchema,
      data,
    },
    id === undefined ? {} : { $id: id },
  );
}

export function ResponseEnvelopeSchema<const Data extends TSchema>(
  data: Data,
  id?: string,
) {
  return strictObject(
    {
      schemaVersion: WorkbenchApiSchemaVersionSchema,
      data,
      requestId: RequestIdSchema,
    },
    id === undefined ? {} : { $id: id },
  );
}

export function ListResponseEnvelopeSchema<const Item extends TSchema>(
  item: Item,
  id?: string,
) {
  return strictObject(
    {
      schemaVersion: WorkbenchApiSchemaVersionSchema,
      data: Type.Array(item),
      page: CursorPageSchema,
      requestId: RequestIdSchema,
    },
    id === undefined ? {} : { $id: id },
  );
}

export type MutationRequestEnvelope<Data> = {
  schemaVersion: "workbench-api-v1";
  data: Data;
};

export type ResponseEnvelope<Data> = {
  schemaVersion: "workbench-api-v1";
  data: Data;
  requestId: string;
};

export const EmptyObjectSchema = strictObject({});
export const EmptyHeadersSchema = strictObject({});

export const IdempotencyHeadersSchema = strictObject({
  "Idempotency-Key": IdempotencyKeySchema,
});

export const RevisionMutationHeadersSchema = strictObject({
  "Idempotency-Key": IdempotencyKeySchema,
  "If-Match": EntityTagSchema,
});

export const EventCursorHeadersSchema = strictObject({
  "Last-Event-ID": Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
});

export const EntityTagResponseHeadersSchema = strictObject({
  ETag: EntityTagSchema,
});

export interface WorkbenchEndpointMetadata {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `${typeof WORKBENCH_API_PREFIX}${string}`;
  mutation: boolean;
  successStatus: 200 | 201 | 202;
  responseMediaType:
    | "application/json"
    | "application/octet-stream"
    | "text/event-stream"
    | "application/vnd.looloomi.loop-package+json";
  pathParamsSchema: TSchema;
  querySchema: TSchema;
  requestHeadersSchema: TSchema;
  requestBodySchema?: TSchema;
  responseBodySchema: TSchema;
  responseHeadersSchema: TSchema;
  requiredRequestHeaders: readonly string[];
  optionalRequestHeaders: readonly string[];
  responseHeaders: readonly string[];
}

export const READ_ENDPOINT_METADATA = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

export const MUTATION_ENDPOINT_METADATA = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: IdempotencyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key"],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;
