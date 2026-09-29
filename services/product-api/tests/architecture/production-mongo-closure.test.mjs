import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(serverRoot, "../..");
const forbiddenImport = /product-mongo-store|mongo-[a-z]|from\s*["']mongodb["']|encrypted-mongo-backup/;
const forbiddenRuntimeConfig = /WORKBENCH_MONGO_|mongodb(?:\+srv)?:\/\/|(?:^|[^a-z])mongo(?:db)?(?:[^a-z]|$)|27017/i;

test("the production server import closure contains no Mongo owner or driver", async () => {
  const visited = new Set();
  const violations = [];

  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(file, "utf8");
    if (forbiddenImport.test(source)) violations.push(file);
    const specifiers = [
      ...source.matchAll(/(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g),
      ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const base = resolve(dirname(file), specifier);
      for (const candidate of [base, `${base}.mjs`, `${base}.js`, resolve(base, "index.mjs")]) {
        try {
          await readFile(candidate);
          await visit(candidate);
          break;
        } catch {
          // Try the next Node-compatible local resolution.
        }
      }
    }
  }

  await visit(resolve(serverRoot, "src/server.mjs"));
  assert.deepEqual(violations, []);
});

test("production packages, locks, startup, and compose contain no Mongo executable path", async () => {
  const packageFiles = [
    resolve(serverRoot, "package.json"),
    resolve(repositoryRoot, "packages/agent-runtime/package.json"),
    resolve(repositoryRoot, "apps/team-web/package.json"),
  ];
  const lockFiles = [
    resolve(serverRoot, "package-lock.json"),
    resolve(repositoryRoot, "packages/agent-runtime/package-lock.json"),
    resolve(repositoryRoot, "apps/team-web/package-lock.json"),
  ];
  const runtimeFiles = [
    resolve(repositoryRoot, ".env.example"),
    resolve(repositoryRoot, "docker-compose.yml"),
    resolve(repositoryRoot, "scripts/start-workbench-server.sh"),
    resolve(repositoryRoot, "services/product-api/operations/workbench-local.mjs"),
    resolve(repositoryRoot, "services/product-api/operations/postgres-backup-restore.mjs"),
    resolve(repositoryRoot, "services/product-api/operations/postgres-release.mjs"),
  ];
  const violations = [];

  for (const file of packageFiles) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (/mongo/i.test(dependency)) violations.push(`${file}:${section}:${dependency}`);
      }
    }
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (/mongo/i.test(`${name} ${command}`)) violations.push(`${file}:scripts:${name}`);
    }
  }

  for (const file of lockFiles) {
    const lock = JSON.parse(await readFile(file, "utf8"));
    for (const packagePath of Object.keys(lock.packages ?? {})) {
      if (/(?:^|node_modules\/)@?[^/]*mongo/i.test(packagePath)) {
        violations.push(`${file}:packages:${packagePath}`);
      }
    }
  }

  for (const file of runtimeFiles) {
    const source = await readFile(file, "utf8");
    if (forbiddenRuntimeConfig.test(source)) violations.push(file);
  }

  assert.deepEqual(violations, []);
});
