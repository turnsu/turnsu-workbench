import assert from "node:assert/strict";
import test from "node:test";
import { Check, WorkflowRunSchema, RunEventSchema } from "@turnsu/workbench-contracts";

import { createPostgresWorkflowRunPersistence } from "../../src/runner/postgres-workflow-run-persistence.mjs";

const NOW = "2026-08-12T00:00:00.000Z";

test("PostgreSQL public Run projects canonical HTTP fields without private execution data", async () => {
  const fixture = createPersistenceFixture();
  const persistence = createPostgresWorkflowRunPersistence({ store: fixture.store, workspaceId: fixture.workspaceId });
  const run = await persistence.readPublicRun(fixture.runId);
  assert.equal(Check(WorkflowRunSchema, run), true, JSON.stringify(run));
  assert.equal(run.nodeRuns.length, 1);
  assert.equal(run.nodeRuns[0].status, "completed");
  assert.equal(Object.hasOwn(run, "executionSnapshot"), false);
  assert.equal(Object.hasOwn(run, "scopeId"), false);
  assert.equal(Object.hasOwn(run.nodeRuns[0], "invocationId"), false);
  assert.equal(Object.hasOwn(run.nodeRuns[0], "executionOutput"), false);
  const listed = await persistence.listRunsByWorkflow(run.workflowId);
  assert.deepEqual(listed, [run]);
});

test("PostgreSQL Workflow Run persistence keeps node outcomes inside the parent running event and records a final output before the terminal event", async () => {
  const fixture = createPersistenceFixture();
  const persistence = createPostgresWorkflowRunPersistence({
    store: fixture.store,
    workspaceId: fixture.workspaceId,
  });

  const nodeEvent = await persistence.appendRunEvent({
    run: { runId: fixture.runId },
    eventTemplate: {
      eventId: "event-node-completed",
      type: "node.completed",
      status: "completed",
      nodeId: fixture.nodeId,
      summary: "Skill completed.",
      occurredAt: NOW,
    },
  });
  assert.equal(nodeEvent.status, "running");
  assert.equal(Check(RunEventSchema, nodeEvent), true, JSON.stringify(nodeEvent));
  assert.equal(fixture.events[0].values[5], "running");

  const lifecycle = [];
  const terminal = await persistence.settleTerminalAggregate({
    runId: fixture.runId,
    status: "completed",
    now: NOW,
    lease: fixture.lease,
    eventTemplate: {
      eventId: "event-run-completed",
      summary: "Run completed.",
    },
    readModelFactory: () => ({
      finalAnswer: { format: "markdown", content: "Product-safe result", createdAt: NOW },
    }),
    syncCommandLifecycle: async (_run, status) => lifecycle.push(status),
  });

  assert.equal(fixture.finalOutputs.length, 1);
  assert.deepEqual(JSON.parse(fixture.finalOutputs[0].values[8]), {
    format: "markdown",
    content: "Product-safe result",
    createdAt: NOW,
  });
  assert.equal(fixture.events.at(-1).values[4], "run.completed");
  assert.equal(fixture.events.at(-1).values[5], "completed");
  assert.deepEqual(lifecycle, ["completed"]);
  assert.equal(terminal.run.authoritativeReadModel.available, true);
});

function createPersistenceFixture() {
  const workspaceId = "workspace-postgres-persistence";
  const runId = "run-postgres-persistence";
  const nodeId = "node-skill";
  const lease = {
    fence: 1,
    workerId: "worker-postgres-persistence",
    leaseToken: "lease-postgres-persistence",
  };
  const state = {
    finalOutputAvailable: false,
    run: {
      schema_version: "workbench-run-v1",
      run_id: runId,
      workspace_id: workspaceId,
      scope_id: "scope-postgres-persistence",
      product_command_id: "command-postgres-persistence",
      workflow_id: "workflow-postgres-persistence",
      workflow_revision_id: "revision-postgres-persistence",
      workflow_revision_content_hash: `sha256:${"a".repeat(64)}`,
      compile_result_id: "compile-postgres-persistence",
      execution_plan_id: "plan-postgres-persistence",
      execution_plan_content_hash: `sha256:${"b".repeat(64)}`,
      inputs: {},
      resource_refs: [],
      idempotency_key: "idempotency-postgres-persistence",
      status: "running",
      current_node_id: nodeId,
      queued_at: NOW,
      started_at: NOW,
      finished_at: null,
      created_at: NOW,
      updated_at: NOW,
      event_sequence: 3,
      payload: {
        requestedBy: "user-postgres-persistence",
        skillMaterialBindings: [],
        executionPlanSnapshot: {},
        executionSnapshot: {},
        authoritativeReadModel: { available: false, version: 0 },
      },
      plan_document: {},
    },
    job: {
      workspace_id: workspaceId,
      run_id: runId,
      state: "leased",
      lease_owner: lease.workerId,
      lease_token: lease.leaseToken,
      lease_expires_at: "2026-08-12T00:01:00.000Z",
      fence: lease.fence,
    },
    attempt: {
      schema_version: "workbench-run-node-attempt-v1",
      node_attempt_id: "node-attempt-postgres-persistence",
      run_id: runId,
      node_id: nodeId,
      attempt_number: 1,
      status: "completed",
      invocation_id: "invocation-postgres-persistence",
      run_fence: lease.fence,
      lease_owner: lease.workerId,
      lease_token: lease.leaseToken,
      started_at: NOW,
      finished_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      payload: { executionOutput: { result: "Product-safe result" } },
    },
  };
  const events = [];
  const finalOutputs = [];
  const store = {
    bindAdapter(factory) {
      return factory({
        execute: async (_uow, queryConfig) => query(state, events, finalOutputs, queryConfig),
      });
    },
    async withTransaction(work, { uow } = {}) { return work(uow ?? {}); },
  };
  return { store, workspaceId, runId, nodeId, lease, events, finalOutputs };
}

function query(state, events, finalOutputs, queryConfig) {
  const text = queryConfig.text;
  const values = queryConfig.values ?? [];
  if (text.includes("SELECT r.*, plan.plan_document")) {
    return { rows: [{ ...state.run, final_output_available: state.finalOutputAvailable }] };
  }
  if (text.includes("FROM public.workflow_run_jobs")) return { rows: [{ ...state.job }] };
  if (text.includes("FROM public.workflow_run_node_attempts")) return { rows: [{ ...state.attempt }] };
  if (text.includes("FROM public.workflow_run_reviews")) return { rows: [] };
  if (text.includes("INSERT INTO public.workflow_run_final_outputs")) {
    finalOutputs.push({ text, values });
    state.finalOutputAvailable = true;
    return { rows: [], rowCount: 1 };
  }
  if (text.includes("INSERT INTO public.workflow_run_events")) {
    events.push({ text, values });
    state.run.event_sequence = values[3];
    state.run.status = values[5];
    state.run.current_node_id = values[6] ?? state.run.current_node_id;
    state.run.updated_at = values[12];
    if (["completed", "failed", "cancelled", "partial", "effect_outcome_unknown"].includes(values[5])) {
      state.run.finished_at = values[12];
      state.job.state = "terminal";
    }
    return {
      rows: [{
        schema_version: "workbench-run-event-v1",
        event_id: values[1],
        run_id: values[2],
        sequence: values[3],
        type: values[4],
        status: values[5],
        node_id: values[6],
        summary: values[8],
        occurred_at: values[12],
      }],
      rowCount: 1,
    };
  }
  throw new Error(`unexpected_query:${text}`);
}
