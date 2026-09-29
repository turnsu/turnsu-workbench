import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  toolExecutor = null,
  executionCapabilities = capabilities,
  actor = null,
} = {}) {
  const persistence = new InMemoryExecutionPersistence();
  const pinnedMetadata = {
    modelProfileRevisionId: "model-revision-default",
    fallbackModelProfileRevisionIds: [],
    modelCapability: "tool_calling",
    ...metadata,
  };
  const request = {
    actor,
    limits: { maxModelRequests, maxSteps, maxOutputBytes: 10_000 },
    metadata: pinnedMetadata,
    controller: { kind: "workflow_run", controllerId: "run-1", fence: 1 },
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
    capabilities: executionCapabilities,
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
    toolExecutor: toolExecutor ?? (async (input) => { calls.push({ kind: "tool", input }); return { items: ["result"] }; }),
    observer,
  });
  const binding = { invocationId: "invocation-a", attemptId: "attempt-a", capabilityLeaseId: "lease-a" };
  const message = (overrides = {}) => ({
    operation: "tool",
    invocationId: binding.invocationId,
    attemptId: binding.attemptId,
    capabilityLeaseId: binding.capabilityLeaseId,
    toolId: "search",
    connectionId: "connection-a",
    input: { query: "safe" },
    ...overrides,
  });
  return { persistence, gateway, binding, message, calls };
}

test("private material tool uses Product actor identity and rejects external connection claims", async () => {
  const { gateway, binding, message, calls } = await fixture({ maxSteps: 5,
    actor: { userId: "alice" },
    executionCapabilities: { ...capabilities, toolAllowlist: ["turnsu_materials"], connectionIds: [] } });
  await gateway.handle(message({ toolId: "turnsu_materials", connectionId: undefined,
    actor: { userId: "bob" }, input: { action: "list" } }), binding);
  assert.deepEqual(calls[0].input.actor, { userId: "alice" });
  await assert.rejects(gateway.handle(message({ toolId: "turnsu_materials", input: { action: "list" } }), binding),
    { code: "gateway_connection_forbidden" });
  await assert.rejects(gateway.handle(message({ toolId: "turnsu_materials", connectionId: undefined, externalAction: true }), binding),
    { code: "gateway_external_action_forbidden" });
});

test("Gateway holds Provider and Tool execution while enforcing lease and allowlists", async () => {
  const { gateway, binding, message, calls } = await fixture({ maxSteps: 8 });
  assert.deepEqual(await gateway.handle(message(), binding), { items: ["result"] });
  assert.equal(calls[0].input.connectionId, "connection-a");
  assert.deepEqual(await gateway.handle(message({ operation: "model", toolId: undefined }), binding), {
    text: "model result",
    requestedModelRevisionId: "model-revision-default",
    actualModelRevisionId: "model-revision-default",
  });
  await assert.rejects(gateway.handle(message({ toolId: "shell" }), binding), { code: "gateway_tool_forbidden" });
  await assert.rejects(gateway.handle(message({ connectionId: undefined }), binding), { code: "gateway_connection_forbidden" });
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

test("Gateway independently rejects unsafe nested Lark results", async () => {
  const larkCapabilities = {
    ...capabilities,
    toolAllowlist: ["lark.task.create"],
    externalActions: true,
  };
  const { gateway, binding, message } = await fixture({
    executionCapabilities: larkCapabilities,
    toolExecutor: async () => ({
      status: "succeeded",
      action: "lark.task.create",
      effect: "write",
      output: {
        taskId: "task-1",
        debug: [{ providerPayload: { value: "not-safe" } }],
      },
      externalRef: { provider: "lark", resourceType: "task", id: "task-1" },
      receipt: {
        receiptId: "lark-effect:gateway-task-1",
        externalRef: { provider: "lark", resourceType: "task", id: "task-1" },
      },
    }),
  });

  await assert.rejects(
    gateway.handle(message({
      toolId: "lark.task.create",
      externalAction: true,
      effectId: "gateway-task-1",
    }), binding),
    { code: "lark_tool_output_forbidden", status: "failed" },
  );
});

test("Gateway returns only the Lark action product projection", async () => {
  const larkCapabilities = {
    ...capabilities,
    toolAllowlist: ["lark.task.create"],
    externalActions: true,
  };
  const { gateway, binding, message } = await fixture({
    executionCapabilities: larkCapabilities,
    toolExecutor: async () => ({
      status: "succeeded",
      action: "lark.task.create",
      effect: "write",
      output: { taskId: "task-1", upstream_debug: "drop-this" },
      externalRef: { provider: "lark", resourceType: "task", id: "task-1" },
      receipt: {
        receiptId: "lark-effect:gateway-task-1",
        provider_debug: "drop-this-too",
        externalRef: { provider: "lark", resourceType: "task", id: "task-1" },
      },
    }),
  });

  const result = await gateway.handle(message({
    toolId: "lark.task.create",
    externalAction: true,
    effectId: "gateway-task-1",
  }), binding);
  assert.deepEqual(result.output, { taskId: "task-1" });
  assert.deepEqual(Object.keys(result.receipt).sort(), ["action", "effect", "externalRef", "receiptId"]);
  assert.equal(JSON.stringify(result).includes("drop-this"), false);
});

test("Gateway reconciles only the exact pinned effect receipt under the active capability lease", async () => {
  const recovery = {
    schemaVersion: "workbench-effect-recovery-v1",
    effectId: "effect-gateway-recovery-1",
    action: "lark.task.create",
    connectionId: "connection-a",
    requirementId: "lark.task",
    approvalFingerprint: `sha256:${"a".repeat(64)}`,
    credentialBindingFingerprint: `sha256:${"b".repeat(64)}`,
    driverBackend: "production",
    sourceInvocationId: "invocation-original",
    sourceAttemptId: "attempt-original",
  };
  let ordinaryToolCalls = 0;
  const toolExecutor = Object.assign(
    async () => { ordinaryToolCalls += 1; },
    {
      async reconcileEffect({ workspaceId, effectId }) {
        assert.equal(workspaceId, "workspace-a");
        assert.equal(effectId, recovery.effectId);
        return {
          ...recovery,
          status: "succeeded",
          invocationId: recovery.sourceInvocationId,
          attemptId: recovery.sourceAttemptId,
          controllerId: "run-1",
          nodeId: "node-task",
          output: { taskId: "task-1" },
          externalRef: { provider: "lark", resourceType: "task", id: "task-1" },
          receipt: {
            receiptId: `lark-effect:${recovery.effectId}`,
            action: recovery.action,
            effect: "write",
            externalRef: { provider: "lark", resourceType: "task", id: "task-1" },
          },
        };
      },
    },
  );
  const { gateway, binding } = await fixture({
    toolExecutor,
    executionCapabilities: {
      ...capabilities,
      toolAllowlist: [recovery.action],
      externalActions: true,
    },
    metadata: {
      outerNodeId: "node-task",
      effectRecovery: recovery,
      connectionSnapshots: [{
        connectionId: recovery.connectionId,
        requirementId: recovery.requirementId,
        approvalFingerprint: recovery.approvalFingerprint,
        credentialBindingFingerprint: recovery.credentialBindingFingerprint,
        driverBackend: recovery.driverBackend,
      }],
    },
  });

  const result = await gateway.recoverEffect({
    ...binding,
    effectRecovery: recovery,
  }, binding);
  assert.equal(result.effectId, recovery.effectId);
  assert.deepEqual(result.output, { taskId: "task-1" });
  assert.equal(ordinaryToolCalls, 0);
  await assert.rejects(
    gateway.recoverEffect({
      ...binding,
      effectRecovery: { ...recovery, action: "lark.task.update" },
    }, binding),
    { code: "gateway_effect_recovery_lineage_invalid" },
  );
});

test("Gateway leaves a pinned effect outcome unknown when its executor has no reconciliation driver", async () => {
  const recovery = {
    schemaVersion: "workbench-effect-recovery-v1",
    effectId: "effect-gateway-recovery-2",
    action: "lark.task.create",
    connectionId: "connection-a",
    requirementId: "lark.task",
    approvalFingerprint: `sha256:${"c".repeat(64)}`,
    credentialBindingFingerprint: `sha256:${"d".repeat(64)}`,
    driverBackend: "production",
    sourceInvocationId: "invocation-original",
    sourceAttemptId: "attempt-original",
  };
  let ordinaryToolCalls = 0;
  const { gateway, binding } = await fixture({
    toolExecutor: async () => { ordinaryToolCalls += 1; },
    executionCapabilities: {
      ...capabilities,
      toolAllowlist: [recovery.action],
      externalActions: true,
    },
    metadata: {
      outerNodeId: "node-task",
      effectRecovery: recovery,
      connectionSnapshots: [{
        connectionId: recovery.connectionId,
        requirementId: recovery.requirementId,
        approvalFingerprint: recovery.approvalFingerprint,
        credentialBindingFingerprint: recovery.credentialBindingFingerprint,
        driverBackend: recovery.driverBackend,
      }],
    },
  });

  await assert.rejects(
    gateway.recoverEffect({ ...binding, effectRecovery: recovery }, binding),
    { code: "gateway_effect_recovery_unavailable", status: "effect_outcome_unknown" },
  );
  assert.equal(ordinaryToolCalls, 0);
});

test("Gateway retains actual provider usage across calls and stdio closure", async () => {
  const { gateway, binding, message } = await fixture({
    maxModelRequests: 2,
    modelExecutor: async (input) => ({
      text: "result",
      requestedModelRevisionId: input.modelProfileRevisionId,
      actualModelRevisionId: input.modelProfileRevisionId,
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, costUsdMicros: 40 },
    }),
  });
  const session = await new StdioToolGatewayServer({ gateway }).open(binding);
  await session.handle(message({ operation: "model", input: { usage: { totalTokens: 1 } } }));
  await session.handle(message({ operation: "model" }));
  assert.deepEqual(session.snapshot().usage, {
    steps: 2, modelRequests: 2, inputTokens: 240, outputTokens: 60,
    totalTokens: 300, costUsdMicros: 80, imageCount: 0,
  });
  await session.close();
  assert.equal(session.snapshot().usage.totalTokens, 300);
});

test("stdio Gateway session is process-bound and releases invocation usage on close", async () => {
  const { gateway, binding, message } = await fixture({ maxModelRequests: 1, maxSteps: 2 });
  const server = new StdioToolGatewayServer({ gateway });
  const session = await server.open(binding);
  assert.equal((await session.handle(message({ operation: "model", toolId: undefined }))).text, "model result");
  const expectedSnapshot = {
    requestedModelRevisionId: "model-revision-default",
    actualModelRevisionId: "model-revision-default",
    usage: { steps: 1, modelRequests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsdMicros: 0, imageCount: 0 },
  };
  assert.deepEqual(session.snapshot(), expectedSnapshot);
  await session.close();
  assert.deepEqual(session.snapshot(), expectedSnapshot);
  await assert.rejects(async () => session.handle(message()), { code: "gateway_session_closed" });

  const next = await server.open(binding);
  assert.equal((await next.handle(message({ operation: "model", toolId: undefined }))).text, "model result");
  await next.close();
});

test("Unix socket endpoint binds one invocation and rejects the wrong nonce", {
  skip: process.env.WORKBENCH_UNIX_SOCKET_INTEGRATION !== "1",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lagw-"));
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
