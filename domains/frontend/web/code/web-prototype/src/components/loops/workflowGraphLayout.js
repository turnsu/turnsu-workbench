export const GRAPH_NODE_WIDTH = 248;
export const graphNodeHeight = (node) => 96 + Math.max(node.inputPorts?.length || 0, node.outputPorts?.length || 0, 1) * 24;

// Layout changes positions only; execution order remains in the canonical edges.
export function workflowGraphLayout(graph) {
  const ids = new Set(graph.nodes.map((node) => node.nodeId));
  const degrees = new Map([...ids].map((id) => [id, 0]));
  const children = new Map([...ids].map((id) => [id, []]));
  for (const edge of graph.edges) {
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId)) continue;
    children.get(edge.sourceNodeId).push(edge.targetNodeId);
    degrees.set(edge.targetNodeId, degrees.get(edge.targetNodeId) + 1);
  }
  const queue = [...ids].filter((id) => degrees.get(id) === 0);
  const levels = new Map(queue.map((id) => [id, 0]));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const child of children.get(id)) {
      levels.set(child, Math.max(levels.get(child) || 0, levels.get(id) + 1));
      degrees.set(child, degrees.get(child) - 1);
      if (degrees.get(child) === 0) queue.push(child);
    }
  }
  const rows = new Map();
  const positions = {};
  const fallback = Math.max(0, ...levels.values()) + 1;
  for (const node of graph.nodes) {
    const level = levels.get(node.nodeId) ?? fallback;
    const y = rows.get(level) || 80;
    positions[node.nodeId] = { x: 64 + level * (GRAPH_NODE_WIDTH + 94), y };
    rows.set(level, y + graphNodeHeight(node) + 56);
  }
  return positions;
}

export function workflowGraphBounds(nodes, positions) {
  if (!nodes.length) return { x: 0, y: 0, width: 400, height: 240 };
  const left = Math.min(...nodes.map((node) => positions[node.nodeId].x));
  const top = Math.min(...nodes.map((node) => positions[node.nodeId].y));
  return { x: left, y: top,
    width: Math.max(...nodes.map((node) => positions[node.nodeId].x + GRAPH_NODE_WIDTH)) - left,
    height: Math.max(...nodes.map((node) => positions[node.nodeId].y + graphNodeHeight(node))) - top };
}
