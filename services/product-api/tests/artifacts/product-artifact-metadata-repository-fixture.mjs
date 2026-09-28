const REQUIRED_METHODS = Object.freeze([
  "create",
  "getById",
  "getReady",
  "listPending",
  "listForCleanup",
  "markReady",
  "markFailed",
  "delete",
]);

export class ProductArtifactMetadataRepositoryFixture {
  constructor(source) {
    if (source?.connect && "repositories" in source) {
      this.store = source;
      this.repository = null;
      return;
    }
    assertRepository(source);
    this.store = null;
    this.repository = source;
  }

  async createPending(record) {
    return (await this.#repository()).create(record);
  }

  async get({ workspaceId, artifactId }) {
    return (await this.#repository()).getById(artifactId, { workspaceId });
  }

  async list({ workspaceId, states, expiresBefore, updatedBefore, invocationId, attemptId, objectId, limit }) {
    const repository = await this.#repository();
    if (states?.length === 1 && states[0] === "pending" && !expiresBefore && !invocationId && !attemptId && !objectId) {
      return repository.listPending({ workspaceId, before: updatedBefore, limit });
    }
    return repository.listForCleanup({
      workspaceId,
      ...(states ? { states } : {}),
      ...(expiresBefore ? { expiresBefore } : {}),
      ...(updatedBefore ? { before: updatedBefore } : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(objectId ? { objectId } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  async transition({ workspaceId, artifactId, expectedState, nextState, expectedFence, patch }) {
    const repository = await this.#repository();
    const transition = {
      workspaceId,
      expectedState,
      expectedFence,
      ...structuredClone(patch),
    };
    if (nextState === "ready") return repository.markReady(artifactId, transition);
    if (nextState === "failed") return repository.markFailed(artifactId, transition);
    throw new TypeError("artifact_transition_state_invalid");
  }

  async delete({ workspaceId, artifactId, expectedStates }) {
    return (await this.#repository()).delete(artifactId, { workspaceId, expectedStates });
  }

  async #repository() {
    if (this.repository) return this.repository;
    await this.store.connect();
    const repository = this.store.repositories?.productArtifacts;
    assertRepository(repository);
    this.repository = repository;
    return repository;
  }
}

export function createProductArtifactMetadataRepositoryFixture(repository) {
  return new ProductArtifactMetadataRepositoryFixture(repository);
}

function assertRepository(repository) {
  if (!repository || REQUIRED_METHODS.some((method) => typeof repository[method] !== "function")) {
    throw new TypeError("product_artifact_repository_required");
  }
}
