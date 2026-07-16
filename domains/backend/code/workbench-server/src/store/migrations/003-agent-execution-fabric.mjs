import { PRODUCT_COLLECTIONS, PRODUCT_INDEX_DEFINITIONS } from "../constants.mjs";
import { collectionDigest, defineMigration } from "./migration-runner.mjs";

const COLLECTIONS = Object.freeze([
  PRODUCT_COLLECTIONS.executionInvocations,
  PRODUCT_COLLECTIONS.executionAttempts,
  PRODUCT_COLLECTIONS.executionEvents,
  PRODUCT_COLLECTIONS.executionCheckpoints,
  PRODUCT_COLLECTIONS.capabilityLeases,
]);

export const agentExecutionFabricMigration = defineMigration({
  version: "003-agent-execution-fabric",
  description: "Create durable Agent execution invocation, attempt, event, checkpoint, and capability lease storage.",
  async inspect({ db }) {
    const collections = {};
    for (const name of COLLECTIONS) collections[name] = await collectionDigest(db.collection(name));
    return { collections };
  },
  async apply({ db }) {
    for (const name of COLLECTIONS) {
      const definition = PRODUCT_INDEX_DEFINITIONS.find((entry) => entry.collection === name);
      await db.collection(name).createIndexes(
        definition.indexes.map(({ key, options }) => ({ key, ...options })),
      );
    }
    return { collections: [...COLLECTIONS], createdIndexes: true };
  },
});
