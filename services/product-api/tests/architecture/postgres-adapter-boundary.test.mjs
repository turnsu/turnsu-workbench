import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(TEST_DIR, "../..");
const BACKEND_SOURCE = resolve(SERVER_ROOT, "src");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);

const normalizePath = (path) => path.replaceAll("\\", "/");
const serverRelative = (path) => normalizePath(relative(SERVER_ROOT, path));

const sourceFiles = async (root) => {
  const found = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path);
    }
  };
  await visit(root);
  return found.sort();
};

const isPostgresAdapter = (file) => (
  /^src\/(agents|artifacts|attachments|auth|authorization|automations|connections|coordination|devices|execution|inbox|loops|member-agents|memory|models|resources|runner|security|skills|tools|work-items)\/postgres(?:-|\/)/.test(file)
  || file === "src/execution/capacity-persistence.mjs"
);

const isApprovedBindAdapterOwner = (file) => (
  file === "src/server.mjs"
  || file.startsWith("src/store/postgres/")
  || file === "src/store/core-semantics/postgres-core-semantics.mjs"
  || isPostgresAdapter(file)
);

const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;

const failWithViolations = (rule, violations) => {
  assert.deepEqual(
    violations,
    [],
    `${rule}\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
  );
};

test("bindAdapter is reserved for the PostgreSQL store, adapters, and composition root", async () => {
  assert.equal(isApprovedBindAdapterOwner("src/agents/postgres-agent-persistence.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/auth/postgres-auth-persistence.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/execution/postgres/execution-persistence.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/runner/postgres-workflow-run-persistence.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/skills/postgres-skill-read-model.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/loops/postgres-workflow-read-model.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/work-items/postgres-work-item-promotion-lifecycle.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/devices/postgres-device-lifecycle.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/member-agents/postgres-member-agent-service.mjs"), true);
  assert.equal(isApprovedBindAdapterOwner("src/application/workbench-application.mjs"), false);
  assert.equal(isApprovedBindAdapterOwner("src/runner/workflow-runner.mjs"), false);

  const violations = [];
  for (const path of await sourceFiles(BACKEND_SOURCE)) {
    const file = serverRelative(path);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/\bbindAdapter\b/g)) {
      if (!isApprovedBindAdapterOwner(file)) {
        violations.push(
          `${file}:${lineAt(source, match.index)} accesses bindAdapter; inject a semantic persistence port instead`,
        );
      }
    }
  }
  failWithViolations("postgres_bind_adapter_owner_boundary", violations);
});

test("PostgreSQL adapters cannot own or expose the raw database capability", async () => {
  const violations = [];
  for (const path of await sourceFiles(BACKEND_SOURCE)) {
    const file = serverRelative(path);
    if (!isPostgresAdapter(file)) continue;
    const source = await readFile(path, "utf8");

    const forbidden = [
      { expression: /(?:from\s*|import\s*)["']pg["']/g, reason: "imports pg instead of using the bound execute capability" },
      { expression: /\bimport\s*\(\s*["']pg["']\s*\)/g, reason: "imports pg instead of using the bound execute capability" },
      { expression: /\b(?:client|pool)\.query\s*\(/g, reason: "uses a raw PostgreSQL client" },
      {
        expression: /(?:=>|return)\s*(?:Object\.freeze\s*\(\s*)?\(?\s*\{[^{}]{0,500}\b(?:execute|client|pool)\s*(?:[,}])/g,
        reason: "returns a raw persistence capability",
      },
      { expression: /\b(?:execute|client|pool)\s*:\s*(?:execute|client|pool)\b/g, reason: "aliases a raw persistence capability onto its public surface" },
      { expression: /\bexport\s+(?:const|let|var|function|class)\s+(?:execute|client|pool)\b/g, reason: "exports a raw persistence capability" },
      { expression: /\bexport\s+default\s+(?:execute|client|pool)\b/g, reason: "exports a raw persistence capability" },
      { expression: /\bexport\s*\{[^}]*\b(?:execute|client|pool)\b[^}]*}/gs, reason: "exports a raw persistence capability" },
    ];

    for (const { expression, reason } of forbidden) {
      for (const match of source.matchAll(expression)) {
        violations.push(`${file}:${lineAt(source, match.index)} ${reason}`);
      }
    }
  }
  failWithViolations("postgres_adapter_capability_does_not_escape", violations);
});
