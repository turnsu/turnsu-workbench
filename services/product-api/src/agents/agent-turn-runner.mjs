import { getBuiltinAgentDefinition } from "./agent-definitions.mjs";
import { ConversationTurnCoordinator } from "../coordination/conversation-turn-coordinator.mjs";
import {
  AgentContextCapsuleManager,
  condensationRequestInput,
  parseCondensationOutput,
} from "./agent-context-capsule.mjs";
import { createProductAgentSessionPort } from "../runtime/product-session-port.mjs";

const SCHEMA_VERSION = "workbench-v1";
const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);

export class AgentTurnRunnerError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "AgentTurnRunnerError";
    this.code = code;
    this.details = details;
  }
}

export class AgentTurnRunner {
  #persistence;
  #executionBroker;
  #executor;
  #clock;
  #idFactory;
  #resolveBaseVersion;
  #resolveModelSelection;
  #authorizeObject;
  #commandAuthorizer;
  #contextCapsules;
  #coordinator;

  constructor({
    persistence,
    executionBroker = null,
    executor = null,
    clock = () => new Date().toISOString(),
    idFactory,
    resolveBaseVersion,
    resolveModelSelection,
    authorizeObject = null,
    commandAuthorizer = null,
    contextCapsuleManager = null,
  } = {}) {
    if (!persistence || typeof persistence.createSession !== "function") {
      throw new TypeError("agent_persistence_required");
    }
    for (const method of ["createQueuedTurn", "settleTurn", "requestCancelWithEvent"]) {
      if (typeof persistence[method] !== "function") {
        throw new TypeError(`agent_persistence_${method}_required`);
      }
    }
    if (typeof idFactory !== "function" || typeof resolveBaseVersion !== "function") {
      throw new TypeError("agent_id_factory_and_version_resolver_required");
    }
    if (typeof resolveModelSelection !== "function") {
      throw new TypeError("agent_model_selection_resolver_required");
    }
    if (authorizeObject !== null && typeof authorizeObject !== "function") {
      throw new TypeError("agent_object_authorizer_invalid");
    }
    if (commandAuthorizer !== null
      && (typeof commandAuthorizer.authorizeAgentTurn !== "function"
        || typeof commandAuthorizer.authorizeCancellation !== "function")) {
      throw new TypeError("agent_command_authorizer_invalid");
    }
    this.#persistence = persistence;
    this.#executionBroker = executionBroker;
    this.#executor = executor;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#resolveBaseVersion = resolveBaseVersion;
    this.#resolveModelSelection = resolveModelSelection;
    this.#authorizeObject = authorizeObject ?? (async () => {
      throw new AgentTurnRunnerError(
        "agent_object_authorizer_unavailable",
        "Module Agent object authorization is unavailable.",
      );
    });
    this.#commandAuthorizer = commandAuthorizer;
    this.#contextCapsules = contextCapsuleManager ?? (
      typeof persistence.getLatestContextEvent === "function"
      && typeof persistence.appendContextEvent === "function"
        ? new AgentContextCapsuleManager({ persistence, clock, idFactory })
        : null
    );
    this.#coordinator = new ConversationTurnCoordinator({
      clock,
      adapter: {
        recover: () => this.#persistence.recover(),
        claimNextTurn: (sessionId, startedAt) => this.#persistence.claimNextTurn(
          sessionId,
          startedAt,
          (sequence, claimedTurn) => ({
            schemaVersion: SCHEMA_VERSION,
            eventId: this.#idFactory("agent-event"),
            sessionId,
            turnId: claimedTurn.turnId,
            sequence,
            type: "turn.started",
            status: "running",
            summary: "Agent turn started.",
            occurredAt: startedAt,
            productCommandId: claimedTurn.productCommandId,
          }),
        ),
        loadSession: (sessionId) => this.#persistence.getSession(sessionId),
        executeTurn: (input) => this.#executeClaimedTurn(input),
        handleTurnError: (input) => this.#handleClaimedTurnError(input),
      },
    });
  }

  async recover() {
    const sessionIds = new Set(await this.#persistence.recover());
    const cancellationIntents = typeof this.#persistence.takeRecoveryCancellationIntents === "function"
      ? this.#persistence.takeRecoveryCancellationIntents()
      : [];
    for (const intent of cancellationIntents) {
      await this.afterCancellationCommitted({
        sessionId: intent.sessionId,
        turnId: intent.turnId,
        reason: "startup_recovery",
        invocationIds: intent.invocationIds,
      });
      const finishedAt = this.#clock();
      await this.#persistence.settleTurn({
        turnId: intent.turnId,
        status: "cancelled",
        result: null,
        finishedAt,
        message: {
          schemaVersion: SCHEMA_VERSION,
          messageId: this.#idFactory("agent-message"),
          sessionId: intent.sessionId,
          turnId: intent.turnId,
          role: "assistant",
          kind: "result",
          content: "Turn cancelled.",
          createdAt: finishedAt,
        },
        event: {
          schemaVersion: SCHEMA_VERSION,
          eventId: this.#idFactory("agent-event"),
          sessionId: intent.sessionId,
          turnId: intent.turnId,
          type: "turn.cancelled",
          status: "cancelled",
          summary: "Turn cancelled.",
          occurredAt: finishedAt,
          productCommandId: intent.productCommandId ?? null,
        },
      });
      sessionIds.add(intent.sessionId);
    }
    for (const sessionId of sessionIds) this.#coordinator.schedule(sessionId);
    return [...sessionIds];
  }

  async createSession({
    definitionId,
    sessionId: requestedSessionId = null,
    title = "",
    source = { kind: "manual" },
    objectKind,
    objectId,
    branchId = null,
    lastUsedModelProfileId = null,
    modelProfileId = null,
    userId,
    workspaceId,
    transactionSession = null,
  }) {
    const definition = getBuiltinAgentDefinition(definitionId);
    if (!definition) throw new AgentTurnRunnerError("agent_definition_not_found", "Agent definition not found.");
    if (!userId || !workspaceId) throw new AgentTurnRunnerError("agent_session_scope_invalid");

    if (definition.kind === "main") {
      if (objectKind || objectId) throw new AgentTurnRunnerError("main_agent_object_forbidden");
      const normalizedSource = normalizeTaskSource(source);
      if (normalizedSource.kind === "loop_run"
        && typeof this.#persistence.findSessionByRunId === "function") {
        const existing = await this.#persistence.findSessionByRunId(
          normalizedSource.runId,
          { userId, workspaceId },
        );
        if (existing) return existing;
      }
      const now = this.#clock();
      return this.#persistence.createSession({
        schemaVersion: SCHEMA_VERSION,
        sessionId: requestedSessionId || this.#idFactory("agent-session"),
        definitionId,
        userId,
        workspaceId,
        scope: { kind: "main" },
        title: normalizeTaskTitle(title, normalizedSource),
        source: normalizedSource,
        taskStatus: normalizedSource.kind === "loop_run" ? "queued" : "idle",
        archived: false,
        status: "active",
        lastUsedModelProfileId: lastUsedModelProfileId ?? modelProfileId ?? null,
        modelPreferenceState: "preference_only",
        activeTurnId: null,
        sessionEpoch: 1,
        createdAt: now,
        updatedAt: now,
      }, { uow: transactionSession });
    }

    if (!definition.objectKinds.includes(objectKind) || !objectId) {
      throw new AgentTurnRunnerError("module_agent_object_invalid", "This module Agent cannot operate on that object.");
    }
    await this.#authorizeObject({ objectKind, objectId, userId, workspaceId });
    if (branchId) {
      const branch = await this.#persistence.getBranch(branchId);
      if (!branch
        || branch.userId !== userId
        || branch.workspaceId !== workspaceId
        || branch.objectKind !== objectKind
        || branch.objectId !== objectId
        || branch.status !== "active") {
        throw new AgentTurnRunnerError("agent_branch_not_found", "Agent branch not found.");
      }
      const resumed = await this.#persistence.findSession({
        userId,
        workspaceId,
        definitionId,
        scope: { kind: "module", objectKind, objectId, branchId },
      });
      if (resumed?.status === "active") {
        return this.#applyModelSelection(resumed, lastUsedModelProfileId ?? modelProfileId);
      }
      const now = this.#clock();
      return this.#persistence.createSession({
        schemaVersion: SCHEMA_VERSION,
        sessionId: this.#idFactory("agent-session"),
        definitionId,
        userId,
        workspaceId,
        scope: { kind: "module", objectKind, objectId, branchId, baseVersionId: branch.baseVersionId },
        title: normalizeTaskTitle(title || definition.label, { kind: "manual" }),
        source: { kind: "manual" },
        taskStatus: "idle",
        archived: false,
        status: "active",
        lastUsedModelProfileId: lastUsedModelProfileId ?? modelProfileId ?? null,
        modelPreferenceState: "preference_only",
        activeTurnId: null,
        sessionEpoch: 1,
        createdAt: now,
        updatedAt: now,
      }, { uow: transactionSession });
    }
    const existing = await this.#persistence.findSession({
      userId,
      workspaceId,
      definitionId,
      scope: { kind: "module", objectKind, objectId },
    });
    if (existing?.status === "active") {
      return this.#applyModelSelection(existing, lastUsedModelProfileId ?? modelProfileId);
    }

    const resolvedBase = await this.#resolveBaseVersion({
      objectKind,
      objectId,
      userId,
      workspaceId,
    });
    const baseVersionId = typeof resolvedBase === "string"
      ? resolvedBase
      : resolvedBase?.baseVersionId;
    if (!baseVersionId) throw new AgentTurnRunnerError("agent_object_not_found", "Agent object not found.");
    const now = this.#clock();
    const newBranchId = this.#idFactory("agent-branch");
    const newBranch = {
      schemaVersion: SCHEMA_VERSION,
      branchId: newBranchId,
      userId,
      workspaceId,
      objectKind,
      objectId,
      baseVersionId,
      ...(resolvedBase?.baseSnapshot
        ? { baseSnapshot: structuredClone(resolvedBase.baseSnapshot) }
        : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const newSession = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.#idFactory("agent-session"),
      definitionId,
      userId,
      workspaceId,
      scope: { kind: "module", objectKind, objectId, branchId: newBranchId, baseVersionId },
      title: normalizeTaskTitle(title || definition.label, { kind: "manual" }),
      source: { kind: "manual" },
      taskStatus: "idle",
      archived: false,
      status: "active",
      lastUsedModelProfileId: lastUsedModelProfileId ?? modelProfileId ?? null,
      modelPreferenceState: "preference_only",
      activeTurnId: null,
      sessionEpoch: 1,
      createdAt: now,
      updatedAt: now,
    };
    if (typeof this.#persistence.createModuleSession === "function") {
      return this.#persistence.createModuleSession(newBranch, newSession, { uow: transactionSession });
    }
    await this.#persistence.createBranch(newBranch, { uow: transactionSession });
    return this.#persistence.createSession(newSession, { uow: transactionSession });
  }

  getSession(sessionId, access) {
    return this.#persistence.getSession(sessionId, access);
  }

  listSessions(query, access) {
    if (typeof this.#persistence.listSessions !== "function") {
      throw new AgentTurnRunnerError("agent_session_history_unavailable");
    }
    return this.#persistence.listSessions(query, access);
  }

  async updateSession({ sessionId, title, archived, userId, workspaceId, transactionSession = null }) {
    if (typeof this.#persistence.updateSession !== "function") {
      throw new AgentTurnRunnerError("agent_session_update_unavailable");
    }
    const session = await this.#requireSession(sessionId, { userId, workspaceId });
    const updated = await this.#persistence.updateSession({
      sessionId: session.sessionId,
      ...(title !== undefined ? { title: normalizeUpdatedTaskTitle(title) } : {}),
      ...(archived !== undefined ? { archived: archived === true } : {}),
      updatedAt: this.#clock(),
    }, { userId, workspaceId }, { uow: transactionSession });
    if (!updated) throw new AgentTurnRunnerError("agent_session_not_found", "Agent session not found.");
    return updated;
  }

  async selectModel({ sessionId, lastUsedModelProfileId = null, modelProfileId = null, userId, workspaceId }) {
    const session = await this.#requireSession(sessionId, { userId, workspaceId });
    if (session.status !== "active") throw new AgentTurnRunnerError("agent_session_closed");
    return this.#applyModelSelection(session, lastUsedModelProfileId ?? modelProfileId);
  }

  async enqueueTurn({
    sessionId,
    turnId: requestedTurnId,
    productCommandId: requestedProductCommandId = null,
    workItemId = null,
    workItemTarget = null,
    continuationTurnTarget = null,
    kind,
    modelProfileId,
    modelProfileRevisionId,
    input,
    userId,
    workspaceId,
    transactionSession = null,
    internalCommand = null,
  }) {
    if (requestedProductCommandId !== null
      && (typeof requestedProductCommandId !== "string" || !requestedProductCommandId.trim())) {
      throw new AgentTurnRunnerError("agent_product_command_id_invalid");
    }
    if (workItemId !== null && (typeof workItemId !== "string" || !workItemId.trim())) {
      throw new AgentTurnRunnerError("agent_work_item_id_invalid");
    }
    if (workItemTarget !== null && (workItemId === null
      || !workItemTarget || typeof workItemTarget !== "object" || Array.isArray(workItemTarget))) {
      throw new AgentTurnRunnerError("agent_work_item_target_invalid");
    }
    if (continuationTurnTarget !== null && (workItemId === null
      || !continuationTurnTarget || typeof continuationTurnTarget !== "object"
      || Array.isArray(continuationTurnTarget))) {
      throw new AgentTurnRunnerError("agent_work_item_continuation_target_invalid");
    }
    if (workItemId === null && continuationTurnTarget !== null) {
      throw new AgentTurnRunnerError("agent_work_item_continuation_target_invalid");
    }
    if (workItemTarget !== null && continuationTurnTarget !== null) {
      throw new AgentTurnRunnerError("agent_work_item_target_conflict");
    }
    const internal = normalizeInternalCommand(internalCommand);
    let session = await this.#requireSession(sessionId, { userId, workspaceId }, transactionSession);
    if (session.status !== "active") throw new AgentTurnRunnerError("agent_session_closed");
    await this.#assertWorkItemContinuationAccess(session, transactionSession);
    if (session.scope.kind === "module") {
      await this.#authorizeObject({
        objectKind: session.scope.objectKind,
        objectId: session.scope.objectId,
        userId,
        workspaceId,
      });
    }
    const definition = getBuiltinAgentDefinition(session.definitionId);
    const normalizedInput = normalizeTurnInput(kind, input);
    const hasImageAttachment = kind === "agent_message"
      && normalizedInput.attachments?.some((ref) =>
        String(ref.mediaType).startsWith("image/"));
    const requiredCapabilities = kind === "model_task"
      ? ["image_generation"]
      : definition?.kind === "module"
        ? ["chat", "tool_calling", "structured_output"]
        : ["chat", "tool_calling", ...(hasImageAttachment ? ["image_input"] : [])];
    const selection = await this.#resolveModelSelection({
      workspaceId,
      userId,
      session: structuredClone(session),
      kind,
      modelProfileId,
      modelProfileRevisionId,
      requiredCapabilities: [...requiredCapabilities],
    });
    const requestedModelRevisionId = exactResolvedRevision(selection, modelProfileRevisionId);
    const modelCapability = kind === "model_task"
      ? "image_generation"
      : hasImageAttachment
        ? "image_input"
      : selection?.capability ?? "tool_calling";
    if (!requiredCapabilities.includes(modelCapability)) {
      throw new AgentTurnRunnerError("agent_model_capability_invalid");
    }
    const selectedProfileId = selection?.profileId ?? selection?.profile?.profileId ?? null;
    const now = this.#clock();
    const turnId = requestedTurnId || this.#idFactory("agent-turn");
    const productCommandId = requestedProductCommandId ?? (requestedTurnId
      ? `product-command:${turnId}`
      : this.#idFactory("product-command"));
    const admissionId = this.#idFactory("admission");
    const sessionEpoch = session.sessionEpoch ?? 1;
    const turnInput = {
      schemaVersion: SCHEMA_VERSION,
      turnId,
      sessionId,
      productCommandId,
      sessionEpoch,
      turnFence: 1,
      kind,
      status: "queued",
      modelRoutingState: "pinned",
      requestedModelRevisionId,
      actualModelRevisionId: null,
      artifactRefs: [],
      input: normalizedInput,
      modelCapability,
      contextWindowTokens: modelContextLimit(selection),
      result: null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      ...(internal ? { toolApprovalResume: structuredClone(internal.toolApprovalResume) } : {}),
    };
    const message = {
      schemaVersion: SCHEMA_VERSION,
      messageId: this.#idFactory("agent-message"),
      sessionId,
      turnId,
      role: "user",
      // A resumed approval is still a user-visible Turn. Its immutable
      // approval/command lineage lives on the Product command and approval
      // aggregate rather than widening the historic message-kind enum.
      kind: "turn",
      content: internal?.message ?? turnMessageContent(turnInput),
      createdAt: now,
    };
    const event = {
      schemaVersion: SCHEMA_VERSION,
      eventId: this.#idFactory("agent-event"),
      sessionId,
      turnId,
      type: "turn.queued",
      status: "queued",
      summary: internal ? "Approved Tool action queued to resume the Agent turn." : "Agent turn queued.",
      occurredAt: now,
      productCommandId: productCommandId,
    };
    const commandAuthority = internal?.authority ?? (this.#commandAuthorizer
      ? await this.#commandAuthorizer.authorizeAgentTurn({
          workspaceId,
          userId,
          sessionId,
          turnId,
          workItemId,
          workItemTarget: workItemTarget === null ? null : structuredClone(workItemTarget),
          continuationTurnTarget: continuationTurnTarget === null
            ? null
            : structuredClone(continuationTurnTarget),
          input: normalizedInput,
          uow: transactionSession,
        })
      : null);
    const command = {
      schemaVersion: SCHEMA_VERSION,
      commandId: productCommandId,
      kind: internal?.kind ?? "agent_turn",
      userId,
      workspaceId,
      sessionId,
      turnId,
      ...(workItemId === null ? {} : { workItemId }),
      ...(continuationTurnTarget === null ? {} : { continuationTurnTarget }),
      ...(internal ? { toolApprovalId: internal.toolApprovalId } : {}),
      status: "accepted",
      createdAt: commandAuthority?.authorizedAt ?? now,
      updatedAt: commandAuthority?.authorizedAt ?? now,
      finishedAt: null,
      ...(commandAuthority ? {
        scopeId: commandAuthority.scopeId,
        authorizationDecisionId: commandAuthority.authorizationDecisionId,
        argumentDigest: commandAuthority.argumentDigest,
      } : {}),
    };
    const admission = {
      schemaVersion: SCHEMA_VERSION,
      admissionId,
      commandId: productCommandId,
      kind: "command_turn",
      invocationId: null,
      userId,
      workspaceId,
      sessionId,
      turnId,
      state: "waiting_session_turn",
      queueSlotHeld: true,
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
    };
    const turn = await this.#persistence.createQueuedTurn({
      turn: turnInput,
      message,
      event,
      command,
      admission,
      modelProfileId: typeof selectedProfileId === "string" && selectedProfileId.length > 0
        ? selectedProfileId
        : null,
      transactionSession,
    });
    if (!transactionSession) this.#coordinator.schedule(sessionId);
    return turn;
  }

  /**
   * A Tool approval never mutates a blocked Turn in-place. The explicit
   * decision command creates a linked continuation Turn, and the Worker uses
   * the exact approved Tool/input digest when it invokes Kernel.resume.
   */
  async resumeApprovedTool({
    approval,
    commandAuthority,
    commandId,
    turnId,
    transactionSession = null,
  } = {}) {
    const resume = normalizeApprovalResume({ approval, commandAuthority, commandId, turnId });
    const session = await this.#requireSession(resume.sessionId, {
      userId: resume.userId,
      workspaceId: resume.workspaceId,
    }, transactionSession);
    const source = await this.#persistence.getTurn(
      resume.sessionId,
      resume.sourceTurnId,
      { userId: resume.userId, workspaceId: resume.workspaceId },
    );
    if (!source) throw new AgentTurnRunnerError("agent_tool_approval_source_turn_not_found");
    if (source.status !== "blocked") {
      throw new AgentTurnRunnerError("agent_tool_approval_source_turn_not_blocked");
    }
    return this.enqueueTurn({
      sessionId: session.sessionId,
      turnId: resume.turnId,
      productCommandId: resume.commandId,
      kind: source.kind,
      modelProfileRevisionId: source.requestedModelRevisionId,
      input: structuredClone(source.input),
      userId: resume.userId,
      workspaceId: resume.workspaceId,
      transactionSession,
      internalCommand: {
        kind: "agent_tool_approval_decide",
        toolApprovalId: resume.approvalId,
        authority: resume.commandAuthority,
        toolApprovalResume: {
          approvalId: resume.approvalId,
          toolId: resume.toolId,
          inputDigest: resume.inputDigest,
        },
        message: `Approved governed Tool action ${resume.toolId}; resuming the original Agent request.`,
      },
    });
  }

  async steer({ sessionId, turnId, message, userId, workspaceId }) {
    await this.#requireSession(sessionId, { userId, workspaceId });
    const active = this.#coordinator.activeTurn(sessionId);
    if (!active || active.turn.turnId !== turnId) {
      throw new AgentTurnRunnerError("agent_turn_not_running", "Steering only applies to the current running turn.");
    }
    const now = this.#clock();
    await this.#persistence.appendMessage({
      schemaVersion: SCHEMA_VERSION,
      messageId: this.#idFactory("agent-message"),
      sessionId,
      turnId,
      role: "user",
      kind: "steer",
      content: String(message).trim(),
      createdAt: now,
    });
    await Promise.resolve(this.#executor?.steer?.({ session: active.session, turn: active.turn, message, signal: active.controller.signal }));
    await this.#appendEvent(sessionId, turnId, "turn.steered", "running", "Current Agent turn steered.", active.turn.productCommandId);
    return this.#persistence.getTurn(sessionId, turnId, { userId, workspaceId });
  }

  getTurn(sessionId, turnId, access) {
    return this.#persistence.getTurn(sessionId, turnId, access);
  }

  listTurns(sessionId, query, access) {
    if (typeof this.#persistence.listTurns !== "function") {
      throw new AgentTurnRunnerError("agent_turn_history_unavailable");
    }
    return this.#persistence.listTurns(sessionId, query, access);
  }

  listEvents(sessionId, queryOrAfter, limitOrAccess, accessMaybe) {
    return this.#persistence.listEvents(
      sessionId,
      queryOrAfter,
      limitOrAccess,
      accessMaybe,
    );
  }

  listMessages(sessionId, access) {
    return this.#persistence.listMessages(sessionId, access);
  }

  async cancelTurn({
    sessionId,
    turnId,
    userId,
    workspaceId,
    reason,
    transactionSession = null,
  }) {
    await this.#requireSession(sessionId, { userId, workspaceId });
    const current = await this.#persistence.getTurn(sessionId, turnId, { userId, workspaceId });
    if (!current) throw new AgentTurnRunnerError("agent_turn_not_found", "Agent turn not found.");
    if (TERMINAL.has(current.status)) return current;

    const now = this.#clock();
    const cancellationCommandId = this.#idFactory("product-command");
    const commandAuthority = this.#commandAuthorizer
      ? await this.#commandAuthorizer.authorizeCancellation({
          workspaceId,
          userId,
          sessionId,
          turnId,
          targetCommandId: current.productCommandId,
          reason,
          uow: transactionSession,
        })
      : null;
    const cancellationCommand = {
      schemaVersion: SCHEMA_VERSION,
      commandId: cancellationCommandId,
      kind: "cancel_agent_turn",
      targetCommandId: current.productCommandId,
      userId,
      workspaceId,
      sessionId,
      turnId,
      status: "completed",
      createdAt: commandAuthority?.authorizedAt ?? now,
      updatedAt: commandAuthority?.authorizedAt ?? now,
      finishedAt: commandAuthority?.authorizedAt ?? now,
      ...(commandAuthority ? {
        scopeId: commandAuthority.scopeId,
        authorizationDecisionId: commandAuthority.authorizationDecisionId,
        argumentDigest: commandAuthority.argumentDigest,
      } : {}),
    };
    const cancellation = typeof this.#persistence.requestCancelWithEvent === "function"
      ? await this.#persistence.requestCancelWithEvent(
          turnId,
          now,
          (sequence, requested) => ({
            schemaVersion: SCHEMA_VERSION,
            eventId: this.#idFactory("agent-event"),
            sessionId,
            turnId,
            sequence,
            type: requested.status === "cancelled"
              ? "turn.cancelled"
              : "turn.cancellation_requested",
            status: requested.status,
            summary: requested.status === "cancelled"
              ? "Turn cancelled."
              : "Agent turn cancellation requested.",
            occurredAt: now,
            productCommandId: cancellationCommand.commandId,
          }),
          { command: cancellationCommand, transactionSession },
        )
      : {
          turn: await this.#persistence.requestCancel(turnId, now),
          event: null,
        };
    const requested = cancellation.event && cancellation.turn
      ? { ...cancellation.turn, cancellationCommandId }
      : cancellation.turn;
    if (!requested) {
      const latest = await this.#persistence.getTurn(sessionId, turnId, { userId, workspaceId });
      if (TERMINAL.has(latest?.status)) return latest;
      throw new AgentTurnRunnerError(
        "agent_turn_cancel_conflict",
        "The Agent turn changed while cancellation was requested.",
      );
    }
    if (cancellation.replayed) return requested;
    if (!cancellation.event && TERMINAL.has(requested?.status)) return requested;
    if (!cancellation.event) {
      await this.#appendEvent(
        sessionId,
        turnId,
        requested.status === "cancelled" ? "turn.cancelled" : "turn.cancellation_requested",
        requested.status,
        requested.status === "cancelled" ? "Turn cancelled." : "Agent turn cancellation requested.",
        cancellationCommand.commandId,
      );
    }
    if (!transactionSession) {
      await this.afterCancellationCommitted({ sessionId, turnId, reason, turn: requested });
    }
    return requested;
  }

  async afterCancellationCommitted({
    sessionId,
    turnId,
    reason,
    turn = null,
    invocationIds = null,
  }) {
    const durableInvocationIds = invocationIds
      ?? await this.#persistence.getTurnInvocations(turnId);
    if (durableInvocationIds.length > 0 && typeof this.#executionBroker?.cancel !== "function") {
      throw new AgentTurnRunnerError("agent_cancellation_dispatch_unavailable");
    }
    const invocationResults = await Promise.all(durableInvocationIds.map(async (invocationId) => ({
      invocationId,
      result: await this.#executionBroker.cancel(invocationId, { reason }),
    })));
    this.#coordinator.abort(
      sessionId,
      turnId,
      new AgentTurnRunnerError("agent_turn_cancelled"),
    );
    if (turn?.status === "cancelled") this.#coordinator.schedule(sessionId);
    return { status: "dispatched", invocationResults };
  }

  async listHandoffs({ sessionId, userId, workspaceId }) {
    const session = await this.#requireSession(sessionId, { userId, workspaceId });
    if (session.definitionId !== "main") throw new AgentTurnRunnerError("agent_handoff_target_invalid");
    return this.#persistence.listHandoffs(sessionId);
  }

  async confirmHandoff({ sessionId, handoffId, userId, workspaceId }) {
    const session = await this.#requireSession(sessionId, { userId, workspaceId });
    if (session.definitionId !== "main") throw new AgentTurnRunnerError("agent_handoff_target_invalid");
    const handoff = await this.#persistence.confirmHandoff(sessionId, handoffId, this.#clock());
    if (!handoff) throw new AgentTurnRunnerError("agent_handoff_not_found");
    return handoff;
  }

  async waitForIdle(sessionId) {
    await this.#coordinator.waitForIdle(sessionId);
  }

  schedule(sessionId) {
    this.#coordinator.schedule(sessionId);
  }

  async #executeClaimedTurn({ session, turn, signal }) {
        await this.#assertWorkItemContinuationAccess(session);
        if (session.scope.kind === "module") {
          await this.#authorizeObject({
            objectKind: session.scope.objectKind,
            objectId: session.scope.objectId,
            userId: session.userId,
            workspaceId: session.workspaceId,
          });
        }
        if (turn.kind === "model_task") {
          const result = await this.#executeModelTask(session, turn, signal);
          const status = signal.aborted
            ? "cancelled"
            : modelTaskTurnStatus(result?.status);
          await this.#finish(turn, status, status === "completed"
            ? {
                result: result.output,
                requestedModelRevisionId: result.requestedModelRevisionId,
                actualModelRevisionId: result.actualModelRevisionId,
                artifactRefs: result.artifactRefs,
                usage: result.usage,
              }
            : {});
          return;
        }
        if (turn.input.attachments?.length > 0
          && (session.definitionId !== "main" || this.#executor?.handlesTextAttachments !== true
            || turn.input.attachments.some((attachment) => attachment.mediaType.startsWith("image/")))) {
          const result = await this.#executeAttachmentTurn(
            session,
            turn,
            signal,
          );
          const status = signal.aborted
            ? "cancelled"
            : modelTaskTurnStatus(result?.status);
          await this.#finish(turn, status, status === "completed"
            ? {
                response: chatResultText(result.output),
                requestedModelRevisionId: result.requestedModelRevisionId,
                actualModelRevisionId: result.actualModelRevisionId,
                artifactRefs: result.artifactRefs,
                usage: result.usage,
              }
            : {});
          return;
        }
        if (typeof this.#executor?.execute !== "function") {
          await this.#finish(turn, "blocked", { response: "Agent execution backend is unavailable." });
          return;
        }
        const messages = await this.#contextMessages(session, turn, signal);
        const result = await this.#executor.execute({
          session: structuredClone(session),
          turn: structuredClone(turn),
          messages,
          signal,
          runWorkers: (requests) => this.#runWorkers(session, turn, requests, signal),
        });
        if (signal.aborted) {
          await this.#finish(turn, "cancelled", { response: "Turn cancelled." });
        } else {
          await this.#finish(turn, result?.status === "blocked" ? "blocked" : "completed", result ?? {});
        }
  }

  async #handleClaimedTurnError({ turn, error, aborted }) {
    const status = aborted ? "cancelled" : error?.status === "blocked" ? "blocked" : "failed";
    await this.#finish(turn, status, { response: safeTurnFailure(status) });
  }

  async #runWorkers(session, turn, requests, signal) {
    if (!this.#executionBroker || typeof this.#executionBroker.execute !== "function") {
      throw new AgentTurnRunnerError("execution_broker_unavailable", "Execution Broker is unavailable.");
    }
    if (!Array.isArray(requests) || requests.length === 0) return [];
    return Promise.all(requests.map(async (request) => {
      const invocationId = this.#idFactory("invocation");
      const attemptId = this.#idFactory("execution-attempt");
      const kernelSessionReplay = await this.#kernelSessionReplay(session, turn, request);
      const normalized = normalizeWorkerRequest(kernelSessionReplay
        ? {
            ...request,
            input: {
              ...(request.input ?? {}),
              kernelSessionReplay,
            },
          }
        : request, {
        invocationId,
        attemptId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: session.sessionId,
        turnId: turn.turnId,
        productCommandId: turn.productCommandId,
      });
      await this.#persistence.addInvocation(turn.turnId, invocationId, this.#clock());
      return this.#executionBroker.execute(normalized, { signal });
    }));
  }

  async #kernelSessionReplay(session, turn, request) {
    // The Minimal Pi profile is currently the bounded Product Agent slice.
    // Other execution modes keep their explicitly selected legacy profile
    // until their own bridge is migrated; this is not a runtime fallback.
    if (request?.mode !== "bounded_agent" || (request?.isolation ?? "container") !== "container") return null;
    const sessionRef = {
      sessionId: session.sessionId,
      branchId: session.scope?.kind === "module" ? session.scope.branchId : null,
    };
    const port = createProductAgentSessionPort({
      persistence: this.#persistence,
      session,
      turn,
      productCommandId: turn.productCommandId,
    });
    const events = [];
    let bytes = 0;
    for await (const event of port.replay(sessionRef)) {
      const encoded = JSON.stringify(event);
      const eventBytes = Buffer.byteLength(encoded, "utf8");
      if (eventBytes > 100_000) continue;
      while (events.length >= 256 || bytes + eventBytes > 1_000_000) {
        const removed = events.shift();
        bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      }
      events.push(event);
      bytes += eventBytes;
    }
    return Object.freeze({
      schemaVersion: "agent-kernel-session-replay-v1",
      session: sessionRef,
      events: Object.freeze(events.map((event) => Object.freeze(structuredClone(event)))),
      checkpoint: await port.checkpoint(sessionRef),
    });
  }

  async #executeModelTask(session, turn, signal) {
    const { task: _task, ...typedInput } = turn.input;
    const [result] = await this.#runWorkers(session, turn, [{
      mode: "model_call",
      isolation: "process",
      goal: "Generate a governed image artifact from the pinned model revision.",
      input: typedInput,
      modelProfileRevisionId: turn.requestedModelRevisionId,
      modelCapability: "image_generation",
      fallbackModelProfileRevisionIds: [],
      limits: {
        timeoutMs: 120_000,
        maxSteps: 1,
        maxModelRequests: 1,
        maxChildren: 0,
        maxInputBytes: 1_000_000,
        maxOutputBytes: 100_000_000,
        maxImageCount: 1,
        maxCostUsdMicros: 10_000_000,
      },
      capabilities: emptyModelCallCapabilities(),
      resultSchema: imageGenerationResultSchema(),
      evidenceRequirements: [{
        requirementId: "model-output-artifact",
        kind: "artifact",
        required: true,
        description: "The generated image must be committed as a governed Artifact.",
      }],
      metadata: {
        agentSessionId: session.sessionId,
        agentTurnId: turn.turnId,
        modelProfileRevisionId: turn.requestedModelRevisionId,
        modelCapability: "image_generation",
        fallbackModelProfileRevisionIds: [],
      },
    }], signal);
    return result;
  }

  async #executeAttachmentTurn(session, turn, signal) {
    const messages = await this.#contextMessages(session, turn, signal);
    const [result] = await this.#runWorkers(session, turn, [{
      mode: "model_call",
      isolation: "process",
      goal: "Understand governed user attachments and answer the current Agent turn.",
      input: {
        messages: chatMessages(messages),
        tools: [],
      },
      modelProfileRevisionId: turn.requestedModelRevisionId,
      modelCapability: turn.modelCapability,
      fallbackModelProfileRevisionIds: [],
      limits: {
        timeoutMs: 120_000,
        maxSteps: 1,
        maxModelRequests: 1,
        maxChildren: 0,
        maxInputBytes: 64_000_000,
        maxOutputBytes: 1_000_000,
        maxImageCount: 8,
        maxCostUsdMicros: 10_000_000,
      },
      capabilities: emptyModelCallCapabilities(),
      resultSchema: {
        type: "object",
        properties: {
          content: { type: "array" },
          toolCalls: { type: "array" },
        },
        required: ["content", "toolCalls"],
        additionalProperties: true,
      },
      evidenceRequirements: [],
      metadata: {
        agentSessionId: session.sessionId,
        agentTurnId: turn.turnId,
        requestedBy: session.userId,
        attachmentRefs: structuredClone(turn.input.attachments),
        modelProfileRevisionId: turn.requestedModelRevisionId,
        modelCapability: turn.modelCapability,
        fallbackModelProfileRevisionIds: [],
      },
    }], signal);
    return result;
  }

  async #contextMessages(session, turn, signal) {
    const messages = await this.#persistence.listMessages(session.sessionId, {
      userId: session.userId,
      workspaceId: session.workspaceId,
    });
    const continuationContext = typeof this.#persistence.getWorkItemContinuationContext === "function"
      ? await this.#persistence.getWorkItemContinuationContext(session.sessionId, {
          userId: session.userId,
          workspaceId: session.workspaceId,
        })
      : null;
    const persistedMessages = Array.isArray(messages) ? messages : [];
    if (!this.#contextCapsules) {
      return continuationContext ? [continuationContext, ...persistedMessages] : persistedMessages;
    }
    const assembled = await this.#contextCapsules.assemble({
      session,
      turn,
      messages: persistedMessages,
      condense: (input) => this.#condenseContext(session, turn, input, signal),
    });
    return continuationContext ? [continuationContext, ...assembled] : assembled;
  }

  async #assertWorkItemContinuationAccess(session, transactionSession = null) {
    if (typeof this.#persistence.assertWorkItemContinuationAccess !== "function") return false;
    return this.#persistence.assertWorkItemContinuationAccess({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      userId: session.userId,
    }, { uow: transactionSession });
  }

  async #condenseContext(session, turn, input, signal) {
    const invocationId = this.#idFactory("context-condensation-invocation");
    const attemptId = this.#idFactory("context-condensation-attempt");
    await this.#persistence.addInvocation(turn.turnId, invocationId, this.#clock());
    const [result] = await Promise.all([this.#executionBroker.execute(normalizeWorkerRequest({
      mode: "model_call",
      isolation: "process",
      goal: "Condense older Agent transcript messages into an auditable, untrusted Context Capsule.",
      input: condensationRequestInput(input),
      modelProfileRevisionId: turn.requestedModelRevisionId,
      modelCapability: "structured_output",
      fallbackModelProfileRevisionIds: [],
      limits: {
        timeoutMs: 60_000,
        maxSteps: 1,
        maxModelRequests: 1,
        maxChildren: 0,
        maxInputBytes: 4_000_000,
        maxOutputBytes: 1_000_000,
        maxImageCount: 0,
        maxCostUsdMicros: 10_000_000,
      },
      capabilities: emptyModelCallCapabilities(),
      resultSchema: { type: "object", additionalProperties: true },
      evidenceRequirements: [],
      metadata: {
        agentSessionId: session.sessionId,
        agentTurnId: turn.turnId,
        maintenanceKind: "context_condensation",
        modelProfileRevisionId: turn.requestedModelRevisionId,
        modelCapability: "structured_output",
        fallbackModelProfileRevisionIds: [],
      },
    }, {
      invocationId,
      attemptId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      productCommandId: turn.productCommandId,
    }), { signal })]);
    if (result?.status !== "completed"
      || result.requestedModelRevisionId !== turn.requestedModelRevisionId
      || result.actualModelRevisionId !== turn.requestedModelRevisionId) {
      const error = new AgentTurnRunnerError("agent_context_condensation_failed");
      error.invocationId = invocationId;
      throw error;
    }
    return parseCondensationOutput(result.output, invocationId);
  }

  async #finish(turn, status, rawResult) {
    const invocationIds = await this.#persistence.getTurnInvocations(turn.turnId);
    const requestedModelRevisionId = turn.requestedModelRevisionId;
    const actualModelRevisionId = rawResult?.actualModelRevisionId ?? null;
    const artifactRefs = safeArtifactRefs(rawResult?.artifactRefs, turn.kind === "model_task" ? 16 : 256);
    const usage = safeExecutionUsage(rawResult?.usage);
    const modelTaskResult = turn.kind === "model_task"
      ? safeImageModelResult(rawResult?.result, {
          requestedModelRevisionId,
          actualModelRevisionId,
          artifactRefs,
        })
      : null;
    if (status === "completed" && (actualModelRevisionId !== requestedModelRevisionId
      || rawResult?.requestedModelRevisionId !== requestedModelRevisionId
      || (turn.kind === "model_task" && !modelTaskResult))) {
      status = "failed";
    }
    let handoff = null;
    if (status === "completed" && rawResult?.handoff) {
      handoff = await this.#prepareHandoff(turn.sessionId, rawResult.handoff);
    }
    const handoffId = handoff?.handoffId ?? null;
    const result = status !== "completed"
      ? null
      : turn.kind === "model_task"
        ? {
            kind: "model_task",
            result: modelTaskResult,
            invocationIds,
            requestedModelRevisionId,
            actualModelRevisionId,
            artifactRefs,
            usage,
          }
        : {
            kind: "agent_message",
            response: String(rawResult?.response || safeTurnFailure(status)).slice(0, 20_000),
            proposalId: rawResult?.proposalId ?? null,
            handoffId,
            invocationIds,
            requestedModelRevisionId,
            actualModelRevisionId,
            artifactRefs,
            usage,
          };
    const finishedAt = this.#clock();
    const terminalSummary = (
      result?.kind === "agent_message" ? result.response : safeTurnFailure(status)
    ).slice(0, 4000);
    const completed = await this.#persistence.settleTurn({
      turnId: turn.turnId,
      sessionEpoch: turn.sessionEpoch,
      turnFence: turn.turnFence,
      status,
      result,
      finishedAt,
      routing: { actualModelRevisionId, artifactRefs },
      message: {
        schemaVersion: SCHEMA_VERSION,
        messageId: this.#idFactory("agent-message"),
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        role: "assistant",
        kind: "result",
        content: result?.kind === "agent_message"
          ? result.response
          : status === "completed"
            ? "Image generation completed."
            : safeTurnFailure(status),
        createdAt: finishedAt,
      },
      event: {
        schemaVersion: SCHEMA_VERSION,
        eventId: this.#idFactory("agent-event"),
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        type: `turn.${status}`,
        status,
        summary: terminalSummary,
        occurredAt: finishedAt,
        productCommandId: turn.productCommandId,
      },
      handoff,
      proposal: status === "completed" ? rawResult?.proposal ?? null : null,
    });
    return completed;
  }

  async #prepareHandoff(sourceSessionId, capsule) {
    const source = await this.#persistence.getSession(sourceSessionId);
    if (!source || source.scope.kind !== "module") throw new AgentTurnRunnerError("agent_handoff_source_invalid");
    const target = await this.#persistence.findMainSession(source.userId, source.workspaceId);
    if (!target) throw new AgentTurnRunnerError("main_agent_session_required");
    const handoffId = this.#idFactory("agent-handoff");
    return {
      schemaVersion: SCHEMA_VERSION,
      handoffId,
      sourceSessionId,
      targetSessionId: target.sessionId,
      status: "pending",
      importantState: stringList(capsule.importantState),
      decisions: stringList(capsule.decisions),
      risks: stringList(capsule.risks),
      artifactRefs: stringList(capsule.artifactRefs),
      createdAt: this.#clock(),
      confirmedAt: null,
    };
  }

  async #appendEvent(sessionId, turnId, type, status, summary, productCommandId = null) {
    return this.#persistence.appendEvent(sessionId, (sequence) => ({
      schemaVersion: SCHEMA_VERSION,
      eventId: this.#idFactory("agent-event"),
      sessionId,
      turnId,
      sequence,
      type,
      status,
      summary,
      occurredAt: this.#clock(),
      ...(productCommandId ? { productCommandId } : {}),
    }));
  }

  async #requireSession(sessionId, access, transactionSession = null) {
    const session = await this.#persistence.getSession(sessionId, access, { uow: transactionSession });
    if (!session) throw new AgentTurnRunnerError("agent_session_not_found", "Agent session not found.");
    return session;
  }

  async #applyModelSelection(session, modelProfileId) {
    if (!modelProfileId || session.lastUsedModelProfileId === modelProfileId) return session;
    if (typeof this.#persistence.updateSessionModel !== "function") {
      throw new AgentTurnRunnerError("agent_model_selection_unavailable");
    }
    return this.#persistence.updateSessionModel(session.sessionId, modelProfileId, this.#clock());
  }
}

function normalizeWorkerRequest(request, {
  invocationId,
  attemptId,
  workspaceId,
  userId,
  sessionId,
  turnId,
  productCommandId,
}) {
  const mode = request?.mode ?? "bounded_agent";
  const normalized = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId,
    workspaceId,
    actor: { userId },
    lineage: { productCommandId: productCommandId ?? turnId, sessionId, turnId },
    controller: { kind: "agent_turn", controllerId: turnId, fence: 1 },
    mode,
    isolation: request?.isolation ?? "container",
    goal: String(request?.goal || "Execute bounded Agent work."),
    input: request?.input ?? {},
    limits: request?.limits ?? {
      timeoutMs: 60_000,
      maxSteps: 32,
      maxModelRequests: mode === "deterministic_skill" ? 0 : 16,
      maxChildren: mode === "agent_orchestrator" ? 4 : 0,
      maxDepth: mode === "agent_orchestrator" ? 2 : 0,
      maxSpawnedChildren: mode === "agent_orchestrator" ? 100 : 0,
      maxToolResultChars: 320_000,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxImageCount: 0,
      maxCostUsdMicros: 0,
    },
    capabilities: request?.capabilities ?? {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: request?.resultSchema ?? { type: "object", additionalProperties: true },
    evidenceRequirements: request?.evidenceRequirements ?? [],
    metadata: request?.metadata ?? {},
  };
  if (mode === "model_call") {
    normalized.modelProfileRevisionId = request.modelProfileRevisionId;
    normalized.modelCapability = request.modelCapability;
    normalized.fallbackModelProfileRevisionIds = request.fallbackModelProfileRevisionIds ?? [];
  }
  return normalized;
}

function normalizeInternalCommand(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.kind !== "agent_tool_approval_decide"
    || typeof value.toolApprovalId !== "string" || !value.toolApprovalId
    || !value.authority || typeof value.authority !== "object"
    || !value.toolApprovalResume || typeof value.toolApprovalResume !== "object"
    || typeof value.message !== "string" || !value.message.trim()) {
    throw new AgentTurnRunnerError("agent_tool_approval_internal_command_invalid");
  }
  const authority = value.authority;
  if (![authority.scopeId, authority.authorizationDecisionId, authority.argumentDigest, authority.authorizedAt]
    .every((item) => typeof item === "string" && item.length > 0)
    || !/^sha256:[a-f0-9]{64}$/.test(authority.argumentDigest)) {
    throw new AgentTurnRunnerError("agent_tool_approval_internal_authority_invalid");
  }
  const resume = value.toolApprovalResume;
  if (resume.approvalId !== value.toolApprovalId
    || typeof resume.toolId !== "string" || !resume.toolId
    || typeof resume.inputDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(resume.inputDigest)) {
    throw new AgentTurnRunnerError("agent_tool_approval_internal_resume_invalid");
  }
  return Object.freeze({
    kind: value.kind,
    toolApprovalId: value.toolApprovalId,
    authority: Object.freeze({
      scopeId: authority.scopeId,
      authorizationDecisionId: authority.authorizationDecisionId,
      argumentDigest: authority.argumentDigest,
      authorizedAt: authority.authorizedAt,
    }),
    toolApprovalResume: Object.freeze({
      approvalId: resume.approvalId,
      toolId: resume.toolId,
      inputDigest: resume.inputDigest,
    }),
    message: value.message.trim().slice(0, 20_000),
  });
}

function normalizeApprovalResume({ approval, commandAuthority, commandId, turnId }) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)
    || typeof commandId !== "string" || !commandId
    || typeof turnId !== "string" || !turnId
    || !commandAuthority || typeof commandAuthority !== "object") {
    throw new AgentTurnRunnerError("agent_tool_approval_resume_invalid");
  }
  const required = [
    approval.approvalId,
    approval.workspaceId,
    approval.userId,
    approval.sessionId,
    approval.sourceTurnId,
    approval.toolId,
    approval.inputDigest,
  ];
  if (required.some((item) => typeof item !== "string" || !item)
    || !/^sha256:[a-f0-9]{64}$/.test(approval.inputDigest)) {
    throw new AgentTurnRunnerError("agent_tool_approval_resume_invalid");
  }
  const authority = normalizeInternalCommand({
    kind: "agent_tool_approval_decide",
    toolApprovalId: approval.approvalId,
    authority: commandAuthority,
    toolApprovalResume: {
      approvalId: approval.approvalId,
      toolId: approval.toolId,
      inputDigest: approval.inputDigest,
    },
    message: "approval resume validation",
  }).authority;
  return Object.freeze({
    approvalId: approval.approvalId,
    workspaceId: approval.workspaceId,
    userId: approval.userId,
    sessionId: approval.sessionId,
    sourceTurnId: approval.sourceTurnId,
    toolId: approval.toolId,
    inputDigest: approval.inputDigest,
    commandAuthority: authority,
    commandId,
    turnId,
  });
}

function normalizeTurnInput(kind, input) {
  if (kind === "agent_message") {
    const attachments = Array.isArray(input?.attachments)
      ? input.attachments.map(normalizeAttachmentRef)
      : [];
    if (!input || typeof input.message !== "string"
      || (!input.message.trim() && attachments.length === 0)) {
      throw new AgentTurnRunnerError("agent_turn_message_invalid");
    }
    return {
      message: input.message.trim(),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }
  if (kind === "model_task") {
    if (!input || input.task !== "image_generation"
      || typeof input.prompt !== "string" || !input.prompt.trim()) {
      throw new AgentTurnRunnerError("agent_model_task_invalid");
    }
    return {
      ...structuredClone(input),
      prompt: input.prompt.trim(),
    };
  }
  throw new AgentTurnRunnerError("agent_turn_kind_invalid");
}

function normalizeTaskSource(source) {
  if (!source || source.kind === "manual") return { kind: "manual" };
  if (source.kind !== "loop_run"
    || !source.workflowId
    || !source.workflowRevisionId
    || !source.runId) {
    throw new AgentTurnRunnerError("agent_task_source_invalid");
  }
  return {
    kind: "loop_run",
    workflowId: String(source.workflowId),
    workflowRevisionId: String(source.workflowRevisionId),
    runId: String(source.runId),
  };
}

function normalizeTaskTitle(title, source) {
  const value = String(title || "").trim().replace(/\s+/g, " ");
  if (value) return value.slice(0, 200);
  return source.kind === "loop_run" ? "Loop run" : "Untitled task";
}

function normalizeUpdatedTaskTitle(title) {
  const value = String(title ?? "").trim().replace(/\s+/g, " ");
  if (!value) throw new AgentTurnRunnerError("agent_session_title_invalid");
  return value.slice(0, 200);
}

function exactResolvedRevision(selection, requestedModelRevisionId) {
  const resolved = typeof selection === "string"
    ? selection
    : selection?.revisionId
      ?? selection?.modelProfileRevisionId
      ?? selection?.revision?.revisionId;
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new AgentTurnRunnerError("agent_turn_model_revision_unresolved");
  }
  if (requestedModelRevisionId && resolved !== requestedModelRevisionId) {
    throw new AgentTurnRunnerError("agent_model_revision_not_exact");
  }
  return resolved;
}

function modelContextLimit(selection) {
  const value = selection?.revision?.limits?.maxInputTokens
    ?? selection?.limits?.maxInputTokens
    ?? selection?.maxInputTokens;
  return Number.isInteger(value) && value >= 256 && value <= 10_000_000
    ? value
    : 128_000;
}

function turnMessageContent(turn) {
  return turn.kind === "agent_message"
    ? turn.input.message || `Attached: ${turn.input.attachments.map((ref) => ref.attachmentId).join(", ")}`
    : `Image generation task: ${turn.input.prompt}`.slice(0, 20_000);
}

function normalizeAttachmentRef(value) {
  if (!value || typeof value !== "object"
    || typeof value.attachmentId !== "string"
    || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.contentHash !== "string"
    || typeof value.mediaType !== "string") {
    throw new AgentTurnRunnerError("agent_attachment_ref_invalid");
  }
  return {
    attachmentId: value.attachmentId,
    version: value.version,
    contentHash: value.contentHash,
    mediaType: value.mediaType,
  };
}

function chatMessages(messages) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .slice(-100)
    .filter((message) => ["user", "assistant", "system"].includes(message?.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? "").slice(0, 20_000),
    }))
    .filter((message) => message.content.length > 0);
  return normalized.length > 0
    ? normalized
    : [{ role: "user", content: "Please review the attached material." }];
}

function chatResultText(output) {
  const blocks = Array.isArray(output?.content) ? output.content : [];
  const text = blocks
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) throw new AgentTurnRunnerError("agent_attachment_response_invalid");
  return text.slice(0, 20_000);
}

function modelTaskTurnStatus(status) {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if ([
    "blocked",
    "permission_denied",
    "sandbox_unavailable",
    "remote_backend_unavailable",
  ].includes(status)) return "blocked";
  return "failed";
}

function emptyModelCallCapabilities() {
  return {
    toolAllowlist: [],
    connectionIds: [],
    network: false,
    filesystem: "none",
    externalActions: false,
  };
}

function imageGenerationResultSchema() {
  return {
    type: "object",
    properties: {
      kind: { const: "image_generation" },
      artifactRefs: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            artifactId: { type: "string" },
            mediaType: { enum: ["image/png", "image/jpeg", "image/webp"] },
          },
          required: ["artifactId", "mediaType"],
          additionalProperties: false,
        },
      },
      seed: { type: ["integer", "null"] },
      format: { enum: ["png", "jpeg", "webp"] },
      dimensions: {
        type: "object",
        properties: { width: { type: "integer" }, height: { type: "integer" } },
        required: ["width", "height"],
        additionalProperties: false,
      },
      safetyStatus: { enum: ["passed", "filtered", "flagged"] },
      usage: { type: "object" },
      requestedModelRevisionId: { type: "string" },
      actualModelRevisionId: { type: "string" },
    },
    required: [
      "kind",
      "artifactRefs",
      "seed",
      "format",
      "dimensions",
      "safetyStatus",
      "usage",
      "requestedModelRevisionId",
      "actualModelRevisionId",
    ],
    additionalProperties: false,
  };
}

function safeArtifactRefs(value, maxItems) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!item || typeof item.artifactId !== "string"
      || !["image/png", "image/jpeg", "image/webp"].includes(item.mediaType)) continue;
    const key = `${item.artifactId}\u0000${item.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ artifactId: item.artifactId, mediaType: item.mediaType });
    if (result.length >= maxItems) break;
  }
  return result;
}

function safeImageModelResult(value, routing) {
  if (!value || value.kind !== "image_generation"
    || !["png", "jpeg", "webp"].includes(value.format)
    || !value.dimensions || !Number.isInteger(value.dimensions.width)
    || !Number.isInteger(value.dimensions.height)
    || value.dimensions.width < 1 || value.dimensions.width > 32_768
    || value.dimensions.height < 1 || value.dimensions.height > 32_768
    || !["passed", "filtered", "flagged"].includes(value.safetyStatus)
    || !value.usage || typeof value.usage !== "object"
    || routing.artifactRefs.length === 0) return null;
  return {
    kind: "image_generation",
    artifactRefs: structuredClone(routing.artifactRefs),
    seed: Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 4_294_967_294
      ? value.seed
      : null,
    format: value.format,
    dimensions: {
      width: value.dimensions.width,
      height: value.dimensions.height,
    },
    safetyStatus: value.safetyStatus,
    usage: {
      inputTokens: nonNegativeInteger(value.usage.inputTokens),
      outputTokens: nonNegativeInteger(value.usage.outputTokens),
      totalTokens: nonNegativeInteger(value.usage.totalTokens),
      imageCount: nonNegativeInteger(value.usage.imageCount, 16),
      costUsdMicros: nonNegativeInteger(value.usage.costUsdMicros, 1_000_000_000_000),
    },
    requestedModelRevisionId: routing.requestedModelRevisionId,
    actualModelRevisionId: routing.actualModelRevisionId,
  };
}

function safeExecutionUsage(value) {
  const usage = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    steps: nonNegativeInteger(usage.steps),
    modelRequests: nonNegativeInteger(usage.modelRequests),
    inputBytes: nonNegativeInteger(usage.inputBytes),
    outputBytes: nonNegativeInteger(usage.outputBytes),
    imageCount: nonNegativeInteger(usage.imageCount, 16),
    costUsdMicros: nonNegativeInteger(usage.costUsdMicros, 1_000_000_000_000),
    ...(Object.hasOwn(usage, "inputTokens") ? { inputTokens: nonNegativeInteger(usage.inputTokens, 10_000_000_000) } : {}),
    ...(Object.hasOwn(usage, "outputTokens") ? { outputTokens: nonNegativeInteger(usage.outputTokens, 10_000_000_000) } : {}),
    ...(Object.hasOwn(usage, "totalTokens") ? { totalTokens: nonNegativeInteger(usage.totalTokens, 20_000_000_000) } : {}),
  };
}

function nonNegativeInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function safeTurnFailure(status) {
  return {
    completed: "Agent turn completed.",
    blocked: "Agent turn is blocked.",
    cancelled: "Agent turn cancelled.",
  }[status] ?? "Agent turn failed.";
}
