import { randomBytes, randomInt } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const POSTGRES_IMAGE = "postgres@sha256:80dee66a0ba95a54d143008143e5d7ef628c0e8d5e0666b39d13c8bac3377953";
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIRECTORY, "../..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const REPOSITORY_NODE = process.execPath;

const suffix = randomBytes(6).toString("hex");
const containerName = `looloomi-pg-foundation-${suffix}`;
const volumeName = `looloomi-pg-foundation-${suffix}`;
const databaseName = `looloomi_pg_foundation_${suffix}_test`;
const databaseUser = "looloomi_foundation_test";
const databasePassword = randomBytes(36).toString("base64url");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "looloomi-pg-foundation-"));
await mkdir(join(temporaryDirectory, "runner"), { recursive: true });

let containerStarted = false;
let failure = null;
let port;

try {
  await requireRepositoryNode();
  await docker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_unavailable");
  port = await findAvailableHighPort();

  await docker([
    "volume", "create",
    "--label", "looloomi.test=postgres-foundation",
    volumeName,
  ], "postgres_volume_create_failed");

  await docker([
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name", containerName,
    "--publish", `127.0.0.1:${port}:5432`,
    "--env", `POSTGRES_USER=${databaseUser}`,
    "--env", `POSTGRES_PASSWORD=${databasePassword}`,
    "--env", `POSTGRES_DB=${databaseName}`,
    "--mount", `type=volume,source=${volumeName},target=/var/lib/postgresql/data`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--health-cmd", `pg_isready --username=${databaseUser} --dbname=${databaseName}`,
    "--health-interval", "1s",
    "--health-timeout", "3s",
    "--health-retries", "45",
    "--health-start-period", "2s",
    POSTGRES_IMAGE,
  ], "postgres_container_start_failed", [databasePassword]);
  containerStarted = true;

  await waitForHealthyContainer();
  const connectionString = new URL("postgresql://127.0.0.1");
  connectionString.username = databaseUser;
  connectionString.password = databasePassword;
  connectionString.port = String(port);
  connectionString.pathname = `/${databaseName}`;
  connectionString.searchParams.set("sslmode", "disable");

  const exit = await runIntegrationTest(connectionString.toString());
  if (exit.code !== 0) {
    throw new Error(`postgres_foundation_integration_failed: exit=${exit.code ?? "none"} signal=${exit.signal ?? "none"}`);
  }
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  if (containerStarted) {
    await cleanupDocker(["stop", "--time", "10", containerName], cleanupErrors);
    await waitForContainerRemoval(cleanupErrors);
  }
  await cleanupDocker(["volume", "rm", "--force", volumeName], cleanupErrors);
  try {
    await rm(temporaryDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupErrors.push(new Error(`temporary_directory_cleanup_failed: ${error.message}`));
  }
  if (cleanupErrors.length > 0) {
    failure = failure
      ? new AggregateError([failure, ...cleanupErrors], "postgres_foundation_run_and_cleanup_failed")
      : new AggregateError(cleanupErrors, "postgres_foundation_cleanup_failed");
  }
}

if (failure) {
  console.error(formatFailure(failure));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "passed",
    image: POSTGRES_IMAGE,
    database: databaseName,
    port,
    cleanup: {
      container: "stopped",
      volume: "removed",
      temporaryDirectory: "removed",
    },
  }));
}

async function requireRepositoryNode() {
  const [actual, expected] = await Promise.all([
    realpath(process.execPath),
    realpath(REPOSITORY_NODE),
  ]);
  if (actual !== expected) {
    throw new Error(`repository_node_required: invoke ${REPOSITORY_NODE}`);
  }
}

async function findAvailableHighPort() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = randomInt(49_152, 65_536);
    const available = await new Promise((resolveAvailability) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolveAvailability(false));
      server.listen({ host: "127.0.0.1", port: candidate, exclusive: true }, () => {
        server.close(() => resolveAvailability(true));
      });
    });
    if (available) return candidate;
  }
  throw new Error("postgres_random_high_port_unavailable");
}

async function waitForHealthyContainer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const health = await docker([
      "inspect",
      "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
      containerName,
    ], "postgres_health_inspect_failed");
    const status = health.stdout.trim();
    // The official image briefly runs its initialization server before it
    // stops that server and execs the long-lived PostgreSQL process.  pg_isready
    // can report healthy during that transition, which makes a following
    // createdb race the entrypoint's shutdown.  A test database is valid only
    // once PID 1 is the final postgres process.
    if (status === "healthy" && await isPrimaryPostgresProcess()) return;
    if (status === "unhealthy") throw new Error("postgres_container_unhealthy");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("postgres_container_health_timeout");
}

async function isPrimaryPostgresProcess() {
  try {
    const result = await execFile("docker", [
      "exec",
      containerName,
      "cat",
      "/proc/1/comm",
    ], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim() === "postgres";
  } catch {
    // Docker can observe the container in the handoff between the image's
    // initialization server and its final exec.  Keep polling until either it
    // settles or the bounded health deadline expires.
    return false;
  }
}

async function runIntegrationTest(connectionString) {
  const defaultFiles = [
    "tests/store/postgres-foundation.integration.test.mjs",
    "tests/store/postgres-baseline-constraints.integration.test.mjs",
    "tests/store/postgres-b1-object-skill-constraints.integration.test.mjs",
    "tests/store/postgres-b2-loop-library-constraints.integration.test.mjs",
    "tests/store/postgres-b3-run-constraints.integration.test.mjs",
    "tests/store/postgres-b4a-authority-constraints.integration.test.mjs",
    "tests/store/postgres-b4b-governance-constraints.integration.test.mjs",
    "tests/store/postgres-b4b-automation-inbox-constraints.integration.test.mjs",
    "tests/store/postgres-invitation-identity.integration.test.mjs",
    "tests/store/postgres-session-domain-ledger.integration.test.mjs",
    "tests/store/postgres-native-client-auth.integration.test.mjs",
    "tests/store/postgres-kernel-session-event-projection.integration.test.mjs",
    "tests/characterization/postgres-characterization.integration.test.mjs",
    "tests/characterization/postgres-memory-operations.integration.test.mjs",
    "tests/characterization/postgres-runner-recovery.integration.test.mjs",
    "tests/characterization/postgres-backup-restore.integration.test.mjs",
    "tests/execution/postgres-admission-execution.integration.test.mjs",
    "tests/operations/production-entrypoint.integration.test.mjs",
    "tests/http/postgres-invitation-oauth.integration.test.mjs",
    "tests/http/postgres-model-configuration.integration.test.mjs",
    "tests/http/postgres-native-client-auth-http.integration.test.mjs",
    "tests/http/postgres-desktop-cloud.integration.test.mjs",
    "tests/http/postgres-project-files.integration.test.mjs",
  ];
  const selected = process.env.WORKBENCH_POSTGRES_TEST_FILE
    ? [process.env.WORKBENCH_POSTGRES_TEST_FILE]
    : defaultFiles;
  for (const [index, testFile] of selected.entries()) {
    const isolatedDatabaseName = `looloomi_pg_${suffix}_${String(index + 1).padStart(2, "0")}_test`;
    const isolatedConnectionString = new URL(connectionString);
    isolatedConnectionString.pathname = `/${isolatedDatabaseName}`;
    await createIsolatedDatabase(isolatedDatabaseName);
    let exit;
    try {
      exit = await runTestFile(isolatedConnectionString.toString(), testFile);
    } finally {
      await dropIsolatedDatabase(isolatedDatabaseName);
    }
    if (exit.code !== 0) return exit;
  }
  return { code: 0, signal: null };
}

async function createIsolatedDatabase(name) {
  await docker([
    "exec",
    containerName,
    "createdb",
    "--username", databaseUser,
    "--owner", databaseUser,
    name,
  ], "postgres_test_database_create_failed");
}

async function dropIsolatedDatabase(name) {
  await docker([
    "exec",
    containerName,
    "dropdb",
    "--username", databaseUser,
    "--if-exists",
    "--force",
    name,
  ], "postgres_test_database_drop_failed");
}

function runTestFile(connectionString, testFile) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(REPOSITORY_NODE, ["--test", testFile], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        WORKBENCH_POSTGRES_INTEGRATION: "1",
        WORKBENCH_POSTGRES_URL: connectionString,
        WORKBENCH_POSTGRES_CONTAINER: containerName,
        WORKBENCH_POSTGRES_USER: databaseUser,
        WORKBENCH_POSTGRES_PASSWORD: databasePassword,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function docker(args, errorCode, secrets = []) {
  try {
    return await execFile("docker", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const diagnostic = redact(String(error.stderr || error.message || "docker command failed"), secrets);
    throw new Error(`${errorCode}: ${diagnostic.trim()}`);
  }
}

async function cleanupDocker(args, errors) {
  try {
    await execFile("docker", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const diagnostic = String(error.stderr || error.message || "docker cleanup failed");
    if (!isMissingDockerObject(diagnostic)) {
      errors.push(new Error(`docker_cleanup_failed: ${diagnostic.trim()}`));
    }
  }
}

async function waitForContainerRemoval(errors) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await execFile("docker", ["container", "inspect", containerName], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const diagnostic = String(error.stderr || error.message || "docker inspect failed");
      if (isMissingDockerObject(diagnostic)) return;
      errors.push(new Error(`postgres_container_removal_inspect_failed: ${diagnostic.trim()}`));
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  errors.push(new Error("postgres_container_removal_timeout"));
}

function isMissingDockerObject(diagnostic) {
  return /No such (container|volume|object)/i.test(diagnostic);
}

function redact(value, secrets) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}

function formatFailure(error, prefix = "") {
  const lines = [`${prefix}${error.message}`];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      lines.push(formatFailure(nested, `${prefix}  `));
    }
  }
  return lines.join("\n");
}
