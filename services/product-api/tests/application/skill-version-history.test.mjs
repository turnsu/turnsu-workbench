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

function createStore({
  visible = true,
  visibility = "private",
  ownerId = "user-a",
  grants = null,
  affectedWorkflows = [],
  workflows = new Map(),
} = {}) {
  const calls = [];
  const store = {
    calls,
    async connect() {},
    repositories: {
      skillAssets: {
        async get(skillId, options) {
          calls.push({ kind: "access", skillId, options });
          return visible ? { skillId, workspaceId: options.workspaceId, visibility, ownerId } : null;
        },
      },
    },
    async getSkillUsageImpact(options) {
      calls.push({ kind: "usage", options });
      return {
        skillId: options.skillId,
        latestVersionId: null,
        latestVersion: null,
        affectedWorkflows: structuredClone(affectedWorkflows),
      };
    },
    async getWorkflow(workflowId, options) {
      calls.push({ kind: "workflow", workflowId, options });
      const workflow = workflows.get(workflowId);
      if (!workflow) {
        const error = new Error("Workflow not found.");
        error.code = "workflow_not_found";
        throw error;
      }
      return { workflow: structuredClone(workflow), etag: '"workflow"' };
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
    async publishSkill(options) {
      calls.push({ kind: "publish", options });
      throw new Error("publish_must_not_be_called");
    },
    async deprecateSkill(options) {
      calls.push({ kind: "deprecate", options });
      throw new Error("deprecate_must_not_be_called");
    },
    async createNextSkillDraft(options) {
      calls.push({ kind: "create-next-draft", options });
      throw new Error("create_next_draft_must_not_be_called");
    },
  };
  if (grants) {
    store.listActiveObjectAccessGrants = async (options) => {
      calls.push({ kind: "grants", options });
      return structuredClone(grants);
    };
  }
  return store;
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
      options: { skillId: "skill-a", workspaceId: "workspace-a", requestedBy: "user-a", limit: 10 },
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
        requestedBy: "user-a",
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

test("private Skill publish, usage, versions, and diff reject a different workspace collaborator", async () => {
  const store = createStore({ ownerId: "user-a", visibility: "private" });
  const application = createWorkbenchApplication({ store });
  const auth = { userId: "user-b", activeWorkspaceId: "workspace-a" };

  await assert.rejects(
    () => application.publishSkill({
      skillId: "skill-a",
      idempotencyKey: "publish-private-as-b",
      ifMatch: '"draft-1"',
      request: { data: { version: "1.0.0", releaseNotes: "" } },
      auth,
    }),
    { code: "skill_not_found" },
  );
  for (const operation of [
    application.getSkillUsage({ skillId: "skill-a", auth }),
    application.listSkillVersions({ skillId: "skill-a", auth }),
    application.getSkillVersionDiff({
      skillId: "skill-a",
      fromVersionId: "version-1",
      toVersionId: "version-2",
      auth,
    }),
  ]) {
    await assert.rejects(operation, { code: "skill_not_found" });
  }
  assert.equal(store.calls.some((call) => ["publish", "usage", "list", "diff"].includes(call.kind)), false);
});

test("workspace-visible published Skill history and usage preserve collaborator read access", async () => {
  const store = createStore({ ownerId: "user-a", visibility: "workspace" });
  const application = createWorkbenchApplication({ store });
  const auth = { userId: "user-b", activeWorkspaceId: "workspace-a" };

  const [usage, versions, diff] = await Promise.all([
    application.getSkillUsage({ skillId: "skill-a", auth }),
    application.listSkillVersions({ skillId: "skill-a", auth }),
    application.getSkillVersionDiff({
      skillId: "skill-a",
      fromVersionId: "version-1",
      toVersionId: "version-2",
      auth,
    }),
  ]);

  assert.equal(usage.skillId, "skill-a");
  assert.equal(versions.data.length, 1);
  assert.equal(diff.skillId, "skill-a");
});

test("explicit Skill grants expose governed history but never another principal's personal Draft", async () => {
  const store = createStore({
    ownerId: "user-a",
    visibility: "private",
    grants: [{
      grantId: "grant-b",
      principalId: "user-b",
      role: "maintainer",
      capabilities: ["object.publish"],
    }],
  });
  const application = createWorkbenchApplication({ store });
  const auth = {
    userId: "user-b",
    activeWorkspaceId: "workspace-a",
    role: "member",
    capabilities: [],
  };

  const versions = await application.listSkillVersions({ skillId: "skill-a", auth });
  assert.equal(versions.data.length, 1);
  await assert.rejects(
    () => application.publishSkill({
      skillId: "skill-a",
      idempotencyKey: "publish-private-as-b",
      ifMatch: '"draft-1"',
      request: { data: { version: "1.0.0", releaseNotes: "" } },
      auth,
    }),
    { code: "skill_not_found" },
  );
  await assert.rejects(
    () => application.deprecateSkill({
      skillId: "skill-a",
      idempotencyKey: "retire-private-as-b",
      request: { data: { reason: "obsolete" } },
      auth,
    }),
    { code: "skill_not_found" },
  );
  assert.equal(store.calls.some((call) => call.kind === "publish"), false);
  assert.equal(store.calls.some((call) => call.kind === "deprecate"), false);
});

test("a Skill editor grant does not make another principal's personal Draft mutable", async () => {
  const store = createStore({
    ownerId: "user-a",
    visibility: "private",
    grants: [{
      grantId: "grant-editor",
      principalId: "user-b",
      role: "editor",
      capabilities: [],
    }],
  });
  const application = createWorkbenchApplication({ store });

  await assert.rejects(
    () => application.createNextSkillDraft({
      skillId: "skill-a",
      idempotencyKey: "foreign-personal-draft",
      ifMatch: '"skd1:draft-a:1"',
      request: { data: { baseVersionId: "version-1" } },
      auth: { userId: "user-b", activeWorkspaceId: "workspace-a" },
    }),
    (error) => error?.code === "skill_not_found",
  );
  assert.equal(store.calls.some((call) => call.kind === "create-next-draft"), false);
});

test("Skill discovery consumes active object grants without exposing another principal's Draft", async () => {
  let grantActive = true;
  const skill = {
    schemaVersion: "workbench-v1",
    skillId: "skill-private",
    workspaceId: "workspace-a",
    ownerId: "user-a",
    visibility: "private",
    lifecycle: "published",
    currentDraftId: "draft-private",
    latestPublishedVersionId: "version-private",
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:01:00.000Z",
  };
  const store = {
    async connect() {},
    async listActiveObjectAccessGrants() {
      return grantActive
        ? [{ grantId: "grant-view", principalId: "user-b", role: "viewer", capabilities: [] }]
        : [];
    },
    repositories: {
      skillAssets: { async list() { return [structuredClone(skill)]; } },
      skillDrafts: {
        async list() {
          return [{ skillDraftId: "draft-private", skillId: skill.skillId, revision: 1 }];
        },
      },
      skillVersions: {
        async list() {
          return [{
            skillVersionId: "version-private",
            skillId: skill.skillId,
            version: "1.0.0",
            name: "Private Skill",
            description: "Shared through an explicit grant.",
            category: "test",
            validation: { status: "passed", testedAt: null },
            publishedAt: "2026-07-13T10:01:00.000Z",
          }];
        },
      },
    },
  };
  const application = createWorkbenchApplication({ store });
  const auth = { userId: "user-b", activeWorkspaceId: "workspace-a", role: "member" };

  const visible = await application.listSkillAssets({ auth });
  assert.equal(visible.data.length, 1);
  assert.equal(visible.data[0].skill.skillId, skill.skillId);
  assert.deepEqual(visible.data[0].skill.allowedActions, []);
  assert.equal(visible.data[0].draft, null);
  assert.equal(visible.data[0].latestVersion.skillVersionId, "version-private");

  grantActive = false;
  const revoked = await application.listSkillAssets({ auth });
  assert.deepEqual(revoked.data, []);
});

test("Skill lifecycle exposes only actions valid for the current owner state", async () => {
  const expectations = new Map([
    ["draft", ["edit"]],
    ["validating", []],
    ["tested", ["edit", "publish"]],
    ["published", ["create_version", "retire"]],
    ["deprecated", []],
    ["archived", []],
  ]);
  for (const [lifecycle, allowedActions] of expectations) {
    const store = {
      async connect() {},
      repositories: {
        skillAssets: {
          async list() {
            return [{
              schemaVersion: "workbench-v1",
              skillId: `skill-${lifecycle}`,
              workspaceId: "workspace-a",
              ownerId: "user-a",
              visibility: "private",
              lifecycle,
              currentDraftId: null,
              latestPublishedVersionId: lifecycle === "published" ? "version-a" : null,
              createdAt: "2026-07-13T10:00:00.000Z",
              updatedAt: "2026-07-13T10:01:00.000Z",
            }];
          },
        },
        skillDrafts: { async list() { return []; } },
        skillVersions: { async list() { return []; } },
      },
    };
    const application = createWorkbenchApplication({ store });
    const result = await application.listSkillAssets({
      auth: { userId: "user-a", activeWorkspaceId: "workspace-a" },
    });
    assert.deepEqual(result.data[0].skill.allowedActions, allowedActions, lifecycle);
  }
});

test("Skill usage omits private Workflow identities the reader cannot access", async () => {
  const workflows = new Map([
    ["workflow-visible", {
      workflowId: "workflow-visible",
      workspaceId: "workspace-a",
      ownerId: "user-b",
      visibility: "private",
    }],
    ["workflow-hidden", {
      workflowId: "workflow-hidden",
      workspaceId: "workspace-a",
      ownerId: "user-a",
      visibility: "private",
    }],
  ]);
  const store = createStore({
    ownerId: "user-a",
    visibility: "workspace",
    workflows,
    affectedWorkflows: [
      { workflowId: "workflow-visible", name: "Visible", state: "draft" },
      { workflowId: "workflow-hidden", name: "Hidden secret", state: "draft" },
    ],
  });
  const application = createWorkbenchApplication({ store });

  const impact = await application.getSkillUsage({
    skillId: "skill-a",
    auth: { userId: "user-b", activeWorkspaceId: "workspace-a" },
  });
  assert.deepEqual(impact.affectedWorkflows, [
    { workflowId: "workflow-visible", name: "Visible", state: "draft" },
  ]);
  assert.equal(JSON.stringify(impact).includes("Hidden secret"), false);
});
