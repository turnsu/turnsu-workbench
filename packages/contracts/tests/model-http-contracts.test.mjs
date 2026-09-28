import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelCatalogQuerySchema,
  CreateModelProfileRequestSchema,
  WORKBENCH_V1_MODEL_ENDPOINTS,
} from "../dist/model-http.js";
import { Check } from "../dist/value.js";

test("model HTTP leaf exposes governed configuration, catalog and Session preference", () => {
  assert.deepEqual(Object.keys(WORKBENCH_V1_MODEL_ENDPOINTS), [
    "createModelProfile",
    "listModelProfiles",
    "selectAgentSessionModel",
  ]);
  assert.equal(Check(ModelCatalogQuerySchema, {
    profileId: "model-profile-chat",
    capabilities: "chat,tool_calling",
    context: "agent_controller",
    cursor: "cursor-2",
    limit: 25,
  }), true);
  assert.equal(Check(ModelCatalogQuerySchema, { profileId: "not valid" }), false);
  assert.equal(Check(ModelCatalogQuerySchema, { capabilities: ["chat"] }), false);
  assert.deepEqual(
    WORKBENCH_V1_MODEL_ENDPOINTS.selectAgentSessionModel.requiredRequestHeaders,
    ["Idempotency-Key"],
  );
});

test("model setup accepts references and rejects raw credentials or browser-chosen authority", () => {
  const data = { displayName: "My model", provider: "deepseek", providerModelId: "provider-model",
    secretRef: "workspace-model:1", makeDefault: true };
  const request = (value) => ({ schemaVersion: "workbench-api-v1", data: value });
  assert.equal(Check(CreateModelProfileRequestSchema, request(data)), true);
  for (const extra of [{ apiKey: "not-a-product-field" }, { endpoint: "https://other.example" },
    { workspaceId: "other-workspace" }, { scopeId: "other-scope" }]) {
    assert.equal(Check(CreateModelProfileRequestSchema, request({ ...data, ...extra })), false);
  }
  for (const secretRef of ["../secret:1", "secret:0", "raw-key-without-revision"]) {
    assert.equal(Check(CreateModelProfileRequestSchema, request({ ...data, secretRef })), false);
  }
  assert.deepEqual(WORKBENCH_V1_MODEL_ENDPOINTS.createModelProfile.requiredRequestHeaders, ["Idempotency-Key"]);
});
