import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { portableLoopPackageExample } from "../../../workbench-contracts/examples/canonical-examples.mjs";

import { formatPortableLoopPackage } from "../../src/loops/portable-loop-package.mjs";
import { formatSkillPackage } from "../../src/skills/skill-package-format.mjs";
import { createSkillUploadService } from "../../src/skills/skill-upload-service.mjs";
import { createFilesystemObjectStore } from "../../src/storage/index.mjs";

const SKILL = `---
name: resumable-proof
description: Prove resumable package upload.
disable-model-invocation: true
---
`;
const RUNTIME_MANIFEST = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
})}\n`;

function memoryStore() {
  const uploads = new Map();
  const objects = new Map();
  const mutations = new Map();
  return {
    lastExternalEffectivePrincipalId: null,
    async connect() {},
    async authorizeWorkspace({ userId, workspaceId }) {
      if (userId !== "user-a" || workspaceId !== "workspace-a") {
        const failure = new Error("forbidden");
        failure.code = "workspace_access_forbidden";
        throw failure;
      }
    },
    async withTransaction(callback) { return callback(null); },
    async runIdempotentMutation(options, callback) {
      const key = `${options.workspaceId}:${options.scope}:${options.key}`;
      if (mutations.has(key)) return structuredClone(mutations.get(key));
      const value = await callback(null);
      mutations.set(key, structuredClone(value));
      return value;
    },
    async runIdempotentExternalMutation(options, callback) {
      this.lastExternalEffectivePrincipalId = options.effectivePrincipalId;
      const key = `external:${options.workspaceId}:${options.effectivePrincipalId}:${options.scope}:${options.key}`;
      if (mutations.has(key)) return structuredClone(mutations.get(key));
      const operationId = `${options.operationIdKind}-external`;
      const recovered = await options.recover?.(operationId);
      const value = recovered ?? await callback(operationId);
      mutations.set(key, structuredClone(value));
      return value;
    },
    repositories: {
      uploads: {
        async insert(value) {
          uploads.set(value.uploadId, structuredClone(value));
          return structuredClone(value);
        },
        async get(uploadId, { workspaceId } = {}) {
          const value = uploads.get(uploadId);
          return value?.workspaceId === workspaceId ? structuredClone(value) : null;
        },
        async patch(uploadId, patch, { workspaceId } = {}) {
          const current = uploads.get(uploadId);
          if (!current || current.workspaceId !== workspaceId) return null;
          const next = { ...current, ...structuredClone(patch) };
          uploads.set(uploadId, next);
          return structuredClone(next);
        },
      },
      objects: {
        async get(objectId, { workspaceId } = {}) {
          const value = objects.get(objectId);
          return value?.workspaceId === workspaceId ? structuredClone(value) : null;
        },
        async insert(value) {
          objects.set(value.objectId, structuredClone(value));
          return structuredClone(value);
        },
      },
    },
    inspectUpload(uploadId) { return structuredClone(uploads.get(uploadId)); },
  };
}

async function fixture(t, { repositorySource = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "looloomi-upload-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = memoryStore();
  const objectStore = await createFilesystemObjectStore({ rootDir: root });
  let identifier = 0;
  return {
    store,
    objectStore,
    service: createSkillUploadService({
      store,
      objectStore,
      repositorySource,
      clock: () => "2026-07-14T10:00:00.000Z",
      idFactory: (kind) => `${kind}-unit-${++identifier}`,
    }),
  };
}

test("resumable Skill upload reports public progress, assembles canonical bytes, and cleans staging", async (t) => {
  const executable = `print('ok')\n# ${"x".repeat(540_000)}\n`;
  const packageBytes = formatSkillPackage([
    { path: "SKILL.md", content: SKILL },
    { path: "skill.runtime.json", content: RUNTIME_MANIFEST },
    { path: "scripts/main.py", content: executable },
  ]);
  const { service, store, objectStore } = await fixture(t);
  const upload = await service.createUpload({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    idempotencyKey: "create-resumable",
    filename: "resumable.skill",
    sizeBytes: packageBytes.byteLength,
    mediaType: "application/vnd.looloomi.skill-package+json",
    ingestMethod: "resumable",
  });
  assert.equal(upload.transfer.totalChunks, 2);
  assert.equal(upload.transfer.complete, false);
  assert.equal("workspaceId" in upload, false);
  assert.equal("objectId" in upload, false);

  const second = packageBytes.subarray(upload.transfer.chunkSizeBytes);
  const firstProgress = await service.uploadChunk({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: upload.uploadId,
    idempotencyKey: "chunk-1",
    chunkIndex: 1,
    content: second,
  });
  assert.deepEqual(firstProgress.transfer.receivedChunks, [1]);
  const first = packageBytes.subarray(0, upload.transfer.chunkSizeBytes);
  const completeProgress = await service.uploadChunk({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: upload.uploadId,
    idempotencyKey: "chunk-0",
    chunkIndex: 0,
    content: first,
  });
  assert.equal(completeProgress.transfer.complete, true);

  const inspected = await service.completeUpload({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: upload.uploadId,
    idempotencyKey: "complete-resumable",
  });
  assert.equal(inspected.state, "needs_decision");
  assert.equal(inspected.inspection.inventory.length, 3);
  assert.equal("contentHash" in inspected.inspection, false);
  assert.ok(store.inspectUpload(upload.uploadId).objectId);
  await assert.rejects(
    () => objectStore.getUploadStatus({ workspaceId: "workspace-a", uploadId: upload.uploadId }),
    (failure) => failure?.code === "upload_not_found",
  );
});

test("repository import is server-owned, idempotent, and returns only the public upload summary", async (t) => {
  const calls = [];
  const repositorySource = {
    async readSkillFiles(input) {
      calls.push(input);
      return {
        filename: "openai-example-main.skill",
        files: [{ path: "SKILL.md", content: SKILL }],
      };
    },
  };
  const { service, store } = await fixture(t, { repositorySource });
  const input = {
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    idempotencyKey: "import-repository",
    repositoryUrl: "https://github.com/openai/example",
    ref: "main",
    skillDirectory: "skills/proof",
  };
  const imported = await service.importRepository(input);
  const replayed = await service.importRepository(input);
  assert.deepEqual(replayed, imported);
  assert.equal(imported.ingestMethod, "repository");
  assert.equal(imported.transfer.complete, true);
  assert.equal("workspaceId" in imported, false);
  assert.equal("requestedBy" in imported, false);
  assert.equal("objectId" in imported, false);
  assert.equal("contentHash" in imported.inspection, false);
  assert.equal(calls.length, 1, "an idempotent replay must not re-read a mutable repository branch");
  assert.equal(store.lastExternalEffectivePrincipalId, "user-a");
});

test("resumable Loop upload stores only a contract-valid quarantined portable package", async (t) => {
  const packageBytes = formatPortableLoopPackage(portableLoopPackageExample);
  const { service, store, objectStore } = await fixture(t);
  const upload = await service.createUpload({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    idempotencyKey: "create-loop-upload",
    filename: "reviewed-brief.loop.json",
    sizeBytes: packageBytes.byteLength,
    mediaType: "application/vnd.looloomi.loop-package+json",
    assetKind: "loop",
    ingestMethod: "resumable",
  });
  assert.equal(upload.assetKind, "loop");
  assert.equal(upload.transfer.totalChunks, 1);

  await service.uploadChunk({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: upload.uploadId,
    idempotencyKey: "loop-chunk-0",
    chunkIndex: 0,
    content: packageBytes,
  });
  const completed = await service.completeUpload({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: upload.uploadId,
    idempotencyKey: "complete-loop-upload",
  });

  assert.equal(completed.state, "ready_draft");
  assert.equal(completed.assetKind, "loop");
  assert.equal(completed.transfer.complete, true);
  assert.equal("inspection" in completed, false);
  assert.equal("objectId" in completed, false);
  const internal = store.inspectUpload(upload.uploadId);
  assert.match(internal.objectId, /^object-[a-f0-9]{64}$/);
  const stored = await objectStore.read({ workspaceId: "workspace-a", objectId: internal.objectId });
  assert.equal(stored.object.state, "quarantined");
  assert.equal(stored.bytes.equals(packageBytes), true);
  const resolved = await service.resolvePortableLoopUpload({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: upload.uploadId,
  });
  assert.equal(resolved.contentHash, stored.object.contentHash);
  assert.deepEqual(resolved.portableLoop, portableLoopPackageExample);
  assert.equal("objectId" in resolved, false);
});
