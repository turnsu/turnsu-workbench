import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

test("Team Library update impact omits private Loop identities the reader cannot access", async () => {
  const workflows = new Map([
    ["loop-visible", {
      workflowId: "loop-visible",
      workspaceId: "workspace-a",
      ownerId: "user-b",
      visibility: "private",
    }],
    ["loop-hidden", {
      workflowId: "loop-hidden",
      workspaceId: "workspace-a",
      ownerId: "user-a",
      visibility: "private",
    }],
  ]);
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async getInstallationUpdateImpact() {
      return {
        schemaVersion: "workbench-v1",
        installationId: "installation-a",
        fromReleaseId: "release-1",
        toReleaseId: "release-2",
        fromVersionId: "version-1",
        toVersionId: "version-2",
        dependencyChanges: [],
        connectionChanges: [],
        breakingFields: [],
        affectedObjects: [
          { objectKind: "loop", objectId: "loop-visible", label: "Visible Loop" },
          { objectKind: "loop", objectId: "loop-hidden", label: "Hidden Loop" },
        ],
        computedAt: "2026-08-04T12:00:00.000Z",
      };
    },
    async getWorkflow(workflowId) {
      const workflow = workflows.get(workflowId);
      return workflow ? { workflow: structuredClone(workflow), etag: '"workflow"' } : null;
    },
  };
  const application = createWorkbenchApplication({ store });

  const impact = await application.getInstallationUpdateImpact({
    installationId: "installation-a",
    query: { releaseId: "release-2" },
    auth: { userId: "user-b", activeWorkspaceId: "workspace-a" },
  });

  assert.deepEqual(impact.affectedObjects, [
    { objectKind: "loop", objectId: "loop-visible", label: "Visible Loop" },
  ]);
  assert.equal(JSON.stringify(impact).includes("Hidden Loop"), false);
});
