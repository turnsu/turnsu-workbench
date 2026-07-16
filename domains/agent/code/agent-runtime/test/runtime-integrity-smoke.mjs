import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createAgentRuntimeCore } from "../core/run-loop/agent-runtime-core.mjs";
import {
  createPiBackedAgentRuntime,
  createPiKernelAdapter,
} from "../kernels/pi/pi-kernel-adapter.mjs";
import {
  RUNTIME_ROOT_ENV,
  resolveRuntimePaths,
} from "../lib/runtime-paths.mjs";

const EXPECTED_OWNER = "looloomi-agent-runtime";
const EXPECTED_RUNTIME_OWNER = "repository-runtime-agent-v1";
const testDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(testDir, "..");
const repoRoot = resolve(agentRuntimeRoot, "../../../..");
const repositoryRuntimeRoot = join(repoRoot, "runtime");
const isolatedRuntimeRoot = mkdtempSync("/private/tmp/looloomi-runtime-integrity-");
const manifestPrefix = `/private/tmp/looloomi-wave1a-runtime-${process.pid}`;
const manifestBeforePath = `${manifestPrefix}-before.manifest.json`;
const manifestAfterPath = `${manifestPrefix}-after.manifest.json`;
const paths = resolveRuntimePaths({
  env: {
    WECHAT_AGENT_TEST_MODE: "1",
    [RUNTIME_ROOT_ENV]: isolatedRuntimeRoot,
  },
});
const localNodeBin = join(repoRoot, ".tooling", "node", "bin");
const localNode = join(localNodeBin, "node");
const daemonEntry = join(agentRuntimeRoot, "bin", "wechat-agent-daemon.mjs");
const daemonPort = await availablePort();
const authMirrorPath = join(isolatedRuntimeRoot, "auth-mirror", "auth-token.json");
const testEnv = {
  ...process.env,
  PATH: `${localNodeBin}:${process.env.PATH || ""}`,
  WECHAT_AGENT_TEST_MODE: "1",
  [RUNTIME_ROOT_ENV]: isolatedRuntimeRoot,
  WECHAT_AGENT_AUTH_MIRROR_PATH: authMirrorPath,
  MONGODB_DB: "looloomi_agent_runtime_integrity_test",
  WECHAT_AGENT_DAEMON_PORT: String(daemonPort),
};

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

function treeManifest(root) {
  const entries = [];
  if (!existsSync(root)) {
    return { fileCount: 0, entryCount: 0, digest: createHash("sha256").update("missing").digest("hex"), entries };
  }

  function visit(path, relativePath) {
    const stat = lstatSync(path);
    const kind = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file";
    const entry = {
      path: relativePath,
      kind,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    if (stat.isSymbolicLink()) entry.target = readlinkSync(path);
    entries.push(entry);
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
    }
  }

  visit(root, "");
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return {
    fileCount: entries.filter((entry) => entry.kind === "file").length,
    entryCount: entries.length,
    digest,
    entries,
  };
}

function writeManifest(path, manifest) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: isolatedRuntimeRoot,
    env: testEnv,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function assertProductSafe(value) {
  const forbiddenKeys = new Set([
    "tokenArtifactPath",
    "registeredTools",
    "activeTools",
    "missingInternalTools",
    "extensionPath",
    "skillPath",
    "promptPath",
  ]);

  function visit(current) {
    if (typeof current === "string") {
      assert.ok(!current.startsWith("/"), `absolute path leaked: ${current}`);
      assert.ok(!current.includes("must-not-leak"), "secret leaked");
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      assert.ok(!forbiddenKeys.has(key), `internal field leaked: ${key}`);
      visit(child);
    }
  }

  visit(value);
}

function assertOwnerMetadata(actual, expected) {
  for (const key of ["owner", "runtimeOwner", "instanceID", "pid", "host", "port", "startedAt"]) {
    assert.equal(actual[key], expected[key], `owner metadata mismatch: ${key}`);
  }
  assert.equal(actual.owner, EXPECTED_OWNER);
  assert.equal(actual.runtimeOwner, EXPECTED_RUNTIME_OWNER);
}

function spawnSurface() {
  return spawn(localNode, [daemonEntry, "--runtime-integrity-surface"], {
    cwd: isolatedRuntimeRoot,
    env: testEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForSurface(child, timeoutMs = 15000) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`surface_timeout stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith("runtime_integrity_surface=")) continue;
        clearTimeout(timer);
        try {
          resolvePromise({ payload: JSON.parse(line.slice("runtime_integrity_surface=".length)), stdout, stderr });
        } catch (error) {
          reject(error);
        }
        return;
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`surface_exited_before_ready code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`process_exit_timeout pid=${child.pid}`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

const repositoryRuntimeBefore = treeManifest(repositoryRuntimeRoot);
writeManifest(manifestBeforePath, repositoryRuntimeBefore);
let surfaceProcess = null;
let signalProcess = null;
let unknownProcess = null;
let piRuntime = null;

try {
  assert.equal(run(localNode, ["--version"]).stdout.trim(), "v22.22.3");
  assert.equal(paths.repoRoot, repoRoot);
  assert.equal(paths.runtimeRoot, isolatedRuntimeRoot);
  assert.ok(paths.agentDataRoot.startsWith(`${isolatedRuntimeRoot}/`));
  assert.equal(existsSync(paths.authTokenPath), false);
  assert.equal(existsSync(paths.daemonPidPath), false);

  surfaceProcess = spawnSurface();
  const { payload: publicPayload } = await waitForSurface(surfaceProcess);
  const pidRecord = JSON.parse(readFileSync(paths.daemonPidPath, "utf8"));
  const tokenRecord = JSON.parse(readFileSync(paths.authTokenPath, "utf8"));
  assertOwnerMetadata(pidRecord, publicPayload.health.daemon);
  assertOwnerMetadata(tokenRecord, pidRecord);
  assert.equal(pidRecord.pid, surfaceProcess.pid);
  assert.equal(tokenRecord.token.length >= 32, true);
  assert.equal(statSync(paths.daemonPidPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.authTokenPath).mode & 0o777, 0o600);

  const healthResponse = await fetch(`http://127.0.0.1:${daemonPort}/health`);
  assert.equal(healthResponse.ok, true);
  const liveHealth = await healthResponse.json();
  assertOwnerMetadata(liveHealth.daemon, pidRecord);
  assert.equal(publicPayload.health.daemon.runtimeOwner, EXPECTED_RUNTIME_OWNER);
  assert.equal(publicPayload.capabilities.tools.length, 0);
  assert.equal("providers" in publicPayload.capabilities, false);
  assert.equal("extensionPackages" in publicPayload.capabilities, false);
  for (const skillID of ["wechat-onchain-intelligence", "image-analysis", "long-task"]) {
    const skill = publicPayload.capabilities.skills.find((item) => item.skillID === skillID);
    assert.equal(skill?.readiness?.code, "pi_skill_loaded_and_bound");
    assert.equal(skill?.status, "available");
  }
  assertProductSafe(publicPayload);

  const startExisting = run("/bin/bash", [join(repoRoot, "scripts", "start-agent-daemon.sh")]);
  assert.equal(startExisting.status, 0, `${startExisting.stdout}\n${startExisting.stderr}`);
  const mirroredToken = JSON.parse(readFileSync(authMirrorPath, "utf8"));
  assertOwnerMetadata(mirroredToken, pidRecord);
  assert.equal(mirroredToken.token, tokenRecord.token);

  const stopOwned = run("/bin/bash", [join(repoRoot, "scripts", "stop-agent-daemon.sh")]);
  assert.equal(stopOwned.status, 0, `${stopOwned.stdout}\n${stopOwned.stderr}`);
  await waitForExit(surfaceProcess);
  surfaceProcess = null;
  assert.equal(existsSync(paths.daemonPidPath), false, "SIGTERM must remove the matching owned PID file");
  assert.equal(existsSync(paths.authTokenPath), true, "daemon token remains canonical across restarts");

  piRuntime = createPiBackedAgentRuntime({
    projectRoot: repoRoot,
    agentRuntimeRoot,
    piAgentDir: paths.piAgentDir,
    piExtensionPath: join(agentRuntimeRoot, "extensions", "wechat-onchain-tools.ts"),
    piSkillPath: join(agentRuntimeRoot, "skills"),
    piPromptPath: join(agentRuntimeRoot, "prompts"),
    projectToolNames: [],
    discoverExtensionPaths: () => [],
    discoverExtensionPackages: () => [],
  });
  const piKernel = createPiKernelAdapter(piRuntime);
  await piKernel.ensure();
  const loadedSkillNames = new Set(piRuntime.skillsResult.skills.map((skill) => skill.name));
  assert.deepEqual(
    ["wechat-onchain-intelligence", "image-analysis", "long-task"].filter((name) => !loadedSkillNames.has(name)),
    [],
  );
  assert.deepEqual(
    piRuntime.skillDiagnostics.filter((item) => (
      item.type === "collision" || /missing description/i.test(item.message || "")
    )),
    [],
  );

  const capturedPromptMessages = [];
  const session = piRuntime.session;
  session.agent.state.model = {
    provider: "runtime-integrity",
    id: "no-network",
    name: "Runtime integrity no-network model",
    api: "openai-completions",
    contextWindow: 8192,
    maxTokens: 1024,
  };
  session._modelRegistry.hasConfiguredAuth = () => true;
  session._runAgentPrompt = async (messages) => {
    capturedPromptMessages.push(...messages);
  };
  const core = createAgentRuntimeCore({
    router: {},
    gateEngine: {},
    piKernel,
    finalOutput: {},
    artifacts: {},
  });
  const proof = await core.invokeSkill("long-task", { goal: "runtime integrity proof" });
  const expandedPrompt = capturedPromptMessages
    .flatMap((message) => message.content || [])
    .map((part) => part?.text || "")
    .join("\n");
  assert.match(expandedPrompt, /^<skill name="long-task" location=/);
  assert.match(expandedPrompt, /runtime integrity proof/);
  assert.equal(proof.status, "completed");
  assert.ok(!JSON.stringify(proof).includes(agentRuntimeRoot));

  unknownProcess = spawn(localNode, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(paths.daemonPidPath, `${JSON.stringify({
    schemaVersion: "unknown-owner-v1",
    owner: "unknown-process",
    runtimeOwner: "unknown-runtime",
    pid: unknownProcess.pid,
    instanceID: "unknown-instance",
    host: "127.0.0.1",
    port: daemonPort,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const canonicalTokenBeforeUnknownChecks = readFileSync(paths.authTokenPath, "utf8");

  const stopUnknown = run("/bin/bash", [join(repoRoot, "scripts", "stop-agent-daemon.sh")]);
  assert.notEqual(stopUnknown.status, 0, `${stopUnknown.stdout}\n${stopUnknown.stderr}`);
  process.kill(unknownProcess.pid, 0);

  writeFileSync(paths.daemonPidPath, `${JSON.stringify({
    schemaVersion: "agent-daemon-pid-v1",
    owner: EXPECTED_OWNER,
    runtimeOwner: EXPECTED_RUNTIME_OWNER,
    pid: unknownProcess.pid,
    instanceID: "command-mismatch-instance",
    host: "127.0.0.1",
    port: daemonPort,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const stopCommandMismatch = run("/bin/bash", [join(repoRoot, "scripts", "stop-agent-daemon.sh")]);
  assert.notEqual(stopCommandMismatch.status, 0, `${stopCommandMismatch.stdout}\n${stopCommandMismatch.stderr}`);
  assert.match(`${stopCommandMismatch.stdout}\n${stopCommandMismatch.stderr}`, /process_command_mismatch/);
  process.kill(unknownProcess.pid, 0);

  const startUnknown = run("/bin/bash", [join(repoRoot, "scripts", "start-agent-daemon.sh")]);
  assert.notEqual(startUnknown.status, 0, `${startUnknown.stdout}\n${startUnknown.stderr}`);
  assert.match(`${startUnknown.stdout}\n${startUnknown.stderr}`, /process_command_mismatch/);
  process.kill(unknownProcess.pid, 0);
  assert.equal(readFileSync(paths.authTokenPath, "utf8"), canonicalTokenBeforeUnknownChecks);

  process.kill(unknownProcess.pid, "SIGTERM");
  await waitForExit(unknownProcess);
  unknownProcess = null;
  unlinkSync(paths.daemonPidPath);

  signalProcess = spawnSurface();
  await waitForSurface(signalProcess);
  const signalOwnerRecord = JSON.parse(readFileSync(paths.daemonPidPath, "utf8"));
  const foreignRecord = { ...signalOwnerRecord, instanceID: "foreign-instance" };
  writeFileSync(paths.daemonPidPath, `${JSON.stringify(foreignRecord)}\n`, { mode: 0o600 });
  process.kill(signalProcess.pid, "SIGINT");
  await waitForExit(signalProcess);
  signalProcess = null;
  assert.deepEqual(JSON.parse(readFileSync(paths.daemonPidPath, "utf8")), foreignRecord);
  unlinkSync(paths.daemonPidPath);

  const unsafeReset = run("/bin/bash", [
    join(repoRoot, "scripts", "reset-local-runtime.sh"),
    "--isolated-test",
    "--yes",
  ], {
    env: { ...testEnv, MONGODB_DB: "looloomi_agent" },
  });
  assert.notEqual(unsafeReset.status, 0, `${unsafeReset.stdout}\n${unsafeReset.stderr}`);
  assert.match(`${unsafeReset.stdout}\n${unsafeReset.stderr}`, /refusing_non_test_database/);

  const destructiveReset = run("/bin/bash", [
    join(repoRoot, "scripts", "reset-local-runtime.sh"),
    "--hard",
    "--yes",
  ]);
  assert.notEqual(destructiveReset.status, 0, `${destructiveReset.stdout}\n${destructiveReset.stderr}`);
  assert.match(`${destructiveReset.stdout}\n${destructiveReset.stderr}`, /destructive_reset_disabled/);

  const unsafeAdminReset = run(localNode, [daemonEntry, "--admin-runtime-reset"], {
    env: { ...testEnv, MONGODB_DB: "looloomi_agent" },
  });
  assert.notEqual(unsafeAdminReset.status, 0, `${unsafeAdminReset.stdout}\n${unsafeAdminReset.stderr}`);
  assert.match(`${unsafeAdminReset.stdout}\n${unsafeAdminReset.stderr}`, /refusing_non_test_database/);

  const repositoryRuntimeAfter = treeManifest(repositoryRuntimeRoot);
  writeManifest(manifestAfterPath, repositoryRuntimeAfter);
  assert.equal(repositoryRuntimeAfter.fileCount, repositoryRuntimeBefore.fileCount);
  assert.equal(repositoryRuntimeAfter.entryCount, repositoryRuntimeBefore.entryCount);
  assert.equal(repositoryRuntimeAfter.digest, repositoryRuntimeBefore.digest);
  console.log(`runtime_integrity=pass repository_runtime_files=${repositoryRuntimeBefore.fileCount} manifest=${repositoryRuntimeBefore.digest}`);
  console.log(`runtime_manifest_before=${manifestBeforePath}`);
  console.log(`runtime_manifest_after=${manifestAfterPath}`);
  console.log(`proof_of_use=core->pi-session-prompt skill=long-task loaded=${loadedSkillNames.size} live_model=false`);
  console.log("daemon_owner_lifecycle=pass signals=SIGTERM,SIGINT");
  console.log("unknown_process_safety=pass");
} finally {
  piRuntime?.session?.dispose?.();
  for (const child of [surfaceProcess, signalProcess, unknownProcess]) {
    if (!child?.pid) continue;
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // The test owns these isolated child processes; they may already have exited.
    }
  }
  rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
}
