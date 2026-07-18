import { getBuiltinAgentDefinition } from "./agent-definitions.mjs";

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
  #scheduled = new Map();
  #rescheduleRequested = new Set();
  #active = new Map();

  constructor({
    persistence,
    executionBroker = null,
    executor = null,
    clock = () => new Date().toISOString(),
    idFactory,
    resolveBaseVersion,
    resolveModelSelection,
  } = {}) {
    if (!persistence || typeof persistence.createSession !== "function") {
      throw new TypeError("agent_persistence_required");
    }
    if (typeof idFactory !== "function" || typeof resolveBaseVersion !== "function") {
      throw new TypeError("agent_id_factory_and_version_resolver_required");
    }
    if (typeof resolveModelSelection !== "function") {
      throw new TypeError("agent_model_selection_resolver_required");
    }
    this.#persistence = persistence;
    this.#executionBroker = executionBroker;
    this.#executor = executor;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#resolveBaseVersion = resolveBaseVersion;
    this.#resolveModelSelection = resolveModelSelection;
  }

  async recover() {
    const sessionIds = await this.#persistence.recover();
    for (const sessionId of sessionIds) this.#schedule(sessionId);
    return sessionIds;
  }

  async createSession({
    definitionId,
    objectKind,
    objectId,
    branchId = null,
    lastUsedModelProfileId = null,
    modelProfileId = null,
    userId,
    workspaceId,
  }) {
    const definition = getBuiltinAgentDefinition(definitionId);
    if (!definition) throw new AgentTurnRunnerError("agent_definition_not_found", "Agent definition not found.");
    if (!userId || !workspaceId) throw new AgentTurnRunnerError("agent_session_scope_invalid");

    if (definition.kind === "main") {
      if (objectKind || objectId) throw new AgentTurnRunnerError("main_agent_object_forbidden");
      const existing = await this.#persistence.findSession({
        userId, workspaceId, definitionId, scope: { kind: "main" },
      });
      if (existing?.status === "active") {
        return this.#applyModelSelection(existing, lastUsedModelProfileId ?? modelProfileId);
      }
      const now = this.#clock();
      return this.#persistence.createSession({
        schemaVersion: SCHEMA_VERSION,
        sessionId: this.#idFactory("agent-session"),
        definitionId,
        userId,
        workspaceId,
        scope: { kind: "main" },
        status: "active",
        lastUsedModelProfileId: lastUsedModelProfileId ?? modelProfileId ?? null,
        modelPreferenceState: "preference_only",
        activeTurnId: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!definition.objectKinds.includes(objectKind) || !objectId) {
      throw new AgentTurnRunnerError("module_agent_object_invalid", "This module Agent cannot operate on that object.");
    }
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
        status: "active",
        lastUsedModelProfileId: lastUsedModelProfileId ?? modelProfileId ?? null,
        modelPreferenceState: "preference_only",
        activeTurnId: null,
        createdAt: now,
        updatedAt: now,
      });
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

    const baseVersionId = await this.#resolveBaseVersion({ objectKind, objectId, userId, workspaceId });
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
      status: "active",
      lastUsedModelProfileId: lastUsedModelProfileId ?? modelProfileId ?? null,
      modelPreferenceState: "preference_only",
      activeTurnId: null,
      createdAt: now,
      updatedAt: now,
    };
    if (typeof this.#persistence.createModuleSession === "function") {
      return this.#persistence.createModuleSession(newBranch, newSession);
    }
    await this.#persistence.createBranch(newBranch);
    return this.#persistence.createSession(newSession);
  }

  getSession(sessionId, access) {
    return this.#persistence.getSession(sessionId, access);
  }

  async selectModel({ sessionId, lastUsedModelProfileId = null, modelProfileId = null, userId, workspaceId }) {
    const session = await this.#requireSession(sessionId, { userId, workspaceId });
    if (session.status !== "active") throw new AgentTurnRunnerError("agent_session_closed");
    return this.#applyModelSelection(session, lastUsedModelProfileId ?? modelProfileId);
  }

  async enqueueTurn({
    sessionId,
    kind,
    modelProfileRevisionId,
    input,
    userId,
    workspaceId,
  }) {
    const session = await this.#requireSession(sessionId, { userId, workspaceId });
    if (session.status !== "active") throw new AgentTurnRunnerError("agent_session_closed");
    const definition = getBuiltinAgentDefinition(session.definitionId);
    const normalizedInput = normalizeTurnInput(kind, input);
    const requiredCapabilities = kind === "model_task"
      ? ["image_generation"]
      : definition?.kind === "module"
        ? ["chat", "tool_calling", "structured_output"]
        : ["chat", "tool_calling"];
    const selection = await this.#resolveModelSelection({
      workspaceId,
      userId,
      session: structuredClone(session),
      kind,
      modelProfileRevisionId,
      requiredCapabilities: [...requiredCapabilities],
    });
    const requestedModelRevisionId = exactResolvedRevision(selection, modelProfileRevisionId);
    const modelCapability = kind === "model_task"
      ? "image_generation"
      : selection?.capability ?? "tool_calling";
    if (!requiredCapabilities.includes(modelCapability)) {
      throw new AgentTurnRunnerError("agent_model_capability_invalid");
    }
    const selectedProfileId = selection?.profileId ?? selection?.profile?.profileId;
    if (typeof selectedProfileId === "string" && selectedProfileId.length > 0) {
      await this.#applyModelSelection(session, selectedProfileId);
    }
    const now = this.#clock();
    const turnId = this.#idFactory("agent-turn");
    const turn = await this.#persistence.createTurn({
      schemaVersion: SCHEMA_VERSION,
      turnId,
      sessionId,
      kind,
      status: "queued",
      modelRoutingState: "pinned",
      requestedModelRevisionId,
      actualModelRevisionId: null,
      artifactRefs: [],
      input: normalizedInput,
      modelCapability,
      result: null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    });
    await this.#persistence.appendMessage({
      schemaVersion: SCHEMA_VERSION,
      messageId: this.#idFactory("agent-message"),
      sessionId,
      turnId,
      role: "user",
      kind: "turn",
      content: turnMessageContent(turn),
      createdAt: now,
    });
    await this.#appendEvent(sessionId, turnId, "turn.queued", "queued", "Agent turn queued.");
    this.#schedule(sessionId);
    return turn;
  }

  async steer({ sessionId, turnId, message, userId, workspaceId }) {
    await this.#requireSession(sessionId, { userId, workspaceId });
    const active = this.#active.get(sessionId);
    if (!active || active.turnId !== turnId) {
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
    await this.#appendEvent(sessionId, turnId, "turn.steered", "running", "Current Agent turn steered.");
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

  listEvents(sessionId, after, limit, access) {
    return this.#persistence.listEvents(sessionId, after, limit, access);
  }

  listMessages(sessionId, access) {
    return this.#persistence.listMessages(sessionId, access);
  }

  async cancelTurn({ sessionId, turnId, userId, workspaceId, reason }) {
    await this.#requireSession(sessionId, { userId, workspaceId });
    const current = await this.#persistence.getTurn(sessionId, turnId, { userId, workspaceId });
    if (!current) throw new AgentTurnRunnerError("agent_turn_not_found", "Agent turn not found.");
    if (TERMINAL.has(current.status)) return current;

    const now = this.#clock();
    const requested = await this.#persistence.requestCancel(turnId, now);
    await this.#appendEvent(sessionId, turnId, "turn.cancellation_requested", requested.status, "Agent turn cancellation requested.");
    const invocationIds = await this.#persistence.getTurnInvocations(turnId);
    await Promise.all(invocationIds.map((invocationId) => (
      Promise.resolve(this.#executionBroker?.cancel?.(invocationId, { reason })).catch(() => null)
    )));
    const active = this.#active.get(sessionId);
    if (active?.turnId === turnId) active.controller.abort(new AgentTurnRunnerError("agent_turn_cancelled"));
    if (requested.status === "cancelled") this.#schedule(sessionId);
    return requested;
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
    await this.#scheduled.get(sessionId);
  }

  #schedule(sessionId) {
    if (this.#scheduled.has(sessionId)) {
      this.#rescheduleRequested.add(sessionId);
      return;
    }
    const promise = Promise.resolve().then(() => this.#drain(sessionId)).finally(() => {
      if (this.#scheduled.get(sessionId) === promise) {
        this.#scheduled.delete(sessionId);
        if (this.#rescheduleRequested.delete(sessionId)) this.#schedule(sessionId);
      }
    });
    this.#scheduled.set(sessionId, promise);
  }

  async #drain(sessionId) {
    while (true) {
      const turn = await this.#persistence.claimNextTurn(sessionId, this.#clock());
      if (!turn) return;
      const session = await this.#persistence.getSession(sessionId);
      const controller = new AbortController();
      const active = { turnId: turn.turnId, turn, session, controller };
      this.#active.set(sessionId, active);
      await this.#appendEvent(sessionId, turn.turnId, "turn.started", "running", "Agent turn started.");
      try {
        if (turn.kind === "model_task") {
          const result = await this.#executeModelTask(session, turn, controller.signal);
          const status = controller.signal.aborted
            ? "cancelled"
            : modelTaskTurnStatus(result?.status);
          await this.#finish(turn, status, status === "completed"
            ? {
                result: result.output,
                requestedModelRevisionId: result.requestedModelRevisionId,
                actualModelRevisionId: result.actualModelRevisionId,
                artifactRefs: result.artifactRefs,
              }
            : {});
          continue;
        }
        if (typeof this.#executor?.execute !== "function") {
          await this.#finish(turn, "blocked", { response: "Agent execution backend is unavailable." });
          continue;
        }
        const messages = await this.#persistence.listMessages(sessionId, { userId: session.userId, workspaceId: session.workspaceId });
        const result = await this.#executor.execute({
          session: structuredClone(session),
          turn: structuredClone(turn),
          messages,
          signal: controller.signal,
          runWorkers: (requests) => this.#runWorkers(session, turn, requests, controller.signal),
        });
        if (controller.signal.aborted) {
          await this.#finish(turn, "cancelled", { response: "Turn cancelled." });
        } else {
          await this.#finish(turn, result?.status === "blocked" ? "blocked" : "completed", result ?? {});
        }
      } catch (error) {
        const status = controller.signal.aborted ? "cancelled" : error?.status === "blocked" ? "blocked" : "failed";
        await this.#finish(turn, status, { response: safeTurnFailure(status) });
      } finally {
        if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      }
    }
  }

  async #runWorkers(session, turn, requests, signal) {
    if (!this.#executionBroker || typeof this.#executionBroker.execute !== "function") {
      throw new AgentTurnRunnerError("execution_broker_unavailable", "Execution Broker is unavailable.");
    }
    if (!Array.isArray(requests) || requests.length === 0) return [];
    return Promise.all(requests.map(async (request) => {
      const invocationId = this.#idFactory("invocation");
      const attemptId = this.#idFactory("execution-attempt");
      const normalized = normalizeWorkerRequest(request, {
        invocationId,
        attemptId,
        workspaceId: session.workspaceId,
        turnId: turn.turnId,
      });
      await this.#persistence.addInvocation(turn.turnId, invocationId, this.#clock());
      return this.#executionBroker.execute(normalized, { signal });
    }));
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

  async #finish(turn, status, rawResult) {
    const invocationIds = await this.#persistence.getTurnInvocations(turn.turnId);
    const requestedModelRevisionId = turn.requestedModelRevisionId;
    const actualModelRevisionId = rawResult?.actualModelRevisionId ?? null;
    const artifactRefs = safeArtifactRefs(rawResult?.artifactRefs, turn.kind === "model_task" ? 16 : 256);
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
    let handoffId = null;
    if (status === "completed" && rawResult?.handoff) {
      handoffId = await this.#createHandoff(turn.sessionId, rawResult.handoff);
    }
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
          };
    const completed = await this.#persistence.completeTurn(
      turn.turnId,
      status,
      result,
      this.#clock(),
      { actualModelRevisionId, artifactRefs },
    );
    if (!completed) return null;
    await this.#persistence.appendMessage({
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
      createdAt: completed.finishedAt,
    });
    await this.#appendEvent(
      turn.sessionId,
      turn.turnId,
      `turn.${status}`,
      status,
      (result?.kind === "agent_message" ? result.response : safeTurnFailure(status)).slice(0, 4000),
    );
    return completed;
  }

  async #createHandoff(sourceSessionId, capsule) {
    const source = await this.#persistence.getSession(sourceSessionId);
    if (!source || source.scope.kind !== "module") throw new AgentTurnRunnerError("agent_handoff_source_invalid");
    const target = await this.#persistence.findMainSession(source.userId, source.workspaceId);
    if (!target) throw new AgentTurnRunnerError("main_agent_session_required");
    const handoffId = this.#idFactory("agent-handoff");
    await this.#persistence.createHandoff({
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
    });
    return handoffId;
  }

  async #appendEvent(sessionId, turnId, type, status, summary) {
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
    }));
  }

  async #requireSession(sessionId, access) {
    const session = await this.#persistence.getSession(sessionId, access);
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

function normalizeWorkerRequest(request, { invocationId, attemptId, workspaceId, turnId }) {
  const mode = request?.mode ?? "bounded_agent";
  const normalized = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId,
    workspaceId,
    controller: { kind: "agent_turn", controllerId: turnId, fence: 1 },
    mode,
    isolation: request?.isolation ?? "container",
    goal: String(request?.goal || "Execute bounded Agent work."),
    input: request?.input ?? {},
    limits: request?.limits ?? {
      timeoutMs: 60_000,
      maxSteps: 32,
      maxModelRequests: mode === "deterministic_skill" ? 0 : 16,
      maxChildren: mode === "agent_orchestrator" ? 8 : 0,
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

function normalizeTurnInput(kind, input) {
  if (kind === "agent_message") {
    if (!input || typeof input.message !== "string" || !input.message.trim()) {
      throw new AgentTurnRunnerError("agent_turn_message_invalid");
    }
    return { message: input.message.trim() };
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

function exactResolvedRevision(selection, requestedModelRevisionId) {
  if (typeof requestedModelRevisionId !== "string" || !requestedModelRevisionId.trim()) {
    throw new AgentTurnRunnerError("agent_turn_model_revision_required");
  }
  const resolved = typeof selection === "string"
    ? selection
    : selection?.revisionId
      ?? selection?.modelProfileRevisionId
      ?? selection?.revision?.revisionId;
  if (resolved !== requestedModelRevisionId) {
    throw new AgentTurnRunnerError("agent_model_revision_not_exact");
  }
  return resolved;
}

function turnMessageContent(turn) {
  return turn.kind === "agent_message"
    ? turn.input.message
    : `Image generation task: ${turn.input.prompt}`.slice(0, 20_000);
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
