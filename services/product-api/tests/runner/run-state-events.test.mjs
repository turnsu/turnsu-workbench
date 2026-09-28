import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialRunStateEvent,
  createLegacyImportEvent,
  createRunStateTransitionEvent,
  foldRunStateEvents,
  runProjectionMatchesFold,
  sourceHashForLegacyRun,
} from "../../src/runner/run-state-events.mjs";

const NOW = "2026-08-01T00:00:00.000Z";

function queuedRun(overrides = {}) {
  return {
    schemaVersion: "workbench-v1",
    runId: "run-state-test",
    workspaceId: "workspace-state-test",
    requestedBy: "user-state-test",
    workflowId: "workflow-state-test",
    workflowRevisionId: "workflow-revision-state-test",
    status: "queued",
    currentNodeId: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
    queuedAt: NOW,
    stateModelVersion: 2,
    stateEventSequence: 1,
    creationCommandId: "command-create",
    executionSnapshot: {
      workspaceId: "workspace-snapshot-copy",
      requestedBy: "user-snapshot-copy",
      graph: { nodes: [], edges: [] },
      plan: { steps: [] },
      skillVersions: [],
    },
    ...structuredClone(overrides),
  };
}

test("Run state genesis carries the immutable execution base and folds deterministically", () => {
  const run = queuedRun();
  const genesis = createInitialRunStateEvent({
    run,
    eventId: "event-genesis",
    commandId: run.creationCommandId,
    occurredAt: NOW,
  });
  run.stateHash = genesis.stateHash;
  const startedAt = "2026-08-01T00:00:01.000Z";
  const started = createRunStateTransitionEvent({
    run,
    patch: { status: "running", startedAt, updatedAt: startedAt },
    eventId: "event-started",
    commandId: "command-start",
    occurredAt: startedAt,
  });
  const folded = foldRunStateEvents([genesis, started], { expectedRunId: run.runId });

  assert.equal(genesis.workspaceId, "workspace-state-test");
  assert.equal(Object.hasOwn(folded.base, "workspaceId"), false);
  assert.equal(Object.hasOwn(folded.base, "requestedBy"), false);
  assert.equal(Object.hasOwn(folded.base.executionSnapshot, "workspaceId"), false);
  assert.equal(Object.hasOwn(folded.base.executionSnapshot, "requestedBy"), false);
  assert.equal(folded.base.status, undefined);
  assert.deepEqual(folded.state, {
    status: "running",
    currentNodeId: null,
    startedAt,
    finishedAt: null,
    updatedAt: startedAt,
  });
  assert.equal(runProjectionMatchesFold({
    ...run,
    ...folded.state,
    stateEventSequence: folded.sequence,
    stateHash: folded.stateHash,
  }, folded), true);

  const fromSnapshot = foldRunStateEvents([], {
    expectedRunId: run.runId,
    snapshot: {
      schemaVersion: "workbench-run-state-snapshot-v2",
      runId: run.runId,
      sequence: folded.sequence,
      stateHash: folded.stateHash,
      state: folded.state,
      base: folded.base,
    },
  });
  assert.deepEqual(fromSnapshot, folded);
});

test("Run state reducer rejects an illegal terminal-to-running transition", () => {
  const run = queuedRun({
    status: "completed",
    startedAt: "2026-08-01T00:00:01.000Z",
    finishedAt: "2026-08-01T00:00:02.000Z",
    updatedAt: "2026-08-01T00:00:02.000Z",
    stateEventSequence: 2,
  });
  const imported = createLegacyImportEvent({
    run,
    eventId: "event-completed-import",
    commandId: "command-import",
    occurredAt: run.updatedAt,
  });
  run.stateHash = imported.stateHash;
  assert.throws(
    () => createRunStateTransitionEvent({
      run,
      patch: { status: "running", finishedAt: null, updatedAt: "2026-08-01T00:00:03.000Z" },
      eventId: "event-illegal",
      commandId: "command-illegal",
      occurredAt: "2026-08-01T00:00:03.000Z",
    }),
    (error) => error?.code === "run_state_transition_invalid",
  );
});

test("Run state fold fails closed for a broken prior hash or missing immutable base", () => {
  const run = queuedRun();
  const genesis = createInitialRunStateEvent({
    run,
    eventId: "event-genesis-corrupt",
    commandId: run.creationCommandId,
    occurredAt: NOW,
  });
  assert.throws(
    () => foldRunStateEvents([{ ...genesis, priorStateHash: "sha256:corrupt" }], { expectedRunId: run.runId }),
    (error) => error?.code === "run_state_event_chain_invalid",
  );
  assert.throws(
    () => foldRunStateEvents([{ ...genesis, payload: { state: genesis.payload.state } }], { expectedRunId: run.runId }),
    (error) => error?.code === "run_state_event_chain_invalid",
  );
});

test("Legacy import source hash covers immutable execution identity and lifecycle", () => {
  const run = queuedRun({ stateModelVersion: undefined, stateEventSequence: undefined });
  const initialHash = sourceHashForLegacyRun(run);
  assert.equal(initialHash, sourceHashForLegacyRun({
    ...run,
    requestedBy: "another-user",
  }));
  assert.equal(initialHash, sourceHashForLegacyRun({
    ...run,
    workspaceId: "another-workspace",
  }));
  assert.notEqual(initialHash, sourceHashForLegacyRun({
    ...run,
    status: "running",
    startedAt: "2026-08-01T00:00:01.000Z",
    updatedAt: "2026-08-01T00:00:01.000Z",
  }));
});
