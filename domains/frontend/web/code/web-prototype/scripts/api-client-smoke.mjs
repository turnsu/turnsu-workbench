import assert from "node:assert/strict";

import {
  encodeBytesBase64,
  formatSkillPackageBytes,
  PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
  portableLoopFilename,
  RUN_EVENT_TYPES,
  WorkbenchApiError,
  createWorkbenchApiClient,
} from "../src/api/client.js";
import {
  importSkillRepositoryPackage,
  beginPortableLoopImport,
  inspectResumableSkillPackage,
} from "../src/api/queries.js";

const requests = [];
const response = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
  async json() { return data; },
});
const rawResponse = (bytes, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
  async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
  async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
});
const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options });
  if (url.endsWith("/workspace")) {
    return response({
      data: { session: { csrfToken: "c".repeat(32), expiresAt: "2026-07-10T10:00:00.000Z" } },
    });
  }
  if (url.endsWith("/session")) {
    return response({
      data: {
        session: { userId: "user-1", activeWorkspaceId: "workspace-1" },
        membership: { userId: "user-1", workspaceId: "workspace-1", role: "viewer" },
      },
    });
  }
  if (url.endsWith("/skill-assets")) {
    return response({ data: [{ skill: { skillId: "skill-1" }, draft: null, latestVersion: null }] });
  }
  if (url.endsWith("/uploads")) {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.data?.assetKind === "loop") {
      return response({ data: { uploadId: "upload-loop-1", assetKind: "loop", state: "selecting" } }, { status: 201 });
    }
    return response({ data: { uploadId: "upload-1", state: "selecting" } }, { status: 201 });
  }
  if (url.endsWith("/uploads/upload-loop-1/chunks/0")) {
    return response({ data: {
      uploadId: "upload-loop-1",
      assetKind: "loop",
      state: "selecting",
      sizeBytes: 45,
      ingestMethod: "resumable",
      transfer: { chunkSizeBytes: 524288, totalChunks: 1, receivedChunks: [0], receivedBytes: 45, complete: true },
    } });
  }
  if (url.endsWith("/uploads/upload-loop-1/complete")) {
    return response({ data: { uploadId: "upload-loop-1", assetKind: "loop", state: "ready_draft", sizeBytes: 45, ingestMethod: "resumable" } });
  }
  if (url.endsWith("/uploads/upload-loop-1") && (!options.method || options.method === "GET")) {
    return response({ data: {
      uploadId: "upload-loop-1",
      assetKind: "loop",
      state: "selecting",
      sizeBytes: 45,
      ingestMethod: "resumable",
      transfer: { chunkSizeBytes: 524288, totalChunks: 1, receivedChunks: [], receivedBytes: 0, complete: false },
    } });
  }
  if (url.endsWith("/loop-imports") && options.method === "POST") {
    return response({ data: {
      importId: "loop-import-1",
      status: "ready",
      portableLoop: { name: "Portable proof", requirements: { skills: [], materials: [], connections: [] } },
      requirementStates: [],
    } }, { status: 202, headers: { etag: '"liv1:loop-import-1:1"' } });
  }
  if (url.endsWith("/loop-imports/loop-import-1") && (!options.method || options.method === "GET")) {
    return response({ data: { importId: "loop-import-1", status: "ready", portableLoop: { name: "Portable proof" } } }, { headers: { etag: '"liv1:loop-import-1:1"' } });
  }
  if (url.endsWith("/loop-imports/loop-import-1/commit")) {
    return response({ data: { workflow: { workflowId: "workflow-imported" }, revision: { revisionId: "revision-imported" } } }, { status: 201, headers: { etag: '"wfv1:workflow-imported:1"' } });
  }
  if (url.includes("/loops/workflow-new/export?revisionId=revision-new")) {
    const bytes = new TextEncoder().encode('{"schemaVersion":"portable-loop-package-v1"}\n');
    return rawResponse(bytes, { headers: {
      "content-type": PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
      "content-disposition": 'attachment; filename="portable-proof.loop.json"',
      etag: '"sha256:portable-proof"',
    } });
  }
  if (url.endsWith("/uploads/repository")) {
    return response({ data: { uploadId: "upload-repository-1", state: "ready_draft", ingestMethod: "repository" } }, { status: 201 });
  }
  if (url.endsWith("/uploads/upload-1/chunks/1")) {
    return response({ data: {
      uploadId: "upload-1",
      state: "selecting",
      ingestMethod: "resumable",
      transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0, 1], receivedBytes: 700000, complete: true },
    } });
  }
  if (url.endsWith("/uploads/upload-1/complete")) {
    return response({ data: { uploadId: "upload-1", state: "ready_draft", ingestMethod: "resumable" } });
  }
  if (url.endsWith("/uploads/upload-1") && (!options.method || options.method === "GET")) {
    return response({ data: {
      uploadId: "upload-1",
      state: "selecting",
      ingestMethod: "resumable",
      transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0], receivedBytes: 524288, complete: false },
    } });
  }
  if (url.endsWith("/uploads/upload-1/package")) {
    return response({ data: { uploadId: "upload-1", state: "ready_draft" } });
  }
  if (url.endsWith("/uploads/upload-1/promote")) {
    return response({ data: { uploadId: "upload-1", state: "promoted" } });
  }
  if (url.endsWith("/resources") && options.method === "POST") {
    return response({ data: { resourceId: "resource-1", version: "1.0.0", label: "Meeting notes" } }, { status: 201 });
  }
  if (url.endsWith("/resources")) {
    return response({ data: [{ resourceId: "resource-1", version: "1.0.0", label: "Meeting notes" }] });
  }
  if (url.endsWith("/resources/resource-1")) {
    return response({ data: { resourceId: "resource-1", version: "1.0.0", label: "Meeting notes" } });
  }
  if (url.endsWith("/connections/connection-1/validate")) {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read shared event details." },
      status: "connected",
      validation: { status: "valid" },
      revision: 3,
    } }, { headers: { etag: '"cnv1:connection-1:3"' } });
  }
  if (url.endsWith("/connections/connection-1") && options.method === "PATCH") {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read shared event details." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 2,
    } }, { headers: { etag: '"cnv1:connection-1:2"' } });
  }
  if (url.endsWith("/connections/connection-1")) {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read event titles." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 1,
    } }, { headers: { etag: '"cnv1:connection-1:1"' } });
  }
  if (url.endsWith("/connections") && options.method === "POST") {
    return response({ data: {
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read event titles." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 1,
    } }, { status: 201, headers: { etag: '"cnv1:connection-1:1"' } });
  }
  if (url.endsWith("/connections")) {
    return response({ data: [{
      connectionId: "connection-1",
      capabilityKey: "calendar.read",
      label: "Team calendar",
      configuration: { permissionSummary: "Read event titles." },
      status: "needs_setup",
      validation: { status: "never_checked" },
      revision: 1,
    }] });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1")) {
    return response({ data: { skillDraftId: "draft-1" } }, { headers: { etag: '"skill-draft-1:1"' } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/package") && options.method === "PUT") {
    return response({ data: { skillDraftId: "draft-1", revision: 2 } }, { headers: { etag: '"skill-draft-1:2"' } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/package")) {
    return response({ data: { skillId: "skill-1", skillDraftId: "draft-1", revision: 1, files: [
      { path: "SKILL.md", kind: "instructions", sizeBytes: 12, content: "# Sample" },
      { path: "scripts/main.py", kind: "script", sizeBytes: 12, content: 'print("ok")' },
    ] } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/tests") && options.method === "POST") {
    return response({ data: { testRunId: "skill-test-run-1", status: "passed" } }, { status: 202 });
  }
  if (url.endsWith("/skills/skill-1/tests/skill-test-run-1")) {
    return response({ data: { testRunId: "skill-test-run-1", status: "passed" } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-1/validations") && options.method === "POST") {
    return response({ data: { validationId: "skill-validation-1", status: "passed" } }, { status: 202 });
  }
  if (url.endsWith("/skills/skill-1/validations/skill-validation-1")) {
    return response({ data: { validationId: "skill-validation-1", status: "passed" } });
  }
  if (url.endsWith("/skills/skill-1/drafts") && options.method === "POST") {
    return response({ data: { skillDraftId: "draft-2" } }, { status: 201, headers: { etag: '"skill-draft-2:1"' } });
  }
  if (url.endsWith("/skills/skill-1/drafts/draft-2") && options.method === "PATCH") {
    return response({ data: { skillDraftId: "draft-2" } }, { headers: { etag: '"skill-draft-2:2"' } });
  }
  if (url.endsWith("/skills/skill-1/versions")) {
    return response({ data: [
      { skillVersionId: "skill-version-2", skillId: "skill-1", version: "2.0.0", name: "Meeting actions", description: "Finds clear follow-up actions.", category: "Meetings", validation: { status: "passed", testedAt: "2026-07-13T02:00:00.000Z" }, publishedBy: "user-1", publishedAt: "2026-07-13T02:00:00.000Z" },
      { skillVersionId: "skill-version-1", skillId: "skill-1", version: "1.0.0", name: "Meeting actions", description: "Finds follow-up actions.", category: "Meetings", validation: { status: "passed", testedAt: "2026-07-12T02:00:00.000Z" }, publishedBy: "user-1", publishedAt: "2026-07-12T02:00:00.000Z" },
    ] });
  }
  if (url.endsWith("/skills/skill-1/usage")) {
    return response({ data: { skillId: "skill-1", latestVersionId: "skill-version-2", latestVersion: "2.0.0", affectedWorkflows: [] } });
  }
  if (url.endsWith("/skills/skill-1/versions/skill-version-1/diff/skill-version-2")) {
    return response({ data: { skillId: "skill-1", fromVersionId: "skill-version-1", fromVersion: "1.0.0", toVersionId: "skill-version-2", toVersion: "2.0.0", entries: [{ field: "purpose", changed: true, summary: "The Skill description changed.", severity: "info" }] } });
  }
  if (url.endsWith("/skills/skill-1/deprecate")) {
    return response({ data: { skillId: "skill-1", lifecycle: "deprecated" } });
  }
  if (url.endsWith("/runs/run-1/comparison/run-2")) {
    return response({ data: { left: { runId: "run-1", workflowRevisionId: "revision-2", status: "completed", skillVersions: ["2.0.0"], reviewed: true, finalAnswer: null, finishedAt: null }, right: { runId: "run-2", workflowRevisionId: "revision-1", status: "completed", skillVersions: ["1.0.0"], reviewed: true, finalAnswer: null, finishedAt: null }, workflowRevisionChanged: true, skillVersionsChanged: true, finalAnswerChanged: false } });
  }
  if (url.endsWith("/runs/run-1/draft")) {
    return response({ data: { workflow: { workflowId: "workflow-from-run" }, revision: { revisionId: "revision-from-run" } } }, { status: 201 });
  }
  if (url.endsWith("/skills/skill-1/publish")) {
    return response({ data: { skill: { skillId: "skill-1" }, version: { skillVersionId: "skill-version-1" }, release: { releaseId: "release-skill-1" } } });
  }
  if (url.endsWith("/skills") && options.method === "POST") {
    return response({ data: { skill: { skillId: "skill-1" }, draft: { skillDraftId: "draft-1" } } }, { status: 201 });
  }
  if (url.endsWith("/loops/workflow-new/duplicate")) {
    return response({ data: { workflow: { workflowId: "workflow-copy" }, revision: { revisionId: "revision-copy" } } }, { status: 201 });
  }
  if (url.endsWith("/loops")) {
    return response({ data: { workflow: { workflowId: "workflow-new" }, revision: { revisionId: "revision-new" } } }, { status: 201 });
  }
  if (url.endsWith("/loops/workflow-new/skill-updates")) {
    return response({ data: { workflow: { workflowId: "workflow-new" }, revision: { revisionId: "revision-v2" } } }, { status: 201, headers: { etag: '"wfv1:workflow-new:2"' } });
  }
  if (url.endsWith("/loops/workflow-new/skill-updates/skill-version-2")) {
    return response({ data: {
      workflowId: "workflow-new",
      workflowRevisionId: "revision-new",
      workflowName: "Meeting follow-up",
      skillId: "skill-1",
      currentVersion: { skillVersionId: "skill-version-1", version: "1.0.0" },
      targetVersion: { skillVersionId: "skill-version-2", version: "2.0.0" },
      affectedNodes: [{ nodeId: "node-skill", title: "Extract actions" }],
      changes: [],
      requiresTestRun: true,
    } }, { headers: { etag: '"wfv1:workflow-new:1:revision-new"' } });
  }
  if (url.endsWith("/loops/workflow-new/proposals") && options.method === "POST") {
    return response({ data: { proposalId: "proposal-1", baseRevisionId: "revision-new", status: "proposed" } }, { status: 201 });
  }
  if (url.endsWith("/loops/workflow-new/proposals/proposal-1/apply") && options.method === "POST") {
    return response({ data: { proposalId: "proposal-1", baseRevisionId: "revision-new", status: "applied" } });
  }
  if (url.endsWith("/loops/workflow-new/proposals/proposal-1/dismiss") && options.method === "POST") {
    return response({ data: { proposalId: "proposal-1", baseRevisionId: "revision-new", status: "dismissed" } });
  }
  if (url.endsWith("/team-library")) {
    return response({ data: [{ releaseId: "release-1", assetKind: "loop" }] });
  }
  if (url.endsWith("/installations")) {
    return response({ data: [{ installationId: "installation-1", pinnedVersionId: "skill-version-1" }] });
  }
  if (url.endsWith("/installations/installation-1/adopt-release")) {
    return response({ data: { installationId: "installation-1", pinnedVersionId: "skill-version-2" } });
  }
  if (url.endsWith("/installations/installation-1")) {
    return response({ data: { installationId: "installation-1", pinnedVersionId: "skill-version-1" } });
  }
  if (url.endsWith("/starting-point")) {
    return response({ data: { workflow: { workflowId: "workflow-start" }, revision: { revisionId: "revision-start" } } }, { status: 201 });
  }
  if (url.endsWith("/fork")) {
    return response({ data: { workflow: { workflowId: "workflow-fork" }, revision: { revisionId: "revision-fork" } } }, { status: 201 });
  }
  if (url.endsWith("/install")) {
    return response({ data: { installationId: "installation-1" } }, { status: 201 });
  }
  if (url.includes("/revisions/")) {
    return response({ data: { revisionId: "revision-1" } }, { headers: { etag: '"workflow-1:1"' } });
  }
  if (url.endsWith("/compile")) {
    return response({ data: { status: "ready" } });
  }
  if (url.endsWith("/publish")) {
    return response({ data: { loopVersion: { loopVersionId: "loop-version-1" }, release: { releaseId: "release-published" } } }, { status: 201 });
  }
  if (url.endsWith("/cancel")) {
    return response({ data: { runId: "run-1" } });
  }
  if (url.endsWith("/retry")) {
    return response({ data: { runId: "run-2" } });
  }
  if (url.endsWith("/runs")) {
    return response({
      code: "workflow_execution_not_ready",
      message: "Compile this workflow first.",
      details: { workflowId: "workflow-1" },
      retryable: false,
      requestId: "request-1",
    }, { status: 409 });
  }
  throw new Error(`unexpected_url:${url}`);
};

const eventSources = [];
class FakeEventSource {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    eventSources.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
}

const api = createWorkbenchApiClient({
  fetchImpl,
  eventSourceFactory: (url, options) => new FakeEventSource(url, options),
  idFactory: () => "idem-fixed",
});

await api.bootstrap();
const activeSession = await api.getActiveSession();
assert.equal(activeSession.data.membership.role, "viewer");
assert.match(requests.at(-1).url, /\/session$/);
const skillAssets = await api.listSkillAssets();
assert.equal(skillAssets.data[0].skill.skillId, "skill-1");
assert.match(requests.at(-1).url, /\/skill-assets$/);
const resources = await api.listResources();
assert.equal(resources.data[0].resourceId, "resource-1");
await api.createResource({ label: "Meeting notes", mediaType: "text/markdown", contentBase64: "Tm90ZXM=" });
assert.match(requests.at(-1).url, /\/resources$/);
assert.equal(JSON.parse(requests.at(-1).options.body).data.label, "Meeting notes");
const connections = await api.listConnections();
assert.equal(connections.data[0].capabilityKey, "calendar.read");
const createdConnection = await api.createConnection({
  capabilityKey: "calendar.read",
  label: "Team calendar",
  configuration: { accountLabel: "Team calendar", permissionSummary: "Read event titles." },
});
assert.equal(createdConnection.etag, '"cnv1:connection-1:1"');
const connectionCreateRequest = requests.at(-1);
assert.equal(connectionCreateRequest.options.method, "POST");
assert.equal(JSON.parse(connectionCreateRequest.options.body).data.capabilityKey, "calendar.read");
const updatedConnection = await api.updateConnection(
  "connection-1",
  { label: "Team calendar", configuration: { accountLabel: "Team calendar", permissionSummary: "Read shared event details." }, enabled: true },
  { ifMatch: createdConnection.etag },
);
assert.equal(updatedConnection.etag, '"cnv1:connection-1:2"');
assert.equal(requests.at(-1).options.method, "PATCH");
assert.equal(requests.at(-1).options.headers["If-Match"], '"cnv1:connection-1:1"');
const validatedConnection = await api.validateConnection(
  "connection-1",
  { ifMatch: updatedConnection.etag },
);
assert.equal(validatedConnection.data.validation.status, "valid");
assert.match(requests.at(-1).url, /\/connections\/connection-1\/validate$/);
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data, {});
assert.equal(requests.at(-1).options.headers["If-Match"], '"cnv1:connection-1:2"');
const revision = await api.getWorkflowRevision("workflow-1", "revision-1");
assert.equal(revision.etag, '"workflow-1:1"');
await api.compileWorkflow("workflow-1", "revision-1");
const compileRequest = requests.at(-1);
assert.equal(compileRequest.options.credentials, "same-origin");
assert.equal(compileRequest.options.headers["Idempotency-Key"], "idem-fixed");
assert.equal(compileRequest.options.headers["X-Workbench-CSRF"], "c".repeat(32));
assert.equal(JSON.parse(compileRequest.options.body).schemaVersion, "workbench-api-v1");

const createdLoop = await api.createLoop({
  name: "Action follow-up",
  description: "Turn decisions into follow-up work.",
  definition: {
    goal: "Turn meeting decisions into follow-up work.",
    context: "",
    constraints: [],
    doneWhen: ["The follow-up is clear."],
    verify: [],
    expectedResult: "A clear follow-up.",
    stopRules: [],
  },
});
assert.equal(createdLoop.data.workflow.workflowId, "workflow-new");
const createRequest = requests.at(-1);
assert.match(createRequest.url, /\/loops$/);
assert.equal(JSON.parse(createRequest.options.body).data.name, "Action follow-up");

const copiedLoop = await api.duplicateLoop("workflow-new", { name: "Action follow-up copy" });
const duplicateRequest = requests.at(-1);
assert.match(duplicateRequest.url, /\/loops\/workflow-new\/duplicate$/);
assert.equal(duplicateRequest.options.method, "POST");
assert.equal(JSON.parse(duplicateRequest.options.body).data.name, "Action follow-up copy");
assert.equal(copiedLoop.data.workflow.workflowId, "workflow-copy");

const portableBytes = new TextEncoder().encode('{"schemaVersion":"portable-loop-package-v1"}\n');
const loopProgress = [];
const preparedLoop = await beginPortableLoopImport({
  api,
  data: { bytes: portableBytes, filename: "portable-proof.loop.json" },
  idempotencyKey: "portable-proof",
  onProgress: (progress) => loopProgress.push(progress),
});
assert.equal(preparedLoop.upload.assetKind, "loop");
assert.equal(preparedLoop.loopImport.importId, "loop-import-1");
assert.equal(preparedLoop.etag, '"liv1:loop-import-1:1"');
assert.deepEqual(loopProgress.map((item) => item.phase), ["uploading", "uploading", "checking", "preparing"]);
const portableUploadRequest = requests.find((request) => request.url.endsWith("/uploads") && JSON.parse(request.options.body).data.assetKind === "loop");
assert.equal(JSON.parse(portableUploadRequest.options.body).data.mediaType, PORTABLE_LOOP_PACKAGE_MEDIA_TYPE);
assert.equal(JSON.parse(portableUploadRequest.options.body).data.ingestMethod, "resumable");
assert.match(requests.find((request) => request.url.endsWith("/loop-imports")).options.headers["Idempotency-Key"], /portable-proof:import/);

const refreshedImport = await api.getLoopImport("loop-import-1");
assert.equal(refreshedImport.etag, '"liv1:loop-import-1:1"');
const committedImport = await api.commitLoopImport("loop-import-1", {
  skillMappings: [],
  materialMappings: [],
  connectionMappings: [],
}, { ifMatch: refreshedImport.etag, idempotencyKey: "portable-proof:commit" });
assert.equal(committedImport.data.workflow.workflowId, "workflow-imported");
assert.equal(requests.at(-1).options.headers["If-Match"], '"liv1:loop-import-1:1"');

const downloadedLoop = await api.exportLoop("workflow-new", "revision-new");
assert.equal(downloadedLoop.mediaType, PORTABLE_LOOP_PACKAGE_MEDIA_TYPE);
assert.equal(downloadedLoop.filename, "portable-proof.loop.json");
assert.equal(downloadedLoop.etag, '"sha256:portable-proof"');
assert.equal(new TextDecoder().decode(downloadedLoop.bytes), new TextDecoder().decode(portableBytes));
assert.equal(portableLoopFilename('attachment; filename="safe-name.loop.json"'), "safe-name.loop.json");
const exportRequest = requests.at(-1);
assert.equal(exportRequest.options.headers.Accept, PORTABLE_LOOP_PACKAGE_MEDIA_TYPE);
assert.equal(exportRequest.options.credentials, "same-origin");

const canonicalPackage = formatSkillPackageBytes([
  { path: "scripts/main.py", contentBase64: "cHJpbnQoJ29rJykK" },
  { path: "SKILL.md", contentBase64: "IyBQcm9vZgo=" },
]);
assert.equal(
  new TextDecoder().decode(canonicalPackage),
  '{"format":"workbench-skill-package-v1","files":[{"path":"scripts/main.py","content":"cHJpbnQoJ29rJykK"},{"path":"SKILL.md","content":"IyBQcm9vZgo="}]}\n',
);
assert.equal(encodeBytesBase64(canonicalPackage), Buffer.from(canonicalPackage).toString("base64"));

const resumableData = {
  name: "Resume proof",
  description: "Checks missing chunk transfer.",
  category: "Tests",
  filename: "resume-proof.skill",
  sizeBytes: 400000,
  files: [{ path: "SKILL.md", contentBase64: Buffer.alloc(400000, 97).toString("base64") }],
};
const resumableCalls = [];
const resumableProgress = [];
let declaredPackageBytes = 0;
const resumableResult = await inspectResumableSkillPackage({
  api: {
    async createUpload(data, options) {
      declaredPackageBytes = data.sizeBytes;
      resumableCalls.push({ operation: "create", data, options });
      return { data: { uploadId: "upload-resume-1" } };
    },
    async getUpload(uploadId) {
      resumableCalls.push({ operation: "get", uploadId });
      return { data: {
        uploadId,
        state: "selecting",
        sizeBytes: declaredPackageBytes,
        ingestMethod: "resumable",
        transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0], receivedBytes: 524288, complete: false },
      } };
    },
    async uploadChunk(uploadId, chunkIndex, data, options) {
      resumableCalls.push({ operation: "chunk", uploadId, chunkIndex, data, options });
      return { data: {
        uploadId,
        state: "selecting",
        sizeBytes: declaredPackageBytes,
        ingestMethod: "resumable",
        transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0, 1], receivedBytes: declaredPackageBytes, complete: true },
      } };
    },
    async completeUpload(uploadId, options) {
      resumableCalls.push({ operation: "complete", uploadId, options });
      return { data: {
        uploadId,
        state: "ready_draft",
        sizeBytes: declaredPackageBytes,
        ingestMethod: "resumable",
        transfer: { chunkSizeBytes: 524288, totalChunks: 2, receivedChunks: [0, 1], receivedBytes: declaredPackageBytes, complete: true },
      } };
    },
  },
  data: resumableData,
  idempotencyKey: "resume-proof",
  onProgress: (progress) => resumableProgress.push(progress),
});
assert.ok(declaredPackageBytes > resumableData.sizeBytes, "the upload declares canonical envelope bytes");
assert.deepEqual(resumableCalls.map((call) => call.operation), ["create", "get", "chunk", "complete"]);
assert.equal(resumableCalls[0].data.ingestMethod, "resumable");
assert.equal(resumableCalls[0].options.idempotencyKey, "resume-proof:upload");
assert.equal(resumableCalls[2].chunkIndex, 1, "the server-confirmed first chunk must be skipped");
assert.equal(resumableCalls[2].options.idempotencyKey, "resume-proof:chunk:1");
assert.equal(resumableCalls[3].options.idempotencyKey, "resume-proof:complete");
assert.equal(resumableProgress.at(-1).phase, "checking");
assert.equal(resumableProgress.at(-1).percent, 100);
assert.equal(resumableResult.upload.state, "ready_draft");
assert.equal(resumableResult.metadata, resumableData);
assert.equal(resumableResult.idempotencyKey, "resume-proof");

const repositoryProgress = [];
let repositoryRequest;
const repositoryData = {
  name: "Repository proof",
  description: "Checks strict import data.",
  category: "Tests",
  repositoryUrl: "https://github.com/openai/example",
  ref: "main",
  skillDirectory: "skills/proof",
};
const repositoryResult = await importSkillRepositoryPackage({
  api: {
    async importSkillRepository(data, options) {
      repositoryRequest = { data, options };
      return { data: {
        uploadId: "upload-repository-proof",
        state: "ready_draft",
        sizeBytes: 100,
        transfer: { receivedBytes: 100 },
      } };
    },
  },
  data: repositoryData,
  idempotencyKey: "repository-proof",
  onProgress: (progress) => repositoryProgress.push(progress),
});
assert.deepEqual(repositoryRequest.data, {
  repositoryUrl: repositoryData.repositoryUrl,
  ref: "main",
  skillDirectory: "skills/proof",
});
assert.equal(repositoryRequest.options.idempotencyKey, "repository-proof");
assert.deepEqual(repositoryProgress.map((progress) => progress.phase), ["importing", "checking"]);
assert.equal(repositoryResult.metadata, repositoryData);
assert.equal(repositoryResult.idempotencyKey, "repository-proof");

const upload = await api.createUpload({
  filename: "meeting-action.skill-package",
  sizeBytes: 42,
  mediaType: "application/vnd.looloomi.skill-package+json",
});
assert.equal(upload.data.uploadId, "upload-1");
const uploadRequest = requests.at(-1);
assert.match(uploadRequest.url, /\/uploads$/);
assert.equal(JSON.parse(uploadRequest.options.body).data.filename, "meeting-action.skill-package");

await api.uploadSkillPackage("upload-1", {
  files: [{ path: "SKILL.md", contentBase64: "IyBzYW1wbGU=" }],
});
const packageRequest = requests.at(-1);
assert.match(packageRequest.url, /\/uploads\/upload-1\/package$/);
assert.equal(JSON.parse(packageRequest.options.body).data.files[0].path, "SKILL.md");

const uploadStatus = await api.getUpload("upload-1");
assert.deepEqual(uploadStatus.data.transfer.receivedChunks, [0]);
const chunkBytes = canonicalPackage.subarray(0, 8);
await api.uploadChunk("upload-1", 1, {
  contentBase64: encodeBytesBase64(chunkBytes),
}, { idempotencyKey: "inspect-1:chunk:1" });
const chunkRequest = requests.at(-1);
assert.match(chunkRequest.url, /\/uploads\/upload-1\/chunks\/1$/);
assert.equal(chunkRequest.options.method, "PUT");
assert.equal(chunkRequest.options.headers["Idempotency-Key"], "inspect-1:chunk:1");
assert.equal(JSON.parse(chunkRequest.options.body).data.contentBase64, Buffer.from(chunkBytes).toString("base64"));

await api.completeUpload("upload-1", { idempotencyKey: "inspect-1:complete" });
const completeRequest = requests.at(-1);
assert.match(completeRequest.url, /\/uploads\/upload-1\/complete$/);
assert.deepEqual(JSON.parse(completeRequest.options.body).data, {});
assert.equal(completeRequest.options.headers["Idempotency-Key"], "inspect-1:complete");

const importedUpload = await api.importSkillRepository({
  repositoryUrl: "https://github.com/openai/example",
  ref: "main",
  skillDirectory: "skills/proof",
}, { idempotencyKey: "import-1" });
assert.equal(importedUpload.data.ingestMethod, "repository");
const importRequest = requests.at(-1);
assert.match(importRequest.url, /\/uploads\/repository$/);
assert.equal(importRequest.options.headers["Idempotency-Key"], "import-1");
assert.equal(JSON.parse(importRequest.options.body).data.skillDirectory, "skills/proof");

await api.promoteUpload("upload-1");
assert.match(requests.at(-1).url, /\/uploads\/upload-1\/promote$/);

const createdSkill = await api.createSkill({
  name: "Meeting action extractor",
  description: "Finds accountable follow-up actions.",
  category: "Meetings",
  uploadId: "upload-1",
});
assert.equal(createdSkill.data.skill.skillId, "skill-1");
const createSkillRequest = requests.at(-1);
assert.match(createSkillRequest.url, /\/skills$/);
assert.equal(JSON.parse(createSkillRequest.options.body).data.uploadId, "upload-1");

const draftPackage = await api.getSkillDraftPackage("skill-1", "draft-1");
assert.equal(draftPackage.data.files[0].path, "SKILL.md");
assert.equal(JSON.stringify(draftPackage.data).includes("contentHash"), false);
const replacedPackage = await api.replaceSkillDraftPackage(
  "skill-1",
  "draft-1",
  { uploadId: "upload-1" },
  { ifMatch: '"skill-draft-1:1"' },
);
assert.equal(replacedPackage.etag, '"skill-draft-1:2"');
assert.equal(requests.at(-1).options.method, "PUT");
assert.equal(JSON.parse(requests.at(-1).options.body).data.uploadId, "upload-1");

const skillDraft = await api.getSkillDraft("skill-1", "draft-1");
assert.equal(skillDraft.etag, '"skill-draft-1:1"');
const testRun = await api.createSkillTest(
  "skill-1",
  "draft-1",
  {
    testCase: {
      name: "Extract one action",
      purpose: "Check the uploaded Skill with supplied notes.",
      input: { meetingNotes: "Ari sends the brief Friday." },
      expectedOutput: { actionCount: 1 },
      timeoutSeconds: 30,
    },
  },
  { ifMatch: skillDraft.etag, idempotencyKey: "idem-skill-test-1" },
);
assert.equal(testRun.data.testRunId, "skill-test-run-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/drafts\/draft-1\/tests$/);
assert.equal(requests.at(-1).options.headers["If-Match"], '"skill-draft-1:1"');
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "idem-skill-test-1");

const validation = await api.createSkillValidation(
  "skill-1",
  "draft-1",
  { testRunIds: ["skill-test-run-1"], permissionAcknowledged: true },
  { ifMatch: skillDraft.etag, idempotencyKey: "idem-skill-validation-1" },
);
assert.equal(validation.data.validationId, "skill-validation-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/drafts\/draft-1\/validations$/);
assert.equal(requests.at(-1).options.headers["If-Match"], '"skill-draft-1:1"');
assert.equal(requests.at(-1).options.headers["Idempotency-Key"], "idem-skill-validation-1");

await api.getSkillTestRun("skill-1", "skill-test-run-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/tests\/skill-test-run-1$/);
await api.getSkillValidation("skill-1", "skill-validation-1");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/validations\/skill-validation-1$/);
const publishedSkill = await api.publishSkill(
  "skill-1",
  { version: "1.0.0", releaseNotes: "First verified release." },
  { ifMatch: skillDraft.etag },
);
assert.equal(publishedSkill.data.version.skillVersionId, "skill-version-1");
assert.equal(publishedSkill.data.release.releaseId, "release-skill-1");
const publishSkillRequest = requests.at(-1);
assert.match(publishSkillRequest.url, /\/skills\/skill-1\/publish$/);
assert.equal(publishSkillRequest.options.headers["If-Match"], '"skill-draft-1:1"');

const nextDraft = await api.createNextSkillDraft(
  "skill-1",
  { baseVersionId: "skill-version-1" },
  { ifMatch: skillDraft.etag },
);
assert.equal(nextDraft.data.skillDraftId, "draft-2");
assert.equal(requests.at(-1).options.headers["If-Match"], '"skill-draft-1:1"');
const updatedDraft = await api.updateSkillDraft(
  "skill-1",
  "draft-2",
  { description: "Clearer meeting actions." },
  { ifMatch: nextDraft.etag },
);
assert.equal(updatedDraft.etag, '"skill-draft-2:2"');
assert.equal(requests.at(-1).options.method, "PATCH");
const versions = await api.listSkillVersions("skill-1");
assert.deepEqual(versions.data.map((item) => item.version), ["2.0.0", "1.0.0"]);
assert.match(requests.at(-1).url, /\/skills\/skill-1\/versions$/);
assert.equal("executionRef" in versions.data[0], false);
const usage = await api.getSkillUsage("skill-1");
assert.equal(usage.data.latestVersion, "2.0.0");
const skillDiff = await api.getSkillVersionDiff("skill-1", "skill-version-1", "skill-version-2");
assert.equal(skillDiff.data.entries[0].field, "purpose");
const retiredSkill = await api.deprecateSkill("skill-1", { reason: "A newer version is available." });
assert.equal(retiredSkill.data.lifecycle, "deprecated");
assert.match(requests.at(-1).url, /\/skills\/skill-1\/deprecate$/);
assert.equal(JSON.parse(requests.at(-1).options.body).data.reason, "A newer version is available.");
const runComparison = await api.getRunComparison("run-1", "run-2");
assert.deepEqual(runComparison.data.left.skillVersions, ["2.0.0"]);
assert.match(requests.at(-1).url, /\/runs\/run-1\/comparison\/run-2$/);
const fromRun = await api.createLoopDraftFromRun("run-1", { name: "Action follow-up from run" });
assert.equal(fromRun.data.workflow.workflowId, "workflow-from-run");
assert.match(requests.at(-1).url, /\/runs\/run-1\/draft$/);
assert.equal(JSON.parse(requests.at(-1).options.body).data.name, "Action follow-up from run");

const published = await api.publishLoop("workflow-new", { version: "1.0.0", releaseNotes: "First team release.", startingPoint: true }, { ifMatch: '"wfv1:workflow-new:1"' });
assert.equal(published.data.release.releaseId, "release-published");
const publishRequest = requests.at(-1);
assert.match(publishRequest.url, /\/loops\/workflow-new\/publish$/);
assert.equal(publishRequest.options.headers["If-Match"], '"wfv1:workflow-new:1"');
assert.equal(JSON.parse(publishRequest.options.body).data.startingPoint, true);
const updatedLoop = await api.createLoopSkillUpdate(
  "workflow-new",
  { skillId: "skill-1", fromVersion: "1.0.0", toVersion: "2.0.0" },
  { ifMatch: '"wfv1:workflow-new:1"' },
);
assert.equal(updatedLoop.data.revision.revisionId, "revision-v2");
assert.match(requests.at(-1).url, /\/loops\/workflow-new\/skill-updates$/);
const updatePreview = await api.getLoopSkillUpdatePreview("workflow-new", "skill-version-2");
assert.equal(updatePreview.data.targetVersion.version, "2.0.0");
assert.equal(updatePreview.etag, '"wfv1:workflow-new:1:revision-new"');
assert.match(requests.at(-1).url, /\/loops\/workflow-new\/skill-updates\/skill-version-2$/);

const proposed = await api.generateLoopProposal(
  "workflow-new",
  { instruction: "Add a review step." },
  { ifMatch: '"wfv1:workflow-new:2"' },
);
assert.equal(proposed.data.status, "proposed");
const proposalRequest = requests.at(-1);
assert.match(proposalRequest.url, /\/loops\/workflow-new\/proposals$/);
assert.equal(proposalRequest.options.headers["If-Match"], '"wfv1:workflow-new:2"');
assert.equal(JSON.parse(proposalRequest.options.body).data.instruction, "Add a review step.");

const appliedProposal = await api.applyLoopProposal(
  "workflow-new",
  "proposal-1",
  { baseRevisionId: "revision-new" },
  { ifMatch: '"wfv1:workflow-new:2"' },
);
assert.equal(appliedProposal.data.status, "applied");
assert.match(requests.at(-1).url, /\/loops\/workflow-new\/proposals\/proposal-1\/apply$/);

const dismissedProposal = await api.dismissLoopProposal(
  "workflow-new",
  "proposal-1",
  { baseRevisionId: "revision-new" },
  { ifMatch: '"wfv1:workflow-new:2"' },
);
assert.equal(dismissedProposal.data.status, "dismissed");
assert.match(requests.at(-1).url, /\/loops\/workflow-new\/proposals\/proposal-1\/dismiss$/);

const library = await api.listTeamLibrary();
assert.equal(library.data[0].releaseId, "release-1");
const installations = await api.listInstallations();
assert.equal(installations.data[0].installationId, "installation-1");
const connectionBindings = [{ requirementId: "calendar.read", connectionId: "connection-1" }];
const adoptedInstallation = await api.adoptInstallationRelease("installation-1", { releaseId: "release-2", connectionBindings });
assert.equal(adoptedInstallation.data.pinnedVersionId, "skill-version-2");
assert.match(requests.at(-1).url, /\/installations\/installation-1\/adopt-release$/);
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data.connectionBindings, connectionBindings);
const installed = await api.installTeamRelease("release-1", { connectionIds: ["connection-1"], connectionBindings });
assert.equal(installed.data.installationId, "installation-1");
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data.connectionBindings, connectionBindings);
const startingPoint = await api.useTeamReleaseAsStartingPoint("release-1", { name: "My shared Loop", connectionBindings });
assert.equal(startingPoint.data.workflow.workflowId, "workflow-start");
assert.match(requests.at(-1).url, /\/team-library\/release-1\/starting-point$/);
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data.connectionBindings, connectionBindings);
const forkedLoop = await api.forkTeamLoopRelease("release-1", { name: "My independent Loop", connectionBindings });
assert.equal(forkedLoop.data.workflow.workflowId, "workflow-fork");
assert.match(requests.at(-1).url, /\/team-library\/release-1\/fork$/);
assert.deepEqual(JSON.parse(requests.at(-1).options.body).data.connectionBindings, connectionBindings);

await assert.rejects(
  () => api.startRun("workflow-1", { workflowRevisionId: "revision-1", inputs: {}, resourceRefs: [] }),
  (error) => error instanceof WorkbenchApiError
    && error.code === "workflow_execution_not_ready"
    && error.status === 409,
);

const cancelled = await api.cancelRun("run-1", { reason: "Stop this test run." });
assert.equal(cancelled.data.runId, "run-1");
const cancelRequest = requests.at(-1);
assert.match(cancelRequest.url, /\/runs\/run-1\/cancel$/);
assert.equal(JSON.parse(cancelRequest.options.body).data.reason, "Stop this test run.");

const retried = await api.retryRun("run-1", { reason: "Try the saved workflow again." });
assert.equal(retried.data.runId, "run-2");
const retryRequest = requests.at(-1);
assert.match(retryRequest.url, /\/runs\/run-1\/retry$/);
assert.equal(JSON.parse(retryRequest.options.body).data.reason, "Try the saved workflow again.");

const recoveryRequests = [];
let recoveryWorkspaceCalls = 0;
let recoveryCompileCalls = 0;
const recoveringApi = createWorkbenchApiClient({
  idFactory: () => "idem-restart-safe",
  async fetchImpl(url, options = {}) {
    recoveryRequests.push({ url, options });
    if (url.endsWith("/workspace")) {
      recoveryWorkspaceCalls += 1;
      return response({
        data: {
          session: {
            csrfToken: (recoveryWorkspaceCalls === 1 ? "a" : "b").repeat(32),
            expiresAt: "2026-07-10T10:00:00.000Z",
          },
        },
      });
    }
    if (url.endsWith("/compile")) {
      recoveryCompileCalls += 1;
      if (recoveryCompileCalls === 1) {
        return response({
          code: "session_required",
          message: "A Workbench session is required.",
          details: {},
          retryable: true,
          requestId: "request-session-restart",
        }, { status: 401 });
      }
      return response({ data: { status: "ready" } });
    }
    throw new Error(`unexpected_recovery_url:${url}`);
  },
});
await recoveringApi.bootstrap();
await recoveringApi.compileWorkflow("workflow-restart", "revision-restart");
const recoveryCompiles = recoveryRequests.filter((entry) => entry.url.endsWith("/compile"));
assert.equal(recoveryWorkspaceCalls, 2);
assert.equal(recoveryCompiles.length, 2);
assert.equal(recoveryCompiles[0].options.headers["Idempotency-Key"], "idem-restart-safe");
assert.equal(recoveryCompiles[1].options.headers["Idempotency-Key"], "idem-restart-safe");
assert.equal(recoveryCompiles[0].options.headers["X-Workbench-CSRF"], "a".repeat(32));
assert.equal(recoveryCompiles[1].options.headers["X-Workbench-CSRF"], "b".repeat(32));

let concurrentWorkspaceCalls = 0;
const concurrentRequests = [];
const concurrentApi = createWorkbenchApiClient({
  idFactory: () => "idem-concurrent",
  async fetchImpl(url, options = {}) {
    concurrentRequests.push({ url, options });
    if (url.endsWith("/workspace")) {
      concurrentWorkspaceCalls += 1;
      if (concurrentWorkspaceCalls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return response({
        data: {
          session: {
            csrfToken: (concurrentWorkspaceCalls === 1 ? "a" : "b").repeat(32),
            expiresAt: "2026-07-10T10:00:00.000Z",
          },
        },
      });
    }
    if (url.endsWith("/compile")) {
      if (options.headers["X-Workbench-CSRF"] === "a".repeat(32)) {
        return response({
          code: "session_required",
          message: "A Workbench session is required.",
          details: {},
          retryable: true,
          requestId: "request-concurrent-session-restart",
        }, { status: 401 });
      }
      return response({ data: { status: "ready" } });
    }
    throw new Error("unexpected_concurrent_url:" + url);
  },
});
await concurrentApi.bootstrap();
await Promise.all([
  concurrentApi.compileWorkflow("workflow-a", "revision-a", { idempotencyKey: "idem-a" }),
  concurrentApi.compileWorkflow("workflow-b", "revision-b", { idempotencyKey: "idem-b" }),
]);
assert.equal(concurrentWorkspaceCalls, 2, "concurrent 401 responses must share one session refresh");
const concurrentRetries = concurrentRequests.filter((entry) => (
  entry.url.endsWith("/compile") && entry.options.headers["X-Workbench-CSRF"] === "b".repeat(32)
));
assert.equal(concurrentRetries.length, 2);
assert.deepEqual(
  concurrentRetries.map((entry) => entry.options.headers["Idempotency-Key"]).sort(),
  ["idem-a", "idem-b"],
);

const events = [];
const stream = api.openRunEventStream("run-1", {
  after: 4,
  onEvent: (event) => events.push(event),
});
assert.equal(eventSources[0].url, "/api/workbench/v1/runs/run-1/events?after=4");
assert.equal(eventSources[0].options.withCredentials, true);
assert.ok(RUN_EVENT_TYPES.every((type) => eventSources[0].listeners.has(type)));
eventSources[0].emit("node.completed", { runId: "run-1", sequence: 5, type: "node.completed" });
assert.equal(events[0].sequence, 5);
stream.close();
assert.equal(eventSources[0].closed, true);

console.log("web_api_client_smoke=pass");
