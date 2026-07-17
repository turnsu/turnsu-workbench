import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("LOOLOOMI-BACKUP-V1\n", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BACKUP_NAME = /^workbench-(\d{8})T(\d{6})Z\.lbkp$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

export async function encryptBackupStream({ source, destination, key, random = randomBytes } = {}) {
  const secret = normalizeKey(key);
  if (!source?.pipe || typeof destination !== "string" || destination.length === 0) {
    throw new TypeError("backup_encrypt_input_invalid");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.partial-${process.pid}`;
  const iv = random(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const output = createWriteStream(temporary, { mode: 0o600, flags: "wx" });
  try {
    output.write(MAGIC);
    output.write(iv);
    await pipeline(source, cipher, output, { end: false });
    await writeAndClose(output, cipher.getAuthTag());
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    return { destination, algorithm: "AES-256-GCM", format: "looloomi-backup-v1" };
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function decryptBackupStream({ source, destination, key } = {}) {
  const secret = normalizeKey(key);
  if (typeof source !== "string" || !destination?.write) throw new TypeError("backup_decrypt_input_invalid");
  const info = await stat(source);
  const headerBytes = MAGIC.length + IV_BYTES;
  if (info.size <= headerBytes + TAG_BYTES) throw backupError("backup_format_invalid");
  const handle = await open(source, "r");
  try {
    const header = Buffer.alloc(headerBytes);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw backupError("backup_format_invalid");
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", secret, header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(source, { start: headerBytes, end: info.size - TAG_BYTES - 1 }),
      decipher,
      destination,
    );
    return { source, verified: true, format: "looloomi-backup-v1" };
  } catch (error) {
    if (error?.code === "backup_format_invalid") throw error;
    throw backupError("backup_authentication_failed");
  } finally {
    await handle.close();
  }
}

export async function writeBackupManifest({
  archive,
  database,
  migrationVersion,
  releaseVersion,
  createdAt = new Date().toISOString(),
} = {}) {
  validateManifestFields({ archive, database, migrationVersion, releaseVersion, createdAt });
  const info = await stat(archive);
  if (!info.isFile() || info.size < MAGIC.length + IV_BYTES + TAG_BYTES + 1) {
    throw backupError("backup_archive_invalid");
  }
  const manifest = Object.freeze({
    schemaVersion: "looloomi-backup-manifest-v1",
    createdAt: new Date(createdAt).toISOString(),
    database,
    migrationVersion,
    releaseVersion,
    archive: Object.freeze({
      filename: basename(archive),
      bytes: info.size,
      digest: await fileDigest(archive),
    }),
  });
  const path = backupManifestPath(archive);
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return { path, manifest };
}

export async function verifyBackupManifest({ archive, manifestPath = backupManifestPath(archive) } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { throw backupError("backup_manifest_invalid"); }
  validateManifest(manifest, archive);
  const info = await stat(archive);
  if (!info.isFile() || info.size !== manifest.archive.bytes
    || await fileDigest(archive) !== manifest.archive.digest) {
    throw backupError("backup_manifest_mismatch");
  }
  return Object.freeze(structuredClone(manifest));
}

export function backupManifestPath(archive) {
  if (typeof archive !== "string" || archive.length === 0) throw new TypeError("backup_archive_path_invalid");
  return `${archive}.manifest.json`;
}

export function selectBackupRetention(files, { daily = 7, weekly = 4 } = {}) {
  if (!Array.isArray(files) || !Number.isInteger(daily) || daily < 1 || !Number.isInteger(weekly) || weekly < 1) {
    throw new TypeError("backup_retention_invalid");
  }
  const parsed = files.map((name) => ({ name, date: backupDate(name) })).filter((item) => item.date)
    .sort((left, right) => right.date - left.date);
  const keep = new Set();
  const days = new Set();
  const weeks = new Set();
  for (const item of parsed) {
    const day = item.date.toISOString().slice(0, 10);
    if (days.size < daily && !days.has(day)) {
      days.add(day);
      keep.add(item.name);
    }
    const week = isoWeek(item.date);
    if (weeks.size < weekly && !weeks.has(week)) {
      weeks.add(week);
      keep.add(item.name);
    }
  }
  return {
    keep: parsed.filter((item) => keep.has(item.name)).map((item) => item.name),
    remove: parsed.filter((item) => !keep.has(item.name)).map((item) => item.name),
  };
}

export function backupFilename(now = new Date()) {
  return `workbench-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.lbkp`;
}

function backupDate(name) {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const value = `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}Z`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoWeek(date) {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  current.setUTCDate(current.getUTCDate() + 4 - (current.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((current - yearStart) / 86400000) + 1) / 7);
  return `${current.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function normalizeKey(key) {
  const value = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "base64");
  if (value.length !== 32) throw new TypeError("backup_key_invalid");
  return value;
}

function validateManifestFields({ archive, database, migrationVersion, releaseVersion, createdAt }) {
  if (typeof archive !== "string" || archive.length === 0
    || !SAFE_ID.test(database || "") || !SAFE_ID.test(migrationVersion || "")
    || !SAFE_ID.test(releaseVersion || "") || Number.isNaN(Date.parse(createdAt))) {
    throw new TypeError("backup_manifest_input_invalid");
  }
}

function validateManifest(manifest, archive) {
  try {
    validateManifestFields({
      archive,
      database: manifest?.database,
      migrationVersion: manifest?.migrationVersion,
      releaseVersion: manifest?.releaseVersion,
      createdAt: manifest?.createdAt,
    });
  } catch {
    throw backupError("backup_manifest_invalid");
  }
  if (manifest?.schemaVersion !== "looloomi-backup-manifest-v1"
    || manifest.archive?.filename !== basename(archive)
    || !Number.isSafeInteger(manifest.archive?.bytes) || manifest.archive.bytes < 1
    || !SHA256.test(manifest.archive?.digest || "")
    || new Date(manifest.createdAt).toISOString() !== manifest.createdAt) {
    throw backupError("backup_manifest_invalid");
  }
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function writeAndClose(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(chunk, resolve);
  });
}

function backupError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
