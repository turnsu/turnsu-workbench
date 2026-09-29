import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductTrace,
} from "../../src/observability/product-trace-service.mjs";

const NOW = "2026-08-01T00:00:00.000Z";

test("Product Trace joins command, turn, admission, execution, effect, proposal, and artifact without payloads", async () => {
  const records = {
    productCommands: [{ commandId: "command-1", userId: "user-1", workspaceId: "workspace-1", status: "completed", createdAt: NOW }],
    agentTurns: [{ turnId: "turn-1", productCommandId: "command-1", status: "completed", createdAt: NOW, input: { message: "private" } }],
    skillCreationTurns: [],
    admissionWaiting: [{ admissionId: "admission-1", commandId: "command-1", workspaceId: "workspace-1", state: "leased", createdAt: NOW }],
    capacityLeases: [{ capacityLeaseId: "capacity-1", admissionId: "admission-1", commandId: "command-1", workspaceId: "workspace-1", status: "released", issuedAt: NOW }],
    capabilityLeases: [],
    executionInvocations: [{ invocationId: "invocation-1", workspaceId: "workspace-1", status: "completed", createdAt: NOW, request: { lineage: { productCommandId: "command-1" }, capacityAuthority: { admissionId: "admission-1" }, input: { secret: "private" } } }],
    executionAttempts: [{ attemptId: "attempt-1", invocationId: "invocation-1", status: "completed", createdAt: NOW, result: { output: "private" } }],
    externalEffectReceipts: [{ effectId: "effect-1", invocationId: "invocation-1", workspaceId: "workspace-1", status: "succeeded", createdAt: NOW, output: { private: true } }],
    agentObjectProposals: [{ proposalId: "proposal-1", turnId: "turn-1", workspaceId: "workspace-1", status: "proposed", createdAt: NOW, operations: [{ secret: true }] }],
    builderProposals: [{ proposalId: "proposal-builder", productCommandId: "command-1", workspaceId: "workspace-1", status: "proposed", createdAt: NOW }],
    skillCreationPatches: [],
    productArtifacts: [{ artifactId: "artifact-1", invocationId: "invocation-1", workspaceId: "workspace-1", state: "ready", createdAt: NOW, objectId: "/host/private" }],
    workerTranscriptArtifacts: [],
  };
  const trace = await buildProductTrace({
    store: fakeStore(records),
    productCommandId: "command-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(new Set(trace.nodes.map((node) => node.kind)), new Set([
    "product_command", "agent_turn", "admission", "capacity_lease", "invocation",
    "execution_attempt", "effect_receipt", "proposal", "artifact",
  ]));
  assert.equal(trace.nodes.find((node) => node.kind === "effect_receipt").parentNodeId, "invocation:invocation-1");
  const serialized = JSON.stringify(trace);
  for (const forbidden of ["private", "secret", "/host", "request", "result", "output"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("Product Trace hides foreign and cross-workspace commands as not found", async () => {
  const store = fakeStore({
    productCommands: [{ commandId: "command-1", userId: "user-1", workspaceId: "workspace-1", status: "accepted", createdAt: NOW }],
  });
  await assert.rejects(
    buildProductTrace({ store, productCommandId: "command-1", userId: "user-2", workspaceId: "workspace-1" }),
    { code: "product_trace_not_found" },
  );
  await assert.rejects(
    buildProductTrace({ store, productCommandId: "command-1", userId: "user-1", workspaceId: "workspace-2" }),
    { code: "product_trace_not_found" },
  );
});

test("Product Trace does not synthesize Realtime execution authority from ProductCommand references", async () => {
  const records = {
    productCommands: [{
      commandId: "realtime-command-1",
      kind: "skill_creation_realtime_call",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "creation-session-1",
      turnId: "realtime-call-1",
      invocationId: "realtime-invocation-1",
      attemptId: "realtime-attempt-1",
      status: "completed",
      createdAt: NOW,
    }],
    admissionWaiting: [{
      admissionId: "admission-realtime-1",
      commandId: "realtime-command-1",
      workspaceId: "workspace-1",
      state: "leased",
      createdAt: NOW,
    }],
    capacityLeases: [{
      capacityLeaseId: "capacity-realtime-1",
      admissionId: "admission-realtime-1",
      commandId: "realtime-command-1",
      workspaceId: "workspace-1",
      status: "released",
      issuedAt: NOW,
    }],
    capabilityLeases: [{
      capabilityLeaseId: "capability-realtime-1",
      invocationId: "realtime-invocation-1",
      workspaceId: "workspace-1",
      status: "revoked",
      issuedAt: NOW,
    }],
    skillCreationPatches: [{
      patchId: "patch-realtime-1",
      productCommandId: "realtime-command-1",
      realtimeCallId: "realtime-call-1",
      providerCallId: "tool-call-1",
      sourceTurnId: "tool-call-1",
      workspaceId: "workspace-1",
      status: "proposed",
      createdAt: NOW,
      operations: [{ private: true }],
    }],
  };
  const trace = await buildProductTrace({
    store: fakeStore(records),
    productCommandId: "realtime-command-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  assert.deepEqual(
    trace.nodes.map((node) => node.kind),
    [
      "admission",
      "capacity_lease",
      "product_command",
      "proposal",
      "realtime_call",
      "tool_call",
    ],
  );
  assert.equal(trace.nodes.some((node) => node.kind === "invocation"), false);
  assert.equal(trace.nodes.some((node) => node.kind === "execution_attempt"), false);
  assert.equal(trace.nodes.some((node) => node.kind === "capability_lease"), false);
  assert.equal(
    trace.nodes.find((node) => node.kind === "tool_call").parentNodeId,
    "realtime_call:realtime-call-1",
  );
  assert.equal(JSON.stringify(trace).includes("private"), false);
});

test("Product Trace attaches Realtime sideband lineage only to persisted execution records", async () => {
  const records = {
    productCommands: [{
      commandId: "realtime-command-1",
      kind: "skill_creation_realtime_call",
      userId: "user-1",
      workspaceId: "workspace-1",
      turnId: "realtime-call-1",
      invocationId: "realtime-invocation-1",
      attemptId: "realtime-attempt-1",
      status: "completed",
      createdAt: NOW,
      providerPayload: { secret: "command-secret" },
    }],
    admissionWaiting: [{
      admissionId: "admission-realtime-1",
      commandId: "realtime-command-1",
      workspaceId: "workspace-1",
      state: "leased",
      createdAt: NOW,
    }],
    executionInvocations: [{
      invocationId: "realtime-invocation-1",
      workspaceId: "workspace-1",
      status: "running",
      createdAt: NOW,
      request: {
        lineage: { productCommandId: "realtime-command-1" },
        capacityAuthority: { admissionId: "admission-realtime-1" },
        input: { secret: "invocation-secret" },
      },
    }],
    executionAttempts: [{
      attemptId: "realtime-attempt-1",
      invocationId: "realtime-invocation-1",
      status: "failed",
      createdAt: NOW,
      result: { output: "attempt-private" },
    }],
    capabilityLeases: [{
      capabilityLeaseId: "capability-realtime-1",
      invocationId: "realtime-invocation-1",
      workspaceId: "workspace-1",
      status: "revoked",
      issuedAt: NOW,
      capabilities: { secret: "lease-private" },
    }],
    skillCreationPatches: [{
      patchId: "patch-realtime-1",
      productCommandId: "realtime-command-1",
      realtimeCallId: "realtime-call-1",
      providerCallId: "tool-call-1",
      sourceTurnId: "tool-call-1",
      workspaceId: "workspace-1",
      status: "proposed",
      createdAt: NOW,
      operations: [{ private: true }],
    }],
  };
  const trace = await buildProductTrace({
    store: fakeStore(records),
    productCommandId: "realtime-command-1",
    userId: "user-1",
    workspaceId: "workspace-1",
  });

  const invocation = trace.nodes.find((node) => node.kind === "invocation");
  const attempt = trace.nodes.find((node) => node.kind === "execution_attempt");
  const toolCall = trace.nodes.find((node) => node.kind === "tool_call");
  assert.equal(invocation.status, "running");
  assert.equal(invocation.parentNodeId, "admission:admission-realtime-1");
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.parentNodeId, "invocation:realtime-invocation-1");
  assert.equal(toolCall.parentNodeId, "invocation:realtime-invocation-1");
  const serialized = JSON.stringify(trace);
  for (const forbidden of ["command-secret", "invocation-secret", "attempt-private", "lease-private", "operations"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

function fakeStore(records) {
  const names = [
    "productCommands", "agentTurns", "skillCreationTurns", "admissionWaiting",
    "capacityLeases", "capabilityLeases", "executionInvocations", "executionAttempts",
    "externalEffectReceipts", "agentObjectProposals", "builderProposals", "skillCreationPatches",
    "productArtifacts", "workerTranscriptArtifacts",
  ];
  return {
    repositories: Object.fromEntries(names.map((name) => [name, {
      async get(identity, { workspaceId: optionWorkspaceId } = {}) {
        const id = typeof identity === "object" ? identity.commandId : identity;
        const workspaceId = typeof identity === "object" ? identity.workspaceId : optionWorkspaceId;
        const userId = typeof identity === "object" ? identity.userId : null;
        return (records[name] ?? []).find((item) => item.commandId === id
          && (!workspaceId || item.workspaceId === workspaceId)
          && (!userId || item.userId === userId)) ?? null;
      },
      async listAllForReadModel(filter) {
        return (records[name] ?? []).filter((item) => matches(item, filter));
      },
    }])),
  };
}

function matches(record, filter) {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = path.split(".").reduce((value, key) => value?.[key], record);
    return expected?.$in ? expected.$in.includes(actual) : actual === expected;
  });
}
