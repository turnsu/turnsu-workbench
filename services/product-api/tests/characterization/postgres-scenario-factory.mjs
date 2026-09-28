import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { createRunLeaseCoordinator } from "../../src/runner/run-lease-coordinator.mjs";
import { canonicalRequestHash } from "../../src/store/serialization.mjs";
import {
  ProductMemoryRetentionService,
  ProductMemoryService,
} from "../../src/memory/index.mjs";
import {
  PostgresBackupRestoreDriver,
  ProductPostgresStore,
} from "../../src/store/postgres/index.mjs";

import {
  postgresRunnerRecoveryExecution,
  postgresRunnerRecoveryIds,
  postgresRunnerRecoveryPlan,
  postgresRunnerRecoveryRevision,
  postgresRunnerRecoveryStartRequest,
} from "./postgres-runner-recovery-definition.mjs";

const FIXED_NOW = "2026-08-05T00:00:00.000Z";
const POSTGRES_RUNNER_RECOVERY_WORKER = fileURLToPath(new URL(
  "./postgres-runner-recovery-worker.mjs",
  import.meta.url,
));

export async function withPostgresScenario({ scenarioId, recordRuntimeIdentity = () => {} }, run) {
  if (process.env.WORKBENCH_POSTGRES_INTEGRATION !== "1") {
    throw coded("postgres_characterization_not_enabled");
  }
  const connectionString = process.env.WORKBENCH_POSTGRES_URL;
  if (!connectionString) throw coded("postgres_characterization_url_required");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!databaseName.endsWith("_test")) throw coded("characterization_database_must_end_in_test");

  const stores = [];
  const cleanup = [];
  const principal = Object.freeze({
    workspaceId: `workspace-${shortId(scenarioId)}`,
    userId: `user-${shortId(scenarioId)}`,
  });
  const scopeId = `${principal.workspaceId}-personal`;
  let sequence = 0;
  const deferCleanup = (work) => {
    if (typeof work !== "function") throw new TypeError("characterization_cleanup_function_required");
    cleanup.push(work);
  };
  const createStore = async ({ targetConnectionString = connectionString } = {}) => {
    const pool = new Pool({ connectionString: targetConnectionString, max: 8, connectionTimeoutMillis: 5_000 });
    const store = new ProductPostgresStore({ pool, maxTransactionRetries: 10 });
    stores.push({ store, pool });
    await store.connect();
    return store;
  };
  const createCore = async ({ store: requestedStore } = {}) => {
    const store = requestedStore ?? await createStore();
    const core = store.createCoreSemantics({
      principal,
      scopeId,
      clock: () => new Date().toISOString(),
    });
    await core.ensureFoundation();
    return core;
  };
  let core;
  try {
    const initialStore = await createStore();
    await initialStore.runMigrations();
    const runtime = initialStore.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values) => execute(uow, text, values),
    }));
    const identity = await initialStore.withTransaction(async (uow) => {
      const [{ rows: versionRows }, { rows: authRows }] = await Promise.all([
        runtime.query(uow, "SHOW server_version"),
        runtime.query(uow, "SELECT current_user AS user"),
      ]);
      return Object.freeze({
        nodeVersion: process.version,
        database: "postgres",
        databaseVersion: versionRows[0]?.server_version,
        authenticated: Boolean(authRows[0]?.user),
        isolation: "serializable",
      });
    });
    if (!identity.databaseVersion || !identity.authenticated) throw coded("postgres_characterization_identity_invalid");
    recordRuntimeIdentity(identity);
    core = initialStore.createCoreSemantics({
      principal,
      scopeId,
      clock: () => new Date().toISOString(),
    });
    await core.ensureFoundation();
    const createMemoryFixture = ({ store: requestedStore = initialStore, clock = () => FIXED_NOW, idFactory } = {}) => {
      const persistence = requestedStore.createMemoryPersistence();
      return {
        persistence,
        service: new ProductMemoryService({ persistence, clock, idFactory }),
        retention: new ProductMemoryRetentionService({ persistence }),
      };
    };
    const backupRestore = createPostgresBackupRestore({
      sourceStore: initialStore,
      sourceConnectionString: connectionString,
      createStore,
      deferCleanup,
    });
    const backup = Object.freeze({
      assertAvailable: () => backupRestore.assertAvailable(),
      async seedSkill(input) { await core.createSkillDraft(input); },
      async readSkill(input) { return publicSkillState(await core.getSkillDraft(input), input); },
      backup: () => backupRestore.backup(),
      assertAuthenticationFailure: (input) => backupRestore.assertAuthenticationFailure(input),
      async restoreIsolated(input) {
        const restored = await backupRestore.restoreIsolated(input);
        const restoredCore = await createCore({ store: restored.store });
        return Object.freeze({
          isolated: restored.isolated,
          verification: restored.verification,
          readSkill: async (value) => publicSkillState(await restoredCore.getSkillDraft(value), value),
          dispose: restored.dispose,
        });
      },
    });
    const runnerRecovery = scenarioId === "runner.sigkill-durable-boundaries"
      ? await createPostgresRunnerRecovery({
        store: initialStore,
        connectionString,
        principal,
        scopeId,
      })
      : null;
    return await run(Object.freeze({
      adapter: "postgres",
      scenarioId,
      principal,
      core,
      now: FIXED_NOW,
      clock: () => FIXED_NOW,
      ids(name = "id") {
        sequence += 1;
        return `${shortId(scenarioId)}-${shortId(name)}-${sequence}`;
      },
      createLeaseCoordinator: ({ runControl, workerId, now }) => createRunLeaseCoordinator({
        runControl,
        workerId,
        clock: () => now,
        leaseDurationMs: 1_000,
      }),
      createPeerCore,
      createMemoryFixture,
      async openMemoryReader() {
        const readerStore = await createStore();
        return createMemoryFixture({
          store: readerStore,
          idFactory: (kind) => `${shortId(scenarioId)}-reader-${kind}-${++sequence}`,
        });
      },
      backup,
      ...(runnerRecovery ? { runnerRecovery } : {}),
      deferCleanup,
    }));
  } catch (error) {
    if (process.env.WORKBENCH_CHARACTERIZATION_DEBUG === "1") {
      console.error(`postgres_characterization:${scenarioId}`, error?.stack ?? error);
    }
    throw error;
  } finally {
    for (const work of cleanup.reverse()) await work().catch(() => {});
    await Promise.all(stores.reverse().map(async ({ store, pool }) => {
      await store.close({ closeInjectedPool: true });
      // close() owns the injected pool above; this guard keeps cleanup robust
      // if an early construction failure occurs before that ownership call.
      await pool.end().catch(() => {});
    }));
  }

  async function createPeerCore() {
    return createCore();
  }
}

async function createPostgresRunnerRecovery({
  store,
  connectionString,
  principal,
  scopeId,
} = {}) {
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, text, values); },
  }));
  const query = (uow, text, values = []) => sql.query(uow, text, values);
  const policyId = `${principal.workspaceId}-policy`;
  const grantId = `${principal.workspaceId}-grant`;
  await store.withTransaction(async (uow) => {
    const now = (await query(uow, "SELECT clock_timestamp() AS now")).rows[0].now;
    await query(uow, "SET CONSTRAINTS ALL DEFERRED");
    for (const scenario of ["post-claim", "waiting-review-handoff"]) {
      const ids = postgresRunnerRecoveryIds(scenario);
      const revision = postgresRunnerRecoveryRevision(scenario);
      const plan = postgresRunnerRecoveryPlan(FIXED_NOW, scenario);
      await query(uow, `
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1',
        'Characterization recovery Workflow', '', 'draft', 'draft', 'private',
        $5, 1, $6, $6)
    `, [
      principal.workspaceId,
      ids.workflowId,
      scopeId,
      principal.userId,
      ids.revisionId,
      now,
    ]);
      await query(uow, `
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, schema_version,
        graph, input_form, output_definition, resource_refs, run_settings, definition,
        content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, 1, 'workbench-v1',
        $4::jsonb, $5::jsonb, $5::jsonb, '[]'::jsonb, $5::jsonb, $5::jsonb,
        $6, $7, 'PostgreSQL recovery characterization', $8, $8)
    `, [
      principal.workspaceId,
      ids.revisionId,
      ids.workflowId,
      JSON.stringify(revision.graph),
      JSON.stringify({}),
      ids.revisionHash,
      principal.userId,
      now,
    ]);
      await query(uow, `
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id, schema_version,
        status, execution_plan_id, ordered_steps, review_gates, compiled_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'ready', $5,
        $6::jsonb, $7::jsonb, $8)
    `, [
      principal.workspaceId,
      ids.compileResultId,
      ids.workflowId,
      ids.revisionId,
      ids.planId,
      JSON.stringify(plan.steps.map((step) => step.nodeId)),
      JSON.stringify(plan.reviewGates.map((gate) => gate.nodeId)),
      now,
    ]);
      await query(uow, `
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, plan_version, content_hash, model_routing_state, plan_document,
        pins_finalized, generated_at
      ) VALUES ($1, $2, $3, $4, $5,
        'workbench-execution-plan-v2', 2, $6, 'not_applicable', $7::jsonb,
        true, $8)
    `, [
      principal.workspaceId,
      ids.planId,
      ids.compileResultId,
      ids.workflowId,
      ids.revisionId,
      ids.planHash,
      JSON.stringify(plan),
      FIXED_NOW,
    ]);
    }
  });

  const createDecision = async (scenario) => {
    const request = postgresRunnerRecoveryStartRequest({ userId: principal.userId, scenario });
    const decisionId = `runner-recovery-decision-${randomUUID()}`;
    const approvalId = `${decisionId}-approval`;
    const digest = canonicalRequestHash(request);
    await store.withTransaction(async (uow) => {
      await query(uow, "SET CONSTRAINTS ALL DEFERRED");
      const authorityClock = (await query(uow, `
        SELECT clock_timestamp() AS decided_at,
               clock_timestamp() + interval '60 seconds' AS expires_at
      `)).rows[0];
      for (const [id, disposition, approval] of [
        [approvalId, "approval_required", approvalId],
        [decisionId, "authorized", approvalId],
      ]) {
        await query(uow, `
          INSERT INTO public.authorization_decisions (
            workspace_id, authorization_decision_id, scope_id, policy_revision_id,
            actor_principal_id, actor_principal_kind, actor_scope_grant_id,
            effective_principal_id, effective_principal_kind, effective_scope_grant_id,
            authorization_source, authorizer_principal_id, authorizer_principal_kind,
            authorizer_scope_grant_id, action_id, effect_class, argument_digest,
            permission_mode, destructive_rule_version, disposition, approval_id,
            reason_code, decided_at, expires_at
          ) VALUES ($1, $2, $3, $4,
            $5, 'user', $6, $5, 'user', $6,
            'principal', $5, 'user', $6, 'workflow_run', 'execute', $7,
            'interactive', 'authority-v1', $8, $9, 'approved', $10, $11)
        `, [
          principal.workspaceId, id, scopeId, policyId,
          principal.userId, grantId, digest, disposition, approval,
          authorityClock.decided_at, authorityClock.expires_at,
        ]);
      }
    });
    return decisionId;
  };

  return Object.freeze({
    durableBoundaryMode: "event",
    async spawn({ scenario, workerId, faultBoundary = "", leaseDurationMs }) {
      const decisionId = await createDecision(scenario);
      return spawnPostgresRunnerRecoveryWorker({
        connectionString,
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        scopeId,
        decisionId,
        scenario,
        workerId,
        faultBoundary,
        leaseDurationMs,
      });
    },
    async snapshot({ runId }) {
      return store.withTransaction(async (uow) => {
        // A PostgreSQL client executes one statement at a time. Keep this
        // snapshot on one SERIALIZABLE UoW without concurrent client.query()
        // calls so the harness observes one coherent database state.
        const runRow = await query(uow, `
            SELECT status, event_sequence, current_node_id, finished_at
              FROM public.workflow_runs
             WHERE workspace_id = $1 AND run_id = $2
          `, [principal.workspaceId, runId]);
        const jobRow = await query(uow, `
            SELECT state, fence, lease_owner, lease_expires_at
              FROM public.workflow_run_jobs
             WHERE workspace_id = $1 AND run_id = $2
          `, [principal.workspaceId, runId]);
        const eventRows = await query(uow, `
            SELECT event_id, sequence, type, status, node_id
              FROM public.workflow_run_events
             WHERE workspace_id = $1 AND run_id = $2
             ORDER BY sequence ASC, event_id ASC
          `, [principal.workspaceId, runId]);
        const attemptRows = await query(uow, `
            SELECT node_id, attempt_number, status, invocation_id, payload
              FROM public.workflow_run_node_attempts
             WHERE workspace_id = $1 AND run_id = $2
             ORDER BY node_id ASC, attempt_number ASC, node_attempt_id ASC
          `, [principal.workspaceId, runId]);
        const reviewRows = await query(uow, `
            SELECT decision, status
              FROM public.workflow_run_reviews
             WHERE workspace_id = $1 AND run_id = $2
             ORDER BY requested_at ASC, review_id ASC
          `, [principal.workspaceId, runId]);
        const invocationRows = await query(uow, `
            SELECT invocation.invocation_id, invocation.status, invocation.payload
              FROM public.execution_invocations invocation
              JOIN public.workflow_run_node_attempts node_attempt
                ON node_attempt.workspace_id = invocation.workspace_id
               AND node_attempt.invocation_id = invocation.invocation_id
             WHERE invocation.workspace_id = $1
               AND invocation.controller_kind = 'workflow_run'
               AND invocation.controller_id = $2
               AND node_attempt.node_id = 'node-skill'
             ORDER BY invocation.created_at ASC, invocation.invocation_id ASC
          `, [principal.workspaceId, runId]);
        const run = runRow.rows[0] ?? null;
        const job = jobRow.rows[0] ?? null;
        const invocationById = new Map(invocationRows.rows.map((row) => [row.invocation_id, row]));
        const failure = [...attemptRows.rows]
          .reverse()
          .find((row) => row.payload?.failure)?.payload?.failure ?? null;
        const events = eventRows.rows.map((row) => ({
          eventId: row.event_id,
          sequence: Number(row.sequence),
          type: row.type,
          status: row.status,
          nodeId: row.node_id ?? null,
        }));
        const terminalEvents = events.filter((event) => /^run\.(?:completed|failed|cancelled|partial|effect_outcome_unknown)$/.test(event.type));
        return Object.freeze({
          durableBoundaryMode: "event",
          run: run ? { runId, status: run.status } : null,
          readModel: run ? { status: run.status, failure } : null,
          job: job ? {
            status: job.state === "terminal"
              ? run?.status ?? "terminal"
              : job.state === "waiting_review" ? "paused" : job.state,
            fence: Number(job.fence),
            leaseOwner: job.lease_owner,
            leaseExpiresAt: iso(job.lease_expires_at),
            checkpointSequence: Number(run?.event_sequence ?? 0),
          } : null,
          events,
          stateEvents: events,
          checkpoints: events.map((event) => ({
            checkpointId: event.eventId,
            sequence: event.sequence,
            terminal: terminalEvents.some((terminal) => terminal.eventId === event.eventId),
          })),
          attempts: attemptRows.rows.map((row) => {
            const invocation = invocationById.get(row.invocation_id);
            return {
              nodeId: row.node_id,
              attempt: Number(row.attempt_number),
              status: row.status,
              // Mongo's historical characterization vocabulary calls a
              // durably started invocation `started`; PostgreSQL stores the
              // same non-terminal lifecycle state as `running`.
              invocationStatus: characterizationInvocationStatus(
                invocation?.status ?? row.payload?.invocationStatus ?? null,
                invocation?.payload?.result?.failure?.code ?? row.payload?.failure?.code ?? null,
              ),
              failureCode: invocation?.payload?.result?.failure?.code ?? row.payload?.failure?.code ?? null,
              hasInvocationIdentity: typeof row.invocation_id === "string" && row.invocation_id.length > 0,
            };
          }),
          terminalTransitions: terminalEvents.map((event) => ({
            status: event.status,
            eventId: event.eventId,
            checkpointId: null,
          })),
          decisions: reviewRows.rows.map((row) => ({
            decision: row.decision,
            applicationStatus: row.status === "decided" ? "applied" : row.status,
          })),
          leases: job ? [{
            status: job.state === "terminal" ? "released" : job.state === "leased" ? "active" : job.state,
            fence: Number(job.fence),
          }] : [],
          effects: invocationRows.rows.map((row) => ({
            invocationId: row.invocation_id,
            status: row.status,
          })),
        });
      });
    },
    async waitUntilLeaseExpired({ runId, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await store.withTransaction((uow) => query(uow, `
          SELECT lease_expires_at, clock_timestamp() AS database_now,
                 lease_expires_at <= clock_timestamp() AS expired
            FROM public.workflow_run_jobs
           WHERE workspace_id = $1 AND run_id = $2
        `, [principal.workspaceId, runId]));
        if (result.rows[0]?.expired === true) return;
        await delay(25);
      }
      throw coded("characterization_lease_expiry_timeout");
    },
  });
}

function spawnPostgresRunnerRecoveryWorker({
  connectionString,
  workspaceId,
  userId,
  scopeId,
  decisionId,
  scenario,
  workerId,
  faultBoundary,
  leaseDurationMs,
}) {
  const child = fork(POSTGRES_RUNNER_RECOVERY_WORKER, [], {
    env: {
      ...process.env,
      WORKBENCH_POSTGRES_URL: connectionString,
      WORKBENCH_FAULT_WORKSPACE_ID: workspaceId,
      WORKBENCH_FAULT_USER_ID: userId,
      WORKBENCH_FAULT_SCOPE_ID: scopeId,
      WORKBENCH_FAULT_DECISION_ID: decisionId,
      WORKBENCH_FAULT_SCENARIO: scenario,
      WORKBENCH_FAULT_WORKER_ID: workerId,
      WORKBENCH_FAULT_BOUNDARY: faultBoundary,
      WORKBENCH_FAULT_LEASE_MS: String(leaseDurationMs),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(coded("characterization_worker_ready_timeout"));
    }, 10_000);
    const onMessage = (message) => {
      if (message?.type !== "ready") return;
      cleanup();
      resolve(child);
    };
    const onError = () => {
      cleanup();
      reject(coded("characterization_worker_start_failed"));
    };
    const onExit = () => {
      cleanup();
      reject(coded("characterization_worker_exited_before_ready"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function createPostgresBackupRestore({ sourceStore, sourceConnectionString, createStore, deferCleanup }) {
  const container = process.env.WORKBENCH_POSTGRES_CONTAINER;
  const user = process.env.WORKBENCH_POSTGRES_USER;
  const password = process.env.WORKBENCH_POSTGRES_PASSWORD;
  const sourceDatabase = decodeURIComponent(new URL(sourceConnectionString).pathname.slice(1));
  const unavailable = !container || !user || !password;
  const transport = unavailable ? unavailableBackupTransport() : dockerBackupTransport({
    container, user, password, sourceDatabase, sourceConnectionString,
  });
  return new PostgresBackupRestoreDriver({
    store: sourceStore,
    transport,
    createIsolatedStore: async (target) => createStore({ targetConnectionString: target.connectionString }),
    deferCleanup,
  });
}

function unavailableBackupTransport() {
  const unavailable = () => { throw coded("postgres_backup_transport_unavailable"); };
  return Object.freeze({
    assertAvailable: unavailable, dump: unavailable, createIsolatedTarget: unavailable,
    restore: unavailable, dropTarget: async () => {},
  });
}

function dockerBackupTransport({ container, user, password, sourceDatabase, sourceConnectionString }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw coded("postgres_backup_container_invalid");
  if (!sourceDatabase.endsWith("_test")) throw coded("characterization_database_must_end_in_test");
  const dockerExec = (args, { stdin = "ignore", stdout = "pipe" } = {}) => {
    const child = spawn("docker", ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, ...args], {
      stdio: [stdin, stdout, "pipe"],
    });
    const completed = childExit(child, "postgres_backup_transport_failed");
    return { child, completed };
  };
  return Object.freeze({
    async assertAvailable() {
      await dockerExec(["pg_dump", "--version"], { stdout: "ignore" }).completed;
      await dockerExec(["pg_restore", "--version"], { stdout: "ignore" }).completed;
    },
    async dump() {
      const command = dockerExec(["pg_dump", "-U", user, "-Fc", "--no-owner", "--no-privileges", "-d", sourceDatabase]);
      return { source: command.child.stdout, completed: command.completed };
    },
    async createIsolatedTarget() {
      const database = `${sourceDatabase.slice(0, Math.max(1, 48 - 9))}_restore_${randomUUID().slice(0, 8)}_test`;
      if (!database.endsWith("_test")) throw coded("postgres_backup_restore_name_invalid");
      await dockerExec(["createdb", "-U", user, database], { stdout: "ignore" }).completed;
      const url = new URL(sourceConnectionString);
      url.pathname = `/${database}`;
      return Object.freeze({ database, connectionString: url.toString() });
    },
    async restore(target) {
      const command = dockerExec(["pg_restore", "-U", user, "--no-owner", "--no-privileges", "-d", target.database], { stdin: "pipe", stdout: "ignore" });
      return {
        destination: command.child.stdin,
        completed: command.completed,
        abort: () => command.child.kill("SIGKILL"),
      };
    },
    async dropTarget(target) {
      if (!target?.database?.endsWith("_test")) return;
      await dockerExec(["dropdb", "-U", user, "--if-exists", target.database], { stdout: "ignore" }).completed;
    },
  });
}

function childExit(child, failureCode) {
  const chunks = [];
  let bytes = 0;
  child.stderr.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 16 * 1024) chunks.push(chunk);
    else child.kill("SIGKILL");
  });
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(coded(failureCode)));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(coded(failureCode));
    });
  });
}

function shortId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function characterizationInvocationStatus(value, failureCode) {
  if (value === "running") return "started";
  if (value === "failed" && failureCode === "side_effect_outcome_unknown") {
    return "outcome_unknown";
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function publicSkillState(value, input) {
  return {
    draft: {
      skillDraftId: value.draft.skillDraftId,
      skillId: value.draft.skillId ?? input.skillId,
      revision: value.draft.revision,
      description: value.draft.description,
    },
  };
}
