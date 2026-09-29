import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAgentObjectBaseVersionResolver } from "../../src/agents/index.mjs";

const HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function storeFor(step) {
  let pending = step;
  return {
    bindAdapter(factory) {
      return factory({
        execute: async (_uow, { text, values }) => {
          assert.ok(pending, `unexpected PostgreSQL query: ${text}`);
          assert.match(text, pending.match);
          assert.deepEqual(values, pending.values);
          const result = pending.rows;
          pending = null;
          return { rows: result };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(pending, null); },
  };
}

test("Module Agent resolves a canonical Workflow revision through the PostgreSQL object boundary", async () => {
  const store = storeFor({
    match: /FROM public\.workflows workflow[\s\S]*revision\.revision_id = workflow\.current_revision_id/,
    values: ["workspace-alpha", "workflow-alpha"],
    rows: [{
      workflow_id: "workflow-alpha", revision_id: "workflow-revision-2", revision_number: 2,
      schema_version: "workbench-v1", base_revision_id: "workflow-revision-1", content_hash: HASH,
      graph: { nodes: [] }, input_form: {}, output_definition: {}, resource_refs: [], run_settings: {},
      definition: { label: "Workflow" }, authored_by: "user-alpha", save_reason: "Updated.",
      compile_status: "ready", compile_warnings: [],
      created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
    }],
  });
  const resolve = createPostgresAgentObjectBaseVersionResolver({ store });
  assert.deepEqual(await resolve({
    objectKind: "workflow", objectId: "workflow-alpha", workspaceId: "workspace-alpha",
  }), {
    baseVersionId: "workflow-revision-2",
    baseSnapshot: {
      schemaVersion: "workbench-v1", workflowId: "workflow-alpha", revisionId: "workflow-revision-2",
      revisionNumber: 2, baseRevisionId: "workflow-revision-1", contentHash: HASH,
      graph: { nodes: [] }, inputForm: {}, outputDefinition: {}, resourceRefs: [], runSettings: {},
      definition: { label: "Workflow" }, authoredBy: "user-alpha", saveReason: "Updated.",
      compile: { status: "ready", diagnostics: [] },
      createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  store.assertDrained();
});

test("Module Agent resolves a private Skill Draft revision without Mongo repositories", async () => {
  const store = storeFor({
    match: /FROM public\.skill_drafts/,
    values: ["workspace-alpha", "draft-alpha"],
    rows: [{
      schema_version: "workbench-v1", skill_draft_id: "draft-alpha", skill_id: "skill-alpha",
      base_version_id: null, draft_revision: 4, content_hash: HASH, definition: { name: "Summarize" },
      package_object_id: null, package_object_kind: null, package_object_hash: null, package_hash: null,
      created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
    }],
  });
  const resolve = createPostgresAgentObjectBaseVersionResolver({ store });
  const resolved = await resolve({
    objectKind: "skill_draft", objectId: "draft-alpha", workspaceId: "workspace-alpha",
  });
  assert.equal(resolved.baseVersionId, "draft-alpha:4");
  assert.equal(resolved.baseSnapshot.skillDraftId, "draft-alpha");
  assert.equal(resolved.baseSnapshot.revision, 4);
  assert.equal(resolved.baseSnapshot.name, "Summarize");
  store.assertDrained();
});
