import assert from "node:assert/strict";
import test from "node:test";

import { ProductClientProtocolError } from "../dist/index.js";
import { createRunProductClient } from "../dist/runs.js";

const run = {
  schemaVersion: "workbench-v1",
  runId: "run-review-1",
  workflowId: "workflow-review-1",
  workflowRevisionId: "workflow-review-r1",
  executionPlanVersion: "workbench-execution-plan-v2",
  executionPlanContentHash: `sha256:${"a".repeat(64)}`,
  status: "waiting_review",
  inputs: {},
  resourceRefs: [],
  currentNodeId: "node-review",
  nodeRuns: [],
  reviewDecisions: [],
  authoritativeReadModel: { available: false, version: 0 },
  idempotencyKey: "run-review-key",
  queuedAt: "2026-08-12T00:00:00.000Z",
  startedAt: "2026-08-12T00:00:01.000Z",
  finishedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:01.000Z",
};

function response(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

test("Run ProductClient validates the private Run read boundary", async () => {
  let captured;
  const client = createRunProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: { run, readModel: {
          schemaVersion: "workbench-v1", runId: run.runId, workflowId: run.workflowId,
          workflowRevisionId: run.workflowRevisionId, status: run.status, currentNodeId: "node-review",
          nodeTimeline: [], finalAnswer: null, evidenceGaps: [],
          reviewPacket: { nodeId: "node-review", title: "Review", summary: "Review this result.", items: [], canRequestChanges: true },
          reviewDecisions: [], failure: null, recoveryActions: [], followUpPrompts: [], resourceRefs: [], evidenceRefs: [],
          createdAt: run.createdAt, updatedAt: run.updatedAt,
        } },
        requestId: "request-run-read",
      });
    },
  });
  const result = await client.call("getRun", { pathParams: { runId: run.runId } });
  assert.equal(captured.url, "/api/workbench/v1/runs/run-review-1");
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(result.body.data.run.status, "waiting_review");
});

test("Run ProductClient submits a Review decision with the supplied idempotency key", async () => {
  let captured;
  const client = createRunProductClient({
    csrfToken: () => "csrf-run-review",
    fetch: async (url, init) => {
      captured = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: {
          decision: {
            schemaVersion: "workbench-v1", decisionId: "review-1", runId: run.runId,
            nodeId: "node-review", decision: "reject", requestedChanges: [], decidedBy: "user-owner",
            decidedAt: "2026-08-12T00:01:00.000Z", idempotencyKey: "review-reject-1",
            createdAt: "2026-08-12T00:01:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z",
          },
          run: {
            ...run,
            status: "cancelled",
            currentNodeId: null,
            reviewDecisions: [{
              schemaVersion: "workbench-v1", decisionId: "review-1", runId: run.runId,
              nodeId: "node-review", decision: "reject", requestedChanges: [], decidedBy: "user-owner",
              decidedAt: "2026-08-12T00:01:00.000Z", idempotencyKey: "review-reject-1",
              createdAt: "2026-08-12T00:01:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z",
            }],
            finishedAt: "2026-08-12T00:01:00.000Z",
            updatedAt: "2026-08-12T00:01:00.000Z",
          },
        },
        requestId: "request-run-reject",
      });
    },
  });
  const result = await client.call("submitReviewDecision", {
    pathParams: { runId: run.runId },
    headers: { "Idempotency-Key": "review-reject-1" },
    body: { schemaVersion: "workbench-api-v1", data: {
      nodeId: "node-review", decision: "reject", requestedChanges: [],
    } },
  });
  assert.equal(captured.url, "/api/workbench/v1/runs/run-review-1/review-decisions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-run-review");
  assert.equal(captured.init.headers.get("Idempotency-Key"), "review-reject-1");
  assert.equal(result.body.data.run.status, "cancelled");
});

test("Run ProductClient submits a cancellation through the typed Run endpoint", async () => {
  let captured;
  const client = createRunProductClient({
    csrfToken: () => "csrf-run-cancel",
    fetch: async (url, init) => {
      captured = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: { runId: run.runId },
        requestId: "request-run-cancel",
      }, { status: 202 });
    },
  });
  const result = await client.call("cancelRun", {
    pathParams: { runId: run.runId },
    headers: { "Idempotency-Key": "run-cancel-1" },
    body: { schemaVersion: "workbench-api-v1", data: { reason: "Stop safely." } },
  });
  assert.equal(captured.url, "/api/workbench/v1/runs/run-review-1/cancel");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-run-cancel");
  assert.equal(captured.init.headers.get("Idempotency-Key"), "run-cancel-1");
  assert.equal(result.body.data.runId, run.runId);
});

test("Run ProductClient retries through the same typed command boundary", async () => {
  let captured;
  const client = createRunProductClient({
    csrfToken: () => "csrf-run-retry",
    fetch: async (url, init) => {
      captured = { url, init };
      return response({
        schemaVersion: "workbench-api-v1",
        data: { runId: "run-review-retry-1" },
        requestId: "request-run-retry",
      }, { status: 202 });
    },
  });
  const result = await client.call("retryRun", {
    pathParams: { runId: run.runId },
    headers: { "Idempotency-Key": "run-retry-1" },
    body: { schemaVersion: "workbench-api-v1", data: { reason: "Retry safely." } },
  });
  assert.equal(captured.url, "/api/workbench/v1/runs/run-review-1/retry");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-run-retry");
  assert.equal(captured.init.headers.get("Idempotency-Key"), "run-retry-1");
  assert.equal(result.body.data.runId, "run-review-retry-1");
});

test("Run ProductClient fails closed before a malformed Review request reaches the network", async () => {
  let fetchCount = 0;
  const client = createRunProductClient({ fetch: async () => { fetchCount += 1; return response({}); } });
  await assert.rejects(
    client.call("submitReviewDecision", /** @type {never} */ ({
      pathParams: { runId: run.runId },
      headers: { "Idempotency-Key": "review-invalid" },
      body: { schemaVersion: "workbench-api-v1", data: { nodeId: "node-review", decision: "reject" } },
    })),
    (error) => error instanceof ProductClientProtocolError && error.stage === "request_body",
  );
  assert.equal(fetchCount, 0);
});
