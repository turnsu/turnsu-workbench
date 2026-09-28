import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentHandoffLifecycle } from "../../src/agents/postgres-agent-handoff-lifecycle.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const NOW = "2026-08-11T01:00:00.000Z";

function storeFixture({ status = "pending" } = {}) {
  const calls = [];
  const handoff = {
    handoff_id: "handoff-alpha", workspace_id: "workspace-alpha", user_id: "alice",
    source_session_id: "module-alpha", target_session_id: "main-alpha", schema_version: "workbench-v1",
    status, created_at: NOW, confirmed_at: status === "confirmed" ? NOW : null,
    payload: { importantState: ["Draft is ready."], decisions: [], risks: [], artifactRefs: [] },
  };
  const store = {
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, config) {
          const text = config.text;
          calls.push(text);
          if (text.includes("FROM public.workspace_memberships")) return { rows: [{ role: "member" }] };
          if (text.includes("INSERT INTO public.product_idempotency_receipts")) return { rows: [{ request_hash: config.values[4], response: null }] };
          if (text.includes("FROM public.agent_sessions")) return { rows: [{ definition_id: "main", status: "active", event_sequence: "4" }] };
          if (text.includes("FROM public.agent_handoffs")) return { rows: [structuredClone(handoff)] };
          if (text.includes("UPDATE public.agent_handoffs")) return { rows: [{ ...handoff, status: "confirmed", confirmed_at: NOW }] };
          if (text.includes("UPDATE public.agent_sessions")) return { rows: [{ event_sequence: "5" }] };
          if (text.includes("INSERT INTO public.agent_session_events")
            || text.includes("INSERT INTO public.agent_session_decision_events")
            || text.includes("UPDATE public.product_idempotency_receipts")) return { rows: [] };
          throw new Error(`unexpected_query:${text}`);
        },
      });
    },
  };
  return { store, calls };
}

function authorityFixture() {
  return {
    async authorizeAgentHandoffConfirm({ targetRevision }) {
      return {
        scopeId: "scope-alpha",
        authorizationDecisionId: "decision-alpha",
        argumentDigest: `sha256:${"a".repeat(64)}`,
        authorizedAt: NOW,
        targetRevision,
      };
    },
  };
}

function commandIntakeFixture() {
  return {
    async accept({ command, persistTarget }) {
      const target = await persistTarget({ command: { commandId: command.commandId } });
      return { command: { ...command, status: "completed" }, target, replayed: false };
    },
  };
}

test("PostgreSQL handoff confirmation is principal-scoped, idempotent, and emits one durable Main Session event", async () => {
  const { store, calls } = storeFixture();
  const lifecycle = new PostgresAgentHandoffLifecycle({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  const result = await lifecycle.confirm({
    sessionId: "main-alpha", handoffId: "handoff-alpha", idempotencyKey: "confirm-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice" },
  });
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmedAt, NOW);
  assert.ok(calls.some((text) => text.includes("agent.handoff.confirmed")));
  assert.ok(calls.some((text) => text.includes("agent_session_decision_events")));
  assert.ok(calls.some((text) => text.includes("UPDATE public.agent_handoffs")));
});

test("an already confirmed handoff creates no duplicate Session event for a new idempotency key", async () => {
  const { store, calls } = storeFixture({ status: "confirmed" });
  const lifecycle = new PostgresAgentHandoffLifecycle({
    store, clock: () => NOW, idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: authorityFixture(), commandIntake: commandIntakeFixture(),
  });
  const result = await lifecycle.confirm({
    sessionId: "main-alpha", handoffId: "handoff-alpha", idempotencyKey: "confirm-another-key",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    context: { workspaceId: "workspace-alpha", userId: "alice" },
  });
  assert.equal(result.status, "confirmed");
  assert.equal(calls.some((text) => text.includes("UPDATE public.agent_sessions")), false);
  assert.equal(calls.some((text) => text.includes("agent.handoff.confirmed")), false);
});

test("Application routes PG handoff confirmation through its lifecycle instead of a legacy Store idempotency method", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { persistenceDriver: "postgres", async connect() {} }, runner: {}, agentRuntime: {},
    agentTurnRunner: {},
    agentHandoffLifecycle: { async confirm(input) { calls.push(input); return { handoffId: input.handoffId, status: "confirmed" }; } },
  });
  const result = await application.confirmAgentHandoff({
    sessionId: "main-alpha", handoffId: "handoff-alpha", idempotencyKey: "confirm-alpha",
    request: { schemaVersion: "workbench-api-v1", data: {} },
    auth: { userId: "alice", workspaceId: "workspace-alpha", role: "member" },
  });
  assert.deepEqual(result, { handoffId: "handoff-alpha", status: "confirmed" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.userId, "alice");
});
