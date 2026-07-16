import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function nowISO() {
  return new Date().toISOString();
}

export function controlID(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function writeJsonArtifact(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

export function artifactPath(projectRoot, path) {
  return relative(projectRoot, path).replaceAll("\\", "/");
}

export function compactText(value, max = 800) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function redactSensitive(value) {
  return String(value ?? "")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "sk-[REDACTED]")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function validateRequired(name, value, requiredKeys = []) {
  const missingKeys = requiredKeys.filter((key) => value?.[key] === undefined || value?.[key] === null);
  return {
    schemaVersion: "agent-artifact-validation-v1",
    artifact: name,
    status: missingKeys.length === 0 ? "pass" : "failed",
    missingKeys,
    rawSecretsReturned: false,
    validatedAt: nowISO(),
  };
}

