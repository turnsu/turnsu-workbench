import { cloneEditorValue, revisionToEditorDraft } from "./editorState.js";

export const EDITOR_DRAFT_SCHEMA_VERSION = "workbench-editor-draft-v1";
export const EDITOR_DRAFT_STORAGE_KEY = "loopops.editor-draft.v1";
export const LEGACY_WORKSPACE_STORAGE_KEY = "loopops.workspace.v1";

const DRAFT_FIELDS = [
  "graph",
  "inputForm",
  "outputDefinition",
  "resourceRefs",
  "runSettings",
  "definition",
];

function exactDraft(value) {
  if (!value || typeof value !== "object") return null;
  return DRAFT_FIELDS.reduce((draft, field) => {
    draft[field] = cloneEditorValue(value[field]);
    return draft;
  }, {});
}

export function createEditorDraftPayload(state, savedAt = new Date().toISOString()) {
  if (!state?.workflowId || !state?.baseRevision?.revisionId || !state?.draft) {
    throw new TypeError("Editor state with a saved base revision is required.");
  }
  return {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    workflowId: state.workflowId,
    baseRevisionId: state.baseRevision.revisionId,
    serverEtag: state.serverEtag || null,
    savedAt,
    draft: exactDraft(state.draft),
  };
}

export function parseEditorDraftPayload(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      !value
      || value.schemaVersion !== EDITOR_DRAFT_SCHEMA_VERSION
      || typeof value.workflowId !== "string"
      || typeof value.baseRevisionId !== "string"
      || typeof value.savedAt !== "string"
      || !value.draft
      || DRAFT_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value.draft, field))
    ) {
      return null;
    }
    return {
      schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
      workflowId: value.workflowId,
      baseRevisionId: value.baseRevisionId,
      serverEtag: typeof value.serverEtag === "string" ? value.serverEtag : null,
      savedAt: value.savedAt,
      draft: exactDraft(value.draft),
    };
  } catch {
    return null;
  }
}

export function persistEditorDraft(state, storage, savedAt) {
  if (!storage?.setItem) return null;
  const payload = createEditorDraftPayload(state, savedAt);
  storage.setItem(EDITOR_DRAFT_STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

function safePortId(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function uniquePorts(labels, direction) {
  const counts = new Map();
  return (Array.isArray(labels) ? labels : []).map((label, index) => {
    const base = safePortId(label, `${direction}-${index + 1}`);
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    const portId = count ? `${base}-${count + 1}` : base;
    return {
      portId,
      name: String(label || `${direction} ${index + 1}`),
      schema: { type: "string" },
      required: direction === "input",
    };
  });
}

function legacyKind(value) {
  if (value === "Review Gate") return "ReviewGate";
  return ["Input", "Skill", "Material", "Transform", "ReviewGate", "Output"].includes(value)
    ? value
    : "Transform";
}

function legacyConfiguration(kind, legacyNode, inputForm) {
  switch (kind) {
    case "Input":
      return { fieldIds: inputForm.fields.map((field) => field.fieldId) };
    case "Skill":
      return {};
    case "Material":
      return { resourceIds: [] };
    case "ReviewGate":
      return {
        instructions: legacyNode.reviewPolicy || "Review before continuing.",
        allowRevision: true,
      };
    case "Output":
      return { format: "markdown" };
    default:
      return { mode: "mapping" };
  }
}

function convertLegacyGraph(legacyWorkflow, inputForm) {
  const oldNodes = Array.isArray(legacyWorkflow?.nodes) ? legacyWorkflow.nodes : [];
  const nodes = oldNodes.map((node, index) => {
    const kind = legacyKind(node.type || node.kind);
    const converted = {
      nodeId: node.id || node.nodeId || `legacy-node-${index + 1}`,
      kind,
      title: node.title || `Step ${index + 1}`,
      description: node.subtitle || node.description || "",
      position: cloneEditorValue(node.position || { x: index * 320, y: 0 }),
      inputPorts: uniquePorts(node.inputs, "input"),
      outputPorts: uniquePorts(node.outputs, "output"),
      inputBindings: [],
      reviewPolicy: {
        mode: kind === "ReviewGate" ? "required" : "none",
        ...(node.reviewPolicy ? { instructions: node.reviewPolicy } : {}),
      },
      retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
      timeoutSeconds: 300,
      display: { collapsed: false },
      configuration: legacyConfiguration(kind, node, inputForm),
    };
    if (kind === "Skill") {
      converted.skillRef = {
        skillId: node.skillId || `legacy-unresolved-${converted.nodeId}`,
        version: "legacy",
      };
    }
    return converted;
  });
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const edges = (Array.isArray(legacyWorkflow?.edges) ? legacyWorkflow.edges : [])
    .map((edge, index) => {
      const sourceNodeId = edge.sourceNodeId || edge.from;
      const targetNodeId = edge.targetNodeId || edge.to;
      const sourceNode = nodesById.get(sourceNodeId);
      const targetNode = nodesById.get(targetNodeId);
      if (!sourceNode || !targetNode) return null;
      const sourcePort = edge.sourcePort || sourceNode.outputPorts[0]?.portId || "output";
      const targetPort = edge.targetPort || targetNode.inputPorts[0]?.portId || "input";
      targetNode.inputBindings.push({
        targetPort,
        source: { kind: "nodeOutput", nodeId: sourceNodeId, portId: sourcePort },
      });
      return {
        edgeId: edge.edgeId || edge.id || `legacy-edge-${index + 1}`,
        sourceNodeId,
        sourcePort,
        targetNodeId,
        targetPort,
      };
    })
    .filter(Boolean);
  return { nodes, edges };
}

function legacyInputForm(loop) {
  return {
    fields: (Array.isArray(loop.requiredInputs) ? loop.requiredInputs : []).map((label, index) => ({
      fieldId: safePortId(label, `input-${index + 1}`),
      label: String(label),
      description: "",
      schema: { type: "string" },
      required: true,
    })),
  };
}

function legacyOutputDefinition(graph, outputShape) {
  const outputNode = graph.nodes.find((node) => node.kind === "Output") || graph.nodes.at(-1);
  if (!outputNode) return null;
  const outputPort = outputNode.outputPorts[0] || {
    portId: "result",
    name: outputShape || "Result",
  };
  return {
    primary: { nodeId: outputNode.nodeId, portId: outputPort.portId },
    expectedOutputs: [
      {
        nodeId: outputNode.nodeId,
        portId: outputPort.portId,
        label: outputShape || outputPort.name || "Result",
        mediaType: "text/markdown",
      },
    ],
  };
}

export function recoverLegacyOwnedWorkflowDraft(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const dirtyIds = new Set(Array.isArray(snapshot.dirtyLoopIds) ? snapshot.dirtyLoopIds : []);
  const ownedDirty = (Array.isArray(snapshot.loopRows) ? snapshot.loopRows : []).filter((loop) => {
    const owned = loop?.type === "LoopWorkflow"
      && (loop.source === "Owned Workflows" || loop.source === "Owned Loops");
    return owned && (loop.dirty === true || dirtyIds.has(loop.id));
  });
  const loop = ownedDirty.find((item) => item.id === snapshot.detailId) || ownedDirty[0];
  if (!loop?.id || !loop.workflow) return null;

  const inputForm = legacyInputForm(loop);
  const graph = convertLegacyGraph(loop.workflow, inputForm);
  const draft = {
    graph,
    inputForm,
    outputDefinition: legacyOutputDefinition(graph, loop.outputShape),
    resourceRefs: [],
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 300 },
  };
  return {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    workflowId: loop.id,
    baseRevisionId: null,
    serverEtag: null,
    savedAt: "",
    draft: revisionToEditorDraft(draft),
    recoveredFrom: LEGACY_WORKSPACE_STORAGE_KEY,
  };
}
