import { useEffect, useMemo, useState } from "react";

import {
  useAgentDefinitionsQuery,
  useAgentEventsQuery,
  useAgentMutations,
  useAgentSessionQuery,
  useAgentSessionsQuery,
  useAgentTurnQuery,
  useAgentTurnsQuery,
} from "../../api/queries.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);
const idempotencyKey = (kind) => `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

function storageKey(workspaceId, userId, scopeKey) {
  return `looloomi:agent:${workspaceId || "workspace"}:${userId || "user"}:${scopeKey}`;
}

function readStoredSession(workspaceId, userId, scopeKey) {
  try {
    return globalThis.sessionStorage?.getItem(storageKey(workspaceId, userId, scopeKey)) || "";
  } catch {
    return "";
  }
}

function storeSession(workspaceId, userId, scopeKey, sessionId) {
  try {
    if (sessionId) globalThis.sessionStorage?.setItem(storageKey(workspaceId, userId, scopeKey), sessionId);
    else globalThis.sessionStorage?.removeItem(storageKey(workspaceId, userId, scopeKey));
  } catch {
    // Session reuse is a convenience; the server remains authoritative.
  }
}

function uniqueTurns(turns, liveTurn) {
  const byId = new Map((turns || []).map((turn) => [turn.turnId, turn]));
  if (liveTurn?.turnId) byId.set(liveTurn.turnId, liveTurn);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function recentSessions(sessions = []) {
  return [...sessions].sort((left, right) => (
    String(right.updatedAt || right.createdAt || "")
      .localeCompare(String(left.updatedAt || left.createdAt || ""))
  ));
}

export function useAgentSessionController({
  workspaceId = "",
  userId = "",
  definitionId = "main",
  definitionKind = "main",
  objectKind = "",
  objectId = "",
  requestedSessionId = "",
  enabled = true,
} = {}) {
  const scopeKey = `${definitionId}:${objectKind || "workspace"}:${objectId || "main"}`;
  const ownsSessionList = definitionKind === "main" && !objectKind && !objectId;
  const principal = useMemo(() => ({ workspaceId, userId }), [workspaceId, userId]);
  const definitions = useAgentDefinitionsQuery(enabled);
  const [sessionId, setSessionId] = useState(() => readStoredSession(workspaceId, userId, scopeKey));
  const [draftingNewSession, setDraftingNewSession] = useState(false);
  const [latestTurnId, setLatestTurnId] = useState("");
  const [rejectedRequestedSessionId, setRejectedRequestedSessionId] = useState("");
  const listAgentSessions = useAgentSessionsQuery(
    { definitionId, limit: 100 },
    enabled && ownsSessionList,
    principal,
  );
  const session = useAgentSessionQuery(sessionId, enabled, principal);
  const turns = useAgentTurnsQuery(sessionId, { limit: 100 }, enabled, principal);
  const events = useAgentEventsQuery(sessionId, { limit: 100 }, enabled, principal);
  const liveTurn = useAgentTurnQuery(sessionId, latestTurnId, enabled, principal);
  const mutations = useAgentMutations();
  const sessions = useMemo(
    () => recentSessions(listAgentSessions.data?.data || []),
    [listAgentSessions.data?.data],
  );

  useEffect(() => {
    setSessionId(readStoredSession(workspaceId, userId, scopeKey));
    setDraftingNewSession(false);
    setLatestTurnId("");
    setRejectedRequestedSessionId("");
  }, [workspaceId, userId, scopeKey]);

  useEffect(() => {
    if (!requestedSessionId && rejectedRequestedSessionId) {
      setRejectedRequestedSessionId("");
    }
  }, [rejectedRequestedSessionId, requestedSessionId]);

  useEffect(() => {
    if (!ownsSessionList
      || !requestedSessionId
      || rejectedRequestedSessionId === requestedSessionId
      || sessionId === requestedSessionId) return;
    setDraftingNewSession(false);
    setLatestTurnId("");
    setSessionId(requestedSessionId);
  }, [
    ownsSessionList,
    rejectedRequestedSessionId,
    requestedSessionId,
    sessionId,
  ]);

  useEffect(() => {
    if (!session.error || session.error.status !== 404) return;
    if (requestedSessionId && sessionId === requestedSessionId) {
      setRejectedRequestedSessionId(requestedSessionId);
      setLatestTurnId("");
      storeSession(workspaceId, userId, scopeKey, "");
      return;
    }
    setSessionId("");
    setDraftingNewSession(true);
    storeSession(workspaceId, userId, scopeKey, "");
  }, [requestedSessionId, session.error, sessionId, workspaceId, userId, scopeKey]);

  useEffect(() => {
    if (requestedSessionId || session.data?.data?.status !== "closed") return;
    setSessionId("");
    setDraftingNewSession(true);
    setLatestTurnId("");
    storeSession(workspaceId, userId, scopeKey, "");
  }, [
    requestedSessionId,
    scopeKey,
    session.data?.data?.status,
    userId,
    workspaceId,
  ]);

  useEffect(() => {
    if (!requestedSessionId
      || rejectedRequestedSessionId === requestedSessionId
      || sessionId !== requestedSessionId
      || !session.data?.data?.sessionId) return;
    storeSession(workspaceId, userId, scopeKey, requestedSessionId);
  }, [
    rejectedRequestedSessionId,
    requestedSessionId,
    scopeKey,
    session.data?.data?.sessionId,
    sessionId,
    userId,
    workspaceId,
  ]);

  useEffect(() => {
    if (!ownsSessionList
      || listAgentSessions.isLoading
      || draftingNewSession
      || sessionId
      || requestedSessionId) return;
    const nextSessionId = sessions[0]?.sessionId || "";
    if (!nextSessionId) return;
    setSessionId(nextSessionId);
    storeSession(workspaceId, userId, scopeKey, nextSessionId);
  }, [
    draftingNewSession,
    ownsSessionList,
    scopeKey,
    sessionId,
    listAgentSessions.isLoading,
    requestedSessionId,
    sessions,
    userId,
    workspaceId,
  ]);

  useEffect(() => {
    const activeTurnId = session.data?.data?.activeTurnId;
    if (activeTurnId) setLatestTurnId(activeTurnId);
  }, [session.data?.data?.activeTurnId]);

  const mainDefinition = (definitions.data?.data || []).find((definition) => definition.definitionId === definitionId)
    || (definitions.data?.data || []).find((definition) => definition.kind === definitionKind)
    || null;
  const history = useMemo(
    () => uniqueTurns(turns.data?.data || [], liveTurn.data?.data),
    [turns.data?.data, liveTurn.data?.data],
  );
  const sessionActiveTurn = history.find((turn) => turn.turnId === session.data?.data?.activeTurnId);
  const activeTurn = (sessionActiveTurn && !TERMINAL.has(sessionActiveTurn.status) ? sessionActiveTurn : null)
    || history.findLast?.((turn) => !TERMINAL.has(turn.status))
    || null;
  const requestedSessionError = rejectedRequestedSessionId
    && rejectedRequestedSessionId === requestedSessionId
    ? "session_not_found_or_forbidden"
    : "";

  function selectSession(nextSessionId) {
    if (!nextSessionId || nextSessionId === sessionId) return;
    setDraftingNewSession(false);
    setLatestTurnId("");
    setSessionId(nextSessionId);
    storeSession(workspaceId, userId, scopeKey, nextSessionId);
  }

  function beginNewSession() {
    setDraftingNewSession(true);
    setLatestTurnId("");
    setSessionId("");
    storeSession(workspaceId, userId, scopeKey, "");
  }

  async function ensureSession(lastUsedModelProfileId = "", title = "") {
    if (requestedSessionError) throw new Error(requestedSessionError);
    if (sessionId) return sessionId;
    if (!mainDefinition) throw new Error("main_agent_definition_unavailable");
    const result = await mutations.createSession.mutateAsync({
      idempotencyKey: idempotencyKey("main-session"),
      principal,
      data: {
        definitionId: mainDefinition.definitionId,
        ...(title ? { title } : {}),
        ...(lastUsedModelProfileId ? { lastUsedModelProfileId } : {}),
        ...(objectKind ? { objectKind } : {}),
        ...(objectId ? { objectId } : {}),
      },
    });
    const createdId = result.data.sessionId;
    setSessionId(createdId);
    setDraftingNewSession(false);
    storeSession(workspaceId, userId, scopeKey, createdId);
    return createdId;
  }

  async function submitTurn(data) {
    const currentSessionId = await ensureSession(
      data.lastUsedModelProfileId || "",
      data.sessionTitle || "",
    );
    if (
      sessionId
      && data.lastUsedModelProfileId
      && session.data?.data?.lastUsedModelProfileId !== data.lastUsedModelProfileId
    ) {
      await mutations.selectModel.mutateAsync({
        sessionId: currentSessionId,
        modelProfileId: data.lastUsedModelProfileId,
        idempotencyKey: idempotencyKey("select-agent-model"),
        principal,
      });
    }
    const result = await mutations.createTurn.mutateAsync({
      sessionId: currentSessionId,
      idempotencyKey: idempotencyKey("agent-turn"),
      principal,
      data: data.turn,
    });
    setLatestTurnId(result.data.turnId);
    return result.data;
  }

  function sendMessage(message, modelProfileId, attachments = []) {
    const normalizedMessage = String(message || "").trim();
    return submitTurn({
      lastUsedModelProfileId: modelProfileId,
      sessionTitle: normalizedMessage.slice(0, 72),
      turn: {
        kind: "agent_message",
        modelProfileId,
        input: {
          message: normalizedMessage,
          ...(attachments.length ? { attachments } : {}),
        },
      },
    });
  }

  function createImage(input, modelProfileId) {
    const normalized = {
      task: "image_generation",
      prompt: String(input?.prompt || "").trim(),
      ...(input?.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      ...(input?.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input?.outputFormat ? { outputFormat: input.outputFormat } : {}),
      ...(input?.seed !== undefined && input?.seed !== "" ? { seed: Number(input.seed) } : {}),
    };
    return submitTurn({
      lastUsedModelProfileId: modelProfileId,
      sessionTitle: normalized.prompt.slice(0, 72),
      turn: { kind: "model_task", modelProfileId, input: normalized },
    });
  }

  async function cancelActive(reason = "Cancelled from the Workbench") {
    if (!sessionId || !activeTurn?.turnId) return null;
    return mutations.cancelTurn.mutateAsync({
      sessionId,
      turnId: activeTurn.turnId,
      idempotencyKey: idempotencyKey("cancel-turn"),
      principal,
      data: { reason },
    });
  }

  return {
    definitions: definitions.data?.data || [],
    mainDefinition,
    sessions,
    sessionsLoading: ownsSessionList && listAgentSessions.isLoading,
    sessionsError: ownsSessionList ? listAgentSessions.error : null,
    requestedSessionError,
    session: session.data?.data || null,
    sessionId,
    draftingNewSession,
    history,
    events: events.data?.data || [],
    hasEarlierSessions: Boolean(listAgentSessions.hasNextPage),
    hasEarlierTurns: Boolean(turns.hasNextPage || events.hasNextPage),
    loadingEarlier: listAgentSessions.isFetchingNextPage || turns.isFetchingNextPage || events.isFetchingNextPage,
    loadEarlierSessions: listAgentSessions.fetchNextPage,
    async loadEarlierTurns() {
      await Promise.all([
        turns.hasNextPage ? turns.fetchNextPage() : Promise.resolve(),
        events.hasNextPage ? events.fetchNextPage() : Promise.resolve(),
      ]);
    },
    activeTurn,
    loading: definitions.isLoading || (Boolean(sessionId) && session.isLoading),
    error: definitions.error
      || (requestedSessionError ? null : session.error)
      || (requestedSessionError ? null : turns.error)
      || (requestedSessionError ? null : events.error)
      || null,
    busy: mutations.createSession.isPending || mutations.selectModel.isPending || mutations.createTurn.isPending,
    running: Boolean(activeTurn),
    selectSession,
    beginNewSession,
    sendMessage,
    createImage,
    cancelActive,
    retry() {
      const requests = [definitions.refetch(), session.refetch(), turns.refetch(), events.refetch()];
      if (ownsSessionList) requests.push(listAgentSessions.refetch());
      return Promise.all(requests);
    },
  };
}

export function useMainAgent(options = {}) {
  return useAgentSessionController({ ...options, definitionId: "main", definitionKind: "main" });
}
