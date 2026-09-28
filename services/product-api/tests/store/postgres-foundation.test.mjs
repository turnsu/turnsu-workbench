import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  POSTGRES_MIGRATIONS,
  PostgresMigrationRunner,
  ProductPostgresStore,
} from "../../src/store/postgres/index.mjs";

class ScriptedClient {
  constructor(steps) {
    this.steps = [...steps];
    this.queries = [];
    this.releases = [];
  }

  async query(text, values) {
    this.queries.push({ text, values });
    const step = this.steps.shift();
    assert.ok(step, `Unexpected query: ${text}`);
    if (step.match instanceof RegExp) assert.match(text, step.match);
    else if (typeof step.match === "object" && step.match !== null) assert.deepEqual(text, step.match);
    else assert.equal(text, step.match);
    if (step.values !== undefined) assert.deepEqual(values, step.values);
    if (step.error) throw step.error;
    return step.result ?? { rows: [] };
  }

  release(broken) {
    this.releases.push(broken);
  }

  assertDrained() {
    assert.equal(this.steps.length, 0, "Not all expected client queries were executed");
  }
}

class FakePool {
  constructor(clients) {
    this.clients = [...clients];
    this.connectCount = 0;
    this.endCount = 0;
  }

  async connect() {
    const client = this.clients[this.connectCount];
    assert.ok(client, "Unexpected Pool.connect()");
    this.connectCount += 1;
    return client;
  }

  async end() {
    this.endCount += 1;
  }
}

const step = (match, result = { rows: [] }, values) => ({ match, result, values });
const failure = (match, error) => ({ match, error });
const sqlStateError = (code) => Object.assign(new Error(`SQLSTATE ${code}`), { code });

test("ProductPostgresStore borrows an injected Pool and exposes only an opaque unit of work", async () => {
  const client = new ScriptedClient([
    step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
    step("COMMIT"),
  ]);
  const pool = new FakePool([client]);
  const store = new ProductPostgresStore({ pool });

  let capturedUnitOfWork;
  const result = await store.withTransaction(async (unitOfWork) => {
    capturedUnitOfWork = unitOfWork;
    assert.equal(Object.isFrozen(unitOfWork), true);
    assert.equal(unitOfWork.kind, "postgres_unit_of_work");
    assert.equal(unitOfWork.query, undefined);
    assert.equal(unitOfWork.client, undefined);
    return "committed";
  });

  assert.equal(result, "committed");
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(client.releases, [false]);
  client.assertDrained();
  await assert.rejects(
    store.withTransaction(async () => {}, { uow: capturedUnitOfWork }),
    /postgres_unit_of_work_inactive/,
  );
  await assert.rejects(
    store.withTransaction(async () => {}, { unitOfWork: capturedUnitOfWork }),
    /postgres_transaction_unit_of_work_option_unsupported_use_uow/,
  );

  await store.close();
  await store.close();
  assert.equal(pool.endCount, 0);
  await assert.rejects(store.withTransaction(async () => {}), /postgres_store_closed/);
});

test("ProductPostgresStore exposes the Module Agent object authorization owner without a raw SQL client", async () => {
  const store = new ProductPostgresStore({ pool: new FakePool([]) });
  const authorizer = store.createAgentObjectAuthorizer({
    objectAccessPolicy: { evaluate: () => ({ allowed: false }) },
  });
  assert.equal(typeof authorizer, "function");
  await store.close();
});

test("close can explicitly take ownership of an injected Pool", async () => {
  const pool = new FakePool([]);
  const store = new ProductPostgresStore({ pool });

  await store.close({ closeInjectedPool: true });

  assert.equal(pool.endCount, 1);
});

test("connect destroys a client when the health query cannot confirm its state", async () => {
  const healthError = new Error("health response lost");
  const client = new ScriptedClient([
    failure("SELECT 1 AS ok", healthError),
  ]);
  const pool = new FakePool([client]);
  const store = new ProductPostgresStore({ pool });

  await assert.rejects(store.connect(), (error) => error === healthError);
  assert.deepEqual(client.releases, [healthError]);
  assert.equal(client.queries.length, 1);
  client.assertDrained();
});

test("bound adapters execute outer and nested work on the same private client", async () => {
  const outerQuery = { text: "SELECT $1::text AS value", values: ["outer"] };
  const nestedQuery = { text: "SELECT $1::text AS value", values: ["nested"] };
  const client = new ScriptedClient([
    step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
    step(outerQuery, { rows: [{ value: "outer" }] }),
    step(nestedQuery, { rows: [{ value: "nested" }] }),
    step("COMMIT"),
  ]);
  const pool = new FakePool([client]);
  const store = new ProductPostgresStore({ pool });
  const adapter = store.bindAdapter(({ execute }) => ({
    read: (uow, queryConfig) => execute(uow, queryConfig),
  }));

  const result = await store.withTransaction(async (uow) => {
    const outer = await adapter.read(uow, outerQuery);
    return store.withTransaction(async (nestedUow) => {
      assert.equal(nestedUow, uow);
      const nested = await adapter.read(nestedUow, nestedQuery);
      return [outer.rows[0].value, nested.rows[0].value];
    },
    { uow });
  });

  assert.deepEqual(result, ["outer", "nested"]);
  assert.equal(pool.connectCount, 1);
  client.assertDrained();
});

test("bound adapters reject foreign and inactive units of work", async () => {
  const ownerClient = new ScriptedClient([
    step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
    step("ROLLBACK"),
  ]);
  const ownerStore = new ProductPostgresStore({ pool: new FakePool([ownerClient]) });
  const foreignStore = new ProductPostgresStore({ pool: new FakePool([]) });
  const foreignAdapter = foreignStore.bindAdapter(({ execute }) => ({
    read: async (uow) => execute(uow, "SELECT 1"),
  }));
  let capturedUow;

  await assert.rejects(ownerStore.withTransaction(async (uow) => {
    capturedUow = uow;
    await foreignAdapter.read(uow);
  }), /postgres_unit_of_work_not_owned/);
  await assert.rejects(foreignAdapter.read(capturedUow), /postgres_unit_of_work_not_owned/);
  ownerClient.assertDrained();

  const inactiveClient = new ScriptedClient([
    step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
    step("COMMIT"),
  ]);
  const inactiveStore = new ProductPostgresStore({ pool: new FakePool([inactiveClient]) });
  const inactiveAdapter = inactiveStore.bindAdapter(({ execute }) => ({
    read: async (uow) => execute(uow, "SELECT 1"),
  }));
  let inactiveUow;
  await inactiveStore.withTransaction(async (uow) => { inactiveUow = uow; });

  await assert.rejects(inactiveAdapter.read(inactiveUow), /postgres_unit_of_work_inactive/);
  inactiveClient.assertDrained();
});

test("transaction failures roll back and non-retryable SQLSTATEs are not retried", async () => {
  const error = sqlStateError("23505");
  const client = new ScriptedClient([
    step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
    step("ROLLBACK"),
  ]);
  const pool = new FakePool([client]);
  const store = new ProductPostgresStore({ pool, retryDelay: async () => {} });

  await assert.rejects(store.withTransaction(async () => { throw error; }), (caught) => caught === error);
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(client.releases, [false]);
  client.assertDrained();
});

test("transaction destroys a client when BEGIN cannot confirm its state", async () => {
  const beginError = new Error("begin response lost");
  const client = new ScriptedClient([
    failure("BEGIN ISOLATION LEVEL SERIALIZABLE", beginError),
  ]);
  const pool = new FakePool([client]);
  const store = new ProductPostgresStore({ pool });
  let workCalled = false;

  await assert.rejects(store.withTransaction(async () => {
    workCalled = true;
  }), (error) => error === beginError);
  assert.equal(workCalled, false);
  assert.deepEqual(client.releases, [beginError]);
  assert.equal(client.queries.length, 1);
  client.assertDrained();
});

for (const code of ["40001", "40P01"]) {
  test(`transaction retries SQLSTATE ${code} within the configured bound`, async () => {
    const failedClient = new ScriptedClient([
      step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
      step("ROLLBACK"),
    ]);
    const successfulClient = new ScriptedClient([
      step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
      step("COMMIT"),
    ]);
    const pool = new FakePool([failedClient, successfulClient]);
    const retries = [];
    const store = new ProductPostgresStore({
      pool,
      maxTransactionRetries: 1,
      retryDelay: async (attempt, error) => retries.push({ attempt, code: error.code }),
    });
    let attempts = 0;

    const result = await store.withTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw sqlStateError(code);
      return "retried";
    });

    assert.equal(result, "retried");
    assert.equal(attempts, 2);
    assert.equal(pool.connectCount, 2);
    assert.deepEqual(retries, [{ attempt: 1, code }]);
    failedClient.assertDrained();
    successfulClient.assertDrained();
  });
}

test("transaction retry is bounded even for retryable SQLSTATEs", async () => {
  const clients = [0, 1].map(() => new ScriptedClient([
    step("BEGIN ISOLATION LEVEL SERIALIZABLE"),
    step("ROLLBACK"),
  ]));
  const pool = new FakePool(clients);
  const store = new ProductPostgresStore({
    pool,
    maxTransactionRetries: 1,
    retryDelay: async () => {},
  });
  let attempts = 0;

  await assert.rejects(store.withTransaction(async () => {
    attempts += 1;
    throw sqlStateError("40001");
  }), (error) => error?.code === "40001");

  assert.equal(attempts, 2);
  assert.equal(pool.connectCount, 2);
  clients.forEach((client) => client.assertDrained());
});

test("migration runner holds one advisory lock client and replays the baseline from its ledger", async () => {
  const migrations = await Promise.all(POSTGRES_MIGRATIONS.map(async (migration) => ({
    ...migration,
    sql: migration.sql ?? await migration.loadSql(),
  })));
  const checksums = new Map(migrations.map((migration) => [
    migration.version,
    `sha256:${createHash("sha256").update(migration.sql).digest("hex")}`,
  ]));
  const lockValues = [1280266061, 1346851660];
  const first = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }, lockValues),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: null }] }, ["public.product_schema_migrations"]),
    ...migrations.flatMap((migration) => [
      step("BEGIN"), step(migration.sql),
      step(/INSERT INTO public\.product_schema_migrations/, { rows: [] }, [
        migration.version, checksums.get(migration.version), migration.description,
      ]),
      step("COMMIT"),
    ]),
    step(/pg_advisory_unlock/, { rows: [{ unlocked: true }] }, lockValues),
  ]);
  const second = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }, lockValues),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: "product_schema_migrations" }] }, ["public.product_schema_migrations"]),
    step(/SELECT version, checksum/, { rows: migrations.map((migration) => ({
      version: migration.version, checksum: checksums.get(migration.version),
    })) }),
    step(/pg_advisory_unlock/, { rows: [{ unlocked: true }] }, lockValues),
  ]);
  const pool = new FakePool([first, second]);
  const runner = new PostgresMigrationRunner({ pool });

  assert.deepEqual(await runner.run(), {
    completed: migrations.map(({ version }) => ({ version, status: "applied" })),
  });
  assert.deepEqual(await runner.run(), {
    completed: migrations.map(({ version }) => ({ version, status: "already_applied" })),
  });
  assert.equal(pool.connectCount, 2);
  assert.deepEqual(first.releases, [undefined]);
  assert.deepEqual(second.releases, [undefined]);
  first.assertDrained();
  second.assertDrained();
});

test("migration lock contention fails closed without applying SQL", async () => {
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: false }] }),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({ pool });

  await assert.rejects(runner.run(), (error) => (
    error?.code === "postgres_migration_lock_unavailable" && error.retryable === true
  ));
  assert.deepEqual(client.releases, [undefined]);
  client.assertDrained();
});

test("migration runner destroys the client when advisory lock acquisition throws", async () => {
  const lockError = new Error("lock response lost");
  const client = new ScriptedClient([
    failure(/pg_try_advisory_lock/, lockError),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({ pool });

  await assert.rejects(runner.run(), (error) => error === lockError);
  assert.deepEqual(client.releases, [lockError]);
  assert.equal(client.queries.length, 1);
  client.assertDrained();
});

test("migration runner destroys the client when advisory lock result is malformed", async () => {
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{}] }),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({ pool });

  await assert.rejects(
    runner.run(),
    (error) => error?.code === "postgres_migration_lock_result_invalid",
  );
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0]?.code, "postgres_migration_lock_result_invalid");
  assert.equal(client.queries.length, 1);
  client.assertDrained();
});

test("migration candidate rejects duplicate three-digit ordinals", () => {
  const pool = new FakePool([]);

  assert.throws(
    () => new PostgresMigrationRunner({
      pool,
      migrations: [
        { version: "001_first", description: "First.", sql: "SELECT 1" },
        { version: "001_second", description: "Second.", sql: "SELECT 2" },
      ],
    }),
    (error) => error?.code === "postgres_migration_ordinal_duplicate",
  );
  assert.equal(pool.connectCount, 0);
});

test("migration runner rejects ledger checksum drift", async () => {
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: "product_schema_migrations" }] }),
    step(/SELECT version, checksum/, {
      rows: [{ version: "001_pg_baseline", checksum: `sha256:${"0".repeat(64)}` }],
    }),
    step(/pg_advisory_unlock/, { rows: [{ unlocked: true }] }),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({ pool });

  await assert.rejects(
    runner.run(),
    (error) => error?.code === "postgres_migration_checksum_drift",
  );
  assert.deepEqual(client.releases, [undefined]);
  client.assertDrained();
});

test("migration runner rejects migrations inserted before the maximum applied version", async () => {
  const migrations = [
    { version: "001_first", description: "First.", sql: "SELECT 1" },
    { version: "002_inserted", description: "Inserted later.", sql: "SELECT 2" },
    { version: "003_applied", description: "Already applied.", sql: "SELECT 3" },
  ];
  const checksum = (sql) => `sha256:${createHash("sha256").update(sql).digest("hex")}`;
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: "product_schema_migrations" }] }),
    step(/SELECT version, checksum/, { rows: [
      { version: "001_first", checksum: checksum("SELECT 1") },
      { version: "003_applied", checksum: checksum("SELECT 3") },
    ] }),
    step(/pg_advisory_unlock/, { rows: [{ unlocked: true }] }),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({ pool, migrations });

  await assert.rejects(
    runner.run(),
    (error) => error?.code === "postgres_migration_not_append_only",
  );
  assert.deepEqual(client.releases, [undefined]);
  client.assertDrained();
});

test("migration runner destroys the lock client when migration BEGIN is uncertain", async () => {
  const beginError = new Error("migration begin response lost");
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: null }] }),
    failure("BEGIN", beginError),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({
    pool,
    migrations: [{
      version: "001_begin_failure",
      description: "Exercise uncertain BEGIN.",
      sql: "SELECT business_sql",
    }],
  });

  await assert.rejects(runner.run(), (error) => (
    error?.code === "postgres_migration_begin_state_unknown"
    && error.cause === beginError
  ));
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0]?.code, "postgres_migration_begin_state_unknown");
  assert.equal(client.queries.length, 3);
  client.assertDrained();
});

test("migration runner destroys a client that cannot release its advisory lock", async () => {
  const sql = "SELECT 1";
  const checksum = `sha256:${createHash("sha256").update(sql).digest("hex")}`;
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: "product_schema_migrations" }] }),
    step(/SELECT version, checksum/, { rows: [{ version: "001_test", checksum }] }),
    step(/pg_advisory_unlock/, { rows: [{ unlocked: false }] }),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({
    pool,
    migrations: [{ version: "001_test", description: "Test migration.", sql }],
  });

  await assert.rejects(
    runner.run(),
    (error) => error?.code === "postgres_migration_unlock_failed",
  );
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0]?.code, "postgres_migration_unlock_failed");
  client.assertDrained();
});

test("migration failure rolls back before releasing the advisory lock", async () => {
  const migrationError = new Error("baseline failed");
  const client = new ScriptedClient([
    step(/pg_try_advisory_lock/, { rows: [{ locked: true }] }),
    step("SELECT to_regclass($1) AS relation", { rows: [{ relation: null }] }),
    step("BEGIN"),
    failure("SELECT broken", migrationError),
    step("ROLLBACK"),
    step(/pg_advisory_unlock/, { rows: [{ unlocked: true }] }),
  ]);
  const pool = new FakePool([client]);
  const runner = new PostgresMigrationRunner({
    pool,
    migrations: [{
      version: "001_broken",
      description: "Exercise rollback.",
      sql: "SELECT broken",
    }],
  });

  await assert.rejects(runner.run(), (error) => error === migrationError);
  assert.deepEqual(client.releases, [undefined]);
  client.assertDrained();
});
