import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  InboxResponseSchema,
  WORKBENCH_V1_INBOX_ENDPOINTS,
} from "../dist/index.js";

const response = {
  schemaVersion: "workbench-api-v1",
  data: {
    items: [{
      schemaVersion: "workbench-v1",
      itemId: "inbox-review-1",
      workspaceId: "workspace-local",
      objectKind: "review",
      objectId: "run-review-1",
      reason: "review_required",
      severity: "warning",
      title: "A run needs review",
      actionRoute: "/loops/loop-1/runs/run-review-1",
      createdAt: "2026-08-04T00:00:00.000Z",
    }],
    count: 1,
    page: { nextCursor: null, hasMore: false },
  },
  requestId: "request-inbox-1",
};

test("Inbox is a strict cursor read model with private no-store responses", () => {
  const endpoint = WORKBENCH_V1_INBOX_ENDPOINTS.getInbox;
  assert.equal(Check(endpoint.querySchema, { cursor: "cursor-1", limit: 100 }), true);
  assert.equal(Check(endpoint.querySchema, { limit: 101 }), false);
  assert.equal(Check(endpoint.responseHeadersSchema, {
    "Cache-Control": "private, no-store",
  }), true);
  assert.equal(Check(endpoint.responseHeadersSchema, {
    "Cache-Control": "public, max-age=60",
  }), false);
  assert.equal(Check(InboxResponseSchema, response), true);
  assert.equal(Check(InboxResponseSchema, {
    ...response,
    data: { ...response.data, rawTranscript: "private" },
  }), false);
  assert.equal(Check(InboxResponseSchema, {
    ...response,
    data: {
      ...response.data,
      items: [{ ...response.data.items[0], actionRoute: "https://outside.invalid" }],
    },
  }), false);
  assert.equal(Check(InboxResponseSchema, {
    ...response,
    data: {
      ...response.data,
      items: [{
        ...response.data.items[0],
        objectKind: "automation",
        objectId: "occurrence-1",
        actionRoute: "/automations?occurrenceId=occurrence-1",
        reason: "run_blocked",
      }],
    },
  }), true);
});
