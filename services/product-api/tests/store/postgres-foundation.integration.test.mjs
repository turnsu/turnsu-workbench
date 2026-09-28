import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import {
  POSTGRES_MIGRATIONS,
  ProductPostgresStore,
} from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";

test("PostgreSQL foundation works against an isolated real server", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  assert.match(databaseName, /_test$/, "integration database must end in _test");

  const observerPool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 4,
  });
  const store = new ProductPostgresStore({
    poolOptions: {
      connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 2,
    },
    maxTransactionRetries: 0,
  });
  const transactionProbe = store.bindAdapter(({ execute }) => Object.freeze({
    query: (unitOfWork, text, values) => execute(unitOfWork, text, values),
  }));
  let closed = false;
  t.after(async () => {
    if (!closed) {
      await store.close();
      await observerPool.end();
    }
  });

  assert.equal(await store.connect(), store);
  const health = await observerPool.query(
    "SELECT current_database() AS database_name, 1::integer AS ok",
  );
  assert.deepEqual(health.rows, [{ database_name: databaseName, ok: 1 }]);

  const migrations = await Promise.all(POSTGRES_MIGRATIONS.map(async (migration) => ({
    ...migration,
    sql: migration.sql ?? await migration.loadSql(),
  })));
  assert.deepEqual(await store.runMigrations(), {
    completed: migrations.map(({ version }) => ({ version, status: "applied" })),
  });
  assert.deepEqual(await store.runMigrations(), {
    completed: migrations.map(({ version }) => ({ version, status: "already_applied" })),
  });

  const ledger = await observerPool.query(
    `SELECT version, checksum, description, status
       FROM public.product_schema_migrations
      ORDER BY version`,
  );
  assert.deepEqual(ledger.rows, migrations.map((migration) => ({
    version: migration.version,
    checksum: `sha256:${createHash("sha256").update(migration.sql).digest("hex")}`,
    description: migration.description,
    status: "applied",
  })));

  await observerPool.query(`
    CREATE TABLE public.postgres_foundation_transaction_probe (
      marker text PRIMARY KEY
    )
  `);

  const committed = await store.withTransaction(async (unitOfWork) => {
    assert.equal(unitOfWork.kind, "postgres_unit_of_work");
    assert.equal(unitOfWork.query, undefined);
    assert.equal(unitOfWork.client, undefined);
    const isolation = await transactionProbe.query(unitOfWork, "SHOW transaction_isolation");
    assert.equal(isolation.rows[0]?.transaction_isolation, "serializable");
    const inserted = await transactionProbe.query(
      unitOfWork,
      `INSERT INTO public.postgres_foundation_transaction_probe (marker)
       VALUES ($1)
       RETURNING marker`,
      ["committed"],
    );
    return inserted.rows[0]?.marker;
  });
  assert.equal(committed, "committed");
  assert.deepEqual(await markers(observerPool), ["committed"]);

  const rollbackProbe = new Error("rollback_probe");
  await assert.rejects(store.withTransaction(async (unitOfWork) => {
    await transactionProbe.query(
      unitOfWork,
      "INSERT INTO public.postgres_foundation_transaction_probe (marker) VALUES ($1)",
      ["rolled_back"],
    );
    throw rollbackProbe;
  }), (error) => error === rollbackProbe);
  assert.deepEqual(await markers(observerPool), ["committed"]);

  await assert.rejects(store.withTransaction(async (unitOfWork) => {
    await transactionProbe.query(
      unitOfWork,
      "INSERT INTO public.postgres_foundation_transaction_probe (marker) VALUES ($1)",
      ["unique_violation_rolled_back"],
    );
    await transactionProbe.query(
      unitOfWork,
      "INSERT INTO public.postgres_foundation_transaction_probe (marker) VALUES ($1)",
      ["unique_violation_rolled_back"],
    );
  }), (error) => error?.code === "23505");
  assert.deepEqual(await markers(observerPool), ["committed"]);

  await store.close();
  await observerPool.end();
  closed = true;
  await store.close();
  await assert.rejects(store.connect(), /postgres_store_closed/);
});

async function markers(pool) {
  const result = await pool.query(
    "SELECT marker FROM public.postgres_foundation_transaction_probe ORDER BY marker",
  );
  return result.rows.map((row) => row.marker);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required when PostgreSQL integration is enabled`);
  return value;
}
