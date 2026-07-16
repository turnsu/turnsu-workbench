import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MongoMemoryPersistence, ProductMemoryService } from "../../src/memory/index.mjs";
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
  });
  const context = { userId: "user-owner", workspaceId: "workspace-memory", role: "owner" };

  let store = makeStore();
  await store.dropTestDatabase();
  const submitted = await makeService(store).submitCandidate({
    input: {
      scope: { kind: "workspace" },
      subject: { kind: "workflow", subjectId: "workflow-memory" },
      statement: "Canonical memory persists across service restart.",
      tags: ["restart"],
      source: { kind: "canonical_object", sourceId: "workflow-memory", versionId: "revision-1", verified: true },
      evidence: [{ kind: "validation", ref: "validation:memory", hash: "sha256:0123456789abcdef" }],
      confidence: 0.95,
      sensitivity: "low",
      expiresAt: null,
    },
    actor: { kind: "agent", id: "agent-main" },
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
