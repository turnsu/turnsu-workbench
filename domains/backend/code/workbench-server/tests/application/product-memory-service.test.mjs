import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMemoryPersistence,
  ProductMemoryService,
} from "../../src/memory/index.mjs";

const BASE_TIME = "2026-07-16T10:00:00.000Z";

function fixture({ objectPermissionResolver, canonicalResolver, initialTime = BASE_TIME } = {}) {
  let time = initialTime;
  let sequence = 0;
  const persistence = new InMemoryMemoryPersistence();
  const service = new ProductMemoryService({
    persistence,
    clock: () => time,
    idFactory: (kind) => `${kind}-${++sequence}`,
    objectPermissionResolver,
    canonicalResolver,
  });
  return {
    persistence,
    service,
    setTime(value) { time = value; },
  };
}

const context = (userId = "user-a", role = "owner", workspaceId = "workspace-a") => ({
  userId,
  role,
  workspaceId,
});

const evidence = (kind = "artifact") => [{
  kind,
  ref: "artifact:fact-1",
  hash: "sha256:0123456789abcdef",
}];

function candidateInput(overrides = {}) {
  return {
    scope: { kind: "personal", ownerUserId: "user-a" },
    subject: { kind: "workflow", subjectId: "workflow-a" },
    statement: "The user prefers concise run summaries.",
    tags: ["preference"],
    source: { kind: "agent", sourceId: "turn-a", versionId: null, verified: false },
    evidence: evidence(),
    confidence: 0.7,
    sensitivity: "low",
    expiresAt: null,
    ...overrides,
  };
}

test("Agent and Worker submissions remain candidates and cannot write durable memory directly", async () => {
  const { service, persistence } = fixture();
  assert.equal(typeof service.createMemory, "undefined");

  const candidate = await service.submitCandidate({
    input: candidateInput(),
    actor: { kind: "worker", id: "worker-a" },
    context: context(),
  });

  assert.equal(candidate.status, "pending");
  assert.equal(persistence.memories.size, 0);
  assert.deepEqual(await service.query({
    query: { scopes: ["personal"], tags: [], limit: 10 },
    context: context(),
  }), []);
});

test("first-version retrieval never invokes the reserved embedding adapter", async () => {
  let calls = 0;
  const persistence = new InMemoryMemoryPersistence();
  const service = new ProductMemoryService({
    persistence,
    clock: () => BASE_TIME,
    idFactory: (() => { let sequence = 0; return (kind) => `${kind}-${++sequence}`; })(),
    embeddingAdapter: { async embed() { calls += 1; throw new Error("must_not_call"); } },
  });
  await service.query({ query: { scopes: ["personal"], tags: [], limit: 10 }, context: context() });
  assert.equal(calls, 0);
});

test("retrieval uses memory identity as the final stable ranking tie-break", async () => {
  const { service, persistence } = fixture();
  for (const suffix of ["b", "a"]) {
    persistence.memories.set(`memory-${suffix}`, {
      schemaVersion: "workbench-v1",
      memoryId: `memory-${suffix}`,
      candidateId: `candidate-${suffix}`,
      workspaceId: "workspace-a",
      scope: { kind: "workspace" },
      subject: { kind: "workflow", subjectId: "workflow-a" },
      statement: "Stable ranking tie.",
      tags: ["ranking"],
      source: { kind: "agent", sourceId: `turn-${suffix}`, versionId: null, verified: false },
      evidence: evidence(),
      confidence: 0.8,
      sensitivity: "low",
      expiresAt: null,
      status: "active",
      promotionMode: "manual",
      policyVersion: "product-memory-v1",
      createdBy: "user-a",
      approvedBy: "user-a",
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    });
  }

  const results = await service.query({
    query: { scopes: ["workspace"], tags: [], limit: 10 },
    context: context(),
  });
  assert.deepEqual(results.map(({ memory }) => memory.memoryId), ["memory-a", "memory-b"]);
});

test("Agent and Worker cannot forge canonical verification to auto-promote", async () => {
  const { service, persistence } = fixture();
  for (const actorKind of ["agent", "worker"]) {
    const candidate = await service.submitCandidate({
      input: candidateInput({
        scope: { kind: "workspace" },
        source: { kind: "canonical_object", sourceId: "workflow-a", versionId: "revision-7", verified: true },
        evidence: evidence("canonical_object"),
        confidence: 0.98,
      }),
      actor: { kind: actorKind, id: `${actorKind}-main` },
      context: context("user-a", "member"),
    });

    assert.equal(candidate.status, "pending");
    assert.equal(candidate.source.verified, false);
  }
  assert.equal(persistence.memories.size, 0);
});

test("only server-resolved low-sensitivity Canonical Object facts auto-promote", async () => {
  const calls = [];
  const { service, persistence } = fixture({
    canonicalResolver: {
      async resolve(reference) {
        calls.push(reference);
        return {
          source: { kind: "canonical_object", sourceId: "workflow-a", versionId: "revision-7", verified: true },
          evidence: [
            { kind: "canonical_object", ref: "product:workflow/workflow-a/revisions/revision-7", hash: "sha256:aaaaaaaaaaaaaaaa" },
            { kind: "validation", ref: "product:workflow/workflow-a/revisions/revision-7/compile", hash: "sha256:bbbbbbbbbbbbbbbb" },
          ],
          statement: "Ship a verified workflow.",
          subject: { kind: "workflow", subjectId: "workflow-a" },
          verification: { objectKind: "workflow", objectId: "workflow-a", versionId: "revision-7", factPath: "/definition/goal" },
        };
      },
    },
  });
  const promoted = await service.ingestCanonicalFact({
    input: candidateInput({
      scope: { kind: "workspace" },
      confidence: 0.98,
    }),
    canonicalRef: {
      objectKind: "workflow",
      objectId: "workflow-a",
      versionId: "revision-7",
      factPath: "/definition/goal",
      expectedEvidenceHash: "sha256:aaaaaaaaaaaaaaaa",
    },
    context: context("user-a", "owner"),
  });

  assert.deepEqual(calls, [{
    workspaceId: "workspace-a",
    objectKind: "workflow",
    objectId: "workflow-a",
    versionId: "revision-7",
    factPath: "/definition/goal",
    expectedEvidenceHash: "sha256:aaaaaaaaaaaaaaaa",
  }]);
  assert.equal(promoted.status, "promoted");
  assert.equal(persistence.memories.size, 1);
  const [result] = await service.query({
    query: { scopes: ["workspace"], text: "verified", tags: [], limit: 10 },
    context: context("user-b", "viewer"),
  });
  assert.equal(result.memory.candidateId, promoted.candidateId);
  assert.equal(result.memory.promotionMode, "policy");
});

test("personal, workspace, object, and tenant permissions are enforced", async () => {
  const { service } = fixture({
    objectPermissionResolver: async ({ scope, context: actorContext, action }) => (
      scope.objectId === "workflow-a"
      && actorContext.userId === "user-editor"
      && ["submit", "read", "approve", "delete"].includes(action)
    ),
  });
  const personal = await service.submitCandidate({
    input: candidateInput(),
    actor: { kind: "agent", id: "agent-personal" },
    context: context(),
  });
  assert.deepEqual(await service.listCandidates({ context: context("user-b", "owner") }), []);
  await assert.rejects(
    service.approveCandidate({ candidateId: personal.candidateId, reason: "No access", context: context("user-b", "owner") }),
    { code: "memory_access_forbidden" },
  );

  const shared = await service.submitCandidate({
    input: candidateInput({ scope: { kind: "workspace" } }),
    actor: { kind: "agent", id: "agent-shared" },
    context: context("user-a", "member"),
  });
  await assert.rejects(
    service.approveCandidate({ candidateId: shared.candidateId, reason: "Member cannot approve", context: context("user-a", "member") }),
    { code: "memory_access_forbidden" },
  );
  assert.equal((await service.approveCandidate({
    candidateId: shared.candidateId,
    reason: "Workspace owner approved.",
    context: context(),
  })).status, "promoted");

  await assert.rejects(
    service.submitCandidate({
      input: candidateInput({ scope: { kind: "object", objectKind: "workflow", objectId: "workflow-a" } }),
      actor: { kind: "agent", id: "agent-object" },
      context: context("user-viewer", "viewer"),
    }),
    { code: "memory_access_forbidden" },
  );
  const objectCandidate = await service.submitCandidate({
    input: candidateInput({ scope: { kind: "object", objectKind: "workflow", objectId: "workflow-a" } }),
    actor: { kind: "agent", id: "agent-object" },
    context: context("user-editor", "member"),
  });
  assert.equal((await service.approveCandidate({
    candidateId: objectCandidate.candidateId,
    reason: "Object editor approved.",
    context: context("user-editor", "member"),
  })).status, "promoted");
  assert.deepEqual(await service.listCandidates({ context: context("user-editor", "owner", "workspace-other") }), []);
});

test("concurrent approval creates exactly one durable memory", async () => {
  const { service, persistence } = fixture();
  const candidate = await service.submitCandidate({
    input: candidateInput(),
    actor: { kind: "agent", id: "agent-a" },
    context: context(),
  });
  const outcomes = await Promise.allSettled([
    service.approveCandidate({ candidateId: candidate.candidateId, reason: "Approve once.", context: context() }),
    service.approveCandidate({ candidateId: candidate.candidateId, reason: "Approve twice.", context: context() }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(persistence.memories.size, 1);
});

test("TTL filtering and physical deletion preserve only a content-free tombstone", async () => {
  const { service, persistence, setTime } = fixture();
  const expiring = await service.submitCandidate({
    input: candidateInput({ expiresAt: "2026-07-16T11:00:00.000Z" }),
    actor: { kind: "agent", id: "agent-a" },
    context: context(),
  });
  await service.approveCandidate({ candidateId: expiring.candidateId, reason: "Useful for one hour.", context: context() });
  assert.equal((await service.query({ query: { scopes: ["personal"], tags: [], limit: 10 }, context: context() })).length, 1);
  setTime("2026-07-16T12:00:00.000Z");
  assert.equal((await service.query({ query: { scopes: ["personal"], tags: [], limit: 10 }, context: context() })).length, 0);

  setTime("2026-07-16T10:30:00.000Z");
  const durable = [...persistence.memories.values()][0];
  const tombstone = await service.deleteMemory({ memoryId: durable.memoryId, reason: "User requested deletion.", context: context() });
  assert.equal(await persistence.getMemory(durable.memoryId, "workspace-a"), null);
  assert.equal(await persistence.getCandidate(durable.candidateId, "workspace-a"), null);
  assert.match(tombstone.memoryIdHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(tombstone).includes("concise run summaries"), false);
  assert.equal(Object.hasOwn(tombstone, "memoryId"), false);
  const events = await persistence.listEvents({ workspaceId: "workspace-a" });
  assert.deepEqual(events.map(({ type }) => type), [
    "candidate.submitted",
    "candidate.approved",
    "memory.deleted",
  ]);
  assert.equal(JSON.stringify(events).includes("concise run summaries"), false);
});

test("Context Capsule contains bounded summaries and evidence references, not transcripts", async () => {
  const { service } = fixture();
  const candidate = await service.submitCandidate({
    input: candidateInput({ statement: "A governed summary without raw conversation content." }),
    actor: { kind: "agent", id: "agent-a" },
    context: context(),
  });
  await service.approveCandidate({ candidateId: candidate.candidateId, reason: "Reviewed summary.", context: context() });
  const capsule = await service.contextCapsule({
    query: { scopes: ["personal"], tags: [], limit: 10 },
    context: context(),
    maxChars: 200,
  });
  assert.deepEqual(Object.keys(capsule.memories[0]).sort(), ["evidenceRefs", "memoryId", "summary"]);
  assert.equal(JSON.stringify(capsule).includes("transcript"), false);
});
