import assert from "node:assert/strict";
import test from "node:test";

import { createSkillUploadService } from "../../src/skills/index.mjs";
import {
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
} from "../../src/skills/skill-package-format.mjs";

const runtimeManifest = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
})}\n`;
const files = [
  {
    path: "SKILL.md",
    content: "---\nname: meeting-actions\ndescription: Finds meeting actions.\n---\n\n# Instructions\n",
  },
  { path: "skill.runtime.json", content: runtimeManifest },
  { path: "scripts/main.py", content: "print({\"actions\": []})\n" },
];
const packageBytes = formatSkillPackage(files);
const contentHash = hashSkillPackageObject(packageBytes);
const objectId = objectIdForSkillPackage(contentHash);

function fixture({ uploadState = "promoted", currentDraftId = "draft-a", bytes = packageBytes } = {}) {
  const calls = [];
  const storedContentHash = hashSkillPackageObject(bytes);
  const storedObjectId = objectIdForSkillPackage(storedContentHash);
  const draft = {
    skillDraftId: "draft-a",
    skillId: "skill-a",
    revision: 3,
    files: [{ objectId: storedObjectId, contentHash: storedContentHash }],
  };
  const store = {
    calls,
    async connect() {},
    async runIdempotentMutation(_options, mutation) { return mutation({}); },
    async withTransaction(mutation) { return mutation({}); },
    async authorizeWorkspace(input) { calls.push({ kind: "authorize", input }); },
    async getSkillDraft(input) {
      calls.push({ kind: "draft", input });
      return { skill: { skillId: "skill-a", currentDraftId }, draft };
    },
    repositories: {
      uploads: {
        async get(uploadId, options) {
          calls.push({ kind: "upload", uploadId, options });
          return {
            uploadId,
            workspaceId: options.workspaceId,
            state: uploadState,
            objectId: storedObjectId,
          };
        },
      },
    },
  };
  const objectStore = {
    async put() {},
    async promote() {},
    async stat() {},
    async read(input) {
      calls.push({ kind: "object", input });
      return {
        object: {
          objectId: storedObjectId,
          workspaceId: input.workspaceId,
          contentHash: storedContentHash,
          sizeBytes: bytes.byteLength,
          mediaType: SKILL_PACKAGE_MEDIA_TYPE,
          state: "promoted",
        },
        bytes,
      };
    },
  };
  return { calls, service: createSkillUploadService({ store, objectStore }) };
}

test("Skill upload service reads the exact promoted draft package as bounded product text", async () => {
  const { calls, service } = fixture();
  const value = await service.getDraftPackage({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    skillId: "skill-a",
    draftId: "draft-a",
  });

  assert.deepEqual(value, {
    skillId: "skill-a",
    skillDraftId: "draft-a",
    revision: 3,
    files: [
      {
        path: "SKILL.md",
        kind: "instructions",
        sizeBytes: Buffer.byteLength(files[0].content),
        content: files[0].content,
      },
      {
        path: "scripts/main.py",
        kind: "executable",
        sizeBytes: Buffer.byteLength(files[2].content),
        content: files[2].content,
      },
      {
        path: "skill.runtime.json",
        kind: "runtime_manifest",
        sizeBytes: Buffer.byteLength(files[1].content),
        content: files[1].content,
      },
    ],
  });
  assert.deepEqual(calls[0], {
    kind: "authorize",
    input: { userId: "user-a", workspaceId: "workspace-a", minimumRole: "viewer" },
  });
  assert.equal(JSON.stringify(value).includes("objectId"), false);
  assert.equal(JSON.stringify(value).includes("contentHash"), false);
});

test("Skill package replacement resolution accepts only a promoted workspace-scoped upload", async () => {
  const promoted = fixture();
  const value = await promoted.service.resolvePromotedPackage({
    workspaceId: "workspace-a",
    requestedBy: "user-a",
    uploadId: "upload-a",
  });
  assert.deepEqual(value, {
    uploadId: "upload-a",
    objectId,
    contentHash,
    mediaType: SKILL_PACKAGE_MEDIA_TYPE,
    sizeBytes: packageBytes.byteLength,
  });
  assert.equal(promoted.calls.find((call) => call.kind === "upload").options.workspaceId, "workspace-a");

  const pending = fixture({ uploadState: "ready_draft" });
  await assert.rejects(
    () => pending.service.resolvePromotedPackage({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      uploadId: "upload-a",
    }),
    (error) => error?.code === "skill_package_not_promoted",
  );
});

test("Skill package reads reject stale drafts and non-UTF-8 executable content", async () => {
  const stale = fixture({ currentDraftId: "draft-new" });
  await assert.rejects(
    () => stale.service.getDraftPackage({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      skillId: "skill-a",
      draftId: "draft-a",
    }),
    (error) => error?.code === "skill_draft_stale",
  );

  const invalidBytes = formatSkillPackage([
    files[0],
    files[1],
    { path: "scripts/main.py", content: Buffer.from([0xff, 0xfe]) },
  ]);
  const invalid = fixture({ bytes: invalidBytes });
  await assert.rejects(
    () => invalid.service.getDraftPackage({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      skillId: "skill-a",
      draftId: "draft-a",
    }),
    (error) => error?.code === "skill_package_unavailable",
  );
});
