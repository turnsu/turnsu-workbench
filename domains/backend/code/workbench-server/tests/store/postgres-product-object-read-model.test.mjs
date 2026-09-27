import assert from "node:assert/strict";
import test from "node:test";

import { PostgresProductObjectReadModel } from "../../src/store/postgres/postgres-product-object-read-model.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

function storeWith(steps) {
  const pending = [...steps];
  return {
    async connect() {},
    bindAdapter(factory) {
      return factory({ execute: async (_uow, { text, values }) => {
        const step = pending.shift();
        assert.ok(step, `unexpected query: ${text}`);
        assert.match(text, step.match);
        assert.deepEqual(values, step.values);
        return { rows: step.rows };
      } });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(pending.length, 0); },
  };
}

const row = {
  schema_version: "workbench-v1",
  object_id: "object-attachment-1",
  workspace_id: "workspace-alpha",
  content_hash: `sha256:${"a".repeat(64)}`,
  size_bytes: "42",
  media_type: "text/markdown",
  created_at: "2026-08-10T00:00:00.000Z",
};

test("PostgreSQL product-object read model exposes only the public object metadata contract", async () => {
  const store = storeWith([{
    match: /FROM public\.product_objects[\s\S]*state <> 'deleted'/,
    values: ["workspace-alpha", "object-attachment-1"],
    rows: [row],
  }]);
  const readModel = new PostgresProductObjectReadModel({ store });
  const object = await readModel.getObject({ workspaceId: "workspace-alpha", objectId: "object-attachment-1" });
  assert.deepEqual(object, {
    schemaVersion: "workbench-v1",
    objectId: "object-attachment-1",
    workspaceId: "workspace-alpha",
    contentHash: `sha256:${"a".repeat(64)}`,
    sizeBytes: 42,
    mediaType: "text/markdown",
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  assert.equal("storageKey" in object, false);
  store.assertDrained();
});

test("Application object reads consume the injected PostgreSQL owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    objectReadModel: {
      async getObject(input) {
        calls.push(input);
        return {
          schemaVersion: "workbench-v1", objectId: input.objectId, workspaceId: input.workspaceId,
          contentHash: `sha256:${"b".repeat(64)}`, sizeBytes: 1,
          mediaType: "text/plain", createdAt: "2026-08-10T00:00:00.000Z",
        };
      },
    },
  });
  const object = await application.getObject({
    objectId: "object-attachment-2",
    auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(object.objectId, "object-attachment-2");
  assert.deepEqual(calls, [{ workspaceId: "workspace-alpha", objectId: "object-attachment-2" }]);
});
