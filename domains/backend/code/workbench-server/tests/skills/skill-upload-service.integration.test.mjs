import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSkillUploadService } from "../../src/skills/index.mjs";
import { createFilesystemObjectStore } from "../../src/storage/index.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DATABASE_NAME = process.env.MONGODB_DB ?? "looloomi_workbench_skill_upload_test";

if (!DATABASE_NAME.endsWith("_test")) throw new Error(`integration_database_must_end_in_test:${DATABASE_NAME}`);

const validSkill = `---
name: meeting-action-extractor
description: Extract explicit follow-up actions from supplied meeting notes.
compatibility: Local only
disable-model-invocation: true
---

# Meeting Action Extractor
`;
const runtimeManifest = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
})}\n`;

test("Skill upload service quarantines package bytes, persists validation, and permits promotion only after passing checks", { skip: !ENABLED, timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-skill-upload-"));
  const store = new ProductMongoStore({ uri: MONGODB_URI, dbName: DATABASE_NAME });
  await store.connect();
  await store.dropTestDatabase();
  await store.ensurePrivateWorkspace({ userId: "user-uploader", workspaceId: "workspace-uploader" });
  const objectStore = await createFilesystemObjectStore({ rootDir: root });
  let nextIdentifier = 0;
  const service = createSkillUploadService({
    store,
    objectStore,
    clock: () => "2026-07-10T12:00:00.000Z",
    idFactory: (kind) => `${kind}-upload-proof-${++nextIdentifier}`,
  });
  context.after(async () => {
    await store.dropTestDatabase();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const created = await service.createUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    idempotencyKey: "create-upload-valid",
    filename: "meeting-action-extractor.zip",
    sizeBytes: validSkill.length,
    mediaType: "application/zip",
  });
  assert.equal(created.state, "selecting");
  assert.deepEqual(await service.createUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    idempotencyKey: "create-upload-valid",
    filename: "meeting-action-extractor.zip",
    sizeBytes: validSkill.length,
    mediaType: "application/zip",
  }), created);

  const inspected = await service.inspectUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    uploadId: created.uploadId,
    idempotencyKey: "inspect-upload-valid",
    files: [{ path: "SKILL.md", content: validSkill }],
  });
  assert.equal(inspected.state, "ready_draft");
  assert.equal("objectId" in inspected, false);
  assert.equal("workspaceId" in inspected, false);
  assert.equal("requestedBy" in inspected, false);
  assert.equal("contentHash" in inspected.inspection, false);
  const internalUpload = await store.repositories.uploads.get(inspected.uploadId, { workspaceId: "workspace-uploader" });
  assert.ok(internalUpload.objectId);
  assert.equal((await objectStore.stat({ workspaceId: "workspace-uploader", objectId: internalUpload.objectId })).state, "quarantined");
  assert.match(internalUpload.inspection.contentHash, /^sha256:/);
  assert.equal(internalUpload.inspection.manifest.name, "meeting-action-extractor");

  const promoted = await service.promoteUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    uploadId: created.uploadId,
    idempotencyKey: "promote-upload-valid",
  });
  assert.equal(promoted.state, "promoted");
  assert.equal("objectId" in promoted, false);
  assert.equal((await objectStore.stat({ workspaceId: "workspace-uploader", objectId: internalUpload.objectId })).state, "promoted");

  const executable = await service.createUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    idempotencyKey: "create-upload-executable",
    filename: "meeting-action-extractor.skill",
    sizeBytes: validSkill.length + 64,
    mediaType: "application/vnd.looloomi.skill-package+json",
  });
  const reviewed = await service.inspectUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    uploadId: executable.uploadId,
    idempotencyKey: "inspect-upload-executable",
    files: [
      { path: "SKILL.md", content: validSkill },
      { path: "skill.runtime.json", content: runtimeManifest },
      { path: "scripts/main.py", content: "import json, sys\nprint(json.dumps(json.load(sys.stdin)))\n" },
    ],
  });
  assert.equal(reviewed.state, "needs_decision");
  assert.ok(reviewed.findings.some((finding) => finding.code === "executable_content_requires_isolation"));
  await assert.rejects(
    () => service.promoteUpload({
      workspaceId: "workspace-uploader",
      requestedBy: "user-uploader",
      uploadId: executable.uploadId,
      idempotencyKey: "promote-upload-executable-without-review",
    }),
    (failure) => failure?.code === "upload_review_acknowledgement_required",
  );
  const executablePromoted = await service.promoteUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    uploadId: executable.uploadId,
    idempotencyKey: "promote-upload-executable",
    permissionAcknowledged: true,
  });
  assert.equal(executablePromoted.state, "promoted");

  const blocked = await service.createUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    idempotencyKey: "create-upload-blocked",
    filename: "unsafe.zip",
    sizeBytes: 10,
    mediaType: "application/zip",
  });
  const failed = await service.inspectUpload({
    workspaceId: "workspace-uploader",
    requestedBy: "user-uploader",
    uploadId: blocked.uploadId,
    idempotencyKey: "inspect-upload-blocked",
    files: [{ path: "SKILL.md", content: `${validSkill}\nAPI_KEY=abcdefghijklmnopqrstuvwxyz012345` }],
  });
  assert.equal(failed.state, "failed");
  assert.ok(failed.findings.some((finding) => finding.code === "secret_detected"));
  await assert.rejects(
    () => service.promoteUpload({
      workspaceId: "workspace-uploader",
      requestedBy: "user-uploader",
      uploadId: blocked.uploadId,
      idempotencyKey: "promote-upload-blocked",
    }),
    (failure) => failure?.code === "upload_promotion_blocked",
  );
  await assert.rejects(
    () => service.getUpload({ workspaceId: "workspace-uploader", requestedBy: "user-other", uploadId: created.uploadId }),
    (failure) => failure?.code === "workspace_access_forbidden",
  );
});
