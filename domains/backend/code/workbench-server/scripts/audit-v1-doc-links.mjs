import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../../../..");
const explicitDocuments = [
  "wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md",
  "DESIGN.md",
  "PRODUCT.md",
];
const documentDirectories = [
  "wiki/design/skill-loop-cloud-workbench-v1",
];

const documents = [
  ...explicitDocuments.map((path) => resolve(repositoryRoot, path)),
  ...await collectMarkdownDocuments(documentDirectories.map((path) => resolve(repositoryRoot, path))),
];
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

async function collectMarkdownDocuments(roots) {
  const found = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && extname(entry.name) === ".md") found.push(path);
    }
  }
  return found;
}
