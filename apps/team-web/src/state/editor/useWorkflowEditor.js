import { useCallback, useEffect, useReducer } from "react";

import {
  EDITOR_ACTIONS,
  EDITOR_DRAFT_STORAGE_KEY,
  LEGACY_WORKSPACE_STORAGE_KEY,
  createEditorState,
  editorReducer,
  parseEditorDraftPayload,
  persistEditorDraft,
  recoverLegacyOwnedWorkflowDraft,
} from "./index.js";
import { editorRevisionSyncKind } from "./editorState.js";

let legacyRecoveryRead = false;

function browserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function recoveredDraft(revision, etag) {
  const storage = browserStorage();
  if (!storage) return null;
  const current = parseEditorDraftPayload(storage.getItem(EDITOR_DRAFT_STORAGE_KEY));
  if (
    current?.workflowId === revision.workflowId
    && current.baseRevisionId === revision.revisionId
    && (!current.serverEtag || !etag || current.serverEtag === etag)
  ) {
    return current.draft;
  }
  if (legacyRecoveryRead) return null;
  legacyRecoveryRead = true;
  let legacySnapshot = null;
  try {
    legacySnapshot = JSON.parse(storage.getItem(LEGACY_WORKSPACE_STORAGE_KEY) || "null");
  } catch {
    legacySnapshot = null;
  }
  const legacy = recoverLegacyOwnedWorkflowDraft(legacySnapshot);
  return legacy?.workflowId === revision.workflowId ? legacy.draft : null;
}

export function useWorkflowEditor(revision, etag) {
  const [state, dispatch] = useReducer(editorReducer, null);

  useEffect(() => {
    if (!revision?.revisionId || !revision?.workflowId) return;
    const sync = editorRevisionSyncKind(state, revision, etag);
    if (sync === "ignore") return;
    const next = createEditorState(revision, { etag });
    const draft = sync === "replace" ? recoveredDraft(revision, etag) : null;
    dispatch({ type: EDITOR_ACTIONS.SYNC_REVISION, revision, etag });
    if (draft) dispatch({ type: EDITOR_ACTIONS.REPLACE_DRAFT, draft: { ...next.draft, ...draft } });
  }, [revision, etag, state]);

  useEffect(() => {
    const storage = browserStorage();
    if (!storage || !state) return;
    if (state.dirty) persistEditorDraft(state, storage);
    else storage.removeItem(EDITOR_DRAFT_STORAGE_KEY);
  }, [state]);

  const replaceDraft = useCallback((next) => {
    if (!state) return;
    dispatch({
      type: EDITOR_ACTIONS.REPLACE_DRAFT,
      draft: typeof next === "function" ? next(state.draft) : next,
    });
  }, [state]);

  return {
    state,
    dispatch,
    loadRevision(nextRevision, nextEtag, selectedNodeId) {
      dispatch({
        type: EDITOR_ACTIONS.LOAD_REVISION,
        revision: nextRevision,
        etag: nextEtag,
        selectedNodeId,
      });
    },
    replaceDraftValue(draft) {
      dispatch({ type: EDITOR_ACTIONS.REPLACE_DRAFT, draft });
    },
    replaceDraft,
    selectNode(nodeId) { dispatch({ type: EDITOR_ACTIONS.SELECT_NODE, nodeId }); },
    compileStarted() { dispatch({ type: EDITOR_ACTIONS.COMPILE_STARTED }); },
    compileSucceeded(result) { dispatch({ type: EDITOR_ACTIONS.COMPILE_SUCCEEDED, result }); },
    compileFailed(diagnostics) { dispatch({ type: EDITOR_ACTIONS.COMPILE_FAILED, diagnostics }); },
    saveStarted() { dispatch({ type: EDITOR_ACTIONS.SAVE_STARTED }); },
    saveSucceeded(nextRevision, nextEtag) {
      dispatch({ type: EDITOR_ACTIONS.SAVE_SUCCEEDED, revision: nextRevision, etag: nextEtag });
    },
    saveFailed(error) { dispatch({ type: EDITOR_ACTIONS.SAVE_FAILED, error }); },
    discard() { dispatch({ type: EDITOR_ACTIONS.DISCARD_CHANGES }); },
  };
}
