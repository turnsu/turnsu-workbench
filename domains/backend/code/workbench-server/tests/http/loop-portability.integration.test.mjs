import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
} from "@looloomi/workbench-contracts";
import { portableLoopPackageExample } from "../../../workbench-contracts/examples/canonical-examples.mjs";

import {
  formatPortableLoopPackage,
  parsePortableLoopPackage,
  PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
} from "../../src/loops/portable-loop-package.mjs";
import { createWorkbenchServer } from "../../src/server.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DATABASE_NAME = process.env.MONGODB_DB ?? "looloomi_workbench_loop_portability_test";

if (!DATABASE_NAME.endsWith("_test")) throw new Error(`integration_database_must_end_in_test:${DATABASE_NAME}`);

test("portable Loop upload, import commit, export, cache validation, isolation, and restart readback", {
  skip: !ENABLED,
  timeout: 60_000,
}, async (context) => {
  const objectStoreRoot = await mkdtemp(join(tmpdir(), "looloomi-loop-portability-"));
  const store = new ProductMongoStore({ uri: MONGODB_URI, dbName: DATABASE_NAME });
  const db = await store.connect();
  await store.dropTestDatabase();
  const composed = createWorkbenchServer({
    store,
    agentRuntime: {},
    runner: {},
    objectStoreRoot,
    bootstrapCatalog: false,
    distDirectory: null,
    env: { ...process.env, WORKBENCH_TEST_MODE: "1", WECHAT_AGENT_TEST_MODE: "1" },
  });
  context.after(async () => {
    await composed.close();
    await store.dropTestDatabase();
    await store.close();
    await rm(objectStoreRoot, { recursive: true, force: true });
  });
  await composed.ready;
  const port = await listen(composed.server);
  const origin = `http://127.0.0.1:${port}`;
  const owner = await bootstrap(origin, "loop-owner", "loop-workspace");
  const outsider = await bootstrap(origin, "loop-outsider", "other-workspace");
  await store.addWorkspaceMembership({
    workspaceId: "loop-workspace",
    addedBy: "loop-owner",
    userId: "loop-viewer",
    displayName: "Loop viewer",
    role: "viewer",
    idempotencyKey: "add-loop-viewer",
  });
  const viewer = await bootstrap(origin, "loop-viewer", "loop-workspace");

  const packageBytes = formatPortableLoopPackage(minimalPortableLoop());
  const upload = await mutation(origin, owner, "/api/workbench/v1/uploads", {
    key: "loop-upload-create",
    body: {
      filename: "portable-review.loop.json",
      sizeBytes: packageBytes.byteLength,
      mediaType: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
      assetKind: "loop",
      ingestMethod: "resumable",
    },
    expectedStatus: 201,
  });
  assert.equal(upload.body.data.assetKind, "loop");
  const uploadId = upload.body.data.uploadId;

  await mutation(origin, owner, `/api/workbench/v1/uploads/${uploadId}/chunks/0`, {
    method: "PUT",
    key: "loop-upload-chunk",
    body: { contentBase64: packageBytes.toString("base64") },
  });
  const completed = await mutation(origin, owner, `/api/workbench/v1/uploads/${uploadId}/complete`, {
    key: "loop-upload-complete",
    body: {},
  });
  assert.equal(completed.body.data.state, "ready_draft");

  const createdImport = await mutation(origin, owner, "/api/workbench/v1/loop-imports", {
    key: "loop-import-create",
    body: { uploadId },
    expectedStatus: 202,
  });
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopImport.responseBodySchema, createdImport.body), true);
  assert.equal(createdImport.body.data.status, "ready");
  const importId = createdImport.body.data.importId;
  const importEtag = createdImport.response.headers.get("etag");
  assert.ok(importEtag);

  const stale = await mutation(origin, owner, `/api/workbench/v1/loop-imports/${importId}/commit`, {
    key: "loop-import-stale",
    ifMatch: '"liv1:wrong:1:sha256:wrong"',
    body: emptyMappings(),
    expectedStatus: 412,
  });
  assert.equal(stale.body.code, "loop_import_revision_conflict");

  const committed = await mutation(origin, owner, `/api/workbench/v1/loop-imports/${importId}/commit`, {
    key: "loop-import-commit",
    ifMatch: importEtag,
    body: emptyMappings(),
    expectedStatus: 201,
  });
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.commitLoopImport.responseBodySchema, committed.body), true);
  assert.equal(committed.body.data.workflow.status, "blocked");
  assert.equal(committed.body.data.workflow.visibility, "private");
  assert.equal(committed.body.data.revision.compile.status, "blocked");
  const { workflowId } = committed.body.data.workflow;
  const revisionId = committed.body.data.revision.revisionId;

  const exported = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/export?revisionId=${revisionId}`, {
    headers: { Cookie: owner.cookie },
  });
  assert.equal(exported.status, 200, await exported.clone().text());
  assert.match(exported.headers.get("content-type"), new RegExp(`^${PORTABLE_LOOP_PACKAGE_MEDIA_TYPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(exported.headers.get("content-disposition"), /^attachment; filename="[A-Za-z0-9][A-Za-z0-9._-]*\.loop\.json"$/);
  const exportedBytes = Buffer.from(await exported.arrayBuffer());
  const exportedPackage = parsePortableLoopPackage(exportedBytes);
  assert.equal(exportedPackage.name, "Portable review Loop");
  assert.equal(exportedBytes.equals(formatPortableLoopPackage(exportedPackage)), true);
  const exportEtag = exported.headers.get("etag");
  assert.ok(exportEtag);

  const notModified = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/export?revisionId=${revisionId}`, {
    headers: { Cookie: owner.cookie, "If-None-Match": exportEtag },
  });
  assert.equal(notModified.status, 304);
  assert.equal((await notModified.arrayBuffer()).byteLength, 0);

  const viewerDenied = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/export?revisionId=${revisionId}`, {
    headers: { Cookie: viewer.cookie },
  });
  assert.equal(viewerDenied.status, 403);
  assert.equal((await viewerDenied.json()).code, "loop_export_forbidden");
  const outsiderHidden = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/export?revisionId=${revisionId}`, {
    headers: { Cookie: outsider.cookie },
  });
  assert.equal(outsiderHidden.status, 404);

  const committedImport = await store.getLoopImport({ importId, workspaceId: "loop-workspace" });
  assert.equal(committedImport.data.status, "committed");
  assert.equal(committedImport.data.committedWorkflowId, workflowId);

  const mappedPackage = mappedPortableLoop();
  await store.repositories.skillVersions.insert({
    schemaVersion: "workbench-v1",
    skillVersionId: "skill-version-portable-import",
    workspaceId: "loop-workspace",
    skillId: mappedPackage.requirements.skills[0].skillId,
    version: mappedPackage.requirements.skills[0].version,
    contentHash: mappedPackage.requirements.skills[0].contentHash,
    connectionRequirements: [{
      requirementId: "evidence-catalog-read",
      label: "Evidence catalog",
      required: true,
      permissionSummary: "Read approved evidence selected by this workspace.",
    }],
  });
  await store.repositories.connections.insert({
    schemaVersion: "workbench-v1",
    connectionId: "connection-portable-import",
    workspaceId: "loop-workspace",
    capabilityKey: "evidence-catalog-read",
    label: "Portable evidence catalog",
    configuration: {},
    status: "connected",
    validation: { status: "valid", checkedAt: "2026-07-14T00:00:00.000Z", message: "Ready." },
    revision: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  });
  const mappedBytes = formatPortableLoopPackage(mappedPackage);
  const mappedUpload = await uploadLoop(origin, owner, mappedBytes, "mapped");
  const mappedImport = await mutation(origin, owner, "/api/workbench/v1/loop-imports", {
    key: "loop-import-create-mapped",
    body: { uploadId: mappedUpload },
    expectedStatus: 202,
  });
  assert.equal(mappedImport.body.data.status, "needs_mapping");
  const mappedImportId = mappedImport.body.data.importId;
  const mappedImportEtag = mappedImport.response.headers.get("etag");
  const missingMappings = await mutation(origin, owner, `/api/workbench/v1/loop-imports/${mappedImportId}/commit`, {
    key: "loop-import-missing-mappings",
    ifMatch: mappedImportEtag,
    body: emptyMappings(),
    expectedStatus: 409,
  });
  assert.equal(missingMappings.body.code, "loop_import_mapping_invalid");
  const mappedCommit = await mutation(origin, owner, `/api/workbench/v1/loop-imports/${mappedImportId}/commit`, {
    key: "loop-import-commit-mapped",
    ifMatch: mappedImportEtag,
    body: {
      skillMappings: [{ requirementRef: "skill:research-brief", skillVersionId: "skill-version-portable-import" }],
      materialMappings: [{
        requirementRef: "material:research-guidance",
        resolution: { kind: "embeddedMaterial", contentHash: mappedPackage.embeddedMaterials[0].contentHash },
      }],
      connectionMappings: [{
        requirementRef: "connection:evidence-catalog-read",
        connectionId: "connection-portable-import",
      }],
    },
    expectedStatus: 201,
  });
  assert.equal(mappedCommit.body.data.revision.resourceRefs.length, 1);
  assert.equal(mappedCommit.body.data.revision.compile.status, "blocked");
  const mappedRevisionId = mappedCommit.body.data.revision.revisionId;
  assert.deepEqual(await store.repositories.connectionBindings.listByTarget({
    workspaceId: "loop-workspace",
    targetKind: "workflow_revision",
    targetId: mappedRevisionId,
  }), [{
    workspaceId: "loop-workspace",
    targetKind: "workflow_revision",
    targetId: mappedRevisionId,
    requirementId: "evidence-catalog-read",
    connectionId: "connection-portable-import",
    boundBy: "loop-owner",
    boundAt: mappedCommit.body.data.revision.createdAt,
  }]);
  assert.equal(await db.collection("loop_versions").countDocuments({
    workspaceId: "loop-workspace",
    workflowId: mappedCommit.body.data.workflow.workflowId,
  }), 0);

  const restarted = new ProductMongoStore({ uri: MONGODB_URI, dbName: DATABASE_NAME });
  await restarted.connect();
  context.after(() => restarted.close());
  assert.equal((await restarted.getWorkflow(workflowId, { workspaceId: "loop-workspace" })).workflow.currentRevisionId, revisionId);
  assert.equal((await restarted.getLoopImport({ importId, workspaceId: "loop-workspace" })).data.status, "committed");
});

function minimalPortableLoop() {
  const input = structuredClone(portableLoopPackageExample.graph.nodes.find((node) => node.kind === "Input"));
  const output = structuredClone(portableLoopPackageExample.graph.nodes.find((node) => node.kind === "Output"));
  output.inputPorts = [{ portId: "content", name: "Content", schema: { type: "string", minLength: 1 }, required: true }];
  output.inputBindings = [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: input.nodeId, portId: "topic" } }];
  return {
    ...structuredClone(portableLoopPackageExample),
    name: "Portable review Loop",
    graph: {
      nodes: [input, output],
      edges: [{
        edgeId: "edge-input-output",
        sourceNodeId: input.nodeId,
        sourcePort: "topic",
        targetNodeId: output.nodeId,
        targetPort: "content",
      }],
    },
    requirements: { skills: [], connections: [], materials: [] },
    embeddedMaterials: [],
  };
}

function mappedPortableLoop() {
  const value = structuredClone(portableLoopPackageExample);
  const content = value.embeddedMaterials[0].content;
  const contentHash = sha256(content);
  value.embeddedMaterials[0].byteLength = Buffer.byteLength(content);
  value.embeddedMaterials[0].contentHash = contentHash;
  value.requirements.materials[0].contentHash = contentHash;
  value.requirements.skills[0].contentHash = sha256("skill-research-brief@1.0.0");
  return value;
}

async function uploadLoop(origin, session, bytes, suffix) {
  const created = await mutation(origin, session, "/api/workbench/v1/uploads", {
    key: `loop-upload-create-${suffix}`,
    body: {
      filename: `${suffix}.loop.json`,
      sizeBytes: bytes.byteLength,
      mediaType: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
      assetKind: "loop",
      ingestMethod: "resumable",
    },
    expectedStatus: 201,
  });
  const uploadId = created.body.data.uploadId;
  await mutation(origin, session, `/api/workbench/v1/uploads/${uploadId}/chunks/0`, {
    method: "PUT",
    key: `loop-upload-chunk-${suffix}`,
    body: { contentBase64: bytes.toString("base64") },
  });
  await mutation(origin, session, `/api/workbench/v1/uploads/${uploadId}/complete`, {
    key: `loop-upload-complete-${suffix}`,
    body: {},
  });
  return uploadId;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function emptyMappings() {
  return { skillMappings: [], materialMappings: [], connectionMappings: [] };
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function bootstrap(origin, userId, workspaceId) {
  const response = await fetch(`${origin}/api/workbench/v1/workspace`, {
    headers: {
      "X-Workbench-Test-User": userId,
      "X-Workbench-Test-Workspace": workspaceId,
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrf: body.data.session.csrfToken,
  };
}

async function mutation(origin, session, path, {
  method = "POST",
  key,
  ifMatch,
  body,
  expectedStatus = 200,
}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Cookie: session.cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Workbench-CSRF": session.csrf,
      "Idempotency-Key": key,
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: body }),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  return { response, body: payload };
}
