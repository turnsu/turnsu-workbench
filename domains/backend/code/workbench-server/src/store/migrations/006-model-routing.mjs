import { PRODUCT_COLLECTIONS, PRODUCT_INDEX_DEFINITIONS } from "../constants.mjs";
import { collectionDigest, defineMigration } from "./migration-runner.mjs";

export const MODEL_ROUTING_COLLECTIONS = Object.freeze([
  PRODUCT_COLLECTIONS.modelProfiles,
  PRODUCT_COLLECTIONS.modelProfileRevisions,
  PRODUCT_COLLECTIONS.modelRoutingPolicies,
  PRODUCT_COLLECTIONS.productArtifacts,
]);

export const modelRoutingMigration = defineMigration({
  version: "006-model-routing",
  description: "Add immutable model catalog revisions, workspace routing policy, and governed Artifact metadata.",
  async inspect({ db }) {
    const collections = {};
    for (const name of MODEL_ROUTING_COLLECTIONS) {
      collections[name] = await collectionDigest(db.collection(name));
    }
    return { collections };
  },
  async apply({ db }) {
    for (const name of MODEL_ROUTING_COLLECTIONS) {
      const definition = PRODUCT_INDEX_DEFINITIONS.find((entry) => entry.collection === name);
      if (!definition) throw new TypeError(`product_index_definition_missing:${name}`);
      await db.collection(name).createIndexes(
        definition.indexes.map(({ key, options }) => ({ key, ...options })),
      );
    }
    return { collections: [...MODEL_ROUTING_COLLECTIONS], createdIndexes: true };
  },
});
