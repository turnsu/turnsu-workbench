import {
  AgentKernelError,
  createToolPipeline,
} from "../../agent-kernel/src/index.mjs";

/**
 * Creates the only Tool Pipeline bridge allowed to call a Product Gateway.
 * The invocation/lease binding is supplied by Product execution ownership;
 * a Kernel Plugin receives only the narrowed Tool Pipeline and can never use
 * the gateway, connection, or credential directly.
 */
export function createProductToolPipeline({
  gateway,
  binding,
  toolPolicy,
  systemSecurity,
  approvals,
  now,
} = {}) {
  assertDependencies({ gateway, binding, toolPolicy, systemSecurity, approvals, now });
  const resolvePolicy = async (call) => normalizePolicy(await toolPolicy.resolve({
    toolId: call.toolId,
    effectClass: call.effectClass,
    input: structuredClone(call.input),
  }), call);
  return createToolPipeline({
    now,
    validate: async (call) => ({
      toolId: call?.toolId,
      effectClass: call?.effectClass,
      input: structuredClone(call?.input ?? null),
    }),
    systemGuard: {
      check: async ({ call, executionGrant, signal }) => {
        const policy = await resolvePolicy(call);
        if (!policy) return { status: "denied", code: "product_tool_policy_denied" };
        return normalizeDecision(await systemSecurity.check({
          call: structuredClone(call),
          policy: structuredClone(policy),
          executionGrant,
          binding: structuredClone(binding),
          signal,
        }), "product_tool_guard_invalid");
      },
    },
    approval: {
      request: async ({ call, executionGrant, signal }) => {
        const policy = await resolvePolicy(call);
        if (!policy) return { status: "denied", code: "product_tool_policy_denied" };
        if (!policy.requiresApproval) return { status: "approved" };
        return normalizeApproval(await approvals.request({
          call: structuredClone(call),
          policy: structuredClone(policy),
          executionGrant,
          binding: structuredClone(binding),
          signal,
        }));
      },
    },
    gateway: {
      execute: async ({ call, executionGrant, signal }) => {
        const policy = await resolvePolicy(call);
        if (!policy) throw coded("product_tool_policy_denied");
        const output = await gateway.handle({
          invocationId: binding.invocationId,
          attemptId: binding.attemptId,
          capabilityLeaseId: binding.capabilityLeaseId,
          operation: "tool",
          toolId: policy.gatewayToolId,
          ...(policy.connectionId === null ? {} : { connectionId: policy.connectionId }),
          ...(policy.childCapabilities === null ? {} : { childCapabilities: structuredClone(policy.childCapabilities) }),
          ...(policy.externalAction ? { externalAction: true, effectId: policy.effectId } : {}),
          input: structuredClone(call.input),
          signal,
        }, structuredClone(binding));
        if (output?.status === "uncertain" && typeof output.effectId === "string" && output.effectId) {
          return {
            status: "uncertain",
            effectId: output.effectId,
            code: safeCode(output.code, "effect_outcome_unknown"),
          };
        }
        if (output?.status === "uncertain" && policy.effectId) {
          return {
            status: "uncertain",
            effectId: policy.effectId,
            code: safeCode(output.code, "effect_outcome_unknown"),
          };
        }
        return { status: "completed", output: structuredClone(output) };
      },
    },
  });
}

function assertDependencies({ gateway, binding, toolPolicy, systemSecurity, approvals, now }) {
  if (typeof gateway?.handle !== "function"
    || !binding || !validBinding(binding)
    || typeof toolPolicy?.resolve !== "function"
    || typeof systemSecurity?.check !== "function"
    || typeof approvals?.request !== "function"
    || typeof now !== "function") {
    throw new AgentKernelError("product_tool_pipeline_dependencies_invalid");
  }
}

function validBinding(value) {
  return [value.invocationId, value.attemptId, value.capabilityLeaseId]
    .every((item) => typeof item === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(item));
}

function normalizePolicy(value, call) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.toolId !== call.toolId || value.effectClass !== call.effectClass
    || typeof value.gatewayToolId !== "string" || !value.gatewayToolId) return null;
  const connectionId = value.connectionId === undefined || value.connectionId === null
    ? null
    : String(value.connectionId);
  if (connectionId !== null && !connectionId) return null;
  const childCapabilities = value.childCapabilities === undefined || value.childCapabilities === null
    ? null
    : cloneJson(value.childCapabilities, "product_tool_policy_invalid");
  const externalAction = value.externalAction === true;
  const effectId = externalAction && typeof value.effectId === "string"
    && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.effectId)
    ? value.effectId
    : null;
  if (externalAction && effectId === null) return null;
  return Object.freeze({
    toolId: value.toolId,
    effectClass: value.effectClass,
    gatewayToolId: value.gatewayToolId,
    connectionId,
    requiresApproval: value.requiresApproval === true,
    childCapabilities,
    externalAction,
    effectId,
  });
}

function normalizeDecision(value, code) {
  if (!value || typeof value !== "object") throw new AgentKernelError(code);
  if (value.status === "allowed") return { status: "allowed" };
  if (value.status === "denied") return { status: "denied", code: safeCode(value.code, "system_guard_denied") };
  throw new AgentKernelError(code);
}

function normalizeApproval(value) {
  if (!value || typeof value !== "object") throw new AgentKernelError("product_tool_approval_invalid");
  if (value.status === "approved") return { status: "approved" };
  if (value.status === "denied") return { status: "denied", code: safeCode(value.code, "approval_denied") };
  if (value.status === "pending" && typeof value.approvalId === "string"
    && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.approvalId)) {
    return { status: "pending", approvalId: value.approvalId };
  }
  throw new AgentKernelError("product_tool_approval_invalid");
}

function cloneJson(value, code) {
  try { return structuredClone(value); } catch (error) { throw new AgentKernelError(code, code, { cause: error }); }
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
