import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(scriptDirectory);
const serverRoot = fileURLToPath(new URL("../../../../../backend/code/workbench-server/", import.meta.url));
const serverEntry = join(serverRoot, "bin", "workbench-server.mjs");
const { ProductMongoStore } = await import(new URL("../../../../../backend/code/workbench-server/src/store/index.mjs", import.meta.url));
const mongoUri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const databaseName = `looloomi_permission_${Date.now()}_${process.pid}_test`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "looloomi-permission-smoke-"));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(origin, processHandle) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`permission_product_server_exited:${processHandle.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/workbench/v1/workspace`, {
        headers: {
          "X-Workbench-Test-User": "permission-readiness-user",
          "X-Workbench-Test-Workspace": "permission-readiness-workspace",
        },
      });
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("permission_product_server_start_timeout");
}

function runSwift(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn("swift", ["scripts/permission-state-smoke.swift"], {
      cwd: webRoot,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: "/private/tmp/loopops-web-audit-clang",
        LOOPOPS_WEB_URL: `${origin}/`,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`permission_swift_failed:${code ?? signal}`));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const cleanupStore = new ProductMongoStore({ uri: mongoUri, dbName: databaseName });
let productServer;

try {
  await cleanupStore.connect();
  await cleanupStore.dropTestDatabase();
  await cleanupStore.close();

  productServer = spawn(process.execPath, [serverEntry], {
    cwd: serverRoot,
    env: {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_TEST_MODE: "1",
      WECHAT_AGENT_TEST_MODE: "1",
      PI_OFFLINE: "1",
      MONGODB_URI: mongoUri,
      MONGODB_DB: databaseName,
      WORKBENCH_MONGODB_DB: databaseName,
      WORKBENCH_OBJECT_STORE_ROOT: join(temporaryRoot, "objects"),
      WECHAT_AGENT_RUNTIME_ROOT: join(temporaryRoot, "runtime"),
      WORKBENCH_WEB_DIST: join(webRoot, "dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  productServer.stdout.on("data", (chunk) => { serverLog += chunk; });
  productServer.stderr.on("data", (chunk) => { serverLog += chunk; });
  try {
    await waitForServer(origin, productServer);
    await runSwift(origin);
  } catch (error) {
    if (serverLog.trim()) process.stderr.write(serverLog);
    throw error;
  }
} finally {
  await stop(productServer);
  const store = new ProductMongoStore({ uri: mongoUri, dbName: databaseName });
  try {
    await store.connect();
    await store.dropTestDatabase();
  } finally {
    await store.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
