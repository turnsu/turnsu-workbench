import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const GIT_COMMIT = /^[a-f0-9]{40}$/;
const DIGEST_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/+:~-]*@)?sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STABILITY_CORE_PRICING_POLICY = "stability-core-credits-2026-07-18";
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
  "license_audit",
  "image_scan",
  "chat_provider_smoke",
  "stability_provider_smoke",
]);

export async function verifyReleaseEvidence({
  root,
  sourceCommit,
  agentImage,
  skillImage,
  mongoImage,
  now = Date.now,
  maxProviderEvidenceAgeMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  if (typeof root !== "string" || !GIT_COMMIT.test(sourceCommit || "")
    || ![agentImage, skillImage, mongoImage].every((image) => DIGEST_IMAGE.test(image || ""))) {
    throw new TypeError("release_evidence_input_invalid");
  }
  const evidenceRoot = join(root, "release-evidence");
  const candidateDigest = await computeCandidateDigest(root);
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
    verifyLicenseAudit(join(evidenceRoot, "license-audit.json"), { sourceCommit, candidateDigest, now, maxProviderEvidenceAgeMs }),
    verifyImageScan(join(evidenceRoot, "agent-image-scan.json"), agentImage),
    verifyImageScan(join(evidenceRoot, "skill-image-scan.json"), skillImage),
    verifyImageScan(join(evidenceRoot, "mongo-image-scan.json"), mongoImage),
    verifySecretScan(join(evidenceRoot, "secret-scan.json"), sourceCommit),
    verifyProviderSmoke(join(evidenceRoot, "chat-provider-smoke.json"), {
      sourceCommit,
      candidateDigest,
      now,
      maxProviderEvidenceAgeMs,
      capability: "chat",
      errorCode: "release_chat_provider_smoke_failed",
      billableConfirmationRequired: false,
    }),
    verifyProviderSmoke(join(evidenceRoot, "stability-provider-smoke.json"), {
      sourceCommit,
      candidateDigest,
      now,
      maxProviderEvidenceAgeMs,
      capability: "image_generation",
      errorCode: "release_stability_provider_smoke_failed",
      billableConfirmationRequired: true,
    }),
  ]);
  return Object.freeze({ ok: true, sourceCommit, gates: REQUIRED_GATES.length });
}

async function verifyLicenseAudit(path, { sourceCommit, candidateDigest, now, maxProviderEvidenceAgeMs }) {
  const value = await readJson(path);
  if (value?.schemaVersion !== "looloomi-license-audit-v1"
    || value.sourceCommit !== sourceCommit
    || value.candidateDigest !== candidateDigest
    || typeof value.scanner !== "string" || value.scanner.length < 1
    || !freshIsoDate(value.generatedAt, now, maxProviderEvidenceAgeMs)
    || !Number.isSafeInteger(value.packagesScanned) || value.packagesScanned < 1
    || !Array.isArray(value.forbiddenLicenses) || value.forbiddenLicenses.length !== 0
    || !Number.isSafeInteger(value.unknownLicenses) || value.unknownLicenses !== 0
    || typeof value.policyDigest !== "string" || !SHA256.test(value.policyDigest)) {
    throw evidenceError("release_license_audit_failed");
  }
}

async function verifyProviderSmoke(path, {
  sourceCommit,
  candidateDigest,
  capability,
  errorCode,
  billableConfirmationRequired,
  now,
  maxProviderEvidenceAgeMs,
}) {
  const value = await readJson(path);
  const assertions = value?.assertions;
  if (value?.schemaVersion !== "looloomi-provider-smoke-v1"
    || value.producer !== "looloomi-provider-smoke-v1"
    || value.sourceCommit !== sourceCommit
    || value.candidateDigest !== candidateDigest
    || value.capability !== capability
    || value.status !== "passed"
    || !freshIsoDate(value.executedAt, now, maxProviderEvidenceAgeMs)
    || !SAFE_ID.test(value.profileRevisionId || "")
    || value.requestDigest !== expectedProviderSmokeRequestDigest(capability, value.profileRevisionId)
    || !SHA256.test(value.responseDigest || "")
    || !validProviderSmokeProtocol(capability, value.protocol)
    || value.attempts !== 1 || value.fallback !== false
    || !plainObject(assertions)
    || assertions.productPath !== true || assertions.requestedActualMatch !== true
    || assertions.rawProviderPayloadAbsent !== true || assertions.secretLeakScanPassed !== true
    || (billableConfirmationRequired && value.billableConfirmed !== true)
    || (capability === "image_generation" && (!SHA256.test(value.artifactDigest || "")
      || !SAFE_ID.test(value.artifactId || "")
      || !["image/png", "image/jpeg", "image/webp"].includes(value.artifactMediaType)
      || !validArtifactDimensions(value.artifactDimensions)
      || !validStabilityCoreBilling(value.billing)
      || assertions.noPiSession !== true || assertions.authorizedRetrieval !== true
      || assertions.crossWorkspaceDenied !== true || assertions.artifactHashVerified !== true))) {
    throw evidenceError(errorCode);
  }
}

function validArtifactDimensions(value) {
  return plainObject(value)
    && Number.isSafeInteger(value.width) && value.width >= 1 && value.width <= 32_768
    && Number.isSafeInteger(value.height) && value.height >= 1 && value.height <= 32_768;
}

function validProviderSmokeProtocol(capability, protocol) {
  return capability === "chat"
    ? ["openai_compatible_chat", "anthropic_messages", "gemini_generate_content"].includes(protocol)
    : capability === "image_generation" && protocol === "stability_image_v2";
}

function validStabilityCoreBilling(value) {
  return plainObject(value)
    && value.pricingPolicy === STABILITY_CORE_PRICING_POLICY
    && value.creditsPerImage === 3
    && value.usdMicrosPerCredit === 10_000
    && value.estimatedUsdMicros === 30_000;
}

export function stabilityCoreBillingEvidence() {
  return Object.freeze({
    pricingPolicy: STABILITY_CORE_PRICING_POLICY,
    creditsPerImage: 3,
    usdMicrosPerCredit: 10_000,
    estimatedUsdMicros: 30_000,
  });
}

export function expectedProviderSmokeRequestDigest(capability, profileRevisionId) {
  if (typeof profileRevisionId !== "string" || profileRevisionId.length < 1) {
    throw new TypeError("provider_smoke_revision_invalid");
  }
  const request = capability === "chat" ? {
    kind: "agent_message",
    modelProfileRevisionId: profileRevisionId,
    input: { message: "Reply with a short acknowledgement for the looloomi release smoke." },
  } : capability === "image_generation" ? {
    kind: "model_task",
    modelProfileRevisionId: profileRevisionId,
    input: {
      task: "image_generation",
      prompt: "A simple blue circle centered on a plain white background.",
      aspectRatio: "1:1",
      outputFormat: "png",
    },
  } : null;
  if (!request) throw new TypeError("provider_smoke_capability_invalid");
  return `sha256:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
}

export async function computeCandidateDigest(root) {
  if (typeof root !== "string" || root.length === 0) throw new TypeError("release_candidate_root_invalid");
  const files = (await walkCandidate(root)).filter((path) =>
    path !== "release-manifest.json" && !path.startsWith("release-evidence/"));
  if (files.length === 0) throw evidenceError("release_candidate_empty");
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    for await (const chunk of createReadStream(join(root, path))) hash.update(chunk);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function walkCandidate(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw evidenceError("release_candidate_symlink_forbidden");
    if (entry.isDirectory()) result.push(...await walkCandidate(root, path));
    else if (entry.isFile()) {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink()) throw evidenceError("release_candidate_file_invalid");
      result.push(path);
    }
  }
  return result.sort();
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

function freshIsoDate(value, now, maxAgeMs) {
  if (!validIsoDate(value) || typeof now !== "function"
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) return false;
  const age = now() - Date.parse(value);
  return age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}

export { REQUIRED_GATES };
