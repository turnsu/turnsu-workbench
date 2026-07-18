import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_SECRET_ACCOUNTS,
  LOCAL_KEYCHAIN_SERVICE,
  readKeychainSecret,
  writeKeychainSecret,
} from "./keychain.mjs";

const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/+:~-]*@)?sha256:[a-f0-9]{64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_PROVIDERS = new Set(["deepseek", "openai", "anthropic", "gemini", "stability", "custom"]);
const MODEL_PROTOCOLS = new Set([
  "openai_compatible_chat",
  "anthropic_messages",
  "gemini_generate_content",
  "stability_image_v2",
]);
const MODEL_CAPABILITIES = new Set(["chat", "tool_calling", "structured_output", "image_generation"]);
const STABILITY_CORE_ASPECT_RATIOS = Object.freeze([
  "16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21",
]);
const STABILITY_CORE_SEED_MAX = 4_294_967_294;
const STABILITY_CORE_ESTIMATED_COST_USD_MICROS = 30_000;
const MODEL_DEFAULTS = Object.freeze({
  deepseek: { protocol: "openai_compatible_chat", endpoint: "https://api.deepseek.com" },
  openai: { protocol: "openai_compatible_chat", endpoint: "https://api.openai.com/v1" },
  anthropic: { protocol: "anthropic_messages", endpoint: "https://api.anthropic.com" },
  gemini: { protocol: "gemini_generate_content", endpoint: "https://generativelanguage.googleapis.com/v1beta" },
  stability: { protocol: "stability_image_v2", endpoint: "https://api.stability.ai" },
  custom: { protocol: "openai_compatible_chat" },
});
const MONGO_USERNAME = /^[A-Za-z0-9_]{3,64}$/;
const DEFAULT_LOCAL_ROOT = join(homedir(), "Library", "Application Support", "Looloomi Workbench");

export function localPaths(root = DEFAULT_LOCAL_ROOT) {
  return Object.freeze({
    root,
    config: join(root, "config.json"),
    state: join(root, "state"),
    watchdogState: join(root, "state", "watchdog.json"),
    runtime: join(root, "runtime"),
    secrets: join(root, "runtime", "secrets"),
    mongoData: join(root, "data", "mongo"),
    mongoConfig: join(root, "data", "mongo-config"),
    objectStore: join(root, "data", "objects"),
    executionRoot: join(root, "runtime", "executions"),
    agentSandboxRoot: join(root, "runtime", "agent-sandbox"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
    releases: join(root, "releases"),
    current: join(root, "current"),
  });
}

export async function ensureLocalDirectories(paths = localPaths()) {
  for (const directory of [
    paths.root, paths.state, paths.runtime, paths.secrets, paths.mongoData, paths.mongoConfig,
    paths.objectStore, paths.executionRoot, paths.agentSandboxRoot, paths.backups,
    paths.logs, paths.releases,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  return paths;
}

export async function initializeLocalSecrets({
  keychain = { read: readKeychainSecret, write: writeKeychainSecret },
  force = false,
} = {}) {
  const values = {
    [LOCAL_SECRET_ACCOUNTS.mongoUsername]: "workbench_admin",
    [LOCAL_SECRET_ACCOUNTS.mongoPassword]: randomBytes(36).toString("base64url"),
    [LOCAL_SECRET_ACCOUNTS.mongoReplicaKey]: randomBytes(756).toString("base64"),
    [LOCAL_SECRET_ACCOUNTS.backupKey]: randomBytes(32).toString("base64"),
  };
  if (!force) {
    for (const account of Object.keys(values)) {
      try {
        if (String(await keychain.read(account)).length > 0) throw localError("local_secrets_already_initialized");
      } catch (error) {
        if (error?.code !== "keychain_secret_unavailable") throw error;
      }
    }
  }
  for (const [account, value] of Object.entries(values)) await keychain.write(account, value);
  return { initialized: Object.keys(values).sort() };
}

export async function materializeMongoSecrets(paths = localPaths(), { keychain = { read: readKeychainSecret } } = {}) {
  await ensureLocalDirectories(paths);
  const username = String(await keychain.read(LOCAL_SECRET_ACCOUNTS.mongoUsername)).trim();
  const password = String(await keychain.read(LOCAL_SECRET_ACCOUNTS.mongoPassword)).trim();
  const replicaKey = String(await keychain.read(LOCAL_SECRET_ACCOUNTS.mongoReplicaKey)).trim();
  if (!MONGO_USERNAME.test(username) || password.length < 32 || password.length > 256
    || Buffer.from(replicaKey, "base64").length < 6 || Buffer.from(replicaKey, "base64").length > 768) {
    throw localError("local_mongo_secret_invalid");
  }
  await atomicSecret(join(paths.secrets, "mongo-root-username"), username);
  await atomicSecret(join(paths.secrets, "mongo-root-password"), password);
  await atomicSecret(join(paths.secrets, "mongo-replica-key"), replicaKey);
  return { username, password, replicaKey };
}

export function authenticatedMongoUri({ username, password, port = 27017 } = {}) {
  if (!MONGO_USERNAME.test(username || "") || typeof password !== "string" || password.length < 1
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("local_mongo_uri_input_invalid");
  }
  return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/?replicaSet=rs0&authSource=admin`;
}

export async function writeLocalConfig(config, paths = localPaths()) {
  const checked = validateLocalConfig(config);
  await ensureLocalDirectories(paths);
  const temporary = `${paths.config}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, paths.config);
  await chmod(paths.config, 0o600);
  return checked;
}

export async function readLocalConfig(paths = localPaths()) {
  let value;
  try { value = JSON.parse(await readFile(paths.config, "utf8")); } catch { throw localError("local_config_unavailable"); }
  return validateLocalConfig(value);
}

export async function buildDaemonEnvironment({
  paths = localPaths(),
  baseEnv = process.env,
  keychain = { read: readKeychainSecret },
} = {}) {
  const [config, mongo] = await Promise.all([
    readLocalConfig(paths),
    materializeMongoSecrets(paths, { keychain }),
  ]);
  return {
    PATH: baseEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    WORKBENCH_LOCAL_PRODUCTION: "1",
    WORKBENCH_PORT: String(config.port),
    WORKBENCH_MONGODB_URI: authenticatedMongoUri(mongo),
    WORKBENCH_MONGODB_DB: config.database,
    WORKBENCH_AGENT_IMAGE: config.agentImage,
    WORKBENCH_DOCKER_IMAGE: config.skillImage,
    WORKBENCH_MODEL_CATALOG_IMPORT_JSON: JSON.stringify(config.modelCatalogImport),
    WORKBENCH_MODEL_ROUTING_REQUIREMENTS_JSON: JSON.stringify(
      config.modelCatalogImport.routingPolicies.map((policy) => ({
        workspaceId: policy.workspaceId,
        capabilities: Object.keys(policy.defaultProfileIdsByCapability).sort(),
      })),
    ),
    WORKBENCH_MODEL_CREDENTIAL_STORE: "macos-keychain",
    WORKBENCH_MODEL_KEYCHAIN_SERVICE: LOCAL_KEYCHAIN_SERVICE,
    WORKBENCH_OBJECT_STORE_ROOT: paths.objectStore,
    WORKBENCH_EXECUTION_ROOT: paths.executionRoot,
    WORKBENCH_AGENT_SANDBOX_ROOT: paths.agentSandboxRoot,
    WORKBENCH_LOG_LEVEL: config.logLevel,
  };
}

export async function inspectLocalFilesystem(paths = localPaths(), { minimumFreeBytes = 5 * 1024 ** 3 } = {}) {
  const checks = [];
  for (const [name, path] of Object.entries({ root: paths.root, secrets: paths.secrets, mongoData: paths.mongoData, backups: paths.backups })) {
    try {
      const info = await stat(path);
      checks.push({ name: `${name}_permissions`, ok: info.isDirectory() && (info.mode & 0o077) === 0 });
    } catch { checks.push({ name: `${name}_permissions`, ok: false }); }
  }
  try {
    const filesystem = await statfs(paths.root);
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    checks.push({ name: "disk_free", ok: Number.isFinite(freeBytes) && freeBytes >= minimumFreeBytes });
  } catch { checks.push({ name: "disk_free", ok: false }); }
  return checks;
}

function validateLocalConfig(value) {
  const migrated = migrateLocalConfig(value);
  const modelCatalogImport = validateModelCatalogImport(migrated?.modelCatalogImport);
  if (modelCatalogImport.profiles.length < 1
    || !DIGEST_IMAGE.test(migrated?.agentImage || "")
    || !DIGEST_IMAGE.test(migrated?.skillImage || "")
    || !Number.isInteger(migrated?.port) || migrated.port < 1024 || migrated.port > 65535
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(migrated?.database || "")
    || !["info", "warn", "error"].includes(migrated?.logLevel ?? "info")) {
    throw localError("local_config_invalid");
  }
  return Object.freeze({
    schemaVersion: "looloomi-local-config-v3",
    modelCatalogImport,
    agentImage: migrated.agentImage,
    skillImage: migrated.skillImage,
    port: migrated.port,
    database: migrated.database,
    logLevel: migrated.logLevel ?? "info",
  });
}

function migrateLocalConfig(value) {
  if (value?.schemaVersion === "looloomi-local-config-v3" || value?.modelCatalogImport) return value;
  const legacyProfiles = value?.modelProfiles ?? (value?.modelBaseUrl ? [{
    id: "legacy-default",
    label: value.model,
    provider: "custom",
    protocol: "openai-compatible",
    baseUrl: value.modelBaseUrl,
    model: value.model,
    credentialRef: "legacy-default",
    enabled: true,
  }] : null);
  if (!Array.isArray(legacyProfiles) || legacyProfiles.length < 1) return value;
  const defaultProfileId = value.defaultModelProfileId ?? "legacy-default";
  return {
    ...value,
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: legacyProfiles.map(legacyProfileImport),
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: {
          chat: defaultProfileId,
          tool_calling: defaultProfileId,
          structured_output: defaultProfileId,
        },
        workflowFallbackAllowed: false,
      }],
    },
  };
}

function legacyProfileImport(profile) {
  const protocol = ({
    "openai-compatible": "openai_compatible_chat",
    anthropic: "anthropic_messages",
    gemini: "gemini_generate_content",
  })[profile.protocol] ?? MODEL_DEFAULTS[profile.provider]?.protocol ?? profile.protocol;
  return {
    profileId: profile.id,
    displayName: profile.label,
    scope: "global",
    enabled: profile.enabled ?? true,
    provider: profile.provider,
    protocol,
    providerModelId: profile.model,
    capabilities: ["chat", "tool_calling", "structured_output"],
    parameterSchemaVersion: "model-parameters-v1",
    defaults: {},
    limits: {},
    credentialRef: profile.credentialRef,
    endpoint: profile.baseUrl,
    policyVersion: "1",
  };
}

function validateModelCatalogImport(value) {
  if (value?.schemaVersion !== "model-catalog-import-v1"
    || !Array.isArray(value.profiles) || value.profiles.length < 1 || value.profiles.length > 128
    || !Array.isArray(value.routingPolicies ?? value.policies)
    || (value.routingPolicies ?? value.policies).length < 1
    || (value.routingPolicies ?? value.policies).length > 128) {
    throw localError("local_config_invalid");
  }
  const profiles = value.profiles.map(validateProfileImport);
  const ids = new Set(profiles.map((item) => item.profileId));
  if (ids.size !== profiles.length) throw localError("local_config_invalid");
  const profilesById = new Map(profiles.map((item) => [item.profileId, item]));
  const policies = (value.routingPolicies ?? value.policies)
    .map((policy) => validatePolicyImport(policy, profilesById));
  if (new Set(policies.map((policy) => policy.workspaceId)).size !== policies.length) throw localError("local_config_invalid");
  return Object.freeze({
    schemaVersion: "model-catalog-import-v1",
    profiles: Object.freeze(profiles),
    routingPolicies: Object.freeze(policies),
  });
}

function validateProfileImport(value) {
  const provider = String(value?.provider || "").trim();
  const defaults = MODEL_DEFAULTS[provider];
  const protocol = String(value?.protocol || defaults?.protocol || "").trim();
  const endpoint = String(value?.endpoint || defaults?.endpoint || "").trim();
  const capabilities = value?.capabilities;
  if (!PROFILE_ID.test(value?.profileId || "")
    || typeof value?.displayName !== "string" || value.displayName.trim().length < 1 || value.displayName.trim().length > 200
    || !["global", "workspace"].includes(value.scope) || typeof value.enabled !== "boolean"
    || (value.scope === "workspace" && !PROFILE_ID.test(value.workspaceId || ""))
    || (value.scope === "global" && value.workspaceId !== undefined)
    || !MODEL_PROVIDERS.has(provider) || !MODEL_ID.test(value?.providerModelId || "")
    || (provider === "stability" && value.providerModelId !== "stable-image-core")
    || !PROFILE_ID.test(value?.credentialRef || "") || !MODEL_PROTOCOLS.has(protocol)
    || (provider !== "custom" && protocol !== defaults?.protocol)
    || (provider === "custom" && protocol !== "openai_compatible_chat")
    || !Array.isArray(capabilities) || capabilities.length < 1
    || new Set(capabilities).size !== capabilities.length
    || capabilities.some((capability) => !MODEL_CAPABILITIES.has(capability))
    || (protocol === "stability_image_v2"
      && (capabilities.length !== 1 || capabilities[0] !== "image_generation"))
    || (protocol !== "stability_image_v2" && capabilities.includes("image_generation"))
    || ((capabilities.includes("tool_calling") || capabilities.includes("structured_output"))
      && !capabilities.includes("chat"))
    || typeof value.parameterSchemaVersion !== "string" || value.parameterSchemaVersion.length < 1
    || !validModelConfigurationObject(value.defaults) || !validModelConfigurationObject(value.limits)
    || (value.parameterSupport !== undefined && !validModelConfigurationObject(value.parameterSupport))
    || typeof value.policyVersion !== "string" || value.policyVersion.length < 1) throw localError("local_config_invalid");
  const url = safeProviderUrl(endpoint);
  const normalizedDefaults = normalizeModelDefaults(value.defaults, protocol);
  const normalizedParameterSupport = normalizeModelParameterSupport(
    value.parameterSupport,
    protocol,
    capabilities,
  );
  const normalizedLimits = normalizeModelLimits(value.limits, protocol);
  return Object.freeze({
    profileId: value.profileId,
    displayName: value.displayName.trim(),
    scope: value.scope,
    ...(value.scope === "workspace" ? { workspaceId: value.workspaceId } : {}),
    enabled: value.enabled,
    provider,
    protocol,
    providerModelId: value.providerModelId,
    capabilities: Object.freeze([...capabilities].sort()),
    parameterSchemaVersion: value.parameterSchemaVersion,
    defaults: normalizedDefaults,
    parameterSupport: normalizedParameterSupport,
    limits: normalizedLimits,
    credentialRef: value.credentialRef,
    endpoint: url.href.replace(/\/$/, ""),
    policyVersion: value.policyVersion,
  });
}

function validatePolicyImport(value, profilesById) {
  const defaults = value?.defaultProfileIdsByCapability;
  if (!PROFILE_ID.test(value?.workspaceId || "") || !isPlainObject(defaults)
    || Object.keys(defaults).length < 1 || Object.entries(defaults).some(([capability, profileId]) =>
      !MODEL_CAPABILITIES.has(capability) || !profilesById.has(profileId)
      || !profilesById.get(profileId).capabilities.includes(capability))
    || typeof value.workflowFallbackAllowed !== "boolean") throw localError("local_config_invalid");
  return Object.freeze({
    workspaceId: value.workspaceId,
    defaultProfileIdsByCapability: Object.freeze(Object.fromEntries(Object.entries(defaults).sort())),
    workflowFallbackAllowed: value.workflowFallbackAllowed,
  });
}

function safeProviderUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw localError("local_config_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw localError("local_config_invalid");
  }
  return url;
}

function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function validModelConfigurationObject(value) {
  if (!isPlainObject(value)) return false;
  const seen = new Set();
  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > 1_024 || depth > 8) return false;
    if (current === null || typeof current === "string" || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) return current.length <= 128 && current.every((item) => visit(item, depth + 1));
    if (!isPlainObject(current)) return false;
    return Object.entries(current).every(([key, item]) => key.length > 0 && key.length <= 128
      && !/(?:api.?key|secret|authorization|credential|password|access.?token|refresh.?token|bearer.?token|auth.?token)/i.test(key)
      && visit(item, depth + 1));
  };
  return visit(value, 0);
}

function normalizeModelDefaults(value, protocol) {
  const source = value ?? {};
  if (protocol === "stability_image_v2") {
    assertOnlyModelFields(source, ["negativePrompt", "aspectRatio", "seed", "outputFormat"]);
    if ((source.negativePrompt !== undefined
        && (typeof source.negativePrompt !== "string" || source.negativePrompt.length > 10_000))
      || (source.aspectRatio !== undefined
        && !STABILITY_CORE_ASPECT_RATIOS.includes(source.aspectRatio))
      || (source.seed !== undefined && !boundedModelInteger(source.seed, 0, STABILITY_CORE_SEED_MAX))
      || (source.outputFormat !== undefined && !["png", "jpeg", "webp"].includes(source.outputFormat))) {
      throw localError("local_config_invalid");
    }
    return structuredClone(source);
  }
  assertOnlyModelFields(source, ["temperature", "maxOutputTokens"]);
  if ((source.temperature !== undefined
      && (typeof source.temperature !== "number" || !Number.isFinite(source.temperature)
        || source.temperature < 0 || source.temperature > 2))
    || (source.maxOutputTokens !== undefined
      && !boundedModelInteger(source.maxOutputTokens, 1, 1_000_000))) {
    throw localError("local_config_invalid");
  }
  return structuredClone(source);
}

function normalizeModelParameterSupport(value, protocol, capabilities) {
  const source = value ?? {};
  if (protocol === "stability_image_v2") {
    assertOnlyModelFields(source, ["kind", "negativePrompt", "aspectRatios", "seed", "outputFormats"]);
    const aspectRatios = source.aspectRatios ?? STABILITY_CORE_ASPECT_RATIOS;
    const outputFormats = source.outputFormats ?? ["png", "jpeg", "webp"];
    if ((source.kind !== undefined && source.kind !== "image_generation")
      || typeof (source.negativePrompt ?? true) !== "boolean"
      || typeof (source.seed ?? true) !== "boolean"
      || !validUniqueModelValues(aspectRatios, STABILITY_CORE_ASPECT_RATIOS)
      || !validUniqueModelValues(outputFormats, ["png", "jpeg", "webp"])) {
      throw localError("local_config_invalid");
    }
    return {
      kind: "image_generation",
      negativePrompt: source.negativePrompt ?? true,
      aspectRatios: [...aspectRatios],
      seed: source.seed ?? true,
      outputFormats: [...outputFormats],
    };
  }
  assertOnlyModelFields(source, ["kind", "temperature", "maxOutputTokens", "tools", "responseSchema"]);
  if ((source.kind !== undefined && source.kind !== "chat")
    || ["temperature", "maxOutputTokens", "tools", "responseSchema"]
      .some((field) => source[field] !== undefined && typeof source[field] !== "boolean")) {
    throw localError("local_config_invalid");
  }
  return {
    kind: "chat",
    temperature: source.temperature ?? true,
    maxOutputTokens: source.maxOutputTokens ?? true,
    tools: source.tools ?? capabilities.includes("tool_calling"),
    responseSchema: source.responseSchema ?? capabilities.includes("structured_output"),
  };
}

function normalizeModelLimits(value, protocol) {
  const source = value ?? {};
  if (protocol === "stability_image_v2") {
    assertOnlyModelFields(source, ["kind", "maxImageCount", "maxOutputBytes", "maxCostUsdMicros"]);
    const result = {
      kind: "image_generation",
      maxImageCount: source.maxImageCount ?? 1,
      maxOutputBytes: source.maxOutputBytes ?? 25_000_000,
      maxCostUsdMicros: source.maxCostUsdMicros ?? STABILITY_CORE_ESTIMATED_COST_USD_MICROS,
    };
    if ((source.kind !== undefined && source.kind !== result.kind)
      || !boundedModelInteger(result.maxImageCount, 1, 16)
      || !boundedModelInteger(result.maxOutputBytes, 1, 100_000_000)
      || !boundedModelInteger(result.maxCostUsdMicros, 0, 1_000_000_000_000)) {
      throw localError("local_config_invalid");
    }
    return result;
  }
  assertOnlyModelFields(source, ["kind", "maxInputTokens", "maxOutputTokens"]);
  const result = {
    kind: "chat",
    maxInputTokens: source.maxInputTokens ?? 128_000,
    maxOutputTokens: source.maxOutputTokens ?? 4_096,
  };
  if ((source.kind !== undefined && source.kind !== result.kind)
    || !boundedModelInteger(result.maxInputTokens, 1, 10_000_000)
    || !boundedModelInteger(result.maxOutputTokens, 1, 1_000_000)) {
    throw localError("local_config_invalid");
  }
  return result;
}

function assertOnlyModelFields(value, allowed) {
  const fields = new Set(allowed);
  if (Object.keys(value).some((field) => !fields.has(field))) throw localError("local_config_invalid");
}

function validUniqueModelValues(value, allowed) {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every((item) => allowed.includes(item));
}

function boundedModelInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

async function atomicSecret(path, value) {
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function localError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}

export { DEFAULT_LOCAL_ROOT };
