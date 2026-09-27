import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProductPostgresStore } from "../../code/workbench-server/src/store/postgres/product-postgres-store.mjs";
import {
  assertPostgresTools,
  createPostgresBackup,
  parsePostgresConnection,
  restorePostgresBackup,
} from "./postgres-backup-restore.mjs";
import {
  validatePostgresReleaseManifest,
  writePostgresReleaseManifest,
} from "./postgres-release.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../../..");
const command = process.argv[2] ?? "help";

try {
  switch (command) {
    case "help":
      printHelp();
      break;
    case "postgres-up":
      await run("docker", ["compose", "up", "-d", "--wait", "--wait-timeout", "90", "postgres"], { cwd: repositoryRoot });
      break;
    case "postgres-down":
      await run("docker", ["compose", "down"], { cwd: repositoryRoot });
      break;
    case "migrate":
      await migrate();
      break;
    case "doctor":
    case "readiness":
      await doctor();
      break;
    case "backup":
      await backup();
      break;
    case "restore":
      await restore();
      break;
    case "stage-release":
      await stageRelease();
      break;
    case "release":
      await activateRelease();
      break;
    case "serve":
      await serve();
      break;
    default:
      throw coded("workbench_local_command_unknown");
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error?.code ?? "workbench_local_failed" })}\n`);
  process.exitCode = 1;
}

async function migrate() {
  const connectionString = requiredPostgresUrl();
  const { database } = parsePostgresConnection(connectionString);
  if (!database.endsWith("_test") && !flag("--confirm-write")) {
    throw coded("postgres_migration_write_confirmation_required");
  }
  const store = new ProductPostgresStore({ poolOptions: { connectionString } });
  try {
    const result = await store.runMigrations();
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "looloomi-postgres-migration-result-v1",
      database,
      ...result,
    }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

async function doctor() {
  const connectionString = requiredPostgresUrl();
  const { database } = parsePostgresConnection(connectionString);
  const tools = await assertPostgresTools();
  const store = new ProductPostgresStore({ poolOptions: { connectionString } });
  try {
    const operations = store.createOperationalReadiness();
    const [probe, migrations] = await Promise.all([
      operations.probe(),
      operations.verifyMigrations(),
    ]);
    const ready = probe.ok === true && migrations.ok === true;
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "looloomi-postgres-doctor-v1",
      ready,
      database,
      checks: { postgres: probe.ok === true, migrations: migrations.ok === true, tools: tools.available === true },
    }, null, 2)}\n`);
    if (!ready) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

async function backup() {
  const root = value("--output") ?? join(defaultRoot(), "backups", timestampDirectory());
  const result = await createPostgresBackup({
    connectionString: requiredPostgresUrl(),
    objectStoreRoot: process.env.WORKBENCH_OBJECT_STORE_ROOT ?? join(defaultRoot(), "objects"),
    backupSetDirectory: resolve(root),
    encryptionKey: await backupKey(),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "looloomi-postgres-backup-result-v1",
    status: "completed",
    backupSetDirectory: result.backupSetDirectory,
    sourceSnapshot: result.manifest.sourceSnapshot,
  }, null, 2)}\n`);
}

async function restore() {
  if (!flag("--confirm-restore")) throw coded("postgres_restore_confirmation_required");
  const source = requiredValue("--source");
  const targetConnectionString = requiredValue("--target-url");
  const objectTargetRoot = requiredValue("--object-target");
  const result = await restorePostgresBackup({
    backupSetDirectory: resolve(source),
    targetConnectionString,
    objectTargetRoot: resolve(objectTargetRoot),
    encryptionKey: await backupKey(),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "looloomi-postgres-restore-result-v1",
    status: "verified",
    isolated: result.isolated,
    targetDatabase: result.targetDatabase,
    restoredSnapshot: result.restoredSnapshot,
  }, null, 2)}\n`);
}

async function stageRelease() {
  const outputFile = resolve(requiredValue("--output"));
  const manifest = await writePostgresReleaseManifest({ repositoryRoot, outputFile });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "looloomi-postgres-release-stage-result-v1",
    outputFile,
    candidate: manifest.candidate,
  }, null, 2)}\n`);
}

async function activateRelease() {
  if (!flag("--confirm-release")) throw coded("postgres_release_confirmation_required");
  const manifestFile = resolve(requiredValue("--manifest"));
  await validatePostgresReleaseManifest({ repositoryRoot, manifestFile });
  await serve();
}

async function serve() {
  await run(resolve(repositoryRoot, "scripts/start-workbench-server.sh"), [], {
    cwd: repositoryRoot,
  });
}

function requiredPostgresUrl() {
  const value = String(process.env.WORKBENCH_POSTGRES_URL ?? "").trim();
  if (!value) throw coded("workbench_postgres_url_required");
  return value;
}

async function backupKey() {
  const inline = String(process.env.WORKBENCH_BACKUP_KEY_BASE64 ?? "").trim();
  if (inline) return Buffer.from(inline, "base64");
  const path = process.env.WORKBENCH_BACKUP_KEY_FILE
    ?? join(process.env.WORKBENCH_SECRETS_DIR ?? join(defaultRoot(), "secrets"), "backup-key");
  return Buffer.from((await readFile(path, "utf8")).trim(), "base64");
}

function run(executable, args, { cwd = repositoryRoot } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(coded("workbench_local_child_failed", { code, signal }));
    });
  });
}

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
function requiredValue(name) {
  const result = value(name);
  if (!result) throw coded(`workbench_local_argument_required:${name}`);
  return result;
}
function flag(name) { return process.argv.includes(name); }
function defaultRoot() { return join(homedir(), "Library", "Application Support", "Looloomi Workbench"); }
function timestampDirectory() { return new Date().toISOString().replaceAll(":", "-"); }

function printHelp() {
  process.stdout.write(`PostgreSQL-only Workbench operations\n\n`);
  process.stdout.write(`  postgres-up | postgres-down\n`);
  process.stdout.write(`  migrate --confirm-write\n`);
  process.stdout.write(`  doctor | readiness\n`);
  process.stdout.write(`  backup [--output <directory>]\n`);
  process.stdout.write(`  restore --source <directory> --target-url <..._restore_test> --object-target <..._restore_test> --confirm-restore\n`);
  process.stdout.write(`  stage-release --output <manifest.json>\n`);
  process.stdout.write(`  release --manifest <manifest.json> --confirm-release\n`);
  process.stdout.write(`  serve\n`);
}

function coded(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  error.productSafe = true;
  return error;
}
