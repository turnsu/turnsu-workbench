import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  createObjectStoreBackup,
  restoreObjectStoreBackup,
  snapshotObjectStore,
} from "../../../../operations/local/object-store-backup.mjs";

test("object store backup encrypts all files and verifies restored Artifact hashes", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-object-backup-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `${root}/source`;
  const workspace = `${source}/workspace-1`;
  await mkdir(workspace, { recursive: true });
  const bytes = Buffer.from("artifact-image-bytes");
  const contentHash = hash(bytes);
  await writeFile(`${workspace}/object-1.bin`, bytes);
  await writeFile(`${workspace}/object-1.json`, `${JSON.stringify({
    storeFormat: "workbench-object-store-v1",
    objectId: "object-1",
    workspaceId: "workspace-1",
    contentHash,
    sizeBytes: bytes.length,
    mediaType: "image/png",
    metadata: { source: "product-artifact", artifactId: "artifact-1" },
    state: "promoted",
  })}\n`);

  const key = randomBytes(32);
  const archive = `${root}/objects.lbkp`;
  const created = await createObjectStoreBackup({ root: source, destination: archive, key });
  assert.equal(created.artifactsVerified, 1);
  assert.equal(created.files.length, 2);
  assert.equal((await readFile(archive)).includes(bytes), false);

  const restored = await restoreObjectStoreBackup({
    source: archive,
    destinationRoot: `${root}/restored`,
    key,
    expectedFiles: created.files,
  });
  assert.deepEqual(restored, { verified: true, files: 2, artifactsVerified: 1 });
  assert.deepEqual(await snapshotObjectStore(`${root}/restored`), {
    entries: created.files,
    artifactsVerified: 1,
  });
});

test("object store snapshot rejects metadata whose content hash does not match bytes", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-object-hash-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/workspace-1`);
  await writeFile(`${root}/workspace-1/object-1.bin`, "tampered");
  await writeFile(`${root}/workspace-1/object-1.json`, `${JSON.stringify({
    storeFormat: "workbench-object-store-v1",
    contentHash: `sha256:${"0".repeat(64)}`,
    sizeBytes: 8,
    metadata: { source: "product-artifact", artifactId: "artifact-1" },
  })}\n`);
  await assert.rejects(snapshotObjectStore(root), { code: "object_store_artifact_hash_mismatch" });
});

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
