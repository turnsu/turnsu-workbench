import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decryptBackupStream,
  encryptBackupStream,
} from "../backup-encryption.mjs";

const CRITICAL_TABLES = Object.freeze([
  "product_users",
  "product_workspaces",
  "workspace_memberships",
  "skill_assets",
  "skill_drafts",
  "workflows",
  "memory_candidates",
  "durable_memories",
]);

/**
 * Product-owned backup intent. The transport owns where a database runs;
 * this driver owns authenticated encryption, opaque handles, semantic source
 * and restored-store verification, and cleanup. It never returns an archive
 * path, connection string, or key.
 */
export class PostgresBackupRestoreDriver {
  constructor({ store, transport, createIsolatedStore, deferCleanup = () => {}, random = randomBytes } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !transport
      || typeof transport.assertAvailable !== "function"
      || typeof transport.dump !== "function"
      || typeof transport.createIsolatedTarget !== "function"
      || typeof transport.restore !== "function"
      || typeof transport.dropTarget !== "function"
      || typeof createIsolatedStore !== "function") {
      throw new TypeError("postgres_backup_driver_dependencies_required");
    }
    this.store = store;
    this.transport = transport;
    this.createIsolatedStore = createIsolatedStore;
    this.random = random;
    this.backups = new Map();
    this.restoreTargets = new Set();
    deferCleanup(async () => this.dispose());
  }

  async assertAvailable() { return this.transport.assertAvailable(); }

  async backup() {
    const root = await mkdtemp(join(tmpdir(), "looloomi-pg-backup-"));
    const archive = join(root, "product.lbkp");
    const key = this.random(32);
    const handle = randomUUID();
    try {
      const source = await this.#snapshot(this.store);
      const dump = await this.transport.dump();
      const encryption = await encryptBackupStream({ source: dump.source, destination: archive, key });
      await dump.completed;
      this.backups.set(handle, { root, archive, key, source });
      return Object.freeze({
        handle,
        encryption: Object.freeze({
          algorithm: encryption.algorithm,
          format: encryption.format,
          authenticated: true,
        }),
        source: Object.freeze(source),
      });
    } catch (error) {
      key.fill(0);
      await rm(root, { force: true, recursive: true });
      throw error;
    }
  }

  async restoreIsolated({ handle } = {}) {
    const backup = this.backups.get(handle);
    if (!backup) throw coded("postgres_backup_handle_invalid");
    const target = await this.transport.createIsolatedTarget();
    this.restoreTargets.add(target);
    let restoredStore = null;
    try {
      const restore = await this.transport.restore(target);
      const verification = await decryptBackupStream({ source: backup.archive, destination: restore.destination, key: backup.key });
      await restore.completed;
      restoredStore = await this.createIsolatedStore(target);
      const restored = await this.#snapshot(restoredStore);
      if (!sameSnapshot(backup.source, restored)) throw coded("postgres_backup_semantic_mismatch");
      return Object.freeze({
        store: restoredStore,
        isolated: true,
        dispose: async () => {
          await restoredStore.close?.({ closeInjectedPool: true }).catch(() => {});
          await this.transport.dropTarget(target).catch(() => {});
          this.restoreTargets.delete(target);
        },
        verification: Object.freeze({
          verified: verification.verified === true,
          algorithm: "AES-256-GCM",
          format: verification.format,
          source: backup.source,
          restored,
        }),
      });
    } catch (error) {
      await restoredStore?.close?.({ closeInjectedPool: true }).catch(() => {});
      await this.transport.dropTarget(target).catch(() => {});
      this.restoreTargets.delete(target);
      throw error;
    }
  }

  async assertAuthenticationFailure({ handle } = {}) {
    const backup = this.backups.get(handle);
    if (!backup) throw coded("postgres_backup_handle_invalid");
    const target = await this.transport.createIsolatedTarget();
    try {
      const restore = await this.transport.restore(target);
      const tampered = Buffer.from(backup.key);
      tampered[0] ^= 0xff;
      try {
        await decryptBackupStream({ source: backup.archive, destination: restore.destination, key: tampered });
      } catch (error) {
        if (error?.code === "backup_authentication_failed") return true;
        throw error;
      } finally {
        tampered.fill(0);
        restore.abort?.();
        await restore.completed.catch(() => {});
      }
      throw coded("postgres_backup_authentication_not_enforced");
    } finally {
      await this.transport.dropTarget(target).catch(() => {});
    }
  }

  async dispose() {
    for (const backup of this.backups.values()) {
      backup.key.fill(0);
      await rm(backup.root, { force: true, recursive: true });
    }
    this.backups.clear();
    for (const target of this.restoreTargets) await this.transport.dropTarget(target).catch(() => {});
    this.restoreTargets.clear();
  }

  async #snapshot(store) {
    const sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
    return store.withTransaction(async (uow) => {
      const query = (text, values) => sql.query(uow, text, values);
      const migrationRows = (await query(`
        SELECT version, checksum FROM public.product_schema_migrations
         WHERE status = 'applied' ORDER BY version ASC
      `)).rows.map((row) => ({ version: row.version, checksum: row.checksum }));
      const tableCounts = {};
      for (const table of CRITICAL_TABLES) {
        const count = (await query(`SELECT count(*)::text AS count FROM public.${table}`)).rows[0]?.count ?? "0";
        tableCounts[table] = Number(count);
      }
      const digest = createHash("sha256")
        .update(JSON.stringify({ migrationRows, tableCounts }))
        .digest("hex");
      return Object.freeze({ migrationRows, tableCounts, checksum: `sha256:${digest}` });
    });
  }
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
