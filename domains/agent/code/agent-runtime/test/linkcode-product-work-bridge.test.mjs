import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  LINKCODE_PI_HOST_COMPATIBILITY,
  LinkCodeProductBridgeError,
  assertLinkCodePiHostCompatibility,
  createLinkCodeProductApiClient,
  createLinkCodeProductWorkBridge,
  createLinkCodeProductWorkExtension,
} from "../integrations/linkcode/product-work-bridge.mjs";

const NOW = "2026-09-16T00:00:00.000Z";
const TOKEN = "a".repeat(40);

test("LinkCode host compatibility pins v0.30.0 + Pi 0.85.1 and rejects the unsupported Pi MCP path", () => {
  assert.deepEqual(assertLinkCodePiHostCompatibility(), LINKCODE_PI_HOST_COMPATIBILITY);
  assert.throws(
    () => assertLinkCodePiHostCompatibility({ mcpServers: [{ name: "must-not-pass" }] }),
    (error) => error instanceof LinkCodeProductBridgeError && error.code === "linkcode_pi_mcp_unsupported",
  );
  assert.throws(
    () => assertLinkCodePiHostCompatibility({ linkCodeRelease: "v0.29.0" }),
    (error) => error instanceof LinkCodeProductBridgeError && error.code === "linkcode_pi_host_version_unsupported",
  );
});

test("native LinkCode Product client uses bearer auth, ETag and idempotency without sending private Session state", async () => {
  const requests = [];
  const client = createLinkCodeProductApiClient({
    baseUrl: "http://127.0.0.1:8787/api/workbench/v1",
    accessToken: async () => TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const pathname = new URL(url).pathname;
      if (options.method === "PATCH") {
        return jsonResponse({ data: workItem({ status: "active" }), requestId: "request-update" }, {
          headers: { etag: '"workv1:work-item-launch:2"' },
        });
      }
      if (pathname.endsWith("/projects/project-launch")) {
        return jsonResponse({ data: project(), requestId: "request-project" });
      }
      return jsonResponse({ data: { workItem: workItem() }, requestId: "request-work" }, {
        headers: { etag: '"workv1:work-item-launch:1"' },
      });
    },
  });

  await client.getProject({ projectId: "project-launch" });
  await client.getWorkItem({ workItemId: "work-item-launch" });
  const updated = await client.updateWorkItem({
    workItemId: "work-item-launch",
    patch: { status: "active", nextAction: "Publish the review." },
    ifMatch: '"workv1:work-item-launch:1"',
    idempotencyKey: "linkcode-apply-proposal-a",
  });

  assert.equal(updated.etag, '"workv1:work-item-launch:2"');
  assert.deepEqual(requests.map(({ options }) => options.method), ["GET", "GET", "PATCH"]);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === `Bearer ${TOKEN}`));
  assert.equal(requests[2].options.headers["If-Match"], '"workv1:work-item-launch:1"');
  assert.equal(requests[2].options.headers["Idempotency-Key"], "linkcode-apply-proposal-a");
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    schemaVersion: "workbench-api-v1",
    data: { status: "active", nextAction: "Publish the review." },
  });
  const serializedRequests = JSON.stringify(requests);
  assert.equal(serializedRequests.includes("sessionId"), false);
  assert.equal(serializedRequests.includes("transcript"), false);
  assert.equal(serializedRequests.includes(TOKEN), true, "the token is present only in the Authorization header captured by this test");
});

test("native LinkCode Product client preserves Product authorization denial and never downgrades to a local fallback", async () => {
  const client = createLinkCodeProductApiClient({
    baseUrl: "https://product.example/api/workbench/v1",
    accessToken: async () => TOKEN,
    fetchImpl: async () => jsonResponse({
      code: "work_item_not_found",
      message: "Work Item not found.",
      retryable: false,
    }, { status: 404 }),
  });
  await assert.rejects(
    () => client.getWorkItem({ workItemId: "work-item-private" }),
    (error) => error instanceof LinkCodeProductBridgeError
      && error.code === "work_item_not_found"
      && error.status === 404
      && error.retryable === false,
  );
});

test("native Pi stages a LinkCode Work proposal, user approval performs one Product update, and continuation reads Product state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-linkcode-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const product = inMemoryProductClient();
  const bridge = createLinkCodeProductWorkBridge({
    productClient: product.client,
    idFactory: () => "linkcode-proposal-a",
    now: () => NOW,
  });
  const extension = createLinkCodeProductWorkExtension({
    bridge,
    projectId: "project-launch",
    workItemId: "work-item-launch",
  });
  const runtime = await createPiRuntime({ root, extension });
  t.after(() => runtime.dispose());

  assert.deepEqual(runtime.session.getActiveToolNames().sort(), [
    "product_work_context_read",
    "product_work_propose_update",
  ]);
  assert.equal(
    runtime.session.getAllTools().some(({ name }) => name.includes("approve")),
    false,
    "approval is a user command, never an LLM-callable tool",
  );

  await runtime.session.prompt("Read the authorized Project and Work Item, then propose moving it to active.");
  const proposal = bridge.getProposal("linkcode-proposal-a");
  assert.deepEqual(proposal.patch, { status: "active", nextAction: "Publish the review." });
  assert.equal(proposal.status, "pending_approval");
  assert.equal(product.state.workItem.status, "ready", "proposal does not mutate Product state");
  assert.equal(product.calls.update.length, 0);

  const [firstReceipt, concurrentReceipt] = await Promise.all([
    bridge.approveUpdate({ proposalId: proposal.proposalId }),
    bridge.approveUpdate({ proposalId: proposal.proposalId }),
  ]);
  const replayedReceipt = await bridge.approveUpdate({ proposalId: proposal.proposalId });
  assert.deepEqual(concurrentReceipt, firstReceipt);
  assert.deepEqual(replayedReceipt, firstReceipt);
  assert.equal(product.calls.update.length, 1, "duplicate approval replays the settled receipt");
  assert.equal(product.state.workItem.status, "active");
  assert.equal(product.calls.update[0].ifMatch, '"workv1:work-item-launch:1"');
  assert.equal(product.calls.update[0].idempotencyKey, "linkcode-apply-linkcode-proposal-a");

  await runtime.session.prompt("Continue by reading the Product Work Item again and report its authoritative status.");
  const finalText = [...runtime.session.messages].reverse()
    .find((message) => message.role === "assistant" && message.content?.some?.((part) => part.type === "text"))
    ?.content.find((part) => part.type === "text")?.text;
  assert.equal(finalText, "Product Work Item is active; continue from the Product state.");

  const productPayloads = JSON.stringify(product.calls);
  assert.equal(productPayloads.includes("private-session-secret"), false);
  assert.equal(productPayloads.includes("sessionId"), false);
});

test("cancelled approval and rejected proposals fail closed without a Product mutation", async () => {
  const product = inMemoryProductClient();
  const bridge = createLinkCodeProductWorkBridge({
    productClient: product.client,
    idFactory: (() => {
      let index = 0;
      return () => `linkcode-proposal-${++index}`;
    })(),
    now: () => NOW,
  });
  const cancelled = await bridge.proposeUpdate({
    projectId: "project-launch",
    workItemId: "work-item-launch",
    summary: "Cancelled approval.",
    patch: { status: "active" },
  });
  const controller = new AbortController();
  controller.abort(new Error("user_cancelled"));
  await assert.rejects(
    () => bridge.approveUpdate({ proposalId: cancelled.proposalId, signal: controller.signal }),
    (error) => error.code === "linkcode_operation_cancelled",
  );
  assert.equal(product.calls.update.length, 0);

  const rejected = await bridge.proposeUpdate({
    projectId: "project-launch",
    workItemId: "work-item-launch",
    summary: "Reject this update.",
    patch: { status: "blocked", blockedReason: "Missing evidence." },
  });
  const rejection = bridge.rejectUpdate({ proposalId: rejected.proposalId, reason: "Not enough evidence." });
  assert.equal(rejection.status, "rejected");
  await assert.rejects(
    () => bridge.approveUpdate({ proposalId: rejected.proposalId }),
    (error) => error.code === "linkcode_proposal_not_pending",
  );
  assert.equal(product.calls.update.length, 0);
});

async function createPiRuntime({ root, extension }) {
  const provider = "linkcode-test";
  const modelId = "product-proposal-test";
  const faux = createFauxCore({
    api: provider,
    provider,
    models: [{ id: modelId, name: "LinkCode test model", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 4_096 }],
    tokensPerSecond: 0,
  });
  faux.setResponses([
    async () => fauxAssistantMessage([{
      type: "toolCall",
      id: "read-before-proposal",
      name: "product_work_context_read",
      arguments: {},
    }], { stopReason: "toolUse" }),
    async () => fauxAssistantMessage([{
      type: "toolCall",
      id: "stage-proposal",
      name: "product_work_propose_update",
      arguments: {
        summary: "Move the launch review into active delivery.",
        patch: { status: "active", nextAction: "Publish the review." },
      },
    }], { stopReason: "toolUse" }),
    async () => fauxAssistantMessage([{ type: "text", text: "Proposal staged for user approval." }], { stopReason: "stop" }),
    async () => fauxAssistantMessage([{
      type: "toolCall",
      id: "read-after-approval",
      name: "product_work_context_read",
      arguments: {},
    }], { stopReason: "toolUse" }),
    async () => fauxAssistantMessage([{
      type: "text",
      text: "Product Work Item is active; continue from the Product state.",
    }], { stopReason: "stop" }),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  await modelRuntime.setRuntimeApiKey(provider, "test-key");
  modelRuntime.registerProvider(provider, {
    api: provider,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    streamSimple: faux.streamSimple,
    models: [{
      id: modelId,
      name: "LinkCode test model",
      api: provider,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    }],
  });
  const model = modelRuntime.getModel(provider, modelId);
  const agentDir = join(root, "pi-agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    extensionFactories: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Use Product tools. Propose changes, but never approve your own proposal.",
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      defaultProjectTrust: "never",
      quietStartup: true,
    }),
    noTools: "builtin",
    tools: ["product_work_context_read", "product_work_propose_update"],
  });
  return {
    session: created.session,
    async dispose() {
      await created.session.dispose();
      modelRuntime.unregisterProvider(provider);
    },
  };
}

function inMemoryProductClient() {
  const state = {
    project: project(),
    workItem: workItem(),
    revision: 1,
  };
  const calls = { project: [], work: [], update: [] };
  const receipts = new Map();
  return {
    state,
    calls,
    client: {
      async getProject(input) {
        calls.project.push(structuredClone(input));
        if (input.projectId !== state.project.projectId) throw new Error("project_not_found");
        return { data: structuredClone(state.project) };
      },
      async getWorkItem(input) {
        calls.work.push(structuredClone(input));
        if (input.workItemId !== state.workItem.workItemId) throw new Error("work_item_not_found");
        return {
          data: { workItem: structuredClone(state.workItem) },
          etag: `\"workv1:${state.workItem.workItemId}:${state.revision}\"`,
        };
      },
      async updateWorkItem(input) {
        const serialized = { ...input, signal: input.signal ? "present" : undefined };
        calls.update.push(structuredClone(serialized));
        if (receipts.has(input.idempotencyKey)) return structuredClone(receipts.get(input.idempotencyKey));
        const expected = `\"workv1:${state.workItem.workItemId}:${state.revision}\"`;
        if (input.ifMatch !== expected) {
          throw new LinkCodeProductBridgeError("work_item_conflict", "Work Item changed.", { status: 409 });
        }
        state.revision += 1;
        state.workItem = { ...state.workItem, ...structuredClone(input.patch), updatedAt: NOW };
        const result = {
          data: structuredClone(state.workItem),
          etag: `\"workv1:${state.workItem.workItemId}:${state.revision}\"`,
          requestId: "product-request-update",
        };
        receipts.set(input.idempotencyKey, result);
        return structuredClone(result);
      },
    },
  };
}

function project() {
  return {
    schemaVersion: "workbench-v1",
    projectId: "project-launch",
    workspaceId: "workspace-team",
    scopeId: "scope-project-launch",
    title: "Launch",
    objective: "Ship the team launch safely.",
    status: "active",
    accountableOwnerUserId: "user-owner",
    members: [{ userId: "user-owner", role: "owner" }],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

function workItem(overrides = {}) {
  return {
    schemaVersion: "workbench-v1",
    workItemId: "work-item-launch",
    workspaceId: "workspace-team",
    projectId: "project-launch",
    title: "Launch review",
    objective: "Prepare the decision-ready launch review.",
    status: "ready",
    priority: "high",
    accountableOwnerUserId: "user-owner",
    requestorUserId: "user-owner",
    members: [],
    source: { kind: "team_work_item" },
    dueAt: null,
    workThreadId: "work-thread-launch",
    authorizedBranchRefs: [],
    linkedLoopRef: null,
    runRefs: [],
    artifactRefs: [],
    decisionRefs: [],
    proposalRefs: [],
    blockedReason: null,
    nextAction: null,
    createdByUserId: "user-owner",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
