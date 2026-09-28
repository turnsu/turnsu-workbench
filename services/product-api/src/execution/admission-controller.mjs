const DEFAULT_LIMITS = Object.freeze({
  user: 4,
  workspace: 8,
  backend: 4,
  provider: 4,
});
const ADMISSION_CONTROLLERS = new WeakSet();
const ACTIVE_PRODUCT_COMMAND_STATUSES = new Set(["accepted", "running"]);
const COMMAND_CONTROLLER_KINDS = Object.freeze({
  member_agent_request_accept: new Set(["member_agent_request"]),
  agent_turn: new Set(["agent_turn"]),
  // The decision command creates a new, linked Agent Turn. It is not a
  // generic execution escape hatch: the target and the request metadata are
  // both checked below against one immutable Tool approval aggregate.
  agent_tool_approval_decide: new Set(["agent_turn"]),
  builder_proposal: new Set(["agent_turn"]),
  skill_creation_realtime_call: new Set(["skill_creation_turn"]),
  skill_creation_turn: new Set(["skill_creation_turn"]),
  skill_test: new Set(["skill_test"]),
  workflow_run: new Set(["workflow_run"]),
});

export class AdmissionControllerError extends Error {
  constructor(code, message = code, { retryable = false } = {}) {
    super(message);
    this.name = "AdmissionControllerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class AdmissionController {
  #persistence;
  #clock;
  #idFactory;
  #leaseDurationMs;
  #limits;
  #orchestratorChildSlots;
  #heartbeatIntervalMs;
  #resolveProductCommand;
  #queues = new Map();
  #userOrder = [];
  #cursor = 0;
  #pumping = false;
  #retryTimer = null;

  constructor({
    persistence,
    clock = () => new Date().toISOString(),
    idFactory,
    leaseDurationMs = 30_000,
    limits = {},
    orchestratorChildSlots = 4,
    heartbeatIntervalMs = 10_000,
    resolveProductCommand,
  } = {}) {
    for (const name of ["markWaiting", "tryAcquire", "authorize", "heartbeat", "listWaiting", "release", "cancelWaiting", "recoverExpired"]) {
      if (typeof persistence?.[name] !== "function") {
        throw new TypeError(`admission_persistence_${name}_required`);
      }
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("admission_clock_and_id_factory_required");
    }
    if (typeof resolveProductCommand !== "function") {
      throw new TypeError("admission_product_command_resolver_required");
    }
    this.#persistence = persistence;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#leaseDurationMs = leaseDurationMs;
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    this.#orchestratorChildSlots = Math.min(Math.max(Number(orchestratorChildSlots) || 1, 1), 16);
    this.#heartbeatIntervalMs = Math.min(
      Math.max(Number(heartbeatIntervalMs) || 1_000, 1_000),
      Math.max(1_000, Math.floor(this.#leaseDurationMs / 3)),
    );
    this.#resolveProductCommand = resolveProductCommand;
    ADMISSION_CONTROLLERS.add(this);
    Object.preventExtensions(this);
  }

  async recover() {
    const released = await this.#persistence.recoverExpired(this.#clock());
    this.#schedulePump();
    return released;
  }

  async acquire({ request, signal } = {}) {
    const descriptor = capacityDescriptor(request);
    await this.#assertActiveProductCommand(request, descriptor);
    const admissionId = request.capacityAuthority?.admissionId
      ?? request.metadata?.admissionId
      ?? this.#idFactory("admission");
    const queuedAt = this.#clock();
    await this.#persistence.markWaiting({
      schemaVersion: "workbench-v1",
      admissionId,
      commandId: descriptor.productCommandId,
      kind: "execution_invocation",
      invocationId: request.invocationId,
      userId: descriptor.userId,
      workspaceId: descriptor.workspaceId,
      sessionId: request.lineage?.sessionId ?? null,
      turnId: request.lineage?.turnId ?? null,
      state: "waiting_capacity",
      queueSlotHeld: false,
      createdAt: queuedAt,
      updatedAt: queuedAt,
      releasedAt: null,
    });
    if (signal?.aborted) {
      await this.#persistence.cancelWaiting(admissionId, this.#clock());
      throw signal.reason ?? new AdmissionControllerError("admission_cancelled");
    }
    return new Promise((resolve, reject) => {
      const waiter = { admissionId, descriptor, request, queuedAt, resolve, reject, signal, abort: null };
      waiter.abort = () => {
        this.#removeWaiter(waiter);
        this.#persistence.cancelWaiting(admissionId, this.#clock()).finally(() => {
          reject(signal.reason ?? new AdmissionControllerError("admission_cancelled"));
        });
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      const queue = this.#queues.get(descriptor.userId) ?? [];
      queue.push(waiter);
      this.#queues.set(descriptor.userId, queue);
      if (!this.#userOrder.includes(descriptor.userId)) this.#userOrder.push(descriptor.userId);
      this.#schedulePump();
    });
  }

  authorize(request) {
    return this.#authorize(request);
  }

  get heartbeatIntervalMs() {
    return this.#heartbeatIntervalMs;
  }

  async heartbeat(lease) {
    if (!lease?.capacityLeaseId || !Number.isInteger(lease.fence)) return null;
    const now = this.#clock();
    const leaseDurationMs = Math.max(
      this.#leaseDurationMs,
      Number(lease.leaseDurationMs) || 0,
    );
    return this.#persistence.heartbeat(lease.capacityLeaseId, {
      fence: lease.fence,
      now,
      expiresAt: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
    });
  }

  async release(capacityLeaseId, { uow = undefined } = {}) {
    if (!capacityLeaseId) return null;
    const released = await this.#persistence.release(capacityLeaseId, this.#clock(), { uow });
    this.#schedulePump();
    return released;
  }

  async readSessionQueue({ userId, workspaceId, sessionId, cursor, limit } = {}) {
    if (!userId || !workspaceId || !sessionId) {
      throw new AdmissionControllerError("admission_queue_identity_missing");
    }
    const result = await this.#persistence.listWaiting({
      userId,
      workspaceId,
      sessionId,
      cursor,
      limit,
    });
    return {
      queuedTurnCount: result.queuedTurnCount,
      items: result.items.map((record) => ({
        admissionId: record.admissionId,
        commandId: record.commandId,
        invocationId: record.invocationId ?? null,
        sessionId: record.sessionId,
        turnId: record.turnId,
        reasonCode: record.state,
        position: record.position,
        estimatedWaitSeconds: record.position * 30,
        approximate: true,
        cancellable: Boolean(record.turnId),
        cancelAction: record.turnId
          ? {
              method: "POST",
              path: `/api/workbench/v1/agent-sessions/${encodeURIComponent(record.sessionId)}/turns/${encodeURIComponent(record.turnId)}/cancel`,
            }
          : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      page: result.page,
    };
  }

  async acquireChildPool({ request, signal } = {}) {
    if (request?.mode !== "agent_orchestrator") return [];
    const slotCount = Math.min(
      Math.max(Number(request.limits?.maxChildren) || 0, 0),
      this.#orchestratorChildSlots,
    );
    const leases = [];
    try {
      for (let slot = 0; slot < slotCount; slot += 1) {
        leases.push(await this.acquire({
          signal,
          request: {
            ...structuredClone(request),
            invocationId: this.#idFactory("child-slot-invocation"),
            attemptId: this.#idFactory("child-slot-attempt"),
            mode: "bounded_agent",
            lineage: {
              ...structuredClone(request.lineage),
              parentInvocationId: request.invocationId,
            },
            metadata: {
              ...structuredClone(request.metadata ?? {}),
              reservedForOrchestrator: request.invocationId,
              childSlot: slot + 1,
            },
          },
        }));
      }
      return leases;
    } catch (error) {
      await Promise.all(leases.map((lease) => this.release(lease.capacityLeaseId)));
      throw error;
    }
  }

  #removeWaiter(waiter) {
    const queue = this.#queues.get(waiter.descriptor.userId) ?? [];
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.#queues.delete(waiter.descriptor.userId);
      const userIndex = this.#userOrder.indexOf(waiter.descriptor.userId);
      if (userIndex >= 0) this.#userOrder.splice(userIndex, 1);
      if (this.#cursor >= this.#userOrder.length) this.#cursor = 0;
    }
    waiter.signal?.removeEventListener("abort", waiter.abort);
  }

  #isCurrentWaiter(waiter) {
    return this.#queues.get(waiter.descriptor.userId)?.[0] === waiter;
  }

  #schedulePump() {
    if (this.#pumping) return;
    this.#pumping = true;
    queueMicrotask(() => this.#pump().finally(() => {
      this.#pumping = false;
      if (this.#queues.size > 0 && !this.#retryTimer) {
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          this.#schedulePump();
        }, 50);
        this.#retryTimer.unref?.();
      }
    }));
  }

  async #pump() {
    if (this.#userOrder.length === 0) return;
    let checked = 0;
    while (checked < this.#userOrder.length && this.#userOrder.length > 0) {
      if (this.#cursor >= this.#userOrder.length) this.#cursor = 0;
      const userId = this.#userOrder[this.#cursor];
      const waiter = this.#queues.get(userId)?.[0];
      this.#cursor = (this.#cursor + 1) % Math.max(this.#userOrder.length, 1);
      checked += 1;
      if (!waiter) continue;
      try {
        await this.#assertActiveProductCommand(waiter.request, waiter.descriptor);
        if (waiter.signal?.aborted || !this.#isCurrentWaiter(waiter)) continue;
        const issuedAt = this.#clock();
        const executionTimeoutMs = Number(waiter.request?.limits?.timeoutMs ?? 0);
        const leaseDurationMs = Math.max(
          this.#leaseDurationMs,
          Number.isFinite(executionTimeoutMs) && executionTimeoutMs > 0
            ? executionTimeoutMs + 5_000
            : 0,
        );
        const lease = await this.#persistence.tryAcquire({
          schemaVersion: "workbench-v1",
          capacityLeaseId: this.#idFactory("capacity-lease"),
          admissionId: waiter.admissionId,
          commandId: waiter.descriptor.productCommandId,
          userId: waiter.descriptor.userId,
          workspaceId: waiter.descriptor.workspaceId,
          backendKey: waiter.descriptor.backendKey,
          providerKey: waiter.descriptor.providerKey,
          dimensions: capacityDimensions(waiter.descriptor, this.#limits),
          fence: 1,
          leaseDurationMs,
          status: "active",
          issuedAt,
          expiresAt: new Date(Date.parse(issuedAt) + leaseDurationMs).toISOString(),
          releasedAt: null,
          updatedAt: issuedAt,
        });
        if (!lease) continue;
        if (waiter.signal?.aborted || !this.#isCurrentWaiter(waiter)) {
          await this.#persistence.release(lease.capacityLeaseId, this.#clock());
          continue;
        }
        this.#removeWaiter(waiter);
        waiter.resolve(lease);
        checked = 0;
      } catch (error) {
        this.#removeWaiter(waiter);
        await this.#persistence.cancelWaiting(waiter.admissionId, this.#clock());
        waiter.reject(error);
        checked = 0;
      }
    }
  }

  async #authorize(request) {
    try {
      const descriptor = capacityDescriptor(request);
      await this.#assertActiveProductCommand(request, descriptor);
    } catch (error) {
      if (error instanceof AdmissionControllerError) return false;
      throw error;
    }
    return this.#persistence.authorize({ request, now: this.#clock() });
  }

  async #assertActiveProductCommand(request, descriptor) {
    const command = await this.#resolveProductCommand({
      commandId: descriptor.productCommandId,
      workspaceId: descriptor.workspaceId,
      userId: descriptor.userId,
    }, request);
    assertProductCommandMatchesRequest(command, request, descriptor);
    return command;
  }
}

Object.freeze(AdmissionController.prototype);

export class AdmittedExecutionDispatcher {
  #broker;
  #admission;
  #leases = new Map();
  #prepared = new Map();
  #streamLeases = new Map();

  constructor({ broker, admissionController } = {}) {
    if (typeof broker?.execute !== "function" || typeof broker?.cancel !== "function") {
      throw new TypeError("admitted_execution_broker_required");
    }
    if (!ADMISSION_CONTROLLERS.has(admissionController)
      || Object.getPrototypeOf(admissionController) !== AdmissionController.prototype) {
      throw new TypeError("admission_controller_required");
    }
    this.#broker = broker;
    this.#admission = admissionController;
    Object.preventExtensions(this);
  }

  registerBackend(input) { return this.#broker.registerBackend(input); }
  hasBackend(input) { return this.#broker.hasBackend(input); }
  probeBackend(input) { return this.#broker.probeBackend(input); }
  listInvocations(input) { return this.#broker.listInvocations(input); }
  getInvocation(input) { return this.#broker.getInvocation(input); }
  listEvents(...input) { return this.#broker.listEvents(...input); }

  async reserveExecution(request, { signal } = {}) {
    if (typeof this.#broker.prepareExecution !== "function") {
      throw new TypeError("admitted_execution_preparation_unsupported");
    }
    const normalized = executionIdentity(request);
    if (this.#prepared.has(normalized.invocationId)) {
      throw new AdmissionControllerError("execution_preparation_already_active");
    }
    const reservation = Object.freeze({
      schemaVersion: "workbench-admitted-execution-reservation-v1",
      invocationId: normalized.invocationId,
      attemptId: normalized.attemptId,
    });
    const state = {
      reservation,
      authority: null,
      lease: null,
      childLeases: [],
      leaseAbort: new AbortController(),
      heartbeatTimer: null,
      admitted: null,
      prepared: null,
      deferredSettlement: null,
      released: false,
      releasePromise: null,
    };
    this.#prepared.set(normalized.invocationId, state);
    try {
      state.admitted = await this.#admitPreparedExecution(normalized, state, signal);
      return reservation;
    } catch (error) {
      await this.#releasePrepared(normalized.invocationId, state);
      throw error;
    }
  }

  async prepareExecution(request, {
    signal,
    uow = undefined,
    reservation = null,
    start = false,
  } = {}) {
    if (typeof this.#broker.prepareExecution !== "function") {
      throw new TypeError("admitted_execution_preparation_unsupported");
    }
    const normalized = executionIdentity(request);
    const activeReservation = reservation ?? await this.reserveExecution(normalized, { signal });
    const state = this.#prepared.get(normalized.invocationId);
    if (
      !state
      || state.reservation !== activeReservation
      || activeReservation?.schemaVersion !== "workbench-admitted-execution-reservation-v1"
      || activeReservation.invocationId !== normalized.invocationId
      || activeReservation.attemptId !== normalized.attemptId
      || !state.admitted
      || state.released
    ) {
      throw new AdmissionControllerError("execution_preparation_reservation_invalid");
    }
    if (state.prepared) {
      throw new AdmissionControllerError("execution_preparation_already_persisted");
    }
    try {
      state.prepared = await this.#broker.prepareExecution(state.admitted, {
        uow,
        start,
        childCapacityPool: state.admitted.mode === "agent_orchestrator"
          ? childCapacityPool(state.childLeases, this.#admission)
          : null,
      });
      state.authority = Object.freeze({
        schemaVersion: "workbench-admitted-prepared-execution-v1",
        invocationId: normalized.invocationId,
        attemptId: normalized.attemptId,
      });
      return state.authority;
    } catch (error) {
      await this.#releasePrepared(normalized.invocationId, state);
      throw error;
    }
  }

  async recoverMemberAgentRequests(options={}) {
    const recovered=await this.#broker.recoverMemberAgentRequests(options);
    await Promise.all(recovered.filter(item=>item.capacityLeaseId).map(item=>this.#admission.release(item.capacityLeaseId)));
    return recovered;
  }

  async recoverStreams(options = {}) {
    if (typeof this.#broker.recoverStreams !== "function") {
      throw new TypeError("admitted_execution_stream_recovery_required");
    }
    const recovered = await this.#broker.recoverStreams(options);
    await Promise.all(recovered
      .filter((item) => item.capacityLeaseId)
      .map((item) => this.#admission.release(item.capacityLeaseId)));
    return Object.freeze(recovered.map((item) => Object.freeze({
      invocationId: item.invocationId,
      status: item.result.status,
    })));
  }

  async settleExecution(deferredSettlement, { uow = undefined } = {}) {
    if (typeof this.#broker.settleExecution !== "function") {
      throw new TypeError("admitted_execution_deferred_settlement_unsupported");
    }
    const state = this.#prepared.get(deferredSettlement?.invocationId);
    if (!state || state.deferredSettlement !== deferredSettlement || state.released) {
      throw new AdmissionControllerError("execution_deferred_settlement_invalid");
    }
    const result = await this.#broker.settleExecution(deferredSettlement, { uow });
    await Promise.all([
      ...state.childLeases.map((lease) => this.#admission.release(lease.capacityLeaseId, { uow })),
      ...(state.lease ? [this.#admission.release(state.lease.capacityLeaseId, { uow })] : []),
    ]);
    return result;
  }

  confirmExecutionSettlement(deferredSettlement) {
    if (typeof this.#broker.confirmExecutionSettlement !== "function") {
      throw new TypeError("admitted_execution_deferred_settlement_unsupported");
    }
    const state = this.#prepared.get(deferredSettlement?.invocationId);
    if (!state || state.deferredSettlement !== deferredSettlement || state.released) {
      throw new AdmissionControllerError("execution_deferred_settlement_invalid");
    }
    const result = this.#broker.confirmExecutionSettlement(deferredSettlement);
    this.#finalizePreparedState(deferredSettlement.invocationId, state);
    return result;
  }

  async suspendExecution(preparedExecution, { uow = undefined } = {}) {
    const state = this.#prepared.get(preparedExecution?.invocationId);
    if (!state || state.authority !== preparedExecution || !state.prepared || state.released) {
      throw new AdmissionControllerError("execution_suspension_authority_invalid");
    }
    await Promise.all([
      ...state.childLeases.map((lease) => this.#admission.release(lease.capacityLeaseId, { uow })),
      ...(state.lease ? [this.#admission.release(state.lease.capacityLeaseId, { uow })] : []),
    ]);
    return Object.freeze({
      schemaVersion: "workbench-admitted-execution-suspension-v1",
      invocationId: preparedExecution.invocationId,
      attemptId: preparedExecution.attemptId,
    });
  }

  confirmExecutionSuspension(preparedExecution) {
    const state = this.#prepared.get(preparedExecution?.invocationId);
    if (!state || state.authority !== preparedExecution || state.released) {
      throw new AdmissionControllerError("execution_suspension_authority_invalid");
    }
    this.#finalizePreparedState(preparedExecution.invocationId, state);
    return true;
  }

  async execute(request, options = {}) {
    const normalized = executionIdentity(request);
    const prepared = options.preparedExecution;
    if (prepared?.schemaVersion === "workbench-admitted-prepared-execution-v1") {
      return this.#executePrepared(normalized, prepared, options);
    }
    const lease = await this.#admission.acquire({ request: normalized, signal: options.signal });
    let childLeases = [];
    const leaseAbort = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, leaseAbort.signal])
      : leaseAbort.signal;
    let heartbeatTimer = null;
    try {
      assertLeaseMatchesRequest(lease, normalized);
      childLeases = await this.#admission.acquireChildPool({ request: normalized, signal });
      const childDescriptor = {
        ...capacityDescriptor(normalized),
        backendKey: `bounded_agent:${normalized.isolation}`,
      };
      for (const childLease of childLeases) assertLeaseMatchesDescriptor(childLease, childDescriptor);
      this.#leases.set(normalized.invocationId, lease.capacityLeaseId);
      const heartbeat = async () => {
        try {
          const renewed = await Promise.all([lease, ...childLeases].map((item) => this.#admission.heartbeat(item)));
          if (renewed.some((item) => !item)) throw new AdmissionControllerError("capacity_lease_lost");
          [lease, ...childLeases].forEach((item, index) => {
            item.expiresAt = renewed[index].expiresAt;
            item.updatedAt = renewed[index].updatedAt;
          });
        } catch (error) {
          const heartbeatError = error instanceof AdmissionControllerError
            ? error
            : new AdmissionControllerError("capacity_lease_heartbeat_failed", error?.message, { retryable: true });
          leaseAbort.abort(heartbeatError);
        }
      };
      heartbeatTimer = setInterval(heartbeat, this.#admission.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      const admitted = {
        ...normalized,
        metadata: {
          ...structuredClone(normalized.metadata ?? {}),
          ...(normalized.mode === "agent_orchestrator"
            ? { admittedChildConcurrency: childLeases.length }
            : {}),
        },
        capacityAuthority: {
          admissionId: lease.admissionId,
          capacityLeaseId: lease.capacityLeaseId,
          fence: lease.fence,
        },
      };
      if (!await this.#admission.authorize(admitted)) {
        throw new AdmissionControllerError("execution_capacity_lease_invalid");
      }
      return await this.#broker.execute(admitted, {
        ...options,
        signal: options.signal,
        authoritySignal: leaseAbort.signal,
        childCapacityPool: normalized.mode === "agent_orchestrator"
          ? {
              leases: childLeases,
              release: (capacityLeaseId) => this.#admission.release(capacityLeaseId),
            }
          : null,
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.#leases.delete(normalized.invocationId);
      await Promise.all(childLeases.map((childLease) => this.#admission.release(childLease.capacityLeaseId)));
      await this.#admission.release(lease.capacityLeaseId);
    }
  }

  async openStream(request, options = {}) {
    if (typeof this.#broker.openStream !== "function") {
      throw new TypeError("admitted_execution_stream_broker_required");
    }
    const normalized = executionIdentity(request);
    if (this.#streamLeases.has(normalized.invocationId)) {
      throw new AdmissionControllerError("execution_stream_already_admitted");
    }
    const leaseAbort = new AbortController();
    const state = {
      lease: null,
      leaseAbort,
      heartbeatTimer: null,
      heartbeatError: null,
      authority: null,
      released: false,
      releasePromise: null,
    };
    this.#streamLeases.set(normalized.invocationId, state);
    try {
      const lease = await this.#admission.acquire({ request: normalized, signal: options.signal });
      state.lease = lease;
      this.#leases.set(normalized.invocationId, lease.capacityLeaseId);
      assertLeaseMatchesRequest(lease, normalized);
      const admitted = {
        ...normalized,
        capacityAuthority: {
          admissionId: lease.admissionId,
          capacityLeaseId: lease.capacityLeaseId,
          fence: lease.fence,
        },
      };
      if (!await this.#admission.authorize(admitted)) {
        throw new AdmissionControllerError("execution_capacity_lease_invalid");
      }
      state.heartbeatTimer = setInterval(() => {
        void this.#heartbeatStream(normalized.invocationId, state);
      }, this.#admission.heartbeatIntervalMs);
      state.heartbeatTimer.unref?.();
      const opened = await this.#broker.openStream(admitted, {
        ...options,
        signal: options.signal,
        authoritySignal: leaseAbort.signal,
        onTerminal: async (result) => {
          await this.#releaseStream(normalized.invocationId, state);
          await options.onTerminal?.(result);
        },
      });
      state.authority = structuredClone(opened.authority);
      return Object.freeze({
        ready: opened.ready,
        completion: opened.completion,
      });
    } catch (error) {
      await this.#releaseStream(normalized.invocationId, state);
      throw state.heartbeatError ?? error;
    }
  }

  updateStream(invocationId, update, options = {}) {
    if (typeof this.#broker.updateStream !== "function") {
      throw new TypeError("admitted_execution_stream_broker_required");
    }
    const state = this.#streamLeases.get(invocationId);
    if (!state?.authority && !options.authority) {
      throw new AdmissionControllerError("execution_stream_not_admitted");
    }
    return this.#broker.updateStream(invocationId, update, {
      ...options,
      authority: structuredClone(options.authority ?? state.authority),
    });
  }

  async finishStream(invocationId, options = {}) {
    if (typeof this.#broker.finishStream !== "function") {
      throw new TypeError("admitted_execution_stream_broker_required");
    }
    const state = this.#streamLeases.get(invocationId);
    const authority = options.authority ?? state?.authority;
    if (!authority) throw new AdmissionControllerError("execution_stream_not_admitted");
    try {
      return await this.#broker.finishStream(invocationId, {
        ...options,
        authority: structuredClone(authority),
      });
    } finally {
      if (state) await this.#releaseStream(invocationId, state);
    }
  }

  async cancel(invocationId, options = {}) {
    const prepared = this.#prepared.get(invocationId);
    const state = this.#streamLeases.get(invocationId);
    if (prepared && !prepared.prepared) {
      await this.#releasePrepared(invocationId, prepared);
      return null;
    }
    try {
      return await this.#broker.cancel(invocationId, options);
    } finally {
      if (prepared) {
        await this.#releasePrepared(invocationId, prepared);
      } else if (state) {
        await this.#releaseStream(invocationId, state);
      } else {
        const leaseId = this.#leases.get(invocationId);
        if (leaseId) await this.#admission.release(leaseId);
      }
    }
  }

  async #executePrepared(request, prepared, options) {
    if (prepared.invocationId !== request.invocationId || prepared.attemptId !== request.attemptId) {
      throw new AdmissionControllerError("execution_preparation_identity_mismatch");
    }
    const state = this.#prepared.get(request.invocationId);
    if (!state?.prepared || !state.admitted || state.released) {
      throw new AdmissionControllerError("execution_preparation_not_found");
    }
    let deferred = false;
    try {
      const result = await this.#broker.execute(state.admitted, {
        ...options,
        signal: options.signal,
        authoritySignal: state.leaseAbort.signal,
        preparedExecution: state.prepared,
        childCapacityPool: state.admitted.mode === "agent_orchestrator"
          ? childCapacityPool(state.childLeases, this.#admission)
          : null,
      });
      if (options.deferSettlement === true) {
        if (result?.schemaVersion !== "workbench-deferred-execution-settlement-v1") {
          throw new AdmissionControllerError("execution_deferred_settlement_invalid");
        }
        state.deferredSettlement = result;
        deferred = true;
      }
      return result;
    } finally {
      if (!deferred) await this.#releasePrepared(request.invocationId, state);
    }
  }

  async #admitPreparedExecution(normalized, state, signal) {
    const lease = await this.#admission.acquire({ request: normalized, signal });
    state.lease = lease;
    this.#leases.set(normalized.invocationId, lease.capacityLeaseId);
    assertLeaseMatchesRequest(lease, normalized);
    const combinedSignal = signal
      ? AbortSignal.any([signal, state.leaseAbort.signal])
      : state.leaseAbort.signal;
    const childLeases = await this.#admission.acquireChildPool({ request: normalized, signal: combinedSignal });
    state.childLeases = childLeases;
    const childDescriptor = {
      ...capacityDescriptor(normalized),
      backendKey: `bounded_agent:${normalized.isolation}`,
    };
    for (const childLease of childLeases) assertLeaseMatchesDescriptor(childLease, childDescriptor);
    const admitted = {
      ...normalized,
      metadata: {
        ...structuredClone(normalized.metadata ?? {}),
        ...(normalized.mode === "agent_orchestrator"
          ? { admittedChildConcurrency: childLeases.length }
          : {}),
      },
      capacityAuthority: {
        admissionId: lease.admissionId,
        capacityLeaseId: lease.capacityLeaseId,
        fence: lease.fence,
      },
    };
    if (!await this.#admission.authorize(admitted)) {
      throw new AdmissionControllerError("execution_capacity_lease_invalid");
    }
    state.heartbeatTimer = setInterval(() => {
      void this.#heartbeatPrepared(state);
    }, this.#admission.heartbeatIntervalMs);
    state.heartbeatTimer.unref?.();
    return admitted;
  }

  async #heartbeatPrepared(state) {
    if (state.released || !state.lease) return;
    try {
      const renewed = await Promise.all([state.lease, ...state.childLeases]
        .map((item) => this.#admission.heartbeat(item)));
      if (renewed.some((item) => !item)) throw new AdmissionControllerError("capacity_lease_lost");
      [state.lease, ...state.childLeases].forEach((item, index) => {
        item.expiresAt = renewed[index].expiresAt;
        item.updatedAt = renewed[index].updatedAt;
      });
    } catch (error) {
      state.leaseAbort.abort(error instanceof AdmissionControllerError
        ? error
        : new AdmissionControllerError("capacity_lease_heartbeat_failed", error?.message, { retryable: true }));
    }
  }

  async #releasePrepared(invocationId, state) {
    if (state.released) return;
    if (state.releasePromise) return state.releasePromise;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.releasePromise = Promise.all([
      ...state.childLeases.map((lease) => this.#admission.release(lease.capacityLeaseId)),
      ...(state.lease ? [this.#admission.release(state.lease.capacityLeaseId)] : []),
    ]).then(() => this.#finalizePreparedState(invocationId, state)).catch((error) => {
      state.releasePromise = null;
      throw error;
    });
    return state.releasePromise;
  }

  #finalizePreparedState(invocationId, state) {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.released = true;
    if (this.#prepared.get(invocationId) === state) this.#prepared.delete(invocationId);
    this.#leases.delete(invocationId);
  }

  async #heartbeatStream(invocationId, state) {
    if (state.released || this.#streamLeases.get(invocationId) !== state) return;
    try {
      const renewed = await this.#admission.heartbeat(state.lease);
      if (!renewed) throw new AdmissionControllerError("capacity_lease_lost");
      state.lease.expiresAt = renewed.expiresAt;
      state.lease.updatedAt = renewed.updatedAt;
    } catch (error) {
      state.heartbeatError = error instanceof AdmissionControllerError
        ? error
        : new AdmissionControllerError(
            "capacity_lease_heartbeat_failed",
            error?.message,
            { retryable: true },
          );
      state.leaseAbort.abort(state.heartbeatError);
    }
  }

  async #releaseStream(invocationId, state) {
    if (state.released) return;
    if (state.releasePromise) return state.releasePromise;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (!state.lease) {
      state.released = true;
      if (this.#streamLeases.get(invocationId) === state) this.#streamLeases.delete(invocationId);
      this.#leases.delete(invocationId);
      return;
    }
    state.releasePromise = this.#admission.release(state.lease.capacityLeaseId).then(() => {
      state.released = true;
      if (this.#streamLeases.get(invocationId) === state) this.#streamLeases.delete(invocationId);
      this.#leases.delete(invocationId);
    }).catch((error) => {
      state.releasePromise = null;
      throw error;
    });
    return state.releasePromise;
  }
}

Object.freeze(AdmittedExecutionDispatcher.prototype);

function executionIdentity(request) {
  return structuredClone(request);
}

function capacityDescriptor(request) {
  const workflowRun = ["workflow_run", "member_agent_request"].includes(request?.controller?.kind);
  if (!request?.actor?.userId
    || !request?.lineage?.productCommandId
    || (!workflowRun && (!request?.lineage?.sessionId || !request?.lineage?.turnId))
    || !request?.workspaceId) {
    throw new AdmissionControllerError("execution_admission_identity_missing");
  }
  return {
    userId: request.actor.userId,
    productCommandId: request.lineage.productCommandId,
    workspaceId: request.workspaceId,
    backendKey: `${request.mode}:${request.isolation}`,
    providerKey: request.modelProfileRevisionId
      ?? request.metadata?.modelProfileRevisionId
      ?? "provider:none",
  };
}

function assertProductCommandMatchesRequest(command, request, descriptor) {
  if (!command) {
    throw new AdmissionControllerError("execution_product_command_not_found");
  }
  if (command.commandId !== descriptor.productCommandId
    || command.workspaceId !== descriptor.workspaceId
    || command.userId !== descriptor.userId) {
    throw new AdmissionControllerError("execution_product_command_identity_mismatch");
  }
  if (!ACTIVE_PRODUCT_COMMAND_STATUSES.has(command.status)) {
    throw new AdmissionControllerError("execution_product_command_not_active");
  }
  const allowedControllerKinds = COMMAND_CONTROLLER_KINDS[command.kind];
  if (!allowedControllerKinds?.has(request.controller?.kind)) {
    throw new AdmissionControllerError("execution_product_command_target_mismatch");
  }
  if (["workflow_run", "member_agent_request_accept"].includes(command.kind) && command.sessionId == null && command.turnId == null) {
    if (request.controller?.controllerId !== command.targetId) {
      throw new AdmissionControllerError("execution_product_command_target_mismatch");
    }
    return;
  }
  if (command.sessionId !== request.lineage.sessionId
    || command.turnId !== request.lineage.turnId) {
    throw new AdmissionControllerError("execution_product_command_lineage_mismatch");
  }
  if (command.kind === "agent_turn" && ["work_item", "work_item_continuation_turn"].includes(command.targetKind)) {
    if (command.targetRevision !== 1 || !command.targetId) {
      throw new AdmissionControllerError("execution_product_command_target_mismatch");
    }
    if (command.targetKind === "work_item_continuation_turn"
      && command.targetId !== command.turnId) {
      throw new AdmissionControllerError("execution_product_command_target_mismatch");
    }
  }
  if (command.kind === "agent_tool_approval_decide") {
    const resume = request.metadata?.toolApprovalResume;
    if (command.targetKind !== "agent_tool_approval"
      || command.targetRevision !== 1
      || typeof command.targetId !== "string" || !command.targetId
      || !resume || typeof resume !== "object"
      || resume.approvalId !== command.targetId
      || typeof resume.toolId !== "string" || !resume.toolId
      || typeof resume.inputDigest !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(resume.inputDigest)) {
      throw new AdmissionControllerError("execution_product_command_target_mismatch");
    }
  }
  if (request.controller?.controllerId !== command.turnId) {
    throw new AdmissionControllerError("execution_product_command_target_mismatch");
  }
}

function assertLeaseMatchesRequest(lease, request) {
  assertLeaseMatchesDescriptor(lease, capacityDescriptor(request));
}

function childCapacityPool(leases, admission) {
  return {
    leases,
    release: (capacityLeaseId) => admission.release(capacityLeaseId),
  };
}

function assertLeaseMatchesDescriptor(lease, descriptor) {
  if (!lease
    || typeof lease.capacityLeaseId !== "string"
    || lease.capacityLeaseId.length === 0
    || typeof lease.admissionId !== "string"
    || lease.admissionId.length === 0
    || !Number.isInteger(lease.fence)
    || lease.fence < 1
    || lease.status !== "active"
    || lease.userId !== descriptor.userId
    || lease.workspaceId !== descriptor.workspaceId
    || lease.commandId !== descriptor.productCommandId
    || lease.backendKey !== descriptor.backendKey
    || lease.providerKey !== descriptor.providerKey
    || !Number.isFinite(Date.parse(lease.expiresAt))) {
    throw new AdmissionControllerError("execution_capacity_lease_invalid");
  }
}

function capacityDimensions(descriptor, limits) {
  return [
    { counterId: `user:${descriptor.userId}`, kind: "user", limit: limits.user },
    { counterId: `workspace:${descriptor.workspaceId}`, kind: "workspace", limit: limits.workspace },
    { counterId: `backend:${descriptor.backendKey}`, kind: "backend", limit: limits.backend },
    { counterId: `provider:${descriptor.providerKey}`, kind: "provider", limit: limits.provider },
  ];
}
