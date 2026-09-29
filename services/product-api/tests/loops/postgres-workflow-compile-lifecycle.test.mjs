import assert from "node:assert/strict";
import test from "node:test";

import { PostgresWorkflowCompileLifecycle } from "../../src/loops/postgres-workflow-compile-lifecycle.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

function storeWith(steps) {
  const rest = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => { const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [] }; } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}

const textSchema = { type: "string", minLength: 1, maxLength: 10000 };
const revision = {
  schema_version: "workbench-v1", revision_id: "revision-alpha", workflow_id: "workflow-alpha", revision_number: 1,
  base_revision_id: null, base_revision_number: null,
  graph: { nodes: [
    { nodeId: "node-input", title: "Goal", description: "The outcome this Loop should produce.", position: { x: 0, y: 0 }, inputPorts: [], outputPorts: [{ portId: "goal", name: "Goal", schema: textSchema, required: true }], inputBindings: [], reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 60, display: { collapsed: false }, kind: "Input", configuration: { fieldIds: ["goal"] } },
    { nodeId: "node-output", title: "Result", description: "The current Loop result.", position: { x: 420, y: 0 }, inputPorts: [{ portId: "result", name: "Result", schema: textSchema, required: true }], outputPorts: [{ portId: "result", name: "Result", schema: textSchema, required: true }], inputBindings: [{ targetPort: "result", source: { kind: "nodeOutput", nodeId: "node-input", portId: "goal" } }], reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 60, display: { collapsed: false }, kind: "Output", configuration: { format: "markdown" } },
  ], edges: [{ edgeId: "edge-input-output", sourceNodeId: "node-input", sourcePort: "goal", targetNodeId: "node-output", targetPort: "result" }] },
  input_form: { fields: [{ fieldId: "goal", label: "Goal", description: "What should this Loop produce?", schema: textSchema, required: true }] },
  output_definition: { primary: { nodeId: "node-output", portId: "result" }, expectedOutputs: [{ nodeId: "node-output", portId: "result", label: "Result", mediaType: "text/markdown" }] },
  resource_refs: [], run_settings: { maxParallelism: 1, defaultTimeoutSeconds: 60, workflowFallbackAllowed: false }, definition: { goal: "Review", context: "", constraints: [], doneWhen: [], verify: [], expectedResult: "Review summary", stopRules: [] }, content_hash: "sha256:abcdef0123456789", authored_by: "alice", save_reason: "Created from a goal.", created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
};

test("PostgreSQL compile lifecycle atomically records and finalizes a blank Loop plan", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "compile-workflow:workflow-alpha", "compile-alpha"], rows: [] },
    { match: /FROM public\.workflows/, values: ["workspace-alpha", "workflow-alpha"], rows: [{ workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", owner_user_id: "alice", current_revision_id: "revision-alpha" }] },
    { match: /FROM public\.workflow_revisions/, values: ["workspace-alpha", "workflow-alpha", "revision-alpha"], rows: [revision] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /SET CONSTRAINTS ALL DEFERRED/ },
    { match: /INSERT INTO public\.compile_results/ },
    { match: /INSERT INTO public\.execution_plans/ },
    { match: /UPDATE public\.execution_plans SET pins_finalized = true/ },
    { match: /UPDATE public\.workflows SET status/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresWorkflowCompileLifecycle({ store, clock: () => "2026-08-10T00:03:00.000Z", idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.compileWorkflow({ workflowId: "workflow-alpha", revisionId: "revision-alpha", idempotencyKey: "compile-alpha", request: { data: { workflowRevisionId: "revision-alpha" } }, workspaceId: "workspace-alpha", compiledBy: "alice" });
  assert.equal(result.status, "ready", JSON.stringify(result.warnings));
  assert.equal(result.compileResultId, "compile-result-alpha");
  assert.equal(result.executionPlanId, "plan-alpha");
  store.assertDrained();
});

test("PostgreSQL compile lifecycle refuses a revision whose pinned Skill version does not exist", async () => {
  const dependencyRevision = { ...revision, graph: { ...revision.graph, nodes: [...revision.graph.nodes, { kind: "Skill", skillRef: { skillId: "skill-alpha", version: "1.0.0" } }] } };
  const lifecycle = new PostgresWorkflowCompileLifecycle({
    store: storeWith([
      { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
      { match: /FROM public\.product_idempotency_receipts/, rows: [] },
      { match: /FROM public\.workflows/, rows: [{ owner_user_id: "alice", current_revision_id: "revision-alpha" }] },
      { match: /FROM public\.workflow_revisions/, rows: [dependencyRevision] },
      { match: /FROM public\.skill_versions version/, rows: [] },
    ]),
    idFactory: (kind) => kind,
  });
  await assert.rejects(
    lifecycle.compileWorkflow({ workflowId: "workflow-alpha", revisionId: "revision-alpha", idempotencyKey: "compile-alpha", request: { data: { workflowRevisionId: "revision-alpha" } }, workspaceId: "workspace-alpha", compiledBy: "alice" }),
    (error) => error?.code === "skill_version_not_found",
  );
});

test("Application compiles through the injected PostgreSQL lifecycle rather than a Store mutation", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    workflowReadModel: { async getWorkflow() { return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, etag: '"wfv1:workflow-alpha:1:revision-alpha"' }; } },
    workflowCompileLifecycle: { async compileWorkflow(input) { calls.push(input); return { status: "ready", workflowId: "workflow-alpha", workflowRevisionId: "revision-alpha" }; } },
  });
  const result = await application.compileWorkflow({ workflowId: "workflow-alpha", idempotencyKey: "compile-alpha", request: { data: { workflowRevisionId: "revision-alpha" } }, auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].compiledBy, "alice");
  assert.equal(result.status, "ready");
});
