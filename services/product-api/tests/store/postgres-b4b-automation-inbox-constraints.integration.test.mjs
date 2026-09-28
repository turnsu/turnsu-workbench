import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
  PostgresAutomationLifecycle,
  PostgresAutomationScheduler,
} from "../../src/automations/index.mjs";
import {
  AdmissionController,
  AdmittedExecutionDispatcher,
  ExecutionBroker,
  PostgresCapacityPersistence,
  PostgresExecutionPersistence,
} from "../../src/execution/index.mjs";
import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { PostgresInboxReadModel } from "../../src/inbox/postgres-inbox-read-model.mjs";
import { createPostgresRunControl } from "../../src/runner/postgres-run-control.mjs";
import {
  createPostgresConnectionApprovalResolver,
  createPostgresWorkflowExecutionResolver,
} from "../../src/runner/postgres-workflow-execution-resolver.mjs";
import { PostgresWorkflowRunCommandIntake } from "../../src/runner/postgres-workflow-run-command-intake.mjs";
import { PostgresWorkflowRunReviewCommandIntake } from "../../src/runner/postgres-workflow-run-review-command-intake.mjs";
import { createPostgresWorkflowRunPersistence } from "../../src/runner/postgres-workflow-run-persistence.mjs";
import { createWorkflowRunner } from "../../src/runner/workflow-runner.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const W = "b4bi-workspace";
const OWNER = "b4bi-owner";
const SCOPE = "b4bi-scope";
const POLICY_ISSUANCE = "b4bi-policy-r0";
const POLICY = "b4bi-policy-r1";
const OWNER_GRANT = "b4bi-owner-grant";
const AUTOMATION = "b4bi-automation-principal";
const AUTOMATION_GRANT = "b4bi-automation-grant";
const SCHEDULER = "b4bi-scheduler";
const SCHEDULER_GRANT = "b4bi-scheduler-grant";
const POLICY_GRANT = "b4bi-automation-policy-grant";
const WORKFLOW = "b4bi-workflow";
const WORKFLOW_REVISION = "b4bi-workflow-r1";
const COMPILE = "b4bi-compile-r1";
const PLAN = "b4bi-plan-r1";
const LOOP = "b4bi-loop-v1";
const RESOURCE = "b4bi-resource";
const RESOURCE_VERSION = "1.0.0";
const RESOURCE_HASH = hash("a");
const WORKFLOW_HASH = hash("b");
const PLAN_HASH = hash("c");
const LOOP_HASH = hash("d");
const MODEL_REVISION = "b4bi-model-r1";
const CONNECTION = "b4bi-connection";
const CONNECTION_REVISION = "b4bi-connection-r1";
const CONNECTION_SECRET = "b4bi-connection-secret-r1";
const CONNECTION_SECRET_R2 = "b4bi-connection-secret-r2";
const CONNECTION_FINGERPRINT = hash("e");
const CONNECTION_R2_FINGERPRINT = hash("5");
const DIGEST = hash("f");
const PAST = new Date(Date.now() - 10 * 60_000).toISOString();
const NOW = new Date(Date.now() - 5 * 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();
const LATER = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const NEW_YORK_SCHEDULE = currentNewYorkSchedule();
const NEW_YORK_CRON = `${NEW_YORK_SCHEDULE.minute} ${NEW_YORK_SCHEDULE.hour} * * *`;
const NEW_YORK_TIME = `${NEW_YORK_SCHEDULE.hour}:${NEW_YORK_SCHEDULE.minute}:00`;

function currentNewYorkSchedule() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    minute: Number(parts.find((part) => part.type === "minute")?.value),
  };
}

test("PostgreSQL B4B Batch B keeps daily Automation, intake, and Inbox authority transactional", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  assert.match(databaseName, /_test$/, "integration database must end in _test");

  const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool });
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  await store.runMigrations();
  await seedAuthority(pool);
  await seedPinnedLoopAndConnection(pool);
  await assertPublicAutomationLifecycle({ pool, store });
  await assertAutomationRevisionAndPinBoundaries(pool);
  await assertPastOccurrenceDedupeAndMisfire(pool);
  await assertAcceptedOccurrenceIntakeAggregate({ pool, store });
  await assertSkipMisfireCannotBecomeRun(pool);
  await assertRuntimeSchedulerGoldenPath({ pool, store });
  await assertInboxIdentityAndLifecycle(pool);
});

async function seedAuthority(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'B4B Inbox Owner', $2, $2)
  `, [OWNER, PAST]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'B4B Automation Inbox', $2, $3, $3)
  `, [W, OWNER, PAST]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES ('b4bi-owner-membership', $1, $2, 'workbench-v1', 'owner', $3, $3)
  `, [W, OWNER, PAST]);
  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id, membership_id, created_at, updated_at
    ) VALUES
      ($1, $2, 'user', $2, 'b4bi-owner-membership', $3, $3),
      ($1, $4, 'automation', NULL, NULL, $3, $3),
      ($1, $5, 'scheduler', NULL, NULL, $3, $3)
  `, [W, OWNER, PAST, AUTOMATION, SCHEDULER]);

  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id,
        owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind, creation_mode,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'personal', $3, $3, $4,
        $3, 'user', 'workspace_initial_seed', $5, $5
      )
    `, [W, SCOPE, OWNER, POLICY_ISSUANCE, PAST]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        policy_content_hash, created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, 1, 'private', 'interactive', ARRAY[]::text[], ARRAY[]::text[],
        $4, $5, 'user', $6
      )
    `, [W, SCOPE, POLICY_ISSUANCE, hash("1"), OWNER, PAST]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        policy_content_hash, created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, 2, 'private', 'auto', ARRAY['execute']::text[], ARRAY[]::text[],
        $4, $5, 'user', $6
      )
    `, [W, SCOPE, POLICY, hash("0"), OWNER, PAST]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
        capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'user', 'operation', ARRAY[]::text[], true,
        $4, 'user', 'scope_creation', $5, $5
      )
    `, [W, SCOPE, OWNER_GRANT, OWNER, PAST]);
  });

  await issueScopeGrant(pool, AUTOMATION_GRANT, AUTOMATION, "automation");
  await issueScopeGrant(pool, SCHEDULER_GRANT, SCHEDULER, "scheduler");
  await issueAutomationPolicyGrant(pool);
  await pool.query(`
    UPDATE public.product_scopes
    SET current_policy_revision_id = $1, revision = 2, updated_at = $2
    WHERE workspace_id = $3 AND scope_id = $4
  `, [POLICY, NOW, W, SCOPE]);
}

async function assertPublicAutomationLifecycle({ pool, store }) {
  let nextId = 0;
  const lifecycle = new PostgresAutomationLifecycle({
    store,
    idFactory: (kind) => `g6-${kind}-${++nextId}`,
  });
  const context = { workspaceId: W, userId: OWNER, role: "owner" };
  const scopes = await lifecycle.listScopes({ context });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].scopeId, SCOPE);
  assert.equal(scopes[0].policy.defaultPermission.mode, "auto");

  const candidates = await lifecycle.listCandidates({
    context,
    query: { scopeId: SCOPE },
  });
  assert.deepEqual(candidates, [{
    loopVersionId: LOOP,
    workflowId: WORKFLOW,
    scopeId: SCOPE,
    name: "Daily Automation Loop",
    description: "",
    version: "1.0.0",
    inputBindings: [{
      bindingId: `resource-${RESOURCE}-${RESOURCE_VERSION}`,
      inputKey: RESOURCE,
      label: "Daily brief",
      source: {
        kind: "resource",
        resourceId: RESOURCE,
        version: RESOURCE_VERSION,
        contentHash: RESOURCE_HASH,
      },
    }],
    connectionRequirements: [{
      requirementId: "daily-connection",
      capabilityKey: "calendar.read",
      description: "Daily automation calendar access.",
      requiredEffects: ["calendar.read"],
      eligibleConnectionIds: [CONNECTION],
    }],
  }]);

  const input = lifecycleInput();
  const created = await lifecycle.createAutomation({
    idempotencyKey: "g6-create-automation",
    request: { data: input },
    context,
  });
  assert.equal(created.data.status, "active");
  assert.equal(created.data.displayName, input.displayName);
  assert.equal(created.data.inputBindings[0].source.version, RESOURCE_VERSION);
  assert.equal(created.data.connectionBindings[0].revision, 1);
  assert.match(created.etag, /^"autv1:/);
  assert.equal(Object.hasOwn(created.data, "_etagRevision"), false);
  const replay = await lifecycle.createAutomation({
    idempotencyKey: "g6-create-automation",
    request: { data: input },
    context,
  });
  assert.deepEqual(replay, created, "a retried create must replay the immutable response");

  const paused = await lifecycle.pauseAutomation({
    automationId: created.data.automationId,
    idempotencyKey: "g6-pause-automation",
    ifMatch: created.etag,
    context,
  });
  assert.equal(paused.data.status, "paused");
  const active = await lifecycle.activateAutomation({
    automationId: created.data.automationId,
    idempotencyKey: "g6-activate-automation",
    ifMatch: paused.etag,
    context,
  });
  assert.equal(active.data.status, "active");
  const occurrences = await lifecycle.listOccurrences({
    automationId: created.data.automationId,
    context,
  });
  assert.deepEqual(occurrences, []);

  const events = await pool.query(`
    SELECT event.kind, command.kind, command.status,
           decision.disposition, decision.authorization_source
      FROM public.automation_lifecycle_events event
      JOIN public.product_commands command
        ON command.workspace_id = event.workspace_id
       AND command.command_id = event.command_id
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
     WHERE event.workspace_id = $1 AND event.automation_id = $2
     ORDER BY event.created_at ASC, event.command_id ASC
  `, [W, created.data.automationId]);
  assert.deepEqual(events.rows.map((row) => ({
    kind: row.kind,
    command_kind: row.kind,
    command_status: row.status,
    disposition: row.disposition,
    authorization_source: row.authorization_source,
  })), [
    { kind: "automation_create", command_kind: "automation_create", command_status: "completed", disposition: "authorized", authorization_source: "principal" },
    { kind: "automation_pause", command_kind: "automation_pause", command_status: "completed", disposition: "authorized", authorization_source: "principal" },
    { kind: "automation_activate", command_kind: "automation_activate", command_status: "completed", disposition: "authorized", authorization_source: "principal" },
  ]);

  const automationRevisionId = (await pool.query(`
    SELECT current_revision_id
      FROM public.automations
     WHERE workspace_id = $1 AND automation_id = $2
  `, [W, created.data.automationId])).rows[0].current_revision_id;
  const execution = await createPostgresWorkflowExecutionResolver({ store })({
    workflowId: WORKFLOW,
    revisionId: WORKFLOW_REVISION,
    automationRevisionId,
  });
  assert.deepEqual(execution.revision.resourceRefs, [{
    resourceId: RESOURCE,
    version: RESOURCE_VERSION,
    contentHash: RESOURCE_HASH,
  }]);
  assert.deepEqual([...execution.resources.values()].map((resource) => ({
    resourceId: resource.resourceId,
    version: resource.version,
    label: resource.label,
  })), [{ resourceId: RESOURCE, version: RESOURCE_VERSION, label: "Daily brief" }]);
  assert.equal(execution.connectionBindings.length, 1);
  assert.equal(execution.connectionBindings[0].requirementId, "daily-connection");
  assert.equal(execution.connectionBindings[0].capabilityKey, "calendar.read");
  const approval = await createPostgresConnectionApprovalResolver({ store })({
    workspaceId: W,
    connectionId: CONNECTION,
    requirementId: "daily-connection",
    automationRevisionId,
  });
  assert.equal(approval.requirementId, "daily-connection");
  assert.equal(approval.capabilityKey, "calendar.read");
}

function lifecycleInput() {
  return {
    scopeId: SCOPE,
    displayName: "G6 public daily brief",
    loopVersionId: LOOP,
    trigger: { kind: "daily_cron", expression: "0 9 * * *", timezone: "Etc/UTC" },
    inputBindings: [{
      bindingId: `resource-${RESOURCE}-${RESOURCE_VERSION}`,
      inputKey: RESOURCE,
      source: {
        kind: "resource",
        resourceId: RESOURCE,
        version: RESOURCE_VERSION,
        contentHash: RESOURCE_HASH,
      },
    }],
    connectionBindings: [{ requirementId: "daily-connection", connectionId: CONNECTION }],
    budgetPolicy: { maxCostUsdMicros: 1_000, maxRuntimeSeconds: 300 },
    misfirePolicy: { kind: "run_once", maxLatenessSeconds: 300 },
    grantExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    grantReviewAt: null,
  };
}

async function issueScopeGrant(pool, grantId, principalId, principalKind) {
  const commandId = `${grantId}-issue-command`;
  const decisionId = `${commandId}-authorized`;
  const targetContract = {
    scopeId: SCOPE,
    grantId,
    subjectPrincipalId: principalId,
    subjectPrincipalKind: principalKind,
    accessKind: "operation",
    capabilities: [],
    canApprove: false,
    grantorPrincipalId: OWNER,
    grantorPrincipalKind: "user",
    issuanceKind: "command",
    status: "active",
  };
  await withTransaction(pool, async (client) => {
    await insertPrincipalApprovalPair(client, {
      decisionId,
      actionId: "scope_principal_grant_issue",
      effectClass: "administrative",
      targetContract,
    });
    await insertCommand(client, {
      commandId,
      decisionId,
      kind: "scope_principal_grant_issue",
      effectClass: "administrative",
      targetKind: "scope_principal_grant",
      targetId: grantId,
      targetContract,
      status: "completed",
      createdAt: PAST,
    });
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind, issuance_kind,
        issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'operation', ARRAY[]::text[], false,
        $6, 'user', 'command', $2, $7, $8, $9, $10, $10
      )
    `, [
      W, SCOPE, grantId, principalId, principalKind, OWNER,
      commandId, decisionId, DIGEST, PAST,
    ]);
  });
}

async function issueAutomationPolicyGrant(pool) {
  const commandId = "b4bi-policy-grant-issue-command";
  const decisionId = `${commandId}-authorized`;
  const targetContract = {
    scopeId: SCOPE,
    policyGrantId: POLICY_GRANT,
    subjectPrincipalId: AUTOMATION,
    subjectPrincipalKind: "automation",
    subjectScopeGrantId: AUTOMATION_GRANT,
    policyRevisionId: POLICY,
    authorizerPrincipalId: OWNER,
    authorizerPrincipalKind: "user",
    authorizerScopeGrantId: OWNER_GRANT,
    expiresAt: isoWithMicroseconds(FUTURE),
    reviewAt: null,
    status: "active",
  };
  await withTransaction(pool, async (client) => {
    await insertPrincipalApprovalPair(client, {
      decisionId,
      actionId: "policy_grant_issue",
      effectClass: "administrative",
      targetContract,
    });
    await insertCommand(client, {
      commandId,
      decisionId,
      kind: "policy_grant_issue",
      effectClass: "administrative",
      targetKind: "policy_grant",
      targetId: POLICY_GRANT,
      targetContract,
      status: "completed",
      createdAt: PAST,
    });
    await client.query(`
      INSERT INTO public.policy_grants (
        workspace_id, scope_id, policy_grant_id,
        subject_principal_id, subject_principal_kind, subject_scope_grant_id,
        policy_revision_id, authorized_by_principal_id, authorized_by_principal_kind,
        authorizer_scope_grant_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        status, expires_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'automation', $5, $6, $7, 'user', $8, $9, $10, $11,
        'active', $12, $13, $13
      )
    `, [
      W, SCOPE, POLICY_GRANT, AUTOMATION, AUTOMATION_GRANT, POLICY,
      OWNER, OWNER_GRANT, commandId, decisionId, DIGEST, FUTURE, PAST,
    ]);
  });
}

async function seedPinnedLoopAndConnection(pool) {
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.product_objects (
        workspace_id, object_id, schema_version, object_kind, content_hash,
        size_bytes, media_type, storage_backend, storage_key, storage_version, state, created_at
      ) VALUES (
        $1, 'b4bi-resource-object', 'workbench-v1', 'resource_content', $2,
        12, 'text/markdown', 'test', 'resource/b4bi', 'v1', 'promoted', $3
      )
    `, [W, RESOURCE_HASH, PAST]);
    await client.query(`
      INSERT INTO public.workspace_resources (
        workspace_id, resource_id, resource_version, created_by, schema_version,
        label, media_type, size_bytes, content_hash, object_id, source_kind,
        readiness_status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'Daily brief', 'text/markdown', 12,
        $5, 'b4bi-resource-object', 'text_entry', 'ready', $6, $6
      )
    `, [W, RESOURCE, RESOURCE_VERSION, OWNER, RESOURCE_HASH, PAST]);

    await client.query(`
      INSERT INTO public.model_profiles (
        profile_id, workspace_id, scope_id, schema_version, profile_scope, display_name,
        current_revision_id, current_revision_number,
        created_by_principal_id, created_by_principal_kind, created_at, updated_at
      ) VALUES (
        'b4bi-model', $1, $2, 'workbench-model-catalog-v1', 'workspace', 'B4B model',
        $3, 1, $4, 'user', $5, $5
      )
    `, [W, SCOPE, MODEL_REVISION, OWNER, PAST]);
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref, store_binding_revision,
        credential_fingerprint, status, created_by_principal_id, created_by_principal_kind,
        probed_at, expires_at, created_at, updated_at
      ) VALUES (
        $1, 'b4bi-model-secret', $2, 'workbench-secret-binding-v1',
        'model_profile_revision', $3, 'cloud_secret_store', 'b4bi-model-store', 1,
        $4, 'active', $5, 'user', $6, $7, $8, $8
      )
    `, [W, SCOPE, MODEL_REVISION, hash("2"), OWNER, PAST, FUTURE, PAST]);
    await client.query(`
      INSERT INTO public.model_profile_revisions (
        revision_id, workspace_id, profile_id, revision_number, schema_version,
        provider, protocol, provider_model_ref, capabilities,
        parameter_support, limits, data_policy, cost_policy,
        parameter_schema_version, policy_version, config_hash, deployment_key,
        secret_binding_id, created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, 'b4bi-model', 1, 'workbench-model-catalog-v1',
        'openai', 'openai_compatible_chat', 'b4bi-model', ARRAY['chat']::text[],
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '1.0.0', '1.0.0', $3, 'b4bi-model-deployment',
        'b4bi-model-secret', $4, 'user', $5
      )
    `, [MODEL_REVISION, W, hash("3"), OWNER, PAST]);
    await client.query(`
      INSERT INTO public.workspace_model_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, schema_version,
        capability_model_revision_ids, policy_version, content_hash, created_by, created_at
      ) VALUES (
        $1, $2, 'b4bi-model-policy-r1', 1, 'workbench-model-policy-v1',
        jsonb_build_object('chat', $3::text), '1.0.0', $4, $5, $6
      )
    `, [W, SCOPE, MODEL_REVISION, hash("4"), OWNER, PAST]);

    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, status, lifecycle, visibility, current_revision_id, current_revision_number,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'Daily Automation Loop',
        'ready', 'ready', 'private', $5, 1, $6, $6
      )
    `, [W, WORKFLOW, SCOPE, OWNER, WORKFLOW_REVISION, PAST]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, schema_version,
        graph, input_form, output_definition, resource_refs, run_settings, definition,
        content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 1, 'workbench-v1',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        jsonb_build_array(jsonb_build_object(
          'resourceId', $4::text, 'version', $5::text, 'contentHash', $6::text
        )),
        '{}'::jsonb, '{}'::jsonb, $7, $8, 'B4B fixture', $9, $9
      )
    `, [
      W, WORKFLOW_REVISION, WORKFLOW, RESOURCE, RESOURCE_VERSION,
      RESOURCE_HASH, WORKFLOW_HASH, OWNER, PAST,
    ]);

    const planDocument = {
      schemaVersion: "workbench-execution-plan-v2",
      planVersion: "2",
      workflowId: WORKFLOW,
      workflowRevisionId: WORKFLOW_REVISION,
      generatedAt: PAST,
      contentHash: PLAN_HASH,
      maxParallelism: 1,
      modelRoutingState: "pinned",
      pinnedSkills: [],
      steps: [{
        nodeId: "daily-node",
        modelProfileRevisionId: MODEL_REVISION,
        modelCapability: "chat",
        fallbackModelProfileRevisionIds: [],
        capabilities: { connectionIds: ["daily-connection"] },
      }],
      reviewGates: [],
      primaryOutput: { nodeId: "daily-node", portId: "result" },
    };
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, status, execution_plan_id, ordered_steps, review_gates, compiled_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'ready', $5,
        '["daily-node"]'::jsonb, '[]'::jsonb, $6
      )
    `, [W, COMPILE, WORKFLOW, WORKFLOW_REVISION, PLAN, PAST]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, plan_version, content_hash, model_routing_state,
        plan_document, pins_finalized, generated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'workbench-execution-plan-v2', 2, $6, 'pinned',
        $7::jsonb, false, $8
      )
    `, [
      W, PLAN, COMPILE, WORKFLOW, WORKFLOW_REVISION, PLAN_HASH,
      JSON.stringify(planDocument), PAST,
    ]);
    await client.query(`
      INSERT INTO public.execution_plan_model_pins (
        workspace_id, plan_id, node_id, pin_role, ordinal,
        model_profile_revision_id, schema_version, created_at
      ) VALUES ($1, $2, 'daily-node', 'primary', 0, $3, 'workbench-internal-v1', $4)
    `, [W, PLAN, MODEL_REVISION, PAST]);
    await client.query(`
      UPDATE public.execution_plans
      SET pins_finalized = true
      WHERE workspace_id = $1 AND plan_id = $2
    `, [W, PLAN]);
    await client.query(`
      INSERT INTO public.loop_versions (
        workspace_id, loop_version_id, workflow_id, workflow_revision_id,
        schema_version, version, workflow_revision_content_hash,
        compile_result_id, execution_plan_id, definition, content_hash,
        released_by, released_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', '1.0.0', $5,
        $6, $7, '{"name":"B4B daily loop"}'::jsonb, $8, $9, $10
      )
    `, [
      W, LOOP, WORKFLOW, WORKFLOW_REVISION, WORKFLOW_HASH,
      COMPILE, PLAN, LOOP_HASH, OWNER, PAST,
    ]);
    await client.query(`
      INSERT INTO public.loop_version_resource_pins (
        workspace_id, loop_version_id, workflow_id, resource_id,
        resource_version, content_hash, schema_version
      ) VALUES ($1, $2, $3, $4, $5, $6, 'workbench-internal-v1')
    `, [W, LOOP, WORKFLOW, RESOURCE, RESOURCE_VERSION, RESOURCE_HASH]);
    await client.query(`
      INSERT INTO public.loop_version_connection_requirements (
        workspace_id, loop_version_id, workflow_id, requirement_id,
        capability_key, description, required_effects, schema_version
      ) VALUES (
        $1, $2, $3, 'daily-connection', 'calendar.read',
        'Daily automation calendar access.', '["calendar.read"]'::jsonb,
        'workbench-internal-v1'
      )
    `, [W, LOOP, WORKFLOW]);
    await client.query(`
      UPDATE public.loop_versions
      SET pins_finalized = true
      WHERE workspace_id = $1 AND loop_version_id = $2
    `, [W, LOOP]);
  });

  await seedConnectionRevisions(pool);
}

async function seedConnectionRevisions(pool) {
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workspace_connections (
        workspace_id, connection_id, scope_id, created_by, schema_version,
        label, current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'B4B calendar', $5, 1, $6, $6)
    `, [W, CONNECTION, SCOPE, OWNER, CONNECTION_REVISION, PAST]);
    await insertConnectionRevision(client, {
      revisionId: CONNECTION_REVISION,
      revisionNumber: 1,
      secretId: CONNECTION_SECRET,
      fingerprint: CONNECTION_FINGERPRINT,
    });
    await insertConnectionRevision(client, {
      revisionId: "b4bi-connection-r2",
      revisionNumber: 2,
      baseRevisionId: CONNECTION_REVISION,
      secretId: CONNECTION_SECRET_R2,
      fingerprint: CONNECTION_R2_FINGERPRINT,
    });
  });
}

async function insertConnectionRevision(client, {
  revisionId,
  revisionNumber,
  baseRevisionId = null,
  secretId,
  fingerprint,
}) {
  await client.query(`
    INSERT INTO public.secret_bindings (
      workspace_id, secret_binding_id, scope_id, schema_version,
      owner_kind, owner_id, secret_source, store_binding_ref, store_binding_revision,
      credential_fingerprint, status, created_by_principal_id, created_by_principal_kind,
      probed_at, expires_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, 'workbench-secret-binding-v1',
      'connection', $4, 'cloud_secret_store', $5, $6, $7,
      'active', $8, 'user', $9, $10, $11, $11
    )
  `, [
    W, secretId, SCOPE, CONNECTION, `${secretId}-store`, revisionNumber,
    fingerprint, OWNER, PAST, FUTURE, PAST,
  ]);
  await client.query(`
    INSERT INTO public.workspace_connection_revisions (
      workspace_id, connection_revision_id, connection_id, scope_id, revision_number,
      base_revision_id, base_revision_number, schema_version,
      capability_key, driver_key, driver_backend, safe_configuration,
      credential_state, secret_binding_id, credential_binding_fingerprint,
      readiness_status, validation_status, validation_message, validation_principal,
      validation_scopes, validation_effects, validation_checked_at, validation_expires_at,
      content_hash, created_by, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, 'workbench-connection-v1',
      'calendar.read', 'calendar', 'production', '{}'::jsonb,
      'bound', $8, $9, 'connected', 'valid', 'Ready.', 'b4bi-calendar-owner',
      '[]'::jsonb, '["calendar.read"]'::jsonb, $10, $11,
      $12, $13, $14
    )
  `, [
    W, revisionId, CONNECTION, SCOPE, revisionNumber, baseRevisionId,
    baseRevisionId === null ? null : revisionNumber - 1, secretId, fingerprint,
    PAST, FUTURE, hash(String(revisionNumber)), OWNER, PAST,
  ]);
}

async function assertAutomationRevisionAndPinBoundaries(pool) {
  await expectSqlState(pool, () => withTransaction(pool, async (client) => {
    await insertAutomationRoot(client, "b4bi-automation-r1", 1);
    await insertAutomationRevision(client, {
      revisionId: "b4bi-automation-r1",
      revisionNumber: 1,
      triggerRevision: 1,
      cronExpression: "0 9 * * *",
      timezoneName: "Etc/UTC",
    });
    await insertConnectionPin(client, "b4bi-automation-r1");
    await finalizeAutomationRevision(client, "b4bi-automation-r1");
  }), "23514", /automation_resource_pin_projection_incomplete/);

  await withTransaction(pool, async (client) => {
    await insertAutomationRoot(client, "b4bi-automation-r1", 1);
    await insertAutomationRevision(client, {
      revisionId: "b4bi-automation-r1",
      revisionNumber: 1,
      triggerRevision: 1,
      cronExpression: "0 9 * * *",
      timezoneName: "Etc/UTC",
    });

    await expectClientSqlState(client, () => client.query(`
      INSERT INTO public.automation_input_pins (
        workspace_id, automation_revision_id, automation_id, scope_id, workflow_id,
        loop_version_id, input_pin_id, input_name, input_kind,
        resource_id, resource_version, resource_content_hash, schema_version, created_at
      ) VALUES (
        '${W}', 'b4bi-automation-r1', 'b4bi-automation', '${SCOPE}', '${WORKFLOW}',
        '${LOOP}', 'b4bi-artifact-pin', 'artifact-input', 'artifact',
        '${RESOURCE}', '${RESOURCE_VERSION}', '${RESOURCE_HASH}',
        'workbench-automation-input-pin-v1', '${PAST}'::timestamptz
      )
    `), "23514", /automation_input_pins_kind/);
    await expectClientSqlState(client, () => client.query(`
      INSERT INTO public.automation_input_pins (
        workspace_id, automation_revision_id, automation_id, scope_id, workflow_id,
        loop_version_id, input_pin_id, input_name, input_kind,
        resource_id, resource_version, resource_content_hash, schema_version, created_at
      ) VALUES (
        '${W}', 'b4bi-automation-r1', 'b4bi-automation', '${SCOPE}', '${WORKFLOW}',
        '${LOOP}', 'b4bi-wrong-resource-pin', 'daily-brief', 'resource',
        '${RESOURCE}', '9.9.9', '${RESOURCE_HASH}',
        'workbench-automation-input-pin-v1', '${PAST}'::timestamptz
      )
    `), "23503");
    await insertResourcePin(client, "b4bi-automation-r1");

    await expectClientSqlState(client, () => insertConnectionPin(client, "b4bi-automation-r1", {
      secretId: CONNECTION_SECRET_R2,
      fingerprint: hash("5"),
    }), "23514", /automation_connection_pin_not_consumable/);
    await insertConnectionPin(client, "b4bi-automation-r1");
    await finalizeAutomationRevision(client, "b4bi-automation-r1");
  });

  await expectSqlState(pool, () => withTransaction(pool, (client) => insertAutomationRevision(client, {
    revisionId: "b4bi-automation-r2-forged-generation",
    revisionNumber: 2,
    baseRevisionId: "b4bi-automation-r1",
    triggerRevision: 2,
    cronExpression: "0 9 * * *",
    timezoneName: "Etc/UTC",
  })), "23514", /automation_trigger_generation_content_mismatch/);

  await appendAutomationRevision(pool, {
    revisionId: "b4bi-automation-r2",
    revisionNumber: 2,
    baseRevisionId: "b4bi-automation-r1",
    triggerRevision: 1,
    cronExpression: "0 9 * * *",
    timezoneName: "Etc/UTC",
  });

  await expectSqlState(pool, () => withTransaction(pool, (client) => insertAutomationRevision(client, {
    revisionId: "b4bi-automation-r3-forged-generation",
    revisionNumber: 3,
    baseRevisionId: "b4bi-automation-r2",
    triggerRevision: 1,
    cronExpression: "0 10 * * *",
    timezoneName: "Etc/UTC",
  })), "23514", /automation_trigger_generation_not_next/);

  await appendAutomationRevision(pool, {
    revisionId: "b4bi-automation-r3",
    revisionNumber: 3,
    baseRevisionId: "b4bi-automation-r2",
    triggerRevision: 2,
    cronExpression: "0 10 * * *",
    timezoneName: "Etc/UTC",
  });

  await expectSqlState(pool, () => withTransaction(pool, (client) => insertAutomationRevision(client, {
    revisionId: "b4bi-automation-r4-forged-generation",
    revisionNumber: 4,
    baseRevisionId: "b4bi-automation-r3",
    triggerRevision: 2,
    cronExpression: "0 10 * * *",
    timezoneName: "America/New_York",
  })), "23514", /automation_trigger_generation_not_next/);

  await appendAutomationRevision(pool, {
    revisionId: "b4bi-automation-r4",
    revisionNumber: 4,
    baseRevisionId: "b4bi-automation-r3",
    triggerRevision: 3,
    cronExpression: NEW_YORK_CRON,
    timezoneName: "America/New_York",
  });

  const revisions = await pool.query(`
    SELECT automation_revision_id, revision_number, trigger_revision, trigger_content_key
    FROM public.automation_revisions
    WHERE workspace_id = $1 AND automation_id = 'b4bi-automation'
      AND automation_revision_id NOT LIKE '%forged%'
    ORDER BY revision_number
  `, [W]);
  assert.deepEqual(revisions.rows.map((row) => ({
    automation_revision_id: row.automation_revision_id,
    revision_number: row.revision_number,
    trigger_revision: row.trigger_revision,
  })), [
    { automation_revision_id: "b4bi-automation-r1", revision_number: 1, trigger_revision: 1 },
    { automation_revision_id: "b4bi-automation-r2", revision_number: 2, trigger_revision: 1 },
    { automation_revision_id: "b4bi-automation-r3", revision_number: 3, trigger_revision: 2 },
    { automation_revision_id: "b4bi-automation-r4", revision_number: 4, trigger_revision: 3 },
  ]);
  assert.notEqual(revisions.rows[0].trigger_content_key, revisions.rows[2].trigger_content_key);
  assert.notEqual(revisions.rows[2].trigger_content_key, revisions.rows[3].trigger_content_key);
}

async function insertAutomationRoot(client, revisionId, revisionNumber) {
  await client.query(`
    INSERT INTO public.automations (
      workspace_id, automation_id, scope_id, owner_user_id, owner_principal_id,
      automation_principal_id, schema_version, display_name, status,
      current_revision_id, current_revision_number, next_scheduled_at,
      created_by_principal_id, created_by_principal_kind, created_at, updated_at
    ) VALUES (
      $1, 'b4bi-automation', $2, $3, $3, $4,
      'workbench-automation-v1', 'Daily B4B inbox', 'active',
      $5, $6, $7, $3, 'user', $8, $8
    )
  `, [W, SCOPE, OWNER, AUTOMATION, revisionId, revisionNumber, FUTURE, PAST]);
}

async function insertAutomationRevision(client, {
  revisionId,
  revisionNumber,
  baseRevisionId = null,
  triggerRevision,
  cronExpression,
  timezoneName,
  misfirePolicy = "run_once",
  maxMisfireLatenessSeconds = 86_400,
}) {
  await client.query(`
    INSERT INTO public.automation_revisions (
      workspace_id, automation_revision_id, automation_id, scope_id,
      automation_principal_id, owner_user_id, owner_scope_grant_id,
      revision_number, base_revision_id, base_revision_number, schema_version,
      workflow_id, workflow_revision_id, workflow_revision_content_hash,
      loop_version_id, loop_version_content_hash, compile_result_id,
      execution_plan_id, execution_plan_content_hash,
      scope_policy_revision_id, policy_grant_id, observed_policy_grant_revision,
      model_policy_revision_id, model_policy_revision_number, model_profile_revision_ids,
      trigger_kind, cron_expression, timezone_name, trigger_revision,
      execution_location_policy, budget_currency, max_cost_microunits,
      max_duration_seconds, approval_policy, allowed_effect_classes,
      misfire_policy, misfire_max_lateness_seconds, dedupe_policy, content_hash,
      created_by_principal_id, created_by_principal_kind, created_at
    ) VALUES (
      $1, $2, 'b4bi-automation', $3,
      $4, $5, $6, $7, $8, $9, 'workbench-automation-revision-v1',
      $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, 1,
      'b4bi-model-policy-r1', 1, ARRAY[$20::public.product_identifier],
      'daily_cron', $21, $22, $23,
      'cloud', 'USD', 1000, 300, 'policy_grant_only', ARRAY['execute']::text[],
      $24, $25, 'local_schedule_date', $26,
      $5, 'user', $27
    )
  `, [
    W, revisionId, SCOPE, AUTOMATION, OWNER, OWNER_GRANT,
    revisionNumber, baseRevisionId, baseRevisionId === null ? null : revisionNumber - 1,
    WORKFLOW, WORKFLOW_REVISION, WORKFLOW_HASH, LOOP, LOOP_HASH, COMPILE,
    PLAN, PLAN_HASH, POLICY, POLICY_GRANT, MODEL_REVISION,
    cronExpression, timezoneName, triggerRevision,
    misfirePolicy, maxMisfireLatenessSeconds,
    hash(["7", "8", "9", "a", "b"][revisionNumber - 1]), PAST,
  ]);
}

async function insertResourcePin(client, revisionId) {
  await client.query(`
    INSERT INTO public.automation_input_pins (
      workspace_id, automation_revision_id, automation_id, scope_id, workflow_id,
      loop_version_id, input_pin_id, input_name, input_kind,
      resource_id, resource_version, resource_content_hash, schema_version, created_at
    ) VALUES (
      $1, $2, 'b4bi-automation', $3, $4, $5,
      $6, 'daily-brief', 'resource', $7, $8, $9,
      'workbench-automation-input-pin-v1', $10
    )
  `, [
    W, revisionId, SCOPE, WORKFLOW, LOOP, `${revisionId}-resource`,
    RESOURCE, RESOURCE_VERSION, RESOURCE_HASH, PAST,
  ]);
}

async function insertConnectionPin(client, revisionId, {
  secretId = CONNECTION_SECRET,
  fingerprint = CONNECTION_FINGERPRINT,
} = {}) {
  await client.query(`
    INSERT INTO public.automation_connection_pins (
      workspace_id, automation_revision_id, automation_id, scope_id, workflow_id,
      loop_version_id, requirement_id, capability_key, required_effects,
      connection_id, connection_revision_id, connection_revision_number,
      secret_binding_id, secret_source, store_binding_ref, store_binding_revision,
      credential_fingerprint, schema_version, created_at
    ) VALUES (
      $1, $2, 'b4bi-automation', $3, $4, $5,
      'daily-connection', 'calendar.read', '["calendar.read"]'::jsonb,
      $6, $7, 1, $8, 'cloud_secret_store', $9, 1, $10,
      'workbench-automation-connection-pin-v1', $11
    )
  `, [
    W, revisionId, SCOPE, WORKFLOW, LOOP, CONNECTION, CONNECTION_REVISION,
    secretId, `${secretId}-store`, fingerprint, PAST,
  ]);
}

async function finalizeAutomationRevision(client, revisionId) {
  await client.query(`
    UPDATE public.automation_revisions
    SET pins_finalized = true
    WHERE workspace_id = $1 AND automation_revision_id = $2
  `, [W, revisionId]);
}

async function appendAutomationRevision(pool, revision) {
  await withTransaction(pool, async (client) => {
    await insertAutomationRevision(client, revision);
    await insertResourcePin(client, revision.revisionId);
    await insertConnectionPin(client, revision.revisionId);
    await finalizeAutomationRevision(client, revision.revisionId);
    await client.query(`
      UPDATE public.automations
      SET current_revision_id = $1,
          current_revision_number = $2,
          write_version = $2,
          updated_at = $3
      WHERE workspace_id = $4 AND automation_id = 'b4bi-automation'
    `, [revision.revisionId, revision.revisionNumber, NOW, W]);
  });
}

async function assertPastOccurrenceDedupeAndMisfire(pool) {
  await pool.query(`
    INSERT INTO public.automation_occurrences (
      workspace_id, occurrence_id, automation_id, automation_revision_id, trigger_revision,
      local_schedule_date, scheduled_for, status, schema_version, created_at, updated_at
    ) SELECT
      $1, 'b4bi-misfire-occurrence', 'b4bi-automation', 'b4bi-automation-r4', 3,
      (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 3,
      (((clock_timestamp() AT TIME ZONE 'America/New_York')::date - 3)::timestamp + $3::time) AT TIME ZONE 'America/New_York',
      'due', 'workbench-automation-occurrence-v1', $2, $2
  `, [W, PAST, NEW_YORK_TIME]);
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.automation_occurrences (
      workspace_id, occurrence_id, automation_id, automation_revision_id, trigger_revision,
      local_schedule_date, scheduled_for, status, schema_version, created_at, updated_at
    ) SELECT
      $1, 'b4bi-duplicate-occurrence', 'b4bi-automation', 'b4bi-automation-r4', 3,
      (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 3,
      (((clock_timestamp() AT TIME ZONE 'America/New_York')::date - 3)::timestamp + $3::time) AT TIME ZONE 'America/New_York',
      'due', 'workbench-automation-occurrence-v1', $2, $2
  `, [W, PAST, NEW_YORK_TIME]), "23505", /automation_occurrences_dedupe_uq/);
  await pool.query(`
    UPDATE public.automation_occurrences
    SET status = 'misfired', reason_code = 'scheduler_delayed',
        terminal_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND occurrence_id = 'b4bi-misfire-occurrence'
  `, [NOW, W]);
  const occurrence = await pool.query(`
    SELECT status, reason_code, scheduled_for < clock_timestamp() AS scheduled_in_past
    FROM public.automation_occurrences
    WHERE workspace_id = $1 AND occurrence_id = 'b4bi-misfire-occurrence'
  `, [W]);
  assert.deepEqual(occurrence.rows, [{
    status: "misfired", reason_code: "scheduler_delayed", scheduled_in_past: true,
  }]);

  await pool.query(`
    INSERT INTO public.automation_occurrences (
      workspace_id, occurrence_id, automation_id, automation_revision_id, trigger_revision,
      local_schedule_date, scheduled_for, status, schema_version, created_at, updated_at
    ) SELECT
      $1, 'b4bi-overlate-runonce-occurrence', 'b4bi-automation', 'b4bi-automation-r4', 3,
      (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 2,
      (((clock_timestamp() AT TIME ZONE 'America/New_York')::date - 2)::timestamp + $3::time) AT TIME ZONE 'America/New_York',
      'due', 'workbench-automation-occurrence-v1', $2, $2
  `, [W, PAST, NEW_YORK_TIME]);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.automation_occurrences
    SET status = 'accepted', accepted_at = clock_timestamp(),
        terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE workspace_id = $1 AND occurrence_id = 'b4bi-overlate-runonce-occurrence'
  `, [W]), "23514", /automation_occurrence_misfire_lateness_exceeded/);
}

async function assertAcceptedOccurrenceIntakeAggregate({ pool, store }) {
  const runId = "b4bi-scheduler-workflow-run";
  await withTransaction(pool, async (client) => {
    const decisionId = "b4bi-scheduler-workflow-run-decision";
    const commandId = "b4bi-scheduler-workflow-run-command";
    const occurrenceId = "b4bi-accepted-occurrence";
    await client.query(`
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, policy_grant_id, action_id, effect_class, argument_digest,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        destructive_rule_version, disposition, reason_code, decided_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'scheduler', $6,
        $7, 'automation', $8, 'policy_grant', $9, 'workflow_run', 'execute', $10,
        'auto', ARRAY['execute']::text[], ARRAY[]::text[],
        'authority-v1', 'authorized', 'scheduler_policy_grant', $11, $12
      )
    `, [
      W, decisionId, SCOPE, POLICY, SCHEDULER, SCHEDULER_GRANT,
      AUTOMATION, AUTOMATION_GRANT, POLICY_GRANT, DIGEST, PAST, FUTURE,
    ]);
    await insertCommand(client, {
      commandId,
      decisionId,
      actorId: SCHEDULER,
      actorKind: "scheduler",
      effectiveId: AUTOMATION,
      effectiveKind: "automation",
      kind: "workflow_run",
      effectClass: "execute",
      targetKind: "workflow_run",
      targetId: runId,
      policyRevision: POLICY,
      status: "accepted",
    });
    await client.query(`
      INSERT INTO public.workflow_runs (
        workspace_id, run_id, scope_id, product_command_id,
        workflow_id, workflow_revision_id, workflow_revision_content_hash,
        compile_result_id, execution_plan_id, execution_plan_content_hash,
        schema_version, inputs, resource_refs, idempotency_key,
        status, event_sequence, queued_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'workbench-run-v1', '{}'::jsonb,
        jsonb_build_array(jsonb_build_object(
          'resourceId', $11::text, 'version', $12::text,
          'label', 'Daily brief', 'contentHash', $13::text
        )),
        $14, 'queued', 0, $15, $15, $15
      )
    `, [
      W, runId, SCOPE, commandId, WORKFLOW, WORKFLOW_REVISION, WORKFLOW_HASH,
      COMPILE, PLAN, PLAN_HASH, RESOURCE, RESOURCE_VERSION, RESOURCE_HASH,
      occurrenceId, NOW,
    ]);
    await client.query(`
      INSERT INTO public.workflow_run_jobs (
        workspace_id, run_id, schema_version, state, available_at, queued_at, created_at, updated_at
      ) VALUES ($1, $2, 'workbench-run-job-v1', 'queued', $3, $3, $3, $3)
    `, [W, runId, NOW]);
    await client.query(`
      INSERT INTO public.workflow_run_events (
        workspace_id, event_id, run_id, schema_version, sequence,
        type, status, summary, writer_kind, product_command_id, run_fence, occurred_at
      ) VALUES (
        $1, $2, $3, 'workbench-run-event-v1', 1,
        'run.queued', 'queued', 'Automation Run queued.', 'controller', $4, 0, $5
      )
    `, [W, `${runId}:queued`, runId, commandId, NOW]);
    await client.query(`
      INSERT INTO public.automation_occurrences (
        workspace_id, occurrence_id, automation_id, automation_revision_id, trigger_revision,
        local_schedule_date, scheduled_for, status,
        authorization_decision_id, product_command_id, run_id, observed_policy_grant_revision,
        schema_version, created_at, updated_at, accepted_at, terminal_at
      )
      SELECT
        $1, $2, 'b4bi-automation', 'b4bi-automation-r4', 3,
        (stamp.now AT TIME ZONE 'America/New_York')::date,
        (((stamp.now AT TIME ZONE 'America/New_York')::date)::timestamp + $6::time) AT TIME ZONE 'America/New_York',
        'accepted', $3, $4, $5, 1,
        'workbench-automation-occurrence-v1', stamp.now, stamp.now, stamp.now, stamp.now
      FROM (SELECT clock_timestamp() AS now) stamp
    `, [W, occurrenceId, decisionId, commandId, runId, NEW_YORK_TIME]);
  });

  const aggregate = await pool.query(`
    SELECT occurrence.status AS occurrence_status,
      decision.actor_principal_kind,
      decision.effective_principal_kind,
      decision.authorization_source,
      command.kind AS command_kind,
      command.status AS command_status,
      run.status AS run_status,
      run.idempotency_key,
      job.state AS job_state,
      event.type AS initial_event
    FROM public.automation_occurrences occurrence
    JOIN public.authorization_decisions decision
      ON decision.workspace_id = occurrence.workspace_id
     AND decision.authorization_decision_id = occurrence.authorization_decision_id
    JOIN public.product_commands command
      ON command.workspace_id = occurrence.workspace_id
     AND command.command_id = occurrence.product_command_id
    JOIN public.workflow_runs run
      ON run.workspace_id = occurrence.workspace_id AND run.run_id = occurrence.run_id
    JOIN public.workflow_run_jobs job
      ON job.workspace_id = run.workspace_id AND job.run_id = run.run_id
    JOIN public.workflow_run_events event
      ON event.workspace_id = run.workspace_id AND event.run_id = run.run_id AND event.sequence = 1
    WHERE occurrence.workspace_id = $1 AND occurrence.occurrence_id = 'b4bi-accepted-occurrence'
  `, [W]);
  assert.deepEqual(aggregate.rows, [{
    occurrence_status: "accepted",
    actor_principal_kind: "scheduler",
    effective_principal_kind: "automation",
    authorization_source: "policy_grant",
    command_kind: "workflow_run",
    command_status: "accepted",
    run_status: "queued",
    idempotency_key: "b4bi-accepted-occurrence",
    job_state: "queued",
    initial_event: "run.queued",
  }]);
  const lifecycle = new PostgresAutomationLifecycle({ store });
  const occurrenceProjection = await lifecycle.listOccurrences({
    automationId: "b4bi-automation",
    query: { limit: 10 },
    context: { workspaceId: W, userId: OWNER, role: "owner" },
  });
  const acceptedOccurrence = occurrenceProjection.find((item) => item.occurrenceId === "b4bi-accepted-occurrence");
  assert.equal(acceptedOccurrence?.runId, runId);
  assert.equal(acceptedOccurrence?.runStatus, "queued");
  await pool.query(`
    UPDATE public.workflow_run_jobs
    SET available_at = $1, updated_at = $2
    WHERE workspace_id = $3 AND run_id = 'b4bi-scheduler-workflow-run'
  `, [LATER, NOW, W]);
}

async function assertSkipMisfireCannotBecomeRun(pool) {
  await appendAutomationRevision(pool, {
    revisionId: "b4bi-automation-r5-skip",
    revisionNumber: 5,
    baseRevisionId: "b4bi-automation-r4",
    triggerRevision: 3,
    cronExpression: NEW_YORK_CRON,
    timezoneName: "America/New_York",
    misfirePolicy: "skip",
    maxMisfireLatenessSeconds: 0,
  });
  await pool.query(`
    INSERT INTO public.automation_occurrences (
      workspace_id, occurrence_id, automation_id, automation_revision_id, trigger_revision,
      local_schedule_date, scheduled_for, status, schema_version, created_at, updated_at
    ) SELECT
      $1, 'b4bi-overlate-skip-occurrence', 'b4bi-automation', 'b4bi-automation-r5-skip', 3,
      (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 4,
      (((clock_timestamp() AT TIME ZONE 'America/New_York')::date - 4)::timestamp + $3::time) AT TIME ZONE 'America/New_York',
      'due', 'workbench-automation-occurrence-v1', $2, $2
  `, [W, PAST, NEW_YORK_TIME]);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.automation_occurrences
    SET status = 'accepted', accepted_at = clock_timestamp(),
        terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE workspace_id = $1 AND occurrence_id = 'b4bi-overlate-skip-occurrence'
  `, [W]), "23514", /automation_occurrence_misfire_must_skip/);
}

async function assertRuntimeSchedulerGoldenPath({ pool, store }) {
  const cleanupScheduler = new PostgresAutomationScheduler({
    persistence: store.createAutomationSchedulerPersistence(),
    workflowRunner: {
      async startRunWithCompanion() {
        throw new Error("unexpected_cleanup_dispatch");
      },
    },
    workspaceId: W,
  });
  await cleanupScheduler.pollDue({ limit: 10 });

  const fixture = await seedRuntimeAutomation(pool);
  const execution = runtimeExecutionFabric({ store, pool });
  const runnerA = runtimeRunner(store, "runtime-a", execution);
  const runnerB = runtimeRunner(store, "runtime-b", execution);
  let signalFirstDispatch;
  const firstDispatchStarted = new Promise((resolve) => { signalFirstDispatch = resolve; });
  let releaseFirstDispatch;
  const firstDispatchBlocked = new Promise((resolve) => { releaseFirstDispatch = resolve; });
  const schedulerA = new PostgresAutomationScheduler({
    persistence: store.createAutomationSchedulerPersistence(),
    workflowRunner: {
      async startRunWithCompanion(...args) {
        signalFirstDispatch();
        await firstDispatchBlocked;
        return runnerA.startRunWithCompanion(...args);
      },
    },
    workspaceId: W,
  });
  const schedulerB = new PostgresAutomationScheduler({
    persistence: store.createAutomationSchedulerPersistence(),
    workflowRunner: runnerB,
    workspaceId: W,
  });

  const firstPoll = schedulerA.pollDue({ limit: 10 });
  let dispatchTimeout;
  try {
    await Promise.race([
      firstDispatchStarted,
      new Promise((_, reject) => {
        dispatchTimeout = setTimeout(
          () => reject(new Error("first_automation_dispatch_not_reached")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(dispatchTimeout);
  }
  try {
    await schedulerB.pollDue({ limit: 10 });
  } finally {
    releaseFirstDispatch();
  }
  await firstPoll;
  const waitingReview = await waitFor(async () => (await pool.query(`
    SELECT occurrence.occurrence_id, occurrence.status AS occurrence_status,
           command.actor_principal_id, command.actor_principal_kind,
           command.effective_principal_id, command.effective_principal_kind,
           command.status AS command_status, run.run_id, run.status AS run_status
      FROM public.automation_occurrences occurrence
      JOIN public.product_commands command
        ON command.workspace_id = occurrence.workspace_id
       AND command.command_id = occurrence.product_command_id
      JOIN public.workflow_runs run
        ON run.workspace_id = occurrence.workspace_id
       AND run.run_id = occurrence.run_id
     WHERE occurrence.workspace_id = $1 AND occurrence.automation_id = $2
  `, [W, fixture.automationId])).rows[0]?.run_status === "waiting_review");
  assert.equal(waitingReview, true, "the Scheduler-started Run must pause durably at its ReviewGate");

  const waiting = (await pool.query(`
    SELECT occurrence.occurrence_id, occurrence.status AS occurrence_status,
           command.actor_principal_id, command.actor_principal_kind,
           command.effective_principal_id, command.effective_principal_kind,
           command.status AS command_status, run.run_id, run.status AS run_status,
           run.idempotency_key
      FROM public.automation_occurrences occurrence
      JOIN public.product_commands command
        ON command.workspace_id = occurrence.workspace_id
       AND command.command_id = occurrence.product_command_id
      JOIN public.workflow_runs run
        ON run.workspace_id = occurrence.workspace_id
       AND run.run_id = occurrence.run_id
     WHERE occurrence.workspace_id = $1 AND occurrence.automation_id = $2
  `, [W, fixture.automationId])).rows;
  assert.equal(waiting.length, 1, "concurrent Scheduler polls must converge on one occurrence and Run");
  assert.equal(waiting[0].occurrence_status, "accepted");
  assert.equal(waiting[0].actor_principal_id, SCHEDULER);
  assert.equal(waiting[0].actor_principal_kind, "scheduler");
  assert.equal(waiting[0].effective_principal_id, AUTOMATION);
  assert.equal(waiting[0].effective_principal_kind, "automation");
  assert.equal(waiting[0].command_status, "running");
  assert.equal(waiting[0].run_status, "waiting_review");
  assert.equal(waiting[0].idempotency_key, waiting[0].occurrence_id);

  const inbox = new PostgresInboxReadModel({ store });
  const inboxItem = (await inbox.list({
    workspaceId: W,
    userId: OWNER,
    query: { limit: 10 },
  })).data.items.find((item) => item.objectId === waiting[0].run_id && item.objectKind === "review");
  assert.ok(inboxItem, "the owner must receive a Product Inbox review item");
  assert.equal(inboxItem.reason, "review_required");
  assert.equal(inboxItem.actionRoute, `/loops/${fixture.workflowId}/runs/${waiting[0].run_id}`);

  let reviewAuthorityId = 0;
  const reviewAuthority = new PostgresAgentCommandAuthorizer({
    store,
    idFactory: (kind) => `runtime-review-${kind}-${++reviewAuthorityId}`,
  });
  const authority = await reviewAuthority.authorizeWorkflowRunReview({
    workspaceId: W,
    userId: OWNER,
    runId: waiting[0].run_id,
    nodeId: "runtime-review",
    decision: "approve",
    requestedChanges: [],
  });
  const approved = await runnerA.submitReviewDecision({
    runId: waiting[0].run_id,
    nodeId: "runtime-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "runtime-automation-review-approval",
    decidedBy: OWNER,
    authorizationDecisionId: authority.authorizationDecisionId,
  });
  assert.equal(approved.decision.applicationStatus, "applied");
  const replayed = await runnerA.submitReviewDecision({
    runId: waiting[0].run_id,
    nodeId: "runtime-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "runtime-automation-review-approval",
    decidedBy: OWNER,
    authorizationDecisionId: authority.authorizationDecisionId,
  });
  assert.deepEqual(replayed, approved, "a retried Owner approval must replay its prior decision");

  const completed = await waitFor(async () => (await pool.query(`
    SELECT status FROM public.workflow_runs
     WHERE workspace_id = $1 AND run_id = $2
  `, [W, waiting[0].run_id])).rows[0]?.status === "completed");
  assert.equal(completed, true, "an explicit Owner approval must resume the same Automation Run");

  const aggregate = (await pool.query(`
    SELECT occurrence.occurrence_id, occurrence.status AS occurrence_status,
           command.actor_principal_id, command.actor_principal_kind,
           command.effective_principal_id, command.effective_principal_kind,
           command.status AS command_status, run.run_id, run.status AS run_status,
           run.idempotency_key, output.final_answer
      FROM public.automation_occurrences occurrence
      JOIN public.product_commands command
        ON command.workspace_id = occurrence.workspace_id
       AND command.command_id = occurrence.product_command_id
      JOIN public.workflow_runs run
        ON run.workspace_id = occurrence.workspace_id
       AND run.run_id = occurrence.run_id
      JOIN public.workflow_run_final_outputs output
        ON output.workspace_id = run.workspace_id AND output.run_id = run.run_id
     WHERE occurrence.workspace_id = $1 AND occurrence.automation_id = $2
  `, [W, fixture.automationId])).rows;
  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].run_id, waiting[0].run_id);
  assert.equal(aggregate[0].occurrence_status, "accepted");
  assert.equal(aggregate[0].actor_principal_id, SCHEDULER);
  assert.equal(aggregate[0].actor_principal_kind, "scheduler");
  assert.equal(aggregate[0].effective_principal_id, AUTOMATION);
  assert.equal(aggregate[0].effective_principal_kind, "automation");
  assert.equal(aggregate[0].command_status, "completed");
  assert.equal(aggregate[0].run_status, "completed");
  assert.equal(aggregate[0].idempotency_key, aggregate[0].occurrence_id);
  assert.equal(aggregate[0].final_answer.format, "markdown");
  assert.equal(aggregate[0].final_answer.content, fixture.finalText);
  const dismissedInbox = await pool.query(`
    SELECT status FROM public.inbox_items
     WHERE workspace_id = $1 AND inbox_item_id = $2
  `, [W, inboxItem.itemId]);
  assert.equal(dismissedInbox.rows[0]?.status, "dismissed");

  const invocations = (await pool.query(`
    SELECT invocation.status, attempt.status AS attempt_status
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts attempt
        ON attempt.invocation_id = invocation.invocation_id
     WHERE invocation.workspace_id = $1
       AND invocation.controller_kind = 'workflow_run'
       AND invocation.controller_id = $2
     ORDER BY invocation.invocation_id ASC
  `, [W, aggregate[0].run_id])).rows;
  assert.deepEqual(invocations, [
    { status: "completed", attempt_status: "completed" },
    { status: "completed", attempt_status: "completed" },
  ]);

  const restartedRunner = runtimeRunner(store, "runtime-restart", execution);
  const restartedScheduler = new PostgresAutomationScheduler({
    persistence: store.createAutomationSchedulerPersistence(),
    workflowRunner: restartedRunner,
    workspaceId: W,
  });
  await restartedScheduler.pollDue({ limit: 10 });
  const counts = (await pool.query(`
    SELECT count(DISTINCT occurrence.occurrence_id)::integer AS occurrences,
           count(DISTINCT occurrence.product_command_id)::integer AS commands,
           count(DISTINCT occurrence.run_id)::integer AS runs
      FROM public.automation_occurrences occurrence
     WHERE occurrence.workspace_id = $1 AND occurrence.automation_id = $2
  `, [W, fixture.automationId])).rows[0];
  assert.deepEqual(counts, { occurrences: 1, commands: 1, runs: 1 });
}

async function seedRuntimeAutomation(pool) {
  const automationId = "b4bi-runtime-automation";
  const automationRevisionId = "b4bi-runtime-automation-r1";
  const workflowId = "b4bi-runtime-workflow";
  const workflowRevisionId = "b4bi-runtime-workflow-r1";
  const compileResultId = "b4bi-runtime-compile-r1";
  const planId = "b4bi-runtime-plan-r1";
  const loopVersionId = "b4bi-runtime-loop-v1";
  const skillId = "b4bi-runtime-skill";
  const skillVersionId = "b4bi-runtime-skill-v1";
  const skillObjectId = "b4bi-runtime-skill-object";
  const workflowHash = hash("6");
  const planHash = hash("7");
  const loopHash = hash("8");
  const skillObjectHash = hash("0");
  const skillPackageHash = hash("1");
  const skillVersionHash = hash("2");
  const skillManifestHash = hash("3");
  const skillProbeHash = hash("4");
  const executionRefHash = hash("5");
  const finalText = "Daily Automation completed through Admission and Execution Broker.";
  const databaseNow = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const scheduledFor = new Date(Math.floor(Date.parse(databaseNow) / 60_000) * 60_000);
  const cronExpression = `${scheduledFor.getUTCMinutes()} ${scheduledFor.getUTCHours()} * * *`;
  const generatedAt = scheduledFor.toISOString();
  const textSchema = { type: "string" };
  const executionRef = {
    executionMode: "script",
    capabilityId: "b4bi-runtime-skill",
    taskIntent: "daily_automation_test",
    adapterVersion: "1",
  };
  const skillDefinition = {
    name: "Runtime daily Skill",
    description: "Exercise the admitted Product execution path for a daily Automation.",
    category: "automation",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { result: textSchema },
      required: ["result"],
      additionalProperties: false,
    },
    risk: {},
    dependencies: [],
    connectionRequirements: [],
    files: [],
    executionRef,
  };
  const graph = {
    nodes: [{
      nodeId: "runtime-skill",
      kind: "Skill",
      title: "Daily admitted Skill",
      description: "Execute through Admission and the Product Broker.",
      position: { x: 0, y: 0 },
      inputPorts: [],
      outputPorts: [{ portId: "result", name: "Result", schema: textSchema, required: true }],
      inputBindings: [],
      skillRef: { skillId, version: "1.0.0" },
      configuration: { format: "markdown" },
      reviewPolicy: { mode: "none" },
      retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
      timeoutSeconds: 30,
      display: { collapsed: false },
    }, {
      nodeId: "runtime-review",
      kind: "ReviewGate",
      title: "Owner approval",
      description: "Require the Automation owner to explicitly continue this Run.",
      position: { x: 240, y: 0 },
      inputPorts: [{ portId: "candidate", name: "Candidate", schema: textSchema, required: true }],
      outputPorts: [{ portId: "approved", name: "Approved", schema: textSchema, required: true }],
      inputBindings: [{
        targetPort: "candidate",
        source: { kind: "nodeOutput", nodeId: "runtime-skill", portId: "result" },
      }],
      configuration: { instructions: "Approve the daily Automation result.", allowRevision: false },
      reviewPolicy: { mode: "required", instructions: "Approve the daily Automation result." },
      retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
      timeoutSeconds: 30,
      display: { collapsed: false },
    }, {
      nodeId: "runtime-output",
      kind: "Output",
      title: "Daily result",
      description: "Publish the Owner-approved result.",
      position: { x: 480, y: 0 },
      inputPorts: [{ portId: "content", name: "Content", schema: textSchema, required: true }],
      outputPorts: [{ portId: "final", name: "Final", schema: textSchema, required: true }],
      inputBindings: [{
        targetPort: "content",
        source: { kind: "nodeOutput", nodeId: "runtime-review", portId: "approved" },
      }],
      configuration: { format: "markdown" },
      reviewPolicy: { mode: "none" },
      retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
      timeoutSeconds: 30,
      display: { collapsed: false },
    }],
    edges: [{
      edgeId: "runtime-skill-review",
      sourceNodeId: "runtime-skill",
      sourcePort: "result",
      targetNodeId: "runtime-review",
      targetPort: "candidate",
    }, {
      edgeId: "runtime-review-output",
      sourceNodeId: "runtime-review",
      sourcePort: "approved",
      targetNodeId: "runtime-output",
      targetPort: "content",
    }],
  };
  const plan = {
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    planId,
    workflowId,
    workflowRevisionId,
    generatedAt,
    contentHash: planHash,
    maxParallelism: 1,
    modelRoutingState: "not_applicable",
    pinnedSkills: [{ skillId, version: "1.0.0" }],
    steps: [{
      nodeId: "runtime-skill",
      kind: "Skill",
      dependsOn: [],
      inputBindings: [],
      executionMode: "deterministic_skill",
      isolation: "process",
      modelRoutingState: "not_applicable",
      capabilities: {
        toolAllowlist: [],
        connectionIds: [],
        network: false,
        filesystem: "none",
        externalActions: false,
      },
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
      resultSchema: skillDefinition.outputSchema,
      evidenceRequirements: [],
    }, {
      nodeId: "runtime-review",
      kind: "ReviewGate",
      dependsOn: ["runtime-skill"],
      inputBindings: [{
        targetPort: "candidate",
        source: { kind: "nodeOutput", nodeId: "runtime-skill", portId: "result" },
      }],
    }, {
      nodeId: "runtime-output",
      kind: "Output",
      dependsOn: ["runtime-review"],
      inputBindings: [{
        targetPort: "content",
        source: { kind: "nodeOutput", nodeId: "runtime-review", portId: "approved" },
      }],
    }],
    reviewGates: [{
      nodeId: "runtime-review",
      dependsOn: ["runtime-skill"],
      instructions: "Approve the daily Automation result.",
    }],
    primaryOutput: { nodeId: "runtime-output", portId: "final" },
  };

  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.product_users (
        user_id, schema_version, display_name, account_role, created_at, updated_at
      ) VALUES (
        'system-catalog', 'workbench-v1', 'System Catalog', 'member', $1, $1
      ) ON CONFLICT (user_id) DO NOTHING
    `, [PAST]);
    await client.query(`
      INSERT INTO public.skill_system_catalog_principals (
        principal_id, product_user_id, schema_version, status, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'workbench-v1', 'enabled', $1, $1
      ) ON CONFLICT (principal_id) DO NOTHING
    `, [PAST]);
    await client.query(`
      INSERT INTO public.product_objects (
        workspace_id, object_id, schema_version, object_kind, content_hash,
        size_bytes, media_type, storage_backend, storage_key, storage_version,
        state, created_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'skill_package', $3,
        12, 'application/zip', 'test', $4, 'v1', 'promoted', $5
      )
    `, [W, skillObjectId, skillObjectHash, `skills/${skillObjectId}`, PAST]);
    await client.query(`
      INSERT INTO public.skill_assets (
        workspace_id, skill_id, scope_id, owner_system_principal_id, schema_version,
        name_normalized, visibility, lifecycle, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'system-catalog', 'workbench-v1',
        'runtime-daily-skill', 'workspace', 'published', $4, $4
      )
    `, [W, skillId, SCOPE, PAST]);
    await client.query(`
      INSERT INTO public.skill_system_catalog_sources (
        workspace_id, catalog_source_id, skill_id, system_principal_id, schema_version,
        source_locator, source_revision, source_manifest_hash,
        package_object_id, package_object_hash, package_hash,
        published_version_content_hash, runtime_probe_id, runtime_probe_status,
        runtime_probe_code, runtime_probe_digest, execution_ref, execution_ref_hash,
        probed_at, created_at, definition
      ) VALUES (
        $1, 'b4bi-runtime-skill-source', $2, 'system-catalog', 'workbench-internal-v1',
        'bundled://b4bi/runtime-skill', '1.0.0', $3,
        $4, $5, $6, $7, 'b4bi-runtime-skill-probe', 'ready',
        'runtime_ready', $8, $9::jsonb, $10, $11, $11, $12::jsonb
      )
    `, [
      W, skillId, skillManifestHash, skillObjectId, skillObjectHash,
      skillPackageHash, skillVersionHash, skillProbeHash,
      JSON.stringify(executionRef), executionRefHash, PAST,
      JSON.stringify(skillDefinition),
    ]);
    await client.query(`
      INSERT INTO public.skill_versions (
        workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
        system_catalog_source_id, package_object_id, package_object_hash, package_hash,
        content_hash, published_by_system_principal_id, published_at, definition
      ) VALUES (
        $1, $2, $3, '1.0.0', 'workbench-v1', 'system_catalog',
        'b4bi-runtime-skill-source', $4, $5, $6, $7,
        'system-catalog', $8, $9::jsonb
      )
    `, [
      W, skillVersionId, skillId, skillObjectId, skillObjectHash,
      skillPackageHash, skillVersionHash, PAST, JSON.stringify(skillDefinition),
    ]);
    await client.query(`
      UPDATE public.skill_assets
         SET latest_published_version_id = $3, updated_at = $4
       WHERE workspace_id = $1 AND skill_id = $2
    `, [W, skillId, skillVersionId, NOW]);
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'Runtime daily Automation', '',
        'ready', 'ready', 'private', $5, 1, $6, $6
      )
    `, [W, workflowId, SCOPE, OWNER, workflowRevisionId, PAST]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, schema_version,
        graph, input_form, output_definition, resource_refs, run_settings, definition,
        content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 1, 'workbench-v1', $4::jsonb, '{}'::jsonb, '{}'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6, 'Runtime Scheduler proof', $7, $7
      )
    `, [W, workflowRevisionId, workflowId, JSON.stringify(graph), workflowHash, OWNER, PAST]);
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, status, execution_plan_id, ordered_steps, review_gates, output_nodes,
        compiled_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', 'ready', $5,
        '["runtime-skill","runtime-review","runtime-output"]'::jsonb,
        '["runtime-review"]'::jsonb, '["runtime-output"]'::jsonb, $6
      )
    `, [W, compileResultId, workflowId, workflowRevisionId, planId, generatedAt]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, plan_version, content_hash, model_routing_state,
        plan_document, pins_finalized, generated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'workbench-execution-plan-v2', 2, $6,
        'not_applicable', $7::jsonb, false, $8
      )
    `, [
      W, planId, compileResultId, workflowId, workflowRevisionId,
      planHash, JSON.stringify(plan), generatedAt,
    ]);
    await client.query(`
      UPDATE public.execution_plans SET pins_finalized = true
       WHERE workspace_id = $1 AND plan_id = $2
    `, [W, planId]);
    await client.query(`
      INSERT INTO public.loop_versions (
        workspace_id, loop_version_id, workflow_id, workflow_revision_id,
        schema_version, version, workflow_revision_content_hash,
        compile_result_id, execution_plan_id, definition, content_hash,
        released_by, released_at
      ) VALUES (
        $1, $2, $3, $4, 'workbench-v1', '1.0.0', $5,
        $6, $7, '{"name":"Runtime daily Automation"}'::jsonb, $8, $9, $10
      )
    `, [
      W, loopVersionId, workflowId, workflowRevisionId, workflowHash,
      compileResultId, planId, loopHash, OWNER, generatedAt,
    ]);
    await client.query(`
      INSERT INTO public.loop_version_skill_pins (
        workspace_id, loop_version_id, workflow_id, skill_id,
        skill_version_id, version, content_hash, schema_version
      ) VALUES (
        $1, $2, $3, $4, $5, '1.0.0', $6, 'workbench-internal-v1'
      )
    `, [W, loopVersionId, workflowId, skillId, skillVersionId, skillVersionHash]);
    await client.query(`
      UPDATE public.loop_versions SET pins_finalized = true
       WHERE workspace_id = $1 AND loop_version_id = $2
    `, [W, loopVersionId]);
    await client.query(`
      INSERT INTO public.automations (
        workspace_id, automation_id, scope_id, owner_user_id, owner_principal_id,
        automation_principal_id, schema_version, display_name, status,
        current_revision_id, current_revision_number, next_scheduled_at,
        created_by_principal_id, created_by_principal_kind, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $4, $5, 'workbench-automation-v1',
        'Runtime daily Automation', 'active', $6, 1, $7, $4, 'user', $8, $8
      )
    `, [W, automationId, SCOPE, OWNER, AUTOMATION, automationRevisionId, generatedAt, PAST]);
    await client.query(`
      INSERT INTO public.automation_revisions (
        workspace_id, automation_revision_id, automation_id, scope_id,
        automation_principal_id, owner_user_id, owner_scope_grant_id,
        revision_number, schema_version,
        workflow_id, workflow_revision_id, workflow_revision_content_hash,
        loop_version_id, loop_version_content_hash, compile_result_id,
        execution_plan_id, execution_plan_content_hash,
        scope_policy_revision_id, policy_grant_id, observed_policy_grant_revision,
        model_policy_revision_id, model_policy_revision_number, model_profile_revision_ids,
        trigger_kind, cron_expression, timezone_name, trigger_revision,
        execution_location_policy, budget_currency, max_cost_microunits,
        max_duration_seconds, approval_policy, allowed_effect_classes,
        misfire_policy, misfire_max_lateness_seconds, dedupe_policy, content_hash,
        created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        1, 'workbench-automation-revision-v1',
        $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, 1, 'b4bi-model-policy-r1', 1, ARRAY[]::public.product_identifier[],
        'daily_cron', $18, 'Etc/UTC', 1,
        'cloud', 'USD', 1000, 300, 'policy_grant_only', ARRAY['execute']::text[],
        'run_once', 86400, 'local_schedule_date', $19,
        $6, 'user', $20
      )
    `, [
      W, automationRevisionId, automationId, SCOPE, AUTOMATION, OWNER, OWNER_GRANT,
      workflowId, workflowRevisionId, workflowHash, loopVersionId, loopHash,
      compileResultId, planId, planHash, POLICY, POLICY_GRANT,
      cronExpression, hash("9"), PAST,
    ]);
    await client.query(`
      UPDATE public.automation_revisions SET pins_finalized = true
       WHERE workspace_id = $1 AND automation_revision_id = $2
    `, [W, automationRevisionId]);
  });
  return { automationId, workflowId, finalText };
}

function runtimeRunner(store, prefix, execution) {
  const idFactory = sequentialIdFactory(prefix);
  return createWorkflowRunner({
    store,
    commandIntake: new PostgresWorkflowRunCommandIntake({ store }),
    reviewCommandIntake: new PostgresWorkflowRunReviewCommandIntake({ store }),
    resolveExecution: createPostgresWorkflowExecutionResolver({ store }),
    executionBroker: execution.dispatcher,
    admissionController: execution.admission,
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
    runControl: createPostgresRunControl({ store, workspaceId: W, idFactory }),
    runPersistence: createPostgresWorkflowRunPersistence({ store, workspaceId: W }),
    workerId: `${prefix}-worker`,
    clock: () => new Date().toISOString(),
    idFactory,
  });
}

function runtimeExecutionFabric({ store, pool }) {
  const admission = new AdmissionController({
    persistence: new PostgresCapacityPersistence({ store }),
    clock: () => new Date().toISOString(),
    idFactory: sequentialIdFactory("runtime-admission"),
    resolveProductCommand: (identity) => runtimeProductCommand(pool, identity),
  });
  const broker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admission,
    clock: () => new Date().toISOString(),
    idFactory: sequentialIdFactory("runtime-execution"),
  });
  broker.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: { result: "Daily Automation completed through Admission and Execution Broker." },
          usage: {
            steps: 1,
            modelRequests: 0,
            inputBytes: 0,
            outputBytes: 71,
          },
        };
      },
    },
  });
  return {
    admission,
    dispatcher: new AdmittedExecutionDispatcher({
      broker,
      admissionController: admission,
    }),
  };
}

async function runtimeProductCommand(pool, { commandId, workspaceId, userId }) {
  const row = (await pool.query(`
    SELECT command_id, workspace_id, quota_user_id, kind,
           session_id, turn_id, target_id, status
      FROM public.product_commands
     WHERE command_id = $1 AND workspace_id = $2 AND quota_user_id = $3
  `, [commandId, workspaceId, userId])).rows[0];
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
}

function sequentialIdFactory(prefix) {
  let sequence = 0;
  return (kind) => `${prefix}-${kind}-${++sequence}`;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function assertInboxIdentityAndLifecycle(pool) {
  await insertInboxItem(pool, {
    inboxItemId: "b4bi-misfire-inbox",
    sourceDomain: "automation_occurrence",
    sourceId: "b4bi-misfire-occurrence",
    sourceRevision: 3,
    sourceCursor: "b4bi-misfire-occurrence",
    targetKind: "automation_occurrence",
    targetId: "b4bi-misfire-occurrence",
  });
  await expectSqlState(pool, () => insertInboxItem(pool, {
    inboxItemId: "b4bi-forged-domain-inbox",
    sourceDomain: "workflow_run",
    sourceId: "b4bi-misfire-occurrence",
    sourceRevision: 1,
    sourceCursor: "b4bi-misfire-occurrence:1",
    targetKind: "workflow_run",
    targetId: "b4bi-misfire-occurrence",
  }), "23514", /inbox_source_or_recipient_mismatch/);

  const otherDecisionId = await seedCrossWorkspaceApprovalSource(pool);
  await expectSqlState(pool, () => insertInboxItem(pool, {
    inboxItemId: "b4bi-cross-workspace-inbox",
    sourceDomain: "authorization_decision",
    sourceId: otherDecisionId,
    sourceRevision: 1,
    sourceCursor: otherDecisionId,
    targetKind: "authorization_decision",
    targetId: otherDecisionId,
  }), "23514", /inbox_source_or_recipient_mismatch/);

  await pool.query(`
    UPDATE public.inbox_items
    SET status = 'read', read_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND inbox_item_id = 'b4bi-misfire-inbox'
  `, [NOW, W]);
  await pool.query(`
    UPDATE public.inbox_items
    SET status = 'dismissed', dismissed_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND inbox_item_id = 'b4bi-misfire-inbox'
  `, [LATER, W]);
  const lifecycle = await pool.query(`
    SELECT status, read_at IS NOT NULL AS was_read, dismissed_at IS NOT NULL AS was_dismissed
    FROM public.inbox_items
    WHERE workspace_id = $1 AND inbox_item_id = 'b4bi-misfire-inbox'
  `, [W]);
  assert.deepEqual(lifecycle.rows, [{ status: "dismissed", was_read: true, was_dismissed: true }]);
  await expectSqlState(pool, () => pool.query(`
    DELETE FROM public.inbox_items
    WHERE workspace_id = $1 AND inbox_item_id = 'b4bi-misfire-inbox'
  `, [W]), "55000", /inbox_item_terminal/);
}

async function insertInboxItem(pool, {
  inboxItemId,
  sourceDomain,
  sourceId,
  sourceRevision,
  sourceCursor,
  targetKind,
  targetId,
}) {
  await pool.query(`
    INSERT INTO public.inbox_items (
      workspace_id, inbox_item_id, recipient_user_id,
      source_domain, source_id, source_revision, source_cursor,
      reason_code, severity, title, summary, target_kind, target_id,
      status, schema_version, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      'automation_attention', 'warning', 'Automation needs attention',
      'A governed source requires review.', $8, $9,
      'unread', 'workbench-inbox-item-v1', $10, $10
    )
  `, [
    W, inboxItemId, OWNER, sourceDomain, sourceId, sourceRevision,
    sourceCursor, targetKind, targetId, PAST,
  ]);
}

async function seedCrossWorkspaceApprovalSource(pool) {
  const otherWorkspace = "b4bi-other-workspace";
  const otherScope = "b4bi-other-scope";
  const otherPolicy = "b4bi-other-policy-r1";
  const otherGrant = "b4bi-other-owner-grant";
  const decisionId = "b4bi-other-approval-request";
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'Other workspace', $2, $3, $3)
  `, [otherWorkspace, OWNER, PAST]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES ('b4bi-other-owner-membership', $1, $2, 'workbench-v1', 'owner', $3, $3)
  `, [otherWorkspace, OWNER, PAST]);
  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id, membership_id, created_at, updated_at
    ) VALUES ($1, $2, 'user', $2, 'b4bi-other-owner-membership', $3, $3)
  `, [otherWorkspace, OWNER, PAST]);
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id,
        owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind, creation_mode, created_at, updated_at
      ) VALUES ($1, $2, 'workbench-v1', 'personal', $3, $3, $4, $3, 'user',
        'workspace_initial_seed', $5, $5)
    `, [otherWorkspace, otherScope, OWNER, otherPolicy, PAST]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        policy_content_hash, created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES ($1, $2, $3, 1, 'private', 'auto', ARRAY['execute']::text[], ARRAY[]::text[],
        $4, $5, 'user', $6)
    `, [otherWorkspace, otherScope, otherPolicy, hash("7"), OWNER, PAST]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
        capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'user', 'operation', ARRAY[]::text[], true,
        $4, 'user', 'scope_creation', $5, $5)
    `, [otherWorkspace, otherScope, otherGrant, OWNER, PAST]);
  });
  await pool.query(`
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest,
      permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
      destructive_rule_version, disposition, approval_id, reason_code, decided_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
      'principal', $5, 'user', $6, 'workflow_run', 'execute', $7,
      'auto', ARRAY['execute']::text[], ARRAY[]::text[],
      'authority-v1', 'approval_required', $2, 'approval_required', $8, $9
    )
  `, [
    otherWorkspace, decisionId, otherScope, otherPolicy, OWNER, otherGrant,
    DIGEST, PAST, FUTURE,
  ]);
  return decisionId;
}

async function insertPrincipalApprovalPair(client, {
  decisionId,
  actionId,
  effectClass,
  targetContract,
}) {
  const requestId = `${decisionId}-request`;
  await insertPrincipalDecision(client, {
    decisionId: requestId,
    actionId,
    effectClass,
    targetContract,
    disposition: "approval_required",
    approvalId: requestId,
  });
  await insertPrincipalDecision(client, {
    decisionId,
    actionId,
    effectClass,
    targetContract,
    disposition: "authorized",
    approvalId: requestId,
  });
}

async function insertPrincipalDecision(client, {
  decisionId,
  actionId,
  effectClass,
  targetContract = null,
  disposition,
  approvalId,
}) {
  await client.query(`
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest, target_contract,
      permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
      destructive_rule_version, disposition, approval_id, reason_code, decided_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'user', $6, $5, 'user', $6,
      'principal', $5, 'user', $6, $7, $8, $9, $10::jsonb,
      'interactive', ARRAY[]::text[], ARRAY[]::text[],
      'authority-v1', $11, $12, 'approved', $13, $14
    )
  `, [
    W, decisionId, SCOPE, POLICY_ISSUANCE, OWNER, OWNER_GRANT, actionId, effectClass,
    DIGEST, targetContract === null ? null : JSON.stringify(targetContract),
    disposition, approvalId, PAST, FUTURE,
  ]);
}

async function insertCommand(client, {
  commandId,
  decisionId,
  actorId = OWNER,
  actorKind = "user",
  effectiveId = OWNER,
  effectiveKind = "user",
  kind,
  effectClass,
  targetKind,
  targetId,
  targetContract = null,
  policyRevision = POLICY_ISSUANCE,
  status,
  createdAt = NOW,
}) {
  await client.query(`
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind, authorization_decision_id,
      policy_revision_id, effect_class, argument_digest, target_contract, quota_user_id,
      schema_version, kind, target_kind, target_id, target_revision,
      status, created_at, updated_at, finished_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12::jsonb, $13,
      'workbench-v1', $14, $15, $16, 1,
      $17, $18::timestamptz, $18::timestamptz,
      CASE WHEN $17 = 'completed' THEN $18::timestamptz ELSE NULL::timestamptz END
    )
  `, [
    commandId, W, SCOPE, actorId, actorKind, effectiveId, effectiveKind, decisionId,
    policyRevision, effectClass, DIGEST, targetContract === null ? null : JSON.stringify(targetContract),
    OWNER, kind, targetKind, targetId, status, createdAt,
  ]);
}

async function expectClientSqlState(client, operation, code, messagePattern = null) {
  await client.query("SAVEPOINT expected_failure");
  try {
    await operation();
    assert.fail(`expected SQLSTATE ${code}`);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    if (messagePattern !== null) assert.match(error.message, messagePattern);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    await client.query("RELEASE SAVEPOINT expected_failure");
  }
}

async function expectSqlState(pool, operation, code, messagePattern = null) {
  try {
    await operation();
    assert.fail(`expected SQLSTATE ${code}`);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    if (messagePattern !== null) assert.match(error.message, messagePattern);
  }
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function isoWithMicroseconds(value) {
  return value.replace(/\.(\d{3})Z$/, ".$1000Z");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required when integration tests are enabled`);
  return value;
}
