const clone = (value) => value == null ? value : structuredClone(value);

export class InMemoryAgentPersistence {
  constructor() {
    this.sessions = new Map();
    this.turns = new Map();
    this.messages = new Map();
    this.branches = new Map();
    this.events = new Map();
    this.handoffs = new Map();
  }

  async findSession(query) {
    const value = [...this.sessions.values()].find((session) => sameSessionScope(session, query));
    return publicSession(value ?? null);
  }

  async createBranch(branch) {
    this.branches.set(branch.branchId, clone(branch));
    return clone(branch);
  }

  async createSession(session) {
    this.sessions.set(session.sessionId, { ...clone(session), turnSequence: 0, messageSequence: 0, eventSequence: 0 });
    return publicSession(this.sessions.get(session.sessionId));
  }

  async getSession(sessionId, access = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    return publicSession(session);
  }

  async getBranch(branchId) {
    return clone(this.branches.get(branchId) ?? null);
  }

  async createTurn(turn) {
    const session = this.sessions.get(turn.sessionId);
    if (!session) throw new Error("agent_session_not_found");
    session.turnSequence += 1;
    session.updatedAt = turn.updatedAt;
    const value = { ...clone(turn), sequence: session.turnSequence, invocationIds: [] };
    this.turns.set(turn.turnId, value);
    return publicTurn(value);
  }

  async appendMessage(message) {
    const session = this.sessions.get(message.sessionId);
    session.messageSequence += 1;
    const value = { ...clone(message), sequence: session.messageSequence };
    const items = this.messages.get(message.sessionId) ?? [];
    items.push(value);
    this.messages.set(message.sessionId, items);
    return clone(value);
  }

  async listMessages(sessionId, access = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    return (this.messages.get(sessionId) ?? []).map(clone);
  }

  async appendEvent(sessionId, eventFactory) {
    const session = this.sessions.get(sessionId);
    session.eventSequence += 1;
    const event = eventFactory(session.eventSequence);
    const items = this.events.get(sessionId) ?? [];
    items.push(clone(event));
    this.events.set(sessionId, items);
    return clone(event);
  }

  async claimNextTurn(sessionId, startedAt) {
    const session = this.sessions.get(sessionId);
    if (!session || session.activeTurnId) return null;
    const turn = [...this.turns.values()]
      .filter((entry) => entry.sessionId === sessionId && entry.status === "queued")
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (!turn) return null;
    session.activeTurnId = turn.turnId;
    session.updatedAt = startedAt;
    turn.status = "running";
    turn.startedAt = startedAt;
    turn.updatedAt = startedAt;
    return publicTurn(turn);
  }

  async addInvocation(turnId, invocationId, updatedAt) {
    const turn = this.turns.get(turnId);
    if (!turn.invocationIds.includes(invocationId)) turn.invocationIds.push(invocationId);
    turn.updatedAt = updatedAt;
  }

  async getTurnInvocations(turnId) {
    return clone(this.turns.get(turnId)?.invocationIds ?? []);
  }

  async completeTurn(turnId, status, result, finishedAt) {
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    if (!["running", "cancellation_requested"].includes(turn.internalStatus ?? turn.status)) return publicTurn(turn);
    turn.status = status;
    turn.internalStatus = status;
    turn.result = clone(result);
    turn.finishedAt = finishedAt;
    turn.updatedAt = finishedAt;
    const session = this.sessions.get(turn.sessionId);
    if (session.activeTurnId === turnId) session.activeTurnId = null;
    session.updatedAt = finishedAt;
    return publicTurn(turn);
  }

  async requestCancel(turnId, cancelledAt) {
    const turn = this.turns.get(turnId);
    if (!turn || ["completed", "failed", "cancelled", "blocked"].includes(turn.status)) return publicTurn(turn ?? null);
    if (turn.status === "queued") {
      turn.status = "cancelled";
      turn.result = { response: "Turn cancelled.", proposalId: null, handoffId: null, invocationIds: [] };
      turn.finishedAt = cancelledAt;
    } else {
      turn.internalStatus = "cancellation_requested";
    }
    turn.updatedAt = cancelledAt;
    return publicTurn(turn);
  }

  async getTurn(sessionId, turnId, access = {}) {
    const session = this.sessions.get(sessionId);
    const turn = this.turns.get(turnId);
    if (!session || !turn || turn.sessionId !== sessionId || !canAccess(session, access)) return null;
    return publicTurn(turn);
  }

  async listEvents(sessionId, after = 0, limit = 500, access = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    return (this.events.get(sessionId) ?? []).filter((event) => event.sequence > after).slice(0, limit).map(clone);
  }

  async findMainSession(userId, workspaceId) {
    return publicSession([...this.sessions.values()].find((session) => (
      session.userId === userId && session.workspaceId === workspaceId && session.definitionId === "main"
    )) ?? null);
  }

  async createHandoff(handoff) {
    this.handoffs.set(handoff.handoffId, clone(handoff));
    return clone(handoff);
  }

  async listHandoffs(targetSessionId) {
    return [...this.handoffs.values()].filter((handoff) => handoff.targetSessionId === targetSessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone);
  }

  async confirmHandoff(targetSessionId, handoffId, confirmedAt) {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff || handoff.targetSessionId !== targetSessionId) return null;
    if (handoff.status === "pending") {
      handoff.status = "confirmed";
      handoff.confirmedAt = confirmedAt;
    }
    return clone(handoff);
  }

  async recover() {
    const sessionIds = [];
    for (const session of this.sessions.values()) {
      if (!session.activeTurnId) continue;
      const turn = this.turns.get(session.activeTurnId);
      if (turn?.status === "running") {
        if (turn.internalStatus === "cancellation_requested") {
          turn.status = "cancelled";
          turn.internalStatus = "cancelled";
          turn.result = { response: "Turn cancelled.", proposalId: null, handoffId: null, invocationIds: clone(turn.invocationIds) };
          turn.finishedAt = session.updatedAt;
        } else {
          turn.status = "queued";
          turn.startedAt = null;
          sessionIds.push(session.sessionId);
        }
      }
      session.activeTurnId = null;
    }
    return sessionIds;
  }
}

export function publicSession(session) {
  if (!session) return null;
  const value = clone(session);
  delete value.turnSequence;
  delete value.messageSequence;
  delete value.eventSequence;
  delete value._id;
  return value;
}

export function publicTurn(turn) {
  if (!turn) return null;
  const value = clone(turn);
  delete value.invocationIds;
  delete value.internalStatus;
  delete value._id;
  return value;
}

function canAccess(session, { userId, workspaceId } = {}) {
  return (!userId || session.userId === userId) && (!workspaceId || session.workspaceId === workspaceId);
}

function sameSessionScope(session, query) {
  if (!canAccess(session, query) || session.definitionId !== query.definitionId) return false;
  if (session.scope.kind !== query.scope.kind) return false;
  if (session.scope.kind === "main") return true;
  return session.scope.objectKind === query.scope.objectKind
    && session.scope.objectId === query.scope.objectId
    && (!query.scope.branchId || session.scope.branchId === query.scope.branchId);
}
