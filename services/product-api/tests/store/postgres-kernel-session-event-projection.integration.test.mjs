import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { AgentTurnRunner } from "../../src/agents/agent-turn-runner.mjs";
import { PostgresAgentToolApprovalLifecycle } from "../../src/agents/postgres-agent-tool-approval-lifecycle.mjs";
import { createProductAgentExecutor } from "../../src/agents/product-agent-executor.mjs";
import {
  PostgresAgentCommandAuthorizer,
  PostgresAgentTurnCommandIntake,
  createPostgresProductCommandResolver,
} from "../../src/coordination/index.mjs";
import {
  AdmissionController,
  AdmittedExecutionDispatcher,
  ExecutionBroker,
  PostgresCapacityPersistence,
  PostgresExecutionPersistence,
} from "../../src/execution/index.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const workspaceId = "kernel-session-projection-workspace";
const modelProfileId = "kernel-session-projection-model";
const modelRevisionId = "kernel-session-projection-model-r1";

test("PostgreSQL projects a real Product Agent Worker Kernel event into the sole Session ledger", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
  timeout: 20_000,
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  t.after(async () => {
    await store.close();
    await pool.end();
  });
  await store.runMigrations();

  const auth = store.createAuthPersistence();
  const registered = await auth.registerAuthAccount({
    username: "kernelowner",
    usernameNormalized: "kernelowner",
    passwordHash: "$2b$12$yW6McEk2Trkg.gFfiQkeMuAY.FtqTkbbJ3gqHQIsLVxNlAPAmrNCS",
    role: "admin",
    workspaceId,
    workspaceName: "Kernel projection workspace",
    idempotencyKey: "kernel-session-register-owner",
    requestFingerprint: { username: "kernelowner", role: "admin" },
  });
  const userId = registered.user.userId;
  await seedModel({ pool, workspaceId, userId });

  const clock = () => new Date().toISOString();
  let sequence = 0;
  const idFactory = (kind) => `kernel-projection-${kind}-${++sequence}`;
  const commandIntake = new PostgresAgentTurnCommandIntake({ store });
  const commandAuthorizer = new PostgresAgentCommandAuthorizer({ store, clock, idFactory });
  const admissionController = new AdmissionController({
    persistence: new PostgresCapacityPersistence({ store }),
    clock,
    idFactory,
    resolveProductCommand: createPostgresProductCommandResolver({ store }),
  });
  const broker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admissionController,
    clock,
    idFactory,
  });
  const workerRequests = [];
  let workerCall = 0;
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "container",
    backend: {
      async execute({ request, emit }) {
        workerRequests.push(structuredClone(request));
        workerCall += 1;
        const occurredAt = clock();
        await emit("agent.kernel.model_visible", {
          modelVisibleEvent: {
            schemaVersion: "agent-kernel-model-visible-event-v1",
            eventId: `kernel-visible-event-${workerCall === 1 ? "a" : "b"}`,
            runId: `kernel-run-${workerCall}`,
            session: { sessionId: request.lineage.sessionId, branchId: null },
            sequence: 1,
            type: "message",
            payload: {
              role: "assistant",
              text: "The durable Kernel event is model-visible only in the Product Session.",
            },
            occurredAt,
          },
        });
        return {
          output: { response: "Kernel-backed turn completed." },
          requestedModelRevisionId: request.metadata.modelProfileRevisionId,
          actualModelRevisionId: request.metadata.modelProfileRevisionId,
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const runner = new AgentTurnRunner({
    persistence: store.createAgentPersistence({ commandIntake, clock }),
    executionBroker: new AdmittedExecutionDispatcher({ broker, admissionController }),
    executor: createProductAgentExecutor(),
    commandAuthorizer,
    clock,
    idFactory,
    resolveBaseVersion: async () => {
      throw new Error("main_agent_does_not_need_object_base_version");
    },
    resolveModelSelection: async ({ modelProfileId: selected, requiredCapabilities }) => {
      assert.equal(selected, modelProfileId);
      assert.equal(requiredCapabilities.includes("tool_calling"), true);
      return {
        profileId: modelProfileId,
        revisionId: modelRevisionId,
        capability: "tool_calling",
        limits: { maxInputTokens: 128_000 },
      };
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    title: "Kernel ledger task",
    userId,
    workspaceId,
    modelProfileId,
  });
  const queued = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "agent_message",
    modelProfileId,
    input: { message: "Persist this Kernel-visible response." },
    userId,
    workspaceId,
  });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, queued.turnId, { userId, workspaceId });
  assert.equal(completed.status, "completed");

  const followUp = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "agent_message",
    modelProfileId,
    input: { message: "Replay the durable Kernel event before this turn." },
    userId,
    workspaceId,
  });
  await runner.waitForIdle(session.sessionId);
  assert.equal((await runner.getTurn(session.sessionId, followUp.turnId, { userId, workspaceId })).status, "completed");
  assert.equal(workerRequests.length, 2);
  assert.equal(workerRequests[1].input.kernelSessionReplay.events.some((event) => (
    event.eventId === "kernel-visible-event-a"
      && event.payload.text === "The durable Kernel event is model-visible only in the Product Session."
  )), true);

  const persistence = store.createAgentPersistence({ commandIntake, clock });
  const summaries = await persistence.listEvents(session.sessionId, { after: 0 }, { userId, workspaceId });
  assert.equal(summaries.some(event => event.modelVisibleEvent), false, 'public summaries must not expose model context');
  assert.equal(await persistence.listModelVisibleEvents(session.sessionId, {}, { userId: 'other-user', workspaceId }), null);

  const kernelEvent = (await pool.query(`
    SELECT event_id, session_id, turn_id, type, status, payload
      FROM public.agent_session_events
     WHERE event_id = 'kernel-visible-event-a'
  `)).rows[0];
  assert.deepEqual(kernelEvent, {
    event_id: "kernel-visible-event-a",
    session_id: session.sessionId,
    turn_id: queued.turnId,
    type: "kernel.message",
    status: "completed",
    payload: {
      schemaVersion: "workbench-v1",
      eventId: "kernel-visible-event-a",
      sessionId: session.sessionId,
      turnId: queued.turnId,
      type: "kernel.message",
      status: "completed",
      summary: "Agent Kernel message",
      productCommandId: queued.productCommandId,
      occurredAt: kernelEvent.payload.occurredAt,
      modelVisibleEvent: {
        schemaVersion: "agent-kernel-model-visible-event-v1",
        eventId: "kernel-visible-event-a",
        runId: "kernel-run-1",
        session: { sessionId: session.sessionId, branchId: null },
        sequence: 1,
        type: "message",
        payload: {
          role: "assistant",
          text: "The durable Kernel event is model-visible only in the Product Session.",
        },
        occurredAt: kernelEvent.payload.occurredAt,
      },
    },
  });
  const domain = await pool.query(`
    SELECT payload
      FROM public.session_domain_outbox
     WHERE session_event_id = 'kernel-visible-event-a'
  `);
  assert.deepEqual(domain.rows, [{ payload: { domain: "session", seq: Number(domain.rows[0].payload.seq) } }]);
  assert.equal(JSON.stringify(domain.rows[0].payload).includes("Kernel event is model-visible"), false);
});

test("PostgreSQL Product Tool approval creates an Inbox decision and resumes only the matching Agent Turn", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
  timeout: 20_000,
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  t.after(async () => {
    await store.close();
    await pool.end();
  });
  await store.runMigrations();

  const approvalWorkspaceId = workspaceId;
  const userId = (await pool.query(`
    SELECT user_id FROM public.product_users WHERE username_normalized = 'kernelowner'
  `)).rows[0]?.user_id;
  assert.ok(userId, "the first isolated Product fixture must own the personal scope");
  const profileId = "kernel-tool-approval-model";
  const revisionId = "kernel-tool-approval-model-r1";
  await seedModel({ pool, workspaceId: approvalWorkspaceId, userId, profileId, revisionId });

  const clock = () => new Date().toISOString();
  let sequence = 0;
  const idFactory = (kind) => `kernel-tool-approval-${kind}-${++sequence}`;
  const commandIntake = new PostgresAgentTurnCommandIntake({ store });
  const commandAuthorizer = new PostgresAgentCommandAuthorizer({ store, clock, idFactory });
  const admissionController = new AdmissionController({
    persistence: new PostgresCapacityPersistence({ store }),
    clock,
    idFactory,
    resolveProductCommand: createPostgresProductCommandResolver({ store }),
  });
  const broker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admissionController,
    clock,
    idFactory,
  });
  let lifecycle;
  let externalCalls = 0;
  let approvalAttempts = 0;
  const toolInput = { title: "Create the approved task" };
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "container",
    backend: {
      async execute({ request, lease }) {
        approvalAttempts += 1;
        const resume = request.metadata.toolApprovalResume;
        if (approvalAttempts > 1) {
          assert.ok(resume, "the approved continuation must carry its private approval reference");
        }
        const response = await lifecycle.request({
          binding: {
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            capabilityLeaseId: lease.capabilityLeaseId,
          },
          message: {
            operation: "approval",
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            capabilityLeaseId: lease.capabilityLeaseId,
            toolId: "lark.task.create",
            effectClass: "external_write",
            connectionId: "connection-a",
            input: toolInput,
            ...(resume ? {
              resumeApprovalId: resume.approvalId,
            } : {}),
          },
        });
        if (response.status === "pending") {
          return { status: "blocked", summary: "Waiting for Product Tool approval.", evidence: [], usage: zeroUsage() };
        }
        assert.deepEqual(response, { status: "approved", approvalId: resume.approvalId });
        externalCalls += 1;
        return {
          output: { response: "The approved external action completed." },
          requestedModelRevisionId: request.metadata.modelProfileRevisionId,
          actualModelRevisionId: request.metadata.modelProfileRevisionId,
          evidence: [],
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const runner = new AgentTurnRunner({
    persistence: store.createAgentPersistence({ commandIntake, clock }),
    executionBroker: new AdmittedExecutionDispatcher({ broker, admissionController }),
    executor: createProductAgentExecutor({
      resolveCapabilities: () => ({
        toolAllowlist: ["lark.task.create"],
        connectionIds: ["connection-a"],
        network: false,
        filesystem: "none",
        externalActions: true,
      }),
    }),
    commandAuthorizer,
    clock,
    idFactory,
    resolveBaseVersion: async () => {
      throw new Error("main_agent_does_not_need_object_base_version");
    },
    resolveModelSelection: async ({ modelProfileId: selected, modelProfileRevisionId, requiredCapabilities }) => {
      assert.equal(modelProfileRevisionId ?? selected, modelProfileRevisionId ?? profileId);
      assert.equal(requiredCapabilities.includes("tool_calling"), true);
      return {
        profileId,
        revisionId: modelProfileRevisionId ?? revisionId,
        capability: "tool_calling",
        limits: { maxInputTokens: 128_000 },
      };
    },
  });
  lifecycle = new PostgresAgentToolApprovalLifecycle({ store, commandAuthorizer, clock, idFactory });
  lifecycle.bindAgentTurnRunner(runner);
  const session = await runner.createSession({
    definitionId: "main",
    title: "Approval task",
    userId,
    workspaceId: approvalWorkspaceId,
    modelProfileId: profileId,
  });
  const first = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "agent_message",
    modelProfileId: profileId,
    input: { message: "Create the governed external task." },
    userId,
    workspaceId: approvalWorkspaceId,
  });
  await runner.waitForIdle(session.sessionId);
  assert.equal((await runner.getTurn(session.sessionId, first.turnId, { userId, workspaceId: approvalWorkspaceId })).status, "blocked");
  assert.equal(externalCalls, 0);
  const pending = (await pool.query(`
    SELECT approval_id, status, authorization_request_id
      FROM public.agent_tool_approvals
     WHERE workspace_id = $1
  `, [approvalWorkspaceId])).rows[0];
  assert.ok(pending);
  assert.deepEqual(pending.status, "pending");
  assert.equal((await pool.query(`
    SELECT status FROM public.inbox_items WHERE workspace_id = $1 AND source_id = $2
  `, [approvalWorkspaceId, pending.authorization_request_id])).rows[0]?.status, "unread");

  const decision = await lifecycle.decide({
    approvalId: pending.approval_id,
    decision: "approve",
    userId,
    workspaceId: approvalWorkspaceId,
  });
  assert.equal(decision.status, "approved");
  assert.ok(decision.resumeTurnId);
  runner.schedule(session.sessionId);
  await runner.waitForIdle(session.sessionId);
  const resumed = await runner.getTurn(session.sessionId, decision.resumeTurnId, {
    userId,
    workspaceId: approvalWorkspaceId,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(externalCalls, 1);
  assert.equal(approvalAttempts, 2);
  assert.equal((await pool.query(`
    SELECT status FROM public.inbox_items WHERE workspace_id = $1 AND source_id = $2
  `, [approvalWorkspaceId, pending.authorization_request_id])).rows[0]?.status, "dismissed");
  const approval = (await pool.query(`
    SELECT status, decision_command_id, resume_turn_id, tool_authorization_decision_id
      FROM public.agent_tool_approvals
     WHERE workspace_id = $1 AND approval_id = $2
  `, [approvalWorkspaceId, pending.approval_id])).rows[0];
  assert.equal(approval.status, "approved");
  assert.equal(approval.resume_turn_id, decision.resumeTurnId);
  assert.ok(approval.decision_command_id);
  assert.ok(approval.tool_authorization_decision_id);
});

async function seedModel({
  pool,
  workspaceId: targetWorkspaceId,
  userId,
  profileId: targetProfileId = modelProfileId,
  revisionId: targetRevisionId = modelRevisionId,
}) {
  const scope = (await pool.query(`
    SELECT scope_id FROM public.product_scopes
     WHERE workspace_id = $1 AND owner_user_id = $2
       AND scope_kind = 'personal' AND status = 'active'
  `, [targetWorkspaceId, userId])).rows[0];
  assert.ok(scope?.scope_id);
  const now = (await pool.query(
    "SELECT clock_timestamp() - interval '1 second' AS now",
  )).rows[0].now;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
    INSERT INTO public.model_profiles (
      profile_id, workspace_id, scope_id, schema_version, profile_scope,
      display_name, current_revision_id, current_revision_number,
      created_by_principal_id, created_by_principal_kind, created_at, updated_at
    ) VALUES ($1, $2, $3, 'workbench-model-catalog-v1', 'workspace',
      'Kernel projection test model', $4, 1, $5, 'user', $6::timestamptz, $6::timestamptz)
    `, [targetProfileId, targetWorkspaceId, scope.scope_id, targetRevisionId, userId, now]);
    await client.query(`
    INSERT INTO public.secret_bindings (
      workspace_id, secret_binding_id, scope_id, schema_version,
      owner_kind, owner_id, secret_source, store_binding_ref,
      store_binding_revision, credential_fingerprint, status,
      created_by_principal_id, created_by_principal_kind,
      probed_at, created_at, updated_at
    ) VALUES ($1, $2, $3, 'workbench-secret-binding-v1',
      'model_profile_revision', $4, 'cloud_secret_store', $5,
      1, $6, 'active', $7, 'user', $8::timestamptz, $8::timestamptz, $8::timestamptz)
    `, [
    targetWorkspaceId,
    `${targetProfileId}-secret`,
    scope.scope_id,
    targetRevisionId,
    `${targetProfileId}-binding`,
    `sha256:${"a".repeat(64)}`,
    userId,
    now,
    ]);
    await client.query(`
    INSERT INTO public.model_profile_revisions (
      revision_id, workspace_id, profile_id, revision_number, schema_version,
      provider, protocol, provider_model_ref, capabilities,
      parameter_support, limits, data_policy, cost_policy,
      parameter_schema_version, policy_version, config_hash,
      deployment_key, secret_binding_id,
      created_by_principal_id, created_by_principal_kind, created_at
    ) VALUES ($1, $2, $3, 1, 'workbench-model-catalog-v1',
      'openai', 'openai_compatible_chat', 'kernel-projection-model', ARRAY['chat', 'tool_calling'],
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '1.0.0', '1.0.0', $4, $5, $6,
      $7, 'user', $8::timestamptz)
    `, [
    targetRevisionId,
    targetWorkspaceId,
    targetProfileId,
    `sha256:${"b".repeat(64)}`,
    `${targetProfileId}-deployment`,
    `${targetProfileId}-secret`,
    userId,
    now,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function zeroUsage() {
  return { steps: 0, modelRequests: 0, inputBytes: 0, outputBytes: 0 };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required when PostgreSQL integration is enabled`);
  return value;
}
