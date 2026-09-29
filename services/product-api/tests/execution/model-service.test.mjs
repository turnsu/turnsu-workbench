import assert from "node:assert/strict";
import test from "node:test";

import {
  configurationFromEnvironment,
  createModelService,
} from "../../src/execution/index.mjs";

test("prompt Skill model selection retains its requesting user's scope and capability requirements", async () => {
  const seen = [];
  const catalog = {
    async listProfiles() { return []; },
    async getWorkspacePolicy(workspaceId, options) {
      seen.push({ workspaceId, ...options });
      return { defaultProfileIdsByCapability: { chat: "alice-chat" } };
    },
    async resolveCurrentProfile(options) {
      seen.push(options);
      if (options.userId !== "alice") throw new Error("model_profile_not_found");
      return { profile: { profileId: "alice-chat" }, revision: { revisionId: "alice-chat-v1" } };
    },
    async resolveRevision(options) { return this.resolveCurrentProfile(options); },
  };
  const service = createModelService({ catalog });
  const selected = await service.resolveTurnSelection({ workspaceId: "workspace-a", userId: "alice", kind: "interactive", requiredCapabilities: ["chat", "tool_calling"] });
  assert.equal(selected.modelProfileRevisionId, "alice-chat-v1");
  assert.deepEqual(seen[0], { workspaceId: "workspace-a", userId: "alice" });
  assert.deepEqual(seen[1], { profileId: "alice-chat", workspaceId: "workspace-a", userId: "alice", capabilities: ["chat", "tool_calling"], requireReady: true });
  await assert.rejects(service.resolveTurnSelection({ workspaceId: "workspace-a", userId: "bob", explicitRevisionId: "alice-chat-v1", requiredCapabilities: ["chat"] }), /model_profile_not_found/);
});

function modelInput(text = "Hello") {
  return {
    context: {
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      tools: [],
    },
    options: { maxTokens: 64 },
  };
}

function completion(text) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: text } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("operator catalog import configuration contains no runtime credentials", () => {
  const configured = configurationFromEnvironment({
    WORKBENCH_MODEL_CATALOG_IMPORT_JSON: JSON.stringify({
      profiles: [{
        id: "deepseek-default",
        label: "DeepSeek",
        provider: "deepseek",
        protocol: "openai_compatible_chat",
        model: "deepseek-reasoner",
        credentialRef: "deepseek",
      }],
    }),
  });
  assert.equal(configured.catalogImport.profiles[0].id, "deepseek-default");
  assert.equal(JSON.stringify(configured).includes("secret"), false);
  assert.equal(Object.hasOwn(configured, "credentials"), false);
});

test("ModelService applies an explicit fallback chain and reports every safe attempt", async () => {
  const events = [];
  const requests = [];
  const service = createModelService({
    defaultModelProfileId: "primary",
    profiles: [
      {
        id: "primary", label: "Primary", provider: "custom", protocol: "openai-compatible",
        baseUrl: "https://primary.example/v1", model: "model-primary", credentialRef: "primary",
        fallback: ["backup"], enabled: true,
      },
      {
        id: "backup", label: "Backup", provider: "custom", protocol: "openai-compatible",
        baseUrl: "https://backup.example/v1", model: "model-backup", credentialRef: "backup",
        fallback: [], enabled: true,
      },
    ],
    credentials: { primary: "primary-secret", backup: "backup-secret" },
    fetchImpl: async (url) => {
      requests.push(String(url));
      return String(url).includes("primary.example")
        ? new Response("unavailable", { status: 503 })
        : completion("FALLBACK_OK");
    },
    observer: async (event) => events.push(event),
    now: (() => { let value = 0; return () => value += 5; })(),
  });

  const result = await service({
    input: modelInput(),
    modelProfileRevisionId: "primary:revision:1",
    fallbackModelProfileRevisionIds: ["backup:revision:1"],
    invocationId: "invocation-a",
    attemptId: "attempt-a",
    workspaceId: "workspace-a",
  });
  assert.equal(result.content[0].text, "FALLBACK_OK");
  assert.equal(requests.length, 2);
  assert.deepEqual(events.map(({ phase, profileId, fallback }) => ({ phase, profileId, fallback })), [
    { phase: "started", profileId: "primary", fallback: false },
    { phase: "failed", profileId: "primary", fallback: false },
    { phase: "started", profileId: "backup", fallback: true },
    { phase: "completed", profileId: "backup", fallback: true },
  ]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("ModelService resolves a PostgreSQL revision through its opaque SecretBinding id", async () => {
  const credentialRefs = [];
  const credentialContexts = [];
  const revision = {
    revisionId: "pg-model-revision-1", profileId: "pg-model", provider: "openai",
    protocol: "openai_compatible_chat", providerModelId: "gpt-test", capabilities: ["chat"],
    limits: {}, secretBindingId: "secret-binding-pg-model-1",
  };
  const catalog = {
    async listProfiles() { return []; },
    async resolveRevision() { return { profile: { profileId: "pg-model" }, revision, readiness: { state: "ready" } }; },
    async resolveCurrentProfile() { return { profile: { profileId: "pg-model" }, revision, readiness: { state: "ready" } }; },
  };
  const service = createModelService({
    catalog,
    credentialResolver: { async resolve(reference, context) {
      credentialRefs.push(reference);
      credentialContexts.push(context);
      return "server-only-api-key";
    } },
    fetchImpl: async () => completion("PG_SECRET_BINDING_OK"),
  });
  const result = await service({
    input: modelInput(), modelProfileRevisionId: revision.revisionId,
    fallbackModelProfileRevisionIds: [], capability: "chat",
    invocationId: "invocation-pg-model-1", attemptId: "attempt-pg-model-1", workspaceId: "workspace-pg-model",
  });
  assert.equal(result.content[0].text, "PG_SECRET_BINDING_OK");
  assert.deepEqual(credentialRefs, ["secret-binding-pg-model-1"]);
  assert.equal(credentialContexts[0].workspaceId, "workspace-pg-model");
  assert.equal(credentialContexts[0].revision.revisionId, revision.revisionId);
  assert.equal(JSON.stringify(result).includes("server-only-api-key"), false);
});

test("legacy WORKBENCH_MODEL configuration remains one compatibility profile", () => {
  const configured = configurationFromEnvironment({
    WORKBENCH_MODEL_BASE_URL: "https://legacy.example/v1",
    WORKBENCH_MODEL_API_KEY: "legacy-secret",
    WORKBENCH_MODEL: "legacy/model",
  });
  assert.equal(configured.defaultModelProfileId, "legacy-default");
  assert.equal(configured.profiles[0].provider, "custom");
  assert.equal(configured.profiles[0].protocol, "openai_compatible_chat");
});

test("ModelService commits a Stability Core response through the governed Artifact boundary", async () => {
  const commits = [];
  const service = createModelService({
    defaultModelProfileId: "stability-core",
    profiles: [{
      id: "stability-core",
      label: "Stable Image Core",
      provider: "stability",
      protocol: "stability_image_v2",
      model: "stable-image-core",
      credentialRef: "stability",
      capabilities: ["image_generation"],
      limits: { maxOutputBytes: 1_000_000, maxCostUsdMicros: 30_000 },
      enabled: true,
    }],
    credentials: { stability: "stability-secret" },
    artifactService: {
      async commitImage(value) {
        commits.push(value);
        return { artifactId: "artifact-stability-1", mediaType: value.mediaType };
      },
    },
    fetchImpl: async () => new Response(PNG_1X1, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "finish-reason": "SUCCESS",
        seed: "11",
      },
    }),
  });

  const result = await service({
    typedInput: { prompt: "A safe lighthouse", aspectRatio: "1:1", seed: 11, outputFormat: "png" },
    modelProfileRevisionId: "stability-core:revision:1",
    fallbackModelProfileRevisionIds: [],
    capability: "image_generation",
    invocationId: "invocation-stability-1",
    attemptId: "attempt-stability-1",
    workspaceId: "workspace-a",
    capabilityLeaseId: "lease-stability-1",
    fence: 1,
    limits: { maxOutputBytes: 1_000_000, maxCostUsdMicros: 30_000 },
    source: { kind: "agent_turn", sourceId: "turn-stability-1" },
  });

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].bytes, PNG_1X1);
  assert.equal(commits[0].safetyStatus, "passed");
  assert.deepEqual(result.artifactRefs, [{ artifactId: "artifact-stability-1", mediaType: "image/png" }]);
  assert.equal(result.safetyStatus, "passed");
  assert.equal(result.usage.imageCount, 1);
  assert.equal(result.usage.costUsdMicros, 30_000);
  assert.equal(result.requestedModelRevisionId, "stability-core:revision:1");
  assert.equal(result.actualModelRevisionId, "stability-core:revision:1");
  assert.equal(JSON.stringify(result).includes(PNG_1X1.toString("base64")), false);
});
