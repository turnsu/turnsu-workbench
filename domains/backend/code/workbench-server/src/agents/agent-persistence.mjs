import { createHash } from "node:crypto";
import { CommandIntakeService } from "../coordination/command-intake-service.mjs";

const clone = (value) => value == null ? value : structuredClone(value);
const MAX_WAITING_TURNS_PER_USER = 3;
const SESSION_CURSOR_VERSION = 2;
const defaultClock = () => new Date().toISOString();

export const encodeAgentCursor = (kind, payload) => Buffer.from(
  JSON.stringify({ kind, ...payload }),
  "utf8",
).toString("base64url");

export const decodeAgentCursor = (kind, cursor) => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.kind !== kind) throw new Error();
    return value;
  } catch {
    const error = new Error("agent_cursor_invalid");
    error.code = "cursor_invalid";
    throw error;
  }
};

export const agentSessionQueryFingerprint = ({
  definitionId,
  taskStatus,
  search,
  archived = false,
  projectLoopTaskStatus = false,
} = {}, { userId, workspaceId } = {}) => createHash("sha256").update(JSON.stringify([
  userId ?? null,
  workspaceId ?? null,
  definitionId ?? null,
  taskStatus ?? null,
  normalizeSessionSearch(search),
  archived === true,
  projectLoopTaskStatus === true,
])).digest("base64url");

export const decodeAgentSessionCursor = (cursor, queryFingerprint) => {
  const value = decodeAgentCursor("sessions", cursor);
  if (!value) return null;
  if (value.version !== SESSION_CURSOR_VERSION
    || typeof value.snapshotAt !== "string"
    || typeof value.queryFingerprint !== "string"
    || value.queryFingerprint !== queryFingerprint
    || typeof value.createdAt !== "string"
    || typeof value.sessionId !== "string"
    || !validTimestamp(value.snapshotAt)
    || !validTimestamp(value.createdAt)
    || !value.createdAt
    || !value.sessionId) {
    throw agentSessionCursorInvalid();
  }
  return value;
};

export const pagedAgentItems = (items, page) => {
  Object.defineProperty(items, "page", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: page,
  });
  return items;
};

export class InMemoryAgentPersistence {
  constructor({ clock = defaultClock, commandIntake = null } = {}) {
    if (typeof clock !== "function") throw new TypeError("agent_clock_invalid");
    this.clock = clock;
    this.sessions = new Map();
    this.turns = new Map();
    this.messages = new Map();
    this.branches = new Map();
    this.events = new Map();
    this.contextEvents = new Map();
    this.handoffs = new Map();
    this.proposals = new Map();
    this.commands = new Map();
    this.admissions = new Map();
    this.recoveryCancellationIntents = [];
    this.stateTransactionTokens = new Set();
    this.commandRepository = new InMemoryProductCommandRepository(this.commands);
    this.commandIntake = commandIntake ?? new CommandIntakeService({
      store: {
        repositories: { productCommands: this.commandRepository },
        withTransaction: (work) => this.#withStateTransaction(work),
      },
      now: clock,
    });
  }

  async findSession(query) {
    const value = [...this.sessions.values()].find((session) => sameSessionScope(session, query));
    return publicSession(value ?? null);
  }

  async createBranch(branch) {
    this.branches.set(branch.branchId, clone(branch));
    return clone(branch);
  }

  async createModuleSession(branch, session) {
    const existing = [...this.sessions.values()].find((candidate) => (
      candidate.status === "active"
      && candidate.userId === session.userId
      && candidate.workspaceId === session.workspaceId
      && candidate.definitionId === session.definitionId
      && candidate.scope.kind === "module"
      && candidate.scope.objectKind === session.scope.objectKind
      && candidate.scope.objectId === session.scope.objectId
    ));
    if (existing) return publicSession(existing);
    this.branches.set(branch.branchId, clone(branch));
    this.sessions.set(session.sessionId, { ...clone(session), turnSequence: 0, messageSequence: 0, eventSequence: 0 });
    return publicSession(this.sessions.get(session.sessionId));
  }

  async createSession(session) {
    const existing = this.sessions.get(session.sessionId)
      || (session.source?.kind === "loop_run"
        ? [...this.sessions.values()].find((candidate) => candidate.source?.runId === session.source.runId)
        : null);
    if (existing) return publicSession(existing);
    this.sessions.set(session.sessionId, { ...clone(session), turnSequence: 0, messageSequence: 0, eventSequence: 0 });
    return publicSession(this.sessions.get(session.sessionId));
  }

  async listSessions({
    definitionId,
    taskStatus,
    search,
    archived = false,
    projectLoopTaskStatus = false,
    cursor,
    limit = 100,
  } = {}, access = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const queryFingerprint = agentSessionQueryFingerprint({
      definitionId,
      taskStatus,
      search,
      archived,
      projectLoopTaskStatus,
    }, access);
    const decoded = decodeAgentSessionCursor(cursor, queryFingerprint);
    const snapshotAt = decoded?.snapshotAt ?? clockTimestamp(this.clock);
    const normalizedSearch = normalizeSessionSearch(search);
    if (decoded && [...this.sessions.values()].some((session) => (
      canAccess(session, access)
      && (!definitionId || session.definitionId === definitionId)
      && session.createdAt <= snapshotAt
      && session.updatedAt >= snapshotAt
    ))) throw agentSessionCursorStale();
    const available = [...this.sessions.values()]
      .filter((session) => canAccess(session, access)
        && (!definitionId || session.definitionId === definitionId)
        && (!taskStatus
          || (projectLoopTaskStatus && session.source?.kind === "loop_run")
          || normalizedTaskStatus(session) === taskStatus)
        && (session.archived === true) === archived
        && (!normalizedSearch || publicSession(session).title.toLocaleLowerCase().includes(normalizedSearch))
        && session.createdAt <= snapshotAt
        && (!decoded
          || session.createdAt < decoded.createdAt
          || (session.createdAt === decoded.createdAt && session.sessionId < decoded.sessionId)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || right.sessionId.localeCompare(left.sessionId));
    const pageItems = available.slice(0, boundedLimit).map(publicSession);
    const hasMore = available.length > boundedLimit;
    return pagedAgentItems(pageItems, {
      snapshotAt,
      nextCursor: hasMore
        ? encodeAgentCursor("sessions", {
          version: SESSION_CURSOR_VERSION,
          snapshotAt,
          queryFingerprint,
          createdAt: pageItems.at(-1).createdAt,
          sessionId: pageItems.at(-1).sessionId,
        })
        : null,
      hasMore,
    });
  }

  async findSessionByRunId(runId, access = {}) {
    return publicSession([...this.sessions.values()].find((session) => (
      session.source?.kind === "loop_run"
      && session.source.runId === runId
      && canAccess(session, access)
    )) ?? null);
  }

  async getSession(sessionId, access = {}, _options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    return publicSession(session);
  }

  async updateSession({ sessionId, title, archived, updatedAt }, access = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    if (title !== undefined) session.title = title;
    if (archived !== undefined) session.archived = archived;
    session.updatedAt = updatedAt;
    return publicSession(session);
  }

  async updateSessionModel(sessionId, modelProfileId, updatedAt) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastUsedModelProfileId = modelProfileId;
    session.modelPreferenceState = "preference_only";
    delete session.modelProfileId;
    session.updatedAt = updatedAt;
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
    session.taskStatus = session.activeTurnId ? "running" : "queued";
    const value = { ...clone(turn), sequence: session.turnSequence, invocationIds: [] };
    this.turns.set(turn.turnId, value);
    return publicTurn(value);
  }

  async createQueuedTurn({
    turn,
    message,
    event,
    command = null,
    admission = null,
    modelProfileId = null,
    transactionSession = null,
  }) {
    return this.#inStateTransaction(transactionSession, async (activeTransaction) => {
      const persistTarget = async () => {
        const existing = this.turns.get(turn.turnId);
        if (existing) {
          if (existing.productCommandId !== command?.commandId) {
            throw new Error("agent_turn_identity_conflict");
          }
          return publicTurn(existing);
        }
        const session = this.sessions.get(turn.sessionId);
        if (!session || session.status !== "active") throw new Error("agent_session_not_found");
        const waitingCount = [...this.admissions.values()].filter((item) => (
          item.userId === admission?.userId
          && item.workspaceId === admission?.workspaceId
          && item.queueSlotHeld === true
        )).length;
        if (admission && waitingCount >= MAX_WAITING_TURNS_PER_USER) {
          throw admissionQueueFull(turn.sessionId);
        }
        session.turnSequence += 1;
        session.messageSequence += 1;
        session.eventSequence += 1;
        session.updatedAt = turn.updatedAt;
        session.taskStatus = session.activeTurnId ? "running" : "queued";
        if (session.turnSequence === 1 && isDefaultTaskTitle(session.title)) {
          session.title = taskTitleFromMessage(message.content);
        }
        if (modelProfileId) {
          session.lastUsedModelProfileId = modelProfileId;
          session.modelPreferenceState = "preference_only";
          delete session.modelProfileId;
        }
        const queuedTurn = { ...clone(turn), sequence: session.turnSequence, invocationIds: [] };
        const queuedMessage = { ...clone(message), sequence: session.messageSequence };
        const queuedEvent = { ...clone(event), sequence: session.eventSequence };
        this.turns.set(turn.turnId, queuedTurn);
        if (admission) this.admissions.set(admission.admissionId, clone(admission));
        this.messages.set(turn.sessionId, [...(this.messages.get(turn.sessionId) ?? []), queuedMessage]);
        this.events.set(turn.sessionId, [...(this.events.get(turn.sessionId) ?? []), queuedEvent]);
        return publicTurn(queuedTurn);
      };
      if (!command) return persistTarget();
      const accepted = await this.commandIntake.accept({
        principal: { userId: command.userId, workspaceId: command.workspaceId },
        command,
        persistTarget,
        loadTarget: async () => publicTurn(this.turns.get(turn.turnId) ?? null),
        at: command.createdAt ?? turn.queuedAt,
        session: activeTransaction,
      });
      return accepted.target;
    });
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
    return (this.messages.get(sessionId) ?? []).slice(-10_000).map(clone);
  }

  async getLatestContextEvent(sessionId, { status } = {}) {
    return clone((this.contextEvents.get(sessionId) ?? [])
      .filter((item) => !status || item.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null);
  }

  async appendContextEvent(event) {
    const existing = (this.contextEvents.get(event.sessionId) ?? []).find((item) => (
      item.status === "completed"
      && event.status === "completed"
      && item.sourceHash === event.sourceHash
      && item.promptRevision === event.promptRevision
      && item.modelProfileRevisionId === event.modelProfileRevisionId
    ));
    if (existing) return clone(existing);
    const items = this.contextEvents.get(event.sessionId) ?? [];
    items.push(clone(event));
    this.contextEvents.set(event.sessionId, items);
    return clone(event);
  }

  async deleteContextEvents(sessionId) {
    const deletedCount = (this.contextEvents.get(sessionId) ?? []).length;
    this.contextEvents.delete(sessionId);
    return { deletedCount };
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

  /**
   * Semantic Product-ledger owner for Harness model-visible events. The
   * caller provides a fully projected Agent Session event; this method only
   * allocates the existing authoritative Session sequence and makes retrying
   * the same Kernel event idempotent. It creates no Harness-side store.
   */
  async appendModelVisibleEvent({ sessionId, turnId, productCommandId, event } = {}) {
    assertModelVisibleEventTarget({ sessionId, turnId, productCommandId, event });
    const session = this.sessions.get(sessionId);
    const turn = this.turns.get(turnId);
    if (!session || !turn || turn.sessionId !== sessionId) throw coded("agent_session_not_found");
    if (turn.productCommandId !== productCommandId) throw coded("agent_kernel_event_command_mismatch");
    const existing = (this.events.get(sessionId) ?? []).find((item) => item.eventId === event.eventId);
    if (existing) {
      if (!sameModelVisibleEvent(existing, event)) throw coded("agent_kernel_event_identity_conflict");
      return clone(existing);
    }
    return this.appendEvent(sessionId, (sequence) => ({ ...clone(event), sequence }));
  }

  async claimNextTurn(sessionId, startedAt, eventFactory = null) {
    return this.#withStateTransaction(async (transactionSession) => {
      const session = this.sessions.get(sessionId);
      if (!session || session.activeTurnId) return null;
      const turn = [...this.turns.values()]
        .filter((entry) => entry.sessionId === sessionId && entry.status === "queued")
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (!turn) return null;
      const startedEvent = typeof eventFactory === "function"
        ? eventFactory(session.eventSequence + 1, runnerTurn(turn))
        : null;
      session.activeTurnId = turn.turnId;
      session.taskStatus = "running";
      session.updatedAt = startedAt;
      turn.status = "running";
      turn.startedAt = startedAt;
      turn.updatedAt = startedAt;
      if (turn.productCommandId) {
        await this.commandIntake.start({
          principal: { userId: session.userId, workspaceId: session.workspaceId },
          commandId: turn.productCommandId,
          at: startedAt,
          session: transactionSession,
        });
      }
      const admission = [...this.admissions.values()].find((entry) => entry.turnId === turn.turnId);
      if (admission) {
        admission.state = "running";
        admission.queueSlotHeld = false;
        admission.updatedAt = startedAt;
      }
      if (startedEvent) {
        session.eventSequence += 1;
        this.events.set(sessionId, [
          ...(this.events.get(sessionId) ?? []),
          clone(startedEvent),
        ]);
      }
      return runnerTurn(turn);
    });
  }

  async addInvocation(turnId, invocationId, updatedAt) {
    const turn = this.turns.get(turnId);
    if (!turn.invocationIds.includes(invocationId)) turn.invocationIds.push(invocationId);
    turn.updatedAt = updatedAt;
  }

  async getTurnInvocations(turnId) {
    return clone(this.turns.get(turnId)?.invocationIds ?? []);
  }

  async settleTurn({
    turnId,
    sessionEpoch,
    turnFence,
    status,
    result,
    finishedAt,
    routing = {},
    message,
    event,
    handoff = null,
    proposal = null,
  }) {
    return this.#withStateTransaction(async (transactionSession) => {
      const turn = this.turns.get(turnId);
      if (!turn) return null;
      if (!["running", "cancellation_requested"].includes(turn.internalStatus ?? turn.status)) {
        return publicTurn(turn);
      }
      const session = this.sessions.get(turn.sessionId);
      if (!session || session.activeTurnId !== turnId) return null;
      const cancellationWon = turn.internalStatus === "cancellation_requested";
      if (!cancellationWon && (
        (sessionEpoch !== undefined && (session.sessionEpoch ?? 1) !== sessionEpoch)
        || (turnFence !== undefined && (turn.turnFence ?? 1) !== turnFence)
      )) return null;
    const effectiveStatus = cancellationWon ? "cancelled" : status;
    const effectiveResult = cancellationWon ? null : result;
    const effectiveRouting = cancellationWon
      ? { actualModelRevisionId: null, artifactRefs: [] }
      : routing;
    const terminalMessage = cancellationWon
      ? { ...clone(message), content: "Turn cancelled." }
      : clone(message);
    const terminalEvent = cancellationWon
      ? {
          ...clone(event),
          type: "turn.cancelled",
          status: "cancelled",
          summary: "Turn cancelled.",
        }
      : clone(event);
    if (proposal && effectiveStatus === "completed") {
      assertSettlementProposal(proposal, turn, effectiveResult);
    }

    turn.status = effectiveStatus;
    turn.internalStatus = effectiveStatus;
    turn.result = clone(effectiveResult);
    turn.actualModelRevisionId = effectiveRouting.actualModelRevisionId ?? null;
    turn.artifactRefs = clone(effectiveRouting.artifactRefs ?? []);
    turn.finishedAt = finishedAt;
    turn.updatedAt = finishedAt;
    session.activeTurnId = null;
    session.taskStatus = effectiveStatus;
    session.updatedAt = finishedAt;
    session.messageSequence += 1;
    session.eventSequence += 1;
    this.messages.set(turn.sessionId, [
      ...(this.messages.get(turn.sessionId) ?? []),
      { ...terminalMessage, sequence: session.messageSequence },
    ]);
    this.events.set(turn.sessionId, [
      ...(this.events.get(turn.sessionId) ?? []),
      { ...terminalEvent, sequence: session.eventSequence },
    ]);
    if (handoff && effectiveStatus === "completed") {
      this.handoffs.set(handoff.handoffId, clone(handoff));
    }
    if (proposal && effectiveStatus === "completed") {
      this.proposals.set(proposal.proposalId, clone(proposal));
    }
      if (turn.productCommandId) {
        await this.commandIntake.settle({
          principal: { userId: session.userId, workspaceId: session.workspaceId },
          commandId: turn.productCommandId,
          status: effectiveStatus,
          at: finishedAt,
          session: transactionSession,
        });
      }
    const admission = [...this.admissions.values()].find((entry) => entry.turnId === turn.turnId);
    if (admission) {
      admission.state = effectiveStatus === "cancelled" ? "cancelled" : "released";
      admission.updatedAt = finishedAt;
      admission.releasedAt = finishedAt;
    }
      return publicTurn(turn);
    });
  }

  requestCancelWithEvent(turnId, cancelledAt, eventFactory, {
    command = null,
    transactionSession = null,
  } = {}) {
    return this.#requestCancellation({
      turnId,
      cancelledAt,
      eventFactory,
      command,
      transactionSession,
    });
  }

  async requestCancel(turnId, cancelledAt, { transactionSession = null } = {}) {
    const cancellation = await this.#requestCancellation({
      turnId,
      cancelledAt,
      eventFactory: null,
      command: null,
      transactionSession,
    });
    return cancellation.turn;
  }

  #requestCancellation({ turnId, cancelledAt, eventFactory, command, transactionSession }) {
    return this.#inStateTransaction(transactionSession, async (activeTransaction) => {
      const turn = this.turns.get(turnId);
      if (!turn || ["completed", "failed", "cancelled", "blocked"].includes(turn.status)) {
        return { turn: publicTurn(turn ?? null), event: null, replayed: true };
      }
      if (turn.cancellationCommandId) {
        return { turn: publicTurn(turn), event: null, replayed: true };
      }
      const session = this.sessions.get(turn.sessionId);
      if (!session) throw new Error("agent_session_not_found");
      const cancellationCommand = command ?? (turn.productCommandId ? {
        schemaVersion: "workbench-v1",
        commandId: `cancel:${turn.productCommandId}`,
        kind: "cancel_agent_turn",
        targetCommandId: turn.productCommandId,
        userId: session.userId,
        workspaceId: session.workspaceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
      } : null);
      const persistTarget = async () => {
        if (turn.status === "queued") {
          turn.status = "cancelled";
          turn.result = null;
          turn.finishedAt = cancelledAt;
          session.taskStatus = "cancelled";
        } else {
          turn.internalStatus = "cancellation_requested";
          turn.turnFence = (turn.turnFence ?? 1) + 1;
          session.taskStatus = "running";
        }
        if (cancellationCommand) turn.cancellationCommandId = cancellationCommand.commandId;
        turn.updatedAt = cancelledAt;
        session.updatedAt = cancelledAt;
        for (const proposal of this.proposals.values()) {
          if (proposal.turnId === turnId
            && proposal.sessionId === turn.sessionId
            && proposal.status === "proposed") {
            this.proposals.delete(proposal.proposalId);
          }
        }
        let event = null;
        if (typeof eventFactory === "function") {
          session.eventSequence += 1;
          event = eventFactory(session.eventSequence, publicTurn(turn));
          this.events.set(turn.sessionId, [
            ...(this.events.get(turn.sessionId) ?? []),
            clone(event),
          ]);
        }
        const admission = [...this.admissions.values()].find((entry) => entry.turnId === turn.turnId);
        if (admission) {
          admission.state = turn.status === "cancelled" ? "cancelled" : "cancellation_requested";
          if (turn.status === "cancelled") admission.queueSlotHeld = false;
          admission.updatedAt = cancelledAt;
          if (turn.status === "cancelled") admission.releasedAt = cancelledAt;
        }
        return { turn: publicTurn(turn), event: clone(event) };
      };
      if (!cancellationCommand || !turn.productCommandId) {
        return { ...(await persistTarget()), replayed: false };
      }
      const accepted = await this.commandIntake.acceptCancellation({
        principal: { userId: session.userId, workspaceId: session.workspaceId },
        command: cancellationCommand,
        targetCommandId: turn.productCommandId,
        targetStatus: turn.status === "queued" ? "cancelled" : "cancellation_requested",
        persistTarget,
        at: cancelledAt,
        session: activeTransaction,
      });
      return { ...accepted.target, replayed: accepted.replayed };
    });
  }

  async getTurn(sessionId, turnId, access = {}) {
    const session = this.sessions.get(sessionId);
    const turn = this.turns.get(turnId);
    if (!session || !turn || turn.sessionId !== sessionId || !canAccess(session, access)) return null;
    return publicTurn(turn);
  }

  async listTurns(sessionId, { after, cursor, limit = 100 } = {}, access = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const decoded = decodeAgentCursor("turns", cursor);
    const cursorDirection = decoded?.direction
      ?? (Number.isInteger(decoded?.afterSequence) ? "forward" : "backward");
    if (decoded && !new Set(["forward", "backward"]).has(cursorDirection)) {
      const error = new Error("agent_cursor_invalid");
      error.code = "cursor_invalid";
      throw error;
    }
    if (Number.isInteger(after) && decoded && cursorDirection !== "forward") {
      const error = new Error("agent_cursor_invalid");
      error.code = "cursor_invalid";
      throw error;
    }
    const forward = Number.isInteger(after) || cursorDirection === "forward";
    const afterSequence = Math.max(
      Number.isInteger(after) ? after : -1,
      Number.isInteger(decoded?.afterSequence) ? decoded.afterSequence : -1,
    );
    const values = [...this.turns.values()]
      .filter((turn) => turn.sessionId === sessionId
        && (forward
          ? turn.sequence > afterSequence
          : turn.sequence < (decoded?.beforeSequence ?? Number.POSITIVE_INFINITY)))
      .sort((left, right) => forward
        ? left.sequence - right.sequence
        : right.sequence - left.sequence);
    const selected = values.slice(0, boundedLimit);
    if (!forward) selected.reverse();
    const pageItems = selected.map(publicTurn);
    const hasMore = values.length > boundedLimit;
    return pagedAgentItems(pageItems, {
      nextCursor: hasMore
        ? encodeAgentCursor("turns", forward
          ? { direction: "forward", afterSequence: pageItems.at(-1).sequence }
          : { direction: "backward", beforeSequence: pageItems[0].sequence })
        : null,
      hasMore,
    });
  }

  async listEvents(sessionId, queryOrAfter = {}, limitOrAccess = 500, accessMaybe = {}) {
    const query = typeof queryOrAfter === "object"
      ? queryOrAfter
      : { after: queryOrAfter, limit: limitOrAccess };
    const access = typeof queryOrAfter === "object" ? limitOrAccess : accessMaybe;
    const session = this.sessions.get(sessionId);
    if (!session || !canAccess(session, access)) return null;
    const boundedLimit = Math.min(Math.max(Number(query.limit) || 500, 1), 1000);
    const decoded = decodeAgentCursor("events", query.cursor);
    const cursorDirection = decoded?.direction
      ?? (Number.isInteger(decoded?.afterSequence) ? "forward" : "backward");
    if (decoded && !new Set(["forward", "backward"]).has(cursorDirection)) {
      const error = new Error("agent_cursor_invalid");
      error.code = "cursor_invalid";
      throw error;
    }
    if (Number.isInteger(query.after) && decoded && cursorDirection !== "forward") {
      const error = new Error("agent_cursor_invalid");
      error.code = "cursor_invalid";
      throw error;
    }
    const forward = Number.isInteger(query.after) || cursorDirection === "forward";
    const afterSequence = Math.max(
      Number.isInteger(query.after) ? query.after : -1,
      Number.isInteger(decoded?.afterSequence) ? decoded.afterSequence : -1,
    );
    const values = (this.events.get(sessionId) ?? [])
      .filter((event) => forward
        ? event.sequence > afterSequence
        : event.sequence < (decoded?.beforeSequence ?? Number.POSITIVE_INFINITY))
      .sort((left, right) => forward
        ? left.sequence - right.sequence
        : right.sequence - left.sequence);
    const selected = values.slice(0, boundedLimit);
    if (!forward) selected.reverse();
    const pageItems = selected.map(clone);
    const hasMore = values.length > boundedLimit;
    return pagedAgentItems(pageItems, {
      nextCursor: hasMore
        ? encodeAgentCursor("events", forward
          ? { direction: "forward", afterSequence: pageItems.at(-1).sequence }
          : { direction: "backward", beforeSequence: pageItems[0].sequence })
        : null,
      hasMore,
    });
  }

  async findMainSession(userId, workspaceId) {
    return publicSession([...this.sessions.values()]
      .filter((session) => (
        session.userId === userId
        && session.workspaceId === workspaceId
        && session.definitionId === "main"
        && session.status === "active"
        && session.source?.kind !== "loop_run"
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null);
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
    const sessionIds = new Set();
    this.recoveryCancellationIntents = [];
    for (const session of this.sessions.values()) {
      const turn = session.activeTurnId
        ? this.turns.get(session.activeTurnId)
        : null;
      if (turn?.status === "running") {
        if (turn.internalStatus === "cancellation_requested") {
          this.recoveryCancellationIntents.push({
            sessionId: session.sessionId,
            turnId: turn.turnId,
            invocationIds: clone(turn.invocationIds ?? []),
            requestedAt: turn.updatedAt ?? session.updatedAt,
          });
        } else {
          await this.#withStateTransaction(async (transactionSession) => {
            turn.status = "queued";
            turn.startedAt = null;
            if (turn.productCommandId) {
              await this.commandIntake.requeue({
                principal: { userId: session.userId, workspaceId: session.workspaceId },
                commandId: turn.productCommandId,
                at: session.updatedAt,
                session: transactionSession,
              });
            }
            const admission = [...this.admissions.values()].find((entry) => entry.turnId === turn.turnId);
            if (admission) {
              admission.state = "waiting_session_turn";
              admission.queueSlotHeld = true;
            }
            session.activeTurnId = null;
          });
        }
      }
      if (turn?.internalStatus !== "cancellation_requested") session.activeTurnId = null;
      if ([...this.turns.values()].some((item) => (
        item.sessionId === session.sessionId && item.status === "queued"
      ))) {
        session.taskStatus = "queued";
        sessionIds.add(session.sessionId);
      }
    }
    return [...sessionIds];
  }

  takeRecoveryCancellationIntents() {
    const intents = clone(this.recoveryCancellationIntents);
    this.recoveryCancellationIntents = [];
    return intents;
  }

  withTransaction(work) {
    if (typeof work !== "function") throw new TypeError("in_memory_agent_transaction_work_required");
    return this.#withStateTransaction(work);
  }

  #inStateTransaction(transactionSession, work) {
    if (!transactionSession) return this.#withStateTransaction(work);
    if (!this.stateTransactionTokens.has(transactionSession)) {
      throw new TypeError("in_memory_agent_transaction_invalid");
    }
    return work(transactionSession);
  }

  async #withStateTransaction(work) {
    const stateMaps = [
      this.sessions,
      this.turns,
      this.messages,
      this.branches,
      this.events,
      this.contextEvents,
      this.handoffs,
      this.proposals,
      this.commands,
      this.admissions,
    ];
    const snapshots = stateMaps.map((map) => clone([...map.entries()]));
    const transactionSession = { inMemoryAgentTransaction: true };
    this.stateTransactionTokens.add(transactionSession);
    try {
      return await work(transactionSession);
    } catch (error) {
      for (let index = 0; index < stateMaps.length; index += 1) {
        stateMaps[index].clear();
        for (const [key, value] of snapshots[index]) stateMaps[index].set(key, value);
      }
      throw error;
    } finally {
      this.stateTransactionTokens.delete(transactionSession);
    }
  }
}

class InMemoryProductCommandRepository {
  constructor(commands) {
    this.commands = commands;
  }

  async get({ commandId, workspaceId, userId }) {
    const command = this.commands.get(commandId);
    return command?.workspaceId === workspaceId && command?.userId === userId
      ? clone(command)
      : null;
  }

  async insertAccepted(command) {
    if (this.commands.has(command.commandId)) throw new Error("product_command_identity_conflict");
    const accepted = { ...clone(command), status: "accepted", finishedAt: null };
    this.commands.set(accepted.commandId, accepted);
    return clone(accepted);
  }

  async compareAndSet({ commandId, workspaceId, userId }, expectedStatuses, patch) {
    const command = this.commands.get(commandId);
    if (!command
      || command.workspaceId !== workspaceId
      || command.userId !== userId
      || !expectedStatuses.includes(command.status)) return null;
    Object.assign(command, clone(patch));
    return clone(command);
  }
}

function admissionQueueFull(sessionId) {
  const error = new Error("admission_queue_full");
  error.code = "admission_queue_full";
  error.status = "conflict";
  error.retryable = true;
  error.details = {
    reasonCode: "admission_queue_full",
    recoveryAction: "inspect_queue",
    method: "GET",
    path: `/api/workbench/v1/agent-sessions/${encodeURIComponent(sessionId)}/queue`,
  };
  return error;
}

export function publicSession(session) {
  if (!session) return null;
  const value = clone(session);
  if (!Object.hasOwn(value, "modelPreferenceState")) {
    value.lastUsedModelProfileId = value.lastUsedModelProfileId ?? value.modelProfileId ?? null;
    value.modelPreferenceState = "legacy_unpinned";
  }
  value.title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim().slice(0, 200)
    : "Untitled task";
  value.source = value.source?.kind === "loop_run"
    ? value.source
    : { kind: "manual" };
  value.taskStatus = value.taskStatus
    ?? (value.activeTurnId ? "running" : "idle");
  value.archived = value.archived === true;
  delete value.modelProfileId;
  delete value.turnSequence;
  delete value.messageSequence;
  delete value.eventSequence;
  delete value._id;
  return value;
}

export function publicTurn(turn) {
  if (!turn) return null;
  const value = clone(turn);
  if (value.modelRoutingState !== "pinned") {
    return {
      schemaVersion: value.schemaVersion,
      turnId: value.turnId,
      sessionId: value.sessionId,
      sequence: value.sequence,
      status: value.status,
      modelRoutingState: "legacy_unpinned",
      message: value.message,
      result: value.result ?? null,
      queuedAt: value.queuedAt,
      startedAt: value.startedAt ?? null,
      finishedAt: value.finishedAt ?? null,
      updatedAt: value.updatedAt,
    };
  }
  delete value.invocationIds;
  delete value.internalStatus;
  delete value.modelCapability;
  delete value.contextWindowTokens;
  delete value.toolApprovalResume;
  delete value._id;
  if (value.productCommandId == null) delete value.productCommandId;
  if (value.cancellationCommandId == null) delete value.cancellationCommandId;
  return value;
}

export function assertSettlementProposal(proposal, turn, result) {
  if (!proposal
    || typeof proposal.proposalId !== "string"
    || !proposal.proposalId
    || proposal.sessionId !== turn.sessionId
    || proposal.turnId !== turn.turnId
    || proposal.status !== "proposed"
    || result?.proposalId !== proposal.proposalId) {
    throw new Error("agent_proposal_settlement_invalid");
  }
}

function runnerTurn(turn) {
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

function assertModelVisibleEventTarget({ sessionId, turnId, productCommandId, event }) {
  if (typeof sessionId !== "string" || !sessionId
    || typeof turnId !== "string" || !turnId
    || typeof productCommandId !== "string" || !productCommandId
    || !event || typeof event !== "object"
    || event.sessionId !== sessionId
    || event.turnId !== turnId
    || event.productCommandId !== productCommandId
    || typeof event.eventId !== "string" || !event.eventId
    || !event.modelVisibleEvent || typeof event.modelVisibleEvent !== "object") {
    throw coded("agent_kernel_event_invalid");
  }
}

function sameModelVisibleEvent(existing, event) {
  return existing.sessionId === event.sessionId
    && existing.turnId === event.turnId
    && existing.productCommandId === event.productCommandId
    && existing.modelVisibleEvent?.eventId === event.modelVisibleEvent?.eventId;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeSessionSearch(search) {
  const value = String(search ?? "").trim().toLocaleLowerCase();
  return value || null;
}

function normalizedTaskStatus(session) {
  return session.taskStatus ?? (session.activeTurnId ? "running" : "idle");
}

function clockTimestamp(clock) {
  const value = clock();
  const timestamp = value instanceof Date ? value.toISOString() : String(value);
  if (!validTimestamp(timestamp)) throw new TypeError("agent_clock_invalid");
  return timestamp;
}

function validTimestamp(value) {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function agentSessionCursorInvalid() {
  const error = new Error("agent_cursor_invalid");
  error.code = "cursor_invalid";
  return error;
}

function agentSessionCursorStale() {
  const error = new Error("agent_cursor_stale");
  error.code = "cursor_stale";
  error.retryable = true;
  error.details = { recoveryAction: "restart_pagination" };
  return error;
}

function sameSessionScope(session, query) {
  if (!canAccess(session, query) || session.definitionId !== query.definitionId) return false;
  if (session.scope.kind !== query.scope.kind) return false;
  if (session.scope.kind === "main") return true;
  return session.scope.objectKind === query.scope.objectKind
    && session.scope.objectId === query.scope.objectId
    && (!query.scope.branchId || session.scope.branchId === query.scope.branchId);
}

function isDefaultTaskTitle(value) {
  return !value || ["Untitled task", "New task", "新任务"].includes(String(value).trim());
}

function taskTitleFromMessage(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  return (title || "Untitled task").slice(0, 72);
}
