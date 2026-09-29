import assert from "node:assert/strict";
import test from "node:test";

import { ProductClientProtocolError } from "../dist/index.js";
import { createModelProductClient } from "../dist/model.js";

const now = "2026-08-05T00:00:00.000Z";
const revision = {
  schemaVersion: "workbench-v1",
  revisionId: "model-revision-chat-1",
  profileId: "model-profile-chat",
  revisionNumber: 1,
  modelDisplayName: "Team Chat",
  providerDisplay: { key: "openai", label: "OpenAI" },
  capabilities: ["chat", "tool_calling"],
  parameterSupport: {
    kind: "chat",
    temperature: true,
    maxOutputTokens: true,
    tools: true,
    responseSchema: true,
  },
  limits: { kind: "chat", maxInputTokens: 128_000, maxOutputTokens: 16_000 },
  createdAt: now,
};
const profile = {
  schemaVersion: "workbench-v1",
  profileId: revision.profileId,
  displayName: "Team Chat",
  currentRevisionId: revision.revisionId,
  currentRevision: revision,
  scope: "global",
  enabled: true,
  readiness: "ready",
  readinessReason: null,
  selectable: true,
  defaultForCapabilities: ["chat"],
  createdAt: now,
  updatedAt: now,
};
const session = {
  schemaVersion: "workbench-v1",
  sessionId: "agent-session-main-1",
  definitionId: "main",
  userId: "user-local",
  workspaceId: "workspace-local",
  scope: { kind: "main" },
  title: "New task",
  source: { kind: "manual" },
  taskStatus: "idle",
  archived: false,
  status: "active",
  lastUsedModelProfileId: profile.profileId,
  modelPreferenceState: "preference_only",
  activeTurnId: null,
  createdAt: now,
  updatedAt: now,
};
const listResponse = {
  schemaVersion: "workbench-api-v1",
  data: [profile],
  page: { nextCursor: null, hasMore: false },
  requestId: "request-model-list-1",
};
const selectionResponse = {
  schemaVersion: "workbench-api-v1",
  data: session,
  requestId: "request-model-select-1",
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("model client validates catalog filters and forwards cancellation", async () => {
  let captured;
  const controller = new AbortController();
  const client = createModelProductClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(listResponse);
    },
  });

  const result = await client.call("listModelProfiles", {
    query: {
      profileId: profile.profileId,
      capabilities: "chat,tool_calling",
      context: "agent_controller",
      cursor: "cursor:model/2",
      limit: 25,
    },
  }, { signal: controller.signal });

  assert.equal(
    captured.url,
    `/api/workbench/v1/model-profiles?profileId=${profile.profileId}&capabilities=chat%2Ctool_calling&context=agent_controller&cursor=cursor%3Amodel%2F2&limit=25`,
  );
  assert.equal(captured.init.signal, controller.signal);
  assert.equal(result.body.data[0].profileId, profile.profileId);
});

test("model preference mutation preserves idempotency and browser-session CSRF", async () => {
  let captured;
  const client = createModelProductClient({
    csrfToken: () => "csrf-model-session-token",
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse(selectionResponse);
    },
  });

  const result = await client.call("selectAgentSessionModel", {
    pathParams: { sessionId: session.sessionId },
    headers: { "Idempotency-Key": "select-model-1" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: { modelProfileId: profile.profileId },
    },
  });

  assert.equal(captured.url, `/api/workbench/v1/agent-sessions/${session.sessionId}/model`);
  assert.equal(captured.init.headers.get("Idempotency-Key"), "select-model-1");
  assert.equal(captured.init.headers.get("X-Workbench-CSRF"), "csrf-model-session-token");
  assert.equal(result.body.data.lastUsedModelProfileId, profile.profileId);
});

test("model client rejects invalid filters and provider-private response fields", async () => {
  let fetchCount = 0;
  const client = createModelProductClient({
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse(listResponse);
    },
  });
  await assert.rejects(
    client.call("listModelProfiles", /** @type {never} */ ({
      query: { capabilities: ["chat"] },
    })),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "request_query",
  );
  assert.equal(fetchCount, 0);

  const unsafe = createModelProductClient({
    fetch: async () => jsonResponse({
      ...listResponse,
      data: [{
        ...profile,
        currentRevision: { ...profile.currentRevision, providerModelId: "secret-provider-model" },
      }],
    }),
  });
  await assert.rejects(
    unsafe.call("listModelProfiles", {}),
    (error) => error instanceof ProductClientProtocolError
      && error.stage === "response_body",
  );
});
