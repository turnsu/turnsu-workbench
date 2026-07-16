import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Check, WORKBENCH_V1_MEMORY_ENDPOINTS } from "@looloomi/workbench-contracts";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

const NOW = "2026-07-16T12:00:00.000Z";
const ORIGIN = "http://127.0.0.1";

class MockResponse extends EventEmitter {
  constructor() { super(); this.status = null; this.headers = {}; this.body = ""; }
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; }
  write(value) { this.body += value; }
  end(value = "") { this.body += value; this.emit("finish"); }
}

function request({ method = "GET", url, headers = {}, body }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key.toLowerCase(), value])) };
  req[Symbol.asyncIterator] = async function* iterator() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}

async function invoke(handler, options) {
  const response = new MockResponse();
  await handler(request(options), response);
  return response;
}

function setup(application) {
  const sessionStore = new WorkbenchSessionStore({
    clock: () => new Date(NOW),
    tokenFactory: () => "memory-http-session-token",
    csrfTokenFactory: () => "memory-http-csrf-token-abcdefghijklmnopqrstuvwxyz",
  });
  const session = sessionStore.issue({ userId: "user-a", activeWorkspaceId: "workspace-a" });
  return {
    session,
    handler: createWorkbenchHttpHandler({ application, sessionStore, origin: ORIGIN, requestIdFactory: () => "request-memory-http" }),
  };
}

function mutationHeaders(session, idempotencyKey) {
  return {
    Cookie: `workbench_session=${session.token}`,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": session.csrfToken,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  };
}

const candidate = {
  schemaVersion: "workbench-v1",
  candidateId: "memory-candidate-a",
  workspaceId: "workspace-a",
  scope: { kind: "personal", ownerUserId: "user-a" },
  subject: { kind: "workflow", subjectId: "workflow-a" },
  statement: "Use concise summaries.",
  tags: ["preference"],
  source: { kind: "agent", sourceId: "turn-a", versionId: null, verified: false },
  evidence: [{ kind: "artifact", ref: "artifact:a", hash: "sha256:0123456789abcdef" }],
  confidence: 0.8,
  sensitivity: "low",
  expiresAt: null,
  createdBy: "agent-a",
  policyVersion: "product-memory-v1",
  submittedByKind: "agent",
  status: "pending",
  createdAt: NOW,
  decidedAt: null,
};

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
  createdAt: NOW,
  updatedAt: NOW,
};

test("formal Memory review, retrieval, and deletion routes return contract-valid responses", async () => {
  const calls = [];
  const application = {
    async listMemoryCandidates(input) { calls.push(input); return { data: [candidate], page: { nextCursor: null, hasMore: false } }; },
    async approveMemoryCandidate(input) { calls.push(input); return { ...candidate, status: "promoted", decidedAt: NOW }; },
    async rejectMemoryCandidate(input) { calls.push(input); return { ...candidate, status: "rejected", decidedAt: NOW }; },
    async listMemories(input) { calls.push(input); return { data: [durable], page: { nextCursor: null, hasMore: false } }; },
    async deleteMemory(input) {
      calls.push(input);
      return { schemaVersion: "workbench-v1", tombstoneId: "memory-tombstone-a", workspaceId: "workspace-a", memoryIdHash: `sha256:${"a".repeat(64)}`, scopeKind: "personal", deletedBy: "user-a", reason: input.request.data.reason, policyVersion: "product-memory-v1", deletedAt: NOW };
    },
  };
  const { handler, session } = setup(application);
  const readHeaders = { Cookie: `workbench_session=${session.token}` };

  const listedCandidates = await invoke(handler, { url: "/api/workbench/v1/memory-candidates?status=pending", headers: readHeaders });
  assert.equal(listedCandidates.status, 200, listedCandidates.body);
  assert.equal(Check(WORKBENCH_V1_MEMORY_ENDPOINTS.listMemoryCandidates.responseBodySchema, JSON.parse(listedCandidates.body)), true);

  const approved = await invoke(handler, {
    method: "POST",
    url: `/api/workbench/v1/memory-candidates/${candidate.candidateId}/approve`,
    headers: mutationHeaders(session, "approve-memory-a"),
    body: { schemaVersion: "workbench-api-v1", data: { reason: "Reviewed evidence." } },
  });
  assert.equal(approved.status, 200, approved.body);
  assert.equal(Check(WORKBENCH_V1_MEMORY_ENDPOINTS.approveMemoryCandidate.responseBodySchema, JSON.parse(approved.body)), true);

  const listed = await invoke(handler, { url: "/api/workbench/v1/memories?scope=personal&tags=preference", headers: readHeaders });
  assert.equal(listed.status, 200, listed.body);
  assert.equal(Check(WORKBENCH_V1_MEMORY_ENDPOINTS.listMemories.responseBodySchema, JSON.parse(listed.body)), true);

  const deleted = await invoke(handler, {
    method: "DELETE",
    url: `/api/workbench/v1/memories/${durable.memoryId}`,
    headers: mutationHeaders(session, "delete-memory-a"),
    body: { schemaVersion: "workbench-api-v1", data: { reason: "Remove this memory." } },
  });
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal(Check(WORKBENCH_V1_MEMORY_ENDPOINTS.deleteMemory.responseBodySchema, JSON.parse(deleted.body)), true);
  assert.equal(calls.at(-1).memoryId, durable.memoryId);
});

test("Memory API exposes no direct Candidate submission or Durable Memory write route", async () => {
  const { handler, session } = setup({});
  for (const url of ["/api/workbench/v1/memory-candidates", "/api/workbench/v1/memories"]) {
    const response = await invoke(handler, {
      method: "POST",
      url,
      headers: mutationHeaders(session, `forbidden-${url.length}`),
      body: { schemaVersion: "workbench-api-v1", data: {} },
    });
    assert.equal(response.status, 404);
  }
});
