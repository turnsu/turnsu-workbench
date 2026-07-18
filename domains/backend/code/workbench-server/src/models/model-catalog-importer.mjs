import { cloneValue } from "../store/serialization.mjs";
import { MODEL_CAPABILITIES, MODEL_PROTOCOLS } from "./model-catalog.mjs";

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROVIDERS = new Set(["deepseek", "openai", "anthropic", "gemini", "stability", "custom"]);
const CAPABILITIES = new Set(MODEL_CAPABILITIES);
const PROTOCOLS = new Set(MODEL_PROTOCOLS);
const PROTOCOL_ALIASES = Object.freeze({
  "openai-compatible": "openai_compatible_chat",
  anthropic: "anthropic_messages",
  gemini: "gemini_generate_content",
  stability: "stability_image_v2",
});
const PROVIDER_PROTOCOL = Object.freeze({
  deepseek: "openai_compatible_chat",
  openai: "openai_compatible_chat",
  anthropic: "anthropic_messages",
  gemini: "gemini_generate_content",
  stability: "stability_image_v2",
  custom: "openai_compatible_chat",
});

export class ModelCatalogImporter {
  #catalog;

  constructor({ catalog } = {}) {
    if (!catalog || typeof catalog.importProfileRevision !== "function"
      || typeof catalog.importWorkspacePolicy !== "function") {
      throw new TypeError("model_catalog_importer_catalog_required");
    }
    this.#catalog = catalog;
  }

  async importConfiguration(configuration, {
    workspaceId,
    allowLoopbackEndpoints = false,
  } = {}) {
    const input = normalizeConfigurationContainer(configuration);
    const profiles = [];
    for (const source of input.profiles) {
      const normalized = normalizeModelProfileConfiguration(source, {
        workspaceId,
        allowLoopbackEndpoints,
      });
      profiles.push(await this.#catalog.importProfileRevision(normalized));
    }

    const policies = [];
    const explicitPolicies = normalizePolicyInputs(input.value);
    for (const source of explicitPolicies) {
      policies.push(await this.#catalog.importWorkspacePolicy(
        normalizeWorkspacePolicy(source, { workspaceId }),
      ));
    }

    if (explicitPolicies.length === 0 && input.value?.defaultModelProfileId) {
      const policyWorkspaceId = input.value.workspaceId ?? workspaceId;
      if (policyWorkspaceId) {
        const selected = profiles.find(({ profile }) =>
          profile.profileId === input.value.defaultModelProfileId);
        if (!selected) throw new TypeError("model_default_profile_not_imported");
        policies.push(await this.#catalog.importWorkspacePolicy({
          workspaceId: policyWorkspaceId,
          defaultProfileIdsByCapability: Object.fromEntries(
            selected.revision.capabilities.map((capability) => [capability, selected.profile.profileId]),
          ),
          workflowFallbackAllowed: input.profiles.some((profile) =>
            Array.isArray(profile.fallback ?? profile.fallbackProfileIds)
            && (profile.fallback ?? profile.fallbackProfileIds).length > 0),
        }));
      }
    }

    return Object.freeze({ profiles, policies });
  }
}

export function normalizeModelProfileConfiguration(value, {
  workspaceId,
  allowLoopbackEndpoints = false,
} = {}) {
  if (!isPlainObject(value)) throw new TypeError("model_profile_configuration_invalid");
  rejectRuntimeOrSecretFields(value);

  const profileId = String(value.profileId ?? value.id ?? "").trim();
  const displayName = String(value.displayName ?? value.label ?? "").trim();
  const provider = String(value.provider ?? "").trim();
  const protocol = normalizeProtocol(value.protocol ?? PROVIDER_PROTOCOL[provider]);
  const providerModelId = String(value.providerModelId ?? value.model ?? "").trim();
  const credentialRef = String(value.credentialRef ?? "").trim();
  const scope = String(value.scope ?? (value.workspaceId ? "workspace" : "global")).trim();
  const profileWorkspaceId = value.workspaceId ?? (scope === "workspace" ? workspaceId : undefined);
  const enabled = value.enabled ?? true;
  const endpoint = value.endpoint ?? value.baseUrl;
  const capabilities = normalizeCapabilities(
    value.capabilities ?? inferredCapabilities(protocol),
    protocol,
  );

  if (!PROFILE_ID.test(profileId) || displayName.length < 1 || displayName.length > 200
    || !PROVIDERS.has(provider) || !PROTOCOLS.has(protocol) || !MODEL_ID.test(providerModelId)
    || !PROFILE_ID.test(credentialRef) || !["global", "workspace"].includes(scope)
    || typeof enabled !== "boolean") {
    throw new TypeError("model_profile_configuration_invalid");
  }
  if (provider !== "custom" && PROVIDER_PROTOCOL[provider] !== protocol) {
    throw new TypeError("model_provider_protocol_mismatch");
  }
  if (provider === "custom" && protocol !== "openai_compatible_chat") {
    throw new TypeError("model_provider_protocol_mismatch");
  }
  if (protocol === "stability_image_v2" && providerModelId !== "stable-image-core") {
    throw new TypeError("model_provider_model_unsupported");
  }
  if (scope === "workspace" && !PROFILE_ID.test(profileWorkspaceId ?? "")) {
    throw new TypeError("model_profile_workspace_required");
  }
  if (scope === "global" && value.workspaceId !== undefined && value.workspaceId !== null) {
    throw new TypeError("global_model_profile_workspace_forbidden");
  }
  if (endpoint !== undefined && endpoint !== null && String(endpoint).trim()) {
    validateEndpoint(String(endpoint).trim(), { allowLoopbackEndpoints });
  }

  const defaults = normalizeDefaults(value.defaults, protocol);
  const parameterSupport = normalizeParameterSupport(value.parameterSupport, protocol, capabilities);
  const limits = normalizeLimits(value.limits, protocol);
  const parameterSchemaVersion = String(value.parameterSchemaVersion ?? "model-parameters-v1").trim();
  const policyVersion = String(value.policyVersion ?? "1").trim();
  if (!isPlainObject(defaults) || parameterSchemaVersion.length < 1 || parameterSchemaVersion.length > 64
    || policyVersion.length < 1 || policyVersion.length > 64) {
    throw new TypeError("model_profile_revision_configuration_invalid");
  }

  return Object.freeze({
    profile: {
      profileId,
      displayName,
      scope,
      ...(scope === "workspace" ? { workspaceId: profileWorkspaceId } : {}),
      enabled,
    },
    revision: {
      provider,
      protocol,
      providerModelId,
      capabilities,
      parameterSchemaVersion,
      defaults: cloneValue(defaults),
      parameterSupport,
      limits,
      credentialRef,
      ...(endpoint !== undefined && endpoint !== null && String(endpoint).trim()
        ? { endpoint: String(endpoint).trim() }
        : {}),
      policyVersion,
    },
  });
}

function normalizeConfigurationContainer(value) {
  if (Array.isArray(value)) return { value: { profiles: value }, profiles: value };
  if (!isPlainObject(value)) throw new TypeError("model_catalog_configuration_invalid");
  const profiles = value.profiles ?? value.modelProfiles;
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 128) {
    throw new TypeError("model_catalog_profiles_invalid");
  }
  return { value, profiles };
}

function normalizePolicyInputs(value) {
  const plural = value?.routingPolicies ?? value?.modelRoutingPolicies;
  if (plural !== undefined) {
    if (!Array.isArray(plural)) throw new TypeError("model_routing_policies_invalid");
    return plural;
  }
  const singular = value?.routingPolicy ?? value?.modelRoutingPolicy;
  return singular === undefined ? [] : [singular];
}

function normalizeWorkspacePolicy(value, { workspaceId } = {}) {
  if (!isPlainObject(value)) throw new TypeError("model_routing_policy_invalid");
  const policyWorkspaceId = value.workspaceId ?? workspaceId;
  if (!PROFILE_ID.test(policyWorkspaceId ?? "")
    || !isPlainObject(value.defaultProfileIdsByCapability)
    || typeof (value.workflowFallbackAllowed ?? false) !== "boolean") {
    throw new TypeError("model_routing_policy_invalid");
  }
  const defaults = Object.fromEntries(
    Object.entries(value.defaultProfileIdsByCapability)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capability, profileId]) => {
        if (!CAPABILITIES.has(capability) || !PROFILE_ID.test(profileId ?? "")) {
          throw new TypeError("model_routing_policy_invalid");
        }
        return [capability, profileId];
      }),
  );
  return {
    workspaceId: policyWorkspaceId,
    defaultProfileIdsByCapability: defaults,
    workflowFallbackAllowed: value.workflowFallbackAllowed ?? false,
  };
}

function normalizeProtocol(value) {
  const protocol = String(value ?? "").trim();
  return PROTOCOL_ALIASES[protocol] ?? protocol;
}

function inferredCapabilities(protocol) {
  return protocol === "stability_image_v2"
    ? ["image_generation"]
    : ["chat", "tool_calling"];
}

function normalizeCapabilities(value, protocol) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MODEL_CAPABILITIES.length
    || new Set(value).size !== value.length || value.some((capability) => !CAPABILITIES.has(capability))) {
    throw new TypeError("model_capabilities_invalid");
  }
  const capabilities = [...value].sort();
  if (protocol === "stability_image_v2" && (capabilities.length !== 1 || capabilities[0] !== "image_generation")) {
    throw new TypeError("model_capability_protocol_mismatch");
  }
  if (protocol !== "stability_image_v2" && capabilities.includes("image_generation")) {
    throw new TypeError("model_capability_protocol_mismatch");
  }
  if ((capabilities.includes("tool_calling") || capabilities.includes("structured_output"))
    && !capabilities.includes("chat")) {
    throw new TypeError("model_capability_protocol_mismatch");
  }
  return capabilities;
}

function normalizeParameterSupport(value, protocol, capabilities) {
  if (value !== undefined && !isPlainObject(value)) {
    throw new TypeError("model_parameter_support_invalid");
  }
  if (protocol === "stability_image_v2") {
    const source = value ?? {};
    assertOnlyFields(source, ["kind", "negativePrompt", "aspectRatios", "seed", "outputFormats"], "model_parameter_support_invalid");
    const aspectRatios = source.aspectRatios
      ?? ["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"];
    const outputFormats = source.outputFormats ?? ["png", "jpeg", "webp"];
    if ((source.kind !== undefined && source.kind !== "image_generation")
      || typeof (source.negativePrompt ?? true) !== "boolean"
      || typeof (source.seed ?? true) !== "boolean"
      || !validUniqueValues(
        aspectRatios,
        ["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"],
      )
      || !validUniqueValues(outputFormats, ["png", "jpeg", "webp"])) {
      throw new TypeError("model_parameter_support_invalid");
    }
    return {
      kind: "image_generation",
      negativePrompt: source.negativePrompt ?? true,
      aspectRatios: [...aspectRatios],
      seed: source.seed ?? true,
      outputFormats: [...outputFormats],
    };
  }

  const source = value ?? {};
  assertOnlyFields(source, ["kind", "temperature", "maxOutputTokens", "tools", "responseSchema"], "model_parameter_support_invalid");
  if ((source.kind !== undefined && source.kind !== "chat")
    || ["temperature", "maxOutputTokens", "tools", "responseSchema"]
      .some((field) => source[field] !== undefined && typeof source[field] !== "boolean")) {
    throw new TypeError("model_parameter_support_invalid");
  }
  return {
    kind: "chat",
    temperature: source.temperature ?? true,
    maxOutputTokens: source.maxOutputTokens ?? true,
    tools: source.tools ?? capabilities.includes("tool_calling"),
    responseSchema: source.responseSchema ?? capabilities.includes("structured_output"),
  };
}

function normalizeLimits(value, protocol) {
  if (value !== undefined && !isPlainObject(value)) throw new TypeError("model_limits_invalid");
  const source = value ?? {};
  if (protocol === "stability_image_v2") {
    assertOnlyFields(source, ["kind", "maxImageCount", "maxOutputBytes", "maxCostUsdMicros"], "model_limits_invalid");
    const limits = {
      kind: "image_generation",
      maxImageCount: source.maxImageCount ?? 1,
      maxOutputBytes: source.maxOutputBytes ?? 25_000_000,
      maxCostUsdMicros: source.maxCostUsdMicros ?? 30_000,
    };
    if ((source.kind !== undefined && source.kind !== limits.kind)
      || !boundedInteger(limits.maxImageCount, 1, 16)
      || !boundedInteger(limits.maxOutputBytes, 1, 100_000_000)
      || !boundedInteger(limits.maxCostUsdMicros, 0, 1_000_000_000_000)) {
      throw new TypeError("model_limits_invalid");
    }
    return limits;
  }
  assertOnlyFields(source, ["kind", "maxInputTokens", "maxOutputTokens"], "model_limits_invalid");
  const limits = {
    kind: "chat",
    maxInputTokens: source.maxInputTokens ?? 128_000,
    maxOutputTokens: source.maxOutputTokens ?? 4_096,
  };
  if ((source.kind !== undefined && source.kind !== limits.kind)
    || !boundedInteger(limits.maxInputTokens, 1, 10_000_000)
    || !boundedInteger(limits.maxOutputTokens, 1, 1_000_000)) {
    throw new TypeError("model_limits_invalid");
  }
  return limits;
}

function normalizeDefaults(value, protocol) {
  if (value !== undefined && !isPlainObject(value)) throw new TypeError("model_defaults_invalid");
  const source = value ?? {};
  if (protocol === "stability_image_v2") {
    assertOnlyFields(
      source,
      ["negativePrompt", "aspectRatio", "seed", "outputFormat"],
      "model_defaults_invalid",
    );
    if ((source.negativePrompt !== undefined
        && (typeof source.negativePrompt !== "string" || source.negativePrompt.length > 10_000))
      || (source.aspectRatio !== undefined
        && !["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"]
          .includes(source.aspectRatio))
      || (source.seed !== undefined && !boundedInteger(source.seed, 0, 4_294_967_294))
      || (source.outputFormat !== undefined
        && !["png", "jpeg", "webp"].includes(source.outputFormat))) {
      throw new TypeError("model_defaults_invalid");
    }
    return cloneValue(source);
  }
  assertOnlyFields(source, ["temperature", "maxOutputTokens"], "model_defaults_invalid");
  if ((source.temperature !== undefined
      && (typeof source.temperature !== "number" || !Number.isFinite(source.temperature)
        || source.temperature < 0 || source.temperature > 2))
    || (source.maxOutputTokens !== undefined
      && !boundedInteger(source.maxOutputTokens, 1, 1_000_000))) {
    throw new TypeError("model_defaults_invalid");
  }
  return cloneValue(source);
}

function validateEndpoint(value, { allowLoopbackEndpoints }) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("model_provider_endpoint_invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname);
  const permittedProtocol = endpoint.protocol === "https:"
    || (allowLoopbackEndpoints === true && endpoint.protocol === "http:" && loopback);
  if (!permittedProtocol || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("model_provider_endpoint_invalid");
  }
}

function rejectRuntimeOrSecretFields(value) {
  for (const field of [
    "apiKey",
    "secret",
    "authorization",
    "credentials",
    "configHash",
    "revisionId",
    "revisionNumber",
    "currentRevisionId",
  ]) {
    if (Object.hasOwn(value, field)) throw new TypeError(`model_profile_operator_field_forbidden:${field}`);
  }
  rejectNestedSecretFields(value);
}

function rejectNestedSecretFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectNestedSecretFields(item);
    return;
  }
  if (!isPlainObject(value)) return;
  const forbidden = new Set([
    "apikey", "secret", "authorization", "credential", "credentials", "token", "password",
  ]);
  for (const [field, nested] of Object.entries(value)) {
    if (forbidden.has(field.toLowerCase())) {
      throw new TypeError(`model_profile_operator_field_forbidden:${field}`);
    }
    rejectNestedSecretFields(nested);
  }
}

function assertOnlyFields(value, fields, code) {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new TypeError(code);
}

function validUniqueValues(value, allowed) {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every((entry) => allowed.includes(entry));
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
