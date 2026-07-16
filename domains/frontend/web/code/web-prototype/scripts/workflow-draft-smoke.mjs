import assert from "node:assert/strict";

import {
  addSkillToDraft,
  addMaterialToDraft,
  connectDraftNodes,
  deleteDraftNode,
  moveDraftNode,
} from "../src/state/editor/workflowDraftActions.js";

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

console.log("web_workflow_draft_smoke=pass");
