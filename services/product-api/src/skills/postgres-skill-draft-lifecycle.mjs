import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash, canonicalSkillDraftContentHash } from "../store/serialization.mjs";

const memberRank = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });
const emptySchema = Object.freeze({ type: "object", properties: {}, required: [] });
const defaultRisk = Object.freeze({ level: "low", externalAction: false, summary: "No external action is configured." });

/** Narrow PG owner for the first canonical Skill write: private Draft creation. */
export class PostgresSkillDraftLifecycle {
  constructor({ store, clock = () => new Date().toISOString(), idFactory } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof idFactory !== "function") {
      throw new TypeError("postgres_skill_draft_lifecycle_dependencies_invalid");
    }
    this.store = store; this.clock = clock; this.idFactory = idFactory;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async createSkill({ idempotencyKey, request, workspaceId, authoredBy, trustedActivation = null, sourcePackage = null } = {}) {
    const data = request?.data;
    if (!data || typeof data !== "object") throw coded("create_skill_request_required");
    for (const [value, code] of [[workspaceId, "workspace_id_required"], [authoredBy, "user_id_required"], [idempotencyKey, "idempotency_key_required"], [data.name, "skill_name_required"], [data.description, "skill_description_required"], [data.category, "skill_category_required"]]) required(value, code);
    if (trustedActivation !== null) throw coded("skill_package_lifecycle_unavailable");
    if ((data.uploadId && sourcePackage?.uploadId !== data.uploadId) || (!data.uploadId && sourcePackage)) throw coded("skill_package_substituted");
    const requestHash = canonicalRequestHash(request);
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const member = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!member || memberRank[member.role] < memberRank.member) throw coded("skill_creation_forbidden");
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([workspaceId, authoredBy, "create-skill", idempotencyKey])]);
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = 'create-skill' AND idempotency_key = $3 FOR UPDATE`, [workspaceId, authoredBy, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (existing.response == null) throw coded("idempotency_record_incomplete");
        return structuredClone(existing.response);
      }
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, 'create-skill', $3, $4, NULL, $5::timestamptz, NULL)`, [workspaceId, authoredBy, idempotencyKey, requestHash, now]);
      const scope = (await query(`SELECT scope_id FROM public.product_scopes WHERE workspace_id = $1 AND owner_user_id = $2 AND scope_kind = 'personal' AND status = 'active' LIMIT 1 FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!scope) throw coded("personal_scope_not_found");
      let upload = null;
      if (data.uploadId) {
        upload = (await query(`SELECT upload.*, object.media_type AS object_media_type, object.size_bytes AS object_size_bytes,
            object.state AS object_state FROM public.upload_sessions upload JOIN public.product_objects object
            ON object.workspace_id = upload.workspace_id AND object.object_id = upload.object_id
            AND object.object_kind = 'skill_package' AND object.content_hash = upload.object_content_hash
          WHERE upload.workspace_id = $1 AND upload.upload_id = $2 AND upload.requested_by = $3
            AND upload.asset_kind = 'skill' FOR SHARE`, [workspaceId, data.uploadId, authoredBy])).rows[0];
        if (!upload || upload.state !== "promoted" || upload.object_state !== "promoted"
          || !["passed", "needs_review"].includes(upload.inspection_status)) throw coded("skill_package_not_promoted");
        if (upload.object_id !== sourcePackage.objectId || upload.object_content_hash !== sourcePackage.contentHash
          || upload.object_media_type !== sourcePackage.mediaType || Number(upload.object_size_bytes) !== sourcePackage.sizeBytes
          || upload.payload?.inspection?.contentHash !== upload.package_hash) throw coded("skill_package_substituted");
      }
      const skillId = this.idFactory("skill"), skillDraftId = this.idFactory("skill-draft");
      const manifest = upload?.payload?.inspection?.manifest;
      const externalAction = manifest?.tools?.some((tool) => tool.effect === "write") === true;
      const definition = { schemaVersion: "workbench-v1", skillDraftId, skillId, workspaceId, baseVersionId: null, revision: 1,
        name: data.name, description: data.description, category: data.category,
        inputSchema: manifest ? interfaceSchema(manifest.inputs, true) : structuredClone(emptySchema),
        outputSchema: manifest ? interfaceSchema(manifest.outputs, false) : structuredClone(emptySchema),
        risk: externalAction ? { level: "high", externalAction: true, summary: "The package declares external write actions; execution requires review." } : structuredClone(defaultRisk),
        dependencies: [], connectionRequirements: [],
        files: upload ? [{ path: "package.skill-package", objectId: upload.object_id, contentHash: upload.object_content_hash,
          mediaType: upload.object_media_type, sizeBytes: Number(upload.object_size_bytes) }] : [],
        updatedBy: authoredBy, createdAt: now, updatedAt: now };
      const contentHash = canonicalSkillDraftContentHash(definition);
      try {
        await query(`INSERT INTO public.skill_assets (workspace_id, skill_id, scope_id, owner_user_id, schema_version, name_normalized, visibility, lifecycle, current_draft_id, created_at, updated_at, payload) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, 'private', 'draft', $6, $7::timestamptz, $7::timestamptz, $8::jsonb)`, [workspaceId, skillId, scope.scope_id, authoredBy, normalize(data.name), skillDraftId, now, JSON.stringify({ name: data.name })]);
      } catch (error) { if (error?.code === "23505") throw coded("skill_name_unavailable"); throw error; }
      const packageValues = [upload?.object_id ?? null, upload ? "skill_package" : null, upload?.object_content_hash ?? null, upload?.package_hash ?? null];
      await query(`INSERT INTO public.skill_drafts (workspace_id, skill_draft_id, skill_id, schema_version, draft_revision, content_hash, updated_by, created_at, updated_at, definition, payload, package_object_id, package_object_kind, package_object_hash, package_hash) VALUES ($1, $2, $3, 'workbench-v1', 1, $4, $5, $6::timestamptz, $6::timestamptz, $7::jsonb, '{}'::jsonb, $8, $9, $10, $11)`, [workspaceId, skillDraftId, skillId, contentHash, authoredBy, now, JSON.stringify(definition), ...packageValues]);
      await query(`INSERT INTO public.skill_draft_revision_snapshots (workspace_id, skill_id, skill_draft_id, draft_revision, schema_version, content_hash, created_by, created_at, definition, package_object_id, package_object_kind, package_object_hash, package_hash) VALUES ($1, $2, $3, 1, 'workbench-internal-v1', $4, $5, $6::timestamptz, $7::jsonb, $8, $9, $10, $11)`, [workspaceId, skillId, skillDraftId, contentHash, authoredBy, now, JSON.stringify(definition), ...packageValues]);
      const response = { skill: { schemaVersion: "workbench-v1", skillId, workspaceId, ownerId: authoredBy, visibility: "private", lifecycle: "draft", currentDraftId: skillDraftId, latestPublishedVersionId: null, createdAt: now, updatedAt: now }, draft: definition };
      await query(`UPDATE public.product_idempotency_receipts SET response = $5::jsonb, completed_at = $6::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = 'create-skill' AND idempotency_key = $3 AND request_hash = $4`, [workspaceId, authoredBy, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  async updateSkillDraft({ skillId, draftId, idempotencyKey, ifMatch, request, workspaceId, authoredBy } = {}) {
    for (const [value, code] of [[skillId, "skill_id_required"], [draftId, "skill_draft_id_required"], [idempotencyKey, "idempotency_key_required"], [ifMatch, "skill_draft_etag_required"], [workspaceId, "workspace_id_required"], [authoredBy, "user_id_required"]]) required(value, code);
    const data = request?.data;
    const editable = ["name", "description", "category", "inputSchema", "outputSchema", "risk", "dependencies", "connectionRequirements"];
    const patch = Object.fromEntries(editable.filter((field) => Object.hasOwn(data ?? {}, field)).map((field) => [field, structuredClone(data[field])]));
    if (Object.keys(patch).length === 0) throw coded("skill_draft_update_required");
    const requestHash = canonicalRequestHash({ ifMatch, request });
    const operationScope = `update-skill-draft:${skillId}:${draftId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("skill_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, authoredBy, operationScope, idempotencyKey])).rows[0];
      if (existing) { if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused"); if (!existing.response) throw coded("idempotency_record_incomplete"); return structuredClone(existing.response); }
      const skill = (await query(`SELECT * FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2 FOR UPDATE`, [workspaceId, skillId])).rows[0];
      if (!skill || skill.owner_user_id !== authoredBy || skill.current_draft_id !== draftId || !["draft", "tested"].includes(skill.lifecycle)) throw coded("skill_draft_not_editable");
      const draft = (await query(`SELECT * FROM public.skill_drafts WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 FOR UPDATE`, [workspaceId, skillId, draftId])).rows[0];
      if (!draft) throw coded("skill_draft_not_found");
      if (ifMatch !== `\"skd1:${draftId}:${Number(draft.draft_revision)}\"`) throw coded("skill_draft_conflict");
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, now]);
      const definition = { ...(draft.definition ?? {}), ...patch, schemaVersion: "workbench-v1", skillDraftId: draftId, skillId, workspaceId, baseVersionId: draft.base_version_id ?? null, revision: Number(draft.draft_revision) + 1, files: structuredClone(draft.definition?.files ?? []), updatedBy: authoredBy, createdAt: iso(draft.created_at), updatedAt: now };
      const contentHash = canonicalSkillDraftContentHash(definition);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_draft_revision_snapshots (workspace_id, skill_id, skill_draft_id, draft_revision, schema_version, content_hash, created_by, created_at, definition, package_object_id, package_object_kind, package_object_hash, package_hash) VALUES ($1, $2, $3, $4, 'workbench-internal-v1', $5, $6, $7::timestamptz, $8::jsonb, $9, $10, $11, $12)`, [workspaceId, skillId, draftId, definition.revision, contentHash, authoredBy, now, JSON.stringify(definition), draft.package_object_id ?? null, draft.package_object_kind ?? null, draft.package_object_hash ?? null, draft.package_hash ?? null]);
      await query(`UPDATE public.skill_drafts SET draft_revision = $4, content_hash = $5, updated_by = $6, updated_at = $7::timestamptz, definition = $8::jsonb WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 AND draft_revision = $9`, [workspaceId, skillId, draftId, definition.revision, contentHash, authoredBy, now, JSON.stringify(definition), Number(draft.draft_revision)]);
      await query(`UPDATE public.skill_assets SET name_normalized = $3, lifecycle = 'draft', updated_at = $4::timestamptz, payload = $5::jsonb WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId, normalize(definition.name), now, JSON.stringify({ ...(skill.payload ?? {}), name: definition.name })]);
      const response = { draft: { ...definition, contentHash } };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  /** Repoints only the active private Draft at one exact promoted package. */
  async replaceSkillDraftPackage({ skillId, draftId, idempotencyKey, ifMatch, request, workspaceId, authoredBy, replacement } = {}) {
    const data = request?.data;
    for (const [value, code] of [[skillId, "skill_id_required"], [draftId, "skill_draft_id_required"], [idempotencyKey, "idempotency_key_required"], [ifMatch, "skill_draft_etag_required"], [workspaceId, "workspace_id_required"], [authoredBy, "user_id_required"], [data?.uploadId, "upload_id_required"]]) required(value, code);
    if (!replacement || replacement.uploadId !== data.uploadId) throw coded("skill_package_substituted");
    const requestHash = canonicalRequestHash({ ifMatch, request });
    const operationScope = `replace-skill-draft-package:${skillId}:${draftId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("skill_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, authoredBy, operationScope, idempotencyKey])).rows[0];
      if (existing) { if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused"); if (!existing.response) throw coded("idempotency_record_incomplete"); return structuredClone(existing.response); }
      const skill = (await query(`SELECT * FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2 FOR UPDATE`, [workspaceId, skillId])).rows[0];
      if (!skill) throw coded("skill_not_found");
      if (skill.owner_user_id !== authoredBy) throw coded("skill_owner_required");
      if (!['draft', 'tested'].includes(skill.lifecycle) || skill.current_draft_id !== draftId) throw coded("skill_draft_not_editable");
      const draft = (await query(`SELECT * FROM public.skill_drafts WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 FOR UPDATE`, [workspaceId, skillId, draftId])).rows[0];
      if (!draft) throw coded("skill_draft_not_found");
      if (ifMatch !== `"skd1:${draftId}:${Number(draft.draft_revision)}"`) throw coded("skill_draft_conflict");
      const upload = (await query(`SELECT upload.upload_id, upload.state, upload.inspection_status, upload.object_id, upload.object_content_hash, upload.package_hash,
          object.media_type, object.size_bytes, object.state AS object_state
        FROM public.upload_sessions upload JOIN public.product_objects object
          ON object.workspace_id = upload.workspace_id AND object.object_id = upload.object_id
        WHERE upload.workspace_id = $1 AND upload.upload_id = $2 AND upload.requested_by = $3
          AND upload.asset_kind = 'skill' FOR SHARE`, [workspaceId, data.uploadId, authoredBy])).rows[0];
      if (!upload || upload.state !== "promoted" || !["passed", "needs_review"].includes(upload.inspection_status) || upload.object_state !== "promoted") throw coded("skill_package_not_promoted");
      if (upload.object_id !== replacement.objectId || upload.object_content_hash !== replacement.contentHash || upload.media_type !== replacement.mediaType || Number(upload.size_bytes) !== Number(replacement.sizeBytes)) throw coded("skill_package_substituted");
      const now = iso(this.clock());
      const definition = { ...(draft.definition ?? {}), schemaVersion: "workbench-v1", skillDraftId: draftId, skillId, workspaceId, baseVersionId: draft.base_version_id ?? null, revision: Number(draft.draft_revision) + 1, files: [{ path: "package.skill-package", objectId: upload.object_id, contentHash: upload.object_content_hash, mediaType: upload.media_type, sizeBytes: Number(upload.size_bytes) }], updatedBy: authoredBy, createdAt: iso(draft.created_at), updatedAt: now };
      delete definition.executionRef;
      const contentHash = canonicalSkillDraftContentHash(definition);
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, now]);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_draft_revision_snapshots (workspace_id, skill_id, skill_draft_id, draft_revision, schema_version, package_object_id, package_object_kind, package_object_hash, package_hash, content_hash, created_by, created_at, definition) VALUES ($1, $2, $3, $4, 'workbench-internal-v1', $5, 'skill_package', $6, $7, $8, $9, $10, $11::timestamptz, $12::jsonb)`, [workspaceId, skillId, draftId, definition.revision, upload.object_id, upload.object_content_hash, upload.package_hash, contentHash, authoredBy, now, JSON.stringify(definition)]);
      await query(`UPDATE public.skill_drafts SET draft_revision = $4, package_object_id = $5, package_object_kind = 'skill_package', package_object_hash = $6, package_hash = $7, content_hash = $8, updated_by = $9, updated_at = $10::timestamptz, definition = $11::jsonb WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 AND draft_revision = $12`, [workspaceId, skillId, draftId, definition.revision, upload.object_id, upload.object_content_hash, upload.package_hash, contentHash, authoredBy, now, JSON.stringify(definition), Number(draft.draft_revision)]);
      await query(`UPDATE public.skill_assets SET lifecycle = 'draft', updated_at = $3::timestamptz WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId, now]);
      const response = { draft: { ...definition, contentHash } };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  /**
   * Starts the next private editing branch from an immutable published Skill
   * Version. The Version stays authoritative: the Draft receives a copied
   * definition and a reference to the exact promoted package object.
   */
  async createNextSkillDraft({ skillId, idempotencyKey, ifMatch, request, workspaceId, authoredBy } = {}) {
    for (const [value, code] of [[skillId, "skill_id_required"], [idempotencyKey, "idempotency_key_required"], [ifMatch, "skill_draft_etag_required"], [workspaceId, "workspace_id_required"], [authoredBy, "user_id_required"], [request?.data?.baseVersionId, "base_skill_version_required"]]) required(value, code);
    const baseVersionId = request.data.baseVersionId;
    const requestHash = canonicalRequestHash({ ifMatch, request });
    const operationScope = `create-next-skill-draft:${skillId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, authoredBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("skill_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, authoredBy, operationScope, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (!existing.response) throw coded("idempotency_record_incomplete");
        return structuredClone(existing.response);
      }
      const skill = (await query(`SELECT * FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2 FOR UPDATE`, [workspaceId, skillId])).rows[0];
      if (!skill) throw coded("skill_not_found");
      if (skill.owner_user_id !== authoredBy) throw coded("skill_owner_required");
      if (skill.lifecycle !== "published" || !skill.latest_published_version_id || !skill.current_draft_id) throw coded("skill_update_not_published");
      const currentDraft = (await query(`SELECT skill_draft_id, draft_revision FROM public.skill_drafts WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 FOR SHARE`, [workspaceId, skillId, skill.current_draft_id])).rows[0];
      if (!currentDraft || ifMatch !== `\"skd1:${currentDraft.skill_draft_id}:${Number(currentDraft.draft_revision)}\"`) throw coded("skill_draft_conflict");
      const version = (await query(`SELECT * FROM public.skill_versions WHERE workspace_id = $1 AND skill_id = $2 AND skill_version_id = $3 FOR SHARE`, [workspaceId, skillId, baseVersionId])).rows[0];
      if (!version) throw coded("skill_version_not_found");
      const packageObject = (await query(`SELECT object_id, content_hash, media_type, size_bytes FROM public.product_objects WHERE workspace_id = $1 AND object_id = $2 AND object_kind = 'skill_package' AND content_hash = $3 FOR SHARE`, [workspaceId, version.package_object_id, version.package_object_hash])).rows[0];
      if (!packageObject) throw coded("skill_package_object_missing");
      const revisionRow = (await query(`SELECT COALESCE(MAX(draft_revision), 0) + 1 AS next_revision FROM public.skill_drafts WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId])).rows[0];
      const nextRevision = Number(revisionRow?.next_revision);
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) throw new TypeError("postgres_skill_draft_revision_invalid");
      const now = iso(this.clock());
      const skillDraftId = this.idFactory("skill-draft");
      const baseDefinition = version.definition;
      if (!baseDefinition || typeof baseDefinition !== "object" || Array.isArray(baseDefinition)) throw coded("skill_version_definition_invalid");
      const definition = {
        ...structuredClone(baseDefinition),
        schemaVersion: "workbench-v1",
        skillDraftId,
        skillId,
        workspaceId,
        baseVersionId,
        revision: nextRevision,
        files: [{ path: "package.skill-package", objectId: packageObject.object_id, contentHash: packageObject.content_hash, mediaType: packageObject.media_type, sizeBytes: Number(packageObject.size_bytes) }],
        updatedBy: authoredBy,
        createdAt: now,
        updatedAt: now,
      };
      if (![definition.name, definition.description, definition.category].every((value) => typeof value === "string" && value.trim())) throw coded("skill_version_definition_invalid");
      const contentHash = canonicalSkillDraftContentHash(definition);
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, now]);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_drafts (workspace_id, skill_draft_id, skill_id, schema_version, base_version_id, draft_revision, package_object_id, package_object_kind, package_object_hash, package_hash, content_hash, updated_by, created_at, updated_at, definition, payload) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6, 'skill_package', $7, $8, $9, $10, $11::timestamptz, $11::timestamptz, $12::jsonb, '{}'::jsonb)`, [workspaceId, skillDraftId, skillId, baseVersionId, nextRevision, packageObject.object_id, packageObject.content_hash, version.package_hash, contentHash, authoredBy, now, JSON.stringify(definition)]);
      await query(`INSERT INTO public.skill_draft_revision_snapshots (workspace_id, skill_id, skill_draft_id, draft_revision, schema_version, package_object_id, package_object_kind, package_object_hash, package_hash, content_hash, created_by, created_at, definition) VALUES ($1, $2, $3, $4, 'workbench-internal-v1', $5, 'skill_package', $6, $7, $8, $9, $10::timestamptz, $11::jsonb)`, [workspaceId, skillId, skillDraftId, nextRevision, packageObject.object_id, packageObject.content_hash, version.package_hash, contentHash, authoredBy, now, JSON.stringify(definition)]);
      await query(`UPDATE public.skill_assets SET current_draft_id = $3, lifecycle = 'draft', updated_at = $4::timestamptz WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId, skillDraftId, now]);
      const response = { skill: { ...(skill.payload ?? {}), schemaVersion: skill.schema_version, skillId, workspaceId, scopeId: skill.scope_id, ownerId: authoredBy, visibility: skill.visibility, lifecycle: "draft", currentDraftId: skillDraftId, latestPublishedVersionId: skill.latest_published_version_id, createdAt: iso(skill.created_at), updatedAt: now }, draft: { ...definition, contentHash } };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, authoredBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  async deprecateSkill({ skillId, idempotencyKey, request, workspaceId, deprecatedBy } = {}) {
    for (const [value, code] of [[skillId, "skill_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [deprecatedBy, "user_id_required"], [request?.data?.reason, "skill_deprecation_reason_required"]]) required(value, code);
    const requestHash = canonicalRequestHash(request);
    const operationScope = `deprecate-skill:${skillId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, deprecatedBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("skill_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, deprecatedBy, operationScope, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (!existing.response) throw coded("idempotency_record_incomplete");
        return structuredClone(existing.response);
      }
      const skill = (await query(`SELECT * FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2 FOR UPDATE`, [workspaceId, skillId])).rows[0];
      if (!skill) throw coded("skill_not_found");
      if (skill.owner_user_id !== deprecatedBy) throw coded("skill_owner_required");
      if (skill.lifecycle !== "published" || !skill.latest_published_version_id) throw coded("skill_deprecation_not_allowed");
      const now = iso(this.clock());
      const payload = { ...(skill.payload ?? {}), retirement: { reason: request.data.reason, retiredAt: now, retiredBy: deprecatedBy } };
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, deprecatedBy, operationScope, idempotencyKey, requestHash, now]);
      await query(`UPDATE public.skill_assets SET lifecycle = 'deprecated', updated_at = $3::timestamptz, payload = $4::jsonb WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId, now, JSON.stringify(payload)]);
      const response = { ...payload, schemaVersion: skill.schema_version, skillId, workspaceId, scopeId: skill.scope_id, ownerId: deprecatedBy, visibility: skill.visibility, lifecycle: "deprecated", currentDraftId: skill.current_draft_id ?? null, latestPublishedVersionId: skill.latest_published_version_id, createdAt: iso(skill.created_at), updatedAt: now };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, deprecatedBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  /**
   * Publishes only the exact Draft proven by an immutable passed Validation and
   * its matching approved execution binding.  This deliberately does not run
   * validation or inspect package bytes: those are separate product owners.
   */
  async publishSkill({ skillId, idempotencyKey, ifMatch, request, workspaceId, publishedBy } = {}) {
    const data = request?.data;
    for (const [value, code] of [[skillId, "skill_id_required"], [idempotencyKey, "idempotency_key_required"], [ifMatch, "skill_draft_etag_required"], [workspaceId, "workspace_id_required"], [publishedBy, "user_id_required"], [data?.version, "skill_version_required"]]) required(value, code);
    if (typeof data.releaseNotes !== "string") throw coded("skill_publish_request_invalid");
    const requestHash = canonicalRequestHash({ ifMatch, request });
    const operationScope = `publish-skill:${skillId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, publishedBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("skill_creation_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, publishedBy, operationScope, idempotencyKey])).rows[0];
      if (existing) { if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused"); if (!existing.response) throw coded("idempotency_record_incomplete"); return structuredClone(existing.response); }
      const skill = (await query(`SELECT * FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2 FOR UPDATE`, [workspaceId, skillId])).rows[0];
      if (!skill) throw coded("skill_not_found");
      if (skill.owner_user_id !== publishedBy) throw coded("skill_owner_required");
      if (skill.lifecycle !== "tested" || !skill.current_draft_id) throw coded("skill_publish_requires_tested");
      const draft = (await query(`SELECT * FROM public.skill_drafts WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 FOR UPDATE`, [workspaceId, skillId, skill.current_draft_id])).rows[0];
      if (!draft) throw coded("skill_draft_not_found");
      if (ifMatch !== `"skd1:${draft.skill_draft_id}:${Number(draft.draft_revision)}"`) throw coded("skill_draft_conflict");
      const definition = structuredClone(draft.definition ?? {});
      const contentHash = canonicalSkillDraftContentHash(definition);
      if (contentHash !== draft.content_hash || !draft.package_object_id || !draft.package_object_hash || !draft.package_hash) throw coded("skill_package_not_publishable");
      const packageRow = (await query(`SELECT upload.upload_id, upload.state, upload.inspection_status, upload.package_hash,
          object.object_id, object.content_hash, object.state AS object_state
        FROM public.upload_sessions upload JOIN public.product_objects object
          ON object.workspace_id = upload.workspace_id AND object.object_id = upload.object_id
        WHERE upload.workspace_id = $1 AND upload.asset_kind = 'skill'
          AND upload.object_id = $2 AND upload.object_content_hash = $3 AND upload.package_hash = $4
        ORDER BY upload.updated_at DESC, upload.upload_id DESC LIMIT 1 FOR SHARE`, [workspaceId, draft.package_object_id, draft.package_object_hash, draft.package_hash])).rows[0];
      if (!packageRow || packageRow.state !== "promoted" || !["passed", "needs_review"].includes(packageRow.inspection_status) || packageRow.object_state !== "promoted") throw coded("skill_package_not_publishable");
      const validation = (await query(`SELECT * FROM public.skill_validations
        WHERE workspace_id = $1 AND skill_id = $2 AND skill_draft_id = $3 AND draft_revision = $4
          AND content_hash = $5 AND object_id = $6 AND object_hash = $7 AND package_hash = $8 AND status = 'passed'
        ORDER BY completed_at DESC, validation_id DESC LIMIT 1 FOR SHARE`, [workspaceId, skillId, draft.skill_draft_id, Number(draft.draft_revision), contentHash, draft.package_object_id, draft.package_object_hash, draft.package_hash])).rows[0];
      if (!validation) throw coded("skill_validation_failed");
      const binding = (await query(`SELECT * FROM public.skill_execution_bindings
        WHERE workspace_id = $1 AND validation_id = $2 AND skill_id = $3 AND skill_draft_id = $4
          AND draft_revision = $5 AND object_id = $6 AND object_hash = $7 AND package_hash = $8 AND content_hash = $9
        LIMIT 1 FOR SHARE`, [workspaceId, validation.validation_id, skillId, draft.skill_draft_id, Number(draft.draft_revision), draft.package_object_id, draft.package_object_hash, draft.package_hash, contentHash])).rows[0];
      if (!binding) throw coded("skill_activation_required");
      const duplicate = (await query(`SELECT skill_version_id FROM public.skill_versions WHERE workspace_id = $1 AND skill_id = $2 AND version = $3 FOR SHARE`, [workspaceId, skillId, data.version])).rows[0];
      if (duplicate) throw coded("skill_version_exists");
      const now = iso(this.clock());
      const skillVersionId = this.idFactory("skill-version");
      const releaseId = this.idFactory("release");
      const executionRef = bindingView(binding);
      const validationView = { validationId: validation.validation_id, status: validation.status, diagnostics: structuredClone(validation.diagnostics ?? []), testedAt: iso(validation.completed_at), contentHash, testRunIds: [validation.primary_test_run_id] };
      // The baseline trigger checks byte-for-byte JSONB equality with the
      // immutable Draft Snapshot. Validation and execution are separate
      // immutable authorities, joined by the PG read model instead.
      const publishedDefinition = structuredClone(definition);
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, publishedBy, operationScope, idempotencyKey, requestHash, now]);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.skill_versions (
          workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
          source_skill_draft_id, source_draft_revision, validation_id, execution_binding_id,
          package_object_id, package_object_kind, package_object_hash, package_hash,
          validated_draft_content_hash, content_hash, published_by_user_id, published_at, definition, payload
        ) VALUES ($1, $2, $3, $4, 'workbench-v1', 'validated_draft', $5, $6, $7, $8,
          $9, 'skill_package', $10, $11, $12, $13, $14, $15::timestamptz, $16::jsonb, '{}'::jsonb)`, [workspaceId, skillVersionId, skillId, data.version, draft.skill_draft_id, Number(draft.draft_revision), validation.validation_id, binding.execution_binding_id, draft.package_object_id, draft.package_object_hash, draft.package_hash, contentHash, binding.published_version_content_hash, publishedBy, now, JSON.stringify(publishedDefinition)]);
      await query(`INSERT INTO public.workspace_asset_releases (
          source_workspace_id, release_id, schema_version, asset_kind, skill_id, skill_version_id,
          version, content_hash, visibility, domain, release_notes, dependencies, published_by, published_at, payload
        ) VALUES ($1, $2, 'workbench-v1', 'skill', $3, $4, $5, $6, 'workspace', $7, $8, $9::jsonb, $10, $11::timestamptz, '{}'::jsonb)`, [workspaceId, releaseId, skillId, skillVersionId, data.version, binding.published_version_content_hash, libraryDomain(definition.category), data.releaseNotes, JSON.stringify(definition.dependencies ?? []), publishedBy, now]);
      await query(`UPDATE public.skill_assets SET lifecycle = 'published', latest_published_version_id = $3, updated_at = $4::timestamptz WHERE workspace_id = $1 AND skill_id = $2`, [workspaceId, skillId, skillVersionId, now]);
      const skillView = { ...(skill.payload ?? {}), schemaVersion: skill.schema_version, skillId, workspaceId, scopeId: skill.scope_id, ownerId: publishedBy, visibility: skill.visibility, lifecycle: "published", currentDraftId: draft.skill_draft_id, latestPublishedVersionId: skillVersionId, createdAt: iso(skill.created_at), updatedAt: now };
      const versionView = { ...publishedDefinition, skillVersionId, skillId, workspaceId, version: data.version, packageHash: draft.package_hash, contentHash: binding.published_version_content_hash, validation: validationView, executionRef, publishedAt: now };
      const release = { schemaVersion: "workbench-v1", releaseId, assetKind: "skill", assetId: skillId, versionId: skillVersionId, version: data.version, visibility: "workspace", startingPoint: false, releaseNotes: data.releaseNotes, dependencies: structuredClone(definition.dependencies ?? []), publishedAt: now };
      const response = { skill: skillView, version: versionView, release };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, publishedBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

}
function interfaceSchema(entries = [], input) {
  // Attachment metadata drives the existing material picker; actual bytes
  // still pass through Product's material-binding resolver at execution.
  const parameters = entries;
  const properties = Object.fromEntries(parameters.map((entry) => [entry.name, {
    ...(entry.type === "json" ? {} : { type: entry.type === "markdown" ? "string" : entry.type === "file" ? "object" : entry.type }),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.type === "file" ? { format: "attachment", ...(entry.acceptedMediaTypes ? { acceptedMediaTypes: [...entry.acceptedMediaTypes] } : {}) } : {}),
  }]));
  return { type: "object", properties, required: parameters.filter((entry) => !input || entry.required).map((entry) => entry.name) };
}
function normalize(value) { return String(value).normalize("NFKC").trim().toLowerCase(); }
function libraryDomain(value) { const category = String(value ?? "").toLowerCase(); if (/(research|search|insight|market)/.test(category)) return "research"; if (/(data|finance|analytics|analysis|report)/.test(category)) return "data"; return /(engineering|coding|code|ops|automation|develop)/.test(category) ? "engineering" : "product"; }
function bindingView(binding) { return { capabilityId: binding.capability_id, taskIntent: binding.task_intent, adapterVersion: binding.adapter_version, executionMode: binding.execution_mode, executorKind: binding.executor_kind, trustTier: binding.trust_tier, ...(binding.runtime_id ? { runtimeId: binding.runtime_id } : {}), ...(binding.image_digest ? { imageDigest: binding.image_digest } : {}) }; }
function required(value, code) { if (typeof value !== "string" || !value.trim()) throw coded(code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_skill_clock_invalid"); return date.toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
