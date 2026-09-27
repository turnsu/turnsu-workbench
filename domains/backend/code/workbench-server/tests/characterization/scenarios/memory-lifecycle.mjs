import assert from "node:assert/strict";

function requireContext(context) {
  assert.equal(typeof context?.createMemoryFixture, "function");
  assert.equal(typeof context?.openMemoryReader, "function");
  assert.equal(typeof context?.principal?.userId, "string");
  assert.equal(typeof context?.principal?.workspaceId, "string");
  assert.equal(typeof context?.ids, "function");
  assert.equal(typeof context?.now, "string");
  return context;
}

function memoryContext(context) {
  return {
    userId: context.principal.userId,
    workspaceId: context.principal.workspaceId,
    role: "owner",
  };
}

async function serviceFixture(context, suffix, now = context.now) {
  let sequence = 0;
  let currentTime = new Date(now).toISOString();
  const fixture = await context.createMemoryFixture({
    clock: () => currentTime,
    idFactory: (kind) => context.ids(`${suffix}-${kind}-${++sequence}`),
  });
  assert.equal(typeof fixture?.persistence?.getCandidate, "function");
  assert.equal(typeof fixture?.persistence?.getMemory, "function");
  assert.equal(typeof fixture?.persistence?.listEvents, "function");
  assert.equal(typeof fixture?.service?.submitCandidate, "function");
  assert.equal(typeof fixture?.retention?.sweepExpired, "function");
  return {
    ...fixture,
    setTime(value) { currentTime = new Date(value).toISOString(); },
  };
}

function candidateInput({
  subjectId,
  statement,
  confidence,
  tags = ["characterization"],
  expiresAt = null,
}) {
  return {
    scope: { kind: "workspace" },
    subject: { kind: "workflow", subjectId },
    statement,
    tags,
    source: {
      kind: "agent",
      sourceId: `${subjectId}-source`,
      versionId: null,
      verified: false,
    },
    evidence: [{
      kind: "artifact",
      ref: `artifact:${subjectId}`,
      hash: "sha256:0123456789abcdef",
    }],
    confidence,
    sensitivity: "low",
    expiresAt,
  };
}

async function promote({ service, persistence, context, input, label }) {
  const candidate = await service.submitCandidate({
    input,
    actor: { kind: "user", id: context.userId },
    context,
  });
  await service.approveCandidate({
    candidateId: candidate.candidateId,
    reason: `Characterization approval: ${label}.`,
    context,
  });
  const memories = await persistence.searchMemories({
    workspaceId: context.workspaceId,
    scopes: ["workspace"],
    subject: input.subject,
    tags: [],
    // Promotion may deliberately seed a due record for the retention case.
    // This lookup only obtains the newly durable identity; expiry enforcement
    // itself is still performed by the database-clock retention owner below.
    now: input.expiresAt
      ? new Date(Math.max(0, Date.parse(input.expiresAt) - 1)).toISOString()
      : new Date().toISOString(),
    limit: 50,
  });
  const memory = memories.find((item) => item.candidateId === candidate.candidateId);
  assert.ok(memory, `durable memory missing for ${label}`);
  return { candidate, memory };
}

async function retentionTtlCleanup(rawContext) {
  const context = requireContext(rawContext);
  const actorContext = memoryContext(context);
  const wallClock = new Date();
  // A retention owner must use its persistence server clock.  Seed a due
  // record; neither the scenario nor ProductMemoryService deletes storage.
  const dueExpiry = new Date(wallClock.getTime() - 1_000).toISOString();
  const { persistence, service, retention } = await serviceFixture(context, "ttl", wallClock.toISOString());

  const pending = await service.submitCandidate({
    input: candidateInput({
      subjectId: context.ids("ttl-pending-subject"),
      statement: "Ephemeral characterization fact.",
      confidence: 0.6,
      expiresAt: dueExpiry,
    }),
    actor: { kind: "user", id: actorContext.userId },
    context: actorContext,
  });
  const promoted = await promote({
    service,
    persistence,
    context: actorContext,
    label: "ttl durable memory",
    input: candidateInput({
      subjectId: context.ids("ttl-durable-subject"),
      statement: "Ephemeral promoted characterization fact.",
      confidence: 0.8,
      expiresAt: dueExpiry,
    }),
  });

  const sweep = await retention.sweepExpired({ limit: 10 });
  const [pendingCandidate, promotedCandidate, durableMemory] = await Promise.all([
    persistence.getCandidate(pending.candidateId, actorContext.workspaceId),
    persistence.getCandidate(promoted.candidate.candidateId, actorContext.workspaceId),
    persistence.getMemory(promoted.memory.memoryId, actorContext.workspaceId),
  ]);
  const physicallyRemoved = pendingCandidate === null && promotedCandidate === null && durableMemory === null;
  assert.equal(physicallyRemoved, true, "TTL retention did not physically remove expired Memory records");
  assert.equal(sweep.deletedCandidateCount, 2);
  assert.equal(sweep.deletedMemoryCount, 1);

  return {
    result: "passed",
    errors: [],
    state: {
      expiredRecordKinds: ["pending_candidate", "promoted_candidate", "durable_memory"],
      retainedMemoryCount: 0,
      retentionClock: sweep.clock,
    },
    events: [{ sequence: 1, type: "memory.retention.ttl_cleanup", status: "completed" }],
    invariants: {
      ttlUsesPhysicalDeletion: true,
      expiredDurableContentAbsent: true,
      noApplicationReadFilterSubstitution: true,
      retentionUsesProductOwnedSweep: true,
    },
  };
}

async function fullTextRanking(rawContext) {
  const context = requireContext(rawContext);
  const actorContext = memoryContext(context);
  const baseTime = new Date(context.now);
  const recentAt = baseTime.toISOString();
  const oldAt = new Date(baseTime.getTime() - 30 * 86_400_000).toISOString();
  const { persistence, service, setTime } = await serviceFixture(context, "ranking", recentAt);
  const labels = new Map();

  async function add(label, subjectId, statement, confidence) {
    const record = await promote({
      service,
      persistence,
      context: actorContext,
      label,
      input: candidateInput({ subjectId, statement, confidence, tags: ["retrieval"] }),
    });
    labels.set(record.memory.memoryId, label);
    return record;
  }

  const confidenceSubject = context.ids("ranking-confidence-subject");
  setTime(recentAt);
  const confidenceHigh = await add("confidence-high", confidenceSubject, "Zephyrlattice recovery guidance.", 0.95);
  const confidenceLow = await add("confidence-low", confidenceSubject, "Zephyrlattice recovery guidance.", 0.55);
  await add("text-non-match", confidenceSubject, "Unrelated quarterly planning note.", 0.99);

  const recencySubject = context.ids("ranking-recency-subject");
  setTime(recentAt);
  const recencyRecent = await add("recency-recent", recencySubject, "Zephyrlattice incident checklist.", 0.75);
  setTime(oldAt);
  const recencyOld = await add("recency-old", recencySubject, "Zephyrlattice incident checklist.", 0.75);

  const tieSubject = context.ids("ranking-tie-subject");
  setTime(recentAt);
  const tieFirst = await add("tie-first", tieSubject, "Zephyrlattice stable ordering proof.", 0.8);
  const tieSecond = await add("tie-second", tieSubject, "Zephyrlattice stable ordering proof.", 0.8);

  const relevanceSubject = context.ids("ranking-relevance-subject");
  setTime(recentAt);
  await add(
    "relevance-high",
    relevanceSubject,
    "Zephyrlattice recovery guidance for recovery incidents.",
    0.8,
  );
  await add(
    "relevance-low",
    relevanceSubject,
    "Zephyrlattice quarterly planning note.",
    0.8,
  );

  async function ranked(subjectId, text = "zephyrlattice") {
    return service.query({
      query: {
        scopes: ["workspace"],
        subject: { kind: "workflow", subjectId },
        text,
        tags: [],
        limit: 10,
      },
      context: actorContext,
    });
  }

  setTime(recentAt);
  const confidenceResults = await ranked(confidenceSubject);
  const recencyResults = await ranked(recencySubject);
  const relevanceResults = await ranked(relevanceSubject, "zephyrlattice recovery");
  const tieOrders = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    tieOrders.push((await ranked(tieSubject)).map(({ memory }) => labels.get(memory.memoryId)));
  }
  const expectedTieOrder = [tieFirst, tieSecond]
    .sort((left, right) => left.memory.memoryId.localeCompare(right.memory.memoryId))
    .map(({ memory }) => labels.get(memory.memoryId));

  const confidenceOrder = confidenceResults.map(({ memory }) => labels.get(memory.memoryId));
  const recencyOrder = recencyResults.map(({ memory }) => labels.get(memory.memoryId));
  const relevanceOrder = relevanceResults.map(({ memory }) => labels.get(memory.memoryId));
  assert.deepEqual(confidenceOrder, ["confidence-high", "confidence-low"]);
  assert.deepEqual(recencyOrder, ["recency-recent", "recency-old"]);
  assert.deepEqual(relevanceOrder, ["relevance-high", "relevance-low"]);
  assert.equal(confidenceResults.every(({ matchedBy }) => matchedBy.includes("text")), true);
  assert.equal(tieOrders.every((order) => JSON.stringify(order) === JSON.stringify(expectedTieOrder)), true);

  return {
    result: "passed",
    errors: [],
    state: {
      confidenceOrder,
      recencyOrder,
      relevanceOrder,
      stableTieOrder: expectedTieOrder,
      textMatchCount: confidenceResults.length,
    },
    events: [{ sequence: 1, type: "memory.search.completed", status: "completed" }],
    invariants: {
      fullTextSearchApplied: true,
      nonMatchingTextExcluded: !confidenceOrder.includes("text-non-match"),
      confidenceContributesToRank: confidenceOrder[0] === "confidence-high",
      recencyContributesToRank: recencyOrder[0] === "recency-recent",
      textRelevanceContributesToRank: relevanceOrder[0] === "relevance-high",
      exactTiesUseMemoryIdentityAscending: true,
    },
  };
}

async function physicalDeleteTombstone(rawContext) {
  const context = requireContext(rawContext);
  const actorContext = memoryContext(context);
  const now = new Date(context.now).toISOString();
  const { persistence, service } = await serviceFixture(context, "delete", now);
  const rawContentSentinel = `private-memory-content-${context.ids("delete-sentinel")}`;
  const promoted = await promote({
    service,
    persistence,
    context: actorContext,
    label: "physical deletion",
    input: candidateInput({
      subjectId: context.ids("delete-subject"),
      statement: rawContentSentinel,
      confidence: 0.9,
    }),
  });

  const tombstone = await service.deleteMemory({
    memoryId: promoted.memory.memoryId,
    reason: "Characterization deletion request.",
    context: actorContext,
  });
  const reader = await context.openMemoryReader();
  const [deletedMemory, deletedCandidate, recoveredTombstone, remainingResults, memoryEvents,
    restartedMemory, crossWorkspaceMemory] = await Promise.all([
    persistence.getMemory(promoted.memory.memoryId, actorContext.workspaceId),
    persistence.getCandidate(promoted.candidate.candidateId, actorContext.workspaceId),
    service.recoverDeletion({ memoryId: promoted.memory.memoryId, context: actorContext }),
    service.query({
      query: {
        scopes: ["workspace"],
        subject: promoted.memory.subject,
        tags: [],
        limit: 10,
      },
      context: actorContext,
    }),
    persistence.listEvents({ workspaceId: actorContext.workspaceId, limit: 20 }),
    reader.persistence.getMemory(promoted.memory.memoryId, actorContext.workspaceId),
    reader.persistence.getMemory(promoted.memory.memoryId, `${actorContext.workspaceId}-other`),
  ]);

  const tombstonePayload = JSON.stringify(recoveredTombstone);
  const eventPayload = JSON.stringify(memoryEvents);
  assert.equal(deletedMemory, null);
  assert.equal(deletedCandidate, null, "deletion retained the original statement in its promoted Memory Candidate");
  assert.equal(restartedMemory, null, "deleted memory resurfaced after persistence restart");
  assert.equal(crossWorkspaceMemory, null, "known memory id crossed workspace boundary");
  assert.equal(remainingResults.length, 0);
  assert.equal(recoveredTombstone.tombstoneId, tombstone.tombstoneId);
  assert.match(recoveredTombstone.memoryIdHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(recoveredTombstone, "memoryId"), false);
  assert.equal(Object.hasOwn(recoveredTombstone, "statement"), false);
  assert.equal(tombstonePayload.includes(rawContentSentinel), false);
  assert.equal(eventPayload.includes(rawContentSentinel), false);

  return {
    result: "passed",
    errors: [],
    state: {
      durableMemoryCount: 0,
      sourceCandidateCount: 0,
      tombstoneCount: 1,
      deletionEventTypes: memoryEvents.map(({ type }) => type),
    },
    events: [{ sequence: 1, type: "memory.deleted", status: "completed" }],
    invariants: {
      durableOriginalPhysicallyAbsent: true,
      candidateOriginalPhysicallyAbsent: true,
      retrievalCannotReturnDeletedMemory: true,
      tombstoneUsesOnlyMemoryIdHash: true,
      tombstoneContainsNoOriginalContent: true,
      eventLedgerContainsNoOriginalContent: true,
      deleteSurvivesNewPersistenceReader: true,
      knownIdCannotCrossWorkspace: true,
    },
  };
}

export const scenarios = Object.freeze([
  { id: "retention.ttl-cleanup", run: retentionTtlCleanup },
  { id: "memory.full-text-ranking", run: fullTextRanking },
  { id: "memory.physical-delete-tombstone", run: physicalDeleteTombstone },
]);
