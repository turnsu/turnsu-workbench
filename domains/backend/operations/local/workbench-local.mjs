#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSupportedNodeVersion } from "../../code/workbench-server/src/runtime/node-version-gate.mjs";
import {
  backupFilename,
  backupManifestPath,
  decryptBackupStream,
  encryptBackupStream,
  selectBackupRetention,
  verifyBackupManifest,
  writeBackupManifest,
} from "./encrypted-mongo-backup.mjs";
import { LOCAL_SECRET_ACCOUNTS, readKeychainSecret, writeKeychainSecret } from "./keychain.mjs";
import {
  activateRelease,
  buildReleaseManifest,
  rollbackRelease,
} from "./release-manager.mjs";
import { stageLocalRelease } from "./release-bundle.mjs";
import {
  authenticatedMongoUri,
  buildDaemonEnvironment,
  ensureLocalDirectories,
  initializeLocalSecrets,
  inspectLocalFilesystem,
  localPaths,
  materializeMongoSecrets,
  readLocalConfig,
  writeLocalConfig,
} from "./local-runtime.mjs";
import { runLocalWatchdog } from "./watchdog.mjs";

assertSupportedNodeVersion();

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "../../../..");
const composePath = join(repositoryRoot, "docker-compose.yml");
const serverBin = join(repositoryRoot, "domains/backend/code/workbench-server/bin/workbench-server.mjs");
const migrationBin = join(repositoryRoot, "domains/backend/code/workbench-server/scripts/migrate-product-store.mjs");
const bundledNode = join(repositoryRoot, ".tooling/node/bin/node");
const MONGO_IMAGE = "mongo@sha256:340c1c56fb10e95cf79ff547f8664b96bc6ead9909bc355238cbf865a9695a6f";
const LATEST_MIGRATION = "005-agent-proposals-and-active-branches";
const FROZEN_FRONTEND_TREE = "d6aa607bab850e6f30a2c92c4823896806871937";
const CRITICAL_RESTORE_COLLECTIONS = Object.freeze([
  "runs", "execution_events", "execution_checkpoints", "agent_turns",
  "memory_deletion_tombstones", "audit_events",
]);

const args = process.argv.slice(2);
const command = args.shift();

try {
  const result = await dispatch(command, args);
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: safeCode(error?.code) })}\n`);
  process.exitCode = 1;
}

async function dispatch(name, argv) {
  const root = valueAfter(argv, "--root") ?? process.env.WORKBENCH_LOCAL_ROOT;
  const paths = localPaths(root);
  switch (name) {
    case "init-secrets":
      await ensureLocalDirectories(paths);
      return initializeLocalSecrets({ force: argv.includes("--rotate") });
    case "set-model-key": {
      const secret = (await readStdin(16_384)).toString("utf8").trim();
      if (!secret) throw coded("model_key_required");
      await writeKeychainSecret(LOCAL_SECRET_ACCOUNTS.modelApiKey, secret);
      return { updated: true };
    }
    case "configure":
      return writeLocalConfig({
        modelBaseUrl: requiredAfter(argv, "--model-base-url"),
        model: requiredAfter(argv, "--model"),
        agentImage: requiredAfter(argv, "--agent-image"),
        skillImage: requiredAfter(argv, "--skill-image"),
        port: integerAfter(argv, "--port", 8798),
        database: valueAfter(argv, "--database") ?? "looloomi_workbench",
        logLevel: valueAfter(argv, "--log-level") ?? "info",
      }, paths);
    case "doctor": {
      const requireRunning = argv.includes("--require-running");
      const result = await doctor({ paths, requireRunning });
      if (requireRunning && result.status !== "ready") throw coded("local_doctor_failed");
      return result;
    }
    case "watchdog":
      return runLocalWatchdog({
        statePath: paths.watchdogState,
        check: () => doctor({ paths, requireRunning: true }),
        notify: (state) => writeWatchdogAlert(state),
      });
    case "preflight":
    case "diagnostics":
      return doctor({ paths, requireRunning: false });
    case "status": {
      const result = await doctor({ paths, requireRunning: true });
      if (result.status !== "ready") throw coded("local_service_not_ready");
      return result;
    }
    case "install":
    case "start":
      return startLocalServices(paths);
    case "stop":
      return stopLocalServices(paths);
    case "restart":
      return restartLocalServer(paths);
    case "mongo-up":
      await materializeMongoSecrets(paths);
      await runChecked("docker", ["compose", "-f", composePath, "up", "-d", "--wait"], {
        env: composeEnvironment(paths),
      });
      return { status: "running" };
    case "mongo-down":
      await runChecked("docker", ["compose", "-f", composePath, "down"], { env: composeEnvironment(paths) });
      return { status: "stopped" };
    case "migrate": {
      const mongo = await materializeMongoSecrets(paths);
      const config = await readLocalConfig(paths);
      await runChecked(bundledNode, [migrationBin, "--db", config.database, "--confirm-write"], {
        cwd: repositoryRoot,
        env: { ...minimalEnvironment(), MONGODB_URI: authenticatedMongoUri(mongo) },
      });
      return { status: "migrated" };
    }
    case "serve": {
      const env = await buildDaemonEnvironment({ paths, baseEnv: minimalEnvironment() });
      return inheritProcess(bundledNode, [serverBin], { cwd: repositoryRoot, env });
    }
    case "backup":
      return createBackup(paths);
    case "restore-drill":
      return restoreDrill(paths, requiredAfter(argv, "--backup"));
    case "manifest":
      return createManifest({
        bundleRoot: requiredAfter(argv, "--bundle"),
        version: requiredAfter(argv, "--version"),
        paths,
      });
    case "stage-release":
      return stageLocalRelease({
        sourceRoot: repositoryRoot,
        destination: requiredAfter(argv, "--destination"),
      });
    case "activate":
    case "upgrade": {
      const config = await readLocalConfig(paths);
      const backup = await createBackup(paths);
      const activated = await activateRelease({
        bundleRoot: requiredAfter(argv, "--bundle"),
        installRoot: paths.root,
        healthCheck: (candidate, manifest) => candidateHealthCheck(candidate, manifest, { paths, config }),
      });
      await installLaunchAgents(paths);
      await waitForReady(config.port);
      return { status: "upgraded", backup: backup.backup, ...activated };
    }
    case "rollback": {
      const config = await readLocalConfig(paths);
      const rolledBack = await rollbackRelease({ installRoot: paths.root });
      await installLaunchAgents(paths);
      await waitForReady(config.port);
      return { status: "rolled_back", ...rolledBack };
    }
    case "install-launchagents":
      return installLaunchAgents(paths);
    case "help":
    case undefined:
      return { commands: [
        "init-secrets", "set-model-key", "configure", "install", "preflight", "start", "stop",
        "restart", "status", "backup", "restore-drill", "upgrade", "rollback", "diagnostics",
        "doctor", "watchdog", "mongo-up", "mongo-down", "migrate", "serve", "stage-release", "manifest",
        "activate", "install-launchagents",
      ] };
    default:
      throw coded("local_command_unknown");
  }
}

async function doctor({ paths, requireRunning }) {
  const checks = await inspectLocalFilesystem(paths);
  let config = null;
  try { config = await readLocalConfig(paths); checks.push({ name: "config", ok: true }); }
  catch { checks.push({ name: "config", ok: false }); }
  for (const account of Object.values(LOCAL_SECRET_ACCOUNTS)) {
    try { await readKeychainSecret(account); checks.push({ name: `keychain_${account}`, ok: true }); }
    catch { checks.push({ name: `keychain_${account}`, ok: false }); }
  }
  const docker = await runProcess("docker", ["info", "--format", "{{json .ServerVersion}}"]);
  checks.push({ name: "docker", ok: docker.code === 0 });
  if (config) {
    for (const [name, image] of [["agent_image", config.agentImage], ["skill_image", config.skillImage], ["mongo_image", MONGO_IMAGE]]) {
      const inspected = await runProcess("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
      checks.push({ name, ok: inspected.code === 0 });
    }
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/readyz`, { signal: AbortSignal.timeout(3000) });
      checks.push({ name: "server_ready", ok: response.status === 200 });
    } catch { checks.push({ name: "server_ready", ok: !requireRunning }); }
  }
  const ok = checks.every((item) => item.ok);
  return { status: ok ? "ready" : "not_ready", checks };
}

async function startLocalServices(paths) {
  await materializeMongoSecrets(paths);
  await runChecked("docker", ["compose", "-f", composePath, "up", "-d", "--wait"], {
    env: composeEnvironment(paths),
  });
  const mongo = await materializeMongoSecrets(paths);
  const config = await readLocalConfig(paths);
  await runChecked(bundledNode, [migrationBin, "--db", config.database, "--confirm-write"], {
    cwd: repositoryRoot,
    env: { ...minimalEnvironment(), MONGODB_URI: authenticatedMongoUri(mongo) },
  });
  await installLaunchAgents(paths);
  await waitForReady(config.port);
  return { status: "ready" };
}

async function stopLocalServices(paths) {
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  for (const definition of launchAgentDefinitions(paths)) {
    await runProcess("/bin/launchctl", [
      "bootout", `gui/${process.getuid()}`, join(launchAgents, `${definition.label}.plist`),
    ]);
  }
  await runChecked("docker", ["compose", "-f", composePath, "down"], { env: composeEnvironment(paths) });
  return { status: "stopped" };
}

async function restartLocalServer(paths) {
  const config = await readLocalConfig(paths);
  await runChecked("/bin/launchctl", [
    "kickstart", "-k", `gui/${process.getuid()}/com.looloomi.workbench.server`,
  ]);
  await waitForReady(config.port);
  return { status: "ready" };
}

async function waitForReady(port, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return true;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (Date.now() < deadline);
  throw coded("local_service_start_timeout");
}

async function writeWatchdogAlert(state) {
  const failed = state.failedChecks.length > 0 ? state.failedChecks.join(",") : "unknown";
  await runChecked("/usr/bin/logger", [
    "-p", "user.err", "-t", "com.looloomi.workbench.watchdog",
    `readiness_failed consecutive=${state.consecutiveFailures} checks=${failed}`,
  ]);
}

async function createBackup(paths) {
  await ensureLocalDirectories(paths);
  const config = await readLocalConfig(paths);
  const key = String(await readKeychainSecret(LOCAL_SECRET_ACCOUNTS.backupKey)).trim();
  const destination = join(paths.backups, backupFilename());
  const manifestPath = backupManifestPath(destination);
  const child = spawn("docker", ["exec", "looloomi-mongodb", "/opt/looloomi/mongo-backup.sh", config.database], {
    stdio: ["ignore", "pipe", "pipe"],
    env: minimalEnvironment(),
  });
  drainBounded(child.stderr);
  const exit = waitForChild(child);
  try {
    await encryptBackupStream({ source: child.stdout, destination, key });
    const code = await exit;
    if (code !== 0) throw coded("mongo_backup_failed");
    await writeBackupManifest({
      archive: destination,
      database: config.database,
      migrationVersion: LATEST_MIGRATION,
      releaseVersion: await currentReleaseVersion(paths),
    });
  } catch (error) {
    child.kill("SIGKILL");
    await rm(destination, { force: true }).catch(() => {});
    await rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  }
  const files = await readdir(paths.backups);
  const retention = selectBackupRetention(files);
  for (const name of retention.remove) {
    const archive = join(paths.backups, name);
    await rm(archive, { force: true });
    await rm(backupManifestPath(archive), { force: true });
  }
  return { status: "completed", backup: destination, manifest: manifestPath, retained: retention.keep.length };
}

async function restoreDrill(paths, backupPath) {
  const info = await lstat(backupPath);
  if (!info.isFile() || info.isSymbolicLink()) throw coded("backup_file_invalid");
  const config = await readLocalConfig(paths);
  const manifest = await verifyBackupManifest({ archive: backupPath });
  if (manifest.database !== config.database || manifest.migrationVersion !== LATEST_MIGRATION) {
    throw coded("backup_manifest_incompatible");
  }
  const key = String(await readKeychainSecret(LOCAL_SECRET_ACCOUNTS.backupKey)).trim();
  const target = `looloomi_restore_${Date.now()}_test`;
  const source = await mongoSnapshotSummary(config.database);
  const restore = spawn("docker", [
    "exec", "-i", "looloomi-mongodb", "/opt/looloomi/mongo-restore.sh", config.database, target,
  ], { stdio: ["pipe", "ignore", "pipe"], env: minimalEnvironment() });
  drainBounded(restore.stderr);
  const exit = waitForChild(restore);
  await decryptBackupStream({ source: backupPath, destination: restore.stdin, key });
  if (await exit !== 0) throw coded("mongo_restore_failed");
  const verified = await runChecked("docker", [
    "exec", "looloomi-mongodb", "/opt/looloomi/mongo-verify-restore.sh", target,
  ]);
  let collections;
  try { collections = JSON.parse(verified.stdout.trim()); } catch { throw coded("mongo_restore_verification_failed"); }
  assertRestoreEquivalent(source, collections);
  await runChecked("docker", ["exec", "looloomi-mongodb", "/opt/looloomi/mongo-drop-test.sh", target]);
  return { status: "verified", targetDatabase: target, cleaned: true, collections };
}

async function mongoSnapshotSummary(database) {
  const result = await runChecked("docker", [
    "exec", "looloomi-mongodb", "/opt/looloomi/mongo-snapshot-summary.sh", database,
  ]);
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw coded("mongo_restore_verification_failed"); }
}

function assertRestoreEquivalent(source, restored) {
  for (const name of CRITICAL_RESTORE_COLLECTIONS) {
    if (source?.[name]?.readable !== true || restored?.[name]?.readable !== true
      || source[name].count !== restored[name].count || restored[name].duplicateIds !== 0
      || source?._indexCounts?.[name] !== restored?._indexCounts?.[name]) {
      throw coded("mongo_restore_verification_failed");
    }
  }
  if (JSON.stringify(source?._migrationLedger) !== JSON.stringify(restored?._migrationLedger)) {
    throw coded("mongo_restore_verification_failed");
  }
}

async function currentReleaseVersion(paths) {
  try {
    const state = JSON.parse(await readFile(join(paths.root, "release-state.json"), "utf8"));
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state?.version || "")) return state.version;
  } catch {}
  return "unmanaged-local";
}

async function createManifest({ bundleRoot, version, paths }) {
  const config = await readLocalConfig(paths);
  const frontendStatus = await runChecked("git", ["status", "--porcelain", "--", "domains/frontend"]);
  const frontendTree = await runChecked("git", ["rev-parse", "HEAD:domains/frontend"]);
  const sourceCommit = await runChecked("git", ["rev-parse", "HEAD"]);
  if (frontendStatus.stdout.trim() || frontendTree.stdout.trim() !== FROZEN_FRONTEND_TREE) {
    throw coded("frozen_frontend_integrity_failed");
  }
  const files = await walkFiles(bundleRoot);
  const manifest = await buildReleaseManifest({
    root: bundleRoot,
    version,
    sourceCommit: sourceCommit.stdout.trim(),
    files: files.filter((path) => path !== "release-manifest.json"),
    agentImage: config.agentImage,
    skillImage: config.skillImage,
    mongoImage: MONGO_IMAGE,
    frontendTreeHash: FROZEN_FRONTEND_TREE,
  });
  await writeFile(join(bundleRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { version, files: manifest.files.length };
}

async function candidateHealthCheck(candidate, manifest, { paths, config }) {
  const node = join(candidate, ".tooling/node/bin/node");
  const server = join(candidate, "domains/backend/code/workbench-server/bin/workbench-server.mjs");
  const info = await Promise.all([lstat(node), lstat(server)]);
  if (!info.every((item) => item.isFile() && !item.isSymbolicLink())
    || manifest.agentImage !== config.agentImage || manifest.skillImage !== config.skillImage
    || manifest.mongoImage !== MONGO_IMAGE || manifest.frontendTreeHash !== FROZEN_FRONTEND_TREE) return false;
  for (const image of [manifest.agentImage, manifest.skillImage, manifest.mongoImage]) {
    if ((await runProcess("docker", ["image", "inspect", image, "--format", "{{.Id}}"])).code !== 0) return false;
  }
  const env = await buildDaemonEnvironment({ paths, baseEnv: minimalEnvironment() });
  const candidateMigration = join(candidate, "domains/backend/code/workbench-server/scripts/migrate-product-store.mjs");
  const migration = await runProcess(node, [candidateMigration, "--db", config.database, "--confirm-write"], {
    cwd: candidate,
    env: { ...env, MONGODB_URI: env.WORKBENCH_MONGODB_URI },
  });
  if (migration.code !== 0) return false;
  return runCandidateReadinessProbe({ candidate, node, env: { ...env, WORKBENCH_PORT: "0" } });
}

function runCandidateReadinessProbe({ candidate, node, env }) {
  const source = `
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = pathToFileURL(resolve("domains/backend/code/workbench-server/src/server.mjs")).href;
    const { startWorkbenchServer } = await import(moduleUrl);
    let running;
    try {
      running = await startWorkbenchServer({ port: 0 });
      const address = running.server.address();
      if (!address || typeof address === "string") throw new Error("candidate_address_invalid");
      const response = await fetch(\`http://127.0.0.1:\${address.port}/readyz\`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      if (response.status !== 200 || body?.status !== "ready") throw new Error("candidate_not_ready");
      process.stdout.write("candidate_ready\\n");
    } finally {
      await running?.close?.();
    }
  `;
  return new Promise((resolveProbe) => {
    const child = spawn(node, ["--input-type=module", "--eval", source], {
      cwd: candidate,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 128 * 1024) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    drainBounded(child.stderr);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", () => { clearTimeout(timeout); resolveProbe(false); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveProbe(code === 0 && Buffer.concat(stdout).toString("utf8").trim().endsWith("candidate_ready"));
    });
  });
}

async function installLaunchAgents(paths) {
  await ensureLocalDirectories(paths);
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  const definitions = launchAgentDefinitions(paths);
  for (const definition of definitions) {
    const path = join(launchAgents, `${definition.label}.plist`);
    await writeFile(path, renderPlist(definition), { mode: 0o600 });
    await chmod(path, 0o600);
    await runProcess("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, path]);
    await runChecked("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, path]);
  }
  return { installed: definitions.map((item) => item.label) };
}

function launchAgentDefinitions(paths) {
  const node = join(paths.current, ".tooling/node/bin/node");
  const cli = join(paths.current, "domains/backend/operations/local/workbench-local.mjs");
  return [
    {
      label: "com.looloomi.workbench.server",
      args: [node, cli, "serve", "--root", paths.root],
      workingDirectory: paths.current,
      runAtLoad: true,
      keepAlive: true,
      stdout: join(paths.logs, "server.stdout.jsonl"),
      stderr: join(paths.logs, "server.stderr.jsonl"),
    },
    {
      label: "com.looloomi.workbench.backup",
      args: [node, cli, "backup", "--root", paths.root],
      workingDirectory: paths.current,
      interval: 86400,
      stdout: join(paths.logs, "backup.stdout.jsonl"),
      stderr: join(paths.logs, "backup.stderr.jsonl"),
    },
    {
      label: "com.looloomi.workbench.watchdog",
      args: [node, cli, "watchdog", "--root", paths.root],
      workingDirectory: paths.current,
      interval: 60,
      stdout: join(paths.logs, "watchdog.stdout.jsonl"),
      stderr: join(paths.logs, "watchdog.stderr.jsonl"),
    },
  ];
}

function renderPlist(definition) {
  const array = definition.args.map((item) => `<string>${xml(item)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${definition.label}</string><key>ProgramArguments</key><array>${array}</array><key>WorkingDirectory</key><string>${xml(definition.workingDirectory)}</string><key>RunAtLoad</key><${definition.runAtLoad ? "true" : "false"}/>${definition.keepAlive ? "<key>KeepAlive</key><true/>" : ""}${definition.interval ? `<key>StartInterval</key><integer>${definition.interval}</integer>` : ""}<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(definition.stdout)}</string><key>StandardErrorPath</key><string>${xml(definition.stderr)}</string></dict></plist>\n`;
}

function composeEnvironment(paths) {
  return {
    ...minimalEnvironment(),
    WORKBENCH_SECRETS_DIR: paths.secrets,
    WORKBENCH_MONGO_DATA_DIR: paths.mongoData,
    WORKBENCH_MONGO_CONFIG_DIR: paths.mongoConfig,
  };
}

function minimalEnvironment() {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" };
}

function runChecked(binary, argv, options = {}) {
  return runProcess(binary, argv, options).then((result) => {
    if (result.code !== 0) throw coded("local_process_failed");
    return result;
  });
}

function runProcess(binary, argv, { cwd = repositoryRoot, env = minimalEnvironment() } = {}) {
  return new Promise((resolveProcess, reject) => {
    let child;
    try { child = spawn(binary, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch { return reject(coded("local_process_unavailable")); }
    const stdout = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 1_000_000) stdout.push(chunk); else child.kill("SIGKILL"); });
    drainBounded(child.stderr);
    child.once("error", () => reject(coded("local_process_unavailable")));
    child.once("close", (code) => resolveProcess({ code, stdout: Buffer.concat(stdout).toString("utf8") }));
  });
}

function inheritProcess(binary, argv, { cwd, env }) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(binary, argv, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", () => reject(coded("local_process_unavailable")));
    child.once("close", (code, signal) => {
      if (signal || code !== 0) reject(coded("local_daemon_failed"));
      else resolveProcess({ status: "stopped" });
    });
    const forward = (signal) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
  });
}

function waitForChild(child) {
  return new Promise((resolveProcess, reject) => {
    child.once("error", () => reject(coded("local_process_unavailable")));
    child.once("close", resolveProcess);
  });
}

function drainBounded(stream) {
  let bytes = 0;
  stream?.on("data", (chunk) => { bytes += chunk.length; if (bytes > 128 * 1024) stream.destroy(); });
}

async function walkFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw coded("release_file_invalid");
    if (entry.isDirectory()) result.push(...await walkFiles(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

function valueAfter(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; }
function requiredAfter(argv, flag) { const value = valueAfter(argv, flag); if (!value) throw coded("local_argument_required"); return value; }
function integerAfter(argv, flag, fallback) { const value = valueAfter(argv, flag); if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed)) throw coded("local_argument_invalid"); return parsed; }
function safeCode(value) { return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/.test(value) ? value : "local_operation_failed"; }
function coded(code) { const error = new Error(code); error.code = code; error.productSafe = true; return error; }
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

async function readStdin(maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw coded("stdin_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
