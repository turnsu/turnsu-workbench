import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_SECRET_ACCOUNTS,
  readKeychainSecret,
  writeKeychainSecret,
} from "./keychain.mjs";

const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/+:~-]*@)?sha256:[a-f0-9]{64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
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
  const modelApiKey = String(await keychain.read(LOCAL_SECRET_ACCOUNTS.modelApiKey)).trim();
  if (modelApiKey.length < 1) throw localError("local_model_key_unavailable");
  return {
    PATH: baseEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    WORKBENCH_LOCAL_PRODUCTION: "1",
    WORKBENCH_PORT: String(config.port),
    WORKBENCH_MONGODB_URI: authenticatedMongoUri(mongo),
    WORKBENCH_MONGODB_DB: config.database,
    WORKBENCH_AGENT_IMAGE: config.agentImage,
    WORKBENCH_DOCKER_IMAGE: config.skillImage,
    WORKBENCH_MODEL_BASE_URL: config.modelBaseUrl,
    WORKBENCH_MODEL_API_KEY: modelApiKey,
    WORKBENCH_MODEL: config.model,
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
  let url;
  try { url = new URL(value?.modelBaseUrl); } catch { throw localError("local_config_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol))
    || !MODEL_ID.test(value?.model || "")
    || !DIGEST_IMAGE.test(value?.agentImage || "")
    || !DIGEST_IMAGE.test(value?.skillImage || "")
    || !Number.isInteger(value?.port) || value.port < 1024 || value.port > 65535
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value?.database || "")
    || !["info", "warn", "error"].includes(value?.logLevel ?? "info")) {
    throw localError("local_config_invalid");
  }
  return Object.freeze({
    schemaVersion: "looloomi-local-config-v1",
    modelBaseUrl: url.href.replace(/\/$/, ""),
    model: value.model,
    agentImage: value.agentImage,
    skillImage: value.skillImage,
    port: value.port,
    database: value.database,
    logLevel: value.logLevel ?? "info",
  });
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
