import {
  Check,
  LifecycleBuilderOperationSchema,
  WorkflowRevisionSchema,
} from "@turnsu/workbench-contracts";

function proposalError(message, details = {}) {
  const error = new Error(message);
  error.code = "builder_proposal_invalid";
  error.details = details;
  return error;
}

function findNode(nodes, nodeId, operation) {
  const index = nodes.findIndex((node) => node.nodeId === nodeId);
  if (index < 0) throw proposalError("A proposed change refers to a missing step.", { operation, nodeId });
  return index;
}

function ensureUnique(values, key, operation) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value[key])) throw proposalError("A proposed change creates a duplicate identifier.", { operation, id: value[key] });
    seen.add(value[key]);
  }
}

function ensureEdgeEndpoints(graph, edge, operation) {
  const source = graph.nodes.find((node) => node.nodeId === edge.sourceNodeId);
  const target = graph.nodes.find((node) => node.nodeId === edge.targetNodeId);
  if (!source || !target || source.nodeId === target.nodeId) {
    throw proposalError("A proposed connection has invalid endpoints.", { operation, edgeId: edge.edgeId });
  }
  if (!source.outputPorts.some((port) => port.portId === edge.sourcePort)) {
    throw proposalError("A proposed connection uses a missing output.", { operation, edgeId: edge.edgeId });
  }
  if (!target.inputPorts.some((port) => port.portId === edge.targetPort)) {
    throw proposalError("A proposed connection uses a missing input.", { operation, edgeId: edge.edgeId });
  }
}

export function applyBuilderOperations(baseRevision, operations) {
  if (!Check(WorkflowRevisionSchema, baseRevision)) throw proposalError("The base workflow version is invalid.");
  if (!Array.isArray(operations)) throw proposalError("Proposed changes must be an array.");
  const next = structuredClone(baseRevision);

  for (const operation of operations) {
    if (!Check(LifecycleBuilderOperationSchema, operation)) {
      throw proposalError("A proposed change does not match the supported operation format.");
    }
    switch (operation.op) {
      case "addNode": {
        if (next.graph.nodes.some((node) => node.nodeId === operation.node.nodeId)) {
          throw proposalError("A proposed step identifier already exists.", { nodeId: operation.node.nodeId });
        }
        next.graph.nodes.push(structuredClone(operation.node));
        break;
      }
      case "removeNode": {
        const index = findNode(next.graph.nodes, operation.nodeId, operation.op);
        next.graph.nodes.splice(index, 1);
        next.graph.edges = next.graph.edges.filter((edge) => edge.sourceNodeId !== operation.nodeId && edge.targetNodeId !== operation.nodeId);
        break;
      }
      case "updateNode": {
        const index = findNode(next.graph.nodes, operation.nodeId, operation.op);
        if (operation.node.nodeId !== operation.nodeId) {
          throw proposalError("A step update cannot change the step identifier.", { nodeId: operation.nodeId });
        }
        next.graph.nodes[index] = structuredClone(operation.node);
        break;
      }
      case "connectNodes": {
        if (next.graph.edges.some((edge) => edge.edgeId === operation.edge.edgeId)) {
          throw proposalError("A proposed connection identifier already exists.", { edgeId: operation.edge.edgeId });
        }
        ensureEdgeEndpoints(next.graph, operation.edge, operation.op);
        next.graph.edges.push(structuredClone(operation.edge));
        break;
      }
      case "disconnectNodes": {
        const index = next.graph.edges.findIndex((edge) => edge.edgeId === operation.edgeId);
        if (index < 0) throw proposalError("A proposed change refers to a missing connection.", { edgeId: operation.edgeId });
        next.graph.edges.splice(index, 1);
        break;
      }
      case "updateWorkflowSettings":
        next.runSettings = structuredClone(operation.runSettings);
        break;
      case "attachResource": {
        const index = next.resourceRefs.findIndex((resource) => resource.resourceId === operation.resourceRef.resourceId);
        if (index >= 0) next.resourceRefs[index] = structuredClone(operation.resourceRef);
        else next.resourceRefs.push(structuredClone(operation.resourceRef));
        break;
      }
      case "detachResource": {
        const previousLength = next.resourceRefs.length;
        next.resourceRefs = next.resourceRefs.filter((resource) => resource.resourceId !== operation.resourceId);
        if (next.resourceRefs.length === previousLength) throw proposalError("A proposed change refers to missing reference material.", { resourceId: operation.resourceId });
        break;
      }
      case "updateDefinition":
        next.definition = structuredClone(operation.definition);
        break;
      case "pinSkillVersion": {
        const matches = next.graph.nodes.filter((node) => node.kind === "Skill" && node.skillRef?.skillId === operation.skill.skillId);
        if (!matches.length) throw proposalError("A proposed Skill version does not match any workflow step.", { skillId: operation.skill.skillId });
        for (const node of matches) node.skillRef = structuredClone(operation.skill);
        break;
      }
      case "unpinSkillVersion":
        throw proposalError("Executable Skill steps must keep an exact version.", { skillId: operation.skillId });
      default:
        throw proposalError("Unsupported proposed change.");
    }
  }

  ensureUnique(next.graph.nodes, "nodeId", "graph");
  ensureUnique(next.graph.edges, "edgeId", "graph");
  for (const edge of next.graph.edges) ensureEdgeEndpoints(next.graph, edge, "graph");
  if (!Check(WorkflowRevisionSchema, next)) throw proposalError("The proposed workflow does not match the saved workflow format.");
  return next;
}
