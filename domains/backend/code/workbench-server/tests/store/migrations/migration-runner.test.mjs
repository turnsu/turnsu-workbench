import assert from "node:assert/strict";
import test from "node:test";

import {
  backfillDefaultWorkspaceMigration,
  agentExecutionFabricMigration,
  defineMigration,
  MigrationError,
  productMemoryMigration,
  ProductMigrationRunner,
  runnerTerminalTransitionsMigration,
} from "../../../src/store/migrations/index.mjs";

class FakeCollection {
  constructor(documents = []) {
    this.documents = documents.map((document) => structuredClone(document));
    this.indexes = [];
  }

  find(filter = {}) {
    const rows = this.documents.filter((document) => matches(document, filter)).map((document) => structuredClone(document));
    return {
      sort: () => ({ toArray: async () => rows }),
      toArray: async () => rows,
    };
  }

  async countDocuments(filter = {}) {
    return this.documents.filter((document) => matches(document, filter)).length;
  }

  async findOne(filter = {}, { sort } = {}) {
    const rows = this.documents.filter((document) => matches(document, filter));
    if (sort) {
      const [[key, direction]] = Object.entries(sort);
      rows.sort((left, right) => direction * ((left[key] > right[key]) - (left[key] < right[key])));
    }
    return rows.length ? structuredClone(rows[0]) : null;
  }

  async insertOne(document) {
    if (this.documents.some((entry) => entry._id === document._id)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    this.documents.push(structuredClone(document));
    return { acknowledged: true };
  }

  async updateMany(filter, update) {
    let modifiedCount = 0;
    for (const document of this.documents) {
      if (!matches(document, filter)) continue;
      applyUpdate(document, update, false);
      modifiedCount += 1;
    }
    return { modifiedCount };
  }

  async updateOne(filter, update, { upsert = false } = {}) {
    let document = this.documents.find((entry) => matches(entry, filter));
    if (!document && upsert) {
      document = baseFromFilter(filter);
      this.documents.push(document);
      applyUpdate(document, update, true);
      return { upsertedCount: 1, modifiedCount: 0 };
    }
    if (!document) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(document, update, false);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(filter, update, { upsert = false } = {}) {
    let document = this.documents.find((entry) => matches(entry, filter));
    if (!document && upsert) {
      const candidate = baseFromFilter(filter);
      if (this.documents.some((entry) => entry._id === candidate._id)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      document = candidate;
      this.documents.push(document);
      applyUpdate(document, update, true);
      return structuredClone(document);
    }
    if (!document) return null;
    applyUpdate(document, update, false);
    return structuredClone(document);
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index >= 0) this.documents.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  }

  async createIndexes(indexes) {
    this.indexes.push(...structuredClone(indexes));
    return indexes.map((index) => index.name);
  }
}

class FakeDb {
  constructor(collections = {}) {
    this.collections = new Map(Object.entries(collections).map(([name, rows]) => [name, new FakeCollection(rows)]));
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection());
    return this.collections.get(name);
  }
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(document, branch));
    const actual = document[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, "$exists")) return expected.$exists ? actual !== undefined : actual === undefined;
      if (Object.hasOwn(expected, "$lte")) return actual <= expected.$lte;
      if (Object.hasOwn(expected, "$in")) return expected.$in.includes(actual);
    }
    return actual === expected;
  });
}

function baseFromFilter(filter) {
  const result = {};
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("$") && !(value && typeof value === "object")) result[key] = value;
  }
  return result;
}

function applyUpdate(document, update, inserting) {
  if (update.$set) Object.assign(document, structuredClone(update.$set));
  if (inserting && update.$setOnInsert) Object.assign(document, structuredClone(update.$setOnInsert));
}

function migration(version, description = version) {
  return defineMigration({
    version,
    description,
    inspect: async () => ({ inspected: version }),
    apply: async () => ({ applied: version }),
  });
}

test("migration runner dry-run does not create a ledger or mutate legacy rows", async () => {
  const db = new FakeDb({
    skills: [{ _id: "skill-1", skillId: "skill-1" }],
    workflows: [{ _id: "workflow-1", workflowId: "workflow-1" }],
  });
  const runner = new ProductMigrationRunner({
    db,
    migrations: [backfillDefaultWorkspaceMigration],
    clock: () => new Date("2026-07-10T00:00:00.000Z"),
  });
  const result = await runner.run({ dryRun: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.pending, ["001-backfill-default-workspace"]);
  assert.equal(db.collection("skills").documents[0].workspaceId, undefined);
  assert.equal(db.collection("product_schema_migrations").documents.length, 0);
  assert.equal(result.reports[0].collections.skills.missingWorkspace, 1);
});

test("backfill migration is idempotent, retains existing tenant values, and records checksums", async () => {
  const db = new FakeDb({
    skills: [
      { _id: "skill-1", skillId: "skill-1" },
      { _id: "skill-2", skillId: "skill-2", workspaceId: "workspace-existing", ownerId: "user-existing" },
    ],
    templates: [{ _id: "template-1", templateId: "template-1" }],
    workflows: [{ _id: "workflow-1", workflowId: "workflow-1" }],
    runs: [{ _id: "run-1", runId: "run-1" }],
  });
  const runner = new ProductMigrationRunner({
    db,
    migrations: [backfillDefaultWorkspaceMigration],
    clock: () => new Date("2026-07-10T00:00:00.000Z"),
  });

  const first = await runner.run({
    context: { defaultWorkspaceId: "workspace-private", defaultOwnerId: "user-owner" },
  });
  assert.equal(first.completed[0].status, "applied");
  assert.equal(db.collection("skills").documents[0].workspaceId, "workspace-private");
  assert.equal(db.collection("skills").documents[0].ownerId, "user-owner");
  assert.equal(db.collection("skills").documents[1].workspaceId, "workspace-existing");
  assert.equal(db.collection("skills").documents[1].ownerId, "user-existing");
  assert.equal(db.collection("templates").documents[0].lifecycleProjection, "pending");
  assert.equal(db.collection("product_workspaces").documents[0].workspaceId, "workspace-private");
  assert.equal(db.collection("workspace_memberships").documents[0].role, "owner");
  assert.match(db.collection("product_schema_migrations").documents[0].checksum, /^sha256:/);

  const second = await runner.run();
  assert.deepEqual(second.completed, [{ version: "001-backfill-default-workspace", status: "already_applied" }]);
});

test("terminal transition migration plans, backfills one marker per terminal Run, and replays safely", async () => {
  const db = new FakeDb({
    runs: [
      { _id: "run-completed", runId: "run-completed", status: "completed", finishedAt: "2026-07-10T00:00:00.000Z" },
      { _id: "run-failed", runId: "run-failed", status: "failed", updatedAt: "2026-07-10T00:00:01.000Z" },
      { _id: "run-active", runId: "run-active", status: "running" },
    ],
    run_events: [
      { _id: "event-completed", eventId: "event-completed", runId: "run-completed", type: "run.completed", sequence: 7 },
    ],
  });
  const runner = new ProductMigrationRunner({
    db,
    migrations: [runnerTerminalTransitionsMigration],
    clock: () => new Date("2026-07-10T00:00:02.000Z"),
  });

  const plan = await runner.run({ dryRun: true });
  assert.deepEqual(plan.pending, ["002-runner-terminal-transitions"]);
  assert.equal(db.collection("run_terminal_transitions").documents.length, 0);

  const first = await runner.run();
  assert.deepEqual(first.completed[0].result, {
    inserted: 1,
    existing: 0,
    skippedWithoutTerminalEvent: 1,
  });
  assert.deepEqual(db.collection("run_terminal_transitions").documents[0], {
    runId: "run-completed",
    schemaVersion: "workbench-v1",
    terminalTransitionId: "terminal:run-completed:completed",
    logicalEventId: "terminal:run-completed:completed",
    status: "completed",
    eventId: "event-completed",
    checkpointId: null,
    committedAt: "2026-07-10T00:00:00.000Z",
  });

  const second = await runner.run();
  assert.deepEqual(second.completed, [{
    version: "002-runner-terminal-transitions",
    status: "already_applied",
  }]);
});

test("execution fabric migration creates durable execution and personal Agent session indexes", async () => {
  const db = new FakeDb();
  const runner = new ProductMigrationRunner({
    db,
    migrations: [agentExecutionFabricMigration],
    clock: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  const planned = await runner.plan();
  assert.deepEqual(planned.pending, ["003-agent-execution-fabric"]);
  const result = await runner.run();
  assert.equal(result.completed[0].result.createdIndexes, true);
  for (const name of [
    "execution_invocations",
    "execution_attempts",
    "execution_events",
    "execution_checkpoints",
    "capability_leases",
    "agent_sessions",
    "agent_turns",
    "agent_messages",
    "agent_branches",
    "agent_session_events",
    "agent_handoffs",
    "merge_conflicts",
  ]) {
    assert.ok(db.collection(name).indexes.length >= 2, name);
  }
});

test("Product Memory migration creates governed candidate, durable, event, and tombstone indexes", async () => {
  const db = new FakeDb();
  const runner = new ProductMigrationRunner({
    db,
    migrations: [productMemoryMigration],
    clock: () => new Date("2026-07-16T00:00:00.000Z"),
  });
  assert.deepEqual((await runner.plan()).pending, ["004-product-memory"]);
  const result = await runner.run();
  assert.equal(result.completed[0].result.createdIndexes, true);
  for (const name of ["memory_candidates", "durable_memories", "memory_events", "memory_deletion_tombstones"]) {
    assert.ok(db.collection(name).indexes.length >= 2, name);
  }
  assert.ok(db.collection("durable_memories").indexes.some((index) => index.name === "memory_text"));
  assert.ok(db.collection("durable_memories").indexes.some((index) => index.name === "expiresAt_ttl"));
});

test("migration runner refuses checksum drift and an active foreign lock", async () => {
  const db = new FakeDb({
    product_schema_migrations: [{ _id: "010-test", version: "010-test", status: "applied", checksum: "sha256:wrong" }],
  });
  const runner = new ProductMigrationRunner({ db, migrations: [migration("010-test")] });
  await assert.rejects(
    runner.plan(),
    (error) => error instanceof MigrationError && error.code === "migration_checksum_drift",
  );

  const locked = new FakeDb({
    product_migration_locks: [{
      _id: "workbench-product-migrations",
      ownerId: "other-process",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }],
  });
  const lockedRunner = new ProductMigrationRunner({
    db: locked,
    migrations: [migration("011-test")],
    clock: () => new Date("2026-07-10T00:00:00.000Z"),
  });
  await assert.rejects(
    lockedRunner.run(),
    (error) => error instanceof MigrationError && error.code === "migration_lock_unavailable",
  );
});
