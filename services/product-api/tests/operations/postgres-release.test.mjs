import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createPostgresReleaseManifest,
  validatePostgresReleaseManifest,
  writePostgresReleaseManifest,
} from "../../operations/postgres-release.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

test("release manifest binds the PostgreSQL-only candidate with no runtime fallback", async () => {
  const manifest = await createPostgresReleaseManifest({
    repositoryRoot: REPOSITORY_ROOT,
    clock: () => "2026-08-12T00:00:00.000Z",
  });
  assert.equal(manifest.schemaVersion, "looloomi-postgres-release-v1");
  assert.equal(manifest.database.authority, "postgresql");
  assert.equal(manifest.database.fallback, false);
  assert.match(manifest.database.image, /^postgres@sha256:[a-f0-9]{64}$/u);
  assert.ok(manifest.database.migrations.length > 0);
  assert.match(manifest.candidate.statusDigest, /^sha256:[a-f0-9]{64}$/u);
});

test("release validation rejects manifest tampering and accepts the exact current candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-pg-release-test-"));
  const file = join(root, "manifest.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePostgresReleaseManifest({ repositoryRoot: REPOSITORY_ROOT, outputFile: file });
  assert.equal((await validatePostgresReleaseManifest({
    repositoryRoot: REPOSITORY_ROOT,
    manifestFile: file,
  })).valid, true);

  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.database.fallback = true;
  await writeFile(file, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    validatePostgresReleaseManifest({ repositoryRoot: REPOSITORY_ROOT, manifestFile: file }),
    { code: "postgres_release_manifest_invalid" },
  );
});
