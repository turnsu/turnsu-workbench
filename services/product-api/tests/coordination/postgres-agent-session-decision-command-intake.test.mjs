import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresAgentCommandAuthorizer,
  PostgresAgentSessionDecisionCommandIntake,
} from "../../src/coordination/index.mjs";

const NOW = "2026-08-12T03:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function storeWith(execute) {
  return {
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    bindAdapter(factory) { return factory({ execute }); },
  };
}

test("Session decision authorizations bind the exact target revision through the interactive human approval path", async () => {
  const calls = [];
  const store = storeWith(async (_uow, { text, values }) => {
    calls.push({ text, values });
    if (text.includes("FROM public.product_scopes")) {
      return { rows: [{
        scope_id: "scope-alpha", current_policy_revision_id: "policy-alpha", permission_mode: "interactive",
        auto_approved_effect_classes: [], auto_approved_action_ids: [], grant_id: "grant-alpha",
      }] };
    }
    if (text.includes("clock_timestamp")) return { rows: [{ now: NOW }] };
    if (text.includes("INSERT INTO public.authorization_decisions")) return { rows: [] };
    throw new Error(`unexpected_query:${text}`);
  });
  const authorizer = new PostgresAgentCommandAuthorizer({
    store, idFactory: (kind) => `${kind}-alpha`,
  });
  const authority = await authorizer.authorizeAgentProposalApply({
    workspaceId: "workspace-alpha", userId: "alice", sessionId: "session-alpha",
    proposalId: "proposal-alpha", targetRevision: 7,
  });
  assert.match(authority.argumentDigest, /^sha256:[a-f0-9]{64}$/);
  const decisions = calls.filter(({ text }) => text.includes("INSERT INTO public.authorization_decisions"));
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every(({ values }) => values.includes("agent_proposal_apply")));
  assert.ok(decisions.every(({ values }) => values.includes("interactive")));
});

test("Session decision Command Intake completes one authorized handoff target in its insertion transaction", async () => {
  const calls = [];
  const store = storeWith(async (_uow, { text, values }) => {
    calls.push({ text, values });
    if (text.includes("FROM public.product_commands") && text.includes("FOR UPDATE")) return { rows: [] };
    if (text.includes("FROM public.authorization_decisions")) {
      assert.deepEqual(values, ["workspace-alpha", "decision-alpha", "scope-alpha", "alice", "agent_handoff_confirm", DIGEST, NOW]);
      return { rows: [{ authorization_decision_id: "decision-alpha", policy_revision_id: "policy-alpha" }] };
    }
    if (text.includes("INSERT INTO public.product_commands")) {
      assert.ok(text.includes("'completed'"));
      assert.deepEqual(values.slice(7), ["agent_handoff_confirm", "agent_handoff", "handoff-alpha", 9, NOW]);
      return { rows: [{
        command_id: "handoff-command-alpha", workspace_id: "workspace-alpha", scope_id: "scope-alpha",
        quota_user_id: "alice", kind: "agent_handoff_confirm", target_kind: "agent_handoff",
        target_id: "handoff-alpha", target_revision: 9, status: "completed",
        created_at: NOW, updated_at: NOW, finished_at: NOW,
      }] };
    }
    throw new Error(`unexpected_query:${text}`);
  });
  const intake = new PostgresAgentSessionDecisionCommandIntake({ store });
  const result = await intake.accept({
    principal: { workspaceId: "workspace-alpha", userId: "alice" },
    command: {
      commandId: "handoff-command-alpha", kind: "agent_handoff_confirm", scopeId: "scope-alpha",
      authorizationDecisionId: "decision-alpha", argumentDigest: DIGEST,
      targetId: "handoff-alpha", targetRevision: 9,
    },
    at: NOW,
    persistTarget: async ({ command }) => ({ handoffId: "handoff-alpha", productCommandId: command.commandId }),
  });
  assert.equal(result.command.status, "completed");
  assert.equal(result.command.targetRevision, 9);
  assert.equal(result.target.productCommandId, "handoff-command-alpha");
  assert.equal(calls.some(({ text }) => text.startsWith("\n        UPDATE public.product_commands")), false);
});

test("Session decision Command Intake rejects a mismatched authorization before writing a target", async () => {
  const store = storeWith(async (_uow, { text }) => {
    if (text.includes("FROM public.product_commands")) return { rows: [] };
    if (text.includes("FROM public.authorization_decisions")) return { rows: [] };
    throw new Error(`unexpected_query:${text}`);
  });
  const intake = new PostgresAgentSessionDecisionCommandIntake({ store });
  await assert.rejects(
    intake.accept({
      principal: { workspaceId: "workspace-alpha", userId: "alice" },
      command: {
        commandId: "proposal-command-alpha", kind: "agent_proposal_reject", scopeId: "scope-alpha",
        authorizationDecisionId: "decision-alpha", argumentDigest: DIGEST,
        targetId: "proposal-alpha", targetRevision: 2,
      },
      at: NOW,
      persistTarget: async () => ({ proposalId: "proposal-alpha" }),
    }),
    { code: "agent_proposal_authorization_required" },
  );
});
