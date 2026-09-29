import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const NOW = new Date(Date.now() - 60_000).toISOString();
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();
const EXPIRY = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const hash = (character) => `sha256:${character.repeat(64)}`;
const OBJECT_HASH = hash("a");
const RESOURCE_HASH = hash("b");
const ATTACHMENT_HASH = hash("c");
const REPRESENTATION_HASH = hash("d");
const PACKAGE_HASH = hash("e");
const DRAFT_HASH = hash("f");
const DRAFT_V2_HASH = hash("4");
const VERSION_HASH = hash("1");
const SYSTEM_PACKAGE_HASH = hash("5");
const SYSTEM_VERSION_HASH = hash("6");
const SYSTEM_MANIFEST_HASH = hash("7");
const SYSTEM_PROBE_HASH = hash("8");
const SYSTEM_EXECUTION_REF_HASH = hash("0");
const IMAGE_DIGEST = `skill-runtime@${hash("9")}`;

const B1_TABLES = [
  "product_objects",
  "upload_sessions",
  "workspace_resources",
  "input_attachments",
  "attachment_derived_representations",
  "skill_assets",
  "skill_system_catalog_principals",
  "skill_system_catalog_sources",
  "legacy_skill_definitions",
  "skill_drafts",
  "skill_draft_revision_snapshots",
  "skill_versions",
  "skill_test_runs",
  "skill_test_evidence",
  "skill_validations",
  "skill_validation_test_runs",
  "skill_execution_bindings",
];

test("PostgreSQL B1 enforces tenant, lifecycle, CAS, fence, and immutable Skill authority", {
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
  await assertB1Inventory(pool);
  await seedTenants(pool);
  await assertTenantObjectIdentity(pool);
  await seedMaterialAuthority(pool);
  await assertMaterialLifecycle(pool);
  await assertLifecycleVocabularyAndTransitions(pool);
  await seedSkillDraftAndTest(pool);
  await assertDraftCasAndHistoricalEvidence(pool);
  await assertTestClaimFence(pool);
  await assertValidationRejectsForgedEvidence(pool);
  await assertValidationAndPublicationAuthority(pool);
  await assertSystemCatalogPublicationAuthority(pool);
  await assertImmutableHistoryGuards(pool);
  await assertLegacyDefinitionIsolation(pool);
  await assertCrossTenantDenials(pool);
});

async function assertB1Inventory(pool) {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [B1_TABLES]);
  assert.deepEqual(
    tables.rows.map(({ table_name: tableName }) => tableName),
    [...B1_TABLES].sort(),
  );

  const unsafeColumns = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND (data_type = 'bytea' OR column_name ~ '(host_path|provider_payload|secret_value)')
  `, [B1_TABLES]);
  assert.deepEqual(unsafeColumns.rows, []);
}

async function seedTenants(pool) {
  await pool.query(`
    INSERT INTO public.product_users (
      user_id, schema_version, display_name, account_role, created_at, updated_at
    ) VALUES
      ('b1-user-a', 'workbench-v1', 'B1 A', 'member', $1, $1),
      ('b1-user-b', 'workbench-v1', 'B1 B', 'member', $1, $1),
      ('system-catalog', 'workbench-v1', 'System Catalog', NULL, $1, $1)
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES
      ('b1-workspace-a', 'workbench-v1', 'B1 A', 'b1-user-a', $1, $1),
      ('b1-workspace-b', 'workbench-v1', 'B1 B', 'b1-user-b', $1, $1)
  `, [NOW]);
  await pool.query(`
    INSERT INTO public.workspace_memberships (
      membership_id, workspace_id, user_id, schema_version, role, created_at, updated_at
    ) VALUES
      ('b1-membership-a', 'b1-workspace-a', 'b1-user-a', 'workbench-v1', 'owner', $1, $1),
      ('b1-membership-b', 'b1-workspace-b', 'b1-user-b', 'workbench-v1', 'owner', $1, $1)
  `, [NOW]);
  await seedPersonalAuthority(pool, {
    workspaceId: "b1-workspace-a", userId: "b1-user-a", membershipId: "b1-membership-a",
  });
  await seedPersonalAuthority(pool, {
    workspaceId: "b1-workspace-b", userId: "b1-user-b", membershipId: "b1-membership-b",
  });
}

async function assertTenantObjectIdentity(pool) {
  await pool.query(objectInsert({
    workspaceId: "b1-workspace-a",
    objectId: "b1-shared-object",
    kind: "skill_package",
    contentHash: OBJECT_HASH,
    storageKey: "b1/a/shared",
  }));
  await pool.query(objectInsert({
    workspaceId: "b1-workspace-b",
    objectId: "b1-shared-object",
    kind: "skill_package",
    contentHash: OBJECT_HASH,
    storageKey: "b1/b/shared",
  }));

  const shared = await pool.query(`
    SELECT workspace_id, object_id, content_hash
    FROM public.product_objects
    WHERE object_id = 'b1-shared-object'
    ORDER BY workspace_id
  `);
  assert.equal(shared.rowCount, 2);
  assert.deepEqual(shared.rows.map((row) => row.workspace_id), ["b1-workspace-a", "b1-workspace-b"]);
}

async function seedMaterialAuthority(pool) {
  for (const object of [
    ["b1-attachment-object", "attachment_source", ATTACHMENT_HASH, "b1/a/attachment"],
    ["b1-representation-object", "attachment_representation", REPRESENTATION_HASH, "b1/a/representation"],
    ["b1-resource-object", "resource_content", RESOURCE_HASH, "b1/a/resource"],
  ]) {
    await pool.query(objectInsert({
      workspaceId: "b1-workspace-a",
      objectId: object[0],
      kind: object[1],
      contentHash: object[2],
      storageKey: object[3],
    }));
  }

  await pool.query(`
    INSERT INTO public.input_attachments (
      workspace_id, attachment_id, attachment_version, owner_user_id,
      schema_version, scope_kind, file_name, media_type, size_bytes,
      content_hash, object_id, processing_status, processing_message,
      processing_retryable, expires_at, created_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-attachment-a', 1, 'b1-user-a',
      'workbench-v1', 'personal', 'brief.md', 'text/markdown', 10,
      $1, 'b1-attachment-object', 'ready', 'Attachment is ready.',
      false, $2, $3, $3
    )
  `, [ATTACHMENT_HASH, EXPIRY, NOW]);
  await pool.query(`
    INSERT INTO public.attachment_derived_representations (
      workspace_id, representation_id, attachment_id, attachment_version,
      attachment_content_hash, schema_version, representation_kind, content_hash,
      character_count, representation_object_id, representation_object_kind,
      evidence, created_at
    ) VALUES (
      'b1-workspace-a', 'b1-representation-a', 'b1-attachment-a', 1,
      $1, 'workbench-v1', 'utf8_text', $2, 9,
      'b1-representation-object', 'attachment_representation', '[]'::jsonb, $3
    )
  `, [ATTACHMENT_HASH, REPRESENTATION_HASH, NOW]);
  await pool.query(`
    INSERT INTO public.attachment_derived_representations (
      workspace_id, representation_id, attachment_id, attachment_version,
      attachment_content_hash, schema_version, representation_kind, content_hash,
      character_count, evidence, created_at
    ) VALUES (
      'b1-workspace-a', 'b1-representation-binary', 'b1-attachment-a', 1,
      $1, 'workbench-v1', 'binary_reference', $1, 0, '[]'::jsonb, $2
    )
  `, [ATTACHMENT_HASH, NOW]);
  const representations = await pool.query(`
    SELECT representation_kind
    FROM public.attachment_derived_representations
    WHERE workspace_id = 'b1-workspace-a' AND attachment_id = 'b1-attachment-a'
    ORDER BY representation_kind
  `);
  assert.deepEqual(
    representations.rows.map((row) => row.representation_kind),
    ["binary_reference", "utf8_text"],
  );

  await pool.query(`
    INSERT INTO public.workspace_resources (
      workspace_id, resource_id, resource_version, created_by, schema_version,
      label, media_type, size_bytes, content_hash, object_id, source_kind,
      source_attachment_id, source_attachment_version, source_attachment_content_hash,
      readiness_status, created_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-resource-a', 'revision:alpha', 'b1-user-a', 'workbench-v1',
      'Brief', 'text/plain', 10, $1, 'b1-resource-object', 'attachment',
      'b1-attachment-a', 1, $2, 'ready', $3, $3
    )
  `, [RESOURCE_HASH, ATTACHMENT_HASH, NOW]);
}

async function assertMaterialLifecycle(pool) {
  await pool.query(`
    UPDATE public.input_attachments
    SET processing_status = 'deleted', processing_code = 'attachment_deleted',
        processing_message = 'Attachment was deleted.', processing_retryable = false,
        deleted_at = $1, row_revision = row_revision + 1, updated_at = $1
    WHERE workspace_id = 'b1-workspace-a'
      AND attachment_id = 'b1-attachment-a'
      AND attachment_version = 1
      AND row_revision = 1
  `, [LATER]);
  const resource = await pool.query(`
    SELECT readiness_status
    FROM public.workspace_resources
    WHERE workspace_id = 'b1-workspace-a' AND resource_id = 'b1-resource-a'
  `);
  assert.equal(resource.rows[0].readiness_status, "ready");

  // Derived text is disposable processing output. Removing it must not affect the
  // independently promoted Workspace Resource or loosen source provenance.
  await pool.query(`
    DELETE FROM public.attachment_derived_representations
    WHERE workspace_id = 'b1-workspace-a'
      AND attachment_id = 'b1-attachment-a'
  `);
  await expectConstraint(pool, `
    DELETE FROM public.input_attachments
    WHERE workspace_id = 'b1-workspace-a'
      AND attachment_id = 'b1-attachment-a'
      AND attachment_version = 1
  `, [], "23503", "workspace_resources_source_attachment_fk");
}

async function assertLifecycleVocabularyAndTransitions(pool) {
  const lifecycles = ["draft", "validating", "tested", "published", "deprecated", "archived"];
  for (const lifecycle of lifecycles) {
    await pool.query(`
      INSERT INTO public.skill_assets (
        workspace_id, skill_id, scope_id, owner_user_id, schema_version,
        name_normalized, visibility, lifecycle, created_at, updated_at
      ) VALUES (
        'b1-workspace-a', $1, 'b1-workspace-a-personal', 'b1-user-a', 'workbench-v1',
        $2, 'private', $3, $4, $4
      )
    `, [`b1-lifecycle-${lifecycle}`, `b1 lifecycle ${lifecycle}`, lifecycle, NOW]);
  }

  const allowedTransitions = [
    ["draft", "validating"],
    ["validating", "draft"],
    ["validating", "tested"],
    ["tested", "draft"],
    ["tested", "published"],
    ["published", "deprecated"],
    ["deprecated", "archived"],
  ];
  for (const [from, to] of allowedTransitions) {
    const skillId = `b1-lifecycle-allowed-${from}-${to}`;
    await pool.query(`
      INSERT INTO public.skill_assets (
        workspace_id, skill_id, scope_id, owner_user_id, schema_version,
        name_normalized, visibility, lifecycle, created_at, updated_at
      ) VALUES (
        'b1-workspace-a', $1, 'b1-workspace-a-personal', 'b1-user-a', 'workbench-v1',
        $2, 'private', $3, $4, $4
      )
    `, [skillId, `b1 allowed ${from} ${to}`, from, NOW]);
    const transition = await pool.query(`
      UPDATE public.skill_assets
      SET lifecycle = $1, updated_at = $2
      WHERE workspace_id = 'b1-workspace-a' AND skill_id = $3
      RETURNING lifecycle
    `, [to, LATER, skillId]);
    assert.equal(transition.rows[0].lifecycle, to);
  }

  const allowed = new Set([
    ...lifecycles.map((lifecycle) => `${lifecycle}:${lifecycle}`),
    ...allowedTransitions.map(([from, to]) => `${from}:${to}`),
  ]);
  for (const from of lifecycles) {
    for (const to of lifecycles) {
      if (allowed.has(`${from}:${to}`)) continue;
      await expectConstraint(pool, `
        UPDATE public.skill_assets
        SET lifecycle = $1, updated_at = $2
        WHERE workspace_id = 'b1-workspace-a' AND skill_id = $3
      `, [to, LATER, `b1-lifecycle-${from}`], "23514", "skill_assets_lifecycle_transition");
    }
  }

  for (const lifecycle of ["ready", "shared", "blocked"]) {
    await expectConstraint(pool, `
      INSERT INTO public.skill_assets (
        workspace_id, skill_id, scope_id, owner_user_id, schema_version,
        name_normalized, visibility, lifecycle, created_at, updated_at
      ) VALUES (
        'b1-workspace-a', $1, 'b1-workspace-a-personal', 'b1-user-a', 'workbench-v1',
        $2, 'private', $3, $4, $4
      )
    `, [
      `b1-lifecycle-legacy-${lifecycle}`,
      `b1 legacy ${lifecycle}`,
      lifecycle,
      NOW,
    ], "23514", "skill_assets_lifecycle");
  }
}

async function seedSkillDraftAndTest(pool) {
  await pool.query(`
    INSERT INTO public.upload_sessions (
      workspace_id, upload_id, requested_by, schema_version, asset_kind, state,
      file_name, size_bytes, media_type, ingest_method, received_bytes,
      total_chunks, received_chunks, object_id, object_kind, object_content_hash,
      package_hash, inspection_status, created_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-upload-a', 'b1-user-a', 'workbench-v1', 'skill', 'promoted',
      'skill.zip', 10, 'application/zip', 'files', 10,
      0, 0, 'b1-shared-object', 'skill_package', $1,
      $2, 'passed', $3, $3
    )
  `, [OBJECT_HASH, PACKAGE_HASH, NOW]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const createdAsset = await client.query(`
      INSERT INTO public.skill_assets (
        workspace_id, skill_id, scope_id, owner_user_id, schema_version, name_normalized,
        visibility, lifecycle, current_draft_id, created_at, updated_at
      ) VALUES (
        'b1-workspace-a', 'b1-skill-a', 'b1-workspace-a-personal',
        'b1-user-a', 'workbench-v1', 'b1 skill',
        'private', 'draft', 'b1-draft-a', $1, $1
      )
      RETURNING lifecycle
    `, [NOW]);
    assert.equal(createdAsset.rows[0].lifecycle, "draft");
    await client.query(`
      INSERT INTO public.skill_drafts (
        workspace_id, skill_draft_id, skill_id, schema_version, draft_revision,
        package_object_id, package_object_kind, package_object_hash, package_hash,
        content_hash, updated_by, created_at, updated_at, definition
      ) VALUES (
        'b1-workspace-a', 'b1-draft-a', 'b1-skill-a', 'workbench-v1', 1,
        'b1-shared-object', 'skill_package', $1, $2,
        $3, 'b1-user-a', $4, $4, '{"name":"B1 Skill"}'::jsonb
      )
    `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW]);
    await client.query(`
      INSERT INTO public.skill_draft_revision_snapshots (
        workspace_id, skill_id, skill_draft_id, draft_revision, schema_version,
        package_object_id, package_object_kind, package_object_hash, package_hash,
        content_hash, created_by, created_at, definition
      ) VALUES (
        'b1-workspace-a', 'b1-skill-a', 'b1-draft-a', 1, 'workbench-internal-v1',
        'b1-shared-object', 'skill_package', $1, $2,
        $3, 'b1-user-a', $4, '{"name":"B1 Skill"}'::jsonb
      )
    `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await insertAuthorizedProductCommand(pool, {
    commandId: "b1-test-run-a", workspaceId: "b1-workspace-a", userId: "b1-user-a",
    kind: "skill_test", sessionId: "b1-draft-a", turnId: "b1-test-run-a",
  });
  await pool.query(`
    INSERT INTO public.skill_test_runs (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision, requested_by,
      product_command_id, schema_version, package_hash, content_hash, status,
      upload_id, object_id, object_hash, test_case, accepted_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-test-run-a', 'b1-skill-a', 'b1-draft-a', 1, 'b1-user-a',
      'b1-test-run-a', 'workbench-v1', $1, $2, 'queued',
      'b1-upload-a', 'b1-shared-object', $3,
      '{"name":"B1 case"}'::jsonb, $4, $4
    )
  `, [PACKAGE_HASH, DRAFT_HASH, OBJECT_HASH, NOW]);
  await pool.query(`
    UPDATE public.skill_assets
    SET lifecycle = 'validating', updated_at = $1
    WHERE workspace_id = 'b1-workspace-a' AND skill_id = 'b1-skill-a'
  `, [LATER]);
  await pool.query(`
    INSERT INTO public.skill_test_evidence (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      schema_version, upload_id, object_id, object_hash, package_hash,
      content_hash, isolated, network_denied, runtime_summary, created_at
    ) VALUES (
      'b1-workspace-a', 'b1-test-run-a', 'b1-skill-a', 'b1-draft-a', 1,
      'workbench-internal-v1', 'b1-upload-a', 'b1-shared-object', $1, $2,
      $3, true, true, '{"runtimeLabel":"B1"}'::jsonb, $4
    )
  `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW]);
}

async function assertDraftCasAndHistoricalEvidence(pool) {
  await pool.query(`
    INSERT INTO public.skill_draft_revision_snapshots (
      workspace_id, skill_id, skill_draft_id, draft_revision, schema_version,
      package_object_id, package_object_kind, package_object_hash, package_hash,
      content_hash, created_by, created_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-skill-a', 'b1-draft-a', 2, 'workbench-internal-v1',
      'b1-shared-object', 'skill_package', $1, $2,
      $3, 'b1-user-a', $4, '{"name":"B1 Skill v2"}'::jsonb
    )
  `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_V2_HASH, LATER]);
  const update = () => pool.query(`
    UPDATE public.skill_drafts
    SET draft_revision = 2, content_hash = $1,
        definition = '{"name":"B1 Skill v2"}'::jsonb, updated_at = $2
    WHERE workspace_id = 'b1-workspace-a'
      AND skill_draft_id = 'b1-draft-a'
      AND draft_revision = 1
    RETURNING draft_revision
  `, [DRAFT_V2_HASH, LATER]);
  const results = await Promise.all([update(), update()]);
  assert.deepEqual(results.map((result) => result.rowCount).sort(), [0, 1]);

  const history = await pool.query(`
    SELECT e.draft_revision AS evidence_revision, d.draft_revision AS current_revision
    FROM public.skill_test_evidence e
    JOIN public.skill_drafts d
      ON d.workspace_id = e.workspace_id AND d.skill_draft_id = e.skill_draft_id
    WHERE e.workspace_id = 'b1-workspace-a' AND e.test_run_id = 'b1-test-run-a'
  `);
  assert.deepEqual(history.rows[0], { evidence_revision: 1, current_revision: 2 });
}

async function assertTestClaimFence(pool) {
  const claim = (owner) => pool.query(`
    UPDATE public.skill_test_runs
    SET runner_claim_owner = $1,
        runner_claim_fence = runner_claim_fence + 1,
        runner_claim_expires_at = $2,
        row_revision = row_revision + 1,
        updated_at = $3
    WHERE workspace_id = 'b1-workspace-a'
      AND test_run_id = 'b1-test-run-a'
      AND status IN ('queued', 'running')
      AND (runner_claim_owner IS NULL OR runner_claim_expires_at <= $3)
    RETURNING runner_claim_owner, runner_claim_fence
  `, [owner, EXPIRY, LATER]);
  const claims = await Promise.all([claim("b1-runner-a"), claim("b1-runner-b")]);
  assert.deepEqual(claims.map((result) => result.rowCount).sort(), [0, 1]);
  const winner = claims.find((result) => result.rowCount === 1).rows[0];
  const heartbeat = await pool.query(`
    UPDATE public.skill_test_runs
    SET runner_claim_expires_at = $1, row_revision = row_revision + 1, updated_at = $2
    WHERE workspace_id = 'b1-workspace-a'
      AND test_run_id = 'b1-test-run-a'
      AND runner_claim_owner = $3
      AND runner_claim_fence = $4
    RETURNING row_revision
  `, [EXPIRY, LATER, winner.runner_claim_owner, winner.runner_claim_fence]);
  assert.equal(heartbeat.rowCount, 1);

  const late = await pool.query(`
    UPDATE public.skill_test_runs
    SET status = 'passed', completed_at = $1, updated_at = $1
    WHERE workspace_id = 'b1-workspace-a'
      AND test_run_id = 'b1-test-run-a'
      AND runner_claim_owner = 'b1-stale-runner'
      AND runner_claim_fence = $2
  `, [LATER, winner.runner_claim_fence]);
  assert.equal(late.rowCount, 0);

  const settled = await pool.query(`
    UPDATE public.skill_test_runs
    SET status = 'passed', started_at = $1, completed_at = $1,
        runner_claim_owner = NULL, runner_claim_expires_at = NULL,
        row_revision = row_revision + 1, updated_at = $1
    WHERE workspace_id = 'b1-workspace-a'
      AND test_run_id = 'b1-test-run-a'
      AND runner_claim_owner = $2
      AND runner_claim_fence = $3
      AND runner_claim_expires_at > $4
    RETURNING status
  `, [LATER, winner.runner_claim_owner, winner.runner_claim_fence, NOW]);
  assert.equal(settled.rowCount, 1);
  assert.equal(settled.rows[0].status, "passed");
  await expectDatabaseError(pool, `
    UPDATE public.skill_test_runs
    SET diagnostics = diagnostics
    WHERE workspace_id = 'b1-workspace-a' AND test_run_id = 'b1-test-run-a'
  `, [], "55000", "terminal_skill_test_run_mutation_forbidden: b1-test-run-a");
  await expectDatabaseError(pool, `
    DELETE FROM public.skill_test_runs
    WHERE workspace_id = 'b1-workspace-a' AND test_run_id = 'b1-test-run-a'
  `, [], "55000", "terminal_skill_test_run_mutation_forbidden: b1-test-run-a");
  const tested = await pool.query(`
    UPDATE public.skill_assets
    SET lifecycle = 'tested', updated_at = $1
    WHERE workspace_id = 'b1-workspace-a' AND skill_id = 'b1-skill-a'
    RETURNING lifecycle
  `, [LATER]);
  assert.equal(tested.rows[0].lifecycle, "tested");
}

async function assertValidationRejectsForgedEvidence(pool) {
  await insertAuthorizedProductCommand(pool, {
    commandId: "b1-test-run-forged-snapshot", workspaceId: "b1-workspace-a",
    userId: "b1-user-a", kind: "skill_test", sessionId: "b1-draft-a",
    turnId: "b1-test-run-forged-snapshot",
  });
  await expectConstraint(pool, `
    INSERT INTO public.skill_test_runs (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      requested_by, product_command_id, schema_version, package_hash, content_hash,
      status, upload_id, object_id, object_hash, test_case, accepted_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-test-run-forged-snapshot', 'b1-skill-a',
      'b1-draft-a', 999, 'b1-user-a', 'b1-test-run-forged-snapshot',
      'workbench-v1', $1, $2, 'queued', 'b1-upload-a',
      'b1-shared-object', $3, '{}'::jsonb, $4, $4
    )
  `, [PACKAGE_HASH, DRAFT_HASH, OBJECT_HASH, NOW], "23503",
  "skill_test_runs_snapshot_fk");

  await seedCompletedTestRun(pool, "b1-test-run-no-evidence");
  await seedCompletedTestRun(pool, "b1-test-run-unsafe", {
    evidence: true,
    isolated: false,
    networkDenied: true,
  });

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-missing-test",
    status: "passed",
    testRunId: "b1-test-run-missing",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_primary_test_run_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-missing-evidence",
    status: "passed",
    testRunId: "b1-test-run-no-evidence",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_primary_evidence_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-forged-revision",
    status: "passed",
    draftRevision: 999,
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_primary_test_run_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-forged-hash",
    status: "passed",
  }), [OBJECT_HASH, PACKAGE_HASH, hash("2"), NOW], "23503",
  "skill_validations_primary_test_run_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-permission-false",
    status: "passed",
    permissionAcknowledged: false,
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23514",
  "skill_validations_passed_requirements");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-unsafe-evidence",
    status: "passed",
    testRunId: "b1-test-run-unsafe",
    isolated: false,
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23514",
  "skill_validations_passed_requirements");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-cross-skill",
    status: "passed",
    skillId: "b1-other-skill",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_draft_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-cross-workspace",
    status: "passed",
    workspaceId: "b1-workspace-b",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_draft_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-forged-object",
    status: "passed",
  }), [hash("3"), PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_upload_fk");

  await expectConstraint(pool, validationInsert({
    validationId: "b1-validation-without-membership",
    status: "passed",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validations_primary_membership_fk");

  const rejected = await pool.query(`
    SELECT validation_id
    FROM public.skill_validations
    WHERE workspace_id = 'b1-workspace-a' AND validation_id LIKE 'b1-validation-%'
  `);
  assert.deepEqual(rejected.rows, []);

  await expectConstraint(pool, bindingInsert({
    bindingId: "b1-binding-forged-validation",
    validationId: "b1-validation-without-membership",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, IMAGE_DIGEST, NOW], "23503",
  "skill_execution_bindings_validation_fk");

  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      source_skill_draft_id, source_draft_revision, validation_id,
      execution_binding_id, package_object_id, package_object_hash, package_hash,
      validated_draft_content_hash, content_hash, published_by_user_id,
      published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-skill-version-forged', 'b1-skill-a', '0.0.0-forged',
      'workbench-v1', 'validated_draft', 'b1-draft-a', 1,
      'b1-validation-without-membership', 'b1-binding-forged-validation',
      'b1-shared-object', $1, $2, $3, $4, 'b1-user-a', $5,
      '{"name":"B1 Skill"}'::jsonb
    )
  `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, NOW], "23503",
  "skill_versions_binding_fk");
}

async function assertValidationAndPublicationAuthority(pool) {
  await insertValidationWithMembership(pool, {
    validationId: "b1-validation-failed",
    status: "failed",
    validationStatus: "failed",
  });
  await expectConstraint(pool, bindingInsert({
    bindingId: "b1-binding-invalid-validation",
    validationId: "b1-validation-failed",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, IMAGE_DIGEST, NOW], "23503",
  "skill_execution_bindings_validation_fk");

  await insertValidationWithMembership(pool, {
    validationId: "b1-validation-a",
    status: "passed",
    validationStatus: "passed",
  });
  await expectConstraint(pool, validationMembershipInsert({
    validationId: "b1-validation-a",
    validationStatus: "passed",
    testRunId: "b1-test-run-missing-member",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW], "23503",
  "skill_validation_test_runs_test_run_fk");
  await pool.query(bindingInsert({
    bindingId: "b1-binding-a",
    validationId: "b1-validation-a",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, IMAGE_DIGEST, NOW]);
  await insertValidationWithMembership(pool, {
    validationId: "b1-validation-b",
    status: "passed",
    validationStatus: "passed",
  });
  await pool.query(bindingInsert({
    bindingId: "b1-binding-b",
    validationId: "b1-validation-b",
  }), [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, IMAGE_DIGEST, NOW]);
  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      source_skill_draft_id, source_draft_revision, validation_id,
      execution_binding_id, package_object_id, package_object_hash, package_hash,
      validated_draft_content_hash, content_hash, published_by_user_id,
      published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-skill-version-forged-definition', 'b1-skill-a',
      '1.0.0-forged-definition', 'workbench-v1', 'validated_draft',
      'b1-draft-a', 1, 'b1-validation-a', 'b1-binding-a',
      'b1-shared-object', $1, $2, $3, $4, 'b1-user-a', $5,
      '{"name":"Attacker replacement"}'::jsonb
    )
  `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, NOW], "23514",
  "skill_versions_definition_authority");
  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      source_skill_draft_id, source_draft_revision, validation_id,
      execution_binding_id, package_object_id, package_object_hash, package_hash,
      validated_draft_content_hash, content_hash, published_by_user_id,
      published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-skill-version-forged-content', 'b1-skill-a',
      '1.0.0-forged-content', 'workbench-v1', 'validated_draft',
      'b1-draft-a', 1, 'b1-validation-a', 'b1-binding-a',
      'b1-shared-object', $1, $2, $3, $4, 'b1-user-a', $5,
      '{"name":"B1 Skill"}'::jsonb
    )
  `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, hash("2"), NOW], "23503",
  "skill_versions_binding_fk");
  await pool.query(`
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      source_skill_draft_id, source_draft_revision, validation_id,
      execution_binding_id, package_object_id, package_object_hash, package_hash,
      validated_draft_content_hash, content_hash, published_by_user_id,
      published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-skill-version-a', 'b1-skill-a', '1.0.0', 'workbench-v1',
      'validated_draft',
      'b1-draft-a', 1, 'b1-validation-a',
      'b1-binding-a', 'b1-shared-object', $1, $2,
      $3, $4, 'b1-user-a', $5, '{"name":"B1 Skill"}'::jsonb
    )
  `, [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, VERSION_HASH, NOW]);
  const portableVersionPin = await pool.query(`
    SELECT content_hash, validated_draft_content_hash
    FROM public.skill_versions
    WHERE workspace_id = 'b1-workspace-a' AND skill_version_id = 'b1-skill-version-a'
  `);
  assert.deepEqual(portableVersionPin.rows[0], {
    content_hash: VERSION_HASH,
    validated_draft_content_hash: DRAFT_HASH,
  });
  assert.notEqual(VERSION_HASH, DRAFT_HASH);
  const published = await pool.query(`
    UPDATE public.skill_assets
    SET latest_published_version_id = 'b1-skill-version-a', lifecycle = 'published', updated_at = $1
    WHERE workspace_id = 'b1-workspace-a' AND skill_id = 'b1-skill-a'
    RETURNING lifecycle
  `, [LATER]);
  assert.equal(published.rows[0].lifecycle, "published");

  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      source_skill_draft_id, source_draft_revision, validation_id,
      execution_binding_id, package_object_id, package_object_hash, package_hash,
      validated_draft_content_hash, content_hash, published_by_user_id,
      published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-skill-version-bad', 'b1-skill-a', '1.0.1', 'workbench-v1',
      'validated_draft',
      'b1-draft-a', 1, 'b1-validation-a',
      'b1-binding-a', 'b1-shared-object', $1, $2,
      $3, $4, 'b1-user-a', $5, '{"name":"B1 Skill"}'::jsonb
    )
  `, [OBJECT_HASH, hash("2"), DRAFT_HASH, VERSION_HASH, NOW], "23503", "skill_versions_binding_fk");

  await expectConstraint(pool, `
    INSERT INTO public.upload_sessions (
      workspace_id, upload_id, requested_by, schema_version, asset_kind, state,
      file_name, size_bytes, media_type, ingest_method, received_bytes,
      total_chunks, received_chunks, object_id, object_kind, object_content_hash,
      package_hash, inspection_status, created_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-upload-bad-object', 'b1-user-a', 'workbench-v1',
      'skill', 'promoted', 'bad.zip', 10, 'application/zip', 'files', 10,
      0, 0, 'b1-shared-object', 'skill_package', $1,
      $2, 'passed', $3, $3
    )
  `, [hash("4"), PACKAGE_HASH, NOW], "23503", "upload_sessions_object_fk");
}

async function assertLegacyDefinitionIsolation(pool) {
  await pool.query(`
    INSERT INTO public.legacy_skill_definitions (
      legacy_definition_id, schema_version, scope_kind, workspace_id,
      owner_user_id, skill_id, version, name, description, category,
      status, created_at, updated_at
    ) VALUES
      ('b1-legacy-global', 'workbench-v1', 'global', NULL, NULL,
        'b1-legacy-skill', '1', 'Global', 'Global', 'test', 'ready', $1, $1),
      ('b1-legacy-workspace-a', 'workbench-v1', 'workspace', 'b1-workspace-a', 'b1-user-a',
        'b1-legacy-skill', '1', 'Tenant A', 'Tenant A', 'test', 'ready', $1, $1),
      ('b1-legacy-workspace-b', 'workbench-v1', 'workspace', 'b1-workspace-b', 'b1-user-b',
        'b1-legacy-skill', '1', 'Tenant B', 'Tenant B', 'test', 'ready', $1, $1)
  `, [NOW]);
  await expectConstraint(pool, `
    INSERT INTO public.legacy_skill_definitions (
      legacy_definition_id, schema_version, scope_kind, skill_id, version,
      name, description, category, status, created_at, updated_at
    ) VALUES (
      'b1-legacy-global-duplicate', 'workbench-v1', 'global', 'b1-legacy-skill', '1',
      'Duplicate', 'Duplicate', 'test', 'ready', $1, $1
    )
  `, [NOW], "23505", "legacy_skill_definitions_global_identity_uq");
}

async function assertSystemCatalogPublicationAuthority(pool) {
  await pool.query(objectInsert({
    workspaceId: "b1-workspace-a",
    objectId: "b1-system-package-object",
    kind: "skill_package",
    contentHash: SYSTEM_PACKAGE_HASH,
    storageKey: "b1/a/system-package",
  }));
  await pool.query(`
    INSERT INTO public.skill_system_catalog_principals (
      principal_id, product_user_id, schema_version, status, created_at, updated_at
    ) VALUES (
      'system-catalog', 'system-catalog', 'workbench-v1', 'enabled', $1, $1
    )
  `, [NOW]);
  const systemAsset = await pool.query(`
    INSERT INTO public.skill_assets (
      workspace_id, skill_id, scope_id, owner_system_principal_id, schema_version,
      name_normalized, visibility, lifecycle, created_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-system-skill', 'b1-workspace-a-personal',
      'system-catalog', 'workbench-v1',
      'b1 system skill', 'private', 'published', $1, $1
    )
    RETURNING lifecycle
  `, [NOW]);
  assert.equal(systemAsset.rows[0].lifecycle, "published");
  await pool.query(systemCatalogSourceInsert(), [
    SYSTEM_MANIFEST_HASH,
    SYSTEM_PACKAGE_HASH,
    SYSTEM_PROBE_HASH,
    SYSTEM_EXECUTION_REF_HASH,
    NOW,
  ]);
  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version-forged-definition', 'b1-system-skill',
      'forged-definition', 'workbench-v1', 'system_catalog',
      'b1-system-source', 'b1-system-package-object', $1, $1,
      $2, 'system-catalog', $3, '{"name":"Attacker replacement"}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, SYSTEM_VERSION_HASH, NOW], "23514",
  "skill_versions_definition_authority");
  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version-forged-content', 'b1-system-skill',
      'forged-content', 'workbench-v1', 'system_catalog',
      'b1-system-source', 'b1-system-package-object', $1, $1,
      $2, 'system-catalog', $3, '{"name":"B1 system skill"}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, hash("1"), NOW], "23503",
  "skill_versions_system_catalog_source_fk");
  await pool.query(`
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version', 'b1-system-skill',
      'catalog-build-2026.08.05', 'workbench-v1', 'system_catalog',
      'b1-system-source', 'b1-system-package-object', $1, $1,
      $2, 'system-catalog', $3, '{"name":"B1 system skill"}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, SYSTEM_VERSION_HASH, NOW]);
  const systemPortablePin = await pool.query(`
    SELECT v.content_hash, s.published_version_content_hash
    FROM public.skill_versions v
    JOIN public.skill_system_catalog_sources s
      ON s.workspace_id = v.workspace_id
      AND s.catalog_source_id = v.system_catalog_source_id
    WHERE v.workspace_id = 'b1-workspace-a'
      AND v.skill_version_id = 'b1-system-version'
  `);
  assert.deepEqual(systemPortablePin.rows[0], {
    content_hash: SYSTEM_VERSION_HASH,
    published_version_content_hash: SYSTEM_VERSION_HASH,
  });
  const linkedSystemVersion = await pool.query(`
    UPDATE public.skill_assets
    SET latest_published_version_id = 'b1-system-version', updated_at = $1
    WHERE workspace_id = 'b1-workspace-a' AND skill_id = 'b1-system-skill'
    RETURNING lifecycle, latest_published_version_id
  `, [LATER]);
  assert.deepEqual(linkedSystemVersion.rows[0], {
    lifecycle: "published",
    latest_published_version_id: "b1-system-version",
  });

  await expectConstraint(pool, systemCatalogSourceInsert({
    sourceId: "b1-system-source-bad-probe",
    probeStatus: "blocked",
  }), [
    SYSTEM_MANIFEST_HASH,
    SYSTEM_PACKAGE_HASH,
    SYSTEM_PROBE_HASH,
    SYSTEM_EXECUTION_REF_HASH,
    NOW,
  ], "23514", "skill_system_catalog_sources_runtime_probe");

  await expectConstraint(pool, systemCatalogSourceInsert({
    sourceId: "b1-system-source-user-owned",
    skillId: "b1-skill-a",
  }), [
    SYSTEM_MANIFEST_HASH,
    OBJECT_HASH,
    SYSTEM_PROBE_HASH,
    SYSTEM_EXECUTION_REF_HASH,
    NOW,
  ], "23503", "skill_system_catalog_sources_asset_fk");

  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version-fake-source', 'b1-system-skill',
      'fake-source', 'workbench-v1', 'system_catalog',
      'b1-system-source-missing', 'b1-system-package-object', $1, $1,
      $2, 'system-catalog', $3, '{}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, hash("a"), NOW], "23503",
  "skill_versions_system_catalog_source_fk");

  await expectDatabaseError(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version-impersonated', 'b1-system-skill',
      'impersonated', 'workbench-v1', 'system_catalog',
      'b1-system-source', 'b1-system-package-object', $1, $1,
      $2, 'b1-user-a', $3, '{}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, hash("b"), NOW], "55000",
  "system_catalog_principal_not_enabled: b1-user-a");

  await expectConstraint(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      source_skill_draft_id, source_draft_revision, validation_id,
      execution_binding_id, system_catalog_source_id, package_object_id,
      package_object_hash, package_hash, validated_draft_content_hash, content_hash,
      published_by_user_id, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version-mixed', 'b1-system-skill',
      'mixed', 'workbench-v1', 'system_catalog',
      'b1-draft-a', 1, 'b1-validation-a', 'b1-binding-a',
      'b1-system-source', 'b1-system-package-object', $1, $1,
      $2, $3, 'b1-user-a', 'system-catalog', $4,
      '{"name":"B1 system skill"}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, DRAFT_HASH, hash("c"), NOW], "23514",
  "skill_versions_source_shape");

  await pool.query(`
    UPDATE public.skill_system_catalog_principals
    SET status = 'disabled', updated_at = $1
    WHERE principal_id = 'system-catalog'
  `, [LATER]);
  await expectDatabaseError(pool, systemCatalogSourceInsert({
    sourceId: "b1-system-source-after-disable",
  }), [
    SYSTEM_MANIFEST_HASH,
    SYSTEM_PACKAGE_HASH,
    SYSTEM_PROBE_HASH,
    SYSTEM_EXECUTION_REF_HASH,
    LATER,
  ], "55000", "system_catalog_principal_not_enabled: system-catalog");
  await expectDatabaseError(pool, `
    INSERT INTO public.skill_versions (
      workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
      system_catalog_source_id, package_object_id, package_object_hash, package_hash,
      content_hash, published_by_system_principal_id, published_at, definition
    ) VALUES (
      'b1-workspace-a', 'b1-system-version-after-disable', 'b1-system-skill',
      'after-disable', 'workbench-v1', 'system_catalog',
      'b1-system-source', 'b1-system-package-object', $1, $1,
      $2, 'system-catalog', $3, '{"name":"B1 system skill"}'::jsonb
    )
  `, [SYSTEM_PACKAGE_HASH, SYSTEM_VERSION_HASH, LATER], "55000",
  "system_catalog_principal_not_enabled: system-catalog");
}

async function assertImmutableHistoryGuards(pool) {
  const targets = [
    {
      table: "skill_draft_revision_snapshots",
      predicate: "workspace_id = 'b1-workspace-a' AND skill_draft_id = 'b1-draft-a' AND draft_revision = 1",
      assignment: "definition = definition",
    },
    {
      table: "skill_validation_test_runs",
      predicate: "workspace_id = 'b1-workspace-a' AND validation_id = 'b1-validation-a' AND test_run_id = 'b1-test-run-a'",
      assignment: "created_at = created_at",
    },
    {
      table: "skill_test_evidence",
      predicate: "workspace_id = 'b1-workspace-a' AND test_run_id = 'b1-test-run-a'",
      assignment: "runtime_summary = runtime_summary",
    },
    {
      table: "skill_validations",
      predicate: "workspace_id = 'b1-workspace-a' AND validation_id = 'b1-validation-a'",
      assignment: "diagnostics = diagnostics",
    },
    {
      table: "skill_execution_bindings",
      predicate: "workspace_id = 'b1-workspace-a' AND execution_binding_id = 'b1-binding-a'",
      assignment: "payload = payload",
    },
    {
      table: "skill_system_catalog_sources",
      predicate: "workspace_id = 'b1-workspace-a' AND catalog_source_id = 'b1-system-source'",
      assignment: "payload = payload",
    },
    {
      table: "skill_versions",
      predicate: "workspace_id = 'b1-workspace-a' AND skill_version_id = 'b1-skill-version-a'",
      assignment: "payload = payload",
    },
  ];
  for (const target of targets) {
    await expectDatabaseError(
      pool,
      `UPDATE public.${target.table} SET ${target.assignment} WHERE ${target.predicate}`,
      [],
      "55000",
      `immutable_skill_history_mutation_forbidden: ${target.table}`,
    );
    await expectDatabaseError(
      pool,
      `DELETE FROM public.${target.table} WHERE ${target.predicate}`,
      [],
      "55000",
      `immutable_skill_history_mutation_forbidden: ${target.table}`,
    );
  }
}

async function assertCrossTenantDenials(pool) {
  await expectConstraint(pool, `
    INSERT INTO public.input_attachments (
      workspace_id, attachment_id, attachment_version, owner_user_id,
      schema_version, scope_kind, file_name, media_type, size_bytes,
      content_hash, object_id, processing_status, processing_message,
      processing_retryable, expires_at, created_at, updated_at
    ) VALUES (
      'b1-workspace-a', 'b1-attachment-cross', 1, 'b1-user-b',
      'workbench-v1', 'personal', 'cross.md', 'text/markdown', 10,
      $1, 'b1-attachment-object', 'ready', 'Attachment is ready.',
      false, $2, $3, $3
    )
  `, [ATTACHMENT_HASH, EXPIRY, NOW], "23503", "input_attachments_owner_fk");

  await expectConstraint(pool, `
    INSERT INTO public.skill_drafts (
      workspace_id, skill_draft_id, skill_id, schema_version, draft_revision,
      content_hash, updated_by, created_at, updated_at, definition
    ) VALUES (
      'b1-workspace-b', 'b1-draft-cross', 'b1-skill-a', 'workbench-v1', 1,
      $1, 'b1-user-b', $2, $2, '{}'::jsonb
    )
  `, [DRAFT_HASH, NOW], "23503", "skill_drafts_skill_fk");
}

async function seedCompletedTestRun(pool, testRunId, {
  evidence = false,
  isolated = true,
  networkDenied = true,
} = {}) {
  await insertAuthorizedProductCommand(pool, {
    commandId: testRunId, workspaceId: "b1-workspace-a", userId: "b1-user-a",
    kind: "skill_test", sessionId: "b1-draft-a", turnId: testRunId,
  });
  await pool.query(`
    INSERT INTO public.skill_test_runs (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      requested_by, product_command_id, schema_version, package_hash, content_hash,
      status, upload_id, object_id, object_hash, test_case,
      accepted_at, started_at, completed_at, updated_at
    ) VALUES (
      'b1-workspace-a', $1, 'b1-skill-a', 'b1-draft-a', 1,
      'b1-user-a', $1, 'workbench-v1', $2, $3,
      'passed', 'b1-upload-a', 'b1-shared-object', $4, '{"name":"B1 case"}'::jsonb,
      $5, $5, $5, $5
    )
  `, [testRunId, PACKAGE_HASH, DRAFT_HASH, OBJECT_HASH, LATER]);
  if (!evidence) return;
  await pool.query(`
    INSERT INTO public.skill_test_evidence (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      schema_version, upload_id, object_id, object_hash, package_hash,
      content_hash, isolated, network_denied, runtime_summary, created_at
    ) VALUES (
      'b1-workspace-a', $1, 'b1-skill-a', 'b1-draft-a', 1,
      'workbench-internal-v1', 'b1-upload-a', 'b1-shared-object', $2, $3,
      $4, $5, $6, '{"runtimeLabel":"B1"}'::jsonb, $7
    )
  `, [testRunId, OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, isolated, networkDenied, LATER]);
}

async function insertValidationWithMembership(pool, {
  validationId,
  status,
  validationStatus,
} = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      validationInsert({ validationId, status }),
      [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW],
    );
    await client.query(
      validationMembershipInsert({ validationId, validationStatus }),
      [OBJECT_HASH, PACKAGE_HASH, DRAFT_HASH, NOW],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function objectInsert({ workspaceId, objectId, kind, contentHash, storageKey }) {
  return {
    text: `
      INSERT INTO public.product_objects (
        workspace_id, object_id, schema_version, object_kind, content_hash,
        size_bytes, media_type, storage_backend, storage_key, storage_version,
        state, created_at
      ) VALUES ($1, $2, 'workbench-v1', $3, $4, 10, 'application/octet-stream',
        'test-object-store', $5, 'v1', 'promoted', $6)
    `,
    values: [workspaceId, objectId, kind, contentHash, storageKey, NOW],
  };
}

function systemCatalogSourceInsert({
  sourceId = "b1-system-source",
  skillId = "b1-system-skill",
  probeStatus = "ready",
} = {}) {
  return `
    INSERT INTO public.skill_system_catalog_sources (
      workspace_id, catalog_source_id, skill_id, system_principal_id,
      schema_version, source_locator, source_revision, source_manifest_hash,
      package_object_id, package_object_hash, package_hash,
      published_version_content_hash,
      runtime_probe_id, runtime_probe_status, runtime_probe_code,
      runtime_probe_digest, execution_ref, execution_ref_hash,
      probed_at, created_at, definition
    ) VALUES (
      'b1-workspace-a', '${sourceId}', '${skillId}', 'system-catalog',
      'workbench-internal-v1',
      'bundled://agent-runtime/skills/meeting-action-extractor.md',
      'catalog-build-2026.08.05', $1,
      '${skillId === "b1-system-skill" ? "b1-system-package-object" : "b1-shared-object"}',
      $2, $2, '${SYSTEM_VERSION_HASH}',
      '${sourceId}:probe', '${probeStatus}', 'skill_loaded_and_bound',
      $3, '{"kind":"built_in","skillId":"meeting-action-extractor"}'::jsonb,
      $4, $5, $5, '{"name":"B1 system skill"}'::jsonb
    )
  `;
}

function validationInsert({
  validationId,
  status,
  permissionAcknowledged = true,
  testRunId = "b1-test-run-a",
  testStatus = "passed",
  draftRevision = 1,
  isolated = true,
  networkDenied = true,
  skillId = "b1-skill-a",
  workspaceId = "b1-workspace-a",
  draftId = "b1-draft-a",
  uploadId = "b1-upload-a",
  objectId = "b1-shared-object",
}) {
  return `
    INSERT INTO public.skill_validations (
      workspace_id, validation_id, skill_id, skill_draft_id, draft_revision,
      schema_version, upload_id, object_id, object_hash, package_hash, content_hash,
      primary_test_run_id, primary_test_status, primary_evidence_isolated,
      primary_evidence_network_denied, permission_acknowledged, status,
      diagnostics, runtime_summary, created_at, completed_at
    ) VALUES (
      '${workspaceId}', '${validationId}', '${skillId}', '${draftId}', ${draftRevision},
      'workbench-v1', '${uploadId}', '${objectId}', $1, $2, $3,
      '${testRunId}', '${testStatus}', ${isolated}, ${networkDenied},
      ${permissionAcknowledged}, '${status}', '[]'::jsonb, '{}'::jsonb,
      $4, $4
    )
  `;
}

function validationMembershipInsert({
  validationId,
  validationStatus,
  testRunId = "b1-test-run-a",
  testStatus = "passed",
  draftRevision = 1,
  isolated = true,
  networkDenied = true,
}) {
  return `
    INSERT INTO public.skill_validation_test_runs (
      workspace_id, validation_id, test_run_id, skill_id, skill_draft_id,
      draft_revision, upload_id, object_id, object_hash, package_hash,
      content_hash, validation_status, test_status, evidence_isolated,
      evidence_network_denied, schema_version, created_at
    ) VALUES (
      'b1-workspace-a', '${validationId}', '${testRunId}', 'b1-skill-a', 'b1-draft-a',
      ${draftRevision}, 'b1-upload-a', 'b1-shared-object', $1, $2,
      $3, '${validationStatus}', '${testStatus}', ${isolated},
      ${networkDenied}, 'workbench-internal-v1', $4
    )
  `;
}

function bindingInsert({ bindingId, validationId }) {
  return `
    INSERT INTO public.skill_execution_bindings (
      workspace_id, execution_binding_id, skill_id, skill_draft_id,
      draft_revision, validation_id, schema_version, upload_id, object_id,
      object_hash, package_hash, content_hash, published_version_content_hash,
      trust_tier, executor_kind,
      runtime_id, image_digest, capability_id, task_intent, adapter_version,
      execution_mode, created_at
    ) VALUES (
      'b1-workspace-a', '${bindingId}', 'b1-skill-a', 'b1-draft-a',
      1, '${validationId}', 'workbench-v1', 'b1-upload-a', 'b1-shared-object',
      $1, $2, $3, $4, 'uploaded_oci', 'docker',
      'python3.12', $5, '${bindingId}:capability', 'execute', 'v1',
      'deterministic', $6
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
    `, [workspaceId, scopeId, policyRevisionId, OBJECT_HASH, userId, NOW]);
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
    kind, OBJECT_HASH, NOW, EXPIRY,
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
    kind, OBJECT_HASH, approvalId, NOW, EXPIRY,
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
    OBJECT_HASH, kind, sessionId, turnId, NOW,
  ]);
}

async function expectConstraint(pool, statement, values, expectedCode, expectedConstraint) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let failure;
    try {
      await execute(client, statement, values);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `expected ${expectedConstraint} to reject the write`);
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.constraint, expectedConstraint);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function expectDatabaseError(pool, statement, values, expectedCode, message) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let failure;
    try {
      await execute(client, statement, values);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `expected ${message}`);
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.message, message);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

function execute(client, statement, values = []) {
  if (typeof statement === "string") return client.query(statement, values);
  return client.query(statement);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}
