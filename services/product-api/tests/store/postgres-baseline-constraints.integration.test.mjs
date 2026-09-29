import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const NOW = new Date(Date.now() - 60_000).toISOString();
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();
const HASH = `sha256:${"a".repeat(64)}`;

test("PostgreSQL baseline rejects cross-tenant and malformed authority records", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  assert.match(databaseName, /_test$/, "integration database must end in _test");

  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool });
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  await store.runMigrations();
  await seedTenants(pool);
  await assertAgentTurnAuthority(pool);
  await assertAgentBranchStatuses(pool);
  await seedCapacityAuthorities(pool);
  await seedExecutionAuthority(pool);
  await assertParentInvocationAuthority(pool);
  await assertCapacityAuthorityMismatches(pool);

  await expectConstraint(pool, `
    INSERT INTO public.agent_handoffs (
      handoff_id, workspace_id, user_id, source_session_id, target_session_id,
      schema_version, status, created_at
    ) VALUES (
      'handoff-cross-tenant', 'workspace-a', 'user-a', 'session-a', 'session-b',
      'workbench-v1', 'pending', $1
    )
  `, [NOW], "23503", "agent_handoffs_target_session_fk");

  await expectConstraint(pool, `
    INSERT INTO public.agent_child_spawn_counters (
      counter_id, workspace_id, session_id, schema_version, count, created_at, updated_at
    ) VALUES (
      'counter-cross-tenant', 'workspace-a', 'session-b', 'workbench-v1', 0, $1, $1
    )
  `, [NOW], "23503", "agent_child_spawn_counters_session_fk");

  await pool.query(`
    INSERT INTO public.agent_child_spawn_counters (
      counter_id, workspace_id, session_id, schema_version, count, created_at, updated_at
    ) VALUES (
      'counter-a', 'workspace-a', 'session-a', 'workbench-v1', 0, $1, $1
    )
  `, [NOW]);
  const reservation = `
    INSERT INTO public.agent_child_spawn_reservations (
      counter_id, workspace_id, session_id, parent_scope_invocation_id,
      parent_invocation_id, child_key, schema_version, reserved_at
    ) VALUES (
      'counter-a', 'workspace-a', 'session-a', NULL,
      'invocation-a', 'invocation-a:child-1',
      'workbench-v1', $1
    )
  `;
  await pool.query(reservation, [NOW]);
  await expectConstraint(
    pool,
    `
      INSERT INTO public.agent_child_spawn_reservations (
        counter_id, workspace_id, session_id, parent_scope_invocation_id,
        parent_invocation_id, child_key, schema_version, reserved_at
      ) VALUES (
        'counter-a', 'workspace-a', 'session-a', NULL, 'invocation-reservation-b',
        'invocation-a:child-1', 'workbench-v1', $1
      )
    `,
    [NOW],
    "23505",
    "agent_child_spawn_reservations_pkey",
  );

  await pool.query(`
    INSERT INTO public.agent_child_spawn_counters (
      counter_id, workspace_id, parent_scope_invocation_id,
      schema_version, count, created_at, updated_at
    ) VALUES (
      'counter-invocation-a', 'workspace-a', 'invocation-a',
      'workbench-v1', 0, $1, $1
    )
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.agent_child_spawn_reservations (
      counter_id, workspace_id, session_id, parent_scope_invocation_id,
      parent_invocation_id, child_key, schema_version, reserved_at
    ) VALUES (
      'counter-invocation-a', 'workspace-a', NULL, 'invocation-a',
      'invocation-a', 'invocation-a:scoped-child', 'workbench-v1', $1
    )
  `, [NOW]);

  await expectConstraint(pool, `
    INSERT INTO public.agent_child_spawn_reservations (
      counter_id, workspace_id, session_id, parent_scope_invocation_id,
      parent_invocation_id, child_key, schema_version, reserved_at
    ) VALUES (
      'counter-invocation-a', 'workspace-a', NULL, 'invocation-a',
      'invocation-reservation-b', 'invocation-a:wrong-parent', 'workbench-v1', $1
    )
  `, [NOW], "23514", "agent_child_spawn_reservations_invocation_parent");

  await expectConstraint(pool, `
    INSERT INTO public.agent_child_spawn_reservations (
      counter_id, workspace_id, session_id, parent_scope_invocation_id,
      parent_invocation_id, child_key, schema_version, reserved_at
    ) VALUES (
      'counter-a', 'workspace-a', 'session-a', NULL,
      'invocation-session-a-2', 'session-a:wrong-session', 'workbench-v1', $1
    )
  `, [NOW], "23503", "agent_child_spawn_reservations_session_parent_fk");

  await expectConstraint(pool, invocationInsert({
    invocationId: "invocation-wrong-command",
    workspaceId: "workspace-b",
    actorUserId: "user-b",
    productCommandId: "command-a",
    lineageSessionId: "session-a",
    lineageTurnId: "turn-a",
    attemptId: "attempt-wrong-command",
    capabilityLeaseId: "capability-wrong-command",
  }), [NOW], "23503", "execution_invocations_command_fk");

  await expectDeferredConstraint(pool, invocationInsert({
    invocationId: "invocation-wrong-attempt",
    workspaceId: "workspace-a",
    actorUserId: "user-a",
    productCommandId: "command-a",
    lineageSessionId: "session-a",
    lineageTurnId: "turn-a",
    attemptId: "attempt-a",
    capabilityLeaseId: "capability-a",
  }), [NOW], "execution_invocations_attempt_authority_fk");

  await expectCapabilityAuthorityMismatch(pool);

  await pool.query(`
    UPDATE public.execution_invocations
    SET status = 'running', started_at = $1, updated_at = $1
    WHERE invocation_id = 'invocation-a'
  `, [NOW]);
  await pool.query(`
    UPDATE public.execution_attempts
    SET status = 'running', started_at = $1, updated_at = $1
    WHERE invocation_id = 'invocation-a' AND attempt_id = 'attempt-a'
  `, [NOW]);

  await expectConstraint(pool, `
    INSERT INTO public.capacity_leases (
      capacity_lease_id, admission_id, command_id, workspace_id,
      schema_version, backend_key, provider_key, fence, lease_duration_ms,
      status, issued_at, expires_at, updated_at, dimensions
    ) VALUES (
      'capacity-cross-tenant', 'admission-a', 'command-b', 'workspace-b',
      'workbench-v1', 'bounded_agent:process', 'provider:none', 3, 60000,
      'active', $1, $2, $1, '[]'::jsonb
    )
  `, [NOW, LATER], "23503", "capacity_leases_admission_fk");

  await expectConstraint(pool, `
    INSERT INTO public.workbench_browser_sessions (
      session_id, user_id, active_workspace_id, schema_version,
      token_hash, csrf_token, created_at, expires_at
    ) VALUES (
      'browser-invalid-hash', 'user-a', 'workspace-a', 'workbench-v1',
      'not-a-digest', 'csrf-a', $1, $2
    )
  `, [NOW, LATER], "23514", "workbench_browser_sessions_token_hash_format");

  await expectConstraint(pool, effectInsert({
    effectId: "effect-invalid-hash",
    argumentDigest: "not-a-digest",
    status: "intent_recorded",
  }), [NOW], "23514", "external_effect_receipts_argument_digest_format");

  await pool.query(effectInsert({
    effectId: "effect-missing-reconcile",
    argumentDigest: HASH,
    status: "intent_recorded",
  }), [NOW]);
  await expectConstraint(pool, `
    UPDATE public.external_effect_receipts
    SET status = 'dispatching', dispatch_started_at = $1, updated_at = $1
    WHERE workspace_id = 'workspace-a' AND effect_id = 'effect-missing-reconcile'
  `, [NOW], "23514", "external_effect_receipts_dispatch_state");
});

async function assertAgentTurnAuthority(pool) {
  await pool.query(`
    INSERT INTO public.agent_turns (
      turn_id, session_id, workspace_id, user_id, schema_version,
      product_command_id, cancellation_command_id, kind, sequence, status,
      model_routing_state, required_model_capability,
      requested_model_revision_id, queued_at, updated_at
    ) VALUES (
      'turn-a', 'session-a', 'workspace-a', 'user-a', 'workbench-v1',
      'command-a', 'command-cancel-a', 'agent_message', 1, 'queued',
      'pinned', 'chat', 'model-revision-a', $1, $1
    )
  `, [NOW]);

  await expectConstraint(pool, `
    INSERT INTO public.agent_turns (
      turn_id, session_id, workspace_id, user_id, schema_version,
      kind, sequence, status, model_routing_state, required_model_capability,
      requested_model_revision_id,
      queued_at, updated_at
    ) VALUES (
      'turn-cross-session', 'session-b', 'workspace-a', 'user-a', 'workbench-v1',
      'agent_message', 2, 'queued', 'pinned', 'chat', 'model-revision-a', $1, $1
    )
  `, [NOW], "23503", "agent_turns_session_fk");

  await expectConstraint(pool, `
    INSERT INTO public.agent_turns (
      turn_id, session_id, workspace_id, user_id, schema_version,
      product_command_id, kind, sequence, status, model_routing_state,
      required_model_capability,
      requested_model_revision_id, queued_at, updated_at
    ) VALUES (
      'turn-cross', 'session-a', 'workspace-a', 'user-a', 'workbench-v1',
      'command-cross', 'agent_message', 2, 'queued', 'pinned',
      'chat', 'model-revision-a', $1, $1
    )
  `, [NOW], "23503", "agent_turns_product_command_fk");

  await expectConstraint(pool, `
    INSERT INTO public.agent_turns (
      turn_id, session_id, workspace_id, user_id, schema_version,
      cancellation_command_id, kind, sequence, status, model_routing_state,
      required_model_capability,
      requested_model_revision_id, queued_at, updated_at
    ) VALUES (
      'turn-cancel-cross', 'session-a', 'workspace-a', 'user-a', 'workbench-v1',
      'command-cancel-cross', 'agent_message', 2, 'queued', 'pinned',
      'chat', 'model-revision-a', $1, $1
    )
  `, [NOW], "23503", "agent_turns_cancellation_command_fk");
}

async function assertAgentBranchStatuses(pool) {
  await pool.query(`
    INSERT INTO public.agent_branches (
      branch_id, workspace_id, user_id, schema_version, object_kind,
      object_id, base_version_id, status, created_at, updated_at
    ) VALUES
      ('branch-active', 'workspace-a', 'user-a', 'workbench-v1',
        'skill_draft', 'skill-active', 'version-a', 'active', $1, $1),
      ('branch-conflicting', 'workspace-a', 'user-a', 'workbench-v1',
        'skill_draft', 'skill-conflicting', 'version-a', 'conflicting', $1, $1),
      ('branch-merged', 'workspace-a', 'user-a', 'workbench-v1',
        'skill_draft', 'skill-merged', 'version-a', 'merged', $1, $1),
      ('branch-rejected', 'workspace-a', 'user-a', 'workbench-v1',
        'skill_draft', 'skill-rejected', 'version-a', 'rejected', $1, $1),
      ('branch-closed', 'workspace-a', 'user-a', 'workbench-v1',
        'skill_draft', 'skill-closed', 'version-a', 'closed', $1, $1)
  `, [NOW]);

  await expectConstraint(pool, `
    INSERT INTO public.agent_branches (
      branch_id, workspace_id, user_id, schema_version, object_kind,
      object_id, base_version_id, status, created_at, updated_at
    ) VALUES (
      'branch-invalid-status', 'workspace-a', 'user-a', 'workbench-v1',
      'skill_draft', 'skill-invalid', 'version-a', 'unknown', $1, $1
    )
  `, [NOW], "23514", "agent_branches_status");
}

async function assertCapacityAuthorityMismatches(pool) {
  const cases = [
    {
      name: "lease",
      overrides: { capacityLeaseId: "capacity-missing" },
    },
    {
      name: "admission",
      overrides: { capacityAdmissionId: "admission-missing" },
    },
    {
      name: "fence",
      overrides: { capacityFence: 99 },
    },
    {
      name: "tenant",
      overrides: {
        workspaceId: "workspace-b",
        actorUserId: "user-b",
        productCommandId: "command-b",
        lineageSessionId: "session-b",
        lineageTurnId: "turn-b",
      },
    },
    {
      name: "command",
      overrides: {
        productCommandId: "command-c",
        lineageSessionId: "session-a",
        lineageTurnId: "turn-c",
      },
    },
    {
      name: "backend",
      overrides: {
        mode: "model_call",
        capacityBackendKey: "model_call:process",
      },
    },
    {
      name: "provider",
      overrides: { capacityProviderKey: "provider:other" },
    },
  ];

  for (const { name, overrides } of cases) {
    await expectConstraint(pool, invocationInsert({
      invocationId: `invocation-capacity-wrong-${name}`,
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-a",
      lineageSessionId: "session-a",
      lineageTurnId: "turn-a",
      attemptId: `attempt-capacity-wrong-${name}`,
      capabilityLeaseId: `capability-capacity-wrong-${name}`,
      ...overrides,
    }), [NOW], "23503", "execution_invocations_capacity_authority_fk");
  }
}

async function assertParentInvocationAuthority(pool) {
  const legalChild = await pool.query(`
    SELECT parent_invocation_id, product_command_id, lineage_session_id,
           lineage_turn_id, controller_kind, controller_id, controller_fence
      FROM public.execution_invocations
     WHERE invocation_id = 'invocation-child-a'
  `);
  assert.deepEqual(legalChild.rows, [{
    parent_invocation_id: "invocation-a",
    product_command_id: "command-a",
    lineage_session_id: "session-a",
    lineage_turn_id: "turn-a",
    controller_kind: "agent_turn",
    controller_id: "turn-a",
    controller_fence: 1,
  }]);

  const mismatches = [
    {
      name: "command",
      overrides: {
        productCommandId: "command-c",
        lineageSessionId: "session-a",
        lineageTurnId: "turn-c",
        capacityAdmissionId: "admission-c",
        capacityLeaseId: "capacity-c",
        controllerId: "turn-a",
      },
    },
    {
      name: "session",
      overrides: {
        productCommandId: "command-d",
        lineageSessionId: "session-a-2",
        lineageTurnId: "turn-d",
        capacityAdmissionId: "admission-d",
        capacityLeaseId: "capacity-session-a-2",
        controllerId: "turn-a",
      },
    },
    {
      name: "controller",
      overrides: { controllerId: "controller-other" },
    },
    {
      name: "controller-fence",
      overrides: { controllerFence: 2 },
    },
  ];

  for (const { name, overrides } of mismatches) {
    await expectConstraint(pool, invocationInsert({
      invocationId: `invocation-parent-wrong-${name}`,
      parentInvocationId: "invocation-a",
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-a",
      lineageSessionId: "session-a",
      lineageTurnId: "turn-a",
      attemptId: `attempt-parent-wrong-${name}`,
      capabilityLeaseId: `capability-parent-wrong-${name}`,
      ...overrides,
    }), [NOW], "23503", "execution_invocations_parent_authority_fk");
  }

  await expectConstraint(pool, invocationInsert({
    invocationId: "invocation-self-parent",
    parentInvocationId: "invocation-self-parent",
    workspaceId: "workspace-a",
    actorUserId: "user-a",
    productCommandId: "command-a",
    lineageSessionId: "session-a",
    lineageTurnId: "turn-a",
    attemptId: "attempt-self-parent",
    capabilityLeaseId: "capability-self-parent",
  }), [NOW], "23514", "execution_invocations_not_self_parent");
}

async function seedTenants(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES
      ('user-a', 'workbench-v1', 'User A', $1, $1),
      ('user-b', 'workbench-v1', 'User B', $1, $1)
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES
      ('workspace-a', 'workbench-v1', 'Workspace A', 'user-a', $1, $1),
      ('workspace-b', 'workbench-v1', 'Workspace B', 'user-b', $1, $1)
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES
      ('membership-a', 'workspace-a', 'user-a', 'workbench-v1', 'owner', $1, $1),
      ('membership-b', 'workspace-b', 'user-b', 'workbench-v1', 'owner', $1, $1)
  `, [NOW]);
  await seedPersonalAuthority(pool, {
    workspaceId: "workspace-a",
    userId: "user-a",
    membershipId: "membership-a",
  });
  await seedPersonalAuthority(pool, {
    workspaceId: "workspace-b",
    userId: "user-b",
    membershipId: "membership-b",
  });
  await seedWorkspaceModel(pool, {
    workspaceId: "workspace-a",
    scopeId: "workspace-a-personal",
    userId: "user-a",
    profileId: "model-profile-a",
    revisionId: "model-revision-a",
    bindingId: "model-secret-a",
  });
  await seedWorkspaceModel(pool, {
    workspaceId: "workspace-b",
    scopeId: "workspace-b-personal",
    userId: "user-b",
    profileId: "model-profile-b",
    revisionId: "model-revision-b",
    bindingId: "model-secret-b",
  });
  await pool.query(`
    INSERT INTO public.agent_sessions (
      session_id, workspace_id, user_id, schema_version, definition_id,
      scope_kind, source_kind, title, task_status, status,
      model_preference_state, created_at, updated_at
    ) VALUES
      ('session-a', 'workspace-a', 'user-a', 'workbench-v1', 'main',
        'main', 'manual', 'Session A', 'idle', 'active', 'preference_only', $1, $1),
      ('session-a-2', 'workspace-a', 'user-a', 'workbench-v1', 'main',
        'main', 'manual', 'Session A2', 'idle', 'active', 'preference_only', $1, $1),
      ('session-b', 'workspace-b', 'user-b', 'workbench-v1', 'main',
        'main', 'manual', 'Session B', 'idle', 'active', 'preference_only', $1, $1)
  `, [NOW]);
  for (const command of [
    ["command-a", "workspace-a", "user-a", "agent_turn", "session-a", "turn-a", null],
    ["command-cancel-a", "workspace-a", "user-a", "cancel_agent_turn", "session-a", "turn-a", "command-a"],
    ["command-b", "workspace-b", "user-b", "agent_turn", "session-b", "turn-b", null],
    ["command-c", "workspace-a", "user-a", "agent_turn", "session-a", "turn-c", null],
    ["command-d", "workspace-a", "user-a", "agent_turn", "session-a-2", "turn-d", null],
    ["command-cross", "workspace-b", "user-b", "agent_turn", "session-a", "turn-cross", null],
    ["command-cancel-cross", "workspace-b", "user-b", "cancel_agent_turn", "session-b", "turn-b", "command-b"],
  ]) {
    await insertAuthorizedProductCommand(pool, {
      commandId: command[0], workspaceId: command[1], userId: command[2], kind: command[3],
      sessionId: command[4], turnId: command[5], targetCommandId: command[6],
    });
  }
  await pool.query(`
    INSERT INTO public.admission_waiting (
      admission_id, command_id, workspace_id, schema_version, kind,
      invocation_id, state, created_at, updated_at
    ) VALUES
      ('admission-a', 'command-a', 'workspace-a', 'workbench-v1',
        'execution_invocation', 'capacity-slot-a', 'waiting_capacity', $1, $1),
      ('admission-c', 'command-c', 'workspace-a', 'workbench-v1',
        'execution_invocation', 'capacity-slot-c', 'waiting_capacity', $1, $1),
      ('admission-d', 'command-d', 'workspace-a', 'workbench-v1',
        'execution_invocation', 'capacity-slot-d', 'waiting_capacity', $1, $1)
  `, [NOW]);
}

async function seedWorkspaceModel(pool, {
  workspaceId, scopeId, userId, profileId, revisionId, bindingId,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.model_profiles (
        profile_id, workspace_id, scope_id, schema_version, profile_scope,
        display_name, current_revision_id, current_revision_number,
        created_by_principal_id, created_by_principal_kind, created_at, updated_at
      ) VALUES ($1, $2, $3, 'workbench-model-catalog-v1', 'workspace',
        $7, $4, 1, $5, 'user', $6, $6)
    `, [profileId, workspaceId, scopeId, revisionId, userId, NOW, profileId]);
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref,
        store_binding_revision, credential_fingerprint, status,
        created_by_principal_id, created_by_principal_kind,
        probed_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'workbench-secret-binding-v1',
        'model_profile_revision', $4, 'cloud_secret_store', $5,
        1, $6, 'active', $7, 'user', $8, $8, $8
      )
    `, [
      workspaceId, bindingId, scopeId, revisionId, `${bindingId}-store`,
      HASH, userId, NOW,
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
        'openai', 'openai_compatible_chat', 'gpt-test', ARRAY['chat'],
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '1.0.0', '1.0.0', $4, $5, $6, $7, 'user', $8
      )
    `, [revisionId, workspaceId, profileId, HASH, `${profileId}-deployment`, bindingId, userId, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedCapacityAuthorities(pool) {
  await pool.query(`
    INSERT INTO public.capacity_leases (
      capacity_lease_id, admission_id, command_id, workspace_id,
      schema_version, backend_key, provider_key, fence, lease_duration_ms,
      status, issued_at, expires_at, updated_at, dimensions
    ) VALUES
      ('capacity-a', 'admission-a', 'command-a', 'workspace-a',
        'workbench-v1', 'bounded_agent:process', 'provider:none', 1, 60000,
        'active', $1, $2, $1, '[]'::jsonb),
      ('capacity-reservation-b', 'admission-a', 'command-a', 'workspace-a',
        'workbench-v1', 'bounded_agent:process', 'provider:none', 2, 60000,
        'active', $1, $2, $1, '[]'::jsonb),
      ('capacity-child-a', 'admission-a', 'command-a', 'workspace-a',
        'workbench-v1', 'bounded_agent:process', 'provider:none', 4, 60000,
        'active', $1, $2, $1, '[]'::jsonb),
      ('capacity-c', 'admission-c', 'command-c', 'workspace-a',
        'workbench-v1', 'bounded_agent:process', 'provider:none', 1, 60000,
        'active', $1, $2, $1, '[]'::jsonb),
      ('capacity-session-a-2', 'admission-d', 'command-d', 'workspace-a',
        'workbench-v1', 'bounded_agent:process', 'provider:none', 1, 60000,
        'active', $1, $2, $1, '[]'::jsonb)
  `, [NOW, LATER]);
}

async function seedExecutionAuthority(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(invocationInsert({
      invocationId: "invocation-a",
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-a",
      lineageSessionId: "session-a",
      lineageTurnId: "turn-a",
      attemptId: "attempt-a",
      capabilityLeaseId: "capability-a",
    }), [NOW]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number, status,
        fence, created_at, updated_at
      ) VALUES (
        'attempt-a', 'invocation-a', 'workbench-execution-fabric-v1', 1,
        'queued', 1, $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, updated_at
      ) VALUES (
        'capability-a', 'invocation-a', 'attempt-a', 'workspace-a',
        'workbench-execution-fabric-v1', 1, 'active', $1, $2, $1
      )
    `, [NOW, LATER]);
    await client.query(invocationInsert({
      invocationId: "invocation-child-a",
      parentInvocationId: "invocation-a",
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-a",
      lineageSessionId: "session-a",
      lineageTurnId: "turn-a",
      attemptId: "attempt-child-a",
      capabilityLeaseId: "capability-child-a",
      capacityLeaseId: "capacity-child-a",
      capacityFence: 4,
    }), [NOW]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number, status,
        fence, created_at, updated_at
      ) VALUES (
        'attempt-child-a', 'invocation-child-a',
        'workbench-execution-fabric-v1', 1, 'queued', 1, $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, updated_at
      ) VALUES (
        'capability-child-a', 'invocation-child-a', 'attempt-child-a', 'workspace-a',
        'workbench-execution-fabric-v1', 1, 'active', $1, $2, $1
      )
    `, [NOW, LATER]);
    await client.query(invocationInsert({
      invocationId: "invocation-reservation-b",
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-a",
      lineageSessionId: "session-a",
      lineageTurnId: "turn-a",
      attemptId: "attempt-reservation-b",
      capabilityLeaseId: "capability-reservation-b",
      capacityLeaseId: "capacity-reservation-b",
      capacityFence: 2,
    }), [NOW]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number, status,
        fence, created_at, updated_at
      ) VALUES (
        'attempt-reservation-b', 'invocation-reservation-b',
        'workbench-execution-fabric-v1', 1, 'queued', 1, $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, updated_at
      ) VALUES (
        'capability-reservation-b', 'invocation-reservation-b',
        'attempt-reservation-b', 'workspace-a',
        'workbench-execution-fabric-v1', 1, 'active', $1, $2, $1
      )
    `, [NOW, LATER]);
    await client.query(invocationInsert({
      invocationId: "invocation-session-a-2",
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-d",
      lineageSessionId: "session-a-2",
      lineageTurnId: "turn-d",
      attemptId: "attempt-session-a-2",
      capabilityLeaseId: "capability-session-a-2",
      capacityAdmissionId: "admission-d",
      capacityLeaseId: "capacity-session-a-2",
    }), [NOW]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number, status,
        fence, created_at, updated_at
      ) VALUES (
        'attempt-session-a-2', 'invocation-session-a-2',
        'workbench-execution-fabric-v1', 1, 'queued', 1, $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, updated_at
      ) VALUES (
        'capability-session-a-2', 'invocation-session-a-2',
        'attempt-session-a-2', 'workspace-a',
        'workbench-execution-fabric-v1', 1, 'active', $1, $2, $1
      )
    `, [NOW, LATER]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function expectCapabilityAuthorityMismatch(pool) {
  const client = await pool.connect();
  let caught = null;
  try {
    await client.query("BEGIN");
    await client.query(invocationInsert({
      invocationId: "invocation-wrong-lease",
      workspaceId: "workspace-a",
      actorUserId: "user-a",
      productCommandId: "command-a",
      lineageSessionId: "session-a",
      lineageTurnId: "turn-a",
      attemptId: "attempt-wrong-lease",
      capabilityLeaseId: "capability-a",
    }), [NOW]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number, status,
        fence, created_at, updated_at
      ) VALUES (
        'attempt-wrong-lease', 'invocation-wrong-lease',
        'workbench-execution-fabric-v1', 1, 'queued', 1, $1, $1
      )
    `, [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    caught = error;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(caught?.code, "23503");
  assert.equal(caught?.constraint, "execution_invocations_capability_authority_fk");
}

function invocationInsert({
  invocationId,
  parentInvocationId = null,
  workspaceId,
  actorUserId,
  productCommandId,
  lineageSessionId,
  lineageTurnId,
  attemptId,
  capabilityLeaseId,
  capacityAdmissionId = "admission-a",
  capacityLeaseId = "capacity-a",
  capacityFence = 1,
  capacityBackendKey = "bounded_agent:process",
  capacityProviderKey = "provider:none",
  mode = "bounded_agent",
  isolation = "process",
  controllerKind = "agent_turn",
  controllerId = lineageTurnId,
  controllerFence = 1,
}) {
  const parentValue = parentInvocationId === null ? "NULL" : `'${parentInvocationId}'`;
  return `
    INSERT INTO public.execution_invocations (
      invocation_id, workspace_id, schema_version, attempt_id, parent_invocation_id,
      product_command_id, lineage_session_id, lineage_turn_id,
      controller_kind, controller_id, controller_fence, mode, isolation, status,
      execution_fence, capacity_admission_id, capacity_lease_id, capacity_fence,
      capacity_backend_key, capacity_provider_key, capability_lease_id,
      created_at, updated_at
    ) VALUES (
      '${invocationId}', '${workspaceId}', 'workbench-execution-fabric-v1', '${attemptId}',
      ${parentValue},
      '${productCommandId}', '${lineageSessionId}', '${lineageTurnId}',
      '${controllerKind}', '${controllerId}', ${controllerFence}, '${mode}', '${isolation}', 'queued',
      1, '${capacityAdmissionId}', '${capacityLeaseId}', ${capacityFence},
      '${capacityBackendKey}', '${capacityProviderKey}', '${capabilityLeaseId}',
      $1, $1
    )
  `;
}

function effectInsert({ effectId, argumentDigest, status, dispatchStartedAt = null }) {
  return `
    INSERT INTO public.external_effect_receipts (
      workspace_id, effect_id, schema_version, invocation_id, attempt_id,
      controller_id, connection_id, action, argument_digest, status, dispatch_started_at,
      created_at, updated_at
    ) VALUES (
      'workspace-a', '${effectId}', 'workbench-internal-v1', 'invocation-a', 'attempt-a',
      'turn-a', 'connection-a', 'lark.task.create', '${argumentDigest}', '${status}',
      ${dispatchStartedAt ? "$1" : "NULL"}, $1, $1
    )
  `;
}

async function seedPersonalAuthority(pool, { workspaceId, userId, membershipId }) {
  const scopeId = `${workspaceId}-personal`;
  const policyRevisionId = `${workspaceId}-policy-1`;
  const scopeGrantId = `${workspaceId}-operation`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, user_id, membership_id,
        created_at, updated_at
      ) VALUES ($1, $2, 'user', $2, $3, $4, $4)
    `, [workspaceId, userId, membershipId, NOW]);
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id,
        owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind, creation_mode,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'personal', $3, $3, $4, $3, 'user',
        'workspace_initial_seed', $5, $5
      )
    `, [workspaceId, scopeId, userId, policyRevisionId, NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES ($1, $2, $3, 1, 'private', 'interactive', $4, $5, 'user', $6)
    `, [workspaceId, scopeId, policyRevisionId, HASH, userId, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, granted_by_principal_id, granted_by_principal_kind,
        can_approve, issuance_kind, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'user', 'operation', $4, 'user',
        true, 'scope_creation', $5, $5
      )
    `, [workspaceId, scopeId, scopeGrantId, userId, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertAuthorizedProductCommand(pool, {
  commandId, workspaceId, userId, kind, sessionId, turnId, targetCommandId,
}) {
  const scopeId = `${workspaceId}-personal`;
  const policyRevisionId = `${workspaceId}-policy-1`;
  const scopeGrantId = `${workspaceId}-operation`;
  const decisionId = `${commandId}-decision`;
  const approvalId = `${commandId}-approval`;
  await pool.query(`
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
      'principal', $5, 'user', $6, $7, 'write_local', $8,
      'interactive', 'authority-v1', 'approval_required', $2,
      'approval_required', $9, $10
    )
  `, [
    workspaceId, approvalId, scopeId, policyRevisionId, userId, scopeGrantId,
    kind, HASH, NOW, LATER,
  ]);
  await pool.query(`
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
      'principal', $5, 'user', $6, $7, 'write_local', $8,
      'interactive', 'authority-v1', 'authorized', $9, 'approved', $10, $11
    )
  `, [
    workspaceId, decisionId, scopeId, policyRevisionId, userId, scopeGrantId,
    kind, HASH, approvalId, NOW, LATER,
  ]);
  await pool.query(`
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind, authorization_decision_id,
      policy_revision_id, effect_class, argument_digest, quota_user_id,
      schema_version, kind, session_id, turn_id,
      target_command_id, status, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, 'user', $4, 'user', $5, $6,
      'write_local', $7, $4, 'workbench-v1', $8, $9, $10, $11,
      'accepted', $12, $12
    )
  `, [
    commandId, workspaceId, scopeId, userId, decisionId, policyRevisionId,
    HASH, kind, sessionId, turnId, targetCommandId, NOW,
  ]);
}

async function expectDeferredConstraint(pool, sql, values, constraint) {
  const client = await pool.connect();
  let caught = null;
  try {
    await client.query("BEGIN");
    await client.query(sql, values);
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`);
    await client.query("COMMIT");
  } catch (error) {
    caught = error;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(caught?.code, "23503");
  assert.equal(caught?.constraint, constraint);
}

async function expectConstraint(pool, sql, values, code, constraint) {
  await assert.rejects(
    pool.query(sql, values),
    (error) => error?.code === code && error?.constraint === constraint,
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required when PostgreSQL integration is enabled`);
  return value;
}
