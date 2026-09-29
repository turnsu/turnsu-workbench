import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresTeamLibraryReadModel } from "../../src/store/postgres/postgres-team-library-read-model.mjs";

function storeWith(steps) {
  const rest = [...steps];
  return {
    async connect() {},
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`);
      assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values);
      return { rows: step.rows ?? [] };
    } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}

test("PostgreSQL Team Library read owner returns typed immutable Loop releases for the active workspace only", async () => {
  const store = storeWith([{
    match: /FROM public\.workspace_asset_releases/,
    values: ["workspace-alpha", "loop", "product", 21, null],
    rows: [{
      source_workspace_id: "workspace-alpha", release_id: "release-alpha", schema_version: "workbench-v1",
      asset_kind: "loop", asset_id: "workflow-alpha", version_id: "loop-version-alpha", version: "1.0.0",
      content_hash: "sha256:aaaaaaaaaaaaaaaa", visibility: "workspace", domain: "product", starting_point: true,
      release_notes: "Initial release", dependencies: [], published_by: "alice", published_at: "2026-08-11T00:00:00.000Z", payload: {},
    }],
  }]);
  const readModel = new PostgresTeamLibraryReadModel({ store });
  const releases = await readModel.list({ workspaceId: "workspace-alpha", query: { assetKind: "loop", domain: "product", limit: 20 } });
  assert.deepEqual(releases, [{
    schemaVersion: "workbench-v1", releaseId: "release-alpha", sourceWorkspaceId: "workspace-alpha",
    assetKind: "loop", assetId: "workflow-alpha", versionId: "loop-version-alpha", version: "1.0.0",
    contentHash: "sha256:aaaaaaaaaaaaaaaa", visibility: "workspace", domain: "product", startingPoint: true,
    releaseNotes: "Initial release", dependencies: [], publishedBy: "alice", publishedAt: "2026-08-11T00:00:00.000Z",
  }]);
  store.assertDrained();
});

test("Application consumes the injected PostgreSQL Team Library owner instead of the legacy Store", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryReadModel: { marker: "bound", async list(input) { assert.equal(this.marker, "bound"); calls.push(input); return [{ releaseId: "release-alpha", assetKind: "loop" }]; } },
  });
  const result = await application.listTeamLibrary({ query: { assetKind: "loop" }, auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.deepEqual(result.data, [{ releaseId: "release-alpha", assetKind: "loop" }]);
  assert.deepEqual(calls, [{ workspaceId: "workspace-alpha", query: { assetKind: "loop" } }]);
});

test("PostgreSQL System Catalog is listed from its global source, never copied into the active workspace", async () => {
  const store = storeWith([{
    match: /source_workspace_id = \$1/,
    values: ["system-catalog", "skill", "product", 21, null],
    rows: [{
      source_workspace_id: "system-catalog", release_id: "system-release", schema_version: "workbench-v1",
      asset_kind: "skill", asset_id: "meeting-action-extractor", version_id: "system-skill-v1", version: "1.0.0",
      content_hash: "sha256:aaaaaaaaaaaaaaaa", visibility: "workspace", domain: "product", starting_point: true,
      release_notes: "Install explicitly", dependencies: [], published_by: null,
      published_by_system_principal_id: "system-catalog", published_at: "2026-08-11T00:00:00.000Z", payload: { defaultPack: true },
    }],
  }]);
  const readModel = new PostgresTeamLibraryReadModel({ store });
  const releases = await readModel.listSystemCatalog({ query: { assetKind: "skill", domain: "product", limit: 20 } });
  assert.equal(releases[0].sourceWorkspaceId, "system-catalog");
  assert.equal(releases[0].publishedBy, "system-catalog");
  store.assertDrained();
});

test("Application exposes the global Catalog read model without falling back to a workspace release list", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryReadModel: { async listSystemCatalog(query) { calls.push(query); return [{ releaseId: "system-release" }]; } },
  });
  const result = await application.listSystemCatalog({ query: { assetKind: "skill" }, auth: { userId: "viewer", workspaceId: "workspace-alpha" } });
  assert.equal(result.data[0].releaseId, "system-release");
  assert.deepEqual(calls, [{ assetKind: "skill" }]);
});

test("PostgreSQL Team Library read owner restores an Installation by stable workspace-scoped identity", async () => {
  const row = {
    workspace_id: "workspace-alpha", installation_id: "installation-alpha", source_workspace_id: "workspace-alpha",
    release_id: "release-alpha", schema_version: "workbench-v1", asset_kind: "loop", loop_workflow_id: "workflow-alpha",
    loop_version_id: "loop-version-alpha", upstream_asset_id: "workflow-alpha", pinned_version_id: "loop-version-alpha",
    state: "installed", installed_by: "alice", installed_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:01:00.000Z", write_version: 3, payload: {},
  };
  const store = storeWith([
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "installation-alpha"], rows: [row] },
    { match: /FROM public\.asset_installations/, values: ["workspace-alpha", "loop", "installed", 20], rows: [row] },
  ]);
  const readModel = new PostgresTeamLibraryReadModel({ store });
  const installation = await readModel.getInstallation({ workspaceId: "workspace-alpha", installationId: "installation-alpha" });
  const installations = await readModel.listInstallations({ workspaceId: "workspace-alpha", query: { assetKind: "loop", state: "installed", limit: 20 } });
  assert.equal(installation.upstreamAssetId, "workflow-alpha");
  assert.equal(installation.pinnedVersionId, "loop-version-alpha");
  assert.equal(installations[0].writeVersion, 3);
  store.assertDrained();
});

test("Application reads Installation detail and list through the PostgreSQL Team Library owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryReadModel: {
      async getInstallation(input) { calls.push({ kind: "get", input }); return { installationId: "installation-alpha" }; },
      async listInstallations(input) { calls.push({ kind: "list", input }); return [{ installationId: "installation-alpha" }]; },
    },
  });
  const auth = { userId: "alice", workspaceId: "workspace-alpha" };
  const detail = await application.getInstallation({ installationId: "installation-alpha", auth });
  const list = await application.listInstallations({ query: { state: "installed" }, auth });
  assert.equal(detail.installationId, "installation-alpha");
  assert.equal(list.data[0].installationId, "installation-alpha");
  assert.deepEqual(calls, [
    { kind: "get", input: { workspaceId: "workspace-alpha", installationId: "installation-alpha" } },
    { kind: "list", input: { workspaceId: "workspace-alpha", query: { state: "installed" } } },
  ]);
});

test("PostgreSQL Team Library read owner restores only the creator's update draft and its governed Connection bindings", async () => {
  const draft = {
    workspace_id: "workspace-alpha", update_draft_id: "update-alpha", installation_id: "installation-alpha", created_by: "alice",
    schema_version: "workbench-v1", asset_kind: "loop", skill_id: null, base_skill_version_id: null, target_skill_version_id: null,
    loop_workflow_id: "workflow-alpha", base_loop_version_id: "loop-version-alpha", target_loop_version_id: "loop-version-beta",
    base_release_id: "release-alpha", target_release_id: "release-beta", base_installation_write_version: 2,
    impact: { breakingFields: ["version"] }, status: "pending_review", conflict_reason: null, revision: 1,
    created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", decided_at: null, payload: {},
  };
  const store = storeWith([
    { match: /FROM public\.installation_update_drafts/, values: ["workspace-alpha", "update-alpha", "alice"], rows: [draft] },
    { match: /FROM public\.installation_update_draft_connection_bindings/, values: ["workspace-alpha", "update-alpha"], rows: [{ requirement_id: "requirement-alpha", connection_id: "connection-alpha" }] },
  ]);
  const readModel = new PostgresTeamLibraryReadModel({ store });
  const result = await readModel.getUpdateDraft({ workspaceId: "workspace-alpha", updateDraftId: "update-alpha", createdBy: "alice" });
  assert.equal(result.targetVersionId, "loop-version-beta");
  assert.deepEqual(result.connectionBindings, [{ requirementId: "requirement-alpha", connectionId: "connection-alpha" }]);
  store.assertDrained();
});

test("Application uses creator-scoped PostgreSQL update-draft read instead of a legacy repository", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    teamLibraryReadModel: { async getUpdateDraft(input) { calls.push(input); return { updateDraftId: "update-alpha", createdBy: "alice" }; } },
  });
  const result = await application.getInstallationUpdateDraft({ updateDraftId: "update-alpha", auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(result.updateDraftId, "update-alpha");
  assert.deepEqual(calls, [{ workspaceId: "workspace-alpha", updateDraftId: "update-alpha", createdBy: "alice" }]);
});
