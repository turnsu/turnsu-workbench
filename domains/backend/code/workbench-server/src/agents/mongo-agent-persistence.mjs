import { publicSession, publicTurn } from "./agent-persistence.mjs";

const opts = (extra = {}) => extra.session ? { ...extra } : { ...extra };
const doc = (value) => value?.value ?? value ?? null;
const clean = (value) => {
  if (!value) return value;
  const result = structuredClone(value);
  delete result._id;
  return result;
};

export class MongoAgentPersistence {
  constructor({ store } = {}) {
    if (!store || typeof store.connect !== "function") throw new TypeError("agent_store_required");
    this.store = store;
  }

  async #repos() {
    await this.store.connect();
    const repositories = this.store.repositories;
    for (const name of [
      "agentSessions", "agentTurns", "agentMessages", "agentBranches",
      "agentSessionEvents", "agentHandoffs",
    ]) if (!repositories?.[name]?.collection) throw new TypeError(`agent_repository_missing:${name}`);
    return repositories;
  }

  async findSession(query) {
    const repositories = await this.#repos();
    return publicSession(await repositories.agentSessions.collection.findOne({
      userId: query.userId,
      workspaceId: query.workspaceId,
      definitionId: query.definitionId,
      "scope.kind": query.scope.kind,
      ...(query.scope.kind === "module" ? {
        "scope.objectKind": query.scope.objectKind,
        "scope.objectId": query.scope.objectId,
        ...(query.scope.branchId ? { "scope.branchId": query.scope.branchId } : {}),
      } : {}),
      status: "active",
    }, { sort: { updatedAt: -1, createdAt: -1 } }));
  }

  async createBranch(branch) {
    const repositories = await this.#repos();
    return repositories.agentBranches.insert(branch);
  }

  async createModuleSession(branch, session) {
    const repositories = await this.#repos();
    try {
      return await this.store.withTransaction(async (mongoSession) => {
        await repositories.agentBranches.collection.insertOne(structuredClone(branch), { session: mongoSession });
        const value = { ...structuredClone(session), turnSequence: 0, messageSequence: 0, eventSequence: 0 };
        await repositories.agentSessions.collection.insertOne(value, { session: mongoSession });
        return publicSession(value);
      });
    } catch (error) {
      if (error?.code !== 11000 && error?.codeName !== "DuplicateKey") throw error;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await this.findSession({
          userId: session.userId,
          workspaceId: session.workspaceId,
          definitionId: session.definitionId,
          scope: {
            kind: "module",
            objectKind: session.scope.objectKind,
            objectId: session.scope.objectId,
          },
        });
        if (existing) return existing;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw error;
    }
  }

  async createSession(session) {
    const repositories = await this.#repos();
    return publicSession(await repositories.agentSessions.insert({
      ...structuredClone(session), turnSequence: 0, messageSequence: 0, eventSequence: 0,
    }));
  }

  async getSession(sessionId, access = {}) {
    const repositories = await this.#repos();
    return publicSession(await repositories.agentSessions.collection.findOne({
      sessionId,
      ...(access.userId ? { userId: access.userId } : {}),
      ...(access.workspaceId ? { workspaceId: access.workspaceId } : {}),
    }));
  }

  async updateSessionModel(sessionId, modelProfileId, updatedAt) {
    const repositories = await this.#repos();
    return publicSession(doc(await repositories.agentSessions.collection.findOneAndUpdate(
      { sessionId, status: "active" },
      {
        $set: {
          lastUsedModelProfileId: modelProfileId,
          modelPreferenceState: "preference_only",
          updatedAt,
        },
        $unset: { modelProfileId: "" },
      },
      { returnDocument: "after" },
    )));
  }

  async getBranch(branchId) {
    const repositories = await this.#repos();
    return repositories.agentBranches.get(branchId);
  }

  async createTurn(turn) {
    const repositories = await this.#repos();
    const session = doc(await repositories.agentSessions.collection.findOneAndUpdate(
      { sessionId: turn.sessionId, status: "active" },
      { $inc: { turnSequence: 1 }, $set: { updatedAt: turn.updatedAt } },
      { returnDocument: "after" },
    ));
    if (!session) throw new Error("agent_session_not_found");
    return publicTurn(await repositories.agentTurns.insert({
      ...structuredClone(turn), sequence: session.turnSequence, invocationIds: [],
    }));
  }

  async appendMessage(message) {
    const repositories = await this.#repos();
    const session = doc(await repositories.agentSessions.collection.findOneAndUpdate(
      { sessionId: message.sessionId },
      { $inc: { messageSequence: 1 } },
      { returnDocument: "after" },
    ));
    if (!session) throw new Error("agent_session_not_found");
    return repositories.agentMessages.insert({ ...structuredClone(message), sequence: session.messageSequence });
  }

  async listMessages(sessionId, access = {}) {
    if (!await this.getSession(sessionId, access)) return null;
    const repositories = await this.#repos();
    return (await repositories.agentMessages.collection.find({ sessionId }).sort({ sequence: 1 }).limit(5000).toArray()).map(clean);
  }

  async appendEvent(sessionId, eventFactory) {
    const repositories = await this.#repos();
    const session = doc(await repositories.agentSessions.collection.findOneAndUpdate(
      { sessionId },
      { $inc: { eventSequence: 1 } },
      { returnDocument: "after" },
    ));
    if (!session) throw new Error("agent_session_not_found");
    return repositories.agentSessionEvents.insert(eventFactory(session.eventSequence));
  }

  async claimNextTurn(sessionId, startedAt) {
    const repositories = await this.#repos();
    const queued = await repositories.agentTurns.collection.findOne(
      { sessionId, status: "queued" },
      { sort: { sequence: 1 } },
    );
    if (!queued) return null;
    const session = doc(await repositories.agentSessions.collection.findOneAndUpdate(
      { sessionId, status: "active", activeTurnId: null },
      { $set: { activeTurnId: queued.turnId, updatedAt: startedAt } },
      { returnDocument: "after" },
    ));
    if (!session) return null;
    const turn = doc(await repositories.agentTurns.collection.findOneAndUpdate(
      { turnId: queued.turnId, status: "queued" },
      { $set: { status: "running", startedAt, updatedAt: startedAt } },
      { returnDocument: "after" },
    ));
    if (!turn) {
      await repositories.agentSessions.collection.updateOne(
        { sessionId, activeTurnId: queued.turnId },
        { $set: { activeTurnId: null, updatedAt: startedAt } },
      );
      return null;
    }
    return internalRunnerTurn(turn);
  }

  async addInvocation(turnId, invocationId, updatedAt) {
    const repositories = await this.#repos();
    await repositories.agentTurns.collection.updateOne(
      { turnId },
      { $addToSet: { invocationIds: invocationId }, $set: { updatedAt } },
    );
  }

  async getTurnInvocations(turnId) {
    const repositories = await this.#repos();
    return (await repositories.agentTurns.collection.findOne({ turnId }))?.invocationIds ?? [];
  }

  async completeTurn(turnId, status, result, finishedAt, routing = {}) {
    const repositories = await this.#repos();
    const turn = doc(await repositories.agentTurns.collection.findOneAndUpdate(
      { turnId, status: "running", $or: [{ internalStatus: { $exists: false } }, { internalStatus: "cancellation_requested" }] },
      {
        $set: {
          status,
          result: structuredClone(result),
          actualModelRevisionId: routing.actualModelRevisionId ?? null,
          artifactRefs: structuredClone(routing.artifactRefs ?? []),
          finishedAt,
          updatedAt: finishedAt,
        },
        $unset: { internalStatus: "" },
      },
      { returnDocument: "after" },
    ));
    if (!turn) return null;
    await repositories.agentSessions.collection.updateOne(
      { sessionId: turn.sessionId, activeTurnId: turnId },
      { $set: { activeTurnId: null, updatedAt: finishedAt } },
    );
    return publicTurn(turn);
  }

  async requestCancel(turnId, cancelledAt) {
    const repositories = await this.#repos();
    const turn = await repositories.agentTurns.collection.findOne({ turnId });
    if (!turn || ["completed", "failed", "cancelled", "blocked"].includes(turn.status)) return publicTurn(turn);
    return publicTurn(doc(await repositories.agentTurns.collection.findOneAndUpdate(
      { turnId, status: turn.status },
      turn.status === "queued"
        ? { $set: { status: "cancelled", result: null, finishedAt: cancelledAt, updatedAt: cancelledAt } }
        : { $set: { internalStatus: "cancellation_requested", updatedAt: cancelledAt } },
      { returnDocument: "after" },
    )));
  }

  async getTurn(sessionId, turnId, access = {}) {
    const session = await this.getSession(sessionId, access);
    if (!session) return null;
    const repositories = await this.#repos();
    return publicTurn(await repositories.agentTurns.collection.findOne({ sessionId, turnId }));
  }

  async listTurns(sessionId, { after = 0, limit = 100 } = {}, access = {}) {
    if (!await this.getSession(sessionId, access)) return null;
    const repositories = await this.#repos();
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return (await repositories.agentTurns.collection.find({
      sessionId,
      sequence: { $gt: Number(after) || 0 },
    }).sort({ sequence: 1 }).limit(boundedLimit).toArray()).map(publicTurn);
  }

  async listEvents(sessionId, after = 0, limit = 500, access = {}) {
    if (!await this.getSession(sessionId, access)) return null;
    const repositories = await this.#repos();
    return (await repositories.agentSessionEvents.collection.find({ sessionId, sequence: { $gt: after } })
      .sort({ sequence: 1 }).limit(Math.min(Math.max(limit, 1), 1000)).toArray()).map(clean);
  }

  async findMainSession(userId, workspaceId) {
    const repositories = await this.#repos();
    return publicSession(await repositories.agentSessions.collection.findOne({ userId, workspaceId, definitionId: "main" }));
  }

  async createHandoff(handoff) {
    const repositories = await this.#repos();
    return repositories.agentHandoffs.insert(handoff);
  }

  async listHandoffs(targetSessionId) {
    const repositories = await this.#repos();
    return (await repositories.agentHandoffs.collection.find({ targetSessionId }).sort({ createdAt: -1 }).limit(500).toArray()).map(clean);
  }

  async confirmHandoff(targetSessionId, handoffId, confirmedAt) {
    const repositories = await this.#repos();
    return clean(doc(await repositories.agentHandoffs.collection.findOneAndUpdate(
      { targetSessionId, handoffId },
      { $set: { status: "confirmed", confirmedAt } },
      { returnDocument: "after" },
    )));
  }

  async recover() {
    const repositories = await this.#repos();
    const sessions = await repositories.agentSessions.collection.find({ activeTurnId: { $ne: null } }).toArray();
    const ids = [];
    for (const session of sessions) {
      const turn = await repositories.agentTurns.collection.findOne({ turnId: session.activeTurnId, status: "running" });
      if (turn?.internalStatus === "cancellation_requested") {
        await repositories.agentTurns.collection.updateOne(
          { turnId: session.activeTurnId, status: "running", internalStatus: "cancellation_requested" },
          {
            $set: {
              status: "cancelled",
              result: null,
              finishedAt: session.updatedAt,
              updatedAt: session.updatedAt,
            },
            $unset: { internalStatus: "" },
          },
        );
      } else {
        await repositories.agentTurns.collection.updateOne(
          { turnId: session.activeTurnId, status: "running" },
          { $set: { status: "queued", startedAt: null, updatedAt: session.updatedAt }, $unset: { internalStatus: "" } },
        );
        ids.push(session.sessionId);
      }
      await repositories.agentSessions.collection.updateOne(
        { sessionId: session.sessionId, activeTurnId: session.activeTurnId },
        { $set: { activeTurnId: null } },
      );
    }
    return ids;
  }
}

function internalRunnerTurn(value) {
  const result = clean(value);
  if (!result) return result;
  delete result.invocationIds;
  delete result.internalStatus;
  return result;
}
