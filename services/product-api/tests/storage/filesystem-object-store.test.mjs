import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFilesystemObjectStore,
  ObjectStoreError,
} from "../../src/storage/index.mjs";

async function testStore(t) {
  const root = await mkdtemp(join(tmpdir(), "looloomi-object-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 1024 });
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("filesystem object store keeps immutable bytes isolated by workspace", async (t) => {
  const store = await testStore(t);
  const bytes = Buffer.from("meeting notes");
  const first = await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-notes-1",
    bytes,
    contentHash: hash(bytes),
    mediaType: "text/plain",
    metadata: { filename: "notes.txt" },
  });

  assert.equal(first.existed, false);
  assert.equal(first.state, "quarantined");
  assert.equal(first.contentHash, hash(bytes));
  assert.equal("path" in first, false);

  const duplicate = await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-notes-1",
    bytes,
    contentHash: hash(bytes),
    mediaType: "text/plain",
    metadata: { filename: "notes.txt" },
  });
  assert.equal(duplicate.existed, true);

  const read = await store.read({ workspaceId: "workspace-alpha", objectId: "object-notes-1" });
  assert.deepEqual(read.bytes, bytes);

  await assert.rejects(
    store.read({ workspaceId: "workspace-beta", objectId: "object-notes-1" }),
    (error) => error instanceof ObjectStoreError && error.code === "object_not_found",
  );

  assert.deepEqual(
    (await store.list({ workspaceId: "workspace-alpha" })).map((entry) => entry.objectId),
    ["object-notes-1"],
  );
});

test("filesystem object store rejects replacement, traversal, invalid hashes, and oversized input", async (t) => {
  const store = await testStore(t);
  const first = Buffer.from("first");
  await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-safe-1",
    bytes: first,
    contentHash: hash(first),
    mediaType: "text/plain",
  });

  await assert.rejects(
    store.put({
      workspaceId: "workspace-alpha",
      objectId: "object-safe-1",
      bytes: Buffer.from("second"),
      mediaType: "text/plain",
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_id_conflict",
  );
  await assert.rejects(
    store.put({
      workspaceId: "../workspace-alpha",
      objectId: "object-safe-2",
      bytes: first,
      mediaType: "text/plain",
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_store_address_invalid",
  );
  await assert.rejects(
    store.put({
      workspaceId: "workspace-alpha",
      objectId: "../object-safe-2",
      bytes: first,
      mediaType: "text/plain",
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_store_address_invalid",
  );
  await assert.rejects(
    store.put({
      workspaceId: "workspace-alpha",
      objectId: "object-safe-2",
      bytes: first,
      contentHash: "sha256:0011223344556677",
      mediaType: "text/plain",
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_hash_mismatch",
  );
  await assert.rejects(
    store.put({
      workspaceId: "workspace-alpha",
      objectId: "object-large-1",
      bytes: Buffer.alloc(1025),
      mediaType: "application/octet-stream",
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_too_large",
  );
});

test("quarantine is explicit, promotion is irreversible here, and cancellation is observable", async (t) => {
  const store = await testStore(t);
  const bytes = Buffer.from("review this package");
  await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-package-1",
    bytes,
    mediaType: "application/zip",
  });
  assert.equal((await store.promote({ workspaceId: "workspace-alpha", objectId: "object-package-1" })).state, "promoted");
  await assert.rejects(
    store.deleteQuarantine({ workspaceId: "workspace-alpha", objectId: "object-package-1" }),
    (error) => error instanceof ObjectStoreError && error.code === "quarantine_delete_forbidden",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    store.put({
      workspaceId: "workspace-alpha",
      objectId: "object-cancelled-1",
      bytes,
      mediaType: "application/octet-stream",
      signal: controller.signal,
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_store_aborted",
  );

  await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-quarantine-1",
    bytes,
    mediaType: "application/octet-stream",
  });
  assert.deepEqual(
    await store.deleteQuarantine({ workspaceId: "workspace-alpha", objectId: "object-quarantine-1" }),
    { deleted: true },
  );
});

test("promoted objects can be explicitly deleted for governed retention cleanup", async (t) => {
  const store = await testStore(t);
  const bytes = Buffer.from("retained artifact bytes");
  await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-artifact-retention",
    bytes,
    mediaType: "image/png",
  });
  await store.promote({ workspaceId: "workspace-alpha", objectId: "object-artifact-retention" });

  assert.deepEqual(
    await store.deleteObject({
      workspaceId: "workspace-alpha",
      objectId: "object-artifact-retention",
      expectedState: "promoted",
    }),
    { deleted: true, state: "promoted" },
  );
  assert.deepEqual(
    await store.deleteObject({ workspaceId: "workspace-alpha", objectId: "object-artifact-retention" }),
    { deleted: false },
  );
  await assert.rejects(
    store.read({ workspaceId: "workspace-alpha", objectId: "object-artifact-retention" }),
    (error) => error instanceof ObjectStoreError && error.code === "object_not_found",
  );
});

test("normal object operations reject workspace directory symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-object-store-root-"));
  const outside = await mkdtemp(join(tmpdir(), "looloomi-object-store-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const store = await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 1024 });
  await symlink(outside, join(root, "workspace-alpha"), "dir");

  for (const operation of [
    () => store.stat({ workspaceId: "workspace-alpha", objectId: "object-secret" }),
    () => store.read({ workspaceId: "workspace-alpha", objectId: "object-secret" }),
    () => store.list({ workspaceId: "workspace-alpha" }),
    () => store.deleteObject({ workspaceId: "workspace-alpha", objectId: "object-secret" }),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error instanceof ObjectStoreError && error.code === "object_store_path_invalid",
    );
  }
});

test("reads and promotion reject symlinked object byte files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-object-store-bytes-root-"));
  const outside = await mkdtemp(join(tmpdir(), "looloomi-object-store-bytes-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const store = await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 1024 });
  await store.put({
    workspaceId: "workspace-alpha",
    objectId: "object-symlink-bytes",
    bytes: Buffer.from("owned bytes"),
    mediaType: "application/octet-stream",
  });
  const bytesPath = join(root, "workspace-alpha", "object-symlink-bytes.bin");
  const outsidePath = join(outside, "secret.bin");
  await writeFile(outsidePath, "outside secret");
  await rm(bytesPath);
  await symlink(outsidePath, bytesPath);

  for (const operation of [
    () => store.read({ workspaceId: "workspace-alpha", objectId: "object-symlink-bytes" }),
    () => store.promote({ workspaceId: "workspace-alpha", objectId: "object-symlink-bytes" }),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error instanceof ObjectStoreError && error.code === "object_integrity_failed",
    );
  }
});

test("resumable upload stages out-of-order chunks and assembles them in index order", async (t) => {
  const store = await testStore(t);
  const chunks = [Buffer.from("secure "), Buffer.from("upload "), Buffer.from("bytes")];
  const expectedSizeBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);

  const first = await store.writeUploadChunk({
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-1",
    chunkIndex: 1,
    totalChunks: 3,
    expectedSizeBytes,
    bytes: chunks[1],
  });
  assert.deepEqual(first.receivedChunkIndexes, [1]);
  assert.equal(first.receivedBytes, chunks[1].byteLength);
  assert.equal(first.complete, false);
  assert.equal(first.existed, false);
  assert.equal("contentHash" in first, false);
  assert.equal("path" in first, false);

  await store.writeUploadChunk({
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-1",
    chunkIndex: 2,
    totalChunks: 3,
    expectedSizeBytes,
    bytes: chunks[2],
  });
  const completed = await store.writeUploadChunk({
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-1",
    chunkIndex: 0,
    totalChunks: 3,
    expectedSizeBytes,
    bytes: chunks[0],
  });
  assert.deepEqual(completed.receivedChunkIndexes, [0, 1, 2]);
  assert.equal(completed.receivedBytes, expectedSizeBytes);
  assert.equal(completed.complete, true);

  const status = await store.getUploadStatus({
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-1",
  });
  assert.deepEqual(status.receivedChunkIndexes, [0, 1, 2]);
  assert.equal("contentHash" in status, false);
  assert.equal("path" in status, false);

  const assembled = await store.assembleUpload({
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-1",
  });
  assert.deepEqual(assembled.bytes, Buffer.concat(chunks));
  assert.deepEqual(assembled.upload, status);

  await assert.rejects(
    store.getUploadStatus({ workspaceId: "workspace-beta", uploadId: "upload-package-1" }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_not_found",
  );
});

test("resumable upload replay is idempotent and conflicting bytes or declarations fail", async (t) => {
  const store = await testStore(t);
  const declaration = {
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-2",
    chunkIndex: 0,
    totalChunks: 2,
    expectedSizeBytes: 6,
  };
  await store.writeUploadChunk({ ...declaration, bytes: Buffer.from("abc") });

  const replay = await store.writeUploadChunk({ ...declaration, bytes: Buffer.from("abc") });
  assert.equal(replay.existed, true);
  assert.deepEqual(replay.receivedChunkIndexes, [0]);
  assert.equal(replay.receivedBytes, 3);

  await assert.rejects(
    store.writeUploadChunk({ ...declaration, bytes: Buffer.from("abd") }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_chunk_conflict",
  );
  await assert.rejects(
    store.writeUploadChunk({ ...declaration, totalChunks: 3, bytes: Buffer.from("abc") }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_declaration_conflict",
  );
  await assert.rejects(
    store.writeUploadChunk({ ...declaration, expectedSizeBytes: 7, bytes: Buffer.from("abc") }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_declaration_conflict",
  );
});

test("resumable upload validates addresses, indexes, declarations, and byte bounds", async (t) => {
  const store = await testStore(t);
  const valid = {
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-3",
    chunkIndex: 0,
    totalChunks: 1,
    expectedSizeBytes: 3,
    bytes: Buffer.from("abc"),
  };

  for (const candidate of [
    { ...valid, workspaceId: "../workspace-alpha" },
    { ...valid, uploadId: "../upload-package-3" },
  ]) {
    await assert.rejects(
      store.writeUploadChunk(candidate),
      (error) => error instanceof ObjectStoreError && error.code === "object_store_address_invalid",
    );
  }
  for (const chunkIndex of [-1, 1, 1.5]) {
    await assert.rejects(
      store.writeUploadChunk({ ...valid, chunkIndex }),
      (error) => error instanceof ObjectStoreError && error.code === "upload_chunk_index_invalid",
    );
  }
  await assert.rejects(
    store.writeUploadChunk({ ...valid, totalChunks: 0 }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_declaration_invalid",
  );
  await assert.rejects(
    store.writeUploadChunk({ ...valid, expectedSizeBytes: 1025 }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_declaration_invalid",
  );
  await assert.rejects(
    store.writeUploadChunk({ ...valid, expectedSizeBytes: 1024, bytes: Buffer.alloc(1025) }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_chunk_too_large",
  );

  await store.writeUploadChunk({
    workspaceId: "workspace-alpha",
    uploadId: "upload-size-bound",
    chunkIndex: 0,
    totalChunks: 2,
    expectedSizeBytes: 5,
    bytes: Buffer.from("abc"),
  });
  await assert.rejects(
    store.writeUploadChunk({
      workspaceId: "workspace-alpha",
      uploadId: "upload-size-bound",
      chunkIndex: 1,
      totalChunks: 2,
      expectedSizeBytes: 5,
      bytes: Buffer.from("def"),
    }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_size_exceeded",
  );
  assert.deepEqual(
    (await store.getUploadStatus({
      workspaceId: "workspace-alpha",
      uploadId: "upload-size-bound",
    })).receivedChunkIndexes,
    [0],
  );
});

test("resumable upload requires every chunk and the exact declared total size", async (t) => {
  const store = await testStore(t);
  const shared = {
    workspaceId: "workspace-alpha",
    uploadId: "upload-package-4",
    totalChunks: 2,
    expectedSizeBytes: 6,
  };
  await store.writeUploadChunk({ ...shared, chunkIndex: 0, bytes: Buffer.from("abc") });
  await assert.rejects(
    store.assembleUpload(shared),
    (error) => error instanceof ObjectStoreError && error.code === "upload_incomplete",
  );

  const status = await store.writeUploadChunk({ ...shared, chunkIndex: 1, bytes: Buffer.from("de") });
  assert.deepEqual(status.receivedChunkIndexes, [0, 1]);
  assert.equal(status.complete, false);
  await assert.rejects(
    store.assembleUpload(shared),
    (error) => error instanceof ObjectStoreError && error.code === "upload_size_mismatch",
  );
});

test("resumable upload cleanup is scoped and idempotent", async (t) => {
  const store = await testStore(t);
  await store.writeUploadChunk({
    workspaceId: "workspace-alpha",
    uploadId: "upload-cleanup-1",
    chunkIndex: 0,
    totalChunks: 1,
    expectedSizeBytes: 3,
    bytes: Buffer.from("abc"),
  });

  assert.deepEqual(
    await store.cleanupUpload({ workspaceId: "workspace-alpha", uploadId: "upload-cleanup-1" }),
    { deleted: true },
  );
  assert.deepEqual(
    await store.cleanupUpload({ workspaceId: "workspace-alpha", uploadId: "upload-cleanup-1" }),
    { deleted: false },
  );
  await assert.rejects(
    store.getUploadStatus({ workspaceId: "workspace-alpha", uploadId: "upload-cleanup-1" }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_not_found",
  );
});

test("resumable upload rejects symlinks in staging directories and chunk files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-object-store-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "looloomi-object-store-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const store = await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 1024 });
  const stagingRoot = join(root, ".uploads");
  await symlink(outside, stagingRoot, "dir");

  await assert.rejects(
    store.writeUploadChunk({
      workspaceId: "workspace-alpha",
      uploadId: "upload-symlink-1",
      chunkIndex: 0,
      totalChunks: 1,
      expectedSizeBytes: 3,
      bytes: Buffer.from("abc"),
    }),
    (error) => error instanceof ObjectStoreError && error.code === "object_store_path_invalid",
  );

  await rm(stagingRoot);
  await store.writeUploadChunk({
    workspaceId: "workspace-alpha",
    uploadId: "upload-symlink-2",
    chunkIndex: 0,
    totalChunks: 2,
    expectedSizeBytes: 6,
    bytes: Buffer.from("abc"),
  });
  const outsideChunk = join(outside, "outside.part");
  await writeFile(outsideChunk, "def");
  await symlink(
    outsideChunk,
    join(stagingRoot, "workspace-alpha", "upload-symlink-2", "1.part"),
  );

  await assert.rejects(
    store.getUploadStatus({ workspaceId: "workspace-alpha", uploadId: "upload-symlink-2" }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_staging_invalid",
  );
  await assert.rejects(
    store.writeUploadChunk({
      workspaceId: "workspace-alpha",
      uploadId: "upload-symlink-2",
      chunkIndex: 1,
      totalChunks: 2,
      expectedSizeBytes: 6,
      bytes: Buffer.from("def"),
    }),
    (error) => error instanceof ObjectStoreError && error.code === "upload_staging_invalid",
  );
});
