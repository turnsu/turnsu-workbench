import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  CanonicalMemoryResolver,
  MongoMemoryPersistence,
  ProductMemoryService,
} from "../../src/memory/index.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const enabled = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const dbName = "looloomi_product_memory_test";

test("Mongo Product Memory survives restart and physically deletes content", { skip: !enabled }, async (t) => {
  const stores = [];
  t.after(async () => {
    const last = stores.at(-1);
    if (last) await last.dropTestDatabase().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
  });
  const makeStore = () => {
    const store = new ProductMongoStore({ dbName });
    stores.push(store);
    return store;
  };
  const makeService = (store) => new ProductMemoryService({
    persistence: new MongoMemoryPersistence({ store }),
    idFactory: (kind) => `${kind}-${randomUUID()}`,
    canonicalResolver: new CanonicalMemoryResolver({ store }),
  });
  const context = { userId: "user-owner", workspaceId: "workspace-memory", role: "owner" };

  let store = makeStore();
  await store.dropTestDatabase();
  await store.connect();
  await store.repositories.workflows.collection.insertOne({
    schemaVersion: "workbench-v1",
    workflowId: "workflow-memory",
    workspaceId: context.workspaceId,
    ownerId: context.userId,
    currentRevisionId: "revision-1",
    revisionNumber: 1,
    writeVersion: 1,
    status: "ready",
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:00.000Z",
  });
  await store.repositories.workflowRevisions.insert({
    schemaVersion: "workbench-v1",
    workflowId: "workflow-memory",
    revisionId: "revision-1",
    revisionNumber: 1,
    definition: { goal: "Canonical memory persists across service restart." },
    graph: { nodes: [], edges: [] },
  });
  await store.repositories.compileResults.insert({
    compileResultId: "compile-memory",
    workflowRevisionId: "revision-1",
    status: "ready",
    diagnostics: [],
    executionPlan: {
      workflowId: "workflow-memory",
      workflowRevisionId: "revision-1",
    },
    compiledAt: "2026-07-16T10:00:00.000Z",
  });
  const submitted = await makeService(store).ingestCanonicalFact({
    input: {
      scope: { kind: "workspace" },
      subject: { kind: "workflow", subjectId: "workflow-memory" },
      statement: "Caller text is ignored for automatic promotion.",
      tags: ["restart"],
      confidence: 0.95,
      sensitivity: "low",
      expiresAt: null,
    },
    canonicalRef: {
      objectKind: "workflow",
      objectId: "workflow-memory",
      versionId: "revision-1",
      factPath: "/definition/goal",
    },
    context,
  });
  assert.equal(submitted.status, "promoted");
  await store.close();

  store = makeStore();
  const restarted = makeService(store);
  const [result] = await restarted.query({ query: { scopes: ["workspace"], tags: ["restart"], limit: 10 }, context });
  assert.equal(result.memory.statement, "Canonical memory persists across service restart.");
  const tombstone = await restarted.deleteMemory({ memoryId: result.memory.memoryId, reason: "Integration deletion proof.", context });
  assert.match(tombstone.memoryIdHash, /^sha256:/);
  assert.equal(await store.repositories.durableMemories.collection.countDocuments({ memoryId: result.memory.memoryId }), 0);
  const storedTombstone = await store.repositories.memoryDeletionTombstones.collection.findOne({ tombstoneId: tombstone.tombstoneId });
  assert.equal(Object.hasOwn(storedTombstone, "statement"), false);
  assert.equal(Object.hasOwn(storedTombstone, "memoryId"), false);
});
