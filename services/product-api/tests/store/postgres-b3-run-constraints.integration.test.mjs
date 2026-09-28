import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { PostgresInboxReadModel } from "../../src/inbox/postgres-inbox-read-model.mjs";
import { PostgresWorkflowRunReviewCommandIntake } from "../../src/runner/postgres-workflow-run-review-command-intake.mjs";
import { PostgresWorkflowRunCancellationCommandIntake } from "../../src/runner/postgres-workflow-run-cancellation-command-intake.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const BASE = Date.now() - 60_000;
const NOW = new Date(BASE).toISOString();
const EXPIRY = new Date(BASE + 60 * 60_000).toISOString();
const DIGEST = `sha256:${"a".repeat(64)}`;
const REVISION_HASH = `sha256:${"b".repeat(64)}`;
const PLAN_HASH = `sha256:${"c".repeat(64)}`;
const W = "b3-workspace";
const USER = "b3-user";
const SCOPE = "b3-scope";
const POLICY = "b3-policy-1";
const GRANT = "b3-operation-grant";
const WORKFLOW = "b3-workflow";
const REVISION = "b3-workflow-r1";
const COMPILE = "b3-compile-r1";
const PLAN = "b3-plan-r1";
const W2 = "b3-cursor-workspace";
const SCOPE2 = "b3-cursor-scope";
const POLICY2 = "b3-cursor-policy";
const GRANT2 = "b3-cursor-grant";
const WORKFLOW2 = "b3-cursor-workflow";
const REVISION2 = "b3-cursor-workflow-r1";
const COMPILE2 = "b3-cursor-compile-r1";
const PLAN2 = "b3-cursor-plan-r1";

test("PostgreSQL B3 keeps outer Runs atomic, pinned, fenced, reviewable, and cursor-safe", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  assert.match(databaseName, /_test$/, "integration database must end in _test");

  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool });
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  await store.runMigrations();
  await seedFoundation(pool);
  await assertIntakeAtomicity(pool);
  await assertClaimAttemptReviewAndTerminal(pool);
  await assertReviewReviseClosure(pool);
  await assertLeaseTransitionEvents(pool);
  await assertRenewalLosesToExpiredTakeover(pool);
  await assertQueuedCancellationAuthority(pool);
  await assertQueuedCancellationCommandIntake({ pool, store });
  await assertActiveCancellationAuthority(pool);
  await assertCancellationRequestedRecovery(pool);
  await assertWaitingReviewCancellation(pool);
  await assertReviewRejectClosure(pool);
  await assertReviewInboxAndCommandRejection({ pool, store });
  await assertConcurrentCancelVsClaim(pool);
  await assertTerminalAndReviewLoseAfterLeaseExpiry(pool);
  await assertRetrySemantics(pool);
  await assertTakeoverAndCursor(pool);
  await assertTerminalOutcomeBoundaries(pool);
  await assertReviewRejectsUnresolvedEffectOutcome(pool);
  await assertReviewAttemptSetSerialization(pool);
  await assertEffectReceiptInitialState(pool);
  await assertMultiEffectReconciliation(pool);
  await assertSettledReceiptMixPermitsNonSuccessTerminalParent(pool);
  await assertCancellationStopsNewEffectDispatch(pool);
  await assertReceiptTransitionLosesToTerminalParent(pool);
  await assertReceiptFirstBlocksTerminalParent(pool);
  await assertZeroReceiptTerminalParent(pool);
});

async function seedFoundation(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'B3 User', $2, $2)
  `, [USER, NOW]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'B3', $2, $3, $3)
  `, [W, USER, NOW]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES ('b3-membership', $1, $2, 'workbench-v1', 'owner', $3, $3)
  `, [W, USER, NOW]);
  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id, membership_id,
      created_at, updated_at
    ) VALUES ($1, $2, 'user', $2, 'b3-membership', $3, $3)
  `, [W, USER, NOW]);

  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind,
        owner_user_id, owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind, creation_mode,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'personal', $3, $3, $4,
        $3, 'user', 'workspace_initial_seed', $5, $5
      )
    `, [W, SCOPE, USER, POLICY, NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision,
        observation_tier, permission_mode, policy_content_hash,
        created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, 1, 'private', 'interactive', $4, $5, 'user', $6
      )
    `, [W, SCOPE, POLICY, DIGEST, USER, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind, issuance_kind,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'user', 'operation', ARRAY['object.execute']::text[], true,
        $4, 'user', 'scope_creation', $5, $5
      )
    `, [W, SCOPE, GRANT, USER, NOW]);
  });

  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'B3 Workflow', '',
        'draft', 'draft', 'private', $5, 1, $6, $6
      )
    `, [W, WORKFLOW, SCOPE, USER, REVISION, NOW]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number,
        schema_version, graph, input_form, output_definition, resource_refs,
        run_settings, definition, content_hash, authored_by, save_reason,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, 1, 'workbench-v1', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
        $4, $5, 'B3 fixture', $6, $6
      )
    `, [W, REVISION, WORKFLOW, REVISION_HASH, USER, NOW]);
  });

  const planDocument = {
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    workflowId: WORKFLOW,
    workflowRevisionId: REVISION,
    generatedAt: NOW,
    contentHash: PLAN_HASH,
    maxParallelism: 1,
    modelRoutingState: "not_applicable",
    pinnedSkills: [],
    steps: [{ nodeId: "node-a" }],
    reviewGates: [{ nodeId: "node-a", dependsOn: [], instructions: "Review." }],
    primaryOutput: { nodeId: "node-a", portId: "result" },
  };
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, status, execution_plan_id, ordered_steps, review_gates,
        compiled_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'ready', $5,
        '["node-a"]'::jsonb, '["node-a"]'::jsonb, $6
      )
    `, [W, COMPILE, WORKFLOW, REVISION, PLAN, NOW]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id,
        workflow_revision_id, schema_version, plan_version, content_hash,
        model_routing_state, plan_document, pins_finalized, generated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'workbench-execution-plan-v2', 2, $6,
        'not_applicable', $7::jsonb, true, $8
      )
    `, [W, PLAN, COMPILE, WORKFLOW, REVISION, PLAN_HASH, JSON.stringify(planDocument), NOW]);
  });
  await seedCursorTenantFoundation(pool);
}

async function seedCursorTenantFoundation(pool) {
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'B3 Cursor Tenant', $2, $3, $3)
  `, [W2, USER, NOW]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES ('b3-cursor-membership', $1, $2, 'workbench-v1', 'owner', $3, $3)
  `, [W2, USER, NOW]);
  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id, membership_id,
      created_at, updated_at
    ) VALUES ($1, $2, 'user', $2, 'b3-cursor-membership', $3, $3)
  `, [W2, USER, NOW]);
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind,
        owner_user_id, owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind, creation_mode,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'personal', $3, $3, $4,
        $3, 'user', 'workspace_initial_seed', $5, $5
      )
    `, [W2, SCOPE2, USER, POLICY2, NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision,
        observation_tier, permission_mode, policy_content_hash,
        created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, 1, 'private', 'interactive', $4, $5, 'user', $6
      )
    `, [W2, SCOPE2, POLICY2, DIGEST, USER, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind, issuance_kind,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'user', 'operation', ARRAY['object.execute']::text[], true,
        $4, 'user', 'scope_creation', $5, $5
      )
    `, [W2, SCOPE2, GRANT2, USER, NOW]);
  });
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'B3 Cursor Workflow', '',
        'draft', 'draft', 'private', $5, 1, $6, $6
      )
    `, [W2, WORKFLOW2, SCOPE2, USER, REVISION2, NOW]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number,
        schema_version, graph, input_form, output_definition, resource_refs,
        run_settings, definition, content_hash, authored_by, save_reason,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, 1, 'workbench-v1', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
        $4, $5, 'B3 cursor fixture', $6, $6
      )
    `, [W2, REVISION2, WORKFLOW2, REVISION_HASH, USER, NOW]);
  });
  const planDocument = {
    schemaVersion: "workbench-execution-plan-v2", planVersion: "2",
    workflowId: WORKFLOW2, workflowRevisionId: REVISION2, generatedAt: NOW,
    contentHash: PLAN_HASH, maxParallelism: 1, modelRoutingState: "not_applicable",
    pinnedSkills: [], steps: [{ nodeId: "node-a" }], reviewGates: [],
    primaryOutput: { nodeId: "node-a", portId: "result" },
  };
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, status, execution_plan_id, ordered_steps, review_gates,
        compiled_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'ready', $5,
        '["node-a"]'::jsonb, '[]'::jsonb, $6
      )
    `, [W2, COMPILE2, WORKFLOW2, REVISION2, PLAN2, NOW]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id,
        workflow_revision_id, schema_version, plan_version, content_hash,
        model_routing_state, plan_document, pins_finalized, generated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'workbench-execution-plan-v2', 2, $6,
        'not_applicable', $7::jsonb, true, $8
      )
    `, [W2, PLAN2, COMPILE2, WORKFLOW2, REVISION2, PLAN_HASH, JSON.stringify(planDocument), NOW]);
  });
}

async function assertIntakeAtomicity(pool) {
  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-orphan-command", kind: "workflow_run",
      effectClass: "execute", targetKind: "workflow_run", targetId: "b3-orphan-run",
    });
  }, "23503", "workflow_run_initial_aggregate_incomplete");

  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-wrong-pin-command", kind: "workflow_run",
      effectClass: "execute", targetKind: "workflow_run", targetId: "b3-wrong-pin-run",
    });
    await insertRunRoot(client, {
      runId: "b3-wrong-pin-run", commandId: "b3-wrong-pin-command",
      idempotencyKey: "b3-wrong-pin-key",
      planHash: `sha256:${"d".repeat(64)}`,
    });
  }, "23514", "workflow_run_plan_hash_mismatch");

  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-incomplete-command", kind: "workflow_run",
      effectClass: "execute", targetKind: "workflow_run", targetId: "b3-incomplete-run",
    });
    await insertRunRoot(client, {
      runId: "b3-incomplete-run", commandId: "b3-incomplete-command",
      idempotencyKey: "b3-incomplete-key",
    });
  }, "23503", "workflow_run_initial_aggregate_incomplete");

  await createRun(pool, {
    runId: "b3-main-run", commandId: "b3-main-command", idempotencyKey: "b3-main-key",
  });
  const intake = await pool.query(`
    SELECT r.status, r.event_sequence, c.status AS command_status, j.state, j.fence
    FROM public.workflow_runs r
    JOIN public.product_commands c
      ON c.workspace_id = r.workspace_id AND c.command_id = r.product_command_id
    JOIN public.workflow_run_jobs j
      ON j.workspace_id = r.workspace_id AND j.run_id = r.run_id
    WHERE r.workspace_id = $1 AND r.run_id = 'b3-main-run'
  `, [W]);
  assert.deepEqual(intake.rows[0], {
    status: "queued", event_sequence: "1", command_status: "accepted",
    state: "queued", fence: 0,
  });

  await expectConstraint(pool, `
    UPDATE public.workflow_runs SET status = 'running', event_sequence = 2, updated_at = $1
    WHERE workspace_id = $2 AND run_id = 'b3-main-run'
  `, [new Date().toISOString(), W], "55000", "workflow_run_lifecycle_requires_event");
  await expectTransactionError(pool, async (client) => {
    await client.query(`
      UPDATE public.product_commands
      SET status = 'running', updated_at = $1
      WHERE workspace_id = $2 AND command_id = 'b3-main-command'
    `, [new Date().toISOString(), W]);
  }, "23514", "workflow_run_projection_inconsistent");
  await expectTransactionError(pool, async (client) => {
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET state = 'terminal', updated_at = $1
      WHERE workspace_id = $2 AND run_id = 'b3-main-run'
    `, [new Date().toISOString(), W]);
  }, "23514", "workflow_run_projection_inconsistent");
}

async function assertClaimAttemptReviewAndTerminal(pool) {
  const claimTime = new Date().toISOString();
  const claimed = await claim(pool, "b3-worker-a", "b3-lease-a");
  assert.equal(claimed.run_id, "b3-main-run");
  assert.equal(claimed.fence, 1);

  await expectTransactionError(pool, async (client) => {
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET fence = 2, lease_owner = 'b3-hijacker', lease_token = 'b3-hijack-token',
          lease_expires_at = clock_timestamp() + interval '2 minutes',
          updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND run_id = 'b3-main-run'
    `, [W]);
  }, "23514", "workflow_run_job_lease_event_id_required");
  await expectTransactionError(pool, async (client) => {
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET lease_expires_at = lease_expires_at + interval '1 minute',
          updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND run_id = 'b3-main-run'
    `, [W]);
  }, "23514", "workflow_run_job_lease_event_id_required");

  await seedExecutionLineage(pool, {
    runId: "b3-main-run", commandId: "b3-main-command", fence: 1,
    invocationId: "b3-invocation-a", attemptId: "b3-execution-attempt-a",
    checkpointId: "b3-checkpoint-a",
  });
  await pool.query(`
    INSERT INTO public.workflow_run_node_attempts (
      workspace_id, node_attempt_id, run_id, scope_id, product_command_id,
      node_id, attempt_number, schema_version, status,
      invocation_id, execution_attempt_id, checkpoint_id,
      run_fence, lease_owner, lease_token, started_at, created_at, updated_at
    ) VALUES (
      $1, 'b3-node-attempt-a', 'b3-main-run', $2, 'b3-main-command',
      'node-a', 1, 'workbench-run-node-attempt-v1', 'running',
      'b3-invocation-a', 'b3-execution-attempt-a', 'b3-checkpoint-a',
      1, 'b3-worker-a', 'b3-lease-a', $3, $3, $3
    )
  `, [W, SCOPE, claimTime]);
  await expectTransactionError(pool, async (client) => {
    await client.query(`
      DELETE FROM public.execution_attempts
      WHERE invocation_id = 'b3-invocation-a'
        AND attempt_id = 'b3-execution-attempt-a'
    `);
  }, "55000", "execution_attempt_delete_forbidden");
  for (const type of ["node.started", "node.effect_recovery_started"]) {
    await expectTransactionError(pool, async (client) => {
      if (type === "node.effect_recovery_started") {
        await client.query(workerEventSql({
          eventId: "b3-effect-recovery-node-started", runId: "b3-main-run",
          sequence: 3, type: "node.started", status: "running", fence: 1,
          workerId: "b3-worker-a", leaseToken: "b3-lease-a",
          nodeAttemptId: "b3-node-attempt-a",
        }));
      }
      await client.query(workerEventSql({
        eventId: `b3-${type}-once`, runId: "b3-main-run",
        sequence: type === "node.started" ? 3 : 4,
        type, status: "running", fence: 1,
        workerId: "b3-worker-a", leaseToken: "b3-lease-a",
        nodeAttemptId: "b3-node-attempt-a",
      }));
      await client.query(workerEventSql({
        eventId: `b3-${type}-twice`, runId: "b3-main-run",
        sequence: type === "node.started" ? 4 : 5,
        type, status: "running", fence: 1,
        workerId: "b3-worker-a", leaseToken: "b3-lease-a",
        nodeAttemptId: "b3-node-attempt-a",
      }));
    }, "23505", type === "node.started"
      ? "workflow_run_events_node_started_uq"
      : "workflow_run_events_effect_recovery_started_uq");
  }
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-effect-recovery-without-start", runId: "b3-main-run", sequence: 3,
      type: "node.effect_recovery_completed", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a",
    }));
  }, "23514", "workflow_run_effect_recovery_predecessor_missing");
  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(workerEventSql({
      eventId: "b3-node-outcome-started", runId: "b3-main-run", sequence: 3,
      type: "node.started", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a", occurredAt: at,
    }));
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-node-attempt-a", invocationId: "b3-invocation-a",
      executionAttemptId: "b3-execution-attempt-a", status: "completed", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-node-outcome-once", runId: "b3-main-run", sequence: 4,
      type: "node.completed", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a", occurredAt: at,
    }));
    await client.query(workerEventSql({
      eventId: "b3-node-outcome-twice", runId: "b3-main-run", sequence: 5,
      type: "node.failed", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a", occurredAt: at,
    }));
  }, "23505", "workflow_run_events_node_outcome_uq");

  await expectConstraint(pool, workerEventSql({
    eventId: "b3-stale-event", runId: "b3-main-run", sequence: 3,
    type: "node.progress", status: "running", fence: 1,
    workerId: "b3-worker-a", leaseToken: "b3-wrong-token",
  }), [], "55000", "workflow_run_stale_worker_event");
  await expectConstraint(pool, workerEventSql({
    eventId: "b3-nonplan-node", runId: "b3-main-run", sequence: 3,
    type: "node.progress", status: "running", fence: 1,
    workerId: "b3-worker-a", leaseToken: "b3-lease-a",
    nodeId: "node-not-in-plan", nodeAttemptId: "b3-node-attempt-a",
  }), [], "23514", "workflow_run_event_node_not_in_plan");
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-wrong-node-attempt", runId: "b3-main-run", sequence: 3,
      type: "node.progress", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-missing-node-attempt",
    }));
  }, "23503", "workflow_run_events_node_attempt_fk");
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-progress-without-start", runId: "b3-main-run", sequence: 3,
      type: "node.progress", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a",
    }));
  }, "23514", "workflow_run_node_started_predecessor_missing");
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-premature-node-completed", runId: "b3-main-run", sequence: 3,
      type: "node.completed", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a",
    }));
  }, "23514", "workflow_run_execution_state_inconsistent");
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-premature-node-failed", runId: "b3-main-run", sequence: 3,
      type: "node.failed", status: "running", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      nodeAttemptId: "b3-node-attempt-a",
    }));
  }, "23514", "workflow_run_execution_state_inconsistent");
  for (const type of [
    "node.started", "node.progress", "node.effect_recovery_started",
    "node.effect_recovery_completed", "node.effect_recovery_unknown",
  ]) {
    await expectTransactionError(pool, async (client) => {
      const at = new Date().toISOString();
      await closeExecutionLineage(client, {
        nodeAttemptId: "b3-node-attempt-a", invocationId: "b3-invocation-a",
        executionAttemptId: "b3-execution-attempt-a", status: "completed", at,
      });
      await client.query(workerEventSql({
        eventId: `b3-incompatible-${type.replaceAll(".", "-")}`,
        runId: "b3-main-run", sequence: 3, type, status: "running", fence: 1,
        workerId: "b3-worker-a", leaseToken: "b3-lease-a",
        nodeAttemptId: "b3-node-attempt-a", occurredAt: at,
      }));
    }, "23514", "workflow_run_execution_state_inconsistent");
  }
  await expectConstraint(pool, workerEventSql({
    eventId: "b3-worker-self-cancel", runId: "b3-main-run", sequence: 3,
    type: "run.cancellation_requested", status: "cancellation_requested", fence: 1,
    workerId: "b3-worker-a", leaseToken: "b3-lease-a",
  }), [], "23514", "workflow_run_event_type_status_writer_mismatch");
  await expectConstraint(pool, workerEventSql({
    eventId: "b3-progress-fake-review", runId: "b3-main-run", sequence: 3,
    type: "node.progress", status: "waiting_review", fence: 1,
    workerId: "b3-worker-a", leaseToken: "b3-lease-a",
  }), [], "23514", "workflow_run_event_type_status_writer_mismatch");

  await pool.query(workerEventSql({
    eventId: "b3-node-started", runId: "b3-main-run", sequence: 3,
    type: "node.started", status: "running", fence: 1,
    workerId: "b3-worker-a", leaseToken: "b3-lease-a",
    nodeAttemptId: "b3-node-attempt-a",
  }));
  await pool.query(workerEventSql({
    eventId: "b3-node-skipped", runId: "b3-main-run", sequence: 4,
    type: "node.progress", status: "skipped", fence: 1,
    workerId: "b3-worker-a", leaseToken: "b3-lease-a",
  }));
  assert.equal(await runStatus(pool, "b3-main-run"), "running");

  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-orphan-review-event", runId: "b3-main-run", sequence: 5,
      type: "review.requested", status: "waiting_review", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      reviewId: "b3-orphan-review", nodeId: "node-a",
    }));
  }, "23503", "workflow_run_events_review_fk");

  await inTransaction(pool, async (client) => {
    await client.query(`
      UPDATE public.workflow_run_node_attempts
      SET status = 'waiting_review', updated_at = $1
      WHERE workspace_id = $2 AND node_attempt_id = 'b3-node-attempt-a'
    `, [new Date().toISOString(), W]);
    await client.query(workerEventSql({
      eventId: "b3-review-requested", runId: "b3-main-run", sequence: 5,
      type: "review.requested", status: "waiting_review", fence: 1,
      workerId: "b3-worker-a", leaseToken: "b3-lease-a",
      reviewId: "b3-review-a", nodeId: "node-a",
    }));
    await client.query(`
      INSERT INTO public.workflow_run_reviews (
        workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
        revision, schema_version, status, requested_at, updated_at
      ) VALUES (
        $1, 'b3-review-a', 'b3-main-run', $2, 'node-a', 'b3-node-attempt-a',
        1, 'workbench-run-review-v1', 'pending', $3, $3
      )
    `, [W, SCOPE, new Date().toISOString()]);
  });
  assert.equal(await runStatus(pool, "b3-main-run"), "waiting_review");

  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-orphan-review-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-a", targetRevision: 1, terminal: true,
    });
  }, "23503", "workflow_run_review_command_not_applied");

  await expectTransactionError(pool, async (client) => {
    const decidedAt = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-unclosed-review-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-a", targetRevision: 1, terminal: true,
    });
    await client.query(`
      UPDATE public.workflow_run_reviews
      SET status = 'decided', decision = 'approve',
          decision_command_id = 'b3-unclosed-review-command',
          decided_at = $1, updated_at = $1
      WHERE workspace_id = $2 AND review_id = 'b3-review-a' AND status = 'pending'
    `, [decidedAt, W]);
    await client.query(controllerEventSql({
      eventId: "b3-unclosed-review-command:event",
      runId: "b3-main-run", sequence: 6,
      type: "review.decided", status: "running",
      commandId: "b3-unclosed-review-command", fence: 1,
      reviewId: "b3-review-a", nodeId: "node-a", occurredAt: decidedAt,
    }));
  }, "23514", "workflow_run_review_execution_not_closed");

  await inTransaction(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-a", targetRevision: 1, terminal: true,
    });
    await client.query(`
      SELECT * FROM public.decide_workflow_run_review(
        $1, 'b3-review-a', 'b3-review-command', 'approve'
      )
    `, [W]);
    await client.query(`
      SELECT * FROM public.decide_workflow_run_review(
        $1, 'b3-review-a', 'b3-review-command', 'approve'
      )
    `, [W]);
  });
  const reviewDecisionEvents = await pool.query(`
    SELECT count(*)::integer AS count
    FROM public.workflow_run_events
    WHERE workspace_id = $1 AND run_id = 'b3-main-run'
      AND type = 'review.decided'
      AND product_command_id = 'b3-review-command'
  `, [W]);
  assert.equal(reviewDecisionEvents.rows[0].count, 1);
  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number,
        status, fence, created_at, updated_at
      ) VALUES (
        'b3-review-late-attempt', 'b3-invocation-a',
        'workbench-execution-fabric-v1', 2, 'queued', 2, $1, $1
      )
    `, [at]);
  }, "55000", "execution_attempt_parent_invocation_terminal");
  await expectConstraint(pool, `
    UPDATE public.workflow_run_reviews SET decision = 'revise', updated_at = $1
    WHERE workspace_id = $2 AND review_id = 'b3-review-a'
  `, [new Date().toISOString(), W], "55000", "workflow_run_review_already_decided");

  const resumed = await claim(pool, "b3-worker-b", "b3-lease-b");
  assert.equal(resumed.run_id, "b3-main-run");
  assert.equal(resumed.fence, 2);
  await seedExecutionLineage(pool, {
    runId: "b3-main-run", commandId: "b3-main-command", fence: 2,
    invocationId: "b3-invocation-b", attemptId: "b3-execution-attempt-b",
    checkpointId: "b3-checkpoint-b",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-main-run", commandId: "b3-main-command",
    nodeAttemptId: "b3-node-attempt-b", attemptNumber: 2,
    invocationId: "b3-invocation-b", executionAttemptId: "b3-execution-attempt-b",
    checkpointId: "b3-checkpoint-b", fence: 2,
    workerId: "b3-worker-b", leaseToken: "b3-lease-b",
  });
  await seedExecutionLineage(pool, {
    runId: "b3-main-run", commandId: "b3-main-command", fence: 2,
    invocationId: "b3-main-orphan-invocation",
    attemptId: "b3-main-orphan-execution-attempt",
    checkpointId: "b3-main-orphan-checkpoint",
  });
  await seedExecutionRetryAttempt(pool, {
    invocationId: "b3-main-orphan-invocation",
    attemptId: "b3-main-orphan-execution-attempt-2",
    attemptNumber: 2, fence: 3,
  });

  await expectTransactionError(pool, async (client) => {
    const finishedAt = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-node-attempt-b", invocationId: "b3-invocation-b",
      executionAttemptId: "b3-execution-attempt-b", status: "completed", at: finishedAt,
    });
    await closeExecutionFabric(client, {
      invocationId: "b3-main-orphan-invocation",
      executionAttemptId: "b3-main-orphan-execution-attempt-2",
      status: "completed", at: finishedAt,
      settleInvocation: false, releaseCapacity: false,
    });
    await client.query(`
      INSERT INTO public.workflow_run_final_outputs (
        workspace_id, run_id, node_id, node_attempt_id,
        schema_version, outcome, run_fence,
        lease_owner, lease_token, final_answer, created_at
      ) VALUES (
        $1, 'b3-main-run', 'node-a', 'b3-node-attempt-b',
        'workbench-run-final-output-v1', 'completed', 2,
        'b3-worker-b', 'b3-lease-b', '{"format":"json","content":{}}'::jsonb, $2
      )
    `, [W, finishedAt]);
    await client.query(workerEventSql({
      eventId: "b3-run-completed-with-running-history",
      runId: "b3-main-run", sequence: 8,
      type: "run.completed", status: "completed", fence: 2,
      workerId: "b3-worker-b", leaseToken: "b3-lease-b",
      nodeAttemptId: "b3-node-attempt-b", occurredAt: finishedAt,
    }));
  }, "23514", "workflow_run_terminal_execution_not_closed");

  await inTransaction(pool, async (client) => {
    const finishedAt = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-node-attempt-b", invocationId: "b3-invocation-b",
      executionAttemptId: "b3-execution-attempt-b", status: "completed", at: finishedAt,
    });
    await closeExecutionFabric(client, {
      invocationId: "b3-main-orphan-invocation",
      executionAttemptId: "b3-main-orphan-execution-attempt-2",
      status: "completed", at: finishedAt,
      settleInvocation: false, releaseCapacity: false,
    });
    await closeExecutionFabric(client, {
      invocationId: "b3-main-orphan-invocation",
      executionAttemptId: "b3-main-orphan-execution-attempt",
      status: "completed", at: finishedAt,
    });
    await client.query(`
      INSERT INTO public.workflow_run_final_outputs (
        workspace_id, run_id, node_id, node_attempt_id,
        schema_version, outcome, run_fence,
        lease_owner, lease_token, final_answer, created_at
      ) VALUES (
        $1, 'b3-main-run', 'node-a', 'b3-node-attempt-b',
        'workbench-run-final-output-v1', 'completed', 2,
        'b3-worker-b', 'b3-lease-b', '{"format":"json","content":{}}'::jsonb, $2
      )
    `, [W, finishedAt]);
    await client.query(workerEventSql({
      eventId: "b3-run-completed", runId: "b3-main-run", sequence: 8,
      type: "run.completed", status: "completed", fence: 2,
      workerId: "b3-worker-b", leaseToken: "b3-lease-b",
      nodeAttemptId: "b3-node-attempt-b", occurredAt: finishedAt,
    }));
  });
  assert.equal(await runStatus(pool, "b3-main-run"), "completed");
  assert.equal(await commandStatus(pool, "b3-main-command"), "completed");
  await expectConstraint(pool, workerEventSql({
    eventId: "b3-late-terminal", runId: "b3-main-run", sequence: 9,
    type: "node.progress", status: "running", fence: 2,
    workerId: "b3-worker-b", leaseToken: "b3-lease-b",
  }), [], "23514", "workflow_run_transition_invalid");
}

async function assertReviewReviseClosure(pool) {
  await createRun(pool, {
    runId: "b3-review-revise-run", commandId: "b3-review-revise-root-command",
    idempotencyKey: "b3-review-revise-key",
  });
  const claimed = await claim(pool, "b3-review-revise-worker", "b3-review-revise-lease");
  assert.equal(claimed.run_id, "b3-review-revise-run");
  await seedExecutionLineage(pool, {
    runId: "b3-review-revise-run", commandId: "b3-review-revise-root-command",
    fence: 1, invocationId: "b3-review-revise-invocation",
    attemptId: "b3-review-revise-execution-attempt",
    checkpointId: "b3-review-revise-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-review-revise-run", commandId: "b3-review-revise-root-command",
    nodeAttemptId: "b3-review-revise-node-attempt", attemptNumber: 1,
    invocationId: "b3-review-revise-invocation",
    executionAttemptId: "b3-review-revise-execution-attempt",
    checkpointId: "b3-review-revise-checkpoint", fence: 1,
    workerId: "b3-review-revise-worker", leaseToken: "b3-review-revise-lease",
  });
  await seedExecutionRetryAttempt(pool, {
    invocationId: "b3-review-revise-invocation",
    attemptId: "b3-review-revise-execution-attempt-retry",
    attemptNumber: 2, fence: 2,
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.workflow_run_node_attempts
      SET status = 'waiting_review', updated_at = $1
      WHERE workspace_id = $2 AND node_attempt_id = 'b3-review-revise-node-attempt'
    `, [at, W]);
    await client.query(workerEventSql({
      eventId: "b3-review-revise-requested", runId: "b3-review-revise-run",
      sequence: 3, type: "review.requested", status: "waiting_review", fence: 1,
      workerId: "b3-review-revise-worker", leaseToken: "b3-review-revise-lease",
      reviewId: "b3-review-revise", nodeAttemptId: "b3-review-revise-node-attempt",
      occurredAt: at,
    }));
    await client.query(`
      INSERT INTO public.workflow_run_reviews (
        workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
        revision, schema_version, status, requested_at, updated_at
      ) VALUES (
        $1, 'b3-review-revise', 'b3-review-revise-run', $2,
        'node-a', 'b3-review-revise-node-attempt', 1,
        'workbench-run-review-v1', 'pending', $3, $3
      )
    `, [W, SCOPE, at]);
  });
  await inTransaction(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-revise-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-revise", targetRevision: 1, terminal: true,
    });
    await client.query(`
      SELECT * FROM public.decide_workflow_run_review(
        $1, 'b3-review-revise', 'b3-review-revise-command', 'revise'
      )
    `, [W]);
  });
  const settled = await pool.query(`
    SELECT node_attempt.status AS node_status,
      invocation.status AS invocation_status,
      execution_attempt.status AS attempt_status,
      capability.status AS capability_status,
      capacity.status AS capacity_status
    FROM public.workflow_run_node_attempts node_attempt
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = node_attempt.invocation_id
     AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capability_leases capability
      ON capability.invocation_id = node_attempt.invocation_id
     AND capability.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capacity_leases capacity
      ON capacity.capacity_lease_id = invocation.capacity_lease_id
    WHERE node_attempt.workspace_id = $1
      AND node_attempt.node_attempt_id = 'b3-review-revise-node-attempt'
  `, [W]);
  assert.deepEqual(settled.rows[0], {
    node_status: "cancelled", invocation_status: "cancelled",
    attempt_status: "cancelled", capability_status: "revoked",
    capacity_status: "released",
  });
  const revisedAttempts = await pool.query(`
    SELECT attempt_id, status FROM public.execution_attempts
    WHERE invocation_id = 'b3-review-revise-invocation'
    ORDER BY attempt_number
  `);
  assert.deepEqual(revisedAttempts.rows, [
    { attempt_id: "b3-review-revise-execution-attempt", status: "cancelled" },
    {
      attempt_id: "b3-review-revise-execution-attempt-retry",
      status: "cancelled",
    },
  ]);

  const resumed = await claim(
    pool, "b3-review-revise-worker-2", "b3-review-revise-lease-2",
  );
  assert.equal(resumed.run_id, "b3-review-revise-run");
  await seedExecutionLineage(pool, {
    runId: "b3-review-revise-run", commandId: "b3-review-revise-root-command",
    fence: 2, invocationId: "b3-review-revise-invocation-2",
    attemptId: "b3-review-revise-execution-attempt-2",
    checkpointId: "b3-review-revise-checkpoint-2",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-review-revise-run", commandId: "b3-review-revise-root-command",
    nodeAttemptId: "b3-review-revise-node-attempt-2", attemptNumber: 2,
    invocationId: "b3-review-revise-invocation-2",
    executionAttemptId: "b3-review-revise-execution-attempt-2",
    checkpointId: "b3-review-revise-checkpoint-2", fence: 2,
    workerId: "b3-review-revise-worker-2", leaseToken: "b3-review-revise-lease-2",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-review-revise-node-attempt-2",
      invocationId: "b3-review-revise-invocation-2",
      executionAttemptId: "b3-review-revise-execution-attempt-2",
      status: "failed", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-review-revise-failed", runId: "b3-review-revise-run",
      sequence: 6, type: "run.failed", status: "failed", fence: 2,
      workerId: "b3-review-revise-worker-2", leaseToken: "b3-review-revise-lease-2",
      nodeAttemptId: "b3-review-revise-node-attempt-2", occurredAt: at,
    }));
  });
}

async function assertReviewRejectsUnresolvedEffectOutcome(pool) {
  await createRun(pool, {
    runId: "b3-review-preserve-run", commandId: "b3-review-preserve-root-command",
    idempotencyKey: "b3-review-preserve-key",
  });
  const claimed = await claim(
    pool, "b3-review-preserve-worker", "b3-review-preserve-lease",
  );
  assert.equal(claimed.run_id, "b3-review-preserve-run");
  await seedExecutionLineage(pool, {
    runId: "b3-review-preserve-run", commandId: "b3-review-preserve-root-command",
    fence: 1, invocationId: "b3-review-preserve-invocation",
    attemptId: "b3-review-preserve-reviewed-attempt",
    checkpointId: "b3-review-preserve-checkpoint",
  });
  await seedExecutionRetryAttempt(pool, {
    invocationId: "b3-review-preserve-invocation",
    attemptId: "b3-review-preserve-unknown-attempt",
    attemptNumber: 2, fence: 2,
    makeCurrent: false,
  });
  await insertEffectIntent(pool, {
    effectId: "b3-review-preserve-effect",
    invocationId: "b3-review-preserve-invocation",
    attemptId: "b3-review-preserve-unknown-attempt",
    runId: "b3-review-preserve-run",
  });
  await moveEffectToOutcomeUnknown(pool, "b3-review-preserve-effect");
  await pool.query(`
    UPDATE public.execution_attempts
    SET status = 'effect_outcome_unknown', finished_at = $1, updated_at = $1
    WHERE invocation_id = 'b3-review-preserve-invocation'
      AND attempt_id = 'b3-review-preserve-unknown-attempt'
  `, [new Date().toISOString()]);
  await seedExecutionRetryAttempt(pool, {
    invocationId: "b3-review-preserve-invocation",
    attemptId: "b3-review-preserve-running-attempt",
    attemptNumber: 3, fence: 3, makeCurrent: false,
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-review-preserve-run", commandId: "b3-review-preserve-root-command",
    nodeAttemptId: "b3-review-preserve-node-attempt", attemptNumber: 1,
    invocationId: "b3-review-preserve-invocation",
    executionAttemptId: "b3-review-preserve-reviewed-attempt",
    checkpointId: "b3-review-preserve-checkpoint", fence: 1,
    workerId: "b3-review-preserve-worker", leaseToken: "b3-review-preserve-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.workflow_run_node_attempts
      SET status = 'waiting_review', updated_at = $1
      WHERE workspace_id = $2
        AND node_attempt_id = 'b3-review-preserve-node-attempt'
    `, [at, W]);
    await client.query(workerEventSql({
      eventId: "b3-review-preserve-requested", runId: "b3-review-preserve-run",
      sequence: 3, type: "review.requested", status: "waiting_review", fence: 1,
      workerId: "b3-review-preserve-worker", leaseToken: "b3-review-preserve-lease",
      reviewId: "b3-review-preserve", nodeAttemptId: "b3-review-preserve-node-attempt",
      occurredAt: at,
    }));
    await client.query(`
      INSERT INTO public.workflow_run_reviews (
        workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
        revision, schema_version, status, requested_at, updated_at
      ) VALUES (
        $1, 'b3-review-preserve', 'b3-review-preserve-run', $2,
        'node-a', 'b3-review-preserve-node-attempt', 1,
        'workbench-run-review-v1', 'pending', $3, $3
      )
    `, [W, SCOPE, at]);
  });
  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-preserve-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-preserve", targetRevision: 1, terminal: true,
    });
    await client.query(`
      SELECT * FROM public.decide_workflow_run_review(
        $1, 'b3-review-preserve', 'b3-review-preserve-command', 'approve'
      )
    `, [W]);
  }, "23514", "workflow_run_review_effect_outcome_unresolved");
  const attempts = await pool.query(`
    SELECT execution_attempt.attempt_id, execution_attempt.status,
      capability.status AS capability_status
    FROM public.execution_attempts execution_attempt
    JOIN public.capability_leases capability
      ON capability.invocation_id = execution_attempt.invocation_id
     AND capability.attempt_id = execution_attempt.attempt_id
    WHERE execution_attempt.invocation_id = 'b3-review-preserve-invocation'
    ORDER BY execution_attempt.attempt_number
  `);
  assert.deepEqual(attempts.rows, [
    {
      attempt_id: "b3-review-preserve-reviewed-attempt", status: "running",
      capability_status: "active",
    },
    {
      attempt_id: "b3-review-preserve-unknown-attempt",
      status: "effect_outcome_unknown",
      capability_status: "active",
    },
    {
      attempt_id: "b3-review-preserve-running-attempt", status: "running",
      capability_status: "active",
    },
  ]);
  const unchanged = await pool.query(`
    SELECT run.status AS run_status, job.state AS job_state,
      review.status AS review_status, node_attempt.status AS node_status,
      invocation.status AS invocation_status,
      count(event.event_id)::integer AS decision_event_count
    FROM public.workflow_runs run
    JOIN public.workflow_run_jobs job
      ON job.workspace_id = run.workspace_id AND job.run_id = run.run_id
    JOIN public.workflow_run_reviews review
      ON review.workspace_id = run.workspace_id AND review.run_id = run.run_id
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = review.workspace_id
     AND node_attempt.node_attempt_id = review.node_attempt_id
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    LEFT JOIN public.workflow_run_events event
      ON event.workspace_id = run.workspace_id AND event.run_id = run.run_id
     AND event.type = 'review.decided'
    WHERE run.workspace_id = $1 AND run.run_id = 'b3-review-preserve-run'
    GROUP BY run.status, job.state, review.status,
      node_attempt.status, invocation.status
  `, [W]);
  assert.deepEqual(unchanged.rows[0], {
    run_status: "waiting_review", job_state: "waiting_review",
    review_status: "pending", node_status: "waiting_review",
    invocation_status: "running", decision_event_count: 0,
  });
}

async function assertReviewAttemptSetSerialization(pool) {
  for (const mutation of ["insert", "update", "review-first-update"]) {
    const prefix = `b3-review-race-${mutation}`;
    const runId = `${prefix}-run`;
    const invocationId = `${prefix}-invocation`;
    const reviewedAttemptId = `${prefix}-reviewed-attempt`;
    const concurrentAttemptId = `${prefix}-concurrent-attempt`;
    const nodeAttemptId = `${prefix}-node-attempt`;
    const reviewId = `${prefix}-review`;
    const commandId = `${prefix}-root-command`;
    await createRun(pool, {
      runId, commandId, idempotencyKey: `${prefix}-key`,
    });
    const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
    assert.equal(claimed.run_id, runId);
    await seedExecutionLineage(pool, {
      runId, commandId, fence: 1, invocationId,
      attemptId: reviewedAttemptId, checkpointId: `${prefix}-checkpoint`,
    });
    await seedRunNodeAttempt(pool, {
      runId, commandId, nodeAttemptId, attemptNumber: 1,
      invocationId, executionAttemptId: reviewedAttemptId,
      checkpointId: `${prefix}-checkpoint`, fence: 1,
      workerId: `${prefix}-worker`, leaseToken: `${prefix}-lease`,
    });
    if (mutation !== "insert") {
      await seedExecutionRetryAttempt(pool, {
        invocationId, attemptId: concurrentAttemptId,
        attemptNumber: 2, fence: 2,
      });
    }
    await inTransaction(pool, async (client) => {
      const at = new Date().toISOString();
      await client.query(`
        UPDATE public.workflow_run_node_attempts
        SET status = 'waiting_review', updated_at = $1
        WHERE workspace_id = $2 AND node_attempt_id = $3
      `, [at, W, nodeAttemptId]);
      await client.query(workerEventSql({
        eventId: `${prefix}-requested`, runId, sequence: 3,
        type: "review.requested", status: "waiting_review", fence: 1,
        workerId: `${prefix}-worker`, leaseToken: `${prefix}-lease`,
        reviewId, nodeAttemptId, occurredAt: at,
      }));
      await client.query(`
        INSERT INTO public.workflow_run_reviews (
          workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
          revision, schema_version, status, requested_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, 'node-a', $5, 1,
          'workbench-run-review-v1', 'pending', $6, $6
        )
      `, [W, reviewId, runId, SCOPE, nodeAttemptId, at]);
    });

    if (mutation === "review-first-update") {
      await assertReviewFirstUpdateRace(pool, {
        prefix, runId, invocationId, concurrentAttemptId, reviewId,
      });
      continue;
    }

    const mutationClient = await pool.connect();
    const reviewClient = await pool.connect();
    let mutationOpen = false;
    let reviewOpen = false;
    try {
      await mutationClient.query("BEGIN");
      mutationOpen = true;
      const at = new Date().toISOString();
      if (mutation === "insert") {
        await mutationClient.query(`
          INSERT INTO public.execution_attempts (
            attempt_id, invocation_id, schema_version, attempt_number,
            status, fence, started_at, created_at, updated_at
          ) VALUES (
            $1, $2, 'workbench-execution-fabric-v1', 2,
            'running', 2, $3, $3, $3
          )
        `, [concurrentAttemptId, invocationId, at]);
      }
      await insertEffectIntent(mutationClient, {
        effectId: `${prefix}-concurrent-effect`, invocationId,
        attemptId: concurrentAttemptId, runId,
      });
      await moveEffectToOutcomeUnknown(
        mutationClient, `${prefix}-concurrent-effect`,
      );
      await mutationClient.query(`
        UPDATE public.execution_attempts
        SET status = 'effect_outcome_unknown', finished_at = $1, updated_at = $1
        WHERE invocation_id = $2 AND attempt_id = $3
      `, [at, invocationId, concurrentAttemptId]);

      await reviewClient.query("BEGIN");
      reviewOpen = true;
      await insertAuthorizedCommand(reviewClient, {
        commandId: `${prefix}-decision-command`, kind: "workflow_run_review",
        effectClass: "write_local", targetKind: "workflow_run_review",
        targetId: reviewId, targetRevision: 1, terminal: true,
      });
      const reviewPid = (
        await reviewClient.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      let reviewError;
      const reviewCompletion = (async () => {
        try {
          await reviewClient.query(`
            SELECT * FROM public.decide_workflow_run_review($1, $2, $3, 'approve')
          `, [W, reviewId, `${prefix}-decision-command`]);
        } catch (error) {
          reviewError = error;
        }
      })();
      await waitForBackendLock(pool, reviewPid);
      await mutationClient.query("COMMIT");
      mutationOpen = false;
      await reviewCompletion;
      assert.equal(reviewError?.code, "23514");
      assert.match(
        String(reviewError?.message),
        /workflow_run_review_effect_outcome_unresolved/,
      );
      await reviewClient.query("ROLLBACK");
      reviewOpen = false;
    } finally {
      if (mutationOpen) await mutationClient.query("ROLLBACK");
      if (reviewOpen) await reviewClient.query("ROLLBACK");
      mutationClient.release();
      reviewClient.release();
    }

    const state = await pool.query(`
      SELECT run.status AS run_status, review.status AS review_status,
        invocation.status AS invocation_status,
        execution_attempt.status AS concurrent_attempt_status
      FROM public.workflow_runs run
      JOIN public.workflow_run_reviews review
        ON review.workspace_id = run.workspace_id AND review.run_id = run.run_id
      JOIN public.execution_invocations invocation
        ON invocation.workspace_id = run.workspace_id
       AND invocation.controller_kind = 'workflow_run'
       AND invocation.controller_id = run.run_id
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
       AND execution_attempt.attempt_id = $3
      WHERE run.workspace_id = $1 AND run.run_id = $2
    `, [W, runId, concurrentAttemptId]);
    assert.deepEqual(state.rows[0], {
      run_status: "waiting_review", review_status: "pending",
      invocation_status: "running",
      concurrent_attempt_status: "effect_outcome_unknown",
    });
  }
}

async function assertReviewFirstUpdateRace(pool, {
  prefix, runId, invocationId, concurrentAttemptId, reviewId,
}) {
  const reviewClient = await pool.connect();
  const mutationClient = await pool.connect();
  let reviewOpen = false;
  let mutationOpen = false;
  try {
    await reviewClient.query("BEGIN");
    reviewOpen = true;
    await insertAuthorizedCommand(reviewClient, {
      commandId: `${prefix}-decision-command`, kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: reviewId, targetRevision: 1, terminal: true,
    });
    await reviewClient.query(`
      SELECT * FROM public.decide_workflow_run_review($1, $2, $3, 'approve')
    `, [W, reviewId, `${prefix}-decision-command`]);

    await mutationClient.query("BEGIN");
    mutationOpen = true;
    const mutationPid = (
      await mutationClient.query("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    let mutationError;
    const mutationCompletion = (async () => {
      try {
        const at = new Date().toISOString();
        await mutationClient.query(`
          UPDATE public.execution_attempts
          SET status = 'effect_outcome_unknown', finished_at = $1, updated_at = $1
          WHERE invocation_id = $2 AND attempt_id = $3
        `, [at, invocationId, concurrentAttemptId]);
      } catch (error) {
        mutationError = error;
      }
    })();
    await waitForBackendLock(pool, mutationPid);
    await reviewClient.query("COMMIT");
    reviewOpen = false;
    await mutationCompletion;
    assert.equal(mutationError?.code, "55000");
    assert.match(
      String(mutationError?.message),
      /execution_attempt_parent_invocation_terminal/,
    );
    await mutationClient.query("ROLLBACK");
    mutationOpen = false;
  } finally {
    if (reviewOpen) await reviewClient.query("ROLLBACK");
    if (mutationOpen) await mutationClient.query("ROLLBACK");
    reviewClient.release();
    mutationClient.release();
  }

  const state = await pool.query(`
    SELECT run.status AS run_status, review.status AS review_status,
      invocation.status AS invocation_status,
      execution_attempt.status AS concurrent_attempt_status,
      count(event.event_id)::integer AS decision_event_count
    FROM public.workflow_runs run
    JOIN public.workflow_run_reviews review
      ON review.workspace_id = run.workspace_id AND review.run_id = run.run_id
    JOIN public.execution_invocations invocation
      ON invocation.workspace_id = run.workspace_id
     AND invocation.controller_kind = 'workflow_run'
     AND invocation.controller_id = run.run_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = invocation.invocation_id
     AND execution_attempt.attempt_id = $3
    LEFT JOIN public.workflow_run_events event
      ON event.workspace_id = run.workspace_id AND event.run_id = run.run_id
     AND event.type = 'review.decided'
    WHERE run.workspace_id = $1 AND run.run_id = $2
    GROUP BY run.status, review.status, invocation.status, execution_attempt.status
  `, [W, runId, concurrentAttemptId]);
  assert.deepEqual(state.rows[0], {
    run_status: "running", review_status: "decided",
    invocation_status: "completed", concurrent_attempt_status: "cancelled",
    decision_event_count: 1,
  });
}

async function assertMultiEffectReconciliation(pool) {
  const cases = [
    { name: "success-unknown", receiptStatuses: ["succeeded", "outcome_unknown"],
      resultStatus: "completed", allowed: false },
    { name: "mixed-terminal", receiptStatuses: ["succeeded", "cancelled"],
      resultStatus: "completed", allowed: false },
    { name: "mixed-terminal-cancelled", receiptStatuses: ["succeeded", "cancelled"],
      resultStatus: "cancelled", allowed: true },
    { name: "all-success", receiptStatuses: ["succeeded", "succeeded"],
      resultStatus: "completed", allowed: true },
    { name: "all-cancelled", receiptStatuses: ["cancelled", "cancelled"],
      resultStatus: "cancelled", allowed: true },
  ];
  for (const testCase of cases) {
    const prefix = `b3-effect-${testCase.name}`;
    const runId = `${prefix}-run`;
    const invocationId = `${prefix}-invocation`;
    const attemptId = `${prefix}-attempt`;
    await createRun(pool, {
      runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
    });
    const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
    assert.equal(claimed.run_id, runId);
    await seedExecutionLineage(pool, {
      runId, commandId: `${prefix}-command`, fence: 1,
      invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
    });
    for (let index = 0; index < 2; index += 1) {
      await insertEffectIntent(pool, {
        effectId: `${prefix}-receipt-${index}`, invocationId, attemptId, runId,
      });
      const at = new Date().toISOString();
      await pool.query(`
        UPDATE public.external_effect_receipts
        SET status = 'dispatching', dispatch_started_at = $1,
            reconcile_after = $1, updated_at = $1
        WHERE workspace_id = $2 AND effect_id = $3
      `, [at, W, `${prefix}-receipt-${index}`]);
      await pool.query(`
        UPDATE public.external_effect_receipts
        SET status = 'outcome_unknown', failed_at = $1, updated_at = $1
        WHERE workspace_id = $2 AND effect_id = $3
      `, [at, W, `${prefix}-receipt-${index}`]);
    }
    await inTransaction(pool, async (client) => {
      const at = new Date().toISOString();
      await client.query(`
        UPDATE public.execution_attempts
        SET status = 'effect_outcome_unknown', finished_at = $1, updated_at = $1
        WHERE invocation_id = $2 AND attempt_id = $3
      `, [at, invocationId, attemptId]);
      await client.query(`
        UPDATE public.execution_invocations
        SET status = 'effect_outcome_unknown', finished_at = $1, updated_at = $1
        WHERE invocation_id = $2
      `, [at, invocationId]);
    });
    const firstTarget = testCase.receiptStatuses[0];
    if (firstTarget !== "outcome_unknown") {
      const at = new Date().toISOString();
      await pool.query(`
        UPDATE public.external_effect_receipts
        SET status = $1, completed_at = $2, cancelled_at = $3,
            failed_at = NULL, updated_at = $4
        WHERE workspace_id = $5 AND effect_id = $6
      `, [
        firstTarget, firstTarget === "succeeded" ? at : null,
        firstTarget === "cancelled" ? at : null, at, W, `${prefix}-receipt-0`,
      ]);
    }
    const settle = async (client) => {
      const at = new Date().toISOString();
      const finalReceiptStatus = testCase.receiptStatuses[1];
      if (finalReceiptStatus !== "outcome_unknown") {
        await client.query(`
          UPDATE public.external_effect_receipts
          SET status = $1, completed_at = $2, cancelled_at = $3,
              failed_at = NULL, updated_at = $4
          WHERE workspace_id = $5 AND effect_id = $6
        `, [
          finalReceiptStatus, finalReceiptStatus === "succeeded" ? at : null,
          finalReceiptStatus === "cancelled" ? at : null,
          at, W, `${prefix}-receipt-1`,
        ]);
      }
      await client.query(`
        UPDATE public.execution_attempts
        SET status = $1, finished_at = $2, updated_at = $2
        WHERE invocation_id = $3 AND attempt_id = $4
      `, [testCase.resultStatus, at, invocationId, attemptId]);
      await client.query(`
        UPDATE public.execution_invocations
        SET status = $1, finished_at = $2, updated_at = $2
        WHERE invocation_id = $3
      `, [testCase.resultStatus, at, invocationId]);
    };
    if (testCase.allowed) {
      await inTransaction(pool, settle);
    } else {
      await expectTransactionError(
        pool, settle, "55000", "execution_attempt_parent_invocation_terminal",
      );
    }
    const status = await pool.query(`
      SELECT invocation.status AS invocation_status,
        execution_attempt.status AS attempt_status
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
       AND execution_attempt.attempt_id = $2
      WHERE invocation.invocation_id = $1
    `, [invocationId, attemptId]);
    const expectedStatus = testCase.allowed
      ? testCase.resultStatus
      : "effect_outcome_unknown";
    assert.deepEqual(status.rows[0], {
      invocation_status: expectedStatus,
      attempt_status: expectedStatus,
    });
  }
}

async function assertEffectReceiptInitialState(pool) {
  const prefix = "b3-effect-initial";
  const runId = `${prefix}-run`;
  const invocationId = `${prefix}-invocation`;
  const attemptId = `${prefix}-attempt`;
  await createRun(pool, {
    runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
  });
  const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
  assert.equal(claimed.run_id, runId);
  await seedExecutionLineage(pool, {
    runId, commandId: `${prefix}-command`, fence: 1,
    invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
  });
  await insertEffectIntent(pool, {
    effectId: `${prefix}-intent`, invocationId, attemptId, runId,
  });
  const recorded = await pool.query(`
    SELECT status, controller_id, invocation_id, attempt_id
    FROM public.external_effect_receipts
    WHERE workspace_id = $1 AND effect_id = $2
  `, [W, `${prefix}-intent`]);
  assert.deepEqual(recorded.rows[0], {
    status: "intent_recorded", controller_id: runId, invocation_id: invocationId,
    attempt_id: attemptId,
  });
  for (const status of ["succeeded", "cancelled", "outcome_unknown"]) {
    await expectTransactionError(pool, async (client) => {
      const at = new Date().toISOString();
      await client.query(`
        INSERT INTO public.external_effect_receipts (
          workspace_id, effect_id, schema_version, invocation_id, attempt_id,
          controller_id, node_id, connection_id, action, argument_digest,
          status, created_at, updated_at
        ) VALUES (
          $1, $2, 'workbench-internal-v1', $3, $4, $5, 'node-a',
          'b3-effect-connection', 'tool.execute', $6, $7, $8, $8
        )
      `, [
        W, `${prefix}-${status}`, invocationId, attemptId, runId,
        `sha256:${"f".repeat(64)}`, status, at,
      ]);
    }, "23514", "external_effect_receipt_initial_status_invalid");
  }
}

async function assertSettledReceiptMixPermitsNonSuccessTerminalParent(pool) {
  for (const resultStatus of ["failed", "partial"]) {
    const prefix = `b3-effect-settled-mix-${resultStatus}`;
    const runId = `${prefix}-run`;
    const invocationId = `${prefix}-invocation`;
    const attemptId = `${prefix}-attempt`;
    await createRun(pool, {
      runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
    });
    const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
    assert.equal(claimed.run_id, runId);
    await seedExecutionLineage(pool, {
      runId, commandId: `${prefix}-command`, fence: 1,
      invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
    });
    for (let index = 0; index < 2; index += 1) {
      const effectId = `${prefix}-receipt-${index}`;
      await insertEffectIntent(pool, { effectId, invocationId, attemptId, runId });
      const at = new Date().toISOString();
      await pool.query(`
        UPDATE public.external_effect_receipts
        SET status = 'dispatching', dispatch_started_at = $1,
            reconcile_after = $1, updated_at = $1
        WHERE workspace_id = $2 AND effect_id = $3
      `, [at, W, effectId]);
      const receiptStatus = index === 0 ? "succeeded" : "cancelled";
      await pool.query(`
        UPDATE public.external_effect_receipts
        SET status = $1, completed_at = $2, cancelled_at = $3, updated_at = $4
        WHERE workspace_id = $5 AND effect_id = $6
      `, [
        receiptStatus, receiptStatus === "succeeded" ? at : null,
        receiptStatus === "cancelled" ? at : null, at, W, effectId,
      ]);
    }
    await inTransaction(pool, async (client) => {
      await closeExecutionFabric(client, {
        invocationId, executionAttemptId: attemptId,
        status: resultStatus, at: new Date().toISOString(),
      });
    });
    const status = await pool.query(`
      SELECT invocation.status AS invocation_status,
        execution_attempt.status AS attempt_status
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
       AND execution_attempt.attempt_id = $2
      WHERE invocation.invocation_id = $1
    `, [invocationId, attemptId]);
    assert.deepEqual(status.rows[0], {
      invocation_status: resultStatus,
      attempt_status: resultStatus,
    });
  }
}

async function assertCancellationStopsNewEffectDispatch(pool) {
  const prefix = "b3-effect-cancellation-dispatch";
  const runId = `${prefix}-run`;
  const invocationId = `${prefix}-invocation`;
  const attemptId = `${prefix}-attempt`;
  const effectId = `${prefix}-receipt`;
  await createRun(pool, {
    runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
  });
  const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
  assert.equal(claimed.run_id, runId);
  await seedExecutionLineage(pool, {
    runId, commandId: `${prefix}-command`, fence: 1,
    invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
  });
  await insertEffectIntent(pool, { effectId, invocationId, attemptId, runId });
  const cancellationAt = new Date().toISOString();
  await pool.query(`
    UPDATE public.execution_invocations
    SET status = 'cancellation_requested', cancel_requested_at = $1, updated_at = $1
    WHERE invocation_id = $2
  `, [cancellationAt, invocationId]);
  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.external_effect_receipts
      SET status = 'dispatching', dispatch_started_at = $1,
          reconcile_after = $1, updated_at = $1
      WHERE workspace_id = $2 AND effect_id = $3
    `, [at, W, effectId]);
  }, "55000", "external_effect_receipt_dispatch_after_cancellation");
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.external_effect_receipts
      SET status = 'cancelled', cancelled_at = $1, updated_at = $1
      WHERE workspace_id = $2 AND effect_id = $3
    `, [at, W, effectId]);
    await closeExecutionFabric(client, {
      invocationId, executionAttemptId: attemptId, status: "cancelled", at,
    });
  });
}

async function assertReceiptTransitionLosesToTerminalParent(pool) {
  const prefix = "b3-effect-parent-race";
  const runId = `${prefix}-run`;
  const invocationId = `${prefix}-invocation`;
  const attemptId = `${prefix}-attempt`;
  const effectId = `${prefix}-receipt`;
  await createRun(pool, {
    runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
  });
  const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
  assert.equal(claimed.run_id, runId);
  await seedExecutionLineage(pool, {
    runId, commandId: `${prefix}-command`, fence: 1,
    invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
  });
  await insertEffectIntent(pool, { effectId, invocationId, attemptId, runId });

  const parentClient = await pool.connect();
  const receiptClient = await pool.connect();
  let parentOpen = false;
  let receiptOpen = false;
  try {
    await parentClient.query("BEGIN");
    parentOpen = true;
    await closeExecutionFabric(parentClient, {
      invocationId, executionAttemptId: attemptId,
      status: "completed", at: new Date().toISOString(),
    });
    await receiptClient.query("BEGIN");
    receiptOpen = true;
    const receiptPid = (
      await receiptClient.query("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    let receiptError;
    const receiptCompletion = (async () => {
      try {
        const at = new Date().toISOString();
        await receiptClient.query(`
          UPDATE public.external_effect_receipts
          SET status = 'dispatching', dispatch_started_at = $1,
              reconcile_after = $1, updated_at = $1
          WHERE workspace_id = $2 AND effect_id = $3
        `, [at, W, effectId]);
      } catch (error) {
        receiptError = error;
      }
    })();
    await waitForBackendLock(pool, receiptPid);
    let parentError;
    try {
      await parentClient.query("COMMIT");
    } catch (error) {
      parentError = error;
      await parentClient.query("ROLLBACK");
    }
    parentOpen = false;
    await receiptCompletion;
    assert.equal(parentError?.code, "23514");
    assert.match(
      String(parentError?.message), /execution_effect_receipt_parent_inconsistent/,
    );
    assert.equal(receiptError, undefined);
    await receiptClient.query("ROLLBACK");
    receiptOpen = false;
  } finally {
    if (parentOpen) await parentClient.query("ROLLBACK");
    if (receiptOpen) await receiptClient.query("ROLLBACK");
    parentClient.release();
    receiptClient.release();
  }
  const receipt = await pool.query(`
    SELECT status FROM public.external_effect_receipts
    WHERE workspace_id = $1 AND effect_id = $2
  `, [W, effectId]);
  assert.equal(receipt.rows[0].status, "intent_recorded");
}

async function assertReceiptFirstBlocksTerminalParent(pool) {
  for (const liveStatus of ["intent_recorded", "dispatching"]) {
    const prefix = `b3-effect-receipt-first-${liveStatus}`;
    const runId = `${prefix}-run`;
    const invocationId = `${prefix}-invocation`;
    const attemptId = `${prefix}-attempt`;
    const effectId = `${prefix}-receipt`;
    await createRun(pool, {
      runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
    });
    const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
    assert.equal(claimed.run_id, runId);
    await seedExecutionLineage(pool, {
      runId, commandId: `${prefix}-command`, fence: 1,
      invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
    });
    const receiptClient = await pool.connect();
    const parentClient = await pool.connect();
    try {
      await insertEffectIntent(receiptClient, { effectId, invocationId, attemptId, runId });
      if (liveStatus === "dispatching") {
        const at = new Date().toISOString();
        await receiptClient.query(`
          UPDATE public.external_effect_receipts
          SET status = 'dispatching', dispatch_started_at = $1,
              reconcile_after = $1, updated_at = $1
          WHERE workspace_id = $2 AND effect_id = $3
        `, [at, W, effectId]);
      }
      await parentClient.query("BEGIN");
      await closeExecutionFabric(parentClient, {
        invocationId, executionAttemptId: attemptId,
        status: "completed", at: new Date().toISOString(),
      });
      await assert.rejects(
        () => parentClient.query("COMMIT"),
        (error) => {
          assert.equal(error?.code, "23514");
          assert.match(
            String(error?.message), /execution_effect_receipt_parent_inconsistent/,
          );
          return true;
        },
      );
      await parentClient.query("ROLLBACK");
      const parent = await pool.query(`
        SELECT invocation.status AS invocation_status,
          execution_attempt.status AS attempt_status
        FROM public.execution_invocations invocation
        JOIN public.execution_attempts execution_attempt
          ON execution_attempt.invocation_id = invocation.invocation_id
         AND execution_attempt.attempt_id = $2
        WHERE invocation.invocation_id = $1
      `, [invocationId, attemptId]);
      assert.deepEqual(parent.rows[0], {
        invocation_status: "running", attempt_status: "running",
      });
      if (liveStatus === "intent_recorded") {
        const at = new Date().toISOString();
        await receiptClient.query(`
          UPDATE public.external_effect_receipts
          SET status = 'dispatching', dispatch_started_at = $1,
              reconcile_after = $1, updated_at = $1
          WHERE workspace_id = $2 AND effect_id = $3
        `, [at, W, effectId]);
      }
      const settledAt = new Date().toISOString();
      await receiptClient.query(`
        UPDATE public.external_effect_receipts
        SET status = 'succeeded', completed_at = $1, updated_at = $1
        WHERE workspace_id = $2 AND effect_id = $3
      `, [settledAt, W, effectId]);
      await inTransaction(pool, async (client) => {
        await closeExecutionFabric(client, {
          invocationId, executionAttemptId: attemptId,
          status: "completed", at: new Date().toISOString(),
        });
      });
    } finally {
      receiptClient.release();
      parentClient.release();
    }
  }
}

async function assertZeroReceiptTerminalParent(pool) {
  const prefix = "b3-effect-zero-receipt";
  const runId = `${prefix}-run`;
  const invocationId = `${prefix}-invocation`;
  const attemptId = `${prefix}-attempt`;
  await createRun(pool, {
    runId, commandId: `${prefix}-command`, idempotencyKey: `${prefix}-key`,
  });
  const claimed = await claim(pool, `${prefix}-worker`, `${prefix}-lease`);
  assert.equal(claimed.run_id, runId);
  await seedExecutionLineage(pool, {
    runId, commandId: `${prefix}-command`, fence: 1,
    invocationId, attemptId, checkpointId: `${prefix}-checkpoint`,
  });
  await inTransaction(pool, async (client) => {
    await closeExecutionFabric(client, {
      invocationId, executionAttemptId: attemptId,
      status: "completed", at: new Date().toISOString(),
    });
  });
  const status = await pool.query(`
    SELECT status FROM public.execution_invocations WHERE invocation_id = $1
  `, [invocationId]);
  assert.equal(status.rows[0].status, "completed");
}

async function insertEffectIntent(pool, { effectId, invocationId, attemptId, runId }) {
  const at = new Date().toISOString();
  await pool.query(`
    INSERT INTO public.external_effect_receipts (
      workspace_id, effect_id, schema_version, invocation_id, attempt_id,
      controller_id, node_id, connection_id, action, argument_digest,
      status, created_at, updated_at
    ) VALUES (
      $1, $2, 'workbench-internal-v1', $3, $4, $5, 'node-a',
      'b3-effect-connection', 'tool.execute', $6, 'intent_recorded', $7, $7
    )
  `, [W, effectId, invocationId, attemptId, runId, `sha256:${"e".repeat(64)}`, at]);
}

async function moveEffectToOutcomeUnknown(database, effectId) {
  const at = new Date().toISOString();
  await database.query(`
    UPDATE public.external_effect_receipts
    SET status = 'dispatching', dispatch_started_at = $1,
        reconcile_after = $1, updated_at = $1
    WHERE workspace_id = $2 AND effect_id = $3
  `, [at, W, effectId]);
  await database.query(`
    UPDATE public.external_effect_receipts
    SET status = 'outcome_unknown', failed_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND effect_id = $3
  `, [at, W, effectId]);
}

async function assertLeaseTransitionEvents(pool) {
  await createRun(pool, {
    runId: "b3-lease-run", commandId: "b3-lease-command", idempotencyKey: "b3-lease-key",
  });
  const claimed = await claim(pool, "b3-lease-worker", "b3-lease-token");
  assert.equal(claimed.run_id, "b3-lease-run");
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-fake-renewal", runId: "b3-lease-run", sequence: 3,
      type: "run.lease_renewed", status: "running", fence: 1,
      workerId: "b3-lease-worker", leaseToken: "b3-lease-token",
      leaseExpiresAt: claimed.lease_expires_at, previousFence: 1,
      previousLeaseOwner: "b3-lease-worker", previousLeaseToken: "b3-lease-token",
      previousLeaseExpiresAt: new Date(Date.parse(claimed.lease_expires_at) - 1_000).toISOString(),
    }));
  }, "55000", "workflow_run_stale_worker_event");

  const renewal = await inTransactionResult(pool, async (client) => {
    const current = (await client.query(`
      SELECT fence, lease_owner, lease_token, lease_expires_at
      FROM public.workflow_run_jobs
      WHERE workspace_id = $1 AND run_id = 'b3-lease-run'
    `, [W])).rows[0];
    const renewed = (await client.query(`
      SELECT * FROM public.renew_workflow_run_job_lease(
        $1, 'b3-lease-run', 'b3-lease-worker', 'b3-lease-token',
        'b3-renewal', interval '2 minutes'
      )
    `, [W])).rows[0];
    assert.ok(
      Date.parse(renewed.lease_expires_at) > Date.parse(current.lease_expires_at),
      "renewal must strictly extend the existing database lease",
    );
    return { current, renewed };
  });

  for (const [suffix, expression] of [
    ["equal", "lease_expires_at"],
    ["earlier", "lease_expires_at - interval '1 second'"],
  ]) {
    await expectTransactionError(pool, async (client) => {
      const current = (await client.query(`
        SELECT fence, lease_owner, lease_token, lease_expires_at
        FROM public.workflow_run_jobs
        WHERE workspace_id = $1 AND run_id = 'b3-lease-run'
      `, [W])).rows[0];
      const next = (await client.query(`
        SELECT ${expression} AS lease_expires_at, clock_timestamp() AS occurred_at
        FROM public.workflow_run_jobs
        WHERE workspace_id = $1 AND run_id = 'b3-lease-run'
      `, [W])).rows[0];
      await client.query(`
        UPDATE public.workflow_run_jobs
        SET lease_expires_at = $1, lease_event_id = $2, updated_at = $3
        WHERE workspace_id = $4 AND run_id = 'b3-lease-run'
      `, [next.lease_expires_at, `b3-renewal-${suffix}`, next.occurred_at, W]);
      await client.query(workerEventSql({
        eventId: `b3-renewal-${suffix}`, runId: "b3-lease-run", sequence: 4,
        type: "run.lease_renewed", status: "running", fence: current.fence,
        workerId: current.lease_owner, leaseToken: current.lease_token,
        leaseExpiresAt: next.lease_expires_at, previousFence: current.fence,
        previousLeaseOwner: current.lease_owner,
        previousLeaseToken: current.lease_token,
        previousLeaseExpiresAt: current.lease_expires_at,
        occurredAt: next.occurred_at,
      }));
    }, "23514", "workflow_run_lease_expiry_not_extended");
  }

  await expectTransactionError(pool, async (client) => {
    const current = (await client.query(`
      SELECT fence, lease_owner, lease_token, lease_expires_at
      FROM public.workflow_run_jobs
      WHERE workspace_id = $1 AND run_id = 'b3-lease-run'
    `, [W])).rows[0];
    const occurredAt = new Date().toISOString();
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET lease_expires_at = $1, lease_event_id = 'b3-tuple-rollback', updated_at = $2
      WHERE workspace_id = $3 AND run_id = 'b3-lease-run'
    `, [claimed.lease_expires_at, occurredAt, W]);
    await client.query(workerEventSql({
      eventId: "b3-tuple-rollback", runId: "b3-lease-run", sequence: 4,
      type: "run.lease_renewed", status: "running", fence: current.fence,
      workerId: current.lease_owner, leaseToken: current.lease_token,
      leaseExpiresAt: claimed.lease_expires_at, previousFence: current.fence,
      previousLeaseOwner: current.lease_owner,
      previousLeaseToken: current.lease_token,
      previousLeaseExpiresAt: current.lease_expires_at, occurredAt,
    }));
  }, "23514", "workflow_run_lease_expiry_not_extended");

  await expectTransactionError(pool, async (client) => {
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET lease_expires_at = lease_expires_at + interval '1 second',
          lease_event_id = 'b3-lease-token:event', updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND run_id = 'b3-lease-run'
    `, [W]);
  }, "23514", "workflow_run_job_lease_event_missing");

  await expectTransactionError(pool, async (client) => {
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET lease_expires_at = lease_expires_at + interval '1 second',
          updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND run_id = 'b3-lease-run'
    `, [W]);
  }, "23514", "workflow_run_job_lease_event_id_required");

  await expectTransactionError(pool, async (client) => {
    const far = (await client.query(`
      SELECT clock_timestamp() + interval '2 hours' AS lease_expires_at,
        clock_timestamp() AS occurred_at
    `)).rows[0];
    await client.query(`
      UPDATE public.workflow_run_jobs
      SET lease_expires_at = $1, lease_event_id = 'b3-far-renewal', updated_at = $2
      WHERE workspace_id = $3 AND run_id = 'b3-lease-run'
    `, [far.lease_expires_at, far.occurred_at, W]);
    await client.query(workerEventSql({
      eventId: "b3-far-renewal", runId: "b3-lease-run", sequence: 4,
      type: "run.lease_renewed", status: "running", fence: 1,
      workerId: "b3-lease-worker", leaseToken: "b3-lease-token",
      leaseExpiresAt: far.lease_expires_at, previousFence: 1,
      previousLeaseOwner: "b3-lease-worker", previousLeaseToken: "b3-lease-token",
      previousLeaseExpiresAt: renewal.renewed.lease_expires_at,
      occurredAt: far.occurred_at,
    }));
  }, "55000", "workflow_run_stale_worker_event");

  await seedExecutionLineage(pool, {
    runId: "b3-lease-run", commandId: "b3-lease-command", fence: 1,
    invocationId: "b3-lease-invocation", attemptId: "b3-lease-execution-attempt",
    checkpointId: "b3-lease-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-lease-run", commandId: "b3-lease-command",
    nodeAttemptId: "b3-lease-node-attempt", attemptNumber: 1,
    invocationId: "b3-lease-invocation", executionAttemptId: "b3-lease-execution-attempt",
    checkpointId: "b3-lease-checkpoint", fence: 1,
    workerId: "b3-lease-worker", leaseToken: "b3-lease-token",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-lease-node-attempt", invocationId: "b3-lease-invocation",
      executionAttemptId: "b3-lease-execution-attempt", status: "failed", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-lease-failed", runId: "b3-lease-run", sequence: 4,
      type: "run.failed", status: "failed", fence: 1,
      workerId: "b3-lease-worker", leaseToken: "b3-lease-token",
      nodeAttemptId: "b3-lease-node-attempt", occurredAt: at,
    }));
  });
}

async function assertRenewalLosesToExpiredTakeover(pool) {
  await createRun(pool, {
    runId: "b3-renew-race-run", commandId: "b3-renew-race-command",
    idempotencyKey: "b3-renew-race-key",
  });
  const first = await claim(
    pool, "b3-renew-race-old-worker", "b3-renew-race-old-lease", "1 second",
  );
  assert.equal(first.run_id, "b3-renew-race-run");

  const blocker = await pool.connect();
  const waiter = await pool.connect();
  let blockerOpen = false;
  let waiterOpen = false;
  try {
    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query(`
      SELECT 1 FROM public.workflow_runs
      WHERE workspace_id = $1 AND run_id = 'b3-renew-race-run'
      FOR UPDATE
    `, [W]);

    await waiter.query("BEGIN");
    waiterOpen = true;
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let waiterError;
    const waiterCompletion = waiter.query(`
      SELECT * FROM public.renew_workflow_run_job_lease(
        $1, 'b3-renew-race-run', 'b3-renew-race-old-worker',
        'b3-renew-race-old-lease', 'b3-renew-race-renewal', interval '2 minutes'
      )
    `, [W]).catch((error) => { waiterError = error; });
    await waitForBackendLock(pool, waiterPid);
    await pool.query("SELECT pg_sleep(1.1)");
    assert.equal(
      await claimOptional(
        pool, "b3-renew-race-blocked-worker", "b3-renew-race-blocked-lease",
      ),
      null,
      "takeover must skip a Run locked by the governed renewal path",
    );
    await blocker.query("COMMIT");
    blockerOpen = false;
    await waiterCompletion;
    assert.equal(waiterError?.code, "55000");
    assert.match(String(waiterError?.message), /workflow_run_stale_lease_renewal/);
    await waiter.query("ROLLBACK");
    waiterOpen = false;
  } finally {
    if (blockerOpen) await blocker.query("ROLLBACK");
    if (waiterOpen) await waiter.query("ROLLBACK");
    blocker.release();
    waiter.release();
  }

  const recovered = await claim(
    pool, "b3-renew-race-new-worker", "b3-renew-race-new-lease",
  );
  assert.equal(recovered.run_id, "b3-renew-race-run");
  assert.equal(recovered.fence, 2);
  const recoveryEvent = await pool.query(`
    SELECT type, status FROM public.workflow_run_events
    WHERE workspace_id = $1 AND event_id = 'b3-renew-race-new-lease:event'
  `, [W]);
  assert.deepEqual(recoveryEvent.rows[0], {
    type: "run.worker_recovered", status: "running",
  });

  await seedExecutionLineage(pool, {
    runId: "b3-renew-race-run", commandId: "b3-renew-race-command", fence: 2,
    invocationId: "b3-renew-race-invocation",
    attemptId: "b3-renew-race-execution-attempt",
    checkpointId: "b3-renew-race-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-renew-race-run", commandId: "b3-renew-race-command",
    nodeAttemptId: "b3-renew-race-node-attempt", attemptNumber: 1,
    invocationId: "b3-renew-race-invocation",
    executionAttemptId: "b3-renew-race-execution-attempt",
    checkpointId: "b3-renew-race-checkpoint", fence: 2,
    workerId: "b3-renew-race-new-worker", leaseToken: "b3-renew-race-new-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-renew-race-node-attempt",
      invocationId: "b3-renew-race-invocation",
      executionAttemptId: "b3-renew-race-execution-attempt",
      status: "failed", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-renew-race-failed", runId: "b3-renew-race-run", sequence: 4,
      type: "run.failed", status: "failed", fence: 2,
      workerId: "b3-renew-race-new-worker", leaseToken: "b3-renew-race-new-lease",
      nodeAttemptId: "b3-renew-race-node-attempt", occurredAt: at,
    }));
  });
}

async function assertQueuedCancellationAuthority(pool) {
  await createRun(pool, {
    runId: "b3-cancel-run", commandId: "b3-cancel-run-command",
    idempotencyKey: "b3-cancel-run-key",
  });
  await createRun(pool, {
    runId: "b3-other-run", commandId: "b3-other-command",
    idempotencyKey: "b3-other-key",
  });
  await expectConstraint(pool, controllerEventSql({
    eventId: "b3-same-scope-injection", runId: "b3-cancel-run", sequence: 2,
    type: "run.cancelled", status: "cancelled", commandId: "b3-other-command", fence: 0,
  }), [], "55000", "workflow_run_controller_event_unauthorized");

  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-orphan-cancel-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-cancel-run", targetRevision: 1, terminal: true,
    });
  }, "23503", "workflow_run_cancel_command_not_applied");

  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-cancel-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-cancel-run", targetRevision: 1, terminal: true,
    });
    await client.query(controllerEventSql({
      eventId: "b3-cancel-requested", runId: "b3-cancel-run", sequence: 2,
      type: "run.cancellation_requested", status: "cancellation_requested",
      commandId: "b3-cancel-command", fence: 0, occurredAt: at,
    }));
    await client.query(controllerEventSql({
      eventId: "b3-cancelled", runId: "b3-cancel-run", sequence: 3,
      type: "run.cancelled", status: "cancelled",
      commandId: "b3-cancel-command", fence: 0, occurredAt: at,
    }));
  });
  const cancelled = await pool.query(`
    SELECT r.status, j.state, j.lease_owner, c.status AS command_status
    FROM public.workflow_runs r
    JOIN public.workflow_run_jobs j USING (workspace_id, run_id)
    JOIN public.product_commands c
      ON c.workspace_id = r.workspace_id AND c.command_id = r.product_command_id
    WHERE r.workspace_id = $1 AND r.run_id = 'b3-cancel-run'
  `, [W]);
  assert.deepEqual(cancelled.rows[0], {
    status: "cancelled", state: "terminal", lease_owner: null, command_status: "cancelled",
  });

  await inTransaction(pool, async (client) => {
    await client.query(controllerEventSql({
      eventId: "b3-other-failed", runId: "b3-other-run", sequence: 2,
      type: "run.failed", status: "failed", commandId: "b3-other-command", fence: 0,
    }));
  });
}

async function assertQueuedCancellationCommandIntake({ pool, store }) {
  const runId = "b3-cancel-command-intake-run";
  await createRun(pool, {
    runId,
    commandId: "b3-cancel-command-intake-root",
    idempotencyKey: "b3-cancel-command-intake-key",
  });
  let sequence = 0;
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `b3-cancel-command-intake-${kind}-${++sequence}`,
  });
  const authority = await authorizer.authorizeWorkflowRunCancellationRequest({
    workspaceId: W,
    userId: USER,
    runId,
    reason: "Stop before dispatch.",
  });
  const command = {
    commandId: "b3-cancel-command-intake-command",
    workspaceId: W,
    scopeId: authority.scopeId,
    authorizationDecisionId: authority.authorizationDecisionId,
    argumentDigest: authority.argumentDigest,
    runId,
    requestedBy: USER,
    reason: "Stop before dispatch.",
  };
  const intake = new PostgresWorkflowRunCancellationCommandIntake({ store });
  const result = await intake.accept({
    principal: { workspaceId: W, userId: USER },
    command,
  });
  assert.equal(result.run.status, "cancelled");
  assert.equal(result.event.type, "run.cancelled");
  const replay = await intake.accept({
    principal: { workspaceId: W, userId: USER },
    command,
  });
  assert.deepEqual(replay, result);
  const persisted = await pool.query(`
    SELECT run.status AS run_status, job.state AS job_state,
           command.kind AS command_kind, command.status AS command_status,
           count(event.event_id)::integer AS cancellation_event_count
      FROM public.workflow_runs run
      JOIN public.workflow_run_jobs job
        ON job.workspace_id = run.workspace_id AND job.run_id = run.run_id
      JOIN public.product_commands command
        ON command.workspace_id = run.workspace_id
       AND command.command_id = $2
      LEFT JOIN public.workflow_run_events event
        ON event.workspace_id = run.workspace_id AND event.run_id = run.run_id
       AND event.product_command_id = command.command_id
     WHERE run.workspace_id = $1 AND run.run_id = $3
     GROUP BY run.status, job.state, command.kind, command.status
  `, [W, command.commandId, runId]);
  assert.deepEqual(persisted.rows[0], {
    run_status: "cancelled",
    job_state: "terminal",
    command_kind: "workflow_run_cancel",
    command_status: "completed",
    cancellation_event_count: 2,
  });
}

async function assertActiveCancellationAuthority(pool) {
  await createRun(pool, {
    runId: "b3-active-cancel-run", commandId: "b3-active-cancel-root-command",
    idempotencyKey: "b3-active-cancel-key",
  });
  const claimed = await claim(pool, "b3-active-worker", "b3-active-lease");
  assert.equal(claimed.run_id, "b3-active-cancel-run");
  await seedExecutionLineage(pool, {
    runId: "b3-active-cancel-run", commandId: "b3-active-cancel-root-command", fence: 1,
    invocationId: "b3-active-invocation", attemptId: "b3-active-execution-attempt",
    checkpointId: "b3-active-checkpoint",
  });
  await seedExecutionLineage(pool, {
    runId: "b3-active-cancel-run", commandId: "b3-active-cancel-root-command", fence: 1,
    invocationId: "b3-active-orphan-invocation",
    attemptId: "b3-active-orphan-execution-attempt",
    checkpointId: "b3-active-orphan-checkpoint",
  });
  await seedExecutionRetryAttempt(pool, {
    invocationId: "b3-active-orphan-invocation",
    attemptId: "b3-active-orphan-execution-attempt-2",
    attemptNumber: 2, fence: 2,
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-active-cancel-run", commandId: "b3-active-cancel-root-command",
    nodeAttemptId: "b3-active-node-attempt", attemptNumber: 1,
    invocationId: "b3-active-invocation", executionAttemptId: "b3-active-execution-attempt",
    checkpointId: "b3-active-checkpoint", fence: 1,
    workerId: "b3-active-worker", leaseToken: "b3-active-lease",
  });
  await inTransaction(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-active-cancel-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-active-cancel-run", targetRevision: 1, terminal: true,
    });
    await client.query(controllerEventSql({
      eventId: "b3-active-cancel-requested", runId: "b3-active-cancel-run", sequence: 3,
      type: "run.cancellation_requested", status: "cancellation_requested",
      commandId: "b3-active-cancel-command", fence: 1,
    }));
  });
  await expectConstraint(pool, controllerEventSql({
    eventId: "b3-active-controller-cancelled", runId: "b3-active-cancel-run", sequence: 4,
    type: "run.cancelled", status: "cancelled",
    commandId: "b3-active-cancel-command", fence: 1,
  }), [], "55000", "workflow_run_controller_event_unauthorized");
  await expectConstraint(pool, workerEventSql({
    eventId: "b3-active-stale-cancelled", runId: "b3-active-cancel-run", sequence: 4,
    type: "run.cancelled", status: "cancelled", fence: 1,
    workerId: "b3-active-worker", leaseToken: "b3-wrong-active-lease",
    nodeAttemptId: "b3-active-node-attempt",
  }), [], "55000", "workflow_run_stale_worker_event");
  await expectTransactionError(pool, async (client) => {
    await client.query(workerEventSql({
      eventId: "b3-active-unrevoked-cancelled", runId: "b3-active-cancel-run", sequence: 4,
      type: "run.cancelled", status: "cancelled", fence: 1,
      workerId: "b3-active-worker", leaseToken: "b3-active-lease",
      nodeAttemptId: "b3-active-node-attempt",
    }));
  }, "23514", "workflow_run_execution_state_inconsistent");
  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-active-node-attempt", invocationId: "b3-active-invocation",
      executionAttemptId: "b3-active-execution-attempt", status: "cancelled", at,
    });
    await closeExecutionFabric(client, {
      invocationId: "b3-active-orphan-invocation",
      executionAttemptId: "b3-active-orphan-execution-attempt-2",
      status: "cancelled", at,
      settleInvocation: false, releaseCapacity: false,
    });
    await client.query(workerEventSql({
      eventId: "b3-active-orphan-unclosed-cancelled",
      runId: "b3-active-cancel-run", sequence: 4,
      type: "run.cancelled", status: "cancelled", fence: 1,
      workerId: "b3-active-worker", leaseToken: "b3-active-lease",
      nodeAttemptId: "b3-active-node-attempt", occurredAt: at,
    }));
  }, "23514", "workflow_run_cancellation_execution_not_closed");
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-active-node-attempt", invocationId: "b3-active-invocation",
      executionAttemptId: "b3-active-execution-attempt", status: "cancelled", at,
    });
    await closeExecutionFabric(client, {
      invocationId: "b3-active-orphan-invocation",
      executionAttemptId: "b3-active-orphan-execution-attempt-2",
      status: "cancelled", at,
      settleInvocation: false, releaseCapacity: false,
    });
    await closeExecutionFabric(client, {
      invocationId: "b3-active-orphan-invocation",
      executionAttemptId: "b3-active-orphan-execution-attempt",
      status: "cancelled", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-active-worker-cancelled", runId: "b3-active-cancel-run", sequence: 4,
      type: "run.cancelled", status: "cancelled", fence: 1,
      workerId: "b3-active-worker", leaseToken: "b3-active-lease",
      nodeAttemptId: "b3-active-node-attempt", occurredAt: at,
    }));
  });
  assert.equal(await runStatus(pool, "b3-active-cancel-run"), "cancelled");
}

async function assertCancellationRequestedRecovery(pool) {
  await createRun(pool, {
    runId: "b3-cancel-recovery-run", commandId: "b3-cancel-recovery-root-command",
    idempotencyKey: "b3-cancel-recovery-key",
  });
  const first = await claim(
    pool, "b3-cancel-crashed-worker", "b3-cancel-crashed-lease", "1 second",
  );
  assert.equal(first.run_id, "b3-cancel-recovery-run");
  await seedExecutionLineage(pool, {
    runId: "b3-cancel-recovery-run", commandId: "b3-cancel-recovery-root-command", fence: 1,
    invocationId: "b3-cancel-crashed-invocation",
    attemptId: "b3-cancel-crashed-execution-attempt",
    checkpointId: "b3-cancel-crashed-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-cancel-recovery-run", commandId: "b3-cancel-recovery-root-command",
    nodeAttemptId: "b3-cancel-crashed-node-attempt", attemptNumber: 1,
    invocationId: "b3-cancel-crashed-invocation",
    executionAttemptId: "b3-cancel-crashed-execution-attempt",
    checkpointId: "b3-cancel-crashed-checkpoint", fence: 1,
    workerId: "b3-cancel-crashed-worker", leaseToken: "b3-cancel-crashed-lease",
  });
  await inTransaction(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-cancel-recovery-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-cancel-recovery-run", targetRevision: 1, terminal: true,
    });
    await client.query(controllerEventSql({
      eventId: "b3-cancel-recovery-requested", runId: "b3-cancel-recovery-run", sequence: 3,
      type: "run.cancellation_requested", status: "cancellation_requested",
      commandId: "b3-cancel-recovery-command", fence: 1,
    }));
  });
  await pool.query("SELECT pg_sleep(1.1)");
  const recovered = await claim(
    pool, "b3-cancel-recovery-worker", "b3-cancel-recovery-lease",
  );
  assert.equal(recovered.run_id, "b3-cancel-recovery-run");
  assert.equal(recovered.fence, 2);
  const recoveryEvent = await pool.query(`
    SELECT event.type, event.status, event.run_fence, event.lease_owner, event.lease_token,
      event.lease_expires_at = job.lease_expires_at AS exact_expiry
    FROM public.workflow_run_events event
    JOIN public.workflow_run_jobs job
      ON job.workspace_id = event.workspace_id AND job.run_id = event.run_id
    WHERE event.workspace_id = $1
      AND event.event_id = 'b3-cancel-recovery-lease:event'
  `, [W]);
  assert.deepEqual(recoveryEvent.rows[0], {
    type: "run.worker_recovered", status: "cancellation_requested",
    run_fence: 2, lease_owner: "b3-cancel-recovery-worker",
    lease_token: "b3-cancel-recovery-lease", exact_expiry: true,
  });
  await inTransaction(pool, async (client) => {
    await client.query(`
      SELECT public.close_workflow_run_recovered_execution(
        $1, 'b3-cancel-recovery-run',
        'b3-cancel-recovery-worker', 'b3-cancel-recovery-lease'
      )
    `, [W]);
  });
  await seedExecutionLineage(pool, {
    runId: "b3-cancel-recovery-run", commandId: "b3-cancel-recovery-root-command", fence: 2,
    invocationId: "b3-cancel-recovery-invocation",
    attemptId: "b3-cancel-recovery-execution-attempt",
    checkpointId: "b3-cancel-recovery-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-cancel-recovery-run", commandId: "b3-cancel-recovery-root-command",
    nodeAttemptId: "b3-cancel-recovery-node-attempt", attemptNumber: 2,
    invocationId: "b3-cancel-recovery-invocation",
    executionAttemptId: "b3-cancel-recovery-execution-attempt",
    checkpointId: "b3-cancel-recovery-checkpoint", fence: 2,
    workerId: "b3-cancel-recovery-worker", leaseToken: "b3-cancel-recovery-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-cancel-recovery-node-attempt",
      invocationId: "b3-cancel-recovery-invocation",
      executionAttemptId: "b3-cancel-recovery-execution-attempt",
      status: "cancelled", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-cancel-recovery-cancelled", runId: "b3-cancel-recovery-run",
      sequence: 5, type: "run.cancelled", status: "cancelled", fence: 2,
      workerId: "b3-cancel-recovery-worker", leaseToken: "b3-cancel-recovery-lease",
      nodeAttemptId: "b3-cancel-recovery-node-attempt", occurredAt: at,
    }));
  });
}

async function assertWaitingReviewCancellation(pool) {
  await createRun(pool, {
    runId: "b3-review-cancel-run", commandId: "b3-review-cancel-root-command",
    idempotencyKey: "b3-review-cancel-key",
  });
  const claimed = await claim(pool, "b3-review-cancel-worker", "b3-review-cancel-lease");
  assert.equal(claimed.run_id, "b3-review-cancel-run");
  await seedExecutionLineage(pool, {
    runId: "b3-review-cancel-run", commandId: "b3-review-cancel-root-command", fence: 1,
    invocationId: "b3-review-cancel-invocation",
    attemptId: "b3-review-cancel-execution-attempt",
    checkpointId: "b3-review-cancel-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-review-cancel-run", commandId: "b3-review-cancel-root-command",
    nodeAttemptId: "b3-review-cancel-node-attempt", attemptNumber: 1,
    invocationId: "b3-review-cancel-invocation",
    executionAttemptId: "b3-review-cancel-execution-attempt",
    checkpointId: "b3-review-cancel-checkpoint", fence: 1,
    workerId: "b3-review-cancel-worker", leaseToken: "b3-review-cancel-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.workflow_run_node_attempts
      SET status = 'waiting_review', updated_at = $1
      WHERE workspace_id = $2 AND node_attempt_id = 'b3-review-cancel-node-attempt'
    `, [at, W]);
    await client.query(workerEventSql({
      eventId: "b3-review-cancel-requested", runId: "b3-review-cancel-run", sequence: 3,
      type: "review.requested", status: "waiting_review", fence: 1,
      workerId: "b3-review-cancel-worker", leaseToken: "b3-review-cancel-lease",
      reviewId: "b3-review-cancel", nodeAttemptId: "b3-review-cancel-node-attempt",
      occurredAt: at,
    }));
    await client.query(`
      INSERT INTO public.workflow_run_reviews (
        workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
        revision, schema_version, status, requested_at, updated_at
      ) VALUES (
        $1, 'b3-review-cancel', 'b3-review-cancel-run', $2,
        'node-a', 'b3-review-cancel-node-attempt', 1,
        'workbench-run-review-v1', 'pending', $3, $3
      )
    `, [W, SCOPE, at]);
  });
  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-omitted-cancel-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-review-cancel-run", targetRevision: 1, terminal: true,
    });
    await client.query(controllerEventSql({
      eventId: "b3-review-omitted-cancellation-requested",
      runId: "b3-review-cancel-run", sequence: 4,
      type: "run.cancellation_requested", status: "cancellation_requested",
      commandId: "b3-review-omitted-cancel-command", fence: 1, occurredAt: at,
    }));
  }, "23503", "workflow_run_cancel_pending_review_not_closed");

  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-cross-run-cancel-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-review-cancel-run", targetRevision: 1, terminal: true,
    });
    await client.query(`
      UPDATE public.workflow_run_reviews
      SET status = 'cancelled', cancellation_command_id = $1,
          cancelled_at = $2, updated_at = $2
      WHERE workspace_id = $3 AND review_id = 'b3-review-cancel' AND status = 'pending'
    `, ["b3-review-cross-run-cancel-command", at, W]);
    await client.query(controllerEventSql({
      eventId: "b3-review-cross-run-requested", runId: "b3-review-cancel-run", sequence: 4,
      type: "run.cancellation_requested", status: "cancellation_requested",
      commandId: "b3-review-cross-run-cancel-command", fence: 1, occurredAt: at,
    }));
    await client.query(controllerEventSql({
      eventId: "b3-review-cross-run-cancelled", runId: "b3-review-cancel-run", sequence: 5,
      type: "run.cancelled", status: "cancelled",
      commandId: "b3-review-cross-run-cancel-command", fence: 1,
      reviewId: "b3-review-a", occurredAt: at,
    }));
  }, "55000", "workflow_run_controller_event_unauthorized");

  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-cancellation-command", kind: "workflow_run_cancel",
      effectClass: "execute", targetKind: "workflow_run_cancellation",
      targetId: "b3-review-cancel-run", targetRevision: 1, terminal: true,
    });
    await client.query(`
      UPDATE public.workflow_run_reviews
      SET status = 'cancelled', cancellation_command_id = $1,
          cancelled_at = $2, updated_at = $2
      WHERE workspace_id = $3 AND review_id = 'b3-review-cancel' AND status = 'pending'
    `, ["b3-review-cancellation-command", at, W]);
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-review-cancel-node-attempt",
      invocationId: "b3-review-cancel-invocation",
      executionAttemptId: "b3-review-cancel-execution-attempt",
      status: "cancelled", at,
    });
    await client.query(controllerEventSql({
      eventId: "b3-review-cancellation-requested", runId: "b3-review-cancel-run", sequence: 4,
      type: "run.cancellation_requested", status: "cancellation_requested",
      commandId: "b3-review-cancellation-command", fence: 1, occurredAt: at,
    }));
    await client.query(controllerEventSql({
      eventId: "b3-review-cancelled", runId: "b3-review-cancel-run", sequence: 5,
      type: "run.cancelled", status: "cancelled",
      commandId: "b3-review-cancellation-command", fence: 1,
      reviewId: "b3-review-cancel", occurredAt: at,
    }));
  });
  const result = await pool.query(`
    SELECT r.status, review.status AS review_status,
      count(*) FILTER (WHERE pending.status = 'pending')::integer AS pending_count
    FROM public.workflow_runs r
    JOIN public.workflow_run_reviews review
      ON review.workspace_id = r.workspace_id AND review.run_id = r.run_id
    LEFT JOIN public.workflow_run_reviews pending
      ON pending.workspace_id = r.workspace_id AND pending.run_id = r.run_id
    WHERE r.workspace_id = $1 AND r.run_id = 'b3-review-cancel-run'
    GROUP BY r.status, review.status
  `, [W]);
  assert.deepEqual(result.rows[0], {
    status: "cancelled", review_status: "cancelled", pending_count: 0,
  });
}

async function assertReviewRejectClosure(pool) {
  await createRun(pool, {
    runId: "b3-review-reject-run", commandId: "b3-review-reject-root-command",
    idempotencyKey: "b3-review-reject-key",
  });
  const claimed = await claim(pool, "b3-review-reject-worker", "b3-review-reject-lease");
  assert.equal(claimed.run_id, "b3-review-reject-run");
  await seedExecutionLineage(pool, {
    runId: "b3-review-reject-run", commandId: "b3-review-reject-root-command", fence: 1,
    invocationId: "b3-review-reject-invocation",
    attemptId: "b3-review-reject-execution-attempt",
    checkpointId: "b3-review-reject-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-review-reject-run", commandId: "b3-review-reject-root-command",
    nodeAttemptId: "b3-review-reject-node-attempt", attemptNumber: 1,
    invocationId: "b3-review-reject-invocation",
    executionAttemptId: "b3-review-reject-execution-attempt",
    checkpointId: "b3-review-reject-checkpoint", fence: 1,
    workerId: "b3-review-reject-worker", leaseToken: "b3-review-reject-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.workflow_run_node_attempts
      SET status = 'waiting_review', updated_at = $1
      WHERE workspace_id = $2 AND node_attempt_id = 'b3-review-reject-node-attempt'
    `, [at, W]);
    await client.query(workerEventSql({
      eventId: "b3-review-reject-requested", runId: "b3-review-reject-run", sequence: 3,
      type: "review.requested", status: "waiting_review", fence: 1,
      workerId: "b3-review-reject-worker", leaseToken: "b3-review-reject-lease",
      reviewId: "b3-review-reject", nodeAttemptId: "b3-review-reject-node-attempt",
      occurredAt: at,
    }));
    await client.query(`
      INSERT INTO public.workflow_run_reviews (
        workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
        revision, schema_version, status, requested_at, updated_at
      ) VALUES (
        $1, 'b3-review-reject', 'b3-review-reject-run', $2,
        'node-a', 'b3-review-reject-node-attempt', 1,
        'workbench-run-review-v1', 'pending', $3, $3
      )
    `, [W, SCOPE, at]);
  });

  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-reject-omission-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-reject", targetRevision: 1, terminal: true,
    });
    await client.query(`
      UPDATE public.workflow_run_reviews
      SET status = 'decided', decision = 'reject',
          decision_command_id = 'b3-review-reject-omission-command',
          decided_at = $1, updated_at = $1
      WHERE workspace_id = $2 AND review_id = 'b3-review-reject' AND status = 'pending'
    `, [at, W]);
    await client.query(controllerEventSql({
      eventId: "b3-review-reject-omitted-cancel", runId: "b3-review-reject-run", sequence: 4,
      type: "run.cancelled", status: "cancelled",
      commandId: "b3-review-reject-omission-command", fence: 1,
      reviewId: "b3-review-reject", occurredAt: at,
    }));
  }, "23514", "workflow_run_cancellation_execution_not_closed");

  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await insertAuthorizedCommand(client, {
      commandId: "b3-review-reject-command", kind: "workflow_run_review",
      effectClass: "write_local", targetKind: "workflow_run_review",
      targetId: "b3-review-reject", targetRevision: 1, terminal: true,
    });
    await client.query(`
      UPDATE public.workflow_run_reviews
      SET status = 'decided', decision = 'reject',
          decision_command_id = 'b3-review-reject-command',
          decided_at = $1, updated_at = $1
      WHERE workspace_id = $2 AND review_id = 'b3-review-reject' AND status = 'pending'
    `, [at, W]);
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-review-reject-node-attempt",
      invocationId: "b3-review-reject-invocation",
      executionAttemptId: "b3-review-reject-execution-attempt",
      status: "cancelled", at,
    });
    await client.query(controllerEventSql({
      eventId: "b3-review-rejected", runId: "b3-review-reject-run", sequence: 4,
      type: "run.cancelled", status: "cancelled",
      commandId: "b3-review-reject-command", fence: 1,
      reviewId: "b3-review-reject", occurredAt: at,
    }));
  });
}

async function assertReviewInboxAndCommandRejection({ pool, store }) {
  const runId = "b3-review-inbox-run";
  const nodeAttemptId = "b3-review-inbox-node-attempt";
  const invocationId = "b3-review-inbox-invocation";
  const executionAttemptId = "b3-review-inbox-execution-attempt";
  await createRun(pool, {
    runId,
    commandId: "b3-review-inbox-root-command",
    idempotencyKey: "b3-review-inbox-key",
  });
  const claimed = await claim(pool, "b3-review-inbox-worker", "b3-review-inbox-lease");
  assert.equal(claimed.run_id, runId);
  await seedExecutionLineage(pool, {
    runId,
    commandId: "b3-review-inbox-root-command",
    fence: 1,
    invocationId,
    attemptId: executionAttemptId,
    checkpointId: "b3-review-inbox-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId,
    commandId: "b3-review-inbox-root-command",
    nodeAttemptId,
    attemptNumber: 1,
    invocationId,
    executionAttemptId,
    checkpointId: "b3-review-inbox-checkpoint",
    fence: 1,
    workerId: "b3-review-inbox-worker",
    leaseToken: "b3-review-inbox-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      UPDATE public.workflow_run_node_attempts
         SET status = 'waiting_review', updated_at = $1
       WHERE workspace_id = $2 AND node_attempt_id = $3
    `, [at, W, nodeAttemptId]);
    await client.query(workerEventSql({
      eventId: "b3-review-inbox-requested",
      runId,
      sequence: 3,
      type: "review.requested",
      status: "waiting_review",
      fence: 1,
      workerId: "b3-review-inbox-worker",
      leaseToken: "b3-review-inbox-lease",
      reviewId: "b3-review-inbox",
      nodeAttemptId,
      occurredAt: at,
    }));
    await client.query(`
      INSERT INTO public.workflow_run_reviews (
        workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
        revision, schema_version, status, requested_at, updated_at, payload
      ) VALUES (
        $1, 'b3-review-inbox', $2, $3, 'node-a', $4,
        1, 'workbench-run-review-v1', 'pending', $5, $5,
        '{"reviewPacket":{"title":"Review required"}}'::jsonb
      )
    `, [W, runId, SCOPE, nodeAttemptId, at]);
    await client.query(`
      INSERT INTO public.inbox_items (
        workspace_id, inbox_item_id, recipient_user_id,
        source_domain, source_id, source_revision, source_cursor,
        reason_code, severity, title, summary, target_kind, target_id,
        status, schema_version, created_at, updated_at
      ) VALUES (
        $1, 'b3-review-inbox-item', $2,
        'workflow_run_review', 'b3-review-inbox', 1, 'b3-review-inbox:1',
        'review_required', 'warning', 'Review required', 'Review the Run.',
        'workflow_run_review', $3,
        'unread', 'workbench-inbox-item-v1', $4, $4
      )
    `, [W, USER, runId, at]);
  });

  const inbox = new PostgresInboxReadModel({ store });
  const listed = await inbox.list({ workspaceId: W, userId: USER, query: { limit: 10 } });
  const item = listed.data.items.find((candidate) => candidate.itemId === "b3-review-inbox-item");
  assert.deepEqual(item, {
    schemaVersion: "workbench-v1",
    itemId: "b3-review-inbox-item",
    workspaceId: W,
    objectKind: "review",
    objectId: runId,
    reason: "review_required",
    severity: "warning",
    title: "Review required",
    actionRoute: `/loops/${WORKFLOW}/runs/${runId}`,
    createdAt: item.createdAt,
  });

  let sequence = 0;
  const authorizer = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `b3-review-inbox-${kind}-${++sequence}`,
  });
  const authority = await authorizer.authorizeWorkflowRunCancellation({
    workspaceId: W,
    userId: USER,
    runId,
    nodeId: "node-a",
    decision: "reject",
    requestedChanges: [],
  });
  const intake = new PostgresWorkflowRunReviewCommandIntake({ store });
  const command = {
    commandId: "b3-review-inbox-reject-command",
    workspaceId: W,
    scopeId: authority.scopeId,
    authorizationDecisionId: authority.authorizationDecisionId,
    argumentDigest: authority.argumentDigest,
    runId,
    nodeId: "node-a",
    decision: "reject",
    requestedChanges: [],
    decidedBy: USER,
  };
  const result = await intake.accept({
    principal: { workspaceId: W, userId: USER },
    command,
  });
  assert.equal(result.decision.decision, "reject");
  assert.equal(result.run.status, "cancelled");
  assert.equal(result.event.type, "run.cancelled");
  const replay = await intake.accept({
    principal: { workspaceId: W, userId: USER },
    command,
  });
  assert.deepEqual(replay, result);

  const closure = await pool.query(`
    SELECT review.status AS review_status,
           command.kind AS command_kind,
           command.status AS command_status,
           inbox.status AS inbox_status,
           node_attempt.status AS node_status,
           invocation.status AS invocation_status,
           execution_attempt.status AS attempt_status,
           capability.status AS capability_status,
           capacity.status AS capacity_status
      FROM public.workflow_run_reviews review
      JOIN public.product_commands command
        ON command.workspace_id = review.workspace_id
       AND command.command_id = review.cancellation_command_id
      JOIN public.inbox_items inbox
        ON inbox.workspace_id = review.workspace_id
       AND inbox.source_domain = 'workflow_run_review'
       AND inbox.source_id = review.review_id
       AND inbox.source_revision = review.revision
      JOIN public.workflow_run_node_attempts node_attempt
        ON node_attempt.workspace_id = review.workspace_id
       AND node_attempt.node_attempt_id = review.node_attempt_id
      JOIN public.execution_invocations invocation
        ON invocation.invocation_id = node_attempt.invocation_id
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
       AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
      JOIN public.capability_leases capability
        ON capability.invocation_id = invocation.invocation_id
       AND capability.attempt_id = execution_attempt.attempt_id
      JOIN public.capacity_leases capacity
        ON capacity.capacity_lease_id = invocation.capacity_lease_id
     WHERE review.workspace_id = $1 AND review.review_id = 'b3-review-inbox'
  `, [W]);
  assert.deepEqual(closure.rows[0], {
    review_status: "cancelled",
    command_kind: "workflow_run_cancel",
    command_status: "completed",
    inbox_status: "dismissed",
    node_status: "cancelled",
    invocation_status: "cancelled",
    attempt_status: "cancelled",
    capability_status: "revoked",
    capacity_status: "released",
  });
}

async function assertConcurrentCancelVsClaim(pool) {
  await createRun(pool, {
    runId: "b3-race-run", commandId: "b3-race-root-command",
    idempotencyKey: "b3-race-key",
  });
  const claimClient = await pool.connect();
  const cancelClient = await pool.connect();
  let claimOpen = false;
  let cancelOpen = false;
  try {
    await claimClient.query("BEGIN");
    claimOpen = true;
    const claimed = await claimClient.query(
      "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
      ["b3-race-worker", "b3-race-lease", "b3-race-claimed", "1 minute"],
    );
    assert.equal(claimed.rows[0]?.run_id, "b3-race-run");

    await cancelClient.query("BEGIN");
    cancelOpen = true;
    const cancelPid = (await cancelClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let cancelError;
    const cancelCompletion = (async () => {
      try {
        await insertAuthorizedCommand(cancelClient, {
          commandId: "b3-race-cancel-command", kind: "workflow_run_cancel",
          effectClass: "execute", targetKind: "workflow_run_cancellation",
          targetId: "b3-race-run", targetRevision: 1, terminal: true,
        });
        await cancelClient.query(controllerEventSql({
          eventId: "b3-race-cancellation-requested", runId: "b3-race-run", sequence: 3,
          type: "run.cancellation_requested", status: "cancellation_requested",
          commandId: "b3-race-cancel-command", fence: 1,
        }));
        await cancelClient.query("COMMIT");
        cancelOpen = false;
      } catch (error) {
        cancelError = error;
      }
    })();

    await waitForBackendLock(pool, cancelPid);
    await claimClient.query("COMMIT");
    claimOpen = false;
    await cancelCompletion;
    if (cancelError) throw cancelError;
  } finally {
    if (claimOpen) await claimClient.query("ROLLBACK");
    if (cancelOpen) await cancelClient.query("ROLLBACK");
    claimClient.release();
    cancelClient.release();
  }

  const linearized = await pool.query(`
    SELECT r.status, r.event_sequence, j.state, j.fence, j.lease_owner
    FROM public.workflow_runs r
    JOIN public.workflow_run_jobs j USING (workspace_id, run_id)
    WHERE r.workspace_id = $1 AND r.run_id = 'b3-race-run'
  `, [W]);
  assert.deepEqual(linearized.rows[0], {
    status: "cancellation_requested", event_sequence: "3",
    state: "leased", fence: 1, lease_owner: "b3-race-worker",
  });

  await seedExecutionLineage(pool, {
    runId: "b3-race-run", commandId: "b3-race-root-command", fence: 1,
    invocationId: "b3-race-invocation", attemptId: "b3-race-execution-attempt",
    checkpointId: "b3-race-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-race-run", commandId: "b3-race-root-command",
    nodeAttemptId: "b3-race-node-attempt", attemptNumber: 1,
    invocationId: "b3-race-invocation", executionAttemptId: "b3-race-execution-attempt",
    checkpointId: "b3-race-checkpoint", fence: 1,
    workerId: "b3-race-worker", leaseToken: "b3-race-lease",
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-race-node-attempt", invocationId: "b3-race-invocation",
      executionAttemptId: "b3-race-execution-attempt", status: "cancelled", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-race-worker-cancelled", runId: "b3-race-run", sequence: 4,
      type: "run.cancelled", status: "cancelled", fence: 1,
      workerId: "b3-race-worker", leaseToken: "b3-race-lease",
      nodeAttemptId: "b3-race-node-attempt", occurredAt: at,
    }));
  });
}

async function waitForBackendLock(pool, backendPid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await pool.query(`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1
    `, [backendPid]);
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("cancel transaction did not block on the Run lock held by claim");
}

async function assertTerminalAndReviewLoseAfterLeaseExpiry(pool) {
  await assertExpiredWorkerEventLosesToTakeover(pool, {
    prefix: "b3-terminal-takeover", type: "run.completed", status: "completed",
  });
  await assertExpiredWorkerEventLosesToTakeover(pool, {
    prefix: "b3-review-takeover", type: "review.requested", status: "waiting_review",
    reviewId: "b3-review-takeover-review",
  });
}

async function assertExpiredWorkerEventLosesToTakeover(pool, {
  prefix, type, status, reviewId = null,
}) {
  const runId = `${prefix}-run`;
  const commandId = `${prefix}-command`;
  const oldInvocationId = `${prefix}-old-invocation`;
  const oldExecutionAttemptId = `${prefix}-old-execution-attempt`;
  const oldNodeAttemptId = `${prefix}-old-node-attempt`;
  await createRun(pool, { runId, commandId, idempotencyKey: `${prefix}-key` });
  const first = await claim(pool, `${prefix}-old-worker`, `${prefix}-old-lease`, "1 second");
  assert.equal(first.run_id, runId);
  await seedExecutionLineage(pool, {
    runId, commandId, fence: 1, invocationId: oldInvocationId,
    attemptId: oldExecutionAttemptId, checkpointId: `${prefix}-old-checkpoint`,
  });
  await seedRunNodeAttempt(pool, {
    runId, commandId, nodeAttemptId: oldNodeAttemptId, attemptNumber: 1,
    invocationId: oldInvocationId, executionAttemptId: oldExecutionAttemptId,
    checkpointId: `${prefix}-old-checkpoint`, fence: 1,
    workerId: `${prefix}-old-worker`, leaseToken: `${prefix}-old-lease`,
  });

  const blocker = await pool.connect();
  const waiter = await pool.connect();
  let blockerOpen = false;
  let waiterOpen = false;
  try {
    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query(`
      SELECT 1 FROM public.workflow_run_jobs
      WHERE workspace_id = $1 AND run_id = $2 FOR UPDATE
    `, [W, runId]);

    await waiter.query("BEGIN");
    waiterOpen = true;
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let waiterError;
    const waiterCompletion = (async () => {
      try {
        const at = new Date().toISOString();
        if (type === "review.requested") {
          await waiter.query(`
            UPDATE public.workflow_run_node_attempts
            SET status = 'waiting_review', updated_at = $1
            WHERE workspace_id = $2 AND node_attempt_id = $3
          `, [at, W, oldNodeAttemptId]);
        } else {
          await closeExecutionLineage(waiter, {
            nodeAttemptId: oldNodeAttemptId, invocationId: oldInvocationId,
            executionAttemptId: oldExecutionAttemptId, status: "completed", at,
          });
        }
        await waiter.query(workerEventSql({
          eventId: `${prefix}-late-event`, runId, sequence: 3, type, status, fence: 1,
          workerId: `${prefix}-old-worker`, leaseToken: `${prefix}-old-lease`,
          nodeAttemptId: oldNodeAttemptId, reviewId, occurredAt: at,
        }));
      } catch (error) {
        waiterError = error;
      }
    })();
    await waitForBackendLock(pool, waiterPid);
    await pool.query("SELECT pg_sleep(1.1)");
    assert.equal(
      await claimOptional(pool, `${prefix}-blocked-worker`, `${prefix}-blocked-lease`),
      null,
      "takeover must not invert the Run-to-Job lock order",
    );
    await blocker.query("COMMIT");
    blockerOpen = false;
    await waiterCompletion;
    assert.equal(waiterError?.code, "55000");
    assert.match(String(waiterError?.message), /workflow_run_stale_node_attempt/);
    await waiter.query("ROLLBACK");
    waiterOpen = false;
  } finally {
    if (blockerOpen) await blocker.query("ROLLBACK");
    if (waiterOpen) await waiter.query("ROLLBACK");
    blocker.release();
    waiter.release();
  }

  const recovered = await claim(pool, `${prefix}-new-worker`, `${prefix}-new-lease`);
  assert.equal(recovered.run_id, runId);
  assert.equal(recovered.fence, 2);
  await pool.query(`
    SELECT * FROM public.renew_workflow_run_job_lease(
      $1, $2, $3, $4, $5, interval '2 minutes'
    )
  `, [
    W, runId, `${prefix}-new-worker`, `${prefix}-new-lease`, `${prefix}-renewed`,
  ]);
  const newInvocationId = `${prefix}-new-invocation`;
  const newExecutionAttemptId = `${prefix}-new-execution-attempt`;
  const newNodeAttemptId = `${prefix}-new-node-attempt`;
  await assert.rejects(
    () => seedRunNodeAttempt(pool, {
      runId, commandId, nodeAttemptId: newNodeAttemptId, attemptNumber: 2,
      invocationId: oldInvocationId, executionAttemptId: oldExecutionAttemptId,
      checkpointId: null, fence: 2,
      workerId: `${prefix}-new-worker`, leaseToken: `${prefix}-new-lease`,
    }),
    (error) => {
      assert.equal(error?.code, "23514");
      assert.match(String(error?.message), /workflow_run_recovery_lineage_not_closed/);
      return true;
    },
  );
  await expectTransactionError(pool, async (client) => {
    await client.query(`
      SELECT public.close_workflow_run_recovered_execution(
        $1, $2, $3, $4
      )
    `, [W, runId, `${prefix}-new-worker`, `${prefix}-wrong-lease`]);
  }, "55000", "workflow_run_recovery_authority_invalid");
  await inTransaction(pool, async (client) => {
    await client.query(`
      SELECT public.close_workflow_run_recovered_execution(
        $1, $2, $3, $4
      )
    `, [
      W, runId, `${prefix}-new-worker`, `${prefix}-new-lease`,
    ]);
  });
  await seedExecutionLineage(pool, {
    runId, commandId, fence: 2, invocationId: newInvocationId,
    attemptId: newExecutionAttemptId, checkpointId: `${prefix}-new-checkpoint`,
  });
  await seedRunNodeAttempt(pool, {
    runId, commandId, nodeAttemptId: newNodeAttemptId, attemptNumber: 2,
    invocationId: newInvocationId, executionAttemptId: newExecutionAttemptId,
    checkpointId: `${prefix}-new-checkpoint`, fence: 2,
    workerId: `${prefix}-new-worker`, leaseToken: `${prefix}-new-lease`,
  });
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: newNodeAttemptId, invocationId: newInvocationId,
      executionAttemptId: newExecutionAttemptId, status: "failed", at,
    });
    await client.query(workerEventSql({
      eventId: `${prefix}-failed`, runId, sequence: 5,
      type: "run.failed", status: "failed", fence: 2,
      workerId: `${prefix}-new-worker`, leaseToken: `${prefix}-new-lease`,
      nodeAttemptId: newNodeAttemptId, occurredAt: at,
    }));
  });
}

async function assertRetrySemantics(pool) {
  await createRun(pool, {
    runId: "b3-retry-run", commandId: "b3-retry-command", idempotencyKey: "b3-retry-key",
    retryOfRunId: "b3-other-run",
  });
  const retry = await pool.query(`
    SELECT retry_of_run_id, product_command_id, idempotency_key
    FROM public.workflow_runs WHERE workspace_id = $1 AND run_id = 'b3-retry-run'
  `, [W]);
  assert.deepEqual(retry.rows[0], {
    retry_of_run_id: "b3-other-run",
    product_command_id: "b3-retry-command",
    idempotency_key: "b3-retry-key",
  });

  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-pending-retry-command", kind: "workflow_run",
      effectClass: "execute", targetKind: "workflow_run", targetId: "b3-pending-retry",
    });
    await insertRunRoot(client, {
      runId: "b3-pending-retry", commandId: "b3-pending-retry-command",
      idempotencyKey: "b3-pending-retry-key", retryOfRunId: "b3-retry-run",
    });
  }, "23514", "workflow_run_retry_source_invalid");

  await expectTransactionError(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: "b3-input-retry-command", kind: "workflow_run",
      effectClass: "execute", targetKind: "workflow_run", targetId: "b3-input-retry",
    });
    await insertRunRoot(client, {
      runId: "b3-input-retry", commandId: "b3-input-retry-command",
      idempotencyKey: "b3-input-retry-key", retryOfRunId: "b3-other-run",
      inputs: { changed: true },
    });
  }, "23514", "workflow_run_retry_source_invalid");

  await inTransaction(pool, async (client) => {
    await client.query(controllerEventSql({
      eventId: "b3-retry-failed", runId: "b3-retry-run", sequence: 2,
      type: "run.failed", status: "failed", commandId: "b3-retry-command", fence: 0,
    }));
  });
}

async function assertTakeoverAndCursor(pool) {
  await createRun(pool, {
    runId: "b3-takeover-run", commandId: "b3-takeover-command",
    idempotencyKey: "b3-takeover-key",
  });
  const first = await claim(pool, "b3-worker-old", "b3-lease-old", "20 milliseconds");
  assert.equal(first.run_id, "b3-takeover-run");
  assert.equal(
    await claimOptional(pool, "b3-worker-too-early", "b3-lease-too-early"),
    null,
    "caller cannot force a lease takeover before the database lease expires",
  );
  await pool.query("SELECT pg_sleep(0.05)");
  const takeover = await claim(pool, "b3-worker-new", "b3-lease-new");
  assert.equal(takeover.run_id, "b3-takeover-run");
  assert.equal(takeover.fence, 2);
  const takeoverEvent = await pool.query(`
    SELECT type, status FROM public.workflow_run_events
    WHERE workspace_id = $1 AND event_id = 'b3-lease-new:event'
  `, [W]);
  assert.deepEqual(takeoverEvent.rows[0], {
    type: "run.worker_recovered", status: "running",
  });
  await seedExecutionLineage(pool, {
    runId: "b3-takeover-run", commandId: "b3-takeover-command", fence: 2,
    invocationId: "b3-takeover-invocation", attemptId: "b3-takeover-execution-attempt",
    checkpointId: "b3-takeover-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-takeover-run", commandId: "b3-takeover-command",
    nodeAttemptId: "b3-takeover-node-attempt", attemptNumber: 1,
    invocationId: "b3-takeover-invocation",
    executionAttemptId: "b3-takeover-execution-attempt",
    checkpointId: "b3-takeover-checkpoint", fence: 2,
    workerId: "b3-worker-new", leaseToken: "b3-lease-new",
  });
  await expectConstraint(pool, workerEventSql({
    eventId: "b3-old-worker-late", runId: "b3-takeover-run", sequence: 4,
    type: "node.progress", status: "running", fence: 1,
    workerId: "b3-worker-old", leaseToken: "b3-lease-old",
    nodeAttemptId: "b3-takeover-node-attempt",
  }), [], "55000", "workflow_run_stale_worker_event");

  await pool.query(workerEventSql({
    eventId: "b3-takeover-node-started", runId: "b3-takeover-run", sequence: 4,
    type: "node.started", status: "running", fence: 2,
    workerId: "b3-worker-new", leaseToken: "b3-lease-new",
    nodeAttemptId: "b3-takeover-node-attempt",
  }));

  for (let index = 0; index < 205; index += 1) {
    await pool.query(workerEventSql({
      eventId: `b3-cursor-${index}`, runId: "b3-takeover-run", sequence: index + 5,
      type: "node.progress", status: "running", fence: 2,
      workerId: "b3-worker-new", leaseToken: "b3-lease-new",
      nodeAttemptId: "b3-takeover-node-attempt",
    }));
  }
  await createRun(pool, {
    workspaceId: W2, scopeId: SCOPE2, policyId: POLICY2, grantId: GRANT2,
    workflowId: WORKFLOW2, revisionId: REVISION2, compileId: COMPILE2, planId: PLAN2,
    runId: "b3-takeover-run", commandId: "b3-cursor-tenant-command",
    idempotencyKey: "b3-cursor-tenant-key",
  });
  await pool.query(controllerEventSql({
    workspaceId: W2, eventId: "b3-cursor-tenant-failed",
    runId: "b3-takeover-run", sequence: 2,
    type: "run.failed", status: "failed",
    commandId: "b3-cursor-tenant-command", fence: 0,
  }));
  const page = await pool.query(`
    SELECT sequence, event_id FROM public.workflow_run_events
    WHERE workspace_id = $1 AND run_id = 'b3-takeover-run' AND sequence > 200
    ORDER BY sequence, event_id LIMIT 20
  `, [W]);
  assert.equal(page.rows.length, 9);
  assert.equal(page.rows[0].sequence, "201");
  const leakage = await pool.query(`
    SELECT count(*)::integer AS count FROM public.workflow_run_events
    WHERE workspace_id <> $1 AND run_id = 'b3-takeover-run'
  `, [W]);
  assert.equal(leakage.rows[0].count, 2, "the same run_id exists in another workspace");
  assert.equal(page.rows.some(({ event_id: eventId }) => eventId === "b3-cursor-tenant-failed"), false);
}

async function assertTerminalOutcomeBoundaries(pool) {
  await createRun(pool, {
    runId: "b3-partial-run", commandId: "b3-partial-command",
    idempotencyKey: "b3-partial-key",
  });
  const partialClaim = await claim(pool, "b3-partial-worker", "b3-partial-lease");
  assert.equal(partialClaim.run_id, "b3-partial-run");
  await seedExecutionLineage(pool, {
    runId: "b3-partial-run", commandId: "b3-partial-command", fence: 1,
    invocationId: "b3-partial-invocation", attemptId: "b3-partial-execution-attempt",
    checkpointId: "b3-partial-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-partial-run", commandId: "b3-partial-command",
    nodeAttemptId: "b3-partial-node-attempt", attemptNumber: 1,
    invocationId: "b3-partial-invocation",
    executionAttemptId: "b3-partial-execution-attempt",
    checkpointId: "b3-partial-checkpoint", fence: 1,
    workerId: "b3-partial-worker", leaseToken: "b3-partial-lease",
  });
  await expectTransactionError(pool, async (client) => {
    const at = new Date().toISOString();
    await client.query(`
      INSERT INTO public.workflow_run_final_outputs (
        workspace_id, run_id, node_id, node_attempt_id,
        schema_version, outcome, run_fence,
        lease_owner, lease_token, final_answer, created_at
      ) VALUES (
        $1, 'b3-partial-run', 'node-a', 'b3-partial-node-attempt',
        'workbench-run-final-output-v1', 'partial', 1,
        'b3-partial-worker', 'b3-partial-lease', '{}'::jsonb, $2
      )
    `, [W, at]);
    await client.query(workerEventSql({
      eventId: "b3-premature-partial", runId: "b3-partial-run", sequence: 3,
      type: "run.partial", status: "partial", fence: 1,
      workerId: "b3-partial-worker", leaseToken: "b3-partial-lease",
      nodeAttemptId: "b3-partial-node-attempt", occurredAt: at,
    }));
  }, "23514", "workflow_run_terminal_execution_not_closed");
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-partial-node-attempt", invocationId: "b3-partial-invocation",
      executionAttemptId: "b3-partial-execution-attempt", status: "partial", at,
    });
    await client.query(`
      INSERT INTO public.workflow_run_final_outputs (
        workspace_id, run_id, node_id, node_attempt_id,
        schema_version, outcome, run_fence,
        lease_owner, lease_token, final_answer, created_at
      ) VALUES (
        $1, 'b3-partial-run', 'node-a', 'b3-partial-node-attempt',
        'workbench-run-final-output-v1', 'partial', 1,
        'b3-partial-worker', 'b3-partial-lease', '{}'::jsonb, $2
      )
    `, [W, at]);
    await client.query(workerEventSql({
      eventId: "b3-partial", runId: "b3-partial-run", sequence: 3,
      type: "run.partial", status: "partial", fence: 1,
      workerId: "b3-partial-worker", leaseToken: "b3-partial-lease",
      nodeAttemptId: "b3-partial-node-attempt", occurredAt: at,
    }));
  });

  await createRun(pool, {
    runId: "b3-effect-run", commandId: "b3-effect-command", idempotencyKey: "b3-effect-key",
  });
  const claimed = await claim(pool, "b3-effect-worker", "b3-effect-lease");
  assert.equal(claimed.run_id, "b3-effect-run");
  await seedExecutionLineage(pool, {
    runId: "b3-effect-run", commandId: "b3-effect-command", fence: 1,
    invocationId: "b3-effect-invocation", attemptId: "b3-effect-execution-attempt",
    checkpointId: "b3-effect-checkpoint",
  });
  await seedRunNodeAttempt(pool, {
    runId: "b3-effect-run", commandId: "b3-effect-command",
    nodeAttemptId: "b3-effect-node-attempt", attemptNumber: 1,
    invocationId: "b3-effect-invocation", executionAttemptId: "b3-effect-execution-attempt",
    checkpointId: "b3-effect-checkpoint", fence: 1,
    workerId: "b3-effect-worker", leaseToken: "b3-effect-lease",
  });
  await insertEffectIntent(pool, {
    effectId: "b3-effect-receipt", invocationId: "b3-effect-invocation",
    attemptId: "b3-effect-execution-attempt", runId: "b3-effect-run",
  });
  await moveEffectToOutcomeUnknown(pool, "b3-effect-receipt");
  await inTransaction(pool, async (client) => {
    const at = new Date().toISOString();
    await closeExecutionLineage(client, {
      nodeAttemptId: "b3-effect-node-attempt", invocationId: "b3-effect-invocation",
      executionAttemptId: "b3-effect-execution-attempt",
      status: "effect_outcome_unknown", at,
    });
    await client.query(workerEventSql({
      eventId: "b3-effect-unknown", runId: "b3-effect-run", sequence: 3,
      type: "run.effect_outcome_unknown", status: "effect_outcome_unknown", fence: 1,
      workerId: "b3-effect-worker", leaseToken: "b3-effect-lease",
      nodeAttemptId: "b3-effect-node-attempt",
      occurredAt: at,
    }));
  });
  assert.equal(await commandStatus(pool, "b3-effect-command"), "blocked");
  await expectTransactionError(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workflow_run_final_outputs (
        workspace_id, run_id, node_id, node_attempt_id,
        schema_version, outcome, run_fence,
        lease_owner, lease_token, final_answer, created_at
      ) VALUES (
        $1, 'b3-effect-run', 'node-a', 'b3-effect-node-attempt',
        'workbench-run-final-output-v1', 'partial', 1,
        'b3-effect-worker', 'b3-effect-lease', '{}'::jsonb, $2
      )
    `, [W, new Date().toISOString()]);
  }, "23514", "workflow_run_final_output_attempt_not_terminal");
}

async function createRun(pool, options) {
  const workspaceId = options.workspaceId ?? W;
  const scopeId = options.scopeId ?? SCOPE;
  await inTransaction(pool, async (client) => {
    await insertAuthorizedCommand(client, {
      commandId: options.commandId, kind: "workflow_run", effectClass: "execute",
      targetKind: "workflow_run", targetId: options.runId,
      workspaceId, scopeId,
      policyId: options.policyId ?? POLICY,
      grantId: options.grantId ?? GRANT,
    });
    await insertRunRoot(client, options);
    await client.query(`
      INSERT INTO public.workflow_run_jobs (
        workspace_id, run_id, schema_version, state, available_at, queued_at,
        created_at, updated_at
      ) VALUES ($1, $2, 'workbench-run-job-v1', 'queued', $3, $3, $3, $3)
    `, [workspaceId, options.runId, options.queuedAt ?? NOW]);
    await client.query(controllerEventSql({
      eventId: `${options.runId}:queued`, runId: options.runId, sequence: 1,
      type: "run.queued", status: "queued", commandId: options.commandId,
      fence: 0, occurredAt: options.queuedAt ?? NOW, workspaceId,
    }));
  });
}

async function insertRunRoot(client, {
  runId, commandId, idempotencyKey, retryOfRunId = null,
  inputs = {}, resourceRefs = [], queuedAt = NOW, planHash = PLAN_HASH,
  workspaceId = W, scopeId = SCOPE, workflowId = WORKFLOW,
  revisionId = REVISION, compileId = COMPILE, planId = PLAN,
}) {
  await client.query(`
    INSERT INTO public.workflow_runs (
      workspace_id, run_id, scope_id, product_command_id,
      workflow_id, workflow_revision_id, workflow_revision_content_hash,
      compile_result_id, execution_plan_id, execution_plan_content_hash,
      retry_of_run_id, schema_version, inputs, resource_refs,
      idempotency_key, status, queued_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, 'workbench-run-v1', $12::jsonb, $13::jsonb,
      $14, 'queued', $15, $15, $15
    )
  `, [
    workspaceId, runId, scopeId, commandId, workflowId, revisionId, REVISION_HASH,
    compileId, planId, planHash, retryOfRunId,
    JSON.stringify(inputs), JSON.stringify(resourceRefs), idempotencyKey, queuedAt,
  ]);
}

async function insertAuthorizedCommand(client, {
  commandId, kind, effectClass, targetKind, targetId, targetRevision = 1,
  terminal = false, workspaceId = W, scopeId = SCOPE,
  policyId = POLICY, grantId = GRANT,
}) {
  const requestId = `${commandId}:request`;
  const decisionId = `${commandId}:decision`;
  await client.query(`
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest,
      permission_mode, destructive_rule_version, disposition, approval_id,
      reason_code, decided_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
      'principal', $5, 'user', $6, $7, $8, $9,
      'interactive', 'authority-v1', 'approval_required', $2,
      'approval_required', $10, $11
    )
  `, [workspaceId, requestId, scopeId, policyId, USER, grantId, kind, effectClass, DIGEST, NOW, EXPIRY]);
  await client.query(`
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest,
      permission_mode, destructive_rule_version, disposition, approval_id,
      reason_code, decided_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
      'principal', $5, 'user', $6, $7, $8, $9,
      'interactive', 'authority-v1', 'authorized', $10,
      'approved', $11, $12
    )
  `, [workspaceId, decisionId, scopeId, policyId, USER, grantId, kind, effectClass, DIGEST, requestId, NOW, EXPIRY]);
  await client.query(`
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id,
      actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind,
      authorization_decision_id, policy_revision_id, effect_class,
      argument_digest, quota_user_id, schema_version, kind,
      target_kind, target_id, target_revision,
      status, created_at, updated_at, finished_at
    ) VALUES (
      $1, $2, $3, $4, 'user', $4, 'user', $5, $6, $7,
      $8, $4, 'workbench-v1', $9, $10, $11, $12,
      $13, $14, $14, $15
    )
  `, [
    commandId, workspaceId, scopeId, USER, decisionId, policyId, effectClass, DIGEST,
    kind, targetKind, targetId, targetRevision,
    terminal ? "completed" : "accepted", NOW, terminal ? NOW : null,
  ]);
}

async function seedExecutionLineage(pool, {
  runId, commandId, fence, invocationId, attemptId, checkpointId,
}) {
  const admissionId = `${invocationId}:admission`;
  const capacityId = `${invocationId}:capacity`;
  const capabilityId = `${invocationId}:capability`;
  await pool.query(`
    INSERT INTO public.admission_waiting (
      admission_id, command_id, workspace_id, schema_version, kind,
      invocation_id, state, created_at, updated_at
    ) VALUES ($1, $2, $3, 'workbench-v1', 'execution_invocation', $4,
      'waiting_capacity', $5, $5)
  `, [admissionId, commandId, W, invocationId, NOW]);
  await pool.query(`
    INSERT INTO public.capacity_leases (
      capacity_lease_id, admission_id, command_id, workspace_id,
      schema_version, backend_key, provider_key, fence, lease_duration_ms,
      status, issued_at, expires_at, updated_at, dimensions
    ) VALUES ($1, $2, $3, $4, 'workbench-v1',
      'deterministic_skill:process', 'provider:none', 1, 3600000,
      'active', $5, $6, $5, '[]'::jsonb)
  `, [capacityId, admissionId, commandId, W, NOW, EXPIRY]);
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.execution_invocations (
        invocation_id, workspace_id, schema_version, attempt_id,
        product_command_id, controller_kind, controller_id, controller_fence,
        mode, isolation, status, execution_fence,
        capacity_admission_id, capacity_lease_id, capacity_fence,
        capacity_backend_key, capacity_provider_key, capability_lease_id,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-execution-fabric-v1', $3, $4,
        'workflow_run', $5, $6, 'deterministic_skill', 'process', 'running', $6,
        $7, $8, 1, 'deterministic_skill:process', 'provider:none', $9, $10, $10
      )
    `, [
      invocationId, W, attemptId, commandId, runId, fence,
      admissionId, capacityId, capabilityId, NOW,
    ]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number,
        status, fence, started_at, created_at, updated_at
      ) VALUES ($1, $2, 'workbench-execution-fabric-v1', 1,
        'running', $3, $4, $4, $4)
    `, [attemptId, invocationId, fence, NOW]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'workbench-execution-fabric-v1',
        $5, 'active', $6, $7, $6)
    `, [capabilityId, invocationId, attemptId, W, fence, NOW, EXPIRY]);
    await client.query(`
      INSERT INTO public.execution_checkpoints (
        checkpoint_id, invocation_id, attempt_id, schema_version,
        sequence, fence, created_at
      ) VALUES ($1, $2, $3, 'workbench-execution-fabric-v1', 1, $4, $5)
    `, [checkpointId, invocationId, attemptId, fence, NOW]);
  });
}

async function seedRunNodeAttempt(pool, {
  runId, commandId, nodeAttemptId, attemptNumber,
  invocationId, executionAttemptId, checkpointId,
  fence, workerId, leaseToken, status = "running",
}) {
  const at = new Date().toISOString();
  await pool.query(`
    INSERT INTO public.workflow_run_node_attempts (
      workspace_id, node_attempt_id, run_id, scope_id, product_command_id,
      node_id, attempt_number, schema_version, status,
      invocation_id, execution_attempt_id, checkpoint_id,
      run_fence, lease_owner, lease_token, started_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'node-a', $6,
      'workbench-run-node-attempt-v1', $7, $8, $9, $10,
      $11, $12, $13, $14, $14, $14
    )
  `, [
    W, nodeAttemptId, runId, SCOPE, commandId, attemptNumber, status,
    invocationId, executionAttemptId, checkpointId,
    fence, workerId, leaseToken, at,
  ]);
}

async function seedExecutionRetryAttempt(pool, {
  invocationId, attemptId, attemptNumber, fence,
  status = "running", makeCurrent = true,
}) {
  const capabilityId = `${invocationId}:capability:${attemptNumber}`;
  const terminal = !["queued", "running"].includes(status);
  await inTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number,
        status, fence, started_at, finished_at, created_at, updated_at
      ) VALUES ($1, $2, 'workbench-execution-fabric-v1', $3,
        $4, $5, $6, $7, $6, $6)
    `, [attemptId, invocationId, attemptNumber, status, fence, NOW,
      terminal ? NOW : null]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, revoked_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'workbench-execution-fabric-v1',
        $5, $6, $7, $8, $9, $7)
    `, [capabilityId, invocationId, attemptId, W, fence,
      terminal ? "revoked" : "active", NOW, EXPIRY, terminal ? NOW : null]);
    if (makeCurrent) {
      await client.query(`
        UPDATE public.execution_invocations
        SET attempt_id = $1, capability_lease_id = $2,
            execution_fence = $3, updated_at = $4
        WHERE invocation_id = $5
      `, [attemptId, capabilityId, fence, NOW, invocationId]);
    }
  });
}

async function closeExecutionLineage(client, {
  nodeAttemptId, invocationId, executionAttemptId, status, at,
}) {
  await client.query(`
    UPDATE public.workflow_run_node_attempts
    SET status = $1, finished_at = $2, updated_at = $2
    WHERE workspace_id = $3 AND node_attempt_id = $4
  `, [status, at, W, nodeAttemptId]);
  await closeExecutionFabric(client, { invocationId, executionAttemptId, status, at });
}

async function closeExecutionFabric(client, {
  invocationId, executionAttemptId, status, at,
  settleInvocation = true, releaseCapacity = true,
}) {
  await client.query(`
    UPDATE public.execution_attempts
    SET status = $1, finished_at = $2, updated_at = $2
    WHERE invocation_id = $3 AND attempt_id = $4
  `, [status, at, invocationId, executionAttemptId]);
  if (settleInvocation) {
    await client.query(`
      UPDATE public.execution_invocations
      SET status = $1, finished_at = $2, updated_at = $2
      WHERE invocation_id = $3
    `, [status, at, invocationId]);
  }
  await client.query(`
    UPDATE public.capability_leases
    SET status = 'revoked', revoked_at = $1, updated_at = $1
    WHERE invocation_id = $2 AND attempt_id = $3
  `, [at, invocationId, executionAttemptId]);
  if (releaseCapacity) {
    await client.query(`
      UPDATE public.capacity_leases
      SET status = 'released', released_at = $1, updated_at = $1
      WHERE capacity_lease_id = $2
    `, [at, `${invocationId}:capacity`]);
  }
}

function workerEventSql({
  eventId, runId, sequence, type, status, fence,
  workerId, leaseToken, reviewId = null, nodeId = "node-a",
  nodeAttemptId = null,
  leaseExpiresAt = null, previousFence = null,
  previousLeaseOwner = null, previousLeaseToken = null,
  previousLeaseExpiresAt = null,
  occurredAt = new Date().toISOString(),
}) {
  const lineageRequired = type.startsWith("node.")
    || type === "review.requested"
    || [
      "run.completed", "run.failed", "run.cancelled",
      "run.partial", "run.effect_outcome_unknown",
    ].includes(type);
  const effectiveNodeAttemptId = nodeAttemptId
    ?? (lineageRequired ? "b3-node-attempt-a" : null);
  return {
    text: `
      INSERT INTO public.workflow_run_events (
        workspace_id, event_id, run_id, schema_version, sequence,
        type, status, node_id, node_attempt_id, review_id, summary, writer_kind,
        run_fence, lease_owner, lease_token, lease_expires_at,
        previous_run_fence, previous_lease_owner, previous_lease_token,
        previous_lease_expires_at, occurred_at
      ) VALUES (
        $1, $2, $3, 'workbench-run-event-v1', $4,
        $5, $6, $7, $8, $9, 'B3 event', 'worker', $10, $11, $12,
        $13, $14, $15, $16, $17, $18
      )
    `,
    values: [
      W, eventId, runId, sequence, type, status, nodeId, effectiveNodeAttemptId,
      reviewId, fence, workerId, leaseToken, leaseExpiresAt,
      previousFence, previousLeaseOwner, previousLeaseToken,
      previousLeaseExpiresAt, occurredAt,
    ],
  };
}

function controllerEventSql({
  eventId, runId, sequence, type, status, commandId, fence,
  reviewId = null, nodeId = reviewId ? "node-a" : null,
  workspaceId = W,
  occurredAt = new Date().toISOString(),
}) {
  return {
    text: `
      INSERT INTO public.workflow_run_events (
        workspace_id, event_id, run_id, schema_version, sequence,
        type, status, node_id, review_id, summary, writer_kind,
        product_command_id, run_fence, occurred_at
      ) VALUES (
        $1, $2, $3, 'workbench-run-event-v1', $4,
        $5, $6, $7, $8, 'B3 event', 'controller', $9, $10, $11
      )
    `,
    values: [
      workspaceId, eventId, runId, sequence, type, status, nodeId, reviewId,
      commandId, fence, occurredAt,
    ],
  };
}

async function claim(pool, workerId, leaseToken, leaseDuration = "1 minute") {
  const result = await pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    [workerId, leaseToken, `${leaseToken}:event`, leaseDuration],
  );
  assert.equal(result.rowCount, 1, "expected one claimable Run");
  return result.rows[0];
}

async function claimOptional(pool, workerId, leaseToken, leaseDuration = "1 minute") {
  const result = await pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    [workerId, leaseToken, `${leaseToken}:event`, leaseDuration],
  );
  assert.ok(result.rowCount <= 1, "claim must return at most one Run");
  return result.rows[0] ?? null;
}

async function runStatus(pool, runId) {
  const result = await pool.query(
    "SELECT status FROM public.workflow_runs WHERE workspace_id = $1 AND run_id = $2",
    [W, runId],
  );
  return result.rows[0]?.status;
}

async function commandStatus(pool, commandId) {
  const result = await pool.query(
    "SELECT status FROM public.product_commands WHERE workspace_id = $1 AND command_id = $2",
    [W, commandId],
  );
  return result.rows[0]?.status;
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function inTransactionResult(pool, operation) {
  let result;
  await inTransaction(pool, async (client) => {
    result = await operation(client);
  });
  return result;
}

async function expectTransactionError(pool, operation, code, constraintOrMessage) {
  await assert.rejects(
    () => inTransaction(pool, operation),
    (error) => {
      assert.equal(error.code, code);
      if (constraintOrMessage) {
        assert.ok(
          error.constraint === constraintOrMessage
          || String(error.message).includes(constraintOrMessage),
          `expected ${constraintOrMessage}, received ${error.constraint ?? error.message}`,
        );
      }
      return true;
    },
  );
}

async function expectConstraint(pool, statement, values, code, constraintOrMessage) {
  const query = typeof statement === "string" ? { text: statement, values } : statement;
  await assert.rejects(
    () => pool.query(query),
    (error) => {
      assert.equal(error.code, code);
      if (constraintOrMessage) {
        assert.ok(
          error.constraint === constraintOrMessage
          || String(error.message).includes(constraintOrMessage),
          `expected ${constraintOrMessage}, received ${error.constraint ?? error.message}`,
        );
      }
      return true;
    },
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
}
