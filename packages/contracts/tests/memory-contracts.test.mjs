import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  DurableMemorySchema,
  MemoryCandidateSchema,
  MemoryDeletionTombstoneSchema,
  MemoryQuerySchema,
  WORKBENCH_V1_MEMORY_ENDPOINTS,
} from "../dist/index.js";

const now = "2026-07-16T12:00:00.000Z";
const candidate = {
  schemaVersion: "workbench-v1",
  candidateId: "memory-candidate-a",
  workspaceId: "workspace-a",
  scope: { kind: "personal", ownerUserId: "user-a" },
  subject: { kind: "workflow", subjectId: "workflow-a" },
  statement: "Use concise summaries.",
  tags: ["preference"],
  source: { kind: "agent", sourceId: "agent-turn-a", versionId: null, verified: false },
  evidence: [{ kind: "artifact", ref: "artifact:a", hash: "sha256:0123456789abcdef" }],
  confidence: 0.8,
  sensitivity: "low",
  expiresAt: null,
  createdBy: "agent-a",
  policyVersion: "product-memory-v1",
  submittedByKind: "agent",
  status: "pending",
  createdAt: now,
  decidedAt: null,
};

test("Product Memory contracts are strict, governed, and endpoint-complete", () => {
  assert.equal(Check(MemoryCandidateSchema, candidate), true);
  assert.equal(Check(DurableMemorySchema, {
    ...candidate,
    memoryId: "memory-a",
    status: "active",
    promotedBy: "user-a",
    promotionMode: "manual",
    updatedAt: now,
    candidateId: candidate.candidateId,
  }), false, "candidate-only fields must not leak into DurableMemory");
  const durable = {
    schemaVersion: "workbench-v1",
    memoryId: "memory-a",
    candidateId: candidate.candidateId,
    workspaceId: candidate.workspaceId,
    scope: candidate.scope,
    subject: candidate.subject,
    statement: candidate.statement,
    tags: candidate.tags,
    source: candidate.source,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    sensitivity: candidate.sensitivity,
    expiresAt: null,
    createdBy: candidate.createdBy,
    policyVersion: candidate.policyVersion,
    status: "active",
    promotedBy: "user-a",
    promotionMode: "manual",
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(Check(DurableMemorySchema, durable), true);
  assert.equal(Check(MemoryQuerySchema, {
    workspaceId: "workspace-a",
    scopes: ["personal", "workspace"],
    tags: [],
    limit: 20,
  }), true);
  assert.equal(Check(MemoryCandidateSchema, { ...candidate, rawTranscript: "must not persist" }), false);
  assert.equal(Check(MemoryDeletionTombstoneSchema, {
    schemaVersion: "workbench-v1",
    tombstoneId: "memory-tombstone-a",
    workspaceId: "workspace-a",
    memoryIdHash: `sha256:${"a".repeat(64)}`,
    scopeKind: "personal",
    deletedBy: "user-a",
    reason: "User requested deletion.",
    policyVersion: "product-memory-v1",
    deletedAt: now,
  }), true);

  assert.deepEqual(Object.fromEntries(Object.entries(WORKBENCH_V1_MEMORY_ENDPOINTS).map(([key, endpoint]) => [key, `${endpoint.method} ${endpoint.path}`])), {
    listMemoryCandidates: "GET /api/workbench/v1/memory-candidates",
    approveMemoryCandidate: "POST /api/workbench/v1/memory-candidates/{candidateId}/approve",
    rejectMemoryCandidate: "POST /api/workbench/v1/memory-candidates/{candidateId}/reject",
    listMemories: "GET /api/workbench/v1/memories",
    deleteMemory: "DELETE /api/workbench/v1/memories/{memoryId}",
  });
});
