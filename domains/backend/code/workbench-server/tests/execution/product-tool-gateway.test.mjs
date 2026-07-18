import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import {
  InMemoryExecutionPersistence,
  ProductToolGateway,
  StdioToolGatewayServer,
  UnixToolGatewayServer,
} from "../../src/execution/index.mjs";

const NOW = "2026-07-16T12:00:00.000Z";
const capabilities = {
  toolAllowlist: ["search"],
  connectionIds: ["connection-a"],
  network: false,
  filesystem: "scratch_readonly",
  externalActions: false,
};

async function fixture({
  maxModelRequests = 1,
  maxSteps = 3,
  clock = () => NOW,
  observer = null,
  metadata = {},
  modelExecutor = null,
} = {}) {
  const persistence = new InMemoryExecutionPersistence();
  const pinnedMetadata = {
    modelProfileRevisionId: "model-revision-default",
    fallbackModelProfileRevisionIds: [],
    modelCapability: "tool_calling",
    ...metadata,
  };
  const request = {
    limits: { maxModelRequests, maxSteps, maxOutputBytes: 10_000 },
    metadata: pinnedMetadata,
  };
  await persistence.createInvocation({
    invocationId: "invocation-a",
    attemptId: "attempt-a",
    workspaceId: "workspace-a",
    request,
    status: "queued",
    eventSequence: 0,
    executionFence: 1,
  });
  await persistence.createAttempt({ attemptId: "attempt-a", invocationId: "invocation-a", status: "queued", fence: 1 });
  await persistence.issueLease({
    capabilityLeaseId: "lease-a",
    invocationId: "invocation-a",
    attemptId: "attempt-a",
    workspaceId: "workspace-a",
    status: "active",
    capabilities,
    expiresAt: "2026-07-16T13:00:00.000Z",
  });
  await persistence.markRunning("invocation-a", "attempt-a", NOW);
  const calls = [];
  const gateway = new ProductToolGateway({
    persistence,
    clock,
    modelExecutor: modelExecutor ?? (async (input) => {
      calls.push({ kind: "model", input });
      return {
        text: "model result",
        requestedModelRevisionId: input.modelProfileRevisionId,
        actualModelRevisionId: input.modelProfileRevisionId,
      };
    }),
    toolExecutor: async (input) => { calls.push({ kind: "tool", input }); return { items: ["result"] }; },
    observer,
  });
  const binding = { invocationId: "invocation-a", attemptId: "attempt-a", capabilityLeaseId: "lease-a" };
  const message = (overrides = {}) => ({
    operation: "tool",
    invocationId: binding.invocationId,
    attemptId: binding.attemptId,
    capabilityLeaseId: binding.capabilityLeaseId,
    toolId: "search",
    input: { query: "safe" },
    ...overrides,
  });
  return { persistence, gateway, binding, message, calls };
}

test("Gateway holds Provider and Tool execution while enforcing lease and allowlists", async () => {
  const { gateway, binding, message, calls } = await fixture({ maxSteps: 8 });
  assert.deepEqual(await gateway.handle(message(), binding), { items: ["result"] });
  assert.equal(calls[0].input.connectionId, null);
  assert.deepEqual(await gateway.handle(message({ operation: "model", toolId: undefined }), binding), {
    text: "model result",
    requestedModelRevisionId: "model-revision-default",
    actualModelRevisionId: "model-revision-default",
  });
  await assert.rejects(gateway.handle(message({ toolId: "shell" }), binding), { code: "gateway_tool_forbidden" });
  await assert.rejects(gateway.handle(message({ connectionId: "connection-b" }), binding), { code: "gateway_connection_forbidden" });
  assert.equal(JSON.stringify(calls).includes("secret"), false);
});

test("Gateway routes only the product-pinned model selection and ignores container input spoofing", async () => {
  const { gateway, binding, message, calls } = await fixture({
    metadata: {
      modelProfileRevisionId: "model-revision-claude-session",
      fallbackModelProfileRevisionIds: ["model-revision-deepseek-backup"],
      modelCapability: "tool_calling",
    },
  });
  await gateway.handle(message({
    operation: "model",
    toolId: undefined,
    input: { options: { modelProfileId: "forged-model" } },
  }), binding);
  assert.equal(calls[0].input.modelProfileRevisionId, "model-revision-claude-session");
  assert.deepEqual(calls[0].input.fallbackModelProfileRevisionIds, ["model-revision-deepseek-backup"]);
  assert.equal(calls[0].input.capability, "tool_calling");
});

test("Gateway rejects an unverified actual model revision", async () => {
  const { gateway, binding, message } = await fixture({
    modelExecutor: async () => ({
      text: "untrusted result",
      requestedModelRevisionId: "model-revision-default",
      actualModelRevisionId: "model-revision-not-authorized",
    }),
  });
  await assert.rejects(
    gateway.handle(message({ operation: "model", toolId: undefined }), binding),
    { code: "gateway_model_route_unverified", status: "failed" },
  );
});

test("Gateway observer receives only bounded allow/reject decisions", async () => {
  const decisions = [];
  const { gateway, binding, message } = await fixture({ observer: (decision) => decisions.push(decision) });
  await gateway.handle(message(), binding);
  await assert.rejects(gateway.handle(message({ toolId: "forbidden", input: { bearer: "must-not-observe" } }), binding));
  assert.deepEqual(decisions, [
    { outcome: "allowed", code: "ok", operation: "tool" },
    { outcome: "rejected", code: "gateway_tool_forbidden", operation: "tool" },
  ]);
  assert.equal(JSON.stringify(decisions).includes("must-not-observe"), false);
});

test("Gateway rejects expired/revoked leases, model over-budget, and child escalation", async () => {
  const expired = await fixture({ clock: () => "2026-07-16T14:00:00.000Z" });
  await assert.rejects(expired.gateway.handle(expired.message(), expired.binding), { code: "gateway_capability_lease_invalid" });

  const revoked = await fixture();
  await revoked.persistence.revokeLease("invocation-a", NOW);
  await assert.rejects(revoked.gateway.handle(revoked.message(), revoked.binding), { code: "gateway_capability_lease_invalid" });

  const budget = await fixture({ maxModelRequests: 1, maxSteps: 3 });
  await budget.gateway.handle(budget.message({ operation: "model", toolId: undefined }), budget.binding);
  await assert.rejects(
    budget.gateway.handle(budget.message({ operation: "model", toolId: undefined }), budget.binding),
    { code: "gateway_model_budget_exceeded" },
  );
  await assert.rejects(
    budget.gateway.handle(budget.message({
      operation: "child_authorize",
      toolId: undefined,
      childCapabilities: { ...capabilities, network: true },
    }), budget.binding),
    { code: "gateway_child_capability_escalation" },
  );
});

test("stdio Gateway session is process-bound and releases invocation usage on close", async () => {
  const { gateway, binding, message } = await fixture({ maxModelRequests: 1, maxSteps: 2 });
  const server = new StdioToolGatewayServer({ gateway });
  const session = await server.open(binding);
  assert.equal((await session.handle(message({ operation: "model", toolId: undefined }))).text, "model result");
  assert.deepEqual(session.snapshot(), {
    requestedModelRevisionId: "model-revision-default",
    actualModelRevisionId: "model-revision-default",
  });
  await session.close();
  assert.deepEqual(session.snapshot(), {
    requestedModelRevisionId: "model-revision-default",
    actualModelRevisionId: "model-revision-default",
  });
  await assert.rejects(async () => session.handle(message()), { code: "gateway_session_closed" });

  const next = await server.open(binding);
  assert.equal((await next.handle(message({ operation: "model", toolId: undefined }))).text, "model result");
  await next.close();
});

test("Unix socket endpoint binds one invocation and rejects the wrong nonce", {
  skip: process.env.WORKBENCH_UNIX_SOCKET_INTEGRATION !== "1",
}, async (t) => {
  const root = await mkdtemp("/private/tmp/lagw-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { gateway, binding, message } = await fixture();
  const server = new UnixToolGatewayServer({ gateway, tempRoot: root });
  const endpoint = await server.open(binding);
  t.after(() => endpoint.close());

  const accepted = await rpc(endpoint.socketPath, { ...message(), nonce: endpoint.nonce });
  assert.deepEqual(accepted, { ok: true, result: { items: ["result"] } });
  const denied = await rpc(endpoint.socketPath, { ...message(), nonce: "wrong" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "gateway_endpoint_unauthorized");
});

function rpc(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let source = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      source += chunk;
      if (!source.includes("\n")) return;
      socket.end();
      resolve(JSON.parse(source.trim()));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
  });
}
