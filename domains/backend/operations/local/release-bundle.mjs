import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const LOCAL_RELEASE_ENTRIES = Object.freeze([
  ".tooling/node/LICENSE",
  ".tooling/node/bin/node",
  "docker-compose.yml",
  "domains/backend/code/workbench-contracts/dist",
  "domains/backend/code/workbench-contracts/examples",
  "domains/backend/code/workbench-contracts/package.json",
  "domains/backend/code/workbench-server/bin",
  "domains/backend/code/workbench-server/node_modules",
  "domains/backend/code/workbench-server/package-lock.json",
  "domains/backend/code/workbench-server/package.json",
  "domains/backend/code/workbench-server/scripts",
  "domains/backend/code/workbench-server/src",
  "domains/backend/operations",
  "domains/agent/code/agent-runtime/bin",
  "domains/agent/code/agent-runtime/control-plane",
  "domains/agent/code/agent-runtime/core",
  "domains/agent/code/agent-runtime/extensions",
  "domains/agent/code/agent-runtime/kernels",
  "domains/agent/code/agent-runtime/lib",
  "domains/agent/code/agent-runtime/node_modules",
  "domains/agent/code/agent-runtime/package-lock.json",
  "domains/agent/code/agent-runtime/package.json",
  "domains/agent/code/agent-runtime/prompts",
  "domains/agent/code/agent-runtime/runtime",
  "domains/agent/code/agent-runtime/skills",
  "domains/agent/code/agent-runtime/worker",
  "domains/agent/image",
  "domains/frontend/web/code/web-prototype/dist",
]);

export async function stageLocalRelease({ sourceRoot, destination, entries = LOCAL_RELEASE_ENTRIES } = {}) {
  const source = resolve(sourceRoot || "");
  const target = resolve(destination || "");
  if (!isAbsolute(sourceRoot || "") || !isAbsolute(destination || "") || source === target
    || relative(source, target) === "" || !relative(source, target).startsWith("..")
    || !Array.isArray(entries) || entries.length === 0) {
    throw releaseBundleError("release_stage_input_invalid");
  }
  try {
    await lstat(target);
    throw releaseBundleError("release_stage_destination_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of [...new Set(entries)].sort()) {
    const path = safeRelativePath(entry);
    const from = join(source, path);
    const to = join(target, path);
    const info = await lstat(from);
    if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
      throw releaseBundleError("release_stage_source_invalid");
    }
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await cp(from, to, {
      recursive: info.isDirectory() || info.isSymbolicLink(),
      dereference: true,
      errorOnExist: true,
      force: false,
      filter: (candidate) => !candidate.endsWith("/.DS_Store") && !candidate.includes("/.cache/"),
    });
  }
  const files = await inspectTree(target);
  if (files.some((item) => item.symbolicLink)) throw releaseBundleError("release_stage_symlink_detected");
  return { destination: target, entries: entries.length, files: files.length };
}

async function inspectTree(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await inspectTree(root, path));
    else result.push({ path, symbolicLink: entry.isSymbolicLink() });
  }
  return result;
}

function safeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")
    || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw releaseBundleError("release_stage_path_invalid");
  }
  return path;
}

function releaseBundleError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
