import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_ENDPOINTS,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
} from "@looloomi/workbench-contracts";
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
  startRunResponseExample,
  templateDetailResponseExample,
  templateListResponseExample,
  useTemplateResponseExample,
  workflowDetailResponseExample,
  workflowListResponseExample,
  workflowRevisionResponseExample,
  workspaceResponseExample,
} from "../../../workbench-contracts/examples/canonical-examples.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";

const clone = (value) => structuredClone(value);

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.body = "";
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  }

  write(value) { this.body += value; }

  end(value = "") { this.body += value; this.emit("finish"); }
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
  allowedActions: skill.lifecycle === "draft" ? ["edit", "publish"] : ["create_version", "retire"],
  createdAt: skill.createdAt,
  updatedAt: skill.updatedAt,
});

const makeApplication = () => ({
  async workspace() { return clone(workspaceResponseExample.data); },
  async listSkills() { return clone(skillListResponseExample.data); },
  async getSkill() { return clone(skillDetailResponseExample.data); },
  async createSkillTest() { return clone(skillTestRunResponseExample.data); },
  async getSkillTestRun() { return clone(skillTestRunResponseExample.data); },
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
  async useTemplate() { return clone(useTemplateResponseExample.data); },
  async listWorkflows() { return clone(workflowListResponseExample.data); },
  async getWorkflow() { return { data: clone(workflowDetailResponseExample.data), etag: '"revision-reviewed-brief-1"' }; },
  async getWorkflowRevision() { return { data: clone(workflowRevisionResponseExample.data), etag: '"revision-reviewed-brief-1"' }; },
  async getLoopSkillUpdatePreview() {
    return {
      data: {
        workflowId: "workflow-reviewed-brief",
        workflowRevisionId: "revision-reviewed-brief-1",
        workflowName: "Reviewed research brief",
        skillId: "skill-meeting-actions",
        currentVersion: {
          skillVersionId: "skill-version-meeting-actions-v1",
          version: "1.0.0",
          name: "Meeting actions",
          description: "Find follow-up work in meeting notes.",
          risk: { level: "low", externalAction: false, summary: "No external action." },
          connectionRequirements: [],
        },
        targetVersion: {
          skillVersionId: "skill-version-meeting-actions-v2",
          version: "2.0.0",
          name: "Meeting actions",
          description: "Find owners and dates in meeting notes.",
          risk: { level: "low", externalAction: false, summary: "No external action." },
          connectionRequirements: [],
        },
        affectedNodes: [{ nodeId: "node-skill", title: "Extract action items" }],
        changes: [{ field: "purpose", changed: true, summary: "The Skill description or name changed.", severity: "info" }],
        requiresTestRun: true,
      },
      etag: '"workflow:workflow-reviewed-brief:1"',
    };
  },
  async saveWorkflowRevision() { return { data: clone(saveWorkflowRevisionResponseExample.data), etag: '"revision-reviewed-brief-2"' }; },
  async compileWorkflow() { return clone(compileWorkflowResponseExample.data); },
  async startRun() { return clone(startRunResponseExample.data); },
  async listWorkflowRuns() { return clone(runHistoryResponseExample.data); },
  async getRun() { return clone(runDetailResponseExample.data); },
  async submitReviewDecision() { return clone(reviewDecisionResponseExample.data); },
  async cancelRun({ runId }) { return runId; },
  async retryRun({ runId }) { return `retry-${runId}`; },
  async duplicateLoop() {
    return {
      workflow: clone(workflowDetailResponseExample.data),
      revision: clone(workflowRevisionResponseExample.data),
    };
  },
  async forkTeamLibraryLoop() {
    const workflow = clone(workflowDetailResponseExample.data);
    workflow.sourceWorkflow = {
      workflowId: "workflow-team-source",
      revisionId: "revision-team-source-1",
    };
    workflow.sourceRelease = {
      releaseId: "release-team-loop-1",
      sourceWorkspaceId: workflow.workspaceId,
      versionId: "loop-version-team-source-1",
      forkedAt: "2026-07-10T10:00:00.000Z",
    };
    return {
      workflow,
      revision: clone(workflowRevisionResponseExample.data),
    };
  },
  async createLoopDraftFromRun() {
    return {
      workflow: clone(workflowDetailResponseExample.data),
      revision: clone(workflowRevisionResponseExample.data),
    };
  },
  async listEvents({ after }) {
    this.lastEventsAfter = after;
    return [clone(runEventExample)];
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

test("workspace creates a host-only HttpOnly strict session and mutations enforce browser proof", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  assert.match(session.cookie, /^workbench_session=/);
  const second = await invoke(handler, { url: "/api/workbench/v1/workspace" });
  assert.match(second.response.headers["set-cookie"], /HttpOnly/);
  assert.match(second.response.headers["set-cookie"], /SameSite=Strict/);
  assert.doesNotMatch(second.response.headers["set-cookie"], /Domain=/);

  const readDenied = await invoke(handler, { url: "/api/workbench/v1/skills" });
  assert.equal(readDenied.response.status, 401);
  assert.equal(parseJson(readDenied.response).code, "session_required");
  const readAllowed = await invoke(handler, {
    url: "/api/workbench/v1/skills",
    headers: { Cookie: session.cookie },
  });
  assert.equal(readAllowed.response.status, 200);

  const body = clone(mutationRequestExamples.useTemplate);
  const denied = await invoke(handler, { method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows", body });
  assert.equal(denied.response.status, 401);
  assert.equal(parseJson(denied.response).code, "session_required");

  const csrfDenied = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows",
    headers: { ...mutationHeaders(session), "X-Workbench-CSRF": "wrong-token" }, body,
  });
  assert.equal(csrfDenied.response.status, 403);
  assert.equal(parseJson(csrfDenied.response).code, "csrf_invalid");

  const originDenied = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows",
    headers: { ...mutationHeaders(session), Origin: "https://example.invalid" }, body,
  });
  assert.equal(originDenied.response.status, 403);
  assert.equal(parseJson(originDenied.response).code, "origin_forbidden");

  const fetchSiteDenied = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows",
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

test("Loop Skill update preview is addressable, read-only, and product-safe", async () => {
  const application = makeApplication();
  const calls = [];
  const implementation = application.getLoopSkillUpdatePreview;
  application.getLoopSkillUpdatePreview = async (input) => {
    calls.push(input);
    return implementation(input);
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const loaded = await invoke(handler, {
    url: "/api/workbench/v1/loops/workflow-reviewed-brief/skill-updates/skill-version-meeting-actions-v2",
    headers: { Cookie: session.cookie },
  });

  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.response.headers.etag, '"workflow:workflow-reviewed-brief:1"');
  const body = parseJson(loaded.response);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getLoopSkillUpdatePreview.responseBodySchema, body),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflowId, "workflow-reviewed-brief");
  assert.equal(calls[0].skillVersionId, "skill-version-meeting-actions-v2");
  for (const forbidden of ["workspaceId", "packageHash", "objectId", "executionRef", "manifest"]) {
    assert.equal(JSON.stringify(body).includes(forbidden), false, forbidden);
  }
});

test("Team library Loop fork is an idempotent mutation with the shared start request shape", async () => {
  const application = makeApplication();
  const calls = [];
  const implementation = application.forkTeamLibraryLoop;
  application.forkTeamLibraryLoop = async (input) => {
    calls.push(input);
    return implementation(input);
  };
  const { handler } = setup({ application });
  const session = await bootstrap(handler);
  const request = {
    schemaVersion: "workbench-api-v1",
    data: { name: "Forked team Loop" },
  };

  const missingIdempotency = mutationHeaders(session);
  delete missingIdempotency["Idempotency-Key"];
  const denied = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/team-library/release-team-loop-1/fork",
    headers: missingIdempotency,
    body: request,
  });
  assert.equal(denied.response.status, 400);
  assert.equal(parseJson(denied.response).code, "request_invalid");
  assert.equal(calls.length, 0);

  const accepted = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/team-library/release-team-loop-1/fork",
    headers: mutationHeaders(session),
    body: request,
  });
  assert.equal(accepted.response.status, 201);
  const response = parseJson(accepted.response);
  assert.equal(
    Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.forkTeamLibraryLoop.responseBodySchema, response),
    true,
  );
  assert.equal(response.data.workflow.sourceRelease.releaseId, "release-team-loop-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].releaseId, "release-team-loop-1");
  assert.equal(calls[0].idempotencyKey, "idem-http-001");
  assert.deepEqual(calls[0].request, request);
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

test("strict path/query/body/header validation maps preconditions and idempotency safely", async () => {
  const { handler } = setup();
  const session = await bootstrap(handler);
  const unknownQuery = await invoke(handler, { url: "/api/workbench/v1/skills?unexpected=yes" });
  assert.equal(unknownQuery.response.status, 400);
  assert.equal(parseJson(unknownQuery.response).code, "request_invalid");
  const unknownBody = clone(mutationRequestExamples.useTemplate);
  unknownBody.data.unexpected = true;
  const invalid = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows", headers: mutationHeaders(session), body: unknownBody,
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
  application.duplicateLoop = async () => ({ workflow: loopWorkflow, revision: loopRevision });
  application.createLoopDraftFromRun = async () => ({ workflow: loopWorkflow, revision: loopRevision });
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

  const copied = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/loops/${loopWorkflow.workflowId}/duplicate`,
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { name: "Meeting actions copy" },
    },
  });
  assert.equal(copied.response.status, 201, copied.response.body);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.duplicateLoop.responseBodySchema, parseJson(copied.response)), true);

  const fromRun = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/runs/run-reviewed-brief-1/draft",
    headers: mutationHeaders(session),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { name: "Meeting actions follow-up" },
    },
  });
  assert.equal(fromRun.response.status, 201, fromRun.response.body);
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopDraftFromRun.responseBodySchema, parseJson(fromRun.response)), true);
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
    assert.equal(parseJson(response).data, expectedId);
  });
  await command("cancelRun", "/api/workbench/v1/runs/run-command-1/cancel", "run-command-1");
  await command("retryRun", "/api/workbench/v1/runs/run-command-1/retry", "retry-run-command-1");
});

test("stable application errors map idempotency/template conflicts and never reveal internal fields", async () => {
  const { handler, application } = setup();
  const session = await bootstrap(handler);
  application.useTemplate = async () => {
    const error = new Error("duplicate key");
    error.code = "idempotency_key_reused";
    error.details = {
      providerPayload: "hidden",
      scope: "use-template",
      nested: [{ artifactPath: "/private/runtime/hidden", safe: "shown" }],
    };
    throw error;
  };
  const idempotency = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows",
    headers: mutationHeaders(session), body: mutationRequestExamples.useTemplate,
  });
  assert.equal(idempotency.response.status, 409);
  assert.equal(parseJson(idempotency.response).code, "idempotency_key_reused");
  assert.equal(Object.hasOwn(parseJson(idempotency.response).details, "providerPayload"), false);
  assert.deepEqual(parseJson(idempotency.response).details.nested, [{ safe: "shown" }]);

  application.useTemplate = async () => {
    const error = new Error("read only");
    error.code = "template_read_only";
    throw error;
  };
  const readOnly = await invoke(handler, {
    method: "POST", url: "/api/workbench/v1/templates/template-reviewed-brief/workflows",
    headers: mutationHeaders(session), body: mutationRequestExamples.useTemplate,
  });
  assert.equal(readOnly.response.status, 409);
  assert.equal(parseJson(readOnly.response).code, "template_read_only");

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
