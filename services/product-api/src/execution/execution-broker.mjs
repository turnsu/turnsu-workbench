import {
  Check,
  ExecutionRequestSchema,
  MemberAgentExecutionRequestSchema,
  ExecutionResultSchema,
  RealtimeStreamReadySchema,
  RealtimeStreamUpdateSchema,
} from "@turnsu/workbench-contracts";

const SCHEMA_VERSION = "workbench-execution-fabric-v1";
// Only stable product codes cross the execution boundary; provider bodies,
// exception messages, URLs, and private runtime details never do.
const PUBLIC_FAILURE_CODES = new Set([
  "member_agent_restart_outcome_unknown", "member_agent_transport_disconnected",
  "provider_auth_failed", "provider_payment_required", "provider_rate_limited", "provider_content_rejected",
  "provider_timeout", "provider_request_invalid", "provider_request_failed",
  "provider_response_invalid", "provider_response_too_large",
  "model_cost_budget_exceeded", "model_route_unresolved", "model_capability_mismatch",
  "prompt_skill_output_invalid", "prompt_skill_output_truncated",
  "execution_result_schema_mismatch", "skill_execution_invalid_output", "skill_execution_output_limit",
]);
const TERMINAL = new Set([
  "completed", "failed", "cancelled", "blocked", "partial", "timeout",
  "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
  "effect_outcome_unknown",
]);
const EMPTY_USAGE = Object.freeze({
  steps: 0,
  modelRequests: 0,
  inputBytes: 0,
  outputBytes: 0,
  imageCount: 0,
  costUsdMicros: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  cachedInputTokens: 0,
});

export class ExecutionBrokerError extends Error {
  constructor(code, message = code, { status = "failed", details = {} } = {}) {
    super(message);
    this.name = "ExecutionBrokerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ExecutionBroker {
  #persistence;
  #clock;
  #idFactory;
  #capacityAuthorizer;
  #streamBackendSettlementTimeoutMs;
  #backends = new Map();
  #active = new Map();
  #deferredSettlements = new Map();

  constructor({
    persistence,
    clock = () => new Date().toISOString(),
    idFactory,
    capacityAuthorizer,
    streamBackendSettlementTimeoutMs = 2_000,
  } = {}) {
    if (!persistence) throw new TypeError("execution_persistence_required");
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("execution_clock_and_id_factory_required");
    }
    if (typeof capacityAuthorizer?.authorize !== "function") {
      throw new TypeError("execution_capacity_authorizer_required");
    }
    this.#persistence = persistence;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#capacityAuthorizer = capacityAuthorizer;
    this.#streamBackendSettlementTimeoutMs = Math.min(
      Math.max(Number(streamBackendSettlementTimeoutMs) || 2_000, 10),
      30_000,
    );
  }

  registerBackend({ mode, isolation, backend } = {}) {
    const backendValid = mode === "realtime_audio"
      ? ["open", "update", "finish", "cancel"].every((name) => typeof backend?.[name] === "function")
      : typeof backend?.execute === "function";
    if (typeof mode !== "string" || typeof isolation !== "string" || !backendValid) {
      throw new TypeError("execution_backend_invalid");
    }
    const key = backendKey(mode, isolation);
    if (this.#backends.has(key)) throw new TypeError(`execution_backend_duplicate:${key}`);
    this.#backends.set(key, backend);
    return () => this.#backends.delete(key);
  }

  hasBackend({ mode, isolation } = {}) {
    if (typeof mode !== "string" || typeof isolation !== "string") return false;
    return this.#backends.has(backendKey(mode, isolation));
  }

  async probeBackend({ mode, isolation, signal } = {}) {
    if (typeof mode !== "string" || typeof isolation !== "string") {
      return Object.freeze({ available: false, verified: true, reasonCode: "execution_backend_invalid" });
    }
    const backend = this.#backends.get(backendKey(mode, isolation));
    if (!backend) {
      return Object.freeze({ available: false, verified: true, reasonCode: "execution_backend_unavailable" });
    }
    if (typeof backend.probe !== "function") {
      return Object.freeze({ available: true, verified: false, reasonCode: "execution_backend_probe_unavailable" });
    }
    try {
      const result = await backend.probe({ signal });
      if (result?.available !== true) {
        return Object.freeze({ available: false, verified: true, reasonCode: "execution_backend_unavailable" });
      }
      const verified = result.verified !== false;
      return Object.freeze({
        available: true,
        verified,
        reasonCode: verified ? "ready" : "execution_backend_probe_unavailable",
      });
    } catch {
      return Object.freeze({ available: false, verified: true, reasonCode: "execution_backend_unavailable" });
    }
  }

  async recoverStreams({ limit = 500 } = {}) {
    if (typeof this.#persistence.listRecoverableRealtimeInvocations !== "function"
      || typeof this.#persistence.failRecoveredRealtimeAttempt !== "function") {
      throw new ExecutionBrokerError(
        "execution_stream_recovery_persistence_required",
        "Realtime recovery requires atomic persistence support.",
        { status: "blocked" },
      );
    }
    const records = await this.#persistence.listRecoverableRealtimeInvocations({ limit });
    const recovered = [];
    for (const invocation of records) {
      if (this.#active.has(invocation.invocationId)) continue;
      const request = invocation.request;
      if (!request || request.mode !== "realtime_audio") continue;
      const result = failureResult(
        request,
        invocation.startedAt ?? invocation.createdAt,
        this.#clock(),
        new ExecutionBrokerError(
          "execution_stream_restart_not_resumable",
          "Realtime media sessions fail closed after Product restart.",
          { status: "failed" },
        ),
      );
      const accepted = await this.#persistence.failRecoveredRealtimeAttempt({
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        fence: invocation.executionFence,
        result,
      });
      if (!accepted) continue;
      await this.#event(
        request,
        "execution.failed",
        "failed",
        { summary: result.summary, reasonCode: "execution_stream_restart_not_resumable" },
      ).catch(() => {});
      recovered.push(Object.freeze({
        invocationId: invocation.invocationId,
        capacityLeaseId: request.capacityAuthority?.capacityLeaseId ?? null,
        result: Object.freeze(productResult(result)),
      }));
    }
    return Object.freeze(recovered);
  }

  async recoverMemberAgentRequests({ limit = 500 } = {}) {
    if (typeof this.#persistence.listRecoverableMemberAgentInvocations !== "function"
      || typeof this.#persistence.failRecoveredMemberAgentAttempt !== "function") {
      throw new ExecutionBrokerError(
        "execution_stream_recovery_persistence_required",
        "Realtime recovery requires atomic persistence support.",
        { status: "blocked" },
      );
    }
    const records = await this.#persistence.listRecoverableMemberAgentInvocations({ limit });
    const recovered = [];
    for (const invocation of records) {
      if (this.#active.has(invocation.invocationId)) continue;
      const request = invocation.request;
      if (!request || request.controller?.kind !== "member_agent_request") continue;
      const result = failureResult(
        request,
        invocation.startedAt ?? invocation.createdAt,
        this.#clock(),
        new ExecutionBrokerError(
          "member_agent_restart_outcome_unknown",
          "Member executions cannot be replayed after Product restart.",
          { status: "partial" },
        ),
      );
      const accepted = await this.#persistence.failRecoveredMemberAgentAttempt({
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        fence: invocation.executionFence,
        result,
      });
      if (!accepted) continue;
      await this.#event(
        request,
        "execution.partial",
        "partial",
        { summary: result.summary, reasonCode: "member_agent_restart_outcome_unknown" },
      ).catch(() => {});
      recovered.push(Object.freeze({
        invocationId: invocation.invocationId,
        capacityLeaseId: request.capacityAuthority?.capacityLeaseId ?? null,
        result: Object.freeze(productResult(result)),
      }));
    }
    return Object.freeze(recovered);
  }

  async prepareExecution(request, {
    childCapacityPool = null,
    uow = undefined,
    start = false,
  } = {}) {
    validateRequest(request);
    if (request.mode === "realtime_audio") {
      throw new ExecutionBrokerError(
        "execution_stream_requires_open",
        "Realtime audio must use the streaming execution lifecycle.",
      );
    }
    if (!await this.#capacityAuthorizer.authorize(request)) {
      throw new ExecutionBrokerError(
        "execution_capacity_lease_invalid",
        "Execution requires a valid Capacity Lease.",
        { status: "permission_denied" },
      );
    }
    assertChildCapacityPool(request, childCapacityPool);
    const createdAt = this.#clock();
    const fence = 1;
    const lease = {
      schemaVersion: SCHEMA_VERSION,
      capabilityLeaseId: this.#idFactory("capability-lease"),
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      fence,
      status: "active",
      capabilities: structuredClone(request.capabilities),
      issuedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + request.limits.timeoutMs).toISOString(),
      revokedAt: null,
      updatedAt: createdAt,
    };
    const invocation = {
      schemaVersion: SCHEMA_VERSION,
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      controller: structuredClone(request.controller),
      mode: request.mode,
      isolation: request.isolation,
      request: structuredClone(request),
      status: "queued",
      eventSequence: 0,
      executionFence: fence,
      capabilityLeaseId: lease.capabilityLeaseId,
      result: null,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const attempt = {
      schemaVersion: SCHEMA_VERSION,
      attemptId: request.attemptId,
      invocationId: request.invocationId,
      attemptNumber: 1,
      status: "queued",
      fence,
      checkpointSequence: 0,
      result: null,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    if (typeof this.#persistence.createExecutionAuthority === "function") {
      await this.#persistence.createExecutionAuthority({ invocation, attempt, lease }, { uow });
    } else {
      await this.#persistence.createInvocation(invocation, { uow });
      await this.#persistence.createAttempt(attempt, { uow });
      await this.#persistence.issueLease(lease, { uow });
    }
    const startedAt = start ? this.#clock() : null;
    if (startedAt) {
      await this.#persistence.markRunning(request.invocationId, request.attemptId, startedAt, { uow });
      await this.#event(request, "execution.started", "running", {}, { uow });
    }
    return Object.freeze({
      schemaVersion: "workbench-prepared-execution-v1",
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      fence,
      lease: Object.freeze(structuredClone(lease)),
      createdAt,
      startedAt,
    });
  }

  async execute(request, {
    signal,
    authoritySignal,
    childCapacityPool = null,
    preparedExecution = null,
    deferSettlement = false,
  } = {}) {
    validateRequest(request);
    if (request.mode === "realtime_audio") {
      throw new ExecutionBrokerError(
        "execution_stream_requires_open",
        "Realtime audio must use the streaming execution lifecycle.",
      );
    }
    const prepared = preparedExecution ?? await this.prepareExecution(request, { childCapacityPool });
    assertPreparedExecutionMatchesRequest(prepared, request);
    const { createdAt, fence, lease } = prepared;

    const backend = this.#backends.get(backendKey(request.mode, request.isolation));
    const controller = new AbortController();
    const childRecorder = request.mode === "agent_orchestrator"
      ? this.#createChildRecorder({
          parentRequest: request,
          parentLease: lease,
          signal: controller.signal,
          capacityPool: childCapacityPool,
        })
      : null;
    const active = {
      kind: "execute",
      controller,
      backend,
      request,
      fence,
      childRecorder,
      startedAt: prepared.startedAt ?? createdAt,
      cancellationPromise: null,
      authoritySignal,
      abortFromAuthority: null,
    };
    this.#active.set(request.invocationId, active);
    const abortFromCaller = () => {
      active.cancellationPromise ??= this.cancel(request.invocationId, { reason: signal?.reason });
    };
    if (signal?.aborted) {
      abortFromCaller();
      try {
        return await active.cancellationPromise;
      } finally {
        if (this.#active.get(request.invocationId) === active) this.#active.delete(request.invocationId);
      }
    }
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    active.abortFromAuthority = () => {
      controller.abort(executionAuthorityFailure(authoritySignal?.reason));
    };
    if (authoritySignal?.aborted) active.abortFromAuthority();
    authoritySignal?.addEventListener("abort", active.abortFromAuthority, { once: true });

    let timeout;
    try {
      const startedAt = prepared.startedAt ?? this.#clock();
      if (!prepared.startedAt) {
        await this.#persistence.markRunning(request.invocationId, request.attemptId, startedAt);
        await this.#event(request, "execution.started", "running", {});
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!backend) throw unavailableFor(request);
      timeout = setTimeout(() => {
        controller.abort(new ExecutionBrokerError("execution_timeout", "Execution exceeded its deadline.", { status: "timeout" }));
      }, request.limits.timeoutMs);
      const backendResult = await backend.execute({
        request: structuredClone(request),
        lease: structuredClone(lease),
        signal: controller.signal,
        emit: (type, payload = {}) => this.#event(request, type, "running", payload),
        checkpoint: (state) => this.#checkpoint(request, fence, state),
        reportChild: childRecorder
          ? (update) => childRecorder.report(update)
          : () => { throw new ExecutionBrokerError("execution_children_forbidden"); },
        assertCapability: (capability) => assertCapabilityAllowed(request.capabilities, capability),
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      await childRecorder?.finalize(backendResult?.children);
      const result = normalizeResult({
        request,
        startedAt,
        finishedAt: this.#clock(),
        backendResult: {
          ...backendResult,
          children: undefined,
        },
      });
      validateResultAgainstRequest(request, result);
      if (deferSettlement) return this.#deferExecutionSettlement(request, fence, result);
      const accepted = await this.#persistence.completeAttempt(request.attemptId, fence, result);
      if (!accepted) return this.#lateResult(request.invocationId, active);
      await this.#persistence.revokeLease(request.invocationId, result.finishedAt);
      await this.#event(request, "execution.completed", result.status, { summary: result.summary });
      return result;
    } catch (error) {
      const existing = await this.#persistence.getInvocation(request.invocationId);
      if (existing?.status === "cancelled" && existing.result) return productResult(existing.result);
      await childRecorder?.cancelAll(error).catch(() => {});
      const result = failureResult(request, active.startedAt, this.#clock(), error, controller.signal);
      if (deferSettlement) return this.#deferExecutionSettlement(request, fence, result);
      const accepted = await this.#persistence.completeAttempt(request.attemptId, fence, result);
      await this.#persistence.revokeLease(request.invocationId, result.finishedAt);
      if (!accepted) return this.#lateResult(request.invocationId, active);
      await this.#event(request, `execution.${result.status}`, result.status, { summary: result.summary });
      return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      authoritySignal?.removeEventListener("abort", active.abortFromAuthority);
      if (this.#active.get(request.invocationId) === active) this.#active.delete(request.invocationId);
    }
  }

  async settleExecution(deferredSettlement, { uow = undefined } = {}) {
    const state = this.#deferredSettlements.get(deferredSettlement?.invocationId);
    if (!state || state.token !== deferredSettlement) {
      throw new ExecutionBrokerError(
        "execution_deferred_settlement_invalid",
        "The deferred execution settlement is missing or stale.",
        { status: "permission_denied" },
      );
    }
    const accepted = await this.#persistence.completeAttempt(
      state.request.attemptId,
      state.fence,
      state.result,
      { uow },
    );
    if (!accepted) {
      throw new ExecutionBrokerError(
        "execution_deferred_settlement_fence_rejected",
        "The deferred execution result lost its execution fence.",
        { status: "effect_outcome_unknown" },
      );
    }
    await this.#persistence.revokeLease(state.request.invocationId, state.result.finishedAt, { uow });
    await this.#event(
      state.request,
      `execution.${state.result.status}`,
      state.result.status,
      { summary: state.result.summary },
      { uow },
    );
    return structuredClone(state.result);
  }

  confirmExecutionSettlement(deferredSettlement) {
    const state = this.#deferredSettlements.get(deferredSettlement?.invocationId);
    if (!state || state.token !== deferredSettlement) {
      throw new ExecutionBrokerError("execution_deferred_settlement_invalid");
    }
    this.#deferredSettlements.delete(deferredSettlement.invocationId);
    return Object.freeze(structuredClone(state.result));
  }

  async openStream(request, {
    offer,
    signal,
    authoritySignal,
    sessionConfig = {},
    realtimeEventSink,
    onTerminal,
  } = {}) {
    validateRequest(request);
    if (request.mode !== "realtime_audio") {
      throw new ExecutionBrokerError("execution_stream_mode_invalid");
    }
    validateRealtimeOffer(offer);
    validateRealtimeSessionConfig(sessionConfig);
    if (realtimeEventSink !== undefined && typeof realtimeEventSink !== "function") {
      throw new TypeError("execution_stream_event_sink_invalid");
    }
    if (typeof onTerminal !== "undefined" && typeof onTerminal !== "function") {
      throw new TypeError("execution_stream_terminal_callback_invalid");
    }
    if (authoritySignal?.aborted) throw executionAuthorityFailure(authoritySignal.reason);
    if (!await this.#capacityAuthorizer.authorize(request)) {
      throw new ExecutionBrokerError(
        "execution_capacity_lease_invalid",
        "Execution requires a valid Capacity Lease.",
        { status: "permission_denied" },
      );
    }
    if (this.#active.has(request.invocationId)) {
      throw new ExecutionBrokerError("execution_invocation_active");
    }

    const createdAt = this.#clock();
    const fence = 1;
    const lease = {
      schemaVersion: SCHEMA_VERSION,
      capabilityLeaseId: this.#idFactory("capability-lease"),
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      fence,
      status: "active",
      capabilities: structuredClone(request.capabilities),
      issuedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + request.limits.timeoutMs).toISOString(),
      revokedAt: null,
      updatedAt: createdAt,
    };
    if (typeof this.#persistence.createExecutionAuthority !== "function") {
      throw new ExecutionBrokerError(
        "execution_atomic_open_persistence_required",
        "Realtime open requires atomic execution authority persistence.",
        { status: "blocked" },
      );
    }
    const invocationRecord = {
      schemaVersion: SCHEMA_VERSION,
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      controller: structuredClone(request.controller),
      mode: request.mode,
      isolation: request.isolation,
      request: structuredClone(request),
      status: "queued",
      eventSequence: 0,
      executionFence: fence,
      capabilityLeaseId: lease.capabilityLeaseId,
      result: null,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const attemptRecord = {
      schemaVersion: SCHEMA_VERSION,
      attemptId: request.attemptId,
      invocationId: request.invocationId,
      attemptNumber: 1,
      status: "queued",
      fence,
      checkpointSequence: 0,
      result: null,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    await this.#persistence.createExecutionAuthority({
      invocation: invocationRecord,
      attempt: attemptRecord,
      lease,
    });

    const backend = this.#backends.get(backendKey(request.mode, request.isolation));
    const controller = new AbortController();
    const completion = deferred();
    const active = {
      kind: "stream",
      controller,
      backend,
      request,
      lease,
      fence,
      startedAt: createdAt,
      streamHandle: null,
      usage: { ...EMPTY_USAGE },
      completion,
      terminalInterrupt: deferred(),
      settlementPromise: null,
      cancellationPromise: null,
      timeout: null,
      callerSignal: signal,
      abortFromCaller: null,
      authoritySignal,
      abortFromAuthority: null,
      onTerminal,
    };
    this.#active.set(request.invocationId, active);
    active.abortFromCaller = () => {
      active.cancellationPromise ??= this.cancel(request.invocationId, { reason: signal?.reason });
    };
    signal?.addEventListener("abort", active.abortFromCaller, { once: true });
    active.abortFromAuthority = () => {
      void this.#failStream(active, executionAuthorityFailure(authoritySignal?.reason)).catch(() => {});
    };
    authoritySignal?.addEventListener("abort", active.abortFromAuthority, { once: true });

    let opened = null;
    try {
      const startedAt = this.#clock();
      active.startedAt = startedAt;
      await this.#persistence.markRunning(request.invocationId, request.attemptId, startedAt);
      await this.#event(request, "execution.started", "running", {});
      if (!backend) throw unavailableFor(request);
      active.timeout = setTimeout(() => {
        void this.#failStream(
          active,
          new ExecutionBrokerError(
            "execution_timeout",
            "Execution exceeded its deadline.",
            { status: "timeout" },
          ),
        ).catch(() => {});
      }, request.limits.timeoutMs);
      const opening = Promise.resolve().then(() => backend.open({
        request: structuredClone(request),
        lease: structuredClone(lease),
        offer: structuredClone(offer),
        sessionConfig: structuredClone(sessionConfig),
        realtimeEventSink: realtimeEventSink
          ? (event) => this.#streamServiceEvent(active, event, realtimeEventSink)
          : undefined,
        signal: controller.signal,
        emit: (type, payload = {}) => this.#streamEvent(active, type, payload),
        checkpoint: () => {
          throw new ExecutionBrokerError(
            "execution_stream_checkpoint_unsupported",
            "Realtime Provider checkpoints are not accepted by the Product execution boundary.",
            { status: "permission_denied" },
          );
        },
        reportUsage: (usageDelta) => this.#recordStreamUsage(active, usageDelta),
        assertCapability: async (capability) => {
          await this.#assertBackendStreamActive(active);
          return assertCapabilityAllowed(request.capabilities, capability);
        },
        fail: (error) => this.#failStream(active, error),
      }));
      opening.then((lateOpened) => {
        if (this.#active.get(request.invocationId) !== active || active.settlementPromise) {
          this.#startBackendCleanup(
            active,
            new ExecutionBrokerError("execution_stream_closed"),
            lateOpened?.handle ?? lateOpened,
          );
        }
      }).catch(() => {});
      const openOutcome = await this.#awaitStreamBackend(active, opening, { bounded: false });
      if (openOutcome.kind === "terminal") {
        await openOutcome.promise;
        throw new ExecutionBrokerError("execution_stream_closed", undefined, { status: "cancelled" });
      }
      opened = openOutcome.value;
      if (controller.signal.aborted || active.settlementPromise) {
        await Promise.resolve(backend.cancel({
          invocationId: request.invocationId,
          request: structuredClone(request),
          handle: opened?.handle ?? opened,
          reason: controller.signal.reason,
        })).catch(() => {});
        throw controller.signal.reason ?? new ExecutionBrokerError("execution_stream_closed");
      }
      if (!opened || typeof opened.sdpAnswer !== "string") {
        throw new ExecutionBrokerError("execution_stream_ready_invalid");
      }
      active.streamHandle = opened.handle ?? opened;
      assertSafeRealtimeSdp(opened.sdpAnswer);
      const ready = {
        schemaVersion: SCHEMA_VERSION,
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        status: "running",
        isolation: request.isolation,
        sdpAnswer: opened.sdpAnswer,
        startedAt,
      };
      if (!Check(RealtimeStreamReadySchema, ready)) {
        throw new ExecutionBrokerError("execution_stream_ready_invalid");
      }
      await this.#event(request, "execution.stream_ready", "running", {});
      if (opened.completion && typeof opened.completion.then === "function") {
        Promise.resolve(opened.completion).then(
          (backendResult) => this.#settleStream(active, async () => backendResult),
          (error) => this.#failStream(active, error),
        ).catch(() => {});
      }
      return Object.freeze({
        ready: Object.freeze(structuredClone(ready)),
        authority: Object.freeze(streamAuthority(active)),
        completion: completion.promise,
      });
    } catch (error) {
      if (this.#active.get(request.invocationId) === active && !active.settlementPromise) {
        await this.#failStream(active, error);
      }
      throw error;
    }
  }

  async updateStream(invocationId, update, { authority } = {}) {
    if (!Check(RealtimeStreamUpdateSchema, update)) {
      throw new ExecutionBrokerError("execution_stream_update_invalid");
    }
    const active = this.#active.get(invocationId);
    if (!active || active.kind !== "stream") {
      throw new ExecutionBrokerError("execution_stream_not_active");
    }
    await this.#assertStreamAuthority(active, authority);
    try {
      const outcome = await this.#awaitStreamBackend(
        active,
        Promise.resolve().then(() => active.backend.update({
          invocationId,
          request: structuredClone(active.request),
          handle: active.streamHandle,
          update: structuredClone(update),
          signal: active.controller.signal,
        })),
        { bounded: true },
      );
      if (outcome.kind === "terminal") {
        const terminal = await outcome.promise;
        throw new ExecutionBrokerError(
          "execution_stream_closed",
          "The Realtime stream closed before the update settled.",
          { status: terminal?.status ?? "cancelled" },
        );
      }
      await this.#assertBackendStreamActive(active);
      const response = outcome.value;
      if (response?.usageDelta) await this.#recordStreamUsage(active, response.usageDelta);
      await this.#event(active.request, "execution.stream_updated", "running", { kind: update.kind });
      return Object.freeze({ invocationId, status: "running" });
    } catch (error) {
      await this.#failStream(active, error);
      throw error;
    }
  }

  async finishStream(invocationId, { authority, reason = "stream_finished" } = {}) {
    const active = this.#active.get(invocationId);
    if (!active || active.kind !== "stream") {
      return this.#finishedStreamResult(invocationId, authority);
    }
    await this.#assertStreamAuthority(active, authority);
    return this.#settleStream(active, () => active.backend.finish({
      invocationId,
      request: structuredClone(active.request),
      handle: active.streamHandle,
      reason,
      signal: active.controller.signal,
    }));
  }

  cancel(invocationId, { reason } = {}) {
    const active = this.#active.get(invocationId);
    if (active?.cancellationPromise) return active.cancellationPromise;
    const operation = this.#cancel(invocationId, { reason });
    if (active) {
      active.cancellationPromise = operation;
      if (active.kind === "stream") {
        active.terminalInterrupt.resolve({ kind: "terminal", promise: operation });
        active.settlementPromise ??= operation;
      }
    }
    return operation;
  }

  async #cancel(invocationId, { reason } = {}) {
    const now = this.#clock();
    const invocation = await this.#persistence.requestCancel(invocationId, now);
    if (!invocation) {
      const existingResult = (await this.#persistence.getInvocation(invocationId))?.result;
      return existingResult ? productResult(existingResult) : null;
    }
    await this.#persistence.revokeLease(invocationId, now);
    const active = this.#active.get(invocationId);
    const cancelError = new ExecutionBrokerError("execution_cancelled", "Execution was cancelled.", { status: "cancelled" });
    await active?.childRecorder?.cancelAll(cancelError);
    active?.controller.abort(cancelError);
    let backendCancellation = null;
    if (typeof active?.backend?.cancel === "function") {
      const cancellation = Promise.resolve().then(() => active.backend.cancel({
        invocationId,
        reason,
        request: active?.request ? structuredClone(active.request) : structuredClone(invocation.request),
        handle: active?.streamHandle ?? null,
      }));
      try {
        backendCancellation = active?.kind === "stream"
          ? await withDeadline(
              cancellation,
              this.#streamBackendSettlementTimeoutMs,
              () => new ExecutionBrokerError("execution_stream_cleanup_timeout", undefined, { status: "timeout" }),
            )
          : await cancellation;
      } catch {
        backendCancellation = active?.kind === "stream"
          ? null
          : { status: "effect_outcome_unknown" };
      }
    }
    const request = active?.request ?? invocation.request;
    const cancellationStatus = cancellationSettlementStatus({ active, request, backendCancellation });
    const result = failureResult(
      request,
      invocation.startedAt ?? now,
      this.#clock(),
      new ExecutionBrokerError(
        cancellationStatus === "cancelled" ? "execution_cancelled" : cancellationStatus,
        cancellationStatus,
        { status: cancellationStatus },
      ),
      undefined,
      active?.kind === "stream" ? active.usage : null,
    );
    const cancelled = await this.#persistence.cancelAttempt(invocationId, result);
    await this.#event(request, `execution.${cancellationStatus}`, cancellationStatus, { summary: result.summary }).catch(() => {});
    const terminal = productResult(cancelled ?? result);
    if (active?.kind === "stream") {
      active.completion.resolve(terminal);
      await this.#cleanupStream(active, terminal);
    }
    this.#deferredSettlements.delete(invocationId);
    return terminal;
  }

  async #assertStreamAuthority(active, authority) {
    const expected = streamAuthority(active);
    if (!authority
      || authority.attemptId !== expected.attemptId
      || authority.capabilityLeaseId !== expected.capabilityLeaseId
      || authority.fence !== expected.fence) {
      throw new ExecutionBrokerError(
        "execution_stream_authority_invalid",
        "The Realtime stream authority is stale or invalid.",
        { status: "permission_denied" },
      );
    }
    const invocation = await this.#persistence.getInvocation(active.request.invocationId);
    if (!invocation
      || invocation.status !== "running"
      || invocation.attemptId !== active.request.attemptId
      || invocation.executionFence !== active.fence
      || invocation.capabilityLeaseId !== active.lease.capabilityLeaseId) {
      const error = new ExecutionBrokerError(
        "execution_result_rejected_by_fence",
        "The Realtime stream fence is no longer current.",
        { status: "permission_denied" },
      );
      await this.#retireStaleStream(active, error);
      throw error;
    }
    if (!await this.#capacityAuthorizer.authorize(active.request)) {
      const error = new ExecutionBrokerError(
        "execution_capacity_lease_invalid",
        "The Realtime capacity lease is no longer active.",
        { status: "permission_denied" },
      );
      await this.#failStream(active, error);
      throw error;
    }
    const lease = await this.#persistence.getActiveLease(
      active.request.invocationId,
      active.request.attemptId,
      this.#clock(),
    );
    if (!lease
      || lease.capabilityLeaseId !== active.lease.capabilityLeaseId
      || lease.fence !== active.fence) {
      const error = new ExecutionBrokerError(
        "execution_capability_lease_invalid",
        "The Realtime capability lease is no longer active.",
        { status: "permission_denied" },
      );
      await this.#failStream(active, error);
      throw error;
    }
  }

  async #recordStreamUsage(active, usageDelta) {
    await this.#assertBackendStreamActive(active);
    try {
      const delta = normalizedUsage(usageDelta, "execution_stream_usage_invalid");
      const next = Object.fromEntries(
        Object.keys(EMPTY_USAGE).map((name) => [name, active.usage[name] + delta[name]]),
      );
      active.usage = next;
      assertUsageWithinLimits(active.request, next);
      await this.#event(active.request, "execution.stream_usage", "running", {
        modelRequests: next.modelRequests,
        inputBytes: next.inputBytes,
        outputBytes: next.outputBytes,
        costUsdMicros: next.costUsdMicros,
        inputTokens: next.inputTokens,
        outputTokens: next.outputTokens,
        totalTokens: next.totalTokens,
        audioInputTokens: next.audioInputTokens,
        audioOutputTokens: next.audioOutputTokens,
        cachedInputTokens: next.cachedInputTokens,
      });
      return structuredClone(next);
    } catch (error) {
      await this.#failStream(active, error);
      throw error;
    }
  }

  async #streamEvent(active, type, payload) {
    await this.#assertBackendStreamActive(active);
    const event = normalizedRealtimeProductEvent(type, payload);
    return this.#event(active.request, event.type, "running", event.payload);
  }

  async #streamServiceEvent(active, event, sink) {
    const normalized = normalizedRealtimeServiceEvent(event);
    await this.#assertBackendStreamActive(active);
    if (normalized.type === "function_call") {
      assertCapabilityAllowed(active.request.capabilities, {
        kind: "tool",
        id: normalized.name,
      });
    }
    const guard = Object.freeze({
      invocationId: active.request.invocationId,
      attemptId: active.request.attemptId,
      fence: active.fence,
      signal: active.controller.signal,
      assertActive: async () => {
        await this.#assertBackendStreamActive(active);
        if (normalized.type === "function_call") {
          assertCapabilityAllowed(active.request.capabilities, {
            kind: "tool",
            id: normalized.name,
          });
        }
        return true;
      },
    });
    const outcome = await this.#awaitStreamBackend(
      active,
      Promise.resolve().then(() => sink(structuredClone(normalized), guard)),
      { bounded: false },
    );
    if (outcome.kind === "terminal") {
      const terminal = await outcome.promise;
      throw new ExecutionBrokerError(
        "execution_stream_closed",
        "The Realtime stream closed before the Product event settled.",
        { status: terminal?.status ?? "cancelled" },
      );
    }
    await guard.assertActive();
    return outcome.value;
  }

  async #assertBackendStreamActive(active) {
    if (this.#active.get(active.request.invocationId) !== active
      || active.kind !== "stream"
      || active.settlementPromise) {
      throw new ExecutionBrokerError("execution_result_rejected_by_fence");
    }
    await this.#assertStreamAuthority(active, streamAuthority(active));
  }

  #settleStream(active, backendOperation, { bounded = true } = {}) {
    if (active.settlementPromise) return active.settlementPromise;
    active.settlementPromise = Promise.resolve().then(async () => {
      let result;
      try {
        const outcome = await this.#awaitStreamBackend(
          active,
          Promise.resolve().then(backendOperation),
          { bounded },
        );
        if (outcome.kind === "terminal") return outcome.promise;
        const backendResult = outcome.value;
        const usage = backendResult?.usage
          ? normalizedUsage(backendResult.usage, "execution_stream_usage_invalid")
          : structuredClone(active.usage);
        assertUsageWithinLimits(active.request, usage);
        result = normalizeResult({
          request: active.request,
          startedAt: active.startedAt,
          finishedAt: this.#clock(),
          backendResult: {
            ...backendResult,
            status: backendResult?.status ?? "completed",
            usage,
          },
        });
        validateResultAgainstRequest(active.request, result);
      } catch (error) {
        if (!active.controller.signal.aborted) active.controller.abort(error);
        this.#startBackendCleanup(active, error);
        result = failureResult(
          active.request,
          active.startedAt,
          this.#clock(),
          error,
          active.controller.signal,
          active.usage,
        );
      }
      const accepted = await this.#persistence.completeAttempt(
        active.request.attemptId,
        active.fence,
        result,
      );
      await this.#persistence.revokeLease(active.request.invocationId, result.finishedAt);
      if (!accepted) return this.#lateResult(active.request.invocationId, active);
      await this.#event(
        active.request,
        `execution.${result.status}`,
        result.status,
        { summary: result.summary },
      );
      const terminal = productResult(result);
      active.completion.resolve(terminal);
      await this.#cleanupStream(active, terminal);
      return terminal;
    });
    return active.settlementPromise;
  }

  async #failStream(active, cause) {
    const error = cause instanceof ExecutionBrokerError
      ? cause
      : new ExecutionBrokerError(
          typeof cause?.code === "string" ? cause.code : "execution_stream_failed",
          cause?.message,
          { status: TERMINAL.has(cause?.status) ? cause.status : "failed" },
        );
    if (!active.controller.signal.aborted) active.controller.abort(error);
    active.terminalInterrupt.resolve({ kind: "error", error });
    if (active.settlementPromise) {
      this.#startBackendCleanup(active, error);
      return active.settlementPromise;
    }
    return this.#settleStream(active, async () => { throw error; }, { bounded: false });
  }

  async #retireStaleStream(active, error) {
    if (!active.controller.signal.aborted) active.controller.abort(error);
    await this.#boundedBackendCleanup(active, error).catch(() => {});
    const terminal = failureResult(
      active.request,
      active.startedAt,
      this.#clock(),
      error,
      active.controller.signal,
      active.usage,
    );
    active.completion.resolve(productResult(terminal));
    await this.#cleanupStream(active, terminal);
  }

  async #awaitStreamBackend(active, operation, { bounded = true } = {}) {
    const backend = bounded
      ? withDeadline(
          operation,
          this.#streamBackendSettlementTimeoutMs,
          () => new ExecutionBrokerError(
            "execution_stream_provider_timeout",
            "The Realtime Provider did not settle before the deadline.",
            { status: "timeout" },
          ),
        )
      : operation;
    return Promise.race([
      backend.then((value) => ({ kind: "backend", value })),
      active.terminalInterrupt.promise.then((outcome) => {
        if (outcome.kind === "error") throw outcome.error;
        return outcome;
      }),
    ]);
  }

  #boundedBackendCleanup(active, reason, handle = active.streamHandle) {
    if (typeof active.backend?.cancel !== "function") return Promise.resolve(null);
    return withDeadline(
      Promise.resolve().then(() => active.backend.cancel({
        invocationId: active.request.invocationId,
        request: structuredClone(active.request),
        handle,
        reason,
      })),
      this.#streamBackendSettlementTimeoutMs,
      () => new ExecutionBrokerError("execution_stream_cleanup_timeout", undefined, { status: "timeout" }),
    );
  }

  #startBackendCleanup(active, reason, handle = active.streamHandle) {
    void this.#boundedBackendCleanup(active, reason, handle).catch(() => {});
  }

  async #finishedStreamResult(invocationId, authority) {
    const invocation = await this.#persistence.getInvocation(invocationId);
    if (!invocation?.result) throw new ExecutionBrokerError("execution_stream_not_active");
    if (!authority
      || invocation.attemptId !== authority.attemptId
      || invocation.executionFence !== authority.fence
      || invocation.capabilityLeaseId !== authority.capabilityLeaseId) {
      throw new ExecutionBrokerError(
        "execution_stream_authority_invalid",
        "The Realtime stream authority is stale or invalid.",
        { status: "permission_denied" },
      );
    }
    return productResult(invocation.result);
  }

  async #cleanupStream(active, terminal) {
    if (active.timeout) clearTimeout(active.timeout);
    active.callerSignal?.removeEventListener("abort", active.abortFromCaller);
    active.authoritySignal?.removeEventListener("abort", active.abortFromAuthority);
    if (this.#active.get(active.request.invocationId) === active) {
      this.#active.delete(active.request.invocationId);
    }
    try {
      await Promise.resolve(active.onTerminal?.(terminal));
    } catch (error) {
      await this.#event(
        active.request,
        "execution.stream_cleanup_failed",
        terminal.status,
        { reasonCode: typeof error?.code === "string" ? error.code : "stream_terminal_cleanup_failed" },
      ).catch(() => {});
    }
  }

  listInvocations(query) {
    return this.#persistence.listInvocations(query);
  }

  getInvocation(invocationId) {
    return this.#persistence.getInvocation(invocationId);
  }

  listEvents(invocationIds, after, limit) {
    return this.#persistence.listEvents(invocationIds, after, limit);
  }

  async #event(request, type, status, payload, options = {}) {
    return this.#persistence.appendEvent(request.invocationId, (sequence) => ({
      schemaVersion: SCHEMA_VERSION,
      eventId: this.#idFactory("execution-event"),
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      sequence,
      type,
      status,
      payload: structuredClone(payload),
      occurredAt: this.#clock(),
    }), options);
  }

  #deferExecutionSettlement(request, fence, result) {
    if (this.#deferredSettlements.has(request.invocationId)) {
      throw new ExecutionBrokerError("execution_deferred_settlement_already_pending");
    }
    const token = Object.freeze({
      schemaVersion: "workbench-deferred-execution-settlement-v1",
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      fence,
      result: Object.freeze(structuredClone(result)),
    });
    this.#deferredSettlements.set(request.invocationId, Object.freeze({
      token,
      request: Object.freeze(structuredClone(request)),
      result: Object.freeze(structuredClone(result)),
      fence,
    }));
    return token;
  }

  async #checkpoint(request, fence, state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new ExecutionBrokerError("execution_checkpoint_invalid");
    }
    return this.#persistence.writeCheckpoint({
      schemaVersion: SCHEMA_VERSION,
      checkpointId: this.#idFactory("execution-checkpoint"),
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      fence,
      state: structuredClone(state),
      createdAt: this.#clock(),
    });
  }

  #createChildRecorder({ parentRequest, parentLease, signal, capacityPool }) {
    const records = new Map();
    const availableCapacity = [...capacityPool.leases];
    const allCapacity = [...capacityPool.leases];
    const releasedCapacity = new Set();
    let queue = Promise.resolve();
    let totalSteps = 0;
    let totalModelRequests = 0;
    const report = (update) => {
      const operation = queue.then(() => record(update));
      queue = operation.catch(() => {});
      return operation;
    };
    const record = async (child) => {
      if (signal?.aborted) throw signal.reason;
      if (!isObject(child) || typeof child.childRef !== "string" || child.childRef.length < 1 || child.childRef.length > 128) {
        throw new ExecutionBrokerError("orchestrator_child_update_invalid");
      }
      const parent = await this.#persistence.getInvocation(parentRequest.invocationId);
      if (!parent || parent.status !== "running" || parent.executionFence !== parentLease.fence) {
        throw new ExecutionBrokerError("execution_result_rejected_by_fence");
      }
      const childRef = child.childRef;
      let state = records.get(childRef);
      if (!state) {
        const spawnLimit = Math.min(parentRequest.limits.maxSpawnedChildren ?? 100, 100);
        if (records.size >= spawnLimit) {
          throw new ExecutionBrokerError("execution_child_budget_exceeded");
        }
        assertAllowedChild(parentRequest, child);
        if (typeof this.#persistence.reserveChildSpawn !== "function") {
          throw new ExecutionBrokerError("execution_child_spawn_authority_unavailable", undefined, { status: "blocked" });
        }
        const spawnReserved = await this.#persistence.reserveChildSpawn({
          workspaceId: parentRequest.workspaceId,
          sessionId: parentRequest.lineage?.sessionId ?? null,
          parentInvocationId: parentRequest.invocationId,
          childRef,
          limit: spawnLimit,
          occurredAt: this.#clock(),
        });
        if (!spawnReserved) throw new ExecutionBrokerError("execution_child_spawn_limit_exceeded", undefined, { status: "blocked" });
        const capabilities = child?.capabilities ?? parentRequest.capabilities;
        if (!capabilitiesAreSubset(capabilities, parentLease.capabilities)) {
          throw new ExecutionBrokerError("execution_child_capability_escalation", "Child Worker requested broader capabilities.", { status: "permission_denied" });
        }
        const createdAt = this.#clock();
        const invocationId = this.#idFactory("invocation");
        const attemptId = this.#idFactory("execution-attempt");
        const capacityLease = availableCapacity.shift();
        if (!capacityLease) {
          throw new ExecutionBrokerError(
            "execution_child_capacity_exhausted",
            "The admitted orchestrator child concurrency is exhausted.",
            { status: "blocked" },
          );
        }
        const childRequest = {
          schemaVersion: SCHEMA_VERSION,
          invocationId,
          attemptId,
          workspaceId: parentRequest.workspaceId,
          actor: structuredClone(parentRequest.actor),
          lineage: {
            ...structuredClone(parentRequest.lineage),
            parentInvocationId: parentRequest.invocationId,
          },
          capacityAuthority: {
            admissionId: capacityLease.admissionId,
            capacityLeaseId: capacityLease.capacityLeaseId,
            fence: capacityLease.fence,
          },
          controller: structuredClone(parentRequest.controller),
          mode: "bounded_agent",
          isolation: parentRequest.isolation,
          goal: String(child?.goal || "Execute orchestrator child work.").slice(0, 8000),
          input: isJsonValue(child?.input) ? structuredClone(child.input) : {},
          limits: {
            timeoutMs: Math.min(child?.limits?.timeoutMs ?? parentRequest.limits.timeoutMs, parentRequest.limits.timeoutMs),
            maxSteps: Math.min(Math.max(child?.limits?.maxSteps ?? parentRequest.limits.maxSteps, 1), parentRequest.limits.maxSteps),
            maxModelRequests: Math.min(Math.max(child?.limits?.maxModelRequests ?? parentRequest.limits.maxModelRequests, 0), parentRequest.limits.maxModelRequests),
            maxChildren: 0,
            maxDepth: 0,
            maxSpawnedChildren: 0,
            maxToolResultChars: parentRequest.limits.maxToolResultChars ?? 320_000,
            maxInputBytes: parentRequest.limits.maxInputBytes,
            maxOutputBytes: parentRequest.limits.maxOutputBytes,
            maxImageCount: 0,
            maxCostUsdMicros: parentRequest.limits.maxCostUsdMicros,
          },
          capabilities: structuredClone(capabilities),
          resultSchema: { type: "object", additionalProperties: true },
          evidenceRequirements: [],
          metadata: {
            parentInvocationId: parentRequest.invocationId,
            externalChildRef: childRef,
            orchestrationDepth: boundedOrchestrationDepth(parentRequest) + 1,
            ...(parentRequest.metadata?.modelProfileRevisionId ? {
              modelProfileRevisionId: parentRequest.metadata.modelProfileRevisionId,
              modelCapability: parentRequest.metadata.modelCapability
                ?? parentRequest.metadata.capability
                ?? "structured_output",
              fallbackModelProfileRevisionIds: structuredClone(
                parentRequest.metadata.fallbackModelProfileRevisionIds ?? [],
              ),
            } : parentRequest.metadata?.modelProfileId ? {
              legacyModelProfileId: parentRequest.metadata.modelProfileId,
            } : {}),
          },
        };
        validateRequest(childRequest);
        if (!await this.#capacityAuthorizer.authorize(childRequest)) {
          throw new ExecutionBrokerError(
            "execution_child_capacity_lease_invalid",
            "Child Worker requires a valid Product-owned Capacity Lease.",
            { status: "permission_denied" },
          );
        }
        const childLease = {
          schemaVersion: SCHEMA_VERSION,
          capabilityLeaseId: this.#idFactory("capability-lease"),
          invocationId,
          attemptId,
          workspaceId: parentRequest.workspaceId,
          fence: parentLease.fence,
          status: "active",
          capabilities: structuredClone(capabilities),
          issuedAt: createdAt,
          expiresAt: parentLease.expiresAt,
          revokedAt: null,
          updatedAt: createdAt,
        };
        await this.#persistence.createInvocation({
          schemaVersion: SCHEMA_VERSION,
          invocationId,
          attemptId,
          workspaceId: parentRequest.workspaceId,
          controller: structuredClone(parentRequest.controller),
          mode: "bounded_agent",
          isolation: parentRequest.isolation,
          request: structuredClone(childRequest),
          parentInvocationId: parentRequest.invocationId,
          status: "queued",
          eventSequence: 0,
          executionFence: parentLease.fence,
          result: null,
          startedAt: null,
          finishedAt: null,
          createdAt,
          updatedAt: createdAt,
        });
        await this.#persistence.createAttempt({
          schemaVersion: SCHEMA_VERSION,
          attemptId,
          invocationId,
          attemptNumber: 1,
          status: "queued",
          fence: parentLease.fence,
          checkpointSequence: 0,
          result: null,
          startedAt: null,
          finishedAt: null,
          createdAt,
          updatedAt: createdAt,
        });
        await this.#persistence.issueLease(childLease);
        const startedAt = this.#clock();
        await this.#persistence.markRunning(invocationId, attemptId, startedAt);
        await this.#event(childRequest, "execution.started", "running", { parentInvocationId: parentRequest.invocationId });
        state = {
          childRef,
          childRequest,
          childLease,
          capacityLease,
          startedAt,
          terminal: false,
          lastStatus: "running",
        };
        records.set(childRef, state);
        await this.#event(parentRequest, "execution.child_started", "running", { childInvocationId: invocationId, childRef });
      }
      if (state.terminal) return childBinding(state);
      if (child.checkpoint !== undefined) {
        await this.#checkpoint(state.childRequest, state.childLease.fence, {
          phase: "orchestrator_child",
          externalChildRef: state.childRef,
          state: structuredClone(child.checkpoint),
        });
      }
      const status = normalizeLiveChildStatus(child.status);
      if (!TERMINAL.has(status)) {
        state.lastStatus = status;
        await this.#event(state.childRequest, "execution.progress", "running", {
          externalChildRef: state.childRef,
          status,
          ...(typeof child.summary === "string" ? { summary: child.summary.slice(0, 4000) } : {}),
        });
        return childBinding(state);
      }
      const childUsage = {
        steps: Number(child?.usage?.steps ?? 0),
        modelRequests: Number(child?.usage?.modelRequests ?? 0),
        inputBytes: Number(child?.usage?.inputBytes ?? byteLength(child?.input)),
        outputBytes: Number(child?.usage?.outputBytes ?? byteLength(child?.output)),
        imageCount: Number(child?.usage?.imageCount ?? 0),
        costUsdMicros: Number(child?.usage?.costUsdMicros ?? 0),
      };
      totalSteps += childUsage.steps;
      totalModelRequests += childUsage.modelRequests;
      if (totalSteps > parentRequest.limits.maxSteps || totalModelRequests > parentRequest.limits.maxModelRequests) {
        throw new ExecutionBrokerError("execution_child_budget_exceeded");
      }
      const childResult = normalizeResult({
        request: state.childRequest,
        startedAt: state.startedAt,
        finishedAt: this.#clock(),
        backendResult: {
          status,
          output: isObject(child?.output) ? structuredClone(child.output) : {},
          summary: String(child?.summary || "Orchestrator child completed.").slice(0, 4000),
          evidence: Array.isArray(child?.evidence) ? child.evidence.filter(isObject).map((item) => structuredClone(item)) : [],
          usage: childUsage,
        },
      });
      validateResultAgainstRequest(state.childRequest, childResult);
      const accepted = await this.#persistence.completeAttempt(state.childRequest.attemptId, state.childLease.fence, childResult);
      if (!accepted) throw new ExecutionBrokerError("execution_result_rejected_by_fence");
      await this.#persistence.revokeLease(state.childRequest.invocationId, childResult.finishedAt);
      await this.#event(state.childRequest, `execution.${childResult.status}`, childResult.status, { summary: childResult.summary });
      await this.#event(parentRequest, "execution.child_recorded", "running", { childInvocationId: state.childRequest.invocationId, status: childResult.status });
      returnChildCapacity(state);
      state.terminal = true;
      state.lastStatus = childResult.status;
      return childBinding(state);
    };
    const cancelAll = async (error) => {
      await queue;
      for (const state of records.values()) {
        if (state.terminal) continue;
        const now = this.#clock();
        await this.#persistence.requestCancel(state.childRequest.invocationId, now);
        await this.#persistence.revokeLease(state.childRequest.invocationId, now);
        const childCancelError = new ExecutionBrokerError(
          "execution_parent_cancelled",
          error?.message ?? "Parent execution stopped.",
          { status: "cancelled" },
        );
        const result = failureResult(state.childRequest, state.startedAt, this.#clock(), childCancelError);
        await this.#persistence.cancelAttempt(state.childRequest.invocationId, result);
        await this.#event(state.childRequest, "execution.cancelled", "cancelled", { summary: result.summary });
        returnChildCapacity(state);
        state.terminal = true;
        state.lastStatus = "cancelled";
      }
      await releaseUnusedCapacity();
    };
    return Object.freeze({
      report,
      async finalize(children) {
        if (children !== undefined) {
          if (!Array.isArray(children)) throw new ExecutionBrokerError("orchestrator_children_invalid");
          for (const child of children) await report(child);
        }
        await queue;
        if ([...records.values()].some((item) => !item.terminal)) {
          throw new ExecutionBrokerError("orchestrator_child_terminal_missing");
        }
        await releaseUnusedCapacity();
        return [...records.values()].map((item) => item.childRequest.invocationId);
      },
      cancelAll,
    });

    function returnChildCapacity(state) {
      if (!state.capacityLease) return;
      availableCapacity.push(state.capacityLease);
      state.capacityLease = null;
    }

    async function releaseChildCapacity(capacityLeaseId) {
      if (!capacityLeaseId || releasedCapacity.has(capacityLeaseId)) return;
      releasedCapacity.add(capacityLeaseId);
      await capacityPool.release(capacityLeaseId);
    }

    async function releaseUnusedCapacity() {
      availableCapacity.splice(0);
      await Promise.all(allCapacity.map((item) => releaseChildCapacity(item.capacityLeaseId)));
    }
  }

  async #lateResult(invocationId, active = null) {
    await active?.cancellationPromise;
    const invocation = await this.#persistence.getInvocation(invocationId);
    if (invocation?.result) return productResult(invocation.result);
    throw new ExecutionBrokerError("execution_result_rejected_by_fence", "A late execution result was rejected.");
  }
}

export function createDeterministicSkillBackend({ agentRuntime, materialResolver = null } = {}) {
  if (typeof agentRuntime?.invokeSkillNode !== "function") throw new TypeError("deterministic_skill_runtime_required");
  if (materialResolver !== null && typeof materialResolver !== "function") {
    throw new TypeError("deterministic_skill_material_resolver_invalid");
  }
  return {
    async execute({ request, signal, checkpoint }) {
      await checkpoint({ phase: "dispatching" });
      const materials = request.metadata?.materialBindings?.length
        ? await materialResolver?.({
          workspaceId: request.workspaceId,
          requestedBy: request.metadata.requestedBy,
          bindings: request.metadata.materialBindings,
          requirements: request.metadata.materialRequirements ?? [],
          signal,
        })
        : [];
      if (request.metadata?.materialBindings?.length && materials?.length !== request.metadata.materialBindings.length) {
        throw new ExecutionBrokerError(
          "skill_material_unavailable",
          "One or more Skill materials are unavailable.",
          { status: "blocked" },
        );
      }
      const inputBytes = byteLength(request.input)
        + materials.reduce((total, material) => total + (material.bytes?.byteLength ?? 0), 0);
      if (inputBytes > request.limits.maxInputBytes) {
        throw new ExecutionBrokerError(
          "execution_input_too_large",
          "The Skill input and governed materials exceed the execution budget.",
          { status: "blocked" },
        );
      }
      const output = await agentRuntime.invokeSkillNode({
        invocationId: request.invocationId,
        workspaceId: request.workspaceId,
        executionRef: structuredClone(request.metadata.executionRef),
        input: structuredClone(request.input),
        materials,
        timeoutMs: request.limits.timeoutMs,
        signal,
      });
      return {
        output,
        summary: "Deterministic Skill completed.",
        evidence: [],
        usage: {
          steps: 1,
          modelRequests: 0,
          inputBytes,
          outputBytes: byteLength(output),
        },
      };
    },
  };
}

export function capabilitiesAreSubset(child, parent) {
  const tools = new Set(parent.toolAllowlist);
  const connections = new Set(parent.connectionIds);
  const fsRank = { none: 0, scratch_readonly: 1, scratch_write: 2 };
  return child.toolAllowlist.every((item) => tools.has(item))
    && child.connectionIds.every((item) => connections.has(item))
    && (!child.network || parent.network)
    && (!child.externalActions || parent.externalActions)
    && fsRank[child.filesystem] <= fsRank[parent.filesystem];
}

function validateRequest(request) {
  if (!Check(ExecutionRequestSchema, request)) {
    throw new ExecutionBrokerError("execution_request_invalid", "Execution request does not match the public contract.");
  }
  if (request.controller?.kind === "member_agent_request" && !Check(MemberAgentExecutionRequestSchema,request)) throw new ExecutionBrokerError("member_agent_execution_profile_invalid");
  if (byteLength(request.input) > request.limits.maxInputBytes) {
    throw new ExecutionBrokerError("execution_input_too_large");
  }
  if (request.mode === "deterministic_skill" && (request.limits.maxModelRequests !== 0 || request.limits.maxChildren !== 0)) {
    throw new ExecutionBrokerError("deterministic_skill_agent_budget_forbidden");
  }
  if (request.mode === "bounded_agent" && request.limits.maxChildren !== 0) {
    throw new ExecutionBrokerError("bounded_agent_children_forbidden");
  }
  if (request.mode === "agent_orchestrator") {
    if (request.limits.maxChildren > 4
      || (request.limits.maxSpawnedChildren ?? request.limits.maxChildren) > 100
      || boundedOrchestrationDepth(request) > 2) {
      throw new ExecutionBrokerError("execution_orchestrator_budget_invalid");
    }
    const allowedChildren = normalizedAllowedChildren(request.metadata?.allowedChildren);
    if (request.limits.maxChildren > 0 && allowedChildren.length === 0) {
      throw new ExecutionBrokerError("execution_allowed_children_required");
    }
  }
  if (request.mode === "model_call" && (
    request.isolation === "container"
    || request.limits.maxChildren !== 0
    || request.limits.maxModelRequests < 1
    || request.capabilities.toolAllowlist.length !== 0
    || request.capabilities.connectionIds.length !== 0
    || request.capabilities.network !== false
    || request.capabilities.filesystem !== "none"
    || request.capabilities.externalActions !== false
    || typeof request.modelProfileRevisionId !== "string"
    || typeof request.modelCapability !== "string"
  )) {
    throw new ExecutionBrokerError("model_call_capabilities_invalid");
  }
  if (request.mode === "realtime_audio" && (
    request.isolation !== "process"
    || request.modelCapability !== "realtime_audio"
    || request.limits.maxChildren !== 0
    || (request.limits.maxDepth ?? 0) !== 0
    || (request.limits.maxSpawnedChildren ?? 0) !== 0
    || request.limits.maxModelRequests < 1
    || request.limits.maxImageCount !== 0
    || request.fallbackModelProfileRevisionIds.length !== 0
    || request.capabilities.connectionIds.length !== 0
    || request.capabilities.network !== false
    || request.capabilities.filesystem !== "none"
    || request.capabilities.externalActions !== false
  )) {
    throw new ExecutionBrokerError("realtime_audio_capabilities_invalid");
  }
}

function assertPreparedExecutionMatchesRequest(prepared, request) {
  if (!prepared || typeof prepared !== "object"
    || prepared.schemaVersion !== "workbench-prepared-execution-v1"
    || prepared.invocationId !== request.invocationId
    || prepared.attemptId !== request.attemptId
    || !Number.isInteger(prepared.fence)
    || prepared.fence < 1
    || prepared.lease?.invocationId !== request.invocationId
    || prepared.lease?.attemptId !== request.attemptId
    || prepared.lease?.workspaceId !== request.workspaceId
    || prepared.lease?.fence !== prepared.fence
    || prepared.lease?.status !== "active"
    || typeof prepared.createdAt !== "string"
    || !Number.isFinite(Date.parse(prepared.createdAt))
    || (prepared.startedAt !== null
      && (typeof prepared.startedAt !== "string" || !Number.isFinite(Date.parse(prepared.startedAt))))) {
    throw new ExecutionBrokerError("execution_prepared_authority_invalid", "The prepared execution authority does not match this request.", {
      status: "permission_denied",
    });
  }
}

function assertChildCapacityPool(request, childCapacityPool) {
  if (request.mode !== "agent_orchestrator") return;
  if (!childCapacityPool
    || !Array.isArray(childCapacityPool.leases)
    || typeof childCapacityPool.release !== "function"
    || (request.limits.maxChildren > 0 && childCapacityPool.leases.length < 1)) {
    throw new ExecutionBrokerError(
      "execution_child_capacity_unavailable",
      "Orchestrator children require Product-owned Capacity Leases before launch.",
      { status: "blocked" },
    );
  }
}

function assertAllowedChild(parentRequest, child) {
  const allowed = normalizedAllowedChildren(parentRequest.metadata?.allowedChildren);
  const identities = [child?.role, child?.kind, child?.childRef]
    .filter((value) => typeof value === "string" && value.length > 0);
  if (!identities.some((identity) => allowed.includes(identity))) {
    throw new ExecutionBrokerError(
      "execution_child_not_allowed",
      "The orchestrator child is not declared by Product policy.",
      { status: "permission_denied" },
    );
  }
}

function normalizedAllowedChildren(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100
    || value.some((item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item))) {
    throw new ExecutionBrokerError("execution_allowed_children_invalid");
  }
  return [...new Set(value)];
}

function boundedOrchestrationDepth(request) {
  const depth = request.metadata?.orchestrationDepth ?? 1;
  if (!Number.isInteger(depth) || depth < 0 || depth > 8) {
    throw new ExecutionBrokerError("execution_orchestrator_depth_invalid");
  }
  const maximum = request.limits.maxDepth ?? 2;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 8 || depth > maximum) {
    throw new ExecutionBrokerError("execution_orchestrator_depth_exceeded");
  }
  return depth;
}

function validateResultAgainstRequest(request, result) {
  if (!Check(ExecutionResultSchema, result)) throw new ExecutionBrokerError("execution_result_invalid");
  if ((request.controller.kind === "member_agent_request") !== (result.usageAccounting === "local_unmetered")) throw new ExecutionBrokerError("execution_result_accounting_invalid");
  if (result.output !== undefined && !Check(request.resultSchema, result.output)) {
    throw new ExecutionBrokerError("execution_result_schema_mismatch");
  }
  if (result.usage.modelRequests > request.limits.maxModelRequests || result.usage.steps > request.limits.maxSteps) {
    throw new ExecutionBrokerError("execution_budget_exceeded");
  }
  if (result.usage.imageCount > request.limits.maxImageCount
    || result.usage.costUsdMicros > request.limits.maxCostUsdMicros) {
    throw new ExecutionBrokerError("execution_budget_exceeded");
  }
  if ((request.limits.maxInputTokens !== undefined
      && result.usage.inputTokens > request.limits.maxInputTokens)
    || (request.limits.maxOutputTokens !== undefined
      && result.usage.outputTokens > request.limits.maxOutputTokens)) {
    throw new ExecutionBrokerError("execution_budget_exceeded");
  }
  if (result.usage.outputBytes > request.limits.maxOutputBytes || byteLength(result.output) > request.limits.maxOutputBytes) {
    throw new ExecutionBrokerError("execution_output_too_large");
  }
}

function assertCapabilityAllowed(capabilities, capability) {
  if (capability?.kind === "tool" && capabilities.toolAllowlist.includes(capability.id)) return true;
  if (capability?.kind === "connection" && capabilities.connectionIds.includes(capability.id)) return true;
  if (capability?.kind === "network" && capabilities.network) return true;
  if (capability?.kind === "external_action" && capabilities.externalActions) return true;
  throw new ExecutionBrokerError("execution_permission_denied", "The capability lease does not allow this operation.", { status: "permission_denied" });
}

function normalizeResult({ request, startedAt, finishedAt, backendResult }) {
  const result = {
    schemaVersion: SCHEMA_VERSION,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    status: backendResult?.status ?? "completed",
    isolation: request.isolation,
    requestedModelRevisionId: backendResult?.requestedModelRevisionId
      ?? (["model_call", "realtime_audio"].includes(request.mode)
        ? request.modelProfileRevisionId
        : request.metadata?.modelProfileRevisionId)
      ?? null,
    actualModelRevisionId: backendResult?.actualModelRevisionId ?? null,
    artifactRefs: structuredClone(backendResult?.artifactRefs ?? []),
    ...(backendResult && Object.hasOwn(backendResult, "output") ? { output: structuredClone(backendResult.output) } : {}),
    summary: String(backendResult?.summary || "Execution completed.").slice(0, 4000),
    evidence: Array.isArray(backendResult?.evidence) ? structuredClone(backendResult.evidence) : [],
    usage: {
      steps: backendResult?.usage?.steps ?? 0,
      modelRequests: backendResult?.usage?.modelRequests ?? 0,
      inputBytes: backendResult?.usage?.inputBytes ?? byteLength(request.input),
      outputBytes: backendResult?.usage?.outputBytes ?? byteLength(backendResult?.output),
      imageCount: backendResult?.usage?.imageCount ?? 0,
      costUsdMicros: backendResult?.usage?.costUsdMicros ?? 0,
      inputTokens: backendResult?.usage?.inputTokens ?? 0,
      outputTokens: backendResult?.usage?.outputTokens ?? 0,
      totalTokens: backendResult?.usage?.totalTokens ?? 0,
      audioInputTokens: backendResult?.usage?.audioInputTokens ?? 0,
      audioOutputTokens: backendResult?.usage?.audioOutputTokens ?? 0,
      cachedInputTokens: backendResult?.usage?.cachedInputTokens ?? 0,
    },
    startedAt,
    finishedAt,
  };
  return productResult(executionAccounting(request,result));
}

function failureResult(request, startedAt, finishedAt, error, signal, usage = null) {
  const cause = signal?.aborted ? signal.reason ?? error : error;
  const status = cause?.status && TERMINAL.has(cause.status) ? cause.status : "failed";
  return productResult(executionAccounting(request,{
    schemaVersion: SCHEMA_VERSION,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    status,
    isolation: request.isolation,
    requestedModelRevisionId: ["model_call", "realtime_audio"].includes(request.mode)
      ? request.modelProfileRevisionId
      : request.metadata?.modelProfileRevisionId ?? null,
    actualModelRevisionId: null,
    artifactRefs: [],
    summary: safeFailureSummary(status, cause?.code),
    ...(PUBLIC_FAILURE_CODES.has(cause?.code) ? { failureCode: cause.code } : {}),
    evidence: [],
    usage: usage
      ? normalizedUsage(usage, "execution_usage_invalid")
      : { ...EMPTY_USAGE, inputBytes: byteLength(request.input) },
    startedAt,
    finishedAt,
  }));
}

function unavailableFor(request) {
  if (request.isolation === "remote") {
    return new ExecutionBrokerError("remote_backend_unavailable", "Remote execution is unavailable.", { status: "remote_backend_unavailable" });
  }
  if (request.isolation === "container") {
    return new ExecutionBrokerError("sandbox_unavailable", "The required sandbox is unavailable.", { status: "sandbox_unavailable" });
  }
  return new ExecutionBrokerError("execution_backend_unavailable", "The execution backend is unavailable.", { status: "blocked" });
}

function safeFailureSummary(status, reasonCode) {
  if (reasonCode === "provider_payment_required") return "The model provider requires account credit or billing action. Ask the account owner to resolve billing, or select another authorized model before retrying.";
  if (reasonCode === "capacity_lease_lost") return "Execution capacity lease was lost.";
  if (reasonCode === "capacity_lease_heartbeat_failed") {
    return "Execution capacity lease heartbeat failed.";
  }
  return {
    cancelled: "Execution cancelled.",
    timeout: "Execution timed out.",
    permission_denied: "Execution permission denied.",
    blocked: "Execution is blocked.",
    sandbox_unavailable: "The required sandbox is unavailable.",
    remote_backend_unavailable: "The remote backend is unavailable.",
    partial: "Execution stopped after one or more external effects may have completed.",
    effect_outcome_unknown: "Execution stopped, but an external effect outcome is unknown.",
  }[status] ?? "Execution failed.";
}

function executionAuthorityFailure(reason) {
  const reasonCode = ["capacity_lease_lost", "capacity_lease_heartbeat_failed"].includes(reason?.code)
    ? reason.code
    : "execution_capacity_authority_lost";
  const message = reasonCode === "capacity_lease_lost"
    ? "Execution capacity lease was lost."
    : reasonCode === "capacity_lease_heartbeat_failed"
      ? "Execution capacity lease heartbeat failed."
      : "Execution capacity authority was lost.";
  return new ExecutionBrokerError(reasonCode, message, { status: "failed" });
}

function cancellationSettlementStatus({ active, request, backendCancellation }) {
  if (!active) return "cancelled";
  if (backendCancellation?.status === "cancelled") return "cancelled";
  if (backendCancellation?.status === "partial") return "partial";
  if (backendCancellation?.status === "effect_outcome_unknown") return "effect_outcome_unknown";
  return request?.capabilities?.externalActions ? "effect_outcome_unknown" : "cancelled";
}

function executionAccounting(request,result) {
  if(request.controller?.kind!=="member_agent_request") return result;
  return {...result,usageAccounting:"local_unmetered",usage:{steps:null,modelRequests:null,costUsdMicros:null,inputBytes:result.usage.inputBytes,outputBytes:result.usage.outputBytes,imageCount:0}};
}

function productResult(result) {
  return structuredClone(result);
}

function byteLength(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeExternalChildStatus(status) {
  return TERMINAL.has(status) ? status : status === "interrupted" ? "cancelled" : status === "skipped" ? "partial" : "failed";
}

function normalizeLiveChildStatus(status) {
  return ["pending", "queued", "launching", "running"].includes(status)
    ? "running"
    : normalizeExternalChildStatus(status);
}

function childBinding(state) {
  return {
    childRef: state.childRef,
    invocationId: state.childRequest.invocationId,
    attemptId: state.childRequest.attemptId,
    capabilityLeaseId: state.childLease.capabilityLeaseId,
    capabilities: structuredClone(state.childLease.capabilities),
    status: state.lastStatus,
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value) || isObject(value);
}

function backendKey(mode, isolation) {
  return `${mode}:${isolation}`;
}

function validateRealtimeOffer(offer) {
  if (!isObject(offer)
    || typeof offer.sdpOffer !== "string"
    || Buffer.byteLength(offer.sdpOffer, "utf8") > 256_000
    || !offer.sdpOffer.startsWith("v=0")
    || /(?:^|\r?\n)m=application\s/i.test(offer.sdpOffer)) {
    throw new ExecutionBrokerError("execution_stream_offer_invalid");
  }
}

function assertSafeRealtimeSdp(value) {
  if (Buffer.byteLength(value, "utf8") > 256_000
    || !value.startsWith("v=0")
    || /(?:^|\r?\n)m=application\s/i.test(value)) {
    throw new ExecutionBrokerError("execution_stream_ready_invalid");
  }
}

function validateRealtimeSessionConfig(value) {
  if (!isObject(value) || !isBoundedJsonTree(value) || byteLength(value) > 256_000) {
    throw new ExecutionBrokerError("execution_stream_session_config_invalid");
  }
}

function isBoundedJsonTree(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || depth > 16 || seen.has(value)) return false;
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  if (items.length > 2_000) return false;
  return items.every((item) => isBoundedJsonTree(item, depth + 1, seen));
}

function streamAuthority(active) {
  return {
    attemptId: active.request.attemptId,
    capabilityLeaseId: active.lease.capabilityLeaseId,
    fence: active.fence,
  };
}

function normalizedUsage(value, code) {
  if (!isObject(value)) throw new ExecutionBrokerError(code);
  const result = {};
  for (const name of Object.keys(EMPTY_USAGE)) {
    const amount = value[name] ?? 0;
    if (!Number.isInteger(amount) || amount < 0) throw new ExecutionBrokerError(code);
    result[name] = amount;
  }
  if (result.imageCount > 16) throw new ExecutionBrokerError(code);
  if (result.totalTokens !== result.inputTokens + result.outputTokens
    || result.audioInputTokens > result.inputTokens
    || result.audioOutputTokens > result.outputTokens
    || result.cachedInputTokens > result.inputTokens) {
    throw new ExecutionBrokerError(code);
  }
  return result;
}

function assertUsageWithinLimits(request, usage) {
  if (usage.steps > request.limits.maxSteps
    || usage.modelRequests > request.limits.maxModelRequests
    || usage.inputBytes > request.limits.maxInputBytes
    || usage.outputBytes > request.limits.maxOutputBytes
    || usage.imageCount > request.limits.maxImageCount
    || usage.costUsdMicros > request.limits.maxCostUsdMicros
    || (request.limits.maxInputTokens !== undefined
      && usage.inputTokens > request.limits.maxInputTokens)
    || (request.limits.maxOutputTokens !== undefined
      && usage.outputTokens > request.limits.maxOutputTokens)) {
    throw new ExecutionBrokerError("execution_budget_exceeded");
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function withDeadline(promise, timeoutMs, errorFactory) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(errorFactory()), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function normalizedRealtimeProductEvent(type, payload) {
  if (!isObject(payload)) throw new ExecutionBrokerError("execution_stream_event_invalid");
  if (type === "realtime.state") {
    assertExactKeys(payload, ["state", "reasonCode"]);
    if (![
      "connecting", "connected", "listening", "thinking", "speaking",
      "reconnecting", "disconnected",
    ].includes(payload.state)
      || (payload.reasonCode !== undefined && !isReasonCode(payload.reasonCode))) {
      throw new ExecutionBrokerError("execution_stream_event_invalid");
    }
    return {
      type,
      payload: {
        state: payload.state,
        ...(payload.reasonCode ? { reasonCode: payload.reasonCode } : {}),
      },
    };
  }
  if (type === "realtime.diagnostic") {
    assertExactKeys(payload, ["reasonCode", "severity", "retryable"]);
    if (!isReasonCode(payload.reasonCode)
      || !["info", "warning", "error"].includes(payload.severity)
      || typeof payload.retryable !== "boolean") {
      throw new ExecutionBrokerError("execution_stream_event_invalid");
    }
    return {
      type,
      payload: {
        reasonCode: payload.reasonCode,
        severity: payload.severity,
        retryable: payload.retryable,
      },
    };
  }
  throw new ExecutionBrokerError("execution_stream_event_invalid");
}

function normalizedRealtimeServiceEvent(event) {
  if (!isObject(event) || typeof event.type !== "string") {
    throw new ExecutionBrokerError("execution_stream_service_event_invalid");
  }
  if (event.type === "state") {
    assertExactKeys(event, ["type", "state", "reasonCode"]);
    const normalized = normalizedRealtimeProductEvent("realtime.state", {
      state: event.state,
      ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
    });
    return { type: "state", ...normalized.payload };
  }
  if (event.type === "function_call") {
    assertExactKeys(event, ["type", "name", "callId", "arguments"]);
    if (!isStableEventId(event.name)
      || !isStableEventId(event.callId)
      || typeof event.arguments !== "string"
      || event.arguments.length > 60_000) {
      throw new ExecutionBrokerError("execution_stream_service_event_invalid");
    }
    return {
      type: "function_call",
      name: event.name,
      callId: event.callId,
      arguments: event.arguments,
    };
  }
  if (event.type === "transcript") {
    assertExactKeys(event, ["type", "segmentId", "speaker", "text", "final"]);
    if (!isStableEventId(event.segmentId)
      || !["user", "assistant"].includes(event.speaker)
      || typeof event.text !== "string"
      || event.text.length > 60_000
      || typeof event.final !== "boolean") {
      throw new ExecutionBrokerError("execution_stream_service_event_invalid");
    }
    return {
      type: "transcript",
      segmentId: event.segmentId,
      speaker: event.speaker,
      text: event.text,
      final: event.final,
    };
  }
  throw new ExecutionBrokerError("execution_stream_service_event_invalid");
}

function assertExactKeys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ExecutionBrokerError("execution_stream_event_invalid");
  }
}

function isReasonCode(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[a-z][a-z0-9_]*$/.test(value);
}

function isStableEventId(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
