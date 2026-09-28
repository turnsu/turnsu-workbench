import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const NOW = new Date(Date.now() - 30_000).toISOString();
const BEFORE = new Date(Date.now() - 2 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60 * 60_000).toISOString();
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();
const DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"c".repeat(64)}`;

const W = "b4a-workspace";
const SCOPE_A = "b4a-scope-a";
const SCOPE_B = "b4a-scope-b";
const POLICY_A = "b4a-policy-a-1";
const POLICY_B = "b4a-policy-b-1";
const GRANT_A = "b4a-grant-a";
const GRANT_B = "b4a-grant-b";
const GRANT_B_ON_A = "b4a-grant-b-on-a";
const GRANT_AUTO = "b4a-grant-auto";

test("PostgreSQL B4A binds decisions, commands, grants and product roots without ABA authority", {
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
  await seedAuthorityFoundation(pool);
  await seedIssuedGrants(pool);
  await assertSystemSeedAuthority(pool);
  await assertApprovalSelfLineage(pool);
  await assertCommandDigestAndTargetAuthority(pool);
  await assertObjectScopeAndIndependentActor(pool);
  await assertSpecialTargetContracts(pool);
  await assertAutomationBuilderCreator(pool);
  await assertDownstreamCommandIdentity(pool);
  await assertUnlineagedGrantDenials(pool);
  await assertRevisionAndConcurrentRevoke(pool);
});

async function seedAuthorityFoundation(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES
      ('b4a-user-a', 'workbench-v1', 'A', $1, $1),
      ('b4a-user-b', 'workbench-v1', 'B', $1, $1)
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'B4A', 'b4a-user-a', $2, $2)
  `, [W, NOW]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES
      ('b4a-member-a', $1, 'b4a-user-a', 'workbench-v1', 'owner', $2, $2),
      ('b4a-member-b', $1, 'b4a-user-b', 'workbench-v1', 'member', $2, $2)
  `, [W, NOW]);
  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id, membership_id,
      created_at, updated_at
    ) VALUES
      ($1, 'b4a-user-a', 'user', 'b4a-user-a', 'b4a-member-a', $2, $2),
      ($1, 'b4a-user-b', 'user', 'b4a-user-b', 'b4a-member-b', $2, $2),
      ($1, 'b4a-automation', 'automation', NULL, NULL, $2, $2),
      ($1, 'b4a-contract-subject', 'connector', NULL, NULL, $2, $2)
  `, [W, NOW]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id,
        owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind, creation_mode,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'personal', 'b4a-user-a', 'b4a-user-a', $3,
        'b4a-user-a', 'user', 'workspace_initial_seed', $4, $4
      )
    `, [W, SCOPE_A, POLICY_A, NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, 1, 'private', 'interactive', $4,
        'b4a-user-a', 'user', $5
      )
    `, [W, SCOPE_A, POLICY_A, DIGEST, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind, issuance_kind,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'b4a-user-a', 'user', 'operation',
        ARRAY['object.manage_access']::text[], true,
        'b4a-user-a', 'user', 'scope_creation', $4, $4
      )
    `, [W, SCOPE_A, GRANT_A, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

}

async function seedIssuedGrants(pool) {
  await issueScopeGrant(pool, {
    grantId: GRANT_B_ON_A,
    subjectId: "b4a-user-b",
    subjectKind: "user",
  });
  await createSecondUserScope(pool);
  await issueScopeGrant(pool, {
    grantId: GRANT_AUTO,
    subjectId: "b4a-automation",
    subjectKind: "automation",
  });

  const commandId = "b4a-policy-grant-command";
  const decisionId = `${commandId}-decision`;
  const targetContractSql = policyGrantContractSql();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, {
      decisionId,
      scopeId: SCOPE_A,
      policyId: POLICY_A,
      actorId: "b4a-user-a",
      actorKind: "user",
      actorGrantId: GRANT_A,
      effectiveId: "b4a-user-a",
      effectiveKind: "user",
      effectiveGrantId: GRANT_A,
      authorizerId: "b4a-user-a",
      authorizerKind: "user",
      authorizerGrantId: GRANT_A,
      actionId: "policy_grant_issue",
      effectClass: "administrative",
      targetContractSql,
    });
    await insertCommand(client, {
      commandId,
      decisionId,
      scopeId: SCOPE_A,
      policyId: POLICY_A,
      actorId: "b4a-user-a",
      actorKind: "user",
      effectiveId: "b4a-user-a",
      effectiveKind: "user",
      kind: "policy_grant_issue",
      effectClass: "administrative",
      targetKind: "policy_grant",
      targetId: "b4a-policy-grant-auto",
      targetRevision: 1,
      targetContractSql,
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
        $1, $2, 'b4a-policy-grant-auto', 'b4a-automation', 'automation', $3,
        $4, 'b4a-user-a', 'user', $5, $6, $7, $8,
        'active', $9, $10, $10
      )
    `, [W, SCOPE_A, GRANT_AUTO, POLICY_A, GRANT_A, commandId, decisionId, DIGEST, LATER, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function issueScopeGrant(pool, { grantId, subjectId, subjectKind }) {
  const commandId = `${grantId}-command`;
  const decisionId = `${grantId}-decision`;
  const targetContractSql = scopeGrantContractSql({
    grantId, subjectId, subjectKind,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, {
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-a",
    actorKind: "user",
    actorGrantId: GRANT_A,
    effectiveId: "b4a-user-a",
    effectiveKind: "user",
    effectiveGrantId: GRANT_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "scope_principal_grant_issue",
    effectClass: "administrative",
    targetContractSql,
    });
    await insertCommand(client, {
    commandId,
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-a",
    actorKind: "user",
    effectiveId: "b4a-user-a",
    effectiveKind: "user",
    kind: "scope_principal_grant_issue",
    effectClass: "administrative",
      targetKind: "scope_principal_grant",
      targetId: grantId,
      targetRevision: 1,
      targetContractSql,
    });
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'operation', ARRAY[]::text[], false,
        'b4a-user-a', 'user', 'command', $2, $6, $7, $8, $9, $9
      )
    `, [W, SCOPE_A, grantId, subjectId, subjectKind, commandId, decisionId, DIGEST, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recoverScopeGrant(pool, grantId, {
  capabilities = [],
  canApprove = true,
} = {}) {
  const commandId = `${grantId}-command`;
  const decisionId = `${grantId}-decision`;
  const targetContractSql = scopeGrantContractSql({
    scopeId: SCOPE_B,
    grantId,
    subjectId: "b4a-user-b",
    subjectKind: "user",
    capabilities,
    canApprove,
    issuanceKind: "membership_recovery",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, standardDecision({
      decisionId,
      actionId: "scope_principal_grant_issue",
      effectClass: "administrative",
      targetContractSql,
    }));
    await insertCommand(client, standardCommand({
      commandId,
      decisionId,
      kind: "scope_principal_grant_issue",
      effectClass: "administrative",
      targetKind: "scope_principal_grant",
      targetId: grantId,
      targetRevision: 1,
      targetContractSql,
    }));
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'b4a-user-b', 'user', 'operation',
        ARRAY[${capabilities.map((value) => `'${value}'`).join(", ")}]::text[], ${canApprove},
        'b4a-user-a', 'user', 'membership_recovery', $4, $5, $6, $7, $8, $8
      )
    `, [W, SCOPE_B, grantId, SCOPE_A, commandId, decisionId, DIGEST, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertSystemSeedAuthority(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES ('system-catalog', 'workbench-v1', 'System Catalog', $1, $1)
    ON CONFLICT (user_id) DO NOTHING
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES (
      'system-catalog', 'workbench-v1', 'System Catalog', 'system-catalog', $1, $1
    )
  `, [NOW]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, created_at, updated_at
      ) VALUES ('system-catalog', 'system-catalog', 'system', $1, $1)
    `, [NOW]);
    await client.query(`
      INSERT INTO public.skill_system_catalog_principals (
        principal_id, product_user_id, schema_version, status, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'workbench-v1', 'enabled', $1, $1
      )
      ON CONFLICT (principal_id) DO UPDATE
      SET status = 'enabled', updated_at = EXCLUDED.updated_at
    `, [NOW]);
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, project_id,
        current_policy_revision_id, created_by_principal_id,
        created_by_principal_kind, creation_mode, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'workbench-v1', 'project',
        'system-catalog', 'system-catalog-policy-1', 'system-catalog',
        'system', 'system_initial_seed', $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'system-catalog-policy-1', 1,
        'observation_disabled', 'interactive', $1,
        'system-catalog', 'system', $2
      )
    `, [DIGEST, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, can_approve, granted_by_principal_id,
        granted_by_principal_kind, issuance_kind, created_at, updated_at
      ) VALUES (
        'system-catalog', 'system-catalog', 'system-catalog-initial-grant',
        'system-catalog', 'system', 'operation', true,
        'system-catalog', 'system', 'scope_creation', $1, $1
      )
    `, [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await pool.query(`
    INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, created_at, updated_at
    ) VALUES ($1, 'system-catalog', 'system', $2, $2)
  `, [W, NOW]);
  await expectConstraint(pool, `
    INSERT INTO public.product_scopes (
      workspace_id, scope_id, schema_version, scope_kind, project_id,
      current_policy_revision_id, created_by_principal_id,
      created_by_principal_kind, creation_mode, created_at, updated_at
    ) VALUES (
      $1, 'system-catalog', 'workbench-v1', 'project', 'system-catalog',
      'forged-system-policy', 'system-catalog', 'system',
      'system_initial_seed', $2, $2
    )
  `, [W, NOW], "23514", "product_scopes_system_seed_shape");
  await expectConstraint(pool, `
    INSERT INTO public.product_scopes (
      workspace_id, scope_id, schema_version, scope_kind, project_id,
      current_policy_revision_id, created_by_principal_id,
      created_by_principal_kind, creation_mode, created_at, updated_at
    ) VALUES (
      'system-catalog', 'system-catalog', 'workbench-v1', 'project',
      'system-catalog', 'another-system-policy', 'system-catalog',
      'system', 'system_initial_seed', $1, $1
    )
  `, [NOW], "23505", "product_scopes_pkey");
}

async function createSecondUserScope(pool) {
  const commandId = "b4a-scope-b-create-command";
  const decisionId = "b4a-scope-b-create-decision";
  const targetContractSql = scopeCreateContractSql();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, {
      decisionId,
      scopeId: SCOPE_A,
      policyId: POLICY_A,
      actorId: "b4a-user-a",
      actorKind: "user",
      actorGrantId: GRANT_A,
      effectiveId: "b4a-user-b",
      effectiveKind: "user",
      effectiveGrantId: GRANT_B_ON_A,
      authorizerId: "b4a-user-a",
      authorizerKind: "user",
      authorizerGrantId: GRANT_A,
      actionId: "scope_create",
      effectClass: "administrative",
      targetContractSql,
    });
    await insertCommand(client, {
      commandId,
      decisionId,
      scopeId: SCOPE_A,
      policyId: POLICY_A,
      actorId: "b4a-user-a",
      actorKind: "user",
      effectiveId: "b4a-user-b",
      effectiveKind: "user",
      quotaUserId: "b4a-user-b",
      kind: "scope_create",
      effectClass: "administrative",
      targetKind: "product_scope",
      targetId: SCOPE_B,
      targetRevision: 1,
      targetContractSql,
    });
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id,
        owner_principal_id, current_policy_revision_id,
        created_by_principal_id, created_by_principal_kind,
        creation_mode, creation_command_id, creation_authority_scope_id,
        created_at, updated_at
      ) VALUES (
        $1, $2, 'workbench-v1', 'personal', 'b4a-user-b', 'b4a-user-b', $3,
        'b4a-user-b', 'user', 'command', $4, $5, $6, $6
      )
    `, [W, SCOPE_B, POLICY_B, commandId, SCOPE_A, NOW]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, policy_content_hash, created_by_principal_id,
        created_by_principal_kind, created_at
      ) VALUES (
        $1, $2, $3, 1, 'private', 'interactive', $4,
        'b4a-user-b', 'user', $5
      )
    `, [W, SCOPE_B, POLICY_B, DIGEST, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'b4a-user-b', 'user', 'operation', ARRAY[]::text[], true,
        'b4a-user-b', 'user', 'scope_creation', $4, $5, $6, $7, $8, $8
      )
    `, [W, SCOPE_B, GRANT_B, SCOPE_A, commandId, decisionId, DIGEST, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertApprovalSelfLineage(pool) {
  const decisionId = "b4a-approved-by-a-for-b";
  await insertApprovalPair(pool, {
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: GRANT_B_ON_A,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: GRANT_B_ON_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "skill_validation",
    effectClass: "execute",
  });
  const rows = await pool.query(`
    SELECT authorization_decision_id, disposition, approval_id,
           effective_principal_id, authorizer_principal_id
    FROM public.authorization_decisions
    WHERE workspace_id = $1 AND authorization_decision_id IN ($2, $3)
    ORDER BY disposition
  `, [W, decisionId, `${decisionId}-request`]);
  assert.equal(rows.rowCount, 2);
  const approved = rows.rows.find((row) => row.disposition === "authorized");
  const requested = rows.rows.find((row) => row.disposition === "approval_required");
  assert.equal(requested.approval_id, requested.authorization_decision_id);
  assert.equal(approved.approval_id, requested.authorization_decision_id);
  assert.equal(approved.effective_principal_id, "b4a-user-b");
  assert.equal(approved.authorizer_principal_id, "b4a-user-a");

  await expectDatabaseError(pool, authorizationDecisionSql({
    decisionId: "b4a-approval-actor-mismatch",
    approvalId: `${decisionId}-request`,
    actorId: "b4a-user-a",
    actorKind: "user",
    actorGrantId: GRANT_A,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: GRANT_B_ON_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
  }), [], "P0001", "authorization_approval_request_invalid");

  await expectConstraint(pool, authorizationDecisionSql({
    decisionId: "b4a-approval-replay",
    approvalId: `${decisionId}-request`,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: GRANT_B_ON_A,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: GRANT_B_ON_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
  }), [], "23505", "authorization_decisions_one_final_per_approval_uq");

  await expectDatabaseError(pool, authorizationDecisionSql({
    decisionId: "b4a-arbitrary-approval",
    approvalId: "not-a-real-approval",
    argumentDigest: DIGEST,
  }), [], "P0001", "authorization_approval_request_invalid");

  await insertApprovalRequest(pool, {
    decisionId: "b4a-wrong-digest-request",
    argumentDigest: DIGEST,
  });
  await expectDatabaseError(pool, authorizationDecisionSql({
    decisionId: "b4a-wrong-digest-final",
    approvalId: "b4a-wrong-digest-request",
    argumentDigest: OTHER_DIGEST,
  }), [], "P0001", "authorization_approval_request_invalid");

  await expectDatabaseError(pool, authorizationDecisionSql({
    decisionId: "b4a-expired-request",
    disposition: "approval_required",
    approvalId: "b4a-expired-request",
    expiresAt: PAST,
  }), [], "P0001", "authorization_decision_expired");
}

async function assertCommandDigestAndTargetAuthority(pool) {
  const targetDecision = "b4a-target-decision";
  await insertApprovalPair(pool, standardDecision({
    decisionId: targetDecision,
    actionId: "agent_turn",
    effectClass: "execute",
  }));
  await insertCommand(pool, standardCommand({
    commandId: "b4a-target-command",
    decisionId: targetDecision,
    kind: "agent_turn",
    effectClass: "execute",
    sessionId: "b4a-session",
    turnId: "b4a-turn",
  }));
  const actorMismatchDecision = "b4a-ordinary-actor-mismatch-decision";
  await insertApprovalPair(pool, standardDecision({
    decisionId: actorMismatchDecision,
    actionId: "agent_turn",
    effectClass: "execute",
  }));
  await expectConstraint(pool, commandSql(standardCommand({
    commandId: "b4a-ordinary-actor-mismatch",
    decisionId: actorMismatchDecision,
    actorId: "b4a-user-b",
    actorKind: "user",
    kind: "agent_turn",
    effectClass: "execute",
    sessionId: "b4a-ordinary-mismatch-session",
    turnId: "b4a-ordinary-mismatch-turn",
  })), [], "23503", "product_commands_decision_fk");
  const scopeMismatchDecision = "b4a-ordinary-scope-mismatch-decision";
  await insertApprovalPair(pool, standardDecision({
    decisionId: scopeMismatchDecision,
    actionId: "agent_turn",
    effectClass: "execute",
  }));
  await expectConstraint(pool, commandSql(standardCommand({
    commandId: "b4a-ordinary-scope-mismatch",
    decisionId: scopeMismatchDecision,
    scopeId: SCOPE_B,
    kind: "agent_turn",
    effectClass: "execute",
    sessionId: "b4a-ordinary-scope-mismatch-session",
    turnId: "b4a-ordinary-scope-mismatch-turn",
  })), [], "23503", "product_commands_decision_fk");
  await expectConstraint(pool, commandSql(standardCommand({
    commandId: "b4a-second-command-for-decision",
    decisionId: targetDecision,
    kind: "agent_turn",
    effectClass: "execute",
    sessionId: "b4a-second-session",
    turnId: "b4a-second-turn",
  })), [], "23505", "product_commands_decision_consumption_uq");

  const cancelDecision = "b4a-cancel-decision";
  await insertApprovalPair(pool, {
    decisionId: cancelDecision,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: GRANT_B_ON_A,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: GRANT_B_ON_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "cancel_agent_turn",
    effectClass: "write_local",
  });
  await insertCommand(pool, {
    commandId: "b4a-cross-user-cancel",
    decisionId: cancelDecision,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    quotaUserId: "b4a-user-b",
    kind: "cancel_agent_turn",
    effectClass: "write_local",
    sessionId: "b4a-session",
    turnId: "b4a-turn",
    targetCommandId: "b4a-target-command",
  });

  await expectDatabaseError(pool, commandSql(standardCommand({
    commandId: "b4a-wrong-digest-command",
    decisionId: targetDecision,
    kind: "agent_turn",
    effectClass: "execute",
    argumentDigest: OTHER_DIGEST,
    sessionId: "b4a-session-other",
    turnId: "b4a-turn-other",
  })), [], "P0001", "product_command_authority_inactive");

  const wrongKindDecision = "b4a-wrong-kind-decision";
  await insertApprovalPair(pool, standardDecision({
    decisionId: wrongKindDecision,
    actionId: "cancel_skill_test",
    effectClass: "write_local",
  }));
  await expectConstraint(pool, commandSql(standardCommand({
    commandId: "b4a-wrong-kind-cancel",
    decisionId: wrongKindDecision,
    kind: "cancel_skill_test",
    effectClass: "write_local",
    sessionId: "b4a-session",
    turnId: "b4a-turn",
    targetCommandId: "b4a-target-command",
  })), [], "23503", "product_commands_target_fk");

  const wrongTurnDecision = "b4a-wrong-turn-decision";
  await insertApprovalPair(pool, standardDecision({
    decisionId: wrongTurnDecision,
    actionId: "cancel_agent_turn",
    effectClass: "write_local",
  }));
  await expectConstraint(pool, commandSql(standardCommand({
    commandId: "b4a-wrong-turn-cancel",
    decisionId: wrongTurnDecision,
    kind: "cancel_agent_turn",
    effectClass: "write_local",
    sessionId: "b4a-session",
    turnId: "b4a-turn-wrong",
    targetCommandId: "b4a-target-command",
  })), [], "23503", "product_commands_target_fk");

  const wrongScopeDecision = "b4a-wrong-scope-decision";
  const scopeTargetDecision = "b4a-scope-target-decision";
  await insertApprovalPair(pool, standardDecision({
    decisionId: scopeTargetDecision,
    actionId: "agent_turn",
    effectClass: "execute",
  }));
  await insertCommand(pool, standardCommand({
    commandId: "b4a-scope-target-command",
    decisionId: scopeTargetDecision,
    kind: "agent_turn",
    effectClass: "execute",
    sessionId: "b4a-scope-session",
    turnId: "b4a-scope-turn",
  }));
  await insertApprovalPair(pool, {
    decisionId: wrongScopeDecision,
    scopeId: SCOPE_B,
    policyId: POLICY_B,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: GRANT_B,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: GRANT_B,
    authorizerId: "b4a-user-b",
    authorizerKind: "user",
    authorizerGrantId: GRANT_B,
    actionId: "cancel_agent_turn",
    effectClass: "write_local",
  });
  await expectConstraint(pool, commandSql({
    commandId: "b4a-wrong-scope-cancel",
    decisionId: wrongScopeDecision,
    scopeId: SCOPE_B,
    policyId: POLICY_B,
    actorId: "b4a-user-b",
    actorKind: "user",
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    quotaUserId: "b4a-user-b",
    kind: "cancel_agent_turn",
    effectClass: "write_local",
    sessionId: "b4a-scope-session",
    turnId: "b4a-scope-turn",
    targetCommandId: "b4a-scope-target-command",
  }), [], "23503", "product_commands_target_fk");

  await expectDatabaseError(pool, commandSql(standardCommand({
    commandId: "b4a-backdated-command",
    decisionId: targetDecision,
    kind: "agent_turn",
    effectClass: "execute",
    sessionId: "b4a-backdated-session",
    turnId: "b4a-backdated-turn",
    createdAt: BEFORE,
  })), [], "P0001", "product_command_authority_inactive");

  await expectDatabaseError(pool, `
    UPDATE public.product_commands SET argument_digest = '${OTHER_DIGEST}'
    WHERE command_id = 'b4a-target-command'
  `, [], "P0001", "product_command_authority_immutable");
  await expectDatabaseError(pool, `
    UPDATE public.product_commands SET payload = '{"forged":true}'::jsonb
    WHERE command_id = 'b4a-target-command'
  `, [], "P0001", "product_command_authority_immutable");
  await pool.query(`
    UPDATE public.product_commands SET status = 'running', updated_at = $1
    WHERE command_id = 'b4a-target-command'
  `, [new Date().toISOString()]);

  const orphanDecision = "b4a-orphan-special-decision";
  const orphanTargetContractSql = scopeGrantContractSql({
    grantId: "b4a-never-created-grant",
    subjectId: "b4a-user-b",
    subjectKind: "user",
  });
  await insertApprovalPair(pool, standardDecision({
    decisionId: orphanDecision,
    actionId: "scope_principal_grant_issue",
    effectClass: "administrative",
    targetContractSql: orphanTargetContractSql,
  }));
  await expectDatabaseError(pool, commandSql(standardCommand({
    commandId: "b4a-orphan-special-command",
    decisionId: orphanDecision,
    kind: "scope_principal_grant_issue",
    effectClass: "administrative",
    targetKind: "scope_principal_grant",
    targetId: "b4a-never-created-grant",
    targetRevision: 1,
    targetContractSql: orphanTargetContractSql,
  })), [], "23503", "product_command_special_target_missing");
}

async function assertObjectScopeAndIndependentActor(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.workflows (
        workspace_id, workflow_id, scope_id, owner_user_id, schema_version,
        name, description, status, lifecycle, visibility,
        current_revision_id, current_revision_number, created_at, updated_at
      ) VALUES (
        $1, 'b4a-workflow', $2, 'b4a-user-a', 'workbench-v1',
        'Workflow', '', 'draft', 'draft', 'private',
        'b4a-workflow-r1', 1, $3, $3
      )
    `, [W, SCOPE_A, NOW]);
    await client.query(`
      INSERT INTO public.workflow_revisions (
        workspace_id, revision_id, workflow_id, revision_number, schema_version,
        graph, input_form, output_definition, run_settings, content_hash,
        authored_by, save_reason, created_at, updated_at
      ) VALUES (
        $1, 'b4a-workflow-r1', 'b4a-workflow', 1, 'workbench-v1',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $2,
        'b4a-user-a', 'initial', $3, $3
      )
    `, [W, DIGEST, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const decisionId = "b4a-object-grant-decision";
  await insertObjectGrant(pool, {
    grantId: "b4a-object-grant",
    decisionId,
  });
  const projection = await pool.query(`
    SELECT c.actor_principal_id, c.effective_principal_id
    FROM public.object_access_grants g
    JOIN public.product_commands c
      ON c.workspace_id = g.workspace_id AND c.command_id = g.product_command_id
    WHERE g.workspace_id = $1 AND g.grant_id = 'b4a-object-grant'
  `, [W]);
  assert.deepEqual(projection.rows[0], {
    actor_principal_id: "b4a-automation",
    effective_principal_id: "b4a-user-a",
  });

  await expectObjectGrantFailure(pool, {
    grantId: "b4a-object-ghost",
    decisionId: "b4a-object-ghost-decision",
    objectId: "ghost",
  }, "object_access_grant_object_scope_mismatch");
  await expectObjectGrantFailure(pool, {
    grantId: "b4a-object-wrong-scope",
    decisionId: "b4a-object-wrong-scope-decision",
    grantScopeId: SCOPE_B,
  }, "object_access_grant_object_scope_mismatch");
  await expectDatabaseError(pool, `
    UPDATE public.workflows SET scope_id = '${SCOPE_B}'
    WHERE workspace_id = '${W}' AND workflow_id = 'b4a-workflow'
  `, [], "P0001", "product_root_scope_immutable");
}

async function assertSpecialTargetContracts(pool) {
  const nonCompletedContract = scopeGrantContractSql({
    grantId: "b4a-non-completed-grant",
    subjectId: "b4a-contract-subject",
    subjectKind: "connector",
  });
  await insertApprovalPair(pool, standardDecision({
    decisionId: "b4a-non-completed-decision",
    actionId: "scope_principal_grant_issue",
    effectClass: "administrative",
    targetContractSql: nonCompletedContract,
  }));
  await expectConstraint(pool, commandSql(standardCommand({
    commandId: "b4a-non-completed-command",
    decisionId: "b4a-non-completed-decision",
    kind: "scope_principal_grant_issue",
    effectClass: "administrative",
    targetKind: "scope_principal_grant",
    targetId: "b4a-non-completed-grant",
    targetRevision: 1,
    targetContractSql: nonCompletedContract,
    status: "accepted",
  })), [], "23514", "product_commands_special_completed");

  await expectSpecialTargetMismatch(pool, {
    suffix: "subject",
    actionId: "scope_principal_grant_issue",
    targetKind: "scope_principal_grant",
    targetId: "b4a-contract-subject-grant",
    targetContractSql: scopeGrantContractSql({
      grantId: "b4a-contract-subject-grant",
      subjectId: "b4a-user-b",
      subjectKind: "user",
    }),
    targetSql: `
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        '${W}', '${SCOPE_A}', 'b4a-contract-subject-grant',
        'b4a-contract-subject', 'connector', 'operation',
        'b4a-user-a', 'user', 'command', '${SCOPE_A}',
        'b4a-contract-subject-command', 'b4a-contract-subject-decision',
        '${DIGEST}', '${NOW}'::timestamptz, '${NOW}'::timestamptz
      )
    `,
  });

  await expectSpecialTargetMismatch(pool, {
    suffix: "capabilities",
    actionId: "scope_principal_grant_issue",
    targetKind: "scope_principal_grant",
    targetId: "b4a-contract-capabilities-grant",
    targetContractSql: scopeGrantContractSql({
      grantId: "b4a-contract-capabilities-grant",
      subjectId: "b4a-contract-subject",
      subjectKind: "connector",
      capabilities: ["object.execute"],
    }),
    targetSql: `
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities,
        granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        '${W}', '${SCOPE_A}', 'b4a-contract-capabilities-grant',
        'b4a-contract-subject', 'connector', 'operation', ARRAY[]::text[],
        'b4a-user-a', 'user', 'command', '${SCOPE_A}',
        'b4a-contract-capabilities-command', 'b4a-contract-capabilities-decision',
        '${DIGEST}', '${NOW}'::timestamptz, '${NOW}'::timestamptz
      )
    `,
  });

  await expectSpecialTargetMismatch(pool, {
    suffix: "role",
    actionId: "object_access_grant_issue",
    targetKind: "object_access_grant",
    targetId: "b4a-contract-role-grant",
    targetContractSql: `jsonb_build_object(
      'scopeId', '${SCOPE_A}', 'grantId', 'b4a-contract-role-grant',
      'objectKind', 'workflow', 'objectId', 'b4a-workflow',
      'subjectPrincipalId', 'b4a-contract-subject',
      'subjectPrincipalKind', 'connector', 'role', 'editor',
      'capabilities', to_jsonb(ARRAY['object.share']::text[]),
      'status', 'active'
    )`,
    targetSql: `
      INSERT INTO public.object_access_grants (
        workspace_id, grant_id, scope_id, object_kind, object_id,
        principal_id, principal_kind, role, capabilities,
        product_command_id, created_at, updated_at
      ) VALUES (
        '${W}', 'b4a-contract-role-grant', '${SCOPE_A}', 'workflow', 'b4a-workflow',
        'b4a-contract-subject', 'connector', 'viewer', ARRAY['object.share']::text[],
        'b4a-contract-role-command', '${NOW}'::timestamptz, '${NOW}'::timestamptz
      )
    `,
  });

  await expectSpecialTargetMismatch(pool, {
    suffix: "policy",
    actionId: "policy_grant_issue",
    targetKind: "policy_grant",
    targetId: "b4a-contract-policy-grant",
    targetContractSql: policyGrantContractSql({
      policyGrantId: "b4a-contract-policy-grant",
      subjectId: "b4a-user-b",
      subjectKind: "user",
      subjectGrantId: GRANT_B_ON_A,
      policyRevisionId: "forged-policy",
    }),
    targetSql: `
      INSERT INTO public.policy_grants (
        workspace_id, scope_id, policy_grant_id,
        subject_principal_id, subject_principal_kind, subject_scope_grant_id,
        policy_revision_id, authorized_by_principal_id, authorized_by_principal_kind,
        authorizer_scope_grant_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        status, expires_at, created_at, updated_at
      ) VALUES (
        '${W}', '${SCOPE_A}', 'b4a-contract-policy-grant',
        'b4a-user-b', 'user', '${GRANT_B_ON_A}', '${POLICY_A}',
        'b4a-user-a', 'user', '${GRANT_A}', 'b4a-contract-policy-command',
        'b4a-contract-policy-decision', '${DIGEST}', 'active',
        '${LATER}'::timestamptz, '${NOW}'::timestamptz, '${NOW}'::timestamptz
      )
    `,
  });

  await expectInitialTargetStatusFailure(pool, {
    suffix: "scope-revoked",
    actionId: "scope_principal_grant_issue",
    targetKind: "scope_principal_grant",
    targetId: "b4a-initial-scope-revoked-grant",
    targetContractSql: scopeGrantContractSql({
      grantId: "b4a-initial-scope-revoked-grant",
      subjectId: "b4a-contract-subject",
      subjectKind: "connector",
    }),
    expectedMessage: "scope_principal_grant_initial_status_invalid",
    targetSql: `
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        status, revoked_at, created_at, updated_at
      ) VALUES (
        '${W}', '${SCOPE_A}', 'b4a-initial-scope-revoked-grant',
        'b4a-contract-subject', 'connector', 'operation',
        'b4a-user-a', 'user', 'command', '${SCOPE_A}',
        'b4a-initial-scope-revoked-command', 'b4a-initial-scope-revoked-decision',
        '${DIGEST}', 'revoked', '${NOW}'::timestamptz,
        '${NOW}'::timestamptz, '${NOW}'::timestamptz
      )
    `,
  });

  for (const status of ["expired", "revalidation_required"]) {
    const suffix = `policy-${status}`;
    const grantId = `b4a-initial-${suffix}-grant`;
    await expectInitialTargetStatusFailure(pool, {
      suffix,
      actionId: "policy_grant_issue",
      targetKind: "policy_grant",
      targetId: grantId,
      targetContractSql: policyGrantContractSql({
        policyGrantId: grantId,
        subjectId: "b4a-user-b",
        subjectKind: "user",
        subjectGrantId: GRANT_B_ON_A,
      }),
      expectedMessage: "policy_grant_initial_status_invalid",
      targetSql: `
        INSERT INTO public.policy_grants (
          workspace_id, scope_id, policy_grant_id,
          subject_principal_id, subject_principal_kind, subject_scope_grant_id,
          policy_revision_id, authorized_by_principal_id, authorized_by_principal_kind,
          authorizer_scope_grant_id, issuance_command_id,
          issuance_authorization_decision_id, issuance_argument_digest,
          status, expires_at, created_at, updated_at
        ) VALUES (
          '${W}', '${SCOPE_A}', '${grantId}',
          'b4a-user-b', 'user', '${GRANT_B_ON_A}', '${POLICY_A}',
          'b4a-user-a', 'user', '${GRANT_A}', 'b4a-initial-${suffix}-command',
          'b4a-initial-${suffix}-decision', '${DIGEST}', '${status}',
          '${LATER}'::timestamptz, '${NOW}'::timestamptz, '${NOW}'::timestamptz
        )
      `,
    });
  }

  await expectInitialTargetStatusFailure(pool, {
    suffix: "object-revoked",
    actionId: "object_access_grant_issue",
    targetKind: "object_access_grant",
    targetId: "b4a-initial-object-revoked-grant",
    targetContractSql: objectGrantContractSql({
      grantId: "b4a-initial-object-revoked-grant",
    }),
    expectedMessage: "object_access_grant_initial_status_invalid",
    targetSql: `
      INSERT INTO public.object_access_grants (
        workspace_id, grant_id, scope_id, object_kind, object_id,
        principal_id, principal_kind, role, capabilities,
        product_command_id, status, revoked_at, created_at, updated_at
      ) VALUES (
        '${W}', 'b4a-initial-object-revoked-grant', '${SCOPE_A}',
        'workflow', 'b4a-workflow', 'b4a-user-b', 'user', 'viewer',
        ARRAY['object.share']::text[], 'b4a-initial-object-revoked-command',
        'revoked', '${NOW}'::timestamptz, '${NOW}'::timestamptz, '${NOW}'::timestamptz
      )
    `,
  });
}

async function expectSpecialTargetMismatch(pool, {
  suffix, actionId, targetKind, targetId, targetContractSql, targetSql,
}) {
  const client = await pool.connect();
  let caught;
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, standardDecision({
      decisionId: `b4a-contract-${suffix}-decision`,
      actionId,
      effectClass: "administrative",
      targetContractSql,
    }));
    await insertCommand(client, standardCommand({
      commandId: `b4a-contract-${suffix}-command`,
      decisionId: `b4a-contract-${suffix}-decision`,
      kind: actionId,
      effectClass: "administrative",
      targetKind,
      targetId,
      targetRevision: 1,
      targetContractSql,
    }));
    await client.query(targetSql);
    await client.query("COMMIT");
  } catch (error) {
    caught = error;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(caught?.code, "23514", caught?.message);
  assert.match(caught?.message ?? "", /product_command_target_contract_mismatch/);
}

async function expectInitialTargetStatusFailure(pool, {
  suffix, actionId, targetKind, targetId, targetContractSql, targetSql, expectedMessage,
}) {
  const client = await pool.connect();
  let caught;
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, standardDecision({
      decisionId: `b4a-initial-${suffix}-decision`,
      actionId,
      effectClass: "administrative",
      targetContractSql,
    }));
    await insertCommand(client, standardCommand({
      commandId: `b4a-initial-${suffix}-command`,
      decisionId: `b4a-initial-${suffix}-decision`,
      kind: actionId,
      effectClass: "administrative",
      targetKind,
      targetId,
      targetRevision: 1,
      targetContractSql,
    }));
    await client.query(targetSql);
    await client.query("COMMIT");
  } catch (error) {
    caught = error;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.equal(caught?.code, "P0001", caught?.message);
  assert.match(caught?.message ?? "", new RegExp(expectedMessage));
}

async function assertAutomationBuilderCreator(pool) {
  const decisionId = "b4a-builder-decision";
  await insertApprovalPair(pool, {
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-automation",
    actorKind: "automation",
    actorGrantId: GRANT_AUTO,
    effectiveId: "b4a-automation",
    effectiveKind: "automation",
    effectiveGrantId: GRANT_AUTO,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "builder_proposal",
    effectClass: "write_local",
  });
  await insertCommand(pool, {
    commandId: "b4a-builder-command",
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-automation",
    actorKind: "automation",
    effectiveId: "b4a-automation",
    effectiveKind: "automation",
    kind: "builder_proposal",
    effectClass: "write_local",
  });
  await pool.query(`
    INSERT INTO public.builder_proposals (
      workspace_id, proposal_id, scope_id,
      created_by_principal_id, created_by_principal_kind,
      product_command_id, schema_version, kind, status, generation_status,
      summary, staged_draft, expires_at, created_at
    ) VALUES (
      $1, 'b4a-builder-proposal', $2, 'b4a-automation', 'automation',
      'b4a-builder-command', 'workbench-v1', 'staged_loop_draft',
      'proposed', 'completed', 'Automation proposal', '{}'::jsonb, $3, $4
    )
  `, [W, SCOPE_A, LATER, NOW]);
}

async function assertDownstreamCommandIdentity(pool) {
  await pool.query(`
    INSERT INTO public.admission_waiting (
      admission_id, command_id, workspace_id, schema_version, kind,
      invocation_id, state, created_at, updated_at
    ) VALUES (
      'b4a-admission', 'b4a-target-command', $1, 'workbench-v1',
      'execution_invocation', 'b4a-slot', 'waiting_capacity', $2, $2
    )
  `, [W, NOW]);
  await pool.query(`
    INSERT INTO public.capacity_leases (
      capacity_lease_id, admission_id, command_id, workspace_id,
      schema_version, backend_key, provider_key, fence, lease_duration_ms,
      status, issued_at, expires_at, updated_at, dimensions
    ) VALUES (
      'b4a-capacity', 'b4a-admission', 'b4a-target-command', $1,
      'workbench-v1', 'bounded_agent:process', 'provider:none', 1, 60000,
      'active', $2, $3, $2, '[]'::jsonb
    )
  `, [W, NOW, LATER]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.execution_invocations (
        invocation_id, workspace_id, schema_version, attempt_id, product_command_id,
        lineage_session_id, lineage_turn_id, controller_kind, controller_id,
        controller_fence, mode, isolation, status, execution_fence,
        capacity_admission_id, capacity_lease_id, capacity_fence,
        capacity_backend_key, capacity_provider_key, capability_lease_id,
        created_at, updated_at
      ) VALUES (
        'b4a-invocation', $1, 'workbench-execution-fabric-v1', 'b4a-attempt',
        'b4a-target-command', 'b4a-session', 'b4a-turn', 'agent_turn', 'b4a-turn',
        1, 'bounded_agent', 'process', 'queued', 1,
        'b4a-admission', 'b4a-capacity', 1,
        'bounded_agent:process', 'provider:none', 'b4a-capability', $2, $2
      )
    `, [W, NOW]);
    await client.query(`
      INSERT INTO public.execution_attempts (
        attempt_id, invocation_id, schema_version, attempt_number,
        status, fence, created_at, updated_at
      ) VALUES (
        'b4a-attempt', 'b4a-invocation', 'workbench-execution-fabric-v1',
        1, 'queued', 1, $1, $1
      )
    `, [NOW]);
    await client.query(`
      INSERT INTO public.capability_leases (
        capability_lease_id, invocation_id, attempt_id, workspace_id,
        schema_version, fence, status, issued_at, expires_at, updated_at
      ) VALUES (
        'b4a-capability', 'b4a-invocation', 'b4a-attempt', $1,
        'workbench-execution-fabric-v1', 1, 'active', $2, $3, $2
      )
    `, [W, NOW, LATER]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertUnlineagedGrantDenials(pool) {
  await expectConstraint(pool, `
    INSERT INTO public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind,
      access_kind, granted_by_principal_id, granted_by_principal_kind,
      issuance_kind, created_at, updated_at
    ) VALUES (
      $1, $2, 'b4a-unlineaged-scope-grant', 'b4a-automation', 'automation',
      'operation', 'b4a-user-a', 'user', 'command', $3, $3
    )
  `, [W, SCOPE_A, NOW], "23514", "scope_principal_grants_issuance_shape");
  await expectDatabaseError(pool, `
    INSERT INTO public.policy_grants (
      workspace_id, scope_id, policy_grant_id,
      subject_principal_id, subject_principal_kind, subject_scope_grant_id,
      policy_revision_id, authorized_by_principal_id, authorized_by_principal_kind,
      authorizer_scope_grant_id, status, expires_at, created_at, updated_at
    ) VALUES (
      $1, $2, 'b4a-unlineaged-policy-grant', 'b4a-user-b', 'user', $3,
      $4, 'b4a-user-a', 'user', $5, 'active', $6, $7, $7
    )
  `, [W, SCOPE_A, GRANT_B_ON_A, POLICY_A, GRANT_A, LATER, NOW],
  "P0001", "policy_grant_issuance_inactive");
}

async function assertRevisionAndConcurrentRevoke(pool) {
  await expectDatabaseError(pool, `
    UPDATE public.workspace_memberships
    SET status = 'suspended', suspended_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [NOW, W], "P0001", "workspace_membership_revision_required");
  await expectDatabaseError(pool, `
    UPDATE public.workspace_principals
    SET status = 'revoked', revoked_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND principal_id = 'b4a-automation'
  `, [NOW, W], "P0001", "workspace_principal_revision_required");
  await expectDatabaseError(pool, `
    UPDATE public.scope_principal_grants
    SET status = 'revoked', revoked_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND grant_id = $3
  `, [NOW, W, GRANT_AUTO], "P0001", "scope_principal_grant_revision_required");

  const membershipClient = await pool.connect();
  try {
    await membershipClient.query("BEGIN");
    await membershipClient.query(`
      UPDATE public.workspace_memberships
      SET status = 'suspended', suspended_at = $1,
          revision = revision + 1, updated_at = $1
      WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
    `, [new Date().toISOString(), W]);
    const pendingGrant = issueScopeGrant(pool, {
      grantId: "b4a-membership-race-grant",
      subjectId: "b4a-user-b",
      subjectKind: "user",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await membershipClient.query("COMMIT");
    await assert.rejects(
      pendingGrant,
      (error) => error?.code === "P0001"
        && error?.message.includes("scope_principal_grant_subject_inactive"),
    );
  } finally {
    await membershipClient.query("ROLLBACK").catch(() => {});
    membershipClient.release();
  }
  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'active', suspended_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  await assertObjectGrantMembershipConcurrency(pool);
  const raceBaseGrant = "b4a-grant-b-after-membership-race";
  await issueScopeGrant(pool, {
    grantId: raceBaseGrant,
    subjectId: "b4a-user-b",
    subjectKind: "user",
  });

  const decisionId = "b4a-before-revoke-decision";
  await insertApprovalPair(pool, {
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: raceBaseGrant,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: raceBaseGrant,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "skill_validation",
    effectClass: "execute",
  });

  const revokeClient = await pool.connect();
  const commandClient = await pool.connect();
  try {
    await revokeClient.query("BEGIN");
    await revokeClient.query(`
      UPDATE public.scope_principal_grants
      SET status = 'revoked', revoked_at = $1,
          revision = revision + 1, updated_at = $1
      WHERE workspace_id = $2 AND grant_id = $3
    `, [new Date().toISOString(), W, raceBaseGrant]);
    const pendingCommand = commandClient.query(commandSql({
      commandId: "b4a-concurrent-command",
      decisionId,
      scopeId: SCOPE_A,
      policyId: POLICY_A,
      actorId: "b4a-user-b",
      actorKind: "user",
      effectiveId: "b4a-user-b",
      effectiveKind: "user",
      quotaUserId: "b4a-user-b",
      kind: "skill_validation",
      effectClass: "execute",
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await revokeClient.query("COMMIT");
    await assert.rejects(
      pendingCommand,
      (error) => error?.code === "P0001"
        && error?.message.includes("product_command_authority_inactive"),
    );
  } finally {
    await revokeClient.query("ROLLBACK").catch(() => {});
    revokeClient.release();
    commandClient.release();
  }

  await expectDatabaseError(pool, `
    UPDATE public.scope_principal_grants
    SET status = 'active', revoked_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND grant_id = $3
  `, [new Date().toISOString(), W, raceBaseGrant], "P0001", "scope_principal_grant_terminal");

  const epochTwoGrant = "b4a-grant-b-epoch-2";
  await issueScopeGrant(pool, {
    grantId: epochTwoGrant,
    subjectId: "b4a-user-b",
    subjectKind: "user",
  });
  const epochTwoDecision = "b4a-epoch-2-decision";
  await insertApprovalPair(pool, {
    decisionId: epochTwoDecision,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: epochTwoGrant,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: epochTwoGrant,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "skill_validation",
    effectClass: "execute",
  });

  await pool.query(`
    UPDATE public.workspace_memberships
    SET role = 'viewer', revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  const revokedByDowngrade = await pool.query(`
    SELECT
      (SELECT status FROM public.scope_principal_grants
        WHERE workspace_id = $1 AND grant_id = $2) AS scope_status,
      (SELECT status FROM public.object_access_grants
        WHERE workspace_id = $1 AND grant_id = 'b4a-object-grant') AS object_status
  `, [W, epochTwoGrant]);
  assert.deepEqual(revokedByDowngrade.rows[0], {
    scope_status: "revoked",
    object_status: "revoked",
  });
  await expectDatabaseError(pool, commandSql({
    commandId: "b4a-old-epoch-after-downgrade",
    decisionId: epochTwoDecision,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    quotaUserId: "b4a-user-b",
    kind: "skill_validation",
    effectClass: "execute",
  }), [], "P0001", "product_command_authority_inactive");

  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'suspended', suspended_at = $1,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'active', suspended_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);

  const epochThreeGrant = "b4a-grant-b-epoch-3";
  await issueScopeGrant(pool, {
    grantId: epochThreeGrant,
    subjectId: "b4a-user-b",
    subjectKind: "user",
  });
  const epochThreeDecision = "b4a-epoch-3-decision";
  await insertApprovalPair(pool, {
    decisionId: epochThreeDecision,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: epochThreeGrant,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: epochThreeGrant,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "skill_validation",
    effectClass: "execute",
  });
  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'removed', removed_at = $1,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  await expectObjectGrantFailure(pool, {
    grantId: "b4a-object-inactive-subject",
    decisionId: "b4a-object-inactive-subject-decision",
  }, "object_access_grant_subject_inactive");
  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'active', removed_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  await expectDatabaseError(pool, commandSql({
    commandId: "b4a-old-epoch-after-restore",
    decisionId: epochThreeDecision,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-b",
    actorKind: "user",
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    quotaUserId: "b4a-user-b",
    kind: "skill_validation",
    effectClass: "execute",
  }), [], "P0001", "product_command_authority_inactive");

  await expectDatabaseError(pool, `
    UPDATE public.scope_principal_grants
    SET status = 'active', revoked_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND grant_id = $3
  `, [new Date().toISOString(), W, GRANT_B], "P0001", "scope_principal_grant_terminal");

  await assert.rejects(
    recoverScopeGrant(pool, "b4a-scope-b-recovery-expanded", {
      capabilities: ["object.execute"],
    }),
    (error) => error?.code === "P0001"
      && error?.message.includes("scope_principal_grant_recovery_rights_mismatch"),
  );
  await assert.rejects(
    recoverScopeGrant(pool, "b4a-scope-b-recovery-no-approval", {
      canApprove: false,
    }),
    (error) => error?.code === "P0001"
      && error?.message.includes("scope_principal_grant_recovery_rights_mismatch"),
  );
  const recoveredScopeGrant = "b4a-scope-b-recovery-grant";
  await recoverScopeGrant(pool, recoveredScopeGrant);
  await assert.rejects(
    recoverScopeGrant(pool, "b4a-scope-b-recovery-duplicate"),
    (error) => error?.code === "P0001"
      && error?.message.includes("scope_principal_grant_recovery_not_allowed"),
  );
  const recoveredDecision = "b4a-scope-b-recovered-decision";
  await insertApprovalPair(pool, {
    decisionId: recoveredDecision,
    scopeId: SCOPE_B,
    policyId: POLICY_B,
    actorId: "b4a-user-b",
    actorKind: "user",
    actorGrantId: recoveredScopeGrant,
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    effectiveGrantId: recoveredScopeGrant,
    authorizerId: "b4a-user-b",
    authorizerKind: "user",
    authorizerGrantId: recoveredScopeGrant,
    actionId: "skill_validation",
    effectClass: "execute",
  });
  await insertCommand(pool, {
    commandId: "b4a-scope-b-recovered-command",
    decisionId: recoveredDecision,
    scopeId: SCOPE_B,
    policyId: POLICY_B,
    actorId: "b4a-user-b",
    actorKind: "user",
    effectiveId: "b4a-user-b",
    effectiveKind: "user",
    quotaUserId: "b4a-user-b",
    kind: "skill_validation",
    effectClass: "execute",
  });

  const epochFourGrant = "b4a-grant-b-epoch-4";
  await issueScopeGrant(pool, {
    grantId: epochFourGrant,
    subjectId: "b4a-user-b",
    subjectKind: "user",
  });
  const restoredGrant = await pool.query(`
    SELECT status, revision FROM public.scope_principal_grants
    WHERE workspace_id = $1 AND grant_id = $2
  `, [W, epochFourGrant]);
  assert.deepEqual(restoredGrant.rows[0], { status: "active", revision: 1 });

  await pool.query(`
    INSERT INTO public.scope_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision, observation_tier,
      permission_mode, policy_content_hash, created_by_principal_id,
      created_by_principal_kind, created_at
    ) VALUES (
      $1, $2, 'b4a-policy-a-2', 2, 'private', 'interactive', $3,
      'b4a-user-a', 'user', $4
    )
  `, [W, SCOPE_A, OTHER_DIGEST, NOW]);
  await expectDatabaseError(pool, `
    UPDATE public.product_scopes
    SET current_policy_revision_id = 'b4a-policy-a-2', updated_at = $1
    WHERE workspace_id = $2 AND scope_id = $3
  `, [new Date().toISOString(), W, SCOPE_A], "P0001", "product_scope_revision_required");
  await pool.query(`
    UPDATE public.product_scopes
    SET current_policy_revision_id = 'b4a-policy-a-2',
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND scope_id = $3
  `, [new Date().toISOString(), W, SCOPE_A]);
}

async function assertObjectGrantMembershipConcurrency(pool) {
  const grantId = "b4a-object-membership-race";
  const decisionId = `${grantId}-decision`;
  const objectClient = await pool.connect();
  const membershipClient = await pool.connect();
  try {
    await objectClient.query("BEGIN");
    await insertApprovalPair(objectClient, objectGrantDecision({ grantId, decisionId }));
    await insertCommand(objectClient, objectGrantCommand({ grantId, decisionId }));
    await objectClient.query(objectGrantSql({ grantId, decisionId }));

    await membershipClient.query("BEGIN");
    await membershipClient.query("SET LOCAL lock_timeout = '100ms'");
    await assert.rejects(
      membershipClient.query(`
        UPDATE public.workspace_memberships
        SET status = 'suspended', suspended_at = $1,
            revision = revision + 1, updated_at = $1
        WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
      `, [new Date().toISOString(), W]),
      (error) => error?.code === "55P03",
    );
    await membershipClient.query("ROLLBACK");

    await objectClient.query("COMMIT");
  } catch (error) {
    await objectClient.query("ROLLBACK").catch(() => {});
    await membershipClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    objectClient.release();
    membershipClient.release();
  }

  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'suspended', suspended_at = $1,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  await pool.query(`
    UPDATE public.workspace_memberships
    SET status = 'active', suspended_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND user_id = 'b4a-user-b'
  `, [new Date().toISOString(), W]);
  const oldEpochGrant = await pool.query(`
    SELECT status FROM public.object_access_grants
    WHERE workspace_id = $1 AND grant_id = $2
  `, [W, grantId]);
  assert.equal(oldEpochGrant.rows[0]?.status, "revoked");
  await expectDatabaseError(pool, `
    UPDATE public.object_access_grants
    SET status = 'active', revoked_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = $2 AND grant_id = $3
  `, [new Date().toISOString(), W, grantId], "P0001", "object_access_grant_terminal");
}

async function insertApprovalRequest(pool, {
  decisionId,
  argumentDigest = DIGEST,
  expiresAt = LATER,
}) {
  await pool.query(authorizationDecisionSql({
    decisionId,
    disposition: "approval_required",
    approvalId: decisionId,
    argumentDigest,
    expiresAt,
  }));
}

async function insertApprovalPair(pool, decision) {
  const requestId = `${decision.decisionId}-request`;
  await pool.query(authorizationDecisionSql({
    ...decision,
    decisionId: requestId,
    authorizerId: decision.effectiveId,
    authorizerKind: decision.effectiveKind,
    authorizerGrantId: decision.effectiveGrantId,
    disposition: "approval_required",
    approvalId: requestId,
  }));
  await pool.query(authorizationDecisionSql({
    ...decision,
    disposition: "authorized",
    approvalId: requestId,
  }));
}

function standardDecision(overrides = {}) {
  return {
    decisionId: "b4a-standard-decision",
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-a",
    actorKind: "user",
    actorGrantId: GRANT_A,
    effectiveId: "b4a-user-a",
    effectiveKind: "user",
    effectiveGrantId: GRANT_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "skill_validation",
    effectClass: "execute",
    ...overrides,
  };
}

function standardCommand(overrides = {}) {
  return {
    commandId: "b4a-standard-command",
    decisionId: "b4a-standard-decision",
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-user-a",
    actorKind: "user",
    effectiveId: "b4a-user-a",
    effectiveKind: "user",
    quotaUserId: "b4a-user-a",
    kind: "skill_validation",
    effectClass: "execute",
    ...overrides,
  };
}

function scopeGrantContractSql({
  scopeId = SCOPE_A,
  grantId,
  subjectId,
  subjectKind,
  accessKind = "operation",
  capabilities = [],
  canApprove = false,
  grantorId = "b4a-user-a",
  grantorKind = "user",
  issuanceKind = "command",
}) {
  return `jsonb_build_object(
    'scopeId', '${scopeId}',
    'grantId', '${grantId}',
    'subjectPrincipalId', '${subjectId}',
    'subjectPrincipalKind', '${subjectKind}',
    'accessKind', '${accessKind}',
    'capabilities', to_jsonb(ARRAY[${capabilities.map((value) => `'${value}'`).join(", ")}]::text[]),
    'canApprove', ${canApprove},
    'grantorPrincipalId', '${grantorId}',
    'grantorPrincipalKind', '${grantorKind}',
    'issuanceKind', '${issuanceKind}',
    'status', 'active'
  )`;
}

function scopeCreateContractSql() {
  return `jsonb_build_object(
    'scopeKind', 'personal',
    'ownerUserId', 'b4a-user-b',
    'ownerPrincipalId', 'b4a-user-b',
    'projectId', NULL,
    'creatorPrincipalId', 'b4a-user-b',
    'creatorPrincipalKind', 'user',
    'policy', jsonb_build_object(
      'policyRevisionId', '${POLICY_B}',
      'revision', 1,
      'observationTier', 'private',
      'permissionMode', 'interactive',
      'autoApprovedEffectClasses', '[]'::jsonb,
      'autoApprovedActionIds', '[]'::jsonb,
      'contentHash', '${DIGEST}'
    ),
    'initialGrant', jsonb_build_object(
      'grantId', '${GRANT_B}',
      'subjectPrincipalId', 'b4a-user-b',
      'subjectPrincipalKind', 'user',
      'accessKind', 'operation',
      'capabilities', '[]'::jsonb,
      'canApprove', true
    )
  )`;
}

function policyGrantContractSql({
  policyGrantId = "b4a-policy-grant-auto",
  subjectId = "b4a-automation",
  subjectKind = "automation",
  subjectGrantId = GRANT_AUTO,
  policyRevisionId = POLICY_A,
} = {}) {
  return `jsonb_build_object(
    'scopeId', '${SCOPE_A}',
    'policyGrantId', '${policyGrantId}',
    'subjectPrincipalId', '${subjectId}',
    'subjectPrincipalKind', '${subjectKind}',
    'subjectScopeGrantId', '${subjectGrantId}',
    'policyRevisionId', '${policyRevisionId}',
    'authorizerPrincipalId', 'b4a-user-a',
    'authorizerPrincipalKind', 'user',
    'authorizerScopeGrantId', '${GRANT_A}',
    'expiresAt', to_char(
      '${LATER}'::timestamptz AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'reviewAt', NULL,
    'status', 'active'
  )`;
}

function authorizationDecisionSql({
  decisionId,
  scopeId = SCOPE_A,
  policyId = POLICY_A,
  actorId = "b4a-user-a",
  actorKind = "user",
  actorGrantId = GRANT_A,
  effectiveId = "b4a-user-a",
  effectiveKind = "user",
  effectiveGrantId = GRANT_A,
  authorizerId = "b4a-user-a",
  authorizerKind = "user",
  authorizerGrantId = GRANT_A,
  actionId = "skill_validation",
  effectClass = "execute",
  argumentDigest = DIGEST,
  targetContractSql = null,
  disposition = "authorized",
  approvalId,
  decidedAt = NOW,
  expiresAt = LATER,
}) {
  const approval = approvalId == null ? "NULL" : `'${approvalId}'`;
  return `
    INSERT INTO public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind, actor_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_scope_grant_id,
      authorization_source, authorizer_principal_id, authorizer_principal_kind,
      authorizer_scope_grant_id, action_id, effect_class, argument_digest,
      target_contract,
      permission_mode, destructive_rule_version, disposition, approval_id,
      reason_code, decided_at, expires_at
    ) VALUES (
      '${W}', '${decisionId}', '${scopeId}', '${policyId}',
      '${actorId}', '${actorKind}', '${actorGrantId}',
      '${effectiveId}', '${effectiveKind}', '${effectiveGrantId}',
      'principal', '${authorizerId}', '${authorizerKind}', '${authorizerGrantId}',
      '${actionId}', '${effectClass}', '${argumentDigest}',
      ${targetContractSql ?? "NULL"}, 'interactive',
      'authority-v1', '${disposition}', ${approval}, 'matrix',
      '${decidedAt}'::timestamptz, '${expiresAt}'::timestamptz
    )
  `;
}

async function insertCommand(pool, command) {
  await pool.query(commandSql(command));
}

function commandSql({
  commandId,
  decisionId,
  scopeId,
  policyId,
  actorId,
  actorKind,
  effectiveId,
  effectiveKind,
  quotaUserId = "b4a-user-a",
  kind,
  effectClass,
  argumentDigest = DIGEST,
  targetContractSql = null,
  sessionId = null,
  turnId = null,
  targetCommandId = null,
  targetKind = null,
  targetId = null,
  targetRevision = null,
  status = targetKind == null ? "accepted" : "completed",
  createdAt = NOW,
}) {
  const literal = (value) => value == null ? "NULL" : `'${value}'`;
  const finishedAt = status === "completed" ? `'${createdAt}'::timestamptz` : "NULL";
  return `
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind, authorization_decision_id,
      policy_revision_id, effect_class, argument_digest, target_contract, quota_user_id,
      schema_version, kind, session_id, turn_id, target_command_id,
      target_kind, target_id, target_revision,
      status, created_at, updated_at, finished_at
    ) VALUES (
      '${commandId}', '${W}', '${scopeId}', '${actorId}', '${actorKind}',
      '${effectiveId}', '${effectiveKind}', '${decisionId}', '${policyId}',
      '${effectClass}', '${argumentDigest}', ${targetContractSql ?? "NULL"},
      '${quotaUserId}', 'workbench-v1', '${kind}',
      ${literal(sessionId)}, ${literal(turnId)}, ${literal(targetCommandId)},
      ${literal(targetKind)}, ${literal(targetId)}, ${targetRevision ?? "NULL"},
      '${status}', '${createdAt}'::timestamptz, '${createdAt}'::timestamptz, ${finishedAt}
    )
  `;
}

async function insertObjectGrant(pool, options) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertApprovalPair(client, objectGrantDecision(options));
    await insertCommand(client, objectGrantCommand(options));
    await client.query(objectGrantSql(options));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function expectObjectGrantFailure(pool, options, message) {
  await assert.rejects(
    insertObjectGrant(pool, options),
    (error) => error?.code === "P0001" && error?.message.includes(message),
  );
}

function objectGrantDecision({ grantId, decisionId, grantScopeId = SCOPE_A, objectId = "b4a-workflow" }) {
  return {
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-automation",
    actorKind: "automation",
    actorGrantId: GRANT_AUTO,
    effectiveId: "b4a-user-a",
    effectiveKind: "user",
    effectiveGrantId: GRANT_A,
    authorizerId: "b4a-user-a",
    authorizerKind: "user",
    authorizerGrantId: GRANT_A,
    actionId: "object_access_grant_issue",
    effectClass: "administrative",
    targetContractSql: objectGrantContractSql({ grantId, grantScopeId, objectId }),
  };
}

function objectGrantContractSql({
  grantId,
  grantScopeId = SCOPE_A,
  objectId = "b4a-workflow",
  role = "viewer",
  capabilities = ["object.share"],
}) {
  return `jsonb_build_object(
    'scopeId', '${grantScopeId}',
    'grantId', '${grantId}',
    'objectKind', 'workflow',
    'objectId', '${objectId}',
    'subjectPrincipalId', 'b4a-user-b',
    'subjectPrincipalKind', 'user',
    'role', '${role}',
    'capabilities', to_jsonb(ARRAY[${capabilities.map((value) => `'${value}'`).join(", ")}]::text[]),
    'status', 'active'
  )`;
}

function objectGrantCommand({
  grantId, decisionId, grantScopeId = SCOPE_A, objectId = "b4a-workflow",
}) {
  return {
    commandId: `${grantId}-command`,
    decisionId,
    scopeId: SCOPE_A,
    policyId: POLICY_A,
    actorId: "b4a-automation",
    actorKind: "automation",
    effectiveId: "b4a-user-a",
    effectiveKind: "user",
    kind: "object_access_grant_issue",
    effectClass: "administrative",
    targetKind: "object_access_grant",
    targetId: grantId,
    targetRevision: 1,
    targetContractSql: objectGrantContractSql({ grantId, grantScopeId, objectId }),
  };
}

function objectGrantSql({
  grantId,
  decisionId,
  grantScopeId = SCOPE_A,
  objectId = "b4a-workflow",
}) {
  return `
    INSERT INTO public.object_access_grants (
      workspace_id, grant_id, scope_id, object_kind, object_id,
      principal_id, principal_kind, role, capabilities,
      product_command_id, created_at, updated_at
    ) VALUES (
      '${W}', '${grantId}', '${grantScopeId}', 'workflow', '${objectId}',
      'b4a-user-b', 'user', 'viewer', ARRAY['object.share']::text[],
      '${grantId}-command',
      '${NOW}'::timestamptz, '${NOW}'::timestamptz
    )
  `;
}

async function expectConstraint(pool, sql, values, code, constraint) {
  await assert.rejects(
    pool.query(sql, values),
    (error) => error?.code === code
      && (constraint === undefined || error?.constraint === constraint),
  );
}

async function expectDatabaseError(pool, sql, values, code, message) {
  await assert.rejects(
    pool.query(sql, values),
    (error) => error?.code === code && error?.message.includes(message),
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
