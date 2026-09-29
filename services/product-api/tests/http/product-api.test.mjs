import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  Check,
  PUBLIC_ENDPOINTS,
  WORKBENCH_V1_ENDPOINTS,
  WORKBENCH_V1_AUTOMATION_ENDPOINTS,
  WORKBENCH_V1_DEVICE_ENDPOINTS,
  WORKBENCH_V1_SCOPE_ENDPOINTS,
  WORKBENCH_V1_INBOX_ENDPOINTS,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
  WORKBENCH_V1_READINESS_ENDPOINTS,
  WORKBENCH_V1_TRACE_ENDPOINTS,
  WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS,
} from "@turnsu/workbench-contracts";
import {
  compileWorkflowResponseExample,
  createSkillTestRequestExample,
  createSkillValidationRequestExample,
  mutationRequestExamples,
  reviewDecisionResponseExample,
  runDetailResponseExample,
  runEventExample,
  runHistoryResponseExample,
  saveWorkflowRevisionResponseExample,
  skillDetailResponseExample,
  skillTestRunExample,
  skillTestRunResponseExample,
  skillValidationRecordExample,
  skillValidationResponseExample,
  skillDraftExample,
  skillDraftPackageExample,
  replaceSkillDraftPackageRequestExample,
  skillVersionListResponseExample,
  skillListResponseExample,
  startRunRequestExample,
  startRunResponseExample,
  templateDetailResponseExample,
  templateListResponseExample,
  workflowDetailResponseExample,
  workflowListResponseExample,
  workflowRevisionResponseExample,
  workspaceResponseExample,
} from "../../../../packages/contracts/examples/canonical-examples.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";

const clone = (value) => structuredClone(value);

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.body = "";
    this.headersSent = false;
  }

  writeHead(status, headers = {}) {
    assert.equal(this.headersSent, false, "HTTP headers can only be sent once");
    this.headersSent = true;
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  }

  write(value) { this.body += value; }

  end(value = "") { this.body += value; this.ended = true; this.emit("finish"); }
}

function makeRequest({ method = "GET", url, headers = {}, body } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = { host: "127.0.0.1", ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) };
  request[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  };
  return request;
}

const parseJson = (response) => JSON.parse(response.body);

const publicDraft = (draft) => ({
  schemaVersion: draft.schemaVersion,
  skillDraftId: draft.skillDraftId,
  skillId: draft.skillId,
  baseVersionId: draft.baseVersionId,
  revision: draft.revision,
  name: draft.name,
  description: draft.description,
  category: draft.category,
  inputSchema: clone(draft.inputSchema),
  outputSchema: clone(draft.outputSchema),
  risk: clone(draft.risk),
  dependencies: clone(draft.dependencies),
  connectionRequirements: clone(draft.connectionRequirements),
  fileCount: draft.files.length,
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt,
});

const publicSkill = (skill) => ({
  schemaVersion: skill.schemaVersion,
  skillId: skill.skillId,
  visibility: skill.visibility,
  lifecycle: skill.lifecycle,
  currentDraftId: skill.currentDraftId,
  latestPublishedVersionId: skill.latestPublishedVersionId,
  allowedActions: skill.lifecycle === "draft"
    ? ["edit"]
    : skill.lifecycle === "tested"
      ? ["edit", "publish"]
      : skill.lifecycle === "published"
        ? ["create_version", "retire"]
        : [],
  createdAt: skill.createdAt,
  updatedAt: skill.updatedAt,
});

const makeApplication = () => ({
  async workspace() { return clone(workspaceResponseExample.data); },
  async getWorkspaceFeatureReadiness() {
    return {
      data: {
        schemaVersion: "workbench-v1",
        workspaceId: "workspace-local",
        workspaceRole: "owner",
        evaluatedAt: "2026-07-10T10:00:00.000Z",
        actions: {
          promptSkill: {},
          scriptSkill: {},
          registeredToolSkill: {},
          skillDirectoryImport: {},
          skillZipImport: {},
          publicGithubSkillImport: {},
          serverSkillImport: {},
          blankLoop: {},
          stagedLoopProposal: {},
          connectionSetup: {},
          workspaceResource: {},
        },
        support: {
          readyRuntimeIds: [],
          registeredToolPackageCount: 0,
          selectableBuilderModelCount: 0,
          readyAttachmentMediaTypes: [],
          unavailableAttachmentMediaTypes: [],
        },
      },
      responseHeaders: { "Cache-Control": "private, no-store" },
    };
  },
  async getProductTrace({ productCommandId }) {
    return {
      schemaVersion: "workbench-v1",
      productCommandId,
      workspaceId: "workspace-local",
      nodes: [{
        nodeId: `product_command:${productCommandId}`,
        kind: "product_command",
        entityId: productCommandId,
        parentNodeId: null,
        status: "completed",
        occurredAt: "2026-07-10T10:00:00.000Z",
      }],
    };
  },
  async createResourceFromAttachment({ request }) {
    return {
      data: {
        schemaVersion: "workbench-v1",
        resourceId: "resource-from-attachment",
        workspaceId: "workspace-local",
        version: "1.0.0",
        label: request.data.label,
        mediaType: request.data.attachment.mediaType,
        sizeBytes: 128,
        contentHash: request.data.attachment.contentHash,
        source: {
          kind: "attachment",
          attachment: clone(request.data.attachment),
          sourceMediaType: request.data.attachment.mediaType,
          derivedText: false,
        },
        readiness: { status: "ready" },
        createdAt: "2026-07-10T10:00:00.000Z",
        updatedAt: "2026-07-10T10:00:00.000Z",
      },
    };
  },
  async listSkills() { return clone(skillListResponseExample.data); },
  async listSkillRuntimes() {
    return {
      data: [{
        runtimeId: "python3.12",
        label: "Python",
        language: "python",
        versionLabel: "Python 3.12",
        entrypoint: "scripts/main.py",
        availability: "ready",
        availabilityReason: null,
        isolation: "container",
        network: false,
        filesystem: "scratch-only",
        timeoutSeconds: { minimum: 1, maximum: 120, step: 1, default: 30 },
        memoryMiB: { minimum: 64, maximum: 512, step: 64, default: 128 },
      }],
      page: { nextCursor: null, hasMore: false },
    };
  },
  async listRegisteredToolPackages() {
    return {
      data: [{
        toolPackageId: "registered:lark-task",
        skillName: "lark-task",
        label: "Lark Tasks",
        description: "Read assigned tasks and create governed follow-up tasks after confirmation.",
        registrationStatus: "registered",
        actions: [{
          actionId: "lark.task.create",
          effect: "write",
          confirmationRequired: true,
        }],
      }],
      page: { nextCursor: null, hasMore: false },
    };
  },
  async scaffoldSkillDraftPackage() {
    const content = Buffer.from(`---
name: http-scaffold
description: "HTTP scaffold"
compatibility: Local only
disable-model-invocation: false
outputs:
  - name: result
    type: json
    description: "Result"
---

# HTTP scaffold
`, "utf8");
    return {
      filename: "http-scaffold-prompt-draft",
      sizeBytes: content.byteLength,
      files: [{ path: "SKILL.md", contentBase64: content.toString("base64") }],
    };
  },
  async getSkill() { return clone(skillDetailResponseExample.data); },
  async createSkillTest() { return clone(skillTestRunResponseExample.data); },
  async getSkillTestRun() { return clone(skillTestRunResponseExample.data); },
  async cancelSkillTest() { return skillTestRunExample.testRunId; },
  async createSkillValidation() { return clone(skillValidationResponseExample.data); },
  async getSkillValidation() { return clone(skillValidationResponseExample.data); },
  async listSkillVersions() {
    return {
      data: clone(skillVersionListResponseExample.data),
      page: clone(skillVersionListResponseExample.page),
    };
  },
  async listTemplates() { return clone(templateListResponseExample.data); },
  async getTemplate() { return clone(templateDetailResponseExample.data); },
  async listWorkflows() { return clone(workflowListResponseExample.data); },
  async getWorkflow() { return { data: clone(workflowDetailResponseExample.data), etag: '"revision-reviewed-brief-1"' }; },
  async getWorkflowRevision() { return { data: clone(workflowRevisionResponseExample.data), etag: '"revision-reviewed-brief-1"' }; },
  async saveWorkflowRevision() { return { data: clone(saveWorkflowRevisionResponseExample.data), etag: '"revision-reviewed-brief-2"' }; },
  async compileWorkflow() { return clone(compileWorkflowResponseExample.data); },
  async startRun() { return clone(startRunResponseExample.data); },
  async startLoopAgentTask() {
    const run = clone(startRunResponseExample.data);
    return {
      session: {
        schemaVersion: "workbench-v1",
        sessionId: "agent-session-loop-http",
        definitionId: "main",
        userId: "user-local",
        workspaceId: "workspace-local",
        scope: { kind: "main" },
        title: "Reviewed research brief",
        source: {
          kind: "loop_run",
          workflowId: run.workflowId,
          workflowRevisionId: run.workflowRevisionId,
          runId: run.runId,
        },
        taskStatus: "queued",
        archived: false,
        status: "active",
        lastUsedModelProfileId: null,
        modelPreferenceState: "preference_only",
        activeTurnId: null,
        createdAt: "2026-07-10T10:00:00.000Z",
        updatedAt: "2026-07-10T10:00:00.000Z",
      },
      run,
    };
  },
  async listWorkflowRuns() { return clone(runHistoryResponseExample.data); },
  async listRecentWork() {
    return {
      data: [{
        runId: "run-reviewed-brief-1",
        workflowId: "workflow-reviewed-brief",
        title: "Reviewed research brief",
        status: "completed",
        updatedAt: "2026-07-10T10:00:00.000Z",
      }],
    };
  },
  async getRun() { return clone(runDetailResponseExample.data); },
  async submitReviewDecision() { return clone(reviewDecisionResponseExample.data); },
  async cancelRun({ runId }) { return { runId }; },
  async retryRun({ runId }) { return { runId: `retry-${runId}` }; },
  async listEvents({ after }) {
    this.lastEventsAfter = after;
    return [clone(runEventExample)];
  },
  async replaySessionDomainEvents({ query }) {
    this.lastSessionDomainAfter = query.after;
    return {
      events: [{
        domain: "session", seq: 8, eventId: "session-event-http", sessionId: "session-http",
        sessionKind: "personal_task", sessionSequence: 3, scopeId: "scope-local",
        actor: { principalId: "user-local", kind: "user" },
        authorizer: { kind: "principal", principal: { principalId: "user-local", kind: "user" } },
        lineage: { productCommandId: "command-http", turnId: "turn-http" },
        payloadClass: "product_safe",
        payloadRef: {
          id: "session-event-http", kind: "turn_completed", state: "completed",
          contentHash: `sha256:${"a".repeat(64)}`,
        },
        occurredAt: "2026-07-10T10:00:00.000Z",
      }],
      watermark: { domain: "session", scopeId: "scope-local", seq: 8 },
      hasMore: false,
    };
  },
  subscribe(_runId, listener) {
    queueMicrotask(() => listener(clone(runEventExample)));
    return () => { this.unsubscribed = true; };
  },
});

function setup({ application = makeApplication(), ...handlerOptions } = {}) {
  const handler = createWorkbenchHttpHandler({
    application,
    origin: "http://127.0.0.1",
    requestIdFactory: () => "request-http-1",
    sessionTokenFactory: () => "session-token-1234567890",
    csrfTokenFactory: () => "csrf-token-1234567890-abcdefghijklmnopqrstuvwxyz",
    clock: () => new Date("2026-07-10T10:00:00.000Z"),
    allowTestSessionBootstrap: true,
    ...handlerOptions,
  });
  return { application, handler };
}

async function invoke(handler, options) {
  const request = makeRequest(options);
  const response = new MockResponse();
  await handler(request, response);
  return { request, response };
}

async function bootstrap(handler) {
  const { response } = await invoke(handler, { url: "/api/workbench/v1/workspace" });
  const body = parseJson(response);
  return { csrf: body.data.session.csrfToken, cookie: response.headers["set-cookie"].split(";")[0] };
}

const mutationHeaders = ({ csrf, cookie, ifMatch } = {}) => ({
  Cookie: cookie,
  Origin: "http://127.0.0.1",
  "Sec-Fetch-Site": "same-origin",
  "X-Workbench-CSRF": csrf,
  "Idempotency-Key": "idem-http-001",
  "Content-Type": "application/json",
  ...(ifMatch ? { "If-Match": ifMatch } : {}),
});

const automationHttpExample = {
  schemaVersion: "workbench-v1",
  variant: "daily_cron_v1",
  automationId: "automation-daily",
  workspaceId: "workspace-local",
  scopeId: "scope-personal",
  ownerId: "user-local",
  displayName: "Daily brief",
  loopVersionId: "loop-daily-v1",
  loopContentHash: `sha256:${"a".repeat(64)}`,
  triggerRevision: 1,
  trigger: { kind: "daily_cron", expression: "0 9 * * *", timezone: "Etc/UTC" },
  inputBindings: [],
  connectionBindings: [],
  executionLocationPolicy: "cloud",
  modelPolicy: { policyRevisionId: "model-policy-1", modelProfileRevisionIds: [] },
  budgetPolicy: { maxCostUsdMicros: 1000, maxRuntimeSeconds: 300 },
  approvalPolicy: {
    policyRevisionId: "scope-policy-1",
    permissionMode: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
  },
  misfirePolicy: { kind: "run_once", maxLatenessSeconds: 300 },
  dedupePolicy: { kind: "scheduled_occurrence" },
  grantId: "automation-grant-1",
  grantRevision: 1,
  grantExpiresAt: "2026-08-20T00:00:00.000Z",
  grantReviewAt: null,
  status: "active",
  blockedReasonCode: null,
  nextRunAt: "2026-08-12T09:00:00.000Z",
  lastRunAt: null,
  lastOutcome: null,
  failureStreak: 0,
  revision: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const automationOccurrenceHttpExample = {
  occurrenceId: "occurrence-daily",
  automationId: "automation-daily",
  workflowId: "workflow-daily",
  triggerRevision: 1,
  scheduledFor: "2026-08-12T09:00:00.000Z",
  localScheduleDate: "2026-08-12",
  dedupeKey: "automation-daily:1:2026-08-12",
  status: "accepted",
  commandId: "command-daily",
  runId: "run-daily",
  runStatus: "queued",
  reasonCode: null,
  createdAt: "2026-08-12T09:00:00.000Z",
  updatedAt: "2026-08-12T09:00:00.000Z",
};

const deviceHttpExample = {
  schemaVersion: "workbench-v1",
  deviceId: "device-alice-mac",
  workspaceId: "workspace-local",
  ownerUserId: "user-local",
  displayName: "Local Mac",
  platform: "macos",
  architecture: "arm64",
  appVersion: "0.3.0",
  workerProtocolVersion: "workbench-device-worker-v1",
  publicIdentity: `sha256:${"c".repeat(64)}`,
  capabilityInventory: ["file_read", "notification"],
  registrationStatus: "active",
  health: "ready",
  lastSeenAt: "2026-08-13T01:00:00.000Z",
  updateRequired: false,
  revision: 1,
  createdAt: "2026-08-13T01:00:00.000Z",
  updatedAt: "2026-08-13T01:00:00.000Z",
  revokedAt: null,
};

test("Device routes require native bearer identity for registration and preserve browser inventory reads", async () => {
  const application = makeApplication();
  const calls = [];
  application.listDevices = async (input) => {
    calls.push(["listDevices", input]);
    return { data: [deviceHttpExample], page: { nextCursor: null, hasMore: false }, responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.registerDevice = async (input) => {
    calls.push(["registerDevice", input]);
    return { data: deviceHttpExample, responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  const nativeSession = {
    clientSessionId: "native-session-device",
    userId: "user-local",
    activeWorkspaceId: "workspace-local",
    clientKind: "desktop",
    devicePublicKey: "A".repeat(43),
    expiresAt: "2026-08-14T01:00:00.000Z",
  };
  const authService = {
    async authenticateNativeAccessToken({ accessToken }) {
      return accessToken === "native-device-token" ? nativeSession : null;
    },
  };
  const { handler } = setup({ application, authService });
  const session = await bootstrap(handler);

  const listed = await invoke(handler, {
    url: "/api/workbench/v1/devices",
    headers: { Cookie: session.cookie },
  });
  assert.equal(listed.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_DEVICE_ENDPOINTS.listDevices.responseBodySchema, parseJson(listed.response)), true);

  const request = {
    schemaVersion: "workbench-api-v1",
    data: {
      displayName: "Local Mac",
      platform: "macos",
      architecture: "arm64",
      appVersion: "0.3.0",
      workerProtocolVersion: "workbench-device-worker-v1",
      capabilityInventory: ["file_read", "notification"],
    },
  };
  const browserAttempt = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/devices",
    headers: mutationHeaders(session),
    body: request,
  });
  assert.equal(browserAttempt.response.status, 403);
  assert.equal(parseJson(browserAttempt.response).code, "device_native_session_required");

  const native = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/devices",
    headers: {
      Authorization: "Bearer native-device-token",
      "Idempotency-Key": "native-device-register-1",
      "Content-Type": "application/json",
    },
    body: request,
  });
  assert.equal(native.response.status, 201, native.response.body);
  assert.equal(Check(WORKBENCH_V1_DEVICE_ENDPOINTS.registerDevice.responseBodySchema, parseJson(native.response)), true);
  assert.deepEqual(calls.map(([kind]) => kind), ["listDevices", "registerDevice"]);
  assert.equal(calls[1][1].auth.clientSessionId, "native-session-device");
  assert.equal(calls[1][1].idempotencyKey, "native-device-register-1");
});

test("Automation and Scope routes forward browser authority, revisions, and private response headers", async () => {
  const application = makeApplication();
  const calls = [];
  const scope = {
    schemaVersion: "workbench-v1",
    scopeId: "scope-personal",
    workspaceId: "workspace-local",
    kind: "personal",
    ownerUserId: "user-local",
    policy: {
      policyRevisionId: "scope-policy-1",
      observationTier: "private",
      defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
    },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  application.listScopes = async (input) => {
    calls.push(["listScopes", input]);
    return { data: [scope], page: { nextCursor: null, hasMore: false }, responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.getScope = async (input) => {
    calls.push(["getScope", input]);
    return { data: scope, etag: '"scopev1:scope-personal:1:scope-policy-1"', responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.reviseScopePolicy = async (input) => {
    calls.push(["reviseScopePolicy", input]);
    return { data: scope, etag: '"scopev1:scope-personal:2:scope-policy-2"', responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.listAutomations = async (input) => {
    calls.push(["listAutomations", input]);
    return { data: [automationHttpExample], page: { nextCursor: null, hasMore: false }, responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.listAutomationCandidates = async (input) => {
    calls.push(["listAutomationCandidates", input]);
    return {
      data: [{
        loopVersionId: "loop-daily-v1",
        workflowId: "workflow-daily",
        scopeId: "scope-personal",
        name: "Daily brief Loop",
        description: "Creates the team's daily brief.",
        version: "1.0.0",
        inputBindings: [{
          bindingId: "resource-brief-1.0.0",
          inputKey: "brief",
          label: "Daily brief",
          source: {
            kind: "resource",
            resourceId: "resource-brief",
            version: "1.0.0",
            contentHash: `sha256:${"b".repeat(64)}`,
          },
        }],
        connectionRequirements: [{
          requirementId: "calendar-read",
          capabilityKey: "calendar.read",
          description: "Read the team calendar.",
          requiredEffects: ["calendar.read"],
          eligibleConnectionIds: ["connection-calendar"],
        }],
      }],
      page: { nextCursor: null, hasMore: false },
      responseHeaders: { "Cache-Control": "private, no-store" },
    };
  };
  application.getAutomation = async (input) => {
    calls.push(["getAutomation", input]);
    return { data: automationHttpExample, etag: '"autv1:automation-daily:1:1"', responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.createAutomation = async (input) => {
    calls.push(["createAutomation", input]);
    return { data: automationHttpExample, etag: '"autv1:automation-daily:1:1"', responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.pauseAutomation = async (input) => {
    calls.push(["pauseAutomation", input]);
    return { data: { ...automationHttpExample, status: "paused", nextRunAt: null }, etag: '"autv1:automation-daily:2:1"', responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  application.listAutomationOccurrences = async (input) => {
    calls.push(["listAutomationOccurrences", input]);
    return { data: [automationOccurrenceHttpExample], page: { nextCursor: null, hasMore: false }, responseHeaders: { "Cache-Control": "private, no-store" } };
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const listed = await invoke(handler, {
    url: "/api/workbench/v1/automations?status=active&limit=10",
    headers: { Cookie: session.cookie },
  });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.response.headers["cache-control"], "private, no-store");
  assert.equal(Check(WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomations.responseBodySchema, parseJson(listed.response)), true);
  const candidates = await invoke(handler, {
    url: "/api/workbench/v1/automations/candidates?scopeId=scope-personal&limit=10",
    headers: { Cookie: session.cookie },
  });
  assert.equal(candidates.response.status, 200);
  assert.equal(candidates.response.headers["cache-control"], "private, no-store");
  assert.equal(Check(WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomationCandidates.responseBodySchema, parseJson(candidates.response)), true);
  const created = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/automations",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        scopeId: "scope-personal",
        displayName: "Daily brief",
        loopVersionId: "loop-daily-v1",
        trigger: automationHttpExample.trigger,
        inputBindings: [],
        connectionBindings: [],
        budgetPolicy: automationHttpExample.budgetPolicy,
        misfirePolicy: automationHttpExample.misfirePolicy,
        grantExpiresAt: "2026-08-20T00:00:00.000Z",
      },
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.etag, '"autv1:automation-daily:1:1"');
  const paused = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/automations/automation-daily/pause",
    headers: mutationHeaders({ ...session, ifMatch: '"autv1:automation-daily:1:1"' }),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(paused.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_AUTOMATION_ENDPOINTS.pauseAutomation.responseBodySchema, parseJson(paused.response)), true);
  const policy = await invoke(handler, {
    method: "PATCH",
    url: "/api/workbench/v1/scopes/scope-personal/policy",
    headers: mutationHeaders({ ...session, ifMatch: '"scopev1:scope-personal:1:scope-policy-1"' }),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { observationTier: "private", defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] } },
    },
  });
  assert.equal(policy.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_SCOPE_ENDPOINTS.reviseScopePolicy.responseBodySchema, parseJson(policy.response)), true);
  const occurrences = await invoke(handler, {
    url: "/api/workbench/v1/automations/automation-daily/occurrences?limit=10",
    headers: { Cookie: session.cookie },
  });
  assert.equal(occurrences.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_AUTOMATION_ENDPOINTS.listAutomationOccurrences.responseBodySchema, parseJson(occurrences.response)), true);
  assert.equal(parseJson(occurrences.response).data[0].runStatus, "queued");
  assert.deepEqual(calls.map(([kind]) => kind), [
    "listAutomations", "listAutomationCandidates", "createAutomation", "pauseAutomation", "reviseScopePolicy", "listAutomationOccurrences",
  ]);
  assert.equal(calls[1][1].query.scopeId, "scope-personal");
  assert.equal(calls[2][1].idempotencyKey, "idem-http-001");
  assert.equal(calls[3][1].ifMatch, '"autv1:automation-daily:1:1"');
  assert.equal(calls[4][1].ifMatch, '"scopev1:scope-personal:1:scope-policy-1"');
});

test("workspace creates a host-only HttpOnly Lax session and mutations enforce browser proof", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  assert.match(session.cookie, /^workbench_session=/);
  const second = await invoke(handler, { url: "/api/workbench/v1/workspace" });
  assert.match(second.response.headers["set-cookie"], /HttpOnly/);
  assert.match(second.response.headers["set-cookie"], /SameSite=Lax/);
  assert.doesNotMatch(second.response.headers["set-cookie"], /Domain=/);

  const readDenied = await invoke(handler, { url: "/api/workbench/v1/skills" });
  assert.equal(readDenied.response.status, 401);
  assert.equal(parseJson(readDenied.response).code, "session_required");
  const readAllowed = await invoke(handler, {
    url: "/api/workbench/v1/skills",
    headers: { Cookie: session.cookie },
  });
  assert.equal(readAllowed.response.status, 200);

  const recentDenied = await invoke(handler, { url: "/api/workbench/v1/recent-work?limit=3" });
  assert.equal(recentDenied.response.status, 401);
  assert.equal(parseJson(recentDenied.response).code, "session_required");
  const recentAllowed = await invoke(handler, {
    url: "/api/workbench/v1/recent-work?limit=3",
    headers: { Cookie: session.cookie },
  });
  assert.equal(recentAllowed.response.status, 200);
  const recentBody = parseJson(recentAllowed.response);
  assert.equal(
    Check(
      WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listRecentWork.responseBodySchema,
      recentBody,
    ),
    true,
  );
  assert.deepEqual(recentBody.data.map(({ runId, workflowId, title, status }) => ({
    runId,
    workflowId,
    title,
    status,
  })), [{
    runId: "run-reviewed-brief-1",
    workflowId: "workflow-reviewed-brief",
    title: "Reviewed research brief",
    status: "completed",
  }]);
  assert.doesNotMatch(JSON.stringify(recentBody), /workspaceId|executionSnapshot|provider/);

  const body = {
    schemaVersion: "workbench-api-v1",
    data: { reason: "Verify browser mutation protection." },
  };
  const mutationUrl = "/api/workbench/v1/runs/run-reviewed-brief-1/cancel";
  const denied = await invoke(handler, { method: "POST", url: mutationUrl, body });
  assert.equal(denied.response.status, 401);
  assert.equal(parseJson(denied.response).code, "session_required");

  const csrfDenied = await invoke(handler, {
    method: "POST", url: mutationUrl,
    headers: { ...mutationHeaders(session), "X-Workbench-CSRF": "wrong-token" }, body,
  });
  assert.equal(csrfDenied.response.status, 403);
  assert.equal(parseJson(csrfDenied.response).code, "csrf_invalid");

  const originDenied = await invoke(handler, {
    method: "POST", url: mutationUrl,
    headers: { ...mutationHeaders(session), Origin: "https://example.invalid" }, body,
  });
  assert.equal(originDenied.response.status, 403);
  assert.equal(parseJson(originDenied.response).code, "origin_forbidden");

  const fetchSiteDenied = await invoke(handler, {
    method: "POST", url: mutationUrl,
    headers: { ...mutationHeaders(session), "Sec-Fetch-Site": "cross-site" }, body,
  });
  assert.equal(fetchSiteDenied.response.status, 403);
  assert.equal(parseJson(fetchSiteDenied.response).code, "fetch_site_forbidden");

  const bearer = await invoke(handler, {
    url: "/api/workbench/v1/skills", headers: { Authorization: "Bearer daemon-token" },
  });
  assert.equal(bearer.response.status, 401);
  assert.equal(parseJson(bearer.response).code, "bearer_not_accepted");
});

test("readiness is private no-store and Attachment promotion uses the authenticated Product mutation", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const readiness = await invoke(handler, {
    url: "/api/workbench/v1/workspace/feature-readiness",
    headers: { Cookie: session.cookie },
  });
  assert.equal(readiness.response.status, 200, readiness.response.body);
  assert.equal(readiness.response.headers["cache-control"], "private, no-store");
  assert.equal(
    Check(
      WORKBENCH_V1_READINESS_ENDPOINTS.getWorkspaceFeatureReadiness.responseBodySchema,
      parseJson(readiness.response),
    ),
    true,
  );

  const contentHash = `sha256:${"a".repeat(64)}`;
  const promoted = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/resources/from-attachment",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        label: "Reference image",
        attachment: {
          attachmentId: "attachment-http",
          version: 1,
          contentHash,
          mediaType: "image/png",
        },
      },
    },
  });
  assert.equal(promoted.response.status, 201);
  assert.equal(
    Check(
      WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createResourceFromAttachment.responseBodySchema,
      parseJson(promoted.response),
    ),
    true,
  );
  assert.equal(parseJson(promoted.response).data.source.attachment.contentHash, contentHash);
});

test("Inbox is session-bound, cursor-valid, and private no-store", async () => {
  const application = makeApplication();
  application.getInbox = async () => ({
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
        actionRoute: "/loops/workflow-reviewed-brief/runs/run-review-1",
        createdAt: "2026-07-10T10:00:00.000Z",
      }],
      count: 1,
      page: { nextCursor: null, hasMore: false },
    },
    responseHeaders: { "Cache-Control": "private, no-store" },
  });
  const { handler } = setup({ application });

  const denied = await invoke(handler, { url: "/api/workbench/v1/inbox?limit=25" });
  assert.equal(denied.response.status, 401);

  const session = await bootstrap(handler);
  const result = await invoke(handler, {
    url: "/api/workbench/v1/inbox?limit=25",
    headers: { Cookie: session.cookie },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers["cache-control"], "private, no-store");
  assert.equal(
    Check(WORKBENCH_V1_INBOX_ENDPOINTS.getInbox.responseBodySchema, parseJson(result.response)),
    true,
  );

  const invalid = await invoke(handler, {
    url: "/api/workbench/v1/inbox?limit=101",
    headers: { Cookie: session.cookie },
  });
  assert.equal(invalid.response.status, 400);
});

test("Product Trace route returns only the contract-safe lineage read model", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const traced = await invoke(handler, {
    url: "/api/workbench/v1/traces/product-command-http",
    headers: { Cookie: session.cookie },
  });
  assert.equal(traced.response.status, 200);
  assert.equal(
    Check(WORKBENCH_V1_TRACE_ENDPOINTS.getProductTrace.responseBodySchema, parseJson(traced.response)),
    true,
  );
  assert.equal(JSON.stringify(parseJson(traced.response)).includes("provider"), false);
});

test("M5 runtime, registered Tool, and Loop Agent task routes dispatch through the real HTTP handler", async () => {
  const application = makeApplication();
  const calls = [];
  for (const method of [
    "listSkillRuntimes",
    "listRegisteredToolPackages",
    "scaffoldSkillDraftPackage",
    "startLoopAgentTask",
  ]) {
    const original = application[method];
    application[method] = async (input) => {
      calls.push([method, input]);
      return original(input);
    };
  }
  const { handler } = setup({ application });
  const session = await bootstrap(handler);

  const runtimes = await invoke(handler, {
    url: "/api/workbench/v1/skill-runtimes",
    headers: { Cookie: session.cookie },
  });
  assert.equal(runtimes.response.status, 200);
  assert.equal(
    Check(
      WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillRuntimes.responseBodySchema,
      parseJson(runtimes.response),
    ),
    true,
  );

  const registeredTools = await invoke(handler, {
    url: "/api/workbench/v1/registered-tool-packages",
    headers: { Cookie: session.cookie },
  });
  assert.equal(registeredTools.response.status, 200);
  assert.equal(
    Check(
      WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listRegisteredToolPackages.responseBodySchema,
      parseJson(registeredTools.response),
    ),
    true,
  );

  const scaffold = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/skill-draft-packages/scaffold",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        definitionType: "prompt",
        name: "HTTP scaffold",
        description: "Generate a governed Prompt Skill package.",
        category: "research",
        tags: [],
        materials: [],
        parameters: [],
        outputs: [{ name: "result", description: "Result", type: "json" }],
        smoke: { purpose: "", input: "", expectedOutcome: "" },
      },
    },
  });
  assert.equal(scaffold.response.status, 200);
  assert.equal(
    Check(
      WORKBENCH_V1_LIFECYCLE_ENDPOINTS.scaffoldSkillDraftPackage.responseBodySchema,
      parseJson(scaffold.response),
    ),
    true,
  );

  const loopTask = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/loops/workflow-reviewed-brief/agent-tasks",
    headers: mutationHeaders(session),
    body: clone(startRunRequestExample),
  });
  assert.equal(loopTask.response.status, 202);
  assert.equal(
    Check(
      WORKBENCH_V1_LIFECYCLE_ENDPOINTS.startLoopAgentTask.responseBodySchema,
      parseJson(loopTask.response),
    ),
    true,
  );
  assert.equal(parseJson(loopTask.response).data.session.source.runId, startRunResponseExample.data.runId);
  assert.deepEqual(calls.map(([method]) => method), [
    "listSkillRuntimes",
    "listRegisteredToolPackages",
    "scaffoldSkillDraftPackage",
    "startLoopAgentTask",
  ]);
  assert.equal(calls[3][1].workflowId, "workflow-reviewed-brief");
  assert.equal(calls[3][1].idempotencyKey, "idem-http-001");
});

test("Skill version history route returns the strict product-safe list envelope", async () => {
  const application = makeApplication();
  const original = application.listSkillVersions;
  let received;
  application.listSkillVersions = async (input) => {
    received = input;
    return original(input);
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const loaded = await invoke(handler, {
    url: "/api/workbench/v1/skills/skill-meeting-actions/versions?limit=10",
    headers: { Cookie: session.cookie },
  });

  assert.equal(loaded.response.status, 200);
  const body = parseJson(loaded.response);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillVersions.responseBodySchema, body),
    true,
  );
  assert.equal(received.skillId, "skill-meeting-actions");
  assert.deepEqual(received.query, { limit: 10 });
  for (const forbidden of [
    "workspaceId",
    "packageObjectId",
    "packageHash",
    "contentHash",
    "manifest",
    "inputSchema",
    "outputSchema",
    "executionRef",
  ]) {
    assert.equal(Object.hasOwn(body.data[0], forbidden), false, forbidden);
  }
});

test("retired Loop update and Team Library fork routes are absent", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  for (const route of [
    {
      method: "GET",
      url: "/api/workbench/v1/loops/workflow-reviewed-brief/skill-updates/skill-version-meeting-actions-v2",
    },
    {
      method: "POST",
      url: "/api/workbench/v1/team-library/release-team-loop-1/fork",
    },
  ]) {
    const result = await invoke(handler, {
      method: route.method,
      url: route.url,
      headers: route.method === "GET" ? { Cookie: session.cookie } : mutationHeaders(session),
      body: route.method === "GET"
        ? undefined
        : { schemaVersion: "workbench-api-v1", data: { name: "Retired action" } },
    });
    assert.equal(result.response.status, 404, route.url);
    assert.equal(parseJson(result.response).code, "route_not_found");
  }
});

test("test identity headers are rejected unless an explicit test-only resolver is installed", async () => {
  const production = setup();
  const denied = await invoke(production.handler, {
    url: "/api/workbench/v1/workspace",
    headers: {
      "X-Workbench-Test-User": "test-user-a",
      "X-Workbench-Test-Workspace": "test-workspace-a",
    },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(parseJson(denied.response).code, "test_identity_forbidden");

  const bootstraps = [];
  const testApplication = makeApplication();
  testApplication.bootstrapSession = async ({ testIdentity }) => {
    bootstraps.push(testIdentity);
    return testIdentity;
  };
  const enabled = setup({
    application: testApplication,
    testIdentityResolver(req) {
      return {
        userId: req.headers["x-workbench-test-user"],
        workspaceId: req.headers["x-workbench-test-workspace"],
      };
    },
  });
  const issued = await invoke(enabled.handler, {
    url: "/api/workbench/v1/workspace",
    headers: {
      "X-Workbench-Test-User": "test-user-a",
      "X-Workbench-Test-Workspace": "test-workspace-a",
    },
  });
  assert.equal(issued.response.status, 200);
  assert.deepEqual(bootstraps, [{ userId: "test-user-a", workspaceId: "test-workspace-a" }]);
});

test("active session and membership routes require a session and keep lifecycle shapes public", async () => {
  const now = "2026-07-10T10:00:00.000Z";
  const application = makeApplication();
  application.getActiveSession = async ({ auth }) => ({
    session: {
      schemaVersion: "workbench-v1",
      sessionId: auth.sessionId,
      userId: auth.userId,
      activeWorkspaceId: auth.activeWorkspaceId,
      expiresAt: auth.expiresAt,
    },
    workspace: {
      schemaVersion: "workbench-v1",
      workspaceId: auth.activeWorkspaceId,
      name: "Private workspace",
      createdBy: auth.userId,
      createdAt: now,
      updatedAt: now,
    },
    membership: {
      schemaVersion: "workbench-v1",
      membershipId: `membership-${auth.activeWorkspaceId}-${auth.userId}`,
      workspaceId: auth.activeWorkspaceId,
      userId: auth.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    },
  });
  application.listMemberships = async () => ({
    data: [{
      schemaVersion: "workbench-v1",
      membershipId: "membership-workspace-local-user-local",
      workspaceId: "workspace-local",
      userId: "user-local",
      role: "owner",
      createdAt: now,
      updatedAt: now,
    }],
  });
  const { handler } = setup({ application });
  const denied = await invoke(handler, { url: "/api/workbench/v1/session" });
  assert.equal(denied.response.status, 401);
  const session = await bootstrap(handler);
  const current = await invoke(handler, {
    url: "/api/workbench/v1/session",
    headers: { Cookie: session.cookie },
  });
  assert.equal(current.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getActiveSession.responseBodySchema, parseJson(current.response)), true);
  const memberships = await invoke(handler, {
    url: "/api/workbench/v1/workspace/memberships",
    headers: { Cookie: session.cookie },
  });
  assert.equal(memberships.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listMemberships.responseBodySchema, parseJson(memberships.response)), true);
});

test("Skill upload routes require a session, browser mutation proof, and contract-valid package summaries", async () => {
  const now = "2026-07-10T10:00:00.000Z";
  const upload = {
    schemaVersion: "workbench-v1",
    uploadId: "upload-meeting-skill-1",
    state: "ready_draft",
    filename: "meeting-action-extractor.zip",
    sizeBytes: 128,
    mediaType: "application/zip",
    ingestMethod: "files",
    transfer: { chunkSizeBytes: 0, totalChunks: 0, receivedChunks: [], receivedBytes: 128, complete: true },
    findings: [],
    inspection: {
      status: "passed",
      manifest: {
        name: "meeting-action-extractor",
        description: "Extract actions from supplied meeting notes.",
        compatibility: "Local only",
        disableModelInvocation: true,
      },
      inventory: [{ path: "SKILL.md", sizeBytes: 128, kind: "instructions" }],
      diagnostics: [],
    },
    createdAt: now,
    updatedAt: now,
  };
  const application = makeApplication();
  application.createUpload = async () => ({
    ...upload,
    state: "selecting",
    transfer: { ...upload.transfer, receivedBytes: 0, complete: false },
    inspection: undefined,
  });
  application.uploadPackage = async () => upload;
  application.uploadChunk = async () => ({
    ...upload,
    state: "selecting",
    ingestMethod: "resumable",
    transfer: { chunkSizeBytes: 524288, totalChunks: 1, receivedChunks: [0], receivedBytes: 128, complete: true },
    inspection: undefined,
  });
  application.completeUpload = async () => ({ ...upload, ingestMethod: "resumable" });
  application.importSkillRepository = async () => ({ ...upload, ingestMethod: "repository" });
  application.getUpload = async () => upload;
  application.promoteUpload = async () => ({ ...upload, state: "promoted" });
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const created = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/uploads",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { filename: upload.filename, sizeBytes: upload.sizeBytes, mediaType: upload.mediaType },
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createUpload.responseBodySchema, parseJson(created.response)), true);
  const packageUpload = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/uploads/${upload.uploadId}/package`,
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { files: [{ path: "SKILL.md", contentBase64: Buffer.from("# package").toString("base64") }] },
    },
  });
  assert.equal(packageUpload.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.uploadPackage.responseBodySchema, parseJson(packageUpload.response)), true);
  const chunk = await invoke(handler, {
    method: "PUT",
    url: `/api/workbench/v1/uploads/${upload.uploadId}/chunks/0`,
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { contentBase64: Buffer.from("chunk").toString("base64") },
    },
  });
  assert.equal(chunk.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.uploadChunk.responseBodySchema, parseJson(chunk.response)), true);
  const completed = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/uploads/${upload.uploadId}/complete`,
    headers: mutationHeaders(session),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(completed.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.completeUpload.responseBodySchema, parseJson(completed.response)), true);
  const imported = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/uploads/repository",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { repositoryUrl: "https://github.com/openai/example", ref: "main", skillDirectory: "skills/reviewer" },
    },
  });
  assert.equal(imported.response.status, 201);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.importSkillRepository.responseBodySchema, parseJson(imported.response)), true);
  const read = await invoke(handler, {
    url: `/api/workbench/v1/uploads/${upload.uploadId}`,
    headers: { Cookie: session.cookie },
  });
  assert.equal(read.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getUpload.responseBodySchema, parseJson(read.response)), true);
  const promoted = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/uploads/${upload.uploadId}/promote`,
    headers: mutationHeaders(session),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.promoteUpload.responseBodySchema, parseJson(promoted.response)), true);
});

test("incomplete repository runtime pairs return a product 422 instead of an internal error", async () => {
  const application = makeApplication();
  application.importSkillRepository = async () => {
    const error = new Error("repository_runtime_pair_incomplete");
    error.code = "repository_runtime_pair_incomplete";
    throw error;
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const imported = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/uploads/repository",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        repositoryUrl: "https://github.com/openai/example",
        ref: "main",
        skillDirectory: "skills/reviewer",
      },
    },
  });

  assert.equal(imported.response.status, 422);
  assert.equal(parseJson(imported.response).code, "repository_runtime_pair_incomplete");
});

test("malformed repository runtime manifests return a product 422 instead of an internal error", async () => {
  const application = makeApplication();
  application.importSkillRepository = async () => {
    const error = new Error("repository_runtime_manifest_invalid");
    error.code = "repository_runtime_manifest_invalid";
    throw error;
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const imported = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/uploads/repository",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        repositoryUrl: "https://github.com/openai/example",
        ref: "main",
        skillDirectory: "skills/reviewer",
      },
    },
  });

  assert.equal(imported.response.status, 422);
  assert.equal(parseJson(imported.response).code, "repository_runtime_manifest_invalid");
});

test("Skill draft package GET and PUT share one strict revision-bound route", async () => {
  const application = makeApplication();
  const calls = [];
  application.getSkillDraftPackage = async (input) => {
    calls.push({ kind: "read", input });
    return { data: clone(skillDraftPackageExample), etag: '"skd1:skill-draft-meeting-actions-3:3"' };
  };
  application.replaceSkillDraftPackage = async (input) => {
    calls.push({ kind: "replace", input });
    return { data: publicDraft(skillDraftExample), etag: '"skd1:skill-draft-meeting-actions-3:4"' };
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const path = `/api/workbench/v1/skills/${skillDraftPackageExample.skillId}/drafts/${skillDraftPackageExample.skillDraftId}/package`;

  const read = await invoke(handler, { url: path, headers: { Cookie: session.cookie } });
  assert.equal(read.response.status, 200);
  assert.equal(read.response.headers.etag, '"skd1:skill-draft-meeting-actions-3:3"');
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillDraftPackage.responseBodySchema, parseJson(read.response)), true);
  for (const forbidden of ["workspaceId", "objectId", "contentHash", "executionRef", "provider", "tool", "artifactPath"]) {
    assert.equal(JSON.stringify(parseJson(read.response)).includes(`\"${forbidden}\"`), false, forbidden);
  }

  const replaced = await invoke(handler, {
    method: "PUT",
    url: path,
    headers: mutationHeaders({ ...session, ifMatch: '"skd1:skill-draft-meeting-actions-3:3"' }),
    body: clone(replaceSkillDraftPackageRequestExample),
  });
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.response.headers.etag, '"skd1:skill-draft-meeting-actions-3:4"');
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.replaceSkillDraftPackage.responseBodySchema, parseJson(replaced.response)), true);
  assert.equal(calls.at(-1).input.idempotencyKey, "idem-http-001");
  assert.equal(calls.at(-1).input.ifMatch, '"skd1:skill-draft-meeting-actions-3:3"');
  assert.deepEqual(calls.at(-1).input.request, replaceSkillDraftPackageRequestExample);

  const missingEtag = await invoke(handler, {
    method: "PUT",
    url: path,
    headers: mutationHeaders(session),
    body: clone(replaceSkillDraftPackageRequestExample),
  });
  assert.equal(missingEtag.response.status, 428);

  const unsafe = await invoke(handler, {
    method: "PUT",
    url: path,
    headers: mutationHeaders({ ...session, ifMatch: '"skd1:skill-draft-meeting-actions-3:3"' }),
    body: {
      ...clone(replaceSkillDraftPackageRequestExample),
      data: { uploadId: "upload-a", objectId: "object-private" },
    },
  });
  assert.equal(unsafe.response.status, 400);

  const wrongMethod = await invoke(handler, {
    method: "POST",
    url: path,
    headers: mutationHeaders(session),
    body: clone(replaceSkillDraftPackageRequestExample),
  });
  assert.equal(wrongMethod.response.status, 404);
});

test("Skill test and validation routes are revision-bound, session-scoped, and contract-valid", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const revisionHeaders = mutationHeaders({ ...session, ifMatch: '"skill-draft-v1"' });
  const testRun = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/skills/${skillTestRunExample.skillId}/drafts/${skillTestRunExample.skillDraftId}/tests`,
    headers: revisionHeaders,
    body: clone(createSkillTestRequestExample),
  });
  assert.equal(testRun.response.status, 202);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkillTest.responseBodySchema, parseJson(testRun.response)), true);
  assert.equal(Object.hasOwn(parseJson(testRun.response).data, "imageDigest"), false);

  const loadedTest = await invoke(handler, {
    url: `/api/workbench/v1/skills/${skillTestRunExample.skillId}/tests/${skillTestRunExample.testRunId}`,
    headers: { Cookie: session.cookie },
  });
  assert.equal(loadedTest.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillTestRun.responseBodySchema, parseJson(loadedTest.response)), true);

  const cancelledTest = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/skills/${skillTestRunExample.skillId}/tests/${skillTestRunExample.testRunId}/cancel`,
    headers: { ...mutationHeaders(session), "Idempotency-Key": "idem-cancel-skill-test-001" },
    body: { schemaVersion: "workbench-api-v1", data: { reason: "No longer needed." } },
  });
  assert.equal(cancelledTest.response.status, 202);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.cancelSkillTest.responseBodySchema, parseJson(cancelledTest.response)),
    true,
  );
  assert.equal(parseJson(cancelledTest.response).data, skillTestRunExample.testRunId);

  const validation = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/skills/${skillValidationRecordExample.skillId}/drafts/${skillValidationRecordExample.skillDraftId}/validations`,
    headers: { ...revisionHeaders, "Idempotency-Key": "idem-validation-001" },
    body: clone(createSkillValidationRequestExample),
  });
  assert.equal(validation.response.status, 202);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkillValidation.responseBodySchema, parseJson(validation.response)), true);
  assert.equal(Object.hasOwn(parseJson(validation.response).data, "imageDigest"), false);

  const loadedValidation = await invoke(handler, {
    url: `/api/workbench/v1/skills/${skillValidationRecordExample.skillId}/validations/${skillValidationRecordExample.validationId}`,
    headers: { Cookie: session.cookie },
  });
  assert.equal(loadedValidation.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillValidation.responseBodySchema, parseJson(loadedValidation.response)), true);

  const missingEtag = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/skills/${skillTestRunExample.skillId}/drafts/${skillTestRunExample.skillDraftId}/tests`,
    headers: mutationHeaders(session),
    body: clone(createSkillTestRequestExample),
  });
  assert.equal(missingEtag.response.status, 428);
});

test("Host allowlist accepts loopback and explicit hosts while rejecting DNS rebinding", async () => {
  const { handler } = setup();
  for (const host of ["localhost:8798", "127.0.0.1:8798", "[::1]:8798"]) {
    const allowed = await invoke(handler, {
      url: "/api/workbench/v1/workspace",
      headers: { Host: host },
    });
    assert.equal(allowed.response.status, 200, host);
  }

  for (const host of [
    "attacker.invalid",
    "localhost.attacker.invalid",
    "127.0.0.1.attacker.invalid",
    "localhost@attacker.invalid",
    "[::1].attacker.invalid",
  ]) {
    const denied = await invoke(handler, {
      url: "/api/workbench/v1/workspace",
      headers: { Host: host },
    });
    assert.equal(denied.response.status, 403, host);
    assert.equal(parseJson(denied.response).code, "invalid_host", host);
    assert.equal(denied.response.headers["set-cookie"], undefined, host);
  }

  const explicit = setup({
    origin: "http://workbench.internal:8798",
    allowedHosts: ["workbench.internal:8798"],
  });
  const configured = await invoke(explicit.handler, {
    url: "/api/workbench/v1/workspace",
    headers: { Host: "workbench.internal:8798" },
  });
  assert.equal(configured.response.status, 200);

  const wrongPort = await invoke(explicit.handler, {
    url: "/api/workbench/v1/workspace",
    headers: { Host: "workbench.internal:4310" },
  });
  assert.equal(wrongPort.response.status, 403);
  assert.equal(parseJson(wrongPort.response).code, "invalid_host");
});

test("all frozen endpoints emit contract-valid public responses", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const paths = { skillId: "skill-research-brief", templateId: "template-reviewed-brief", workflowId: "workflow-reviewed-brief", revisionId: "revision-reviewed-brief-1", runId: "run-reviewed-brief-1" };
  for (const endpoint of Object.values(WORKBENCH_V1_ENDPOINTS)) {
    if (endpoint.responseMediaType === "text/event-stream") continue;
    const url = endpoint.path.replace(/\{(\w+)\}/g, (_match, key) => paths[key]);
    const body = endpoint.mutation ? clone(mutationRequestExamples[endpoint.operationId]) : undefined;
    const { response } = await invoke(handler, {
      method: endpoint.method,
      url,
      headers: endpoint.mutation
        ? mutationHeaders({ ...session, ifMatch: endpoint.operationId === "saveWorkflowRevision" ? '"revision-reviewed-brief-1"' : undefined })
        : { Cookie: session.cookie },
      body,
    });
    assert.equal(response.status, endpoint.successStatus, endpoint.operationId);
    assert.equal(Check(endpoint.responseBodySchema, parseJson(response)), true, endpoint.operationId);
    if (endpoint.operationId === "getWorkflow") {
      assert.equal(response.headers.etag, '"revision-reviewed-brief-1"');
    }
  }
});

test("the HTTP handler consumes every public endpoint from the contract registry", async () => {
  const { handler } = setup();
  for (const endpoint of PUBLIC_ENDPOINTS) {
    const url = endpoint.path.replace(/\{\w+\}/g, "route-probe");
    const { response } = await invoke(handler, {
      method: endpoint.method,
      url,
    });
    const payload = response.body ? parseJson(response) : {};
    assert.notEqual(
      payload.code,
      "route_not_found",
      `${endpoint.method} ${endpoint.path} was not registered`,
    );
  }
});

test("strict path/query/body/header validation maps preconditions and idempotency safely", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const unknownQuery = await invoke(handler, { url: "/api/workbench/v1/skills?unexpected=yes" });
  assert.equal(unknownQuery.response.status, 400);
  assert.equal(parseJson(unknownQuery.response).code, "request_invalid");
  const unknownBody = clone(mutationRequestExamples.saveWorkflowRevision);
  unknownBody.data.unexpected = true;
  const invalid = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/workflows/workflow-reviewed-brief/revisions",
    headers: mutationHeaders({ ...session, ifMatch: '"revision-reviewed-brief-1"' }),
    body: unknownBody,
  });
  assert.equal(invalid.response.status, 400);
  const missingPrecondition = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/workflows/workflow-reviewed-brief/revisions", headers: mutationHeaders(session), body: mutationRequestExamples.saveWorkflowRevision,
  });
  assert.equal(missingPrecondition.response.status, 428);
  assert.equal(parseJson(missingPrecondition.response).code, "precondition_required");
});

test("the first V1 Skill lifecycle routes are session-bound and contract-valid", async () => {
  const now = "2026-07-10T10:00:00.000Z";
  const skill = {
    schemaVersion: "workbench-v1",
    skillId: "skill-new-1",
    workspaceId: "workspace-local",
    ownerId: "user-local",
    visibility: "private",
    lifecycle: "draft",
    currentDraftId: "skill-draft-new-1",
    latestPublishedVersionId: null,
    createdAt: now,
    updatedAt: now,
  };
  const draft = {
    schemaVersion: "workbench-v1",
    skillDraftId: "skill-draft-new-1",
    skillId: "skill-new-1",
    workspaceId: "workspace-local",
    baseVersionId: null,
    revision: 1,
    name: "Meeting summary",
    description: "Summarize a reviewed meeting source.",
    category: "meetings",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk: { level: "low", externalAction: false, summary: "No external action is configured." },
    dependencies: [],
    connectionRequirements: [],
    files: [],
    updatedBy: "user-local",
    createdAt: now,
    updatedAt: now,
  };
  const application = makeApplication();
  application.createSkill = async () => ({ skill: publicSkill(skill), draft: publicDraft(draft) });
  application.getSkillDraft = async () => ({ data: publicDraft(draft), etag: '"skill-draft-new-1"' });
  const definition = {
    goal: "Turn meeting notes into actions.",
    context: "Internal meeting notes.",
    constraints: ["Do not send messages."],
    doneWhen: ["Each action has an owner."],
    verify: ["A reviewer approves the result."],
    expectedResult: "A reviewed action list.",
    stopRules: ["Stop when source notes are missing."],
  };
  const loopWorkflow = clone(workflowDetailResponseExample.data);
  const loopRevision = { ...clone(workflowRevisionResponseExample.data), definition };
  application.createLoop = async () => ({ workflow: loopWorkflow, revision: loopRevision });
  application.saveLoopRevision = async () => ({
    data: { workflow: loopWorkflow, revision: loopRevision },
    etag: '"revision-reviewed-brief-2"',
  });
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const request = {
    schemaVersion: "workbench-api-v1",
    data: { name: draft.name, description: draft.description, category: draft.category },
  };
  const created = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/skills",
    headers: mutationHeaders(session),
    body: request,
  });
  assert.equal(created.response.status, 201);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkill.responseBodySchema, parseJson(created.response)), true);

  const loaded = await invoke(handler, {
    url: "/api/workbench/v1/skills/skill-new-1/drafts/skill-draft-new-1",
    headers: { Cookie: session.cookie },
  });
  assert.equal(loaded.response.status, 200);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillDraft.responseBodySchema, parseJson(loaded.response)), true);

  const loop = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/loops",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { name: "Meeting actions", description: "Turn notes into actions.", definition },
    },
  });
  assert.equal(loop.response.status, 201);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoop.responseBodySchema, parseJson(loop.response)), true);

  const saved = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${loopWorkflow.workflowId}/revisions`,
    headers: mutationHeaders({ ...session, ifMatch: '"revision-reviewed-brief-1"' }),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        baseRevisionId: loopRevision.revisionId,
        graph: loopRevision.graph,
        inputForm: loopRevision.inputForm,
        outputDefinition: loopRevision.outputDefinition,
        resourceRefs: loopRevision.resourceRefs,
        runSettings: loopRevision.runSettings,
        definition,
        saveReason: "Refine the Loop definition.",
      },
    },
  });
  assert.equal(saved.response.status, 201, saved.response.body);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.saveLoopRevision.responseBodySchema, parseJson(saved.response)), true);
});

test("cancel and retry commands are session-bound mutation routes with contract-valid IDs", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const command = (operationId, path, expectedId) => invoke(handler, {
    method: "POST",
    url: path,
    headers: mutationHeaders(session),
    body: { schemaVersion: "workbench-api-v1", data: { reason: "Stop or retry this Run." } },
  }).then(({ response }) => {
    assert.equal(response.status, 202);
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS[operationId].responseBodySchema, parseJson(response)), true);
    const data = parseJson(response).data;
    assert.equal(
      ["cancelRun", "retryRun"].includes(operationId) ? data.runId : data,
      expectedId,
    );
  });
  await command("cancelRun", "/api/workbench/v1/runs/run-command-1/cancel", "run-command-1");
  await command("retryRun", "/api/workbench/v1/runs/run-command-1/retry", "retry-run-command-1");
});

test("stable application errors map mutation conflicts and never reveal internal fields", async () => {
  const { handler, application } = setup();
  const session = await bootstrap(handler);
  application.saveWorkflowRevision = async () => {
    const error = new Error("duplicate key");
    error.code = "idempotency_key_reused";
    error.details = {
      providerPayload: "hidden",
      scope: "save-workflow-revision",
      nested: [{ artifactPath: "/private/runtime/hidden", safe: "shown" }],
    };
    throw error;
  };
  const idempotency = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/workflows/workflow-reviewed-brief/revisions",
    headers: mutationHeaders({ ...session, ifMatch: '"revision-reviewed-brief-1"' }),
    body: mutationRequestExamples.saveWorkflowRevision,
  });
  assert.equal(idempotency.response.status, 409);
  assert.equal(parseJson(idempotency.response).code, "idempotency_key_reused");
  assert.equal(Object.hasOwn(parseJson(idempotency.response).details, "providerPayload"), false);
  assert.deepEqual(parseJson(idempotency.response).details.nested, [{ safe: "shown" }]);

  application.saveWorkflowRevision = async () => {
    const error = new Error("changed");
    error.code = "workflow_revision_conflict";
    error.details = { workflowId: "workflow-reviewed-brief" };
    throw error;
  };
  const conflict = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/workflows/workflow-reviewed-brief/revisions",
    headers: mutationHeaders({ ...session, ifMatch: '"revision-reviewed-brief-1"' }),
    body: mutationRequestExamples.saveWorkflowRevision,
  });
  assert.equal(conflict.response.status, 412);
  assert.equal(parseJson(conflict.response).code, "workflow_revision_conflict");

  application.submitReviewDecision = async () => {
    const error = new Error("run is not waiting for review");
    error.code = "review_not_waiting";
    throw error;
  };
  const reviewConflict = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/runs/run-reviewed-brief-1/review-decisions",
    headers: mutationHeaders(session), body: mutationRequestExamples.submitReviewDecision,
  });
  assert.equal(reviewConflict.response.status, 409);
  assert.equal(parseJson(reviewConflict.response).code, "review_not_waiting");

  application.getSkill = async () => ({ ...skillDetailResponseExample.data, providerPayload: "private" });
  const invalidPublic = await invoke(handler, {
    url: "/api/workbench/v1/skills/skill-research-brief",
    headers: { Cookie: session.cookie },
  });
  assert.equal(invalidPublic.response.status, 500);
  assert.equal(invalidPublic.response.body.includes("providerPayload"), false);
});

test("SSE replays a cursor then subscribes and always unsubscribes on disconnect", async () => {
  const { handler, application } = setup();
  const session = await bootstrap(handler);
  const { request, response } = await invoke(handler, {
    url: "/api/workbench/v1/runs/run-reviewed-brief-1/events?after=41",
    headers: { "Last-Event-ID": "39", Cookie: session.cookie },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.match(response.body, /id: 42/);
  assert.match(response.body, /event: node.completed/);
  assert.match(response.body, /data: /);
  assert.equal(response.body.match(/^id: 42$/gm)?.length, 1);
  assert.equal(application.lastEventsAfter, 41);
  request.emit("close");
  assert.equal(application.unsubscribed, true);
});

test("invalid SSE replay closes the stream without writing a second HTTP response", async () => {
  const { handler, application } = setup();
  const session = await bootstrap(handler);
  application.listEvents = async () => [{ ...clone(runEventExample), sequence: 42, nodeId: null }];
  const { response } = await invoke(handler, {
    url: "/api/workbench/v1/runs/run-reviewed-brief-1/events?after=41",
    headers: { Cookie: session.cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.ended, true);
  assert.equal(response.body, "");
  assert.equal(application.unsubscribed, true);
});

test("Session-domain SSE replays only Product-safe command-derived envelopes", async () => {
  const { handler, application } = setup();
  const session = await bootstrap(handler);
  const { response } = await invoke(handler, {
    url: "/api/workbench/v1/session-domain/events?after=7",
    headers: { "Last-Event-ID": "6", Cookie: session.cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.match(response.body, /id: 8/);
  assert.match(response.body, /event: session/);
  assert.match(response.body, /session-event-http/);
  assert.equal(application.lastSessionDomainAfter, 7);
});

test("SSE subscribes before replay, buffers the race window, and deduplicates by sequence", async () => {
  const application = makeApplication();
  const calls = [];
  let listener;
  const event = (sequence) => ({
    ...clone(runEventExample),
    sequence,
    eventId: `event-${sequence}`,
  });
  application.subscribe = (_runId, next) => {
    calls.push("subscribe");
    listener = next;
    return () => { application.unsubscribed = true; };
  };
  application.listEvents = async ({ after }) => {
    assert.equal(after, 41);
    calls.push("listEvents");
    listener?.(event(43));
    listener?.(event(42));
    listener?.(event(40));
    return [event(42)];
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);

  const { request, response } = await invoke(handler, {
    url: "/api/workbench/v1/runs/run-reviewed-brief-1/events",
    headers: { "Last-Event-ID": "41", Cookie: session.cookie },
  });

  assert.deepEqual(calls, ["subscribe", "listEvents"]);
  assert.equal(response.body.match(/^id: 40$/gm), null);
  assert.equal(response.body.match(/^id: 42$/gm)?.length, 1);
  assert.equal(response.body.match(/^id: 43$/gm)?.length, 1);
  assert.ok(response.body.indexOf("id: 42") < response.body.indexOf("id: 43"));

  listener(event(43));
  listener(event(44));
  assert.equal(response.body.match(/^id: 43$/gm)?.length, 1);
  assert.equal(response.body.match(/^id: 44$/gm)?.length, 1);

  request.emit("close");
  assert.equal(application.unsubscribed, true);
});
