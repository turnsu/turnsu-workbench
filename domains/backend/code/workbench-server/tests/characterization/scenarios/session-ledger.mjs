import assert from "node:assert/strict";

const CREATED_AT = "2026-08-04T23:50:00.000Z";
const SNAPSHOT_AT = "2026-08-05T00:00:00.000Z";
const CLAIMED_AT = "2026-08-05T00:01:00.000Z";
const SETTLED_AT = "2026-08-05T00:02:00.000Z";

const requireContext = (context) => {
  assert.ok(context?.core?.ledger);
  assert.equal(typeof context?.createPeerCore, "function");
  assert.equal(typeof context?.principal?.workspaceId, "string");
  assert.equal(typeof context?.principal?.userId, "string");
  assert.equal(typeof context?.ids, "function");
  return context;
};

const sessionFixture = ({ sessionId, principal, taskStatus = "completed" }) => ({
  schemaVersion: "workbench-v1",
  sessionId,
  definitionId: "main",
  userId: principal.userId,
  workspaceId: principal.workspaceId,
  scope: { kind: "main" },
  title: "Session ledger characterization",
  source: { kind: "manual" },
  taskStatus,
  archived: false,
  status: "active",
  lastUsedModelProfileId: null,
  modelPreferenceState: "preference_only",
  activeTurnId: null,
  sessionEpoch: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

const turnFixture = ({ turnId, sessionId, message }) => ({
  schemaVersion: "workbench-v1",
  turnId,
  sessionId,
  sessionEpoch: 1,
  turnFence: 1,
  kind: "agent_message",
  status: "queued",
  modelRoutingState: "pinned",
  requestedModelRevisionId: "characterization-model-revision",
  actualModelRevisionId: null,
  artifactRefs: [],
  input: { message },
  result: null,
  queuedAt: CREATED_AT,
  startedAt: null,
  finishedAt: null,
  updatedAt: CREATED_AT,
});

const descendingStrings = (values) => [...values].sort((left, right) => (
  left === right ? 0 : left > right ? -1 : 1
));

const runKeysetAndEventResume = async (rawContext) => {
  const {
    core,
    principal,
    ids,
    createPeerCore,
  } = requireContext(rawContext);
  const firstPersistence = core.ledger;
  const resumedPersistence = (await createPeerCore({ clock: () => SNAPSHOT_AT })).ledger;

  const identityPrefix = ids("session-ledger-cursor");
  const sessionIds = [];
  for (let index = 0; index < 225; index += 1) {
    const sessionId = `${identityPrefix}-session-${String(index).padStart(3, "0")}`;
    sessionIds.push(sessionId);
    await firstPersistence.createSession(sessionFixture({ sessionId, principal }));
  }

  const sessionPageSizes = [];
  const observedSessionIds = [];
  let sessionCursor = null;
  let sessionPageNumber = 0;
  do {
    const persistence = sessionPageNumber < 2 ? firstPersistence : resumedPersistence;
    const page = await persistence.listSessions({
      taskStatus: "completed",
      archived: false,
      cursor: sessionCursor,
      limit: 37,
    }, principal);
    sessionPageSizes.push(page.length);
    observedSessionIds.push(...page.map((session) => session.sessionId));
    sessionCursor = page.page.nextCursor;
    sessionPageNumber += 1;
  } while (sessionCursor);

  assert.equal(observedSessionIds.length, 225);
  assert.equal(new Set(observedSessionIds).size, 225);
  assert.deepEqual(observedSessionIds, descendingStrings(sessionIds));
  assert.deepEqual(sessionPageSizes, [37, 37, 37, 37, 37, 37, 3]);

  const ledgerSessionId = sessionIds[0];
  for (let sequence = 1; sequence <= 225; sequence += 1) {
    await firstPersistence.appendEvent(ledgerSessionId, (allocatedSequence) => ({
      schemaVersion: "workbench-v1",
      eventId: `${identityPrefix}-event-${String(sequence).padStart(3, "0")}`,
      sessionId: ledgerSessionId,
      turnId: null,
      sequence: allocatedSequence,
      type: "turn.progress",
      status: "running",
      summary: `Progress ${sequence}`,
      occurredAt: CREATED_AT,
    }));
  }

  const eventPageSizes = [];
  const observedSequences = [];
  let eventCursor = null;
  let eventPageNumber = 0;
  let resumeAfterSequence = null;
  do {
    const persistence = eventPageNumber < 2 ? firstPersistence : resumedPersistence;
    const page = await persistence.listEvents(
      ledgerSessionId,
      { after: 0, cursor: eventCursor, limit: 41 },
      principal,
    );
    eventPageSizes.push(page.length);
    observedSequences.push(...page.map((event) => event.sequence));
    eventCursor = page.page.nextCursor;
    eventPageNumber += 1;
    if (eventPageNumber === 2) resumeAfterSequence = observedSequences.at(-1);
  } while (eventCursor);

  const expectedSequences = Array.from({ length: 225 }, (_, index) => index + 1);
  assert.deepEqual(observedSequences, expectedSequences);
  assert.equal(new Set(observedSequences).size, 225);
  assert.deepEqual(eventPageSizes, [41, 41, 41, 41, 41, 20]);
  assert.equal(resumeAfterSequence, 82);

  return {
    result: {
      status: "passed",
      sessionCount: observedSessionIds.length,
      eventCount: observedSequences.length,
    },
    errors: [],
    state: {
      sessionPageSizes,
      eventPageSizes,
      resumedAfterEventSequence: resumeAfterSequence,
      terminalEventSequence: observedSequences.at(-1),
    },
    events: [
      { sequence: 1, type: "session.cursor.exhausted", status: "completed" },
      { sequence: 2, type: "session.events.resumed", status: "completed" },
      { sequence: 3, type: "session.events.exhausted", status: "completed" },
    ],
    invariants: {
      sameTimestampSessionsUseStableIdentityTiebreak: true,
      sessionCursorHasNoGapOrDuplicate: true,
      eventCursorResumesOnAnotherStore: true,
      eventSequenceRemainsTotalAndContiguous: true,
    },
  };
};

const runFifoSingleClaim = async (rawContext) => {
  const {
    core,
    principal,
    ids,
    createPeerCore,
  } = requireContext(rawContext);
  const firstClaimer = core.ledger;
  const secondClaimer = (await createPeerCore({ clock: () => SNAPSHOT_AT })).ledger;
  const sessionId = ids("fifo-session");

  await firstClaimer.createSession(sessionFixture({
    sessionId,
    principal,
    taskStatus: "queued",
  }));
  const turnIds = [];
  for (let index = 1; index <= 3; index += 1) {
    const turnId = ids(`fifo-turn-${index}`);
    turnIds.push(turnId);
    await firstClaimer.createTurn(turnFixture({
      turnId,
      sessionId,
      message: `FIFO item ${index}`,
    }));
  }

  const concurrentClaims = await Promise.all([
    firstClaimer.claimNextTurn(sessionId, CLAIMED_AT),
    secondClaimer.claimNextTurn(sessionId, CLAIMED_AT),
  ]);
  const successfulClaims = concurrentClaims.filter(Boolean);
  assert.equal(successfulClaims.length, 1);
  assert.equal(successfulClaims[0].sequence, 1);

  const claimedTurn = successfulClaims[0];
  await firstClaimer.settleTurn({
    sessionId,
    turnId: claimedTurn.turnId,
    sessionEpoch: claimedTurn.sessionEpoch,
    turnFence: claimedTurn.turnFence,
    status: "completed",
    result: {
      kind: "agent_message",
      response: "FIFO head completed.",
      proposalId: null,
      handoffId: null,
      invocationIds: [],
      requestedModelRevisionId: claimedTurn.requestedModelRevisionId,
      actualModelRevisionId: claimedTurn.requestedModelRevisionId,
      artifactRefs: [],
    },
    finishedAt: SETTLED_AT,
    routing: {
      actualModelRevisionId: claimedTurn.requestedModelRevisionId,
      artifactRefs: [],
    },
    message: {
      schemaVersion: "workbench-v1",
      messageId: ids("fifo-terminal-message"),
      sessionId,
      turnId: claimedTurn.turnId,
      role: "assistant",
      kind: "result",
      content: "FIFO head completed.",
      createdAt: SETTLED_AT,
    },
    event: {
      schemaVersion: "workbench-v1",
      eventId: ids("fifo-terminal-event"),
      sessionId,
      turnId: claimedTurn.turnId,
      type: "turn.completed",
      status: "completed",
      summary: "FIFO head completed.",
      occurredAt: SETTLED_AT,
    },
  });

  const nextClaimer = concurrentClaims[0] ? secondClaimer : firstClaimer;
  const nextClaim = await nextClaimer.claimNextTurn(sessionId, SETTLED_AT);
  assert.equal(nextClaim?.sequence, 2);

  const turns = await firstClaimer.listTurns(
    sessionId,
    { after: 0, limit: 10 },
    principal,
  );
  assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2, 3]);
  assert.deepEqual(turns.map((turn) => turn.status), ["completed", "running", "queued"]);
  assert.deepEqual(turns.map((turn) => turn.turnId), turnIds);

  return {
    result: {
      status: "passed",
      concurrentClaimers: concurrentClaims.length,
      successfulClaims: successfulClaims.length,
    },
    errors: [],
    state: {
      orderedTurnStates: turns.map((turn) => turn.status),
      firstClaimedSequence: claimedTurn.sequence,
      secondClaimedSequence: nextClaim.sequence,
    },
    events: [
      { sequence: 1, type: "session.turn.claimed", status: "running" },
      { sequence: 2, type: "session.turn.completed", status: "completed" },
      { sequence: 3, type: "session.turn.claimed", status: "running" },
    ],
    invariants: {
      twoClaimersObtainOneFifoHead: true,
      activeTurnBlocksParallelSessionClaim: true,
      nextClaimAdvancesOnlyAfterHeadSettles: true,
      queuedTurnOrderIsPreserved: true,
    },
  };
};

export const scenarios = [
  { id: "cursor.keyset-and-event-resume", run: runKeysetAndEventResume },
  { id: "queue.fifo-single-claim", run: runFifoSingleClaim },
];
