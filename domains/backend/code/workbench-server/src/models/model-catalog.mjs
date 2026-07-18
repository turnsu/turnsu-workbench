import { randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash, cloneValue } from "../store/serialization.mjs";

export const MODEL_CAPABILITIES = Object.freeze([
  "chat",
  "tool_calling",
  "structured_output",
  "image_generation",
]);

export const MODEL_PROTOCOLS = Object.freeze([
  "openai_compatible_chat",
  "anthropic_messages",
  "gemini_generate_content",
  "stability_image_v2",
]);

const CAPABILITIES = new Set(MODEL_CAPABILITIES);
const READINESS_STATES = new Set(["ready", "degraded", "unavailable", "disabled"]);
const duplicateKey = (error) => error?.code === 11000 || error?.codeName === "DuplicateKey";
const retryableMongoError = (error) =>
  duplicateKey(error)
  || error instanceof CatalogWriteConflict
  || error?.hasErrorLabel?.("TransientTransactionError") === true
  || error?.hasErrorLabel?.("UnknownTransactionCommitResult") === true;

class CatalogWriteConflict extends Error {
  constructor() {
    super("model_catalog_write_conflict");
    this.code = "model_catalog_write_conflict";
  }
}

export class ModelCatalog {
  #store;
  #repositories;
  #withTransaction;
  #clock;
  #idFactory;
  #readinessResolver;
  #maxWriteAttempts;

  constructor({
    store = null,
    repositories = null,
    withTransaction = null,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    readinessResolver = async () => ({ state: "unavailable", reason: "readiness_not_evaluated" }),
    maxWriteAttempts = 8,
  } = {}) {
    if (!store && !repositories) throw new TypeError("model_catalog_repositories_required");
    if (withTransaction !== null && typeof withTransaction !== "function") {
      throw new TypeError("model_catalog_transaction_runner_invalid");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("model_catalog_dependency_invalid");
    }
    if (typeof readinessResolver !== "function") {
      throw new TypeError("model_catalog_readiness_resolver_invalid");
    }
    if (!Number.isInteger(maxWriteAttempts) || maxWriteAttempts < 1 || maxWriteAttempts > 32) {
      throw new TypeError("model_catalog_write_attempts_invalid");
    }
    this.#store = store;
    this.#repositories = repositories;
    this.#withTransaction = withTransaction
      ?? (store?.withTransaction ? (callback) => store.withTransaction(callback) : null);
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#readinessResolver = readinessResolver;
    this.#maxWriteAttempts = maxWriteAttempts;
  }

  async listProfiles({ workspaceId, capabilities = [], includeDisabled = true } = {}) {
    const requiredCapabilities = normalizeCapabilities(capabilities);
    const repositories = await this.#getRepositories();
    const [profiles, policy] = await Promise.all([
      repositories.modelProfiles.listAuthorized({
        workspaceId,
        ...(includeDisabled ? {} : { enabled: true }),
      }),
      workspaceId ? repositories.modelRoutingPolicies.get(workspaceId) : null,
    ]);
    const results = await Promise.all(profiles.map(async (profile) => {
      if (!profile.currentRevisionId) return null;
      const revision = await repositories.modelProfileRevisions.get(profile.currentRevisionId);
      if (!revision || revision.profileId !== profile.profileId) return null;
      if (!hasCapabilities(revision, requiredCapabilities)) return null;
      const readiness = await this.deriveReadiness({ profile, revision, workspaceId });
      return publicCatalogEntry(profile, revision, readiness, policy);
    }));
    return results.filter(Boolean).sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.profileId.localeCompare(right.profileId));
  }

  async resolveCurrentProfile({
    profileId,
    workspaceId,
    capabilities = [],
    requireReady = true,
  } = {}) {
    const repositories = await this.#getRepositories();
    const profile = await repositories.modelProfiles.get(profileId, { workspaceId });
    if (!profile) {
      throw new ProductStoreError("model_profile_not_found", "The model profile is not available in this workspace.");
    }
    if (!profile.currentRevisionId) {
      throw new ProductStoreError("model_revision_unavailable", "The model profile has no current revision.");
    }
    return this.resolveRevision({
      revisionId: profile.currentRevisionId,
      workspaceId,
      capabilities,
      requireReady,
    });
  }

  async resolveRevision({
    revisionId,
    workspaceId,
    capabilities = [],
    requireReady = true,
  } = {}) {
    const requiredCapabilities = normalizeCapabilities(capabilities);
    const repositories = await this.#getRepositories();
    const revision = await repositories.modelProfileRevisions.get(revisionId);
    if (!revision) {
      throw new ProductStoreError("model_profile_not_found", "The model profile revision was not found.");
    }
    const profile = await repositories.modelProfiles.get(revision.profileId, { workspaceId });
    if (!profile) {
      throw new ProductStoreError("model_profile_forbidden", "The model profile is not available in this workspace.");
    }
    if (!hasCapabilities(revision, requiredCapabilities)) {
      throw new ProductStoreError("model_capability_mismatch", "The model profile does not support the required capability.", {
        requiredCapabilities,
      });
    }
    const readiness = await this.deriveReadiness({ profile, revision, workspaceId });
    if (requireReady && readiness.state !== "ready" && readiness.state !== "degraded") {
      throw new ProductStoreError("model_revision_unavailable", "The model profile revision is unavailable.", {
        readiness: readiness.state,
      });
    }
    return Object.freeze({
      profile: cloneValue(profile),
      revision: cloneValue(revision),
      readiness,
    });
  }

  async deriveReadiness({ profile, revision, workspaceId } = {}) {
    if (profile?.enabled !== true) return Object.freeze({ state: "disabled" });
    try {
      const resolved = await this.#readinessResolver({
        profile: cloneValue(profile),
        revision: cloneValue(revision),
        workspaceId,
      });
      const readiness = typeof resolved === "string" ? { state: resolved } : resolved;
      if (!readiness || !READINESS_STATES.has(readiness.state)) {
        return Object.freeze({ state: "unavailable", reason: "readiness_result_invalid" });
      }
      return Object.freeze(cloneValue(readiness));
    } catch {
      return Object.freeze({ state: "unavailable", reason: "readiness_check_failed" });
    }
  }

  async getWorkspacePolicy(workspaceId) {
    requiredString(workspaceId, "model_routing_workspace_required");
    const repositories = await this.#getRepositories();
    return repositories.modelRoutingPolicies.get(workspaceId);
  }

  async importProfileRevision({ profile, revision } = {}) {
    const normalizedProfile = validateProfile(profile);
    const revisionConfiguration = validateRevisionConfiguration(revision);
    const configHash = canonicalRequestHash(revisionConfiguration);
    const repositories = await this.#getRepositories();

    return this.#retryWrite(async () => this.#transact(async (session) => {
      const options = session ? { session } : {};
      const now = this.#timestamp();
      let storedProfile = await repositories.modelProfiles.ensure({
        schemaVersion: "workbench-v1",
        ...normalizedProfile,
        currentRevisionId: null,
        createdAt: now,
        updatedAt: now,
      }, options);
      assertSameProfileScope(storedProfile, normalizedProfile);

      if (storedProfile.displayName !== normalizedProfile.displayName
        || storedProfile.enabled !== normalizedProfile.enabled) {
        storedProfile = await repositories.modelProfiles.updateMetadata(
          normalizedProfile.profileId,
          { ...normalizedProfile, updatedAt: now },
          options,
        );
        if (!storedProfile) throw new CatalogWriteConflict();
      }

      let storedRevision = await repositories.modelProfileRevisions.findByConfigHash(
        normalizedProfile.profileId,
        configHash,
        options,
      );
      const reused = Boolean(storedRevision);
      if (!storedRevision) {
        const latest = await repositories.modelProfileRevisions.latestByProfile(
          normalizedProfile.profileId,
          options,
        );
        storedRevision = await repositories.modelProfileRevisions.insert({
          schemaVersion: "workbench-v1",
          revisionId: this.#idFactory("model-revision"),
          profileId: normalizedProfile.profileId,
          revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          ...revisionConfiguration,
          configHash,
          createdAt: now,
        }, options);
      }

      if (storedProfile.currentRevisionId !== storedRevision.revisionId) {
        const advanced = await repositories.modelProfiles.advanceCurrentRevision(
          normalizedProfile.profileId,
          {
            expectedCurrentRevisionId: storedProfile.currentRevisionId,
            currentRevisionId: storedRevision.revisionId,
            updatedAt: now,
          },
          options,
        );
        if (!advanced) throw new CatalogWriteConflict();
        storedProfile = advanced;
      }

      return Object.freeze({
        profile: cloneValue(storedProfile),
        revision: cloneValue(storedRevision),
        reused,
      });
    }));
  }

  async importWorkspacePolicy({
    workspaceId,
    defaultProfileIdsByCapability,
    workflowFallbackAllowed = false,
  } = {}) {
    requiredString(workspaceId, "model_routing_workspace_required");
    if (typeof workflowFallbackAllowed !== "boolean") {
      throw new TypeError("model_routing_fallback_policy_invalid");
    }
    const defaults = normalizeRoutingDefaults(defaultProfileIdsByCapability);
    for (const [capability, profileId] of Object.entries(defaults)) {
      await this.resolveCurrentProfile({
        profileId,
        workspaceId,
        capabilities: [capability],
        requireReady: false,
      });
    }
    const repositories = await this.#getRepositories();

    return this.#retryWrite(async () => this.#transact(async (session) => {
      const options = session ? { session } : {};
      const now = this.#timestamp();
      const current = await repositories.modelRoutingPolicies.get(workspaceId, options);
      if (!current) {
        const policy = await repositories.modelRoutingPolicies.insert({
          schemaVersion: "workbench-v1",
          workspaceId,
          defaultProfileIdsByCapability: defaults,
          workflowFallbackAllowed,
          policyVersion: "1",
          updatedAt: now,
        }, options);
        return Object.freeze({ policy: cloneValue(policy), reused: false });
      }
      if (canonicalRequestHash(current.defaultProfileIdsByCapability) === canonicalRequestHash(defaults)
        && current.workflowFallbackAllowed === workflowFallbackAllowed) {
        return Object.freeze({ policy: cloneValue(current), reused: true });
      }
      const policy = await repositories.modelRoutingPolicies.updateVersioned(
        workspaceId,
        {
          expectedPolicyVersion: current.policyVersion,
          nextPolicyVersion: incrementVersion(current.policyVersion),
          defaultProfileIdsByCapability: defaults,
          workflowFallbackAllowed,
          updatedAt: now,
        },
        options,
      );
      if (!policy) throw new CatalogWriteConflict();
      return Object.freeze({ policy: cloneValue(policy), reused: false });
    }));
  }

  async #getRepositories() {
    if (this.#store) {
      await this.#store.connect();
      this.#repositories = this.#store.repositories;
    }
    const repositories = this.#repositories;
    for (const name of ["modelProfiles", "modelProfileRevisions", "modelRoutingPolicies"]) {
      if (!repositories?.[name]) throw new TypeError(`model_catalog_repository_required:${name}`);
    }
    return repositories;
  }

  #transact(callback) {
    if (!this.#withTransaction) throw new TypeError("model_catalog_transaction_required");
    return this.#withTransaction(callback);
  }

  async #retryWrite(operation) {
    let lastError;
    for (let attempt = 1; attempt <= this.#maxWriteAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!retryableMongoError(error) || attempt === this.#maxWriteAttempts) break;
      }
    }
    if (lastError instanceof CatalogWriteConflict || retryableMongoError(lastError)) {
      throw new ProductStoreError(
        "model_catalog_write_conflict",
        "The model catalog changed concurrently; retry the import.",
      );
    }
    throw lastError;
  }

  #timestamp() {
    const value = this.#clock();
    return value instanceof Date ? value.toISOString() : String(value);
  }
}

function validateProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("model_profile_invalid");
  }
  requiredString(value.profileId, "model_profile_id_required");
  requiredString(value.displayName, "model_profile_display_name_required");
  if (!['global', 'workspace'].includes(value.scope) || typeof value.enabled !== "boolean") {
    throw new TypeError("model_profile_invalid");
  }
  if (value.scope === "workspace") requiredString(value.workspaceId, "model_profile_workspace_required");
  if (value.scope === "global" && value.workspaceId !== undefined && value.workspaceId !== null) {
    throw new TypeError("global_model_profile_workspace_forbidden");
  }
  return {
    profileId: value.profileId,
    displayName: value.displayName,
    scope: value.scope,
    ...(value.scope === "workspace" ? { workspaceId: value.workspaceId } : {}),
    enabled: value.enabled,
  };
}

function validateRevisionConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("model_profile_revision_invalid");
  }
  for (const field of ["provider", "protocol", "providerModelId", "parameterSchemaVersion", "credentialRef", "policyVersion"]) {
    requiredString(value[field], `model_profile_revision_${field}_required`);
  }
  if (!MODEL_PROTOCOLS.includes(value.protocol)) throw new TypeError("model_protocol_invalid");
  const capabilities = normalizeCapabilities(value.capabilities, { requireOne: true });
  for (const field of ["defaults", "parameterSupport", "limits"]) {
    if (!isPlainObject(value[field])) throw new TypeError(`model_profile_revision_${field}_invalid`);
  }
  return cloneValue({
    provider: value.provider,
    protocol: value.protocol,
    providerModelId: value.providerModelId,
    capabilities,
    parameterSchemaVersion: value.parameterSchemaVersion,
    defaults: value.defaults,
    parameterSupport: value.parameterSupport,
    limits: value.limits,
    credentialRef: value.credentialRef,
    ...(value.endpoint ? { endpoint: value.endpoint } : {}),
    policyVersion: value.policyVersion,
  });
}

function normalizeCapabilities(value, { requireOne = false } = {}) {
  if (!Array.isArray(value) || (requireOne && value.length === 0)) {
    throw new TypeError("model_capabilities_invalid");
  }
  if (new Set(value).size !== value.length || value.some((capability) => !CAPABILITIES.has(capability))) {
    throw new TypeError("model_capabilities_invalid");
  }
  return [...value].sort();
}

function normalizeRoutingDefaults(value) {
  if (!isPlainObject(value)) throw new TypeError("model_routing_defaults_invalid");
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([capability, profileId]) => !CAPABILITIES.has(capability)
    || typeof profileId !== "string" || profileId.length === 0)) {
    throw new TypeError("model_routing_defaults_invalid");
  }
  return Object.fromEntries(entries);
}

function assertSameProfileScope(stored, expected) {
  const sameWorkspace = stored.scope === "global" || stored.workspaceId === expected.workspaceId;
  if (stored.scope !== expected.scope || !sameWorkspace) {
    throw new ProductStoreError(
      "model_profile_scope_conflict",
      "A model profile identity cannot move between authorization scopes.",
      { profileId: expected.profileId },
    );
  }
}

function hasCapabilities(revision, required) {
  const available = new Set(revision.capabilities ?? []);
  return required.every((capability) => available.has(capability));
}

function publicCatalogEntry(profile, revision, readiness, policy) {
  const defaultForCapabilities = MODEL_CAPABILITIES.filter((capability) =>
    policy?.defaultProfileIdsByCapability?.[capability] === profile.profileId);
  return Object.freeze({
    schemaVersion: "workbench-v1",
    profileId: profile.profileId,
    displayName: profile.displayName,
    currentRevisionId: revision.revisionId,
    scope: profile.scope,
    ...(profile.scope === "workspace" ? { workspaceId: profile.workspaceId } : {}),
    enabled: profile.enabled,
    currentRevision: {
      schemaVersion: "workbench-v1",
      revisionId: revision.revisionId,
      profileId: profile.profileId,
      revisionNumber: revision.revisionNumber,
      modelDisplayName: profile.displayName,
      providerDisplay: {
        key: revision.provider,
        label: providerLabel(revision.provider),
      },
      capabilities: cloneValue(revision.capabilities),
      parameterSupport: cloneValue(revision.parameterSupport),
      limits: cloneValue(revision.limits),
      createdAt: revision.createdAt,
    },
    readiness: readiness.state,
    readinessReason: typeof readiness.reason === "string" && readiness.reason.length > 0
      ? readiness.reason.slice(0, 1_000)
      : null,
    selectable: profile.enabled === true && ["ready", "degraded"].includes(readiness.state),
    defaultForCapabilities,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

function providerLabel(provider) {
  return ({
    deepseek: "DeepSeek",
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    stability: "Stability AI",
    custom: "Custom",
  })[provider] ?? "Model provider";
}

function incrementVersion(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,62}$/.test(value)) {
    throw new ProductStoreError(
      "model_routing_policy_version_invalid",
      "The workspace model routing policy version is invalid.",
    );
  }
  return (BigInt(value) + 1n).toString();
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
