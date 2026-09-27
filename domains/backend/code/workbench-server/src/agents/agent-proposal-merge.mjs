import { createHash } from "node:crypto";

import {
  Check,
  UpdateSkillDraftDataSchema,
} from "@looloomi/workbench-contracts";

const MISSING = Symbol("missing");
const EDITABLE_SKILL_FIELDS = new Set([
  "name",
  "description",
  "category",
  "inputSchema",
  "outputSchema",
  "risk",
  "dependencies",
  "connectionRequirements",
]);

export function mergeSkillDraftProposal({ base, current, operations }) {
  if (!base || !current || base.skillDraftId !== current.skillDraftId) {
    throw proposalMergeError("agent_proposal_base_invalid");
  }
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 256) {
    throw proposalMergeError("agent_proposal_operation_invalid");
  }
  const proposed = structuredClone(base);
  const affectedFields = new Set();
  for (const operation of operations) {
    const parts = parsePath(operation?.path);
    if (!EDITABLE_SKILL_FIELDS.has(parts[0])) {
      throw proposalMergeError("agent_proposal_path_forbidden", { path: operation?.path });
    }
    affectedFields.add(parts[0]);
    applyJsonPatch(proposed, operation, parts);
  }
  const conflicts = [];
  const patch = {};
  for (const field of [...affectedFields].sort()) {
    const baseValue = Object.hasOwn(base, field) ? base[field] : MISSING;
    const currentValue = Object.hasOwn(current, field) ? current[field] : MISSING;
    const proposedValue = Object.hasOwn(proposed, field) ? proposed[field] : MISSING;
    if (!equal(baseValue, currentValue) && !equal(currentValue, proposedValue)) {
      conflicts.push({
        path: `/${escapePath(field)}`,
        baseValueHash: valueHash(baseValue),
        currentValueHash: valueHash(currentValue),
        proposedValueHash: valueHash(proposedValue),
      });
      continue;
    }
    if (!equal(currentValue, proposedValue) && proposedValue !== MISSING) {
      patch[field] = structuredClone(proposedValue);
    }
  }
  if (conflicts.length) return { status: "conflicted", patch: null, conflicts };
  if (Object.keys(patch).length === 0 || !Check(UpdateSkillDraftDataSchema, patch)) {
    throw proposalMergeError("agent_proposal_result_invalid");
  }
  return { status: "merged", patch, conflicts: [] };
}

function applyJsonPatch(document, operation, parts) {
  if (
    !operation
    || !["add", "replace", "remove"].includes(operation.op)
    || (operation.op !== "remove" && !Object.hasOwn(operation, "value"))
  ) {
    throw proposalMergeError("agent_proposal_operation_invalid");
  }
  let target = document;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) {
      throw proposalMergeError("agent_proposal_target_missing", { path: operation.path });
    }
    target = target[part];
  }
  const key = parts.at(-1);
  if (Array.isArray(target)) {
    const index = key === "-" ? target.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > target.length) {
      throw proposalMergeError("agent_proposal_array_index_invalid", { path: operation.path });
    }
    if (operation.op === "add") target.splice(index, 0, structuredClone(operation.value));
    else if (index >= target.length) throw proposalMergeError("agent_proposal_target_missing", { path: operation.path });
    else if (operation.op === "remove") target.splice(index, 1);
    else target[index] = structuredClone(operation.value);
    return;
  }
  if (!target || typeof target !== "object") {
    throw proposalMergeError("agent_proposal_target_missing", { path: operation.path });
  }
  const exists = Object.hasOwn(target, key);
  if (operation.op === "add" && exists) throw proposalMergeError("agent_proposal_add_target_exists", { path: operation.path });
  if (operation.op !== "add" && !exists) throw proposalMergeError("agent_proposal_target_missing", { path: operation.path });
  if (operation.op === "remove") delete target[key];
  else target[key] = structuredClone(operation.value);
}

function parsePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 1000) {
    throw proposalMergeError("agent_proposal_operation_invalid");
  }
  const parts = path.slice(1).split("/").map(unescapePath);
  if (
    parts.length === 0
    || parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))
  ) {
    throw proposalMergeError("agent_proposal_operation_invalid");
  }
  return parts;
}

function equal(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueHash(value) {
  const serialized = value === MISSING ? "<missing>" : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function escapePath(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePath(value) {
  return String(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

function proposalMergeError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
