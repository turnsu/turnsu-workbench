import { createHash } from "node:crypto";

import { parseStrictJson } from "../validation/strict-json-parser.mjs";

export const SKILL_PACKAGE_FORMAT = "workbench-skill-package-v1";
export const SKILL_PACKAGE_MEDIA_TYPE = "application/vnd.looloomi.skill-package+json";
export const SKILL_RUNTIME_MANIFEST_PATH = "skill.runtime.json";
export const EXECUTABLE_SKILL_PATHS = Object.freeze([
  "SKILL.md",
  SKILL_RUNTIME_MANIFEST_PATH,
  "scripts/main.py",
]);
export const SUPPORTED_SKILL_RUNTIME_MANIFEST = Object.freeze({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: Object.freeze({ stdin: "json", stdout: "json" }),
  permissions: Object.freeze({
    network: false,
    connections: Object.freeze([]),
    externalActions: false,
    filesystem: "scratch-only",
  }),
});

const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class SkillPackageFormatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillPackageFormatError";
    this.code = code;
  }
}

export function formatSkillPackage(files) {
  const records = Array.isArray(files) ? files.map((file) => ({
    path: String(file?.path ?? ""),
    content: contentBase64(file?.content),
  })) : [];
  records.sort((left, right) => left.path.localeCompare(right.path) || left.content.localeCompare(right.content));
  return Buffer.from(`${JSON.stringify({ format: SKILL_PACKAGE_FORMAT, files: records })}\n`, "utf8");
}

export function parseSkillPackage(value, { maxEnvelopeBytes = MAX_ENVELOPE_BYTES } = {}) {
  const bytes = asBuffer(value);
  if (!Number.isSafeInteger(maxEnvelopeBytes) || maxEnvelopeBytes < 1) {
    throw new TypeError("skill_package_envelope_limit_invalid");
  }
  if (bytes.byteLength > maxEnvelopeBytes) {
    throw packageError("skill_package_too_large", "The Skill package exceeds the allowed size.");
  }

  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw packageError("skill_package_invalid", "The Skill package could not be read.");
  }
  if (!isPlainObject(envelope)
    || envelope.format !== SKILL_PACKAGE_FORMAT
    || !Array.isArray(envelope.files)
    || Object.keys(envelope).sort().join(",") !== "files,format") {
    throw packageError("skill_package_invalid", "The Skill package format is unsupported.");
  }

  const paths = new Set();
  const files = envelope.files.map((record) => {
    if (!isPlainObject(record)
      || typeof record.path !== "string"
      || typeof record.content !== "string"
      || Object.keys(record).sort().join(",") !== "content,path"
      || !BASE64.test(record.content)) {
      throw packageError("skill_package_invalid", "The Skill package contains an invalid file record.");
    }
    if (paths.has(record.path)) {
      throw packageError("skill_package_invalid", "The Skill package contains a duplicate file path.");
    }
    paths.add(record.path);
    const content = Buffer.from(record.content, "base64");
    if (content.toString("base64") !== record.content) {
      throw packageError("skill_package_invalid", "The Skill package contains invalid file content.");
    }
    return Object.freeze({ path: record.path, content });
  });

  if (!formatSkillPackage(files).equals(bytes)) {
    throw packageError("skill_package_not_canonical", "The Skill package is not in canonical form.");
  }
  return Object.freeze(files);
}

export function assertExecutableSkillPackage(files) {
  const paths = Array.isArray(files) ? new Set(files.map((file) => file?.path)) : null;
  if (!Array.isArray(files)
    || files.length !== EXECUTABLE_SKILL_PATHS.length
    || paths.size !== EXECUTABLE_SKILL_PATHS.length
    || EXECUTABLE_SKILL_PATHS.some((path) => !paths.has(path))) {
    throw packageError(
      "skill_package_contract_unsupported",
      "This uploaded Skill does not match the supported executable package contract.",
    );
  }
  const runtimeFile = files.find((file) => file.path === SKILL_RUNTIME_MANIFEST_PATH);
  parseSkillRuntimeManifest(runtimeFile?.content);
  return files;
}

export function parseSkillRuntimeManifest(value) {
  let manifest;
  try {
    manifest = parseStrictJson(asBuffer(value).toString("utf8"));
  } catch {
    throw packageError(
      "skill_runtime_manifest_invalid",
      "The uploaded Skill runtime manifest is invalid or unsupported.",
    );
  }
  if (!isPlainObject(manifest)
    || !hasOnlyKeys(manifest, ["runtime", "entrypoint", "protocol", "permissions"])
    || manifest.runtime !== SUPPORTED_SKILL_RUNTIME_MANIFEST.runtime
    || manifest.entrypoint !== SUPPORTED_SKILL_RUNTIME_MANIFEST.entrypoint
    || !isPlainObject(manifest.protocol)
    || !hasOnlyKeys(manifest.protocol, ["stdin", "stdout"])
    || manifest.protocol.stdin !== SUPPORTED_SKILL_RUNTIME_MANIFEST.protocol.stdin
    || manifest.protocol.stdout !== SUPPORTED_SKILL_RUNTIME_MANIFEST.protocol.stdout
    || !isPlainObject(manifest.permissions)
    || !hasOnlyKeys(manifest.permissions, ["network", "connections", "externalActions", "filesystem"])
    || manifest.permissions.network !== false
    || !Array.isArray(manifest.permissions.connections)
    || manifest.permissions.connections.length !== 0
    || manifest.permissions.externalActions !== false
    || manifest.permissions.filesystem !== SUPPORTED_SKILL_RUNTIME_MANIFEST.permissions.filesystem) {
    throw packageError(
      "skill_runtime_manifest_invalid",
      "The uploaded Skill runtime manifest is invalid or unsupported.",
    );
  }
  return Object.freeze({
    runtime: manifest.runtime,
    entrypoint: manifest.entrypoint,
    protocol: Object.freeze({ ...manifest.protocol }),
    permissions: Object.freeze({
      ...manifest.permissions,
      connections: Object.freeze([]),
    }),
  });
}

export function hashSkillPackageObject(value) {
  return `sha256:${createHash("sha256").update(asBuffer(value)).digest("hex")}`;
}

export function objectIdForSkillPackage(value) {
  const contentHash = typeof value === "string" && SHA256.test(value)
    ? value
    : hashSkillPackageObject(value);
  return `object-${contentHash.slice("sha256:".length)}`;
}

function contentBase64(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8").toString("base64");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return "";
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw packageError("skill_package_invalid", "The Skill package bytes are invalid.");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => key === keys[index]);
}

function packageError(code, message) {
  return new SkillPackageFormatError(code, message);
}
