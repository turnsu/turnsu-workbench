import assert from "node:assert/strict";
import test from "node:test";

import { ProductClientProtocolError } from "../dist/index.js";
import { createAutomationProductClient } from "../dist/automation.js";
import { createScopeProductClient } from "../dist/scope.js";

const hash = `sha256:${"a".repeat(64)}`;
const scope = {
  schemaVersion: "workbench-v1",
  scopeId: "scope-personal",
  workspaceId: "workspace-team",
  kind: "personal",
  ownerUserId: "user-owner",
  policy: {
    policyRevisionId: "policy-1",
    observationTier: "private",
    defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
  },
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};
const candidate = {
  loopVersionId: "loop-daily-v1",
  workflowId: "workflow-daily",
  scopeId: "scope-personal",
  name: "Daily brief",
  description: "Creates the daily brief.",
  version: "1.0.0",
  inputBindings: [{
    bindingId: "resource-brief-1.0.0",
    inputKey: "resource-brief",
    label: "Daily brief source",
    source: { kind: "resource", resourceId: "resource-brief", version: "1.0.0", contentHash: hash },
  }],
  connectionRequirements: [{
    requirementId: "calendar-read",
    capabilityKey: "calendar.read",
    description: "Read calendar events.",
    requiredEffects: ["calendar.read"],
    eligibleConnectionIds: ["connection-calendar"],
  }],
};

const occurrence = {
  occurrenceId: "occurrence-daily",
  automationId: "automation-daily",
  triggerRevision: 1,
  scheduledFor: "2026-08-12T09:00:00.000Z",
  localScheduleDate: "2026-08-12",
  dedupeKey: "automation-daily:1:2026-08-12",
  status: "accepted",
  commandId: "command-daily",
  runId: "run-daily",
  workflowId: "workflow-daily",
  runStatus: "waiting_review",
  reasonCode: null,
  createdAt: "2026-08-12T09:00:00.000Z",
  updatedAt: "2026-08-12T09:01:00.000Z",
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("Automation ProductClient exposes only product-safe candidates and preserves private cache headers", async () => {
  let captured;
  const client = createAutomationProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        schemaVersion: "workbench-api-v1",
        data: [candidate],
        page: { nextCursor: null, hasMore: false },
        requestId: "request-automation-candidates",
      }, { headers: { "Cache-Control": "private, no-store" } });
    },
  });

  const result = await client.call("listAutomationCandidates", {
    query: { scopeId: "scope-personal", limit: 10 },
  });

  assert.equal(captured.url, "/api/workbench/v1/automations/candidates?scopeId=scope-personal&limit=10");
  assert.equal(captured.init.credentials, "same-origin");
  assert.deepEqual(result.body.data, [candidate]);
  assert.deepEqual(result.headers, { "Cache-Control": "private, no-store" });
});

test("Automation ProductClient rejects secret-bearing candidates before they reach a browser", async () => {
  const client = createAutomationProductClient({
    fetch: async () => jsonResponse({
      schemaVersion: "workbench-api-v1",
      data: [{
        ...candidate,
        connectionRequirements: [{ ...candidate.connectionRequirements[0], secretBindingId: "secret-hidden" }],
      }],
      page: { nextCursor: null, hasMore: false },
      requestId: "request-automation-candidates",
    }, { headers: { "Cache-Control": "private, no-store" } }),
  });

  await assert.rejects(
    client.call("listAutomationCandidates", {}),
    (error) => error instanceof ProductClientProtocolError && error.stage === "response_body",
  );
});

test("Automation ProductClient preserves an accepted occurrence Run state as a read-only projection", async () => {
  let captured;
  const client = createAutomationProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        schemaVersion: "workbench-api-v1",
        data: [occurrence],
        page: { nextCursor: null, hasMore: false },
        requestId: "request-automation-occurrences",
      }, { headers: { "Cache-Control": "private, no-store" } });
    },
  });

  const result = await client.call("listAutomationOccurrences", {
    pathParams: { automationId: "automation-daily" },
    query: { limit: 10 },
  });

  assert.equal(captured.url, "/api/workbench/v1/automations/automation-daily/occurrences?limit=10");
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(result.body.data[0].runStatus, "waiting_review");
});

test("Scope ProductClient requires the current entity ETag for a policy revision", async () => {
  let captured;
  const client = createScopeProductClient({
    csrfToken: () => "csrf-scope-policy",
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        schemaVersion: "workbench-api-v1",
        data: scope,
        requestId: "request-scope-policy",
      }, { headers: { "Cache-Control": "private, no-store", ETag: '"scopev1:scope-personal:2:policy-2"' } });
    },
  });

  const result = await client.call("reviseScopePolicy", {
    pathParams: { scopeId: "scope-personal" },
    headers: {
      "Idempotency-Key": "scope-policy-2",
      "If-Match": '"scopev1:scope-personal:1:policy-1"',
    },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        observationTier: "private",
        defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
      },
    },
  });

  assert.equal(captured.url, "/api/workbench/v1/scopes/scope-personal/policy");
  assert.equal(captured.init.method, "PATCH");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-scope-policy");
  assert.equal(captured.init.headers.get("If-Match"), '"scopev1:scope-personal:1:policy-1"');
  assert.equal(result.headers.ETag, '"scopev1:scope-personal:2:policy-2"');
});
