import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const draft = {
  skillDraftId: "draft-a",
  skillId: "skill-a",
  revision: 5,
};

function fixture({ resolveFailure = null } = {}) {
  const calls = [];
  const store = {
    async connect() {},
    async authorizeWorkspace(input) { calls.push({ kind: "authorize", input }); },
    async replaceSkillDraftPackage(input) {
      calls.push({ kind: "replace", input });
      return { draft: structuredClone(draft) };
    },
  };
  const skillUploadService = {
    async getDraftPackage(input) {
      calls.push({ kind: "read", input });
      return {
        skillId: input.skillId,
        skillDraftId: input.draftId,
        revision: 4,
        files: [],
      };
    },
    async resolvePromotedPackage(input) {
      calls.push({ kind: "resolve", input });
      if (resolveFailure) throw resolveFailure;
      return {
        uploadId: input.uploadId,
        objectId: "object-a",
        contentHash: "sha256:0123456789abcdef",
        mediaType: "application/vnd.looloomi.skill-package+json",
        sizeBytes: 512,
      };
    },
  };
  return {
    calls,
    application: createWorkbenchApplication({ store, skillUploadService }),
  };
}

test("application returns package text with the draft ETag and no storage projection", async () => {
  const { application, calls } = fixture();
  const result = await application.getSkillDraftPackage({
    skillId: "skill-a",
    draftId: "draft-a",
    auth: { userId: "user-a", activeWorkspaceId: "workspace-a" },
  });
  assert.equal(result.etag, '"skd1:draft-a:4"');
  assert.deepEqual(result.data, {
    skillId: "skill-a",
    skillDraftId: "draft-a",
    revision: 4,
    files: [],
  });
  assert.deepEqual(calls.map((call) => call.kind), ["authorize", "read"]);
  assert.equal(calls[1].input.workspaceId, "workspace-a");
});

test("application resolves a promoted upload before one revision-bound package replacement", async () => {
  const { application, calls } = fixture();
  const request = { schemaVersion: "workbench-api-v1", data: { uploadId: "upload-a" } };
  const result = await application.replaceSkillDraftPackage({
    skillId: "skill-a",
    draftId: "draft-a",
    idempotencyKey: "idem-a",
    ifMatch: '"skd1:draft-a:4"',
    request,
    auth: { userId: "user-a", activeWorkspaceId: "workspace-a" },
  });
  assert.equal(result.etag, '"skd1:draft-a:5"');
  assert.deepEqual(calls.map((call) => call.kind), ["authorize", "resolve", "replace"]);
  assert.equal(calls[1].input.uploadId, "upload-a");
  assert.equal(calls[2].input.workspaceId, "workspace-a");
  assert.equal(calls[2].input.authoredBy, "user-a");
  assert.equal(calls[2].input.replacement.objectId, "object-a");
  assert.deepEqual(calls[2].input.request, request);
});

test("application never mutates a draft when promoted upload resolution fails", async () => {
  const failure = Object.assign(new Error("not promoted"), { code: "skill_package_not_promoted" });
  const { application, calls } = fixture({ resolveFailure: failure });
  await assert.rejects(
    () => application.replaceSkillDraftPackage({
      skillId: "skill-a",
      draftId: "draft-a",
      idempotencyKey: "idem-a",
      ifMatch: '"skd1:draft-a:4"',
      request: { data: { uploadId: "upload-a" } },
      auth: { userId: "user-a", activeWorkspaceId: "workspace-a" },
    }),
    (error) => error?.code === "skill_package_not_promoted",
  );
  assert.equal(calls.some((call) => call.kind === "replace"), false);
});
