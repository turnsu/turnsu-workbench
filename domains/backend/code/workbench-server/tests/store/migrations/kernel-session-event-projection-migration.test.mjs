import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Kernel model-visible Worker events project only through existing Product execution and Session authority", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "031_g1_kernel_session_event_projection");
  assert.ok(migration);
  const sql = await migration.loadSql();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.project_execution_kernel_model_visible_event/);
  assert.match(sql, /NEW\.type <> 'agent\.kernel\.model_visible'/);
  assert.match(sql, /agent-kernel-model-visible-event-v1/);
  assert.match(sql, /FROM public\.execution_invocations[\s\S]*FOR SHARE/);
  assert.match(sql, /command_row\.kind <> 'agent_turn'/);
  assert.match(sql, /FROM public\.agent_sessions[\s\S]*FOR UPDATE/);
  assert.match(sql, /FROM public\.agent_turns[\s\S]*FOR SHARE/);
  assert.match(sql, /model_event #>> '\{session,sessionId\}' <> invocation_row\.lineage_session_id/);
  assert.match(sql, /existing_row\.payload -> 'modelVisibleEvent' IS DISTINCT FROM model_event/);
  assert.match(sql, /UPDATE public\.agent_sessions[\s\S]*event_sequence = event_sequence \+ 1/);
  assert.match(sql, /INSERT INTO public\.agent_session_events/);
  assert.match(sql, /CREATE TRIGGER execution_events_project_kernel_session_event/);
  assert.doesNotMatch(sql, /CREATE TABLE|Mongo|Pi SessionManager|repository fallback/iu);
});
