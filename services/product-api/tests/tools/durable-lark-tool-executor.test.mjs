import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createDurableLarkToolExecutor,
} from "../../src/tools/durable-lark-tool-executor.mjs";

const connectionApprovalSnapshot = Object.freeze({
  approvalSchemaVersion: "connection-approval-v1",
  requirementId: "lark.task.create",
  connectionId: "connection-lark",
  connectionRevision: 7,
  capabilityKey: "lark.task.create",
  driverKey: "lark",
  driverBackend: "production",
  principal: "lark-user-123",
  principalFingerprint: `sha256:${"1".repeat(64)}`,
  permissionFingerprint: `sha256:${"2".repeat(64)}`,
  credentialBindingFingerprint: `sha256:${"3".repeat(64)}`,
  validationExpiresAt: "2099-01-01T00:00:00.000Z",
  approvalFingerprint: `sha256:${"4".repeat(64)}`,
});

const writeRequest = (overrides = {}) => ({
  toolId: "lark.task.create",
  connectionId: "connection-lark",
  input: { summary: "Ship the release" },
  workspaceId: "workspace-a",
  invocationId: "invocation-a",
  attemptId: "attempt-a",
  controller: { kind: "workflow_run", controllerId: "run-a", fence: 1 },
  metadata: {
    skillName: "lark-task",
    requestedBy: "user-a",
    outerNodeId: "node-task",
    externalActionConfirmed: false,
    connectionSnapshots: [structuredClone(connectionApprovalSnapshot)],
  },
  effectId: "effect-task-create-1",
  ...overrides,
});

function memoryPersistence() {
  const records = new Map();
  return {
    records,
    async get({ effectId }) {
      return records.has(effectId) ? structuredClone(records.get(effectId)) : null;
    },
    async claim(record) {
      if (records.has(record.effectId)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      records.set(record.effectId, structuredClone(record));
      return structuredClone(record);
    },
    async beginDispatch({ effectId, dispatchStartedAt, reconcileAfter }) {
      const record = records.get(effectId);
      if (!record || record.status !== "intent_recorded") return null;
      Object.assign(record, {
        status: "dispatching",
        dispatchStartedAt,
        reconcileAfter,
        updatedAt: dispatchStartedAt,
      });
      return structuredClone(record);
    },
    async complete({ effectId, completedAt, output, receipt, externalRef, resolution }) {
      const record = records.get(effectId);
      if (!record || !["dispatching", "outcome_unknown"].includes(record.status)) return null;
      Object.assign(record, {
        status: "succeeded",
        completedAt,
        updatedAt: completedAt,
        output: structuredClone(output),
        receipt: structuredClone(receipt),
        externalRef: structuredClone(externalRef),
        ...(resolution ? { resolution: structuredClone(resolution) } : {}),
      });
      return structuredClone(record);
    },
    async markOutcomeUnknown({ effectId, failedAt, errorCode }) {
      const record = records.get(effectId);
      if (!record || record.status !== "dispatching") return null;
      Object.assign(record, {
        status: "outcome_unknown",
        failedAt,
        updatedAt: failedAt,
        errorCode,
      });
      return structuredClone(record);
    },
    async cancelIntent({ effectId, cancelledAt, requestedBy, reason }) {
      const record = records.get(effectId);
      if (!record || record.status !== "intent_recorded") return null;
      Object.assign(record, {
        status: "cancelled",
        cancelledAt,
        updatedAt: cancelledAt,
        resolution: { source: "cancel", outcome: "not_applied", resolvedBy: requestedBy, reason },
      });
      return structuredClone(record);
    },
    async resolve({ effectId, expectedStatuses, status, resolvedAt, resolution, output, receipt, externalRef }) {
      const record = records.get(effectId);
      if (!record || !expectedStatuses.includes(record.status)) return null;
      Object.assign(record, {
        status,
        updatedAt: resolvedAt,
        resolution: structuredClone(resolution),
        ...(status === "succeeded" ? {
          completedAt: resolvedAt,
          output: structuredClone(output),
          receipt: structuredClone(receipt),
          externalRef: structuredClone(externalRef),
        } : { cancelledAt: resolvedAt }),
      });
      return structuredClone(record);
    },
  };
}

const externalRef = (id = "task-1") => ({
  provider: "lark",
  resourceType: "task",
  id,
});

const capabilities = ({ reconcile = "none", cancel = "transport_only" } = {}) => ({
  idempotency: "provider_key",
  reconcile,
  cancel,
});

const connectionResolver = async ({ workspaceId, connectionId, toolId }) => {
  assert.equal(workspaceId, "workspace-a");
  assert.equal(connectionId, "connection-lark");
  assert.equal(toolId, "lark.task.create");
  return { profile: "governed-lark-profile" };
};

test("durable Lark writes require confirmation, persist a receipt, and replay without a second effect", async () => {
  const persistence = memoryPersistence();
  const calls = [];
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      calls.push(structuredClone({ ...request, signal: undefined }));
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      return {
        status: "succeeded",
        action: request.action,
        effect: "write",
        output: { taskId: "task-1" },
        externalRef: externalRef(),
        receipt: { receiptId: `lark-effect:${request.effectId}`, externalRef: externalRef() },
      };
    },
  };
  const execute = createDurableLarkToolExecutor({
    adapter,
    persistence,
    connectionResolver,
    clock: () => "2026-07-24T10:00:00.000Z",
  });

  const unconfirmed = await execute(writeRequest());
  assert.equal(unconfirmed.status, "confirmation_required");
  assert.equal(persistence.records.size, 0);

  const confirmedRequest = writeRequest({
    metadata: { ...writeRequest().metadata, externalActionConfirmed: true },
  });
  const first = await execute(confirmedRequest);
  const replay = await execute(confirmedRequest);

  assert.deepEqual(first.output, { taskId: "task-1" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.output, first.output);
  assert.equal(calls.filter((call) => call.confirmed === true).length, 1);
  assert.equal(persistence.records.get(confirmedRequest.effectId).status, "succeeded");
  assert.deepEqual(persistence.records.get(confirmedRequest.effectId).externalRef, externalRef());
  assert.equal(persistence.records.get(confirmedRequest.effectId).dispatchStartedAt, "2026-07-24T10:00:00.000Z");
  assert.equal(
    persistence.records.get(confirmedRequest.effectId).approvalFingerprint,
    connectionApprovalSnapshot.approvalFingerprint,
  );
  assert.equal(
    persistence.records.get(confirmedRequest.effectId).credentialBindingFingerprint,
    connectionApprovalSnapshot.credentialBindingFingerprint,
  );
  assert.equal(JSON.stringify(persistence.records.get(confirmedRequest.effectId)).includes("secret"), false);
});

test("durable Lark execution rejects missing Run approval snapshots and legacy receipt replay", async () => {
  const persistence = memoryPersistence();
  let confirmedCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      confirmedCalls += 1;
      return {
        status: "succeeded",
        action: request.action,
        effect: "write",
        output: { taskId: "task-lineage" },
        externalRef: externalRef("task-lineage"),
        receipt: {
          receiptId: `lark-effect:${request.effectId}`,
          externalRef: externalRef("task-lineage"),
        },
      };
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  await assert.rejects(
    execute(writeRequest({
      metadata: {
        ...writeRequest().metadata,
        connectionSnapshots: [],
        externalActionConfirmed: true,
      },
    })),
    { code: "run_connection_snapshot_unavailable" },
  );
  const request = writeRequest({
    metadata: { ...writeRequest().metadata, externalActionConfirmed: true },
  });
  await execute(request);
  delete persistence.records.get(request.effectId).approvalFingerprint;
  await assert.rejects(execute(request), { code: "effect_connection_lineage_unavailable" });
  assert.equal(confirmedCalls, 1);
});

test("an uncertain external write is fenced from automatic replay", async () => {
  const persistence = memoryPersistence();
  let confirmedCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      confirmedCalls += 1;
      const error = new Error("transport lost after dispatch");
      error.code = "lark_tool_failed";
      throw error;
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({
    metadata: { ...writeRequest().metadata, externalActionConfirmed: true },
  });

  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  await assert.rejects(() => execute(request), { code: "lark_effect_outcome_unknown" });
  assert.equal(confirmedCalls, 1);
  assert.equal(persistence.records.get(request.effectId).status, "outcome_unknown");
});

test("a non-terminal effect fails closed when the Driver capability snapshot changes", async () => {
  const persistence = memoryPersistence();
  let currentCapabilities = capabilities({ reconcile: "query" });
  let reconcileCalls = 0;
  const adapter = {
    effectCapabilities: () => currentCapabilities,
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      const failure = new Error("transport lost after dispatch");
      failure.code = "lark_tool_failed";
      throw failure;
    },
    async reconcileEffect() {
      reconcileCalls += 1;
      return { outcome: "unknown" };
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });

  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  currentCapabilities = capabilities({ reconcile: "query", cancel: "cooperative" });
  await assert.rejects(() => execute(request), { code: "lark_effect_driver_capability_conflict" });
  await assert.rejects(
    () => execute.reconcileEffect({ workspaceId: request.workspaceId, effectId: request.effectId }),
    { code: "lark_effect_driver_capability_conflict" },
  );
  assert.equal(reconcileCalls, 0);
});

test("an effect id cannot be rebound to different arguments", async () => {
  const persistence = memoryPersistence();
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      return {
        status: "succeeded",
        action: request.action,
        effect: "write",
        output: { taskId: "task-1" },
        externalRef: externalRef(),
        receipt: { receiptId: `lark-effect:${request.effectId}`, externalRef: externalRef() },
      };
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const confirmed = { ...writeRequest().metadata, externalActionConfirmed: true };
  await execute(writeRequest({ metadata: confirmed }));

  await assert.rejects(
    () => execute(writeRequest({
      metadata: confirmed,
      input: { summary: "Different task" },
    })),
    { code: "lark_effect_identity_conflict" },
  );
});

test("durable Lark receipts reject unsafe output before persistence", async () => {
  const persistence = memoryPersistence();
  const execute = createDurableLarkToolExecutor({
    persistence,
    connectionResolver,
    adapter: {
      effectCapabilities: () => capabilities(),
      async execute(request) {
        if (request.confirmed !== true) {
          return { status: "confirmation_required", action: request.action, effect: "write" };
        }
        return {
          status: "succeeded",
          action: request.action,
          effect: "write",
          output: {
            taskId: "task-safe",
            access_token: "must-not-persist",
            nested: { password: "also-secret", label: "Visible" },
          },
          externalRef: externalRef("task-safe"),
          receipt: { receiptId: `lark-effect:${request.effectId}`, externalRef: externalRef("task-safe") },
        };
      },
    },
  });
  const request = writeRequest({
    metadata: { ...writeRequest().metadata, externalActionConfirmed: true },
  });
  await assert.rejects(() => execute(request), { code: "lark_tool_output_forbidden" });
  const persisted = persistence.records.get(request.effectId);

  assert.equal(persisted.status, "outcome_unknown");
  assert.equal(Object.hasOwn(persisted, "output"), false);
  assert.equal(Object.hasOwn(persisted, "receipt"), false);
  assert.equal(JSON.stringify(persisted).includes("must-not-persist"), false);
  assert.equal(JSON.stringify(persisted).includes("also-secret"), false);
});

test("durable replay rejects a poisoned stored output instead of exposing it", async () => {
  const persistence = memoryPersistence();
  const request = writeRequest({
    metadata: { ...writeRequest().metadata, externalActionConfirmed: true },
  });
  await persistence.claim({
    schemaVersion: "workbench-internal-v1",
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    action: request.toolId,
    argumentDigest: `sha256:${createHash("sha256").update('{"summary":"Ship the release"}').digest("hex")}`,
    actorId: request.metadata.requestedBy,
    skillName: request.metadata.skillName,
    controllerId: request.controller.controllerId,
    nodeId: request.metadata.outerNodeId,
    connectionId: request.connectionId,
    ...connectionApprovalSnapshot,
    driverCapabilities: capabilities(),
    status: "succeeded",
    output: { taskId: "task-poisoned", url: "file:///Users/alice/private/result.json" },
    externalRef: externalRef("task-poisoned"),
    receipt: {
      receiptId: `lark-effect:${request.effectId}`,
      externalRef: externalRef("task-poisoned"),
    },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  });
  const execute = createDurableLarkToolExecutor({
    persistence,
    connectionResolver,
    adapter: {
      effectCapabilities: () => capabilities(),
      async execute(message) {
        return { status: "confirmation_required", action: message.action, effect: "write" };
      },
    },
  });

  await assert.rejects(() => execute(request), { code: "lark_tool_output_forbidden" });
});

test("an intent can be cancelled before dispatch without claiming an external rollback", async () => {
  const persistence = memoryPersistence();
  let confirmedCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      confirmedCalls += 1;
      throw new Error("must not dispatch");
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await persistence.claim({
    schemaVersion: "workbench-internal-v1",
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    action: request.toolId,
    argumentDigest: `sha256:${createHash("sha256").update('{"summary":"Ship the release"}').digest("hex")}`,
    actorId: request.metadata.requestedBy,
    skillName: request.metadata.skillName,
    controllerId: request.controller.controllerId,
    nodeId: request.metadata.outerNodeId,
    connectionId: request.connectionId,
    ...connectionApprovalSnapshot,
    driverCapabilities: capabilities(),
    status: "intent_recorded",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  });
  const cancelled = await execute.cancelEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    requestedBy: "user-a",
    reason: "No longer needed",
  });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => execute(request), { code: "lark_effect_cancelled" });
  assert.equal(confirmedCalls, 0);
});

test("the dedicated recovery API reconciles an unknown dispatch and returns its full receipt lineage", async () => {
  const persistence = memoryPersistence();
  let confirmedCalls = 0;
  let reconcileCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities({ reconcile: "query" }),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      confirmedCalls += 1;
      const failure = new Error("transport lost after dispatch");
      failure.code = "lark_tool_failed";
      throw failure;
    },
    async reconcileEffect(request) {
      reconcileCalls += 1;
      assert.equal(request.effectId, "effect-task-create-1");
      return {
        outcome: "succeeded",
        output: { taskId: "task-reconciled" },
        externalRef: externalRef("task-reconciled"),
        receipt: {
          receiptId: "lark-effect:effect-task-create-1",
          externalRef: externalRef("task-reconciled"),
        },
      };
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  const result = await execute.reconcileEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
  });
  assert.equal(result.effectId, request.effectId);
  assert.equal(result.action, request.toolId);
  assert.equal(result.connectionId, request.connectionId);
  assert.equal(result.requirementId, connectionApprovalSnapshot.requirementId);
  assert.equal(result.approvalFingerprint, connectionApprovalSnapshot.approvalFingerprint);
  assert.equal(result.invocationId, request.invocationId);
  assert.equal(result.attemptId, request.attemptId);
  assert.equal(result.output.taskId, "task-reconciled");
  assert.equal(confirmedCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(persistence.records.get(request.effectId).status, "succeeded");
});

test("an active dispatch lease prevents a concurrent caller from reconciling too early", async () => {
  const persistence = memoryPersistence();
  let enteredDispatch;
  const dispatchStarted = new Promise((resolve) => { enteredDispatch = resolve; });
  let finishDispatch;
  const dispatchGate = new Promise((resolve) => { finishDispatch = resolve; });
  let reconcileCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities({ reconcile: "query" }),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      enteredDispatch();
      await dispatchGate;
      return {
        status: "succeeded",
        action: request.action,
        effect: "write",
        output: { taskId: "task-live" },
        externalRef: externalRef("task-live"),
        receipt: { receiptId: `lark-effect:${request.effectId}`, externalRef: externalRef("task-live") },
      };
    },
    async reconcileEffect() {
      reconcileCalls += 1;
      return { outcome: "unknown" };
    },
  };
  const execute = createDurableLarkToolExecutor({
    adapter,
    persistence,
    connectionResolver,
    clock: () => "2026-08-01T00:00:00.000Z",
  });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  const first = execute(request);
  await dispatchStarted;
  await assert.rejects(() => execute(request), { code: "lark_effect_outcome_unknown" });
  await assert.rejects(() => execute.reconcileEffect({ workspaceId: request.workspaceId, effectId: request.effectId }), {
    code: "lark_effect_still_dispatching",
  });
  assert.equal(reconcileCalls, 0);
  finishDispatch();
  assert.equal((await first).status, "succeeded");
});

test("a stale dispatch window is automatically reconciled instead of blindly dispatched", async () => {
  const persistence = memoryPersistence();
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await persistence.claim({
    schemaVersion: "workbench-internal-v1",
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    action: request.toolId,
    argumentDigest: `sha256:${createHash("sha256").update('{"summary":"Ship the release"}').digest("hex")}`,
    actorId: request.metadata.requestedBy,
    skillName: request.metadata.skillName,
    controllerId: request.controller.controllerId,
    nodeId: request.metadata.outerNodeId,
    connectionId: request.connectionId,
    ...connectionApprovalSnapshot,
    driverCapabilities: capabilities({ reconcile: "query" }),
    status: "intent_recorded",
    createdAt: "2026-07-31T23:00:00.000Z",
    updatedAt: "2026-07-31T23:00:00.000Z",
  });
  await persistence.beginDispatch({
    effectId: request.effectId,
    dispatchStartedAt: "2026-07-31T23:00:00.000Z",
    reconcileAfter: "2026-07-31T23:05:00.000Z",
  });
  let confirmedCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities({ reconcile: "query" }),
    async execute(message) {
      if (message.confirmed !== true) return { status: "confirmation_required", action: message.action, effect: "write" };
      confirmedCalls += 1;
      throw new Error("must not redispatch");
    },
    async reconcileEffect() {
      return {
        outcome: "succeeded",
        output: { taskId: "task-after-crash" },
        externalRef: externalRef("task-after-crash"),
        receipt: {
          receiptId: "lark-effect:effect-task-create-1",
          externalRef: externalRef("task-after-crash"),
        },
      };
    },
  };
  const execute = createDurableLarkToolExecutor({
    adapter,
    persistence,
    connectionResolver,
    clock: () => "2026-08-01T00:00:00.000Z",
  });
  const result = await execute(request);
  assert.equal(result.reconciled, true);
  assert.equal(result.externalRef.id, "task-after-crash");
  assert.equal(confirmedCalls, 0);
});

test("automatic reconciliation reports not-applied as a terminal effect outcome, not a Tool success", async () => {
  const persistence = memoryPersistence();
  let confirmedCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities({ reconcile: "query" }),
    async execute(request) {
      if (request.confirmed !== true) return { status: "confirmation_required", action: request.action, effect: "write" };
      confirmedCalls += 1;
      const failure = new Error("transport lost");
      failure.code = "lark_tool_failed";
      throw failure;
    },
    async reconcileEffect() { return { outcome: "not_applied" }; },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  await assert.rejects(() => execute(request), { code: "lark_effect_not_applied" });
  assert.equal(confirmedCalls, 1);
  assert.equal(persistence.records.get(request.effectId).status, "cancelled");
});

test("an unqueryable unknown effect remains blocked until an explicit human resolution", async () => {
  const persistence = memoryPersistence();
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      if (request.confirmed !== true) {
        return { status: "confirmation_required", action: request.action, effect: "write" };
      }
      const failure = new Error("unknown after dispatch");
      failure.code = "lark_tool_failed";
      throw failure;
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  await assert.rejects(() => execute.reconcileEffect({ workspaceId: request.workspaceId, effectId: request.effectId }), {
    code: "lark_effect_reconciliation_unavailable",
  });
  await assert.rejects(() => execute.resolveEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    outcome: "succeeded",
    resolvedBy: "operator-a",
    reason: "Checked in Lark",
  }), { code: "lark_external_ref_required" });

  const resolved = await execute.resolveEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    outcome: "succeeded",
    resolvedBy: "operator-a",
    reason: "Checked in Lark",
    externalRef: externalRef("task-manual"),
    output: { taskId: "task-manual" },
  });
  assert.equal(resolved.status, "succeeded");
  assert.equal(resolved.resolution.source, "human");
  const replay = await execute(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.output.taskId, "task-manual");
});

test("a manual not-applied resolution is terminal and cannot be rewritten as succeeded", async () => {
  const persistence = memoryPersistence();
  const adapter = {
    effectCapabilities: () => capabilities(),
    async execute(request) {
      if (request.confirmed !== true) return { status: "confirmation_required", action: request.action, effect: "write" };
      const failure = new Error("unknown");
      failure.code = "lark_tool_failed";
      throw failure;
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  const resolved = await execute.resolveEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    outcome: "not_applied",
    resolvedBy: "operator-a",
    reason: "Provider search found no task",
  });
  assert.equal(resolved.status, "cancelled");
  await assert.rejects(() => execute.resolveEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    outcome: "succeeded",
    resolvedBy: "operator-a",
    reason: "Changed my mind",
    externalRef: externalRef("task-conflict"),
  }), { code: "lark_effect_resolution_conflict" });
});

test("cooperative Driver cancellation settles only after the Provider reports not applied", async () => {
  const persistence = memoryPersistence();
  let cancelCalls = 0;
  const adapter = {
    effectCapabilities: () => capabilities({ cancel: "cooperative" }),
    async execute(request) {
      if (request.confirmed !== true) return { status: "confirmation_required", action: request.action, effect: "write" };
      const failure = new Error("transport lost");
      failure.code = "lark_tool_failed";
      throw failure;
    },
    async cancelEffect() {
      cancelCalls += 1;
      return { outcome: "not_applied" };
    },
  };
  const execute = createDurableLarkToolExecutor({ adapter, persistence, connectionResolver });
  const request = writeRequest({ metadata: { ...writeRequest().metadata, externalActionConfirmed: true } });
  await assert.rejects(() => execute(request), { code: "lark_tool_failed" });
  const cancelled = await execute.cancelEffect({
    workspaceId: request.workspaceId,
    effectId: request.effectId,
    requestedBy: "operator-a",
    reason: "Stop if the Provider has not applied it",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.resolution.outcome, "not_applied");
  assert.equal(cancelCalls, 1);
});
