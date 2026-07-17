import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GIT_COMMIT = /^[a-f0-9]{40}$/;
const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/+:~-]*@)?sha256:[a-f0-9]{64}$/;
const REQUIRED_GATES = Object.freeze([
  "contracts",
  "backend",
  "agent",
  "authenticated_mongo",
  "docker_isolation",
  "default_agent_composition",
  "backup_restore",
  "upgrade_rollback",
  "capacity",
  "secret_scan",
  "dependency_audit",
  "image_scan",
]);

export async function verifyReleaseEvidence({ root, sourceCommit, agentImage, skillImage, mongoImage } = {}) {
  if (typeof root !== "string" || !GIT_COMMIT.test(sourceCommit || "")
    || ![agentImage, skillImage, mongoImage].every((image) => DIGEST_IMAGE.test(image || ""))) {
    throw new TypeError("release_evidence_input_invalid");
  }
  const evidenceRoot = join(root, "release-evidence");
  const gates = await readJson(join(evidenceRoot, "release-gates.json"));
  if (gates?.schemaVersion !== "looloomi-release-gates-v1" || gates.sourceCommit !== sourceCommit
    || !validIsoDate(gates.generatedAt) || !plainObject(gates.gates)
    || REQUIRED_GATES.some((gate) => gates.gates[gate] !== "passed")) {
    throw evidenceError("release_gates_not_passed");
  }

  await Promise.all([
    verifySbom(join(evidenceRoot, "backend-sbom.cdx.json")),
    verifySbom(join(evidenceRoot, "agent-sbom.cdx.json")),
    verifyNpmAudit(join(evidenceRoot, "backend-npm-audit.json")),
    verifyNpmAudit(join(evidenceRoot, "agent-npm-audit.json")),
    verifyImageScan(join(evidenceRoot, "agent-image-scan.json"), agentImage),
    verifyImageScan(join(evidenceRoot, "skill-image-scan.json"), skillImage),
    verifyImageScan(join(evidenceRoot, "mongo-image-scan.json"), mongoImage),
    verifySecretScan(join(evidenceRoot, "secret-scan.json"), sourceCommit),
  ]);
  return Object.freeze({ ok: true, sourceCommit, gates: REQUIRED_GATES.length });
}

async function verifySbom(path) {
  const value = await readJson(path);
  if (value?.bomFormat !== "CycloneDX" || typeof value.specVersion !== "string"
    || !Array.isArray(value.components) || value.components.length < 1) {
    throw evidenceError("release_sbom_invalid");
  }
}

async function verifyNpmAudit(path) {
  const value = await readJson(path);
  const vulnerabilities = value?.metadata?.vulnerabilities;
  if (!plainObject(vulnerabilities) || !["info", "low", "moderate", "high", "critical", "total"]
    .every((key) => Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] === 0)) {
    throw evidenceError("release_dependency_audit_failed");
  }
}

async function verifyImageScan(path, expectedImage) {
  const value = await readJson(path);
  const vulnerabilities = value?.vulnerabilities;
  if (value?.schemaVersion !== "looloomi-image-scan-v1" || value.image !== expectedImage
    || typeof value.scanner !== "string" || value.scanner.length < 1 || !validIsoDate(value.databaseUpdatedAt)
    || !plainObject(vulnerabilities)
    || !["critical", "high"].every((key) => Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] === 0)) {
    throw evidenceError("release_image_scan_failed");
  }
}

async function verifySecretScan(path, sourceCommit) {
  const value = await readJson(path);
  if (value?.schemaVersion !== "looloomi-secret-scan-v1"
    || value.scanner !== "looloomi-local-secret-scan-v1" || value.sourceCommit !== sourceCommit
    || !Number.isSafeInteger(value.filesScanned) || value.filesScanned < 1
    || !Number.isSafeInteger(value.oversizedFilesSkipped) || value.oversizedFilesSkipped !== 0
    || !Number.isSafeInteger(value.findings) || value.findings !== 0) {
    throw evidenceError("release_secret_scan_failed");
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw evidenceError("release_evidence_missing_or_invalid"); }
}

function validIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}

export { REQUIRED_GATES };
