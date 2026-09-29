import assert from "node:assert/strict";
import test from "node:test";
import { PostgresInboxReadModel } from "../../src/inbox/postgres-inbox-read-model.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

function storeWith(steps) { const rest = [...steps]; return { bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => { const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [] }; } }); }, async withTransaction(work) { return work({}); }, assertDrained() { assert.equal(rest.length, 0); } }; }
const row = { inbox_item_id: "inbox-alpha", workspace_id: "workspace-alpha", target_kind: "workflow_run", target_id: "run-alpha", workflow_id: "loop-alpha", reason_code: "run_failed", severity: "critical", title: "Run failed", created_at: "2026-08-10T00:00:00.000Z" };

test("PostgreSQL Inbox reads recipient-scoped governed items with a stable keyset cursor", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ "?column?": 1 }] },
    { match: /count\(\*\)::int AS count/, values: ["workspace-alpha", "alice"], rows: [{ count: 1 }] },
    { match: /FROM public\.inbox_items/, values: ["workspace-alpha", "alice", null, null, 2], rows: [row] },
  ]);
  const model = new PostgresInboxReadModel({ store });
  const result = await model.list({ workspaceId: "workspace-alpha", userId: "alice", query: { limit: 1 } });
  assert.equal(result.data.count, 1); assert.equal(result.data.items[0].objectKind, "run");
  assert.equal(result.data.items[0].actionRoute, "/loops/loop-alpha/runs/run-alpha");
  store.assertDrained();
});

test("PostgreSQL Inbox maps a durable Automation occurrence to the public Automation surface", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ "?column?": 1 }] },
    { match: /count\(\*\)::int AS count/, values: ["workspace-alpha", "alice"], rows: [{ count: 1 }] },
    { match: /FROM public\.inbox_items/, values: ["workspace-alpha", "alice", null, null, 2], rows: [{ ...row, target_kind: "automation_occurrence", target_id: "occurrence-alpha", automation_id: "automation-alpha", reason_code: "automation_attention", severity: "error" }] },
  ]);
  const model = new PostgresInboxReadModel({ store });
  const result = await model.list({ workspaceId: "workspace-alpha", userId: "alice", query: { limit: 1 } });
  assert.deepEqual(result.data.items[0], {
    schemaVersion: "workbench-v1", itemId: "inbox-alpha", workspaceId: "workspace-alpha",
    objectKind: "automation", objectId: "occurrence-alpha", reason: "run_blocked", severity: "critical",
    title: "Run failed", actionRoute: "/automations?automationId=automation-alpha&occurrenceId=occurrence-alpha",
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  store.assertDrained();
});

test("PostgreSQL Inbox fails closed when a stored workflow item cannot resolve its Product route", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ "?column?": 1 }] },
    { match: /count\(\*\)::int AS count/, values: ["workspace-alpha", "alice"], rows: [{ count: 1 }] },
    { match: /FROM public\.inbox_items/, values: ["workspace-alpha", "alice", null, null, 2], rows: [{ ...row, workflow_id: null }] },
  ]);
  const model = new PostgresInboxReadModel({ store });
  await assert.rejects(model.list({ workspaceId: "workspace-alpha", userId: "alice", query: { limit: 1 } }), { code: "inbox_workflow_route_unresolved" });
  store.assertDrained();
});

test("PostgreSQL Inbox fails closed when an Automation occurrence cannot resolve its owning Automation", async () => {
  const store = storeWith([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ "?column?": 1 }] },
    { match: /count\(\*\)::int AS count/, values: ["workspace-alpha", "alice"], rows: [{ count: 1 }] },
    { match: /FROM public\.inbox_items/, values: ["workspace-alpha", "alice", null, null, 2], rows: [{ ...row, target_kind: "automation_occurrence", target_id: "occurrence-alpha", automation_id: null, reason_code: "automation_attention", severity: "error" }] },
  ]);
  const model = new PostgresInboxReadModel({ store });
  await assert.rejects(model.list({ workspaceId: "workspace-alpha", userId: "alice", query: { limit: 1 } }), { code: "inbox_automation_route_unresolved" });
  store.assertDrained();
});

test("Application consumes the injected PostgreSQL Inbox read model instead of repository aggregation", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    inboxReadModel: { async list(input) { calls.push(input); return { data: { items: [], count: 0, page: { nextCursor: null, hasMore: false } } }; } },
  });
  await application.getInbox({ query: { limit: 10 }, auth: { userId: "alice", workspaceId: "workspace-alpha" } });
  assert.deepEqual(calls, [{ workspaceId: "workspace-alpha", userId: "alice", query: { limit: 10 } }]);
});
