import assert from "node:assert/strict";

import { createWorkbenchApiClient } from "../src/api/client.js";
import { workbenchKeys } from "../src/api/queryKeys.js";
import { defaultModelSelection, modelPickerOptions, normalizeModelFilters } from "../src/state/models/modelCatalog.js";

const requests = [];
function response(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const fetchImpl = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).endsWith("/workspace")) {
    return response({ session: { csrfToken: "csrf-model-routing" } });
  }
  if (String(url).includes("/model-profiles")) return response([]);
  if (String(url).endsWith("/agent-sessions")) {
    return response({ sessionId: "session-main", activeTurnId: null }, { status: 201 });
  }
  if (String(url).endsWith("/agent-sessions/session-main/model")) {
    return response({ sessionId: "session-main", lastUsedModelProfileId: "profile-chat" });
  }
  if (String(url).endsWith("/agent-sessions/session-main/turns")) {
    return response({ turnId: "turn-1", status: "queued" }, { status: 202 });
  }
  if (String(url).endsWith("/artifacts/artifact-1")) {
    return response({ artifactId: "artifact-1", state: "ready" });
  }
  throw new Error(`unexpected_request:${url}`);
};

const api = createWorkbenchApiClient({ fetchImpl });
await api.bootstrap();
await api.listModelProfiles({
  capabilities: ["structured_output", "chat", "tool_calling"],
  context: "builder",
  selectedRevisionId: "revision-history",
});
const catalogRequest = requests.at(-1);
assert.match(catalogRequest.url, /capabilities=structured_output%2Cchat%2Ctool_calling/);
assert.match(catalogRequest.url, /context=builder/);
assert.match(catalogRequest.url, /selectedRevisionId=revision-history/);

await api.createAgentSession({ definitionId: "main" }, { idempotencyKey: "session-key" });
await api.selectAgentSessionModel("session-main", { modelProfileId: "profile-chat" }, { idempotencyKey: "model-key" });
const preferenceRequest = requests.at(-1);
assert.deepEqual(JSON.parse(preferenceRequest.options.body).data, { modelProfileId: "profile-chat" });
await api.createAgentTurn("session-main", {
  kind: "agent_message",
  modelProfileRevisionId: "revision-chat-7",
  input: { message: "Prepare a concise plan." },
}, { idempotencyKey: "turn-key" });
const chatRequest = requests.at(-1);
assert.deepEqual(JSON.parse(chatRequest.options.body).data, {
  kind: "agent_message",
  modelProfileRevisionId: "revision-chat-7",
  input: { message: "Prepare a concise plan." },
});

await api.createAgentTurn("session-main", {
  kind: "model_task",
  modelProfileRevisionId: "revision-image-3",
  input: { task: "image_generation", prompt: "A calm blue workspace", aspectRatio: "16:9", outputFormat: "png" },
}, { idempotencyKey: "image-key" });
const imageRequest = requests.at(-1);
assert.deepEqual(JSON.parse(imageRequest.options.body).data, {
  kind: "model_task",
  modelProfileRevisionId: "revision-image-3",
  input: { task: "image_generation", prompt: "A calm blue workspace", aspectRatio: "16:9", outputFormat: "png" },
});

assert.equal(api.artifactContentUrl("artifact 1"), "/api/workbench/v1/artifacts/artifact%201/content");
await api.getArtifact("artifact-1");
assert.match(requests.at(-1).url, /\/artifacts\/artifact-1$/);

const filters = normalizeModelFilters({
  capabilities: ["tool_calling", "chat", "chat", "not-a-capability"],
  context: "agent_controller",
  selectedRevisionId: "revision-old",
});
assert.deepEqual(filters.capabilities, ["chat", "tool_calling"]);
assert.notDeepEqual(
  workbenchKeys.modelProfiles(filters),
  workbenchKeys.modelProfiles({ ...filters, context: "builder" }),
  "model catalog cache keys must isolate selection contexts",
);
assert.notDeepEqual(
  workbenchKeys.modelProfiles(filters),
  workbenchKeys.modelProfiles({ ...filters, selectedRevisionId: "revision-other" }),
  "historical selections must not share catalog cache entries",
);

const profiles = [{
  profileId: "profile-chat",
  displayName: "Chat model",
  enabled: true,
  readiness: "ready",
  selectable: true,
  currentRevision: {
    revisionId: "revision-current",
    revisionNumber: 4,
    capabilities: ["chat", "tool_calling"],
    providerDisplay: { key: "openai", label: "OpenAI" },
  },
  historicalRevision: {
    revisionId: "revision-old",
    revisionNumber: 2,
    capabilities: ["chat", "tool_calling"],
    providerDisplay: { key: "openai", label: "OpenAI" },
  },
}];
const historyOptions = modelPickerOptions(profiles, {
  requiredCapabilities: ["chat", "tool_calling"],
  selectionKind: "revision",
  selectedValue: "revision-old",
});
assert.equal(historyOptions[0].value, "revision-old");
assert.equal(historyOptions[0].historical, true);
assert.equal(historyOptions[0].disabled, true);
assert.equal(historyOptions[1].value, "revision-current");
assert.equal(historyOptions[1].disabled, false);

const degraded = [{
  profileId: "profile-degraded",
  displayName: "Degraded but selectable",
  enabled: true,
  readiness: "degraded",
  selectable: true,
  defaultForCapabilities: ["chat"],
  currentRevision: { revisionId: "revision-degraded", capabilities: ["chat"] },
}];
assert.equal(modelPickerOptions(degraded, { requiredCapabilities: ["chat"] })[0].disabled, false);
assert.equal(defaultModelSelection(degraded, "chat"), "revision-degraded");

const imageOnly = [{
  profileId: "profile-image",
  displayName: "Stable Image",
  enabled: true,
  readiness: "ready",
  selectable: true,
  currentRevision: { revisionId: "revision-image", capabilities: ["image_generation"] },
}];
assert.equal(modelPickerOptions(imageOnly, { requiredCapabilities: ["chat", "tool_calling"] }).length, 0);

console.log("web_model_routing_smoke=pass");
