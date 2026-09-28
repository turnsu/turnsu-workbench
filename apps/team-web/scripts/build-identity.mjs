import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_IDENTITY_SCHEMA = "looloomi-web-build-v1";

const sourceInputs = Object.freeze([
  "src",
  "build",
  "index.html",
  "vite.config.mjs",
  "package.json",
  "package-lock.json",
]);

function filesUnder(root, entries, { exclude = new Set() } = {}) {
  const files = [];
  const visit = (relativePath) => {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) return;
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(relativePath, child));
      }
      return;
    }
    const normalized = relativePath.split(path.sep).join("/");
    if (!exclude.has(normalized)) files.push(normalized);
  };
  for (const entry of entries) visit(entry);
  return files.sort();
}

function contentIdentity(root, files) {
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relativePath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function computeSourceIdentity(root) {
  return contentIdentity(root, filesUnder(root, sourceInputs));
}

export function computeDistIdentity(dist) {
  const files = filesUnder(dist, ["index.html", ".vite", "assets"], {
    exclude: new Set(["build-identity.json"]),
  });
  if (files.length === 0) throw new Error("web_build_assets_missing");
  return contentIdentity(dist, files);
}

export function createBuildIdentity(root) {
  const dist = path.join(root, "dist");
  const viteManifestPath = path.join(dist, ".vite", "manifest.json");
  if (!fs.existsSync(viteManifestPath)) throw new Error("vite_manifest_missing");
  const viteManifest = JSON.parse(fs.readFileSync(viteManifestPath, "utf8"));
  const entryFile = viteManifest["index.html"]?.file;
  if (!entryFile || !fs.existsSync(path.join(dist, entryFile))) {
    throw new Error("vite_entry_missing");
  }
  return {
    schemaVersion: BUILD_IDENTITY_SCHEMA,
    sourceIdentity: computeSourceIdentity(root),
    buildIdentity: computeDistIdentity(dist),
    entryFile,
    builtAt: new Date().toISOString(),
  };
}

function isMainModule() {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const identity = createBuildIdentity(root);
  fs.writeFileSync(
    path.join(root, "dist", "build-identity.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  process.stdout.write(`${identity.buildIdentity}\n`);
}
