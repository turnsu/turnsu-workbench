import { createHash } from "node:crypto";

import { isCompleteConnectionApprovalSnapshot } from "../connections/workspace-connection-service.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import { getLarkToolPolicy } from "./lark-tool-policy.mjs";
import {
  sanitizeLarkOperatorText,
  sanitizeLarkToolResult,
} from "./lark-tool-output.mjs";

const duplicateConflict = (error) => error?.code === "23505" || error?.code === "external_effect_exists";
const timestamp = (clock) => {
  const value = clock();
  return value instanceof Date ? value.toISOString() : String(value);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const CAPABILITY_VALUES = Object.freeze({
  idempotency: new Set(["none", "provider_key"]),
  reconcile: new Set(["none", "query"]),
  cancel: new Set(["none", "transport_only", "cooperative"]),
});
const EFFECT_ID = /^.{8,128}$/s;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const DEFAULT_DISPATCH_LEASE_MS = 5 * 60 * 1000;

function toolError(code, message, details = {}) {
  return new ProductStoreError(code, message, details);
}

export function createDurableLarkToolExecutor({
  adapter,
  persistence,
  connectionResolver,
  clock = () => new Date().toISOString(),
  dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
} = {}) {
  if (typeof adapter?.execute !== "function" || typeof adapter?.effectCapabilities !== "function") {
    throw new TypeError("durable_lark_adapter_required");
  }
  for (const method of [
    "get",
    "claim",
    "beginDispatch",
    "complete",
    "markOutcomeUnknown",
    "cancelIntent",
    "resolve",
  ]) {
    if (typeof persistence?.[method] !== "function") {
      throw new TypeError("external_effect_persistence_required");
    }
  }
  if (typeof connectionResolver !== "function") {
    throw new TypeError("lark_connection_resolver_required");
  }
  if (!Number.isSafeInteger(dispatchLeaseMs) || dispatchLeaseMs < 1_000 || dispatchLeaseMs > 60 * 60 * 1000) {
    throw new TypeError("external_effect_dispatch_lease_invalid");
  }

  async function executeDurableLarkTool({
    toolId,
    connectionId,
    input,
    workspaceId,
    invocationId,
    attemptId,
    controller,
    metadata,
    effectId,
    signal,
  } = {}) {
    const policy = getLarkToolPolicy(toolId);
    if (!policy) {
      throw toolError("lark_tool_not_allowed", "The requested Lark Tool is not registered.");
    }
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw toolError("lark_connection_required", "A governed Connection is required for every Lark Tool call.");
    }
    const expectedConnection = expectedConnectionFor(metadata, connectionId);
    if (!isCompleteConnectionApprovalSnapshot(expectedConnection)) {
      throw toolError(
        "run_connection_snapshot_unavailable",
        "This invocation has no complete immutable Connection approval snapshot.",
        { connectionId },
      );
    }
    const runtime = await connectionResolver({
      workspaceId,
      connectionId,
      toolId,
      requestedBy: metadata?.requestedBy,
      expectedConnection,
    });
    if (typeof runtime?.profile !== "string" || runtime.profile.length === 0) {
      throw toolError(
        "connection_runtime_binding_unavailable",
        "The selected Connection has no usable runtime binding.",
        { connectionId },
      );
    }
    const request = {
      action: toolId,
      skillName: metadata?.skillName,
      arguments: input,
      userId: metadata?.requestedBy,
      profile: runtime.profile,
      confirmed: metadata?.externalActionConfirmed === true,
      effectId,
      signal,
    };
    if (policy.effect !== "write") {
      return sanitizeLarkToolResult(toolId, await adapter.execute(request));
    }

    // This preflight validates the exact action and arguments without resolving
    // another profile or spawning the Driver process.
    const preflight = sanitizeLarkToolResult(
      toolId,
      await adapter.execute({ ...request, confirmed: false }),
    );
    if (request.confirmed !== true) return preflight;
    assertRecordKey(workspaceId, effectId);

    const capabilities = effectCapabilities(adapter, toolId);
    const identity = {
      workspaceId,
      effectId,
      action: toolId,
      argumentDigest: digest(input),
      actorId: metadata?.requestedBy ?? null,
      skillName: metadata?.skillName ?? null,
      controllerId: controller?.controllerId ?? null,
      nodeId: metadata?.outerNodeId ?? null,
      connectionId,
      approvalSchemaVersion: expectedConnection.approvalSchemaVersion,
      connectionRevision: expectedConnection?.connectionRevision ?? null,
      capabilityKey: expectedConnection?.capabilityKey ?? null,
      driverKey: expectedConnection?.driverKey ?? null,
      requirementId: expectedConnection?.requirementId ?? null,
      driverBackend: expectedConnection?.driverBackend ?? null,
      principal: expectedConnection?.principal ?? null,
      principalFingerprint: expectedConnection?.principalFingerprint ?? null,
      permissionFingerprint: expectedConnection?.permissionFingerprint ?? null,
      credentialBindingFingerprint: expectedConnection?.credentialBindingFingerprint ?? null,
      validationExpiresAt: expectedConnection?.validationExpiresAt ?? null,
      approvalFingerprint: expectedConnection?.approvalFingerprint ?? null,
    };
    let record = await persistence.get({ workspaceId, effectId });
    if (!record) {
      const now = timestamp(clock);
      try {
        record = await persistence.claim({
          schemaVersion: "workbench-internal-v1",
          ...identity,
          invocationId,
          attemptId,
          driverCapabilities: capabilities,
          status: "intent_recorded",
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (!duplicateConflict(error)) throw error;
        record = await persistence.get({ workspaceId, effectId });
        if (!record) {
          throw toolError(
            "lark_effect_claim_conflict",
            "The effect intent could not be durably claimed in this workspace.",
            { effectId },
          );
        }
      }
    }

    assertRecordConnectionLineage(record);
    assertSameEffect(record, identity);
    if (record.status === "succeeded") return replayResult(record);
    if (record.status === "cancelled") {
      throw toolError("lark_effect_cancelled", "This external effect was cancelled before a safe dispatch.", { effectId });
    }
    assertCapabilitySnapshot(record.driverCapabilities, capabilities, effectId);
    if (["dispatching", "outcome_unknown", "pending"].includes(record.status)) {
      const reconciled = await autoReconcile(record, { runtime, signal });
      if (reconciled) return reconciled;
      throw outcomeUnknown(record);
    }
    if (record.status !== "intent_recorded") {
      throw toolError("lark_effect_state_invalid", "The external effect is in an invalid durable state.", {
        effectId,
        status: record.status,
      });
    }
    const dispatchStartedAt = timestamp(clock);
    const dispatching = await persistence.beginDispatch({
      workspaceId,
      effectId,
      dispatchStartedAt,
      reconcileAfter: addMilliseconds(dispatchStartedAt, dispatchLeaseMs),
    });
    if (!dispatching) {
      const current = await persistence.get({ workspaceId, effectId });
      if (!current) throw toolError("lark_effect_state_missing", "The external effect intent disappeared before dispatch.", { effectId });
      assertRecordConnectionLineage(current);
      assertSameEffect(current, identity);
      if (current.status === "succeeded") return replayResult(current);
      if (current.status === "cancelled") {
        throw toolError("lark_effect_cancelled", "This external effect was cancelled before dispatch.", { effectId });
      }
      const reconciled = await autoReconcile(current, { runtime, signal });
      if (reconciled) return reconciled;
      throw outcomeUnknown(current);
    }

    try {
      const result = successResult(await adapter.execute({ ...request, confirmed: true }), policy, effectId);
      const completedAt = timestamp(clock);
      const completed = await persistence.complete({
        workspaceId,
        effectId,
        completedAt,
        output: result.output,
        receipt: result.receipt,
        externalRef: result.externalRef,
      });
      if (!completed) {
        throw toolError(
          "lark_effect_receipt_commit_failed",
          "The external write completed but its receipt could not be committed.",
          { effectId },
        );
      }
      return result;
    } catch (error) {
      const unknown = await persistence.markOutcomeUnknown({
        workspaceId,
        effectId,
        failedAt: timestamp(clock),
        errorCode: error?.code ?? "lark_tool_failed",
      });
      if (!unknown) {
        const current = await persistence.get({ workspaceId, effectId });
        if (current?.status === "succeeded") return replayResult(current);
      }
      throw error;
    }
  }

  async function autoReconcile(record, context) {
    if (record.status === "pending") return null;
    if (record.status === "dispatching" && !dispatchLeaseExpired(record, clock)) return null;
    const recorded = safeCapabilities(record.driverCapabilities);
    const current = effectCapabilities(adapter, record.action);
    if (recorded.reconcile !== "query" || current.reconcile !== "query") return null;
    const reconciled = await reconcileRecord(record, context);
    if (reconciled?.status === "cancelled") throw effectNotApplied(reconciled);
    return reconciled;
  }

  async function reconcileRecord(record, { runtime, signal } = {}) {
    if (typeof adapter.reconcileEffect !== "function") return null;
    let result;
    try {
      result = await adapter.reconcileEffect({
        action: record.action,
        effectId: record.effectId,
        profile: runtime.profile,
        externalRef: record.externalRef ?? null,
        signal,
      });
    } catch (error) {
      if (record.status === "dispatching") {
        await persistence.markOutcomeUnknown({
          workspaceId: record.workspaceId,
          effectId: record.effectId,
          failedAt: timestamp(clock),
          errorCode: error?.code ?? "lark_effect_reconciliation_failed",
        });
      }
      return null;
    }
    return settleDriverOutcome(record, result);
  }

  async function settleDriverOutcome(record, result) {
    if (!result || !["succeeded", "not_applied", "unknown"].includes(result.outcome)) {
      throw toolError("lark_effect_reconciliation_invalid", "The Driver returned an invalid reconciliation outcome.");
    }
    if (result.outcome === "unknown") {
      if (record.status === "dispatching") {
        await persistence.markOutcomeUnknown({
          workspaceId: record.workspaceId,
          effectId: record.effectId,
          failedAt: timestamp(clock),
          errorCode: "lark_effect_reconciliation_unknown",
        });
      }
      return null;
    }
    const resolvedAt = timestamp(clock);
    const resolution = {
      source: "driver",
      outcome: result.outcome,
      resolvedAt,
    };
    const succeeded = result.outcome === "succeeded";
    const success = succeeded
      ? successResult({ ...result, status: "succeeded", action: record.action, effect: "write" }, getLarkToolPolicy(record.action), record.effectId)
      : null;
    const resolved = await persistence.resolve({
      workspaceId: record.workspaceId,
      effectId: record.effectId,
      expectedStatuses: ["dispatching", "outcome_unknown"],
      status: succeeded ? "succeeded" : "cancelled",
      resolvedAt,
      resolution,
      output: success?.output,
      receipt: success?.receipt,
      externalRef: success?.externalRef,
    });
    if (resolved) return succeeded ? replayResult(resolved, { reconciled: true }) : resolved;
    const current = await persistence.get({ workspaceId: record.workspaceId, effectId: record.effectId });
    return terminalResolution(current, { requestedOutcome: result.outcome });
  }

  async function reconcileEffect({ workspaceId, effectId, signal } = {}) {
    assertRecordKey(workspaceId, effectId);
    const record = await persistence.get({ workspaceId, effectId });
    if (!record) throw toolError("lark_effect_not_found", "The external effect receipt was not found.", { effectId });
    if (record.status === "succeeded") return safeEffectRecord(record);
    if (record.status === "cancelled") return structuredClone(record);
    if (record.status === "intent_recorded") {
      throw toolError("lark_effect_not_dispatched", "The external effect has not entered the dispatch window.", { effectId });
    }
    if (record.status === "dispatching" && !dispatchLeaseExpired(record, clock)) {
      throw toolError(
        "lark_effect_still_dispatching",
        "The external effect is still inside its active dispatch window.",
        { effectId, reconcileAfter: record.reconcileAfter },
      );
    }
    const recorded = safeCapabilities(record.driverCapabilities);
    const current = effectCapabilities(adapter, record.action);
    assertCapabilitySnapshot(record.driverCapabilities, current, effectId);
    if (
      recorded.reconcile !== "query"
      || current.reconcile !== "query"
      || typeof adapter.reconcileEffect !== "function"
    ) {
      if (record.status === "dispatching") {
        await persistence.markOutcomeUnknown({
          workspaceId,
          effectId,
          failedAt: timestamp(clock),
          errorCode: "lark_effect_reconciliation_unavailable",
        });
      }
      throw toolError(
        "lark_effect_reconciliation_unavailable",
        "This Lark action cannot be queried; explicit human resolution is required.",
        { effectId, action: record.action },
      );
    }
    const runtime = await resolveRecordRuntime(record);
    const reconciled = await reconcileRecord(record, { runtime, signal });
    if (reconciled) {
      const settled = await persistence.get({ workspaceId, effectId });
      if (settled?.status === "succeeded") return safeEffectRecord(settled);
      if (settled) return structuredClone(settled);
    }
    throw outcomeUnknown(await persistence.get({ workspaceId, effectId }) ?? record);
  }

  async function resolveEffect({
    workspaceId,
    effectId,
    outcome,
    resolvedBy,
    reason,
    externalRef,
    output = null,
    receipt = null,
  } = {}) {
    assertRecordKey(workspaceId, effectId);
    if (!new Set(["succeeded", "not_applied"]).has(outcome)) {
      throw toolError("lark_effect_resolution_invalid", "The human effect resolution is invalid.");
    }
    if (
      typeof resolvedBy !== "string"
      || resolvedBy.length === 0
      || resolvedBy.length > 256
      || typeof reason !== "string"
      || reason.length === 0
      || reason.length > 2_000
    ) {
      throw toolError("lark_effect_resolution_actor_required", "Human effect resolution requires an actor and reason.");
    }
    const safeReason = sanitizeLarkOperatorText(reason);
    const record = await persistence.get({ workspaceId, effectId });
    if (!record) throw toolError("lark_effect_not_found", "The external effect receipt was not found.", { effectId });
    if (["succeeded", "cancelled"].includes(record.status)) {
      return terminalResolution(record, { requestedOutcome: outcome, externalRef });
    }
    if (!new Set(["dispatching", "outcome_unknown", "pending"]).has(record.status)) {
      throw toolError("lark_effect_resolution_not_allowed", "This effect is not waiting for outcome resolution.", {
        effectId,
        status: record.status,
      });
    }
    const resolvedAt = timestamp(clock);
    const resolution = {
      source: "human",
      outcome,
      resolvedBy,
      reason: safeReason,
      resolvedAt,
    };
    const succeeded = outcome === "succeeded";
    let success = null;
    if (succeeded) {
      if (!externalRef) {
        throw toolError("lark_external_ref_required", "A verified external reference is required to resolve this effect as succeeded.");
      }
      success = successResult({
        status: "succeeded",
        action: record.action,
        effect: "write",
        output,
        externalRef,
        receipt: receipt ? { ...receipt, externalRef } : {
          receiptId: `lark-effect:${effectId}`,
          action: record.action,
          effect: "write",
          externalRef,
          completedAt: resolvedAt,
        },
      }, getLarkToolPolicy(record.action), effectId);
    }
    const resolved = await persistence.resolve({
      workspaceId,
      effectId,
      expectedStatuses: ["dispatching", "outcome_unknown", "pending"],
      status: succeeded ? "succeeded" : "cancelled",
      resolvedAt,
      resolution,
      output: success?.output,
      receipt: success?.receipt,
      externalRef: success?.externalRef,
    });
    if (resolved) return succeeded ? safeEffectRecord(resolved) : structuredClone(resolved);
    const current = await persistence.get({ workspaceId, effectId });
    return terminalResolution(current, { requestedOutcome: outcome, externalRef });
  }

  async function cancelEffect({ workspaceId, effectId, requestedBy, reason = "Cancelled before dispatch.", signal } = {}) {
    assertRecordKey(workspaceId, effectId);
    if (
      typeof requestedBy !== "string"
      || requestedBy.length === 0
      || requestedBy.length > 256
      || typeof reason !== "string"
      || reason.length === 0
      || reason.length > 2_000
    ) {
      throw toolError("lark_effect_cancel_actor_required", "Effect cancellation requires an actor and reason.");
    }
    const safeReason = sanitizeLarkOperatorText(reason);
    let record = await persistence.get({ workspaceId, effectId });
    if (!record) throw toolError("lark_effect_not_found", "The external effect receipt was not found.", { effectId });
    if (record.status === "intent_recorded") {
      const cancelled = await persistence.cancelIntent({
        workspaceId,
        effectId,
        cancelledAt: timestamp(clock),
        requestedBy,
        reason: safeReason,
      });
      if (cancelled) return cancelled;
      record = await persistence.get({ workspaceId, effectId });
    }
    if (record?.status === "succeeded") return safeEffectRecord(record);
    if (record?.status === "cancelled") return structuredClone(record);
    const recorded = safeCapabilities(record?.driverCapabilities);
    const current = effectCapabilities(adapter, record?.action);
    assertCapabilitySnapshot(record?.driverCapabilities, current, effectId);
    if (
      recorded.cancel !== "cooperative"
      || current.cancel !== "cooperative"
      || typeof adapter.cancelEffect !== "function"
    ) {
      if (record?.status === "dispatching") {
        await persistence.markOutcomeUnknown({
          workspaceId,
          effectId,
          failedAt: timestamp(clock),
          errorCode: "lark_effect_cancel_unavailable",
        });
      }
      throw outcomeUnknown(await persistence.get({ workspaceId, effectId }) ?? record);
    }
    const runtime = await resolveRecordRuntime(record);
    const result = await adapter.cancelEffect({
      action: record.action,
      effectId,
      profile: runtime.profile,
      externalRef: record.externalRef ?? null,
      reason: safeReason,
      signal,
    });
    const settled = await settleDriverOutcome(record, result);
    if (settled) return settled;
    throw outcomeUnknown(await persistence.get({ workspaceId, effectId }) ?? record);
  }

  async function resolveRecordRuntime(record) {
    const expectedConnection = recordExpectedConnection(record);
    if (!expectedConnection) {
      throw toolError(
        "effect_connection_lineage_unavailable",
        "This historical effect has no complete Connection approval lineage and cannot be replayed or reconciled automatically.",
        { effectId: record.effectId },
      );
    }
    const runtime = await connectionResolver({
      workspaceId: record.workspaceId,
      connectionId: record.connectionId,
      toolId: record.action,
      requestedBy: record.actorId,
      expectedConnection,
    });
    if (typeof runtime?.profile !== "string" || runtime.profile.length === 0) {
      throw toolError("connection_runtime_binding_unavailable", "The effect Connection runtime is unavailable.");
    }
    return runtime;
  }

  Object.assign(executeDurableLarkTool, {
    reconcileEffect,
    resolveEffect,
    cancelEffect,
  });
  return Object.freeze(executeDurableLarkTool);
}

function expectedConnectionFor(metadata, connectionId) {
  return (metadata?.connectionSnapshots ?? [])
    .find((snapshot) => snapshot?.connectionId === connectionId) ?? null;
}

function recordExpectedConnection(record) {
  const expected = {
    approvalSchemaVersion: record.approvalSchemaVersion,
    requirementId: record.requirementId,
    connectionId: record.connectionId,
    connectionRevision: record.connectionRevision,
    capabilityKey: record.capabilityKey,
    driverKey: record.driverKey,
    driverBackend: record.driverBackend,
    principal: record.principal,
    principalFingerprint: record.principalFingerprint,
    permissionFingerprint: record.permissionFingerprint,
    credentialBindingFingerprint: record.credentialBindingFingerprint,
    validationExpiresAt: record.validationExpiresAt,
    approvalFingerprint: record.approvalFingerprint,
  };
  return isCompleteConnectionApprovalSnapshot(expected) ? expected : null;
}

function assertRecordConnectionLineage(record) {
  if (!recordExpectedConnection(record)) {
    throw toolError(
      "effect_connection_lineage_unavailable",
      "This historical effect has no complete Connection approval lineage and cannot be replayed automatically.",
      { effectId: record?.effectId },
    );
  }
}

function assertEffectId(effectId) {
  if (typeof effectId !== "string" || !EFFECT_ID.test(effectId)) {
    throw toolError("lark_effect_id_required", "A stable effect identifier is required for a Lark write.");
  }
}

function assertRecordKey(workspaceId, effectId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw toolError("workspace_id_required", "An effect workspace is required.");
  }
  assertEffectId(effectId);
}

function effectCapabilities(adapter, action) {
  return safeCapabilities(adapter.effectCapabilities(action), { strict: true });
}

function safeCapabilities(value, { strict = false } = {}) {
  const normalized = {
    idempotency: value?.idempotency,
    reconcile: value?.reconcile,
    cancel: value?.cancel,
  };
  const valid = Object.entries(normalized)
    .every(([key, entry]) => CAPABILITY_VALUES[key].has(entry));
  if (!valid) {
    if (strict) {
      throw toolError("lark_effect_capability_invalid", "The Lark Driver declared invalid effect capabilities.");
    }
    return { idempotency: "none", reconcile: "none", cancel: "none" };
  }
  return Object.freeze(normalized);
}

function assertCapabilitySnapshot(recorded, current, effectId) {
  if (canonicalJson(safeCapabilities(recorded)) !== canonicalJson(current)) {
    throw toolError(
      "lark_effect_driver_capability_conflict",
      "The Lark Driver capabilities changed after this effect intent was recorded.",
      { effectId },
    );
  }
}

function successResult(value, policy, effectId) {
  if (!policy) {
    throw toolError("lark_effect_result_invalid", "The Lark Driver returned an invalid write result.");
  }
  const result = sanitizeLarkToolResult(policy.action, value);
  if (
    result?.status !== "succeeded"
    || result.action !== policy.action
    || result.effect !== "write"
  ) {
    throw toolError("lark_effect_result_invalid", "The Lark Driver returned an invalid write result.");
  }
  const externalRef = validateExternalRef(result.externalRef, policy);
  const receiptRef = validateExternalRef(result.receipt?.externalRef, policy);
  if (canonicalJson(externalRef) !== canonicalJson(receiptRef)) {
    throw toolError("lark_effect_receipt_conflict", "The Lark receipt does not match its external reference.", { effectId });
  }
  if (typeof result.receipt?.receiptId !== "string" || result.receipt.receiptId.length === 0) {
    throw toolError("lark_effect_receipt_invalid", "The Lark Driver returned an invalid effect receipt.", { effectId });
  }
  return { ...result, externalRef, receipt: { ...result.receipt, externalRef } };
}

function validateExternalRef(value, policy) {
  if (
    !value
    || typeof value !== "object"
    || value.provider !== "lark"
    || value.resourceType !== policy?.driver?.resourceType
    || typeof value.id !== "string"
    || !EXTERNAL_ID.test(value.id)
    || (value.containerId !== undefined && (
      typeof value.containerId !== "string" || !EXTERNAL_ID.test(value.containerId)
    ))
  ) {
    throw toolError("lark_external_ref_invalid", "The Lark external reference is invalid.");
  }
  return {
    provider: "lark",
    resourceType: policy.driver.resourceType,
    id: value.id,
    ...(value.containerId ? { containerId: value.containerId } : {}),
  };
}

function replayResult(record, { reconciled = false } = {}) {
  return sanitizeLarkToolResult(record.action, {
    status: "succeeded",
    action: record.action,
    effect: "write",
    output: structuredClone(record.output),
    externalRef: structuredClone(record.externalRef),
    receipt: structuredClone(record.receipt),
    ...(reconciled ? { reconciled: true } : { replayed: true }),
  });
}

function safeEffectRecord(record) {
  const safe = replayResult(record);
  return {
    ...structuredClone(record),
    output: safe.output,
    externalRef: safe.externalRef,
    receipt: safe.receipt,
  };
}

function terminalResolution(record, { requestedOutcome, externalRef } = {}) {
  if (!record) {
    throw toolError("lark_effect_resolution_conflict", "The effect changed during outcome resolution.");
  }
  if (record.status === "succeeded" && requestedOutcome === "succeeded") {
    const requestedRef = externalRef
      ? validateExternalRef(externalRef, getLarkToolPolicy(record.action))
      : null;
    if (requestedRef && canonicalJson(record.externalRef) !== canonicalJson(requestedRef)) {
      throw toolError("lark_effect_resolution_conflict", "The effect already has a different external reference.");
    }
    return safeEffectRecord(record);
  }
  if (record.status === "cancelled" && requestedOutcome === "not_applied") return structuredClone(record);
  throw toolError("lark_effect_resolution_conflict", "The effect already has a different terminal outcome.", {
    status: record.status,
  });
}

function outcomeUnknown(record) {
  return toolError(
    "lark_effect_outcome_unknown",
    "This write may already be in progress or completed; automatic replay is disabled.",
    { effectId: record?.effectId, status: record?.status },
  );
}

function effectNotApplied(record) {
  return toolError(
    "lark_effect_not_applied",
    "Provider reconciliation confirmed that this external effect was not applied.",
    { effectId: record?.effectId, status: record?.status },
  );
}

function addMilliseconds(value, milliseconds) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError("external_effect_clock_invalid");
  return new Date(time + milliseconds).toISOString();
}

function dispatchLeaseExpired(record, clock) {
  const now = Date.parse(timestamp(clock));
  const reconcileAfter = Date.parse(record?.reconcileAfter);
  return Number.isFinite(now) && Number.isFinite(reconcileAfter) && now >= reconcileAfter;
}

function assertSameEffect(existing, identity) {
  for (const field of [
    "workspaceId",
    "effectId",
    "action",
    "argumentDigest",
    "actorId",
    "skillName",
    "controllerId",
    "nodeId",
    "connectionId",
    "connectionRevision",
    "capabilityKey",
    "driverKey",
    "approvalSchemaVersion",
    "requirementId",
    "driverBackend",
    "principal",
    "principalFingerprint",
    "permissionFingerprint",
    "credentialBindingFingerprint",
    "validationExpiresAt",
    "approvalFingerprint",
  ]) {
    if (existing[field] !== identity[field]) {
      throw toolError(
        "lark_effect_identity_conflict",
        "The effect identifier is already bound to a different external action.",
        { effectId: identity.effectId, field },
      );
    }
  }
}

function canonicalJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}
