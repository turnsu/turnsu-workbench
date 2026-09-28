import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSkillDraftLifecycle } from "../../src/skills/index.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { canonicalSkillDraftContentHash } from "../../src/store/serialization.mjs";

function scriptedStore(steps) {
  const remaining = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = remaining.shift(); assert.ok(step, `unexpected query: ${text}`);
      assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values); step.verify?.({ text, values });
      return { rows: step.rows ?? [] };
    } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(remaining.length, 0); },
  };
}

const request = { data: { name: "Meeting Notes", description: "Summarize notes", category: "product" } };

test("PostgreSQL Skill Draft lifecycle atomically creates a private Asset, Draft, snapshot and idempotency response", async () => {
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "create-skill-alpha"], rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /FROM public\.product_scopes/, values: ["workspace-alpha", "alice"], rows: [{ scope_id: "scope-alpha" }] },
    { match: /INSERT INTO public\.skill_assets/ },
    { match: /INSERT INTO public\.skill_drafts/ },
    { match: /INSERT INTO public\.skill_draft_revision_snapshots/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({
    store, clock: () => "2026-08-10T00:00:00.000Z", idFactory: (kind) => `${kind}-alpha`,
  });
  const result = await lifecycle.createSkill({
    idempotencyKey: "create-skill-alpha", request, workspaceId: "workspace-alpha", authoredBy: "alice",
  });
  assert.equal(result.skill.skillId, "skill-alpha");
  assert.equal(result.draft.skillDraftId, "skill-draft-alpha");
  assert.equal(result.draft.revision, 1);
  store.assertDrained();
});

test("PostgreSQL Skill Draft lifecycle replays the canonical response and rejects a reused key", async () => {
  const canonical = { skill: { skillId: "skill-alpha" }, draft: { skillDraftId: "skill-draft-alpha", revision: 1 } };
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "create-skill-alpha"], rows: [{ request_hash: "sha256:bad", response: canonical }] },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({ store, idFactory: (kind) => kind });
  await assert.rejects(
    lifecycle.createSkill({ idempotencyKey: "create-skill-alpha", request, workspaceId: "workspace-alpha", authoredBy: "alice" }),
    (error) => error?.code === "idempotency_key_reused",
  );
  store.assertDrained();
});

test("PostgreSQL Skill Draft lifecycle atomically advances an owned Draft and its immutable revision", async () => {
  const previousDefinition = {
    schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha", workspaceId: "workspace-alpha",
    baseVersionId: null, revision: 1, name: "Meeting Notes", description: "Summarize notes", category: "product",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, risk: { level: "low" },
    dependencies: [], connectionRequirements: [], files: [], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
  };
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "update-skill-draft:skill-alpha:draft-alpha", "update-skill-alpha"], rows: [] },
    { match: /FROM public\.skill_assets/, values: ["workspace-alpha", "skill-alpha"], rows: [{ workspace_id: "workspace-alpha", skill_id: "skill-alpha", owner_user_id: "alice", current_draft_id: "draft-alpha", lifecycle: "draft", payload: { name: "Meeting Notes" } }] },
    { match: /FROM public\.skill_drafts/, values: ["workspace-alpha", "skill-alpha", "draft-alpha"], rows: [{ workspace_id: "workspace-alpha", skill_id: "skill-alpha", skill_draft_id: "draft-alpha", base_version_id: null, draft_revision: 1, definition: previousDefinition, created_at: "2026-08-10T00:00:00.000Z" }] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /SET CONSTRAINTS ALL DEFERRED/ },
    { match: /INSERT INTO public\.skill_draft_revision_snapshots/ },
    { match: /UPDATE public\.skill_drafts/ },
    { match: /UPDATE public\.skill_assets/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({ store, clock: () => "2026-08-10T00:01:00.000Z", idFactory: (kind) => kind });
  const result = await lifecycle.updateSkillDraft({
    skillId: "skill-alpha", draftId: "draft-alpha", workspaceId: "workspace-alpha", authoredBy: "alice",
    idempotencyKey: "update-skill-alpha", ifMatch: '"skd1:draft-alpha:1"',
    request: { data: { name: "Decision Notes", description: "Extract decisions" } },
  });
  assert.equal(result.draft.revision, 2);
  assert.equal(result.draft.name, "Decision Notes");
  assert.equal(result.draft.description, "Extract decisions");
  assert.equal(result.draft.category, "product");
  store.assertDrained();
});

test("PostgreSQL Skill Draft lifecycle rejects a stale ETag before any mutation", async () => {
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.skill_assets/, rows: [{ owner_user_id: "alice", current_draft_id: "draft-alpha", lifecycle: "draft" }] },
    { match: /FROM public\.skill_drafts/, rows: [{ draft_revision: 2, definition: {}, base_version_id: null, created_at: "2026-08-10T00:00:00.000Z" }] },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({ store, idFactory: (kind) => kind });
  await assert.rejects(
    lifecycle.updateSkillDraft({
      skillId: "skill-alpha", draftId: "draft-alpha", workspaceId: "workspace-alpha", authoredBy: "alice",
      idempotencyKey: "update-skill-alpha", ifMatch: '"skd1:draft-alpha:1"', request: { data: { name: "Changed" } },
    }),
    (error) => error?.code === "skill_draft_conflict",
  );
  store.assertDrained();
});

test("PostgreSQL Skill package replacement creates a new immutable Draft snapshot and clears execution", async () => {
  const definition = { schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha", workspaceId: "workspace-alpha", baseVersionId: null, revision: 1, name: "Meeting Notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, dependencies: [], connectionRequirements: [], files: [], executionRef: { capabilityId: "old-binding" }, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.skill_assets/, rows: [{ owner_user_id: "alice", lifecycle: "tested", current_draft_id: "draft-alpha" }] },
    { match: /FROM public\.skill_drafts/, rows: [{ draft_revision: 1, base_version_id: null, created_at: "2026-08-10T00:00:00.000Z", definition }] },
    { match: /FROM public\.upload_sessions/, values: ["workspace-alpha", "upload-alpha", "alice"], rows: [{ upload_id: "upload-alpha", state: "promoted", inspection_status: "passed", object_id: "object-alpha", object_content_hash: "sha256:aaaaaaaaaaaaaaaa", package_hash: "sha256:bbbbbbbbbbbbbbbb", media_type: "application/vnd.looloomi.skill-package+json", size_bytes: 42, object_state: "promoted" }] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /SET CONSTRAINTS ALL DEFERRED/ },
    { match: /INSERT INTO public\.skill_draft_revision_snapshots/, verify: ({ values }) => assert.equal(JSON.parse(values[10]).executionRef, undefined) },
    { match: /UPDATE public\.skill_drafts/ },
    { match: /UPDATE public\.skill_assets/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({ store, clock: () => "2026-08-10T00:01:00.000Z", idFactory: (kind) => kind });
  const result = await lifecycle.replaceSkillDraftPackage({
    skillId: "skill-alpha", draftId: "draft-alpha", idempotencyKey: "replace-alpha", ifMatch: '"skd1:draft-alpha:1"', workspaceId: "workspace-alpha", authoredBy: "alice",
    request: { data: { uploadId: "upload-alpha" } }, replacement: { uploadId: "upload-alpha", objectId: "object-alpha", contentHash: "sha256:aaaaaaaaaaaaaaaa", mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: 42 },
  });
  assert.equal(result.draft.revision, 2);
  assert.equal(result.draft.files[0].objectId, "object-alpha");
  assert.equal(Object.hasOwn(result.draft, "executionRef"), false);
  store.assertDrained();
});

test("PostgreSQL Skill Draft lifecycle atomically starts a new private Draft from an immutable published Version", async () => {
  const publishedDefinition = {
    schemaVersion: "workbench-v1", skillVersionId: "version-alpha", skillId: "skill-alpha", version: "1.0.0",
    name: "Meeting Notes", description: "Summarize notes", category: "product",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, risk: { level: "low" },
    dependencies: [], connectionRequirements: [], executionRef: { executionMode: "deterministic" },
  };
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "create-next-skill-draft:skill-alpha", "next-skill-alpha"], rows: [] },
    { match: /FROM public\.skill_assets/, values: ["workspace-alpha", "skill-alpha"], rows: [{ schema_version: "workbench-v1", workspace_id: "workspace-alpha", skill_id: "skill-alpha", scope_id: "scope-alpha", owner_user_id: "alice", visibility: "private", lifecycle: "published", current_draft_id: "draft-current", latest_published_version_id: "version-alpha", created_at: "2026-08-10T00:00:00.000Z", payload: { name: "Meeting Notes" } }] },
    { match: /FROM public\.skill_drafts/, values: ["workspace-alpha", "skill-alpha", "draft-current"], rows: [{ skill_draft_id: "draft-current", draft_revision: 4 }] },
    { match: /FROM public\.skill_versions/, values: ["workspace-alpha", "skill-alpha", "version-alpha"], rows: [{ skill_version_id: "version-alpha", package_object_id: "object-alpha", package_object_hash: "sha256:aaaaaaaaaaaaaaaa", package_hash: "sha256:bbbbbbbbbbbbbbbb", definition: publishedDefinition }] },
    { match: /FROM public\.product_objects/, values: ["workspace-alpha", "object-alpha", "sha256:aaaaaaaaaaaaaaaa"], rows: [{ object_id: "object-alpha", content_hash: "sha256:aaaaaaaaaaaaaaaa", media_type: "application/zip", size_bytes: 42 }] },
    { match: /COALESCE\(MAX\(draft_revision\)/, values: ["workspace-alpha", "skill-alpha"], rows: [{ next_revision: 5 }] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /SET CONSTRAINTS ALL DEFERRED/ },
    { match: /INSERT INTO public\.skill_drafts/ },
    { match: /INSERT INTO public\.skill_draft_revision_snapshots/ },
    { match: /UPDATE public\.skill_assets/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({
    store, clock: () => "2026-08-10T00:02:00.000Z", idFactory: (kind) => `${kind}-next`,
  });
  const result = await lifecycle.createNextSkillDraft({
    skillId: "skill-alpha", idempotencyKey: "next-skill-alpha", ifMatch: '"skd1:draft-current:4"',
    request: { data: { baseVersionId: "version-alpha" } }, workspaceId: "workspace-alpha", authoredBy: "alice",
  });
  assert.equal(result.skill.lifecycle, "draft");
  assert.equal(result.draft.skillDraftId, "skill-draft-next");
  assert.equal(result.draft.baseVersionId, "version-alpha");
  assert.equal(result.draft.revision, 5);
  assert.deepEqual(result.draft.files, [{ path: "package.skill-package", objectId: "object-alpha", contentHash: "sha256:aaaaaaaaaaaaaaaa", mediaType: "application/zip", sizeBytes: 42 }]);
  store.assertDrained();
});

test("PostgreSQL Skill Draft lifecycle atomically retires an owned published Skill", async () => {
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "deprecate-skill:skill-alpha", "retire-skill-alpha"], rows: [] },
    { match: /FROM public\.skill_assets/, values: ["workspace-alpha", "skill-alpha"], rows: [{ schema_version: "workbench-v1", workspace_id: "workspace-alpha", skill_id: "skill-alpha", scope_id: "scope-alpha", owner_user_id: "alice", visibility: "private", lifecycle: "published", current_draft_id: "draft-current", latest_published_version_id: "version-alpha", created_at: "2026-08-10T00:00:00.000Z", payload: { name: "Meeting Notes" } }] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /UPDATE public\.skill_assets/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({
    store, clock: () => "2026-08-10T00:03:00.000Z", idFactory: (kind) => kind,
  });
  const result = await lifecycle.deprecateSkill({
    skillId: "skill-alpha", idempotencyKey: "retire-skill-alpha", request: { data: { reason: "Superseded" } },
    workspaceId: "workspace-alpha", deprecatedBy: "alice",
  });
  assert.equal(result.lifecycle, "deprecated");
  assert.deepEqual(result.retirement, { reason: "Superseded", retiredAt: "2026-08-10T00:03:00.000Z", retiredBy: "alice" });
  store.assertDrained();
});

test("PostgreSQL Skill publication consumes only an exact passed Validation and immutable execution binding", async () => {
  const definition = {
    schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha", workspaceId: "workspace-alpha",
    baseVersionId: null, revision: 2, name: "Meeting Notes", description: "Summarize notes", category: "product",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, risk: { level: "low" }, dependencies: [], connectionRequirements: [],
    files: [{ path: "package.skill-package", objectId: "object-alpha", contentHash: "sha256:aaaaaaaaaaaaaaaa" }],
  };
  const contentHash = canonicalSkillDraftContentHash(definition);
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.skill_assets/, rows: [{ schema_version: "workbench-v1", workspace_id: "workspace-alpha", skill_id: "skill-alpha", scope_id: "scope-alpha", owner_user_id: "alice", visibility: "private", lifecycle: "tested", current_draft_id: "draft-alpha", created_at: "2026-08-10T00:00:00.000Z", payload: { name: "Meeting Notes" } }] },
    { match: /FROM public\.skill_drafts/, rows: [{ skill_draft_id: "draft-alpha", draft_revision: 2, content_hash: contentHash, package_object_id: "object-alpha", package_object_hash: "sha256:aaaaaaaaaaaaaaaa", package_hash: "sha256:bbbbbbbbbbbbbbbb", definition }] },
    { match: /FROM public\.upload_sessions/, rows: [{ upload_id: "upload-alpha", state: "promoted", inspection_status: "passed", package_hash: "sha256:bbbbbbbbbbbbbbbb", object_id: "object-alpha", content_hash: "sha256:aaaaaaaaaaaaaaaa", object_state: "promoted" }] },
    { match: /FROM public\.skill_validations/, rows: [{ validation_id: "validation-alpha", status: "passed", diagnostics: [], completed_at: "2026-08-10T00:01:00.000Z", primary_test_run_id: "test-alpha" }] },
    { match: /FROM public\.skill_execution_bindings/, rows: [{ execution_binding_id: "binding-alpha", published_version_content_hash: "sha256:cccccccccccccccc", capability_id: "capability-alpha", task_intent: "execute", adapter_version: "v1", execution_mode: "deterministic", executor_kind: "prompt_tool", trust_tier: "uploaded_prompt", runtime_id: null, image_digest: null }] },
    { match: /FROM public\.skill_versions/, rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /SET CONSTRAINTS ALL DEFERRED/ },
    { match: /INSERT INTO public\.skill_versions/, verify: ({ values }) => assert.deepEqual(JSON.parse(values[15]), definition) },
    { match: /INSERT INTO public\.workspace_asset_releases/ },
    { match: /UPDATE public\.skill_assets/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresSkillDraftLifecycle({ store, clock: () => "2026-08-10T00:04:00.000Z", idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.publishSkill({
    skillId: "skill-alpha", idempotencyKey: "publish-alpha", ifMatch: '"skd1:draft-alpha:2"', workspaceId: "workspace-alpha", publishedBy: "alice",
    request: { data: { version: "1.0.0", releaseNotes: "Validated release." } },
  });
  assert.equal(result.skill.lifecycle, "published");
  assert.equal(result.version.validation.status, "passed");
  assert.equal(result.version.executionRef.capabilityId, "capability-alpha");
  assert.equal(result.release.releaseId, "release-alpha");
  store.assertDrained();
});


test("Application creates a Skill through the injected PostgreSQL lifecycle instead of store.createSkill", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillDraftLifecycle: {
      async createSkill(input) {
        calls.push(input);
        return {
          skill: { schemaVersion: "workbench-v1", skillId: "skill-alpha", ownerId: "alice", visibility: "private", lifecycle: "draft", currentDraftId: "draft-alpha", latestPublishedVersionId: null, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" },
          draft: { schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha", revision: 1, name: "Meeting Notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, dependencies: [], connectionRequirements: [], files: [], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" },
        };
      },
    },
  });
  const response = await application.createSkill({
    idempotencyKey: "create-skill-alpha", request, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceId, "workspace-alpha");
  assert.equal(response.skill.skillId, "skill-alpha");
});

test("Application updates a Skill through the injected PostgreSQL lifecycle instead of store.updateSkillDraft", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: {
      async getSkillDraft() {
        return {
          skill: { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" },
          draft: { skillDraftId: "draft-alpha", skillId: "skill-alpha", revision: 1 },
        };
      },
    },
    skillDraftLifecycle: {
      async updateSkillDraft(input) {
        calls.push(input);
        return { draft: { skillDraftId: "draft-alpha", skillId: "skill-alpha", revision: 2, name: "Decision Notes", description: "Extract decisions", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, dependencies: [], connectionRequirements: [], files: [], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" } };
      },
    },
  });
  const response = await application.updateSkillDraft({
    skillId: "skill-alpha", draftId: "draft-alpha", idempotencyKey: "update-skill-alpha", ifMatch: '"skd1:draft-alpha:1"',
    request: { data: { name: "Decision Notes" } }, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authoredBy, "alice");
  assert.equal(response.etag, '"skd1:draft-alpha:2"');
});

test("Application replaces a package through the injected PostgreSQL lifecycle instead of the legacy Store", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: { async getSkillDraft() { return { skill: { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, draft: { skillDraftId: "draft-alpha", skillId: "skill-alpha", revision: 1 } }; } },
    skillUploadService: { async resolvePromotedPackage() { return { uploadId: "upload-alpha", objectId: "object-alpha", contentHash: "sha256:aaaaaaaaaaaaaaaa", mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: 42 }; } },
    skillDraftLifecycle: { async replaceSkillDraftPackage(input) { calls.push(input); return { draft: { schemaVersion: "workbench-v1", skillDraftId: "draft-alpha", skillId: "skill-alpha", revision: 2, name: "Meeting Notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, dependencies: [], connectionRequirements: [], files: [], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" } }; } },
  });
  const response = await application.replaceSkillDraftPackage({
    skillId: "skill-alpha", draftId: "draft-alpha", idempotencyKey: "replace-alpha", ifMatch: '"skd1:draft-alpha:1"', request: { data: { uploadId: "upload-alpha" } }, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].replacement.objectId, "object-alpha");
  assert.equal(response.etag, '"skd1:draft-alpha:2"');
});

test("Application starts the next Skill Draft through the PostgreSQL lifecycle instead of the legacy Store", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: {
      async getSkill() {
        return { skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "published", latestPublishedVersionId: "version-alpha" };
      },
    },
    skillDraftLifecycle: {
      async createNextSkillDraft(input) {
        calls.push(input);
        return { draft: { schemaVersion: "workbench-v1", skillDraftId: "draft-next", skillId: "skill-alpha", baseVersionId: "version-alpha", revision: 5, name: "Meeting Notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, dependencies: [], connectionRequirements: [], files: [], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:02:00.000Z" } };
      },
    },
  });
  const response = await application.createNextSkillDraft({
    skillId: "skill-alpha", idempotencyKey: "next-skill-alpha", ifMatch: '"skd1:draft-current:4"',
    request: { data: { baseVersionId: "version-alpha" } }, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authoredBy, "alice");
  assert.equal(response.data.skillDraftId, "draft-next");
  assert.equal(response.etag, '"skd1:draft-next:5"');
});

test("Application retires an owned published Skill through the PostgreSQL lifecycle", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: {
      async getSkill() {
        return { schemaVersion: "workbench-v1", skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "published", currentDraftId: "draft-alpha", latestPublishedVersionId: "version-alpha", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
      },
    },
    skillDraftLifecycle: {
      async deprecateSkill(input) {
        calls.push(input);
        return { schemaVersion: "workbench-v1", skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "deprecated", currentDraftId: "draft-alpha", latestPublishedVersionId: "version-alpha", retirement: { reason: "Superseded", retiredAt: "2026-08-10T00:03:00.000Z" }, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:03:00.000Z" };
      },
    },
  });
  const response = await application.deprecateSkill({
    skillId: "skill-alpha", idempotencyKey: "retire-skill-alpha", request: { data: { reason: "Superseded" } },
    auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deprecatedBy, "alice");
  assert.equal(response.lifecycle, "deprecated");
});

test("Application publishes a Skill through the injected PostgreSQL lifecycle instead of the legacy Store", async () => {
  const calls = [];
  const published = { schemaVersion: "workbench-v1", skillId: "skill-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "published", currentDraftId: "draft-alpha", latestPublishedVersionId: "version-alpha", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:04:00.000Z" };
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillReadModel: { async getSkill() { return { ...published, lifecycle: "tested", latestPublishedVersionId: null }; } },
    skillDraftLifecycle: { async publishSkill(input) { calls.push(input); return { skill: published, version: { schemaVersion: "workbench-v1", skillVersionId: "version-alpha", skillId: "skill-alpha", version: "1.0.0", name: "Meeting Notes", description: "Summarize notes", category: "product", inputSchema: {}, outputSchema: {}, risk: {}, validation: { status: "passed", testedAt: "2026-08-10T00:01:00.000Z" }, publishedAt: "2026-08-10T00:04:00.000Z" }, release: { schemaVersion: "workbench-v1", releaseId: "release-alpha", assetKind: "skill", assetId: "skill-alpha", versionId: "version-alpha", version: "1.0.0", visibility: "workspace", startingPoint: false, releaseNotes: "Validated release.", dependencies: [], publishedAt: "2026-08-10T00:04:00.000Z" } }; } },
  });
  const response = await application.publishSkill({
    skillId: "skill-alpha", idempotencyKey: "publish-alpha", ifMatch: '"skd1:draft-alpha:2"', request: { data: { version: "1.0.0", releaseNotes: "Validated release." } }, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].publishedBy, "alice");
  assert.equal(response.skill.lifecycle, "published");
  assert.equal(response.release.releaseId, "release-alpha");
});
