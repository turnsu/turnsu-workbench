import { Type, type Static } from "typebox";

import {
  ProductCommandIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const ProductTraceNodeKindSchema = stringEnum([
  "product_command",
  "agent_turn",
  "skill_creation_turn",
  "admission",
  "capacity_lease",
  "capability_lease",
  "realtime_call",
  "invocation",
  "execution_attempt",
  "provider_call",
  "tool_call",
  "effect_receipt",
  "proposal",
  "artifact",
]);

export const ProductTraceNodeSchema = strictObject({
  nodeId: Type.String({ minLength: 3, maxLength: 300 }),
  kind: ProductTraceNodeKindSchema,
  entityId: Type.String({ minLength: 1, maxLength: 128 }),
  parentNodeId: Type.Union([
    Type.String({ minLength: 3, maxLength: 300 }),
    Type.Null(),
  ]),
  status: Type.String({ minLength: 1, maxLength: 64 }),
  occurredAt: UtcTimestampSchema,
});

export const ProductTraceSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    productCommandId: ProductCommandIdSchema,
    workspaceId: WorkspaceIdSchema,
    nodes: Type.Array(ProductTraceNodeSchema, { minItems: 1, maxItems: 4096 }),
  },
  { $id: "ProductTrace" },
);

export type ProductTraceNode = Static<typeof ProductTraceNodeSchema>;
export type ProductTrace = Static<typeof ProductTraceSchema>;
