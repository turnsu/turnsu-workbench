const compareId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function buildDependencyGraph(nodeIds, edges) {
  const adjacency = new Map(
    nodeIds.map((nodeId) => [nodeId, new Set()]),
  );
  const predecessors = new Map(
    nodeIds.map((nodeId) => [nodeId, new Set()]),
  );

  for (const edge of edges) {
    if (
      !adjacency.has(edge.sourceNodeId) ||
      !adjacency.has(edge.targetNodeId)
    ) {
      continue;
    }
    adjacency.get(edge.sourceNodeId).add(edge.targetNodeId);
    predecessors.get(edge.targetNodeId).add(edge.sourceNodeId);
  }

  return { adjacency, predecessors };
}

export function kahnByStableLayers(nodeIds, adjacency, predecessors) {
  const indegree = new Map(
    nodeIds.map((nodeId) => [nodeId, predecessors.get(nodeId).size]),
  );
  let layer = nodeIds
    .filter((nodeId) => indegree.get(nodeId) === 0)
    .sort(compareId);
  const ordered = [];

  while (layer.length > 0) {
    ordered.push(...layer);
    const nextLayer = new Set();

    for (const nodeId of layer) {
      for (const targetNodeId of [...adjacency.get(nodeId)].sort(compareId)) {
        const nextIndegree = indegree.get(targetNodeId) - 1;
        indegree.set(targetNodeId, nextIndegree);
        if (nextIndegree === 0) {
          nextLayer.add(targetNodeId);
        }
      }
    }

    layer = [...nextLayer].sort(compareId);
  }

  return ordered;
}

export function reachableNodeIds(startNodeIds, adjacency) {
  const reachable = new Set();
  const queue = [...startNodeIds].sort(compareId);

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (reachable.has(nodeId) || !adjacency.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    for (const targetNodeId of [...adjacency.get(nodeId)].sort(compareId)) {
      if (!reachable.has(targetNodeId)) {
        queue.push(targetNodeId);
      }
    }
  }

  return reachable;
}

export function invalidCycles(nodeIds, adjacency) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const components = [];

  const visit = (nodeId) => {
    indexByNode.set(nodeId, nextIndex);
    lowLinkByNode.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const targetNodeId of [...adjacency.get(nodeId)].sort(compareId)) {
      if (!indexByNode.has(targetNodeId)) {
        visit(targetNodeId);
        lowLinkByNode.set(
          nodeId,
          Math.min(lowLinkByNode.get(nodeId), lowLinkByNode.get(targetNodeId)),
        );
      } else if (onStack.has(targetNodeId)) {
        lowLinkByNode.set(
          nodeId,
          Math.min(lowLinkByNode.get(nodeId), indexByNode.get(targetNodeId)),
        );
      }
    }

    if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) {
      return;
    }

    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== nodeId);
    components.push(component.sort(compareId));
  };

  for (const nodeId of [...nodeIds].sort(compareId)) {
    if (!indexByNode.has(nodeId)) {
      visit(nodeId);
    }
  }

  return components
    .filter(
      (component) =>
        component.length > 1 || adjacency.get(component[0]).has(component[0]),
    )
    .map((component) => ({
      nodeIds: component.length === 1 ? [component[0], component[0]] : component,
    }))
    .sort((left, right) => compareId(left.nodeIds[0], right.nodeIds[0]));
}
