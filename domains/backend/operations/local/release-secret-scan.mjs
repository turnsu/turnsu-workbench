import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const DETECTORS = Object.freeze([
  {
    rule: "private_key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{40,}\r?\n)+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    rule: "aws_access_key",
    expression: /\bAKIA[0-9A-Z]{16}\b/g,
    accept: (match) => !match[0].endsWith("EXAMPLE"),
  },
  { rule: "github_token", expression: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { rule: "provider_key", expression: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  {
    rule: "mongodb_password_uri",
    expression: /mongodb(?:\+srv)?:\/\/([^:\s/@'"`]+):([^@\s/'"`]+)@([^\s/'"`:]+)/g,
    accept: (match) => !isMongoPlaceholder(match[1], match[2], match[3]),
  },
  {
    rule: "bearer_literal",
    expression: /authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  },
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
    for (const { rule, expression, accept = () => true } of DETECTORS) {
      expression.lastIndex = 0;
      if ([...source.matchAll(expression)].some(accept)) matches.push({ path, rule });
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

function isMongoPlaceholder(username, password, host) {
  if ([username, password, host].some((value) => /[$\{\}]/.test(value))) return true;
  const pair = `${username.toLowerCase()}:${password.toLowerCase()}`;
  return ["username:password", "user:password", "user:pass"].includes(pair)
    && ["host", "localhost", "127.0.0.1"].includes(host.toLowerCase());
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
