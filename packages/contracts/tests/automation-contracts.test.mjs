import assert from "node:assert/strict";
import test from "node:test";

import {
  AutomationResponseSchema,
  Check,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS,
  WORKBENCH_V1_SCOPE_ENDPOINTS,
} from "../dist/index.js";

const hash = `sha256:${"a".repeat(64)}`;
const automation = {
  schemaVersion: "workbench-v1",
  variant: "daily_cron_v1",
  automationId: "automation-daily",
  workspaceId: "workspace-local",
  scopeId: "scope-personal",
  ownerId: "user-owner",
  displayName: "Daily brief",
  loopVersionId: "loop-v1",
  loopContentHash: hash,
  triggerRevision: 1,
  trigger: { kind: "daily_cron", expression: "0 9 * * *", timezone: "Asia/Hong_Kong" },
  inputBindings: [{
    bindingId: "brief-input",
    inputKey: "brief",
    source: { kind: "resource", resourceId: "resource-brief", version: "1.0.0", contentHash: hash },
  }],
  connectionBindings: [{
    requirementId: "calendar-read",
    connectionId: "connection-calendar",
    revision: 1,
    secretBindingId: "secret-calendar",
    storeBindingRevision: 1,
  }],
  executionLocationPolicy: "cloud",
  modelPolicy: { policyRevisionId: "model-policy-1", modelProfileRevisionIds: ["model-revision-1"] },
  budgetPolicy: { maxCostUsdMicros: 1000000, maxRuntimeSeconds: 600 },
  approvalPolicy: {
    policyRevisionId: "policy-1",
    permissionMode: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
  },
  misfirePolicy: { kind: "run_once", maxLatenessSeconds: 300 },
  dedupePolicy: { kind: "scheduled_occurrence" },
  grantId: "policy-grant-1",
  grantRevision: 1,
  grantExpiresAt: "2026-08-30T01:00:00.000Z",
  grantReviewAt: "2026-08-20T01:00:00.000Z",
  status: "active",
  blockedReasonCode: null,
  nextRunAt: "2026-08-12T01:00:00.000Z",
  lastRunAt: null,
  lastOutcome: null,
  failureStreak: 0,
  revision: 1,
  createdAt: "2026-08-11T01:00:00.000Z",
  updatedAt: "2026-08-11T01:00:00.000Z",
};

const candidate = {
  loopVersionId: "loop-v1",
  workflowId: "workflow-daily",
  scopeId: "scope-personal",
  name: "Daily brief",
  description: "Creates a concise daily brief.",
  version: "1.0.0",
  inputBindings: [{
    bindingId: "resource-brief-1.0.0",
    inputKey: "brief",
    label: "Daily brief source",
    source: { kind: "resource", resourceId: "resource-brief", version: "1.0.0", contentHash: hash },
  }],
  connectionRequirements: [{
    requirementId: "calendar-read",
    capabilityKey: "calendar.read",
    description: "Read calendar events for the brief.",
    requiredEffects: ["calendar.read"],
    eligibleConnectionIds: ["connection-calendar"],
  }],
};

const acceptedOccurrence = {
  occurrenceId: "occurrence-daily",
  automationId: "automation-daily",
  workflowId: "workflow-daily",
  triggerRevision: 1,
  scheduledFor: "2026-08-12T01:00:00.000Z",
  localScheduleDate: "2026-08-12",
  dedupeKey: "automation-daily:1:2026-08-12",
  status: "accepted",
  commandId: "command-daily",
  runId: "run-daily",
  runStatus: "running",
  reasonCode: null,
  createdAt: "2026-08-12T01:00:00.000Z",
  updatedAt: "2026-08-12T01:01:00.000Z",
};

test("Automation and Scope endpoints expose private, revision-safe product contracts", () => {
  const endpoints = WORKBENCH_V1_AUTOMATION_ENDPOINTS;
  assert.equal(endpoints.createAutomation.method, "POST");
  assert.equal(endpoints.createAutomation.successStatus, 201);
  assert.equal(endpoints.listAutomationCandidates.path, "/api/workbench/v1/automations/candidates");
  assert.equal(endpoints.listAutomationCandidates.method, "GET");
  assert.deepEqual(endpoints.listAutomationCandidates.responseHeaders, ["Cache-Control"]);
  assert.equal(Check(endpoints.listAutomationCandidates.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [candidate],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-automation-candidates",
  }), true);
  assert.equal(Check(endpoints.listAutomationCandidates.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [{
      ...candidate,
      connectionRequirements: [{ ...candidate.connectionRequirements[0], secretBindingId: "secret-hidden" }],
    }],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-automation-candidates",
  }), false, "candidate discovery must not expose credential bindings");
  assert.deepEqual(endpoints.createAutomation.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.deepEqual(endpoints.createAutomation.responseHeaders, ["Cache-Control", "ETag"]);
  assert.equal(Check(endpoints.createAutomation.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      scopeId: "scope-personal",
      displayName: "Daily brief",
      loopVersionId: "loop-v1",
      trigger: { kind: "daily_cron", expression: "0 9 * * *", timezone: "Asia/Hong_Kong" },
      inputBindings: automation.inputBindings,
      connectionBindings: [{ requirementId: "calendar-read", connectionId: "connection-calendar" }],
      budgetPolicy: automation.budgetPolicy,
      misfirePolicy: automation.misfirePolicy,
      grantExpiresAt: "2026-08-30T01:00:00.000Z",
    },
  }), true);
  assert.equal(Check(endpoints.createAutomation.requestBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      scopeId: "scope-personal",
      displayName: "Daily brief",
      loopVersionId: "loop-v1",
      trigger: { kind: "daily_cron", expression: "0 9 * * *", timezone: "Asia/Hong_Kong" },
      inputBindings: automation.inputBindings,
      connectionBindings: automation.connectionBindings,
      budgetPolicy: automation.budgetPolicy,
      misfirePolicy: automation.misfirePolicy,
      grantExpiresAt: "2026-08-30T01:00:00.000Z",
    },
  }), false, "clients cannot select a hidden Connection revision or secret binding");
  for (const endpoint of [endpoints.reviseAutomation, endpoints.activateAutomation, endpoints.pauseAutomation, endpoints.archiveAutomation]) {
    assert.deepEqual(endpoint.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
  }
  assert.equal(Check(AutomationResponseSchema, {
    schemaVersion: "workbench-api-v1",
    data: automation,
    requestId: "request-automation",
  }), true);
  assert.equal(Check(AutomationResponseSchema, {
    schemaVersion: "workbench-api-v1",
    data: { ...automation, automationRevisionId: "hidden" },
    requestId: "request-automation",
  }), false, "the API never exposes the internal Automation revision identifier");
  assert.equal(Check(endpoints.listAutomationOccurrences.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [acceptedOccurrence],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-automation-occurrences",
  }), true);
  assert.equal(Check(endpoints.listAutomationOccurrences.responseBodySchema, {
    schemaVersion: "workbench-api-v1",
    data: [{ ...acceptedOccurrence, runStatus: undefined }],
    page: { nextCursor: null, hasMore: false },
    requestId: "request-automation-occurrences",
  }), false, "accepted occurrences must expose either their current Run status or an explicit null");
  assert.equal(WORKBENCH_V1_SCOPE_ENDPOINTS.reviseScopePolicy.path, "/api/workbench/v1/scopes/{scopeId}/policy");
  assert.deepEqual(WORKBENCH_V1_SCOPE_ENDPOINTS.reviseScopePolicy.requiredRequestHeaders, ["Idempotency-Key", "If-Match"]);
});
