import { ProductStoreError } from "../store/errors.mjs";

const CAPABILITIES = new Set([
  "chat", "tool_calling", "structured_output", "image_input", "image_generation",
  "realtime_audio_input", "realtime_audio_output", "realtime_turn_detection", "realtime_barge_in",
]);
const READINESS = new Set(["ready", "degraded", "unavailable", "disabled"]);

/**
 * PostgreSQL read owner for governed Model Profiles.  Revisions already have
 * a database-enforced SecretBinding relation, so this class never accepts a
 * browser/provider credential payload or falls back to the old Mongo catalog.
 * Model/Secret binding writes are intentionally owned by the Phase 1
 * authority workflow rather than recreated as an environment importer here.
 */
export class PostgresModelCatalog {
  #store;
  #sql;
  #readinessResolver;

  constructor({ store, readinessResolver = async () => ({ state: "unavailable", reason: "readiness_not_evaluated" }) } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_model_catalog_store_required");
    }
    if (typeof readinessResolver !== "function") throw new TypeError("postgres_model_catalog_readiness_resolver_required");
    this.#store = store;
    this.#readinessResolver = readinessResolver;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async listProfiles({ workspaceId, userId = null, capabilities = [], includeDisabled = true } = {}) {
    const required = normalizedCapabilities(capabilities);
    return this.#transact(async (sql) => {
      const scopeId = userId ? await this.#personalScope(sql, workspaceId, userId) : null;
      const policy = scopeId ? await this.#policy(sql, workspaceId, scopeId) : null;
      const rows = (await sql(`
        SELECT profile.*, revision.*
          FROM public.model_profiles profile
          JOIN public.model_profile_revisions revision
            ON revision.workspace_id = profile.workspace_id
           AND revision.profile_id = profile.profile_id
           AND revision.revision_id = profile.current_revision_id
         WHERE (profile.workspace_id = $1 OR profile.profile_scope = 'global')
           AND ($2::boolean OR profile.enabled = true)
           AND ($3::text IS NULL OR profile.profile_scope = 'global' OR profile.scope_id = $4)
         ORDER BY profile.display_name ASC, profile.profile_id ASC
      `, [workspaceId ?? null, includeDisabled === true, userId, scopeId])).rows;
      const values = [];
      for (const row of rows) {
        const profile = profileView(row);
        const revision = revisionView(row);
        if (!hasCapabilities(revision, required)) continue;
        const readiness = await this.deriveReadiness({ profile, revision, workspaceId });
        values.push(catalogEntry(profile, revision, readiness, policy));
      }
      return values;
    });
  }

  async resolveCurrentProfile({ profileId, workspaceId, userId = null, capabilities = [], requireReady = true } = {}) {
    const profile = await this.#profile(profileId, workspaceId);
    if (!profile) throw new ProductStoreError("model_profile_not_found", "The model profile is not available in this workspace.");
    return this.resolveRevision({ revisionId: profile.currentRevisionId, workspaceId, userId, capabilities, requireReady });
  }

  async resolveRevision({ revisionId, workspaceId, userId = null, capabilities = [], requireReady = true } = {}) {
    const required = normalizedCapabilities(capabilities);
    const pair = await this.#transact(async (sql) => {
      const scopeId = userId ? await this.#personalScope(sql, workspaceId, userId) : null;
      const row = (await sql(`
        SELECT profile.*, revision.*
          FROM public.model_profile_revisions revision
          JOIN public.model_profiles profile
            ON profile.workspace_id = revision.workspace_id AND profile.profile_id = revision.profile_id
         WHERE revision.revision_id = $1
           AND (profile.workspace_id = $2 OR profile.profile_scope = 'global')
           AND ($3::text IS NULL OR profile.profile_scope = 'global' OR profile.scope_id = $4)
      `, [revisionId, workspaceId, userId, scopeId])).rows[0];
      return row ? { profile: profileView(row), revision: revisionView(row) } : null;
    });
    if (!pair) throw new ProductStoreError("model_profile_not_found", "The model profile revision was not found.");
    if (!hasCapabilities(pair.revision, required)) {
      throw new ProductStoreError("model_capability_mismatch", "The model profile does not support the required capability.", { requiredCapabilities: required });
    }
    const readiness = await this.deriveReadiness({ ...pair, workspaceId });
    if (requireReady && !["ready", "degraded"].includes(readiness.state)) {
      throw new ProductStoreError("model_revision_unavailable", "The model profile revision is unavailable.", {
        readiness: readiness.state,
        ...(readiness.reason ? { readinessReason: readiness.reason } : {}),
      });
    }
    return Object.freeze({ profile: structuredClone(pair.profile), revision: structuredClone(pair.revision), readiness });
  }

  async deriveReadiness({ profile, revision, workspaceId } = {}) {
    if (profile?.enabled !== true) return Object.freeze({ state: "disabled" });
    try {
      const resolved = await this.#readinessResolver({ profile: structuredClone(profile), revision: structuredClone(revision), workspaceId });
      const readiness = typeof resolved === "string" ? { state: resolved } : resolved;
      if (!readiness || !READINESS.has(readiness.state)) return Object.freeze({ state: "unavailable", reason: "readiness_result_invalid" });
      return Object.freeze(structuredClone(readiness));
    } catch {
      return Object.freeze({ state: "unavailable", reason: "readiness_check_failed" });
    }
  }

  async getWorkspacePolicy(workspaceId, { scopeId = null, userId = null } = {}) {
    required(workspaceId, "model_routing_workspace_required");
    return this.#transact(async (sql) => {
      const selectedScopeId = scopeId ?? (userId ? await this.#personalScope(sql, workspaceId, userId) : null);
      return selectedScopeId ? this.#policy(sql, workspaceId, selectedScopeId) : null;
    });
  }

  // This protects the M1 one-store composition from accidentally rebuilding
  // a Mongo-era credential import path. PostgresModelConfiguration owns the
  // governed SecretBinding + model-policy command.
  async importProfileRevision() { throw unavailable("postgres_model_catalog_write_unavailable"); }
  async importWorkspacePolicy() { throw unavailable("postgres_model_catalog_write_unavailable"); }

  async #profile(profileId, workspaceId) {
    required(profileId, "model_profile_id_required");
    return this.#transact(async (sql) => {
      const row = (await sql(`SELECT * FROM public.model_profiles
        WHERE profile_id = $1 AND (workspace_id = $2 OR profile_scope = 'global')`, [profileId, workspaceId])).rows[0];
      return row ? profileView(row) : null;
    });
  }

  async #personalScope(sql, workspaceId, userId) {
    return (await sql(`SELECT scope.scope_id FROM public.product_scopes scope
      JOIN public.workspace_memberships membership ON membership.workspace_id = scope.workspace_id
        AND membership.user_id = $2 AND membership.status = 'active'
      WHERE scope.workspace_id = $1 AND scope.owner_user_id = $2
        AND scope.scope_kind = 'personal' AND scope.status = 'active'`, [workspaceId, userId])).rows[0]?.scope_id ?? null;
  }

  async #policy(sql, workspaceId, scopeId) {
    const row = (await sql(`
      SELECT * FROM public.workspace_model_policy_revisions
       WHERE workspace_id = $1 AND scope_id = $2
       ORDER BY revision DESC, created_at DESC, policy_revision_id DESC LIMIT 1
    `, [workspaceId, scopeId])).rows[0];
    if (!row) return null;
    const revisionIds = Object.values(row.capability_model_revision_ids ?? {});
    const profiles = revisionIds.length === 0 ? [] : (await sql(`
      SELECT revision_id, profile_id FROM public.model_profile_revisions WHERE revision_id = ANY($1::text[])
    `, [revisionIds])).rows;
    const profileByRevision = new Map(profiles.map((value) => [value.revision_id, value.profile_id]));
    const defaults = Object.fromEntries(Object.entries(row.capability_model_revision_ids ?? {})
      .filter(([capability, revisionId]) => CAPABILITIES.has(capability) && profileByRevision.has(revisionId))
      .map(([capability, revisionId]) => [capability, profileByRevision.get(revisionId)]));
    return Object.freeze({
      schemaVersion: "workbench-model-policy-v1", workspaceId: row.workspace_id, scopeId: row.scope_id,
      policyRevisionId: row.policy_revision_id, revision: Number(row.revision),
      defaultProfileIdsByCapability: defaults, workflowFallbackAllowed: row.workflow_fallback_allowed === true,
      policyVersion: row.policy_version, createdAt: iso(row.created_at),
    });
  }

  #transact(work) { return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values))); }
}

function profileView(row) {
  return {
    ...(row.payload ?? {}), schemaVersion: "workbench-model-catalog-v1", profileId: row.profile_id,
    workspaceId: row.workspace_id, scopeId: row.scope_id, scope: row.profile_scope, displayName: row.display_name,
    enabled: row.enabled === true, currentRevisionId: row.current_revision_id,
    currentRevisionNumber: Number(row.current_revision_number), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function revisionView(row) {
  return {
    ...(row.payload ?? {}), schemaVersion: "workbench-model-catalog-v1", revisionId: row.revision_id,
    workspaceId: row.workspace_id, profileId: row.profile_id, revisionNumber: Number(row.revision_number),
    provider: row.provider, protocol: row.protocol, providerModelId: row.provider_model_ref,
    capabilities: [...(row.capabilities ?? [])], parameterSupport: structuredClone(row.parameter_support ?? {}),
    limits: structuredClone(row.limits ?? {}), dataPolicy: structuredClone(row.data_policy ?? {}),
    costPolicy: structuredClone(row.cost_policy ?? {}), parameterSchemaVersion: row.parameter_schema_version,
    policyVersion: row.policy_version, configHash: row.config_hash, deploymentKey: row.deployment_key,
    secretBindingId: row.secret_binding_id, createdAt: iso(row.created_at),
  };
}

function catalogEntry(profile, revision, readiness, policy) {
  const defaultForCapabilities = [...CAPABILITIES].filter((capability) => policy?.defaultProfileIdsByCapability?.[capability] === profile.profileId);
  return Object.freeze({
    schemaVersion: "workbench-v1", profileId: profile.profileId, displayName: profile.displayName,
    currentRevisionId: revision.revisionId, scope: profile.scope,
    ...(profile.scope === "workspace" ? { workspaceId: profile.workspaceId } : {}), enabled: profile.enabled,
    currentRevision: { schemaVersion: "workbench-v1", revisionId: revision.revisionId, profileId: revision.profileId,
      revisionNumber: revision.revisionNumber, modelDisplayName: profile.displayName,
      providerDisplay: { key: revision.provider, label: revision.provider }, capabilities: structuredClone(revision.capabilities),
      parameterSupport: structuredClone(revision.parameterSupport), limits: structuredClone(revision.limits), createdAt: revision.createdAt },
    readiness: readiness.state, readinessReason: readiness.reason ?? null,
    selectable: profile.enabled && ["ready", "degraded"].includes(readiness.state), defaultForCapabilities,
    createdAt: profile.createdAt, updatedAt: profile.updatedAt,
  });
}

function normalizedCapabilities(value) {
  if (!Array.isArray(value) || value.some((capability) => !CAPABILITIES.has(capability))) throw new TypeError("model_capabilities_invalid");
  return [...new Set(value)].sort();
}
function hasCapabilities(revision, requiredCapabilities) { const available = new Set(revision.capabilities ?? []); return requiredCapabilities.every((capability) => available.has(capability)); }
function required(value, code) { if (typeof value !== "string" || !value) throw new TypeError(code); return value; }
function unavailable(code) { return new ProductStoreError(code, "This PostgreSQL model catalog operation is not available until governed SecretBinding commands are enabled."); }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
