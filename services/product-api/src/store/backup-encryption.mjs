import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("LOOLOOMI-BACKUP-V1\n", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Authenticated stream encryption shared by Product-owned backup drivers. */
export async function encryptBackupStream({ source, destination, key, random = randomBytes } = {}) {
  const secret = normalizeKey(key);
  if (!source?.pipe || typeof destination !== "string" || destination.length === 0) throw new TypeError("backup_encrypt_input_invalid");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.partial-${process.pid}`;
  const iv = random(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const output = createWriteStream(temporary, { mode: 0o600, flags: "wx" });
  try {
    output.write(MAGIC); output.write(iv);
    await pipeline(source, cipher, output, { end: false });
    await writeAndClose(output, cipher.getAuthTag());
    await chmod(temporary, 0o600); await rename(temporary, destination);
    return { destination, algorithm: "AES-256-GCM", format: "looloomi-backup-v1" };
  } catch (error) {
    output.destroy(); await rm(temporary, { force: true }).catch(() => {}); throw error;
  }
}

export async function decryptBackupStream({ source, destination, key } = {}) {
  const secret = normalizeKey(key);
  if (typeof source !== "string" || !destination?.write) throw new TypeError("backup_decrypt_input_invalid");
  const info = await stat(source); const headerBytes = MAGIC.length + IV_BYTES;
  if (info.size <= headerBytes + TAG_BYTES) throw backupError("backup_format_invalid");
  const handle = await open(source, "r");
  try {
    const header = Buffer.alloc(headerBytes); await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw backupError("backup_format_invalid");
    const tag = Buffer.alloc(TAG_BYTES); await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", secret, header.subarray(MAGIC.length)); decipher.setAuthTag(tag);
    await pipeline(createReadStream(source, { start: headerBytes, end: info.size - TAG_BYTES - 1 }), decipher, destination);
    return { source, verified: true, format: "looloomi-backup-v1" };
  } catch (error) {
    if (error?.code === "backup_format_invalid") throw error;
    throw backupError("backup_authentication_failed");
  } finally { await handle.close(); }
}

function normalizeKey(key) { const value = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "base64"); if (value.length !== 32) throw new TypeError("backup_key_invalid"); return value; }
function writeAndClose(stream, chunk) { return new Promise((resolve, reject) => { stream.once("error", reject); stream.end(chunk, resolve); }); }
function backupError(code) { const error = new Error(code); error.code = code; error.productSafe = true; return error; }
