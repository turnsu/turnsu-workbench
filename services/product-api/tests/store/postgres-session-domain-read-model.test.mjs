import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSessionDomainReadModel } from "../../src/store/postgres/postgres-session-domain-read-model.mjs";

const NOW = "2026-08-12T04:00:00.000Z";
const HASH = `sha256:${"b".repeat(64)}`;

function storeWith(execute) {
  return {
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    bindAdapter(factory) { return factory({ execute }); },
  };
}

test("Session domain replay is scoped to the caller's personal scope and returns contract-valid envelopes", async () => {
  const calls = [];
  const store = storeWith(async (_uow, { text, values }) => {
    calls.push({ text, values });
    if (text.includes("FROM public.product_scopes scope")) return { rows: [{ scope_id: "scope-alice" }] };
    if (text.includes("FROM public.session_domain_events")) return { rows: [{
      event_id: "event-alpha", session_id: "session-alpha", session_kind: "personal_task",
      session_sequence: "3", scope_id: "scope-alice", domain_sequence: "7",
      actor: { principalId: "alice", kind: "user" },
      authorizer: { kind: "principal", principal: { principalId: "alice", kind: "user" } },
      branch: null, lineage: { productCommandId: "command-alpha", turnId: "turn-alpha" },
      payload_class: "product_safe",
      payload_ref: { id: "event-alpha", kind: "turn_completed", state: "completed", contentHash: HASH },
      occurred_at: NOW,
    }] };
    if (text.includes("FROM public.session_domain_scope_cursors")) return { rows: [{ next_sequence: "8" }] };
    throw new Error(`unexpected_query:${text}`);
  });
  const readModel = new PostgresSessionDomainReadModel({ store });
  const result = await readModel.replay({ workspaceId: "workspace-alpha", userId: "alice", after: 6, limit: 20 });
  assert.equal(result.scopeId, "scope-alice");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].seq, 7);
  assert.equal(result.watermark.seq, 7);
  const replay = calls.find(({ text }) => text.includes("FROM public.session_domain_events"));
  assert.deepEqual(replay.values, ["workspace-alpha", "scope-alice", 6, 21]);
});

test("Session domain watermark is zero until its personal scope has a committed envelope", async () => {
  const store = storeWith(async (_uow, { text }) => {
    if (text.includes("FROM public.product_scopes scope")) return { rows: [{ scope_id: "scope-alice" }] };
    if (text.includes("FROM public.session_domain_scope_cursors")) return { rows: [] };
    throw new Error(`unexpected_query:${text}`);
  });
  const readModel = new PostgresSessionDomainReadModel({ store });
  assert.deepEqual(await readModel.watermark({ workspaceId: "workspace-alpha", userId: "alice" }), {
    domain: "session", scopeId: "scope-alice", seq: 0,
  });
});
