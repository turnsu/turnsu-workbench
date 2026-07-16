import {
  Check,
  ExecutionRequestSchema,
  ExecutionResultSchema,
} from "@looloomi/workbench-contracts";

const SCHEMA_VERSION = "workbench-execution-fabric-v1";
const TERMINAL = new Set([
  "completed", "failed", "cancelled", "blocked", "partial", "timeout",
  "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
]);

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
  #backends = new Map();
  #active = new Map();

  constructor({ persistence, clock = () => new Date().toISOString(), idFactory } = {}) {
    if (!persistence) throw new TypeError("execution_persistence_required");
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("execution_clock_and_id_factory_required");
    }
    this.#persistence = persistence;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  registerBackend({ mode, isolation, backend } = {}) {
    if (typeof mode !== "string" || typeof isolation !== "string" || typeof backend?.execute !== "function") {
      throw new TypeError("execution_backend_invalid");
    }
    const key = backendKey(mode, isolation);
    if (this.#backends.has(key)) throw new TypeError(`execution_backend_duplicate:${key}`);
    this.#backends.set(key, backend);
    return () => this.#backends.delete(key);
  }

  async execute(request, { signal } = {}) {
    validateRequest(request);
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
    await this.#persistence.createInvocation({
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
      result: null,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await this.#persistence.createAttempt({
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
    });
    await this.#persistence.issueLease(lease);

    const backend = this.#backends.get(backendKey(request.mode, request.isolation));
    const controller = new AbortController();
    const active = { controller, backend, request, fence, startedAt: createdAt, cancellationPromise: null };
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

    let timeout;
    try {
      const startedAt = this.#clock();
      await this.#persistence.markRunning(request.invocationId, request.attemptId, startedAt);
      await this.#event(request, "execution.started", "running", {});
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
        assertCapability: (capability) => assertCapabilityAllowed(request.capabilities, capability),
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      await this.#recordExternalChildren(request, lease, backendResult?.children);
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
      const accepted = await this.#persistence.completeAttempt(request.attemptId, fence, result);
      if (!accepted) return this.#lateResult(request.invocationId, active);
      await this.#persistence.revokeLease(request.invocationId, result.finishedAt);
      await this.#event(request, "execution.completed", result.status, { summary: result.summary });
      return result;
    } catch (error) {
      const existing = await this.#persistence.getInvocation(request.invocationId);
      if (existing?.status === "cancelled" && existing.result) return productResult(existing.result);
      const result = failureResult(request, active.startedAt, this.#clock(), error, controller.signal);
      const accepted = await this.#persistence.completeAttempt(request.attemptId, fence, result);
      await this.#persistence.revokeLease(request.invocationId, result.finishedAt);
      if (!accepted) return this.#lateResult(request.invocationId, active);
      await this.#event(request, `execution.${result.status}`, result.status, { summary: result.summary });
      return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.#active.get(request.invocationId) === active) this.#active.delete(request.invocationId);
    }
  }

  cancel(invocationId, { reason } = {}) {
    const active = this.#active.get(invocationId);
    if (active?.cancellationPromise) return active.cancellationPromise;
    const operation = this.#cancel(invocationId, { reason });
    if (active) active.cancellationPromise = operation;
    return operation;
  }

  async #cancel(invocationId, { reason } = {}) {
    const now = this.#clock();
    const invocation = await this.#persistence.requestCancel(invocationId, now);
    if (!invocation) return (await this.#persistence.getInvocation(invocationId))?.result ?? null;
    await this.#persistence.revokeLease(invocationId, now);
    const active = this.#active.get(invocationId);
    const cancelError = new ExecutionBrokerError("execution_cancelled", "Execution was cancelled.", { status: "cancelled" });
    active?.controller.abort(cancelError);
    if (typeof active?.backend?.cancel === "function") {
      await Promise.resolve(active.backend.cancel({ invocationId, reason })).catch(() => {});
    }
    const request = active?.request ?? invocation.request;
    const result = failureResult(request, invocation.startedAt ?? now, this.#clock(), cancelError);
    const cancelled = await this.#persistence.cancelAttempt(invocationId, result);
    await this.#event(request, "execution.cancelled", "cancelled", { summary: result.summary }).catch(() => {});
    return productResult(cancelled ?? result);
  }

  listInvocations(query) {
    return this.#persistence.listInvocations(query);
  }

  listEvents(invocationIds, after, limit) {
    return this.#persistence.listEvents(invocationIds, after, limit);
  }

  async #event(request, type, status, payload) {
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
    }));
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

  async #recordExternalChildren(parentRequest, parentLease, children) {
    if (children === undefined) return [];
    if (parentRequest.mode !== "agent_orchestrator" || !Array.isArray(children)) {
      throw new ExecutionBrokerError("orchestrator_children_invalid");
    }
    if (children.length > parentRequest.limits.maxChildren) {
      throw new ExecutionBrokerError("execution_child_budget_exceeded");
    }
    const totalModelRequests = children.reduce((sum, child) => sum + Number(child?.usage?.modelRequests ?? 0), 0);
    const totalSteps = children.reduce((sum, child) => sum + Number(child?.usage?.steps ?? 0), 0);
    if (totalModelRequests > parentRequest.limits.maxModelRequests || totalSteps > parentRequest.limits.maxSteps) {
      throw new ExecutionBrokerError("execution_child_budget_exceeded");
    }

    const invocationIds = [];
    for (const child of children) {
      const capabilities = child?.capabilities ?? parentRequest.capabilities;
      if (!capabilitiesAreSubset(capabilities, parentLease.capabilities)) {
        throw new ExecutionBrokerError("execution_child_capability_escalation", "Child Worker requested broader capabilities.", { status: "permission_denied" });
      }
      const createdAt = this.#clock();
      const invocationId = this.#idFactory("invocation");
      const attemptId = this.#idFactory("execution-attempt");
      const childRequest = {
        schemaVersion: SCHEMA_VERSION,
        invocationId,
        attemptId,
        workspaceId: parentRequest.workspaceId,
        controller: structuredClone(parentRequest.controller),
        mode: "bounded_agent",
        isolation: parentRequest.isolation,
        goal: String(child?.goal || "Execute orchestrator child work.").slice(0, 8000),
        input: isJsonValue(child?.input) ? structuredClone(child.input) : {},
        limits: {
          timeoutMs: Math.min(child?.limits?.timeoutMs ?? parentRequest.limits.timeoutMs, parentRequest.limits.timeoutMs),
          maxSteps: Math.min(Math.max(child?.usage?.steps ?? 1, 1), parentRequest.limits.maxSteps),
          maxModelRequests: Math.min(Math.max(child?.usage?.modelRequests ?? 0, 0), parentRequest.limits.maxModelRequests),
          maxChildren: 0,
          maxInputBytes: parentRequest.limits.maxInputBytes,
          maxOutputBytes: parentRequest.limits.maxOutputBytes,
        },
        capabilities: structuredClone(capabilities),
        resultSchema: { type: "object", additionalProperties: true },
        evidenceRequirements: [],
        metadata: {
          parentInvocationId: parentRequest.invocationId,
          externalChildRef: String(child?.childRef || "agwab-child").slice(0, 128),
        },
      };
      validateRequest(childRequest);
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
      const childResult = normalizeResult({
        request: childRequest,
        startedAt,
        finishedAt: this.#clock(),
        backendResult: {
          status: normalizeExternalChildStatus(child?.status),
          output: isObject(child?.output) ? structuredClone(child.output) : {},
          summary: String(child?.summary || "Orchestrator child completed.").slice(0, 4000),
          evidence: Array.isArray(child?.evidence) ? child.evidence.filter(isObject).map((item) => structuredClone(item)) : [],
          usage: {
            steps: Number(child?.usage?.steps ?? 0),
            modelRequests: Number(child?.usage?.modelRequests ?? 0),
            inputBytes: Number(child?.usage?.inputBytes ?? byteLength(child?.input)),
            outputBytes: Number(child?.usage?.outputBytes ?? byteLength(child?.output)),
          },
        },
      });
      validateResultAgainstRequest(childRequest, childResult);
      await this.#persistence.completeAttempt(attemptId, parentLease.fence, childResult);
      await this.#persistence.revokeLease(invocationId, childResult.finishedAt);
      await this.#event(childRequest, `execution.${childResult.status}`, childResult.status, { summary: childResult.summary });
      await this.#event(parentRequest, "execution.child_recorded", "running", { childInvocationId: invocationId, status: childResult.status });
      invocationIds.push(invocationId);
    }
    return invocationIds;
  }

  async #lateResult(invocationId, active = null) {
    await active?.cancellationPromise;
    const invocation = await this.#persistence.getInvocation(invocationId);
    if (invocation?.result) return productResult(invocation.result);
    throw new ExecutionBrokerError("execution_result_rejected_by_fence", "A late execution result was rejected.");
  }
}

export function createDeterministicSkillBackend({ agentRuntime } = {}) {
  if (typeof agentRuntime?.invokeSkillNode !== "function") throw new TypeError("deterministic_skill_runtime_required");
  return {
    async execute({ request, signal, checkpoint }) {
      await checkpoint({ phase: "dispatching" });
      const output = await agentRuntime.invokeSkillNode({
        invocationId: request.invocationId,
        workspaceId: request.workspaceId,
        executionRef: structuredClone(request.metadata.executionRef),
        input: structuredClone(request.input),
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
          inputBytes: byteLength(request.input),
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
  if (byteLength(request.input) > request.limits.maxInputBytes) {
    throw new ExecutionBrokerError("execution_input_too_large");
  }
  if (request.mode === "deterministic_skill" && (request.limits.maxModelRequests !== 0 || request.limits.maxChildren !== 0)) {
    throw new ExecutionBrokerError("deterministic_skill_agent_budget_forbidden");
  }
  if (request.mode === "bounded_agent" && request.limits.maxChildren !== 0) {
    throw new ExecutionBrokerError("bounded_agent_children_forbidden");
  }
}

function validateResultAgainstRequest(request, result) {
  if (!Check(ExecutionResultSchema, result)) throw new ExecutionBrokerError("execution_result_invalid");
  if (result.output !== undefined && !Check(request.resultSchema, result.output)) {
    throw new ExecutionBrokerError("execution_result_schema_mismatch");
  }
  if (result.usage.modelRequests > request.limits.maxModelRequests || result.usage.steps > request.limits.maxSteps) {
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
  return productResult({
    schemaVersion: SCHEMA_VERSION,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    status: backendResult?.status ?? "completed",
    isolation: request.isolation,
    ...(backendResult && Object.hasOwn(backendResult, "output") ? { output: structuredClone(backendResult.output) } : {}),
    summary: String(backendResult?.summary || "Execution completed.").slice(0, 4000),
    evidence: Array.isArray(backendResult?.evidence) ? structuredClone(backendResult.evidence) : [],
    usage: {
      steps: backendResult?.usage?.steps ?? 0,
      modelRequests: backendResult?.usage?.modelRequests ?? 0,
      inputBytes: backendResult?.usage?.inputBytes ?? byteLength(request.input),
      outputBytes: backendResult?.usage?.outputBytes ?? byteLength(backendResult?.output),
    },
    startedAt,
    finishedAt,
  });
}

function failureResult(request, startedAt, finishedAt, error, signal) {
  const cause = signal?.aborted ? signal.reason ?? error : error;
  const status = cause?.status && TERMINAL.has(cause.status) ? cause.status : "failed";
  return productResult({
    schemaVersion: SCHEMA_VERSION,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    status,
    isolation: request.isolation,
    summary: safeFailureSummary(status),
    evidence: [],
    usage: { steps: 0, modelRequests: 0, inputBytes: byteLength(request.input), outputBytes: 0 },
    startedAt,
    finishedAt,
  });
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

function safeFailureSummary(status) {
  return {
    cancelled: "Execution cancelled.",
    timeout: "Execution timed out.",
    permission_denied: "Execution permission denied.",
    blocked: "Execution is blocked.",
    sandbox_unavailable: "The required sandbox is unavailable.",
    remote_backend_unavailable: "The remote backend is unavailable.",
  }[status] ?? "Execution failed.";
}

function productResult(result) {
  const value = structuredClone(result);
  delete value.imageDigest;
  delete value.hostPath;
  delete value.socketPath;
  return value;
}

function byteLength(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeExternalChildStatus(status) {
  return TERMINAL.has(status) ? status : status === "interrupted" ? "cancelled" : status === "skipped" ? "partial" : "failed";
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
