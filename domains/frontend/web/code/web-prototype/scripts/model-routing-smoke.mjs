import assert from "node:assert/strict";

import { createWorkbenchApiClient } from "../src/api/client.js";
import { workbenchKeys } from "../src/api/queryKeys.js";
import { defaultModelSelection, modelPickerOptions, normalizeModelFilters } from "../src/state/models/modelCatalog.js";

const requests = [];
let selectionAttempts = 0;
const modelSession = {
  schemaVersion: "workbench-v1",
  sessionId: "session-main",
  definitionId: "main",
  userId: "user-model-routing",
  workspaceId: "workspace-model-routing",
  scope: { kind: "main" },
  title: "Main task",
  source: { kind: "manual" },
  taskStatus: "idle",
  archived: false,
  status: "active",
  lastUsedModelProfileId: "profile-chat",
  modelPreferenceState: "preference_only",
  activeTurnId: null,
  createdAt: "2026-07-10T09:00:00.000Z",
  updatedAt: "2026-07-10T09:00:00.000Z",
};
function response(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const fetchImpl = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).endsWith("/workspace")) {
    return new Response(JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: {
        workspace: {
          workspaceId: "workspace-model-routing",
          name: "Model routing workspace",
          capabilities: {
            builderProposal: false,
            resources: false,
            maxParallelism: 1,
          },
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T09:00:00.000Z",
        },
        session: {
          csrfToken: "c".repeat(32),
          expiresAt: "2026-07-10T10:00:00.000Z",
          userId: "user-model-routing",
          workspaceId: "workspace-model-routing",
        },
      },
      requestId: "request-model-routing",
    }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (String(url).includes("/model-profiles")) {
    return new Response(JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: [],
      page: { nextCursor: null, hasMore: false },
      requestId: "request-model-list",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (String(url).endsWith("/agent-sessions")) {
    return response({ sessionId: "session-main", activeTurnId: null }, { status: 201 });
  }
  if (String(url).endsWith("/agent-sessions/session-main/model")) {
    selectionAttempts += 1;
    if (selectionAttempts === 1) {
      return new Response(JSON.stringify({
        code: "csrf_invalid",
        message: "Refresh the browser session.",
        details: {},
        retryable: false,
        requestId: "request-model-csrf",
      }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: modelSession,
      requestId: "request-model-select",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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
const catalogController = new AbortController();
await api.listModelProfiles({
  capabilities: ["structured_output", "chat", "tool_calling"],
  context: "builder",
  selectedRevisionId: "revision-history",
  cursor: "cursor-model-2",
  limit: 25,
}, { signal: catalogController.signal });
const catalogRequest = requests.at(-1);
assert.match(catalogRequest.url, /capabilities=structured_output%2Cchat%2Ctool_calling/);
assert.match(catalogRequest.url, /context=builder/);
assert.match(catalogRequest.url, /selectedRevisionId=revision-history/);
assert.match(catalogRequest.url, /cursor=cursor-model-2/);
assert.match(catalogRequest.url, /limit=25/);
assert.equal(catalogRequest.options.signal, catalogController.signal);

await api.createAgentSession({ definitionId: "main" }, { idempotencyKey: "session-key" });
await api.selectAgentSessionModel("session-main", { modelProfileId: "profile-chat" }, { idempotencyKey: "model-key" });
const preferenceRequest = requests.at(-1);
assert.deepEqual(JSON.parse(preferenceRequest.options.body).data, { modelProfileId: "profile-chat" });
const preferenceRequests = requests.filter(({ url }) => url.endsWith("/agent-sessions/session-main/model"));
assert.equal(preferenceRequests.length, 2);
assert.equal(preferenceRequests[0].options.headers.get("Idempotency-Key"), "model-key");
assert.equal(preferenceRequests[1].options.headers.get("Idempotency-Key"), "model-key");
await api.createAgentTurn("session-main", {
  kind: "agent_message",
  modelProfileId: "profile-chat",
  input: { message: "Prepare a concise plan." },
}, { idempotencyKey: "turn-key" });
const chatRequest = requests.at(-1);
assert.deepEqual(JSON.parse(chatRequest.options.body).data, {
  kind: "agent_message",
  modelProfileId: "profile-chat",
  input: { message: "Prepare a concise plan." },
});

await api.createAgentTurn("session-main", {
  kind: "model_task",
  modelProfileId: "profile-image",
  input: { task: "image_generation", prompt: "A calm blue workspace", aspectRatio: "16:9", outputFormat: "png" },
}, { idempotencyKey: "image-key" });
const imageRequest = requests.at(-1);
assert.deepEqual(JSON.parse(imageRequest.options.body).data, {
  kind: "model_task",
  modelProfileId: "profile-image",
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
assert.notDeepEqual(
  workbenchKeys.modelProfiles(filters),
  workbenchKeys.modelProfiles({ ...filters, profileId: "profile-target" }),
  "exact recovery targets must not share catalog cache entries",
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
