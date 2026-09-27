import assert from "node:assert/strict";
import test from "node:test";

import { PostgresLoopDraftLifecycle } from "../../src/loops/postgres-loop-draft-lifecycle.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

test("publishing a tested Loop fixes shared Skill and resource versions without copying credentials", async () => {
  const writes = [];
  const hash = `sha256:${"a".repeat(64)}`;
  const store = {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      if (/^(INSERT|UPDATE)/.test(text.trim())) { writes.push({ text, values }); return { rows: [], rowCount: 1 }; }
      const row = text.includes("public.workspace_memberships") ? { role: "member" }
        : text.includes("public.product_idempotency_receipts") ? null
        : text.includes("public.workflows") ? { owner_user_id: "alice", current_revision_id: "revision-alpha", write_version: 1, visibility: "private", lifecycle: "ready", status: "ready", latest_compile_result_id: "compile-alpha", workflow_id: "workflow-alpha" }
        : text.includes("public.workflow_revisions") ? { definition: {}, content_hash: hash, graph: { nodes: [{ kind: "Skill", skillRef: { skillId: "skill-alpha", version: "1.0.0" } }] }, resource_refs: [{ resourceId: "resource-alpha", version: "1.0.0", contentHash: hash }] }
        : text.includes("public.skill_versions") ? { workspace_id: "workspace-alpha", skill_id: "skill-alpha", skill_version_id: "skill-version-alpha", version: "1.0.0", content_hash: hash, schema_version: "workbench-v1", owner_user_id: "alice", visibility: "workspace", lifecycle: "published", latest_published_version_id: "skill-version-alpha", workspace_released: true, published_at: "2026-09-22T00:00:00Z", capability_id: "summarize", definition: { name: "Summary", dependencies: [], connectionRequirements: [] } }
        : text.includes("public.workspace_resources") ? { resource_id: "resource-alpha", resource_version: "1.0.0", content_hash: hash, label: "Team notes", readiness_status: "ready", object_state: "promoted" }
        : text.includes("public.compile_results") ? { compile_result_id: "compile-alpha", execution_plan_id: "plan-alpha" }
        : text.includes("public.execution_plans") ? { plan_id: "plan-alpha", pins_finalized: true, plan_document: { pinnedSkills: [{ skillId: "skill-alpha", version: "1.0.0" }], steps: [] } }
        : text.includes("public.workflow_runs") ? { run_id: "run-alpha" }
        : text.includes("public.loop_versions") ? null
        : (() => { throw new Error(`unexpected query: ${text}`); })();
      return { rows: row ? [row] : [] };
    } }); },
    async withTransaction(work) { return work({}); },
  };
  const lifecycle = new PostgresLoopDraftLifecycle({ store, idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.publishLoop({ workflowId: "workflow-alpha", workspaceId: "workspace-alpha", releasedBy: "alice", idempotencyKey: "publish-alpha", ifMatch: '"wfv1:workflow-alpha:1:revision-alpha"', request: { data: { version: "1.0.0", releaseNotes: "Shared team method", startingPoint: true } } });
  assert.deepEqual(result.loopVersion.pinnedSkills, [{ skillId: "skill-alpha", version: "1.0.0" }]);
  assert.equal(result.loopVersion.workspaceId, "workspace-alpha");
  assert.equal(result.release.sourceWorkspaceId, "workspace-alpha");
  assert.deepEqual(result.release.dependencies, [{ kind: "skill", id: "skill-alpha", version: "1.0.0", required: true }, { kind: "resource", id: "resource-alpha", version: "1.0.0", required: true }]);
  assert.ok(writes.some(({ text, values }) => text.includes("INSERT INTO public.loop_version_skill_pins") && values.includes("skill-version-alpha") && values.includes(hash)));
  assert.ok(writes.some(({ text, values }) => text.includes("INSERT INTO public.loop_version_resource_pins") && values.includes("resource-alpha") && values.includes(hash)));
});

function storeWith(steps) {
  const rest = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => { const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [], rowCount: step.rowCount ?? 1 }; } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}
const request = { data: { name: "Weekly review", description: "Review work", definition: { objective: "review" } } };

test("PostgreSQL blank Loop creation persists private Workflow and immutable revision atomically", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "create-loop-alpha"], rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /FROM public\.product_scopes/, values: ["workspace-alpha", "alice"], rows: [{ scope_id: "scope-alpha" }] },
    { match: /^SET CONSTRAINTS ALL DEFERRED$/ },
    { match: /INSERT INTO public\.workflows/ },
    { match: /INSERT INTO public\.workflow_revisions/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, clock: () => "2026-08-10T00:00:00.000Z", idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.createLoop({ idempotencyKey: "create-loop-alpha", request, workspaceId: "workspace-alpha", authoredBy: "alice" });
  assert.equal(result.workflow.workflowId, "workflow-alpha");
  assert.equal(result.workflow.currentRevisionId, "revision-alpha");
  assert.equal(result.revision.graph.nodes.length, 2);
  store.assertDrained();
});

test("PostgreSQL blank Loop creation rejects idempotency reuse before writing a second Workflow", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "create-loop-alpha"], rows: [{ request_hash: "sha256:other", response: {} }] },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, idFactory: (kind) => kind });
  await assert.rejects(lifecycle.createLoop({ idempotencyKey: "create-loop-alpha", request, workspaceId: "workspace-alpha", authoredBy: "alice" }), (error) => error?.code === "idempotency_key_reused");
  store.assertDrained();
});

test("Application opens the blank Loop path through the injected PostgreSQL lifecycle", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    loopDraftLifecycle: { calls, async createLoop(input) { this.calls.push(input); return { workflow: { workflowId: "workflow-alpha" }, revision: { revisionId: "revision-alpha" } }; } },
  });
  const result = await application.createLoop({
    idempotencyKey: "create-loop-alpha", request, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authoredBy, "alice");
  assert.equal(result.workflow.workflowId, "workflow-alpha");
});

test("PostgreSQL Loop lifecycle atomically advances an owned blank Draft revision", async () => {
  const updateRequest = { data: { baseRevisionId: "revision-alpha", graph: { nodes: [], edges: [] }, inputForm: { fields: [] }, outputDefinition: {}, resourceRefs: [], runSettings: {}, saveReason: "Builder edit" } };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "save-workflow-revision:workflow-alpha", "save-loop-alpha"], rows: [] },
    { match: /FROM public\.workflows/, values: ["workspace-alpha", "workflow-alpha"], rows: [{ workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", scope_id: "scope-alpha", owner_user_id: "alice", schema_version: "workbench-v1", name: "Weekly review", description: "", status: "draft", lifecycle: "draft", visibility: "private", archived: false, current_revision_id: "revision-alpha", current_revision_number: 1, write_version: 1, created_at: "2026-08-10T00:00:00.000Z" }] },
    { match: /FROM public\.workflow_revisions/, values: ["workspace-alpha", "workflow-alpha", "revision-alpha"], rows: [{ revision_number: 1 }] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /^SET CONSTRAINTS ALL DEFERRED$/ },
    { match: /INSERT INTO public\.workflow_revisions/ },
    { match: /UPDATE public\.workflows/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, clock: () => "2026-08-10T00:00:00.000Z", idFactory: (kind) => `${kind}-next` });
  const result = await lifecycle.saveWorkflowRevision({ workflowId: "workflow-alpha", workspaceId: "workspace-alpha", authoredBy: "alice", idempotencyKey: "save-loop-alpha", ifMatch: '"wfv1:workflow-alpha:1:revision-alpha"', request: updateRequest });
  assert.equal(result.workflow.currentRevisionId, "revision-next");
  assert.equal(result.revision.revisionNumber, 2);
  store.assertDrained();
});

test("PostgreSQL Loop lifecycle refuses a nonexistent Skill version without saving", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.workflows/, rows: [{ workflow_id: "workflow-alpha", owner_user_id: "alice", visibility: "private", current_revision_id: "revision-alpha", write_version: 1 }] },
    { match: /FROM public\.workflow_revisions/, rows: [{ revision_number: 1 }] },
    { match: /FROM public\.skill_versions version/, rows: [] },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, idFactory: (kind) => kind });
  await assert.rejects(
    lifecycle.saveWorkflowRevision({ workflowId: "workflow-alpha", workspaceId: "workspace-alpha", authoredBy: "alice", idempotencyKey: "save-loop-alpha", ifMatch: '"wfv1:workflow-alpha:1:revision-alpha"', request: { data: { baseRevisionId: "revision-alpha", graph: { nodes: [{ kind: "Skill", skillRef: { skillId: "skill-missing", version: "1.0.0" } }] }, inputForm: {}, outputDefinition: {}, resourceRefs: [], runSettings: {} } } }),
    (error) => error?.code === "skill_version_not_found",
  );
  store.assertDrained();
});

test("Application saves a blank Loop revision through the injected PostgreSQL lifecycle", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    workflowReadModel: { async getWorkflow() { return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private" }, etag: '"wfv1:workflow-alpha:1:revision-alpha"' }; } },
    loopDraftLifecycle: { calls, async saveWorkflowRevision(input) { this.calls.push(input); return { workflow: { workflowId: "workflow-alpha" }, revision: { revisionId: "revision-next" }, etag: '"wfv1:workflow-alpha:2:revision-next"' }; } },
  });
  const result = await application.saveWorkflowRevision({
    workflowId: "workflow-alpha", idempotencyKey: "save-loop-alpha", ifMatch: '"wfv1:workflow-alpha:1:revision-alpha"',
    request: { data: { baseRevisionId: "revision-alpha", graph: { nodes: [], edges: [] }, inputForm: { fields: [] }, outputDefinition: {}, resourceRefs: [], runSettings: {} } },
    auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls[0].authoredBy, "alice");
  assert.equal(result.etag, '"wfv1:workflow-alpha:2:revision-next"');
});

test("PostgreSQL Loop lifecycle publishes a dependency-free compiled-and-tested private Loop atomically", async () => {
  const publishRequest = { data: { version: "1.0.0", releaseNotes: "Initial release", startingPoint: true } };
  const workflow = { workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", owner_user_id: "alice", scope_id: "scope-alpha", current_revision_id: "revision-alpha", current_revision_number: 1, write_version: 2, lifecycle: "ready", status: "ready", visibility: "private", latest_compile_result_id: "compile-alpha", schema_version: "workbench-v1", created_at: "2026-08-10T00:00:00.000Z" };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, values: ["workspace-alpha", "alice", "publish-loop:workflow-alpha", "publish-loop-alpha"], rows: [] },
    { match: /FROM public\.workflows/, values: ["workspace-alpha", "workflow-alpha"], rows: [workflow] },
    { match: /FROM public\.workflow_revisions/, values: ["workspace-alpha", "workflow-alpha", "revision-alpha"], rows: [{ revision_id: "revision-alpha", content_hash: "sha256:aaaaaaaaaaaaaaaa", definition: { objective: "review" }, resource_refs: [], graph: { nodes: [] } }] },
    { match: /FROM public\.compile_results/, values: ["workspace-alpha", "compile-alpha", "workflow-alpha", "revision-alpha"], rows: [{ compile_result_id: "compile-alpha", execution_plan_id: "plan-alpha" }] },
    { match: /FROM public\.execution_plans/, values: ["workspace-alpha", "plan-alpha", "compile-alpha", "workflow-alpha", "revision-alpha"], rows: [{ plan_id: "plan-alpha", content_hash: "sha256:bbbbbbbbbbbbbbbb", pins_finalized: true, plan_document: { pinnedSkills: [], steps: [] } }] },
    { match: /FROM public\.workflow_runs/, values: ["workspace-alpha", "workflow-alpha", "revision-alpha", "compile-alpha", "plan-alpha"], rows: [{ run_id: "run-alpha" }] },
    { match: /FROM public\.loop_versions/, values: ["workspace-alpha", "workflow-alpha", "1.0.0"], rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /INSERT INTO public\.loop_versions/ },
    { match: /UPDATE public\.loop_versions SET pins_finalized = true/ },
    { match: /INSERT INTO public\.workspace_asset_releases/ },
    { match: /UPDATE public\.workflows SET visibility = 'workspace'/ },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, clock: () => "2026-08-11T00:00:00.000Z", idFactory: (kind) => `${kind}-alpha` });
  const result = await lifecycle.publishLoop({ workflowId: "workflow-alpha", idempotencyKey: "publish-loop-alpha", ifMatch: '"wfv1:workflow-alpha:2:revision-alpha"', request: publishRequest, workspaceId: "workspace-alpha", releasedBy: "alice" });
  assert.equal(result.loopVersion.loopVersionId, "loop-version-alpha");
  assert.equal(result.release.releaseId, "release-alpha");
  assert.equal(result.release.startingPoint, true);
  store.assertDrained();
});

test("PostgreSQL Loop publication rejects a missing Skill version before publication writes", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.workflows/, rows: [{ workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", owner_user_id: "alice", current_revision_id: "revision-alpha", write_version: 1, lifecycle: "ready", status: "ready", visibility: "private", latest_compile_result_id: "compile-alpha" }] },
    { match: /FROM public\.workflow_revisions/, rows: [{ definition: { objective: "review" }, resource_refs: [], graph: { nodes: [{ kind: "Skill" }] } }] },
    { match: /FROM public\.compile_results/, rows: [{ compile_result_id: "compile-alpha", execution_plan_id: "plan-alpha" }] },
    { match: /FROM public\.execution_plans/, rows: [{ plan_id: "plan-alpha", pins_finalized: true, plan_document: { pinnedSkills: [], steps: [] } }] },
    { match: /FROM public\.skill_versions/, rows: [] },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, idFactory: (kind) => kind });
  await assert.rejects(
    lifecycle.publishLoop({ workflowId: "workflow-alpha", idempotencyKey: "publish-loop-alpha", ifMatch: '"wfv1:workflow-alpha:1:revision-alpha"', request: { data: { version: "1.0.0", releaseNotes: "", startingPoint: false } }, workspaceId: "workspace-alpha", releasedBy: "alice" }),
    (error) => error?.code === "skill_version_not_found",
  );
  store.assertDrained();
});

test("PostgreSQL Loop publication refuses a late shared-state CAS before returning a release", async () => {
  const publishRequest = { data: { version: "1.0.0", releaseNotes: "Initial release", startingPoint: false } };
  const workflow = { workspace_id: "workspace-alpha", workflow_id: "workflow-alpha", owner_user_id: "alice", current_revision_id: "revision-alpha", current_revision_number: 1, write_version: 2, lifecycle: "ready", status: "ready", visibility: "private", latest_compile_result_id: "compile-alpha", schema_version: "workbench-v1", created_at: "2026-08-10T00:00:00.000Z" };
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /FROM public\.workflows/, rows: [workflow] },
    { match: /FROM public\.workflow_revisions/, rows: [{ content_hash: "sha256:aaaaaaaaaaaaaaaa", definition: { objective: "review" }, resource_refs: [], graph: { nodes: [] } }] },
    { match: /FROM public\.compile_results/, rows: [{ compile_result_id: "compile-alpha", execution_plan_id: "plan-alpha" }] },
    { match: /FROM public\.execution_plans/, rows: [{ plan_id: "plan-alpha", pins_finalized: true, plan_document: { pinnedSkills: [], steps: [] } }] },
    { match: /FROM public\.workflow_runs/, rows: [{ run_id: "run-alpha" }] },
    { match: /FROM public\.loop_versions/, rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /INSERT INTO public\.loop_versions/ },
    { match: /UPDATE public\.loop_versions SET pins_finalized = true/ },
    { match: /INSERT INTO public\.workspace_asset_releases/ },
    { match: /UPDATE public\.workflows SET visibility = 'workspace'/, rowCount: 0 },
  ]);
  const lifecycle = new PostgresLoopDraftLifecycle({ store, idFactory: (kind) => `${kind}-alpha` });
  await assert.rejects(
    lifecycle.publishLoop({ workflowId: "workflow-alpha", idempotencyKey: "publish-loop-alpha", ifMatch: '"wfv1:workflow-alpha:2:revision-alpha"', request: publishRequest, workspaceId: "workspace-alpha", releasedBy: "alice" }),
    (error) => error?.code === "workflow_revision_conflict",
  );
  store.assertDrained();
});

test("Application publishes through the PostgreSQL Loop lifecycle instead of the legacy Store", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    workflowReadModel: { async getWorkflow() { return { workflow: { workflowId: "workflow-alpha", workspaceId: "workspace-alpha", ownerId: "alice", visibility: "private", lifecycle: "ready", status: "ready" } }; } },
    loopDraftLifecycle: { calls, async publishLoop(input) { this.calls.push(input); return { loopVersion: { loopVersionId: "loop-version-alpha" }, release: { releaseId: "release-alpha" } }; } },
  });
  const result = await application.publishLoop({
    workflowId: "workflow-alpha", idempotencyKey: "publish-loop-alpha", ifMatch: '"wfv1:workflow-alpha:2:revision-alpha"', request: { data: { version: "1.0.0", releaseNotes: "Initial", startingPoint: false } }, auth: { userId: "alice", workspaceId: "workspace-alpha" },
  });
  assert.equal(calls[0].releasedBy, "alice");
  assert.equal(result.release.releaseId, "release-alpha");
});
