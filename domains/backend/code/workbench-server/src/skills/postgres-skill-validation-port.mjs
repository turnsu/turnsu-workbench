import { ProductStoreError } from "../store/errors.mjs";
import { hashSkillPackageObject } from "./skill-package-format.mjs";

/**
 * PostgreSQL semantic boundary for the existing Skill validation coordinator.
 * It owns the exact Draft/package/validation/binding aggregate; it is not a
 * generic repository facade and exposes no raw database handle to callers.
 */
export class PostgresSkillValidationPort {
  constructor({ store, objectStore, persistence } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !objectStore?.read
      || !persistence?.getTestRun || !persistence?.getValidation) {
      throw new TypeError("postgres_skill_validation_port_dependencies_invalid");
    }
    this.store = store;
    this.objectStore = objectStore;
    this.persistence = persistence;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  withTransaction(work) { return this.store.withTransaction((uow) => work(uow)); }
  persistenceFor({ uow, session } = {}) {
    const unit = uow ?? session;
    if (!unit) return this.persistence;
    return Object.freeze({
      ...Object.fromEntries([
        "getTestRun", "insertTestRun", "transitionTestRun", "getValidation",
      ].map((method) => [method, (input) => this.persistence[method]({ ...input, uow: unit })])),
      insertValidation: (record) => this.persistence.insertValidation(record, { uow: unit }),
    });
  }
  async getTestRun(input) { return (await this.persistence.getTestRun(input))?.record ?? null; }
  getValidation(input) { return this.persistence.getValidation(input); }

  async resolveValidationContext({ workspaceId, skillId, draftId, requestedBy, uow } = {}) {
    return this.#transaction(uow, async (query) => {
      const row = (await query(`SELECT asset.*, draft.*, upload.upload_id, upload.state AS upload_state,
          upload.package_hash AS upload_package_hash, upload.payload AS upload_payload,
          object.object_id AS verified_object_id, object.content_hash AS verified_object_hash,
          object.state AS object_state
        FROM public.skill_assets asset
        JOIN public.skill_drafts draft ON draft.workspace_id = asset.workspace_id
          AND draft.skill_id = asset.skill_id AND draft.skill_draft_id = $3
        JOIN public.workspace_memberships member ON member.workspace_id = asset.workspace_id
          AND member.user_id = $4 AND member.status = 'active'
        JOIN public.upload_sessions upload ON upload.workspace_id = asset.workspace_id
          AND upload.asset_kind = 'skill' AND upload.object_id = draft.package_object_id
          AND upload.object_content_hash = draft.package_object_hash AND upload.package_hash = draft.package_hash
        JOIN public.product_objects object ON object.workspace_id = asset.workspace_id
          AND object.object_id = draft.package_object_id AND object.object_kind = 'skill_package'
          AND object.content_hash = draft.package_object_hash
        WHERE asset.workspace_id = $1 AND asset.skill_id = $2 AND asset.owner_user_id = $4
          AND asset.current_draft_id = $3 AND asset.lifecycle = 'draft'
          AND upload.state = 'promoted' AND object.state = 'promoted'
        FOR SHARE OF asset, draft, member, upload, object`, [workspaceId, skillId, draftId, requestedBy])).rows[0];
      if (!row) throw coded("skill_package_not_publishable");
      const inspection = row.upload_payload?.inspection;
      if (!inspection?.contentHash || inspection.contentHash !== row.package_hash) throw coded("skill_package_not_publishable");
      return Object.freeze({
        skill: skillView(row),
        draft: structuredClone(row.definition),
        uploadId: row.upload_id,
        objectId: row.verified_object_id,
        objectHash: row.verified_object_hash,
        packageHash: row.upload_package_hash,
        contentHash: row.content_hash,
        inspection: structuredClone(inspection),
      });
    });
  }

  async loadPromotedPackage(request, { uow, session } = {}) {
    const { workspaceId, uploadId, objectId, objectHash, packageHash, requestedBy, signal } = request ?? {};
    return this.#transaction(uow ?? session, async (query) => {
      const owned = requestedBy ? "AND upload.requested_by = $6" : "";
      const values = requestedBy
        ? [workspaceId, uploadId, objectId, objectHash, packageHash, requestedBy]
        : [workspaceId, uploadId, objectId, objectHash, packageHash];
      const row = (await query(`SELECT upload.upload_id, upload.state AS upload_state, upload.package_hash,
          upload.payload AS upload_payload, object.object_id, object.content_hash, object.media_type, object.state AS object_state
        FROM public.upload_sessions upload JOIN public.product_objects object
          ON object.workspace_id = upload.workspace_id AND object.object_id = upload.object_id
        WHERE upload.workspace_id = $1 AND upload.upload_id = $2 AND upload.asset_kind = 'skill'
          AND upload.object_id = $3 AND upload.object_content_hash = $4 AND upload.package_hash = $5
          ${owned} AND upload.state = 'promoted' AND object.object_kind = 'skill_package' AND object.state = 'promoted'`, values)).rows[0];
      const inspection = row?.upload_payload?.inspection;
      if (!row || !inspection || inspection.contentHash !== packageHash) throw coded("skill_package_not_promoted");
      const stored = await this.objectStore.read({ workspaceId, objectId, signal });
      if (stored.object?.state !== 'promoted' || stored.object?.contentHash !== objectHash
        || hashSkillPackageObject(stored.bytes) !== objectHash) throw coded("skill_package_substituted");
      return Object.freeze({ workspaceId, uploadId, objectId, objectHash, packageHash,
        inspection: structuredClone(inspection), state: 'promoted', bytes: Buffer.from(stored.bytes) });
    });
  }

  async loadTestExecutionPackage({ workspaceId, executionRef, signal } = {}) {
    const entry = await this.persistence.getTestRun({ workspaceId, testRunId: executionRef?.testRunId });
    if (!entry?.record || !entry.evidence) throw coded("skill_test_execution_ref_invalid");
    return this.loadPromotedPackage({ workspaceId, requestedBy: entry.record.requestedBy,
      uploadId: entry.evidence.uploadId, objectId: entry.evidence.objectId,
      objectHash: entry.evidence.objectHash, packageHash: entry.evidence.packageHash, signal });
  }

  async resolveExecutionBinding({ workspaceId, executionRef, imageDigests } = {}) {
    return this.#transaction(null, async (query) => {
      const row = (await query(`SELECT * FROM public.skill_execution_bindings
        WHERE workspace_id = $1 AND capability_id = $2 AND task_intent = $3
          AND adapter_version = $4 AND execution_mode = $5 LIMIT 1`, [workspaceId,
        executionRef?.capabilityId, executionRef?.taskIntent, executionRef?.adapterVersion, executionRef?.executionMode])).rows[0];
      const prompt = executionRef?.executionMode === 'agent';
      if (!row || row.executor_kind !== (prompt ? 'prompt_tool' : 'docker')
        || (!prompt && row.image_digest !== imageDigests?.get(row.runtime_id))) {
        throw coded("uploaded_skill_execution_binding_missing");
      }
      return bindingView(row);
    });
  }

  async createValidation(input, { uow, createRecord, imageDigests, idFactory, clock } = {}) {
    return this.#transaction(uow, async (query) => {
      const asset = (await query(`SELECT * FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2
        AND current_draft_id = $3 AND lifecycle = 'draft' FOR UPDATE`, [input.workspaceId, input.skillId, input.draftId])).rows[0];
      if (!asset) throw coded("skill_validation_state_invalid");
      await query(`UPDATE public.skill_assets SET lifecycle = 'validating', updated_at = $3::timestamptz
        WHERE workspace_id = $1 AND skill_id = $2`, [input.workspaceId, input.skillId, timestamp(clock)]);
      const record = await createRecord();
      if (record.status !== 'passed') {
        await query(`UPDATE public.skill_assets SET lifecycle = 'draft', updated_at = $3::timestamptz
          WHERE workspace_id = $1 AND skill_id = $2`, [input.workspaceId, input.skillId, timestamp(clock)]);
        return record;
      }
      const loaded = await this.loadPromotedPackage(input, { uow });
      const promptTool = isPrompt(loaded.inspection);
      const runtimeId = loaded.inspection?.manifest?.runtime?.runtime ?? null;
      const imageDigest = promptTool ? null : imageDigests?.get(runtimeId);
      if (!promptTool && !imageDigest) throw coded("skill_runtime_unavailable");
      const duplicate = (await query(`SELECT execution_binding_id FROM public.skill_execution_bindings
        WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 AND draft_revision = $4
          AND content_hash = $5 AND package_hash = $6 FOR SHARE`, [input.workspaceId, input.skillId,
        input.draftId, input.draftRevision, input.contentHash, input.packageHash])).rows[0];
      if (duplicate) throw coded("skill_validation_already_passed");
      const executionRef = input.executionRef ?? generatedExecutionRef(input.packageHash, promptTool);
      const now = timestamp(clock);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_execution_bindings (
          workspace_id, execution_binding_id, skill_id, skill_draft_id, draft_revision, validation_id,
          schema_version, upload_id, object_id, object_hash, package_hash, content_hash, published_version_content_hash,
          trust_tier, executor_kind, runtime_id, image_digest, capability_id, task_intent, adapter_version,
          execution_mode, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, 'workbench-v1', $7, $8, $9, $10, $11, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20::timestamptz, '{}'::jsonb)`, [
        input.workspaceId, idFactory('skill-execution-binding'), input.skillId, input.draftId, input.draftRevision,
        record.validationId, input.uploadId, input.objectId, input.objectHash, input.packageHash, input.contentHash,
        promptTool ? 'uploaded_prompt' : 'uploaded_oci', promptTool ? 'prompt_tool' : 'docker', runtimeId, imageDigest,
        executionRef.capabilityId, executionRef.taskIntent, executionRef.adapterVersion, executionRef.executionMode, now,
      ]);
      await query(`UPDATE public.skill_assets SET lifecycle = 'tested', updated_at = $3::timestamptz
        WHERE workspace_id = $1 AND skill_id = $2`, [input.workspaceId, input.skillId, now]);
      return record;
    });
  }

  #transaction(uow, work) { return uow == null ? this.store.withTransaction((unit) => work((text, values) => this.sql.query(unit, text, values))) : work((text, values) => this.sql.query(uow, text, values)); }
}

function isPrompt(inspection) { return !inspection?.manifest?.runtime && !(inspection?.inventory ?? []).some((file) => file?.kind === 'executable'); }
function generatedExecutionRef(packageHash, prompt) { const digest = packageHash.slice('sha256:'.length, 'sha256:'.length + 48); return { capabilityId: `${prompt ? 'prompt' : 'uploaded'}-${digest}`, taskIntent: 'execute', adapterVersion: '1', executionMode: prompt ? 'agent' : 'deterministic' }; }
function skillView(row) { return { schemaVersion: row.schema_version, skillId: row.skill_id, workspaceId: row.workspace_id, ownerId: row.owner_user_id, visibility: row.visibility, lifecycle: row.lifecycle, currentDraftId: row.current_draft_id, latestPublishedVersionId: row.latest_published_version_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
function bindingView(row) { return { workspaceId: row.workspace_id, skillId: row.skill_id, skillDraftId: row.skill_draft_id, draftRevision: Number(row.draft_revision), validationId: row.validation_id, uploadId: row.upload_id, objectId: row.object_id, objectHash: row.object_hash, packageHash: row.package_hash, contentHash: row.content_hash, trustTier: row.trust_tier, executorKind: row.executor_kind, runtimeId: row.runtime_id ?? null, imageDigest: row.image_digest ?? null, executionRef: { capabilityId: row.capability_id, taskIntent: row.task_intent, adapterVersion: row.adapter_version, executionMode: row.execution_mode } }; }
function timestamp(clock) { const value = clock(); const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError('postgres_skill_validation_clock_invalid'); return date.toISOString(); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
