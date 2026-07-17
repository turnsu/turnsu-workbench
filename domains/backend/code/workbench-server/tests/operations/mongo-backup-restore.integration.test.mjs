import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import {
  decryptBackupStream,
  encryptBackupStream,
} from "../../../../operations/local/encrypted-mongo-backup.mjs";

const enabled = process.env.WORKBENCH_MONGO_BACKUP_INTEGRATION === "1";
const container = process.env.WORKBENCH_MONGO_CONTAINER ?? "looloomi-mongodb";
const sourceDatabase = process.env.WORKBENCH_MONGO_BACKUP_SOURCE_DB ?? "looloomi_production_rehearsal_test";

test("authenticated Mongo archive encrypts, restores to isolated database, and verifies critical records", {
  skip: !enabled,
  timeout: 120_000,
}, async (t) => {
  assert.match(sourceDatabase, /_test$/);
  assert.match(container, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  const targetDatabase = `looloomi_restore_${Date.now()}_test`;
  const root = await mkdtemp("/private/tmp/looloomi-mongo-restore-");
  const archive = `${root}/rehearsal.lbkp`;
  const key = randomBytes(32);
  t.after(async () => {
    await runDocker(["exec", container, "/opt/looloomi/mongo-drop-test.sh", targetDatabase]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const dump = spawn("docker", [
    "exec", container, "/opt/looloomi/mongo-backup.sh", sourceDatabase,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const dumpExit = childExit(dump);
  await encryptBackupStream({ source: dump.stdout, destination: archive, key });
  const dumpResult = await dumpExit;
  assert.equal(dumpResult.code, 0, `mongodump must complete: ${dumpResult.stderr}`);

  const restore = spawn("docker", [
    "exec", "-i", container, "/opt/looloomi/mongo-restore.sh", sourceDatabase, targetDatabase,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  const restoreExit = childExit(restore);
  const decrypted = await decryptBackupStream({ source: archive, destination: restore.stdin, key });
  assert.equal(decrypted.verified, true);
  const restoreResult = await restoreExit;
  assert.equal(restoreResult.code, 0, `mongorestore must complete: ${restoreResult.stderr}`);

  const verified = await runDocker([
    "exec", container, "/opt/looloomi/mongo-verify-restore.sh", targetDatabase,
  ]);
  const collections = JSON.parse(verified.stdout.trim());
  for (const name of [
    "runs", "execution_events", "execution_checkpoints", "agent_turns",
    "memory_deletion_tombstones", "audit_events",
  ]) {
    assert.equal(collections[name].readable, true, name);
    assert.equal(collections[name].count, 1, name);
    assert.equal(collections[name].duplicateIds, 0, name);
    assert.ok(collections._indexCounts[name] >= 1, `${name} indexes`);
  }
  assert.deepEqual(
    collections._migrationLedger.map(({ version, status }) => ({ version, status })),
    [
      "001-backfill-default-workspace",
      "002-runner-terminal-transitions",
      "003-agent-execution-fabric",
      "004-product-memory",
      "005-agent-proposals-and-active-branches",
    ].map((version) => ({ version, status: "applied" })),
  );
});

function childExit(child) {
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 128 * 1024) stderr.push(chunk);
    if (stderrBytes > 128 * 1024) child.kill("SIGKILL");
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
    }));
  });
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 1_000_000) stdout.push(chunk); else child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1_000_000) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve({ stdout: Buffer.concat(stdout).toString("utf8") })
      : reject(new Error("docker_operation_failed")));
  });
}
