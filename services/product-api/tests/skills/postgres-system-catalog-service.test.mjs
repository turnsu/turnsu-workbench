import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresSystemCatalogService,
  SYSTEM_CATALOG,
} from "../../src/skills/postgres-system-catalog-service.mjs";

function valuesFor(history, fragment) {
  const row = history.find((entry) => entry.text.includes(fragment));
  assert.ok(row, `missing query: ${fragment}`);
  return row.values;
}

function storeWith(steps) {
  const rest = [...steps];
  const history = [];
  return {
    bindAdapter(factory) {
      return factory({ execute: async (_uow, { text, values }) => {
        const step = rest.shift();
        assert.ok(step, `unexpected query: ${text}`);
        assert.match(text, step.match ?? step);
        history.push({ text, values });
        return {
          rows: typeof step.rows === "function" ? step.rows(history) : (step.rows ?? []),
          rowCount: 1,
        };
      } });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}

test("PostgreSQL system catalog creates only the global immutable source and release", async () => {
  const store = storeWith([
    /INSERT INTO public\.product_users/,
    /INSERT INTO public\.product_workspaces/,
    /INSERT INTO public\.workspace_principals/,
    /INSERT INTO public\.skill_system_catalog_principals/,
    /INSERT INTO public\.product_scopes/,
    /INSERT INTO public\.scope_policy_revisions/,
    /INSERT INTO public\.scope_principal_grants/,
    /INSERT INTO public\.product_objects/,
    /INSERT INTO public\.skill_assets/,
    /INSERT INTO public\.skill_system_catalog_sources/,
    /INSERT INTO public\.skill_versions/,
    /UPDATE public\.skill_assets/,
    /INSERT INTO public\.workspace_asset_releases/,
    { match: /SELECT status FROM public\.skill_system_catalog_principals/, rows: [{ status: "enabled" }] },
    { match: /SELECT content_hash, state FROM public\.product_objects/, rows: (history) => {
      const values = valuesFor(history, "INSERT INTO public.product_objects");
      return [{ content_hash: values[2], state: "promoted" }];
    } },
    { match: /SELECT scope_id, owner_system_principal_id, lifecycle, latest_published_version_id/, rows: [{
      scope_id: "system-catalog", owner_system_principal_id: "system-catalog", lifecycle: "published",
      latest_published_version_id: "system-skill-version-meeting-action-extractor-v1",
    }] },
    { match: /SELECT source_manifest_hash, package_object_id/, rows: (history) => {
      const values = valuesFor(history, "INSERT INTO public.skill_system_catalog_sources");
      return [{
        source_manifest_hash: values[5], package_object_id: values[6], package_object_hash: values[7],
        package_hash: values[8], published_version_content_hash: values[9], runtime_probe_status: "ready",
        execution_ref: JSON.parse(values[13]), execution_ref_hash: values[14], definition: JSON.parse(values[17]),
      }];
    } },
    { match: /SELECT skill_id, package_object_id, package_object_hash, package_hash, content_hash/, rows: (history) => {
      const values = valuesFor(history, "INSERT INTO public.skill_versions");
      return [{
        skill_id: values[2], package_object_id: values[4], package_object_hash: values[5], package_hash: values[6],
        content_hash: values[7], published_by_system_principal_id: values[8], definition: JSON.parse(values[10]),
      }];
    } },
    { match: /SELECT asset_kind, skill_id, skill_version_id, content_hash/, rows: (history) => {
      const values = valuesFor(history, "INSERT INTO public.workspace_asset_releases");
      return [{
        asset_kind: "skill", skill_id: values[2], skill_version_id: values[3], content_hash: values[4],
        published_by_system_principal_id: values[6], payload: JSON.parse(values[8]),
      }];
    } },
  ]);
  const puts = [];
  const service = new PostgresSystemCatalogService({
    store,
    objectStore: {
      async initialize() {},
      async put(input) { puts.push(input); return { sizeBytes: input.bytes.byteLength, mediaType: input.mediaType }; },
      async promote({ objectId }) { return { objectId, contentHash: puts[0].contentHash }; },
    },
    teamLibraryLifecycle: { async installRelease() { throw new Error("not called"); } },
    probeSkill: async () => ({ ready: true, code: "runtime_ready" }),
    clock: () => "2026-08-11T01:00:00.000Z",
  });
  const source = await service.ensureGlobalSource();
  assert.equal(source.sourceWorkspaceId, SYSTEM_CATALOG.workspaceId);
  assert.equal(source.releaseId, SYSTEM_CATALOG.releaseId);
  assert.equal(puts[0].workspaceId, "system-catalog");
  store.assertDrained();
});

test("default system pack delegates one explicit admin-only installation to the shared lifecycle", async () => {
  const calls = [];
  const service = new PostgresSystemCatalogService({
    store: { bindAdapter(factory) { return factory({ execute() {} }); }, async withTransaction(work) { return work({}); } },
    objectStore: { async put() {}, async promote() {} },
    teamLibraryLifecycle: { async installRelease(input) { calls.push(input); return { installationId: "installed", assetKind: "skill" }; } },
  });
  const result = await service.installDefaultPack({ workspaceId: "workspace-a", installedBy: "owner-a", idempotencyKey: "pack-a", request: { data: {} } });
  assert.equal(calls[0].sourceWorkspaceId, "system-catalog");
  assert.equal(calls[0].minimumRole, "admin");
  assert.equal(result.installations[0].installationId, "installed");
});

test("system catalog fails closed when an existing global principal is no longer enabled", async () => {
  let objectHash = null;
  const service = new PostgresSystemCatalogService({
    store: {
      bindAdapter(factory) {
        return factory({ execute: async (_uow, { text }) => ({
          rows: /SELECT status FROM public\.skill_system_catalog_principals/.test(text)
            ? [{ status: "disabled" }]
            : [],
          rowCount: 1,
        }) });
      },
      async withTransaction(work) { return work({}); },
    },
    objectStore: {
      async initialize() {},
      async put(input) { objectHash = input.contentHash; return { sizeBytes: input.bytes.byteLength, mediaType: input.mediaType }; },
      async promote({ objectId }) { return { objectId, contentHash: objectHash }; },
    },
    teamLibraryLifecycle: { async installRelease() {} },
    probeSkill: async () => ({ ready: true, code: "runtime_ready" }),
  });
  await assert.rejects(() => service.ensureGlobalSource(), (error) => error?.code === "system_catalog_integrity_conflict");
});
