import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresSkillReadModel } from "../../src/skills/postgres-skill-read-model.mjs";

function storeWith(steps) {
  const rest = [...steps];
  return {
    async connect() {},
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => { const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [] }; } }); },
    async withTransaction(work) { return work({}); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}
const row = {
  workspace_id: "workspace-alpha", skill_id: "skill-alpha", scope_id: "scope-alpha", owner_user_id: "alice",
  schema_version: "workbench-v1", visibility: "private", lifecycle: "draft", current_draft_id: "draft-alpha", latest_published_version_id: null,
  created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z", payload: { name: "Review notes" },
  skill_draft_id: "draft-alpha", draft_revision: 1, base_version_id: null, draft_content_hash: "sha256:abcdef0123456789", draft_updated_by: "alice",
  draft_created_at: "2026-08-10T00:00:00.000Z", draft_updated_at: "2026-08-10T00:00:00.000Z", draft_definition: { name: "Review notes", description: "Summarize notes" }, draft_payload: {},
  latest_skill_version_id: "version-alpha", latest_version: "1.0.0", latest_schema_version: "workbench-v1", latest_package_hash: "sha256:0123456789abcdef", latest_content_hash: "sha256:abcdef0123456789", latest_published_at: "2026-08-10T00:01:00.000Z", latest_definition: { name: "Review notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, validation: { status: "passed" } }, latest_payload: {},
};

test("PostgreSQL Skill read model returns the private Draft with its canonical asset", async () => {
  const store = storeWith([{ match: /FROM public\.skill_drafts/, values: ["workspace-alpha", "draft-alpha", "skill-alpha"], rows: [row] }]);
  const readModel = new PostgresSkillReadModel({ store });
  const result = await readModel.getSkillDraft({ workspaceId: "workspace-alpha", skillId: "skill-alpha", draftId: "draft-alpha" });
  assert.equal(result.skill.ownerId, "alice");
  assert.equal(result.draft.revision, 1);
  store.assertDrained();
});

test("Application lists Skill assets from the injected PostgreSQL read owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: { async listSkillAssets(input) { calls.push(input); return [{ skill: { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "draft", currentDraftId: "draft-alpha", latestPublishedVersionId: "version-alpha", schemaVersion: "workbench-v1", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" }, draft: { skillDraftId: "draft-alpha", skillId: "skill-alpha", revision: 1, schemaVersion: "workbench-v1" }, latestVersion: { skillVersionId: "version-alpha", skillId: "skill-alpha", version: "1.0.0", name: "Review notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, validation: { status: "passed" }, publishedAt: "2026-08-10T00:01:00.000Z" } }]; } },
  });
  const result = await application.listSkillAssets({ auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(result.data[0].skill.skillId, "skill-alpha");
  assert.equal(result.data[0].draft.skillDraftId, "draft-alpha");
  assert.equal(result.data[0].latestVersion.skillVersionId, "version-alpha");
  assert.deepEqual(calls, [{ workspaceId: "workspace-alpha", query: {} }]);
});

test("PostgreSQL Skill read model returns immutable version history and an adapter-owned safe diff", async () => {
  const first = {
    workspace_id: "workspace-alpha", skill_id: "skill-alpha", skill_version_id: "version-one", version: "1.0.0",
    schema_version: "workbench-v1", package_hash: "sha256:aaaaaaaaaaaaaaaa", content_hash: "sha256:bbbbbbbbbbbbbbbb",
    published_at: "2026-08-10T00:00:00.000Z", definition: {
      name: "Meeting Notes", description: "Summarize notes", inputSchema: { properties: { transcript: {} } },
      outputSchema: { properties: { summary: {} } }, risk: { level: "low", summary: "No external action." }, dependencies: [], connectionRequirements: [],
    }, payload: {}, validation_status: "passed", validation_completed_at: "2026-08-10T00:00:00.000Z",
    binding_capability_id: "capability-alpha", binding_task_intent: "execute", binding_adapter_version: "v1",
    binding_execution_mode: "deterministic", binding_executor_kind: "prompt_tool", binding_trust_tier: "uploaded_prompt",
    binding_runtime_id: null, binding_image_digest: null,
  };
  const second = {
    ...first, skill_version_id: "version-two", version: "2.0.0", package_hash: "sha256:cccccccccccccccc",
    published_at: "2026-08-10T00:01:00.000Z", definition: {
      ...first.definition, description: "Summarize notes and decisions", outputSchema: { properties: { summary: {}, decisions: {} } },
    },
  };
  const store = storeWith([
    { match: /FROM public\.skill_versions/, values: ["workspace-alpha", "skill-alpha", 20], rows: [second, first] },
    { match: /FROM public\.skill_versions/, values: ["workspace-alpha", "skill-alpha", ["version-one", "version-two"]], rows: [first, second] },
  ]);
  const readModel = new PostgresSkillReadModel({ store });
  const versions = await readModel.listSkillVersions({ workspaceId: "workspace-alpha", skillId: "skill-alpha", limit: 20 });
  const diff = await readModel.getSkillVersionDiff({ workspaceId: "workspace-alpha", skillId: "skill-alpha", fromVersionId: "version-one", toVersionId: "version-two" });
  assert.deepEqual(versions.map((version) => version.skillVersionId), ["version-two", "version-one"]);
  assert.equal(diff.entries.find((entry) => entry.kind === "purpose").changed, true);
  assert.equal(diff.entries.find((entry) => entry.kind === "creates").changed, true);
  assert.equal(diff.entries.find((entry) => entry.kind === "package").changed, true);
  assert.equal(versions[0].validation.status, "passed");
  assert.equal(versions[0].executionRef.capabilityId, "capability-alpha");
  store.assertDrained();
});

test("Application reads version history and comparison through the PostgreSQL read owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: {
      async getSkill() { return { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "published", latestPublishedVersionId: "version-two" }; },
      async listSkillVersions(input) { calls.push({ kind: "list", input }); return [{ skillVersionId: "version-two", skillId: "skill-alpha", version: "2.0.0", name: "Meeting Notes", description: "Summarize notes", category: "product", validation: { status: "passed" }, publishedAt: "2026-08-10T00:01:00.000Z" }]; },
      async getSkillVersionDiff(input) { calls.push({ kind: "diff", input }); return { skillId: "skill-alpha", fromVersionId: "version-one", toVersionId: "version-two", entries: [] }; },
    },
  });
  const auth = { userId: "alice", workspaceId: "workspace-alpha" };
  const versions = await application.listSkillVersions({ skillId: "skill-alpha", query: { limit: 20 }, auth });
  const diff = await application.getSkillVersionDiff({ skillId: "skill-alpha", fromVersionId: "version-one", toVersionId: "version-two", auth });
  assert.equal(versions.data[0].skillVersionId, "version-two");
  assert.equal(diff.toVersionId, "version-two");
  assert.deepEqual(calls, [
    { kind: "list", input: { skillId: "skill-alpha", workspaceId: "workspace-alpha", requestedBy: "alice", limit: 20 } },
    { kind: "diff", input: { skillId: "skill-alpha", fromVersionId: "version-one", toVersionId: "version-two", workspaceId: "workspace-alpha", requestedBy: "alice" } },
  ]);
});

test("PostgreSQL composition advertises create_version only when its lifecycle owner implements it", async () => {
  const published = { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "published", currentDraftId: "draft-alpha", latestPublishedVersionId: "version-alpha", schemaVersion: "workbench-v1", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: { async listSkillAssets() { return [{ skill: published, draft: null }]; } },
    skillDraftLifecycle: { async createNextSkillDraft() {} },
  });
  const result = await application.listSkillAssets({ auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.deepEqual(result.data[0].skill.allowedActions, ["create_version", "retire"]);
});

test("PostgreSQL Skill read model computes Skill usage internally and the application keeps workflow ACL filtering", async () => {
  const store = storeWith([
    { match: /FROM public\.skill_versions/, values: ["workspace-alpha", "skill-alpha"], rows: [{ skill_version_id: "version-alpha", version: "1.0.0" }] },
    { match: /FROM public\.workflows workflow/, values: ["workspace-alpha"], rows: [
      { workflow_id: "loop-private", revision_id: "revision-private", name: "Private", visibility: "private", status: "ready", lifecycle: "ready", graph: { nodes: [{ kind: "Skill", skillRef: { skillId: "skill-alpha" } }] } },
      { workflow_id: "loop-other", revision_id: "revision-other", name: "Other", visibility: "private", status: "ready", lifecycle: "ready", graph: { nodes: [{ kind: "Skill", skillRef: { skillId: "skill-other" } }] } },
    ] },
  ]);
  const readModel = new PostgresSkillReadModel({ store });
  const usage = await readModel.getSkillUsageImpact({ workspaceId: "workspace-alpha", skillId: "skill-alpha" });
  assert.equal(usage.latestVersionId, "version-alpha");
  assert.deepEqual(usage.affectedWorkflows.map((workflow) => workflow.workflowId), ["loop-private"]);
  store.assertDrained();

  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: {
      async getSkill() { return { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "published", latestPublishedVersionId: "version-alpha" }; },
      async getSkillUsageImpact() { return usage; },
    },
    workflowReadModel: {
      async getWorkflow({ workflowId }) {
        if (workflowId === "loop-private") return { workflow: { workflowId, workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" } };
        throw new Error("workflow_not_expected");
      },
    },
  });
  const result = await application.getSkillUsage({ skillId: "skill-alpha", auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.deepEqual(result.affectedWorkflows.map((workflow) => workflow.workflowId), ["loop-private"]);
});
