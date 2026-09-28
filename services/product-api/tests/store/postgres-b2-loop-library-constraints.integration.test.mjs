import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { exerciseLoopPublication } from "./loop-publication-scenario.mjs";

import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const NOW = new Date(Date.now() - 60_000).toISOString();
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();
const EXPIRY = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const hash = (character) => `sha256:${character.repeat(64)}`;
const REVISION_HASH = hash("a");
const REVISION_TWO_HASH = hash("b");
const PLAN_HASH = hash("c");
const LOOP_V1_HASH = hash("d");
const LOOP_V2_HASH = hash("e");
const RESOURCE_HASH = hash("f");
const SKILL_OBJECT_HASH = hash("1");
const SKILL_PACKAGE_HASH = hash("2");
const SKILL_VERSION_HASH = hash("3");
const PROBE_HASH = hash("4");
const MANIFEST_HASH = hash("5");
const EXECUTION_REF_HASH = hash("6");
const LOOP_OBJECT_HASH = hash("7");

const B2_TABLES = [
  "templates",
  "workflows",
  "workflow_revisions",
  "loop_imports",
  "loop_versions",
  "loop_version_skill_pins",
  "loop_version_resource_pins",
  "loop_version_connection_requirements",
  "workspace_asset_releases",
  "asset_installations",
  "installation_update_drafts",
  "installation_update_draft_connection_bindings",
  "workspace_connections",
  "workspace_connection_revisions",
  "workspace_connection_bindings",
  "builder_proposals",
  "compile_results",
  "execution_plans",
  "execution_plan_model_pins",
];

test("PostgreSQL B2 enforces Loop/Library revision, compile, release, and update authority", {
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
  await assertInventory(pool);
  await seedTenants(pool);
  await seedModelGovernance(pool);
  await seedTemplateAndMaterials(pool);
  await assertWorkflowRevisionAuthority(pool);
  await seedCompileAuthority(pool);
  await assertCompilePlanAuthority(pool);
  await seedConnectionAndSkill(pool);
  await seedLoopVersionsAndPins(pool);
  await assertTypedReleaseAuthority(pool);
  await assertInstallationUpdateAuthority(pool);
  await assertConnectionBindingAuthority(pool);
  await seedExecutionInvocations(pool);
  await assertBuilderProposalLineage(pool);
  await assertLoopImportAuthority(pool);
  await assertImmutableAndMutableBoundaries(pool);
  await exerciseLoopPublication({ pool, store, resourceHash: RESOURCE_HASH });
});

async function assertInventory(pool) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [B2_TABLES]);
  assert.deepEqual(result.rows.map((row) => row.table_name), [...B2_TABLES].sort());

  const unsafe = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND column_name ~ '(token|password|secret_value|credential_json|host_path|publisher_connection|store_binding_ref|secret_binding_ref|secret_binding_revision)'
  `, [B2_TABLES]);
  assert.deepEqual(unsafe.rows, []);

  const connectionColumns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_connections'
      AND column_name IN ('secret_binding_id', 'credential_binding_fingerprint')
    ORDER BY column_name
  `);
  assert.deepEqual(
    connectionColumns.rows.map((row) => row.column_name),
    [],
  );
  const revisionSecretColumns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'workspace_connection_revisions'
      AND column_name IN ('secret_binding_id', 'credential_binding_fingerprint')
    ORDER BY column_name
  `);
  assert.deepEqual(
    revisionSecretColumns.rows.map((row) => row.column_name),
    ['credential_binding_fingerprint', 'secret_binding_id'],
  );
}

async function seedTenants(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES
      ('b2-user-a', 'workbench-v1', 'B2 A', $1, $1),
      ('b2-user-b', 'workbench-v1', 'B2 B', $1, $1),
      ('b2-user-c', 'workbench-v1', 'B2 C', $1, $1),
      ('system-catalog', 'workbench-v1', 'System Catalog', $1, $1)
    ON CONFLICT (user_id) DO NOTHING
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES
      ('b2-workspace-a', 'workbench-v1', 'B2 A', 'b2-user-a', $1, $1),
      ('b2-workspace-b', 'workbench-v1', 'B2 B', 'b2-user-c', $1, $1)
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES
      ('b2-member-a', 'b2-workspace-a', 'b2-user-a', 'workbench-v1', 'owner', $1, $1),
      ('b2-member-b', 'b2-workspace-a', 'b2-user-b', 'workbench-v1', 'member', $1, $1),
      ('b2-member-c', 'b2-workspace-b', 'b2-user-c', 'workbench-v1', 'owner', $1, $1)
  `, [NOW]);
  await seedPersonalAuthority(pool, {
    workspaceId: "b2-workspace-a", userId: "b2-user-a", membershipId: "b2-member-a",
  });
  await seedCollaboratorAuthority(pool);
  await seedPersonalAuthority(pool, {
    workspaceId: "b2-workspace-b", userId: "b2-user-c", membershipId: "b2-member-c",
  });
}

async function seedModelGovernance(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const suffix of ["primary", "fallback", "late-model-revision"]) {
      const revisionId = suffix === "late-model-revision"
        ? "b2-late-model-revision"
        : `b2-model-${suffix}`;
      const profileId = `b2-profile-${suffix}`;
      const bindingId = `b2-model-secret-${suffix}`;
      await client.query(`
        INSERT INTO public.model_profiles (
          profile_id, workspace_id, scope_id, schema_version, profile_scope,
          display_name, current_revision_id, current_revision_number,
          created_by_principal_id, created_by_principal_kind, created_at, updated_at
        ) VALUES (
          $1, 'b2-workspace-a', 'b2-workspace-a-b2-user-a-personal',
          'workbench-model-catalog-v1', 'workspace', $4, $2, 1,
          'b2-user-a', 'user', $3, $3
        )
      `, [profileId, revisionId, NOW, profileId]);
      await client.query(`
        INSERT INTO public.secret_bindings (
          workspace_id, secret_binding_id, scope_id, schema_version,
          owner_kind, owner_id, secret_source, store_binding_ref,
          store_binding_revision, credential_fingerprint, status,
          created_by_principal_id, created_by_principal_kind,
          probed_at, created_at, updated_at
        ) VALUES (
          'b2-workspace-a', $1, 'b2-workspace-a-b2-user-a-personal',
          'workbench-secret-binding-v1', 'model_profile_revision', $2,
          'cloud_secret_store', $3, 1, $4, 'active',
          'b2-user-a', 'user', $5, $5, $5
        )
      `, [bindingId, revisionId, `${bindingId}-store`, hash("a"), NOW]);
      await client.query(`
        INSERT INTO public.model_profile_revisions (
          revision_id, workspace_id, profile_id, revision_number, schema_version,
          provider, protocol, provider_model_ref, capabilities,
          parameter_support, limits, data_policy, cost_policy,
          parameter_schema_version, policy_version, config_hash,
          deployment_key, secret_binding_id,
          created_by_principal_id, created_by_principal_kind, created_at
        ) VALUES (
          $1, 'b2-workspace-a', $2, 1, 'workbench-model-catalog-v1',
          'openai', 'openai_compatible_chat', 'gpt-test', ARRAY['chat'],
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '1.0.0', '1.0.0', $3, $4, $5, 'b2-user-a', 'user', $6
        )
      `, [revisionId, profileId, hash("b"), `${profileId}-deployment`, bindingId, NOW]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedCollaboratorAuthority(pool) {
  const scopeId = "b2-workspace-a-b2-user-a-personal";
  const policyId = "b2-workspace-a-b2-user-a-policy-1";
  const ownerGrantId = "b2-workspace-a-b2-user-a-operation";
  const collaboratorGrantId = "b2-workspace-a-b2-user-b-operation";
  const requestId = "b2-user-b-grant-request";
  const decisionId = "b2-user-b-grant-decision";
  const commandId = "b2-user-b-grant-command";
  const targetContractSql = `jsonb_build_object(
    'scopeId', '${scopeId}',
    'grantId', '${collaboratorGrantId}',
    'subjectPrincipalId', 'b2-user-b',
    'subjectPrincipalKind', 'user',
    'accessKind', 'operation',
    'capabilities', '[]'::jsonb,
    'canApprove', false,
    'grantorPrincipalId', 'b2-user-a',
    'grantorPrincipalKind', 'user',
    'issuanceKind', 'command',
    'status', 'active'
  )`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, user_id, membership_id,
        created_at, updated_at
      ) VALUES (
        'b2-workspace-a', 'b2-user-b', 'user', 'b2-user-b', 'b2-member-b', $1, $1
      )
    `, [NOW]);
    await client.query(`
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
        'b2-workspace-a', $1, $2, $3,
        'b2-user-a', 'user', $4, 'b2-user-a', 'user', $4,
        'principal', 'b2-user-a', 'user', $4,
        'scope_principal_grant_issue', 'administrative', $5, ${targetContractSql},
        'interactive', 'authority-v1', 'approval_required', $1,
        'approval_required', $6, $7
      )
    `, [requestId, scopeId, policyId, ownerGrantId, REVISION_HASH, NOW, EXPIRY]);
    await client.query(`
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
        'b2-workspace-a', $1, $2, $3,
        'b2-user-a', 'user', $4, 'b2-user-a', 'user', $4,
        'principal', 'b2-user-a', 'user', $4,
        'scope_principal_grant_issue', 'administrative', $5, ${targetContractSql},
        'interactive', 'authority-v1', 'authorized', $6,
        'approved', $7, $8
      )
    `, [decisionId, scopeId, policyId, ownerGrantId, REVISION_HASH, requestId, NOW, EXPIRY]);
    await client.query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind, authorization_decision_id,
        policy_revision_id, effect_class, argument_digest, target_contract, quota_user_id,
        schema_version, kind, target_kind, target_id, target_revision,
        status, created_at, updated_at, finished_at
      ) VALUES (
        $1, 'b2-workspace-a', $2, 'b2-user-a', 'user', 'b2-user-a', 'user',
        $3, $4, 'administrative', $5, ${targetContractSql},
        'b2-user-a', 'workbench-v1',
        'scope_principal_grant_issue', 'scope_principal_grant', $6, 1,
        'completed', $7, $7, $7
      )
    `, [commandId, scopeId, decisionId, policyId, REVISION_HASH, collaboratorGrantId, NOW]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        created_at, updated_at
      ) VALUES (
        'b2-workspace-a', $1, $2, 'b2-user-b', 'user', 'operation',
        'b2-user-a', 'user', 'command', $1, $3, $4, $5, $6, $6
      )
    `, [scopeId, collaboratorGrantId, commandId, decisionId, REVISION_HASH, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedTemplateAndMaterials(pool) {
  await pool.query(`
    INSERT INTO public.templates (
      template_id, template_version, schema_version, name, description, category,
      display, input_form, graph, included_skills, expected_outputs, review_policy,
      availability_status, created_at, updated_at
    ) VALUES (
      'b2-template', '1.0.0', 'workbench-v1', 'Private Loop', 'Creates a private draft.',
      'product', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
      '[{"name":"result"}]'::jsonb, '{}'::jsonb, 'available', $1, $1
    )
  `, [NOW]);
  await pool.query(objectInsert("b2-workspace-a", "b2-resource-object", "resource_content", RESOURCE_HASH));
  await pool.query(`
    INSERT INTO public.workspace_resources (
      workspace_id, resource_id, resource_version, created_by, schema_version,
      label, media_type, size_bytes, content_hash, object_id, source_kind,
      readiness_status, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-resource', '1.0.0', 'b2-user-a', 'workbench-v1',
      'Research brief', 'text/markdown', 12, $1, 'b2-resource-object', 'text_entry',
      'ready', $2, $2
    )
  `, [RESOURCE_HASH, NOW]);
}

async function assertWorkflowRevisionAuthority(pool) {
  await createWorkflow(pool, {
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
    revisionHash: REVISION_HASH,
    ownerId: "b2-user-a",
    resourceRefs: [{
      resourceId: "b2-resource",
      version: "1.0.0",
      label: "Research brief",
      contentHash: RESOURCE_HASH,
    }],
  });
  const workflow = await pool.query(`
    SELECT owner_user_id, visibility, lifecycle, status, current_revision_number, write_version
    FROM public.workflows
    WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a'
  `);
  assert.deepEqual(workflow.rows[0], {
    owner_user_id: "b2-user-a",
    visibility: "private",
    lifecycle: "draft",
    status: "draft",
    current_revision_number: 1,
    write_version: 1,
  });

  await expectConstraint(pool, workflowInsert({
    workspaceId: "b2-workspace-a",
    workflowId: "b2-cross-owner",
    revisionId: "b2-cross-owner-r1",
    ownerId: "b2-user-c",
    scopeId: "b2-workspace-a-b2-user-a-personal",
  }), [NOW], "23503", "workflows_owner_fk");
  await expectConstraint(pool, `
    UPDATE public.workflows
    SET source_release_workspace_id = 'b2-workspace-b',
        source_release_id = 'b2-foreign-release',
        source_release_version_id = 'b2-foreign-loop-version',
        write_version = write_version + 1,
        updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a'
  `, [LATER], "23514", "workflows_source_release_workspace");

  await createWorkflow(pool, {
    workflowId: "b2-workflow-other",
    revisionId: "b2-revision-other1",
    revisionHash: REVISION_TWO_HASH,
    ownerId: "b2-user-a",
  });
  await expectTransactionConstraint(pool, async (client) => {
    await client.query(`
      UPDATE public.workflows
      SET current_revision_id = 'b2-revision-other1', write_version = write_version + 1,
          updated_at = $1
      WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a'
    `, [LATER]);
  }, "23503", "workflows_current_revision_fk");

  await expectConstraint(pool, revisionInsert({
    revisionId: "b2-revision-wrong-base",
    workflowId: "b2-workflow-a",
    revisionNumber: 2,
    baseRevisionId: "b2-revision-other1",
    contentHash: REVISION_TWO_HASH,
  }), [NOW], "23503", "workflow_revisions_base_fk");
  await pool.query(revisionInsert({
    revisionId: "b2-revision-a2",
    workflowId: "b2-workflow-a",
    revisionNumber: 2,
    baseRevisionId: "b2-revision-a1",
    contentHash: hash("8"),
  }), [NOW]);
  await expectConstraint(pool, revisionInsert({
    revisionId: "b2-revision-skips-base",
    workflowId: "b2-workflow-a",
    revisionNumber: 3,
    baseRevisionId: "b2-revision-a1",
    baseRevisionNumber: 1,
    contentHash: hash("9"),
  }), [NOW], "23514", "workflow_revisions_base_shape");
  await expectConstraint(pool, revisionInsert({
    revisionId: "b2-revision-null-base-number",
    workflowId: "b2-workflow-a",
    revisionNumber: 3,
    baseRevisionId: "b2-revision-a2",
    baseRevisionNumber: null,
    contentHash: hash("7"),
  }), [NOW], "23514", "workflow_revisions_base_shape");
  await expectConstraint(pool, revisionInsert({
    revisionId: "b2-revision-future-base-number",
    workflowId: "b2-workflow-a",
    revisionNumber: 2,
    baseRevisionId: "b2-revision-a1",
    baseRevisionNumber: 2,
    contentHash: hash("0"),
  }), [NOW], "23514", "workflow_revisions_base_shape");
  await expectConstraint(pool, revisionInsert({
    revisionId: "b2-revision-duplicate-number",
    workflowId: "b2-workflow-a",
    revisionNumber: 1,
    contentHash: REVISION_TWO_HASH,
  }), [NOW], "23505", "workflow_revisions_number_uq");

  const firstWriter = await pool.query(`
    UPDATE public.workflows
    SET description = 'first writer', write_version = write_version + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a' AND write_version = 1
  `, [LATER]);
  const staleWriter = await pool.query(`
    UPDATE public.workflows
    SET description = 'stale writer', write_version = write_version + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a' AND write_version = 1
  `, [LATER]);
  assert.equal(firstWriter.rowCount, 1);
  assert.equal(staleWriter.rowCount, 0);
}

async function seedCompileAuthority(pool) {
  await insertCompilePair(pool, {
    resultId: "b2-compile-a1",
    planId: "b2-plan-a1",
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
    pinnedSkills: [{ skillId: "b2-skill", version: "1.0.0" }],
  });
  await pool.query(`
    UPDATE public.workflows
    SET latest_compile_result_id = 'b2-compile-a1', updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a'
  `, [LATER]);
}

async function assertCompilePlanAuthority(pool) {
  await insertCompilePair(pool, {
    resultId: "b2-review-compile",
    planId: "b2-review-plan",
    workflowId: "b2-workflow-other",
    revisionId: "b2-revision-other1",
    orderedSteps: ["node-review"],
    reviewGates: ["node-review"],
  });
  await expectConstraint(pool, executionPlanInsert({
    resultId: "b2-json-lineage-result",
    planId: "b2-json-lineage-plan",
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
    documentWorkflowId: "b2-workflow-other",
  }), [NOW], "23514", "execution_plans_document_coherence");
  await expectConstraint(pool, executionPlanInsert({
    resultId: "b2-json-time-result",
    planId: "b2-json-time-plan",
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
    documentGeneratedAt: LATER,
  }), [NOW], "23514", "execution_plans_document_coherence");
  await expectConstraint(pool, executionPlanInsert({
    resultId: "b2-json-missing-key-result",
    planId: "b2-json-missing-key-plan",
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
    omitDocumentKey: "primaryOutput",
  }), [NOW], "23514", "execution_plans_document_coherence");

  await expectTransactionConstraint(pool, async (client) => {
    await client.query(compileResultInsert({
      resultId: "b2-missing-model-pin-result",
      planId: "b2-missing-model-pin-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      status: "ready",
    }), [NOW]);
    await client.query(executionPlanInsert({
      resultId: "b2-missing-model-pin-result",
      planId: "b2-missing-model-pin-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      modelProfileRevisionId: "b2-model-primary",
      fallbackModelProfileRevisionIds: ["b2-model-fallback"],
      pinsFinalized: false,
    }), [NOW]);
    await client.query(`
      UPDATE public.execution_plans
      SET pins_finalized = true
      WHERE workspace_id = 'b2-workspace-a' AND plan_id = 'b2-missing-model-pin-plan'
    `);
  }, "55000", undefined);

  await createPinnedCompilePair(pool);

  await expectTransactionConstraint(pool, async (client) => {
    await client.query(compileResultInsert({
      resultId: "b2-ready-orphan",
      planId: "b2-missing-plan",
      workflowId: "b2-workflow-a",
      revisionId: "b2-revision-a1",
      status: "ready",
    }), [NOW]);
  }, "23503", "compile_results_execution_plan_fk");

  await expectTransactionConstraint(pool, async (client) => {
    await client.query(executionPlanInsert({
      resultId: "b2-missing-result",
      planId: "b2-orphan-plan",
      workflowId: "b2-workflow-a",
      revisionId: "b2-revision-a1",
    }), [NOW]);
  }, "23503", "execution_plans_compile_result_fk");

  await expectConstraint(pool, compileResultInsert({
    resultId: "b2-blocked-with-plan",
    planId: "b2-plan-for-blocked",
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
    status: "blocked",
  }), [NOW], "23514", "compile_results_plan_shape");

  await expectTransactionConstraint(pool, async (client) => {
    await client.query(compileResultInsert({
      resultId: "b2-mismatch-result",
      planId: "b2-mismatch-plan",
      workflowId: "b2-workflow-a",
      revisionId: "b2-revision-a1",
      status: "ready",
    }), [NOW]);
    await client.query(executionPlanInsert({
      resultId: "b2-mismatch-result",
      planId: "b2-mismatch-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
    }), [NOW]);
  }, "23503", "compile_results_execution_plan_fk");

  await expectConstraint(pool, executionPlanInsert({
    resultId: "b2-compile-a1",
    planId: "b2-second-plan",
    workflowId: "b2-workflow-a",
    revisionId: "b2-revision-a1",
  }), [NOW], "23505", "execution_plans_compile_result_uq");

  await expectTransactionConstraint(pool, async (client) => {
    await client.query(compileResultInsert({
      resultId: "b2-projection-mismatch-result",
      planId: "b2-projection-mismatch-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      status: "ready",
    }), [NOW]);
    await client.query(executionPlanInsert({
      resultId: "b2-projection-mismatch-result",
      planId: "b2-projection-mismatch-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      stepNodeId: "node-other",
    }), [NOW]);
  }, "23503", "execution_plans_compile_result_fk");

  await expectTransactionConstraint(pool, async (client) => {
    await client.query(compileResultInsert({
      resultId: "b2-review-projection-mismatch-result",
      planId: "b2-review-projection-mismatch-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      status: "ready",
      orderedSteps: ["node-a", "node-review"],
      reviewGates: ["node-a"],
    }), [NOW]);
    await client.query(executionPlanInsert({
      resultId: "b2-review-projection-mismatch-result",
      planId: "b2-review-projection-mismatch-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      stepNodeIds: ["node-a", "node-review"],
      reviewGateNodeIds: ["node-review"],
    }), [NOW]);
  }, "23503", "execution_plans_compile_result_fk");
}

async function seedConnectionAndSkill(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(connectionRootInsert({
      connectionId: "b2-connection-a",
      revisionId: "b2-connection-a-r1",
      label: "Lark tasks",
    }), [NOW]);
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref,
        store_binding_revision, credential_fingerprint, status,
        created_by_principal_id, created_by_principal_kind,
        probed_at, created_at, updated_at
      ) VALUES (
        'b2-workspace-a', 'b2-secret-binding-lark',
        'b2-workspace-a-b2-user-a-personal', 'workbench-secret-binding-v1',
        'connection', 'b2-connection-a', 'cloud_secret_store',
        'b2-lark-store', 1, $1, 'active', 'b2-user-a', 'user', $2, $2, $2
      )
    `, [hash("8"), NOW]);
    await client.query(connectionRevisionInsert({
      connectionId: "b2-connection-a",
      revisionId: "b2-connection-a-r1",
      credentialState: "bound",
      secretBindingId: "b2-secret-binding-lark",
      credentialFingerprint: hash("8"),
      readinessStatus: "connected",
      validationStatus: "valid",
      validationPrincipal: "tenant-a",
      validationCheckedAt: NOW,
    }), [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await expectTransactionConstraint(pool, async (transaction) => {
    await transaction.query(connectionRootInsert({
      connectionId: "b2-bound-without-secret-binding",
      revisionId: "b2-bound-without-secret-binding-r1",
      label: "Missing SecretBinding",
    }), [NOW]);
    await transaction.query(connectionRevisionInsert({
      connectionId: "b2-bound-without-secret-binding",
      revisionId: "b2-bound-without-secret-binding-r1",
      credentialState: "bound",
      credentialFingerprint: hash("9"),
    }), [NOW]);
  }, "23514", "workspace_connection_revisions_binding_shape");
  await expectTransactionConstraint(pool, async (transaction) => {
    await transaction.query(connectionRootInsert({
      connectionId: "b2-unsafe-connection-config",
      revisionId: "b2-unsafe-connection-config-r1",
      label: "Unsafe config",
    }), [NOW]);
    await transaction.query(connectionRevisionInsert({
      connectionId: "b2-unsafe-connection-config",
      revisionId: "b2-unsafe-connection-config-r1",
      safeConfiguration: { accountLabel: "team", token: "must-not-persist" },
    }), [NOW]);
  }, "23514", "workspace_connection_revisions_safe_configuration");
  await expectTransactionError(pool, async (transaction) => {
    await transaction.query(connectionRootInsert({
      connectionId: "b2-invalid-connected",
      revisionId: "b2-invalid-connected-r1",
      label: "Invalid connected",
    }), [NOW]);
    await transaction.query(connectionRevisionInsert({
      connectionId: "b2-invalid-connected",
      revisionId: "b2-invalid-connected-r1",
      readinessStatus: "connected",
    }), [NOW]);
  }, "23514", /workspace_connection_validation_not_fresh/);

  await pool.query(`
    INSERT INTO public.skill_system_catalog_principals (
      principal_id, product_user_id, schema_version, status, created_at, updated_at
    ) VALUES ('system-catalog', 'system-catalog', 'workbench-v1', 'enabled', $1, $1)
    ON CONFLICT (principal_id) DO UPDATE SET status = 'enabled', updated_at = EXCLUDED.updated_at
  `, [NOW]);
  await pool.query(objectInsert("b2-workspace-a", "b2-skill-object", "skill_package", SKILL_OBJECT_HASH));
  await pool.query(`
    INSERT INTO public.skill_assets (
      workspace_id, skill_id, scope_id, owner_system_principal_id, schema_version,
      name_normalized, visibility, lifecycle, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-skill', 'b2-workspace-a-b2-user-a-personal',
      'system-catalog', 'workbench-v1',
      'b2-skill', 'workspace', 'published', $1, $1
    )
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.skill_system_catalog_sources (
      workspace_id, catalog_source_id, skill_id, system_principal_id, schema_version,
      source_locator, source_revision, source_manifest_hash, package_object_id,
      package_object_hash, package_hash, published_version_content_hash,
      runtime_probe_id, runtime_probe_status, runtime_probe_code, runtime_probe_digest,
      execution_ref, execution_ref_hash, probed_at, created_at, definition
    ) VALUES (
      'b2-workspace-a', 'b2-skill-source', 'b2-skill', 'system-catalog',
      'workbench-internal-v1', 'bundled://b2/skill', '1.0.0', $1,
      'b2-skill-object', $2, $3, $4, 'b2-probe', 'ready', 'runtime_ready', $5,
      '{"capabilityId":"b2-echo","taskIntent":"echo","adapterVersion":"1.0.0","executionMode":"deterministic"}'::jsonb, $6, $7, $7, '{"name":"B2 skill","description":"Echo team input","category":"data","inputSchema":{"type":"object","properties":{"goal":{"type":"string"}},"required":["goal"]},"outputSchema":{"type":"object","properties":{"result":{"type":"string"}},"required":["result"]},"risk":{"level":"low","externalAction":false,"summary":"No external effects"},"dependencies":[],"connectionRequirements":[]}'::jsonb
    )
  `, [MANIFEST_HASH, SKILL_OBJECT_HASH, SKILL_PACKAGE_HASH, SKILL_VERSION_HASH, PROBE_HASH, EXECUTION_REF_HASH, NOW]);
  await pool.query(`
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b2-workspace-a', 'b2-skill-v1', 'b2-skill', '1.0.0', 'workbench-v1',
      'system_catalog', 'b2-skill-source', 'b2-skill-object', $1, $2, $3,
      'system-catalog', $4, '{"name":"B2 skill","description":"Echo team input","category":"data","inputSchema":{"type":"object","properties":{"goal":{"type":"string"}},"required":["goal"]},"outputSchema":{"type":"object","properties":{"result":{"type":"string"}},"required":["result"]},"risk":{"level":"low","externalAction":false,"summary":"No external effects"},"dependencies":[],"connectionRequirements":[]}'::jsonb
    )
  `, [SKILL_OBJECT_HASH, SKILL_PACKAGE_HASH, SKILL_VERSION_HASH, NOW]);
  await pool.query(`
    UPDATE public.skill_assets
    SET latest_published_version_id = 'b2-skill-v1', updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND skill_id = 'b2-skill'
  `, [LATER]);
}

async function seedLoopVersionsAndPins(pool) {
  for (const [loopVersionId, version, contentHash] of [
    ["b2-loop-v1", "1.0.0", LOOP_V1_HASH],
    ["b2-loop-v2", "2.0.0", LOOP_V2_HASH],
  ]) {
    await pool.query(`
      INSERT INTO public.loop_versions (
        workspace_id, loop_version_id, workflow_id, workflow_revision_id,
        schema_version, version, workflow_revision_content_hash, compile_result_id,
        execution_plan_id, definition, content_hash, released_by, released_at
      ) VALUES (
        'b2-workspace-a', $1, 'b2-workflow-a', 'b2-revision-a1',
        'workbench-v1', $2, $3, 'b2-compile-a1', 'b2-plan-a1',
        '{"name":"B2 loop"}'::jsonb, $4, 'b2-user-a', $5
      )
    `, [loopVersionId, version, REVISION_HASH, contentHash, NOW]);
  }
  await expectTransactionConstraint(pool, async (client) => {
    await client.query(`
      INSERT INTO public.loop_versions (
        workspace_id, loop_version_id, workflow_id, workflow_revision_id,
        schema_version, version, workflow_revision_content_hash, compile_result_id,
        execution_plan_id, definition, content_hash, released_by, released_at
      ) VALUES (
        'b2-workspace-a', 'b2-loop-missing-skill-pin', 'b2-workflow-a',
        'b2-revision-a1', 'workbench-v1', '3.0.0', $1, 'b2-compile-a1',
        'b2-plan-a1', '{"name":"Missing pin"}'::jsonb, $2, 'b2-user-a', $3
      )
    `, [REVISION_HASH, hash("0"), NOW]);
    await client.query(`
      UPDATE public.loop_versions
      SET pins_finalized = true
      WHERE workspace_id = 'b2-workspace-a'
        AND loop_version_id = 'b2-loop-missing-skill-pin'
    `);
  }, "55000", undefined);
  await pool.query(`
    INSERT INTO public.loop_version_skill_pins (
      workspace_id, loop_version_id, workflow_id, skill_id, skill_version_id,
      version, content_hash, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v1', 'b2-workflow-a', 'b2-skill', 'b2-skill-v1',
      '1.0.0', $1, 'workbench-internal-v1'
    )
  `, [SKILL_VERSION_HASH]);
  await pool.query(`
    INSERT INTO public.loop_version_resource_pins (
      workspace_id, loop_version_id, workflow_id, resource_id, resource_version,
      content_hash, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v1', 'b2-workflow-a', 'b2-resource', '1.0.0',
      $1, 'workbench-internal-v1'
    )
  `, [RESOURCE_HASH]);
  await pool.query(`
    INSERT INTO public.loop_version_connection_requirements (
      workspace_id, loop_version_id, workflow_id, requirement_id,
      capability_key, description, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v1', 'b2-workflow-a', 'lark-task',
      'lark.task', 'Create a governed task.', 'workbench-internal-v1'
    )
  `);

  await expectConstraint(pool, `
    INSERT INTO public.loop_version_skill_pins (
      workspace_id, loop_version_id, workflow_id, skill_id, skill_version_id,
      version, content_hash, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v2', 'b2-workflow-a', 'b2-skill', 'b2-skill-v1',
      '9.9.9', $1, 'workbench-internal-v1'
    )
  `, [SKILL_VERSION_HASH], "23503", "loop_version_skill_pins_skill_fk");
  await expectConstraint(pool, `
    INSERT INTO public.loop_version_resource_pins (
      workspace_id, loop_version_id, workflow_id, resource_id, resource_version,
      content_hash, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v2', 'b2-workflow-a', 'b2-resource', '1.0.0',
      $1, 'workbench-internal-v1'
    )
  `, [hash("9")], "23503", "loop_version_resource_pins_resource_fk");
  await pool.query(`
    INSERT INTO public.loop_version_skill_pins (
      workspace_id, loop_version_id, workflow_id, skill_id, skill_version_id,
      version, content_hash, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v2', 'b2-workflow-a', 'b2-skill', 'b2-skill-v1',
      '1.0.0', $1, 'workbench-internal-v1'
    )
  `, [SKILL_VERSION_HASH]);
  await pool.query(`
    INSERT INTO public.loop_version_resource_pins (
      workspace_id, loop_version_id, workflow_id, resource_id, resource_version,
      content_hash, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v2', 'b2-workflow-a', 'b2-resource', '1.0.0',
      $1, 'workbench-internal-v1'
    )
  `, [RESOURCE_HASH]);

  await pool.query(`
    UPDATE public.loop_versions
    SET pins_finalized = true
    WHERE workspace_id = 'b2-workspace-a'
      AND loop_version_id IN ('b2-loop-v1', 'b2-loop-v2')
  `);
  await expectSqlState(pool, `
    INSERT INTO public.loop_version_connection_requirements (
      workspace_id, loop_version_id, workflow_id, requirement_id,
      capability_key, description, schema_version
    ) VALUES (
      'b2-workspace-a', 'b2-loop-v1', 'b2-workflow-a', 'late-connection',
      'lark.task', 'Must not mutate a released pin set.', 'workbench-internal-v1'
    )
  `, [], "55000");
  await expectSqlState(pool, `
    INSERT INTO public.execution_plan_model_pins (
      workspace_id, plan_id, node_id, pin_role, ordinal,
      model_profile_revision_id, schema_version, created_at
    ) VALUES (
      'b2-workspace-a', 'b2-plan-a1', 'node-a', 'primary', 0,
      'b2-late-model-revision', 'workbench-internal-v1', $1
    )
  `, [NOW], "55000");
}

async function assertTypedReleaseAuthority(pool) {
  await insertLoopRelease(pool, "b2-release-loop-v2", "b2-loop-v2", "2.0.0", LOOP_V2_HASH);
  await pool.query(`
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      skill_id, skill_version_id, version, content_hash, visibility, domain,
      published_by, published_at
    ) VALUES (
      'b2-workspace-a', 'b2-release-skill', 'workbench-v1', 'skill',
      'b2-skill', 'b2-skill-v1', '1.0.0', $1, 'workspace', 'engineering',
      'b2-user-a', $2
    )
  `, [SKILL_VERSION_HASH, NOW]);

  await expectConstraint(pool, `
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      skill_id, skill_version_id, version, content_hash, visibility, domain,
      published_by, published_at
    ) VALUES (
      'b2-workspace-a', 'b2-release-skill-as-loop', 'workbench-v1', 'skill',
      'b2-workflow-a', 'b2-loop-v1', '1.0.0', $1, 'workspace', 'product',
      'b2-user-a', $2
    )
  `, [LOOP_V1_HASH, NOW], "23503", "workspace_asset_releases_skill_fk");
  await expectConstraint(pool, `
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      loop_workflow_id, loop_version_id, version, content_hash, visibility, domain,
      published_by, published_at
    ) VALUES (
      'b2-workspace-a', 'b2-release-loop-as-skill', 'workbench-v1', 'loop',
      'b2-skill', 'b2-skill-v1', '1.0.0', $1, 'workspace', 'product',
      'b2-user-a', $2
    )
  `, [SKILL_VERSION_HASH, NOW], "23503", "workspace_asset_releases_loop_fk");
  await expectConstraint(pool, `
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      loop_workflow_id, loop_version_id, version, content_hash, visibility, domain,
      published_by, published_at
    ) VALUES (
      'b2-workspace-a', 'b2-release-wrong-hash', 'workbench-v1', 'loop',
      'b2-workflow-a', 'b2-loop-v1', '1.0.0', $1, 'workspace', 'product',
      'b2-user-a', $2
    )
  `, [hash("0"), NOW], "23503", "workspace_asset_releases_loop_fk");
  await insertLoopRelease(pool, "b2-release-loop-v1", "b2-loop-v1", "1.0.0", LOOP_V1_HASH);
  await expectConstraint(pool, `
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      loop_workflow_id, loop_version_id, version, content_hash, visibility, domain,
      published_by, published_at
    ) VALUES (
      'b2-workspace-a', 'b2-release-duplicate-version', 'workbench-v1', 'loop',
      'b2-workflow-a', 'b2-loop-v1', '1.0.0', $1, 'workspace', 'product',
      'b2-user-a', $2
    )
  `, [LOOP_V1_HASH, NOW], "23505", "workspace_asset_releases_asset_version_uq");
}

async function assertInstallationUpdateAuthority(pool) {
  await pool.query(`
    INSERT INTO public.asset_installations (
      workspace_id, installation_id, source_workspace_id, release_id,
      schema_version, asset_kind, loop_workflow_id, loop_version_id, state,
      installed_by, installed_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-installation', 'b2-workspace-a', 'b2-release-loop-v1',
      'workbench-v1', 'loop', 'b2-workflow-a', 'b2-loop-v1', 'installed',
      'b2-user-a', $1, $1
    )
  `, [NOW]);
  await insertUpdateDraft(pool, {
    draftId: "b2-update-draft",
    baseReleaseId: "b2-release-loop-v1",
    baseVersionId: "b2-loop-v1",
    targetReleaseId: "b2-release-loop-v2",
    targetVersionId: "b2-loop-v2",
  });
  await insertUpdateDraft(pool, {
    draftId: "b2-stale-update-draft",
    baseReleaseId: "b2-release-loop-v1",
    baseVersionId: "b2-loop-v1",
    targetReleaseId: "b2-release-loop-v2",
    targetVersionId: "b2-loop-v2",
  });
  const afterCreate = await installationIdentity(pool);
  assert.deepEqual(afterCreate, {
    release_id: "b2-release-loop-v1",
    pinned_version_id: "b2-loop-v1",
    state: "installed",
    write_version: 1,
  });

  await expectConstraint(pool, `
    INSERT INTO public.installation_update_drafts (
      workspace_id, source_workspace_id, update_draft_id, installation_id, created_by, schema_version,
      asset_kind, loop_workflow_id, base_loop_version_id, target_loop_version_id,
      base_release_id, target_release_id, base_installation_write_version,
      impact, status, revision, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-workspace-a', 'b2-update-wrong-target', 'b2-installation', 'b2-user-a',
      'workbench-v1', 'loop', 'b2-workflow-a', 'b2-loop-v1', 'b2-loop-v1',
      'b2-release-loop-v1', 'b2-release-loop-v2', 1, '{}'::jsonb,
      'pending_review', 1, $1, $1
    )
  `, [NOW], "23503", "installation_update_drafts_target_loop_release_fk");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const applied = await client.query(`
      UPDATE public.asset_installations
      SET release_id = 'b2-release-loop-v2', loop_version_id = 'b2-loop-v2',
          state = 'installed', write_version = write_version + 1, updated_at = $1
      WHERE workspace_id = 'b2-workspace-a' AND installation_id = 'b2-installation'
        AND release_id = 'b2-release-loop-v1' AND loop_version_id = 'b2-loop-v1'
        AND write_version = (
          SELECT base_installation_write_version
          FROM public.installation_update_drafts
          WHERE workspace_id = 'b2-workspace-a'
            AND update_draft_id = 'b2-update-draft'
        )
    `, [LATER]);
    assert.equal(applied.rowCount, 1);
    await client.query(`
      UPDATE public.installation_update_drafts
      SET status = 'applied', decided_at = $1, revision = revision + 1, updated_at = $1
      WHERE workspace_id = 'b2-workspace-a' AND update_draft_id = 'b2-update-draft'
        AND status = 'pending_review' AND revision = 1
    `, [LATER]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const history = await pool.query(`
    SELECT base_release_id, base_pinned_version_id, target_release_id, target_version_id, status
    FROM public.installation_update_drafts
    WHERE workspace_id = 'b2-workspace-a' AND update_draft_id = 'b2-update-draft'
  `);
  assert.deepEqual(history.rows[0], {
    base_release_id: "b2-release-loop-v1",
    base_pinned_version_id: "b2-loop-v1",
    target_release_id: "b2-release-loop-v2",
    target_version_id: "b2-loop-v2",
    status: "applied",
  });
  await assert.rejects(
    insertUpdateDraft(pool, {
      draftId: "b2-forged-stale-update-draft",
      baseReleaseId: "b2-release-loop-v1",
      baseVersionId: "b2-loop-v1",
      targetReleaseId: "b2-release-loop-v2",
      targetVersionId: "b2-loop-v2",
    }),
    (error) => error?.code === "55000",
  );
  await expectSqlState(pool, `
    UPDATE public.installation_update_drafts
    SET status = 'pending_review', decided_at = NULL,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND update_draft_id = 'b2-update-draft'
  `, [LATER], "55000");
  await expectSqlState(pool, `
    UPDATE public.installation_update_drafts
    SET base_installation_write_version = 2,
        revision = revision + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND update_draft_id = 'b2-stale-update-draft'
  `, [LATER], "55000");
  const abaReset = await pool.query(`
    UPDATE public.asset_installations
    SET release_id = 'b2-release-loop-v1', loop_version_id = 'b2-loop-v1',
        write_version = write_version + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND installation_id = 'b2-installation'
      AND release_id = 'b2-release-loop-v2' AND loop_version_id = 'b2-loop-v2'
      AND write_version = 2
  `, [LATER]);
  assert.equal(abaReset.rowCount, 1);
  const staleClient = await pool.connect();
  try {
    await staleClient.query("BEGIN");
    const staleApply = await staleClient.query(`
      UPDATE public.asset_installations
      SET release_id = 'b2-release-loop-v2', loop_version_id = 'b2-loop-v2',
          write_version = write_version + 1, updated_at = $1
      WHERE workspace_id = 'b2-workspace-a' AND installation_id = 'b2-installation'
        AND release_id = 'b2-release-loop-v1' AND loop_version_id = 'b2-loop-v1'
        AND write_version = (
          SELECT base_installation_write_version
          FROM public.installation_update_drafts
          WHERE workspace_id = 'b2-workspace-a'
            AND update_draft_id = 'b2-stale-update-draft'
        )
    `, [LATER]);
    assert.equal(staleApply.rowCount, 0);
    await staleClient.query(`
      UPDATE public.installation_update_drafts
      SET status = 'conflicted', conflict_reason = 'installation_base_changed',
          revision = revision + 1, updated_at = $1
      WHERE workspace_id = 'b2-workspace-a' AND update_draft_id = 'b2-stale-update-draft'
        AND status = 'pending_review' AND revision = 1
    `, [LATER]);
    await staleClient.query("COMMIT");
  } finally {
    staleClient.release();
  }
  assert.deepEqual(await installationIdentity(pool), {
    release_id: "b2-release-loop-v1",
    pinned_version_id: "b2-loop-v1",
    state: "installed",
    write_version: 3,
  });
}

async function assertConnectionBindingAuthority(pool) {
  await pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-binding-workflow', 'b2-connection-a', 'lark-task',
      'b2-user-a', 'workbench-v1', 'b2-workflow-a', 'b2-revision-a1', $1, $1
    )
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, installation_id, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-binding-installation', 'b2-connection-a', 'lark-task',
      'b2-user-a', 'workbench-v1', 'b2-installation', $1, $1
    )
  `, [NOW]);
  await expectConstraint(pool, `
    INSERT INTO public.asset_installations (
      workspace_id, installation_id, source_workspace_id, release_id,
      schema_version, asset_kind, loop_workflow_id, loop_version_id, state,
      installed_by, installed_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-installation-wrong-version', 'b2-workspace-a',
      'b2-release-loop-v2', 'workbench-v1', 'loop', 'b2-workflow-a',
      'b2-loop-v2', 'installed', 'b2-user-a', $1, $1
    )
  `, [NOW], "23505", "asset_installations_active_asset_uq");
  await pool.query(`
    INSERT INTO public.asset_installations (
      workspace_id, installation_id, source_workspace_id, release_id,
      schema_version, asset_kind, loop_workflow_id, loop_version_id, state,
      installed_by, installed_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-installation-removed', 'b2-workspace-a',
      'b2-release-loop-v2', 'workbench-v1', 'loop', 'b2-workflow-a',
      'b2-loop-v2', 'removed', 'b2-user-a', $1, $1
    )
  `, [NOW]);
  await assert.rejects(pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, installation_id, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-binding-installation-wrong-version',
      'b2-connection-a', 'lark-task', 'b2-user-a', 'workbench-v1',
      'b2-installation-removed', $1, $1
    )
  `, [NOW]), (error) => (
    error?.code === "23514"
    && /workspace_connection_binding_requirement_invalid/.test(error?.message ?? "")
  ));
  await assert.rejects(pool.query(`
    INSERT INTO public.workspace_connection_bindings (
      workspace_id, binding_id, connection_id, requirement_id, bound_by,
      schema_version, workflow_id, workflow_revision_id, created_at, updated_at
    ) VALUES (
      'b2-workspace-b', 'b2-binding-cross', 'b2-connection-a', 'lark-task',
      'b2-user-c', 'workbench-v1', 'b2-workflow-a', 'b2-revision-a1', $1, $1
    )
  `, [NOW]), (error) => (
    error?.code === "23514"
    && /workspace_connection_binding_requirement_invalid/.test(error?.message ?? "")
  ));
}

async function seedExecutionInvocations(pool) {
  for (const actor of [
    { suffix: "a", userId: "b2-user-a", commandId: "b2-command-a" },
    { suffix: "a2", userId: "b2-user-a", commandId: "b2-command-a2" },
    { suffix: "b", userId: "b2-user-b", commandId: "b2-command-b" },
  ]) {
    await insertAuthorizedProductCommand(pool, {
      commandId: actor.commandId, workspaceId: "b2-workspace-a", userId: actor.userId,
      kind: "builder_proposal", sessionId: `b2-session-${actor.suffix}`,
      turnId: `b2-turn-${actor.suffix}`,
    });
    await pool.query(`
      INSERT INTO public.admission_waiting (
        admission_id, command_id, workspace_id, schema_version, kind,
        invocation_id, state, created_at, updated_at
      ) VALUES ($1, $2, 'b2-workspace-a', 'workbench-v1',
        'execution_invocation', $3, 'waiting_capacity', $4, $4)
    `, [`b2-admission-${actor.suffix}`, actor.commandId, `b2-slot-${actor.suffix}`, NOW]);
    await pool.query(`
      INSERT INTO public.capacity_leases (
        capacity_lease_id, admission_id, command_id, workspace_id,
        schema_version, backend_key, provider_key, fence, lease_duration_ms,
        status, issued_at, expires_at, updated_at, dimensions
      ) VALUES ($1, $2, $3, 'b2-workspace-a', 'workbench-v1',
        'bounded_agent:process', 'provider:none', 1, 60000, 'active', $4, $5, $4, '[]'::jsonb)
    `, [`b2-capacity-${actor.suffix}`, `b2-admission-${actor.suffix}`, actor.commandId, NOW, EXPIRY]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO public.execution_invocations (
          invocation_id, workspace_id, schema_version, attempt_id, product_command_id,
          lineage_session_id, lineage_turn_id, controller_kind,
          controller_id, controller_fence, mode, isolation, status, execution_fence,
          capacity_admission_id, capacity_lease_id, capacity_fence,
          capacity_backend_key, capacity_provider_key, capability_lease_id,
          created_at, updated_at
        ) VALUES ($1, 'b2-workspace-a', 'workbench-execution-fabric-v1', $2, $3,
          $4, $5, 'agent_turn', $5, 1, 'bounded_agent', 'process', 'queued', 1,
          $6, $7, 1, 'bounded_agent:process', 'provider:none', $8, $9, $9)
      `, [
        `b2-invocation-${actor.suffix}`, `b2-attempt-${actor.suffix}`,
        actor.commandId, `b2-session-${actor.suffix}`,
        `b2-turn-${actor.suffix}`, `b2-admission-${actor.suffix}`,
        `b2-capacity-${actor.suffix}`, `b2-capability-${actor.suffix}`, NOW,
      ]);
      await client.query(`
        INSERT INTO public.execution_attempts (
          attempt_id, invocation_id, schema_version, attempt_number, status,
          fence, created_at, updated_at
        ) VALUES ($1, $2, 'workbench-execution-fabric-v1', 1, 'queued', 1, $3, $3)
      `, [`b2-attempt-${actor.suffix}`, `b2-invocation-${actor.suffix}`, NOW]);
      await client.query(`
        INSERT INTO public.capability_leases (
          capability_lease_id, invocation_id, attempt_id, workspace_id,
          schema_version, fence, status, issued_at, expires_at, updated_at
        ) VALUES ($1, $2, $3, 'b2-workspace-a', 'workbench-execution-fabric-v1',
          1, 'active', $4, $5, $4)
      `, [
        `b2-capability-${actor.suffix}`, `b2-invocation-${actor.suffix}`,
        `b2-attempt-${actor.suffix}`, NOW, EXPIRY,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function assertBuilderProposalLineage(pool) {
  await expectConstraint(pool, `
    INSERT INTO public.builder_proposals (
      workspace_id, proposal_id, scope_id,
      created_by_principal_id, created_by_principal_kind, schema_version, kind,
      workflow_id, base_revision_id, status, generation_status, summary, created_at
    ) VALUES (
      'b2-workspace-a', 'b2-proposal-no-command',
      'b2-workspace-a-b2-user-a-personal', 'b2-user-a', 'user', 'workbench-v1',
      'workflow_change', 'b2-workflow-a', 'b2-revision-a1',
      'proposed', 'completed', 'Missing command', $1
    )
  `, [NOW], "23502", undefined);
  await pool.query(proposalInsert({
    proposalId: "b2-proposal-planned",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-not-created-yet",
    plannedAttemptId: "b2-not-created-attempt-yet",
  }), [NOW]);
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-half-planned",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-half-planned",
  }), [NOW], "23514", "builder_proposals_planned_execution_shape");
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-source-without-reservation",
    commandId: "b2-command-a",
    sourceInvocationId: "b2-invocation-a",
    sourceAttemptId: "b2-attempt-a",
  }), [NOW], "23514", "builder_proposals_source_execution_shape");
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-missing-source",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-not-created",
    plannedAttemptId: "b2-not-created-attempt",
    sourceInvocationId: "b2-not-created",
    sourceAttemptId: "b2-not-created-attempt",
  }), [NOW], "23503", "builder_proposals_source_invocation_fk");
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-other-actor",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-invocation-b",
    plannedAttemptId: "b2-attempt-b",
    sourceInvocationId: "b2-invocation-b",
    sourceAttemptId: "b2-attempt-b",
  }), [NOW], "23503", "builder_proposals_source_invocation_fk");
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-other-command",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-invocation-a2",
    plannedAttemptId: "b2-attempt-a2",
    sourceInvocationId: "b2-invocation-a2",
    sourceAttemptId: "b2-attempt-a2",
  }), [NOW], "23503", "builder_proposals_source_invocation_fk");
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-wrong-attempt",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-invocation-a",
    plannedAttemptId: "b2-attempt-b",
    sourceInvocationId: "b2-invocation-a",
    sourceAttemptId: "b2-attempt-b",
  }), [NOW], "23503", "builder_proposals_source_invocation_fk");
  await expectConstraint(pool, proposalInsert({
    proposalId: "b2-proposal-reservation-mismatch",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-reserved-other",
    plannedAttemptId: "b2-reserved-other-attempt",
    sourceInvocationId: "b2-invocation-a",
    sourceAttemptId: "b2-attempt-a",
  }), [NOW], "23514", "builder_proposals_source_execution_shape");
  await pool.query(proposalInsert({
    proposalId: "b2-proposal-source",
    commandId: "b2-command-a",
    plannedInvocationId: "b2-invocation-a",
    plannedAttemptId: "b2-attempt-a",
    sourceInvocationId: "b2-invocation-a",
    sourceAttemptId: "b2-attempt-a",
  }), [NOW]);
}

async function assertLoopImportAuthority(pool) {
  await pool.query(objectInsert("b2-workspace-a", "b2-loop-object", "loop_package", LOOP_OBJECT_HASH));
  await pool.query(`
    INSERT INTO public.upload_sessions (
      workspace_id, upload_id, requested_by, schema_version, asset_kind, state,
      file_name, size_bytes, media_type, ingest_method, received_bytes,
      object_id, object_kind, object_content_hash, package_hash,
      inspection_status, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-loop-upload', 'b2-user-a', 'workbench-v1', 'loop',
      'ready_draft', 'loop.json', 12, 'application/json', 'files', 12,
      'b2-loop-object', 'loop_package', $1, $2, 'passed', $3, $3
    )
  `, [LOOP_OBJECT_HASH, SKILL_PACKAGE_HASH, NOW]);
  await pool.query(`
    INSERT INTO public.loop_imports (
      workspace_id, import_id, upload_id, imported_by, schema_version, status,
      source_object_id, source_content_hash, source_package_hash, requirement_states,
      diagnostics, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-loop-import', 'b2-loop-upload', 'b2-user-a',
      'workbench-v1', 'ready', 'b2-loop-object', $1, $2, '[]'::jsonb,
      '[]'::jsonb, $3, $3
    )
  `, [LOOP_OBJECT_HASH, SKILL_PACKAGE_HASH, NOW]);
  await pool.query(`
    UPDATE public.loop_imports
    SET status = 'committed', committed_workflow_id = 'b2-workflow-a',
        committed_revision_id = 'b2-revision-a1', row_revision = row_revision + 1,
        updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND import_id = 'b2-loop-import'
      AND imported_by = 'b2-user-a' AND row_revision = 1
  `, [LATER]);
  await expectConstraint(pool, `
    UPDATE public.loop_imports
    SET committed_workflow_id = 'b2-workflow-other', updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND import_id = 'b2-loop-import'
  `, [LATER], "23503", "loop_imports_committed_revision_fk");
}

async function assertImmutableAndMutableBoundaries(pool) {
  await expectSqlState(pool, `
    UPDATE public.templates
    SET name = 'Mutated template', updated_at = $1
    WHERE template_id = 'b2-template' AND template_version = '1.0.0'
  `, [LATER], "55000");
  await expectSqlState(pool, `
    DELETE FROM public.templates
    WHERE template_id = 'b2-template' AND template_version = '1.0.0'
  `, [], "55000");
  const availabilityProjection = await pool.query(`
    UPDATE public.templates
    SET availability_status = 'blocked',
        availability_diagnostics = '[{"code":"runtime_unavailable"}]'::jsonb,
        updated_at = $1
    WHERE template_id = 'b2-template' AND template_version = '1.0.0'
  `, [LATER]);
  assert.equal(availabilityProjection.rowCount, 1);

  for (const [table, assignment, predicate] of [
    ["workflow_revisions", "save_reason = save_reason", "workspace_id = 'b2-workspace-a' AND revision_id = 'b2-revision-a1'"],
    ["compile_results", "compiled_at = compiled_at", "workspace_id = 'b2-workspace-a' AND compile_result_id = 'b2-compile-a1'"],
    ["execution_plans", "generated_at = generated_at", "workspace_id = 'b2-workspace-a' AND plan_id = 'b2-plan-a1'"],
    ["loop_versions", "released_at = released_at", "workspace_id = 'b2-workspace-a' AND loop_version_id = 'b2-loop-v1'"],
    ["workspace_asset_releases", "published_at = published_at", "source_workspace_id = 'b2-workspace-a' AND release_id = 'b2-release-loop-v1'"],
  ]) {
    await expectSqlState(pool, `UPDATE public.${table} SET ${assignment} WHERE ${predicate}`, [], "55000");
    await expectSqlState(pool, `DELETE FROM public.${table} WHERE ${predicate}`, [], "55000");
  }

  const mutableWorkflow = await pool.query(`
    UPDATE public.workflows SET description = 'mutable workflow',
      write_version = write_version + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND workflow_id = 'b2-workflow-a'
  `, [LATER]);
  const mutableInstallation = await pool.query(`
    UPDATE public.asset_installations SET state = 'update_available',
      write_version = write_version + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND installation_id = 'b2-installation'
  `, [LATER]);
  const mutableDraft = await pool.query(`
    UPDATE public.installation_update_drafts SET revision = revision + 1, updated_at = $1
    WHERE workspace_id = 'b2-workspace-a' AND update_draft_id = 'b2-stale-update-draft'
  `, [LATER]);
  assert.equal(mutableWorkflow.rowCount, 1);
  assert.equal(mutableInstallation.rowCount, 1);
  assert.equal(mutableDraft.rowCount, 1);
}

async function createWorkflow(pool, {
  workflowId,
  revisionId,
  revisionHash,
  ownerId,
  resourceRefs = [],
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(workflowInsert({ workflowId, revisionId, ownerId }), [NOW]);
    await client.query(revisionInsert({
      revisionId,
      workflowId,
      revisionNumber: 1,
      contentHash: revisionHash,
      resourceRefs,
    }), [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function workflowInsert({
  workspaceId = "b2-workspace-a",
  workflowId,
  revisionId,
  ownerId,
  scopeId = `${workspaceId}-${ownerId}-personal`,
}) {
  return `
    INSERT INTO public.workflows (
      workspace_id, workflow_id, scope_id, owner_user_id, schema_version, name, description,
      status, lifecycle, visibility, current_revision_id, current_revision_number,
      source_template_id, source_template_version, created_at, updated_at
    ) VALUES (
      '${workspaceId}', '${workflowId}', '${scopeId}',
      '${ownerId}', 'workbench-v1', '${workflowId}', '',
      'draft', 'draft', 'private', '${revisionId}', 1,
      'b2-template', '1.0.0', $1, $1
    )
  `;
}

function revisionInsert({
  revisionId,
  workflowId,
  revisionNumber,
  baseRevisionId = null,
  baseRevisionNumber = baseRevisionId === null ? null : revisionNumber - 1,
  contentHash,
  resourceRefs = [],
}) {
  const base = baseRevisionId === null ? "NULL" : `'${baseRevisionId}'`;
  const baseNumber = baseRevisionNumber === null ? "NULL" : String(baseRevisionNumber);
  return `
    INSERT INTO public.workflow_revisions (
      workspace_id, revision_id, workflow_id, revision_number, base_revision_id,
      base_revision_number, schema_version, graph, input_form, output_definition, resource_refs,
      run_settings, definition, content_hash, authored_by, save_reason,
      created_at, updated_at
    ) VALUES (
      'b2-workspace-a', '${revisionId}', '${workflowId}', ${revisionNumber}, ${base}, ${baseNumber},
      'workbench-v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '${JSON.stringify(resourceRefs)}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '${contentHash}', 'b2-user-a', 'B2 fixture', $1, $1
    )
  `;
}

async function insertCompilePair(pool, {
  resultId,
  planId,
  workflowId,
  revisionId,
  orderedSteps = ["node-a"],
  reviewGates = [],
  pinnedSkills = [],
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(compileResultInsert({
      resultId, planId, workflowId, revisionId, status: "ready",
      orderedSteps, reviewGates,
    }), [NOW]);
    await client.query(executionPlanInsert({
      resultId, planId, workflowId, revisionId,
      stepNodeIds: orderedSteps, reviewGateNodeIds: reviewGates, pinnedSkills,
    }), [NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createPinnedCompilePair(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(compileResultInsert({
      resultId: "b2-model-compile",
      planId: "b2-model-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      status: "ready",
    }), [NOW]);
    await client.query(executionPlanInsert({
      resultId: "b2-model-compile",
      planId: "b2-model-plan",
      workflowId: "b2-workflow-other",
      revisionId: "b2-revision-other1",
      modelProfileRevisionId: "b2-model-primary",
      fallbackModelProfileRevisionIds: ["b2-model-fallback"],
      pinsFinalized: false,
    }), [NOW]);
    await client.query(`
      INSERT INTO public.execution_plan_model_pins (
        workspace_id, plan_id, node_id, pin_role, ordinal,
        model_profile_revision_id, schema_version, created_at
      ) VALUES
        ('b2-workspace-a', 'b2-model-plan', 'node-a', 'primary', 0,
          'b2-model-primary', 'workbench-internal-v1', $1),
        ('b2-workspace-a', 'b2-model-plan', 'node-a', 'fallback', 1,
          'b2-model-fallback', 'workbench-internal-v1', $1)
    `, [NOW]);
    await client.query(`
      UPDATE public.execution_plans
      SET pins_finalized = true
      WHERE workspace_id = 'b2-workspace-a' AND plan_id = 'b2-model-plan'
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function connectionRootInsert({ connectionId, revisionId, label }) {
  return `
    INSERT INTO public.workspace_connections (
      workspace_id, connection_id, scope_id, created_by, schema_version,
      label, current_revision_id, current_revision_number,
      created_at, updated_at
    ) VALUES (
      'b2-workspace-a', '${connectionId}',
      'b2-workspace-a-b2-user-a-personal', 'b2-user-a', 'workbench-v1',
      '${label}', '${revisionId}', 1, $1, $1
    )
  `;
}

function connectionRevisionInsert({
  connectionId,
  revisionId,
  safeConfiguration = {},
  credentialState = "unbound",
  secretBindingId = null,
  credentialFingerprint = null,
  readinessStatus = "needs_setup",
  validationStatus = "never_checked",
  validationPrincipal = null,
  validationCheckedAt = null,
}) {
  const quote = (value) => value === null
    ? "NULL"
    : `'${String(value).replaceAll("'", "''")}'`;
  const safeConfigurationSql = quote(JSON.stringify(safeConfiguration));
  return `
    INSERT INTO public.workspace_connection_revisions (
      workspace_id, connection_revision_id, connection_id, scope_id,
      revision_number, schema_version, capability_key, driver_key,
      driver_backend, safe_configuration, credential_state, secret_binding_id,
      credential_binding_fingerprint, readiness_status, validation_status,
      validation_message, validation_principal, validation_checked_at,
      content_hash, created_by, created_at
    ) VALUES (
      'b2-workspace-a', '${revisionId}', '${connectionId}',
      'b2-workspace-a-b2-user-a-personal', 1, 'workbench-connection-v1',
      'lark.task', 'lark', 'production', ${safeConfigurationSql}::jsonb,
      '${credentialState}', ${quote(secretBindingId)}, ${quote(credentialFingerprint)},
      '${readinessStatus}', '${validationStatus}', 'Connection state.',
      ${quote(validationPrincipal)}, ${quote(validationCheckedAt)},
      '${hash("c")}', 'b2-user-a', $1
    )
  `;
}

function compileResultInsert({
  resultId,
  planId,
  workflowId,
  revisionId,
  status,
  orderedSteps = ["node-a"],
  reviewGates = [],
}) {
  const plan = planId === null ? "NULL" : `'${planId}'`;
  return `
    INSERT INTO public.compile_results (
      workspace_id, compile_result_id, workflow_id, workflow_revision_id,
      schema_version, status, execution_plan_id, ordered_steps, review_gates, compiled_at
    ) VALUES (
      'b2-workspace-a', '${resultId}', '${workflowId}', '${revisionId}',
      'workbench-v1', '${status}', ${plan}, '${JSON.stringify(orderedSteps)}'::jsonb,
      '${JSON.stringify(reviewGates)}'::jsonb, $1
    )
  `;
}

function executionPlanInsert({
  resultId,
  planId,
  workflowId,
  revisionId,
  documentWorkflowId = workflowId,
  stepNodeId = "node-a",
  stepNodeIds = [stepNodeId],
  reviewGateNodeIds = [],
  documentGeneratedAt = NOW,
  modelProfileRevisionId = null,
  fallbackModelProfileRevisionIds = [],
  pinsFinalized = true,
  pinnedSkills = [],
  omitDocumentKey = null,
}) {
  const modelRoutingState = modelProfileRevisionId === null ? "not_applicable" : "pinned";
  const planDocumentValue = {
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    workflowId: documentWorkflowId,
    workflowRevisionId: revisionId,
    generatedAt: documentGeneratedAt,
    contentHash: PLAN_HASH,
    maxParallelism: 1,
    modelRoutingState,
    pinnedSkills,
    steps: stepNodeIds.map((nodeId, index) => ({
      nodeId,
      ...(index === 0 && modelProfileRevisionId !== null ? {
        modelProfileRevisionId,
        modelCapability: "chat",
        fallbackModelProfileRevisionIds,
      } : {}),
    })),
    reviewGates: reviewGateNodeIds.map((nodeId) => ({
      nodeId,
      dependsOn: [],
      instructions: "Review the result.",
    })),
    primaryOutput: { nodeId: stepNodeIds[0], portId: "result" },
  };
  if (omitDocumentKey !== null) delete planDocumentValue[omitDocumentKey];
  const planDocument = JSON.stringify(planDocumentValue);
  return `
    INSERT INTO public.execution_plans (
      workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id,
      schema_version, plan_version, content_hash, model_routing_state,
      plan_document, pins_finalized, generated_at
    ) VALUES (
      'b2-workspace-a', '${planId}', '${resultId}', '${workflowId}', '${revisionId}',
      'workbench-execution-plan-v2', 2, '${PLAN_HASH}', '${modelRoutingState}',
      '${planDocument}'::jsonb, ${pinsFinalized}, $1
    )
  `;
}

async function insertLoopRelease(pool, releaseId, loopVersionId, version, contentHash) {
  await pool.query(`
    INSERT INTO public.workspace_asset_releases (
      source_workspace_id, release_id, schema_version, asset_kind,
      loop_workflow_id, loop_version_id, version, content_hash, visibility, domain,
      published_by, published_at
    ) VALUES (
      'b2-workspace-a', $1, 'workbench-v1', 'loop', 'b2-workflow-a', $2,
      $3, $4, 'workspace', 'product', 'b2-user-a', $5
    )
  `, [releaseId, loopVersionId, version, contentHash, NOW]);
}

async function insertUpdateDraft(pool, {
  draftId,
  baseReleaseId,
  baseVersionId,
  targetReleaseId,
  targetVersionId,
  baseWriteVersion = 1,
}) {
  await pool.query(`
    INSERT INTO public.installation_update_drafts (
      workspace_id, source_workspace_id, update_draft_id, installation_id, created_by, schema_version,
      asset_kind, loop_workflow_id, base_loop_version_id, target_loop_version_id,
      base_release_id, target_release_id, base_installation_write_version,
      impact, status, revision, created_at, updated_at
    ) VALUES (
      'b2-workspace-a', 'b2-workspace-a', $1, 'b2-installation', 'b2-user-a', 'workbench-v1',
      'loop', 'b2-workflow-a', $2, $3, $4, $5, $6, '{}'::jsonb,
      'pending_review', 1, $7, $7
    )
  `, [
    draftId, baseVersionId, targetVersionId, baseReleaseId, targetReleaseId,
    baseWriteVersion, NOW,
  ]);
}

function proposalInsert({
  proposalId,
  commandId,
  plannedInvocationId = null,
  plannedAttemptId = null,
  sourceInvocationId = null,
  sourceAttemptId = null,
}) {
  const planned = plannedInvocationId === null ? "NULL" : `'${plannedInvocationId}'`;
  const plannedAttempt = plannedAttemptId === null ? "NULL" : `'${plannedAttemptId}'`;
  const source = sourceInvocationId === null ? "NULL" : `'${sourceInvocationId}'`;
  const sourceAttempt = sourceAttemptId === null ? "NULL" : `'${sourceAttemptId}'`;
  return `
    INSERT INTO public.builder_proposals (
      workspace_id, proposal_id, scope_id,
      created_by_principal_id, created_by_principal_kind,
      product_command_id, schema_version,
      kind, workflow_id, base_revision_id, planned_invocation_id,
      planned_attempt_id, source_invocation_id, source_attempt_id,
      status, generation_status, summary,
      created_at
    ) VALUES (
      'b2-workspace-a', '${proposalId}', 'b2-workspace-a-b2-user-a-personal',
      'b2-user-a', 'user', '${commandId}', 'workbench-v1',
      'workflow_change', 'b2-workflow-a', 'b2-revision-a1', ${planned},
      ${plannedAttempt}, ${source}, ${sourceAttempt},
      'proposed', 'completed', 'B2 proposal', $1
    )
  `;
}

function objectInsert(workspaceId, objectId, objectKind, contentHash) {
  return `
    INSERT INTO public.product_objects (
      workspace_id, object_id, schema_version, object_kind, content_hash,
      size_bytes, media_type, storage_backend, storage_key, storage_version,
      state, created_at
    ) VALUES (
      '${workspaceId}', '${objectId}', 'workbench-v1', '${objectKind}', '${contentHash}',
      12, 'application/octet-stream', 'test-object-store', '${workspaceId}/${objectId}',
      '1', 'promoted', '${NOW}'::timestamptz
    )
  `;
}

async function seedPersonalAuthority(pool, { workspaceId, userId, membershipId }) {
  const scopeId = `${workspaceId}-${userId}-personal`;
  const policyRevisionId = `${workspaceId}-${userId}-policy-1`;
  const scopeGrantId = `${workspaceId}-${userId}-operation`;
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
    `, [workspaceId, scopeId, policyRevisionId, REVISION_HASH, userId, NOW]);
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
  commandId, workspaceId, userId, kind, sessionId, turnId,
}) {
  const authorityOwnerId = workspaceId === "b2-workspace-a" && userId === "b2-user-b"
    ? "b2-user-a"
    : userId;
  const scopeId = `${workspaceId}-${authorityOwnerId}-personal`;
  const policyRevisionId = `${workspaceId}-${authorityOwnerId}-policy-1`;
  const scopeGrantId = `${workspaceId}-${userId}-operation`;
  const authorizerScopeGrantId = `${workspaceId}-${authorityOwnerId}-operation`;
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
    kind, REVISION_HASH, NOW, EXPIRY,
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
      'principal', $7, 'user', $8, $9, 'write_local', $10,
      'interactive', 'authority-v1', 'authorized', $11, 'approved', $12, $13
    )
  `, [
    workspaceId, decisionId, scopeId, policyRevisionId, userId, scopeGrantId,
    authorityOwnerId, authorizerScopeGrantId, kind, REVISION_HASH,
    approvalId, NOW, EXPIRY,
  ]);
  await pool.query(`
    INSERT INTO public.product_commands (
      command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind, authorization_decision_id,
      policy_revision_id, effect_class, argument_digest, quota_user_id,
      schema_version, kind, session_id, turn_id,
      status, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, 'user', $4, 'user', $5, $6,
      'write_local', $7, $4, 'workbench-v1', $8, $9, $10,
      'accepted', $11, $11
    )
  `, [
    commandId, workspaceId, scopeId, userId, decisionId, policyRevisionId,
    REVISION_HASH, kind, sessionId, turnId, NOW,
  ]);
}

async function installationIdentity(pool) {
  const result = await pool.query(`
    SELECT release_id, pinned_version_id, state, write_version
    FROM public.asset_installations
    WHERE workspace_id = 'b2-workspace-a' AND installation_id = 'b2-installation'
  `);
  return result.rows[0];
}

async function expectTransactionConstraint(pool, operation, code, constraint) {
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
  assert.equal(caught?.constraint, constraint, caught?.message);
}

async function expectTransactionError(pool, operation, code, message) {
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
  assert.match(caught?.message ?? "", message);
}

async function expectConstraint(pool, sql, values, code, constraint) {
  await assert.rejects(
    pool.query(sql, values),
    (error) => error?.code === code && error?.constraint === constraint,
  );
}

async function expectSqlState(pool, sql, values, code) {
  await assert.rejects(pool.query(sql, values), (error) => error?.code === code);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
