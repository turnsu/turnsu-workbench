import { createHash } from "node:crypto";
import process from "node:process";

import { ProductPostgresStore } from "../src/store/postgres/product-postgres-store.mjs";
import { POSTGRES_MIGRATIONS } from "../src/store/postgres/migrations/index.mjs";

const args = new Set(process.argv.slice(2));
const printManifest = args.has("--print-manifest");
const dryRun = args.has("--dry-run");
const confirmed = args.has("--confirm-write");
const connectionString = valueAfter("--url") ?? process.env.WORKBENCH_POSTGRES_URL ?? "";

if (printManifest) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "looloomi-postgres-schema-migration-manifest-v1",
    migrations: await manifest(),
  }, null, 2)}\n`);
} else {
  const database = databaseName(connectionString);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "looloomi-postgres-schema-migration-dry-run-v1",
      database,
      migrations: await manifest(),
    }, null, 2)}\n`);
  } else {
    if (!database.endsWith("_test") && !confirmed) {
      fail(
        "postgres_migration_write_confirmation_required",
        "Write mode requires a _test database or --confirm-write.",
      );
    }
    const store = new ProductPostgresStore({ poolOptions: { connectionString } });
    try {
      const result = await store.runMigrations();
      process.stdout.write(`${JSON.stringify({
        schemaVersion: "looloomi-postgres-schema-migration-result-v1",
        database,
        ...result,
      }, null, 2)}\n`);
    } finally {
      await store.close();
    }
  }
}

async function manifest() {
  return Promise.all(POSTGRES_MIGRATIONS.map(async ({ version, description, loadSql }) => {
    const sql = await loadSql();
    return {
      version,
      description,
      checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}`,
    };
  }));
}

function databaseName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("workbench_postgres_url_required", "Set WORKBENCH_POSTGRES_URL or pass --url.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("workbench_postgres_url_invalid", "WORKBENCH_POSTGRES_URL must be a valid PostgreSQL URL.");
  }
  if (!/^postgres(?:ql)?:$/i.test(url.protocol)) {
    fail("workbench_postgres_url_invalid", "WORKBENCH_POSTGRES_URL must use postgres:// or postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    fail("postgres_migration_database_required", "The PostgreSQL URL must name exactly one database.");
  }
  return database;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exitCode = 2;
  throw new Error(message);
}
