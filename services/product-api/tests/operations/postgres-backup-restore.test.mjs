import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertRestoreTarget,
  createPostgresBackup,
  parsePostgresConnection,
  restorePostgresBackup,
} from "../../operations/postgres-backup-restore.mjs";

const SOURCE_URL = "postgresql://workbench:secret@127.0.0.1:5432/workbench_source_test?sslmode=disable";
const TARGET_URL = "postgresql://restore:secret@127.0.0.1:5432/workbench_restore_test?sslmode=disable";
const KEY = Buffer.alloc(32, 7);
const SNAPSHOT = Object.freeze({
  migrations: [{ version: "001", checksum: "sha256:test" }],
  tableCounts: { product_users: 2 },
  checksum: "sha256:snapshot",
});

test("PostgreSQL connection parsing and restore targets fail closed", () => {
  assert.deepEqual(parsePostgresConnection(SOURCE_URL), {
    database: "workbench_source_test",
    host: "127.0.0.1",
    port: "5432",
    user: "workbench",
    password: "secret",
    sslmode: "disable",
  });
  assert.equal(assertRestoreTarget(TARGET_URL, "/tmp/objects_restore_test").database, "workbench_restore_test");
  assert.throws(
    () => assertRestoreTarget(SOURCE_URL, "/tmp/objects_restore_test"),
    { code: "postgres_restore_target_must_end_restore_test" },
  );
  assert.throws(
    () => assertRestoreTarget(TARGET_URL, "/tmp/objects"),
    { code: "object_restore_target_must_end_restore_test" },
  );
});

test("encrypted PostgreSQL and Object Store backup restores only to an isolated verified target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-pg-backup-test-"));
  const objects = join(root, "objects");
  const backup = join(root, "backup");
  const restoredObjects = join(root, "objects_restore_test");
  await writeFile(join(root, "placeholder"), "root");
  await mkdir(objects);
  await writeFile(join(objects, "artifact.bin"), "artifact-bytes");
  t.after(() => rm(root, { recursive: true, force: true }));

  const spawnTool = (command, args, options) => {
    const child = new EventEmitter();
    queueMicrotask(async () => {
      try {
        if (command === "pg_dump") {
          const output = args[args.indexOf("--file") + 1];
          await writeFile(output, "postgres-dump");
          assert.equal(options.env.PGDATABASE, "workbench_source_test");
        } else if (command === "tar" && args.includes("-cf")) {
          await writeFile(args[args.indexOf("-cf") + 1], "object-archive");
        }
        child.emit("exit", 0, null);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };

  const created = await createPostgresBackup({
    connectionString: SOURCE_URL,
    objectStoreRoot: objects,
    backupSetDirectory: backup,
    encryptionKey: KEY,
    spawnTool,
    snapshot: async () => SNAPSHOT,
    clock: () => "2026-08-12T00:00:00.000Z",
  });
  assert.equal(created.manifest.sourceDatabase, "workbench_source_test");
  assert.equal(JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")).integrity.algorithm, "HMAC-SHA256");

  const restored = await restorePostgresBackup({
    backupSetDirectory: backup,
    targetConnectionString: TARGET_URL,
    objectTargetRoot: restoredObjects,
    encryptionKey: KEY,
    spawnTool,
    snapshot: async () => SNAPSHOT,
  });
  assert.equal(restored.isolated, true);
  assert.equal(restored.targetDatabase, "workbench_restore_test");

  const tampered = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
  tampered.sourceDatabase = "tampered";
  await writeFile(join(backup, "manifest.json"), `${JSON.stringify(tampered)}\n`);
  await assert.rejects(
    restorePostgresBackup({
      backupSetDirectory: backup,
      targetConnectionString: TARGET_URL,
      objectTargetRoot: join(root, "tampered_restore_test"),
      encryptionKey: KEY,
      spawnTool,
      snapshot: async () => SNAPSHOT,
    }),
    { code: "backup_manifest_authentication_failed" },
  );
});
