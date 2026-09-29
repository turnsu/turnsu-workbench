import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";

import {
  AdmissionController,
  AdmittedExecutionDispatcher,
  ExecutionBroker,
  PostgresCapacityPersistence,
  PostgresExecutionPersistence,
} from "../../src/execution/index.mjs";
import {
  createPostgresRunControl,
  createPostgresWorkflowRunPersistence,
  createWorkflowRunner,
  PostgresWorkflowRunCommandIntake,
} from "../../src/runner/index.mjs";
import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";
import { canonicalRequestHash } from "../../src/store/serialization.mjs";
import { createWorkerTranscriptArtifactService } from "../../src/artifacts/worker-transcript-artifact-service.mjs";
import { FilesystemObjectStore } from "../../src/storage/filesystem-object-store.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const workspaceId = "g3b-admission-workspace";
const userId = "g3b-admission-user";
const scopeId = "g3b-admission-scope";
const workflowId = "g3b-admission-workflow";
const revisionId = "g3b-admission-revision";
const compileId = "g3b-admission-compile";
const planId = "g3b-admission-plan";
const runId = "g3b-admission-run";
const commandId = "g3b-admission-command";
const revisionHash = `sha256:${"b".repeat(64)}`;
const planHash = `sha256:${"c".repeat(64)}`;
const digest = `sha256:${"a".repeat(64)}`;

test("PostgreSQL Admission and Execution persistence retain Product authority through prepared dispatch", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
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
  await seedWorkflowRunAuthority({ store, pool });
  await insertAuthorizedRealtimeCommand(pool);

  const runControl = createPostgresRunControl({
    store,
    workspaceId,
    idFactory: sequentialIds("run-control"),
  });
  const workerLease = await runControl.claimRunJob(runId, {
    workerId: "g3b-admission-worker",
    now: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  assert.ok(workerLease);
  assert.equal(workerLease.fence, 1);
  assert.equal(workerLease.leaseToken.startsWith("run-control-run-lease-token-"), true);
  assert.ok(await runControl.assertActiveFence(runId, {
    workerId: "g3b-admission-worker",
    fence: workerLease.fence,
    leaseToken: workerLease.leaseToken,
    now: new Date().toISOString(),
  }));

  const capacity = new PostgresCapacityPersistence({ store });
  const admission = new AdmissionController({
    persistence: capacity,
    clock: () => new Date().toISOString(),
    idFactory: sequentialIds("admission"),
    resolveProductCommand: (identity) => productCommand(pool, identity),
  });
  const broker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admission,
    clock: () => new Date().toISOString(),
    idFactory: sequentialIds("execution"),
  });
  broker.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute({ emit }) {
        // Pi streams telemetry while the Gateway also records model activity.
        // A burst must remain durable and ordered without exhausting retries.
        await Promise.all(Array.from({ length: 24 }, (_, index) => (
          emit("agent.kernel.telemetry", { index })
        )));
        return {
          output: { result: "completed through PostgreSQL authority" },
          usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const dispatcher = new AdmittedExecutionDispatcher({ broker, admissionController: admission });
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "g3b-admission-invocation",
    attemptId: "g3b-admission-attempt",
    workspaceId,
    actor: { userId },
    lineage: { productCommandId: commandId },
    controller: { kind: "workflow_run", controllerId: runId, fence: workerLease.fence },
    mode: "deterministic_skill",
    isolation: "process",
    goal: "Exercise Product-owned PostgreSQL execution authority.",
    input: {},
    limits: {
      timeoutMs: 5_000,
      maxSteps: 1,
      maxModelRequests: 0,
      maxChildren: 0,
      maxInputBytes: 1_000,
      maxOutputBytes: 1_000,
      maxImageCount: 0,
      maxCostUsdMicros: 0,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false,
    },
    resultSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
    evidenceRequirements: [],
    metadata: { executionRef: { capabilityId: "g3b-admission", taskIntent: "verify", adapterVersion: "1" } },
  };

  const reservation = await dispatcher.reserveExecution(request);
  const reservedRows = await pool.query(`
    SELECT capacity.status, invocation.invocation_id
      FROM public.capacity_leases capacity
      JOIN public.admission_waiting admission
        ON admission.admission_id = capacity.admission_id
      LEFT JOIN public.execution_invocations invocation
        ON invocation.capacity_lease_id = capacity.capacity_lease_id
     WHERE admission.invocation_id = $1
  `, [reservation.invocationId]);
  assert.equal(reservedRows.rows.length, 1);
  assert.equal(reservedRows.rows[0].status, "active");
  assert.equal(reservedRows.rows[0].invocation_id, null);
  const prepared = await store.withTransaction((uow) => dispatcher.prepareExecution(request, { uow, reservation }));
  const preparedRows = await pool.query(`
    SELECT invocation.status AS invocation_status, attempt.status AS attempt_status,
           capability.status AS capability_status, capacity.status AS capacity_status
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts attempt ON attempt.invocation_id = invocation.invocation_id
      JOIN public.capability_leases capability ON capability.capability_lease_id = invocation.capability_lease_id
      JOIN public.capacity_leases capacity ON capacity.capacity_lease_id = invocation.capacity_lease_id
     WHERE invocation.invocation_id = $1
  `, [request.invocationId]);
  assert.deepEqual(preparedRows.rows, [{
    invocation_status: "queued", attempt_status: "queued", capability_status: "active", capacity_status: "active",
  }]);

  const result = await dispatcher.execute(request, { preparedExecution: prepared });
  assert.equal(result.status, "completed");
  const streamedEvents = await pool.query(`
    SELECT sequence, payload FROM public.execution_events
     WHERE invocation_id = $1 AND type = 'agent.kernel.telemetry' ORDER BY sequence
  `, [request.invocationId]);
  assert.deepEqual(streamedEvents.rows.map((row) => row.payload.index),
    Array.from({ length: 24 }, (_, index) => index));
  assert.equal(new Set(streamedEvents.rows.map((row) => row.sequence)).size, 24);
  // Recreate the read adapter: execution history must survive the Worker and
  // remain scoped to the invocation IDs authorized by the Product caller.
  const history = new PostgresExecutionPersistence({ store });
  const events = await history.listEvents([request.invocationId]);
  assert.deepEqual(events.filter((event) => event.type === "agent.kernel.telemetry")
    .map((event) => event.payload.index), Array.from({ length: 24 }, (_, index) => index));
  assert.ok(events.every((event) => event.invocationId === request.invocationId));
  assert.deepEqual(await history.listEvents([request.invocationId], events[0].sequence, 2),
    events.filter((event) => event.sequence > events[0].sequence).slice(0, 2));
  assert.deepEqual(await history.listEvents([]), []);
  assert.deepEqual(await history.listEvents(["unrelated-invocation"]), []);
  const objectRoot = await mkdtemp(join(tmpdir(), "turnsu-execution-transcript-"));
  t.after(() => rm(objectRoot, { recursive: true, force: true }));
  const transcriptRepository = store.createWorkerTranscriptArtifactRepository();
  const transcriptService = createWorkerTranscriptArtifactService({
    repository: transcriptRepository,
    objectStore: await new FilesystemObjectStore({ rootDir: objectRoot }).initialize(),
    audit: (event) => transcriptRepository.appendAudit(event),
    encryptionKey: Buffer.alloc(32, 9), keyId: "test-transcript-key",
  });
  t.after(() => transcriptService.dispose());
  const objectScope = { objectKind: "workflow_run", objectId: runId };
  const transcriptContent = JSON.stringify({ messages: [{ role: "assistant", text: "Persisted result" }] });
  const transcript = await transcriptService.commit({ workspaceId, ownerUserId: userId,
    objectScope, invocationId: request.invocationId, attemptId: request.attemptId, content: transcriptContent });
  const restoredTranscript = await transcriptService.read({ workspaceId, requestedBy: userId,
    objectScope, transcriptArtifactId: transcript.transcriptArtifactId });
  assert.equal(restoredTranscript.bytes.toString("utf8"), transcriptContent);
  const settledRows = await pool.query(`
    SELECT invocation.status AS invocation_status, attempt.status AS attempt_status,
           capability.status AS capability_status, capacity.status AS capacity_status
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts attempt ON attempt.invocation_id = invocation.invocation_id
      JOIN public.capability_leases capability ON capability.capability_lease_id = invocation.capability_lease_id
      JOIN public.capacity_leases capacity ON capacity.capacity_lease_id = invocation.capacity_lease_id
     WHERE invocation.invocation_id = $1
  `, [request.invocationId]);
  assert.deepEqual(settledRows.rows, [{
    invocation_status: "completed", attempt_status: "completed", capability_status: "revoked", capacity_status: "released",
  }]);

  const { input: _nonRealtimeInput, ...realtimeBase } = request;
  const realtimeRequest = {
    ...realtimeBase,
    invocationId: "g3b-admission-realtime-invocation",
    attemptId: "g3b-admission-realtime-attempt",
    lineage: {
      productCommandId: "g3b-admission-realtime-command",
      sessionId: "g3b-admission-realtime-session",
      turnId: "g3b-admission-realtime-turn",
    },
    controller: {
      kind: "skill_creation_turn",
      controllerId: "g3b-admission-realtime-turn",
      fence: 1,
    },
    mode: "realtime_audio",
    modelProfileRevisionId: "g3b-admission-realtime-model",
    modelCapability: "realtime_audio",
    fallbackModelProfileRevisionIds: [],
    goal: "Verify PostgreSQL realtime recovery fencing.",
    limits: {
      ...request.limits,
      maxModelRequests: 20,
      maxDepth: 0,
      maxSpawnedChildren: 0,
      maxInputTokens: 50_000,
      maxOutputTokens: 20_000,
    },
    capabilities: {
      ...request.capabilities,
      toolAllowlist: ["propose_skill_creation_patch"],
    },
    metadata: { creationSessionId: "g3b-admission-realtime-session" },
  };
  const realtimePersistence = new PostgresExecutionPersistence({ store });
  const realtimeBroker = new ExecutionBroker({
    persistence: realtimePersistence,
    capacityAuthorizer: admission,
    clock: () => new Date().toISOString(),
    idFactory: sequentialIds("realtime-execution"),
  });
  const realtimeDispatcher = new AdmittedExecutionDispatcher({ broker: realtimeBroker, admissionController: admission });
  realtimeDispatcher.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: {
      async open() {
        return {
          sdpAnswer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n",
          handle: { callId: "g3b-admission-realtime-call" },
        };
      },
      async update() { return {}; },
      async finish() { return { output: {}, summary: "finished" }; },
      async cancel() { return { status: "cancelled" }; },
    },
  });
  const openedRealtime = await realtimeDispatcher.openStream(realtimeRequest, {
    offer: { sdpOffer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" },
  });

  const recoveryBroker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admission,
    clock: () => new Date().toISOString(),
    idFactory: sequentialIds("realtime-recovery"),
  });
  const recovered = await new AdmittedExecutionDispatcher({
    broker: recoveryBroker,
    admissionController: admission,
  }).recoverStreams();
  assert.deepEqual(recovered, [{
    invocationId: realtimeRequest.invocationId,
    status: "failed",
  }]);
  const recoveredRows = await pool.query(`
    SELECT invocation.status AS invocation_status, invocation.execution_fence,
           attempt.status AS attempt_status, attempt.fence AS attempt_fence,
           capability.status AS capability_status, capacity.status AS capacity_status
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts attempt ON attempt.invocation_id = invocation.invocation_id
      JOIN public.capability_leases capability ON capability.capability_lease_id = invocation.capability_lease_id
      JOIN public.capacity_leases capacity ON capacity.capacity_lease_id = invocation.capacity_lease_id
     WHERE invocation.invocation_id = $1
  `, [realtimeRequest.invocationId]);
  assert.deepEqual(recoveredRows.rows, [{
    invocation_status: "failed",
    execution_fence: 2,
    attempt_status: "failed",
    attempt_fence: 1,
    capability_status: "revoked",
    capacity_status: "released",
  }]);
  await assert.rejects(
    realtimeDispatcher.finishStream(realtimeRequest.invocationId, {
      authority: openedRealtime.authority,
    }),
    { code: "execution_result_rejected_by_fence", status: "permission_denied" },
  );
});

test("WorkflowRunner retries through a fresh canonical PostgreSQL command authority", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  t.after(async () => {
    await store.close();
    await pool.end();
  });
  await store.runMigrations();

  const ids = runnerIds();
  await seedRunnerFoundation({ store, pool, ids });
  const request = {
    workflowId: ids.workflowId,
    workflowRevisionId: ids.revisionId,
    inputs: {}, resourceRefs: [], materialBindings: [], requestedBy: ids.userId, retryOf: null,
  };
  const authorizationDecisionId = await insertAuthorizedWorkflowDecision(pool, {
    workspaceId: ids.workspaceId,
    scopeId: ids.scopeId,
    policyId: `${ids.workspaceId}-policy`,
    grantId: `${ids.workspaceId}-grant`,
    userId: ids.userId,
    decisionId: ids.decisionId,
    digest: canonicalRequestHash(request),
  });

  let sequence = 0;
  const admission = new AdmissionController({
    persistence: new PostgresCapacityPersistence({ store }),
    clock: () => new Date().toISOString(),
    idFactory: (kind) => `g3b-runner-admission-${kind}-${++sequence}`,
    resolveProductCommand: (identity) => productCommand(pool, identity),
  });
  const rawBroker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admission,
    clock: () => new Date().toISOString(),
    idFactory: (kind) => `g3b-runner-execution-${kind}-${++sequence}`,
  });
  let executionAttempts = 0;
  rawBroker.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute() {
        executionAttempts += 1;
        if (executionAttempts === 1) {
          return {
            status: "failed",
            summary: "Transient PostgreSQL test failure.",
            usage: { steps: 1, modelRequests: 0, inputBytes: 0, outputBytes: 0 },
          };
        }
        return {
          output: { result: "canonical PostgreSQL Workflow Run completed" },
          usage: { steps: 1, modelRequests: 0, inputBytes: 0, outputBytes: 48 },
        };
      },
    },
  });
  const runner = createWorkflowRunner({
    store,
    commandIntake: new PostgresWorkflowRunCommandIntake({ store }),
    runPersistence: createPostgresWorkflowRunPersistence({ store, workspaceId: ids.workspaceId }),
    runControl: createPostgresRunControl({
      store, workspaceId: ids.workspaceId, idFactory: (kind) => `g3b-runner-${kind}-${++sequence}`,
    }),
    executionBroker: new AdmittedExecutionDispatcher({ broker: rawBroker, admissionController: admission }),
    workerId: "g3b-pg-runner-worker",
    leaseDurationMs: 5_000,
    scheduleOnStart: false,
    clock: () => new Date().toISOString(),
    idFactory: (kind) => `g3b-runner-${kind}-${++sequence}`,
    resolveExecution: async () => runnerExecution(ids),
    agentRuntime: finalAuthority,
  });

  const created = await runner.startRun({
    workflowId: ids.workflowId,
    workflowRevisionId: ids.revisionId,
    inputs: {}, resourceRefs: [], materialBindings: [],
    idempotencyKey: "g3b-pg-runner-start", requestId: "g3b-pg-runner-request",
    requestedBy: ids.userId, authorizationDecisionId,
  });
  assert.equal(created.status, "queued");
  const recovery = await runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, [created.runId]);
  const failed = await pool.query(`
    SELECT run.status AS run_status, run.event_sequence,
           job.state AS job_state, job.fence,
           count(node.node_attempt_id)::int AS node_attempt_count,
           count(invocation.invocation_id)::int AS invocation_count
      FROM public.workflow_runs run
      JOIN public.workflow_run_jobs job ON job.workspace_id = run.workspace_id AND job.run_id = run.run_id
      LEFT JOIN public.workflow_run_node_attempts node ON node.workspace_id = run.workspace_id AND node.run_id = run.run_id
      LEFT JOIN public.execution_invocations invocation ON invocation.workspace_id = run.workspace_id
        AND invocation.controller_kind = 'workflow_run' AND invocation.controller_id = run.run_id
     WHERE run.workspace_id = $1 AND run.run_id = $2
     GROUP BY run.status, run.event_sequence, job.state, job.fence
  `, [ids.workspaceId, created.runId]);
  assert.deepEqual(failed.rows, [{
    run_status: "failed", event_sequence: "5", job_state: "terminal", fence: 1,
    node_attempt_count: 1, invocation_count: 1,
  }]);
  const failedCommand = await pool.query(`
    SELECT command.status, command.session_id, command.turn_id
      FROM public.product_commands command
      JOIN public.workflow_runs run ON run.product_command_id = command.command_id
     WHERE run.workspace_id = $1 AND run.run_id = $2
  `, [ids.workspaceId, created.runId]);
  assert.deepEqual(failedCommand.rows, [{ status: "failed", session_id: null, turn_id: null }]);

  const retryAuthority = await new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `g3b-retry-${kind}-${++sequence}`,
  }).authorizeWorkflowRunRetry({
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    runId: created.runId,
    reason: "Retry after the transient execution failure.",
  });
  const retry = await runner.retryRun({
    runId: created.runId,
    idempotencyKey: "g3b-pg-runner-retry",
    requestedBy: ids.userId,
    reason: "Retry after the transient execution failure.",
    authorizationDecisionId: retryAuthority.authorizationDecisionId,
  });
  assert.equal(retry.retryOf, created.runId);
  assert.deepEqual((await runner.recover()).recoveredRunIds, [retry.runId]);

  const retried = await pool.query(`
    SELECT run.status AS run_status, run.retry_of_run_id,
           command.status AS command_status,
           command.authorization_decision_id,
           decision.action_id, decision.argument_digest
      FROM public.workflow_runs run
      JOIN public.product_commands command
        ON command.workspace_id = run.workspace_id
       AND command.command_id = run.product_command_id
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
     WHERE run.workspace_id = $1 AND run.run_id = $2
  `, [ids.workspaceId, retry.runId]);
  assert.deepEqual(retried.rows, [{
    run_status: "completed",
    retry_of_run_id: created.runId,
    command_status: "completed",
    authorization_decision_id: retryAuthority.authorizationDecisionId,
    action_id: "workflow_run",
    argument_digest: retryAuthority.argumentDigest,
  }]);
  assert.equal(executionAttempts, 2);
});

test("WorkflowRunner accepts companion-bound PostgreSQL Run authority", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  t.after(async () => {
    await store.close();
    await pool.end();
  });
  await store.runMigrations();

  const ids = runnerIds("g3b-companion");
  await seedRunnerFoundation({ store, pool, ids });
  let sequence = 0;
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `g3b-companion-authority-${kind}-${++sequence}`,
  });
  const authority = await authorizer.authorizeWorkflowRun({
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    workflowId: ids.workflowId,
    workflowRevisionId: ids.revisionId,
    inputs: { topic: "companion authority" },
    resourceRefs: [],
    materialBindings: [],
    companionKind: "agent-session",
  });
  const admission = new AdmissionController({
    persistence: new PostgresCapacityPersistence({ store }),
    clock: () => new Date().toISOString(),
    idFactory: (kind) => `g3b-companion-admission-${kind}-${++sequence}`,
    resolveProductCommand: (identity) => productCommand(pool, identity),
  });
  const rawBroker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admission,
    clock: () => new Date().toISOString(),
    idFactory: (kind) => `g3b-companion-execution-${kind}-${++sequence}`,
  });
  rawBroker.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: { result: "companion-bound PostgreSQL Workflow Run completed" },
          usage: { steps: 1, modelRequests: 0, inputBytes: 0, outputBytes: 48 },
        };
      },
    },
  });
  const runner = createWorkflowRunner({
    store,
    commandIntake: new PostgresWorkflowRunCommandIntake({ store }),
    runPersistence: createPostgresWorkflowRunPersistence({ store, workspaceId: ids.workspaceId }),
    runControl: createPostgresRunControl({
      store, workspaceId: ids.workspaceId, idFactory: (kind) => `g3b-companion-${kind}-${++sequence}`,
    }),
    executionBroker: new AdmittedExecutionDispatcher({ broker: rawBroker, admissionController: admission }),
    workerId: "g3b-pg-companion-worker",
    leaseDurationMs: 5_000,
    scheduleOnStart: false,
    clock: () => new Date().toISOString(),
    idFactory: (kind) => `g3b-companion-${kind}-${++sequence}`,
    resolveExecution: async () => runnerExecution(ids),
    agentRuntime: finalAuthority,
  });

  let persistedCompanion = null;
  const created = await runner.startRunWithCompanion({
    workflowId: ids.workflowId,
    workflowRevisionId: ids.revisionId,
    inputs: { topic: "companion authority" },
    resourceRefs: [],
    materialBindings: [],
    idempotencyKey: "g3b-companion-start",
    requestId: "g3b-companion-request",
    requestedBy: ids.userId,
    authorizationDecisionId: authority.authorizationDecisionId,
  }, {
    kind: "agent-session",
    persist: async ({ run, transactionSession }) => {
      assert.ok(transactionSession);
      persistedCompanion = { runId: run.runId };
      return { sessionId: `agent-session-for-${run.runId}` };
    },
  });

  assert.equal(created.run.status, "queued");
  assert.deepEqual(created.companion, { sessionId: `agent-session-for-${created.run.runId}` });
  assert.deepEqual(persistedCompanion, { runId: created.run.runId });
  assert.deepEqual((await runner.recover()).recoveredRunIds, [created.run.runId]);

  const persisted = await pool.query(`
    SELECT run.status AS run_status,
           command.status AS command_status,
           command.authorization_decision_id,
           decision.action_id, decision.argument_digest
      FROM public.workflow_runs run
      JOIN public.product_commands command
        ON command.workspace_id = run.workspace_id
       AND command.command_id = run.product_command_id
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
     WHERE run.workspace_id = $1 AND run.run_id = $2
  `, [ids.workspaceId, created.run.runId]);
  assert.deepEqual(persisted.rows, [{
    run_status: "completed",
    command_status: "completed",
    authorization_decision_id: authority.authorizationDecisionId,
    action_id: "workflow_run",
    argument_digest: authority.argumentDigest,
  }]);
});

async function seedWorkflowRunAuthority({ store, pool }) {
  const core = store.createCoreSemantics({
    principal: { workspaceId, userId },
    scopeId,
    clock: () => "2026-08-10T00:00:00.000Z",
  });
  await core.ensureFoundation();
  const now = new Date().toISOString();
  const policyId = `${workspaceId}-policy`;
  const grantId = `${workspaceId}-grant`;
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'G3B Admission', '',
        'draft', 'draft', 'private', $5, 1, $6, $6)
    `, [workspaceId, workflowId, scopeId, userId, revisionId, now]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, schema_version,
        graph, input_form, output_definition, resource_refs, run_settings, definition,
        content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, 'workbench-v1', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $5, 'G3B test root', $6, $6)
    `, [workspaceId, revisionId, workflowId, revisionHash, userId, now]);
    const plan = {
      schemaVersion: "workbench-execution-plan-v2", planVersion: "2", workflowId,
      workflowRevisionId: revisionId, generatedAt: now, contentHash: planHash,
      maxParallelism: 1, modelRoutingState: "not_applicable", pinnedSkills: [],
      steps: [{ nodeId: "node-a" }], reviewGates: [], primaryOutput: { nodeId: "node-a", portId: "result" },
    };
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id, schema_version,
        status, execution_plan_id, ordered_steps, review_gates, compiled_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'ready', $5, '["node-a"]'::jsonb, '[]'::jsonb, $6)
    `, [workspaceId, compileId, workflowId, revisionId, planId, now]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, plan_version, content_hash, model_routing_state, plan_document, pins_finalized, generated_at
      ) VALUES ($1, $2, $3, $4, $5, 'workbench-execution-plan-v2', 2, $6, 'not_applicable', $7::jsonb, true, $8)
    `, [workspaceId, planId, compileId, workflowId, revisionId, planHash, JSON.stringify(plan), now]);
    await insertAuthorizedWorkflowCommand(client, { policyId, grantId, now });
    await client.query(`
      INSERT INTO public.workflow_runs (
        workspace_id, run_id, scope_id, product_command_id, workflow_id, workflow_revision_id,
        workflow_revision_content_hash, compile_result_id, execution_plan_id, execution_plan_content_hash,
        schema_version, inputs, resource_refs, idempotency_key, status, queued_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'workbench-run-v1', '{}'::jsonb, '[]'::jsonb, $11, 'queued', $12, $12, $12)
    `, [workspaceId, runId, scopeId, commandId, workflowId, revisionId, revisionHash,
      compileId, planId, planHash, `${runId}:idempotency`, now]);
    await client.query(`
      INSERT INTO public.workflow_run_jobs (
        workspace_id, run_id, schema_version, state, available_at, queued_at, created_at, updated_at
      ) VALUES ($1, $2, 'workbench-run-job-v1', 'queued', $3, $3, $3, $3)
    `, [workspaceId, runId, now]);
    await client.query(`
      INSERT INTO public.workflow_run_events (
        workspace_id, event_id, run_id, schema_version, sequence, type, status, summary,
        writer_kind, product_command_id, run_fence, occurred_at
      ) VALUES ($1, $2, $3, 'workbench-run-event-v1', 1, 'run.queued', 'queued', 'Run queued.',
        'controller', $4, 0, $5)
    `, [workspaceId, `${runId}:queued`, runId, commandId, now]);
  });
}

async function insertAuthorizedWorkflowCommand(client, { policyId, grantId, now }) {
  const approvalId = `${commandId}:approval`;
  const decisionId = `${commandId}:decision`;
  for (const [id, disposition, approval] of [
    [approvalId, "approval_required", approvalId],
    [decisionId, "authorized", approvalId],
  ]) {
    await client.query(`
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, authorizer_principal_id, authorizer_principal_kind, authorizer_scope_grant_id,
        action_id, effect_class, argument_digest, permission_mode, destructive_rule_version,
        disposition, approval_id, reason_code, decided_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
        'principal', $5, 'user', $6, 'workflow_run', 'execute', $7, 'interactive', 'authority-v1',
        $8, $9, 'approved', $10, $11)
    `, [workspaceId, id, scopeId, policyId, userId, grantId, digest, disposition, approval,
      now, new Date(Date.parse(now) + 60_000).toISOString()]);
  }
  await client.query(`
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind, authorization_decision_id, policy_revision_id,
      effect_class, argument_digest, quota_user_id, schema_version, kind,
      target_kind, target_id, target_revision, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
      'workbench-v1', 'workflow_run', 'workflow_run', $8, 1, 'accepted', $9, $9)
  `, [commandId, workspaceId, scopeId, userId, decisionId, policyId, digest, runId, now]);
}

async function insertAuthorizedRealtimeCommand(pool) {
  const realtimeCommandId = "g3b-admission-realtime-command";
  const realtimeDecisionId = `${realtimeCommandId}:decision`;
  const realtimeApprovalId = `${realtimeCommandId}:approval`;
  const policyId = `${workspaceId}-policy`;
  const grantId = `${workspaceId}-grant`;
  const databaseNow = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  const now = new Date(databaseNow).toISOString();
  await inTransaction(pool, async (client) => {
    for (const [id, disposition, approvalId] of [
      [realtimeApprovalId, "approval_required", realtimeApprovalId],
      [realtimeDecisionId, "authorized", realtimeApprovalId],
    ]) {
      await client.query(`
        INSERT INTO public.authorization_decisions (
          workspace_id, authorization_decision_id, scope_id, policy_revision_id,
          actor_principal_id, actor_principal_kind, actor_scope_grant_id,
          effective_principal_id, effective_principal_kind, effective_scope_grant_id,
          authorization_source, authorizer_principal_id, authorizer_principal_kind, authorizer_scope_grant_id,
          action_id, effect_class, argument_digest, permission_mode, destructive_rule_version,
          disposition, approval_id, reason_code, decided_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
          'principal', $5, 'user', $6, 'skill_creation_realtime_call', 'execute', $7,
          'interactive', 'authority-v1', $8, $9, 'approved', $10, $11)
      `, [workspaceId, id, scopeId, policyId, userId, grantId, digest,
        disposition, approvalId, now, new Date(Date.parse(now) + 60_000).toISOString()]);
    }
    await client.query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind, authorization_decision_id, policy_revision_id,
        effect_class, argument_digest, quota_user_id, schema_version, kind,
        session_id, turn_id, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
        'workbench-v1', 'skill_creation_realtime_call', $8, $9, 'accepted', $10, $10)
    `, [realtimeCommandId, workspaceId, scopeId, userId, realtimeDecisionId,
      policyId, digest, "g3b-admission-realtime-session", "g3b-admission-realtime-turn", now]);
  });
}

async function productCommand(pool, { commandId: requestedCommandId, workspaceId: requestedWorkspaceId, userId: requestedUserId }) {
  const row = (await pool.query(`
    SELECT command_id, workspace_id, quota_user_id, kind, session_id, turn_id, target_id, status
      FROM public.product_commands
     WHERE command_id = $1 AND workspace_id = $2 AND quota_user_id = $3
  `, [requestedCommandId, requestedWorkspaceId, requestedUserId])).rows[0];
  return row && {
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    userId: row.quota_user_id,
    kind: row.kind,
    sessionId: row.session_id,
    turnId: row.turn_id,
    targetId: row.target_id,
    status: row.status,
  };
}

function sequentialIds(prefix) {
  let index = 0;
  return (kind) => `${prefix}-${kind}-${++index}`;
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required when PostgreSQL integration is enabled`);
  return value;
}

function runnerIds(prefix = "g3b-runner") {
  return {
    workspaceId: `${prefix}-workspace`,
    userId: `${prefix}-user`,
    scopeId: `${prefix}-scope`,
    workflowId: `${prefix}-workflow`,
    revisionId: `${prefix}-revision`,
    compileId: `${prefix}-compile`,
    planId: `${prefix}-plan`,
    decisionId: `${prefix}-decision`,
  };
}

async function seedRunnerFoundation({ store, pool, ids }) {
  const core = store.createCoreSemantics({
    principal: { workspaceId: ids.workspaceId, userId: ids.userId },
    scopeId: ids.scopeId,
    clock: () => new Date().toISOString(),
  });
  await core.ensureFoundation();
  const now = new Date().toISOString();
  const revisionHash = `sha256:${"d".repeat(64)}`;
  const planHash = `sha256:${"e".repeat(64)}`;
  const plan = runnerPlan(ids, planHash, now);
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'G3B Runner', '',
        'draft', 'draft', 'private', $5, 1, $6, $6)
    `, [ids.workspaceId, ids.workflowId, ids.scopeId, ids.userId, ids.revisionId, now]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, schema_version,
        graph, input_form, output_definition, resource_refs, run_settings, definition,
        content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, 'workbench-v1', $4::jsonb, '{}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6, 'G3B runner', $7, $7)
    `, [ids.workspaceId, ids.revisionId, ids.workflowId, JSON.stringify(runnerRevision(ids)), revisionHash, ids.userId, now]);
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id, schema_version,
        status, execution_plan_id, ordered_steps, review_gates, compiled_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'ready', $5, '["node-skill"]'::jsonb, '[]'::jsonb, $6)
    `, [ids.workspaceId, ids.compileId, ids.workflowId, ids.revisionId, ids.planId, now]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, plan_version, content_hash, model_routing_state, plan_document, pins_finalized, generated_at
      ) VALUES ($1, $2, $3, $4, $5, 'workbench-execution-plan-v2', 2, $6, 'not_applicable', $7::jsonb, true, $8)
    `, [ids.workspaceId, ids.planId, ids.compileId, ids.workflowId, ids.revisionId, planHash, JSON.stringify(plan), now]);
  });
  ids.revisionHash = revisionHash;
  ids.planHash = planHash;
}

function runnerRevision(ids) {
  return {
    graph: {
      nodes: [{
        nodeId: "node-skill", kind: "Skill", title: "Canonical Skill", description: "Run one governed skill.",
        inputPorts: [], outputPorts: [{ portId: "result", name: "result", schema: { type: "string" }, required: true }],
        inputBindings: [], skillRef: { skillId: "g3b-runner-skill", version: "1" }, configuration: { format: "markdown" },
        reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 5,
      }],
      edges: [],
    },
    inputForm: {}, outputDefinition: {}, runSettings: {},
    revisionId: ids.revisionId, workflowId: ids.workflowId, contentHash: ids.revisionHash,
  };
}

function runnerPlan(ids, planHash, generatedAt) {
  return {
    schemaVersion: "workbench-execution-plan-v2", planVersion: "2",
    planId: ids.planId, workflowId: ids.workflowId, workflowRevisionId: ids.revisionId,
    generatedAt, contentHash: planHash, maxParallelism: 1, modelRoutingState: "not_applicable",
    pinnedSkills: [{ skillId: "g3b-runner-skill", version: "1" }],
    steps: [{
      nodeId: "node-skill", kind: "Skill", dependsOn: [], inputBindings: [],
      executionMode: "deterministic_skill", isolation: "process", modelRoutingState: "not_applicable",
      capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
      limits: { timeoutMs: 5_000, maxSteps: 1, maxModelRequests: 0, maxChildren: 0, maxInputBytes: 1_000, maxOutputBytes: 1_000, maxImageCount: 0, maxCostUsdMicros: 0 },
      resultSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      evidenceRequirements: [],
    }],
    reviewGates: [], primaryOutput: { nodeId: "node-skill", portId: "result" },
  };
}

function runnerExecution(ids) {
  const skillVersion = {
    skillId: "g3b-runner-skill", version: "1", name: "Canonical Skill",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
    executionRef: { executionMode: "script", capabilityId: "g3b-runner-skill", taskIntent: "test", adapterVersion: "1" },
  };
  return {
    revision: runnerRevision(ids),
    compileResult: { status: "ready", compileResultId: ids.compileId, executionPlan: runnerPlan(ids, ids.planHash, new Date().toISOString()) },
    workspaceId: ids.workspaceId, scopeId: ids.scopeId, compileResultId: ids.compileId, executionPlanId: ids.planId,
    skillVersions: [skillVersion],
    skills: { [`${skillVersion.skillId}:${skillVersion.version}`]: { definition: skillVersion, executionRef: skillVersion.executionRef } },
  };
}

const finalAuthority = {
  async buildAuthoritativeFinal({ runId, finalText, evidenceGaps, reviewPacket }) {
    return {
      finalText, evidenceGaps, reviewPacket,
      agentFinalReadModel: { schemaVersion: "agent-final-read-model-v1", runID: runId, finalText },
    };
  },
};

async function insertAuthorizedWorkflowDecision(pool, {
  workspaceId, scopeId, policyId, grantId, userId, decisionId, digest,
}) {
  const approvalId = `${decisionId}-approval`;
  const databaseNow = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  const now = new Date(databaseNow).toISOString();
  for (const [id, disposition, approval] of [
    [approvalId, "approval_required", approvalId],
    [decisionId, "authorized", approvalId],
  ]) {
    await pool.query(`
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, authorizer_principal_id, authorizer_principal_kind, authorizer_scope_grant_id,
        action_id, effect_class, argument_digest, permission_mode, destructive_rule_version,
        disposition, approval_id, reason_code, decided_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
        'principal', $5, 'user', $6, 'workflow_run', 'execute', $7, 'interactive', 'authority-v1',
        $8, $9, 'approved', $10, $11)
    `, [workspaceId, id, scopeId, policyId, userId, grantId, digest, disposition, approval,
      now, new Date(Date.parse(now) + 60_000).toISOString()]);
  }
  return decisionId;
}
