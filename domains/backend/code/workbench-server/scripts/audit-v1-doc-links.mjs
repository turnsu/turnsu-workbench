import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../../../..");
const explicitDocuments = [
  "README.md",
  "PRODUCT.md",
  "DESIGN.md",
  "wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md",
  "wiki/prd/2026-08-04-cross-review-master-prd-vs-blueprint.md",
  "wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md",
  "wiki/architecture/README.md",
  "wiki/prd/README.md",
  "wiki/history/README.md",
  "domains/backend/documents/operations/SINGLE_MACHINE_RUNBOOK.md",
];
const documents = explicitDocuments.map((path) => resolve(repositoryRoot, path));
const missing = [];
let localLinkCount = 0;

for (const document of [...new Set(documents)].sort()) {
  const source = await readFile(document, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "").split(/\s+["']/u, 1)[0];
    if (!rawTarget || rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)) continue;
    const pathPart = decodeURIComponent(rawTarget.split("#", 1)[0]);
    if (!pathPart) continue;
    localLinkCount += 1;
    const target = isAbsolute(pathPart) ? resolve(pathPart) : resolve(dirname(document), pathPart);
    try {
      await stat(target);
    } catch {
      missing.push({
        document: document.slice(repositoryRoot.length + 1),
        target: rawTarget,
      });
    }
  }
}

if (missing.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: "failed", missing }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`v1_document_link_audit=pass\n`);
  process.stdout.write(`v1_document_count=${documents.length}\n`);
  process.stdout.write(`v1_local_link_count=${localLinkCount}\n`);
}
