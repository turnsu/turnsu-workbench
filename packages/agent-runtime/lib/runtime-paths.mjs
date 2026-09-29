import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_ROOT_ENV = "TURNSU_AGENT_RUNTIME_ROOT";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const derivedAgentRuntimeRoot = resolve(moduleDir, "..");
const derivedRepoRoot = resolve(derivedAgentRuntimeRoot, "../..");

export function isPathInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function temporaryRoots() {
  return [...new Set([tmpdir(), "/tmp", "/private/tmp"].map((path) => resolve(path)))];
}

function validateRuntimeOverride(rawOverride, { isTestMode }) {
  if (!rawOverride) {
    if (isTestMode) throw new Error("test_runtime_override_required");
    return null;
  }
  if (!isTestMode) throw new Error("runtime_override_requires_test_mode");
  if (!isAbsolute(rawOverride)) throw new Error("runtime_override_must_be_absolute");

  const candidate = resolve(rawOverride);
  const isDedicatedTemporaryPath = temporaryRoots().some((root) => (
    candidate !== root && isPathInside(root, candidate)
  ));
  if (!isDedicatedTemporaryPath || isPathInside(derivedRepoRoot, candidate)) {
    throw new Error("runtime_override_must_be_temporary");
  }
  return candidate;
}

export function resolveRuntimePaths({ env = process.env } = {}) {
  const isTestMode = String(env.TURNSU_AGENT_TEST_MODE || "") === "1";
  const override = validateRuntimeOverride(String(env[RUNTIME_ROOT_ENV] || "").trim(), { isTestMode });
  const runtimeRoot = override || join(derivedRepoRoot, "runtime");
  const agentDataRoot = join(runtimeRoot, "agent");
  const opsRoot = join(runtimeRoot, "ops");

  return Object.freeze({
    repoRoot: derivedRepoRoot,
    agentRuntimeRoot: derivedAgentRuntimeRoot,
    runtimeRoot,
    agentDataRoot,
    sessionsRoot: join(agentDataRoot, "sessions"),
    tasksRoot: join(agentDataRoot, "tasks"),
    runsRoot: join(agentDataRoot, "runs"),
    attachmentsRoot: join(agentDataRoot, "attachments"),
    logsRoot: join(agentDataRoot, "logs"),
    opsRoot,
    opsHealthRoot: join(opsRoot, "health"),
    opsMetricsRoot: join(opsRoot, "metrics"),
    opsEventsRoot: join(opsRoot, "events"),
    opsPolicyRoot: join(opsRoot, "policy"),
    bridgesRoot: join(runtimeRoot, "bridges"),
    piAgentDir: join(agentDataRoot, "pi-agent-home"),
    authTokenPath: join(agentDataRoot, "auth-token.json"),
    daemonPidPath: join(agentDataRoot, "daemon.pid"),
    daemonLogPath: join(agentDataRoot, "logs", "daemon.log"),
    isTestMode,
    usesRuntimeOverride: Boolean(override),
  });
}

export function runtimeArtifactPath(path, paths = runtimePaths) {
  const absolutePath = resolve(path);
  if (!isPathInside(paths.runtimeRoot, absolutePath)) {
    throw new Error("path_outside_runtime_root");
  }
  const suffix = relative(paths.runtimeRoot, absolutePath).split(sep).join("/");
  return suffix ? `runtime/${suffix}` : "runtime";
}

export function assertIsolatedTestRuntime({ paths = runtimePaths, databaseName } = {}) {
  if (!paths.isTestMode || !paths.usesRuntimeOverride) {
    throw new Error("isolated_test_runtime_required");
  }
  if (!String(databaseName || "").endsWith("_test")) {
    throw new Error("refusing_non_test_database");
  }
  return true;
}

export const runtimePaths = resolveRuntimePaths();

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const printIndex = process.argv.indexOf("--print");
  const key = printIndex >= 0 ? process.argv[printIndex + 1] : null;
  const value = key ? runtimePaths[key] : null;
  if (typeof value !== "string") {
    console.error("usage: runtime-paths.mjs --print <path-key>");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${value}\n`);
  }
}
