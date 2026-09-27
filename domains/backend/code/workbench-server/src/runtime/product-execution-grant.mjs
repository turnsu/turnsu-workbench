import { createHash } from "node:crypto";

import {
  createExecutionGrant,
  serializeExecutionGrant,
} from "../../../../../agent/code/agent-kernel/src/index.mjs";
import { getLarkToolPolicy } from "../tools/lark-tool-policy.mjs";
import { AGENT_MATERIAL_TOOL_ID } from "../tools/agent-material-tool.mjs";

/**
 * Derives a JSON-safe, deny-by-default Harness ExecutionGrant from the
 * Product Execution lease.  It is not an independent authority: the Product
 * Gateway rechecks the same lease on every model or Tool operation.
 */
export function createProductExecutionGrant({
  invocationId,
  capabilityLeaseId,
  expiresAt,
  capabilities,
  maxToolCalls,
  scopeRef = invocationId,
} = {}) {
  assertInput({ invocationId, capabilityLeaseId, expiresAt, capabilities, maxToolCalls, scopeRef });
  const effects = productToolEffectMap(capabilities);
  const allowed = {
    toolIds: Object.keys(effects),
    effectClasses: [...new Set(Object.values(effects))],
  };
  const grant = createExecutionGrant({
    grantId: grantId({ invocationId, capabilityLeaseId }),
    expiresAt,
    allowedToolIds: allowed.toolIds,
    allowedEffectClasses: allowed.effectClasses,
    maxToolCalls: Math.min(maxToolCalls, allowed.toolIds.length > 0 ? maxToolCalls : 0),
    scopeRef,
  });
  return serializeExecutionGrant(grant);
}

export function productToolEffectMap(capabilities) {
  const result = {};
  const hasConnection = Array.isArray(capabilities.connectionIds)
    && capabilities.connectionIds.some((value) => typeof value === "string" && value.length > 0);
  for (const toolId of new Set(capabilities.toolAllowlist)) {
    if (toolId === AGENT_MATERIAL_TOOL_ID) {
      result[toolId] = "read";
      continue;
    }
    if (!hasConnection) continue;
    const policy = getLarkToolPolicy(toolId);
    if (!policy) continue;
    if (policy.effect === "read") {
      result[toolId] = "read";
    } else if (policy.effect === "write" && capabilities.externalActions === true) {
      result[toolId] = "external_write";
    }
  }
  return Object.freeze(result);
}

function assertInput({ invocationId, capabilityLeaseId, expiresAt, capabilities, maxToolCalls, scopeRef }) {
  for (const value of [invocationId, capabilityLeaseId, scopeRef]) {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      throw new TypeError("product_execution_grant_identity_invalid");
    }
  }
  if (!Number.isFinite(Date.parse(expiresAt)) || !Number.isInteger(maxToolCalls) || maxToolCalls < 0
    || !capabilities || typeof capabilities !== "object"
    || !Array.isArray(capabilities.toolAllowlist) || !Array.isArray(capabilities.connectionIds)) {
    throw new TypeError("product_execution_grant_input_invalid");
  }
}

function grantId({ invocationId, capabilityLeaseId }) {
  const digest = createHash("sha256")
    .update(`${invocationId}\u0000${capabilityLeaseId}`)
    .digest("hex");
  return `execution-grant-${digest.slice(0, 48)}`;
}
