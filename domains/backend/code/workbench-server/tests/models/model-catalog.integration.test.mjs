import assert from "node:assert/strict";
import test from "node:test";

import { ModelCatalog, ModelCatalogImporter } from "../../src/models/index.mjs";
import { ProductMongoStore } from "../../src/store/product-mongo-store.mjs";

const enabled = process.env.WORKBENCH_MONGO_INTEGRATION === "1";

test("model catalog survives restart and concurrent import in isolated Mongo", { skip: !enabled }, async () => {
  const dbName = process.env.MONGODB_DB || "looloomi_model_catalog_test";
  if (!dbName.endsWith("_test")) throw new TypeError("model_catalog_integration_requires_test_database");
  const options = {
    uri: process.env.WORKBENCH_MONGODB_URI ?? process.env.MONGODB_URI,
    dbName,
  };
  const store = new ProductMongoStore(options);
  try {
    await store.dropTestDatabase();
    const catalog = new ModelCatalog({
      store,
      readinessResolver: async () => ({ state: "ready" }),
    });
    const importer = new ModelCatalogImporter({ catalog });
    const configuration = { profiles: [{
      profileId: "mongo-chat",
      displayName: "Mongo chat",
      provider: "openai",
      protocol: "openai_compatible_chat",
      providerModelId: "gpt-model",
      capabilities: ["chat", "tool_calling"],
      credentialRef: "openai-main",
      scope: "workspace",
      workspaceId: "workspace-mongo",
      enabled: true,
    }] };
    const imported = await Promise.all([
      importer.importConfiguration(configuration),
      importer.importConfiguration(configuration),
      importer.importConfiguration(configuration),
    ]);
    assert.equal(new Set(imported.map((result) => result.profiles[0].revision.revisionId)).size, 1);
    assert.equal(await store.db.collection("model_profile_revisions").countDocuments({ profileId: "mongo-chat" }), 1);

    await store.close();
    const reopened = new ProductMongoStore(options);
    try {
      const readCatalog = new ModelCatalog({
        store: reopened,
        readinessResolver: async () => ({ state: "ready" }),
      });
      const profiles = await readCatalog.listProfiles({
        workspaceId: "workspace-mongo",
        capabilities: ["chat"],
      });
      assert.deepEqual(profiles.map((profile) => profile.profileId), ["mongo-chat"]);
      await reopened.dropTestDatabase();
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
  }
});
