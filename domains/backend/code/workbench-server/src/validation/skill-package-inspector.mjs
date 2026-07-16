import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  parseSkillRuntimeManifest,
  SKILL_RUNTIME_MANIFEST_PATH,
  SkillPackageFormatError,
} from "../skills/skill-package-format.mjs";
import { parseYamlDocument } from "./yaml-parser.mjs";

const MAX_FILE_COUNT = 256;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const ALLOWED_FRONTMATTER = new Set(["name", "description", "compatibility", "disable-model-invocation"]);
const EXECUTABLE_EXTENSION = /\.(?:cjs|js|mjs|py|sh|ts)$/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
];
const DANGEROUS_SCRIPT_PATTERNS = [
  /\b(?:curl|wget)\b/i,
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\b(?:child_process|process\.env|eval\s*\()/i,
];

export function inspectSkillPackage({ files, maxFileCount = MAX_FILE_COUNT, maxPackageBytes = MAX_PACKAGE_BYTES } = {}) {
  const diagnostics = [];
  const normalizedFiles = normalizeFiles(files, { maxFileCount, maxPackageBytes, diagnostics });
  const byPath = new Map(normalizedFiles.map((file) => [file.path, file]));
  const skillFile = byPath.get("SKILL.md");
  if (!skillFile) {
    diagnostics.push(diagnostic("skill_file_missing", "error", "The package must include one root SKILL.md file."));
  }

  let frontmatter = null;
  if (skillFile) {
    frontmatter = inspectSkillFrontmatter(skillFile, diagnostics);
  }
  const runtimeManifest = inspectRuntimeManifest({ byPath, diagnostics });
  for (const file of normalizedFiles) inspectFile(file, diagnostics);

  const hasErrors = diagnostics.some((entry) => entry.severity === "error");
  const hasWarnings = diagnostics.some((entry) => entry.severity === "warning");
  return Object.freeze({
    status: hasErrors ? "failed" : hasWarnings ? "needs_review" : "passed",
    contentHash: packageHash(normalizedFiles),
    manifest: frontmatter && runtimeManifest
      ? Object.freeze({ ...frontmatter, runtime: runtimeManifest })
      : frontmatter,
    inventory: Object.freeze(normalizedFiles.map((file) => Object.freeze({
      path: file.path,
      sizeBytes: file.bytes.byteLength,
      kind: file.kind,
    }))),
    diagnostics: Object.freeze(diagnostics),
  });
}

function normalizeFiles(files, { maxFileCount, maxPackageBytes, diagnostics }) {
  if (!Array.isArray(files) || files.length === 0) {
    diagnostics.push(diagnostic("package_files_required", "error", "Select package files before validation."));
    return [];
  }
  if (!Number.isSafeInteger(maxFileCount) || maxFileCount < 1 || files.length > maxFileCount) {
    diagnostics.push(diagnostic("package_file_count_invalid", "error", "The package contains too many files."));
    return [];
  }
  if (!Number.isSafeInteger(maxPackageBytes) || maxPackageBytes < 1) {
    throw new TypeError("skill_package_limit_invalid");
  }

  const paths = new Set();
  let totalBytes = 0;
  const normalized = [];
  for (const candidate of files) {
    const path = normalizePath(candidate?.path, diagnostics);
    if (!path || paths.has(path)) {
      if (path) diagnostics.push(diagnostic("package_path_duplicate", "error", "A package file path is duplicated.", path));
      continue;
    }
    paths.add(path);
    const bytes = asBytes(candidate?.content, path, diagnostics);
    if (!bytes) continue;
    if (bytes.byteLength > MAX_FILE_BYTES) {
      diagnostics.push(diagnostic("package_file_too_large", "error", "A package file exceeds the allowed size.", path));
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxPackageBytes) {
      diagnostics.push(diagnostic("package_too_large", "error", "The package exceeds the allowed size."));
      break;
    }
    if (bytes.includes(0)) {
      diagnostics.push(diagnostic("binary_content_not_allowed", "error", "Binary files cannot be validated as a Skill package.", path));
      continue;
    }
    normalized.push(Object.freeze({ path, bytes, kind: classifyPath(path) }));
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizePath(value, diagnostics) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") || value.includes("\0")) {
    diagnostics.push(diagnostic("package_path_invalid", "error", "A package file path is invalid."));
    return null;
  }
  const normalized = posix.normalize(value);
  if (
    value.startsWith("/")
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== value
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    diagnostics.push(diagnostic("package_path_invalid", "error", "A package file path is invalid.", value));
    return null;
  }
  return normalized;
}

function asBytes(value, path, diagnostics) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  diagnostics.push(diagnostic("package_file_content_invalid", "error", "A package file has invalid content.", path));
  return null;
}

function inspectSkillFrontmatter(file, diagnostics) {
  const source = file.bytes.toString("utf8");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    diagnostics.push(diagnostic("skill_frontmatter_missing", "error", "SKILL.md must begin with supported frontmatter.", file.path));
    return null;
  }
  let entries;
  try {
    entries = parseYamlDocument(match[1]);
  } catch {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "SKILL.md frontmatter is not valid YAML.", file.path));
    return null;
  }
  if (!isPlainObject(entries)) {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "SKILL.md frontmatter must be a YAML mapping.", file.path));
    return null;
  }
  if (Object.keys(entries).some((key) => !ALLOWED_FRONTMATTER.has(key))) {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "SKILL.md frontmatter contains an unsupported field.", file.path));
  }
  if (!isPiSkillName(entries.name)) {
    diagnostics.push(diagnostic("skill_name_invalid", "error", "SKILL.md name must be a normalized lowercase Skill identifier.", file.path));
  }
  if (typeof entries.description !== "string"
    || entries.description.trim() === ""
    || entries.description.length > 1024) {
    diagnostics.push(diagnostic("skill_description_invalid", "error", "SKILL.md requires a concise description.", file.path));
  }
  if (Object.hasOwn(entries, "compatibility") && typeof entries.compatibility !== "string") {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "SKILL.md compatibility must be text.", file.path));
  }
  if (Object.hasOwn(entries, "disable-model-invocation")
    && typeof entries["disable-model-invocation"] !== "boolean") {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "disable-model-invocation must be a boolean.", file.path));
  }
  return Object.freeze({
    name: typeof entries.name === "string" ? entries.name : null,
    description: typeof entries.description === "string" ? entries.description : null,
    compatibility: typeof entries.compatibility === "string" ? entries.compatibility : null,
    disableModelInvocation: entries["disable-model-invocation"] === true,
  });
}

function inspectRuntimeManifest({ byPath, diagnostics }) {
  const runtimeFile = byPath.get(SKILL_RUNTIME_MANIFEST_PATH);
  const executableFiles = [...byPath.values()].filter((file) => file.kind === "executable");
  if (!runtimeFile) {
    if (executableFiles.length > 0) {
      diagnostics.push(diagnostic(
        "skill_runtime_manifest_missing",
        "error",
        "Executable Skill packages must include one root skill.runtime.json file.",
        SKILL_RUNTIME_MANIFEST_PATH,
      ));
    }
    return null;
  }
  let manifest;
  try {
    manifest = parseSkillRuntimeManifest(runtimeFile.bytes);
  } catch (failure) {
    if (!(failure instanceof SkillPackageFormatError)) throw failure;
    diagnostics.push(diagnostic(
      "skill_runtime_manifest_invalid",
      "error",
      "skill.runtime.json does not match the supported isolated runtime profile.",
      runtimeFile.path,
    ));
    return null;
  }
  if (!byPath.has(manifest.entrypoint)) {
    diagnostics.push(diagnostic(
      "skill_runtime_entrypoint_missing",
      "error",
      "The declared Skill runtime entrypoint is missing.",
      manifest.entrypoint,
    ));
  }
  return manifest;
}

function inspectFile(file, diagnostics) {
  const content = file.bytes.toString("utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      diagnostics.push(diagnostic("secret_detected", "error", "Potential credentials were found in a package file.", file.path));
      break;
    }
  }
  if (file.kind !== "executable") return;
  diagnostics.push(diagnostic("executable_content_requires_isolation", "warning", "Executable package content requires isolated validation before it can run.", file.path));
  for (const pattern of DANGEROUS_SCRIPT_PATTERNS) {
    if (pattern.test(content)) {
      diagnostics.push(diagnostic("dangerous_script_pattern", "error", "Executable package content requests an unsupported capability.", file.path));
      break;
    }
  }
}

function classifyPath(path) {
  if (path === "SKILL.md") return "instructions";
  if (path === SKILL_RUNTIME_MANIFEST_PATH) return "runtime_manifest";
  if (path.startsWith("scripts/") || EXECUTABLE_EXTENSION.test(path)) return "executable";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  if (path === "agents/openai.yaml") return "agent_metadata";
  return "other";
}

function isPiSkillName(value) {
  return typeof value === "string"
    && value.length <= 64
    && /^[a-z0-9-]+$/.test(value)
    && !value.startsWith("-")
    && !value.endsWith("-")
    && !value.includes("--");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageHash(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function diagnostic(code, severity, message, path) {
  return Object.freeze({ code, severity, message, ...(path ? { path } : {}) });
}
