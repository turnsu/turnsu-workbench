const textSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 10000 });

/** Product-neutral blank Loop definition shared by PostgreSQL and legacy tests. */
export function initialLoopDraft() {
  const input = { nodeId: "node-input", title: "Goal", description: "The outcome this Loop should produce.", position: { x: 0, y: 0 }, inputPorts: [], outputPorts: [{ portId: "goal", name: "Goal", schema: structuredClone(textSchema), required: true }], inputBindings: [], reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 60, display: { collapsed: false }, kind: "Input", configuration: { fieldIds: ["goal"] } };
  const output = { nodeId: "node-output", title: "Result", description: "The current Loop result.", position: { x: 420, y: 0 }, inputPorts: [{ portId: "result", name: "Result", schema: structuredClone(textSchema), required: true }], outputPorts: [{ portId: "result", name: "Result", schema: structuredClone(textSchema), required: true }], inputBindings: [{ targetPort: "result", source: { kind: "nodeOutput", nodeId: "node-input", portId: "goal" } }], reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 60, display: { collapsed: false }, kind: "Output", configuration: { format: "markdown" } };
  return {
    graph: { nodes: [input, output], edges: [{ edgeId: "edge-input-output", sourceNodeId: "node-input", sourcePort: "goal", targetNodeId: "node-output", targetPort: "result" }] },
    inputForm: { fields: [{ fieldId: "goal", label: "Goal", description: "What should this Loop produce?", schema: structuredClone(textSchema), required: true }] },
    outputDefinition: { primary: { nodeId: "node-output", portId: "result" }, expectedOutputs: [{ nodeId: "node-output", portId: "result", label: "Result", mediaType: "text/markdown" }] },
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 60, workflowFallbackAllowed: false },
  };
}
