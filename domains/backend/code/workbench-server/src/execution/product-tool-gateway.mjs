import { Check, ExecutionCapabilitiesSchema } from "@looloomi/workbench-contracts";

import { capabilitiesAreSubset } from "./execution-broker.mjs";

const MAX_GATEWAY_INPUT_BYTES = 1_000_000;

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
      } finally {
        this.#untrackModelController(message, modelController);
      }
    } else {
      assertToolAllowed(message, effectiveCapabilities);
      if (!this.#toolExecutor) throw blocked("tool_backend_unavailable");
      result = await this.#toolExecutor({
        toolId: message.toolId,
        connectionId: message.connectionId ?? null,
        input: structuredClone(message.input),
        invocationId: message.invocationId,
        attemptId: message.attemptId,
        workspaceId: invocation.workspaceId,
        capabilities: structuredClone(effectiveCapabilities),
        signal: message.signal,
      });
    }
    await this.#authorize(message, binding);
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
    };
    return {
      requestedModelRevisionId: usage.requestedModelRevisionIds.size === 1
        ? [...usage.requestedModelRevisionIds][0]
        : null,
      actualModelRevisionId: usage.actualModelRevisionIds.size === 1
        ? [...usage.actualModelRevisionIds][0]
        : null,
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

function assertToolAllowed(message, capabilities) {
  if (typeof message.toolId !== "string" || !capabilities.toolAllowlist.includes(message.toolId)) {
    throw denied("gateway_tool_forbidden");
  }
  if (message.connectionId !== undefined && !capabilities.connectionIds.includes(message.connectionId)) {
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
