import assert from "node:assert/strict";
import test from "node:test";

import { ObjectAccessPolicy, createPostgresAgentObjectAuthorizer } from "../../src/authorization/index.mjs";

function scriptedStore(steps) {
  const remaining = [...steps];
  return {
    bindAdapter(factory) {
      return factory({
        execute: async (_uow, { text, values }) => {
          const step = remaining.shift();
          assert.ok(step, `unexpected PostgreSQL query: ${text}`);
          assert.match(text, step.match);
          assert.deepEqual(values, step.values);
          return { rows: step.rows ?? [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(remaining.length, 0); },
  };
}

const membership = { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "bob"], rows: [{ role: "member" }] };
const workflow = { match: /FROM public\.workflows/, values: ["workspace-alpha", "workflow-private"], rows: [{ workspace_id: "workspace-alpha", owner_user_id: "alice", visibility: "private" }] };

test("PostgreSQL Module Agent authorization consumes canonical membership, object, and active grants", async () => {
  const store = scriptedStore([
    membership,
    workflow,
    { match: /FROM public\.object_access_grants/, values: ["workspace-alpha", "workflow", "workflow-private", "bob"], rows: [{ principal_id: "bob", role: "reviewer", capabilities: [] }] },
  ]);
  const authorize = createPostgresAgentObjectAuthorizer({ store, objectAccessPolicy: new ObjectAccessPolicy() });
  assert.equal(await authorize({
    objectKind: "workflow", objectId: "workflow-private", userId: "bob", workspaceId: "workspace-alpha",
  }), true);
  store.assertDrained();
});

test("PostgreSQL Module Agent authorization fails closed after a grant is revoked", async () => {
  const store = scriptedStore([
    membership,
    workflow,
    { match: /FROM public\.object_access_grants/, values: ["workspace-alpha", "workflow", "workflow-private", "bob"], rows: [] },
  ]);
  const authorize = createPostgresAgentObjectAuthorizer({ store, objectAccessPolicy: new ObjectAccessPolicy() });
  await assert.rejects(
    authorize({ objectKind: "workflow", objectId: "workflow-private", userId: "bob", workspaceId: "workspace-alpha" }),
    (error) => error?.code === "agent_object_forbidden" && error?.status === "permission_denied",
  );
  store.assertDrained();
});
