import {
  Check,
  Errors,
  EXECUTION_PLAN_V2_SCHEMA_VERSION,
  SkillDefinitionSchema,
  UtcTimestampSchema,
  WORKBENCH_SCHEMA_VERSION,
  WorkflowRevisionSchema,
} from "@looloomi/workbench-contracts";

import {
  compareCanonical,
  deepFreeze,
  sha256Canonical,
} from "./canonical.mjs";
import {
  buildDependencyGraph,
  invalidCycles,
  kahnByStableLayers,
  reachableNodeIds,
} from "./graph-algorithms.mjs";
import {
  isSchemaAssignable,
  parseMappingExpression,
  schemaAtMapping,
} from "./schema-compatibility.mjs";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const compareId = compareText;

const safeId = (value, fallback) =>
  typeof value === "string" &&
  value.length <= 128 &&
  STABLE_ID.test(value)
    ? value
    : fallback;

const clone = (value) => structuredClone(value);

const skillKey = (reference) => `${reference.skillId}\u0000${reference.version}`;

const nodeResultSchema = (node) => ({
  type: "object",
  properties: Object.fromEntries(
    node.outputPorts.map((port) => [port.portId, clone(port.schema)]),
  ),
  required: node.outputPorts.filter((port) => port.required).map((port) => port.portId),
  additionalProperties: false,
});

const executionModeFor = (node, resolvedSkill) => {
  if (node.kind !== "Skill") return "deterministic_skill";
  if (resolvedSkill?.definition?.executionRef?.executionMode === "orchestrator") {
    return "agent_orchestrator";
  }
  if (resolvedSkill?.definition?.executionRef?.executionMode === "agent") {
    return "bounded_agent";
  }
  return "deterministic_skill";
};

const executionPolicyFor = (node, resolvedSkill) => {
  const executionMode = executionModeFor(node, resolvedSkill);
  const agentic = executionMode !== "deterministic_skill";
  const orchestrator = executionMode === "agent_orchestrator";
  const dependencies = resolvedSkill?.definition?.dependencies ?? [];
  return {
    executionMode,
    isolation: agentic ? "container" : "process",
    limits: {
      timeoutMs: node.timeoutSeconds * 1000,
      maxSteps: agentic ? (orchestrator ? 128 : 32) : 1,
      maxModelRequests: agentic ? (orchestrator ? 64 : 16) : 0,
      maxChildren: orchestrator ? 16 : 0,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: dependencies
        .filter((entry) => entry.kind === "connection" && entry.required)
        .map((entry) => entry.id)
        .sort(compareId),
      network: false,
      filesystem: "none",
      externalActions: resolvedSkill?.definition?.risk?.externalAction === true,
    },
    resultSchema: nodeResultSchema(node),
    evidenceRequirements: [{
      requirementId: `output:${node.nodeId}`,
      kind: "output",
      required: true,
      description: `Return a contract-valid result for ${node.title}.`,
    }],
  };
};

const duplicateValues = (values) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort(compareId);
};

const targetKey = (nodeId, portId) => `${nodeId}\u0000${portId}`;
const edgeBindingKey = (edge) =>
  [
    edge.sourceNodeId,
    edge.sourcePort,
    edge.targetNodeId,
    edge.targetPort,
  ].join("\u0000");

const diagnostic = ({ code, message, nodeId, field, recoveryAction }) => ({
  code,
  message: message.slice(0, 4000),
  severity: "error",
  ...(nodeId === undefined ? {} : { nodeId }),
  ...(field === undefined ? {} : { field: field.slice(0, 256) }),
  ...(recoveryAction === undefined
    ? {}
    : { recoveryAction: recoveryAction.slice(0, 1000) }),
});

const compareDiagnostic = (left, right) =>
  compareText(
    [left.code, left.nodeId ?? "", left.field ?? "", left.message].join(
      "\u0000",
    ),
    [right.code, right.nodeId ?? "", right.field ?? "", right.message].join(
      "\u0000",
    ),
  );

const makeResultBase = (revision, compiledAt) => ({
  schemaVersion: WORKBENCH_SCHEMA_VERSION,
  workflowId: safeId(revision?.workflowId, "workflow-invalid"),
  workflowRevisionId: safeId(revision?.revisionId, "revision-invalid"),
  orderedSteps: [],
  requiredRunInputs: [],
  missingBindings: [],
  missingResources: [],
  unavailableSkills: [],
  orphanNodeIds: [],
  unreachableNodeIds: [],
  invalidCycles: [],
  portSchemaMismatches: [],
  reviewGates: [],
  outputNodes: [],
  warnings: [],
  recoveryActions: [],
  compiledAt,
});

const finish = (result, status, diagnostics, executionPlan) => ({
  ...result,
  status,
  warnings: [...diagnostics].sort(compareDiagnostic),
  ...(executionPlan === undefined ? {} : { executionPlan }),
});

const nodeIdFromSchemaError = (revision, instancePath) => {
  const match = /^\/graph\/nodes\/([0-9]+)/.exec(instancePath);
  if (!match) {
    return undefined;
  }
  const nodeId = revision?.graph?.nodes?.[Number(match[1])]?.nodeId;
  return safeId(nodeId, undefined);
};

const schemaDiagnostics = (revision) =>
  Errors(WorkflowRevisionSchema, revision).map((error) => {
    const field = error.instancePath || "$";
    return diagnostic({
      code: "revision_schema_invalid",
      message: `${field}: ${error.message}`,
      nodeId: nodeIdFromSchemaError(revision, error.instancePath),
      field,
      recoveryAction: "Fix the saved Workflow revision and compile it again.",
    });
  });

const portById = (node, direction, portId) =>
  node[direction].find((port) => port.portId === portId);

const canonicalNode = (node) => {
  const normalized = clone(node);
  delete normalized.position;
  delete normalized.display;
  normalized.inputPorts.sort((left, right) =>
    compareId(left.portId, right.portId),
  );
  normalized.outputPorts.sort((left, right) =>
    compareId(left.portId, right.portId),
  );
  normalized.inputBindings.sort(compareCanonical);
  if (Array.isArray(normalized.configuration?.fieldIds)) {
    normalized.configuration.fieldIds.sort(compareId);
  }
  if (Array.isArray(normalized.configuration?.resourceIds)) {
    normalized.configuration.resourceIds.sort(compareId);
  }
  return normalized;
};

const canonicalSkillSnapshot = (resolved) => ({
  skillId: resolved.definition.skillId,
  version: resolved.definition.version,
  status: resolved.definition.status,
  executionRef: clone(resolved.definition.executionRef),
  readiness: {
    ...clone(resolved.definition.readiness),
    diagnostics: [...resolved.definition.readiness.diagnostics].sort(
      compareCanonical,
    ),
  },
  adapterReadiness: {
    status: resolved.adapterReadiness.status,
  },
  piReadiness: {
    status: resolved.piReadiness.status,
  },
});

const canonicalHashPayload = ({
  revision,
  orderedSteps,
  steps,
  pinnedSkills,
  reviewGates,
  resolvedSkills,
  resolvedResources,
}) => ({
  schemaVersion: "workbench-compiler-content-v1",
  workflowId: revision.workflowId,
  workflowRevisionId: revision.revisionId,
  graph: {
    nodes: revision.graph.nodes
      .map(canonicalNode)
      .sort((left, right) => compareId(left.nodeId, right.nodeId)),
    edges: revision.graph.edges.map(clone).sort(compareCanonical),
  },
  inputForm: {
    fields: revision.inputForm.fields.map(clone).sort((left, right) =>
      compareId(left.fieldId, right.fieldId),
    ),
  },
  outputDefinition: {
    primary: clone(revision.outputDefinition.primary),
    expectedOutputs: revision.outputDefinition.expectedOutputs
      .map(clone)
      .sort(compareCanonical),
  },
  resourceRefs: revision.resourceRefs.map(clone).sort(compareCanonical),
  runSettings: clone(revision.runSettings),
  resolvedSkills: resolvedSkills
    .map(canonicalSkillSnapshot)
    .sort(compareCanonical),
  resolvedResources: resolvedResources.map(clone).sort(compareCanonical),
  execution: {
    maxParallelism: 1,
    orderedSteps,
    pinnedSkills,
    steps,
    reviewGates,
    primaryOutput: clone(revision.outputDefinition.primary),
  },
});

const validateTimestamp = (options) => {
  if (!options || !Check(UtcTimestampSchema, options.compiledAt)) {
    throw new TypeError("compileWorkflowV1 requires a valid compiledAt timestamp.");
  }
};

const validateResolver = (options) => {
  if (
    !options.resolver ||
    typeof options.resolver.resolveSkill !== "function" ||
    typeof options.resolver.resolveResource !== "function"
  ) {
    throw new TypeError(
      "compileWorkflowV1 requires resolveSkill and resolveResource functions.",
    );
  }
};

/**
 * Compile one immutable WorkflowRevision using synchronous, injected readiness snapshots.
 * The function performs no I/O and does not read UI-provided readiness fields.
 */
export function compileWorkflowV1(revision, options) {
  validateTimestamp(options);
  const result = makeResultBase(revision, options.compiledAt);

  if (!Check(WorkflowRevisionSchema, revision)) {
    return finish(result, "invalid", schemaDiagnostics(revision));
  }
  validateResolver(options);

  const invalidDiagnostics = [];
  const blockedDiagnostics = [];
  const nonBlockingDiagnostics = [];
  const addInvalid = (value) => invalidDiagnostics.push(diagnostic(value));
  const addBlocked = (value) => blockedDiagnostics.push(diagnostic(value));

  const nodes = revision.graph.nodes;
  const edges = revision.graph.edges;

  for (const nodeId of duplicateValues(nodes.map((node) => node.nodeId))) {
    addInvalid({
      code: "duplicate_node_id",
      message: `Node ID ${nodeId} is duplicated.`,
      nodeId,
      field: "graph.nodes",
    });
  }
  for (const edgeId of duplicateValues(edges.map((edge) => edge.edgeId))) {
    const edge = edges.find((candidate) => candidate.edgeId === edgeId);
    addInvalid({
      code: "duplicate_edge_id",
      message: `Edge ID ${edgeId} is duplicated.`,
      nodeId: edge?.targetNodeId,
      field: "graph.edges",
    });
  }
  for (const node of nodes) {
    for (const direction of ["inputPorts", "outputPorts"]) {
      const duplicatePortIds = duplicateValues(
        node[direction].map((port) => port.portId),
      );
      for (const portId of duplicatePortIds) {
        addInvalid({
          code: "duplicate_port_id",
          message: `Port ID ${portId} is duplicated in ${direction} on node ${node.nodeId}.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.${direction}`,
        });
      }
    }
  }
  for (const fieldId of duplicateValues(
    revision.inputForm.fields.map((field) => field.fieldId),
  )) {
    addInvalid({
      code: "duplicate_input_field_id",
      message: `Input field ID ${fieldId} is duplicated.`,
      field: "inputForm.fields",
    });
  }
  for (const resourceId of duplicateValues(
    revision.resourceRefs.map((resourceRef) => resourceRef.resourceId),
  )) {
    addInvalid({
      code: "duplicate_resource_id",
      message: `Resource ID ${resourceId} is duplicated.`,
      field: "resourceRefs",
    });
  }

  const nodeById = new Map();
  for (const node of nodes) {
    if (!nodeById.has(node.nodeId)) {
      nodeById.set(node.nodeId, node);
    }
  }
  const uniqueNodeIds = [...nodeById.keys()].sort(compareId);
  const fieldById = new Map();
  for (const field of revision.inputForm.fields) {
    if (!fieldById.has(field.fieldId)) {
      fieldById.set(field.fieldId, field);
    }
  }
  const resourceRefById = new Map();
  for (const resourceRef of revision.resourceRefs) {
    if (!resourceRefById.has(resourceRef.resourceId)) {
      resourceRefById.set(resourceRef.resourceId, resourceRef);
    }
  }

  const inputNodes = nodes.filter((node) => node.kind === "Input");
  const outputNodes = nodes.filter((node) => node.kind === "Output");
  result.outputNodes = [...new Set(outputNodes.map((node) => node.nodeId))].sort(
    compareId,
  );
  result.reviewGates = [
    ...new Set(
      nodes
        .filter((node) => node.kind === "ReviewGate")
        .map((node) => node.nodeId),
    ),
  ].sort(compareId);

  if (inputNodes.length === 0) {
    addInvalid({
      code: "input_node_required",
      message: "The Workflow must contain at least one Input node.",
      field: "graph.nodes",
    });
  }
  if (outputNodes.length === 0) {
    addInvalid({
      code: "output_node_required",
      message: "The Workflow must contain at least one Output node.",
      field: "graph.nodes",
    });
  }

  const usedInputFieldIds = new Set();
  for (const node of inputNodes) {
    for (const fieldId of node.configuration.fieldIds) {
      const field = fieldById.get(fieldId);
      const outputPort = portById(node, "outputPorts", fieldId);
      if (!field) {
        addInvalid({
          code: "input_field_not_found",
          message: `Input field ${fieldId} does not exist.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.configuration.fieldIds`,
        });
        continue;
      }
      usedInputFieldIds.add(fieldId);
      if (!outputPort) {
        addInvalid({
          code: "input_output_port_not_found",
          message: `Input node ${node.nodeId} has no output port for field ${fieldId}.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.outputPorts`,
        });
        continue;
      }
      if (
        !isSchemaAssignable(field.schema, outputPort.schema) ||
        !isSchemaAssignable(outputPort.schema, field.schema)
      ) {
        addInvalid({
          code: "input_field_schema_mismatch",
          message: `Input field ${fieldId} and its output port have incompatible schemas.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.outputPorts.${fieldId}`,
        });
      }
    }
  }
  result.requiredRunInputs = [...usedInputFieldIds]
    .sort(compareId)
    .map((fieldId) => {
      const field = fieldById.get(fieldId);
      return {
        inputKey: field.fieldId,
        label: field.label,
        schema: clone(field.schema),
        required: field.required,
      };
    });

  for (const node of nodes) {
    if (node.kind === "Material") {
      for (const resourceId of node.configuration.resourceIds) {
        if (!resourceRefById.has(resourceId)) {
          addInvalid({
            code: "resource_ref_not_found",
            message: `Resource ${resourceId} is not attached to the revision.`,
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.configuration.resourceIds`,
          });
        }
      }
    }
    if (node.kind === "Transform") {
      if (node.configuration.mode === "boundedAgent") {
        addBlocked({
          code: "bounded_agent_transform_not_ready",
          message: "Bounded agent Transform execution is not ready in compiler v1.",
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.configuration.mode`,
        });
      } else if (
        parseMappingExpression(node.configuration.expression) === null
      ) {
        addInvalid({
          code: "invalid_mapping_expression",
          message: "Only identity and RFC 6901 JSON Pointer mappings are supported.",
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.configuration.expression`,
        });
      }
    }
    if (node.condition !== undefined) {
      addInvalid({
        code: "node_condition_not_supported",
        message: "Conditional execution is not represented by ExecutionPlanV1.",
        nodeId: node.nodeId,
        field: `graph.nodes.${node.nodeId}.condition`,
      });
    }
  }

  const dependencyEdges = [];
  const edgeClaimsByTarget = new Map();
  const edgesByBinding = new Map();
  const mismatchKeys = new Set();

  const addPortMismatch = ({ edge, message }) => {
    const key = edgeBindingKey(edge);
    if (mismatchKeys.has(key)) {
      return;
    }
    mismatchKeys.add(key);
    result.portSchemaMismatches.push({
      sourceNodeId: edge.sourceNodeId,
      sourcePort: edge.sourcePort,
      targetNodeId: edge.targetNodeId,
      targetPort: edge.targetPort,
      message,
    });
    addInvalid({
      code: "port_schema_mismatch",
      message,
      nodeId: edge.targetNodeId,
      field: `graph.edges.${edge.edgeId}`,
    });
  };

  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.sourceNodeId);
    const targetNode = nodeById.get(edge.targetNodeId);
    if (!sourceNode || !targetNode) {
      addInvalid({
        code: "edge_node_not_found",
        message: `Edge ${edge.edgeId} references a missing node.`,
        nodeId: targetNode?.nodeId ?? sourceNode?.nodeId,
        field: `graph.edges.${edge.edgeId}`,
      });
      continue;
    }

    dependencyEdges.push(edge);
    const sourcePort = portById(sourceNode, "outputPorts", edge.sourcePort);
    const targetPort = portById(targetNode, "inputPorts", edge.targetPort);
    if (!sourcePort || !targetPort) {
      addInvalid({
        code: "edge_port_not_found",
        message: `Edge ${edge.edgeId} references a missing source or target port.`,
        nodeId: targetNode.nodeId,
        field: `graph.edges.${edge.edgeId}`,
      });
      continue;
    }

    const target = targetKey(edge.targetNodeId, edge.targetPort);
    const targetClaims = edgeClaimsByTarget.get(target) ?? [];
    targetClaims.push(edge);
    edgeClaimsByTarget.set(target, targetClaims);

    const binding = edgeBindingKey(edge);
    const matchingEdges = edgesByBinding.get(binding) ?? [];
    matchingEdges.push(edge);
    edgesByBinding.set(binding, matchingEdges);

    const mapping = parseMappingExpression(edge.mappingExpression);
    if (mapping === null) {
      addInvalid({
        code: "invalid_mapping_expression",
        message: "Only identity and RFC 6901 JSON Pointer mappings are supported.",
        nodeId: targetNode.nodeId,
        field: `graph.edges.${edge.edgeId}.mappingExpression`,
      });
      continue;
    }

    const mappedSchema = schemaAtMapping(sourcePort.schema, mapping);
    if (mappedSchema === null) {
      addInvalid({
        code: "mapping_pointer_not_found",
        message: `Mapping ${mapping.expression} does not resolve in the source schema.`,
        nodeId: targetNode.nodeId,
        field: `graph.edges.${edge.edgeId}.mappingExpression`,
      });
      continue;
    }
    if (!isSchemaAssignable(mappedSchema, targetPort.schema)) {
      addPortMismatch({
        edge,
        message: "Source schema is not assignable to the target schema.",
      });
    }
  }

  const ambiguousTargets = new Set();
  const addAmbiguous = (node, portId) => {
    const key = targetKey(node.nodeId, portId);
    if (ambiguousTargets.has(key)) {
      return;
    }
    ambiguousTargets.add(key);
    addInvalid({
      code: "ambiguous_target_binding",
      message: `Target port ${portId} has more than one binding source.`,
      nodeId: node.nodeId,
      field: `graph.nodes.${node.nodeId}.inputBindings`,
    });
  };

  for (const node of nodes) {
    const bindingsByPort = new Map();
    for (const binding of node.inputBindings) {
      const targetPort = portById(node, "inputPorts", binding.targetPort);
      if (!targetPort) {
        addInvalid({
          code: "binding_target_port_not_found",
          message: `Binding target port ${binding.targetPort} does not exist.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.inputBindings`,
        });
        continue;
      }
      const portBindings = bindingsByPort.get(binding.targetPort) ?? [];
      portBindings.push(binding);
      bindingsByPort.set(binding.targetPort, portBindings);

      const source = binding.source;
      if (source.kind === "nodeOutput") {
        const sourceNode = nodeById.get(source.nodeId);
        if (!sourceNode) {
          addInvalid({
            code: "binding_node_not_found",
            message: `Binding references missing node ${source.nodeId}.`,
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.inputBindings`,
          });
          continue;
        }
        if (!portById(sourceNode, "outputPorts", source.portId)) {
          addInvalid({
            code: "binding_port_not_found",
            message: `Binding references missing output port ${source.portId}.`,
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.inputBindings`,
          });
          continue;
        }
        const key = [
          source.nodeId,
          source.portId,
          node.nodeId,
          binding.targetPort,
        ].join("\u0000");
        if (!edgesByBinding.has(key)) {
          addInvalid({
            code: "binding_edge_missing",
            message: "A nodeOutput binding must have one matching explicit edge.",
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.inputBindings`,
          });
        }
      } else if (source.kind === "runInput") {
        const field = fieldById.get(source.inputKey);
        if (!field) {
          addInvalid({
            code: "run_input_not_found",
            message: `Run input ${source.inputKey} does not exist.`,
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.inputBindings`,
          });
        } else if (!isSchemaAssignable(field.schema, targetPort.schema)) {
          addInvalid({
            code: "run_input_schema_mismatch",
            message: "Run input schema is not assignable to the target schema.",
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.inputBindings`,
          });
        }
      } else if (source.kind === "literal") {
        if (!Check(targetPort.schema, source.value)) {
          addInvalid({
            code: "literal_schema_mismatch",
            message: "Literal binding does not satisfy the target schema.",
            nodeId: node.nodeId,
            field: `graph.nodes.${node.nodeId}.inputBindings`,
          });
        }
      } else if (!resourceRefById.has(source.resourceId)) {
        addInvalid({
          code: "resource_ref_not_found",
          message: `Resource ${source.resourceId} is not attached to the revision.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.inputBindings`,
        });
      }
    }

    for (const inputPort of node.inputPorts) {
      const explicitBindings = bindingsByPort.get(inputPort.portId) ?? [];
      const targetEdges =
        edgeClaimsByTarget.get(targetKey(node.nodeId, inputPort.portId)) ?? [];

      if (inputPort.required && explicitBindings.length === 0) {
        result.missingBindings.push({
          nodeId: node.nodeId,
          targetPort: inputPort.portId,
          message: "Required target port has no explicit input binding.",
        });
        addInvalid({
          code: "required_binding_missing",
          message: `Required target port ${inputPort.portId} is not bound.`,
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.inputBindings`,
        });
      }

      let ambiguous = explicitBindings.length > 1 || targetEdges.length > 1;
      if (explicitBindings.length === 1 && targetEdges.length === 1) {
        const source = explicitBindings[0].source;
        ambiguous =
          source.kind !== "nodeOutput" ||
          source.nodeId !== targetEdges[0].sourceNodeId ||
          source.portId !== targetEdges[0].sourcePort;
      }
      if (ambiguous) {
        addAmbiguous(node, inputPort.portId);
      }
    }
  }

  for (const edge of edges) {
    const targetNode = nodeById.get(edge.targetNodeId);
    if (!targetNode || !portById(targetNode, "inputPorts", edge.targetPort)) {
      continue;
    }
    const hasMatchingBinding = targetNode.inputBindings.some(
      (binding) =>
        binding.targetPort === edge.targetPort &&
        binding.source.kind === "nodeOutput" &&
        binding.source.nodeId === edge.sourceNodeId &&
        binding.source.portId === edge.sourcePort,
    );
    if (!hasMatchingBinding) {
      addInvalid({
        code: "edge_binding_missing",
        message: "An edge must have one matching explicit nodeOutput binding.",
        nodeId: targetNode.nodeId,
        field: `graph.edges.${edge.edgeId}`,
      });
    }
  }

  const primary = revision.outputDefinition.primary;
  const primaryNode = nodeById.get(primary.nodeId);
  if (
    !primaryNode ||
    primaryNode.kind !== "Output" ||
    !portById(primaryNode, "outputPorts", primary.portId)
  ) {
    addInvalid({
      code: "primary_output_invalid",
      message: "Primary output must reference a real Output node output port.",
      nodeId: primaryNode?.nodeId,
      field: "outputDefinition.primary",
    });
  }
  for (const expectedOutput of revision.outputDefinition.expectedOutputs) {
    const outputNode = nodeById.get(expectedOutput.nodeId);
    if (
      !outputNode ||
      outputNode.kind !== "Output" ||
      !portById(outputNode, "outputPorts", expectedOutput.portId)
    ) {
      addInvalid({
        code: "expected_output_invalid",
        message: "Expected output must reference a real Output node output port.",
        nodeId: outputNode?.nodeId,
        field: "outputDefinition.expectedOutputs",
      });
    }
  }

  const { adjacency, predecessors } = buildDependencyGraph(
    uniqueNodeIds,
    dependencyEdges,
  );
  const orderedSteps = kahnByStableLayers(
    uniqueNodeIds,
    adjacency,
    predecessors,
  );
  result.orderedSteps = orderedSteps;
  result.invalidCycles = invalidCycles(uniqueNodeIds, adjacency);
  for (const cycle of result.invalidCycles) {
    addInvalid({
      code: "workflow_cycle",
      message: `Workflow contains a cycle: ${cycle.nodeIds.join(", ")}.`,
      nodeId: cycle.nodeIds[0],
      field: "graph.edges",
    });
  }

  const reachable = reachableNodeIds(
    inputNodes.map((node) => node.nodeId),
    adjacency,
  );
  result.unreachableNodeIds = uniqueNodeIds
    .filter((nodeId) => !reachable.has(nodeId))
    .sort(compareId);
  result.orphanNodeIds = uniqueNodeIds
    .filter(
      (nodeId) =>
        adjacency.get(nodeId).size === 0 && predecessors.get(nodeId).size === 0,
    )
    .sort(compareId);
  for (const nodeId of result.unreachableNodeIds) {
    const node = nodeById.get(nodeId);
    addInvalid({
      code: node.kind === "Output" ? "output_unreachable" : "node_unreachable",
      message:
        node.kind === "Output"
          ? "Output node is not reachable from an Input node."
          : "Node is not reachable from an Input node.",
      nodeId,
      field: `graph.nodes.${nodeId}`,
    });
  }

  if (invalidDiagnostics.length > 0) {
    return finish(result, "invalid", [
      ...invalidDiagnostics,
      ...blockedDiagnostics,
    ]);
  }

  const resolvedSkills = [];
  for (const node of [...nodes]
    .filter((candidate) => candidate.kind === "Skill")
    .sort((left, right) => compareId(left.nodeId, right.nodeId))) {
    let resolved;
    try {
      resolved = options.resolver.resolveSkill(clone(node.skillRef));
    } catch {
      resolved = null;
    }

    const reasons = [];
    if (!resolved || !Check(SkillDefinitionSchema, resolved.definition)) {
      reasons.push("The pinned SkillDefinition did not resolve to a valid definition.");
      addBlocked({
        code: "skill_not_ready",
        message: reasons.at(-1),
        nodeId: node.nodeId,
        field: `graph.nodes.${node.nodeId}.skillRef`,
      });
    } else if (
      resolved.definition.skillId !== node.skillRef.skillId ||
      resolved.definition.version !== node.skillRef.version
    ) {
      reasons.push("The resolver did not return the exact pinned Skill version.");
      addBlocked({
        code: "skill_version_not_available",
        message: reasons.at(-1),
        nodeId: node.nodeId,
        field: `graph.nodes.${node.nodeId}.skillRef`,
      });
    } else {
      if (
        resolved.definition.status !== "ready" ||
        resolved.definition.readiness.status !== "ready" ||
        resolved.definition.readiness.diagnostics.some(
          (entry) => entry.severity === "error",
        )
      ) {
        reasons.push("The pinned Skill is not ready.");
        addBlocked({
          code: "skill_not_ready",
          message: reasons.at(-1),
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.skillRef`,
        });
      }
      if (resolved.adapterReadiness?.status !== "ready") {
        reasons.push(
          resolved.adapterReadiness?.reason ?? "The Skill adapter is not ready.",
        );
        addBlocked({
          code: "skill_adapter_not_ready",
          message: reasons.at(-1),
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.skillRef`,
        });
      }
      if (resolved.piReadiness?.status !== "ready") {
        reasons.push(resolved.piReadiness?.reason ?? "PI is not ready.");
        addBlocked({
          code: "pi_not_ready",
          message: reasons.at(-1),
          nodeId: node.nodeId,
          field: `graph.nodes.${node.nodeId}.skillRef`,
        });
      }
      for (const entry of resolved.definition.readiness.diagnostics) {
        if (entry.severity !== "error") {
          nonBlockingDiagnostics.push({
            ...clone(entry),
            nodeId: entry.nodeId ?? node.nodeId,
          });
        }
      }
      resolvedSkills.push(resolved);
    }

    if (reasons.length > 0) {
      result.unavailableSkills.push({
        skillRef: clone(node.skillRef),
        reason: reasons.join(" ").slice(0, 1000),
        nodeId: node.nodeId,
      });
    }
  }

  const resourceUsage = new Map();
  for (const node of nodes) {
    const resourceIds = [];
    if (node.kind === "Material") {
      resourceIds.push(...node.configuration.resourceIds);
    }
    for (const binding of node.inputBindings) {
      if (binding.source.kind === "resource") {
        resourceIds.push(binding.source.resourceId);
      }
    }
    for (const resourceId of resourceIds) {
      const nodeIds = resourceUsage.get(resourceId) ?? new Set();
      nodeIds.add(node.nodeId);
      resourceUsage.set(resourceId, nodeIds);
    }
  }

  const resolvedResources = [];
  for (const resourceRef of [...revision.resourceRefs].sort(compareCanonical)) {
    let resolved;
    try {
      resolved = options.resolver.resolveResource(clone(resourceRef));
    } catch {
      resolved = null;
    }
    const usageNodeId = resourceUsage.has(resourceRef.resourceId)
      ? [...resourceUsage.get(resourceRef.resourceId)].sort(compareId)[0]
      : undefined;
    if (resolved?.readiness?.status !== "ready") {
      result.missingResources.push({
        resourceId: resourceRef.resourceId,
        label: resourceRef.label,
        ...(usageNodeId === undefined ? {} : { nodeId: usageNodeId }),
      });
      addBlocked({
        code: "resource_not_ready",
        message:
          resolved?.readiness?.reason ?? "The attached Resource is not ready.",
        nodeId: usageNodeId,
        field: "resourceRefs",
      });
    } else {
      resolvedResources.push({
        resourceRef: clone(resourceRef),
        readiness: { status: "ready" },
      });
    }
  }

  result.unavailableSkills.sort((left, right) =>
    compareId(left.nodeId ?? "", right.nodeId ?? ""),
  );
  result.missingResources.sort((left, right) =>
    compareId(left.resourceId, right.resourceId),
  );

  if (blockedDiagnostics.length > 0) {
    return finish(result, "blocked", [
      ...blockedDiagnostics,
      ...nonBlockingDiagnostics,
    ]);
  }

  result.reviewGates = orderedSteps.filter(
    (nodeId) => nodeById.get(nodeId).kind === "ReviewGate",
  );
  result.outputNodes = orderedSteps.filter(
    (nodeId) => nodeById.get(nodeId).kind === "Output",
  );

  const pinnedSkills = [
    ...new Map(
      nodes
        .filter((node) => node.kind === "Skill")
        .map((node) => [
          `${node.skillRef.skillId}\u0000${node.skillRef.version}`,
          clone(node.skillRef),
        ]),
    ).values(),
  ].sort((left, right) =>
    compareText(
      `${left.skillId}\u0000${left.version}`,
      `${right.skillId}\u0000${right.version}`,
    ),
  );

  const steps = orderedSteps.map((nodeId) => {
    const node = nodeById.get(nodeId);
    const resolvedSkill = node.kind === "Skill"
      ? resolvedSkills.find((entry) => skillKey(entry.definition) === skillKey(node.skillRef))
      : null;
    return {
      nodeId,
      kind: node.kind,
      ...(node.kind === "Skill" ? { skillRef: clone(node.skillRef) } : {}),
      dependsOn: [...predecessors.get(nodeId)].sort(compareId),
      inputBindings: node.inputBindings.map(clone).sort(compareCanonical),
      ...executionPolicyFor(node, resolvedSkill),
    };
  });
  const reviewGates = result.reviewGates.map((nodeId) => {
    const node = nodeById.get(nodeId);
    return {
      nodeId,
      dependsOn: [...predecessors.get(nodeId)].sort(compareId),
      instructions:
        node.reviewPolicy.instructions ?? node.configuration.instructions,
    };
  });

  const contentHash = sha256Canonical(
    canonicalHashPayload({
      revision,
      orderedSteps,
      steps,
      pinnedSkills,
      reviewGates,
      resolvedSkills,
      resolvedResources,
    }),
  );
  const executionPlan = deepFreeze({
    schemaVersion: EXECUTION_PLAN_V2_SCHEMA_VERSION,
    planVersion: "2",
    workflowId: revision.workflowId,
    workflowRevisionId: revision.revisionId,
    generatedAt: options.compiledAt,
    contentHash,
    maxParallelism: 1,
    pinnedSkills,
    steps,
    reviewGates,
    primaryOutput: clone(revision.outputDefinition.primary),
  });

  return finish(result, "ready", nonBlockingDiagnostics, executionPlan);
}
