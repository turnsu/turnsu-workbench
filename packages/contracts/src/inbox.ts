import { Type, type Static } from "typebox";

import {
  InboxItemIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
  WorkbenchSchemaVersionSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const InboxReasonSchema = stringEnum([
  "proposal_conflict",
  "merge_conflict",
  "review_required",
  "library_update_review",
  "connection_missing",
  "connection_invalid",
  "run_blocked",
  "run_failed",
  "runtime_unavailable",
  "model_unavailable",
]);

export const InboxItemSchema = strictObject(
  {
    schemaVersion: WorkbenchSchemaVersionSchema,
    itemId: InboxItemIdSchema,
    workspaceId: WorkspaceIdSchema,
    objectKind: stringEnum([
      "proposal",
      "merge_conflict",
      "review",
      "automation",
      "installation_update",
      "connection",
      "run",
      "runtime",
      "model",
    ]),
    objectId: Type.String({ minLength: 1, maxLength: 128 }),
    reason: InboxReasonSchema,
    severity: stringEnum(["info", "warning", "critical"]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    actionRoute: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: "^/(?!/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$",
    }),
    createdAt: UtcTimestampSchema,
  },
  { $id: "InboxItem" },
);

export type InboxItem = Static<typeof InboxItemSchema>;
