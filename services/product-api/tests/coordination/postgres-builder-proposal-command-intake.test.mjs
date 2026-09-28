import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresAgentCommandAuthorizer,
  PostgresBuilderProposalCommandIntake,
} from "../../src/coordination/index.mjs";

const NOW = "2026-08-11T04:00:00.000Z";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function storeWith(execute) {
  return {
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    bindAdapter(factory) { return factory({ execute }); },
  };
}

test("Builder authorization creates an explicit builder_proposal decision without fabricating Agent turn lineage", async () => {
  const calls = [];
  const store = storeWith(async (_uow, { text, values }) => {
    calls.push({ text, values });
    if (text.includes("FROM public.product_scopes")) {
      return { rows: [{ scope_id: "scope-alpha", current_policy_revision_id: "policy-alpha", permission_mode: "interactive", auto_approved_effect_classes: [], auto_approved_action_ids: [], grant_id: "grant-alpha" }] };
    }
    if (text.includes("clock_timestamp")) return { rows: [{ now: NOW }] };
    if (text.includes("INSERT INTO public.authorization_decisions")) return { rows: [] };
    throw new Error(`unexpected_query:${text}`);
  });
  const authorizer = new PostgresAgentCommandAuthorizer({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-alpha`,
  });
  const authority = await authorizer.authorizeBuilderProposal({
    workspaceId: "workspace-alpha", userId: "alice", proposalId: "proposal-alpha", input: { name: "A" },
  });
  assert.equal(authority.scopeId, "scope-alpha");
  assert.equal(authority.authorizationDecisionId, "authorization-decision-alpha");
  assert.match(authority.argumentDigest, /^sha256:[a-f0-9]{64}$/);
  const decisions = calls.filter((call) => call.text.includes("INSERT INTO public.authorization_decisions"));
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((call) => call.values.includes("builder_proposal")));
});

test("Builder Command Intake persists only an authorized Builder command and replays its product target", async () => {
  let invocation = 0;
  const store = storeWith(async (_uow, { text, values }) => {
    invocation += 1;
    if (text.includes("FROM public.product_commands") && text.includes("FOR UPDATE")) return { rows: [] };
    if (text.includes("FROM public.authorization_decisions")) {
      assert.deepEqual(values, ["workspace-alpha", "decision-alpha", "scope-alpha", "alice", DIGEST, NOW]);
      return { rows: [{ authorization_decision_id: "decision-alpha", policy_revision_id: "policy-alpha" }] };
    }
    if (text.includes("INSERT INTO public.product_commands")) {
      assert.ok(text.includes("'builder_proposal'"));
      return { rows: [{ command_id: "builder-command-alpha", workspace_id: "workspace-alpha", scope_id: "scope-alpha", quota_user_id: "alice", kind: "builder_proposal", status: "accepted", created_at: NOW, updated_at: NOW, finished_at: null }] };
    }
    throw new Error(`unexpected_query:${text}`);
  });
  const intake = new PostgresBuilderProposalCommandIntake({ store });
  const result = await intake.accept({
    principal: { workspaceId: "workspace-alpha", userId: "alice" },
    command: { commandId: "builder-command-alpha", kind: "builder_proposal", scopeId: "scope-alpha", authorizationDecisionId: "decision-alpha", argumentDigest: DIGEST },
    at: NOW,
    persistTarget: async ({ command }) => ({ proposalId: "proposal-alpha", productCommandId: command.commandId }),
  });
  assert.equal(result.command.status, "accepted");
  assert.equal(result.target.productCommandId, "builder-command-alpha");
  assert.equal(invocation, 3);
});

test("Builder Command Intake rejects an unavailable decision before persisting a command", async () => {
  const store = storeWith(async (_uow, { text }) => {
    if (text.includes("FROM public.product_commands")) return { rows: [] };
    if (text.includes("FROM public.authorization_decisions")) return { rows: [] };
    throw new Error(`unexpected_query:${text}`);
  });
  const intake = new PostgresBuilderProposalCommandIntake({ store });
  await assert.rejects(
    intake.accept({
      principal: { workspaceId: "workspace-alpha", userId: "alice" },
      command: { commandId: "builder-command-alpha", kind: "builder_proposal", scopeId: "scope-alpha", authorizationDecisionId: "decision-alpha", argumentDigest: DIGEST },
      at: NOW, persistTarget: async () => ({ proposalId: "proposal-alpha" }),
    }),
    { code: "builder_proposal_authorization_required" },
  );
});
