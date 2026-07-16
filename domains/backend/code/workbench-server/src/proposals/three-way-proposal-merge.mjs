import { createHash } from "node:crypto";

import { Check, WorkflowRevisionSchema } from "@looloomi/workbench-contracts";

const MISSING = Symbol("missing");

export function mergeWorkflowProposal({ base, current, proposed }) {
  for (const [name, value] of Object.entries({ base, current, proposed })) {
    if (!Check(WorkflowRevisionSchema, value)) throw mergeError(`merge_${name}_revision_invalid`);
  }
  const baseUnits = units(base);
  const currentChanges = changes(baseUnits, units(current));
  const proposedChanges = changes(baseUnits, units(proposed));
  const conflicts = [];
  const accepted = [];

  for (const proposedChange of proposedChanges) {
    const overlapping = currentChanges.filter((currentChange) => pathsOverlap(currentChange.path, proposedChange.path));
    const identical = overlapping.length === 1
      && overlapping[0].path === proposedChange.path
      && equal(overlapping[0].next, proposedChange.next);
    if (overlapping.length > 0 && !identical) {
      conflicts.push({
        path: proposedChange.path,
        baseValueHash: valueHash(proposedChange.base),
        currentValueHash: valueHash(valueAt(current, proposedChange.path)),
        proposedValueHash: valueHash(proposedChange.next),
      });
    } else if (!identical) {
      accepted.push(proposedChange);
    }
  }

  if (conflicts.length > 0) return { status: "conflicted", merged: null, conflicts };
  const merged = structuredClone(current);
  for (const change of accepted) applyUnit(merged, change.path, change.next);
  if (!Check(WorkflowRevisionSchema, merged)) throw mergeError("merged_workflow_revision_invalid");
  return { status: "merged", merged, conflicts: [] };
}

function units(revision) {
  const result = new Map();
  for (const node of revision.graph.nodes) {
    for (const [field, value] of Object.entries(node)) {
      if (field === "nodeId") continue;
      result.set(`/graph/nodes/${escapePath(node.nodeId)}/${escapePath(field)}`, structuredClone(value));
    }
  }
  for (const edge of revision.graph.edges) {
    result.set(`/graph/edges/${escapePath(edge.edgeId)}`, structuredClone(edge));
  }
  for (const resource of revision.resourceRefs) {
    result.set(`/resourceRefs/${escapePath(resource.resourceId)}`, structuredClone(resource));
  }
  for (const [field, value] of Object.entries(revision.runSettings)) {
    result.set(`/runSettings/${escapePath(field)}`, structuredClone(value));
  }
  for (const [field, value] of Object.entries(revision.definition ?? {})) {
    result.set(`/definition/${escapePath(field)}`, structuredClone(value));
  }
  return result;
}

function changes(base, next) {
  const paths = new Set([...base.keys(), ...next.keys()]);
  const raw = [...paths].filter((path) => !equal(base.get(path) ?? MISSING, next.get(path) ?? MISSING)).map((path) => ({
    path,
    base: base.has(path) ? base.get(path) : MISSING,
    next: next.has(path) ? next.get(path) : MISSING,
  }));
  return collapseNodeChanges(raw);
}

function collapseNodeChanges(raw) {
  const byNode = new Map();
  for (const change of raw) {
    const match = change.path.match(/^\/graph\/nodes\/([^/]+)\/([^/]+)$/);
    if (!match) continue;
    const key = match[1];
    const list = byNode.get(key) ?? [];
    list.push(change);
    byNode.set(key, list);
  }
  const output = raw.filter((change) => !change.path.startsWith("/graph/nodes/"));
  for (const [encodedNodeId, nodeChanges] of byNode) {
    const baseMissing = nodeChanges.every((change) => change.base === MISSING);
    const nextMissing = nodeChanges.every((change) => change.next === MISSING);
    if (baseMissing || nextMissing) {
      output.push({
        path: `/graph/nodes/${encodedNodeId}`,
        base: baseMissing ? MISSING : objectFromNodeChanges(encodedNodeId, nodeChanges, "base"),
        next: nextMissing ? MISSING : objectFromNodeChanges(encodedNodeId, nodeChanges, "next"),
      });
    } else {
      output.push(...nodeChanges);
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function objectFromNodeChanges(encodedNodeId, nodeChanges, side) {
  const node = { nodeId: unescapePath(encodedNodeId) };
  for (const change of nodeChanges) {
    if (change[side] !== MISSING) node[unescapePath(change.path.split("/").at(-1))] = structuredClone(change[side]);
  }
  return node;
}

function applyUnit(revision, path, value) {
  const parts = path.split("/").slice(1).map(unescapePath);
  if (parts[0] === "graph" && parts[1] === "nodes") {
    const nodeId = parts[2];
    const index = revision.graph.nodes.findIndex((node) => node.nodeId === nodeId);
    if (parts.length === 3) return setArrayItem(revision.graph.nodes, index, value);
    if (index < 0) throw mergeError("merge_node_missing", { path });
    return setField(revision.graph.nodes[index], parts[3], value);
  }
  if (parts[0] === "graph" && parts[1] === "edges") {
    const index = revision.graph.edges.findIndex((edge) => edge.edgeId === parts[2]);
    return setArrayItem(revision.graph.edges, index, value);
  }
  if (parts[0] === "resourceRefs") {
    const index = revision.resourceRefs.findIndex((resource) => resource.resourceId === parts[1]);
    return setArrayItem(revision.resourceRefs, index, value);
  }
  if (parts[0] === "definition") {
    revision.definition ??= {};
    return setField(revision.definition, parts[1], value);
  }
  if (parts[0] === "runSettings") return setField(revision.runSettings, parts[1], value);
  throw mergeError("merge_path_unsupported", { path });
}

function valueAt(revision, path) {
  const mapped = units(revision);
  if (mapped.has(path)) return mapped.get(path);
  const parts = path.split("/").slice(1).map(unescapePath);
  if (parts[0] === "graph" && parts[1] === "nodes" && parts.length === 3) {
    return revision.graph.nodes.find((node) => node.nodeId === parts[2]) ?? MISSING;
  }
  return MISSING;
}

function setArrayItem(array, index, value) {
  if (value === MISSING) {
    if (index >= 0) array.splice(index, 1);
  } else if (index >= 0) array[index] = structuredClone(value);
  else array.push(structuredClone(value));
}

function setField(target, field, value) {
  if (value === MISSING) delete target[field];
  else target[field] = structuredClone(value);
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
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

function mergeError(code, details = {}) {
  const error = new Error(code);
  error.code = "builder_proposal_invalid";
  error.details = details;
  return error;
}
