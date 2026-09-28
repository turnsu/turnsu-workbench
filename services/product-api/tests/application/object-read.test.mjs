import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const object = {
  schemaVersion: "workbench-v1",
  objectId: "object-upload-1",
  workspaceId: "workspace-team",
  contentHash: `sha256:${"a".repeat(64)}`,
  sizeBytes: 42,
  mediaType: "application/zip",
  createdAt: "2026-07-24T00:00:00.000Z",
};

test("stored objects are read through the authenticated workspace boundary", async () => {
  const reads = [];
  const authorizations = [];
  const store = {
    async connect() {},
    async authorizeWorkspace(input) {
      authorizations.push(input);
      return { role: "owner" };
    },
    repositories: {
      objects: {
        async get(objectId, options) {
          reads.push({ objectId, options });
          return options.workspaceId === object.workspaceId ? object : null;
        },
      },
    },
  };
  const application = createWorkbenchApplication({ store });

  const loaded = await application.getObject({
    objectId: object.objectId,
    auth: { userId: "user-owner", activeWorkspaceId: "workspace-team" },
  });
  assert.deepEqual(loaded, object);
  assert.deepEqual(reads, [{
    objectId: object.objectId,
    options: { workspaceId: "workspace-team" },
  }]);
  assert.deepEqual(authorizations[0], {
    userId: "user-owner",
    workspaceId: "workspace-team",
    minimumRole: "viewer",
  });

  await assert.rejects(
    () => application.getObject({
      objectId: object.objectId,
      auth: { userId: "user-owner", activeWorkspaceId: "workspace-other" },
    }),
    { code: "object_not_found" },
  );
});
