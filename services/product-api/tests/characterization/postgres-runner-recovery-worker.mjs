import { AdmissionController, AdmittedExecutionDispatcher, ExecutionBroker, PostgresCapacityPersistence, PostgresExecutionPersistence } from "../../src/execution/index.mjs";
import { PostgresAgentCommandAuthorizer } from "../../src/coordination/index.mjs";
import {
  createPostgresRunControl,
  createPostgresWorkflowRunPersistence,
  createWorkflowRunner,
  PostgresWorkflowRunCommandIntake,
  PostgresWorkflowRunReviewCommandIntake,
} from "../../src/runner/index.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

import {
  postgresRunnerRecoveryExecution,
  postgresRunnerRecoveryStartRequest,
} from "./postgres-runner-recovery-definition.mjs";

const connectionString = requiredEnv("WORKBENCH_POSTGRES_URL");
const workspaceId = requiredEnv("WORKBENCH_FAULT_WORKSPACE_ID");
const userId = requiredEnv("WORKBENCH_FAULT_USER_ID");
const scopeId = requiredEnv("WORKBENCH_FAULT_SCOPE_ID");
const authorizationDecisionId = requiredEnv("WORKBENCH_FAULT_DECISION_ID");
const workerId = requiredEnv("WORKBENCH_FAULT_WORKER_ID");
const scenario = requiredEnv("WORKBENCH_FAULT_SCENARIO");
const faultBoundary = process.env.WORKBENCH_FAULT_BOUNDARY ?? "";
const leaseDurationMs = Number(process.env.WORKBENCH_FAULT_LEASE_MS ?? 1_000);

if (!new URL(connectionString).pathname.endsWith("_test")) {
  throw new Error("characterization_database_must_end_in_test");
}
if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
  throw new Error(`invalid_fault_lease_duration:${leaseDurationMs}`);
}

const store = new ProductPostgresStore({
  poolOptions: { connectionString },
  maxTransactionRetries: 0,
});
await store.connect();

let idSequence = 0;
let faultSent = false;
const protocolKeepAlive = setInterval(() => {}, 60_000);
const nextId = (kind) => `${kind}-${workerId}-${++idSequence}`;
const commandResolver = createProductCommandResolver({ store });
const admissionController = new AdmissionController({
  persistence: new PostgresCapacityPersistence({ store }),
  clock: () => new Date().toISOString(),
  idFactory: (kind) => nextId(`admission-${kind}`),
  resolveProductCommand: commandResolver,
});
const rawExecutionBroker = new ExecutionBroker({
  persistence: new PostgresExecutionPersistence({ store }),
  capacityAuthorizer: admissionController,
  clock: () => new Date().toISOString(),
  idFactory: (kind) => nextId(`execution-${kind}`),
});
rawExecutionBroker.registerBackend({
  mode: "deterministic_skill",
  isolation: "process",
  backend: {
    async execute({ request }) {
      return {
        status: "completed",
        output: { result: `effect:${request.input.text}` },
        summary: "isolated PostgreSQL deterministic execution completed",
        evidence: [],
        usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
      };
    },
  },
});
const executionBroker = new AdmittedExecutionDispatcher({
  broker: rawExecutionBroker,
  admissionController,
});
const reviewCommandAuthorizer = new PostgresAgentCommandAuthorizer({
  store,
  clock: () => new Date(),
  idFactory: (kind) => nextId(`review-${kind}`),
});
const runner = createWorkflowRunner({
  store,
  commandIntake: new PostgresWorkflowRunCommandIntake({ store }),
  reviewCommandIntake: new PostgresWorkflowRunReviewCommandIntake({ store }),
  runPersistence: createPostgresWorkflowRunPersistence({ store, workspaceId }),
  runControl: createPostgresRunControl({ store, workspaceId, idFactory: nextId }),
  workerId,
  leaseDurationMs,
  scheduleOnStart: false,
  clock: () => new Date().toISOString(),
  idFactory: nextId,
  resolveExecution: async () => postgresRunnerRecoveryExecution({
    workspaceId,
    scopeId,
    scenario,
    generatedAt: new Date().toISOString(),
  }),
  executionBroker,
  agentRuntime: {
    async buildAuthoritativeFinal({ runId, finalText, evidenceGaps, reviewPacket }) {
      return {
        finalText,
        evidenceGaps,
        reviewPacket,
        agentFinalReadModel: {
          schemaVersion: "agent-final-read-model-v1",
          runID: runId,
          finalText,
        },
      };
    },
  },
  faultInjector: async (boundary, context) => {
    if (faultSent || boundary !== faultBoundary) return;
    faultSent = true;
    const marker = `FAULT_BOUNDARY ${boundary} ${context.runId}`;
    process.stdout.write(`${marker}\n`);
    process.send?.({ type: "fault", boundary, context, marker });
    await new Promise(() => {});
  },
});

process.on("message", (message) => { void handleMessage(message); });
process.on("disconnect", () => {
  clearInterval(protocolKeepAlive);
  void store.close().finally(() => process.exit(0));
});
process.send?.({ type: "ready", workerId, pid: process.pid });
process.stdout.write(`WORKER_READY ${workerId} ${process.pid}\n`);

async function handleMessage(message) {
  const requestId = message?.requestId;
  if (!requestId) return;
  try {
    let value;
    if (message.command === "start") {
      const request = postgresRunnerRecoveryStartRequest({ userId, scenario });
      value = await runner.startRun({
        ...request,
        idempotencyKey: `start-${scenario}`,
        requestId: `request-${scenario}`,
        authorizationDecisionId,
      });
    } else if (message.command === "recover") {
      value = await runner.recover();
    } else if (message.command === "approve") {
      const authority = await reviewCommandAuthorizer.authorizeWorkflowRunReview({
        workspaceId,
        userId,
        runId: message.runId,
        nodeId: "node-review",
        decision: "approve",
        requestedChanges: [],
      });
      value = await runner.submitReviewDecision({
        runId: message.runId,
        nodeId: "node-review",
        decision: "approve",
        requestedChanges: [],
        idempotencyKey: `approve-${scenario}`,
        decidedBy: userId,
        authorizationDecisionId: authority.authorizationDecisionId,
      });
    } else if (message.command === "close") {
      clearInterval(protocolKeepAlive);
      await store.close();
      return send({ type: "response", requestId, ok: true, value: null }, true);
    } else {
      throw new Error(`unknown_worker_command:${message.command}`);
    }
    send({ type: "response", requestId, ok: true, value });
  } catch (error) {
    send({
      type: "response",
      requestId,
      ok: false,
      error: {
        name: error?.name,
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
      },
    });
  }
}

function send(message, exitAfterSend = false) {
  if (!process.connected) {
    if (exitAfterSend) process.exit(0);
    return;
  }
  process.send(message, () => {
    if (exitAfterSend) process.exit(0);
  });
}

function createProductCommandResolver({ store: sourceStore }) {
  const sql = sourceStore.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, { text, values }); },
  }));
  return async ({ commandId, workspaceId: requestedWorkspaceId, userId: requestedUserId }) => (
    sourceStore.withTransaction(async (uow) => {
      const row = (await sql.query(uow, `
        SELECT command_id, workspace_id, quota_user_id, kind, session_id, turn_id, target_id, status
          FROM public.product_commands
         WHERE command_id = $1 AND workspace_id = $2 AND quota_user_id = $3
      `, [commandId, requestedWorkspaceId, requestedUserId])).rows[0];
      return row ? {
        commandId: row.command_id,
        workspaceId: row.workspace_id,
        userId: row.quota_user_id,
        kind: row.kind,
        sessionId: row.session_id,
        turnId: row.turn_id,
        targetId: row.target_id,
        status: row.status,
      } : null;
    })
  );
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}
