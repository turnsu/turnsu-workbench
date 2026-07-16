import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptRoot, "..");
const repositoryRoot = resolve(webRoot, "../../../../..");
const webSourceRoot = join(webRoot, "src");
const agentRoot = join(repositoryRoot, "domains/agent/code/agent-runtime");

async function sourceFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:js|jsx|mjs|ts|tsx)$/.test(entry.name)) result.push(path);
    }
  }
  await visit(root);
  return result;
}

async function matches(files, pattern) {
  const found = [];
  for (const path of files) {
    const source = await readFile(path, "utf8");
    if (pattern.test(source)) found.push(relative(repositoryRoot, path));
  }
  return found;
}

const webFiles = await sourceFiles(webSourceRoot);
const agentFiles = await sourceFiles(agentRoot);
const forbiddenWebOwners = [
  ["legacy client model", /loopopsModel|startMockRun|compileWorkflowGraph/],
  ["direct Agent daemon access", /wechat-agent-daemon|\/api\/agent|daemonToken|Bearer\s+/i],
  ["raw execution internals", /artifactPath|executionRef|packageHash|providerPayload|toolName/],
  ["production fixture catalogs", /loopopsSeed|workflowLibrary|runLedgers|skillCatalog/],
];

for (const [label, pattern] of forbiddenWebOwners) {
  assert.deepEqual(await matches(webFiles, pattern), [], `${label} regained browser authority`);
}

assert.deepEqual(
  await matches(agentFiles, /\/api\/workbench\/v1|WORKBENCH_V1_ENDPOINTS/),
  [],
  "The legacy Agent runtime must not own Product API routes",
);

const persistenceOwners = await matches(webFiles, /localStorage|sessionStorage/);
assert.deepEqual(
  persistenceOwners.sort(),
  [
    "domains/frontend/web/code/web-prototype/src/state/editor/useWorkflowEditor.js",
    "domains/frontend/web/code/web-prototype/src/state/ui/useWorkspaceUi.js",
  ],
  "Browser persistence must remain limited to unsaved editor drafts and UI preferences",
);

const clientSource = await readFile(join(webSourceRoot, "api/client.js"), "utf8");
assert.match(clientSource, /const API_PREFIX = "\/api\/workbench\/v1"/);
assert.doesNotMatch(clientSource, /https?:\/\/|127\.0\.0\.1|localhost|Authorization/);

console.log("v1_production_owner_audit=pass");
console.log(`v1_production_owner_audit_web_files=${webFiles.length}`);
console.log(`v1_production_owner_audit_agent_files=${agentFiles.length}`);
console.log(`v1_production_owner_audit_persistence=${persistenceOwners.length}`);
