/** PostgreSQL read owner for the current workspace's published Team Library. */
export class PostgresTeamLibraryReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_team_library_read_model_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async list({ workspaceId, query = {} } = {}) {
    required(workspaceId, "workspace_id_required");
    return this.releasePage(workspaceId, query);
  }

  async listSystemCatalog({ query = {} } = {}) { return this.releasePage('system-catalog', query); }

  async releasePage(workspaceId, query) {
    const limit = boundedLimit(query.limit);
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#sql.query(uow, `SELECT release.*, skill.definition AS published_skill_definition,
          loop.definition AS published_loop_definition, native.recipe AS published_native_recipe FROM public.workspace_asset_releases release
        LEFT JOIN public.skill_versions skill ON skill.workspace_id = release.source_workspace_id
          AND skill.skill_version_id = release.skill_version_id AND skill.content_hash = release.content_hash
        LEFT JOIN public.loop_versions loop ON loop.workspace_id = release.source_workspace_id
          AND loop.loop_version_id = release.loop_version_id AND loop.content_hash = release.content_hash
        LEFT JOIN public.native_loop_versions native ON native.workspace_id = release.source_workspace_id
          AND native.version_id = release.native_loop_version_id AND native.content_hash = release.content_hash
        WHERE release.source_workspace_id = $1 AND release.visibility = 'workspace'
          AND ($2::text IS NULL OR release.asset_kind = $2)
          AND ($3::text IS NULL OR release.domain = $3)
          AND ($5::text IS NULL OR (release.published_at,release.release_id) <
            (SELECT cursor.published_at,cursor.release_id FROM public.workspace_asset_releases cursor
             WHERE cursor.source_workspace_id=$1 AND cursor.release_id=$5 AND cursor.visibility='workspace'))
        ORDER BY release.published_at DESC, release.release_id DESC LIMIT $4`, [
        workspaceId, query.assetKind ?? null, query.domain ?? null, limit + 1, query.cursor ?? null,
      ])).rows;
      const items = rows.slice(0, limit).map(releaseView);
      Object.defineProperty(items, 'page', { value: { hasMore: rows.length > limit, nextCursor: rows.length > limit ? items.at(-1).releaseId : null } });
      return items;
    });
  }

  async getInstallation({ workspaceId, installationId } = {}) {
    required(workspaceId, "workspace_id_required"); required(installationId, "installation_id_required");
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#sql.query(uow, `SELECT * FROM public.asset_installations
        WHERE workspace_id = $1 AND installation_id = $2`, [workspaceId, installationId])).rows[0];
      return row ? installationView(row) : null;
    });
  }

  async listInstallations({ workspaceId, query = {} } = {}) {
    required(workspaceId, "workspace_id_required");
    const limit = boundedLimit(query.limit);
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#sql.query(uow, `SELECT * FROM public.asset_installations
        WHERE workspace_id = $1
          AND ($2::text IS NULL OR asset_kind = $2)
          AND ($3::text IS NULL OR state = $3)
        ORDER BY updated_at DESC, installation_id DESC LIMIT $4`, [
        workspaceId, query.assetKind ?? null, query.state ?? null, limit,
      ])).rows;
      return rows.map(installationView);
    });
  }

  async getUpdateDraft({ workspaceId, updateDraftId, createdBy } = {}) {
    required(workspaceId, "workspace_id_required"); required(updateDraftId, "installation_update_draft_id_required"); required(createdBy, "user_id_required");
    return this.#store.withTransaction(async (uow) => {
      const draft = (await this.#sql.query(uow, `SELECT * FROM public.installation_update_drafts
        WHERE workspace_id = $1 AND update_draft_id = $2 AND created_by = $3`, [workspaceId, updateDraftId, createdBy])).rows[0];
      if (!draft) return null;
      const bindings = (await this.#sql.query(uow, `SELECT requirement_id, connection_id
        FROM public.installation_update_draft_connection_bindings
        WHERE workspace_id = $1 AND update_draft_id = $2
        ORDER BY requirement_id`, [workspaceId, updateDraftId])).rows;
      return updateDraftView(draft, bindings);
    });
  }
}

function releaseView(row) {
  return Object.freeze({
    ...(row.payload ?? {}),
    schemaVersion: row.schema_version,
    releaseId: row.release_id,
    sourceWorkspaceId: row.source_workspace_id,
    assetKind: row.asset_kind,
    assetId: row.asset_id,
    versionId: row.version_id,
    version: row.version,
    contentHash: row.content_hash,
    visibility: row.visibility,
    domain: row.domain,
    startingPoint: row.starting_point === true,
    releaseNotes: row.release_notes,
    dependencies: structuredClone(row.dependencies ?? []),
    publishedBy: row.published_by ?? row.published_by_system_principal_id,
    publishedAt: iso(row.published_at),
    ...(row.published_loop_definition ? { loopSummary: { goal: row.published_loop_definition.goal || "", expectedResult: row.published_loop_definition.expectedResult || "" } } : {}),
    ...(row.published_native_recipe ? { executionMode: "native_agent", executionSemantics: "agent_guided_recipe", cloudReady: false,
      loopSummary: { name: row.published_native_recipe.name, description: row.published_native_recipe.description,
        goal: row.published_native_recipe.definition.goal, expectedResult: row.published_native_recipe.definition.expectedResult } } : {}),
    ...(row.published_skill_definition ? { skillSummary: {
      name: row.published_skill_definition.name || "",
      description: row.published_skill_definition.description || "",
      inputs: Object.keys(row.published_skill_definition.inputSchema?.properties || {}),
      outputs: Object.keys(row.published_skill_definition.outputSchema?.properties || {}),
      ...(row.published_skill_definition.inputSchema ? { inputSchema: structuredClone(row.published_skill_definition.inputSchema) } : {}),
      ...(row.published_skill_definition.outputSchema ? { outputSchema: structuredClone(row.published_skill_definition.outputSchema) } : {}),
      dependencies: (row.published_skill_definition.dependencies || []).map((value) => value.name || value.skillId || value.kind || "Dependency"),
      risk: row.published_skill_definition.risk?.summary || row.published_skill_definition.risk?.level || "",
    } } : {}),
  });
}

function installationView(row) {
  return Object.freeze({
    ...(row.payload ?? {}),
    schemaVersion: row.schema_version,
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    sourceWorkspaceId: row.source_workspace_id,
    releaseId: row.release_id,
    assetKind: row.asset_kind,
    upstreamAssetId: row.upstream_asset_id,
    pinnedVersionId: row.pinned_version_id,
    state: row.state,
    installedBy: row.installed_by,
    installedAt: iso(row.installed_at),
    updatedAt: iso(row.updated_at),
    writeVersion: Number(row.write_version),
  });
}

function updateDraftView(row, bindings) {
  const basePinnedVersionId = row.base_pinned_version_id
    ?? (row.asset_kind === "skill" ? row.base_skill_version_id : row.base_loop_version_id);
  const targetVersionId = row.target_version_id
    ?? (row.asset_kind === "skill" ? row.target_skill_version_id : row.target_loop_version_id);
  return Object.freeze({
    ...(row.payload ?? {}), schemaVersion: row.schema_version, updateDraftId: row.update_draft_id,
    workspaceId: row.workspace_id, sourceWorkspaceId: row.source_workspace_id, installationId: row.installation_id, createdBy: row.created_by,
    baseReleaseId: row.base_release_id, basePinnedVersionId, targetReleaseId: row.target_release_id, targetVersionId,
    impact: structuredClone(row.impact),
    connectionBindings: bindings.map((binding) => ({ requirementId: binding.requirement_id, connectionId: binding.connection_id })),
    status: row.status, conflictReason: row.conflict_reason ?? null, revision: Number(row.revision),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), decidedAt: row.decided_at == null ? null : iso(row.decided_at),
  });
}

function required(value, code) { if (typeof value !== "string" || !value) throw new TypeError(code); }
function boundedLimit(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100; }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
