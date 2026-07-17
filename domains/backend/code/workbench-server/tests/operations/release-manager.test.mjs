import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  activateRelease,
  buildReleaseManifest,
  rollbackRelease,
  verifyReleaseManifest,
} from "../../../../operations/local/release-manager.mjs";

const AGENT_IMAGE = `sha256:${"a".repeat(64)}`;
const SKILL_IMAGE = `skill@sha256:${"c".repeat(64)}`;
const MONGO_IMAGE = `mongo@sha256:${"b".repeat(64)}`;
const FRONTEND_TREE = "d6aa607bab850e6f30a2c92c4823896806871937";
const SOURCE_COMMIT = "d".repeat(40);

async function writeReleaseEvidence(path, { dependencyVulnerabilities = 0 } = {}) {
  const evidence = `${path}/release-evidence`;
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/release-gates.json`, `${JSON.stringify({
    schemaVersion: "looloomi-release-gates-v1",
    sourceCommit: SOURCE_COMMIT,
    generatedAt: "2026-07-17T00:00:00.000Z",
    gates: Object.fromEntries([
      "contracts", "backend", "agent", "authenticated_mongo", "docker_isolation",
      "default_agent_composition", "backup_restore", "upgrade_rollback", "capacity",
      "secret_scan", "dependency_audit", "image_scan",
    ].map((name) => [name, "passed"])),
  })}\n`);
  const sbom = `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [{ name: "fixture" }] })}\n`;
  await writeFile(`${evidence}/backend-sbom.cdx.json`, sbom);
  await writeFile(`${evidence}/agent-sbom.cdx.json`, sbom);
  const audit = `${JSON.stringify({ metadata: { vulnerabilities: {
    info: 0, low: dependencyVulnerabilities, moderate: 0, high: 0, critical: 0, total: dependencyVulnerabilities,
  } } })}\n`;
  await writeFile(`${evidence}/backend-npm-audit.json`, audit);
  await writeFile(`${evidence}/agent-npm-audit.json`, audit);
  for (const [name, image] of [["agent", AGENT_IMAGE], ["skill", SKILL_IMAGE], ["mongo", MONGO_IMAGE]]) {
    await writeFile(`${evidence}/${name}-image-scan.json`, `${JSON.stringify({
      schemaVersion: "looloomi-image-scan-v1",
      image,
      scanner: "fixture-scanner",
      databaseUpdatedAt: "2026-07-17T00:00:00.000Z",
      vulnerabilities: { critical: 0, high: 0 },
    })}\n`);
  }
  await writeFile(`${evidence}/secret-scan.json`, `${JSON.stringify({
    schemaVersion: "looloomi-secret-scan-v1", filesScanned: 1, findings: 0,
  })}\n`);
}

async function bundle(root, version, content) {
  const path = `${root}/${version}-bundle`;
  await mkdir(`${path}/app`, { recursive: true });
  await writeFile(`${path}/app/server.mjs`, content);
  await writeReleaseEvidence(path);
  const manifest = await buildReleaseManifest({
    root: path,
    version,
    files: [
      "app/server.mjs",
      "release-evidence/agent-npm-audit.json",
      "release-evidence/agent-sbom.cdx.json",
      "release-evidence/agent-image-scan.json",
      "release-evidence/backend-npm-audit.json",
      "release-evidence/backend-sbom.cdx.json",
      "release-evidence/mongo-image-scan.json",
      "release-evidence/release-gates.json",
      "release-evidence/secret-scan.json",
      "release-evidence/skill-image-scan.json",
    ],
    sourceCommit: SOURCE_COMMIT,
    agentImage: AGENT_IMAGE,
    skillImage: SKILL_IMAGE,
    mongoImage: MONGO_IMAGE,
    frontendTreeHash: FRONTEND_TREE,
  });
  await writeFile(`${path}/release-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

test("release activation verifies hashes, checks candidate health, and rolls back by atomic link", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-release-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = `${root}/install`;
  const v1 = await bundle(root, "1.0.0", "export const version = '1.0.0';\n");
  const first = await activateRelease({ bundleRoot: v1, installRoot, healthCheck: async () => true });
  assert.equal(await readlink(`${installRoot}/current`), first.activated);

  const v2 = await bundle(root, "1.1.0", "export const version = '1.1.0';\n");
  await assert.rejects(
    activateRelease({ bundleRoot: v2, installRoot, healthCheck: async () => false }),
    { code: "release_health_check_failed" },
  );
  assert.equal(await readlink(`${installRoot}/current`), first.activated);

  const second = await activateRelease({ bundleRoot: v2, installRoot, healthCheck: async () => true });
  assert.equal(await readlink(`${installRoot}/current`), second.activated);
  const rolledBack = await rollbackRelease({ installRoot });
  assert.equal(rolledBack.activated, first.activated);
  assert.equal(await readlink(`${installRoot}/current`), first.activated);
});

test("release verification detects modified content and rejects path traversal", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-release-integrity-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await bundle(root, "2.0.0", "safe\n");
  const manifest = JSON.parse(await readFile(`${path}/release-manifest.json`, "utf8"));
  assert.deepEqual(await verifyReleaseManifest({ root: path, manifest }), { ok: true, version: "2.0.0", files: 10 });
  await writeFile(`${path}/app/server.mjs`, "tampered\n");
  await assert.rejects(verifyReleaseManifest({ root: path, manifest }), { code: "release_integrity_failed" });
  await assert.rejects(
    buildReleaseManifest({ root: path, version: "2.1.0", files: ["../secret"], sourceCommit: SOURCE_COMMIT, agentImage: AGENT_IMAGE, skillImage: SKILL_IMAGE, mongoImage: MONGO_IMAGE, frontendTreeHash: FRONTEND_TREE }),
    { code: "release_path_invalid" },
  );
});

test("release activation fails closed when supply-chain evidence is missing or reports a vulnerability", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-release-evidence-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await bundle(root, "3.0.0", "safe\n");
  const manifest = JSON.parse(await readFile(`${path}/release-manifest.json`, "utf8"));

  await writeFile(`${path}/release-evidence/agent-npm-audit.json`, `${JSON.stringify({
    metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 } },
  })}\n`);
  const files = manifest.files.map((entry) => entry.path);
  const vulnerableManifest = await buildReleaseManifest({
    root: path,
    version: "3.0.1",
    files,
    sourceCommit: SOURCE_COMMIT,
    agentImage: AGENT_IMAGE,
    skillImage: SKILL_IMAGE,
    mongoImage: MONGO_IMAGE,
    frontendTreeHash: FRONTEND_TREE,
  });
  await assert.rejects(verifyReleaseManifest({ root: path, manifest: vulnerableManifest }), {
    code: "release_dependency_audit_failed",
  });
});
