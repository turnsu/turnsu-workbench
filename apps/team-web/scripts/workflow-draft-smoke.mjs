import assert from "node:assert/strict";

import {
  addSkillToDraft,
  addMaterialToDraft,
  bindDraftNodeInput,
  inputSourceOptions,
  connectDraftNodes,
  deleteDraftNode,
  moveDraftNode,
} from "../src/state/editor/workflowDraftActions.js";
import { workflowGraphLayout, workflowGraphBounds, graphNodeHeight } from "../src/components/loops/workflowGraphLayout.js";

const draft = {
  graph: {
    nodes: [{
      nodeId: "node-input",
      kind: "Input",
      title: "Input",
      description: "",
      position: { x: 0, y: 0 },
      inputPorts: [],
      outputPorts: [{ portId: "text", name: "Text", schema: { type: "string" }, required: true }],
      inputBindings: [],
      reviewPolicy: { mode: "none" },
      retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
      timeoutSeconds: 30,
      display: { collapsed: false },
      configuration: { fieldIds: ["text"] },
    }],
    edges: [],
  },
  inputForm: { fields: [] },
  outputDefinition: { primary: { nodeId: "node-input", portId: "text" }, expectedOutputs: [{ nodeId: "node-input", portId: "text", label: "Text", mediaType: "text/plain" }] },
  resourceRefs: [],
  runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 30 },
};
const skill = {
  skillId: "skill-echo",
  version: "1",
  name: "Echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  outputSchema: {
    type: "object",
    properties: { echo: { type: "array", items: { type: "string" }, maxItems: 4 } },
    required: ["echo"],
  },
};
const added = addSkillToDraft(draft, skill, { x: 100, y: 200 }, () => "node-skill");
assert.equal(added.graph.nodes.at(-1).skillRef.skillId, "skill-echo");
assert.equal(added.graph.nodes.at(-1).position.y, 200);
assert.equal(Object.hasOwn(added.graph.nodes.at(-1).outputPorts[0].schema, "maxItems"), false);
const connected = connectDraftNodes(added, "node-input", "node-skill", () => "edge-1");
assert.equal(connected.graph.edges[0].targetPort, "text");
assert.equal(connected.graph.nodes.at(-1).inputBindings[0].source.nodeId, "node-input");
const outputDraft = structuredClone(draft);
outputDraft.graph.nodes.push({ ...structuredClone(draft.graph.nodes[0]), kind: "Output", nodeId: "node-output",
  inputPorts: [{ portId: "result", name: "Result", schema: { type: "string", minLength: 1, maxLength: 10000 }, required: true }],
  outputPorts: [{ portId: "result", name: "Result", schema: { type: "string", minLength: 1, maxLength: 10000 }, required: true }],
  configuration: { format: "markdown" },
});
const outputConnected = connectDraftNodes(outputDraft, "node-input", "node-output", () => "edge-result");
assert.deepEqual(outputConnected.graph.nodes[1].inputPorts[0].schema, { type: "string" });
assert.deepEqual(outputConnected.graph.nodes[1].outputPorts[0].schema, { type: "string" });
assert.equal(outputDraft.graph.nodes[1].inputPorts[0].schema.maxLength, 10000, "connecting produces a new draft without mutating saved content");
const moved = moveDraftNode(connected, "node-skill", { x: 500, y: 400 });
assert.equal(moved.graph.nodes.at(-1).position.x, 500);
const removed = deleteDraftNode(moved, "node-skill");
assert.equal(removed.graph.nodes.length, 1);
assert.equal(removed.graph.edges.length, 0);
const withMaterial = addMaterialToDraft(draft, {
  resourceId: "resource-notes",
  version: "1.0.0",
  label: "Meeting notes",
}, { x: 300, y: 200 }, () => "node-material");
assert.deepEqual(withMaterial.resourceRefs, [{ resourceId: "resource-notes", version: "1.0.0", label: "Meeting notes" }]);
assert.deepEqual(withMaterial.graph.nodes.at(-1).configuration, { resourceIds: ["resource-notes"] });
assert.equal(withMaterial.graph.nodes.at(-1).kind, "Material");

// Replacing a source updates the executable graph, not just its visual order.
const alternativeInput = { ...structuredClone(draft.graph.nodes[0]), nodeId: "input-other", title: "Other input" };
const rebindingDraft = structuredClone(connected);
rebindingDraft.graph.nodes.push(alternativeInput);
const rebound = bindDraftNodeInput(rebindingDraft, "node-skill", "text", { nodeId: "input-other", portId: "text" }, () => "edge-other");
assert.equal(rebound.graph.edges.length, 1);
assert.equal(rebound.graph.edges[0].sourceNodeId, "input-other");
assert.equal(rebound.graph.nodes[1].inputBindings[0].source.nodeId, "input-other");
assert.equal(rebindingDraft.graph.edges[0].sourceNodeId, "node-input", "saved source is not mutated");
const unbound = bindDraftNodeInput(rebound, "node-skill", "text", null, () => "unused");
assert.equal(unbound.graph.edges.length, 0);
assert.equal(unbound.graph.nodes[1].inputBindings.length, 0);
const cyclicDraft = structuredClone(outputConnected);
cyclicDraft.graph.nodes[0].inputPorts = [{ portId: "cycle", schema: { type: "string" }, required: true }];
assert.deepEqual(inputSourceOptions(cyclicDraft.graph, "node-input", "cycle"), [], "self and downstream sources would create a cycle");
assert.throws(() => bindDraftNodeInput(cyclicDraft, "node-input", "cycle", { nodeId: "node-output", portId: "result" }, () => "bad"), /workflow_input_source_invalid/);
assert.throws(() => bindDraftNodeInput(connected, "node-skill", "missing", null, () => "bad"), /workflow_input_not_found/);
const boundOutput = bindDraftNodeInput(outputDraft, "node-output", "result", { nodeId: "node-input", portId: "text" }, () => "edge-output");
assert.deepEqual(boundOutput.graph.nodes[1].outputPorts[0].schema, { type: "string" });

const inputDraft = structuredClone(connected);
inputDraft.inputForm.fields = [{ fieldId: "text", label: "Source text" }, { fieldId: "other", label: "Other" }];
const inputRemoved = deleteDraftNode(inputDraft, "node-input");
assert.deepEqual(inputRemoved.inputForm.fields, [{ fieldId: "other", label: "Other" }], "removed input must disappear from the next test run form");
assert.deepEqual(inputRemoved.graph.edges, []);
assert.deepEqual(inputRemoved.graph.nodes[0].inputBindings, []);
assert.equal(inputDraft.inputForm.fields.length, 2, "the prior snapshot stays available for undo");
inputDraft.graph.nodes.push(alternativeInput);
assert.equal(deleteDraftNode(inputDraft, "node-input").inputForm.fields.length, 2, "another input can still own a shared field");

const branchGraph = { nodes: ["end", "left", "start", "right"].map((nodeId) => ({ nodeId, inputPorts: [], outputPorts: [] })),
  edges: [["start", "left"], ["start", "right"], ["left", "end"], ["right", "end"]].map(([sourceNodeId, targetNodeId]) => ({ sourceNodeId, targetNodeId })) };
const graphBefore = structuredClone(branchGraph);
const arranged = workflowGraphLayout(branchGraph);
assert.ok(arranged.start.x < arranged.left.x && arranged.left.x < arranged.end.x, "layout follows dependencies, not array order");
assert.equal(arranged.left.x, arranged.right.x, "parallel branches share a column");
assert.ok(Math.abs(arranged.left.y - arranged.right.y) > graphNodeHeight(branchGraph.nodes[1]), "parallel cards do not overlap");
assert.deepEqual(branchGraph, graphBefore, "arranging never changes execution dependencies");
const bounds = workflowGraphBounds(branchGraph.nodes, arranged);
assert.ok(bounds.width > 600 && bounds.height > 200, "fit bounds include all branches");
const cyclic = { ...branchGraph, edges: [...branchGraph.edges, { sourceNodeId: "end", targetNodeId: "start" }] };
assert.equal(Object.keys(workflowGraphLayout(cyclic)).length, 4, "invalid historical cycles stay visible for repair");

console.log("web_workflow_draft_smoke=pass");
