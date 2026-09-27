import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  parseSkillRuntimeManifest,
  SKILL_RUNTIME_MANIFEST_PATH,
  SkillPackageFormatError,
} from "../skills/skill-package-format.mjs";
import { normalizeAcceptedMaterialMediaTypes } from "../attachments/material-media-types.mjs";
import { projectLarkToolDeclaration } from "../tools/lark-tool-policy.mjs";
import { parseYamlDocument } from "./yaml-parser.mjs";

const MAX_FILE_COUNT = 256;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const ALLOWED_FRONTMATTER = new Set([
  "name",
  "version",
  "description",
  "compatibility",
  "license",
  "allowed-tools",
  "disable-model-invocation",
  "metadata",
  "inputs",
  "outputs",
  "tools",
  "dependencies",
]);
const INTERFACE_TYPES = new Set(["string", "number", "boolean", "json", "markdown", "file"]);
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
  // Standard author metadata stays in the original SKILL.md bytes. In
  // particular allowed-tools must never become a Product authorization grant.
  for (const key of ["license", "allowed-tools"]) {
    if (Object.hasOwn(entries, key) && typeof entries[key] !== "string") {
      diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", `SKILL.md ${key} must be text.`, file.path));
    }
  }
  if (Object.hasOwn(entries, "disable-model-invocation")
    && typeof entries["disable-model-invocation"] !== "boolean") {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "disable-model-invocation must be a boolean.", file.path));
  }
  if (Object.hasOwn(entries, "version")
    && (typeof entries.version !== "string" || entries.version.length === 0 || entries.version.length > 64)) {
    diagnostics.push(diagnostic("skill_frontmatter_invalid", "error", "SKILL.md version must be bounded text.", file.path));
  }
  const inputs = inspectInterface(entries.inputs, "input", diagnostics, file.path);
  const outputs = inspectInterface(entries.outputs, "output", diagnostics, file.path);
  const dependencies = inspectDependencies(entries.dependencies, entries.metadata, diagnostics, file.path);
  const tools = inspectTools(entries.tools, entries.name, diagnostics, file.path);
  return Object.freeze({
    name: typeof entries.name === "string" ? entries.name : null,
    description: typeof entries.description === "string" ? entries.description : null,
    compatibility: typeof entries.compatibility === "string" ? entries.compatibility : null,
    disableModelInvocation: entries["disable-model-invocation"] === true,
    ...(typeof entries.version === "string" ? { version: entries.version } : {}),
    ...(inputs.length > 0 ? { inputs: Object.freeze(inputs) } : {}),
    ...(outputs.length > 0 ? { outputs: Object.freeze(outputs) } : {}),
    ...(tools.length > 0 ? { tools: Object.freeze(tools) } : {}),
    ...(dependencies.length > 0 ? { dependencies: Object.freeze(dependencies) } : {}),
  });
}

function inspectInterface(value, kind, diagnostics, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    diagnostics.push(diagnostic("skill_interface_invalid", "error", `SKILL.md ${kind}s must be a bounded list.`, path));
    return [];
  }
  const names = new Set();
  const normalized = [];
  for (const entry of value) {
    const allowed = kind === "input"
      ? new Set(["name", "title", "type", "required", "description", "acceptedMediaTypes"])
      : new Set(["name", "type", "description"]);
    let acceptedMediaTypes = null;
    try {
      if (entry?.type === "file") {
        acceptedMediaTypes = normalizeAcceptedMaterialMediaTypes(entry.acceptedMediaTypes);
      } else if (entry?.acceptedMediaTypes !== undefined) {
        throw new TypeError("skill_material_media_types_invalid");
      }
    } catch {
      acceptedMediaTypes = null;
    }
    if (
      !isPlainObject(entry)
      || Object.keys(entry).some((key) => !allowed.has(key))
      || typeof entry.name !== "string"
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entry.name)
      || names.has(entry.name)
      || !INTERFACE_TYPES.has(entry.type)
      || (entry.description !== undefined
        && (typeof entry.description !== "string" || entry.description.length === 0 || entry.description.length > 1000))
      || (entry.title !== undefined
        && (typeof entry.title !== "string" || entry.title.length === 0 || entry.title.length > 200))
      || (kind === "input" && entry.required !== undefined && typeof entry.required !== "boolean")
      || (entry.type === "file" && acceptedMediaTypes === null)
    ) {
      diagnostics.push(diagnostic("skill_interface_invalid", "error", `SKILL.md contains an invalid ${kind} declaration.`, path));
      continue;
    }
    names.add(entry.name);
    normalized.push(Object.freeze({
      name: entry.name,
      type: entry.type,
      ...(kind === "input" ? { required: entry.required === true } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.type === "file" ? { acceptedMediaTypes: Object.freeze(acceptedMediaTypes) } : {}),
    }));
  }
  return normalized;
}

function inspectDependencies(value, metadata, diagnostics, path) {
  const declared = value === undefined ? [] : value;
  if (!Array.isArray(declared) || declared.length > 32) {
    diagnostics.push(diagnostic("skill_dependency_invalid", "error", "SKILL.md dependencies must be a bounded list.", path));
    return [];
  }
  const metadataBins = metadata?.requires?.bins;
  if (metadata !== undefined && !isPlainObject(metadata)) {
    diagnostics.push(diagnostic("skill_metadata_invalid", "error", "SKILL.md metadata must be a mapping.", path));
  }
  if (isPlainObject(metadata) && JSON.stringify(metadata).length > 16_384) {
    diagnostics.push(diagnostic("skill_metadata_invalid", "error", "SKILL.md metadata exceeds the product limit.", path));
  }
  if (metadata?.requires !== undefined && !isPlainObject(metadata.requires)) {
    diagnostics.push(diagnostic("skill_metadata_invalid", "error", "SKILL.md metadata requires must be a mapping.", path));
  }
  if (
    metadata?.cliHelp !== undefined
    && (typeof metadata.cliHelp !== "string" || metadata.cliHelp.length === 0 || metadata.cliHelp.length > 2_000)
  ) {
    diagnostics.push(diagnostic("skill_metadata_invalid", "error", "SKILL.md cliHelp must be bounded text.", path));
  }
  if (metadataBins !== undefined && (!Array.isArray(metadataBins) || metadataBins.length > 32)) {
    diagnostics.push(diagnostic("skill_metadata_invalid", "error", "SKILL.md metadata bins must be a bounded list.", path));
  }
  const values = [
    ...declared,
    ...(Array.isArray(metadataBins) ? metadataBins.map((name) => ({ type: "cli", name })) : []),
  ];
  const seen = new Set();
  const normalized = [];
  for (const entry of values) {
    if (
      !isPlainObject(entry)
      || Object.keys(entry).some((key) => !["type", "name"].includes(key))
      || entry.type !== "cli"
      || typeof entry.name !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)
    ) {
      diagnostics.push(diagnostic("skill_dependency_invalid", "error", "SKILL.md contains an invalid CLI dependency.", path));
      continue;
    }
    const key = `${entry.type}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(Object.freeze({ type: entry.type, name: entry.name }));
  }
  return normalized;
}

function inspectTools(value, skillName, diagnostics, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    diagnostics.push(diagnostic("skill_tool_declaration_invalid", "error", "SKILL.md tools must be a bounded list.", path));
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    const action = typeof entry === "string"
      ? entry
      : isPlainObject(entry) && Object.keys(entry).length === 1 ? entry.action : null;
    const declaration = projectLarkToolDeclaration(action, skillName);
    if (!declaration || seen.has(action)) {
      diagnostics.push(diagnostic(
        "skill_tool_declaration_invalid",
        "error",
        "SKILL.md tools must name an exact product-approved action for this Skill.",
        path,
      ));
      continue;
    }
    seen.add(action);
    normalized.push(Object.freeze(declaration));
  }
  return normalized;
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
