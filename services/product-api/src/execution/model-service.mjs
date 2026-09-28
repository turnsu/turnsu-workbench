import { createAnthropicModelExecutor } from "./anthropic-model-executor.mjs";
import { createGeminiModelExecutor } from "./gemini-model-executor.mjs";
import {
  ModelProviderError,
  createOpenAICompatibleModelExecutor,
} from "./openai-compatible-model-executor.mjs";
import { createStabilityImageExecutor } from "./stability-image-model-executor.mjs";

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITIES = new Set([
  "chat",
  "tool_calling",
  "structured_output",
  "image_input",
  "image_generation",
  "realtime_audio_input",
  "realtime_audio_output",
  "realtime_turn_detection",
  "realtime_barge_in",
]);
const TRANSIENT_PROVIDER_ERRORS = new Set([
  "provider_rate_limited",
  "provider_timeout",
  "provider_request_failed",
  "provider_response_invalid",
]);
const DEFAULT_ENDPOINTS = Object.freeze({
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  stability: "https://api.stability.ai",
});

export function createConfiguredModelService({
  env = process.env,
  catalog = null,
  credentialResolver = null,
  artifactService = null,
  fetchImpl = globalThis.fetch,
  observer = null,
  now = () => Date.now(),
} = {}) {
  const configured = configurationFromEnvironment(env);
  if (!configured && !catalog) return null;
  if (catalog) {
    return createModelService({
      catalog,
      credentialResolver,
      artifactService,
      fetchImpl,
      observer,
      now,
    });
  }
  return createModelService({ ...configured, artifactService, fetchImpl, observer, now });
}

export function createModelService({
  catalog = null,
  profiles = null,
  defaultModelProfileId = null,
  credentials = null,
  credentialResolver = null,
  artifactService = null,
  fetchImpl = globalThis.fetch,
  observer = null,
  now = () => Date.now(),
} = {}) {
  if (observer !== null && typeof observer !== "function") throw new TypeError("model_service_observer_invalid");
  if (typeof fetchImpl !== "function" || typeof now !== "function") throw new TypeError("model_service_dependency_invalid");
  const source = catalog ?? createLegacyCatalog({ profiles, defaultModelProfileId });
  if (!source?.resolveRevision || !source?.resolveCurrentProfile || !source?.listProfiles) {
    throw new TypeError("model_catalog_required");
  }
  const resolveCredential = buildCredentialResolver(credentialResolver, credentials);

  const execute = async ({
    typedInput,
    input,
    modelProfileRevisionId = null,
    modelProfileId = null,
    fallbackModelProfileRevisionIds = [],
    capability = null,
    invocationId,
    attemptId,
    workspaceId,
    capabilityLeaseId,
    fence,
    limits = {},
    source: artifactSource = null,
    signal,
  } = {}) => {
    const requiredCapability = normalizeCapability(capability, typedInput ?? input);
    if (inputContainsImage(typedInput ?? input) && requiredCapability !== "image_input") {
      throw modelError("model_capability_mismatch");
    }
    const primary = modelProfileRevisionId
      ? await source.resolveRevision({
        revisionId: modelProfileRevisionId,
        workspaceId,
        capabilities: [requiredCapability],
        requireReady: true,
      })
      : await source.resolveCurrentProfile({
        profileId: modelProfileId ?? defaultModelProfileId,
        workspaceId,
        capabilities: [requiredCapability],
        requireReady: true,
      });
    const fallbackIds = normalizeFallbacks(fallbackModelProfileRevisionIds, primary.revision.revisionId);
    if (requiredCapability === "image_generation" && fallbackIds.length > 0) {
      throw modelError("model_image_fallback_forbidden");
    }
    const route = [primary];
    for (const revisionId of fallbackIds) {
      route.push(await source.resolveRevision({
        revisionId,
        workspaceId,
        capabilities: [requiredCapability],
        requireReady: true,
      }));
    }

    const requestedRevisionId = primary.revision.revisionId;
    let lastError = null;
    for (let index = 0; index < route.length; index += 1) {
      throwIfAborted(signal);
      const resolved = route[index];
      const revision = resolved.revision;
      const startedAt = now();
      await notify(observer, attemptEvent({
        phase: "started", revision, requestedRevisionId, fallback: index > 0,
        invocationId, attemptId, workspaceId, capability: requiredCapability,
      }));
      try {
        const apiKey = await resolveCredential(credentialReference(revision), {
          workspaceId,
          revision,
        });
        const executor = createExecutor({
          revision,
          apiKey,
          fetchImpl,
          limits,
          artifactWriter: requiredCapability === "image_generation"
            ? createArtifactWriter({
              artifactService,
              workspaceId,
              invocationId,
              attemptId,
              capabilityLeaseId,
              fence,
              artifactSource,
              requestedRevisionId,
              actualRevisionId: revision.revisionId,
              signal,
            })
            : null,
        });
        const result = await executor({ input: structuredClone(typedInput ?? input), signal });
        const normalized = normalizeModelResult(result, {
          capability: requiredCapability,
          requestedRevisionId,
          actualRevisionId: revision.revisionId,
        });
        await notify(observer, attemptEvent({
          phase: "completed", revision, requestedRevisionId, fallback: index > 0,
          invocationId, attemptId, workspaceId, capability: requiredCapability,
          durationMs: elapsed(now(), startedAt), usage: normalized.usage,
        }));
        return normalized;
      } catch (error) {
        lastError = normalizeCredentialError(error);
        await notify(observer, attemptEvent({
          phase: "failed", revision, requestedRevisionId, fallback: index > 0,
          invocationId, attemptId, workspaceId, capability: requiredCapability,
          durationMs: elapsed(now(), startedAt), code: safeCode(lastError?.code),
        }));
        if (signal?.aborted || !fallbackEligible(lastError) || index === route.length - 1) throw lastError;
      }
    }
    throw lastError ?? modelError("provider_request_failed");
  };

  execute.execute = execute;
  execute.listModels = async ({ workspaceId, capabilities = [], includeDisabled = true } = {}) => (
    source.listProfiles({ workspaceId, capabilities, includeDisabled })
  );
  execute.hasProfile = async (profileId, { workspaceId, capabilities = [] } = {}) => {
    try {
      await source.resolveCurrentProfile({ profileId, workspaceId, capabilities, requireReady: false });
      return true;
    } catch { return false; }
  };
  execute.hasRevision = async (revisionId, { workspaceId, capabilities = [] } = {}) => {
    try {
      await source.resolveRevision({ revisionId, workspaceId, capabilities, requireReady: false });
      return true;
    } catch { return false; }
  };
  execute.resolveTurnSelection = (options) => resolveTurnSelection(source, options);
  execute.resolveCurrentProfile = (options) => source.resolveCurrentProfile(options);
  execute.resolveRevision = (options) => source.resolveRevision(options);
  execute.getWorkspacePolicy = (workspaceId) => source.getWorkspacePolicy?.(workspaceId) ?? null;
  execute.probe = (options) => probeCatalog({ source, resolveCredential, fetchImpl, artifactService, ...options });
  execute.defaultModelProfileId = defaultModelProfileId;
  return Object.freeze(execute);
}

async function resolveTurnSelection(source, {
  workspaceId,
  userId = null,
  kind,
  explicitRevisionId = null,
  lastUsedModelProfileId = null,
  requiredCapabilities = null,
} = {}) {
  const capabilities = Array.isArray(requiredCapabilities) && requiredCapabilities.length > 0
    ? [...new Set(requiredCapabilities)]
    : kind === "model_task"
    ? ["image_generation"]
    : ["chat", "tool_calling", "structured_output"];
  let resolved;
  let inheritedFrom;
  if (explicitRevisionId) {
    resolved = await source.resolveRevision({
      revisionId: explicitRevisionId, workspaceId, ...(userId ? { userId } : {}), capabilities, requireReady: true,
    });
    inheritedFrom = "turn";
  } else if (lastUsedModelProfileId) {
    resolved = await source.resolveCurrentProfile({
      profileId: lastUsedModelProfileId, workspaceId, ...(userId ? { userId } : {}), capabilities, requireReady: true,
    });
    inheritedFrom = "session_preference";
  } else {
    const policy = await source.getWorkspacePolicy?.(workspaceId, ...(userId ? [{ userId }] : []));
    const capability = requiredCapabilities?.length ? capabilities[0] : kind === "model_task" ? "image_generation" : "structured_output";
    const profileId = policy?.defaultProfileIdsByCapability?.[capability];
    if (!profileId) throw modelError("model_route_unresolved");
    resolved = await source.resolveCurrentProfile({
      profileId, workspaceId, ...(userId ? { userId } : {}), capabilities, requireReady: true,
    });
    inheritedFrom = "workspace_default";
  }
  return Object.freeze({
    profileId: resolved.profile.profileId,
    modelProfileRevisionId: resolved.revision.revisionId,
    capabilities: [...capabilities],
    inheritedFrom,
  });
}

async function probeCatalog({ source, resolveCredential, fetchImpl, artifactService, workspaceId } = {}) {
  try {
    const policy = await source.getWorkspacePolicy?.(workspaceId);
    const profileIds = policy
      ? [...new Set(Object.values(policy.defaultProfileIdsByCapability ?? {}))]
      : source.defaultModelProfileId ? [source.defaultModelProfileId] : [];
    if (profileIds.length === 0) return { available: false, code: "model_route_unresolved" };
    const profiles = [];
    for (const profileId of profileIds) {
      const resolved = await source.resolveCurrentProfile({
        profileId, workspaceId, capabilities: [], requireReady: false,
      });
      const apiKey = await resolveCredential(credentialReference(resolved.revision));
      if (resolved.revision.protocol === "openai_realtime") {
        profiles.push({
          profileId,
          revisionId: resolved.revision.revisionId,
          available: typeof apiKey === "string" && apiKey.length > 0,
        });
        continue;
      }
      const executor = createExecutor({
        revision: resolved.revision,
        apiKey,
        fetchImpl,
        limits: resolved.revision.limits,
        artifactWriter: resolved.revision.protocol === "stability_image_v2" && artifactService
          ? async () => { throw modelError("artifact_write_forbidden_during_probe"); }
          : null,
      });
      const result = await executor.probe?.();
      profiles.push({
        profileId,
        revisionId: resolved.revision.revisionId,
        available: result?.available === true,
      });
    }
    return { available: profiles.every((profile) => profile.available), profiles };
  } catch (error) {
    return { available: false, code: safeCode(error?.code) };
  }
}

function createArtifactWriter({
  artifactService,
  workspaceId,
  invocationId,
  attemptId,
  capabilityLeaseId,
  fence,
  artifactSource,
  requestedRevisionId,
  actualRevisionId,
  signal,
}) {
  if (!artifactService?.commitImage) throw modelError("artifact_service_unavailable", { status: "blocked" });
  if (!artifactSource) throw modelError("artifact_source_required");
  return async ({ bytes, mediaType, dimensions, format, seed, safetyStatus, signal: writerSignal }) => {
    const committed = await artifactService.commitImage({
      workspaceId,
      execution: { invocationId, attemptId, fence, capabilityLeaseId },
      source: structuredClone(artifactSource),
      requestedModelRevisionId: requestedRevisionId,
      actualModelRevisionId: actualRevisionId,
      bytes,
      mediaType,
      expectedDimensions: dimensions,
      format,
      seed,
      safetyStatus,
      signal: writerSignal ?? signal,
    });
    return { artifactId: committed.artifactId, mediaType: committed.mediaType ?? mediaType };
  };
}

function createExecutor({ revision, apiKey, fetchImpl, limits, artifactWriter }) {
  const baseUrl = revision.endpoint ?? DEFAULT_ENDPOINTS[revision.provider];
  const options = {
    baseUrl,
    apiKey,
    model: revision.providerModelId,
    fetchImpl,
    limits: { ...revision.limits, ...limits },
  };
  if (revision.protocol === "anthropic_messages") return createAnthropicModelExecutor(options);
  if (revision.protocol === "gemini_generate_content") return createGeminiModelExecutor(options);
  if (revision.protocol === "stability_image_v2") {
    if (typeof artifactWriter !== "function") throw modelError("artifact_service_unavailable", { status: "blocked" });
    return createStabilityImageExecutor({ ...options, artifactWriter });
  }
  if (revision.protocol === "openai_compatible_chat") return createOpenAICompatibleModelExecutor(options);
  throw modelError("model_protocol_unsupported", { status: "blocked" });
}

function normalizeModelResult(result, { capability, requestedRevisionId, actualRevisionId }) {
  if (!isPlainObject(result)) throw modelError("provider_response_invalid");
  if (capability === "image_generation") {
    return Object.freeze({
      kind: "image_generation",
      artifactRefs: normalizeArtifactRefs(result.artifactRefs),
      seed: Number.isInteger(result.seed) ? result.seed : null,
      format: ["png", "jpeg", "webp"].includes(result.format) ? result.format : "png",
      dimensions: structuredClone(result.dimensions),
      safetyStatus: typeof result.safetyStatus === "string" ? result.safetyStatus : "unknown",
      usage: normalizeUsage(result.usage, { imageCount: 1 }),
      requestedModelRevisionId: requestedRevisionId,
      actualModelRevisionId: actualRevisionId,
    });
  }
  return Object.freeze({
    ...structuredClone(result),
    requestedModelRevisionId: requestedRevisionId,
    actualModelRevisionId: actualRevisionId,
    usage: normalizeUsage(result.usage),
  });
}

function normalizeArtifactRefs(value) {
  const refs = Array.isArray(value) ? value : [];
  const normalized = refs.filter((item) => isPlainObject(item)
    && typeof item.artifactId === "string"
    && ["image/png", "image/jpeg", "image/webp"].includes(item.mediaType))
    .map((item) => ({ artifactId: item.artifactId, mediaType: item.mediaType }));
  if (normalized.length === 0) throw modelError("artifact_write_failed");
  return normalized;
}

function normalizeUsage(value, { imageCount = 0 } = {}) {
  const inputTokens = nonnegativeInteger(value?.inputTokens ?? value?.input);
  const outputTokens = nonnegativeInteger(value?.outputTokens ?? value?.output);
  return {
    inputTokens,
    outputTokens,
    totalTokens: nonnegativeInteger(value?.totalTokens ?? inputTokens + outputTokens),
    imageCount: nonnegativeInteger(value?.imageCount ?? imageCount),
    costUsdMicros: nonnegativeInteger(value?.costUsdMicros),
  };
}

function buildCredentialResolver(resolver, credentials) {
  if (resolver?.resolve) return (credentialRef, context) => resolver.resolve(credentialRef, context);
  if (typeof resolver === "function") return resolver;
  const map = isPlainObject(credentials) ? new Map(Object.entries(credentials)) : null;
  if (!map) return async () => { throw credentialUnavailable(); };
  return async (credentialRef) => {
    const secret = map.get(credentialRef);
    if (typeof secret !== "string" || secret.length === 0) throw credentialUnavailable();
    return secret;
  };
}

// Legacy catalog entries use credentialRef. PostgreSQL revision records hold
// only a governed opaque SecretBinding id; passing that id to the injected
// resolver keeps the secret store at the Product boundary without changing
// the public Model catalog shape.
function credentialReference(revision) {
  const value = revision?.credentialRef ?? revision?.secretBindingId;
  if (!PROFILE_ID.test(value ?? "")) throw credentialUnavailable();
  return value;
}

function createLegacyCatalog({ profiles, defaultModelProfileId }) {
  if (!Array.isArray(profiles) || profiles.length === 0 || !PROFILE_ID.test(defaultModelProfileId ?? "")) {
    throw new TypeError("model_profiles_configuration_invalid");
  }
  const entries = new Map(profiles.map((source, index) => {
    const profileId = source.id ?? source.profileId;
    const protocol = normalizeProtocol(source.protocol, source.provider);
    const revision = {
      revisionId: source.revisionId ?? `${profileId}:revision:1`,
      profileId,
      revisionNumber: 1,
      provider: source.provider,
      protocol,
      providerModelId: source.model ?? source.providerModelId,
      capabilities: source.capabilities ?? (protocol === "stability_image_v2"
        ? ["image_generation"] : ["chat", "tool_calling", "structured_output"]),
      parameterSchemaVersion: "model-parameters-v1",
      defaults: source.defaults ?? {},
      limits: source.limits ?? {},
      credentialRef: source.credentialRef,
      ...(source.baseUrl || source.endpoint ? { endpoint: source.baseUrl ?? source.endpoint } : {}),
      policyVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const profile = {
      profileId,
      displayName: source.label ?? source.displayName ?? profileId,
      scope: "global",
      enabled: source.enabled !== false,
      currentRevisionId: revision.revisionId,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    };
    if (!PROFILE_ID.test(profileId ?? "") || !PROFILE_ID.test(revision.credentialRef ?? "")
      || !revision.providerModelId || !revision.protocol) throw new TypeError("model_profile_configuration_invalid");
    return [profileId, { profile, revision, readiness: { state: profile.enabled ? "ready" : "disabled" }, index }];
  }));
  const byRevision = new Map([...entries.values()].map((entry) => [entry.revision.revisionId, entry]));
  if (!entries.has(defaultModelProfileId)) throw new TypeError("model_profiles_configuration_invalid");
  return Object.freeze({
    defaultModelProfileId,
    async listProfiles({ capabilities = [], includeDisabled = true } = {}) {
      return [...entries.values()].filter((entry) => (includeDisabled || entry.profile.enabled)
        && capabilities.every((capability) => entry.revision.capabilities.includes(capability)))
        .map(({ profile, revision }) => ({
          profileId: profile.profileId,
          displayName: profile.displayName,
          currentRevisionId: revision.revisionId,
          capabilities: [...revision.capabilities],
          enabled: profile.enabled,
          readiness: profile.enabled ? "ready" : "disabled",
        }));
    },
    async resolveRevision({ revisionId, capabilities = [], requireReady = true }) {
      const entry = byRevision.get(revisionId);
      return requireLegacyEntry(entry, capabilities, requireReady);
    },
    async resolveCurrentProfile({ profileId, capabilities = [], requireReady = true }) {
      return requireLegacyEntry(entries.get(profileId), capabilities, requireReady);
    },
    async getWorkspacePolicy() {
      return { defaultProfileIdsByCapability: {
        chat: defaultModelProfileId,
        tool_calling: defaultModelProfileId,
        structured_output: defaultModelProfileId,
      } };
    },
  });
}

function requireLegacyEntry(entry, capabilities, requireReady) {
  if (!entry) throw modelError("model_profile_not_found");
  if (capabilities.some((capability) => !entry.revision.capabilities.includes(capability))) {
    throw modelError("model_capability_mismatch");
  }
  if (requireReady && entry.readiness.state !== "ready") throw modelError("model_revision_unavailable");
  return entry;
}

export function configurationFromEnvironment(env = process.env) {
  const catalogImport = String(env.WORKBENCH_MODEL_CATALOG_IMPORT_JSON || "").trim();
  if (catalogImport) {
    try { return { catalogImport: JSON.parse(catalogImport) }; }
    catch { throw new TypeError("workbench_model_catalog_import_json_invalid"); }
  }
  const jsonProfiles = String(env.WORKBENCH_MODEL_PROFILES_JSON || "").trim();
  if (jsonProfiles) {
    try {
      const value = JSON.parse(jsonProfiles);
      return {
        profiles: Array.isArray(value) ? value : value.profiles,
        defaultModelProfileId: env.WORKBENCH_MODEL_DEFAULT_PROFILE ?? value.defaultModelProfileId,
        credentials: JSON.parse(String(env.WORKBENCH_MODEL_CREDENTIALS_JSON || "{}")),
      };
    } catch { throw new TypeError("workbench_model_profiles_json_invalid"); }
  }
  const baseUrl = String(env.WORKBENCH_MODEL_BASE_URL || "").trim();
  const apiKey = String(env.WORKBENCH_MODEL_API_KEY || "").trim();
  const model = String(env.WORKBENCH_MODEL || "").trim();
  if (!baseUrl && !apiKey && !model) return null;
  if (!baseUrl || !apiKey || !model) throw new TypeError("workbench_model_configuration_incomplete");
  return {
    profiles: [{
      id: "legacy-default", label: model, provider: "custom", protocol: "openai_compatible_chat",
      baseUrl, model, credentialRef: "legacy-default", enabled: true,
    }],
    defaultModelProfileId: "legacy-default",
    credentials: { "legacy-default": apiKey },
  };
}

function normalizeProtocol(protocol, provider) {
  const value = ({
    "openai-compatible": "openai_compatible_chat",
    anthropic: "anthropic_messages",
    gemini: "gemini_generate_content",
    stability: "stability_image_v2",
  })[protocol] ?? protocol;
  return value ?? ({
    deepseek: "openai_compatible_chat", openai: "openai_compatible_chat", custom: "openai_compatible_chat",
    anthropic: "anthropic_messages", gemini: "gemini_generate_content", stability: "stability_image_v2",
  })[provider];
}

function normalizeFallbacks(value, primaryRevisionId) {
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length
    || value.includes(primaryRevisionId) || value.some((item) => !PROFILE_ID.test(item))) {
    throw modelError("model_fallback_selection_invalid");
  }
  return value;
}

function normalizeCapability(value, input) {
  const capability = value ?? (typeof input?.prompt === "string"
    ? "image_generation"
    : inputContainsImage(input)
      ? "image_input"
      : "chat");
  if (!CAPABILITIES.has(capability)) throw modelError("model_capability_mismatch");
  return capability;
}

function inputContainsImage(input) {
  const messages = input?.messages ?? input?.context?.messages;
  return Array.isArray(messages) && messages.some((message) =>
    Array.isArray(message?.content)
      && message.content.some((part) => part?.type === "image"));
}

function normalizeCredentialError(error) {
  if (error?.code !== "credential_unavailable") return error;
  return modelError("provider_auth_failed", { status: "blocked" });
}

function credentialUnavailable() {
  const error = new Error("credential_unavailable");
  error.code = "credential_unavailable";
  error.productSafe = true;
  return error;
}

function fallbackEligible(error) {
  return error instanceof ModelProviderError
    ? error.retryable === true
    : TRANSIENT_PROVIDER_ERRORS.has(error?.code);
}

function modelError(code, { status = "failed" } = {}) {
  const error = new ModelProviderError(code, { status });
  error.code = code;
  return error;
}

function attemptEvent({ revision, requestedRevisionId, capability, ...rest }) {
  return {
    ...rest,
    requestedModelRevisionId: requestedRevisionId,
    actualModelRevisionId: revision.revisionId,
    profileId: revision.profileId,
    provider: revision.provider,
    protocol: revision.protocol,
    capability,
  };
}

async function notify(observer, event) {
  if (observer) await observer(Object.freeze(structuredClone(event)));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? modelError("cancelled", { status: "cancelled" });
}

function elapsed(value, startedAt) { return Math.max(0, Number(value) - Number(startedAt)); }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function safeCode(value) { return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "provider_request_failed"; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
