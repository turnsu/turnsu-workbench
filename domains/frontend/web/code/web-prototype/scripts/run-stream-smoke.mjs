import assert from "node:assert/strict";

import {
  createRunStreamState,
  reduceRunEvents,
  runEventReceived,
  runReadModelRefreshed,
  runStreamConnected,
  runStreamConnectionStarted,
  runStreamDisconnected,
  runStreamReducer,
  selectRunEventCursor,
  selectRunStream,
} from "../src/state/run-stream/index.js";

const RUN_A = "run-a";
const RUN_B = "run-b";

let state = createRunStreamState();
assert.deepEqual(state, { byRunId: {} });

state = runStreamReducer(state, runStreamConnectionStarted(RUN_A));
assert.equal(selectRunStream(state, RUN_A).connection.status, "connecting");
state = runStreamReducer(state, runStreamConnected(RUN_A));
assert.equal(selectRunStream(state, RUN_A).connection.status, "connected");

state = reduceRunEvents(state, [
  event(1, "run.queued", { status: "queued" }),
  event(2, "run.started", { status: "running" }),
  event(3, "node.started", { nodeId: "node-skill", status: "running" }),
  event(4, "node.progress", { nodeId: "node-skill", status: "running", summary: "Halfway done." }),
  event(5, "node.completed", { nodeId: "node-skill", status: "completed" }),
]);

let runA = selectRunStream(state, RUN_A);
assert.equal(runA.status, "running", "node.completed must not mark the whole run completed");
assert.equal(runA.lastSequence, 5);
assert.equal(selectRunEventCursor(state, RUN_A), 5);
assert.deepEqual(runA.nodes["node-skill"], {
  nodeId: "node-skill",
  status: "completed",
  summary: "node.completed 5",
  occurredAt: "2026-07-10T10:00:05.000Z",
  lastSequence: 5,
});

const beforeDuplicate = state;
state = runStreamReducer(state, runEventReceived(event(5, "node.completed", { nodeId: "node-skill", status: "completed" })));
assert.equal(state, beforeDuplicate, "same sequence must be ignored without allocating new state");

state = runStreamReducer(state, runEventReceived(event(6, "node.failed", {
  eventId: "event-5",
  nodeId: "node-skill",
  status: "failed",
})));
assert.equal(state, beforeDuplicate, "same eventId must be ignored even when its sequence changes");

state = runStreamReducer(state, runEventReceived(event(4, "node.failed", {
  eventId: "event-late",
  nodeId: "node-skill",
  status: "failed",
})));
assert.equal(state, beforeDuplicate, "an out-of-order sequence must not roll state back");

state = runStreamReducer(state, runEventReceived(event(7, "review.requested", {
  nodeId: "node-review",
  status: "waiting_review",
  summary: "Please review the draft.",
})));
runA = selectRunStream(state, RUN_A);
assert.equal(runA.status, "waiting_review");
assert.deepEqual(runA.pendingReview, {
  nodeId: "node-review",
  summary: "Please review the draft.",
  occurredAt: "2026-07-10T10:00:07.000Z",
  sequence: 7,
});
assert.equal(runA.readModelRefreshRequired, true);

state = runStreamReducer(state, runReadModelRefreshed(RUN_A));
assert.equal(selectRunStream(state, RUN_A).readModelRefreshRequired, false);

state = runStreamReducer(state, runEventReceived(event(8, "run.paused", { status: "paused" })));
runA = selectRunStream(state, RUN_A);
assert.equal(runA.status, "paused");
assert.equal(runA.pendingReview, null, "the pending review clears after a decision pauses the run");

state = runStreamReducer(state, runEventReceived(event(9, "node.started", {
  nodeId: "node-output",
  status: "running",
})));
runA = selectRunStream(state, RUN_A);
assert.equal(runA.status, "running", "a node event resumes the projection after review approval");
assert.equal(runA.currentNodeId, "node-output");

state = runStreamReducer(state, runStreamDisconnected(RUN_A, {
  reason: "network_lost",
  retryable: true,
}));
runA = selectRunStream(state, RUN_A);
assert.deepEqual(runA.connection, {
  status: "disconnected",
  reason: "network_lost",
  retryable: true,
});
assert.equal(runA.lastSequence, 9, "disconnects must preserve the resume cursor");

state = runStreamReducer(state, runEventReceived(event(10, "run.completed", {
  status: "completed",
  summary: "Run completed; fetch the result detail.",
})));
runA = selectRunStream(state, RUN_A);
assert.equal(runA.status, "completed");
assert.equal(runA.readModelRefreshRequired, true);
assert.deepEqual(runA.terminal, {
  type: "run.completed",
  status: "completed",
  summary: "Run completed; fetch the result detail.",
  occurredAt: "2026-07-10T10:00:10.000Z",
  sequence: 10,
});
assert.equal("finalAnswer" in runA, false, "SSE state must never construct the authoritative final answer");
assert.equal("readModel" in runA, false, "RunReadModel belongs to server state, not the event reducer");

state = runStreamReducer(state, runEventReceived(event(1, "run.queued", {
  runId: RUN_B,
  eventId: "event-b-1",
  status: "queued",
})));
assert.equal(selectRunStream(state, RUN_A).status, "completed");
assert.equal(selectRunStream(state, RUN_B).status, "queued");
assert.equal(selectRunEventCursor(state, RUN_B), 1);

const failedState = reduceRunEvents(createRunStreamState(), [
  event(1, "run.started", { status: "running" }),
  event(2, "node.failed", { nodeId: "node-skill", status: "failed" }),
  event(3, "run.failed", { status: "failed", summary: "The run could not finish." }),
]);
assert.equal(selectRunStream(failedState, RUN_A).status, "failed");
assert.equal(selectRunStream(failedState, RUN_A).nodes["node-skill"].status, "failed");
assert.equal(selectRunStream(failedState, RUN_A).terminal.type, "run.failed");

const cancelledState = reduceRunEvents(createRunStreamState(), [
  event(1, "run.started", { status: "running" }),
  event(2, "run.cancelled", { status: "cancelled" }),
]);
assert.equal(selectRunStream(cancelledState, RUN_A).status, "cancelled");
assert.equal(selectRunStream(cancelledState, RUN_A).terminal.type, "run.cancelled");

assert.equal(selectRunStream(state, "missing-run"), null);
assert.equal(selectRunEventCursor(state, "missing-run"), 0);

console.log("run-stream smoke passed");

function event(sequence, type, overrides = {}) {
  const runId = overrides.runId ?? RUN_A;
  return {
    schemaVersion: "workbench-run-event-v1",
    sequence,
    eventId: overrides.eventId ?? `event-${sequence}`,
    type,
    runId,
    workflowId: "workflow-a",
    workflowRevisionId: "revision-a-1",
    ...(overrides.nodeId ? { nodeId: overrides.nodeId } : {}),
    status: overrides.status ?? "running",
    summary: overrides.summary ?? `${type} ${sequence}`,
    occurredAt: `2026-07-10T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}
