import { Type, type Static } from "typebox";

import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  EventCursorHeadersSchema,
  WORKBENCH_API_PREFIX,
  type WorkbenchEndpointMetadata,
} from "./http.js";
import { SessionDomainEnvelopeSchema } from "./session-ledger.js";
import { strictObject } from "./schema.js";

const readMetadata = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "text/event-stream",
  requestHeadersSchema: EventCursorHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: ["Last-Event-ID"],
  responseHeaders: [],
} as const;

export const SessionDomainEventsQuerySchema = strictObject({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

export const WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS = {
  getSessionDomainEvents: {
    ...readMetadata,
    operationId: "getSessionDomainEvents",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/session-domain/events`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: SessionDomainEventsQuerySchema,
    responseBodySchema: SessionDomainEnvelopeSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

export type SessionDomainEventsQuery = Static<typeof SessionDomainEventsQuerySchema>;
