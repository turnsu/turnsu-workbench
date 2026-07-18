import { useEffect, useMemo, useState } from "react";

import {
  useAgentDefinitionsQuery,
  useAgentEventsQuery,
  useAgentMutations,
  useAgentSessionQuery,
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
    return globalThis.localStorage?.getItem(storageKey(workspaceId, userId, scopeKey)) || "";
  } catch {
    return "";
  }
}

function storeSession(workspaceId, userId, scopeKey, sessionId) {
  try {
    if (sessionId) globalThis.localStorage?.setItem(storageKey(workspaceId, userId, scopeKey), sessionId);
    else globalThis.localStorage?.removeItem(storageKey(workspaceId, userId, scopeKey));
  } catch {
    // Session reuse is a convenience; the server remains authoritative.
  }
}

function uniqueTurns(turns, liveTurn) {
  const byId = new Map((turns || []).map((turn) => [turn.turnId, turn]));
  if (liveTurn?.turnId) byId.set(liveTurn.turnId, liveTurn);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function useAgentSessionController({
  workspaceId = "",
  userId = "",
  definitionId = "main",
  definitionKind = "main",
  objectKind = "",
  objectId = "",
  enabled = true,
} = {}) {
  const scopeKey = `${definitionId}:${objectKind || "workspace"}:${objectId || "main"}`;
  const definitions = useAgentDefinitionsQuery(enabled);
  const [sessionId, setSessionId] = useState(() => readStoredSession(workspaceId, userId, scopeKey));
  const [latestTurnId, setLatestTurnId] = useState("");
  const session = useAgentSessionQuery(sessionId, enabled);
  const turns = useAgentTurnsQuery(sessionId, { limit: 100 }, enabled);
  const events = useAgentEventsQuery(sessionId, { after: 0, limit: 250 }, enabled);
  const liveTurn = useAgentTurnQuery(sessionId, latestTurnId, enabled);
  const mutations = useAgentMutations();

  useEffect(() => {
    setSessionId(readStoredSession(workspaceId, userId, scopeKey));
    setLatestTurnId("");
  }, [workspaceId, userId, scopeKey]);

  useEffect(() => {
    if (!session.error || session.error.status !== 404) return;
    setSessionId("");
    storeSession(workspaceId, userId, scopeKey, "");
  }, [session.error, workspaceId, userId, scopeKey]);

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

  async function ensureSession(lastUsedModelProfileId = "") {
    if (sessionId) return sessionId;
    if (!mainDefinition) throw new Error("main_agent_definition_unavailable");
    const result = await mutations.createSession.mutateAsync({
      idempotencyKey: idempotencyKey("main-session"),
      data: {
        definitionId: mainDefinition.definitionId,
        ...(lastUsedModelProfileId ? { lastUsedModelProfileId } : {}),
        ...(objectKind ? { objectKind } : {}),
        ...(objectId ? { objectId } : {}),
      },
    });
    const createdId = result.data.sessionId;
    setSessionId(createdId);
    storeSession(workspaceId, userId, scopeKey, createdId);
    return createdId;
  }

  async function submitTurn(data) {
    const currentSessionId = await ensureSession(data.lastUsedModelProfileId || "");
    if (
      sessionId
      && data.lastUsedModelProfileId
      && session.data?.data?.lastUsedModelProfileId !== data.lastUsedModelProfileId
    ) {
      await mutations.selectModel.mutateAsync({
        sessionId: currentSessionId,
        modelProfileId: data.lastUsedModelProfileId,
        idempotencyKey: idempotencyKey("select-agent-model"),
      });
    }
    const result = await mutations.createTurn.mutateAsync({
      sessionId: currentSessionId,
      idempotencyKey: idempotencyKey("agent-turn"),
      data: data.turn,
    });
    setLatestTurnId(result.data.turnId);
    return result.data;
  }

  function sendMessage(message, modelProfileRevisionId, modelProfileId = "") {
    return submitTurn({
      lastUsedModelProfileId: modelProfileId,
      turn: {
        kind: "agent_message",
        modelProfileRevisionId,
        input: { message: String(message || "").trim() },
      },
    });
  }

  function createImage(input, modelProfileRevisionId, modelProfileId = "") {
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
      turn: { kind: "model_task", modelProfileRevisionId, input: normalized },
    });
  }

  async function cancelActive(reason = "Cancelled from the Workbench") {
    if (!sessionId || !activeTurn?.turnId) return null;
    return mutations.cancelTurn.mutateAsync({
      sessionId,
      turnId: activeTurn.turnId,
      idempotencyKey: idempotencyKey("cancel-turn"),
      data: { reason },
    });
  }

  return {
    definitions: definitions.data?.data || [],
    mainDefinition,
    session: session.data?.data || null,
    sessionId,
    history,
    events: events.data?.data || [],
    activeTurn,
    loading: definitions.isLoading || (Boolean(sessionId) && session.isLoading),
    error: definitions.error || session.error || turns.error || events.error || null,
    busy: mutations.createSession.isPending || mutations.selectModel.isPending || mutations.createTurn.isPending || Boolean(activeTurn),
    sendMessage,
    createImage,
    cancelActive,
    retry() {
      return Promise.all([definitions.refetch(), session.refetch(), turns.refetch(), events.refetch()]);
    },
  };
}

export function useMainAgent(options = {}) {
  return useAgentSessionController({ ...options, definitionId: "main", definitionKind: "main" });
}
