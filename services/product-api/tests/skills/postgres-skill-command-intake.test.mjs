import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSkillCommandIntake } from "../../src/skills/postgres-skill-command-intake.mjs";

function storeWith(steps) {
  const pending = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = pending.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match);
      if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [] };
    } }); },
    async withTransaction(work) { return work({}); },
    assertDrained() { assert.equal(pending.length, 0); },
  };
}

const principal = { workspaceId: "workspace-alpha", userId: "alice" };
const command = {
  commandId: "test-alpha", kind: "skill_test", scopeId: "scope-alpha", authorizationDecisionId: "decision-alpha",
  argumentDigest: `sha256:${"a".repeat(64)}`, sessionId: "draft-alpha", turnId: "test-alpha",
};

test("PostgreSQL Skill command intake consumes one exact skill_test authority and target", async () => {
  const store = storeWith([
    { match: /FROM public\.product_commands/, values: ["workspace-alpha", "test-alpha", "alice", "skill_test"], rows: [] },
    { match: /FROM public\.authorization_decisions/, values: ["workspace-alpha", "decision-alpha", "scope-alpha", "alice", "skill_test", command.argumentDigest, "2026-08-11T00:00:00.000Z"], rows: [{ authorization_decision_id: "decision-alpha", policy_revision_id: "policy-alpha" }] },
    { match: /INSERT INTO public\.product_commands/, rows: [{ command_id: "test-alpha", workspace_id: "workspace-alpha", scope_id: "scope-alpha", quota_user_id: "alice", kind: "skill_test", session_id: "draft-alpha", turn_id: "test-alpha", status: "accepted", invocation_id: null, attempt_id: null, created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", finished_at: null }] },
  ]);
  const intake = new PostgresSkillCommandIntake({ store });
  const result = await intake.accept({ principal, command, at: "2026-08-11T00:00:00.000Z", persistTarget: async ({ command: accepted }) => ({ testRunId: accepted.commandId }) });
  assert.equal(result.command.status, "accepted");
  assert.deepEqual(result.target, { testRunId: "test-alpha" });
  store.assertDrained();
});

test("PostgreSQL Skill command intake rejects an authority whose action differs from its command kind", async () => {
  const store = storeWith([
    { match: /FROM public\.product_commands/, rows: [] },
    { match: /FROM public\.authorization_decisions/, rows: [] },
  ]);
  const intake = new PostgresSkillCommandIntake({ store });
  await assert.rejects(
    () => intake.accept({ principal, command, at: "2026-08-11T00:00:00.000Z", persistTarget: async () => ({}) }),
    (error) => error?.code === "skill_test_authorization_required",
  );
  store.assertDrained();
});

test("PostgreSQL Skill command intake only cancels the exact owned Skill Test after a separate cancellation decision", async () => {
  const current = {
    command_id: "test-alpha", workspace_id: "workspace-alpha", scope_id: "scope-alpha", quota_user_id: "alice",
    kind: "skill_test", session_id: "draft-alpha", turn_id: "test-alpha", status: "running",
    invocation_id: "invocation-alpha", attempt_id: "attempt-alpha", created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z", finished_at: null,
  };
  const store = storeWith([
    { match: /FROM public\.product_commands/, values: ["workspace-alpha", "test-alpha", "alice"], rows: [current] },
    { match: /FROM public\.authorization_decisions/, values: ["workspace-alpha", "cancel-decision-alpha", "scope-alpha", "alice", `sha256:${"c".repeat(64)}`, "2026-08-11T00:01:00.000Z"], rows: [{ authorization_decision_id: "cancel-decision-alpha" }] },
    { match: /UPDATE public\.product_commands SET status = 'cancellation_requested'/, values: ["workspace-alpha", "test-alpha", "alice", "2026-08-11T00:01:00.000Z"], rows: [{ ...current, status: "cancellation_requested", updated_at: "2026-08-11T00:01:00.000Z" }] },
  ]);
  const intake = new PostgresSkillCommandIntake({ store });
  const result = await intake.requestCancellation({
    principal,
    commandId: "test-alpha",
    authorizationDecisionId: "cancel-decision-alpha",
    argumentDigest: `sha256:${"c".repeat(64)}`,
    at: "2026-08-11T00:01:00.000Z",
  });
  assert.equal(result.status, "cancellation_requested");
  store.assertDrained();
});
