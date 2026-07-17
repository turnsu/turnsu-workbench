import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const PATTERNS = Object.freeze([
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["provider_key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["mongodb_password_uri", /mongodb(?:\+srv)?:\/\/[^:\s/]+:[^@\s/]+@/],
  ["bearer_literal", /authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._-]{16,}/i],
]);
const MAX_TEXT_BYTES = 25 * 1024 * 1024;

export async function scanReleaseSecrets({ root, sourceCommit } = {}) {
  if (typeof root !== "string" || root.length < 1 || !/^[a-f0-9]{40}$/.test(sourceCommit || "")) {
    throw new TypeError("release_secret_scan_input_invalid");
  }
  const files = await walk(root);
  const matches = [];
  let filesScanned = 0;
  let binaryFilesSkipped = 0;
  let oversizedFilesSkipped = 0;
  for (const path of files) {
    if (path === "release-evidence/secret-scan.json") continue;
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw scanError("release_secret_scan_file_invalid");
    const handle = await open(absolute, "r");
    const sample = Buffer.alloc(Math.min(info.size, 8192));
    try {
      if (sample.length > 0) await handle.read(sample, 0, sample.length, 0);
    } finally {
      await handle.close();
    }
    if (sample.includes(0)) {
      binaryFilesSkipped += 1;
      continue;
    }
    if (info.size > MAX_TEXT_BYTES) {
      oversizedFilesSkipped += 1;
      continue;
    }
    const bytes = await readFile(absolute);
    filesScanned += 1;
    const source = bytes.toString("utf8");
    for (const [rule, expression] of PATTERNS) {
      if (expression.test(source)) matches.push({ path, rule });
    }
  }
  return Object.freeze({
    schemaVersion: "looloomi-secret-scan-v1",
    scanner: "looloomi-local-secret-scan-v1",
    sourceCommit,
    filesScanned,
    binaryFilesSkipped,
    oversizedFilesSkipped,
    findings: matches.length,
    matches,
  });
}

async function walk(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else result.push(path);
  }
  return result.sort();
}

function scanError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
