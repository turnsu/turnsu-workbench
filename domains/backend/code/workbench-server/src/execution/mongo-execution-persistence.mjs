const clone = (value) => value == null ? value : structuredClone(value);
const options = (session) => session ? { session } : {};
const after = (session) => ({ ...options(session), returnDocument: "after" });
const document = (result) => result?.value ?? result ?? null;

export class MongoExecutionPersistence {
  constructor({ store } = {}) {
    if (!store || typeof store.connect !== "function") throw new TypeError("execution_store_required");
    this.store = store;
  }

  async #repositories() {
    await this.store.connect();
    const repositories = this.store.repositories;
    for (const name of [
      "executionInvocations", "executionAttempts", "executionEvents",
      "executionCheckpoints", "capabilityLeases",
    ]) {
      if (!repositories?.[name]?.collection) throw new TypeError(`execution_repository_missing:${name}`);
    }
    return repositories;
  }

  async createInvocation(record, { session } = {}) {
    const repositories = await this.#repositories();
    return repositories.executionInvocations.insert(record, options(session));
  }

  async createAttempt(record, { session } = {}) {
    const repositories = await this.#repositories();
    return repositories.executionAttempts.insert(record, options(session));
  }

  async issueLease(record, { session } = {}) {
    const repositories = await this.#repositories();
    return repositories.capabilityLeases.insert(record, options(session));
  }

  async appendEvent(invocationId, eventFactory, { session } = {}) {
    const repositories = await this.#repositories();
    const invocation = document(await repositories.executionInvocations.collection.findOneAndUpdate(
      { invocationId },
      { $inc: { eventSequence: 1 } },
      after(session),
    ));
    if (!invocation) throw new Error("execution_invocation_not_found");
    const event = eventFactory(invocation.eventSequence);
    await repositories.executionEvents.insert(event, options(session));
    return clone(event);
  }

  async writeCheckpoint(record, { session } = {}) {
    const repositories = await this.#repositories();
    const attempt = document(await repositories.executionAttempts.collection.findOneAndUpdate(
      { attemptId: record.attemptId, fence: record.fence, status: "running" },
      { $inc: { checkpointSequence: 1 } },
      after(session),
    ));
    if (!attempt) throw new Error("execution_checkpoint_fence_rejected");
    const value = { ...clone(record), sequence: attempt.checkpointSequence };
    await repositories.executionCheckpoints.insert(value, options(session));
    return value;
  }

  async markRunning(invocationId, attemptId, startedAt, { session } = {}) {
    const repositories = await this.#repositories();
    const attempt = await repositories.executionAttempts.collection.updateOne(
      { attemptId, invocationId, status: "queued" },
      { $set: { status: "running", startedAt, updatedAt: startedAt } },
      options(session),
    );
    if (attempt.matchedCount !== 1) throw new Error("execution_attempt_not_startable");
    await repositories.executionInvocations.collection.updateOne(
      { invocationId, status: "queued" },
      { $set: { status: "running", startedAt, updatedAt: startedAt } },
      options(session),
    );
  }

  async completeAttempt(attemptId, fence, result, { session } = {}) {
    const repositories = await this.#repositories();
    const attempt = document(await repositories.executionAttempts.collection.findOneAndUpdate(
      { attemptId, fence, status: "running" },
      { $set: { status: result.status, result: clone(result), finishedAt: result.finishedAt, updatedAt: result.finishedAt } },
      after(session),
    ));
    if (!attempt) return false;
    const invocation = await repositories.executionInvocations.collection.updateOne(
      { invocationId: attempt.invocationId, executionFence: fence, status: "running" },
      { $set: { status: result.status, result: clone(result), finishedAt: result.finishedAt, updatedAt: result.finishedAt } },
      options(session),
    );
    return invocation.matchedCount === 1;
  }

  async requestCancel(invocationId, cancelledAt, { session } = {}) {
    const repositories = await this.#repositories();
    return clone(document(await repositories.executionInvocations.collection.findOneAndUpdate(
      { invocationId, status: { $in: ["queued", "running"] } },
      { $set: { status: "cancellation_requested", cancelRequestedAt: cancelledAt, updatedAt: cancelledAt } },
      after(session),
    )));
  }

  async revokeLease(invocationId, revokedAt, { session } = {}) {
    const repositories = await this.#repositories();
    await repositories.capabilityLeases.collection.updateMany(
      { invocationId, status: "active" },
      { $set: { status: "revoked", revokedAt, updatedAt: revokedAt } },
      options(session),
    );
  }

  async cancelAttempt(invocationId, result, { session } = {}) {
    const repositories = await this.#repositories();
    const invocation = document(await repositories.executionInvocations.collection.findOneAndUpdate(
      { invocationId, status: { $in: ["queued", "running", "cancellation_requested"] } },
      {
        $inc: { executionFence: 1 },
        $set: { status: "cancelled", result: clone(result), finishedAt: result.finishedAt, updatedAt: result.finishedAt },
      },
      after(session),
    ));
    if (!invocation) return (await this.getInvocation(invocationId))?.result ?? null;
    await repositories.executionAttempts.collection.updateMany(
      { invocationId, status: { $in: ["queued", "running"] } },
      {
        $inc: { fence: 1 },
        $set: { status: "cancelled", result: clone(result), finishedAt: result.finishedAt, updatedAt: result.finishedAt },
      },
      options(session),
    );
    return clone(result);
  }

  async getInvocation(invocationId, { session } = {}) {
    const repositories = await this.#repositories();
    return clone(await repositories.executionInvocations.collection.findOne({ invocationId }, options(session)));
  }

  async getAttempt(attemptId, { session } = {}) {
    const repositories = await this.#repositories();
    return clone(await repositories.executionAttempts.collection.findOne({ attemptId }, options(session)));
  }

  async getActiveLease(invocationId, attemptId, now, { session } = {}) {
    const repositories = await this.#repositories();
    return clone(await repositories.capabilityLeases.collection.findOne({
      invocationId,
      attemptId,
      status: "active",
      expiresAt: { $gt: now },
    }, options(session)));
  }

  async listInvocations({ workspaceId, controllerId, limit = 100, session } = {}) {
    const repositories = await this.#repositories();
    return repositories.executionInvocations.collection.find({
      ...(workspaceId ? { workspaceId } : {}),
      ...(controllerId ? { "controller.controllerId": controllerId } : {}),
    }, options(session)).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray();
  }

  async listEvents(invocationIds, afterSequence = 0, limit = 500, { session } = {}) {
    const repositories = await this.#repositories();
    return repositories.executionEvents.collection.find({
      invocationId: { $in: invocationIds },
      sequence: { $gt: afterSequence },
    }, options(session)).sort({ occurredAt: 1, invocationId: 1, sequence: 1 }).limit(Math.min(Math.max(limit, 1), 1000)).toArray();
  }
}
