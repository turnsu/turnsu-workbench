const REQUIRED_METHODS = Object.freeze([
  "createPending",
  "get",
  "list",
  "transition",
]);

export class ProductWorkerTranscriptArtifactRepositoryAdapter {
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
    return (await this.#repository()).createPending(record);
  }

  async get(input) {
    return (await this.#repository()).get(input);
  }

  async list(input) {
    return (await this.#repository()).list(input);
  }

  async transition(input) {
    return (await this.#repository()).transition(input);
  }

  async #repository() {
    if (this.repository) return this.repository;
    await this.store.connect();
    const repository = this.store.repositories?.workerTranscriptArtifacts;
    assertRepository(repository);
    this.repository = repository;
    return repository;
  }
}

export function createProductWorkerTranscriptArtifactRepositoryAdapter(source) {
  return new ProductWorkerTranscriptArtifactRepositoryAdapter(source);
}

function assertRepository(repository) {
  if (!repository || REQUIRED_METHODS.some((method) => typeof repository[method] !== "function")) {
    throw new TypeError("worker_transcript_repository_required");
  }
}
