import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresWorkflowReadModel } from "../../src/loops/postgres-workflow-read-model.mjs";

function storeWith(steps) {
  const rest = [...steps];
  return {
    async connect() {},
    bindAdapter(factory) {
      return factory({ execute: async (_uow, { text, values }) => {
        const step = rest.shift();
        assert.ok(step, `unexpected query: ${text}`);
        assert.match(text, step.match);
        if (step.values) assert.deepEqual(values, step.values);
        return { rows: step.rows ?? [] };
      } });
    },
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}

const workflow = {
  workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", scope_id: "scope-alpha", owner_user_id: "alice",
  schema_version: "workbench-v1", name: "Weekly review", description: "Review work", status: "draft", lifecycle: "draft",
  visibility: "private", archived: false, current_revision_id: "revision-alpha", current_revision_number: 1, write_version: 1,
  latest_compile_result_id: null, latest_run_id: null, created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z", payload: {},
};
const revision = {
  workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", revision_id: "revision-alpha", revision_number: 1,
  base_revision_id: null, base_revision_number: null, schema_version: "workbench-v1", graph: { nodes: [], edges: [] },
  input_form: { fields: [] }, output_definition: {}, resource_refs: [], run_settings: {}, definition: { objective: "review" },
  content_hash: "sha256:abcdef0123456789", authored_by: "alice", save_reason: "Created from a goal.",
  created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
};

test("PostgreSQL Workflow read model returns canonical Workflow plus its immutable current revision", async () => {
  const store = storeWith([
    { match: /FROM public\.workflows/, values: ["workspace-alpha", "workflow-alpha"], rows: [workflow] },
    { match: /FROM public\.workflow_revisions/, values: ["workspace-alpha", "workflow-alpha", "revision-alpha"], rows: [revision] },
    { match: /FROM public\.compile_results/, values: ["workspace-alpha", "workflow-alpha", "revision-alpha"], rows: [] },
  ]);
  const readModel = new PostgresWorkflowReadModel({ store });
  const result = await readModel.getWorkflow({ workspaceId: "workspace-alpha", workflowId: "workflow-alpha" });
  assert.equal(result.workflow.ownerId, "alice");
  assert.equal(result.revision.revisionId, "revision-alpha");
  assert.equal(result.etag, '"wfv1:workflow-alpha:1:revision-alpha"');
  store.assertDrained();
});

test("Application consumes the injected PostgreSQL Workflow read model instead of Store repositories", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    workflowReadModel: {
      async getWorkflow(input) {
        calls.push(input);
        return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, etag: '"workflow:workflow-alpha:1"' };
      },
    },
  });
  const result = await application.getWorkflow({ workflowId: "workflow-alpha", auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(result.data.workflowId, "workflow-alpha");
  assert.deepEqual(calls, [{ workflowId: "workflow-alpha", workspaceId: "workspace-alpha" }]);
});
