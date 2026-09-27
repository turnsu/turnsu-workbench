import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_ROOT = resolve(SERVER_ROOT, "../../../..");
const SERVER_SOURCE_ROOT = resolve(SERVER_ROOT, "src");
const WEB_SOURCE_ROOT = resolve(REPOSITORY_ROOT, "domains/frontend/web/code/web-prototype/src");
const AGENT_SOURCE_ROOT = resolve(REPOSITORY_ROOT, "domains/agent/code/agent-runtime");
const AGENT_HARNESS_PACKAGE_ROOTS = [
  AGENT_SOURCE_ROOT,
  resolve(REPOSITORY_ROOT, "domains/agent/code/agent-kernel"),
  resolve(REPOSITORY_ROOT, "domains/agent/code/agent-kernel-pi"),
  resolve(REPOSITORY_ROOT, "domains/agent/code/agent-kernel-product-bridge"),
  resolve(REPOSITORY_ROOT, "domains/agent/code/plugins"),
];

async function sourceFiles(root, { extensions = [".mjs", ".js", ".jsx", ".ts", ".tsx"] } = {}) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "test", "tests"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

function importSpecifiers(source) {
  const specifiers = [];
  const staticImport = /^\s*(?:import|export)\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/gmu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const inside = (path, root) => path === root || path.startsWith(`${root}${sep}`);
const repositoryPath = (path) => relative(REPOSITORY_ROOT, path).split(sep).join("/");

async function relativeImportViolations(root, allowedRoots) {
  const violations = [];
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (!allowedRoots.some((allowedRoot) => inside(target, allowedRoot))) {
        violations.push({ file: repositoryPath(file), specifier });
      }
    }
  }
  return violations;
}

test("active Web and Agent packages cannot import across the Product control-plane boundary", async () => {
  assert.deepEqual(
    await relativeImportViolations(WEB_SOURCE_ROOT, [WEB_SOURCE_ROOT]),
    [],
    "Web source must use the Product API client and cannot deep-import Backend or Agent code",
  );
  assert.deepEqual(
    await relativeImportViolations(AGENT_SOURCE_ROOT, AGENT_HARNESS_PACKAGE_ROOTS),
    [],
    "Agent Worker code may use the declared Harness packages, but cannot import Product HTTP, store, Runner, or Web internals",
  );
});

test("HTTP adapters import Product application/security boundaries rather than Runner or Broker internals", async () => {
  const forbidden = [];
  const httpRoot = resolve(SERVER_SOURCE_ROOT, "http");
  for (const file of await sourceFiles(httpRoot, { extensions: [".mjs"] })) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (["runner", "execution", "agents", "skills"].some((owner) =>
        inside(target, resolve(SERVER_SOURCE_ROOT, owner)))) {
        forbidden.push({ file: repositoryPath(file), specifier });
      }
    }
  }
  assert.deepEqual(forbidden, []);
});

test("direct execution dispatch remains limited to Product-owned Runner and Agent services", async () => {
  const owners = [];
  for (const file of await sourceFiles(SERVER_SOURCE_ROOT, { extensions: [".mjs"] })) {
    const source = await readFile(file, "utf8");
    if (/(?:this\.)?#?executionBroker\.execute\s*\(/u.test(source)) {
      owners.push(repositoryPath(file).replace("domains/backend/code/workbench-server/src/", ""));
    }
  }
  assert.deepEqual(owners.sort(), [
    "agents/agent-turn-runner.mjs",
    "application/workbench-application.mjs",
    "runner/workflow-runner.mjs",
  ]);
});

test("Session, Turn, and Run creation stays inside the Product application or an explicit Product lifecycle", async () => {
  const callers = [];
  const patterns = [
    /\bagentTurnRunner\.(?:createSession|enqueueTurn)\s*\(/u,
    /\brunner\.(?:startRun|startRunWithCompanion)\s*\(/u,
  ];
  for (const file of await sourceFiles(SERVER_SOURCE_ROOT, { extensions: [".mjs"] })) {
    const source = await readFile(file, "utf8");
    if (patterns.some((pattern) => pattern.test(source))) {
      callers.push(repositoryPath(file).replace("domains/backend/code/workbench-server/src/", ""));
    }
  }
  assert.deepEqual(callers, [
    "application/workbench-application.mjs",
    "work-items/postgres-work-item-promotion-lifecycle.mjs",
  ]);
});

test("the retired Agent daemon is absent and raw ProductCommand writes stay absent", async () => {
  await assert.rejects(
    readFile(resolve(AGENT_SOURCE_ROOT, "bin/wechat-agent-daemon.mjs"), "utf8"),
    (error) => error?.code === "ENOENT",
  );

  const rawWriters = [];
  for (const file of await sourceFiles(SERVER_SOURCE_ROOT, { extensions: [".mjs"] })) {
    const source = await readFile(file, "utf8");
    if (/productCommands\.(?:insert|patch|update|upsert|collection)\b/u.test(source)) {
      rawWriters.push(repositoryPath(file));
    }
  }
  assert.deepEqual(rawWriters, []);
});
