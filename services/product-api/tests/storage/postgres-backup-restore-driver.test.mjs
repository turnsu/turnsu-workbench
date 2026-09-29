import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { PostgresBackupRestoreDriver } from "../../src/store/postgres/postgres-backup-restore-driver.mjs";

const store = {
  bindAdapter(factory) {
    return factory({ execute: async (_transaction, { text }) => text.includes("product_schema_migrations")
      ? { rows: [] }
      : { rows: [{ count: "0" }] } });
  },
  withTransaction(work) { return work({}); },
};

function source() {
  return Readable.from((async function* () {
    await delay(30);
    yield Buffer.from("isolated PostgreSQL dump");
  })());
}

test("an early dump failure is handled while the archive stream is still running", async () => {
  const driver = new PostgresBackupRestoreDriver({
    store,
    transport: {
      assertAvailable: async () => {},
      dump: async () => ({ source: source(), completed: delay(1).then(() => { throw new Error("pg_dump_failed"); }) }),
      createIsolatedTarget: async () => {},
      restore: async () => {},
      dropTarget: async () => {},
    },
    createIsolatedStore: async () => {},
  });
  await assert.rejects(driver.backup(), /pg_dump_failed/);
  await driver.dispose();
});

test("an early restore failure is handled while authenticated decryption is still running", async () => {
  const driver = new PostgresBackupRestoreDriver({
    store,
    transport: {
      assertAvailable: async () => {},
      dump: async () => ({ source: source(), completed: delay(40) }),
      createIsolatedTarget: async () => ({ database: "isolated_restore_test" }),
      restore: async () => ({
        destination: new Writable({ write(_chunk, _encoding, callback) { setTimeout(callback, 30); } }),
        completed: delay(1).then(() => { throw new Error("pg_restore_failed"); }),
      }),
      dropTarget: async () => {},
    },
    createIsolatedStore: async () => {},
  });
  try {
    const archive = await driver.backup();
    await assert.rejects(driver.restoreIsolated({ handle: archive.handle }), /pg_restore_failed/);
  } finally {
    await driver.dispose();
  }
});
