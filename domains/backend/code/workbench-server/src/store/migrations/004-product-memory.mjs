import { PRODUCT_COLLECTIONS, PRODUCT_INDEX_DEFINITIONS } from "../constants.mjs";
import { collectionDigest, defineMigration } from "./migration-runner.mjs";

const COLLECTIONS = Object.freeze([
  PRODUCT_COLLECTIONS.memoryCandidates,
  PRODUCT_COLLECTIONS.durableMemories,
  PRODUCT_COLLECTIONS.memoryEvents,
  PRODUCT_COLLECTIONS.memoryDeletionTombstones,
]);

export const productMemoryMigration = defineMigration({
  version: "004-product-memory",
  description: "Create Product-owned governed Memory candidate, durable fact, event, and deletion tombstone storage.",
  async inspect({ db }) {
    const collections = {};
    for (const name of COLLECTIONS) collections[name] = await collectionDigest(db.collection(name));
    return { collections };
  },
  async apply({ db }) {
    for (const name of COLLECTIONS) {
      const definition = PRODUCT_INDEX_DEFINITIONS.find((entry) => entry.collection === name);
      await db.collection(name).createIndexes(definition.indexes.map(({ key, options }) => ({ key, ...options })));
    }
    return { collections: [...COLLECTIONS], createdIndexes: true };
  },
});
