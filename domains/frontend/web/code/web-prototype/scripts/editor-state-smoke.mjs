import assert from "node:assert/strict";

import {
  EDITOR_ACTIONS,
  EDITOR_DRAFT_STORAGE_KEY,
  createEditorDraftPayload,
  createEditorState,
  editorReducer,
  parseEditorDraftPayload,
  persistEditorDraft,
  recoverLegacyOwnedWorkflowDraft,
} from "../src/state/editor/index.js";

const revision = {
  schemaVersion: "workbench-v1",
  revisionId: "revision-workflow-1-3",
  workflowId: "workflow-1",
  revisionNumber: 3,
  baseRevisionId: "revision-workflow-1-2",
  graph: {
    nodes: [
      { nodeId: "node-input", kind: "Input", title: "Starting point", position: { x: 0, y: 0 } },
      { nodeId: "node-output", kind: "Output", title: "Final result", position: { x: 320, y: 0 } },
    ],
    edges: [
      {
        edgeId: "edge-input-output",
        sourceNodeId: "node-input",
        sourcePort: "value",
        targetNodeId: "node-output",
        targetPort: "content",
      },
    ],
  },
  inputForm: { fields: [] },
  outputDefinition: {
    primary: { nodeId: "node-output", portId: "content" },
    expectedOutputs: [
      { nodeId: "node-output", portId: "content", label: "Final result", mediaType: "text/markdown" },
    ],
  },
  resourceRefs: [],
  runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 300 },
  definition: { goal: "Review the incoming work", context: "", constraints: [], doneWhen: ["A result is ready"], verify: [], expectedResult: "Reviewed result", stopRules: [] },
  contentHash: "sha256:revision-3",
  authoredBy: "user-local",
  saveReason: "Saved revision",
  compile: {
    status: "ready",
    diagnostics: [{ code: "existing_warning", severity: "warning" }],
  },
  createdAt: "2026-07-10T08:00:00.000Z",
  updatedAt: "2026-07-10T08:00:00.000Z",
};

const initial = createEditorState(revision, {
  etag: '"workflow-1:3"',
  selectedNodeId: "missing-node",
});

assert.equal(initial.baseRevision.revisionId, revision.revisionId);
assert.notEqual(initial.baseRevision, revision, "the immutable server revision must be cloned");
assert.notEqual(initial.draft.graph, revision.graph, "the editable draft must not alias server state");
assert.equal(initial.selectedNodeId, "node-input", "invalid selection must fall back to the first node");
assert.equal(initial.dirty, false);
assert.equal(initial.serverEtag, '"workflow-1:3"');
assert.equal(initial.compile.status, "ready");
assert.equal(initial.draft.definition.goal, "Review the incoming work");
assert.deepEqual(initial.compile.diagnostics, revision.compile.diagnostics);

const selected = editorReducer(initial, {
  type: EDITOR_ACTIONS.SELECT_NODE,
  nodeId: "node-output",
});
assert.equal(selected.selectedNodeId, "node-output");
assert.equal(initial.selectedNodeId, "node-input", "the reducer must not mutate prior state");

const changedDraft = structuredClone(selected.draft);
changedDraft.graph.nodes[1].title = "Reviewed final result";
const changed = editorReducer(selected, {
  type: EDITOR_ACTIONS.REPLACE_DRAFT,
  draft: changedDraft,
});
assert.equal(changed.dirty, true);
assert.equal(changed.compile.status, "stale", "a draft edit must invalidate prior compile authority");
assert.deepEqual(changed.compile.diagnostics, []);

const compiled = editorReducer(changed, {
  type: EDITOR_ACTIONS.COMPILE_SUCCEEDED,
  result: {
    status: "blocked",
    diagnostics: [{ code: "missing_information", severity: "error", nodeId: "node-input" }],
  },
});
assert.equal(compiled.compile.status, "blocked");
assert.equal(compiled.compile.diagnostics[0].code, "missing_information");

const conflict = editorReducer(compiled, {
  type: EDITOR_ACTIONS.SAVE_FAILED,
  error: {
    status: 412,
    code: "workflow_revision_conflict",
    message: "This workflow changed after you opened it.",
    details: {
      expectedRevisionId: revision.revisionId,
      currentRevisionId: "revision-workflow-1-4",
    },
  },
  currentEtag: '"workflow-1:4"',
});
assert.equal(conflict.saveStatus, "conflict");
assert.equal(conflict.conflict.code, "workflow_revision_conflict");
assert.equal(conflict.conflict.currentRevisionId, "revision-workflow-1-4");
assert.equal(conflict.conflict.currentEtag, '"workflow-1:4"');
assert.equal(conflict.dirty, true, "a conflict must preserve local edits");
assert.equal(conflict.serverEtag, '"workflow-1:3"', "a conflict must not silently advance the editor base");

const savedRevision = {
  ...structuredClone(revision),
  revisionId: "revision-workflow-1-4",
  revisionNumber: 4,
  baseRevisionId: revision.revisionId,
  graph: structuredClone(changedDraft.graph),
  contentHash: "sha256:revision-4",
  compile: { status: "blocked", diagnostics: structuredClone(compiled.compile.diagnostics) },
  saveReason: "Update final result",
  updatedAt: "2026-07-10T09:00:00.000Z",
};
const saved = editorReducer(conflict, {
  type: EDITOR_ACTIONS.SAVE_SUCCEEDED,
  revision: savedRevision,
  etag: '"workflow-1:4"',
});
assert.equal(saved.baseRevision.revisionId, savedRevision.revisionId);
assert.equal(saved.serverEtag, '"workflow-1:4"');
assert.equal(saved.dirty, false);
assert.equal(saved.saveStatus, "saved");
assert.equal(saved.conflict, null);
assert.equal(saved.selectedNodeId, "node-output");

const reverted = editorReducer(changed, {
  type: EDITOR_ACTIONS.REPLACE_DRAFT,
  draft: {
    graph: revision.graph,
    inputForm: revision.inputForm,
    outputDefinition: revision.outputDefinition,
    resourceRefs: revision.resourceRefs,
    runSettings: revision.runSettings,
    definition: revision.definition,
  },
});
assert.equal(reverted.dirty, false, "returning to the saved content must clear dirty state");

const payload = createEditorDraftPayload({
  ...changed,
  skills: [{ id: "must-not-persist" }],
  runs: [{ id: "must-not-persist" }],
  toasts: [{ id: "must-not-persist" }],
  chatMessages: [{ id: "must-not-persist" }],
  serverReadiness: { status: "ready" },
}, "2026-07-10T09:30:00.000Z");
assert.deepEqual(Object.keys(payload).sort(), [
  "baseRevisionId",
  "draft",
  "savedAt",
  "schemaVersion",
  "serverEtag",
  "workflowId",
].sort());
assert.deepEqual(Object.keys(payload.draft).sort(), [
  "definition",
  "graph",
  "inputForm",
  "outputDefinition",
  "resourceRefs",
  "runSettings",
].sort());

const forbiddenPersistenceKeys = new Set([
  "catalogs",
  "skills",
  "templates",
  "runs",
  "toasts",
  "chat",
  "chatMessages",
  "readiness",
  "compile",
]);
function collectKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  Object.entries(value).forEach(([key, child]) => {
    keys.push(key);
    collectKeys(child, keys);
  });
  return keys;
}
assert.equal(
  collectKeys(payload).some((key) => forbiddenPersistenceKeys.has(key)),
  false,
  "draft persistence must not contain server, run, notification, or chat state",
);
assert.deepEqual(parseEditorDraftPayload(JSON.stringify(payload)), payload);
assert.equal(parseEditorDraftPayload("not-json"), null);
assert.equal(
  parseEditorDraftPayload(JSON.stringify({ ...payload, draft: { graph: payload.draft.graph } })),
  null,
  "partial drafts must not be restored",
);

const writes = [];
const storage = {
  setItem(key, value) { writes.push({ key, value }); },
};
persistEditorDraft(changed, storage, "2026-07-10T09:30:00.000Z");
assert.equal(writes.length, 1);
assert.equal(writes[0].key, EDITOR_DRAFT_STORAGE_KEY);
assert.notEqual(writes[0].key, "loopops.workspace.v1", "the legacy workspace key is read-only");

const legacySnapshot = {
  version: 1,
  detailId: "legacy-owned-dirty",
  dirtyLoopIds: ["legacy-owned-dirty"],
  loopRows: [
    {
      id: "legacy-template",
      type: "LoopTemplate",
      source: "Preset Templates",
      title: "Template",
      workflow: { nodes: [{ id: "template-node", type: "Input" }], edges: [] },
    },
    {
      id: "legacy-owned-clean",
      type: "LoopWorkflow",
      source: "Owned Workflows",
      title: "Clean workflow",
      dirty: false,
      workflow: { nodes: [{ id: "clean-node", type: "Input" }], edges: [] },
    },
    {
      id: "legacy-owned-dirty",
      type: "LoopWorkflow",
      source: "Owned Workflows",
      title: "Recovered workflow",
      dirty: true,
      requiredInputs: ["Meeting notes"],
      outputShape: "Reviewed notes",
      workflow: {
        nodes: [
          { id: "legacy-input", type: "Input", title: "Meeting notes", outputs: ["Meeting context"] },
          { id: "legacy-output", type: "Output", title: "Reviewed notes", inputs: ["Meeting context"], outputs: ["Final answer"] },
        ],
        edges: [{ id: "legacy-edge", from: "legacy-input", to: "legacy-output" }],
      },
    },
  ],
  skillRows: [{ id: "must-not-migrate" }],
  runs: [{ id: "must-not-migrate" }],
  toasts: [{ id: "must-not-migrate" }],
  chatMessages: [{ id: "must-not-migrate" }],
};

const recovered = recoverLegacyOwnedWorkflowDraft(legacySnapshot);
assert.equal(recovered.workflowId, "legacy-owned-dirty");
assert.equal(recovered.baseRevisionId, null);
assert.equal(recovered.serverEtag, null);
assert.equal(recovered.recoveredFrom, "loopops.workspace.v1");
assert.equal(recovered.draft.graph.nodes[0].nodeId, "legacy-input");
assert.equal(recovered.draft.graph.nodes[1].kind, "Output");
assert.equal(recovered.draft.graph.edges[0].sourceNodeId, "legacy-input");
assert.equal(recovered.draft.inputForm.fields[0].label, "Meeting notes");
assert.equal(collectKeys(recovered).includes("skillRows"), false);
assert.equal(collectKeys(recovered).includes("runs"), false);
assert.equal(recoverLegacyOwnedWorkflowDraft({ loopRows: legacySnapshot.loopRows.slice(0, 2) }), null);

console.log("web_editor_state_smoke=pass");
