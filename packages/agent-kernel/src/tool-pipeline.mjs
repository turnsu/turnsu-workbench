import {
  AgentKernelError,
  assertEffectClass,
  assertExecutionGrant,
  assertIdentifier,
  cloneValue,
  freeze,
} from "./contracts.mjs";

/**
 * The Kernel owns ordering only.  Validation, approval and gateway providers
 * are supplied by a bridge/Profile, so this pipeline cannot discover a secret,
 * bypass Product policy, or turn a deny into an allow.
 */
export function createToolPipeline({ validate, systemGuard, approval, gateway, now = () => new Date().toISOString() } = {}) {
  if (typeof validate !== "function"
    || typeof systemGuard?.check !== "function"
    || typeof approval?.request !== "function"
    || typeof gateway?.execute !== "function"
    || typeof now !== "function") {
    throw new AgentKernelError("tool_pipeline_dependencies_invalid");
  }
  return freeze({
    async execute({ call, executionGrant, grantState, emit, signal } = {}) {
      if (typeof emit !== "function" || !grantState || !Number.isInteger(grantState.usedToolCalls)) {
        throw new AgentKernelError("tool_pipeline_execution_invalid");
      }
      const grant = assertExecutionGrant(executionGrant);
      const normalized = normalizeToolCall(await validate(cloneValue(call, "tool_call_invalid")));
      emit({
        type: "tool.requested",
        modelVisible: true,
        payload: { toolId: normalized.toolId, effectClass: normalized.effectClass },
      });
      if (!grant.allows({
        toolId: normalized.toolId,
        effectClass: normalized.effectClass,
        now: now(),
        usedToolCalls: grantState.usedToolCalls,
      })) {
        return denied({ emit, normalized, code: "execution_grant_denied" });
      }
      const guarded = normalizeGuardDecision(await systemGuard.check({
        call: cloneValue(normalized),
        executionGrant: grant,
        signal,
      }));
      if (guarded.status === "denied") {
        return denied({ emit, normalized, code: guarded.code });
      }
      const approvalDecision = normalizeApprovalDecision(await approval.request({
        call: cloneValue(normalized),
        executionGrant: grant,
        signal,
      }));
      if (approvalDecision.status === "pending") {
        const payload = {
          toolId: normalized.toolId,
          effectClass: normalized.effectClass,
          approvalId: approvalDecision.approvalId,
        };
        emit({ type: "approval.pending", modelVisible: true, payload });
        emit({ type: "tool.pending", modelVisible: true, payload });
        return freeze({ status: "pending", ...payload });
      }
      if (approvalDecision.status === "denied") {
        return denied({ emit, normalized, code: approvalDecision.code });
      }
      // Count only an effect that passed grant, monotonic guard, and approval.
      grantState.usedToolCalls += 1;
      let result;
      try {
        result = normalizeGatewayResult(await gateway.execute({
          call: cloneValue(normalized),
          executionGrant: grant,
          signal,
        }));
      } catch (error) {
        const code = safeCode(error?.code, "tool_gateway_failed");
        emit({
          type: "tool.failed",
          modelVisible: true,
          payload: { toolId: normalized.toolId, effectClass: normalized.effectClass, code },
        });
        return freeze({ status: "failed", toolId: normalized.toolId, effectClass: normalized.effectClass, code });
      }
      if (result.status === "uncertain") {
        emit({
          type: "effect.uncertain",
          modelVisible: true,
          payload: {
            toolId: normalized.toolId,
            effectClass: normalized.effectClass,
            effectId: result.effectId,
            code: result.code,
          },
        });
        return freeze({
          status: "uncertain",
          toolId: normalized.toolId,
          effectClass: normalized.effectClass,
          effectId: result.effectId,
          code: result.code,
        });
      }
      const completed = freeze({
        status: "completed",
        toolId: normalized.toolId,
        effectClass: normalized.effectClass,
        output: cloneValue(result.output, "tool_result_invalid"),
      });
      emit({
        type: "tool.result",
        modelVisible: true,
        payload: cloneValue(completed, "tool_result_invalid"),
      });
      return completed;
    },
  });
}

function normalizeToolCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentKernelError("tool_call_invalid");
  return freeze({
    toolId: assertIdentifier(value.toolId, "tool_call_invalid"),
    effectClass: assertEffectClass(value.effectClass, "tool_call_invalid"),
    input: cloneValue(value.input === undefined ? null : value.input, "tool_call_invalid"),
  });
}

function normalizeGuardDecision(value) {
  if (!value || typeof value !== "object") throw new AgentKernelError("tool_guard_invalid");
  if (value.status === "allowed") return freeze({ status: "allowed" });
  if (value.status === "denied") return freeze({ status: "denied", code: safeCode(value.code, "system_guard_denied") });
  throw new AgentKernelError("tool_guard_invalid");
}

function normalizeApprovalDecision(value) {
  if (!value || typeof value !== "object") throw new AgentKernelError("tool_approval_invalid");
  if (value.status === "approved") return freeze({ status: "approved" });
  if (value.status === "denied") return freeze({ status: "denied", code: safeCode(value.code, "approval_denied") });
  if (value.status === "pending") {
    return freeze({ status: "pending", approvalId: assertIdentifier(value.approvalId, "tool_approval_invalid") });
  }
  throw new AgentKernelError("tool_approval_invalid");
}

function normalizeGatewayResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentKernelError("tool_gateway_result_invalid");
  if (value.status === "completed") return freeze({ status: "completed", output: cloneValue(value.output, "tool_gateway_result_invalid") });
  if (value.status === "uncertain") {
    return freeze({
      status: "uncertain",
      effectId: assertIdentifier(value.effectId, "tool_gateway_result_invalid"),
      code: safeCode(value.code, "effect_outcome_unknown"),
    });
  }
  throw new AgentKernelError("tool_gateway_result_invalid");
}

function denied({ emit, normalized, code }) {
  const result = freeze({
    status: "denied",
    toolId: normalized.toolId,
    effectClass: normalized.effectClass,
    code: safeCode(code, "tool_denied"),
  });
  emit({ type: "tool.denied", modelVisible: true, payload: cloneValue(result) });
  return result;
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}
