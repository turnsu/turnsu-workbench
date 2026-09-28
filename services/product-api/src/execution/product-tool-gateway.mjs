import { Check, ExecutionCapabilitiesSchema } from "@turnsu/workbench-contracts";

import { sanitizeLarkToolResult } from "../tools/lark-tool-output.mjs";
import { getLarkToolPolicy } from "../tools/lark-tool-policy.mjs";
import { AGENT_MATERIAL_TOOL_ID } from "../tools/agent-material-tool.mjs";
import { capabilitiesAreSubset } from "./execution-broker.mjs";

const MAX_GATEWAY_INPUT_BYTES = 1_000_000;
const MODEL_USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "imageCount", "costUsdMicros"];

export class ProductToolGatewayError extends Error {
  constructor(code, message = code, { status = "permission_denied" } = {}) {
    super(message);
    this.name = "ProductToolGatewayError";
    this.code = code;
    this.status = status;
    this.productSafe = true;
  }
}

export class ProductToolGateway {
  #persistence;
  #modelExecutor;
  #toolExecutor;
  #clock;
  #observer;
  #usage = new Map();
  #modelControllers = new Map();

  constructor({
    persistence,
    modelExecutor = null,
    toolExecutor = null,
    clock = () => new Date().toISOString(),
    observer = null,
  } = {}) {
    if (!persistence?.getActiveLease || !persistence?.getInvocation || typeof clock !== "function") {
      throw new TypeError("product_tool_gateway_persistence_required");
    }
    if (modelExecutor !== null && typeof modelExecutor !== "function") throw new TypeError("product_model_executor_invalid");
    if (toolExecutor !== null && typeof toolExecutor !== "function") throw new TypeError("product_tool_executor_invalid");
    if (observer !== null && typeof observer !== "function") throw new TypeError("product_gateway_observer_invalid");
    this.#persistence = persistence;
    this.#modelExecutor = modelExecutor;
    this.#toolExecutor = toolExecutor;
    this.#clock = clock;
    this.#observer = observer;
  }

  async handle(message, binding) {
    try {
      const result = await this.#dispatch(message, binding);
      this.#observer?.({ outcome: "allowed", code: "ok", operation: message?.operation });
      return result;
    } catch (error) {
      this.#observer?.({ outcome: "rejected", code: safeObserverCode(error?.code), operation: message?.operation });
      throw error;
    }
  }

  async recoverEffect(message, binding) {
    try {
      validateRecoveryMessage(message, binding);
      const { invocation, lease } = await this.#authorize(message, binding);
      const recovery = invocation.request?.metadata?.effectRecovery;
      if (!sameRecovery(recovery, message.effectRecovery)) {
        throw denied("gateway_effect_recovery_lineage_invalid");
      }
      assertToolAllowed({
        toolId: recovery.action,
        connectionId: recovery.connectionId,
        externalAction: true,
      }, lease.capabilities);
      assertRecoveryConnectionSnapshot(invocation.request?.metadata, recovery);
      if (typeof this.#toolExecutor?.reconcileEffect !== "function") {
        throw outcomeUnknown("gateway_effect_recovery_unavailable");
      }
      const usage = this.#usageFor(message.invocationId, message.attemptId);
      if (usage.steps !== 0 || invocation.request.limits.maxSteps < 1) {
        throw outcomeUnknown("gateway_effect_recovery_budget_exceeded");
      }
      usage.steps += 1;
      const result = await this.#toolExecutor.reconcileEffect({
        workspaceId: invocation.workspaceId,
        effectId: recovery.effectId,
        signal: message.signal,
      });
      await this.#authorize(message, binding);
      assertRecoveredEffect(result, recovery, invocation);
      let safe;
      try {
        safe = sanitizeLarkToolResult(recovery.action, {
          status: result.status,
          action: result.action,
          effect: getLarkToolPolicy(recovery.action)?.effect,
          output: result.output,
          externalRef: result.externalRef,
          receipt: result.receipt,
          reconciled: true,
        });
      } catch (error) {
        throw new ProductToolGatewayError(
          safeObserverCode(error?.code),
          "The recovered Lark Tool output did not match its product contract.",
          { status: "effect_outcome_unknown" },
        );
      }
      const projected = {
        ...safe,
        effectId: recovery.effectId,
        connectionId: recovery.connectionId,
        requirementId: recovery.requirementId,
        approvalFingerprint: recovery.approvalFingerprint,
        credentialBindingFingerprint: recovery.credentialBindingFingerprint,
        driverBackend: recovery.driverBackend,
        sourceInvocationId: recovery.sourceInvocationId,
        sourceAttemptId: recovery.sourceAttemptId,
      };
      if (!isJsonValue(projected) || byteLength(projected) > invocation.request.limits.maxOutputBytes) {
        throw outcomeUnknown("gateway_effect_recovery_result_invalid");
      }
      this.#observer?.({ outcome: "allowed", code: "ok", operation: "effect_recovery" });
      return structuredClone(projected);
    } catch (error) {
      this.#observer?.({
        outcome: "rejected",
        code: safeObserverCode(error?.code),
        operation: "effect_recovery",
      });
      throw error;
    }
  }

  async #dispatch(message, binding) {
    validateGatewayMessage(message, binding);
    const { invocation, lease } = await this.#authorize(message, binding);
    const limits = invocation.request?.limits;
    const effectiveCapabilities = message.childCapabilities ?? lease.capabilities;
    if (message.childCapabilities
      && (!Check(ExecutionCapabilitiesSchema, message.childCapabilities)
        || !capabilitiesAreSubset(message.childCapabilities, lease.capabilities))) {
      throw denied("gateway_child_capability_escalation");
    }
    const usage = this.#usageFor(message.invocationId, message.attemptId);
    if (message.operation === "child_authorize") {
      return { allowed: true, capabilities: structuredClone(effectiveCapabilities) };
    }
    if (usage.steps >= limits.maxSteps) throw denied("gateway_step_budget_exceeded");
    usage.steps += 1;

    let result;
    if (message.operation === "model") {
      if (usage.modelRequests >= limits.maxModelRequests) throw denied("gateway_model_budget_exceeded");
      if (!this.#modelExecutor) throw blocked("provider_unavailable");
      usage.modelRequests += 1;
      const modelController = new AbortController();
      this.#trackModelController(message, modelController);
      try {
        result = await this.#modelExecutor({
          typedInput: structuredClone(message.input),
          modelProfileRevisionId: invocation.request?.metadata?.modelProfileRevisionId ?? null,
          fallbackModelProfileRevisionIds: structuredClone(
            invocation.request?.metadata?.fallbackModelProfileRevisionIds ?? [],
          ),
          capability: invocation.request?.metadata?.modelCapability ?? "structured_output",
          invocationId: message.invocationId,
          attemptId: message.attemptId,
          workspaceId: invocation.workspaceId,
          capabilityLeaseId: lease.capabilityLeaseId,
          fence: lease.fence,
          limits: structuredClone(limits),
          signal: modelController.signal,
        });
        const requestedModelRevisionId = invocation.request?.metadata?.modelProfileRevisionId;
        const allowedActualRevisions = new Set([
          requestedModelRevisionId,
          ...(invocation.request?.metadata?.fallbackModelProfileRevisionIds ?? []),
        ]);
        if (typeof requestedModelRevisionId !== "string"
          || result?.requestedModelRevisionId !== requestedModelRevisionId
          || typeof result?.actualModelRevisionId !== "string"
          || !allowedActualRevisions.has(result.actualModelRevisionId)) {
          throw new ProductToolGatewayError(
            "gateway_model_route_unverified",
            "The model route could not be verified.",
            { status: "failed" },
          );
        }
        usage.requestedModelRevisionIds.add(result.requestedModelRevisionId);
        usage.actualModelRevisionIds.add(result.actualModelRevisionId);
        for (const name of MODEL_USAGE_FIELDS) {
          const amount = result.usage?.[name] ?? 0;
          if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(usage[name] + amount)) {
            throw new ProductToolGatewayError("gateway_model_usage_invalid", "The model usage could not be verified.", { status: "failed" });
          }
          usage[name] += amount;
        }
      } finally {
        this.#untrackModelController(message, modelController);
      }
    } else {
      assertToolAllowed(message, effectiveCapabilities);
      if (!this.#toolExecutor) throw blocked("tool_backend_unavailable");
      result = await this.#toolExecutor({
        toolId: message.toolId,
        actor: structuredClone(invocation.request?.actor ?? null),
        connectionId: message.connectionId ?? null,
        input: structuredClone(message.input),
        invocationId: message.invocationId,
        attemptId: message.attemptId,
        workspaceId: invocation.workspaceId,
        controller: structuredClone(invocation.request?.controller ?? null),
        capabilities: structuredClone(effectiveCapabilities),
        metadata: structuredClone(invocation.request?.metadata ?? {}),
        effectId: message.effectId,
        signal: message.signal,
      });
    }
    await this.#authorize(message, binding);
    if (message.operation === "tool" && getLarkToolPolicy(message.toolId)) {
      try {
        result = sanitizeLarkToolResult(message.toolId, result);
      } catch (error) {
        throw new ProductToolGatewayError(
          safeObserverCode(error?.code),
          "The Lark Tool returned output that did not match its product contract.",
          { status: "failed" },
        );
      }
    }
    if (!isJsonValue(result) || byteLength(result) > limits.maxOutputBytes) {
      throw new ProductToolGatewayError("gateway_result_invalid", "Gateway result is invalid.", { status: "failed" });
    }
    return structuredClone(result);
  }

  release({ invocationId, attemptId }, { reason } = {}) {
    const key = `${invocationId}:${attemptId}`;
    for (const controller of this.#modelControllers.get(key) ?? []) {
      controller.abort(reason ?? blocked("gateway_session_closed"));
    }
    this.#modelControllers.delete(key);
    this.#usage.delete(key);
  }

  snapshot({ invocationId, attemptId }) {
    const usage = this.#usage.get(`${invocationId}:${attemptId}`);
    if (!usage) return {
      requestedModelRevisionId: null,
      actualModelRevisionId: null,
      usage: { steps: 0, modelRequests: 0, ...Object.fromEntries(MODEL_USAGE_FIELDS.map((name) => [name, 0])) },
    };
    return {
      requestedModelRevisionId: usage.requestedModelRevisionIds.size === 1
        ? [...usage.requestedModelRevisionIds][0]
        : null,
      actualModelRevisionId: usage.actualModelRevisionIds.size === 1
        ? [...usage.actualModelRevisionIds][0]
        : null,
      usage: {
        steps: usage.steps,
        modelRequests: usage.modelRequests,
        ...Object.fromEntries(MODEL_USAGE_FIELDS.map((name) => [name, usage[name]])),
      },
    };
  }

  #trackModelController(message, controller) {
    const key = `${message.invocationId}:${message.attemptId}`;
    const controllers = this.#modelControllers.get(key) ?? new Set();
    controllers.add(controller);
    this.#modelControllers.set(key, controllers);
  }

  #untrackModelController(message, controller) {
    const key = `${message.invocationId}:${message.attemptId}`;
    const controllers = this.#modelControllers.get(key);
    controllers?.delete(controller);
    if (controllers?.size === 0) this.#modelControllers.delete(key);
  }

  async #authorize(message, binding) {
    const now = this.#clock();
    const lease = await this.#persistence.getActiveLease(message.invocationId, message.attemptId, now);
    if (!lease
      || lease.capabilityLeaseId !== message.capabilityLeaseId
      || lease.capabilityLeaseId !== binding.capabilityLeaseId) {
      throw denied("gateway_capability_lease_invalid");
    }
    const invocation = await this.#persistence.getInvocation(message.invocationId);
    if (!invocation
      || invocation.attemptId !== message.attemptId
      || invocation.status !== "running"
      || !invocation.request?.limits) {
      throw denied("gateway_invocation_inactive");
    }
    return { invocation, lease };
  }

  #usageFor(invocationId, attemptId) {
    const key = `${invocationId}:${attemptId}`;
    let usage = this.#usage.get(key);
    if (!usage) {
      usage = {
        steps: 0,
        modelRequests: 0,
        ...Object.fromEntries(MODEL_USAGE_FIELDS.map((name) => [name, 0])),
        requestedModelRevisionIds: new Set(),
        actualModelRevisionIds: new Set(),
      };
      this.#usage.set(key, usage);
    }
    return usage;
  }
}

function validateGatewayMessage(message, binding) {
  if (!isPlainObject(message)
    || !isPlainObject(binding)
    || message.invocationId !== binding.invocationId
    || message.attemptId !== binding.attemptId
    || message.capabilityLeaseId !== binding.capabilityLeaseId
    || !["model", "tool", "child_authorize"].includes(message.operation)
    || !isJsonValue(message.input)
    || byteLength(message.input) > MAX_GATEWAY_INPUT_BYTES) {
    throw denied("gateway_request_invalid");
  }
}

function validateRecoveryMessage(message, binding) {
  if (!isPlainObject(message)
    || !isPlainObject(binding)
    || message.invocationId !== binding.invocationId
    || message.attemptId !== binding.attemptId
    || message.capabilityLeaseId !== binding.capabilityLeaseId
    || !validRecovery(message.effectRecovery)) {
    throw denied("gateway_effect_recovery_request_invalid");
  }
}

const RECOVERY_FIELDS = Object.freeze([
  "schemaVersion",
  "effectId",
  "action",
  "connectionId",
  "requirementId",
  "approvalFingerprint",
  "credentialBindingFingerprint",
  "driverBackend",
  "sourceInvocationId",
  "sourceAttemptId",
]);

function validRecovery(value) {
  return isPlainObject(value)
    && value.schemaVersion === "workbench-effect-recovery-v1"
    && RECOVERY_FIELDS.every((field) => typeof value[field] === "string" && value[field].length > 0)
    && Object.keys(value).every((field) => RECOVERY_FIELDS.includes(field));
}

function sameRecovery(left, right) {
  return validRecovery(left)
    && validRecovery(right)
    && RECOVERY_FIELDS.every((field) => left[field] === right[field]);
}

function assertRecoveryConnectionSnapshot(metadata, recovery) {
  const snapshot = (metadata?.connectionSnapshots ?? []).find((candidate) => (
    candidate?.connectionId === recovery.connectionId
    && candidate?.requirementId === recovery.requirementId
  ));
  if (!snapshot
    || snapshot.approvalFingerprint !== recovery.approvalFingerprint
    || snapshot.credentialBindingFingerprint !== recovery.credentialBindingFingerprint
    || snapshot.driverBackend !== recovery.driverBackend) {
    throw denied("gateway_effect_recovery_connection_invalid");
  }
}

function assertRecoveredEffect(result, recovery, invocation) {
  if (!isPlainObject(result)
    || result.status !== "succeeded"
    || result.effectId !== recovery.effectId
    || result.action !== recovery.action
    || result.connectionId !== recovery.connectionId
    || result.requirementId !== recovery.requirementId
    || result.approvalFingerprint !== recovery.approvalFingerprint
    || result.credentialBindingFingerprint !== recovery.credentialBindingFingerprint
    || result.driverBackend !== recovery.driverBackend
    || result.invocationId !== recovery.sourceInvocationId
    || result.attemptId !== recovery.sourceAttemptId
    || result.controllerId !== invocation.request?.controller?.controllerId
    || result.nodeId !== invocation.request?.metadata?.outerNodeId) {
    throw outcomeUnknown("gateway_effect_recovery_result_mismatch");
  }
}

function assertToolAllowed(message, capabilities) {
  if (typeof message.toolId !== "string" || !capabilities.toolAllowlist.includes(message.toolId)) {
    throw denied("gateway_tool_forbidden");
  }
  if (message.toolId === AGENT_MATERIAL_TOOL_ID) {
    if (message.connectionId != null) throw denied("gateway_connection_forbidden");
    if (message.externalAction === true) throw denied("gateway_external_action_forbidden");
    if (message.network === true) throw denied("gateway_network_forbidden");
  } else if (typeof message.connectionId !== "string" || !capabilities.connectionIds.includes(message.connectionId)) {
    throw denied("gateway_connection_forbidden");
  }
  if (message.network === true && capabilities.network !== true) throw denied("gateway_network_forbidden");
  if (message.externalAction === true && capabilities.externalActions !== true) throw denied("gateway_external_action_forbidden");
}

function denied(code) {
  return new ProductToolGatewayError(code, "Gateway request is not permitted.");
}

function blocked(code) {
  return new ProductToolGatewayError(code, "Gateway backend is unavailable.", { status: "blocked" });
}

function outcomeUnknown(code) {
  return new ProductToolGatewayError(
    code,
    "The original external effect could not be reconciled safely.",
    { status: "effect_outcome_unknown" },
  );
}

function safeObserverCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "gateway_error";
}

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}
