import assert from "node:assert/strict";

import { createFlowGramDocument, countFlowGramLinks, getFlowGramStatus } from "../src/components/canvas/flowgramAdapter.js";
import {
  EDITOR_ACTIONS,
  createEditorState,
  editorReducer,
} from "../src/state/editor/editorState.js";
import {
  addSkillToDraft,
  connectDraftNodes,
  deleteDraftNode,
  moveDraftNode,
  updateDraftNode,
} from "../src/state/editor/workflowDraftActions.js";
import {
  createRunStreamState,
  reduceRunEvents,
  selectRunEventCursor,
  selectRunStream,
} from "../src/state/run-stream/runStreamState.js";
import { workflowRevisionToCanvas } from "../src/state/server/presentationAdapters.js";
import { dictionaries } from "../src/i18n.js";

const stringSchema = { type: "string", minLength: 1 };
const baseNode = {
  description: "",
  position: { x: 80, y: 100 },
  inputPorts: [],
  outputPorts: [{ portId: "text", name: "Text", schema: stringSchema, required: true }],
  inputBindings: [],
  reviewPolicy: { mode: "none" },
  retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
  timeoutSeconds: 30,
  display: { collapsed: false },
};
const revision = {
  schemaVersion: "workbench-v1",
  workflowId: "workflow-smoke",
  revisionId: "revision-smoke-1",
  revisionNumber: 1,
  baseRevisionId: null,
  graph: { nodes: [{ ...baseNode, nodeId: "node-input", kind: "Input", title: "Input", configuration: { fieldIds: ["text"] } }], edges: [] },
  inputForm: { fields: [{ fieldId: "text", label: "Text", description: "", schema: stringSchema, required: true }] },
  outputDefinition: { primary: { nodeId: "node-input", portId: "text" }, expectedOutputs: [{ nodeId: "node-input", portId: "text", label: "Text", mediaType: "text/plain" }] },
  resourceRefs: [],
  runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 30 },
  contentHash: "sha256:1234567890abcdef",
  authoredBy: "user-local",
  saveReason: "Smoke fixture",
  compile: { status: "blocked", diagnostics: [] },
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};
const skill = {
  skillId: "skill-echo",
  version: "1",
  name: "Echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: stringSchema }, required: ["text"] },
  outputSchema: {
    type: "object",
    properties: { echo: { type: "array", items: stringSchema, maxItems: 4 } },
    required: ["echo"],
  },
};

let draft = addSkillToDraft(createEditorState(revision, { etag: '"workflow-smoke:1"' }).draft, skill, { x: 420, y: 100 }, () => "node-skill");
draft = connectDraftNodes(draft, "node-input", "node-skill", () => "edge-input-skill");
draft = moveDraftNode(draft, "node-skill", { x: 520, y: 220 });
draft = updateDraftNode(draft, "node-skill", { title: "Echo reviewed text" });
assert.equal(draft.graph.nodes.at(-1).position.x, 520);
assert.equal(draft.graph.edges[0].targetPort, "text");
assert.equal(Object.hasOwn(draft.graph.nodes.at(-1).outputPorts[0].schema, "maxItems"), false);

let editor = createEditorState(revision, { etag: '"workflow-smoke:1"' });
editor = editorReducer(editor, { type: EDITOR_ACTIONS.REPLACE_DRAFT, draft });
assert.equal(editor.dirty, true);
assert.equal(editor.compile.status, "stale");
editor = editorReducer(editor, { type: EDITOR_ACTIONS.SAVE_FAILED, error: { status: 412, code: "workflow_revision_conflict", details: { currentRevisionId: "revision-smoke-2" } } });
assert.equal(editor.saveStatus, "conflict");

const canvas = workflowRevisionToCanvas({ ...revision, ...draft });
const flowgram = createFlowGramDocument(canvas);
assert.equal(flowgram.nodes.length, 2);
assert.equal(countFlowGramLinks(flowgram), 1);
assert.equal((await getFlowGramStatus()).status, "available");

const event = (sequence, type, eventId, nodeId) => ({
  schemaVersion: "workbench-run-event-v1",
  sequence,
  type,
  eventId,
  runId: "run-smoke",
  workflowId: "workflow-smoke",
  workflowRevisionId: "revision-smoke-1",
  ...(nodeId ? { nodeId } : {}),
  status: type === "run.completed" ? "completed" : type === "review.requested" ? "waiting_review" : "running",
  summary: type,
  occurredAt: "2026-07-10T00:00:00.000Z",
});
const stream = reduceRunEvents(createRunStreamState(), [
  event(1, "run.started", "event-1"),
  event(2, "node.completed", "event-2", "node-skill"),
  event(3, "review.requested", "event-3", "node-review"),
  event(3, "review.requested", "event-3", "node-review"),
  event(4, "run.completed", "event-4"),
]);
assert.equal(selectRunEventCursor(stream, "run-smoke"), 4);
assert.equal(selectRunStream(stream, "run-smoke").status, "completed");
assert.equal(selectRunStream(stream, "run-smoke").readModelRefreshRequired, true);
assert.equal(Object.hasOwn(selectRunStream(stream, "run-smoke"), "finalAnswer"), false);

assert.equal(dictionaries.en["page.builder.title"], "Loop builder");
assert.equal(dictionaries.zh["page.builder.title"], "工作流编排");

const removed = deleteDraftNode(draft, "node-skill");
assert.equal(removed.graph.nodes.length, 1);
assert.equal(removed.graph.edges.length, 0);

console.log("web_action_smoke=pass");
console.log("web_action_canonical_graph=true");
console.log("web_action_editor_conflict=true");
console.log("web_action_run_stream=true");
console.log("web_action_final_authority=server-read-model");
