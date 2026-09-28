import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const PAST = new Date(Date.now() - 2 * 60_000).toISOString();
const NOW = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();
const FAR_FUTURE = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const hash = (character) => `sha256:${character.repeat(64)}`;

const B4B_A_TABLES = [
  "secret_bindings",
  "model_profiles",
  "model_profile_revisions",
  "workspace_model_policy_revisions",
  "workspace_connection_revisions",
];

test("PostgreSQL B4B Batch A enforces exact Model, Secret, policy, and Connection authority", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  assert.match(databaseName, /_test$/, "integration database must end in _test");

  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool });
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  await store.runMigrations();
  await assertInventory(pool);
  await seedAuthority(pool);
  await seedGovernedModels(pool);
  await seedGovernedExecutionPlan(pool, {
    compileId: "b4b-run-compile-r1",
    planId: "b4b-run-plan-r1",
    modelRevisionId: "b4b-run-model-r1",
  });
  await assertModelConsumptionAndPolicy(pool);
  await assertHistoricalConsumersAndRunAdmission(pool);
  await assertSecretLifecycleAndModelOwnership(pool);
  await assertConnectionRevisionAuthority(pool);
  await assertImmutableHistory(pool);
  await assertArchivedScopeConsumptionGates(pool);
});

async function assertInventory(pool) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [B4B_A_TABLES]);
  assert.deepEqual(result.rows.map((row) => row.table_name), [...B4B_A_TABLES].sort());

  const unsafe = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND column_name ~ '(secret_value|credential_json|token|password|host_path)'
  `, [B4B_A_TABLES]);
  assert.deepEqual(unsafe.rows, []);
}

async function seedAuthority(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES
      ('system-catalog', 'workbench-v1', 'System Catalog', $1, $1),
      ('b4b-user-a', 'workbench-v1', 'B4B A', $1, $1),
      ('b4b-user-b', 'workbench-v1', 'B4B B', $1, $1)
    ON CONFLICT (user_id) DO NOTHING
  `, [PAST]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES
      ('system-catalog', 'workbench-v1', 'System Catalog', 'system-catalog', $1, $1),
      ('b4b-workspace-a', 'workbench-v1', 'B4B A', 'b4b-user-a', $1, $1),
      ('b4b-workspace-b', 'workbench-v1', 'B4B B', 'b4b-user-b', $1, $1)
    ON CONFLICT (workspace_id) DO NOTHING
  `, [PAST]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES
      ('b4b-membership-a', 'b4b-workspace-a', 'b4b-user-a', 'workbench-v1', 'owner', $1, $1),
      ('b4b-membership-a-b', 'b4b-workspace-a', 'b4b-user-b', 'workbench-v1', 'member', $1, $1),
      ('b4b-membership-b', 'b4b-workspace-b', 'b4b-user-b', 'workbench-v1', 'owner', $1, $1)
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `, [PAST]);

  await seedSystemAuthority(pool);
  await seedPersonalAuthority(pool, {
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    membershipId: "b4b-membership-a",
  });
  await seedPersonalAuthority(pool, {
    workspaceId: "b4b-workspace-b",
    userId: "b4b-user-b",
    membershipId: "b4b-membership-b",
  });
  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id, membership_id,
      created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-user-b', 'user', 'b4b-user-b',
      'b4b-membership-a-b', $1, $1
    )
  `, [PAST]);
  await seedProjectAuthority(pool);

  await pool.query(`
    INSERT INTO public.agent_sessions (
      session_id, workspace_id, user_id, schema_version, definition_id,
      scope_kind, source_kind, title, task_status, status,
      model_preference_state, created_at, updated_at
    ) VALUES
      ('b4b-session-a', 'b4b-workspace-a', 'b4b-user-a', 'workbench-v1',
        'main', 'main', 'manual', 'B4B A', 'idle', 'active', 'preference_only', $1, $1),
      ('b4b-session-b', 'b4b-workspace-b', 'b4b-user-b', 'workbench-v1',
        'main', 'main', 'manual', 'B4B B', 'idle', 'active', 'preference_only', $1, $1)
  `, [NOW]);
}

async function seedSystemAuthority(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.skill_system_catalog_principals (
        principal_id, product_user_id, schema_version, status, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'workbench-v1', 'enabled', $1, $1
      ) ON CONFLICT (principal_id) DO UPDATE
        SET status = 'enabled',
            updated_at = GREATEST(
              public.skill_system_catalog_principals.updated_at,
              EXCLUDED.updated_at
            )
    `, [PAST]);
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, created_at, updated_at
      ) VALUES ('system-catalog', 'system-catalog', 'system', $1, $1)
      ON CONFLICT (workspace_id, principal_id) DO NOTHING
    `, [PAST]);
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, project_id,
        current_policy_revision_id, created_by_principal_id,
        created_by_principal_kind, creation_mode, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'workbench-v1', 'project',
        'system-catalog', 'system-catalog-policy-1', 'system-catalog',
        'system', 'system_initial_seed', $1, $1
      ) ON CONFLICT (workspace_id, scope_id) DO NOTHING
    `, [PAST]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'system-catalog-policy-1', 1,
        'observation_disabled', 'interactive', $1,
        'system-catalog', 'system', $2
      ) ON CONFLICT (workspace_id, scope_id, policy_revision_id) DO NOTHING
    `, [hash("a"), PAST]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, can_approve, granted_by_principal_id,
        granted_by_principal_kind, issuance_kind, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'system-catalog-initial-grant',
        'system-catalog', 'system', 'operation', true,
        'system-catalog', 'system', 'scope_creation', $1, $1
      ) ON CONFLICT (workspace_id, grant_id) DO NOTHING
    `, [PAST]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedPersonalAuthority(pool, {
  workspaceId,
  userId,
  membershipId,
  scopeId = `${workspaceId}-personal`,
  policyId = `${workspaceId}-policy-1`,
  grantId = `${workspaceId}-operation`,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, user_id, membership_id,
        created_at, updated_at
      ) VALUES ($1, $2, 'user', $2, $3, $4, $4)
    `, [workspaceId, userId, membershipId, PAST]);
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
    `, [workspaceId, scopeId, userId, policyId, PAST]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES ($1, $2, $3, 1, 'private', 'interactive', $4, $5, 'user', $6)
    `, [workspaceId, scopeId, policyId, hash("b"), userId, PAST]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, can_approve, granted_by_principal_id,
        granted_by_principal_kind, issuance_kind, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'user', 'operation', true, $4, 'user',
        'scope_creation', $5, $5)
    `, [workspaceId, scopeId, grantId, userId, PAST]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedProjectAuthority(pool) {
  const commandId = "b4b-project-scope-create";
  const requestDecisionId = `${commandId}:request`;
  const authorizedDecisionId = `${commandId}:authorized`;
  const digest = hash("5");
  const policyHash = hash("6");
  const targetContract = {
    scopeKind: "project",
    ownerUserId: null,
    ownerPrincipalId: null,
    projectId: "b4b-project",
    creatorPrincipalId: "b4b-user-a",
    creatorPrincipalKind: "user",
    policy: {
      policyRevisionId: "b4b-project-policy-1",
      revision: 1,
      observationTier: "workspace_readable",
      permissionMode: "interactive",
      autoApprovedEffectClasses: [],
      autoApprovedActionIds: [],
      contentHash: policyHash,
    },
    initialGrant: {
      grantId: "b4b-project-operation",
      subjectPrincipalId: "b4b-user-a",
      subjectPrincipalKind: "user",
      accessKind: "operation",
      capabilities: [],
      canApprove: true,
    },
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const decision of [
      { id: requestDecisionId, disposition: "approval_required", approvalId: requestDecisionId },
      { id: authorizedDecisionId, disposition: "authorized", approvalId: requestDecisionId },
    ]) {
      await client.query(`
        INSERT INTO public.authorization_decisions (
          workspace_id, authorization_decision_id, scope_id, policy_revision_id,
          actor_principal_id, actor_principal_kind, actor_scope_grant_id,
          effective_principal_id, effective_principal_kind, effective_scope_grant_id,
          authorization_source, authorizer_principal_id, authorizer_principal_kind,
          authorizer_scope_grant_id, action_id, effect_class, argument_digest,
          target_contract, permission_mode, destructive_rule_version,
          disposition, approval_id, reason_code, decided_at, expires_at
        ) VALUES (
          'b4b-workspace-a', $1, 'b4b-workspace-a-personal',
          'b4b-workspace-a-policy-1', 'b4b-user-a', 'user',
          'b4b-workspace-a-operation', 'b4b-user-a', 'user',
          'b4b-workspace-a-operation', 'principal', 'b4b-user-a', 'user',
          'b4b-workspace-a-operation', 'scope_create', 'administrative', $2,
          $3::jsonb, 'interactive', 'authority-v1', $4, $5,
          $6, $7, $8
        )
      `, [
        decision.id, digest, JSON.stringify(targetContract), decision.disposition,
        decision.approvalId,
        decision.disposition === "authorized" ? "approved" : "approval_required",
        NOW, FUTURE,
      ]);
    }
    await client.query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id,
        actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind,
        authorization_decision_id, policy_revision_id, effect_class,
        argument_digest, target_contract, quota_user_id, schema_version, kind,
        target_kind, target_id, target_revision, status,
        created_at, updated_at, finished_at
      ) VALUES (
        $1, 'b4b-workspace-a', 'b4b-workspace-a-personal',
        'b4b-user-a', 'user', 'b4b-user-a', 'user', $2,
        'b4b-workspace-a-policy-1', 'administrative', $3, $4::jsonb,
        'b4b-user-a', 'workbench-v1', 'scope_create',
        'product_scope', 'b4b-project-scope', 1, 'completed', $5, $5, $5
      )
    `, [commandId, authorizedDecisionId, digest, JSON.stringify(targetContract), NOW]);
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, project_id,
        current_policy_revision_id, created_by_principal_id,
        created_by_principal_kind, creation_mode, creation_command_id,
        creation_authority_scope_id, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-scope', 'workbench-v1', 'project',
        'b4b-project', 'b4b-project-policy-1', 'b4b-user-a', 'user',
        'command', $1, 'b4b-workspace-a-personal', $2, $2
      )
    `, [commandId, NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-scope', 'b4b-project-policy-1', 1,
        'workspace_readable', 'interactive', $1, 'b4b-user-a', 'user', $2
      )
    `, [policyHash, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, can_approve, granted_by_principal_id,
        granted_by_principal_kind, issuance_kind, issuance_authority_scope_id,
        issuance_command_id, issuance_authorization_decision_id,
        issuance_argument_digest, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-scope', 'b4b-project-operation',
        'b4b-user-a', 'user', 'operation', true,
        'b4b-user-a', 'user', 'scope_creation', 'b4b-workspace-a-personal',
        $1, $2, $3, $4, $4
      )
    `, [commandId, authorizedDecisionId, digest, NOW]);
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-workflow', 'b4b-project-scope',
        'b4b-user-a', 'workbench-v1', 'B4B project workflow',
        'draft', 'draft', 'private', 'b4b-project-workflow-r1', 1, $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number,
        schema_version, graph, input_form, output_definition, resource_refs,
        run_settings, content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-workflow-r1', 'b4b-project-workflow', 1,
        'workbench-v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
        '{}'::jsonb, $1, 'b4b-user-a', 'Project scope fixture', $2, $2
      )
    `, [hash("7"), NOW]);
    await client.query(`
      INSERT INTO public.agent_branches (
        branch_id, workspace_id, user_id, schema_version,
        object_kind, object_id, base_version_id, status, created_at, updated_at
      ) VALUES (
        'b4b-project-branch-b', 'b4b-workspace-a', 'b4b-user-b', 'workbench-v1',
        'workflow', 'b4b-project-workflow', 'b4b-project-workflow-r1',
        'active', $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.agent_sessions (
        session_id, workspace_id, user_id, schema_version, definition_id,
        scope_kind, object_kind, object_id, branch_id, base_version_id,
        source_kind, title, task_status, status,
        model_preference_state, created_at, updated_at
      ) VALUES (
        'b4b-project-session-b', 'b4b-workspace-a', 'b4b-user-b',
        'workbench-v1', 'loop_creator', 'module', 'workflow',
        'b4b-project-workflow', 'b4b-project-branch-b',
        'b4b-project-workflow-r1', 'manual', 'B4B Bob project session',
        'idle', 'active', 'preference_only', $1, $1
      )
    `, [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function grantProjectScopeToBob(pool) {
  const requestId = "b4b-project-bob-grant-request";
  const decisionId = "b4b-project-bob-grant-decision";
  const commandId = "b4b-project-bob-grant-command";
  const grantId = "b4b-project-bob-operation";
  const digest = hash("6");
  const targetContract = {
    scopeId: "b4b-project-scope",
    grantId,
    subjectPrincipalId: "b4b-user-b",
    subjectPrincipalKind: "user",
    accessKind: "operation",
    capabilities: [],
    canApprove: false,
    grantorPrincipalId: "b4b-user-a",
    grantorPrincipalKind: "user",
    issuanceKind: "command",
    status: "active",
  };
  await withTransaction(pool, async (client) => {
    for (const decision of [
      { id: requestId, disposition: "approval_required", approvalId: requestId },
      { id: decisionId, disposition: "authorized", approvalId: requestId },
    ]) {
      await client.query(`
        INSERT INTO public.authorization_decisions (
          workspace_id, authorization_decision_id, scope_id, policy_revision_id,
          actor_principal_id, actor_principal_kind, actor_scope_grant_id,
          effective_principal_id, effective_principal_kind, effective_scope_grant_id,
          authorization_source, authorizer_principal_id, authorizer_principal_kind,
          authorizer_scope_grant_id, action_id, effect_class, argument_digest,
          target_contract, permission_mode, destructive_rule_version,
          disposition, approval_id, reason_code, decided_at, expires_at
        ) VALUES (
          'b4b-workspace-a', $1, 'b4b-project-scope', 'b4b-project-policy-1',
          'b4b-user-a', 'user', 'b4b-project-operation',
          'b4b-user-a', 'user', 'b4b-project-operation',
          'principal', 'b4b-user-a', 'user', 'b4b-project-operation',
          'scope_principal_grant_issue', 'administrative', $2, $3::jsonb,
          'interactive', 'authority-v1', $4, $5, $6, $7, $8
        )
      `, [
        decision.id, digest, JSON.stringify(targetContract), decision.disposition,
        decision.approvalId,
        decision.disposition === "authorized" ? "approved" : "approval_required",
        NOW, FUTURE,
      ]);
    }
    await client.query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id,
        actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind,
        authorization_decision_id, policy_revision_id, effect_class,
        argument_digest, target_contract, quota_user_id, schema_version, kind,
        target_kind, target_id, target_revision, status,
        created_at, updated_at, finished_at
      ) VALUES (
        $1, 'b4b-workspace-a', 'b4b-project-scope',
        'b4b-user-a', 'user', 'b4b-user-a', 'user', $2,
        'b4b-project-policy-1', 'administrative', $3, $4::jsonb,
        'b4b-user-a', 'workbench-v1', 'scope_principal_grant_issue',
        'scope_principal_grant', $5, 1, 'completed', $6, $6, $6
      )
    `, [commandId, decisionId, digest, JSON.stringify(targetContract), grantId, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-scope', $1, 'b4b-user-b', 'user',
        'operation', ARRAY[]::text[], false, 'b4b-user-a', 'user',
        'command', 'b4b-project-scope', $2, $3, $4, $5, $5
      )
    `, [grantId, commandId, decisionId, digest, NOW]);
  });
}

async function seedGovernedModels(pool) {
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-global-profile",
    revisionId: "b4b-global-r1",
    bindingId: "b4b-global-secret",
    workspaceId: "system-catalog",
    scopeId: "system-catalog",
    principalId: "system-catalog",
    principalKind: "system",
    profileScope: "global",
    capabilities: ["chat", "tool_calling"],
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-workspace-profile-a",
    revisionId: "b4b-workspace-a-r1",
    bindingId: "b4b-workspace-a-secret",
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-expired-profile-a",
    revisionId: "b4b-expired-a-r1",
    bindingId: "b4b-expired-a-secret",
    bindingStatus: "expired",
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-revoked-profile-a",
    revisionId: "b4b-revoked-a-r1",
    bindingId: "b4b-revoked-a-secret",
    bindingStatus: "revoked",
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-pending-profile-a",
    revisionId: "b4b-pending-a-r1",
    bindingId: "b4b-pending-a-secret",
    bindingStatus: "pending",
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-run-model-profile",
    revisionId: "b4b-run-model-r1",
    bindingId: "b4b-run-model-secret-r1",
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-disable-model-profile",
    revisionId: "b4b-disable-model-r1",
    bindingId: "b4b-disable-model-secret-r1",
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-image-model-profile",
    revisionId: "b4b-image-model-r1",
    bindingId: "b4b-image-model-secret-r1",
    provider: "stability",
    protocol: "stability_image_v2",
    providerModelRef: "stable-image-test",
    capabilities: ["image_generation"],
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-structured-model-profile",
    revisionId: "b4b-structured-model-r1",
    bindingId: "b4b-structured-model-secret-r1",
    capabilities: ["chat", "structured_output"],
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-project-model-profile",
    revisionId: "b4b-project-model-r1",
    bindingId: "b4b-project-model-secret-r1",
    scopeId: "b4b-project-scope",
    capabilities: ["chat", "structured_output"],
  }));
  await createModelAggregate(pool, modelFixture({
    profileId: "b4b-desktop-model-profile",
    revisionId: "b4b-desktop-model-r1",
    bindingId: "b4b-desktop-model-secret-r1",
    secretSource: "desktop_keychain",
  }));
  await expectSqlState(pool, () => createModelAggregate(pool, modelFixture({
    profileId: "b4b-future-probe-model-profile",
    revisionId: "b4b-future-probe-model-r1",
    bindingId: "b4b-future-probe-model-secret",
    bindingProbedAt: FUTURE,
  })), "23514");
  await expectSqlState(pool, () => createModelAggregate(pool, modelFixture({
    profileId: "b4b-realtime-image-generation-profile",
    revisionId: "b4b-realtime-image-generation-r1",
    bindingId: "b4b-realtime-image-generation-secret",
    protocol: "openai_realtime",
    capabilities: [
      "chat", "tool_calling", "realtime_audio_input", "realtime_audio_output",
      "realtime_turn_detection", "realtime_barge_in", "image_generation",
    ],
  })), "23514");
}

function modelFixture(overrides = {}) {
  return {
    profileId: "b4b-workspace-profile-a",
    revisionId: "b4b-workspace-a-r1",
    bindingId: "b4b-workspace-a-secret",
    workspaceId: "b4b-workspace-a",
    scopeId: "b4b-workspace-a-personal",
    principalId: "b4b-user-a",
    principalKind: "user",
    profileScope: "workspace",
    capabilities: ["chat"],
    bindingStatus: "active",
    secretSource: "cloud_secret_store",
    provider: "openai",
    protocol: "openai_compatible_chat",
    providerModelRef: "gpt-test",
    ...overrides,
  };
}

async function createModelAggregate(pool, fixture) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertModelAggregate(client, fixture);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedGovernedExecutionPlan(pool, {
  compileId,
  planId,
  modelRevisionId,
}) {
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-run-workflow', 'b4b-workspace-a-personal',
        'b4b-user-a', 'workbench-v1', 'B4B governed Run',
        'ready', 'ready', 'private', 'b4b-run-workflow-r1', 1, $1, $1
      ) ON CONFLICT (workspace_id, workflow_id) DO NOTHING
    `, [PAST]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number,
        schema_version, graph, input_form, output_definition, resource_refs,
        run_settings, content_hash, authored_by, save_reason, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-run-workflow-r1', 'b4b-run-workflow', 1,
        'workbench-v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
        '{}'::jsonb, $1, 'b4b-user-a', 'B4B governed model fixture', $2, $2
      ) ON CONFLICT (workspace_id, revision_id) DO NOTHING
    `, [hash("7"), PAST]);
  });

  const planHash = hash(planId.endsWith("r1") ? "8" : "9");
  const planDocument = {
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    workflowId: "b4b-run-workflow",
    workflowRevisionId: "b4b-run-workflow-r1",
    generatedAt: NOW,
    contentHash: planHash,
    maxParallelism: 1,
    modelRoutingState: "pinned",
    pinnedSkills: [],
    steps: [{
      nodeId: "node-model",
      modelProfileRevisionId: modelRevisionId,
      modelCapability: "chat",
      fallbackModelProfileRevisionIds: [],
    }],
    reviewGates: [],
    primaryOutput: { nodeId: "node-model", portId: "result" },
  };
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.compile_results (
        workspace_id, compile_result_id, workflow_id, workflow_revision_id,
        schema_version, status, execution_plan_id, ordered_steps,
        review_gates, compiled_at
      ) VALUES (
        'b4b-workspace-a', $1, 'b4b-run-workflow', 'b4b-run-workflow-r1',
        'workbench-v1', 'ready', $2, '["node-model"]'::jsonb, '[]'::jsonb, $3
      )
    `, [compileId, planId, NOW]);
    await client.query(`
      INSERT INTO public.execution_plans (
        workspace_id, plan_id, compile_result_id, workflow_id,
        workflow_revision_id, schema_version, plan_version, content_hash,
        model_routing_state, plan_document, pins_finalized, generated_at
      ) VALUES (
        'b4b-workspace-a', $1, $2, 'b4b-run-workflow',
        'b4b-run-workflow-r1', 'workbench-execution-plan-v2', 2, $3,
        'pinned', $4::jsonb, false, $5
      )
    `, [planId, compileId, planHash, JSON.stringify(planDocument), NOW]);
    await client.query(`
      INSERT INTO public.execution_plan_model_pins (
        workspace_id, plan_id, node_id, pin_role, ordinal,
        model_profile_revision_id, schema_version, created_at
      ) VALUES (
        'b4b-workspace-a', $1, 'node-model', 'primary', 0,
        $2, 'workbench-internal-v1', $3
      )
    `, [planId, modelRevisionId, NOW]);
    await client.query(`
      UPDATE public.execution_plans
      SET pins_finalized = true
      WHERE workspace_id = 'b4b-workspace-a' AND plan_id = $1
    `, [planId]);
  });
}

async function assertPlanCapabilityGates(pool) {
  await expectTransactionSqlState(pool, async (client) => {
    await client.query(
      "SET CONSTRAINTS execution_plan_model_pins_model_revision_guard DEFERRED",
    );
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-wrong-capability-compile",
      planId: "b4b-wrong-capability-plan",
      modelRevisionId: "b4b-workspace-a-r1",
      modelCapability: "image_generation",
      hashCharacter: "1",
    });
  }, "23514");

  await expectTransactionSqlState(pool, async (client) => {
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-ready-recheck-compile",
      planId: "b4b-ready-recheck-plan",
      modelRevisionId: "b4b-workspace-a-r1",
      modelCapability: "chat",
      hashCharacter: "2",
    });
    await client.query(`
      UPDATE public.model_profiles
      SET enabled = false, write_version = 2, updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND profile_id = 'b4b-workspace-profile-a'
    `, [FUTURE]);
  }, "23514");
}

async function insertPlanCapabilityFixture(client, {
  compileId,
  planId,
  modelRevisionId,
  modelCapability,
  hashCharacter,
  workflowId = "b4b-run-workflow",
  workflowRevisionId = "b4b-run-workflow-r1",
}) {
  const planHash = hash(hashCharacter);
  const document = {
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    workflowId,
    workflowRevisionId,
    generatedAt: NOW,
    contentHash: planHash,
    maxParallelism: 1,
    modelRoutingState: "pinned",
    pinnedSkills: [],
    steps: [{
      nodeId: "node-model",
      modelProfileRevisionId: modelRevisionId,
      modelCapability,
      fallbackModelProfileRevisionIds: [],
    }],
    reviewGates: [],
    primaryOutput: { nodeId: "node-model", portId: "result" },
  };
  await client.query(`
    INSERT INTO public.compile_results (
      workspace_id, compile_result_id, workflow_id, workflow_revision_id,
      schema_version, status, execution_plan_id, ordered_steps,
      review_gates, compiled_at
    ) VALUES (
      'b4b-workspace-a', $1, $3, $4,
      'workbench-v1', 'ready', $2, '["node-model"]'::jsonb, '[]'::jsonb, $5
    )
  `, [compileId, planId, workflowId, workflowRevisionId, NOW]);
  await client.query(`
    INSERT INTO public.execution_plans (
      workspace_id, plan_id, compile_result_id, workflow_id,
      workflow_revision_id, schema_version, plan_version, content_hash,
      model_routing_state, plan_document, pins_finalized, generated_at
    ) VALUES (
      'b4b-workspace-a', $1, $2, $3,
      $4, 'workbench-execution-plan-v2', 2, $5,
      'pinned', $6::jsonb, false, $7
    )
  `, [
    planId, compileId, workflowId, workflowRevisionId,
    planHash, JSON.stringify(document), NOW,
  ]);
  await client.query(`
    INSERT INTO public.execution_plan_model_pins (
      workspace_id, plan_id, node_id, pin_role, ordinal,
      model_profile_revision_id, schema_version, created_at
    ) VALUES (
      'b4b-workspace-a', $1, 'node-model', 'primary', 0,
      $2, 'workbench-internal-v1', $3
    )
  `, [planId, modelRevisionId, NOW]);
  await client.query(`
    UPDATE public.execution_plans
    SET pins_finalized = true
    WHERE workspace_id = 'b4b-workspace-a' AND plan_id = $1
  `, [planId]);
}

async function insertModelAggregate(client, fixture) {
  const {
    profileId, revisionId, bindingId, workspaceId, scopeId,
    principalId, principalKind, profileScope, capabilities,
    bindingStatus, secretSource, bindingOwnerId = revisionId,
    provider, protocol, providerModelRef, bindingProbedAt = null,
  } = fixture;
  const bindingTimes = secretBindingTimes(bindingStatus);
  const effectiveProbedAt = bindingProbedAt ?? bindingTimes.probedAt;
  await client.query(`
    INSERT INTO public.model_profiles (
      profile_id, workspace_id, scope_id, schema_version, profile_scope,
      display_name, current_revision_id, current_revision_number,
      created_by_principal_id, created_by_principal_kind, created_at, updated_at
    ) VALUES ($1, $2, $3, 'workbench-model-catalog-v1', $4,
      $9, $5, 1, $6, $7, $8, $8)
  `, [
    profileId, workspaceId, scopeId, profileScope, revisionId,
    principalId, principalKind, PAST, `${profileId} profile`,
  ]);
  await client.query(`
    INSERT INTO public.secret_bindings (
      workspace_id, secret_binding_id, scope_id, schema_version,
      owner_kind, owner_id, secret_source, store_binding_ref,
      store_binding_revision, credential_fingerprint, status,
      created_by_principal_id, created_by_principal_kind,
      probed_at, expires_at, revoked_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, 'workbench-secret-binding-v1',
      'model_profile_revision', $4, $5, $6, 1, $7, $8,
      $9, $10, $11, $12, $13, $14, $15
    )
  `, [
    workspaceId, bindingId, scopeId, bindingOwnerId, secretSource,
    `${bindingId}-store`, hash("c"), bindingStatus, principalId, principalKind,
    effectiveProbedAt, bindingTimes.expiresAt, bindingTimes.revokedAt,
    PAST, bindingTimes.updatedAt,
  ]);
  await client.query(`
    INSERT INTO public.model_profile_revisions (
      revision_id, workspace_id, profile_id, revision_number, schema_version,
      provider, protocol, provider_model_ref, capabilities,
      parameter_support, limits, data_policy, cost_policy,
      parameter_schema_version, policy_version, config_hash,
      deployment_key, secret_binding_id,
      created_by_principal_id, created_by_principal_kind, created_at
    ) VALUES (
      $1, $2, $3, 1, 'workbench-model-catalog-v1',
      $4, $5, $6, $7,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '1.0.0', '1.0.0', $8, $9, $10, $11, $12, $13
    )
  `, [
    revisionId, workspaceId, profileId, provider, protocol, providerModelRef,
    capabilities, hash("d"), `${profileId}-deployment`, bindingId,
    principalId, principalKind, PAST,
  ]);
}

function secretBindingTimes(status) {
  if (status === "active") return {
    probedAt: NOW, expiresAt: FUTURE, revokedAt: null, updatedAt: NOW,
  };
  if (status === "expired") return {
    probedAt: PAST, expiresAt: NOW, revokedAt: null, updatedAt: NOW,
  };
  if (status === "revoked") return {
    probedAt: PAST, expiresAt: FUTURE, revokedAt: NOW, updatedAt: NOW,
  };
  return { probedAt: null, expiresAt: FUTURE, revokedAt: null, updatedAt: PAST };
}

async function assertModelConsumptionAndPolicy(pool) {
  await insertPinnedTurn(pool, {
    turnId: "b4b-turn-a-global",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-global-r1",
    sequence: 1,
  });
  await insertPinnedTurn(pool, {
    turnId: "b4b-turn-b-global",
    sessionId: "b4b-session-b",
    workspaceId: "b4b-workspace-b",
    userId: "b4b-user-b",
    revisionId: "b4b-global-r1",
    sequence: 1,
  });
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.agent_turns
    SET status = 'completed', finished_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-turn-a-global'
  `, [NOW]), "23514");
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.agent_turns
    SET actual_model_revision_id = 'b4b-structured-model-r1',
        status = 'completed', finished_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-turn-a-global'
  `, [NOW]), "23514");
  await pool.query(`
    UPDATE public.agent_turns
    SET actual_model_revision_id = 'b4b-global-r1',
        status = 'running', started_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-turn-a-global'
  `, [NOW]);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.agent_turns
    SET actual_model_revision_id = 'b4b-structured-model-r1', updated_at = $1
    WHERE turn_id = 'b4b-turn-a-global'
  `, [NOW]), "55000");
  await pool.query(`
    UPDATE public.agent_turns
    SET status = 'completed', finished_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-turn-a-global'
  `, [NOW]);
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-turn-missing-capability",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-global-r1",
    sequence: 10,
    requiredCapability: null,
  }), "23514");

  for (const [turnId, revisionId] of [
    ["b4b-turn-b-cross", "b4b-workspace-a-r1"],
    ["b4b-turn-a-expired", "b4b-expired-a-r1"],
    ["b4b-turn-a-revoked", "b4b-revoked-a-r1"],
    ["b4b-turn-a-pending", "b4b-pending-a-r1"],
  ]) {
    await expectSqlState(pool, () => insertPinnedTurn(pool, {
      turnId,
      sessionId: turnId.includes("turn-b") ? "b4b-session-b" : "b4b-session-a",
      workspaceId: turnId.includes("turn-b") ? "b4b-workspace-b" : "b4b-workspace-a",
      userId: turnId.includes("turn-b") ? "b4b-user-b" : "b4b-user-a",
      revisionId,
      sequence: 2,
    }), "23514");
  }

  await expectTransactionSqlState(pool, async (client) => {
    await client.query("SET CONSTRAINTS agent_turns_model_revision_guard DEFERRED");
    await client.query(`
      INSERT INTO public.agent_turns (
        turn_id, session_id, workspace_id, user_id, schema_version,
        kind, sequence, status, model_routing_state,
        required_model_capability, requested_model_revision_id,
        queued_at, updated_at
      ) VALUES (
        'b4b-turn-missing', 'b4b-session-a', 'b4b-workspace-a', 'b4b-user-a',
        'workbench-v1', 'agent_message', 3, 'queued', 'pinned',
        'chat', 'b4b-model-revision-missing', $1, $1
      )
    `, [NOW]);
  }, "23503", "agent_turns_requested_model_revision_fk");

  await pool.query(`
    INSERT INTO public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision, schema_version,
      capability_model_revision_ids, workflow_fallback_allowed,
      policy_version, content_hash, created_by, created_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-workspace-a-personal',
      'b4b-model-policy-a1', 1,
      'workbench-model-policy-v1',
      '{"chat":"b4b-workspace-a-r1","tool_calling":"b4b-global-r1"}'::jsonb,
      true, '1.0.0', $1, 'b4b-user-a', $2
    )
  `, [hash("e"), NOW]);
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision, schema_version,
      capability_model_revision_ids, workflow_fallback_allowed,
      policy_version, content_hash, created_by, created_at
    ) VALUES (
      'b4b-workspace-b', 'b4b-workspace-b-personal',
      'b4b-model-policy-b1', 1,
      'workbench-model-policy-v1', '{"chat":"b4b-workspace-a-r1"}'::jsonb,
      false, '1.0.0', $1, 'b4b-user-b', $2
    )
  `, [hash("f"), NOW]), "23514");
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision,
      base_policy_revision_id, base_revision, schema_version,
      capability_model_revision_ids, workflow_fallback_allowed,
      policy_version, content_hash, created_by, created_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-workspace-a-personal',
      'b4b-model-policy-capability', 2,
      'b4b-model-policy-a1', 1,
      'workbench-model-policy-v1', '{"image_generation":"b4b-global-r1"}'::jsonb,
      false, '1.0.0', $1, 'b4b-user-a', $2
    )
  `, [hash("1"), NOW]), "23514");

  await insertPinnedTurn(pool, {
    turnId: "b4b-turn-image",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-image-model-r1",
    sequence: 7,
    kind: "model_task",
    requiredCapability: "image_generation",
  });
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-turn-image-wrong-model",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-workspace-a-r1",
    sequence: 8,
    kind: "model_task",
    requiredCapability: "image_generation",
  }), "23514");
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-turn-image-input-wrong-model",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-workspace-a-r1",
    sequence: 9,
    requiredCapability: "image_input",
  }), "23514");
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-project-turn-without-grant",
    sessionId: "b4b-project-session-b",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-b",
    revisionId: "b4b-project-model-r1",
    sequence: 1,
  }), "23514");
  await grantProjectScopeToBob(pool);
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-project-turn-cross-scope",
    sessionId: "b4b-project-session-b",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-b",
    revisionId: "b4b-workspace-a-r1",
    sequence: 1,
  }), "23514");
  await insertPinnedTurn(pool, {
    turnId: "b4b-project-turn-same-scope",
    sessionId: "b4b-project-session-b",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-b",
    revisionId: "b4b-project-model-r1",
    sequence: 1,
  });
  await insertContextEvent(pool, {
    contextEventId: "b4b-project-context-with-grant",
    turnId: "b4b-project-turn-same-scope",
    modelRevisionId: "b4b-project-model-r1",
    sourceHash: hash("6"),
    sessionId: "b4b-project-session-b",
    userId: "b4b-user-b",
  });
  await pool.query(`
    UPDATE public.scope_principal_grants
    SET status = 'revoked', revision = 2, revoked_at = $1, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND grant_id = 'b4b-project-bob-operation'
  `, [FUTURE]);
  await expectSqlState(pool, () => insertContextEvent(pool, {
    contextEventId: "b4b-project-context-after-revoke",
    turnId: "b4b-project-turn-same-scope",
    modelRevisionId: "b4b-project-model-r1",
    sourceHash: hash("7"),
    sessionId: "b4b-project-session-b",
    userId: "b4b-user-b",
  }), "23514", /agent_session_scope_grant_missing/);
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-turn-desktop-secret",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-desktop-model-r1",
    sequence: 11,
  }), "23514");

  await insertContextEvent(pool, {
    contextEventId: "b4b-context-structured",
    turnId: "b4b-turn-a-global",
    modelRevisionId: "b4b-structured-model-r1",
    sourceHash: hash("4"),
  });
  await expectSqlState(pool, () => insertContextEvent(pool, {
    contextEventId: "b4b-context-wrong-capability",
    turnId: "b4b-turn-a-global",
    modelRevisionId: "b4b-workspace-a-r1",
    sourceHash: hash("5"),
  }), "23514");
  await assertPlanCapabilityGates(pool);
  await assertScopeAndSecretSourcePlanGates(pool);
}

async function assertScopeAndSecretSourcePlanGates(pool) {
  await expectTransactionSqlState(pool, async (client) => {
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-project-cross-scope-compile",
      planId: "b4b-project-cross-scope-plan",
      modelRevisionId: "b4b-workspace-a-r1",
      modelCapability: "chat",
      hashCharacter: "a",
      workflowId: "b4b-project-workflow",
      workflowRevisionId: "b4b-project-workflow-r1",
    });
  }, "23514");
  await withTransaction(pool, async (client) => {
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-project-same-scope-compile",
      planId: "b4b-project-same-scope-plan",
      modelRevisionId: "b4b-project-model-r1",
      modelCapability: "chat",
      hashCharacter: "b",
      workflowId: "b4b-project-workflow",
      workflowRevisionId: "b4b-project-workflow-r1",
    });
  });
  await expectTransactionSqlState(pool, async (client) => {
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-desktop-secret-compile",
      planId: "b4b-desktop-secret-plan",
      modelRevisionId: "b4b-desktop-model-r1",
      modelCapability: "chat",
      hashCharacter: "c",
    });
  }, "23514");

  await pool.query(`
    INSERT INTO public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision, schema_version,
      capability_model_revision_ids, workflow_fallback_allowed,
      policy_version, content_hash, created_by, created_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-scope', 'b4b-project-model-policy', 1,
      'workbench-model-policy-v1', '{"chat":"b4b-project-model-r1"}'::jsonb,
      false, '1.0.0', $1, 'b4b-user-a', $2
    )
  `, [hash("d"), NOW]);
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision, schema_version,
      capability_model_revision_ids, workflow_fallback_allowed,
      policy_version, content_hash, created_by, created_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-scope',
      'b4b-project-model-policy-cross', 2,
      'workbench-model-policy-v1', '{"chat":"b4b-workspace-a-r1"}'::jsonb,
      false, '1.0.0', $1, 'b4b-user-a', $2
    )
  `, [hash("e"), NOW]), "23514");
}

async function insertContextEvent(pool, {
  contextEventId, turnId, modelRevisionId, sourceHash,
  sessionId = "b4b-session-a", userId = "b4b-user-a",
}) {
  await pool.query(`
    INSERT INTO public.agent_context_events (
      context_event_id, session_id, workspace_id, user_id, schema_version,
      status, through_message_sequence, source_hash, prompt_revision,
      model_profile_revision_id, turn_id, created_at
    ) VALUES (
      $1, $2, 'b4b-workspace-a', $3, 'workbench-v1',
      'completed', 0, $4, 'context-condensation-v1', $5, $6, $7
    )
  `, [contextEventId, sessionId, userId, sourceHash, modelRevisionId, turnId, NOW]);
}

async function insertPinnedTurn(pool, {
  turnId, sessionId, workspaceId, userId, revisionId, sequence,
  kind = "agent_message", requiredCapability = "chat",
}) {
  await pool.query(`
    INSERT INTO public.agent_turns (
      turn_id, session_id, workspace_id, user_id, schema_version,
      kind, sequence, status, model_routing_state,
      required_model_capability, requested_model_revision_id,
      queued_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'workbench-v1',
      $5, $6, 'queued', 'pinned', $7, $8, $9, $9)
  `, [
    turnId, sessionId, workspaceId, userId, kind, sequence,
    requiredCapability, revisionId, NOW,
  ]);
}

async function assertHistoricalConsumersAndRunAdmission(pool) {
  await insertPinnedTurn(pool, {
    turnId: "b4b-turn-historical-revoked",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-run-model-r1",
    sequence: 4,
  });
  await insertPinnedTurn(pool, {
    turnId: "b4b-turn-historical-disabled",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-disable-model-r1",
    sequence: 5,
  });
  await createWorkflowRun(pool, {
    runId: "b4b-run-awaiting-claim",
    commandId: "b4b-run-awaiting-claim-command",
    idempotencyKey: "b4b-run-awaiting-claim-key",
    compileId: "b4b-run-compile-r1",
    planId: "b4b-run-plan-r1",
    planHash: hash("8"),
  });

  await pool.query(`
    UPDATE public.agent_turns
    SET actual_model_revision_id = 'b4b-disable-model-r1', updated_at = $1
    WHERE turn_id = 'b4b-turn-historical-disabled'
  `, [NOW]);
  await pool.query(`
    UPDATE public.agent_turns
    SET actual_model_revision_id = 'b4b-run-model-r1', updated_at = $1
    WHERE turn_id = 'b4b-turn-historical-revoked'
  `, [NOW]);

  await pool.query(`
    UPDATE public.model_profiles
    SET enabled = false, write_version = 2, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND profile_id = 'b4b-disable-model-profile'
  `, [FUTURE]);
  await pool.query(`
    UPDATE public.agent_turns
    SET status = 'completed', finished_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-turn-historical-disabled'
  `, [FUTURE]);
  await pool.query(`
    UPDATE public.model_profiles
    SET enabled = true, write_version = 3, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND profile_id = 'b4b-disable-model-profile'
  `, [FUTURE]);
  await insertPinnedTurn(pool, {
    turnId: "b4b-turn-after-reenable",
    sessionId: "b4b-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-disable-model-r1",
    sequence: 6,
  });

  await pool.query(`
    UPDATE public.secret_bindings
    SET status = 'revoked', status_revision = 2,
        revoked_at = $1, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND secret_binding_id = 'b4b-run-model-secret-r1'
  `, [FUTURE]);
  await pool.query(`
    UPDATE public.agent_turns
    SET status = 'completed', finished_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-turn-historical-revoked'
  `, [FUTURE]);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.agent_turns
    SET requested_model_revision_id = 'b4b-global-r1',
        actual_model_revision_id = 'b4b-global-r1', updated_at = $1
    WHERE turn_id = 'b4b-turn-historical-revoked'
  `, [FUTURE]), "55000");

  await expectTransactionSqlState(pool, async (client) => {
    await insertWorkflowRunAggregate(client, {
      runId: "b4b-run-revoked-plan",
      commandId: "b4b-run-revoked-plan-command",
      idempotencyKey: "b4b-run-revoked-plan-key",
      compileId: "b4b-run-compile-r1",
      planId: "b4b-run-plan-r1",
      planHash: hash("8"),
    });
  }, "23514");
  await expectSqlState(pool, () => pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-worker-revoked", "b4b-lease-revoked", "b4b-claim-revoked", "1 minute"],
  ), "23514");
  await pool.query(`
    INSERT INTO public.workflow_run_events (
      workspace_id, event_id, run_id, schema_version, sequence,
      type, status, summary, writer_kind, product_command_id,
      run_fence, occurred_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-run-awaiting-claim:failed',
      'b4b-run-awaiting-claim', 'workbench-run-event-v1', 2,
      'run.failed', 'failed', 'Pinned model is no longer available.',
      'controller', 'b4b-run-awaiting-claim-command', 0, $1
    )
  `, [FUTURE]);

  await insertSecondModelRevision(pool);
  await seedGovernedExecutionPlan(pool, {
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    modelRevisionId: "b4b-run-model-r2",
  });
  await createWorkflowRun(pool, {
    runId: "b4b-run-r2",
    commandId: "b4b-run-r2-command",
    idempotencyKey: "b4b-run-r2-key",
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    planHash: hash("9"),
  });
  const claimed = await pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-worker-r2", "b4b-lease-r2", "b4b-claim-r2", "1 minute"],
  );
  assert.equal(claimed.rowCount, 1);
  assert.equal(claimed.rows[0]?.run_id, "b4b-run-r2");
}

async function insertSecondModelRevision(pool) {
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref,
        store_binding_revision, credential_fingerprint, status,
        created_by_principal_id, created_by_principal_kind,
        probed_at, expires_at, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-run-model-secret-r2',
        'b4b-workspace-a-personal', 'workbench-secret-binding-v1',
        'model_profile_revision', 'b4b-run-model-r2', 'cloud_secret_store',
        'b4b-run-model-store', 2, $1, 'active', 'b4b-user-a', 'user',
        $2, $3, $2, $2
      )
    `, [hash("2"), NOW, FUTURE]);
    await client.query(`
      INSERT INTO public.model_profile_revisions (
        revision_id, workspace_id, profile_id, revision_number,
        base_revision_id, base_revision_number, schema_version,
        provider, protocol, provider_model_ref, capabilities,
        parameter_support, limits, data_policy, cost_policy,
        parameter_schema_version, policy_version, config_hash,
        deployment_key, secret_binding_id,
        created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES (
        'b4b-run-model-r2', 'b4b-workspace-a', 'b4b-run-model-profile', 2,
        'b4b-run-model-r1', 1, 'workbench-model-catalog-v1',
        'openai', 'openai_compatible_chat', 'gpt-test-v2', ARRAY['chat']::text[],
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '1.0.0', '1.0.0', $1, 'b4b-run-model-deployment-r2',
        'b4b-run-model-secret-r2', 'b4b-user-a', 'user', $2
      )
    `, [hash("3"), NOW]);
    await client.query(`
      UPDATE public.model_profiles
      SET current_revision_id = 'b4b-run-model-r2',
          current_revision_number = 2, write_version = 2, updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND profile_id = 'b4b-run-model-profile'
    `, [FUTURE]);
  });
}

async function createWorkflowRun(pool, fixture) {
  await withTransaction(pool, (client) => insertWorkflowRunAggregate(client, fixture));
}

async function insertWorkflowRunAggregate(client, {
  runId,
  commandId,
  idempotencyKey,
  compileId,
  planId,
  planHash,
  scopeId = "b4b-workspace-a-personal",
  policyId = "b4b-workspace-a-policy-1",
  scopeGrantId = "b4b-workspace-a-operation",
  workflowId = "b4b-run-workflow",
  workflowRevisionId = "b4b-run-workflow-r1",
  workflowRevisionHash = hash("7"),
}) {
  const requestDecisionId = `${commandId}:request`;
  const authorizedDecisionId = `${commandId}:authorized`;
  const digest = hash("a");
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
      'b4b-workspace-a', $1, '${scopeId}',
      '${policyId}', 'b4b-user-a', 'user',
      '${scopeGrantId}', 'b4b-user-a', 'user',
      '${scopeGrantId}', 'principal', 'b4b-user-a', 'user',
      '${scopeGrantId}', 'workflow_run', 'execute', $2,
      'interactive', 'authority-v1', 'approval_required', $1,
      'approval_required', $3, $4
    )
  `, [requestDecisionId, digest, NOW, FUTURE]);
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
      'b4b-workspace-a', $1, '${scopeId}',
      '${policyId}', 'b4b-user-a', 'user',
      '${scopeGrantId}', 'b4b-user-a', 'user',
      '${scopeGrantId}', 'principal', 'b4b-user-a', 'user',
      '${scopeGrantId}', 'workflow_run', 'execute', $2,
      'interactive', 'authority-v1', 'authorized', $3,
      'approved', $4, $5
    )
  `, [authorizedDecisionId, digest, requestDecisionId, NOW, FUTURE]);
  await client.query(`
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id,
      actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind,
      authorization_decision_id, policy_revision_id, effect_class,
      argument_digest, quota_user_id, schema_version, kind,
      target_kind, target_id, target_revision, status, created_at, updated_at
    ) VALUES (
      $1, 'b4b-workspace-a', '${scopeId}',
      'b4b-user-a', 'user', 'b4b-user-a', 'user', $2,
      '${policyId}', 'execute', $3, 'b4b-user-a',
      'workbench-v1', 'workflow_run', 'workflow_run', $4, 1,
      'accepted', $5, $5
    )
  `, [commandId, authorizedDecisionId, digest, runId, NOW]);
  await client.query(`
    INSERT INTO public.workflow_runs (
      workspace_id, run_id, scope_id, product_command_id,
      workflow_id, workflow_revision_id, workflow_revision_content_hash,
      compile_result_id, execution_plan_id, execution_plan_content_hash,
      schema_version, idempotency_key, status, queued_at, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', $1, '${scopeId}', $2,
      '${workflowId}', '${workflowRevisionId}', $3,
      $4, $5, $6, 'workbench-run-v1', $7,
      'queued', $8, $8, $8
    )
  `, [
    runId, commandId, workflowRevisionHash, compileId, planId, planHash,
    idempotencyKey, NOW,
  ]);
  await client.query(`
    INSERT INTO public.workflow_run_jobs (
      workspace_id, run_id, schema_version, state,
      available_at, queued_at, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', $1, 'workbench-run-job-v1', 'queued',
      $2, $2, $2, $2
    )
  `, [runId, NOW]);
  await client.query(`
    INSERT INTO public.workflow_run_events (
      workspace_id, event_id, run_id, schema_version, sequence,
      type, status, summary, writer_kind, product_command_id,
      run_fence, occurred_at
    ) VALUES (
      'b4b-workspace-a', $1, $2, 'workbench-run-event-v1', 1,
      'run.queued', 'queued', 'Run queued.', 'controller', $3, 0, $4
    )
  `, [`${runId}:queued`, runId, commandId, NOW]);
}

async function assertSecretLifecycleAndModelOwnership(pool) {
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.secret_bindings
    SET secret_source = 'desktop_keychain', status_revision = 2, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND secret_binding_id = 'b4b-workspace-a-secret'
  `, [FUTURE]), "55000");
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.secret_bindings
    SET status = 'pending', status_revision = 2, probed_at = NULL, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND secret_binding_id = 'b4b-workspace-a-secret'
  `, [FUTURE]), "55000");

  await expectTransactionSqlState(pool, async (client) => {
    await insertModelAggregate(client, modelFixture({
      profileId: "b4b-invalid-global-profile",
      revisionId: "b4b-invalid-global-r1",
      bindingId: "b4b-invalid-global-secret",
      workspaceId: "system-catalog",
      scopeId: "system-catalog",
      principalId: "system-catalog",
      principalKind: "system",
      profileScope: "global",
      secretSource: "desktop_keychain",
    }));
  }, "23514");

  await expectTransactionSqlState(pool, async (client) => {
    const fixture = modelFixture({
      profileId: "b4b-owner-mismatch-profile",
      revisionId: "b4b-owner-mismatch-r1",
      bindingId: "b4b-owner-mismatch-secret",
      bindingOwnerId: "b4b-unowned-model-r1",
    });
    await insertModelAggregate(client, fixture);
  }, "23514");
}

async function assertConnectionRevisionAuthority(pool) {
  await createConnectionAggregate(pool, {
    connectionId: "b4b-connection-a",
    revisionId: "b4b-connection-a-r1",
    bindingId: "b4b-connection-secret-r1",
    storeRevision: 1,
  });
  await expectSqlState(pool, () => createConnectionAggregate(pool, {
    connectionId: "b4b-future-probe-connection",
    revisionId: "b4b-future-probe-connection-r1",
    bindingId: "b4b-future-probe-connection-secret",
    storeRevision: 1,
    bindingProbedAt: FUTURE,
  }), "23514", /secret_binding_active_probe_invalid/);
  await expectTransactionSqlState(pool, async (client) => {
    await insertConnectionAggregate(client, {
      connectionId: "b4b-connection-pending",
      revisionId: "b4b-connection-pending-r1",
      bindingId: "b4b-connection-pending-secret",
      storeRevision: 1,
      bindingStatus: "pending",
    });
  }, "23514");
  await expectTransactionSqlState(pool, async (client) => {
    await insertConnectionAggregate(client, {
      connectionId: "b4b-connection-desktop-connected",
      revisionId: "b4b-connection-desktop-connected-r1",
      bindingId: "b4b-connection-desktop-connected-secret",
      storeRevision: 1,
      secretSource: "desktop_keychain",
    });
  }, "23514");
  await expectTransactionSqlState(pool, async (client) => {
    await insertConnectionAggregate(client, {
      connectionId: "b4b-connection-future-checked",
      revisionId: "b4b-connection-future-checked-r1",
      bindingId: "b4b-connection-future-checked-secret",
      storeRevision: 1,
      validationCheckedAtSql: `'${FUTURE}'`,
      validationExpiresAtSql: `'${FAR_FUTURE}'`,
    });
  }, "23514");
  await expectTransactionSqlState(pool, async (client) => {
    await insertConnectionAggregate(client, {
      connectionId: "b4b-connection-past-validation",
      revisionId: "b4b-connection-past-validation-r1",
      bindingId: "b4b-connection-past-validation-secret",
      storeRevision: 1,
      validationCheckedAtSql: `'${PAST}'`,
      validationExpiresAtSql: `'${NOW}'`,
    });
  }, "23514");
  await expectTransactionSqlState(pool, async (client) => {
    await insertConnectionAggregate(client, {
      connectionId: "b4b-connection-owner-mismatch",
      revisionId: "b4b-connection-owner-mismatch-r1",
      bindingId: "b4b-connection-owner-mismatch-secret",
      storeRevision: 1,
      bindingOwnerId: "b4b-connection-a",
    });
  }, "23514");
  await expectTransactionSqlState(pool, async (client) => {
    await insertConnectionAggregate(client, {
      connectionId: "b4b-connection-fingerprint-mismatch",
      revisionId: "b4b-connection-fingerprint-mismatch-r1",
      bindingId: "b4b-connection-fingerprint-mismatch-secret",
      storeRevision: 1,
      revisionCredentialFingerprint: hash("6"),
    });
  }, "23514");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref,
        store_binding_revision, credential_fingerprint, status,
        created_by_principal_id, created_by_principal_kind,
        probed_at, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-connection-secret-r2',
        'b4b-workspace-a-personal', 'workbench-secret-binding-v1',
        'connection', 'b4b-connection-a', 'cloud_secret_store',
        'b4b-connection-store', 2, $1, 'active',
        'b4b-user-a', 'user', $2, $2, $2
      )
    `, [hash("4"), NOW]);
    await client.query(connectionRevisionSql({
      connectionId: "b4b-connection-a",
      revisionId: "b4b-connection-a-r2",
      revisionNumber: 2,
      baseRevisionId: "b4b-connection-a-r1",
      bindingId: "b4b-connection-secret-r2",
    }), [NOW]);
    await client.query(`
      UPDATE public.workspace_connections
      SET current_revision_id = 'b4b-connection-a-r2',
          current_revision_number = 2,
          write_version = 2,
          updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND connection_id = 'b4b-connection-a'
    `, [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const current = await pool.query(`
    SELECT current_revision_id, current_revision_number, write_version
    FROM public.workspace_connections
    WHERE workspace_id = 'b4b-workspace-a' AND connection_id = 'b4b-connection-a'
  `);
  assert.deepEqual(current.rows, [{
    current_revision_id: "b4b-connection-a-r2",
    current_revision_number: 2,
    write_version: 2,
  }]);

  await publishConnectionRequirement(pool, {
    loopVersionId: "b4b-project-loop-v1",
    workflowId: "b4b-project-workflow",
    workflowRevisionId: "b4b-project-workflow-r1",
    workflowRevisionHash: hash("7"),
    compileId: "b4b-project-same-scope-compile",
    planId: "b4b-project-same-scope-plan",
    version: "1.0.0-project",
    requirementId: "project-tool",
    capabilityKey: "project.tool",
    requiredEffects: ["project.read"],
    contentHash: hash("f"),
  });
  await publishConnectionRequirement(pool, {
    loopVersionId: "b4b-run-loop-v1",
    workflowId: "b4b-run-workflow",
    workflowRevisionId: "b4b-run-workflow-r1",
    workflowRevisionHash: hash("7"),
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    version: "1.0.0-run",
    requirementId: "short-lived-tool",
    capabilityKey: "lark.task",
    requiredEffects: ["task.write"],
    contentHash: hash("0"),
  });
  await seedRunInstallationFixture(pool);
  await expectSqlState(pool, () => publishConnectionRequirement(pool, {
    loopVersionId: "b4b-duplicate-effects-loop-v1",
    workflowId: "b4b-project-workflow",
    workflowRevisionId: "b4b-project-workflow-r1",
    workflowRevisionHash: hash("7"),
    compileId: "b4b-project-same-scope-compile",
    planId: "b4b-project-same-scope-plan",
    version: "1.0.0-duplicate-effects",
    requirementId: "duplicate-effects-tool",
    capabilityKey: "project.tool",
    requiredEffects: ["project.read", "project.read"],
    contentHash: hash("1"),
  }), "23514");

  await createConnectionAggregate(pool, {
    connectionId: "b4b-project-connection",
    revisionId: "b4b-project-connection-r1",
    bindingId: "b4b-project-connection-secret",
    storeRevision: 1,
    scopeId: "b4b-project-scope",
    capabilityKey: "project.tool",
    validationEffects: ["project.read", "project.write"],
  });
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-invented-requirement',
      'b4b-project-connection', 'invented-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1', $1, $1
    )
  `, [NOW]), "23514");
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-cross-scope-binding',
      'b4b-connection-a', 'project-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1', $1, $1
    )
  `, [NOW]), "23514");

  await expectSqlState(pool, () => createConnectionAggregate(pool, {
    connectionId: "b4b-duplicate-validation-effects",
    revisionId: "b4b-duplicate-validation-effects-r1",
    bindingId: "b4b-duplicate-validation-effects-secret",
    storeRevision: 1,
    validationEffects: ["task.write", "task.write"],
  }), "23514");

  await createConnectionAggregate(pool, {
    connectionId: "b4b-project-wrong-capability",
    revisionId: "b4b-project-wrong-capability-r1",
    bindingId: "b4b-project-wrong-capability-secret",
    storeRevision: 1,
    scopeId: "b4b-project-scope",
    capabilityKey: "wrong.capability",
    validationEffects: ["project.read"],
  });
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-wrong-capability-binding',
      'b4b-project-wrong-capability', 'project-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1', $1, $1
    )
  `, [NOW]), "23514");
  await createConnectionAggregate(pool, {
    connectionId: "b4b-project-missing-effect",
    revisionId: "b4b-project-missing-effect-r1",
    bindingId: "b4b-project-missing-effect-secret",
    storeRevision: 1,
    scopeId: "b4b-project-scope",
    capabilityKey: "project.tool",
    validationEffects: [],
  });
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-missing-effect-binding',
      'b4b-project-missing-effect', 'project-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1', $1, $1
    )
  `, [NOW]), "23514");

  await pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-connection-binding',
      'b4b-project-connection', 'project-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1', $1, $1
    )
  `, [NOW]);
  await assertConnectionBindingGenerations(pool);

  await createConnectionAggregate(pool, {
    connectionId: "b4b-desktop-configured-connection",
    revisionId: "b4b-desktop-configured-connection-r1",
    bindingId: "b4b-desktop-configured-connection-secret",
    storeRevision: 1,
    secretSource: "desktop_keychain",
    readinessStatus: "needs_setup",
    validationStatus: "never_checked",
    validationCheckedAtSql: "NULL",
    validationExpiresAtSql: "NULL",
  });
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-desktop-cloud-binding',
      'b4b-desktop-configured-connection', 'short-lived-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-run-workflow', 'b4b-run-workflow-r1', $1, $1
    )
  `, [NOW]), "23514");

  await createConnectionAggregate(pool, {
    connectionId: "b4b-installation-stable-connection",
    revisionId: "b4b-installation-stable-connection-r1",
    bindingId: "b4b-installation-stable-connection-secret",
    storeRevision: 1,
    validationEffects: ["task.read", "task.write"],
  });
  await pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, installation_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-run-installation-binding',
      'b4b-installation-stable-connection', 'short-lived-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-run-installation', $1, $1
    )
  `, [NOW]);
  await assertInstallationBindingConcurrency(pool);

  await createConnectionAggregate(pool, {
    connectionId: "b4b-short-validation-connection",
    revisionId: "b4b-short-validation-connection-r1",
    bindingId: "b4b-short-validation-connection-secret",
    storeRevision: 1,
    validationExpiresAtSql: "clock_timestamp() + interval '2 seconds'",
    validationEffects: ["task.read", "task.write"],
  });
  await replaceRunInstallationBinding(pool, {
    previousBindingId: "b4b-run-installation-binding",
    bindingId: "b4b-short-validation-binding",
    connectionId: "b4b-short-validation-connection",
    generation: 2,
  });
  await createWorkflowRun(pool, {
    runId: "b4b-run-connection-expiry",
    commandId: "b4b-run-connection-expiry-command",
    idempotencyKey: "b4b-run-connection-expiry-key",
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    planHash: hash("9"),
  });
  await pool.query("SELECT pg_sleep(2.2)");
  await pool.query(`
    UPDATE public.workspace_connection_bindings
    SET payload = '{"historical":true}'::jsonb, updated_at = clock_timestamp()
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-short-validation-binding'
  `);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.workspace_connection_bindings
    SET requirement_id = 'forged-requirement', updated_at = clock_timestamp()
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-short-validation-binding'
  `), "55000");
  await expectSqlState(pool, () => pool.query(`
    DELETE FROM public.workspace_connection_bindings
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-short-validation-binding'
  `), "55000", /workspace_connection_binding_delete_forbidden/);
  await expectSqlState(pool, () => createWorkflowRun(pool, {
    runId: "b4b-run-expired-connection-rejected",
    commandId: "b4b-run-expired-connection-rejected-command",
    idempotencyKey: "b4b-run-expired-connection-rejected-key",
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    planHash: hash("9"),
  }), "23514");
  await withTransaction(pool, async (client) => {
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-expired-connection-binding-compile",
      planId: "b4b-expired-connection-binding-plan",
      modelRevisionId: "b4b-run-model-r2",
      modelCapability: "chat",
      hashCharacter: "2",
    });
  });
  await publishConnectionRequirement(pool, {
    loopVersionId: "b4b-expired-connection-binding-loop-v1",
    workflowId: "b4b-run-workflow",
    workflowRevisionId: "b4b-run-workflow-r1",
    workflowRevisionHash: hash("7"),
    compileId: "b4b-expired-connection-binding-compile",
    planId: "b4b-expired-connection-binding-plan",
    version: "1.0.1-run",
    requirementId: "short-lived-tool-2",
    capabilityKey: "lark.task",
    requiredEffects: ["task.write"],
    contentHash: hash("3"),
  });
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-short-validation-late-binding',
      'b4b-short-validation-connection', 'short-lived-tool-2', 'b4b-user-a',
      'workbench-v1', 'b4b-run-workflow', 'b4b-run-workflow-r1', $1, $1
    )
  `, [NOW]), "23514", /workspace_connection_not_consumable/);
  await expectSqlState(pool, () => pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-expired-connection-worker", "b4b-expired-connection-lease",
      "b4b-expired-connection-claim", "1 minute"],
  ), "23514");

  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref,
        store_binding_revision, credential_fingerprint, status,
        created_by_principal_id, created_by_principal_kind,
        probed_at, expires_at, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-short-validation-connection-test-secret',
        'b4b-workspace-a-personal', 'workbench-secret-binding-v1',
        'connection', 'b4b-short-validation-connection', 'cloud_secret_store',
        'b4b-short-validation-connection-test-store', 2, $1, 'active',
        'b4b-user-a', 'user', $2, $3, $2, $2
      )
    `, [hash("6"), NOW, FUTURE]);
    await client.query(connectionRevisionSql({
      connectionId: "b4b-short-validation-connection",
      revisionId: "b4b-short-validation-connection-r2-test",
      bindingId: "b4b-short-validation-connection-test-secret",
      revisionNumber: 2,
      baseRevisionId: "b4b-short-validation-connection-r1",
      credentialFingerprint: hash("6"),
      driverBackend: "test",
      validationEffects: ["task.read", "task.write"],
    }), [NOW]);
    await client.query(`
      UPDATE public.workspace_connections
      SET current_revision_id = 'b4b-short-validation-connection-r2-test',
          current_revision_number = 2, write_version = 2, updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND connection_id = 'b4b-short-validation-connection'
    `, [NOW]);
  });
  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-test-backend-binding',
      'b4b-short-validation-connection', 'short-lived-tool-2', 'b4b-user-a',
      'workbench-v1', 'b4b-run-workflow', 'b4b-run-workflow-r1', $1, $1
    )
  `, [NOW]), "23514", /workspace_connection_not_consumable/);
  await expectSqlState(pool, () => createWorkflowRun(pool, {
    runId: "b4b-run-test-backend-rejected",
    commandId: "b4b-run-test-backend-rejected-command",
    idempotencyKey: "b4b-run-test-backend-rejected-key",
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    planHash: hash("9"),
  }), "23514", /workspace_connection_not_consumable/);
  await expectSqlState(pool, () => pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-test-backend-worker", "b4b-test-backend-lease",
      "b4b-test-backend-claim", "1 minute"],
  ), "23514", /workspace_connection_not_consumable/);
  await pool.query(`
    INSERT INTO public.workflow_run_events (
      workspace_id, event_id, run_id, schema_version, sequence,
      type, status, summary, writer_kind, product_command_id,
      run_fence, occurred_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-run-connection-expiry:failed',
      'b4b-run-connection-expiry', 'workbench-run-event-v1', 2,
      'run.failed', 'failed', 'Connection is no longer consumable.',
      'controller', 'b4b-run-connection-expiry-command', 0, $1
    )
  `, [FUTURE]);
}

async function publishConnectionRequirement(pool, {
  loopVersionId,
  workflowId,
  workflowRevisionId,
  workflowRevisionHash,
  compileId,
  planId,
  version,
  requirementId,
  capabilityKey,
  requiredEffects,
  contentHash,
}) {
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.loop_versions (
        workspace_id, loop_version_id, workflow_id, workflow_revision_id,
        schema_version, version, workflow_revision_content_hash,
        compile_result_id, execution_plan_id, definition, content_hash,
        released_by, released_at
      ) VALUES (
        'b4b-workspace-a', $1, $2, $3, 'workbench-v1', $4, $5,
        $6, $7, '{"name":"Connection requirement fixture"}'::jsonb, $8,
        'b4b-user-a', $9
      )
    `, [
      loopVersionId, workflowId, workflowRevisionId, version,
      workflowRevisionHash, compileId, planId, contentHash, NOW,
    ]);
    await client.query(`
      INSERT INTO public.loop_version_connection_requirements (
        workspace_id, loop_version_id, workflow_id, requirement_id,
        capability_key, description, required_effects, schema_version
      ) VALUES (
        'b4b-workspace-a', $1, $2, $3, $4,
        'Connection capability required by this published Loop.',
        $5::jsonb, 'workbench-internal-v1'
      )
    `, [
      loopVersionId, workflowId, requirementId, capabilityKey,
      JSON.stringify(requiredEffects),
    ]);
    await client.query(`
      UPDATE public.loop_versions
      SET pins_finalized = true
      WHERE workspace_id = 'b4b-workspace-a'
        AND loop_version_id = $1
    `, [loopVersionId]);
  });
}

async function seedRunInstallationFixture(pool) {
  await publishConnectionRequirement(pool, {
    loopVersionId: "b4b-run-loop-v2",
    workflowId: "b4b-run-workflow",
    workflowRevisionId: "b4b-run-workflow-r1",
    workflowRevisionHash: hash("7"),
    compileId: "b4b-run-compile-r1",
    planId: "b4b-run-plan-r1",
    version: "2.0.0-run",
    requirementId: "short-lived-tool",
    capabilityKey: "lark.task",
    requiredEffects: ["task.write"],
    contentHash: hash("e"),
  });
  await pool.query(`
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      loop_workflow_id, loop_version_id, version, content_hash,
      visibility, domain, published_by, published_at
    ) VALUES
      (
        'b4b-workspace-a', 'b4b-run-release-v1', 'workbench-v1', 'loop',
        'b4b-run-workflow', 'b4b-run-loop-v1', '1.0.0-run', $1,
        'workspace', 'product', 'b4b-user-a', $3
      ),
      (
        'b4b-workspace-a', 'b4b-run-release-v2', 'workbench-v1', 'loop',
        'b4b-run-workflow', 'b4b-run-loop-v2', '2.0.0-run', $2,
        'workspace', 'product', 'b4b-user-a', $3
      )
  `, [hash("0"), hash("e"), NOW]);
  await pool.query(`
    INSERT INTO public.asset_installations (
      workspace_id, installation_id, source_workspace_id, release_id,
      schema_version, asset_kind, loop_workflow_id, loop_version_id, state,
      installed_by, installed_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-run-installation', 'b4b-workspace-a',
      'b4b-run-release-v1', 'workbench-v1', 'loop', 'b4b-run-workflow',
      'b4b-run-loop-v1', 'installed', 'b4b-user-a', $1, $1
    )
  `, [NOW]);
}

async function assertInstallationBindingConcurrency(pool) {
  const creationClient = await pool.connect();
  const creationUpdateClient = await pool.connect();
  try {
    await creationClient.query("BEGIN");
    await insertWorkflowRunAggregate(creationClient, {
      runId: "b4b-installation-claim-lock",
      commandId: "b4b-installation-claim-lock-command",
      idempotencyKey: "b4b-installation-claim-lock-key",
      compileId: "b4b-run-compile-r2",
      planId: "b4b-run-plan-r2",
      planHash: hash("9"),
    });
    await creationClient.query(
      "SELECT public.assert_execution_plan_connection_bindings_consumable($1, $2)",
      ["b4b-workspace-a", "b4b-run-plan-r2"],
    );
    await creationUpdateClient.query("BEGIN");
    await creationUpdateClient.query("SET LOCAL lock_timeout = '100ms'");
    let blockedUpdate = null;
    try {
      await updateRunInstallation(creationUpdateClient, "v2");
    } catch (error) {
      blockedUpdate = error;
    }
    assert.equal(blockedUpdate?.code, "55P03", blockedUpdate?.message);
    await creationUpdateClient.query("ROLLBACK");
    await creationClient.query("COMMIT");
  } catch (error) {
    await creationUpdateClient.query("ROLLBACK").catch(() => {});
    await creationClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    creationUpdateClient.release();
    creationClient.release();
  }

  await updateRunInstallation(pool, "v2");
  await expectSqlState(pool, () => createWorkflowRun(pool, {
    runId: "b4b-installation-create-after-update",
    commandId: "b4b-installation-create-after-update-command",
    idempotencyKey: "b4b-installation-create-after-update-key",
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    planHash: hash("9"),
  }), "23514", /execution_plan_connection_requirement_unbound/);
  await updateRunInstallation(pool, "v1");
  await createWorkflowRun(pool, {
    runId: "b4b-installation-claim-race",
    commandId: "b4b-installation-claim-race-command",
    idempotencyKey: "b4b-installation-claim-race-key",
    compileId: "b4b-run-compile-r2",
    planId: "b4b-run-plan-r2",
    planHash: hash("9"),
  });

  const claimClient = await pool.connect();
  const claimUpdateClient = await pool.connect();
  try {
    await claimClient.query("BEGIN");
    const claimed = await claimClient.query(
      "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
      ["b4b-installation-race-worker", "b4b-installation-race-lease",
        "b4b-installation-race-claim", "1 minute"],
    );
    assert.equal(claimed.rows[0]?.run_id, "b4b-installation-claim-lock");
    await claimUpdateClient.query("BEGIN");
    await claimUpdateClient.query("SET LOCAL lock_timeout = '100ms'");
    let blockedUpdate = null;
    try {
      await updateRunInstallation(claimUpdateClient, "v2");
    } catch (error) {
      blockedUpdate = error;
    }
    assert.equal(blockedUpdate?.code, "55P03", blockedUpdate?.message);
    await claimUpdateClient.query("ROLLBACK");
    await claimClient.query("COMMIT");
  } catch (error) {
    await claimUpdateClient.query("ROLLBACK").catch(() => {});
    await claimClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    claimUpdateClient.release();
    claimClient.release();
  }

  await updateRunInstallation(pool, "v2");
  await expectSqlState(pool, () => pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-installation-stale-worker", "b4b-installation-stale-lease",
      "b4b-installation-stale-claim", "1 minute"],
  ), "23514", /execution_plan_connection_requirement_unbound/);
  await updateRunInstallation(pool, "v1");
  await pool.query(`
    INSERT INTO public.workflow_run_events (
      workspace_id, event_id, run_id, schema_version, sequence,
      type, status, summary, writer_kind, product_command_id,
      run_fence, occurred_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-installation-claim-race:failed',
      'b4b-installation-claim-race', 'workbench-run-event-v1', 2,
      'run.failed', 'failed', 'Stale installation lineage rejected.',
      'controller', 'b4b-installation-claim-race-command', 0, $1
    )
  `, [NOW]);
}

async function updateRunInstallation(client, target) {
  const releaseId = target === "v1" ? "b4b-run-release-v1" : "b4b-run-release-v2";
  const loopVersionId = target === "v1" ? "b4b-run-loop-v1" : "b4b-run-loop-v2";
  return client.query(`
    UPDATE public.asset_installations
    SET release_id = $1, loop_version_id = $2,
        write_version = write_version + 1, updated_at = $3
    WHERE workspace_id = 'b4b-workspace-a'
      AND installation_id = 'b4b-run-installation'
  `, [releaseId, loopVersionId, NOW]);
}

async function replaceRunInstallationBinding(pool, {
  previousBindingId, bindingId, connectionId, generation,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const superseded = await client.query(`
      UPDATE public.workspace_connection_bindings
      SET status = 'superseded', superseded_at = $1, updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND binding_id = $2
        AND status = 'active'
    `, [NOW, previousBindingId]);
    assert.equal(superseded.rowCount, 1);
    await client.query(`
      INSERT INTO public.workspace_connection_bindings (
        workspace_id, binding_id, connection_id, requirement_id, bound_by,
        schema_version, installation_id, generation, created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', $1, $2, 'short-lived-tool', 'b4b-user-a',
        'workbench-v1', 'b4b-run-installation', $3, $4, $4
      )
    `, [bindingId, connectionId, generation, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertConnectionBindingGenerations(pool) {
  await createWorkflowRun(pool, {
    runId: "b4b-project-run-before-rebind",
    commandId: "b4b-project-run-before-rebind-command",
    idempotencyKey: "b4b-project-run-before-rebind-key",
    compileId: "b4b-project-same-scope-compile",
    planId: "b4b-project-same-scope-plan",
    planHash: hash("b"),
    scopeId: "b4b-project-scope",
    policyId: "b4b-project-policy-1",
    scopeGrantId: "b4b-project-operation",
    workflowId: "b4b-project-workflow",
    workflowRevisionId: "b4b-project-workflow-r1",
    workflowRevisionHash: hash("7"),
  });
  for (const fixture of [
    {
      bindingId: "b4b-project-binding-without-supersede",
      generation: 2,
      message: /workspace_connection_binding_previous_generation_active/,
    },
    {
      bindingId: "b4b-project-binding-skipped-generation",
      generation: 3,
      message: /workspace_connection_binding_previous_generation_missing/,
    },
  ]) {
    await expectSqlState(pool, () => pool.query(`
      INSERT INTO public.workspace_connection_bindings (
        workspace_id, binding_id, connection_id, requirement_id, bound_by,
        schema_version, workflow_id, workflow_revision_id, generation,
        created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', $1, 'b4b-project-connection', 'project-tool',
        'b4b-user-a', 'workbench-v1', 'b4b-project-workflow',
        'b4b-project-workflow-r1', $2, $3, $3
      )
    `, [fixture.bindingId, fixture.generation, NOW]), "23514", fixture.message);
  }

  await createConnectionAggregate(pool, {
    connectionId: "b4b-project-connection-b",
    revisionId: "b4b-project-connection-b-r1",
    bindingId: "b4b-project-connection-b-secret",
    storeRevision: 1,
    scopeId: "b4b-project-scope",
    capabilityKey: "project.tool",
    validationEffects: ["project.read", "project.write"],
  });
  await replaceProjectConnectionBinding(pool, {
    previousBindingId: "b4b-project-connection-binding",
    bindingId: "b4b-project-connection-binding-r2",
    connectionId: "b4b-project-connection-b",
    generation: 2,
  });

  const firstRebind = await pool.query(`
    SELECT binding_id, connection_id, generation, status, superseded_at
    FROM public.workspace_connection_bindings
    WHERE workspace_id = 'b4b-workspace-a'
      AND workflow_id = 'b4b-project-workflow'
      AND workflow_revision_id = 'b4b-project-workflow-r1'
      AND requirement_id = 'project-tool'
    ORDER BY generation
  `);
  assert.deepEqual(firstRebind.rows.map((row) => ({
    binding_id: row.binding_id,
    connection_id: row.connection_id,
    generation: row.generation,
    status: row.status,
    superseded: row.superseded_at !== null,
  })), [
    {
      binding_id: "b4b-project-connection-binding",
      connection_id: "b4b-project-connection",
      generation: 1,
      status: "superseded",
      superseded: true,
    },
    {
      binding_id: "b4b-project-connection-binding-r2",
      connection_id: "b4b-project-connection-b",
      generation: 2,
      status: "active",
      superseded: false,
    },
  ]);

  await expectSqlState(pool, () => pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, generation,
      created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-binding-same-generation',
      'b4b-project-connection-b', 'project-tool', 'b4b-user-a',
      'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1',
      2, $1, $1
    )
  `, [NOW]), "23505", /workspace_connection_bindings_workflow_generation_uq/);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.workspace_connection_bindings
    SET status = 'active', superseded_at = NULL, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-project-connection-binding'
  `, [FUTURE]), "55000", /workspace_connection_binding_superseded_terminal/);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.workspace_connection_bindings
    SET superseded_at = $1, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-project-connection-binding'
  `, [FUTURE]), "55000", /workspace_connection_binding_superseded_terminal/);
  await expectSqlState(pool, () => pool.query(`
    DELETE FROM public.workspace_connection_bindings
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-project-connection-binding'
  `), "55000", /workspace_connection_binding_delete_forbidden/);
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.workspace_connection_bindings
    SET status = 'superseded', superseded_at = $1, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND binding_id = 'b4b-project-connection-binding-r2'
  `, [NOW]), "23514", /workspace_connection_binding_active_generation_invalid/);

  await pool.query(`
    INSERT INTO public.workflow_run_events (
      workspace_id, event_id, run_id, schema_version, sequence,
      type, status, summary, writer_kind, product_command_id,
      run_fence, occurred_at
    ) VALUES (
      'b4b-workspace-a', 'b4b-project-run-before-rebind:failed',
      'b4b-project-run-before-rebind', 'workbench-run-event-v1', 2,
      'run.failed', 'failed', 'Historical Run ended after Connection rebind.',
      'controller', 'b4b-project-run-before-rebind-command', 0, $1
    )
  `, [NOW]);
  const historical = await pool.query(`
    SELECT status FROM public.workflow_runs
    WHERE workspace_id = 'b4b-workspace-a'
      AND run_id = 'b4b-project-run-before-rebind'
  `);
  assert.equal(historical.rows[0]?.status, "failed");

  await pool.query(`
    UPDATE public.workspace_connections
    SET enabled = false, write_version = write_version + 1, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND connection_id = 'b4b-project-connection'
  `, [NOW]);
  await createWorkflowRun(pool, {
    runId: "b4b-project-run-on-binding-b",
    commandId: "b4b-project-run-on-binding-b-command",
    idempotencyKey: "b4b-project-run-on-binding-b-key",
    compileId: "b4b-project-same-scope-compile",
    planId: "b4b-project-same-scope-plan",
    planHash: hash("b"),
    scopeId: "b4b-project-scope",
    policyId: "b4b-project-policy-1",
    scopeGrantId: "b4b-project-operation",
    workflowId: "b4b-project-workflow",
    workflowRevisionId: "b4b-project-workflow-r1",
    workflowRevisionHash: hash("7"),
  });
  const claimedOnB = await pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-project-worker-b", "b4b-project-lease-b",
      "b4b-project-claim-b", "1 minute"],
  );
  assert.equal(claimedOnB.rows[0]?.run_id, "b4b-project-run-on-binding-b");

  for (const suffix of ["c", "d"]) {
    await createConnectionAggregate(pool, {
      connectionId: `b4b-project-connection-${suffix}`,
      revisionId: `b4b-project-connection-${suffix}-r1`,
      bindingId: `b4b-project-connection-${suffix}-secret`,
      storeRevision: 1,
      scopeId: "b4b-project-scope",
      capabilityKey: "project.tool",
      validationEffects: ["project.read", "project.write"],
    });
  }
  const concurrent = await Promise.allSettled([
    replaceProjectConnectionBinding(pool, {
      previousBindingId: "b4b-project-connection-binding-r2",
      bindingId: "b4b-project-connection-binding-r3-c",
      connectionId: "b4b-project-connection-c",
      generation: 3,
    }),
    replaceProjectConnectionBinding(pool, {
      previousBindingId: "b4b-project-connection-binding-r2",
      bindingId: "b4b-project-connection-binding-r3-d",
      connectionId: "b4b-project-connection-d",
      generation: 3,
    }),
  ]);
  assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(concurrent.filter(({ status }) => status === "rejected").length, 1);
  const active = await pool.query(`
    SELECT binding_id, connection_id, generation
    FROM public.workspace_connection_bindings
    WHERE workspace_id = 'b4b-workspace-a'
      AND workflow_id = 'b4b-project-workflow'
      AND workflow_revision_id = 'b4b-project-workflow-r1'
      AND requirement_id = 'project-tool'
      AND status = 'active'
  `);
  assert.equal(active.rowCount, 1);
  assert.equal(active.rows[0]?.generation, 3);
  assert.ok([
    "b4b-project-connection-c", "b4b-project-connection-d",
  ].includes(active.rows[0]?.connection_id));
}

async function replaceProjectConnectionBinding(pool, {
  previousBindingId, bindingId, connectionId, generation,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const superseded = await client.query(`
      UPDATE public.workspace_connection_bindings
      SET status = 'superseded', superseded_at = $1, updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND binding_id = $2
        AND status = 'active'
    `, [NOW, previousBindingId]);
    if (superseded.rowCount !== 1) {
      throw new Error("workspace_connection_binding_rebind_lost_race");
    }
    await client.query(`
      INSERT INTO public.workspace_connection_bindings (
        workspace_id, binding_id, connection_id, requirement_id, bound_by,
        schema_version, workflow_id, workflow_revision_id, generation,
        created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', $1, $2, 'project-tool', 'b4b-user-a',
        'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1',
        $3, $4, $4
      )
    `, [bindingId, connectionId, generation, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createConnectionAggregate(pool, fixture) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertConnectionAggregate(client, fixture);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertConnectionAggregate(client, {
  connectionId,
  revisionId,
  bindingId,
  storeRevision,
  bindingStatus = "active",
  bindingOwnerId = connectionId,
  bindingCredentialFingerprint = hash("4"),
  revisionCredentialFingerprint = bindingCredentialFingerprint,
  scopeId = "b4b-workspace-a-personal",
  secretSource = "cloud_secret_store",
  readinessStatus = "connected",
  validationStatus = "valid",
  validationCheckedAtSql = "$1",
  validationExpiresAtSql = `'${FUTURE}'`,
  capabilityKey = "lark.task",
  validationEffects = [],
  driverBackend = "production",
  bindingProbedAt = null,
}) {
  const times = secretBindingTimes(bindingStatus);
  const effectiveProbedAt = bindingProbedAt ?? times.probedAt;
  await client.query(`
    INSERT INTO public.workspace_connections (
      workspace_id, connection_id, scope_id, created_by, schema_version,
      label, current_revision_id, current_revision_number,
      created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', $1, $3, 'b4b-user-a',
      'workbench-v1', $5, $2, 1, $4, $4
    )
  `, [connectionId, revisionId, scopeId, PAST, `${connectionId} connection`]);
  await client.query(`
    INSERT INTO public.secret_bindings (
      workspace_id, secret_binding_id, scope_id, schema_version,
      owner_kind, owner_id, secret_source, store_binding_ref,
      store_binding_revision, credential_fingerprint, status,
      created_by_principal_id, created_by_principal_kind,
      probed_at, expires_at, revoked_at, created_at, updated_at
    ) VALUES (
      'b4b-workspace-a', $1, $12,
      'workbench-secret-binding-v1', 'connection', $2,
      $13, $3, $4, $5, $6,
      'b4b-user-a', 'user', $7, $8, $9, $10, $11
    )
  `, [
    bindingId, bindingOwnerId, `${connectionId}-store`, storeRevision,
    bindingCredentialFingerprint,
    bindingStatus, effectiveProbedAt, times.expiresAt, times.revokedAt, PAST, times.updatedAt,
    scopeId, secretSource,
  ]);
  await client.query(connectionRevisionSql({
    connectionId,
    revisionId,
    bindingId,
    credentialFingerprint: revisionCredentialFingerprint,
    scopeId,
    readinessStatus,
    validationStatus,
    validationCheckedAtSql,
    validationExpiresAtSql,
    capabilityKey,
    validationEffects,
    driverBackend,
  }), [NOW]);
}

function connectionRevisionSql({
  connectionId,
  revisionId,
  bindingId,
  revisionNumber = 1,
  baseRevisionId = null,
  credentialFingerprint = hash("4"),
  scopeId = "b4b-workspace-a-personal",
  readinessStatus = "connected",
  validationStatus = "valid",
  validationCheckedAtSql = "$1",
  validationExpiresAtSql = `'${FUTURE}'`,
  capabilityKey = "lark.task",
  validationEffects = [],
  driverBackend = "production",
}) {
  const baseRevision = baseRevisionId === null ? "NULL" : `'${baseRevisionId}'`;
  const baseRevisionNumber = revisionNumber === 1 ? "NULL" : String(revisionNumber - 1);
  return `
    INSERT INTO public.workspace_connection_revisions (
      workspace_id, connection_revision_id, connection_id, scope_id,
      revision_number, base_revision_id, base_revision_number,
      schema_version, capability_key, driver_key, driver_backend,
      safe_configuration, credential_state, secret_binding_id,
      credential_binding_fingerprint, readiness_status, validation_status,
      validation_message, validation_principal, validation_effects,
      validation_checked_at,
      validation_expires_at, content_hash, created_by, created_at
    ) VALUES (
      'b4b-workspace-a', '${revisionId}', '${connectionId}',
      '${scopeId}', ${revisionNumber}, ${baseRevision}, ${baseRevisionNumber},
      'workbench-connection-v1', '${capabilityKey}', 'lark', '${driverBackend}',
      '{"accountLabel":"team"}'::jsonb, 'bound', '${bindingId}',
      '${credentialFingerprint}', '${readinessStatus}', '${validationStatus}',
      'Connection state.', 'tenant-a',
      '${JSON.stringify(validationEffects)}'::jsonb, ${validationCheckedAtSql},
      ${validationExpiresAtSql}, '${hash("5")}', 'b4b-user-a', $1
    )
  `;
}

async function assertImmutableHistory(pool) {
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.model_profile_revisions
    SET deployment_key = 'forged-deployment'
    WHERE revision_id = 'b4b-workspace-a-r1'
  `), "55000");
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.workspace_model_policy_revisions
    SET capability_model_revision_ids = '{"chat":"b4b-global-r1"}'::jsonb
    WHERE workspace_id = 'b4b-workspace-a'
      AND policy_revision_id = 'b4b-model-policy-a1'
  `), "55000");
  await expectSqlState(pool, () => pool.query(`
    UPDATE public.workspace_connection_revisions
    SET validation_message = 'forged'
    WHERE workspace_id = 'b4b-workspace-a'
      AND connection_revision_id = 'b4b-connection-a-r2'
  `), "55000");
}

async function assertArchivedScopeConsumptionGates(pool) {
  await withTransaction(pool, async (client) => {
    await client.query(`
      INSERT INTO public.agent_branches (
        branch_id, workspace_id, user_id, schema_version,
        object_kind, object_id, base_version_id, status, created_at, updated_at
      ) VALUES (
        'b4b-project-branch-a', 'b4b-workspace-a', 'b4b-user-a',
        'workbench-v1', 'workflow', 'b4b-project-workflow',
        'b4b-project-workflow-r1', 'active', $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.agent_sessions (
        session_id, workspace_id, user_id, schema_version, definition_id,
        scope_kind, object_kind, object_id, branch_id, base_version_id,
        source_kind, title, task_status, status,
        model_preference_state, created_at, updated_at
      ) VALUES (
        'b4b-project-session-a', 'b4b-workspace-a', 'b4b-user-a',
        'workbench-v1', 'loop_creator', 'module', 'workflow',
        'b4b-project-workflow', 'b4b-project-branch-a',
        'b4b-project-workflow-r1', 'manual', 'B4B Alice project session',
        'idle', 'active', 'preference_only', $1, $1
      )
    `, [NOW]);
  });
  await insertPinnedTurn(pool, {
    turnId: "b4b-project-turn-before-archive",
    sessionId: "b4b-project-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-project-model-r1",
    sequence: 1,
  });
  await pool.query(`
    UPDATE public.agent_turns
    SET actual_model_revision_id = 'b4b-project-model-r1',
        status = 'running', started_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-project-turn-before-archive'
  `, [NOW]);
  await createWorkflowRun(pool, {
    runId: "b4b-project-run-before-archive",
    commandId: "b4b-project-run-before-archive-command",
    idempotencyKey: "b4b-project-run-before-archive-key",
    compileId: "b4b-project-same-scope-compile",
    planId: "b4b-project-same-scope-plan",
    planHash: hash("b"),
    scopeId: "b4b-project-scope",
    policyId: "b4b-project-policy-1",
    scopeGrantId: "b4b-project-operation",
    workflowId: "b4b-project-workflow",
    workflowRevisionId: "b4b-project-workflow-r1",
    workflowRevisionHash: hash("7"),
  });
  await pool.query(`
    UPDATE public.product_scopes
    SET status = 'archived', revision = 2,
        archived_at = $1, updated_at = $1
    WHERE workspace_id = 'b4b-workspace-a'
      AND scope_id = 'b4b-project-scope'
  `, [FUTURE]);
  await pool.query(`
    UPDATE public.agent_turns
    SET status = 'completed', finished_at = $1, updated_at = $1
    WHERE turn_id = 'b4b-project-turn-before-archive'
  `, [FUTURE]);
  await expectSqlState(pool, () => insertPinnedTurn(pool, {
    turnId: "b4b-project-turn-after-archive",
    sessionId: "b4b-project-session-a",
    workspaceId: "b4b-workspace-a",
    userId: "b4b-user-a",
    revisionId: "b4b-project-model-r1",
    sequence: 2,
  }), "23514", /agent_session_scope_grant_missing/);
  await expectSqlState(pool, () => insertContextEvent(pool, {
    contextEventId: "b4b-project-context-after-archive",
    turnId: "b4b-project-turn-before-archive",
    modelRevisionId: "b4b-project-model-r1",
    sourceHash: hash("8"),
    sessionId: "b4b-project-session-a",
    userId: "b4b-user-a",
  }), "23514", /agent_session_scope_grant_missing/);
  await expectTransactionSqlState(pool, async (client) => {
    await insertPlanCapabilityFixture(client, {
      compileId: "b4b-project-archived-compile",
      planId: "b4b-project-archived-plan",
      modelRevisionId: "b4b-project-model-r1",
      modelCapability: "chat",
      hashCharacter: "4",
      workflowId: "b4b-project-workflow",
      workflowRevisionId: "b4b-project-workflow-r1",
    });
  }, "23514");
  await expectTransactionSqlState(pool, async (client) => {
    await client.query(`
      UPDATE public.workspace_connection_bindings
      SET status = 'superseded', superseded_at = $1, updated_at = $1
      WHERE workspace_id = 'b4b-workspace-a'
        AND workflow_id = 'b4b-project-workflow'
        AND workflow_revision_id = 'b4b-project-workflow-r1'
        AND requirement_id = 'project-tool'
        AND status = 'active'
    `, [FUTURE]);
    await client.query(`
      INSERT INTO public.workspace_connection_bindings (
        workspace_id, binding_id, connection_id, requirement_id, bound_by,
        schema_version, workflow_id, workflow_revision_id, generation,
        created_at, updated_at
      ) VALUES (
        'b4b-workspace-a', 'b4b-project-archived-binding',
        'b4b-project-connection', 'project-tool', 'b4b-user-a',
        'workbench-v1', 'b4b-project-workflow', 'b4b-project-workflow-r1',
        4, $1, $1
      )
    `, [FUTURE]);
  }, "23514", /workspace_connection_not_consumable/);
  await expectSqlState(pool, () => createWorkflowRun(pool, {
    runId: "b4b-project-run-after-archive",
    commandId: "b4b-project-run-after-archive-command",
    idempotencyKey: "b4b-project-run-after-archive-key",
    compileId: "b4b-project-same-scope-compile",
    planId: "b4b-project-same-scope-plan",
    planHash: hash("b"),
    scopeId: "b4b-project-scope",
    policyId: "b4b-project-policy-1",
    scopeGrantId: "b4b-project-operation",
    workflowId: "b4b-project-workflow",
    workflowRevisionId: "b4b-project-workflow-r1",
    workflowRevisionHash: hash("7"),
  }), "P0001", /authorization_scope_or_policy_not_current/);
  await expectSqlState(pool, () => pool.query(
    "SELECT * FROM public.claim_workflow_run_job($1, $2, $3, $4::interval)",
    ["b4b-archived-scope-worker", "b4b-archived-scope-lease",
      "b4b-archived-scope-claim", "1 minute"],
  ), "23514");
}

async function expectTransactionSqlState(pool, operation, code, detail = null) {
  const client = await pool.connect();
  let caught = null;
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    caught = error;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(caught?.code, code, caught?.message);
  if (typeof detail === "string") {
    assert.equal(caught?.constraint, detail, caught?.message);
  } else if (detail instanceof RegExp) {
    assert.match(caught?.message ?? "", detail, caught?.message);
  }
}

async function withTransaction(pool, operation) {
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

async function expectSqlState(pool, operation, code, messagePattern = null) {
  await assert.rejects(operation, (error) => (
    error?.code === code
    && (messagePattern === null || messagePattern.test(error?.message ?? ""))
  ));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required when PostgreSQL integration is enabled`);
  return value;
}
