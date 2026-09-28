import { createHash } from "node:crypto";

import { POSTGRES_MIGRATIONS } from "./migrations/index.mjs";

const DEFAULT_ADVISORY_LOCK_KEYS = Object.freeze([1280266061, 1346851660]);
const LEDGER_RELATION = "public.product_schema_migrations";

export class PostgresMigrationError extends Error {
  constructor(code, message, {
    retryable = false,
    cause,
    connectionStateUnknown = false,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PostgresMigrationError";
    this.code = code;
    this.retryable = retryable;
    this.connectionStateUnknown = connectionStateUnknown;
  }
}

export class PostgresMigrationRunner {
  #pool;
  #migrations;
  #lockKeys;

  constructor({
    pool,
    migrations = POSTGRES_MIGRATIONS,
    advisoryLockKeys = DEFAULT_ADVISORY_LOCK_KEYS,
  } = {}) {
    if (!pool || typeof pool.connect !== "function") {
      throw new PostgresMigrationError(
        "postgres_migration_pool_required",
        "A PostgreSQL Pool is required.",
      );
    }
    this.#pool = pool;
    this.#migrations = normalizeMigrations(migrations);
    this.#lockKeys = normalizeLockKeys(advisoryLockKeys);
  }

  async run() {
    const migrations = await materializeMigrations(this.#migrations);
    const client = await this.#pool.connect();
    let lockState = "unknown";
    let operationError = null;

    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
        this.#lockKeys,
      );
      const locked = Array.isArray(lock.rows) && lock.rows.length === 1
        ? lock.rows[0]?.locked
        : undefined;
      if (locked === true) lockState = "held";
      else if (locked === false) lockState = "not_held";
      else {
        throw new PostgresMigrationError(
          "postgres_migration_lock_result_invalid",
          "PostgreSQL returned an invalid advisory lock result.",
        );
      }
      if (lockState === "not_held") {
        throw new PostgresMigrationError(
          "postgres_migration_lock_unavailable",
          "Another PostgreSQL migration process is active.",
          { retryable: true },
        );
      }

      const applied = await readAppliedMigrations(client);
      assertLedgerMatchesCandidate(applied, migrations);
      assertMigrationsAreAppendOnly(applied, migrations);

      const completed = [];
      for (const migration of migrations) {
        if (applied.has(migration.version)) {
          completed.push({ version: migration.version, status: "already_applied" });
          continue;
        }
        await applyMigration(client, migration);
        completed.push({ version: migration.version, status: "applied" });
      }
      return { completed };
    } catch (error) {
      if (error?.connectionStateUnknown === true) lockState = "unknown";
      operationError = error;
      throw error;
    } finally {
      let cleanupError = null;
      if (lockState === "held") {
        try {
          const unlock = await client.query(
            "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
            this.#lockKeys,
          );
          if (unlock.rows?.[0]?.unlocked !== true) {
            cleanupError = new PostgresMigrationError(
              "postgres_migration_unlock_failed",
              "The PostgreSQL migration advisory lock was not released.",
            );
          }
        } catch (error) {
          cleanupError = error;
        }
      }
      const destroyReason = lockState === "unknown"
        ? asError(operationError, "postgres_migration_lock_state_unknown")
        : cleanupError;
      try {
        client.release(destroyReason ?? undefined);
      } catch (error) {
        cleanupError ??= error;
      }
      if (!operationError && cleanupError) throw cleanupError;
    }
  }
}

async function readAppliedMigrations(client) {
  const relation = await client.query(
    "SELECT to_regclass($1) AS relation",
    [LEDGER_RELATION],
  );
  if (relation.rows?.[0]?.relation == null) return new Map();

  const ledger = await client.query(
    `SELECT version, checksum
       FROM public.product_schema_migrations
      WHERE status = 'applied'
      ORDER BY version`,
  );
  return new Map(ledger.rows.map((row) => [row.version, row.checksum]));
}

function assertLedgerMatchesCandidate(applied, migrations) {
  const candidate = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const [version, checksum] of applied) {
    const migration = candidate.get(version);
    if (!migration) {
      throw new PostgresMigrationError(
        "postgres_migration_unknown_version",
        `Migration ${version} is not owned by this candidate.`,
      );
    }
    if (migration.checksum !== checksum) {
      throw new PostgresMigrationError(
        "postgres_migration_checksum_drift",
        `Migration ${version} does not match its recorded checksum.`,
      );
    }
  }
}

function assertMigrationsAreAppendOnly(applied, migrations) {
  if (applied.size === 0) return;
  const maximumAppliedVersion = [...applied.keys()]
    .sort((left, right) => left.localeCompare(right))
    .at(-1);
  const insertedMigration = migrations.find((migration) => (
    !applied.has(migration.version)
    && migration.version.localeCompare(maximumAppliedVersion) < 0
  ));
  if (insertedMigration) {
    throw new PostgresMigrationError(
      "postgres_migration_not_append_only",
      `Migration ${insertedMigration.version} was inserted before already-applied migration ${maximumAppliedVersion}.`,
    );
  }
}

async function applyMigration(client, migration) {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO public.product_schema_migrations
         (version, checksum, description, status)
       VALUES ($1, $2, $3, 'applied')`,
      [migration.version, migration.checksum, migration.description],
    );
    await client.query("COMMIT");
  } catch (error) {
    if (!transactionStarted) {
      throw new PostgresMigrationError(
        "postgres_migration_begin_state_unknown",
        `Migration ${migration.version} could not confirm that its transaction began.`,
        { cause: error, connectionStateUnknown: true },
      );
    }
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new PostgresMigrationError(
          "postgres_migration_rollback_failed",
          `Migration ${migration.version} failed and could not be rolled back.`,
          {
            cause: new AggregateError([error, rollbackError]),
            connectionStateUnknown: true,
          },
        );
      }
    }
    throw error;
  }
}

function normalizeMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new PostgresMigrationError(
      "postgres_migrations_required",
      "At least one PostgreSQL migration is required.",
    );
  }
  const normalized = migrations.map((migration) => {
    if (!migration || typeof migration.version !== "string"
      || !/^\d{3}_[a-z0-9_]+$/.test(migration.version)
      || typeof migration.description !== "string"
      || migration.description.length === 0
      || (typeof migration.sql !== "string" && typeof migration.loadSql !== "function")) {
      throw new PostgresMigrationError(
        "postgres_migration_definition_invalid",
        "A PostgreSQL migration requires a stable version, description, and SQL source.",
      );
    }
    return Object.freeze({ ...migration });
  }).sort((left, right) => left.version.localeCompare(right.version));

  if (new Set(normalized.map((migration) => migration.version)).size !== normalized.length) {
    throw new PostgresMigrationError(
      "postgres_migration_version_duplicate",
      "PostgreSQL migration versions must be unique.",
    );
  }
  const ordinals = normalized.map((migration) => migration.version.slice(0, 3));
  if (new Set(ordinals).size !== ordinals.length) {
    throw new PostgresMigrationError(
      "postgres_migration_ordinal_duplicate",
      "PostgreSQL migration ordinals must be unique.",
    );
  }
  return Object.freeze(normalized);
}

async function materializeMigrations(migrations) {
  return Promise.all(migrations.map(async (migration) => {
    const sql = migration.sql ?? await migration.loadSql();
    if (typeof sql !== "string" || sql.trim().length === 0) {
      throw new PostgresMigrationError(
        "postgres_migration_sql_invalid",
        `Migration ${migration.version} has no SQL.`,
      );
    }
    return Object.freeze({
      version: migration.version,
      description: migration.description,
      sql,
      checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    });
  }));
}

function normalizeLockKeys(keys) {
  if (!Array.isArray(keys) || keys.length !== 2
    || keys.some((key) => !Number.isInteger(key) || key < -2147483648 || key > 2147483647)) {
    throw new PostgresMigrationError(
      "postgres_migration_lock_keys_invalid",
      "PostgreSQL advisory lock keys must be two signed 32-bit integers.",
    );
  }
  return Object.freeze([...keys]);
}

function asError(value, fallbackCode) {
  if (value instanceof Error) return value;
  return new PostgresMigrationError(
    fallbackCode,
    "The PostgreSQL migration advisory lock state is unknown.",
  );
}
