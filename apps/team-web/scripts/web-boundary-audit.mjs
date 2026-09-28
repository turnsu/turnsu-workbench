import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkbenchApiClient, WorkbenchApiError } from "../src/api/client.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptRoot, "..");
const sourceRoot = join(webRoot, "src");

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if ([".js", ".jsx", ".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function importedSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

const sourceFiles = await walk(sourceRoot);
for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  for (const specifier of importedSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    assert.ok(
      target === sourceRoot || target.startsWith(`${sourceRoot}/`),
      `${relative(webRoot, file)} crosses the Web package boundary via ${specifier}`,
    );
  }
}

const requests = [];
const client = createWorkbenchApiClient({
  fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: {
        registrationOpen: false,
        bootstrapRequired: false,
        bootstrapAvailable: false,
        authenticated: false,
      },
      requestId: "request-auth-status-audit",
    }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
  reviewMode: "visual-only",
});
await client.authStatus();
assert.equal(requests[0]?.url, "/api/workbench/v1/auth/status");
assert.equal(requests[0]?.options?.credentials, "same-origin");
await assert.rejects(
  () => client.startRun("workflow-1", {}),
  (error) => error instanceof WorkbenchApiError && error.code === "visual_review_mutation_forbidden",
);
assert.equal(requests.length, 1, "visual review mutations must stop before transport");

console.log("web_boundary_audit=pass");
console.log("web_boundary_audit_scope=structural-import-and-product-api-entry");
console.log("web_functional_evidence=false");
