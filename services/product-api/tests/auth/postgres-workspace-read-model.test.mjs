import assert from "node:assert/strict";
import test from "node:test";

import { PostgresWorkspaceReadModel } from "../../src/auth/postgres-workspace-read-model.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

function storeWith(steps) {
  const rest = [...steps];
  return {
    async connect() {},
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => { const step = rest.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match); if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [] }; } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(rest.length, 0); },
  };
}

const workspace = { workspace_id: "workspace-alpha", schema_version: "workbench-v1", name: "Team workspace", created_by: "alice", created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:01:00.000Z" };

test("PostgreSQL workspace read model projects the real workspace and active membership without repositories", async () => {
  const store = storeWith([
    { match: /FROM public\.product_workspaces WHERE workspace_id = \$1/, values: ["workspace-alpha"], rows: [workspace] },
    { match: /FROM public\.product_workspaces workspace/, values: ["workspace-alpha", "alice"], rows: [{ workspace_id: "workspace-alpha", workspace_schema_version: "workbench-v1", name: "Team workspace", created_by: "alice", workspace_created_at: "2026-08-10T00:00:00.000Z", workspace_updated_at: "2026-08-10T00:01:00.000Z", membership_id: "membership-alpha", user_id: "alice", role: "owner", membership_created_at: "2026-08-10T00:00:00.000Z", membership_updated_at: "2026-08-10T00:01:00.000Z" }] },
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", 200], rows: [{ membership_id: "membership-alpha", workspace_id: "workspace-alpha", user_id: "alice", role: "owner", created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:01:00.000Z" }] },
  ]);
  const readModel = new PostgresWorkspaceReadModel({ store });
  const actualWorkspace = await readModel.getWorkspace({ workspaceId: "workspace-alpha" });
  const active = await readModel.getActiveSession({ workspaceId: "workspace-alpha", userId: "alice" });
  const memberships = await readModel.listMemberships({ workspaceId: "workspace-alpha" });
  assert.equal(actualWorkspace.name, "Team workspace");
  assert.equal(active.membership.role, "owner");
  assert.equal(memberships[0].membershipId, "membership-alpha");
  store.assertDrained();
});

test("Application workspace and active-session operations consume the injected PostgreSQL read owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {}, clock: () => "2026-08-10T00:02:00.000Z",
    workspaceReadModel: {
      async getWorkspace(input) { calls.push(["workspace", input]); return { workspaceId: "workspace-alpha", name: "Team workspace", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" }; },
      async getActiveSession(input) { calls.push(["active", input]); return { workspace: { schemaVersion: "workbench-v1", workspaceId: "workspace-alpha", name: "Team workspace", createdBy: "alice", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" }, membership: { schemaVersion: "workbench-v1", membershipId: "membership-alpha", workspaceId: "workspace-alpha", userId: "alice", role: "owner", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" } }; },
      async listMemberships(input) { calls.push(["members", input]); return [{ schemaVersion: "workbench-v1", membershipId: "membership-alpha", workspaceId: "workspace-alpha", userId: "alice", role: "owner", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" }]; },
    },
  });
  const auth = { userId: "alice", workspaceId: "workspace-alpha" };
  const [summary, active, memberships] = await Promise.all([application.workspace({ auth }), application.getActiveSession({ auth }), application.listMemberships({ auth })]);
  assert.equal(summary.workspace.name, "Team workspace");
  assert.equal(summary.workspace.createdAt, "2026-08-10T00:00:00.000Z");
  assert.equal(active.membership.membershipId, "membership-alpha");
  assert.equal(memberships.data[0].membershipId, "membership-alpha");
  assert.deepEqual(calls.sort(([left], [right]) => left.localeCompare(right)), [["active", { workspaceId: "workspace-alpha", userId: "alice" }], ["members", { workspaceId: "workspace-alpha", query: {} }], ["workspace", { workspaceId: "workspace-alpha" }]]);
});

test("Application authorization in PostgreSQL composition uses the injected active-membership role, never a browser role claim", async () => {
  const authorizations = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    skillDraftLifecycle: { async createSkill() { throw new Error("must_not_create"); } },
    workspaceAuthorizer: {
      async authorizeWorkspace(input) {
        authorizations.push(input);
        const error = new Error("workspace_role_forbidden");
        error.code = "workspace_role_forbidden";
        throw error;
      },
    },
  });
  await assert.rejects(() => application.createSkill({
    idempotencyKey: "skill-alpha",
    request: { data: { name: "A", description: "B", category: "testing" } },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "owner" },
  }), { code: "workspace_role_forbidden" });
  assert.deepEqual(authorizations, [{
    userId: "alice", workspaceId: "workspace-alpha", minimumRole: "member",
  }]);
});
