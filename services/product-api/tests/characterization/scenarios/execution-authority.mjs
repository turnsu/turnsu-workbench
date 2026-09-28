import assert from "node:assert/strict";

const WORKBENCH_SCHEMA_VERSION = "workbench-v1";
const RUN_EVENT_SCHEMA_VERSION = "workbench-run-event-v1";

function requireContext(context) {
  assert.equal(typeof context?.adapter, "string");
  assert.equal(typeof context?.core?.runControl?.appendRunEvent, "function");
  assert.equal(typeof context?.core?.runControl?.claimRunJob, "function");
  assert.equal(typeof context?.core?.runControl?.acquireLease, "function");
  assert.equal(typeof context?.principal?.workspaceId, "string");
  assert.equal(typeof context?.principal?.userId, "string");
  assert.equal(typeof context?.ids, "function");
  assert.equal(typeof context?.createLeaseCoordinator, "function");
  assert.equal(typeof context?.now, "string");
  return context;
}

async function runLeaseFenceTakeover(rawContext) {
  const { core, principal, ids, now, createLeaseCoordinator } = requireContext(rawContext);
  const runId = ids("lease-run");
  const runJobId = ids("lease-job");
  const firstWorkerId = ids("first-worker");
  const takeoverWorkerId = ids("takeover-worker");
  const firstExpiry = addMilliseconds(now, 1_000);
  const takeoverAt = addMilliseconds(firstExpiry, 1);
  const takeoverExpiry = addMilliseconds(takeoverAt, 1_000);
  const finishedAt = addMilliseconds(takeoverAt, 100);
  const { runControl } = core;

  await runControl.createRunJob({
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    runJobId,
    runId,
    workspaceId: principal.workspaceId,
    status: "queued",
    fence: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    checkpointSequence: 0,
    queuedAt: now,
    updatedAt: now,
  });

  const firstClaim = await createLeaseCoordinator({
    runControl,
    workerId: firstWorkerId,
    now,
  }).claim(runId);
  assert.equal(firstClaim?.fence, 1);
  assert.equal(firstClaim?.leaseOwner, firstWorkerId);
  const firstLease = await runControl.acquireLease(leaseRecord({
    runId,
    runJobId,
    workspaceId: principal.workspaceId,
    workerId: firstWorkerId,
    fence: firstClaim.fence,
    acquiredAt: now,
    expiresAt: firstExpiry,
  }));
  assert.equal(firstLease?.status, "active");

  const takeoverClaim = await runControl.claimRunJob(runId, {
    workerId: takeoverWorkerId,
    now: takeoverAt,
    leaseExpiresAt: takeoverExpiry,
  });
  assert.equal(takeoverClaim?.fence, 2);
  assert.equal(takeoverClaim?.leaseOwner, takeoverWorkerId);
  const takeoverLease = await runControl.acquireLease(leaseRecord({
    runId,
    runJobId,
    workspaceId: principal.workspaceId,
    workerId: takeoverWorkerId,
    fence: takeoverClaim.fence,
    acquiredAt: takeoverAt,
    expiresAt: takeoverExpiry,
  }));
  assert.equal(takeoverLease?.workerId, takeoverWorkerId);
  assert.equal(takeoverLease?.fence, 2);

  const staleJobWrite = await runControl.assertActiveFence(runId, {
    workerId: firstWorkerId,
    fence: firstClaim.fence,
    now: takeoverAt,
  });
  const staleLeaseHeartbeat = await runControl.heartbeatLease(runId, {
    workerId: firstWorkerId,
    fence: firstClaim.fence,
    heartbeatAt: takeoverAt,
    expiresAt: takeoverExpiry,
  });
  const staleFinish = await runControl.finishRunJob(runId, {
    workerId: firstWorkerId,
    fence: firstClaim.fence,
    status: "completed",
    now: finishedAt,
  });
  assert.equal(staleJobWrite, null);
  assert.equal(staleLeaseHeartbeat, null);
  assert.equal(staleFinish, null);

  const liveFence = await runControl.assertActiveFence(runId, {
    workerId: takeoverWorkerId,
    fence: takeoverClaim.fence,
    now: takeoverAt,
  });
  assert.equal(liveFence?.fence, takeoverClaim.fence);
  const completedJob = await runControl.finishRunJob(runId, {
    workerId: takeoverWorkerId,
    fence: takeoverClaim.fence,
    status: "completed",
    now: finishedAt,
  });
  const releasedLease = await runControl.releaseLease(runId, {
    workerId: takeoverWorkerId,
    fence: takeoverClaim.fence,
    releasedAt: finishedAt,
  });
  const durableJob = await runControl.getRunJob(runId);
  assert.equal(completedJob?.status, "completed");
  assert.equal(durableJob?.status, "completed");
  assert.equal(durableJob?.leaseOwner, null);
  assert.equal(releasedLease?.status, "released");
  assert.equal(releasedLease?.fence, takeoverClaim.fence);

  return {
    result: {
      status: "passed",
      takeoverFence: takeoverClaim.fence,
      staleWritesAccepted: 0,
    },
    errors: [],
    state: {
      firstClaim: { status: firstClaim.status, fence: firstClaim.fence },
      takeoverClaim: { status: takeoverClaim.status, fence: takeoverClaim.fence },
      terminal: {
        jobStatus: durableJob.status,
        leaseStatus: releasedLease.status,
        fence: releasedLease.fence,
        ownerCleared: durableJob.leaseOwner === null,
      },
    },
    events: [
      { sequence: 1, type: "lease.claimed", status: "active" },
      { sequence: 2, type: "lease.taken_over", status: "active" },
      { sequence: 3, type: "stale_write.rejected", status: "rejected" },
      { sequence: 4, type: "run.completed", status: "completed" },
    ],
    invariants: {
      takeoverAdvancesMonotonicFence: takeoverClaim.fence === firstClaim.fence + 1,
      staleJobWriteIsRejected: staleJobWrite === null && staleFinish === null,
      staleLeaseHeartbeatIsRejected: staleLeaseHeartbeat === null,
      onlyCurrentFenceCanCommitTerminalState: durableJob.status === "completed",
      terminalStateReleasesActiveLease: releasedLease.status === "released",
    },
  };
}

async function runConcurrentEventOrder(rawContext) {
  const { core, principal, ids, now } = requireContext(rawContext);
  const runId = ids("event-run");
  const eventCount = 12;

  await core.runControl.createRun({
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    runId,
    workspaceId: principal.workspaceId,
    workflowId: ids("event-workflow"),
    workflowRevisionId: ids("event-revision"),
    status: "running",
    requestedBy: principal.userId,
    createdAt: now,
    updatedAt: now,
  });

  const appended = await Promise.all(Array.from({ length: eventCount }, (_, index) => (
    core.runControl.appendRunEvent({
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      eventId: ids(`event-${index + 1}`),
      type: "node.progress",
      runId,
      status: "running",
      summary: "Concurrent product progress persisted.",
      occurredAt: now,
    })
  )));
  const events = await core.runControl.listRunEvents(runId);
  const run = await core.runControl.getRun(runId);
  const sequences = events.map((event) => event.sequence);
  const eventIds = events.map((event) => event.eventId);

  assert.equal(appended.length, eventCount);
  assert.equal(events.length, eventCount);
  assert.deepEqual(sequences, contiguous(eventCount));
  assert.equal(new Set(eventIds).size, eventCount);
  assert.equal(new Set(appended.map((event) => event.sequence)).size, eventCount);

  return {
    result: {
      status: "passed",
      concurrentAppends: eventCount,
      durableEvents: events.length,
    },
    errors: [],
    state: {
      runStatus: run.status,
      eventSequence: events.length,
      firstSequence: sequences[0],
      lastSequence: sequences.at(-1),
    },
    events: events.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      status: event.status,
    })),
    invariants: {
      concurrentEventsReceiveOneTotalOrder: true,
      eventSequenceIsContiguous: true,
      eventIdentityIsUnique: true,
      allConcurrentAppendsAreDurable: appended.length === events.length,
    },
  };
}

function leaseRecord({ runId, runJobId, workspaceId, workerId, fence, acquiredAt, expiresAt }) {
  return {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    runId,
    runJobId,
    workspaceId,
    workerId,
    fence,
    status: "active",
    acquiredAt,
    heartbeatAt: acquiredAt,
    expiresAt,
    releasedAt: null,
    updatedAt: acquiredAt,
  };
}

function addMilliseconds(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function contiguous(count) {
  return Array.from({ length: count }, (_, index) => index + 1);
}

export const scenarios = [
  { id: "execution.lease-fence-takeover", run: runLeaseFenceTakeover },
  { id: "events.concurrent-total-order", run: runConcurrentEventOrder },
];
