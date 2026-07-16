const clone = (value) => value == null ? value : structuredClone(value);

export class InMemoryMemoryPersistence {
  constructor() {
    this.candidates = new Map();
    this.memories = new Map();
    this.events = new Map();
    this.tombstones = new Map();
  }

  async submitCandidate(candidate, event) {
    if (this.candidates.has(candidate.candidateId) || this.events.has(event.memoryEventId)) {
      throw new Error("memory_candidate_duplicate");
    }
    this.candidates.set(candidate.candidateId, clone(candidate));
    this.events.set(event.memoryEventId, clone(event));
    return clone(candidate);
  }
  async getCandidate(candidateId, workspaceId) {
    const value = this.candidates.get(candidateId);
    return value?.workspaceId === workspaceId ? clone(value) : null;
  }
  async patchCandidate(candidateId, workspaceId, patch) {
    const value = this.candidates.get(candidateId);
    if (!value || value.workspaceId !== workspaceId) return null;
    const next = { ...value, ...clone(patch) };
    this.candidates.set(candidateId, next);
    return clone(next);
  }
  async listCandidates({ workspaceId, status, scope, limit = 500 }) {
    return [...this.candidates.values()].filter((candidate) => candidate.workspaceId === workspaceId
      && (!status || candidate.status === status) && (!scope || candidate.scope.kind === scope))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit).map(clone);
  }
  async promoteCandidate({ candidateId, workspaceId, memory, candidatePatch, event }) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.workspaceId !== workspaceId || candidate.status !== "pending") return null;
    if (this.memories.has(memory.memoryId) || this.events.has(event.memoryEventId)) {
      throw new Error("durable_memory_duplicate");
    }
    const promoted = { ...candidate, ...clone(candidatePatch) };
    this.candidates.set(candidateId, promoted);
    this.memories.set(memory.memoryId, clone(memory));
    this.events.set(event.memoryEventId, clone(event));
    return { candidate: clone(promoted), memory: clone(memory) };
  }
  async rejectCandidate({ candidateId, workspaceId, candidatePatch, event }) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.workspaceId !== workspaceId || candidate.status !== "pending") return null;
    const rejected = { ...candidate, ...clone(candidatePatch) };
    this.candidates.set(candidateId, rejected);
    this.events.set(event.memoryEventId, clone(event));
    return clone(rejected);
  }
  async getMemory(memoryId, workspaceId) {
    const value = this.memories.get(memoryId);
    return value?.workspaceId === workspaceId ? clone(value) : null;
  }
  async searchMemories({ workspaceId, scopes, subject, tags, now, limit = 500 }) {
    return [...this.memories.values()].filter((memory) => memory.workspaceId === workspaceId
      && memory.status === "active" && scopes.includes(memory.scope.kind)
      && (!memory.expiresAt || memory.expiresAt > now)
      && (!subject || (memory.subject.kind === subject.kind && memory.subject.subjectId === subject.subjectId))
      && (!tags?.length || tags.some((tag) => memory.tags.includes(tag))))
      .slice(0, limit).map(clone);
  }
  async deleteMemoryWithTombstone(memoryId, workspaceId, tombstone, event) {
    const memory = this.memories.get(memoryId);
    if (!memory || memory.workspaceId !== workspaceId) return null;
    this.memories.delete(memoryId);
    this.tombstones.set(tombstone.tombstoneId, clone(tombstone));
    this.events.set(event.memoryEventId, clone(event));
    return clone(tombstone);
  }
  async getTombstoneByMemoryHash(memoryIdHash, workspaceId) {
    return clone([...this.tombstones.values()].find((item) => (
      item.memoryIdHash === memoryIdHash && item.workspaceId === workspaceId
    )) ?? null);
  }
  async appendEvent(event) { this.events.set(event.memoryEventId, clone(event)); return clone(event); }
}
