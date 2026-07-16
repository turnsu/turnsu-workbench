const clean = (value) => {
  if (!value) return value;
  const result = structuredClone(value);
  delete result._id;
  if (result.expiresAt instanceof Date) result.expiresAt = result.expiresAt.toISOString();
  return result;
};
const storage = (value) => ({
  ...structuredClone(value),
  ...(value.expiresAt ? { expiresAt: new Date(value.expiresAt) } : {}),
});

export class MongoMemoryPersistence {
  constructor({ store } = {}) {
    if (!store?.connect) throw new TypeError("memory_store_required");
    this.store = store;
  }

  async #repos() {
    await this.store.connect();
    const repositories = this.store.repositories;
    for (const name of ["memoryCandidates", "durableMemories", "memoryEvents", "memoryDeletionTombstones"]) {
      if (!repositories?.[name]?.collection) throw new TypeError(`memory_repository_missing:${name}`);
    }
    return repositories;
  }

  async submitCandidate(candidate, event) {
    const repositories = await this.#repos();
    return this.store.withTransaction(async (session) => {
      await repositories.memoryCandidates.collection.insertOne(storage(candidate), { session });
      await repositories.memoryEvents.collection.insertOne(structuredClone(event), { session });
      return structuredClone(candidate);
    });
  }
  async getCandidate(candidateId, workspaceId) {
    const repositories = await this.#repos();
    return clean(await repositories.memoryCandidates.collection.findOne({ candidateId, workspaceId }));
  }
  async patchCandidate(candidateId, workspaceId, patch) {
    const repositories = await this.#repos();
    return clean(await repositories.memoryCandidates.collection.findOneAndUpdate(
      { candidateId, workspaceId }, { $set: storage(patch) }, { returnDocument: "after" },
    ));
  }
  async listCandidates({ workspaceId, status, scope, limit = 500 }) {
    const repositories = await this.#repos();
    return (await repositories.memoryCandidates.collection.find({
      workspaceId, ...(status ? { status } : {}), ...(scope ? { "scope.kind": scope } : {}),
    }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 1000)).toArray()).map(clean);
  }
  async promoteCandidate({ candidateId, workspaceId, memory, candidatePatch, event }) {
    const repositories = await this.#repos();
    return this.store.withTransaction(async (session) => {
      const candidate = await repositories.memoryCandidates.collection.findOneAndUpdate(
        { candidateId, workspaceId, status: "pending" },
        { $set: storage(candidatePatch) },
        { returnDocument: "after", session },
      );
      if (!candidate) return null;
      await repositories.durableMemories.collection.insertOne(storage(memory), { session });
      await repositories.memoryEvents.collection.insertOne(structuredClone(event), { session });
      return { candidate: clean(candidate), memory: structuredClone(memory) };
    });
  }
  async rejectCandidate({ candidateId, workspaceId, candidatePatch, event }) {
    const repositories = await this.#repos();
    return this.store.withTransaction(async (session) => {
      const candidate = await repositories.memoryCandidates.collection.findOneAndUpdate(
        { candidateId, workspaceId, status: "pending" },
        { $set: storage(candidatePatch) },
        { returnDocument: "after", session },
      );
      if (!candidate) return null;
      await repositories.memoryEvents.collection.insertOne(structuredClone(event), { session });
      return clean(candidate);
    });
  }
  async getMemory(memoryId, workspaceId) {
    const repositories = await this.#repos();
    return clean(await repositories.durableMemories.collection.findOne({ memoryId, workspaceId }));
  }
  async searchMemories({ workspaceId, scopes, subject, text, tags, now, limit = 500 }) {
    const repositories = await this.#repos();
    const filter = {
      workspaceId,
      status: "active",
      "scope.kind": { $in: scopes },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(now) } }],
      ...(subject ? { "subject.kind": subject.kind, "subject.subjectId": subject.subjectId } : {}),
      ...(tags?.length ? { tags: { $in: tags } } : {}),
      ...(text ? { $text: { $search: text } } : {}),
    };
    let cursor = repositories.durableMemories.collection.find(filter, text ? { projection: { score: { $meta: "textScore" } } } : {});
    cursor = text ? cursor.sort({ score: { $meta: "textScore" }, confidence: -1, updatedAt: -1 }) : cursor.sort({ confidence: -1, updatedAt: -1 });
    return (await cursor.limit(Math.min(Math.max(limit, 1), 1000)).toArray()).map((item) => {
      const score = item.score;
      const result = clean(item);
      delete result.score;
      return { ...result, ...(Number.isFinite(score) ? { searchScore: score } : {}) };
    });
  }
  async deleteMemoryWithTombstone(memoryId, workspaceId, tombstone, event) {
    const repositories = await this.#repos();
    return this.store.withTransaction(async (session) => {
      const deleted = await repositories.durableMemories.collection.findOneAndDelete({ memoryId, workspaceId }, { session });
      if (!deleted) return null;
      await repositories.memoryDeletionTombstones.collection.insertOne(structuredClone(tombstone), { session });
      await repositories.memoryEvents.collection.insertOne(structuredClone(event), { session });
      return structuredClone(tombstone);
    });
  }
  async getTombstoneByMemoryHash(memoryIdHash, workspaceId) {
    const repositories = await this.#repos();
    return clean(await repositories.memoryDeletionTombstones.collection.findOne({ memoryIdHash, workspaceId }));
  }
  async appendEvent(event) {
    const repositories = await this.#repos();
    await repositories.memoryEvents.collection.insertOne(structuredClone(event));
    return structuredClone(event);
  }
}
