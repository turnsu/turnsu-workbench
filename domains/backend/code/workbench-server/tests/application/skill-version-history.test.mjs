import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const summary = {
  skillVersionId: "version-2",
  skillId: "skill-a",
  version: "2.0.0",
  name: "Meeting actions",
  description: "Find meeting actions.",
  category: "meetings",
  validation: { status: "passed", testedAt: "2026-07-13T10:00:00.000Z" },
      publishedAt: "2026-07-13T10:01:00.000Z",
};

function createStore({ visible = true } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {},
    repositories: {
      skillAssets: {
        async get(skillId, options) {
          calls.push({ kind: "access", skillId, options });
          return visible ? { skillId, workspaceId: options.workspaceId } : null;
        },
      },
    },
    async listSkillVersions(options) {
      calls.push({ kind: "list", options });
      return [structuredClone(summary)];
    },
    async getSkillVersionDiff(options) {
      calls.push({ kind: "diff", options });
      return {
        skillId: options.skillId,
        fromVersionId: options.fromVersionId,
        fromVersion: "1.0.0",
        toVersionId: options.toVersionId,
        toVersion: "2.0.0",
        entries: [],
      };
    },
  };
}

test("application verifies workspace Skill access before returning version history", async () => {
  const store = createStore();
  const application = createWorkbenchApplication({ store });

  const result = await application.listSkillVersions({
    skillId: "skill-a",
    query: { limit: 10 },
    auth: { userId: "user-a", activeWorkspaceId: "workspace-a" },
  });

  assert.deepEqual(result.data, [summary]);
  assert.deepEqual(result.page, { nextCursor: null, hasMore: false });
  assert.deepEqual(store.calls, [
    {
      kind: "access",
      skillId: "skill-a",
      options: { workspaceId: "workspace-a" },
    },
    {
      kind: "list",
      options: { skillId: "skill-a", workspaceId: "workspace-a", limit: 10 },
    },
  ]);
});

test("application returns skill_not_found before querying another workspace history", async () => {
  const store = createStore({ visible: false });
  const application = createWorkbenchApplication({ store });

  await assert.rejects(
    () => application.listSkillVersions({
      skillId: "skill-a",
      auth: { userId: "user-b", activeWorkspaceId: "workspace-b" },
    }),
    (error) => error?.code === "skill_not_found",
  );
  assert.equal(store.calls.some((call) => call.kind === "list"), false);
});

test("application verifies workspace Skill access before comparing versions", async () => {
  const store = createStore();
  const application = createWorkbenchApplication({ store });

  const result = await application.getSkillVersionDiff({
    skillId: "skill-a",
    fromVersionId: "version-1",
    toVersionId: "version-2",
    auth: { userId: "user-a", activeWorkspaceId: "workspace-a" },
  });

  assert.equal(result.skillId, "skill-a");
  assert.deepEqual(store.calls, [
    {
      kind: "access",
      skillId: "skill-a",
      options: { workspaceId: "workspace-a" },
    },
    {
      kind: "diff",
      options: {
        skillId: "skill-a",
        fromVersionId: "version-1",
        toVersionId: "version-2",
        workspaceId: "workspace-a",
      },
    },
  ]);
});

test("application hides version comparison before querying another workspace versions", async () => {
  const store = createStore({ visible: false });
  const application = createWorkbenchApplication({ store });

  await assert.rejects(
    () => application.getSkillVersionDiff({
      skillId: "skill-a",
      fromVersionId: "version-1",
      toVersionId: "version-2",
      auth: { userId: "user-b", activeWorkspaceId: "workspace-b" },
    }),
    (error) => error?.code === "skill_not_found",
  );
  assert.equal(store.calls.some((call) => call.kind === "diff"), false);
});
