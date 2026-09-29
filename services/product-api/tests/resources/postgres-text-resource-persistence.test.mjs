import assert from "node:assert/strict";
import test from "node:test";

import { PostgresTextResourcePersistence } from "../../src/resources/index.mjs";

class ScriptedStore {
  constructor(steps) { this.steps = [...steps]; }
  bindAdapter(factory) {
    return factory({ execute: async (_uow, config) => {
      const step = this.steps.shift();
      assert.ok(step, `unexpected query: ${config.text}`);
      assert.match(config.text, step.match);
      step.assertValues?.(config.values);
      return step.result ?? { rows: [], rowCount: 0 };
    } });
  }
  async withTransaction(work, options = {}) { return work(options.uow ?? { kind: "test-uow" }); }
  assertDrained() { assert.equal(this.steps.length, 0); }
}

const resource = Object.freeze({
  schemaVersion: "workbench-v1", resourceId: "resource-alpha", workspaceId: "workspace-alpha",
  createdBy: "user-alpha", version: "1.0.0", label: "Meeting notes", mediaType: "text/markdown",
  sizeBytes: 12, contentHash: `sha256:${"a".repeat(64)}`, objectId: "object-resource-alpha",
  source: { kind: "text_entry" }, readiness: { status: "ready" },
  createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
});

const row = (overrides = {}) => ({
  workspace_id: resource.workspaceId, resource_id: resource.resourceId, resource_version: resource.version,
  created_by: resource.createdBy, schema_version: resource.schemaVersion, label: resource.label,
  media_type: resource.mediaType, size_bytes: resource.sizeBytes, content_hash: resource.contentHash,
  object_id: resource.objectId, source_kind: "text_entry", source_attachment_id: null,
  source_attachment_version: null, source_attachment_content_hash: null, readiness_status: "ready",
  created_at: resource.createdAt, updated_at: resource.updatedAt, payload: {}, ...overrides,
});

test("PostgreSQL Resource persistence writes the product object and immutable resource in one UoW", async () => {
  const store = new ScriptedStore([
    { match: /INSERT INTO public\.product_objects/, assertValues(values) {
      assert.deepEqual(values.slice(0, 6), [resource.workspaceId, resource.objectId, resource.contentHash, resource.sizeBytes, resource.mediaType, resource.createdAt]);
      assert.deepEqual(JSON.parse(values[6]), { source: "workspace_resource", resourceId: resource.resourceId });
    } },
    { match: /INSERT INTO public\.workspace_resources/, assertValues(values) {
      assert.deepEqual(values.slice(0, 4), [resource.workspaceId, resource.resourceId, resource.version, resource.createdBy]);
      assert.equal(values[10], "text_entry");
    }, result: { rows: [row()] } },
  ]);
  const persistence = new PostgresTextResourcePersistence({ store });
  assert.deepEqual(await persistence.insertResource({ resource }), resource);
  store.assertDrained();
});

test("PostgreSQL Resource persistence reads only the selected workspace/version", async () => {
  const store = new ScriptedStore([{
    match: /FROM public\.workspace_resources/,
    assertValues(values) { assert.deepEqual(values, [resource.workspaceId, resource.resourceId, resource.version]); },
    result: { rows: [row()] },
  }]);
  const persistence = new PostgresTextResourcePersistence({ store });
  assert.equal((await persistence.getResource({ workspaceId: resource.workspaceId, resourceId: resource.resourceId, version: resource.version })).resourceId, resource.resourceId);
  store.assertDrained();
});
