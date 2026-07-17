import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  backupFilename,
  backupManifestPath,
  decryptBackupStream,
  encryptBackupStream,
  selectBackupRetention,
  verifyBackupManifest,
  writeBackupManifest,
} from "../../../../operations/local/encrypted-mongo-backup.mjs";

test("Mongo backup format streams AES-256-GCM data and rejects tampering", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-backup-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = `${root}/workbench-20260717T010203Z.lbkp`;
  const key = randomBytes(32);
  const input = Buffer.from("product-store-archive\n".repeat(10000));
  await encryptBackupStream({ source: Readable.from(input), destination, key });

  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const result = await decryptBackupStream({ source: destination, destination: sink, key });
  assert.equal(result.verified, true);
  assert.deepEqual(Buffer.concat(chunks), input);

  const corrupted = Buffer.from(await readFile(destination));
  corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
  await writeFile(destination, corrupted, { mode: 0o600 });
  await assert.rejects(
    decryptBackupStream({
      source: destination,
      destination: new Writable({ write(_chunk, _encoding, done) { done(); } }),
      key,
    }),
    { code: "backup_authentication_failed" },
  );
});

test("backup naming and retention preserve seven daily plus four weekly recovery points", () => {
  assert.equal(backupFilename(new Date("2026-07-17T01:02:03.456Z")), "workbench-20260717T010203Z.lbkp");
  const files = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 17 - index, 1, 0, 0));
    return backupFilename(date);
  });
  const result = selectBackupRetention([...files, "README.md"]);
  assert.equal(result.keep.length, 9);
  assert.equal(result.remove.length, 33);
  assert.ok(files.slice(0, 7).every((name) => result.keep.includes(name)));
  assert.equal(result.keep.some((name) => name === "README.md"), false);
});

test("backup manifest binds ciphertext digest to database, migration, and release", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-backup-manifest-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = `${root}/workbench-20260717T010203Z.lbkp`;
  await encryptBackupStream({ source: Readable.from("archive"), destination: archive, key: randomBytes(32) });
  const written = await writeBackupManifest({
    archive,
    database: "looloomi_workbench",
    migrationVersion: "005-agent-proposals-and-active-branches",
    releaseVersion: "release-20260717",
    createdAt: "2026-07-17T01:02:03.000Z",
  });
  assert.equal(written.path, backupManifestPath(archive));
  const verified = await verifyBackupManifest({ archive });
  assert.equal(verified.database, "looloomi_workbench");
  assert.equal(verified.archive.filename, "workbench-20260717T010203Z.lbkp");
  assert.match(verified.archive.digest, /^sha256:[a-f0-9]{64}$/);

  const bytes = Buffer.from(await readFile(archive));
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await writeFile(archive, bytes, { mode: 0o600 });
  await assert.rejects(verifyBackupManifest({ archive }), { code: "backup_manifest_mismatch" });
});
