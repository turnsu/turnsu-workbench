import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { PostgresAgentTurnCommandIntake } from "../../src/coordination/postgres-agent-turn-command-intake.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const workspaceId = "session-ledger-workspace";
const sessionId = "session-ledger-main";
const turnId = "session-ledger-turn";
const privateTranscript = "must-not-appear-in-session-domain-replay";
const now = () => new Date();

test("PostgreSQL Session-domain ledger projects an authorized Agent event into a private replay/outbox stream", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });
  let sequence = 0;
  const idFactory = (kind) => `${kind}-${++sequence}`;
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  const auth = store.createAuthPersistence({ clock: now, idFactory });
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query: (uow, text, values = []) => execute(uow, { text, values }),
  }));
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  await store.runMigrations();
  const owner = await auth.registerAuthAccount({
    username: "ledgerowner",
    usernameNormalized: "ledgerowner",
    passwordHash: "$2b$12$yW6McEk2Trkg.gFfiQkeMuAY.FtqTkbbJ3gqHQIsLVxNlAPAmrNCS",
    role: "admin",
    workspaceId,
    workspaceName: "Session ledger workspace",
    idempotencyKey: "register-ledger-owner",
    requestFingerprint: { username: "ledgerowner", role: "admin" },
  });
  assert.equal(owner.user.userId.startsWith("user-"), true);

  await store.withTransaction(async (uow) => {
    const createdAt = await databaseNow(sql, uow);
    await sql.query(uow, `
      INSERT INTO public.agent_sessions (
        session_id, workspace_id, user_id, schema_version, definition_id,
        scope_kind, source_kind, title, task_status, status,
        model_preference_state, created_at, updated_at
      ) VALUES ($1, $2, $3, 'workbench-v1', 'main',
        'main', 'manual', 'Session ledger task', 'idle', 'active',
        'preference_only', $4::timestamptz, $4::timestamptz)
    `, [sessionId, workspaceId, owner.user.userId, createdAt]);
  });

  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    clock: now,
    idFactory: (kind) => `authority-${kind}-${++sequence}`,
  });
  const authority = await authorizer.authorizeAgentTurn({
    workspaceId,
    userId: owner.user.userId,
    sessionId,
    turnId,
    input: { message: "Record an authorized product-safe Session event." },
  });

  const commandIntake = new PostgresAgentTurnCommandIntake({ store });
  const accepted = await commandIntake.accept({
    principal: { workspaceId, userId: owner.user.userId },
    command: {
      commandId: "session-ledger-command",
      workspaceId,
      userId: owner.user.userId,
      sessionId,
      turnId,
      kind: "agent_turn",
      scopeId: authority.scopeId,
      authorizationDecisionId: authority.authorizationDecisionId,
      argumentDigest: authority.argumentDigest,
      createdAt: authority.authorizedAt,
    },
    at: authority.authorizedAt,
    persistTarget: async ({ command, uow }) => {
      const occurredAt = await databaseNow(sql, uow);
      const advanced = (await sql.query(uow, `
        UPDATE public.agent_sessions
           SET event_sequence = event_sequence + 1, updated_at = $2::timestamptz
         WHERE session_id = $1
         RETURNING event_sequence
      `, [sessionId, occurredAt])).rows[0];
      assert.ok(advanced, "the command target must have a live Agent Session");
      await sql.query(uow, `
        INSERT INTO public.agent_session_events (
          event_id, session_id, turn_id, schema_version, sequence,
          type, status, summary, occurred_at, payload
        ) VALUES ($1, $2, NULL, 'workbench-v1', $3,
          'turn.queued', 'queued', 'Agent turn queued.', $4::timestamptz, $5::jsonb)
      `, [
        "session-ledger-event", sessionId, advanced.event_sequence, occurredAt,
        JSON.stringify({
          schemaVersion: "workbench-v1",
          eventId: "session-ledger-event",
          sessionId,
          turnId,
          type: "turn.queued",
          status: "queued",
          summary: "Agent turn queued.",
          occurredAt,
          productCommandId: command.commandId,
          privateTranscript,
        }),
      ]);
      return { eventSequence: Number(advanced.event_sequence), occurredAt };
    },
  });
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.command.status, "accepted");

  const readModel = store.createSessionDomainReadModel();
  const replay = await readModel.replay({ workspaceId, userId: owner.user.userId, after: 0, limit: 20 });
  assert.equal(replay.scopeId, authority.scopeId);
  assert.equal(replay.events.length, 1);
  const event = replay.events[0];
  assert.equal(event.domain, "session");
  assert.equal(event.seq, 1);
  assert.equal(event.eventId, "session-ledger-event");
  assert.equal(event.sessionId, sessionId);
  assert.equal(event.sessionKind, "personal_task");
  assert.equal(event.sessionSequence, 1);
  assert.equal(event.scopeId, authority.scopeId);
  assert.deepEqual(event.actor, { principalId: owner.user.userId, kind: "user" });
  assert.deepEqual(event.authorizer, {
    kind: "principal",
    principal: { principalId: owner.user.userId, kind: "user" },
  });
  assert.deepEqual(event.lineage, { productCommandId: "session-ledger-command" });
  assert.equal(event.payloadClass, "product_safe");
  assert.deepEqual({ ...event.payloadRef, contentHash: "checked-below" }, {
    id: "session-ledger-event", kind: "turn_queued", state: "queued", contentHash: "checked-below",
  });
  assert.match(event.payloadRef.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(event.occurredAt, iso(accepted.target.occurredAt));
  assert.equal(JSON.stringify(event).includes(privateTranscript), false);
  assert.equal(replay.watermark.seq, 1);

  const outbox = await pool.query(`
    SELECT status, domain_sequence, payload
      FROM public.session_domain_outbox
     WHERE workspace_id = $1 AND session_event_id = 'session-ledger-event'
  `, [workspaceId]);
  assert.deepEqual(outbox.rows, [{ status: "queued", domain_sequence: "1", payload: { domain: "session", seq: 1 } }]);

  await assert.rejects(() => store.withTransaction(async (uow) => {
    const occurredAt = await databaseNow(sql, uow);
    const advanced = (await sql.query(uow, `
      UPDATE public.agent_sessions
         SET event_sequence = event_sequence + 1, updated_at = $2::timestamptz
       WHERE session_id = $1
       RETURNING event_sequence
    `, [sessionId, occurredAt])).rows[0];
    await sql.query(uow, `
      INSERT INTO public.agent_session_events (
        event_id, session_id, turn_id, schema_version, sequence,
        type, status, summary, occurred_at, payload
      ) VALUES ($1, $2, NULL, 'workbench-v1', $3,
        'turn.progress', 'running', 'Forged event.', $4::timestamptz, $5::jsonb)
    `, [
      "session-ledger-forged", sessionId, advanced.event_sequence, occurredAt,
      JSON.stringify({ productCommandId: "unknown-command" }),
    ]);
  }), (error) => error?.code === "23514" && /session_domain_agent_scope_missing/.test(error.message));
  assert.equal((await readModel.replay({ workspaceId, userId: owner.user.userId, after: 0, limit: 20 })).events.length, 1);
});

async function databaseNow(sql, uow) {
  const row = (await sql.query(uow, "SELECT clock_timestamp() AS now")).rows[0];
  return iso(row.now);
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  assert.ok(Number.isFinite(date.getTime()), "a valid timestamp is required");
  return date.toISOString();
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is required`);
  return value;
}
