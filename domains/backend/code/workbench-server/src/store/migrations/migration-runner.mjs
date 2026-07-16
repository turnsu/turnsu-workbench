import { createHash, randomUUID } from "node:crypto";

export class MigrationError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ProductMigrationRunner {
  #db;
  #migrations;
  #clock;
  #lockId;
  #ownerId;
  #leaseMilliseconds;

  constructor({ db, migrations, clock = () => new Date(), lockId = "workbench-product-migrations", ownerId = `migration-${randomUUID()}`, leaseMilliseconds = 30000 } = {}) {
    if (!db || typeof db.collection !== "function") throw new MigrationError("migration_db_required", "A product database is required.");
    this.#db = db;
    this.#migrations = normalizeMigrations(migrations);
    this.#clock = clock;
    this.#lockId = lockId;
    this.#ownerId = ownerId;
    this.#leaseMilliseconds = leaseMilliseconds;
  }

  async plan({ dryRun = true, context = {} } = {}) {
    const applied = await this.#appliedVersions();
    const pending = this.#migrations.filter((migration) => !applied.has(migration.version));
    const reports = [];
    for (const migration of pending) {
      reports.push(await migration.inspect(this.#context({ ...context, dryRun })));
    }
    return {
      dryRun,
      applied: [...applied].sort(),
      pending: pending.map((migration) => migration.version),
      reports,
    };
  }

  async run({ dryRun = false, context = {} } = {}) {
    if (dryRun) return this.plan({ dryRun: true, context });
    const lease = await this.#acquireLock();
    try {
      const applied = await this.#appliedVersions();
      const completed = [];
      for (const migration of this.#migrations) {
        if (applied.has(migration.version)) {
          completed.push({ version: migration.version, status: "already_applied" });
          continue;
        }
        const ctx = this.#context({ ...context, dryRun: false });
        const before = await migration.inspect(ctx);
        const result = await migration.apply(ctx);
        const after = await migration.inspect(ctx);
        await this.#ledger().insertOne({
          _id: migration.version,
          version: migration.version,
          checksum: migration.checksum,
          status: "applied",
          ownerId: this.#ownerId,
          appliedAt: this.#clock().toISOString(),
          before,
          after,
          result,
        });
        completed.push({ version: migration.version, status: "applied", before, after, result });
      }
      return { dryRun: false, completed };
    } finally {
      await this.#releaseLock(lease).catch(() => {});
    }
  }

  #context(input) {
    return Object.freeze({
      db: this.#db,
      clock: this.#clock,
      ownerId: this.#ownerId,
      ...input,
    });
  }

  #ledger() {
    return this.#db.collection("product_schema_migrations");
  }

  #locks() {
    return this.#db.collection("product_migration_locks");
  }

  async #appliedVersions() {
    const rows = await this.#ledger().find({ status: "applied" }).toArray();
    const known = new Map(this.#migrations.map((migration) => [migration.version, migration]));
    for (const row of rows) {
      const migration = known.get(row.version);
      if (!migration) continue;
      if (row.checksum !== migration.checksum) {
        throw new MigrationError("migration_checksum_drift", `Migration ${row.version} does not match its recorded checksum.`);
      }
    }
    return new Set(rows.map((row) => row.version));
  }

  async #acquireLock() {
    const now = this.#clock();
    const expiresAt = new Date(now.getTime() + this.#leaseMilliseconds).toISOString();
    let result;
    try {
      result = await this.#locks().findOneAndUpdate(
        {
          _id: this.#lockId,
          $or: [
            { ownerId: this.#ownerId },
            { expiresAt: { $lte: now.toISOString() } },
            { expiresAt: { $exists: false } },
          ],
        },
        {
          $set: { ownerId: this.#ownerId, expiresAt, updatedAt: now.toISOString() },
          $setOnInsert: { createdAt: now.toISOString() },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if (error?.code === 11000) {
        throw new MigrationError("migration_lock_unavailable", "Another migration process is active.", { retryable: true });
      }
      throw error;
    }
    const lock = result?.value ?? result;
    if (!lock || lock.ownerId !== this.#ownerId) {
      throw new MigrationError("migration_lock_unavailable", "Another migration process is active.", { retryable: true });
    }
    return lock;
  }

  async #releaseLock(lock) {
    if (!lock) return;
    await this.#locks().deleteOne({ _id: this.#lockId, ownerId: this.#ownerId });
  }
}

export function defineMigration({ version, description, inspect, apply }) {
  if (typeof version !== "string" || !/^\d{3,}[-_][a-z0-9-]+$/.test(version)) {
    throw new MigrationError("migration_version_invalid", "Migration versions must be ordered and stable.");
  }
  if (typeof description !== "string" || description.length === 0 || typeof inspect !== "function" || typeof apply !== "function") {
    throw new MigrationError("migration_definition_invalid", "A migration requires a description, inspection, and apply function.");
  }
  return Object.freeze({
    version,
    description,
    inspect,
    apply,
    checksum: `sha256:${createHash("sha256").update(`${version}\n${description}\n${inspect.toString()}\n${apply.toString()}`).digest("hex")}`,
  });
}

export async function collectionDigest(collection, { filter = {}, idField = "_id" } = {}) {
  const rows = await collection.find(filter, { projection: { [idField]: 1 } }).sort({ [idField]: 1 }).toArray();
  const ids = rows.map((row) => String(row[idField] ?? row._id ?? "")).sort();
  return {
    count: ids.length,
    checksum: `sha256:${createHash("sha256").update(JSON.stringify(ids)).digest("hex")}`,
  };
}

function normalizeMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new MigrationError("migrations_required", "At least one migration is required.");
  }
  const ordered = [...migrations].sort((left, right) => left.version.localeCompare(right.version));
  if (new Set(ordered.map((migration) => migration.version)).size !== ordered.length) {
    throw new MigrationError("migration_version_duplicate", "Migration versions must be unique.");
  }
  return Object.freeze(ordered);
}
