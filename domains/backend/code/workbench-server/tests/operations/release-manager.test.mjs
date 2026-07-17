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

async function bundle(root, version, content) {
  const path = `${root}/${version}-bundle`;
  await mkdir(`${path}/app`, { recursive: true });
  await writeFile(`${path}/app/server.mjs`, content);
  const manifest = await buildReleaseManifest({
    root: path,
    version,
    files: ["app/server.mjs"],
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
  assert.deepEqual(await verifyReleaseManifest({ root: path, manifest }), { ok: true, version: "2.0.0", files: 1 });
  await writeFile(`${path}/app/server.mjs`, "tampered\n");
  await assert.rejects(verifyReleaseManifest({ root: path, manifest }), { code: "release_integrity_failed" });
  await assert.rejects(
    buildReleaseManifest({ root: path, version: "2.1.0", files: ["../secret"], agentImage: AGENT_IMAGE, skillImage: SKILL_IMAGE, mongoImage: MONGO_IMAGE, frontendTreeHash: FRONTEND_TREE }),
    { code: "release_path_invalid" },
  );
});
