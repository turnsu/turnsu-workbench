import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/+:~-]*@)?sha256:[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_TREE = /^[a-f0-9]{40}$/;

export async function buildReleaseManifest({ root, version, files, agentImage, skillImage, mongoImage, frontendTreeHash } = {}) {
  if (!VERSION.test(version || "") || !Array.isArray(files) || files.length === 0
    || !DIGEST_IMAGE.test(agentImage || "") || !DIGEST_IMAGE.test(skillImage || "")
    || !DIGEST_IMAGE.test(mongoImage || "") || !GIT_TREE.test(frontendTreeHash || "")) {
    throw new TypeError("release_manifest_input_invalid");
  }
  const normalized = [...new Set(files.map(safeRelativePath))].sort();
  const entries = [];
  for (const path of normalized) {
    const absolute = inside(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw releaseError("release_file_invalid");
    entries.push({ path, bytes: info.size, digest: await fileDigest(absolute) });
  }
  return Object.freeze({
    schemaVersion: "looloomi-local-release-v1",
    version,
    agentImage,
    skillImage,
    mongoImage,
    frontendTreeHash,
    files: entries,
  });
}

export async function verifyReleaseManifest({ root, manifest } = {}) {
  validateManifest(manifest);
  for (const entry of manifest.files) {
    const path = safeRelativePath(entry.path);
    const absolute = inside(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes
      || await fileDigest(absolute) !== entry.digest) {
      throw releaseError("release_integrity_failed");
    }
  }
  return { ok: true, version: manifest.version, files: manifest.files.length };
}

export async function activateRelease({ bundleRoot, installRoot, healthCheck = async () => true } = {}) {
  if (typeof healthCheck !== "function") throw new TypeError("release_health_check_invalid");
  const manifest = JSON.parse(await readFile(join(bundleRoot, "release-manifest.json"), "utf8"));
  await verifyReleaseManifest({ root: bundleRoot, manifest });
  const releases = join(installRoot, "releases");
  const destination = join(releases, manifest.version);
  const staging = join(releases, `.${manifest.version}.staging-${process.pid}`);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  try {
    await lstat(destination);
    throw releaseError("release_version_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(staging, { recursive: true, force: true });
  await cp(bundleRoot, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
  try {
    await verifyReleaseManifest({ root: staging, manifest });
    if (await healthCheck(staging, manifest) !== true) throw releaseError("release_health_check_failed");
    await rename(staging, destination);
    const current = join(installRoot, "current");
    const previous = await existingLink(current);
    await writeReleaseState(installRoot, { current: destination, previous, version: manifest.version });
    await switchLink(current, destination);
    return { activated: destination, previous, version: manifest.version };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function rollbackRelease({ installRoot } = {}) {
  let state;
  try { state = JSON.parse(await readFile(join(installRoot, "release-state.json"), "utf8")); } catch {
    throw releaseError("release_rollback_unavailable");
  }
  if (typeof state.previous !== "string" || !insideInstall(installRoot, state.previous)) {
    throw releaseError("release_rollback_unavailable");
  }
  const info = await lstat(state.previous);
  if (!info.isDirectory()) throw releaseError("release_rollback_unavailable");
  const current = join(installRoot, "current");
  await switchLink(current, state.previous);
  await writeReleaseState(installRoot, {
    current: state.previous,
    previous: state.current,
    version: state.previous.split("/").at(-1),
  });
  return { activated: state.previous, previous: state.current };
}

async function switchLink(path, target) {
  const temporary = `${path}.next-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(target, temporary, "dir");
  await rename(temporary, path);
}

async function writeReleaseState(root, value) {
  const path = join(root, "release-state.json");
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function existingLink(path) {
  try { return await readlink(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw releaseError("release_current_link_invalid");
  }
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== "looloomi-local-release-v1" || !VERSION.test(manifest.version || "")
    || !DIGEST_IMAGE.test(manifest.agentImage || "") || !DIGEST_IMAGE.test(manifest.skillImage || "")
    || !DIGEST_IMAGE.test(manifest.mongoImage || "")
    || !GIT_TREE.test(manifest.frontendTreeHash || "")
    || !Array.isArray(manifest.files) || manifest.files.length === 0
    || new Set(manifest.files.map((item) => item?.path)).size !== manifest.files.length
    || manifest.files.some((item) => !Number.isSafeInteger(item?.bytes) || item.bytes < 0 || !SHA256.test(item?.digest || ""))) {
    throw releaseError("release_manifest_invalid");
  }
  for (const item of manifest.files) safeRelativePath(item.path);
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function safeRelativePath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 1024 || path.includes("\\")) {
    throw releaseError("release_path_invalid");
  }
  const normalized = path.replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw releaseError("release_path_invalid");
  }
  return normalized;
}

function inside(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, path);
  if (relative(absoluteRoot, absolute).startsWith("..") || dirname(absolute) === absolute) throw releaseError("release_path_invalid");
  return absolute;
}

function insideInstall(root, path) {
  const releases = resolve(root, "releases");
  const target = resolve(path);
  return target.startsWith(`${releases}/`);
}

function releaseError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
