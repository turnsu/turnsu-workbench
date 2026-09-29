import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";

test("recommended startup migrates isolated PostgreSQL and serves health over the production composition", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
  timeout: 90_000,
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/u);

  const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const startupScript = join(repositoryRoot, "scripts/start-workbench-server.sh");
  const temporaryRoot = await mkdtemp("/private/tmp/looloomi-production-entrypoint-");
  const cloudSecrets = join(temporaryRoot, "cloud-secrets");
  await mkdir(cloudSecrets, { mode: 0o700 });

  const child = spawn("/bin/bash", [startupScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      WORKBENCH_POSTGRES_URL: connectionString,
      WORKBENCH_MANAGED_POSTGRES: "1",
      WORKBENCH_SKIP_WEB_BUILD: "1",
      WORKBENCH_ENV_FILE: join(temporaryRoot, "absent.env"),
      WORKBENCH_OBJECT_STORE_ROOT: join(temporaryRoot, "objects_startup_test"),
      WORKBENCH_EXECUTION_ROOT: join(temporaryRoot, "executions_startup_test"),
      WORKBENCH_CLOUD_SECRET_STORE_DIR: cloudSecrets,
      WORKBENCH_IDENTITY_ENABLED: "false",
      WORKBENCH_LOCAL_PRODUCTION: "0",
      WORKBENCH_PORT: "0",
      WORKBENCH_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const output = captureOutput(child);

  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    await exit;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const port = await output.readyPort;
  assert.ok(Number.isInteger(port) && port > 0, `invalid ready port: ${port}`);

  const health = await fetchJson(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "alive" });

  const readiness = await fetchJson(`http://127.0.0.1:${port}/readyz`);
  assert.equal(readiness.status, 200, JSON.stringify(readiness.body));
  assert.equal(readiness.body.status, "ready");
  assert.equal(readiness.body.checks.postgres, "ok");
  assert.equal(readiness.body.checks.startup, "ok");

  child.kill("SIGTERM");
  const stopped = await exit;
  assert.deepEqual(stopped, { code: 0, signal: null }, output.diagnostics());
});

function captureOutput(child) {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let resolvePort;
  let rejectPort;
  const readyPort = new Promise((resolveReady, rejectReady) => {
    resolvePort = resolveReady;
    rejectPort = rejectReady;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectPort(new Error(`production_entrypoint_ready_timeout\n${diagnostics()}`));
  }, 75_000);
  timer.unref?.();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const match = stdout.match(/workbench_server_ready:http:\/\/127\.0\.0\.1:(\d+)/u);
    if (!settled && match) {
      settled = true;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectPort(new Error(`production_entrypoint_exited_before_ready: code=${code} signal=${signal}\n${diagnostics()}`));
  });

  function diagnostics() {
    return `stdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`;
  }

  return { readyPort, diagnostics };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  return { status: response.status, body: await response.json() };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
}
