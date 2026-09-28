import { Type, type Static } from "typebox";

import {
  UserIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
} from "./common.js";
import {
  EmptyObjectSchema,
  READ_ENDPOINT_METADATA,
  ResponseEnvelopeSchema,
  WORKBENCH_API_PREFIX,
  type WorkbenchEndpointMetadata,
} from "./endpoint-core.js";
import { strictObject } from "./schema.js";

export const WorkspaceCapabilitiesSchema = strictObject({
  builderProposal: Type.Boolean(),
  resources: Type.Boolean(),
  maxParallelism: Type.Literal(1),
});

export const WorkspaceSchema = strictObject({
  workspaceId: WorkspaceIdSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  capabilities: WorkspaceCapabilitiesSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});

export const WorkspaceSessionSchema = strictObject({
  csrfToken: Type.String({ minLength: 0, maxLength: 256 }),
  expiresAt: UtcTimestampSchema,
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
});

export const WorkspaceBootstrapSchema = strictObject({
  workspace: WorkspaceSchema,
  session: WorkspaceSessionSchema,
});

export const WorkspaceResponseSchema = ResponseEnvelopeSchema(
  WorkspaceBootstrapSchema,
  "WorkspaceResponse",
);

export const WORKBENCH_V1_WORKSPACE_ENDPOINTS = {
  workspace: {
    ...READ_ENDPOINT_METADATA,
    responseHeadersSchema: strictObject({
      "Cache-Control": Type.Literal("no-store"),
    }),
    responseHeaders: ["Cache-Control"],
    operationId: "workspace",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workspace`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: WorkspaceResponseSchema,
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;

export type Workspace = Static<typeof WorkspaceSchema>;
