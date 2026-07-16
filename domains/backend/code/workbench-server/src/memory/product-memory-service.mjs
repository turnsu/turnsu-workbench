import { createHash } from "node:crypto";

import {
  Check,
  DurableMemorySchema,
  MemoryCandidateSchema,
  MemoryDeletionTombstoneSchema,
  MemoryEventSchema,
  MemoryQuerySchema,
} from "@looloomi/workbench-contracts";

const SCHEMA_VERSION = "workbench-v1";
const DEFAULT_POLICY_VERSION = "product-memory-v1";

export class ProductMemoryError extends Error {
  constructor(code, message = code) { super(message); this.name = "ProductMemoryError"; this.code = code; }
}

export class ProductMemoryService {
  constructor({
    persistence,
    clock = () => new Date().toISOString(),
    idFactory,
    objectPermissionResolver = async () => false,
    canonicalResolver = null,
    embeddingAdapter = null,
    policyVersion = DEFAULT_POLICY_VERSION,
  } = {}) {
    if (!persistence || typeof idFactory !== "function") throw new TypeError("memory_persistence_and_id_factory_required");
    this.persistence = persistence;
    this.clock = clock;
    this.idFactory = idFactory;
    this.objectPermissionResolver = objectPermissionResolver;
    this.canonicalResolver = canonicalResolver;
    this.embeddingAdapter = embeddingAdapter;
    this.policyVersion = policyVersion;
  }

  async submitCandidate({ input, actor, context }) {
    requireContext(context);
    if (!actor || !["agent", "worker", "user", "system"].includes(actor.kind)) throw new ProductMemoryError("memory_actor_invalid");
    validateScopeOwnership(input.scope, context, actor);
    if (!await this.#canAccess(input.scope, context, "submit")) throw new ProductMemoryError("memory_access_forbidden");
    return this.#submitCandidateValue({
      input,
      actor,
      context,
      source: { ...structuredClone(input.source), verified: false },
      evidence: structuredClone(input.evidence ?? []),
      metadata: { verification: "caller_untrusted" },
    });
  }

  async ingestCanonicalFact({ input, canonicalRef, context }) {
    requireContext(context);
    if (!this.canonicalResolver || typeof this.canonicalResolver.resolve !== "function") {
      throw new ProductMemoryError("canonical_memory_resolver_unavailable");
    }
    const actor = { kind: "system", id: "product-canonical-memory" };
    validateScopeOwnership(input.scope, context, actor);
    if (!await this.#canAccess(input.scope, context, "submit")) throw new ProductMemoryError("memory_access_forbidden");
    const verified = await this.canonicalResolver.resolve({
      workspaceId: context.workspaceId,
      objectKind: canonicalRef?.objectKind,
      objectId: canonicalRef?.objectId,
      versionId: canonicalRef?.versionId,
      factPath: canonicalRef?.factPath,
      ...(canonicalRef?.expectedEvidenceHash ? { expectedEvidenceHash: canonicalRef.expectedEvidenceHash } : {}),
    });
    const candidate = await this.#submitCandidateValue({
      input: {
        ...input,
        subject: verified.subject,
        statement: verified.statement,
      },
      actor,
      context,
      source: verified.source,
      evidence: verified.evidence,
      metadata: { verification: "server_resolved", ...verified.verification },
    });
    if (candidate.sensitivity !== "low") return candidate;
    return (await this.#promote(candidate, {
      userId: "product-memory-policy",
      workspaceId: context.workspaceId,
      role: "owner",
    }, {
      automatic: true,
      reason: "Server-resolved low-sensitivity Canonical Object fact with verified evidence.",
    })).candidate;
  }

  async #submitCandidateValue({ input, actor, context, source, evidence, metadata }) {
    const now = this.clock();
    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      candidateId: this.idFactory("memory-candidate"),
      workspaceId: context.workspaceId,
      scope: structuredClone(input.scope),
      subject: structuredClone(input.subject),
      statement: String(input.statement || "").trim(),
      tags: uniqueStrings(input.tags),
      source: structuredClone(source),
      evidence: structuredClone(evidence),
      confidence: Number(input.confidence),
      sensitivity: input.sensitivity,
      expiresAt: input.expiresAt ?? null,
      createdBy: actor.id,
      policyVersion: this.policyVersion,
      submittedByKind: actor.kind,
      status: "pending",
      createdAt: now,
      decidedAt: null,
    };
    if (!Check(MemoryCandidateSchema, candidate)) throw new ProductMemoryError("memory_candidate_invalid", "Memory candidate is invalid.");
    const submittedEvent = this.#eventValue("candidate.submitted", candidate, null, actor.id, metadata, now);
    await this.persistence.submitCandidate(candidate, submittedEvent);
    return candidate;
  }

  async listCandidates({ context, status, scope, limit = 500 }) {
    requireContext(context);
    const candidates = await this.persistence.listCandidates({ workspaceId: context.workspaceId, status, scope, limit });
    const allowed = [];
    for (const candidate of candidates) if (await this.#canAccess(candidate.scope, context, "read")) allowed.push(candidate);
    return allowed;
  }

  async getCandidate({ candidateId, context }) {
    requireContext(context);
    const candidate = await this.#candidate(candidateId, context.workspaceId);
    if (!await this.#canAccess(candidate.scope, context, "read")) throw new ProductMemoryError("memory_access_forbidden");
    return candidate;
  }

  async approveCandidate({ candidateId, reason, context }) {
    requireContext(context);
    const candidate = await this.#candidate(candidateId, context.workspaceId);
    if (!await this.#canAccess(candidate.scope, context, "approve")) throw new ProductMemoryError("memory_access_forbidden");
    if (candidate.status !== "pending") throw new ProductMemoryError("memory_candidate_state_invalid");
    return (await this.#promote(candidate, context, { automatic: false, reason })).candidate;
  }

  async rejectCandidate({ candidateId, reason, context }) {
    requireContext(context);
    const candidate = await this.#candidate(candidateId, context.workspaceId);
    if (!await this.#canAccess(candidate.scope, context, "approve")) throw new ProductMemoryError("memory_access_forbidden");
    if (candidate.status !== "pending") throw new ProductMemoryError("memory_candidate_state_invalid");
    const decidedAt = this.clock();
    const event = this.#eventValue(
      "candidate.rejected",
      candidate,
      null,
      context.userId,
      { reason: String(reason).slice(0, 2000) },
      decidedAt,
    );
    const rejected = await this.persistence.rejectCandidate({
      candidateId,
      workspaceId: context.workspaceId,
      candidatePatch: { status: "rejected", decidedAt },
      event,
    });
    if (!rejected) throw new ProductMemoryError("memory_candidate_state_invalid");
    return rejected;
  }

  async query({ query, context }) {
    requireContext(context);
    const normalized = {
      workspaceId: context.workspaceId,
      scopes: query.scopes,
      tags: uniqueStrings(query.tags),
      limit: query.limit,
      ...(query.subject ? { subject: structuredClone(query.subject) } : {}),
      ...(query.text ? { text: String(query.text).trim() } : {}),
    };
    if (!Check(MemoryQuerySchema, normalized)) throw new ProductMemoryError("memory_query_invalid");
    const memories = await this.persistence.searchMemories({ ...normalized, now: this.clock(), limit: Math.min(normalized.limit * 10, 1000) });
    const allowed = [];
    for (const memory of memories) if (await this.#canAccess(memory.scope, context, "read")) allowed.push(memory);
    return allowed.map((memory) => scoreMemory(memory, normalized, this.clock())).sort((left, right) => right.score - left.score).slice(0, normalized.limit);
  }

  async contextCapsule({ query, context, maxItems = 10, maxChars = 4000 }) {
    const results = await this.query({ query: { ...query, limit: Math.min(maxItems, 10) }, context });
    let used = 0;
    const memories = [];
    for (const result of results) {
      const summary = result.memory.statement.slice(0, 500);
      if (used + summary.length > maxChars) break;
      used += summary.length;
      memories.push({ memoryId: result.memory.memoryId, summary, evidenceRefs: result.memory.evidence.map((item) => item.ref) });
    }
    return { memories, truncated: memories.length < results.length };
  }

  async deleteMemory({ memoryId, reason, context }) {
    requireContext(context);
    const memory = await this.persistence.getMemory(memoryId, context.workspaceId);
    if (!memory) throw new ProductMemoryError("memory_not_found");
    if (!await this.#canAccess(memory.scope, context, "delete")) throw new ProductMemoryError("memory_access_forbidden");
    const deletedAt = this.clock();
    const tombstone = {
      schemaVersion: SCHEMA_VERSION,
      tombstoneId: this.idFactory("memory-tombstone"),
      workspaceId: context.workspaceId,
      memoryIdHash: `sha256:${createHash("sha256").update(memory.memoryId).digest("hex")}`,
      scopeKind: memory.scope.kind,
      deletedBy: context.userId,
      reason: String(reason || "Deleted by user.").slice(0, 2000),
      policyVersion: this.policyVersion,
      deletedAt,
    };
    if (!Check(MemoryDeletionTombstoneSchema, tombstone)) throw new ProductMemoryError("memory_tombstone_invalid");
    const event = this.#eventValue("memory.deleted", null, memory, context.userId, { tombstoneId: tombstone.tombstoneId }, deletedAt);
    const deleted = await this.persistence.deleteMemoryWithTombstone(memoryId, context.workspaceId, tombstone, event);
    if (!deleted) throw new ProductMemoryError("memory_not_found");
    return deleted;
  }

  async recoverDeletion({ memoryId, context }) {
    requireContext(context);
    const memoryIdHash = `sha256:${createHash("sha256").update(memoryId).digest("hex")}`;
    return this.persistence.getTombstoneByMemoryHash(memoryIdHash, context.workspaceId);
  }

  async #promote(candidate, context, { automatic, reason }) {
    const now = this.clock();
    const memory = {
      schemaVersion: SCHEMA_VERSION,
      memoryId: this.idFactory("memory"),
      candidateId: candidate.candidateId,
      workspaceId: candidate.workspaceId,
      scope: structuredClone(candidate.scope),
      subject: structuredClone(candidate.subject),
      statement: candidate.statement,
      tags: structuredClone(candidate.tags),
      source: structuredClone(candidate.source),
      evidence: structuredClone(candidate.evidence),
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      expiresAt: candidate.expiresAt,
      createdBy: candidate.createdBy,
      policyVersion: this.policyVersion,
      status: "active",
      promotedBy: context.userId,
      promotionMode: automatic ? "policy" : "manual",
      createdAt: now,
      updatedAt: now,
    };
    if (!Check(DurableMemorySchema, memory)) throw new ProductMemoryError("durable_memory_invalid");
    const event = this.#eventValue(
      "candidate.approved",
      candidate,
      memory,
      context.userId,
      { automatic, reason: String(reason).slice(0, 2000) },
      now,
    );
    const promoted = await this.persistence.promoteCandidate({
      candidateId: candidate.candidateId,
      workspaceId: candidate.workspaceId,
      memory,
      candidatePatch: { status: "promoted", decidedAt: now },
      event,
    });
    if (!promoted) throw new ProductMemoryError("memory_candidate_state_invalid");
    return promoted;
  }

  async #candidate(candidateId, workspaceId) {
    const candidate = await this.persistence.getCandidate(candidateId, workspaceId);
    if (!candidate) throw new ProductMemoryError("memory_candidate_not_found");
    return candidate;
  }

  async #canAccess(scope, context, action) {
    if (scope.kind === "personal") return scope.ownerUserId === context.userId;
    if (scope.kind === "workspace") {
      if (action === "read") return true;
      if (action === "submit") return ["owner", "admin", "maintainer", "member"].includes(context.role);
      return ["owner", "admin"].includes(context.role);
    }
    return this.objectPermissionResolver({ scope, context, action });
  }

  async #event(type, candidate, memory, actorId, metadata) {
    return this.persistence.appendEvent(this.#eventValue(type, candidate, memory, actorId, metadata, this.clock()));
  }
  #eventValue(type, candidate, memory, actorId, metadata, createdAt) {
    const event = {
      schemaVersion: SCHEMA_VERSION,
      memoryEventId: this.idFactory("memory-event"),
      workspaceId: candidate?.workspaceId ?? memory.workspaceId,
      candidateId: candidate?.candidateId ?? memory?.candidateId ?? null,
      memoryId: memory?.memoryId ?? null,
      type,
      actorId,
      metadata: structuredClone(metadata),
      createdAt,
    };
    if (!Check(MemoryEventSchema, event)) throw new ProductMemoryError("memory_event_invalid");
    return event;
  }
}

function validateScopeOwnership(scope, context, actor) {
  if (!scope || typeof scope !== "object") throw new ProductMemoryError("memory_scope_invalid");
  if (scope.kind === "personal" && scope.ownerUserId !== context.userId) {
    throw new ProductMemoryError("memory_access_forbidden");
  }
}

function scoreMemory(memory, query, now) {
  let score = memory.searchScore ?? 0;
  const matchedBy = new Set();
  const terms = String(query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${memory.statement} ${memory.tags.join(" ")}`.toLowerCase();
  const textMatches = terms.filter((term) => haystack.includes(term)).length;
  if (textMatches) { score += textMatches * 3; matchedBy.add("text"); }
  const tagMatches = query.tags.filter((tag) => memory.tags.includes(tag)).length;
  if (tagMatches) { score += tagMatches * 2; matchedBy.add("tag"); }
  score += memory.confidence * 2; matchedBy.add("confidence");
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(memory.updatedAt)) / 86_400_000);
  score += 1 / (1 + ageDays); matchedBy.add("recency");
  const clean = structuredClone(memory); delete clean.searchScore;
  return { memory: clean, score, matchedBy: [...matchedBy] };
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().slice(0, 64)))];
}

function requireContext(context) {
  if (!context?.userId || !context?.workspaceId || !context?.role) throw new ProductMemoryError("memory_context_invalid");
}
