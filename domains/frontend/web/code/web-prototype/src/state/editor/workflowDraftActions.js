const clone = (value) => structuredClone(value);
const stringSchema = () => ({ type: "string", minLength: 1 });
const PORT_SCHEMA_KEYS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "additionalProperties",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "format",
]);

// Skills may retain richer JSON Schema internally. A Workflow port is a stable
// public contract and only accepts the v1 DataSchema subset.
export function workflowPortSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return stringSchema();
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => PORT_SCHEMA_KEYS.has(key))
      .map(([key, value]) => [key, clone(value)]),
  );
}

function portEntries(schema, direction) {
  const required = new Set(schema?.required || []);
  return Object.entries(schema?.properties || {}).map(([portId, value]) => ({
    portId,
    name: value?.title || portId,
    schema: workflowPortSchema(value),
    required: direction === "output" || required.has(portId),
  }));
}

function nodeBase({ nodeId, kind, title, description, position }) {
  return {
    nodeId,
    kind,
    title,
    description,
    position: position || { x: 160, y: 160 },
    inputPorts: [],
    outputPorts: [],
    inputBindings: [],
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 300,
    display: { collapsed: false },
  };
}

export function addSkillToDraft(draft, skill, position, idFactory) {
  const next = clone(draft);
  const nodeId = idFactory("node");
  next.graph.nodes.push({
    ...nodeBase({
      nodeId,
      kind: "Skill",
      title: skill.name,
      description: skill.description,
      position,
    }),
    inputPorts: portEntries(skill.inputSchema, "input"),
    outputPorts: portEntries(skill.outputSchema, "output"),
    skillRef: { skillId: skill.skillId, version: skill.version },
    configuration: {},
  });
  return next;
}

export function addMaterialToDraft(draft, resource, position, idFactory) {
  const next = clone(draft);
  const nodeId = idFactory("node");
  if (!next.resourceRefs.some((ref) => ref.resourceId === resource.resourceId && ref.version === resource.version)) {
    next.resourceRefs.push({ resourceId: resource.resourceId, version: resource.version, label: resource.label });
  }
  next.graph.nodes.push({
    ...nodeBase({ nodeId, kind: "Material", title: resource.label, description: "Reference material available to this workflow.", position }),
    outputPorts: [{ portId: "text", name: "Text", schema: stringSchema(), required: true }],
    configuration: { resourceIds: [resource.resourceId] },
  });
  return next;
}

export function addPaletteNodeToDraft(draft, resource, position, idFactory) {
  const next = clone(draft);
  const nodeId = idFactory("node");
  const title = resource.title || "Workflow step";
  const group = resource.groupId || "";
  if (group === "palette-inputs") {
    const fieldId = idFactory("input");
    const schema = stringSchema();
    next.inputForm.fields.push({ fieldId, label: title, description: "", schema, required: true });
    next.graph.nodes.push({
      ...nodeBase({ nodeId, kind: "Input", title, description: "Information supplied before the run.", position }),
      outputPorts: [{ portId: fieldId, name: title, schema, required: true }],
      configuration: { fieldIds: [fieldId] },
    });
  } else if (group === "palette-controls") {
    next.graph.nodes.push({
      ...nodeBase({ nodeId, kind: "ReviewGate", title, description: "Pause for an explicit decision.", position }),
      inputPorts: [{ portId: "candidate", name: "Candidate", schema: stringSchema(), required: true }],
      outputPorts: [{ portId: "approved", name: "Approved", schema: stringSchema(), required: true }],
      reviewPolicy: { mode: "required", instructions: "Approve, request a revision, or reject." },
      configuration: { instructions: "Review before continuing.", allowRevision: true },
      timeoutSeconds: 86400,
    });
  } else {
    const portId = "final";
    next.graph.nodes.push({
      ...nodeBase({ nodeId, kind: "Output", title, description: "Publish the reviewed result.", position }),
      inputPorts: [{ portId: "content", name: "Content", schema: stringSchema(), required: true }],
      outputPorts: [{ portId, name: "Final", schema: stringSchema(), required: true }],
      configuration: { format: "markdown" },
    });
    const expected = { nodeId, portId, label: title, mediaType: "text/markdown" };
    next.outputDefinition = { primary: { nodeId, portId }, expectedOutputs: [expected] };
  }
  return next;
}

export function moveDraftNode(draft, nodeId, position) {
  const next = clone(draft);
  const node = next.graph.nodes.find((item) => item.nodeId === nodeId);
  if (node) node.position = { ...position };
  return next;
}

export function updateDraftNode(draft, nodeId, patch) {
  const next = clone(draft);
  const index = next.graph.nodes.findIndex((item) => item.nodeId === nodeId);
  if (index >= 0) next.graph.nodes[index] = { ...next.graph.nodes[index], ...clone(patch) };
  return next;
}

export function reorderDraftNode(draft, fromIndex, toIndex) {
  const next = clone(draft);
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= next.graph.nodes.length || toIndex >= next.graph.nodes.length) return next;
  const [node] = next.graph.nodes.splice(fromIndex, 1);
  next.graph.nodes.splice(toIndex, 0, node);
  return next;
}

export function deleteDraftNode(draft, nodeId) {
  const next = clone(draft);
  const removed = next.graph.nodes.find((node) => node.nodeId === nodeId);
  next.graph.nodes = next.graph.nodes.filter((node) => node.nodeId !== nodeId);
  if (removed?.kind === "Input") {
    const retained = new Set(next.graph.nodes.flatMap((node) => node.configuration?.fieldIds || []));
    const removedFields = new Set(removed.configuration?.fieldIds || []);
    next.inputForm.fields = next.inputForm.fields.filter((field) => !removedFields.has(field.fieldId) || retained.has(field.fieldId));
  }
  next.graph.edges = next.graph.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId);
  for (const node of next.graph.nodes) {
    node.inputBindings = node.inputBindings.filter((binding) => binding.source.kind !== "nodeOutput" || binding.source.nodeId !== nodeId);
  }
  if (next.outputDefinition.primary.nodeId === nodeId) {
    const replacement = next.graph.nodes.find((node) => node.kind === "Output" && node.outputPorts[0]);
    if (replacement) {
      const port = replacement.outputPorts[0];
      next.outputDefinition = {
        primary: { nodeId: replacement.nodeId, portId: port.portId },
        expectedOutputs: [{ nodeId: replacement.nodeId, portId: port.portId, label: replacement.title, mediaType: "text/markdown" }],
      };
    }
  }
  return next;
}

export function connectDraftNodes(draft, fromNodeId, toNodeId, idFactory) {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return clone(draft);
  const next = clone(draft);
  const source = next.graph.nodes.find((node) => node.nodeId === fromNodeId);
  const target = next.graph.nodes.find((node) => node.nodeId === toNodeId);
  if (!source || !target) return next;
  const bound = new Set(target.inputBindings.map((binding) => binding.targetPort));
  const sourcePort = source.outputPorts[0];
  const targetPort = target.inputPorts.find((port) => !bound.has(port.portId));
  if (!sourcePort || !targetPort) return next;
  if (next.graph.edges.some((edge) => edge.sourceNodeId === fromNodeId && edge.sourcePort === sourcePort.portId && edge.targetNodeId === toNodeId && edge.targetPort === targetPort.portId)) return next;
  // A single-value result forwards the connected value. Its initial text
  // bounds must not reject a valid Skill result or change that result's shape.
  if (target.kind === "Output" && target.inputPorts.length === 1 && target.outputPorts.length === 1
    && targetPort.schema.type === sourcePort.schema.type) {
    targetPort.schema = clone(sourcePort.schema);
    target.outputPorts[0].schema = clone(sourcePort.schema);
  }
  next.graph.edges.push({
    edgeId: idFactory("edge"),
    sourceNodeId: fromNodeId,
    sourcePort: sourcePort.portId,
    targetNodeId: toNodeId,
    targetPort: targetPort.portId,
  });
  target.inputBindings.push({
    targetPort: targetPort.portId,
    source: { kind: "nodeOutput", nodeId: fromNodeId, portId: sourcePort.portId },
  });
  return next;
}

// The document editor changes the same bindings and edges as the canvas.
// A row's visual position must never imply an execution dependency.
export function inputSourceOptions(graph, targetNodeId, targetPortId) {
  const target = graph.nodes.find((node) => node.nodeId === targetNodeId);
  const port = target?.inputPorts.find((item) => item.portId === targetPortId);
  if (!port) return [];
  const downstream = new Set([targetNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (downstream.has(edge.sourceNodeId) && !downstream.has(edge.targetNodeId)) {
        downstream.add(edge.targetNodeId);
        changed = true;
      }
    }
  }
  return graph.nodes.filter((node) => !downstream.has(node.nodeId)).flatMap((node) => (
    node.outputPorts.filter((output) => output.schema.type === port.schema.type)
      .map((output) => ({ nodeId: node.nodeId, portId: output.portId, nodeTitle: node.title, name: output.name }))
  ));
}

export function bindDraftNodeInput(draft, nodeId, portId, source, idFactory) {
  const next = clone(draft);
  const target = next.graph.nodes.find((node) => node.nodeId === nodeId);
  const port = target?.inputPorts.find((item) => item.portId === portId);
  if (!port) throw new Error("workflow_input_not_found");
  if (source && !inputSourceOptions(next.graph, nodeId, portId).some((option) => (
    option.nodeId === source.nodeId && option.portId === source.portId
  ))) throw new Error("workflow_input_source_invalid");
  next.graph.edges = next.graph.edges.filter((edge) => edge.targetNodeId !== nodeId || edge.targetPort !== portId);
  target.inputBindings = target.inputBindings.filter((binding) => binding.targetPort !== portId);
  if (!source) return next;
  const sourcePort = next.graph.nodes.find((node) => node.nodeId === source.nodeId)
    .outputPorts.find((output) => output.portId === source.portId);
  if (target.kind === "Output" && target.inputPorts.length === 1 && target.outputPorts.length === 1) {
    port.schema = clone(sourcePort.schema);
    target.outputPorts[0].schema = clone(sourcePort.schema);
  }
  target.inputBindings.push({ targetPort: portId, source: { kind: "nodeOutput", ...source } });
  next.graph.edges.push({
    edgeId: idFactory("edge"), sourceNodeId: source.nodeId, sourcePort: source.portId,
    targetNodeId: nodeId, targetPort: portId,
  });
  return next;
}
