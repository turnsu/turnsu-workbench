const clone = (value) => value == null ? value : structuredClone(value);

export class InMemoryExecutionPersistence {
  constructor() {
    this.invocations = new Map();
    this.attempts = new Map();
    this.events = new Map();
    this.checkpoints = new Map();
    this.leases = new Map();
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
    invocation.status = "running";
    invocation.startedAt = startedAt;
    attempt.status = "running";
    attempt.startedAt = startedAt;
  }

  async completeAttempt(attemptId, fence, result) {
    const attempt = this.#attempt(attemptId);
    if (attempt.status !== "running" || attempt.fence !== fence) return false;
    attempt.status = result.status;
    attempt.result = clone(result);
    attempt.finishedAt = result.finishedAt;
    const invocation = this.#invocation(attempt.invocationId);
    if (invocation.executionFence !== fence || invocation.status === "cancellation_requested") return false;
    invocation.status = result.status;
    invocation.result = clone(result);
    invocation.finishedAt = result.finishedAt;
    return true;
  }

  async requestCancel(invocationId, cancelledAt) {
    const invocation = this.#invocation(invocationId);
    if (isTerminal(invocation.status)) return clone(invocation);
    invocation.status = "cancellation_requested";
    invocation.cancelRequestedAt = cancelledAt;
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
    invocation.status = "cancelled";
    invocation.result = clone(result);
    invocation.finishedAt = result.finishedAt;
    for (const attempt of this.attempts.values()) {
      if (attempt.invocationId !== invocationId || attempt.status !== "running") continue;
      attempt.fence += 1;
      attempt.status = "cancelled";
      attempt.result = clone(result);
      attempt.finishedAt = result.finishedAt;
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
  ].includes(status);
}
