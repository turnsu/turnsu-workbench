import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_MIGRATIONS } from "../../../src/store/postgres/migrations/index.mjs";

test("Agent Session decision migration requires a completed named Product Command and one immutable Session event", async () => {
  const migration = POSTGRES_MIGRATIONS.find(({ version }) => version === "024_g1_session_decision_commands");
  assert.ok(migration);
  const sql = await migration.loadSql();
  assert.match(sql, /CREATE TABLE public\.agent_session_decision_events/);
  assert.match(sql, /agent_session_decision_events_immutable/);
  assert.match(sql, /'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject'/);
  assert.match(sql, /session_event\.payload ->> 'productCommandId' = NEW\.command_id/);
  assert.match(sql, /proposal\.status = event\.status_after/);
  assert.doesNotMatch(sql, /Mongo|repository fallback/i);
});
