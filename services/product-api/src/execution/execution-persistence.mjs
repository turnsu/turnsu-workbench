const clone = (value) => value == null ? value : structuredClone(value);

export class InMemoryExecutionPersistence {
  constructor() {
    this.invocations = new Map();
    this.attempts = new Map();
    this.events = new Map();
    this.checkpoints = new Map();
    this.leases = new Map();
    this.childSpawnCounters = new Map();
  }

  async createInvocation(record) {
    if (this.invocations.has(record.invocationId)) throw duplicate("execution_invocation_exists");
    this.invocations.set(record.invocationId, clone(record));
    return clone(record);
  }

  async createAttempt(record) {
    if (this.attempts.has(record.attemptId)) throw duplicate("execution_attempt_exists");
    this.attempts.set(record.attemptId, clone(record));
    return clone(record);
  }

  async issueLease(record) {
    this.leases.set(record.capabilityLeaseId, clone(record));
    return clone(record);
  }

  async createExecutionAuthority({ invocation, attempt, lease } = {}) {
    if (!invocation || !attempt || !lease) throw new TypeError("execution_authority_records_required");
    if (this.invocations.has(invocation.invocationId)) throw duplicate("execution_invocation_exists");
    if (this.attempts.has(attempt.attemptId)) throw duplicate("execution_attempt_exists");
    if (this.leases.has(lease.capabilityLeaseId)) throw duplicate("execution_capability_lease_exists");
    const records = {
      invocation: clone(invocation),
      attempt: clone(attempt),
      lease: clone(lease),
    };
    this.invocations.set(invocation.invocationId, records.invocation);
    this.attempts.set(attempt.attemptId, records.attempt);
    this.leases.set(lease.capabilityLeaseId, records.lease);
    return {
      invocation: clone(records.invocation),
      attempt: clone(records.attempt),
      lease: clone(records.lease),
    };
  }

  async appendEvent(invocationId, eventFactory) {
    const invocation = this.#invocation(invocationId);
    invocation.eventSequence += 1;
    const event = eventFactory(invocation.eventSequence);
    const items = this.events.get(invocationId) ?? [];
    items.push(clone(event));
    this.events.set(invocationId, items);
    return clone(event);
  }

  async writeCheckpoint(record) {
    const items = this.checkpoints.get(record.invocationId) ?? [];
    const value = { ...clone(record), sequence: items.length + 1 };
    items.push(value);
    this.checkpoints.set(record.invocationId, items);
    return clone(value);
  }

  async markRunning(invocationId, attemptId, startedAt) {
    const invocation = this.#invocation(invocationId);
    const attempt = this.#attempt(attemptId);
    if (invocation.status !== "queued" || attempt.status !== "queued") {
      throw new Error("execution_attempt_not_startable");
    }
    invocation.status = "running";
    invocation.startedAt = startedAt;
    attempt.status = "running";
    attempt.startedAt = startedAt;
  }

  async completeAttempt(attemptId, fence, result) {
    const attempt = this.#attempt(attemptId);
    if (attempt.status !== "running" || attempt.fence !== fence) return false;
    const invocation = this.#invocation(attempt.invocationId);
    if (invocation.executionFence !== fence || invocation.status !== "running") return false;
    invocation.status = result.status;
    invocation.result = clone(result);
    invocation.finishedAt = result.finishedAt;
    invocation.updatedAt = result.finishedAt;
    attempt.status = result.status;
    attempt.result = clone(result);
    attempt.finishedAt = result.finishedAt;
    attempt.updatedAt = result.finishedAt;
    await this.revokeLease(invocation.invocationId, result.finishedAt);
    return true;
  }

  async requestCancel(invocationId, cancelledAt) {
    const invocation = this.#invocation(invocationId);
    if (isTerminal(invocation.status)) return clone(invocation);
    invocation.status = "cancellation_requested";
    invocation.cancelRequestedAt = cancelledAt;
    invocation.updatedAt = cancelledAt;
    await this.revokeLease(invocationId, cancelledAt);
    return clone(invocation);
  }

  async revokeLease(invocationId, revokedAt) {
    for (const lease of this.leases.values()) {
      if (lease.invocationId !== invocationId || lease.status !== "active") continue;
      lease.status = "revoked";
      lease.revokedAt = revokedAt;
    }
  }

  async cancelAttempt(invocationId, result) {
    const invocation = this.#invocation(invocationId);
    if (isTerminal(invocation.status)) return clone(invocation.result);
    invocation.executionFence += 1;
    invocation.status = result.status;
    invocation.result = clone(result);
    invocation.finishedAt = result.finishedAt;
    for (const attempt of this.attempts.values()) {
      if (attempt.invocationId !== invocationId || !["queued", "running"].includes(attempt.status)) continue;
      attempt.fence += 1;
      attempt.status = result.status;
      attempt.result = clone(result);
      attempt.finishedAt = result.finishedAt;
      attempt.updatedAt = result.finishedAt;
    }
    return clone(result);
  }

  async getInvocation(invocationId) {
    return clone(this.invocations.get(invocationId) ?? null);
  }

  async getAttempt(attemptId) {
    return clone(this.attempts.get(attemptId) ?? null);
  }

  async getActiveLease(invocationId, attemptId, now) {
    for (const lease of this.leases.values()) {
      if (
        lease.invocationId === invocationId
        && lease.attemptId === attemptId
        && lease.status === "active"
        && lease.expiresAt > now
      ) return clone(lease);
    }
    return null;
  }

  async listInvocations({ workspaceId, controllerId, limit = 100 } = {}) {
    return [...this.invocations.values()]
      .filter((item) => (!workspaceId || item.workspaceId === workspaceId)
        && (!controllerId || item.controller.controllerId === controllerId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async listRecoverableRealtimeInvocations({ limit = 500 } = {}) {
    return [...this.invocations.values()]
      .filter((item) => item.mode === "realtime_audio"
        && ["queued", "running", "cancellation_requested"].includes(item.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(clone);
  }

  async failRecoveredRealtimeAttempt({ invocationId, attemptId, fence, result } = {}) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation
      || invocation.mode !== "realtime_audio"
      || invocation.attemptId !== attemptId
      || invocation.executionFence !== fence
      || !["queued", "running", "cancellation_requested"].includes(invocation.status)) return false;
    invocation.executionFence += 1;
    invocation.status = result.status;
    invocation.result = clone(result);
    invocation.finishedAt = result.finishedAt;
    invocation.updatedAt = result.finishedAt;
    const attempt = this.attempts.get(attemptId);
    if (attempt
      && attempt.invocationId === invocationId
      && attempt.fence === fence
      && ["queued", "running"].includes(attempt.status)) {
      attempt.fence += 1;
      attempt.status = result.status;
      attempt.result = clone(result);
      attempt.finishedAt = result.finishedAt;
      attempt.updatedAt = result.finishedAt;
    }
    await this.revokeLease(invocationId, result.finishedAt);
    return true;
  }

  async reserveChildSpawn({ workspaceId, sessionId, parentInvocationId, childRef, limit, occurredAt }) {
    const scopeId = sessionId || parentInvocationId;
    const counterId = `${workspaceId}:${scopeId}`;
    const current = this.childSpawnCounters.get(counterId) ?? {
      counterId,
      workspaceId,
      sessionId: sessionId ?? null,
      parentScopeInvocationId: sessionId ? null : parentInvocationId,
      childKeys: [],
      count: 0,
      updatedAt: occurredAt,
    };
    const childKey = `${parentInvocationId}:${childRef}`;
    if (current.childKeys.includes(childKey)) return true;
    if (current.count >= limit) return false;
    current.childKeys.push(childKey);
    current.count += 1;
    current.updatedAt = occurredAt;
    this.childSpawnCounters.set(counterId, current);
    return true;
  }

  async listEvents(invocationIds, after = 0, limit = 500) {
    return invocationIds
      .flatMap((invocationId) => this.events.get(invocationId) ?? [])
      .filter((event) => event.sequence > after)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
        || left.invocationId.localeCompare(right.invocationId)
        || left.sequence - right.sequence)
      .slice(0, limit)
      .map(clone);
  }

  #invocation(invocationId) {
    const value = this.invocations.get(invocationId);
    if (!value) throw new Error("execution_invocation_not_found");
    return value;
  }

  #attempt(attemptId) {
    const value = this.attempts.get(attemptId);
    if (!value) throw new Error("execution_attempt_not_found");
    return value;
  }
}

function duplicate(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isTerminal(status) {
  return [
    "completed", "failed", "cancelled", "blocked", "partial", "timeout",
    "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
    "effect_outcome_unknown",
  ].includes(status);
}
