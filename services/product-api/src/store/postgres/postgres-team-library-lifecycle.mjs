import { ProductStoreError } from "../errors.mjs";
import { canonicalRequestHash } from "../serialization.mjs";

const memberRank = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/** PG write owner for explicit local and platform-catalog installations. */
export class PostgresTeamLibraryLifecycle {
  constructor({ store, clock = () => new Date().toISOString(), idFactory } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof idFactory !== "function") {
      throw new TypeError("postgres_team_library_lifecycle_dependencies_invalid");
    }
    this.store = store; this.clock = clock; this.idFactory = idFactory;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async installRelease({ releaseId, sourceWorkspaceId: requestedSourceWorkspaceId = null, minimumRole = "member", idempotencyKey, request, workspaceId, installedBy } = {}) {
    for (const [value, code] of [[releaseId, "release_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [installedBy, "user_id_required"]]) required(value, code);
    if (!memberRank[minimumRole]) throw new TypeError("team_library_install_minimum_role_invalid");
    const sourceWorkspaceId = requestedSourceWorkspaceId ?? workspaceId;
    const requestHash = canonicalRequestHash(request);
    const operationScope = `install-release:${sourceWorkspaceId}:${releaseId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, installedBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank[minimumRole]) throw coded("team_library_install_forbidden");
      const existingReceipt = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, installedBy, operationScope, idempotencyKey])).rows[0];
      if (existingReceipt) {
        if (existingReceipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (!existingReceipt.response) throw coded("idempotency_record_incomplete");
        return structuredClone(existingReceipt.response);
      }
      const release = (await query(`SELECT * FROM public.workspace_asset_releases WHERE source_workspace_id = $1 AND release_id = $2 AND visibility = 'workspace' FOR SHARE`, [sourceWorkspaceId, releaseId])).rows[0];
      if (!release) throw coded("release_not_available");
      if (release.native_loop_version_id) throw coded("native_loop_managed_execution_unavailable");
      if (!["skill", "loop"].includes(release.asset_kind)) throw coded("team_library_install_asset_lifecycle_unavailable");
      if (release.asset_kind === "loop") {
        const requirement = (await query(`SELECT requirement_id FROM public.loop_version_connection_requirements WHERE workspace_id = $1 AND loop_version_id = $2 LIMIT 1 FOR SHARE`, [sourceWorkspaceId, release.loop_version_id])).rows[0];
        if (requirement) throw coded("team_library_install_connection_lifecycle_unavailable");
      }
      const upstream = release.asset_kind === "skill" ? release.skill_id : release.loop_workflow_id;
      const existing = (await query(`SELECT * FROM public.asset_installations WHERE workspace_id = $1 AND asset_kind = $2 AND upstream_asset_id = $3 AND state <> 'removed' FOR UPDATE`, [workspaceId, release.asset_kind, upstream])).rows[0];
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, installedBy, operationScope, idempotencyKey, requestHash, now]);
      let row;
      if (existing) {
        if (existing.release_id === release.release_id) {
          row = existing;
        } else {
          const updated = await query(`UPDATE public.asset_installations SET state = 'update_available', updated_at = $3::timestamptz, write_version = $4 WHERE workspace_id = $1 AND installation_id = $2 AND write_version = $5 RETURNING *`, [workspaceId, existing.installation_id, now, Number(existing.write_version) + 1, Number(existing.write_version)]);
          if (updated.rowCount !== 1) throw coded("installation_revision_conflict");
          row = updated.rows[0];
        }
      } else {
        const installationId = this.idFactory("installation");
        if (release.asset_kind === "skill") {
          row = (await query(`INSERT INTO public.asset_installations (workspace_id, installation_id, source_workspace_id, release_id, schema_version, asset_kind, skill_id, skill_version_id, state, installed_by, installed_at, updated_at, write_version, payload) VALUES ($1, $2, $3, $4, 'workbench-v1', 'skill', $5, $6, 'installed', $7, $8::timestamptz, $8::timestamptz, 1, '{}'::jsonb) RETURNING *`, [workspaceId, installationId, sourceWorkspaceId, release.release_id, release.skill_id, release.skill_version_id, installedBy, now])).rows[0];
        } else {
          row = (await query(`INSERT INTO public.asset_installations (workspace_id, installation_id, source_workspace_id, release_id, schema_version, asset_kind, loop_workflow_id, loop_version_id, state, installed_by, installed_at, updated_at, write_version, payload) VALUES ($1, $2, $3, $4, 'workbench-v1', 'loop', $5, $6, 'installed', $7, $8::timestamptz, $8::timestamptz, 1, '{}'::jsonb) RETURNING *`, [workspaceId, installationId, sourceWorkspaceId, release.release_id, release.loop_workflow_id, release.loop_version_id, installedBy, now])).rows[0];
        }
      }
      const response = installationView(row);
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, installedBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  async getInstallationUpdateImpact({ installationId, releaseId, workspaceId } = {}) {
    for (const [value, code] of [[installationId, "installation_id_required"], [releaseId, "release_id_required"], [workspaceId, "workspace_id_required"]]) required(value, code);
    return this.store.withTransaction((uow) => this.#loadUpdateContext({ uow, installationId, releaseId, workspaceId, lock: false }));
  }

  async createInstallationUpdateDraft({ installationId, idempotencyKey, request, workspaceId, createdBy } = {}) {
    for (const [value, code] of [[installationId, "installation_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [createdBy, "user_id_required"], [request?.data?.releaseId, "release_id_required"]]) required(value, code);
    const releaseId = request.data.releaseId;
    const requestHash = canonicalRequestHash(request);
    const operationScope = `create-installation-update-draft:${installationId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, createdBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("team_library_install_forbidden");
      const existingReceipt = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, createdBy, operationScope, idempotencyKey])).rows[0];
      if (existingReceipt) {
        if (existingReceipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (!existingReceipt.response) throw coded("idempotency_record_incomplete");
        return structuredClone(existingReceipt.response);
      }
      const context = await this.#loadUpdateContext({ uow, installationId, releaseId, workspaceId, lock: true });
      const now = iso(this.clock());
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, createdBy, operationScope, idempotencyKey, requestHash, now]);
      const updatedInstallation = await query(`UPDATE public.asset_installations SET state = 'update_draft_created', updated_at = $3::timestamptz, write_version = $4 WHERE workspace_id = $1 AND installation_id = $2 AND write_version = $5 RETURNING *`, [workspaceId, installationId, now, Number(context.installation.write_version) + 1, Number(context.installation.write_version)]);
      if (updatedInstallation.rowCount !== 1) throw coded("installation_revision_conflict");
      const draftId = this.idFactory("installation-update-draft");
      const draft = context.installation.asset_kind === "skill"
        ? (await query(`INSERT INTO public.installation_update_drafts (workspace_id, update_draft_id, installation_id, source_workspace_id, created_by, schema_version, asset_kind, skill_id, base_skill_version_id, target_skill_version_id, base_release_id, target_release_id, base_installation_write_version, impact, status, conflict_reason, revision, created_at, updated_at, decided_at, payload) VALUES ($1, $2, $3, $4, $5, 'workbench-v1', 'skill', $6, $7, $8, $9, $10, $11, $12::jsonb, 'pending_review', NULL, 1, $13::timestamptz, $13::timestamptz, NULL, '{}'::jsonb) RETURNING *`, [workspaceId, draftId, installationId, context.installation.source_workspace_id, createdBy, context.installation.skill_id, context.installation.skill_version_id, context.target.skill_version_id, context.current.release_id, context.target.release_id, Number(updatedInstallation.rows[0].write_version), JSON.stringify(context.impact), now])).rows[0]
        : (await query(`INSERT INTO public.installation_update_drafts (workspace_id, update_draft_id, installation_id, source_workspace_id, created_by, schema_version, asset_kind, loop_workflow_id, base_loop_version_id, target_loop_version_id, base_release_id, target_release_id, base_installation_write_version, impact, status, conflict_reason, revision, created_at, updated_at, decided_at, payload) VALUES ($1, $2, $3, $4, $5, 'workbench-v1', 'loop', $6, $7, $8, $9, $10, $11, $12::jsonb, 'pending_review', NULL, 1, $13::timestamptz, $13::timestamptz, NULL, '{}'::jsonb) RETURNING *`, [workspaceId, draftId, installationId, context.installation.source_workspace_id, createdBy, context.installation.loop_workflow_id, context.installation.loop_version_id, context.target.loop_version_id, context.current.release_id, context.target.release_id, Number(updatedInstallation.rows[0].write_version), JSON.stringify(context.impact), now])).rows[0];
      const response = updateDraftView(draft);
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, createdBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }

  async refreshInstallationUpdateDraft({ updateDraftId, idempotencyKey, request, workspaceId, refreshedBy } = {}) {
    for (const [value, code] of [[updateDraftId, "installation_update_draft_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [refreshedBy, "user_id_required"]]) required(value, code);
    const requestHash = canonicalRequestHash(request);
    const operationScope = `refresh-installation-update-draft:${updateDraftId}`;
    const outcome = await this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await this.#requireMember({ query, workspaceId, userId: refreshedBy });
      const receipt = await this.#loadReceipt({ query, workspaceId, userId: refreshedBy, operationScope, idempotencyKey, requestHash });
      if (receipt) return receipt;
      const draft = await this.#loadOwnedDraft({ query, workspaceId, updateDraftId, createdBy: refreshedBy });
      if (["applied", "kept_current"].includes(draft.status)) throw coded("installation_update_draft_not_found");
      const context = await this.#loadUpdateContext({ uow, installationId: draft.installation_id, releaseId: draft.target_release_id, workspaceId, lock: true });
      const now = iso(this.clock());
      await this.#beginReceipt({ query, workspaceId, userId: refreshedBy, operationScope, idempotencyKey, requestHash, now });
      if (!this.#matchesDraftBase({ installation: context.installation, draft })) {
        const conflicted = (await query(`UPDATE public.installation_update_drafts
          SET status = 'conflicted', conflict_reason = 'The installed version changed after this update draft was created.',
              revision = $3, updated_at = $4::timestamptz
          WHERE workspace_id = $1 AND update_draft_id = $2 RETURNING *`, [workspaceId, updateDraftId, Number(draft.revision) + 1, now])).rows[0];
        const response = { outcome: "installation_update_conflict", updateDraft: updateDraftView(conflicted) };
        await this.#completeReceipt({ query, workspaceId, userId: refreshedBy, operationScope, idempotencyKey, requestHash, response, now });
        return response;
      }
      const refreshed = context.installation.asset_kind === "skill"
        ? (await query(`UPDATE public.installation_update_drafts
          SET target_skill_version_id = $3, target_release_id = $4, impact = $5::jsonb,
              status = 'ready', conflict_reason = NULL, revision = $6, updated_at = $7::timestamptz
          WHERE workspace_id = $1 AND update_draft_id = $2
          RETURNING *`, [workspaceId, updateDraftId, context.target.skill_version_id, context.target.release_id,
          JSON.stringify(context.impact), Number(draft.revision) + 1, now])).rows[0]
        : (await query(`UPDATE public.installation_update_drafts
          SET target_loop_version_id = $3, target_release_id = $4, impact = $5::jsonb,
              status = 'ready', conflict_reason = NULL, revision = $6, updated_at = $7::timestamptz
          WHERE workspace_id = $1 AND update_draft_id = $2
          RETURNING *`, [workspaceId, updateDraftId, context.target.loop_version_id, context.target.release_id,
          JSON.stringify(context.impact), Number(draft.revision) + 1, now])).rows[0];
      const response = updateDraftView(refreshed);
      await this.#completeReceipt({ query, workspaceId, userId: refreshedBy, operationScope, idempotencyKey, requestHash, response, now });
      return response;
    });
    if (outcome?.outcome === "installation_update_conflict") throw coded("installation_update_conflict");
    return outcome;
  }

  async confirmInstallationUpdateDraft({ updateDraftId, idempotencyKey, request, workspaceId, confirmedBy } = {}) {
    for (const [value, code] of [[updateDraftId, "installation_update_draft_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [confirmedBy, "user_id_required"]]) required(value, code);
    const requestHash = canonicalRequestHash(request);
    const operationScope = `confirm-installation-update-draft:${updateDraftId}`;
    const outcome = await this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await this.#requireMember({ query, workspaceId, userId: confirmedBy });
      const receipt = await this.#loadReceipt({ query, workspaceId, userId: confirmedBy, operationScope, idempotencyKey, requestHash });
      if (receipt) return receipt;
      const draft = await this.#loadOwnedDraft({ query, workspaceId, updateDraftId, createdBy: confirmedBy });
      if (!["pending_review", "ready"].includes(draft.status)) throw coded("installation_update_draft_state_invalid");
      const installation = (await query(`SELECT * FROM public.asset_installations
        WHERE workspace_id = $1 AND installation_id = $2 FOR UPDATE`, [workspaceId, draft.installation_id])).rows[0];
      if (!installation || installation.state === "removed") throw coded("installation_not_found");
      const now = iso(this.clock());
      await this.#beginReceipt({ query, workspaceId, userId: confirmedBy, operationScope, idempotencyKey, requestHash, now });
      if (!this.#matchesDraftBase({ installation, draft })) {
        const conflicted = (await query(`UPDATE public.installation_update_drafts
          SET status = 'conflicted', conflict_reason = 'The installed version changed after this update draft was created.',
              revision = $3, updated_at = $4::timestamptz
          WHERE workspace_id = $1 AND update_draft_id = $2 RETURNING *`, [workspaceId, updateDraftId, Number(draft.revision) + 1, now])).rows[0];
        const response = { outcome: "installation_update_conflict", updateDraft: updateDraftView(conflicted) };
        await this.#completeReceipt({ query, workspaceId, userId: confirmedBy, operationScope, idempotencyKey, requestHash, response, now });
        return response;
      }
      const context = await this.#loadUpdateContext({ uow, installationId: draft.installation_id, releaseId: draft.target_release_id, workspaceId, lock: true });
      const updated = installation.asset_kind === "skill"
        ? await query(`UPDATE public.asset_installations
          SET release_id = $3, skill_version_id = $4, state = 'installed', updated_at = $5::timestamptz, write_version = $6
          WHERE workspace_id = $1 AND installation_id = $2 AND write_version = $7
          RETURNING *`, [workspaceId, installation.installation_id, context.target.release_id, context.target.skill_version_id,
          now, Number(installation.write_version) + 1, Number(installation.write_version)])
        : await query(`UPDATE public.asset_installations
          SET release_id = $3, loop_version_id = $4, state = 'installed', updated_at = $5::timestamptz, write_version = $6
          WHERE workspace_id = $1 AND installation_id = $2 AND write_version = $7
          RETURNING *`, [workspaceId, installation.installation_id, context.target.release_id, context.target.loop_version_id,
          now, Number(installation.write_version) + 1, Number(installation.write_version)]);
      if (updated.rowCount !== 1) throw coded("installation_revision_conflict");
      const applied = (await query(`UPDATE public.installation_update_drafts
        SET status = 'applied', conflict_reason = NULL, revision = $3, updated_at = $4::timestamptz, decided_at = $4::timestamptz
        WHERE workspace_id = $1 AND update_draft_id = $2 RETURNING *`, [workspaceId, updateDraftId, Number(draft.revision) + 1, now])).rows[0];
      const response = updateDraftView(applied);
      await this.#completeReceipt({ query, workspaceId, userId: confirmedBy, operationScope, idempotencyKey, requestHash, response, now });
      return response;
    });
    if (outcome?.outcome === "installation_update_conflict") throw coded("installation_update_conflict");
    return outcome;
  }

  async keepCurrentInstallationVersion({ updateDraftId, idempotencyKey, request, workspaceId, decidedBy } = {}) {
    for (const [value, code] of [[updateDraftId, "installation_update_draft_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [decidedBy, "user_id_required"]]) required(value, code);
    const requestHash = canonicalRequestHash(request);
    const operationScope = `keep-current-installation-version:${updateDraftId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await this.#requireMember({ query, workspaceId, userId: decidedBy });
      const receipt = await this.#loadReceipt({ query, workspaceId, userId: decidedBy, operationScope, idempotencyKey, requestHash });
      if (receipt) return receipt;
      const draft = await this.#loadOwnedDraft({ query, workspaceId, updateDraftId, createdBy: decidedBy });
      if (["applied", "kept_current"].includes(draft.status)) throw coded("installation_update_draft_state_invalid");
      const installation = (await query(`SELECT * FROM public.asset_installations
        WHERE workspace_id = $1 AND installation_id = $2 FOR UPDATE`, [workspaceId, draft.installation_id])).rows[0];
      if (!installation || installation.state === "removed") throw coded("installation_not_found");
      const now = iso(this.clock());
      await this.#beginReceipt({ query, workspaceId, userId: decidedBy, operationScope, idempotencyKey, requestHash, now });
      const restored = await query(`UPDATE public.asset_installations
        SET state = 'installed', updated_at = $3::timestamptz, write_version = $4
        WHERE workspace_id = $1 AND installation_id = $2 AND write_version = $5
        RETURNING *`, [workspaceId, installation.installation_id, now, Number(installation.write_version) + 1, Number(installation.write_version)]);
      if (restored.rowCount !== 1) throw coded("installation_revision_conflict");
      const kept = (await query(`UPDATE public.installation_update_drafts
        SET status = 'kept_current', conflict_reason = NULL, revision = $3, updated_at = $4::timestamptz, decided_at = $4::timestamptz
        WHERE workspace_id = $1 AND update_draft_id = $2 RETURNING *`, [workspaceId, updateDraftId, Number(draft.revision) + 1, now])).rows[0];
      const response = updateDraftView(kept);
      await this.#completeReceipt({ query, workspaceId, userId: decidedBy, operationScope, idempotencyKey, requestHash, response, now });
      return response;
    });
  }

  async #loadUpdateContext({ uow, installationId, releaseId, workspaceId, lock }) {
    const query = (text, values) => this.sql.query(uow, text, values);
    const suffix = lock ? " FOR UPDATE" : "";
    const installation = (await query(`SELECT * FROM public.asset_installations WHERE workspace_id = $1 AND installation_id = $2${suffix}`, [workspaceId, installationId])).rows[0];
    if (!installation || installation.state === "removed") throw coded("installation_not_found");
    if (!["skill", "loop"].includes(installation.asset_kind)) throw coded("team_library_update_asset_lifecycle_unavailable");
    const sourceWorkspaceId = installation.source_workspace_id ?? workspaceId;
    const current = (await query(`SELECT * FROM public.workspace_asset_releases WHERE source_workspace_id = $1 AND release_id = $2${lock ? " FOR SHARE" : ""}`, [sourceWorkspaceId, installation.release_id])).rows[0];
    const target = (await query(`SELECT * FROM public.workspace_asset_releases WHERE source_workspace_id = $1 AND release_id = $2 AND visibility = 'workspace'${lock ? " FOR SHARE" : ""}`, [sourceWorkspaceId, releaseId])).rows[0];
    if (current?.native_loop_version_id || target?.native_loop_version_id) throw coded("native_loop_managed_execution_unavailable");
    const sameAsset = installation.asset_kind === "skill"
      ? target?.skill_id === installation.skill_id
      : target?.loop_workflow_id === installation.loop_workflow_id;
    if (!current || !target || target.asset_kind !== installation.asset_kind || !sameAsset) throw coded("release_not_available");
    if (installation.asset_kind === "loop") {
      const requirements = await Promise.all([current.loop_version_id, target.loop_version_id].map(async (loopVersionId) => (
        (await query(`SELECT requirement_id FROM public.loop_version_connection_requirements WHERE workspace_id = $1 AND loop_version_id = $2 LIMIT 1${lock ? " FOR SHARE" : ""}`, [sourceWorkspaceId, loopVersionId])).rows[0]
      )));
      if (requirements.some(Boolean)) throw coded("team_library_update_connection_lifecycle_unavailable");
    }
    const fromVersionId = installation.asset_kind === "skill" ? current.skill_version_id : current.loop_version_id;
    const toVersionId = installation.asset_kind === "skill" ? target.skill_version_id : target.loop_version_id;
    const upstreamAssetId = installation.asset_kind === "skill" ? installation.skill_id : installation.loop_workflow_id;
    const impact = {
      schemaVersion: "workbench-v1", installationId, fromReleaseId: current.release_id, toReleaseId: target.release_id,
      fromVersionId, toVersionId,
      dependencyChanges: [], connectionChanges: [],
      breakingFields: [
        ...(current.content_hash !== target.content_hash ? ["contentHash"] : []),
        ...(current.version !== target.version ? ["version"] : []),
      ],
      affectedObjects: [{ objectKind: installation.asset_kind, objectId: upstreamAssetId, label: upstreamAssetId }],
      computedAt: iso(this.clock()),
    };
    return { installation, current, target, impact };
  }

  async #requireMember({ query, workspaceId, userId }) {
    const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, userId])).rows[0];
    if (!membership || memberRank[membership.role] < memberRank.member) throw coded("team_library_install_forbidden");
  }

  async #loadReceipt({ query, workspaceId, userId, operationScope, idempotencyKey, requestHash }) {
    const receipt = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, userId, operationScope, idempotencyKey])).rows[0];
    if (!receipt) return null;
    if (receipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
    if (!receipt.response) throw coded("idempotency_record_incomplete");
    return structuredClone(receipt.response);
  }

  async #beginReceipt({ query, workspaceId, userId, operationScope, idempotencyKey, requestHash, now }) {
    await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, userId, operationScope, idempotencyKey, requestHash, now]);
  }

  async #completeReceipt({ query, workspaceId, userId, operationScope, idempotencyKey, requestHash, response, now }) {
    await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, userId, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
  }

  async #loadOwnedDraft({ query, workspaceId, updateDraftId, createdBy }) {
    const draft = (await query(`SELECT * FROM public.installation_update_drafts
      WHERE workspace_id = $1 AND update_draft_id = $2 AND created_by = $3 FOR UPDATE`, [workspaceId, updateDraftId, createdBy])).rows[0];
    if (!draft) throw coded("installation_update_draft_not_found");
    return draft;
  }

  #matchesDraftBase({ installation, draft }) {
    const sameAsset = installation.asset_kind === "skill"
      ? installation.skill_id === draft.skill_id && installation.skill_version_id === draft.base_skill_version_id
      : installation.loop_workflow_id === draft.loop_workflow_id && installation.loop_version_id === draft.base_loop_version_id;
    const sourceWorkspaceId = installation.source_workspace_id ?? draft.source_workspace_id ?? installation.workspace_id;
    return installation.asset_kind === draft.asset_kind
      && sourceWorkspaceId === (draft.source_workspace_id ?? sourceWorkspaceId)
      && installation.release_id === draft.base_release_id
      && sameAsset
      && Number(installation.write_version) === Number(draft.base_installation_write_version);
  }
}

function installationView(row) {
  return {
    ...(row.payload ?? {}), schemaVersion: row.schema_version, installationId: row.installation_id,
    workspaceId: row.workspace_id, sourceWorkspaceId: row.source_workspace_id, releaseId: row.release_id,
    assetKind: row.asset_kind, upstreamAssetId: row.upstream_asset_id, pinnedVersionId: row.pinned_version_id,
    state: row.state, installedBy: row.installed_by, installedAt: iso(row.installed_at), updatedAt: iso(row.updated_at), writeVersion: Number(row.write_version),
  };
}
function updateDraftView(row) {
  const basePinnedVersionId = row.base_pinned_version_id
    ?? (row.asset_kind === "skill" ? row.base_skill_version_id : row.base_loop_version_id);
  const targetVersionId = row.target_version_id
    ?? (row.asset_kind === "skill" ? row.target_skill_version_id : row.target_loop_version_id);
  return {
    ...(row.payload ?? {}), schemaVersion: row.schema_version, updateDraftId: row.update_draft_id,
    workspaceId: row.workspace_id, sourceWorkspaceId: row.source_workspace_id, installationId: row.installation_id, createdBy: row.created_by,
    baseReleaseId: row.base_release_id, basePinnedVersionId, targetReleaseId: row.target_release_id, targetVersionId,
    connectionBindings: [], impact: structuredClone(row.impact),
    status: row.status, conflictReason: row.conflict_reason ?? null, revision: Number(row.revision),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), decidedAt: row.decided_at == null ? null : iso(row.decided_at),
  };
}
function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_team_library_clock_invalid"); return date.toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
