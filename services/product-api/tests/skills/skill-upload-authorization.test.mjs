import assert from "node:assert/strict";
import test from "node:test";

import { createSkillUploadService } from "../../src/skills/skill-upload-service.mjs";

function fixture() {
  const mutationCalls = [];
  const upload = {
    schemaVersion: "workbench-v1",
    uploadId: "upload-private-a",
    assetKind: "skill",
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    state: "selecting",
    objectId: "object-private-a",
    filename: "private.skill",
    sizeBytes: 4,
    mediaType: "application/vnd.looloomi.skill-package+json",
    ingestMethod: "resumable",
    transfer: {
      chunkSizeBytes: 4,
      totalChunks: 1,
      receivedChunks: [],
      receivedBytes: 0,
      complete: false,
    },
    findings: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
  const store = {
    async connect() {},
    async authorizeWorkspace({ userId, workspaceId }) {
      if (!["user-a", "user-b"].includes(userId) || !["workspace-a", "workspace-b"].includes(workspaceId)) {
        const failure = new Error("workspace_access_forbidden");
        failure.code = "workspace_access_forbidden";
        throw failure;
      }
    },
    async runIdempotentMutation(options, callback) {
      mutationCalls.push(structuredClone(options));
      return callback(null);
    },
    async runIdempotentExternalMutation(_options, callback) { return callback("upload-external"); },
    async withTransaction(callback) { return callback(null); },
    repositories: {
      uploads: {
        async get(uploadId, { workspaceId } = {}) {
          return uploadId === upload.uploadId && workspaceId === upload.workspaceId
            ? structuredClone(upload)
            : null;
        },
        async insert(value) { return structuredClone(value); },
        async patch() { throw new Error("unexpected_upload_patch"); },
      },
      objects: {
        async get() { throw new Error("unexpected_object_repository_read"); },
        async insert() { throw new Error("unexpected_object_repository_write"); },
      },
    },
  };
  const objectCalls = [];
  const objectStore = {};
  for (const method of [
    "put", "promote", "stat", "read", "writeUploadChunk", "assembleUpload", "cleanupUpload",
  ]) {
    objectStore[method] = async (input) => {
      objectCalls.push({ method, input });
      throw new Error(`unexpected_object_store_${method}`);
    };
  }
  return {
    mutationCalls,
    objectCalls,
    service: createSkillUploadService({ store, objectStore }),
  };
}

test("upload mutations namespace idempotency by the effective principal", async () => {
  const { service, mutationCalls } = fixture();
  await service.createUpload({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    idempotencyKey: "create-owned-upload",
    filename: "owned.skill",
    sizeBytes: 4,
    mediaType: "application/vnd.looloomi.skill-package+json",
  });
  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].effectivePrincipalId, "user-a");
  assert.equal(mutationCalls[0].request.requestedBy, "user-a");
});

test("a workspace member cannot consume another member's private upload", async () => {
  const { service, objectCalls } = fixture();
  const base = {
    workspaceId: "workspace-a",
    requestedBy: "user-b",
    uploadId: "upload-private-a",
  };
  const attempts = [
    () => service.getUpload(base),
    () => service.uploadChunk({
      ...base,
      idempotencyKey: "chunk-b",
      chunkIndex: 0,
      content: Buffer.from("test"),
    }),
    () => service.completeUpload({ ...base, idempotencyKey: "complete-b" }),
    () => service.inspectUpload({
      ...base,
      idempotencyKey: "inspect-b",
      files: [{ path: "SKILL.md", content: "private" }],
    }),
    () => service.promoteUpload({ ...base, idempotencyKey: "promote-b" }),
    () => service.resolvePromotedPackage(base),
    () => service.resolvePortableLoopUpload(base),
  ];

  for (const attempt of attempts) {
    await assert.rejects(attempt, {
      code: "upload_not_found",
      message: "The upload was not found.",
    });
  }
  assert.deepEqual(objectCalls, [], "ownership must be rejected before any ObjectStore access");
});

test("an upload address from another workspace is rejected before ObjectStore access", async () => {
  const { service, objectCalls } = fixture();
  await assert.rejects(
    service.getUpload({
      workspaceId: "workspace-b",
      requestedBy: "user-b",
      uploadId: "upload-private-a",
    }),
    { code: "upload_not_found" },
  );
  assert.deepEqual(objectCalls, []);
});
