import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Session ledger projection is scope-local, command-derived, and only emits safe references", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "024_g1_session_decision_commands");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /CREATE TABLE public\.session_domain_events/);
  assert.match(sql, /CREATE TABLE public\.session_domain_outbox/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.project_session_domain_event/);
  assert.match(sql, /FROM public\.product_commands command/);
  assert.match(sql, /FROM public\.authorization_decisions decision/);
  assert.match(sql, /command\.scope_id INTO resolved_scope_id/);
  assert.match(sql, /actual_contract IS DISTINCT FROM NEW\.target_contract/);
  assert.match(sql, /payload_class IN \('private', 'product_safe', 'internal'\)/);
  assert.match(sql, /CREATE TRIGGER agent_session_events_project_domain_envelope/);
  assert.match(sql, /CREATE TRIGGER execution_events_project_domain_envelope/);
  const projection = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.project_session_domain_event"));
  assert.doesNotMatch(projection, /provider_payload|repository fallback|Mongo/i);
});
