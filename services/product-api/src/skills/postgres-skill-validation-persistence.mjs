import { ProductStoreError } from "../store/errors.mjs";

/** Narrow persistence port consumed by the existing Skill validation service. */
export class PostgresSkillValidationPersistence {
  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) throw new TypeError("postgres_skill_validation_persistence_store_required");
    this.store = store; this.clock = clock;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  withTransaction(work) {
    if (typeof work !== "function") throw new TypeError("postgres_skill_validation_transaction_required");
    return this.store.withTransaction((uow) => work(uow));
  }

  async getTestRun({ workspaceId, testRunId, uow } = {}) {
    required(workspaceId, "workspace_id_required"); required(testRunId, "skill_test_run_id_required");
    return this.#transaction(uow, async (query) => {
      const row = (await query(`SELECT run.*, evidence.isolated, evidence.network_denied, evidence.runtime_summary
        FROM public.skill_test_runs run LEFT JOIN public.skill_test_evidence evidence
          ON evidence.workspace_id = run.workspace_id AND evidence.test_run_id = run.test_run_id
        WHERE run.workspace_id = $1 AND run.test_run_id = $2`, [workspaceId, testRunId])).rows[0];
      return row ? testEntry(row) : null;
    });
  }

  async listRecoverable({ limit = 1_000, uow } = {}) {
    const bounded = Math.min(Math.max(Number(limit) || 1_000, 1), 1_000);
    return this.#transaction(uow, async (query) => (await query(`SELECT run.*, evidence.isolated, evidence.network_denied, evidence.runtime_summary
      FROM public.skill_test_runs run JOIN public.skill_test_evidence evidence
        ON evidence.workspace_id = run.workspace_id AND evidence.test_run_id = run.test_run_id
      WHERE run.status IN ('queued', 'running') ORDER BY run.updated_at, run.test_run_id LIMIT $1`, [bounded])).rows.map((row) => testEntry(row).record));
  }

  async insertTestRun({ record, evidence, uow } = {}) {
    assertTest(record, evidence);
    return this.#transaction(uow, async (query) => {
      const now = timestamp(this.clock());
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_test_runs (
          workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision, requested_by, product_command_id,
          schema_version, package_hash, content_hash, upload_id, object_id, object_hash, status, test_case,
          diagnostics, output_preview, execution_attempt, accepted_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $2, 'workbench-v1', $7, $8, $9, $10, $11, 'queued', $12::jsonb,
          '[]'::jsonb, NULL, 1, $13::timestamptz, $13::timestamptz, '{}'::jsonb)`, [
        record.workspaceId, record.testRunId, record.skillId, record.skillDraftId, evidence.draftRevision,
        record.requestedBy, record.packageHash, record.contentHash, evidence.uploadId, evidence.objectId,
        evidence.objectHash, JSON.stringify(record.testCase), now,
      ]);
      await query(`INSERT INTO public.skill_test_evidence (
          workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision, schema_version,
          upload_id, object_id, object_hash, package_hash, content_hash, isolated, network_denied,
          runtime_summary, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, 'workbench-internal-v1', $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::timestamptz, '{}'::jsonb)`, [
        record.workspaceId, record.testRunId, record.skillId, record.skillDraftId, evidence.draftRevision,
        evidence.uploadId, evidence.objectId, evidence.objectHash, evidence.packageHash, evidence.contentHash,
        evidence.isolated === true, evidence.networkDenied === true, JSON.stringify(evidence.runtimeSummary ?? {}), now,
      ]);
      return publicTest(record);
    });
  }

  async transitionTestRun({ workspaceId, testRunId, expectedStatuses, expectedExecutionAttempt, expectedClaimOwner, expectedClaimFence, expectedClaimValidAt, patch, uow } = {}) {
    required(workspaceId, "workspace_id_required"); required(testRunId, "skill_test_run_id_required");
    if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0 || !patch || typeof patch !== "object") throw coded("skill_test_transition_request_invalid");
    return this.#transaction(uow, async (query) => {
      const now = timestamp(this.clock());
      const next = (await query(`UPDATE public.skill_test_runs SET
          status = COALESCE($4, status), execution_attempt = COALESCE($5, execution_attempt),
          runner_claim_owner = CASE WHEN $6::boolean THEN $7 ELSE runner_claim_owner END,
          runner_claim_expires_at = CASE WHEN $6::boolean THEN $8::timestamptz ELSE runner_claim_expires_at END,
          started_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE started_at END,
          completed_at = CASE WHEN $11::boolean THEN $12::timestamptz ELSE completed_at END,
          diagnostics = CASE WHEN $13::boolean THEN $14::jsonb ELSE diagnostics END,
          output_preview = CASE WHEN $15::boolean THEN $16::jsonb ELSE output_preview END,
          row_revision = row_revision + 1, updated_at = $17::timestamptz,
          payload = payload || $18::jsonb
        WHERE workspace_id = $1 AND test_run_id = $2 AND status = ANY($3::text[])
          AND ($19::integer IS NULL OR execution_attempt = $19)
          AND ($20::text IS NULL OR runner_claim_owner = $20)
          AND ($21::integer IS NULL OR runner_claim_fence = $21)
          AND ($22::timestamptz IS NULL OR runner_claim_expires_at >= $22::timestamptz)
        RETURNING *`, [
        workspaceId, testRunId, expectedStatuses, patch.status ?? null, patch.executionAttempt ?? null,
        Object.hasOwn(patch, "runnerClaimOwner") || Object.hasOwn(patch, "runnerClaimExpiresAt"), patch.runnerClaimOwner ?? null, patch.runnerClaimExpiresAt ?? null,
        Object.hasOwn(patch, "startedAt"), patch.startedAt ?? null, Object.hasOwn(patch, "completedAt"), patch.completedAt ?? null,
        Object.hasOwn(patch, "diagnostics"), JSON.stringify(patch.diagnostics ?? []), Object.hasOwn(patch, "outputPreview"), JSON.stringify(patch.outputPreview ?? null), now,
        JSON.stringify({ ...(patch.settlementFailureCode ? { settlementFailureCode: patch.settlementFailureCode } : {}), ...(patch.settlementRetryAt ? { settlementRetryAt: patch.settlementRetryAt } : {}) }),
        expectedExecutionAttempt ?? null, expectedClaimOwner ?? null, expectedClaimFence ?? null, expectedClaimValidAt ?? null,
      ])).rows[0];
      return next ? publicTest(testRecord(next)) : null;
    });
  }

  async claim({ workspaceId, testRunId, claimOwner, now, leaseExpiresAt, expectedStatuses, uow } = {}) {
    required(workspaceId, "workspace_id_required"); required(testRunId, "skill_test_run_id_required"); required(claimOwner, "skill_test_claim_owner_required");
    return this.#transaction(uow, async (query) => {
      const row = (await query(`UPDATE public.skill_test_runs SET runner_claim_owner = $3, runner_claim_fence = runner_claim_fence + 1,
          runner_claim_expires_at = $4::timestamptz, row_revision = row_revision + 1, updated_at = $5::timestamptz
        WHERE workspace_id = $1 AND test_run_id = $2 AND status = ANY($6::text[])
          AND (runner_claim_owner IS NULL OR runner_claim_expires_at <= $5::timestamptz)
        RETURNING *`, [workspaceId, testRunId, claimOwner, leaseExpiresAt, now, expectedStatuses])).rows[0];
      return row ? claimView(row) : null;
    });
  }

  async renewClaim({ workspaceId, testRunId, claimOwner, claimFence, now, leaseExpiresAt, uow } = {}) {
    return this.#transaction(uow, async (query) => {
      const row = (await query(`UPDATE public.skill_test_runs SET runner_claim_expires_at = $5::timestamptz, row_revision = row_revision + 1, updated_at = $6::timestamptz
        WHERE workspace_id = $1 AND test_run_id = $2 AND runner_claim_owner = $3 AND runner_claim_fence = $4
          AND runner_claim_expires_at >= $6::timestamptz AND status IN ('queued', 'running') RETURNING *`, [workspaceId, testRunId, claimOwner, claimFence, leaseExpiresAt, now])).rows[0];
      return row ? claimView(row) : null;
    });
  }

  async getValidation({ workspaceId, validationId, uow } = {}) {
    required(workspaceId, "workspace_id_required"); required(validationId, "skill_validation_id_required");
    return this.#transaction(uow, async (query) => {
      const row = (await query(`SELECT validation.*, COALESCE(array_agg(member.test_run_id::text ORDER BY member.test_run_id) FILTER (WHERE member.test_run_id IS NOT NULL), '{}'::text[]) AS test_run_ids
        FROM public.skill_validations validation LEFT JOIN public.skill_validation_test_runs member
          ON member.workspace_id = validation.workspace_id AND member.validation_id = validation.validation_id
        WHERE validation.workspace_id = $1 AND validation.validation_id = $2
        GROUP BY validation.workspace_id, validation.validation_id`, [workspaceId, validationId])).rows[0];
      return row ? validationRecord(row) : null;
    });
  }

  async insertValidation(record, { uow } = {}) {
    assertValidation(record);
    return this.#transaction(uow, async (query) => {
      const tests = (await query(`SELECT run.*, evidence.isolated, evidence.network_denied, evidence.runtime_summary
        FROM public.skill_test_runs run JOIN public.skill_test_evidence evidence
          ON evidence.workspace_id = run.workspace_id AND evidence.test_run_id = run.test_run_id
        WHERE run.workspace_id = $1 AND run.test_run_id = ANY($2::text[])
        ORDER BY run.test_run_id`, [record.workspaceId, record.testRunIds])).rows;
      if (tests.length !== record.testRunIds.length) throw coded("skill_test_run_missing");
      const primary = tests.find((row) => row.test_run_id === record.testRunIds[0]) ?? tests[0];
      if (!primary || primary.skill_id !== record.skillId || primary.skill_draft_id !== record.skillDraftId || Number(primary.draft_revision) !== record.draftRevision || primary.content_hash !== record.contentHash) throw coded("skill_test_run_stale");
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_validations (
          workspace_id, validation_id, skill_id, skill_draft_id, draft_revision, schema_version,
          upload_id, object_id, object_hash, package_hash, content_hash, primary_test_run_id,
          primary_test_status, primary_evidence_isolated, primary_evidence_network_denied,
          permission_acknowledged, status, diagnostics, runtime_summary, created_at, completed_at, payload
        ) VALUES ($1, $2, $3, $4, $5, 'workbench-v1', $6, $7, $8, $9, $10, $11, $12, $13, $14,
          true, $15, $16::jsonb, $17::jsonb, $18::timestamptz, $19::timestamptz, '{}'::jsonb)`, [
        record.workspaceId, record.validationId, record.skillId, record.skillDraftId, record.draftRevision,
        primary.upload_id, primary.object_id, primary.object_hash, primary.package_hash, record.contentHash,
        primary.test_run_id, primary.status, primary.isolated, primary.network_denied, record.status,
        JSON.stringify(record.diagnostics ?? []), JSON.stringify(record.runtimeSummary ?? {}), record.createdAt, record.completedAt,
      ]);
      for (const row of tests) await query(`INSERT INTO public.skill_validation_test_runs (
        workspace_id, validation_id, test_run_id, skill_id, skill_draft_id, draft_revision, upload_id,
        object_id, object_hash, package_hash, content_hash, validation_status, test_status,
        evidence_isolated, evidence_network_denied, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'workbench-internal-v1', $16::timestamptz)`, [
        record.workspaceId, record.validationId, row.test_run_id, row.skill_id, row.skill_draft_id, row.draft_revision,
        row.upload_id, row.object_id, row.object_hash, row.package_hash, row.content_hash, record.status,
        row.status, row.isolated, row.network_denied, record.createdAt,
      ]);
      return structuredClone(record);
    });
  }

  #transaction(uow, work) { return uow == null ? this.store.withTransaction((unit) => work((text, values) => this.sql.query(unit, text, values))) : work((text, values) => this.sql.query(uow, text, values)); }
}

function testEntry(row) { return { record: testRecord(row), evidence: evidenceRecord(row) }; }
function testRecord(row) { return { schemaVersion: row.schema_version, testRunId: row.test_run_id, workspaceId: row.workspace_id, skillId: row.skill_id, skillDraftId: row.skill_draft_id, packageHash: row.package_hash, contentHash: row.content_hash, testCase: structuredClone(row.test_case), status: row.status, diagnostics: structuredClone(row.diagnostics ?? []), outputPreview: structuredClone(row.output_preview ?? null), executionAttempt: Number(row.execution_attempt), requestedBy: row.requested_by, runnerClaimOwner: row.runner_claim_owner ?? null, runnerClaimFence: Number(row.runner_claim_fence), runnerClaimExpiresAt: iso(row.runner_claim_expires_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at) }; }
function evidenceRecord(row) { return { workspaceId: row.workspace_id, skillId: row.skill_id, skillDraftId: row.skill_draft_id, draftRevision: Number(row.draft_revision), uploadId: row.upload_id, objectId: row.object_id, objectHash: row.object_hash, packageHash: row.package_hash, contentHash: row.content_hash, isolated: row.isolated === true, networkDenied: row.network_denied === true, runtimeSummary: structuredClone(row.runtime_summary ?? {}) }; }
function validationRecord(row) { return { schemaVersion: row.schema_version, validationId: row.validation_id, workspaceId: row.workspace_id, skillId: row.skill_id, skillDraftId: row.skill_draft_id, draftRevision: Number(row.draft_revision), contentHash: row.content_hash, testRunIds: [...(row.test_run_ids ?? [])], permissionAcknowledged: row.permission_acknowledged === true, status: row.status, diagnostics: structuredClone(row.diagnostics ?? []), runtimeSummary: structuredClone(row.runtime_summary ?? {}), createdAt: iso(row.created_at), completedAt: iso(row.completed_at) }; }
function publicTest(record) { return structuredClone(record); }
function claimView(row) { return { runnerClaimOwner: row.runner_claim_owner, runnerClaimFence: Number(row.runner_claim_fence), runnerClaimExpiresAt: iso(row.runner_claim_expires_at), executionAttempt: Number(row.execution_attempt) }; }
function assertTest(record, evidence) { for (const value of [record?.workspaceId, record?.testRunId, record?.skillId, record?.skillDraftId, record?.requestedBy, evidence?.uploadId, evidence?.objectId, evidence?.objectHash, evidence?.packageHash, evidence?.contentHash]) required(value, "skill_test_record_invalid"); }
function assertValidation(record) { for (const value of [record?.workspaceId, record?.validationId, record?.skillId, record?.skillDraftId, record?.contentHash]) required(value, "skill_validation_record_invalid"); if (!Array.isArray(record.testRunIds) || record.testRunIds.length === 0) throw coded("skill_test_run_ids_invalid"); }
function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function timestamp(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_skill_validation_clock_invalid"); return date.toISOString(); }
function iso(value) { return value == null ? null : timestamp(value); }
function coded(code) { return new ProductStoreError(code, code); }
