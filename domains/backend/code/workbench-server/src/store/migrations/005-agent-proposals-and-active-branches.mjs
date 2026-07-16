import { PRODUCT_COLLECTIONS, PRODUCT_INDEX_DEFINITIONS } from "../constants.mjs";
import { collectionDigest, defineMigration } from "./migration-runner.mjs";

const COLLECTIONS = Object.freeze([
  PRODUCT_COLLECTIONS.agentBranches,
  PRODUCT_COLLECTIONS.agentObjectProposals,
]);

export const agentProposalsAndActiveBranchesMigration = defineMigration({
  version: "005-agent-proposals-and-active-branches",
  description: "Add personal Agent proposal storage and one-active-branch-per-user/object enforcement.",
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
