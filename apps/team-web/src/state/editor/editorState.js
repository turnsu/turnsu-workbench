const EDITABLE_REVISION_FIELDS = [
  "graph",
  "inputForm",
  "outputDefinition",
  "resourceRefs",
  "runSettings",
  "definition",
];

export const EDITOR_ACTIONS = Object.freeze({
  LOAD_REVISION: "editor/load-revision",
  SYNC_REVISION: "editor/sync-revision",
  SELECT_NODE: "editor/select-node",
  REPLACE_DRAFT: "editor/replace-draft",
  UNDO: "editor/undo",
  REDO: "editor/redo",
  COMPILE_STARTED: "editor/compile-started",
  COMPILE_SUCCEEDED: "editor/compile-succeeded",
  COMPILE_FAILED: "editor/compile-failed",
  SAVE_STARTED: "editor/save-started",
  SAVE_SUCCEEDED: "editor/save-succeeded",
  SAVE_FAILED: "editor/save-failed",
  DISCARD_CHANGES: "editor/discard-changes",
  CLEAR_CONFLICT: "editor/clear-conflict",
});

export function cloneEditorValue(value) {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

export function normalizeRunSettings(settings = {}) {
  const controllerProfileId = settings.agentControllerModelProfileId || settings.modelProfileId || "";
  const imageProfileId = settings.imageGenerationModelProfileId || "";
  return {
    maxParallelism: settings.maxParallelism ?? 1,
    defaultTimeoutSeconds: settings.defaultTimeoutSeconds ?? 300,
    ...(controllerProfileId ? { agentControllerModelProfileId: controllerProfileId } : {}),
    ...(imageProfileId ? { imageGenerationModelProfileId: imageProfileId } : {}),
    workflowFallbackAllowed: settings.workflowFallbackAllowed === true
      || (Array.isArray(settings.fallbackModelProfileIds) && settings.fallbackModelProfileIds.length > 0),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function sameDraft(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function revisionToEditorDraft(revision) {
  if (!revision || typeof revision !== "object") return null;
  return EDITABLE_REVISION_FIELDS.reduce((draft, field) => {
    draft[field] = field === "runSettings"
      ? normalizeRunSettings(revision[field])
      : cloneEditorValue(revision[field]);
    return draft;
  }, {});
}

function nodeIdentifier(node) {
  return node?.nodeId || node?.id || "";
}

function resolveSelection(draft, requestedNodeId) {
  const nodes = draft?.graph?.nodes || [];
  if (requestedNodeId && nodes.some((node) => nodeIdentifier(node) === requestedNodeId)) {
    return requestedNodeId;
  }
  return nodeIdentifier(nodes[0]) || null;
}

function compileStateFromRevision(revision) {
  const compile = revision?.compile;
  if (!compile) return { status: "idle", diagnostics: [], result: null };
  return {
    status: compile.status,
    diagnostics: cloneEditorValue(compile.diagnostics || []),
    result: cloneEditorValue(compile),
  };
}

export function createEditorState(revision, { etag = null, selectedNodeId = null } = {}) {
  if (!revision?.revisionId || !revision?.workflowId) {
    throw new TypeError("A saved WorkflowRevision is required to create editor state.");
  }

  const baseRevision = cloneEditorValue(revision);
  const draft = revisionToEditorDraft(baseRevision);
  return {
    workflowId: baseRevision.workflowId,
    baseRevision,
    draft,
    selectedNodeId: resolveSelection(draft, selectedNodeId),
    dirty: false,
    compile: compileStateFromRevision(baseRevision),
    serverEtag: etag,
    saveStatus: "idle",
    lastSaveError: null,
    conflict: null,
    past: [],
    future: [],
  };
}

function replaceDraft(state, draft) {
  const nextDraft = {
    ...cloneEditorValue(draft),
    runSettings: normalizeRunSettings(draft?.runSettings),
  };
  const contentChanged = !sameDraft(state.draft, nextDraft);
  const baseDraft = revisionToEditorDraft(state.baseRevision);
  return {
    ...state,
    draft: nextDraft,
    selectedNodeId: resolveSelection(nextDraft, state.selectedNodeId),
    dirty: !sameDraft(baseDraft, nextDraft),
    compile: contentChanged
      ? { status: "stale", diagnostics: [], result: null }
      : state.compile,
    saveStatus: state.saveStatus === "saving" ? "saving" : "idle",
    lastSaveError: null,
    conflict: null,
  };
}

function normalizeSaveConflict(state, action) {
  const error = cloneEditorValue(action.error || {});
  const details = error.details || {};
  return {
    ...state,
    saveStatus: "conflict",
    lastSaveError: error,
    conflict: {
      code: error.code || "workflow_revision_conflict",
      message: error.message || "",
      expectedRevisionId:
        details.expectedRevisionId || details.expectedRevision || state.baseRevision.revisionId,
      currentRevisionId: details.currentRevisionId || details.currentRevision || null,
      currentEtag: action.currentEtag || details.currentEtag || null,
      details: cloneEditorValue(details),
    },
  };
}

export function editorRevisionSyncKind(state, revision, etag) {
  if (!revision?.revisionId || !revision?.workflowId) return "ignore";
  if (!state || state.workflowId !== revision.workflowId) return "replace";
  // Query refetches can arrive before/after the save mutation settles. They
  // must not overwrite local work or roll the editor back to an older base.
  if (state.dirty || state.saveStatus === "saving" || state.conflict
    || revision.revisionNumber < state.baseRevision.revisionNumber) return "ignore";
  if (state.baseRevision.revisionId !== revision.revisionId) return "replace";
  return etag && etag !== state.serverEtag ? "refresh" : "ignore";
}

export function editorReducer(state, action) {
  switch (action?.type) {
    case EDITOR_ACTIONS.SYNC_REVISION: {
      const kind = editorRevisionSyncKind(state, action.revision, action.etag);
      if (kind === "ignore") return state;
      if (kind === "refresh") return { ...state, serverEtag: action.etag };
      return createEditorState(action.revision, { etag: action.etag, selectedNodeId: state?.selectedNodeId });
    }
    case EDITOR_ACTIONS.LOAD_REVISION:
      return createEditorState(action.revision, {
        etag: action.etag ?? null,
        selectedNodeId: action.selectedNodeId ?? state?.selectedNodeId ?? null,
      });

    case EDITOR_ACTIONS.SELECT_NODE:
      return {
        ...state,
        selectedNodeId: resolveSelection(state.draft, action.nodeId),
      };

    case EDITOR_ACTIONS.REPLACE_DRAFT: {
      const next = replaceDraft(state, action.draft);
      if (sameDraft(state.draft, next.draft)) return state;
      return { ...next, past: [...(state.past || []), state.draft].slice(-50), future: [] };
    }

    case EDITOR_ACTIONS.UNDO: {
      if (!state?.past?.length || state.saveStatus === "saving" || state.conflict) return state;
      return { ...replaceDraft(state, state.past.at(-1)), past: state.past.slice(0, -1),
        future: [state.draft, ...(state.future || [])].slice(0, 50) };
    }

    case EDITOR_ACTIONS.REDO: {
      if (!state?.future?.length || state.saveStatus === "saving" || state.conflict) return state;
      return { ...replaceDraft(state, state.future[0]), past: [...(state.past || []), state.draft].slice(-50),
        future: state.future.slice(1) };
    }

    case EDITOR_ACTIONS.COMPILE_STARTED:
      return {
        ...state,
        compile: { status: "compiling", diagnostics: [], result: null },
      };

    case EDITOR_ACTIONS.COMPILE_SUCCEEDED: {
      const result = cloneEditorValue(action.result || {});
      return {
        ...state,
        compile: {
          status: result.status || "invalid",
          diagnostics: cloneEditorValue(result.diagnostics || []),
          result,
        },
      };
    }

    case EDITOR_ACTIONS.COMPILE_FAILED:
      return {
        ...state,
        compile: {
          status: "error",
          diagnostics: cloneEditorValue(action.diagnostics || []),
          result: null,
        },
      };

    case EDITOR_ACTIONS.SAVE_STARTED:
      return {
        ...state,
        saveStatus: "saving",
        lastSaveError: null,
        conflict: null,
      };

    case EDITOR_ACTIONS.SAVE_SUCCEEDED: {
      const next = createEditorState(action.revision, {
        etag: action.etag ?? null,
        selectedNodeId: state.selectedNodeId,
      });
      return { ...next, saveStatus: "saved", past: state.past || [], future: state.future || [] };
    }

    case EDITOR_ACTIONS.SAVE_FAILED:
      if (action.error?.status === 412 || action.error?.code === "workflow_revision_conflict") {
        return normalizeSaveConflict(state, action);
      }
      return {
        ...state,
        saveStatus: "error",
        lastSaveError: cloneEditorValue(action.error || {}),
        conflict: null,
      };

    case EDITOR_ACTIONS.DISCARD_CHANGES:
      return {
        ...state,
        past: [],
        future: [],
        draft: revisionToEditorDraft(state.baseRevision),
        selectedNodeId: resolveSelection(
          revisionToEditorDraft(state.baseRevision),
          state.selectedNodeId,
        ),
        dirty: false,
        compile: compileStateFromRevision(state.baseRevision),
        saveStatus: "idle",
        lastSaveError: null,
        conflict: null,
      };

    case EDITOR_ACTIONS.CLEAR_CONFLICT:
      return {
        ...state,
        saveStatus: state.dirty ? "idle" : "saved",
        lastSaveError: null,
        conflict: null,
      };

    default:
      return state;
  }
}
