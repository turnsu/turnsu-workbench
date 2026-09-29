import { createHash } from "node:crypto";

import { createProductToolPipeline } from "../../../../packages/product-bridge/src/index.mjs";
import { getLarkToolPolicy } from "../tools/lark-tool-policy.mjs";

/**
 * Product composition for the Harness Tool Pipeline.  It exposes only Lark
 * actions already declared by the Product catalog, binds every request to one
 * active Execution Gateway lease, and fails closed for external writes when
 * no Product Inbox approval provider was supplied.
 */
export function createProductGatewayToolPipeline({
  gateway,
  binding,
  connectionId,
  approvalPort = null,
  systemSecurity = null,
  effectIdFactory = deterministicEffectId,
  clock = () => new Date().toISOString(),
} = {}) {
  if (typeof connectionId !== "string" || !connectionId
    || typeof effectIdFactory !== "function" || typeof clock !== "function") {
    throw new TypeError("product_gateway_tool_pipeline_target_invalid");
  }
  return createProductToolPipeline({
    gateway,
    binding,
    toolPolicy: {
      async resolve(call) {
        const policy = getLarkToolPolicy(call.toolId);
        const effectClass = policy?.effect === "write" ? "external_write" : policy?.effect === "read" ? "read" : null;
        if (!policy || call.effectClass !== effectClass) return null;
        const externalAction = policy.effect === "write";
        return {
          toolId: policy.action,
          effectClass,
          gatewayToolId: policy.action,
          connectionId,
          requiresApproval: policy.confirmationRequired,
          externalAction,
          ...(externalAction ? {
            effectId: effectIdFactory({ binding, call, policy }),
          } : {}),
        };
      },
    },
    systemSecurity: systemSecurity ?? pinnedProductToolSecurity(),
    approvals: approvalPort ?? unavailableApprovalPort(),
    now: clock,
  });
}

export function pinnedProductToolSecurity() {
  return Object.freeze({
    async check({ call, policy }) {
      if (!policy
        || call.toolId !== policy.toolId
        || call.effectClass !== policy.effectClass
        || !policy.gatewayToolId
        || !policy.connectionId) {
        return { status: "denied", code: "product_tool_policy_denied" };
      }
      if (policy.externalAction && policy.effectClass !== "external_write") {
        return { status: "denied", code: "product_tool_effect_class_invalid" };
      }
      return { status: "allowed" };
    },
  });
}

function unavailableApprovalPort() {
  return Object.freeze({
    async request() {
      return { status: "denied", code: "product_approval_unavailable" };
    },
  });
}

function deterministicEffectId({ binding, call, policy }) {
  const source = JSON.stringify({
    invocationId: binding?.invocationId,
    attemptId: binding?.attemptId,
    toolId: call?.toolId,
    input: call?.input,
    policy: policy?.action,
  });
  return `effect-${createHash("sha256").update(source).digest("hex").slice(0, 56)}`;
}
