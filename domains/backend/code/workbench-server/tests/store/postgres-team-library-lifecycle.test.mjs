import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresTeamLibraryLifecycle } from "../../src/store/postgres/postgres-team-library-lifecycle.mjs";

function storeWith(steps) {
  const rest = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`);
      assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values);
      return { rows: step.rows ?? [], rowCount: step.rowCount ?? 1 };
    } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}

const release = {
  source_workspace_id: "workspace-alpha", release_id: "release-alpha", asset_kind: "loop",
  loop_workflow_id: "workflow-alpha", loop_version_id: "loop-version-alpha", visibility: "workspace",
};

test("PostgreSQL Team Library lifecycle installs an available connection-free Loop release through one receipt-bound transaction", async () => {
  const installed = {
    workspace_id: "workspace-alpha", installation_id: "installation-alpha", source_workspace_id: "workspace-alpha",
    release_id: "release-alpha", schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha",
    loop_version_id: "loop-version-alpha", upstream_asset_id: "workflow-alpha", pinned_version_id: "loop-version-alpha",
    state: "installed", installed_by: "alice", installed_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", write_version: 1, payload: {},
  };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "install-release:workspace-alpha:release-alpha", "install-alpha"], rows: [] },
    { match: /FROM public\.workspace_asset_releases/, values: ["workspace-alpha", "release-alpha"], rows: [release] },
    { match: /FROM public\.loop_version_connection_requirements/, values: ["workspace-alpha", "loop-version-alpha"], rows: [] },
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "loop", "workflow-alpha"], rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /INSERT INTO public\.asset_installations/, rows: [installed] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:00:00.000Z", idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.installRelease({ releaseId: "release-alpha", idempotencyKey: "install-alpha", request: { data: {} }, workspaceId: "workspace-alpha", installedBy: "alice" });
  assert.equal(result.installationId, "installation-alpha");
  assert.equal(result.state, "installed");
  assert.equal(result.pinnedVersionId, "loop-version-alpha");
  store.assertDrained();
});

test("PostgreSQL Team Library lifecycle marks a newer release available without silently changing the pinned Version", async () => {
  const current = {
    workspace_id: "workspace-alpha", installation_id: "installation-alpha", source_workspace_id: "workspace-alpha",
    release_id: "release-alpha", schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha",
    loop_version_id: "loop-version-alpha", upstream_asset_id: "workflow-alpha", pinned_version_id: "loop-version-alpha",
    state: "installed", installed_by: "alice", installed_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", write_version: 1, payload: {},
  };
  const target = { ...release, release_id: "release-beta", loop_version_id: "loop-version-beta" };
  const updated = { ...current, state: "update_available", updated_at: "2026-08-11T00:01:00.000Z", write_version: 2 };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.workspace_asset_releases/, rows: [target] },
    { match: /FROM public\.loop_version_connection_requirements/, rows: [] },
    { match: /FROM public\.asset_installations/, rows: [current] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /UPDATE public\.asset_installations SET state = 'update_available'/, rows: [updated] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:01:00.000Z", idFactory: (kind) => kind });
  const result = await lifecycle.installRelease({ releaseId: "release-beta", idempotencyKey: "install-beta", request: { data: {} }, workspaceId: "workspace-alpha", installedBy: "alice" });
  assert.equal(result.state, "update_available");
  assert.equal(result.releaseId, "release-alpha");
  assert.equal(result.pinnedVersionId, "loop-version-alpha");
  store.assertDrained();
});

test("Application installs through the injected PostgreSQL Team Library lifecycle instead of the legacy Store", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryLifecycle: { async installRelease(input) { calls.push(input); return { installationId: "installation-alpha" }; } },
  });
  const result = await application.installRelease({ releaseId: "release-alpha", idempotencyKey: "install-alpha", request: { data: {} }, auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(result.installationId, "installation-alpha");
  assert.equal(calls[0].installedBy, "alice");
});

test("Application requires an admin authorization before it requests a default system pack installation", async () => {
  const calls = [];
  const authorizations = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    workspaceAuthorizer: { async authorizeWorkspace(input) { authorizations.push(input); return { role: "admin" }; } },
    systemCatalogService: { async installDefaultPack(input) { calls.push(input); return { installations: [{ installationId: "system-install" }] }; } },
  });
  const result = await application.installDefaultSystemCatalog({
    idempotencyKey: "system-pack", request: { data: {} }, auth: { userId: "admin", workspaceId: "workspace-alpha" },
  });
  assert.equal(result.installations[0].installationId, "system-install");
  assert.deepEqual(authorizations, [{ userId: "admin", workspaceId: "workspace-alpha", minimumRole: "admin" }]);
  assert.equal(calls[0].installedBy, "admin");
});

test("PostgreSQL Team Library lifecycle permits a system-catalog Skill only through an explicit admin installation", async () => {
  const release = {
    source_workspace_id: "system-catalog", release_id: "system-release", asset_kind: "skill",
    skill_id: "meeting-action-extractor", skill_version_id: "system-skill-v1", visibility: "workspace",
  };
  const installed = {
    workspace_id: "workspace-alpha", installation_id: "installation-system", source_workspace_id: "system-catalog",
    release_id: "system-release", schema_version: "workbench-v1", asset_kind: "skill",
    skill_id: "meeting-action-extractor", skill_version_id: "system-skill-v1",
    upstream_asset_id: "meeting-action-extractor", pinned_version_id: "system-skill-v1",
    state: "installed", installed_by: "admin", installed_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z", write_version: 1, payload: {},
  };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "admin"], rows: [{ role: "admin" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "admin", "install-release:system-catalog:system-release", "install-system"], rows: [] },
    { match: /FROM public\.workspace_asset_releases/, values: ["system-catalog", "system-release"], rows: [release] },
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "skill", "meeting-action-extractor"], rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /INSERT INTO public\.asset_installations/, rows: [installed] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:00:00.000Z", idFactory: () => "installation-system" });
  const result = await lifecycle.installRelease({
    releaseId: "system-release", sourceWorkspaceId: "system-catalog", minimumRole: "admin",
    idempotencyKey: "install-system", request: { data: {} }, workspaceId: "workspace-alpha", installedBy: "admin",
  });
  assert.equal(result.sourceWorkspaceId, "system-catalog");
  assert.equal(result.assetKind, "skill");
  store.assertDrained();
});

test("PostgreSQL Team Library lifecycle computes a Loop update impact and creates a pending review Draft without changing its pin", async () => {
  const installation = {
    workspace_id: "workspace-alpha", installation_id: "installation-alpha", source_workspace_id: "workspace-alpha",
    release_id: "release-alpha", schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha",
    loop_version_id: "loop-version-alpha", state: "update_available", installed_by: "alice", installed_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", write_version: 1, payload: {},
  };
  const current = { ...release, loop_version_id: "loop-version-alpha", version: "1.0.0", content_hash: "sha256:aaaaaaaaaaaaaaaa" };
  const target = { ...release, release_id: "release-beta", loop_version_id: "loop-version-beta", version: "2.0.0", content_hash: "sha256:bbbbbbbbbbbbbbbb" };
  const updatedInstallation = { ...installation, state: "update_draft_created", write_version: 2, updated_at: "2026-08-11T00:01:00.000Z" };
  const persistedDraft = {
    workspace_id: "workspace-alpha", update_draft_id: "installation-update-draft-alpha", installation_id: "installation-alpha", created_by: "alice",
    schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha", base_loop_version_id: "loop-version-alpha", target_loop_version_id: "loop-version-beta",
    base_release_id: "release-alpha", target_release_id: "release-beta", base_installation_write_version: 2,
    impact: { breakingFields: ["contentHash", "version"] }, status: "pending_review", conflict_reason: null, revision: 1,
    created_at: "2026-08-11T00:01:00.000Z", updated_at: "2026-08-11T00:01:00.000Z", decided_at: null, payload: {},
  };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "create-installation-update-draft:installation-alpha", "draft-alpha"], rows: [] },
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "installation-alpha"], rows: [installation] },
    { match: /FROM public\.workspace_asset_releases/, values: ["workspace-alpha", "release-alpha"], rows: [current] },
    { match: /FROM public\.workspace_asset_releases/, values: ["workspace-alpha", "release-beta"], rows: [target] },
    { match: /FROM public\.loop_version_connection_requirements/, values: ["workspace-alpha", "loop-version-alpha"], rows: [] },
    { match: /FROM public\.loop_version_connection_requirements/, values: ["workspace-alpha", "loop-version-beta"], rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /UPDATE public\.asset_installations SET state = 'update_draft_created'/, rows: [updatedInstallation] },
    { match: /INSERT INTO public\.installation_update_drafts/, rows: [persistedDraft] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:01:00.000Z", idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.createInstallationUpdateDraft({ installationId: "installation-alpha", idempotencyKey: "draft-alpha", request: { data: { releaseId: "release-beta" } }, workspaceId: "workspace-alpha", createdBy: "alice" });
  assert.equal(result.status, "pending_review");
  assert.equal(result.basePinnedVersionId, "loop-version-alpha");
  assert.equal(result.targetVersionId, "loop-version-beta");
  store.assertDrained();
});

test("PostgreSQL Team Library impact rejects an update that changes the upstream Loop identity", async () => {
  const installation = { installation_id: "installation-alpha", asset_kind: "loop", loop_workflow_id: "workflow-alpha", loop_version_id: "loop-version-alpha", release_id: "release-alpha", state: "installed" };
  const current = { ...release, loop_version_id: "loop-version-alpha" };
  const target = { ...release, release_id: "release-beta", loop_workflow_id: "workflow-other", loop_version_id: "loop-version-beta" };
  const store = storeWith([
    { match: /FROM public\.asset_installations/, rows: [installation] },
    { match: /FROM public\.workspace_asset_releases/, rows: [current] },
    { match: /FROM public\.workspace_asset_releases/, rows: [target] },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, idFactory: (kind) => kind });
  await assert.rejects(
    lifecycle.getInstallationUpdateImpact({ installationId: "installation-alpha", releaseId: "release-beta", workspaceId: "workspace-alpha" }),
    (error) => error?.code === "release_not_available",
  );
  store.assertDrained();
});

test("Application creates an installation update Draft through the injected PostgreSQL lifecycle", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryLifecycle: { async createInstallationUpdateDraft(input) { calls.push(input); return { updateDraftId: "update-alpha" }; } },
  });
  const result = await application.createInstallationUpdateDraft({ installationId: "installation-alpha", idempotencyKey: "draft-alpha", request: { data: { releaseId: "release-beta" } }, auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(result.updateDraftId, "update-alpha");
  assert.equal(calls[0].createdBy, "alice");
});

test("PostgreSQL Team Library lifecycle applies a reviewed update atomically only after explicit confirmation", async () => {
  const installation = {
    workspace_id: "workspace-alpha", installation_id: "installation-alpha", release_id: "release-alpha", asset_kind: "loop",
    loop_workflow_id: "workflow-alpha", loop_version_id: "loop-version-alpha", state: "update_draft_created", write_version: 2,
  };
  const draft = {
    workspace_id: "workspace-alpha", update_draft_id: "update-alpha", installation_id: "installation-alpha", created_by: "alice",
    schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha", base_loop_version_id: "loop-version-alpha",
    target_loop_version_id: "loop-version-beta", base_release_id: "release-alpha", target_release_id: "release-beta",
    base_installation_write_version: 2, impact: {}, status: "ready", conflict_reason: null, revision: 2,
    created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", decided_at: null, payload: {},
  };
  const current = { ...release, loop_version_id: "loop-version-alpha", version: "1.0.0", content_hash: "sha256:aaaaaaaaaaaaaaaa" };
  const target = { ...release, release_id: "release-beta", loop_version_id: "loop-version-beta", version: "2.0.0", content_hash: "sha256:bbbbbbbbbbbbbbbb" };
  const applied = { ...draft, status: "applied", revision: 3, updated_at: "2026-08-11T00:02:00.000Z", decided_at: "2026-08-11T00:02:00.000Z" };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.installation_update_drafts/, values: ["workspace-alpha", "update-alpha", "alice"], rows: [draft] },
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "installation-alpha"], rows: [installation] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "installation-alpha"], rows: [installation] },
    { match: /FROM public\.workspace_asset_releases/, values: ["workspace-alpha", "release-alpha"], rows: [current] },
    { match: /FROM public\.workspace_asset_releases/, values: ["workspace-alpha", "release-beta"], rows: [target] },
    { match: /FROM public\.loop_version_connection_requirements/, values: ["workspace-alpha", "loop-version-alpha"], rows: [] },
    { match: /FROM public\.loop_version_connection_requirements/, values: ["workspace-alpha", "loop-version-beta"], rows: [] },
    { match: /UPDATE public\.asset_installations\s+SET release_id =/, rows: [{ ...installation, release_id: "release-beta", loop_version_id: "loop-version-beta", state: "installed", write_version: 3 }] },
    { match: /UPDATE public\.installation_update_drafts\s+SET status = 'applied'/, rows: [applied] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:02:00.000Z", idFactory: (kind) => kind });
  const result = await lifecycle.confirmInstallationUpdateDraft({ updateDraftId: "update-alpha", idempotencyKey: "confirm-alpha", request: { data: {} }, workspaceId: "workspace-alpha", confirmedBy: "alice" });
  assert.equal(result.status, "applied");
  assert.equal(result.targetReleaseId, "release-beta");
  store.assertDrained();
});

test("PostgreSQL Team Library lifecycle persists a conflict instead of silently applying a stale update Draft", async () => {
  const installation = { workspace_id: "workspace-alpha", installation_id: "installation-alpha", release_id: "release-other", asset_kind: "loop", loop_workflow_id: "workflow-alpha", loop_version_id: "loop-version-other", state: "installed", write_version: 9 };
  const draft = {
    workspace_id: "workspace-alpha", update_draft_id: "update-alpha", installation_id: "installation-alpha", created_by: "alice",
    schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha", base_loop_version_id: "loop-version-alpha",
    target_loop_version_id: "loop-version-beta", base_release_id: "release-alpha", target_release_id: "release-beta", base_installation_write_version: 2,
    impact: {}, status: "pending_review", conflict_reason: null, revision: 1, created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", decided_at: null, payload: {},
  };
  const conflicted = { ...draft, status: "conflicted", conflict_reason: "The installed version changed after this update draft was created.", revision: 2, updated_at: "2026-08-11T00:03:00.000Z" };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.installation_update_drafts/, rows: [draft] },
    { match: /FROM public\.asset_installations/, rows: [installation] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /UPDATE public\.installation_update_drafts\s+SET status = 'conflicted'/, rows: [conflicted] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:03:00.000Z", idFactory: (kind) => kind });
  await assert.rejects(
    lifecycle.confirmInstallationUpdateDraft({ updateDraftId: "update-alpha", idempotencyKey: "confirm-alpha", request: { data: {} }, workspaceId: "workspace-alpha", confirmedBy: "alice" }),
    (error) => error?.code === "installation_update_conflict",
  );
  store.assertDrained();
});

test("PostgreSQL Team Library lifecycle keeps the installed pin when a user dismisses an update Draft", async () => {
  const installation = { workspace_id: "workspace-alpha", installation_id: "installation-alpha", release_id: "release-alpha", asset_kind: "loop", loop_workflow_id: "workflow-alpha", loop_version_id: "loop-version-alpha", state: "update_draft_created", write_version: 2 };
  const draft = {
    workspace_id: "workspace-alpha", update_draft_id: "update-alpha", installation_id: "installation-alpha", created_by: "alice",
    schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha", base_loop_version_id: "loop-version-alpha", target_loop_version_id: "loop-version-beta",
    base_release_id: "release-alpha", target_release_id: "release-beta", base_installation_write_version: 2, impact: {}, status: "pending_review", conflict_reason: null, revision: 1,
    created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", decided_at: null, payload: {},
  };
  const kept = { ...draft, status: "kept_current", revision: 2, updated_at: "2026-08-11T00:04:00.000Z", decided_at: "2026-08-11T00:04:00.000Z" };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.installation_update_drafts/, rows: [draft] },
    { match: /FROM public\.asset_installations/, rows: [installation] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /UPDATE public\.asset_installations\s+SET state = 'installed'/, rows: [{ ...installation, state: "installed", write_version: 3 }] },
    { match: /UPDATE public\.installation_update_drafts\s+SET status = 'kept_current'/, rows: [kept] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresTeamLibraryLifecycle({ store, clock: () => "2026-08-11T00:04:00.000Z", idFactory: (kind) => kind });
  const result = await lifecycle.keepCurrentInstallationVersion({ updateDraftId: "update-alpha", idempotencyKey: "keep-alpha", request: { data: {} }, workspaceId: "workspace-alpha", decidedBy: "alice" });
  assert.equal(result.status, "kept_current");
  assert.equal(result.basePinnedVersionId, "loop-version-alpha");
  store.assertDrained();
});

test("Application routes update decisions through the injected PostgreSQL Team Library lifecycle", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryLifecycle: {
      async refreshInstallationUpdateDraft(input) { calls.push(["refresh", input]); return { status: "ready" }; },
      async confirmInstallationUpdateDraft(input) { calls.push(["confirm", input]); return { status: "applied" }; },
      async keepCurrentInstallationVersion(input) { calls.push(["keep", input]); return { status: "kept_current" }; },
    },
  });
  const auth = { userId: "alice", workspaceId: "workspace-alpha" };
  await application.refreshInstallationUpdateDraft({ updateDraftId: "update-alpha", idempotencyKey: "refresh", request: { data: {} }, auth });
  await application.confirmInstallationUpdateDraft({ updateDraftId: "update-alpha", idempotencyKey: "confirm", request: { data: {} }, auth });
  await application.keepCurrentInstallationVersion({ updateDraftId: "update-alpha", idempotencyKey: "keep", request: { data: {} }, auth });
  assert.deepEqual(calls.map(([kind]) => kind), ["refresh", "confirm", "keep"]);
  assert.equal(calls[1][1].confirmedBy, "alice");
});
