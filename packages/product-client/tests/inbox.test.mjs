import assert from "node:assert/strict";
import test from "node:test";

import { ProductClientProtocolError } from "../dist/index.js";
import { createInboxProductClient } from "../dist/inbox.js";

const inboxResponse = {
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

function jsonResponse(body, cacheControl = "private, no-store") {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

test("inbox preserves cursor, cancellation, and private cache boundary", async () => {
  let captured;
  const controller = new AbortController();
  const client = createInboxProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(inboxResponse);
    },
  });

  const result = await client.call("getInbox", {
    query: { cursor: "cursor:page/2", limit: 25 },
  }, { signal: controller.signal });

  assert.equal(captured.url, "/api/workbench/v1/inbox?cursor=cursor%3Apage%2F2&limit=25");
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(captured.init.signal, controller.signal);
  assert.equal(result.body.data.items[0].actionRoute, "/loops/loop-1/runs/run-review-1");
  assert.deepEqual(result.headers, { "Cache-Control": "private, no-store" });
});

test("inbox fails closed on invalid query, body, or cache header", async () => {
  let fetchCount = 0;
  const client = createInboxProductClient({
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse(inboxResponse);
    },
  });
  await assert.rejects(
    client.call("getInbox", /** @type {never} */ ({ query: { limit: 101 } })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_query",
  );
  assert.equal(fetchCount, 0);

  const malformed = createInboxProductClient({
    fetch: async () => jsonResponse({
      ...inboxResponse,
      data: { ...inboxResponse.data, leakedTranscript: "private" },
    }),
  });
  await assert.rejects(
    malformed.call("getInbox", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_body",
  );

  const cacheable = createInboxProductClient({
    fetch: async () => jsonResponse(inboxResponse, "public, max-age=60"),
  });
  await assert.rejects(
    cacheable.call("getInbox", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_headers",
  );
});
