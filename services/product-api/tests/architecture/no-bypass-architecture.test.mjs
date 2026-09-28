import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(TEST_DIR, "../..");
const REPOSITORY_ROOT = resolve(SERVER_ROOT, "../..");
const BACKEND_SOURCE = resolve(SERVER_ROOT, "src");
const WEB_SOURCE = resolve(REPOSITORY_ROOT, "apps/team-web/src");

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);

const COMPOSITION_CONSTRUCTORS = new Set([
  "CommandIntakeService",
  "AdmissionController",
  "ExecutionBroker",
  "AdmittedExecutionDispatcher",
]);

const COMPOSITION_ROOTS = new Set([
  "src/server.mjs",
]);

// This class is a test double. The companion assertion below prevents deployable
// source from consuming it, so unit tests do not need to recreate the server root.
const TEST_DOUBLE_CONSTRUCTOR_ALLOWLIST = new Map([
  ["CommandIntakeService", new Set(["src/agents/agent-persistence.mjs"])],
]);

const DIRECT_EXECUTION_OWNERS = new Set([
  "src/agents/agent-turn-runner.mjs",
  "src/application/workbench-application.mjs",
  "src/execution/admission-controller.mjs",
  "src/execution/execution-broker.mjs",
  // Accepted member-to-member requests are Product Commands; this owner submits
  // them through the admitted dispatcher after consent and device checks.
  "src/member-agents/postgres-member-agent-service.mjs",
  "src/runner/workflow-runner.mjs",
  "src/skills/skill-test-runner.mjs",
  "src/skills/skill-validation-composition.mjs",
  "src/tools/durable-lark-tool-executor.mjs",
]);

const WEB_NETWORK_OWNERS = new Set([
  "src/api/client.js",
]);

const AGENT_RUNTIME_PUBLIC_EXPORT = "@turnsu/agent-runtime";
// The repository is not packaged as a workspace dependency yet, so these
// source imports are the explicitly versioned public entrypoint. Backend code
// may use this one module, never Agent Runtime internals, Pi, or extensions.
const AGENT_RUNTIME_PUBLIC_ENTRYPOINTS = new Set([
  "../../../../packages/agent-runtime/public-api.mjs",
]);

const extensionOf = (path) => path.slice(path.lastIndexOf("."));
const normalizePath = (path) => path.replaceAll("\\", "/");
const serverRelative = (path) => normalizePath(relative(SERVER_ROOT, path));
const webRelative = (path) => normalizePath(relative(resolve(WEB_SOURCE, ".."), path));

const sourceFiles = async (root) => {
  const found = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (SOURCE_EXTENSIONS.has(extensionOf(entry.name))) found.push(path);
    }
  };
  await visit(root);
  return found.sort();
};

const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;

const matches = (source, expression) => [...source.matchAll(expression)].map((match) => ({
  match,
  line: lineAt(source, match.index),
}));

const importsFrom = (source) => {
  const imports = [];
  const staticImport = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^;"']*?\sfrom\s*)?["']([^"']+)["']/gm;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const { match } of matches(source, staticImport)) {
    imports.push({ specifier: match[1], line: lineAt(source, match.index + match[0].indexOf(match[1])) });
  }
  for (const { match } of matches(source, dynamicImport)) {
    imports.push({ specifier: match[1], line: lineAt(source, match.index + match[0].indexOf(match[1])) });
  }
  return imports;
};

const failWithViolations = (rule, violations) => {
  assert.deepEqual(
    violations,
    [],
    `${rule}\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
  );
};

test("coordination and execution services are constructed only by the composition root", async () => {
  const violations = [];
  for (const path of await sourceFiles(BACKEND_SOURCE)) {
    const file = serverRelative(path);
    const source = await readFile(path, "utf8");
    for (const service of COMPOSITION_CONSTRUCTORS) {
      const expression = new RegExp(`\\bnew\\s+${service}\\s*\\(`, "g");
      for (const { line } of matches(source, expression)) {
        const testDoubleFiles = TEST_DOUBLE_CONSTRUCTOR_ALLOWLIST.get(service) ?? new Set();
        if (!COMPOSITION_ROOTS.has(file) && !testDoubleFiles.has(file)) {
          violations.push(`${file}:${line} constructs ${service}; inject the Product-owned singleton instead`);
        }
      }
    }
  }
  failWithViolations("composition_only_construction", violations);
});

test("the in-memory Agent persistence composition remains test-only", async () => {
  const violations = [];
  for (const path of await sourceFiles(BACKEND_SOURCE)) {
    const file = serverRelative(path);
    if (file === "src/agents/agent-persistence.mjs" || file === "src/agents/index.mjs") continue;
    const source = await readFile(path, "utf8");
    for (const { line } of matches(source, /\bInMemoryAgentPersistence\b/g)) {
      violations.push(`${file}:${line} consumes the test-only InMemoryAgentPersistence`);
    }
  }
  failWithViolations("in_memory_persistence_not_in_deployable_closure", violations);
});

test("HTTP, connector, scheduler and client layers cannot import product internals", async () => {
  const violations = [];
  const backendFiles = await sourceFiles(BACKEND_SOURCE);
  const webFiles = await sourceFiles(WEB_SOURCE);
  for (const path of [...backendFiles, ...webFiles]) {
    const isBackend = path.startsWith(`${BACKEND_SOURCE}/`);
    const file = isBackend ? serverRelative(path) : `web/${webRelative(path)}`;
    const isBoundary = !isBackend
      || /^src\/(http|connectors?|schedulers?|desktop|web)\//.test(file)
      || /^src\/operations\/.*http-handler\./.test(file);
    if (!isBoundary) continue;
    const source = await readFile(path, "utf8");
    for (const imported of importsFrom(source)) {
      const resolved = imported.specifier.startsWith(".")
        ? normalizePath(relative(SERVER_ROOT, resolve(dirname(path), imported.specifier)))
        : imported.specifier;
      const forbidden = /(^|\/)src\/(runner|execution|runtime|store)(\/|$)/.test(resolved)
        || /(^|\/)agent-runtime(\/|$)/.test(resolved);
      if (forbidden) {
        violations.push(`${file}:${imported.line} imports ${imported.specifier}; call the Product API/application port instead`);
      }
    }
  }
  failWithViolations("boundary_layers_do_not_import_product_internals", violations);
});

test("direct execution calls stay inside declared Product execution owners", async () => {
  const violations = [];
  for (const path of await sourceFiles(BACKEND_SOURCE)) {
    const file = serverRelative(path);
    const source = await readFile(path, "utf8");
    const directCalls = [
      ...matches(source, /\.execute\s*\(/g),
      ...matches(source, /\.invokeSkillNode\s*\(/g),
    ];
    if (directCalls.length > 0 && !DIRECT_EXECUTION_OWNERS.has(file)) {
      for (const { line } of directCalls) {
        violations.push(`${file}:${line} calls execution directly; route through an admitted Product owner`);
      }
    }
  }
  failWithViolations("direct_execution_owner_boundary", violations);
});

test("Skill Test runner reads Product Commands only through CommandIntakeService", async () => {
  const source = await readFile(resolve(BACKEND_SOURCE, "skills/skill-test-runner.mjs"), "utf8");
  assert.equal(
    /repositories\.productCommands\b/.test(source),
    false,
    "skill-test-runner must not create a second ProductCommand read owner",
  );
  assert.match(source, /#commandIntake\.(?:recover|recoverByLineage|listRecoverable)\s*\(/);
});

test("Product code reaches Agent Runtime only through its public entrypoint", async () => {
  const violations = [];
  for (const path of await sourceFiles(BACKEND_SOURCE)) {
    const file = serverRelative(path);
    const source = await readFile(path, "utf8");
    for (const imported of importsFrom(source)) {
      if (imported.specifier === AGENT_RUNTIME_PUBLIC_EXPORT
        || AGENT_RUNTIME_PUBLIC_ENTRYPOINTS.has(imported.specifier)) continue;
      const isRepositoryDeepImport = imported.specifier.includes("agent/code/agent-runtime");
      const isPackageDeepImport = imported.specifier.startsWith(`${AGENT_RUNTIME_PUBLIC_EXPORT}/`)
        || imported.specifier === "@turnsu/agent-runtime"
        || imported.specifier.startsWith("@turnsu/agent-runtime/");
      if (!isRepositoryDeepImport && !isPackageDeepImport) continue;
      const key = `${file}::${imported.specifier}`;
      if (!isRepositoryDeepImport) {
        violations.push(`${file}:${imported.line} deep-imports ${imported.specifier}; use the Agent Runtime public package export`);
      } else {
        violations.push(`${file}:${imported.line} deep-imports ${imported.specifier}; use Agent Runtime public-api.mjs`);
      }
    }
  }
  failWithViolations("agent_runtime_public_entrypoint_boundary", violations);
});

test("browser networking stays in the Product API client or explicit media transport", async () => {
  const violations = [];
  const networkExpression = /\bfetch\s*\(|\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(|\bnavigator\.sendBeacon\s*\(/g;
  for (const path of await sourceFiles(WEB_SOURCE)) {
    const file = webRelative(path);
    const source = await readFile(path, "utf8");
    for (const { line } of matches(source, networkExpression)) {
      if (!WEB_NETWORK_OWNERS.has(file)) {
        violations.push(`${file}:${line} opens a browser network channel outside the Product API/media transport boundary`);
      }
    }
  }
  failWithViolations("browser_network_owner_boundary", violations);
});
