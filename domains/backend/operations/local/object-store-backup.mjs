import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { decryptBackupStream, encryptBackupStream } from "./encrypted-mongo-backup.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OBJECT_RECORD_FORMAT = "workbench-object-store-v1";

export async function createObjectStoreBackup({ root, destination, key, spawnProcess = spawn } = {}) {
  const sourceRoot = await safeDirectory(root);
  const before = await snapshotObjectStore(sourceRoot);
  const child = spawnProcess("/usr/bin/tar", ["-C", sourceRoot, "-cf", "-", "."], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exit = childExit(child);
  try {
    await encryptBackupStream({ source: child.stdout, destination, key });
    const result = await exit;
    if (result.code !== 0) throw backupError("object_store_backup_failed");
    const after = await snapshotObjectStore(sourceRoot);
    assertSameEntries(before.entries, after.entries);
    return Object.freeze({
      archive: destination,
      files: before.entries,
      artifactsVerified: before.artifactsVerified,
    });
  } catch (error) {
    child.kill?.("SIGKILL");
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

export async function restoreObjectStoreBackup({
  source,
  destinationRoot,
  key,
  expectedFiles,
  spawnProcess = spawn,
} = {}) {
  validateEntries(expectedFiles);
  await ensureEmptyDestination(destinationRoot);
  const child = spawnProcess("/usr/bin/tar", ["-C", destinationRoot, "-xf", "-"], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  const exit = childExit(child);
  try {
    await decryptBackupStream({ source, destination: child.stdin, key });
    const result = await exit;
    if (result.code !== 0) throw backupError("object_store_restore_failed");
    const restored = await snapshotObjectStore(destinationRoot);
    assertSameEntries(expectedFiles, restored.entries);
    return Object.freeze({
      verified: true,
      files: restored.entries.length,
      artifactsVerified: restored.artifactsVerified,
    });
  } catch (error) {
    child.kill?.("SIGKILL");
    throw error;
  }
}

export async function snapshotObjectStore(root) {
  const sourceRoot = await safeDirectory(root);
  const paths = await walk(sourceRoot);
  const entries = [];
  for (const path of paths) {
    const absolute = inside(sourceRoot, path);
    const info = await lstat(absolute);
    entries.push(Object.freeze({
      path,
      bytes: info.size,
      digest: await fileDigest(absolute),
    }));
  }
  const artifactsVerified = await verifyObjectRecords(sourceRoot, new Map(entries.map((entry) => [entry.path, entry])));
  return Object.freeze({ entries: Object.freeze(entries), artifactsVerified });
}

async function verifyObjectRecords(root, byPath) {
  let artifacts = 0;
  for (const path of [...byPath.keys()].filter((item) => item.endsWith(".json"))) {
    let record;
    try { record = JSON.parse(await readFile(inside(root, path), "utf8")); }
    catch { throw backupError("object_store_record_invalid"); }
    if (record?.storeFormat !== OBJECT_RECORD_FORMAT) continue;
    const bytesPath = `${path.slice(0, -5)}.bin`;
    const bytes = byPath.get(bytesPath);
    if (!bytes || !SHA256.test(record.contentHash || "")
      || bytes.digest !== record.contentHash || bytes.bytes !== record.sizeBytes) {
      throw backupError("object_store_artifact_hash_mismatch");
    }
    if (record.metadata?.source === "product-artifact") artifacts += 1;
  }
  return artifacts;
}

async function walk(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw backupError("object_store_symlink_forbidden");
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else if (entry.isFile()) result.push(path);
    else throw backupError("object_store_entry_invalid");
  }
  return result.sort();
}

function validateEntries(entries) {
  if (!Array.isArray(entries)
    || entries.some((entry) => !safeRelativePath(entry?.path)
      || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 || !SHA256.test(entry?.digest || ""))
    || new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw backupError("object_store_backup_manifest_invalid");
  }
}

function assertSameEntries(expected, actual) {
  validateEntries(expected);
  validateEntries(actual);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw backupError("object_store_backup_mismatch");
  }
}

async function safeDirectory(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("object_store_backup_root_invalid");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw backupError("object_store_backup_root_invalid");
  return realpath(path);
}

async function ensureEmptyDestination(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("object_store_restore_root_invalid");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length !== 0) {
      throw backupError("object_store_restore_root_not_empty");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
  }
}

function safeRelativePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 1024
    && !path.includes("\\") && !path.startsWith("/")
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}

function inside(root, path) {
  if (!safeRelativePath(path)) throw backupError("object_store_backup_path_invalid");
  const base = resolve(root);
  const target = resolve(root, path);
  if (relative(base, target).startsWith("..")) throw backupError("object_store_backup_path_invalid");
  return target;
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function childExit(child) {
  const stderr = [];
  let bytes = 0;
  child.stderr?.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 128 * 1024) stderr.push(chunk);
    else child.kill?.("SIGKILL");
  });
  return new Promise((resolveExit, reject) => {
    child.once("error", () => reject(backupError("object_store_backup_process_unavailable")));
    child.once("close", (code) => resolveExit({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function backupError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
