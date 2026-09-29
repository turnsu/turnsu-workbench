const FLOWGRAM_NODE_TYPE = "default";

function edgeTargetsFor(nodeId, edges = []) {
  return edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
}

export function createFlowGramDocument({ nodes = [], edges = [] }) {
  return {
    nodes: nodes.map((node, index) => ({
      id: node.id,
      type: FLOWGRAM_NODE_TYPE,
      data: {
        title: node.title,
        nodeType: node.type,
        skillId: node.skillId || "",
        subtitle: node.subtitle || "",
        inputs: Array.isArray(node.inputs) ? node.inputs : [],
        outputs: Array.isArray(node.outputs) ? node.outputs : [],
        reviewPolicy: node.reviewPolicy || "Visible",
        position: node.position || null,
        order: index + 1,
        nextNodeIds: edgeTargetsFor(node.id, edges),
      },
    })),
  };
}

export function countFlowGramLinks(document) {
  return (document?.nodes || []).reduce((total, node) => total + (node.data?.nextNodeIds?.length || 0), 0);
}

export async function getFlowGramStatus() {
  try {
    const module = await import("@flowgram.ai/editor");
    const hasEditor = Boolean(module.Editor);
    const hasEditorContext = Boolean(module.EditorProvider);
    const hasPreset = Boolean(module.createDefaultPreset);
    const hasDocument = Boolean(module.FlowDocument);

    return {
      status: hasEditor && hasEditorContext && hasPreset && hasDocument ? "available" : "unavailable",
      hasEditor,
      hasEditorContext,
      hasPreset,
      hasDocument,
    };
  } catch (error) {
    return {
      status: "unavailable",
      hasEditor: false,
      hasEditorContext: false,
      hasPreset: false,
      hasDocument: false,
      error: error?.message || String(error),
    };
  }
}
