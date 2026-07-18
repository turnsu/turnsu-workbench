import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  Errors,
  ExecutionRequestSchema,
  ImageGenerationResultSchema,
} from "@looloomi/workbench-contracts";

import {
  createWorkflowRunner,
  WorkflowRunnerError,
} from "../../src/runner/index.mjs";

const NOW = "2026-07-10T10:00:00.000Z";

test("WorkflowRunner persists review continuation, attempts, event order, and authoritative final", async () => {
  const fixture = createFixture();
  const run = await fixture.runner.startRun(startRequest("idem-approve"));
  assert.equal(run.status, "queued");
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");

  const waiting = await fixture.runner.getRun(run.runId);
  assert.equal(waiting.readModel.reviewPacket.nodeId, "node-review");
  assert.equal(waiting.readModel.finalAnswer, null);
  assert.equal(Object.hasOwn(waiting.readModel, "session"), false);
  assertProductSafe(waiting);
  let terminalPublishedOutsideTransaction = false;
  const unsubscribe = fixture.runner.subscribe(run.runId, (event) => {
    if (event.type === "run.completed") terminalPublishedOutsideTransaction = !fixture.store.inTransaction;
  });

  const approval = await fixture.runner.submitReviewDecision({
    runId: run.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "decision-approve",
    decidedBy: "user-local",
  });
  assert.equal(approval.decision.decision, "approve");
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "completed");
  unsubscribe();

  const completed = await fixture.runner.getRun(run.runId);
  assert.equal(completed.readModel.finalAnswer.content, "Draft 1: product-safe workflow");
  assert.equal(completed.run.authoritativeReadModel.available, true);
  assert.equal(completed.readModel.status, "completed");
  const internalCompleted = await fixture.store.repositories.runs.getInternal(completed.run.runId);
  assert.equal(internalCompleted.agentFinalReadModel.schemaVersion, "agent-final-read-model-v1");
  assert.equal(internalCompleted.agentFinalReadModel.finalText, completed.readModel.finalAnswer.content);
  assert.equal(Object.hasOwn(completed.run, "agentFinalReadModel"), false);
  const events = await fixture.runner.listEvents(run.runId, 0);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(fixture.store.terminalReadModelsBeforeEvents, true);
  assert.equal(terminalPublishedOutsideTransaction, true);
  assertTerminalTransaction(fixture.store);
  assertProductSafe(completed);
});

test("WorkflowRunner persists one queued RunJob with the Run", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  const run = await fixture.runner.startRun(startRequest("idem-durable-job"));
  assert.deepEqual(fixture.store.jobLog, [{
    runId: run.runId,
    workspaceId: "workspace-local",
    status: "queued",
    fence: 0,
  }]);
});

test("WorkflowRunner recovers a queued Run from its durable job", async () => {
  const initial = createFixture({ scheduleOnStart: false });
  const run = await initial.runner.startRun(startRequest("idem-recover-queued"));
  assert.equal((await initial.runner.getRun(run.runId)).run.status, "queued");

  const restarted = createFixture({ store: initial.store, ids: initial.ids });
  const recovery = await restarted.runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, [run.runId]);
  await waitFor(async () => (await restarted.runner.getRun(run.runId)).run.status === "waiting_review");
});

test("two recovering workers lease one queued Run exactly once", async () => {
  const initial = createFixture({ scheduleOnStart: false });
  const run = await initial.runner.startRun(startRequest("idem-lease-race"));
  const workerA = createFixture({ store: initial.store, ids: initial.ids, workerId: "worker-a", invocationDelayMs: 30 });
  const workerB = createFixture({ store: initial.store, ids: initial.ids, workerId: "worker-b", invocationDelayMs: 30 });

  const results = await Promise.all([workerA.runner.recover(), workerB.runner.recover()]);
  await waitFor(async () => (await workerA.runner.getRun(run.runId)).run.status === "waiting_review");

  assert.equal(results.flatMap((result) => result.recoveredRunIds).length, 1);
  assert.equal(workerA.invocationInputs.length + workerB.invocationInputs.length, 1);
  assert.equal(initial.store.jobLog[0].fence, 1);
  assert.deepEqual(initial.store.leaseLog.map((lease) => ({ runId: lease.runId, fence: lease.fence, status: lease.status })), [
    { runId: run.runId, fence: 1, status: "released" },
  ]);
});

test("WorkflowRunner does not execute when the durable lease projection rejects its claim", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  fixture.store.rejectNextLeaseAcquire();
  const run = await fixture.runner.startRun(startRequest("idem-lease-projection-rejected"));

  const recovery = await fixture.runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, []);
  assert.equal(fixture.invocationInputs.length, 0);
  assert.equal((await fixture.runner.getRun(run.runId)).run.status, "queued");
  assert.equal(fixture.store.jobLog[0].status, "queued");
  assert.equal(fixture.store.jobLog[0].fence, 1);
});

test("WorkflowRunner checkpoints every durable node boundary with a monotonic sequence", async () => {
  const fixture = createFixture();
  const run = await fixture.runner.startRun(startRequest("idem-checkpoints"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
  assert.deepEqual(fixture.store.checkpointLog.map((checkpoint) => checkpoint.state.status), [
    "completed",
    "completed",
    "waiting_review",
  ]);

  await fixture.runner.submitReviewDecision({
    runId: run.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "decision-checkpoints",
    decidedBy: "user-local",
  });
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "completed");
  assert.deepEqual(fixture.store.checkpointLog.map((checkpoint) => checkpoint.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(fixture.store.checkpointLog.map((checkpoint) => checkpoint.state.nodeId), [
    "node-input",
    "node-skill",
    "node-review",
    "node-review",
    "node-output",
    undefined,
  ]);
});

test("expired stale worker cannot invoke or write after a higher fence claims its prepared invocation", async () => {
  let signalFaultReached;
  const faultReached = new Promise((resolve) => { signalFaultReached = resolve; });
  let resumeFault;
  const blocked = new Promise((resolve) => { resumeFault = resolve; });
  const initial = createFixture({ scheduleOnStart: false });
  const run = await initial.runner.startRun(startRequest("idem-stale-fence"));
  const workerA = createFixture({
    store: initial.store,
    ids: initial.ids,
    workerId: "worker-stale",
    faultInjector: async (boundary) => {
      if (boundary !== "post-attempt-invocation-persistence") return;
      signalFaultReached();
      await blocked;
    },
  });
  const workerARecovery = workerA.runner.recover();
  await faultReached;
  initial.store.expireLease(run.runId);

  const workerB = createFixture({ store: initial.store, ids: initial.ids, workerId: "worker-current" });
  assert.deepEqual((await workerB.runner.recover()).recoveredRunIds, [run.runId]);
  await waitFor(async () => (await workerB.runner.getRun(run.runId)).run.status === "failed");
  resumeFault();
  await waitFor(() => initial.store.jobLog.find((entry) => entry.runId === run.runId)?.status === "failed");

  const detail = await workerB.runner.getRun(run.runId);
  const terminalEvents = (await workerB.runner.listEvents(run.runId)).filter((event) => event.type === "run.failed");
  assert.equal(detail.readModel.failure.code, "side_effect_outcome_unknown");
  assert.equal(workerA.invocationInputs.length + workerB.invocationInputs.length, 0);
  assert.equal(terminalEvents.length, 1);
  assert.equal(initial.store.jobLog[0].fence, 2);
  assert.deepEqual((await workerB.runner.recover()).recoveredRunIds, []);
  await workerARecovery;
});

test("WorkflowRunner renews its durable lease while a Skill invocation is still running", async () => {
  const fixture = createFixture({ invocationDelayMs: 1_100, leaseDurationMs: 1_000 });
  const run = await fixture.runner.startRun(startRequest("idem-lease-heartbeat"));

  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review", 3_000);

  assert.ok(fixture.store.heartbeatLog.length >= 2);
  assert.equal(fixture.store.jobLog[0].status, "paused");
});

test("startup recovery takes over an expired running lease with a higher fence", async () => {
  const initial = createFixture({ scheduleOnStart: false });
  const run = await initial.runner.startRun(startRequest("idem-expired-lease"));
  initial.store.simulateExpiredRun(run.runId, {
    workerId: "dead-worker",
    fence: 1,
    leaseExpiresAt: "2026-07-10T09:59:00.000Z",
  });

  const restarted = createFixture({ store: initial.store, ids: initial.ids, workerId: "recovery-worker" });
  const recovery = await restarted.runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, [run.runId]);
  await waitFor(async () => (await restarted.runner.getRun(run.runId)).run.status === "waiting_review");
  assert.equal(initial.store.jobLog[0].fence, 2);
  assert.equal(restarted.invocationInputs.length, 1);
});

test("startup recovery continues a persisted review decision left paused by a crash", async () => {
  const initial = createFixture();
  const run = await initial.runner.startRun(startRequest("idem-paused-review"));
  await waitFor(async () => (await initial.runner.getRun(run.runId)).run.status === "waiting_review");
  initial.store.simulatePausedReview(run.runId, {
    schemaVersion: "workbench-v1",
    decisionId: "review-crash-1",
    runId: run.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    decidedBy: "user-local",
    decidedAt: NOW,
    idempotencyKey: "decision-crash-1",
    createdAt: NOW,
    updatedAt: NOW,
  });

  const restarted = createFixture({ store: initial.store, ids: initial.ids, workerId: "review-recovery" });
  const recovery = await restarted.runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, [run.runId]);
  await waitFor(async () => (await restarted.runner.getRun(run.runId)).run.status === "completed");
});

test("startup recovery reconstructs a missing completed projection and event from Run authority", async () => {
  const initial = createFixture();
  const run = await initial.runner.startRun(startRequest("idem-terminal-missing"));
  await waitFor(async () => (await initial.runner.getRun(run.runId)).run.status === "waiting_review");
  await initial.runner.submitReviewDecision({
    runId: run.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "decision-terminal-missing",
    decidedBy: "user-local",
  });
  await waitFor(async () => (await initial.runner.getRun(run.runId)).run.status === "completed");
  const completedFence = initial.store.jobLog.find((job) => job.runId === run.runId).fence;
  initial.store.simulateTerminalRecovery(run.runId, {
    readModel: null,
    removeTerminalEvent: true,
    tamperedFinalOutput: "browser recomputation must not win",
  });

  const restarted = createFixture({ store: initial.store, ids: initial.ids, workerId: "terminal-recovery" });
  const recovery = await restarted.runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, [run.runId]);
  await waitFor(() => initial.store.jobLog.find((job) => job.runId === run.runId)?.status === "completed");

  const recovered = await restarted.runner.getRun(run.runId);
  const terminalEvents = (await restarted.runner.listEvents(run.runId)).filter((event) => event.type === "run.completed");
  assert.equal(recovered.readModel.finalAnswer.content, "Draft 1: product-safe workflow");
  assert.equal(initial.invocationInputs.length, 1);
  assert.equal(restarted.invocationInputs.length, 0);
  assert.equal(terminalEvents.length, 1);
  assert.equal(initial.store.jobLog.find((job) => job.runId === run.runId).fence, completedFence + 1);
  assert.equal(initial.store.leaseLog.find((lease) => lease.runId === run.runId).status, "released");
});

test("startup recovery repairs a stale terminal projection without duplicating the terminal event", async () => {
  const initial = createFixture();
  const run = await initial.runner.startRun(startRequest("idem-terminal-stale"));
  await waitFor(async () => (await initial.runner.getRun(run.runId)).run.status === "waiting_review");
  await initial.runner.submitReviewDecision({
    runId: run.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "decision-terminal-stale",
    decidedBy: "user-local",
  });
  await waitFor(async () => (await initial.runner.getRun(run.runId)).run.status === "completed");
  const stale = await initial.store.repositories.runReadModels.get(run.runId);
  initial.store.simulateTerminalRecovery(run.runId, {
    readModel: {
      ...stale,
      status: "running",
      currentNodeId: "node-output",
      finalAnswer: { ...stale.finalAnswer, content: "stale projection" },
    },
    jobStatus: "running",
  });

  const restarted = createFixture({ store: initial.store, ids: initial.ids, workerId: "terminal-stale-recovery" });
  assert.deepEqual((await restarted.runner.recover()).recoveredRunIds, [run.runId]);
  await waitFor(() => initial.store.jobLog.find((job) => job.runId === run.runId)?.status === "completed");

  const recovered = await restarted.runner.getRun(run.runId);
  const terminalEvents = (await restarted.runner.listEvents(run.runId)).filter((event) => event.type === "run.completed");
  assert.equal(recovered.readModel.status, "completed");
  assert.equal(recovered.readModel.currentNodeId, null);
  assert.equal(recovered.readModel.finalAnswer.content, "Draft 1: product-safe workflow");
  assert.equal(initial.invocationInputs.length, 1);
  assert.equal(restarted.invocationInputs.length, 0);
  assert.equal(terminalEvents.length, 1);
});

test("WorkflowRunner revise only retries the ReviewGate direct upstream Skill and reject cancels", async () => {
  const fixture = createFixture();
  const revised = await fixture.runner.startRun(startRequest("idem-revise"));
  await waitFor(async () => (await fixture.runner.getRun(revised.runId)).run.status === "waiting_review");
  await fixture.runner.submitReviewDecision({
    runId: revised.runId,
    nodeId: "node-review",
    decision: "revise",
    comment: "Make the draft tighter.",
    requestedChanges: ["Tighten the draft."],
    idempotencyKey: "decision-revise",
    decidedBy: "user-local",
  });
  await waitFor(async () => {
    const detail = await fixture.runner.getRun(revised.runId);
    return detail.run.status === "waiting_review" && detail.run.nodeRuns.filter((entry) => entry.nodeId === "node-skill").length === 2;
  });
  const waiting = await fixture.runner.getRun(revised.runId);
  const skills = waiting.run.nodeRuns.filter((entry) => entry.nodeId === "node-skill");
  assert.deepEqual(skills.map((entry) => entry.attempt), [1, 2]);
  assert.equal(waiting.run.nodeRuns.filter((entry) => entry.nodeId === "node-input").length, 1);
  assert.deepEqual(fixture.invocationInputs[1], {
    topic: "product-safe workflow\n\nReviewer feedback:\n- Make the draft tighter.\n- Tighten the draft.",
  });
  await fixture.runner.submitReviewDecision({
    runId: revised.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "decision-revise-approve",
    decidedBy: "user-local",
  });
  await waitFor(async () => (await fixture.runner.getRun(revised.runId)).run.status === "completed");
  assert.equal(
    (await fixture.runner.getRun(revised.runId)).readModel.finalAnswer.content,
    "Draft 2: product-safe workflow\n\nReviewer feedback:\n- Make the draft tighter.\n- Tighten the draft.",
  );

  const rejected = await fixture.runner.startRun(startRequest("idem-reject"));
  await waitFor(async () => (await fixture.runner.getRun(rejected.runId)).run.status === "waiting_review");
  await fixture.runner.submitReviewDecision({
    runId: rejected.runId,
    nodeId: "node-review",
    decision: "reject",
    requestedChanges: [],
    idempotencyKey: "decision-reject",
    decidedBy: "user-local",
  });
  await waitFor(async () => (await fixture.runner.getRun(rejected.runId)).run.status === "cancelled");
  const detail = await fixture.runner.getRun(rejected.runId);
  assert.equal(detail.readModel.finalAnswer, null);
  assert.equal((await fixture.runner.listEvents(rejected.runId)).at(-1).type, "run.cancelled");
});

test("WorkflowRunner replays idempotency, rejects conflicts, and reopens durable runs without recovery", async () => {
  const fixture = createFixture();
  const request = startRequest("idem-replay");
  const first = await fixture.runner.startRun(request);
  const replay = await fixture.runner.startRun(request);
  assert.equal(replay.runId, first.runId);
  await assert.rejects(
    () => fixture.runner.startRun({ ...request, inputs: { topic: "different" } }),
    (error) => error?.code === "idempotency_key_reused",
  );
  await waitFor(async () => (await fixture.runner.getRun(first.runId)).run.status === "waiting_review");

  const restarted = createFixture({ store: fixture.store, ids: fixture.ids });
  const reopened = await restarted.runner.getRun(first.runId);
  assert.equal(reopened.run.status, "waiting_review");
  assert.ok((await restarted.runner.listEvents(first.runId)).length >= 1);
  const rerun = await restarted.runner.startRun(startRequest("idem-rerun"));
  assert.notEqual(rerun.runId, first.runId);
});

test("WorkflowRunner persists cancel and retry commands and retries the immutable execution snapshot", async () => {
  const fixture = createFixture({ skillVersions: [publishedFixtureSkillVersion()] });
  const first = await fixture.runner.startRun(startRequest("idem-command-first"));
  await waitFor(async () => (await fixture.runner.getRun(first.runId)).run.status === "waiting_review");

  const cancelled = await fixture.runner.cancelRun({
    runId: first.runId,
    idempotencyKey: "idem-command-cancel",
    requestedBy: "user-local",
    reason: "Stop this review.",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await fixture.runner.listEvents(first.runId)).at(-1).type, "run.cancelled");
  assertTerminalTransaction(fixture.store);
  assert.equal(fixture.store.jobLog.find((job) => job.runId === first.runId).status, "cancelled");
  assert.equal(fixture.store.leaseLog.find((lease) => lease.runId === first.runId).status, "released");

  const retried = await fixture.runner.retryRun({
    runId: first.runId,
    idempotencyKey: "idem-command-retry",
    requestedBy: "user-local",
    reason: "Try the same revision again.",
  });
  assert.notEqual(retried.runId, first.runId);
  await waitFor(async () => (await fixture.runner.getRun(retried.runId)).run.status === "waiting_review");
  assert.deepEqual(fixture.store.commandLog.map((entry) => entry.command), ["cancel", "retry"]);
});

test("WorkflowRunner does not abort an active invocation when the cancel command cannot be persisted", async () => {
  let invocationStarted;
  const started = new Promise((resolve) => { invocationStarted = resolve; });
  let finishInvocation;
  const finish = new Promise((resolve) => { finishInvocation = resolve; });
  let aborted = false;
  const fixture = createFixture({
    agentRuntimeOverrides: {
      async invokeSkillNode({ signal }) {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        invocationStarted();
        return finish;
      },
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-cancel-persistence-failure"));
  await started;

  const runIdempotentMutation = fixture.store.runIdempotentMutation;
  fixture.store.runIdempotentMutation = async () => {
    throw new WorkflowRunnerError("idempotency_key_reused");
  };
  await assert.rejects(
    () => fixture.runner.cancelRun({
      runId: run.runId,
      idempotencyKey: "idem-cancel-conflict",
      requestedBy: "user-local",
      reason: "This request must not take effect.",
    }),
    (error) => error?.code === "idempotency_key_reused",
  );
  assert.equal(aborted, false);
  assert.equal((await fixture.runner.getRun(run.runId)).run.status, "running");

  fixture.store.runIdempotentMutation = runIdempotentMutation;
  finishInvocation({ brief: "Draft 1: product-safe workflow" });
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
});

test("WorkflowRunner persists a failed terminal state when the initial background schedule throws", async () => {
  const revision = makeRevision();
  revision.graph.nodes = revision.graph.nodes.filter((node) => node.nodeId !== "node-input");
  const fixture = createFixture({ revision });

  const run = await fixture.runner.startRun(startRequest("idem-start-schedule-failure"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "failed");

  const failed = await fixture.runner.getRun(run.runId);
  const events = await fixture.runner.listEvents(run.runId);
  assert.equal(failed.readModel.status, "failed");
  assert.equal(failed.readModel.failure.code, "execution_node_missing");
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(fixture.store.terminalReadModelsBeforeEvents, true);
  assertTerminalTransaction(fixture.store);
});

test("WorkflowRunner persists a failed terminal state when review continuation throws", async () => {
  const fixture = createFixture({
    agentRuntimeOverrides: {
      async buildAuthoritativeFinal() {
        throw runnerError("authoritative_final_unavailable");
      },
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-review-schedule-failure"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");

  await fixture.runner.submitReviewDecision({
    runId: run.runId,
    nodeId: "node-review",
    decision: "approve",
    requestedChanges: [],
    idempotencyKey: "decision-schedule-failure",
    decidedBy: "user-local",
  });
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "failed");

  const failed = await fixture.runner.getRun(run.runId);
  const events = await fixture.runner.listEvents(run.runId);
  assert.equal(failed.readModel.failure.code, "authoritative_final_unavailable");
  assert.equal(failed.readModel.finalAnswer, null);
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(fixture.store.terminalReadModelsBeforeEvents, true);
});

test("WorkflowRunner applies the complete Skill input schema", async () => {
  const fixture = createFixture({
    skillInputSchema: {
      type: "object",
      properties: { topic: { type: "string", pattern: "^approved-" } },
      required: ["topic"],
      additionalProperties: false,
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-invalid-skill-input"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "failed");

  const failed = await fixture.runner.getRun(run.runId);
  assert.equal(failed.readModel.failure.code, "skill_input_invalid");
  assert.equal((await fixture.runner.listEvents(run.runId)).at(-1).type, "run.failed");
});

test("WorkflowRunner applies the complete Skill output schema", async () => {
  const fixture = createFixture({
    skillOutputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", minLength: 1 },
        confidence: { type: "integer", minimum: 1 },
      },
      required: ["brief", "confidence"],
      additionalProperties: false,
    },
    agentRuntimeOverrides: {
      async invokeSkillNode({ input }) {
        return { brief: `Draft: ${input.topic}`, confidence: 0 };
      },
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-invalid-skill-output"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "failed");

  const failed = await fixture.runner.getRun(run.runId);
  assert.equal(failed.readModel.failure.code, "skill_output_invalid");
  assert.equal((await fixture.runner.listEvents(run.runId)).at(-1).type, "run.failed");
});

test("WorkflowRunner reads server-owned text material without exposing object content in the Run", async () => {
  const base = { title: "", description: "", position: { x: 0, y: 0 }, reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 30, display: { collapsed: false } };
  const port = (portId) => ({ portId, name: portId, schema: { type: "string", minLength: 1 }, required: true });
  const revision = {
    workflowId: "workflow-runner", revisionId: "revision-runner-1", resourceRefs: [{ resourceId: "resource-notes", version: "1.0.0", label: "Meeting notes" }],
    graph: { nodes: [
      { ...base, nodeId: "node-material", kind: "Material", title: "Notes", inputPorts: [], outputPorts: [port("text")], inputBindings: [], configuration: { resourceIds: ["resource-notes"] } },
      { ...base, nodeId: "node-output", kind: "Output", title: "Output", inputPorts: [port("content")], outputPorts: [port("final")], inputBindings: [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: "node-material", portId: "text" } }], configuration: { format: "markdown" } },
    ], edges: [{ edgeId: "edge-material", sourceNodeId: "node-material", sourcePort: "text", targetNodeId: "node-output", targetPort: "content" }] },
  };
  const plan = { schemaVersion: "workbench-execution-plan-v1", planVersion: "1", workflowId: revision.workflowId, workflowRevisionId: revision.revisionId, contentHash: "sha256:1234567890abcdef", generatedAt: NOW, maxParallelism: 1, pinnedSkills: [], steps: [
    { nodeId: "node-material", kind: "Material", dependsOn: [], inputBindings: [] },
    { nodeId: "node-output", kind: "Output", dependsOn: ["node-material"], inputBindings: [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: "node-material", portId: "text" } }] },
  ], reviewGates: [], primaryOutput: { nodeId: "node-output", portId: "final" } };
  const fixture = createFixture({ revision, plan, resolveResourceText: async ({ resourceId, version }) => {
    assert.equal(resourceId, "resource-notes"); assert.equal(version, "1.0.0"); return "Action: assign an owner.";
  } });
  const run = await fixture.runner.startRun({ workflowId: revision.workflowId, workflowRevisionId: revision.revisionId, inputs: {}, resourceRefs: revision.resourceRefs, idempotencyKey: "material-run", requestId: "material-run" });
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "completed");
  const completed = await fixture.runner.getRun(run.runId);
  assert.equal(completed.readModel.finalAnswer.content, "Action: assign an owner.");
  assertProductSafe(completed);
});

test("WorkflowRunner delegates Skill nodes through the Product Execution Broker", async () => {
  const requests = [];
  const fixture = createFixture({
    executionBroker: {
      async execute(executionRequest, { signal }) {
        assert.equal(signal.aborted, false);
        requests.push(structuredClone(executionRequest));
        return {
          schemaVersion: "workbench-execution-fabric-v1",
          invocationId: executionRequest.invocationId,
          attemptId: executionRequest.attemptId,
          status: "completed",
          isolation: "process",
          output: { brief: `Broker: ${executionRequest.input.topic}` },
          summary: "completed",
          evidence: [],
          usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
          startedAt: NOW,
          finishedAt: NOW,
        };
      },
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-broker"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
  assert.equal(requests.length, 1);
  assert.equal(fixture.invocationInputs.length, 0);
  assert.equal(requests[0].mode, "deterministic_skill");
  assert.equal(requests[0].controller.kind, "workflow_run");
  assert.equal(requests[0].controller.controllerId, run.runId);
  assert.equal(requests[0].limits.maxModelRequests, 0);
  assert.deepEqual(requests[0].metadata.executionRef, {
    capabilityId: "workflow-conformance",
    taskIntent: "echo",
    adapterVersion: "1",
    executionMode: "deterministic",
  });
});

test("WorkflowRunner dispatches a pinned bounded Agent revision and publishes actual fallback", async () => {
  const plan = makePlan();
  plan.schemaVersion = "workbench-execution-plan-v2";
  plan.planVersion = "2";
  plan.modelRoutingState = "pinned";
  const step = plan.steps.find((candidate) => candidate.kind === "Skill");
  Object.assign(step, {
    executionMode: "bounded_agent",
    isolation: "container",
    limits: {
      timeoutMs: 30_000, maxSteps: 32, maxModelRequests: 16, maxChildren: 0,
      maxInputBytes: 1_000_000, maxOutputBytes: 1_000_000,
      maxImageCount: 0, maxCostUsdMicros: 500_000,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false,
      filesystem: "none", externalActions: false,
    },
    resultSchema: {
      type: "object", properties: { brief: { type: "string", minLength: 1 } },
      required: ["brief"], additionalProperties: false,
    },
    evidenceRequirements: [],
    modelRoutingState: "pinned",
    modelProfileRevisionId: "model-revision-controller-1",
    modelCapability: "tool_calling",
    parameterSchema: {
      type: "object", properties: { topic: { type: "string", minLength: 1 } },
      required: ["topic"], additionalProperties: false,
    },
    fallbackModelProfileRevisionIds: ["model-revision-controller-2"],
  });
  const requests = [];
  const fixture = createFixture({
    plan,
    skillExecutionRef: {
      capabilityId: "workflow-conformance", taskIntent: "echo",
      adapterVersion: "1", executionMode: "agent",
    },
    executionBroker: {
      async execute(request) {
        requests.push(structuredClone(request));
        return {
          status: "completed",
          output: { brief: "Broker fallback result" },
          requestedModelRevisionId: "model-revision-controller-1",
          actualModelRevisionId: "model-revision-controller-2",
          artifactRefs: [],
        };
      },
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-bounded-model"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
  assert.equal(requests[0].mode, "bounded_agent");
  assert.equal(requests[0].isolation, "container");
  assert.equal(requests[0].metadata.modelProfileRevisionId, "model-revision-controller-1");
  assert.deepEqual(requests[0].metadata.fallbackModelProfileRevisionIds, ["model-revision-controller-2"]);
  const detail = await fixture.runner.getRun(run.runId);
  const timeline = detail.readModel.nodeTimeline.find((entry) => entry.nodeId === "node-skill");
  assert.equal(timeline.requestedModelRevisionId, "model-revision-controller-1");
  assert.equal(timeline.actualModelRevisionId, "model-revision-controller-2");
  assert.equal(timeline.fallbackUsed, true);
  assert.deepEqual(timeline.artifactRefs, []);
  assertProductSafe(detail);
});

test("WorkflowRunner builds a strict process model_call and publishes safe Artifact refs", async () => {
  const revision = makeRevision();
  const input = revision.graph.nodes.find((node) => node.kind === "Input");
  const skill = revision.graph.nodes.find((node) => node.kind === "Skill");
  const review = revision.graph.nodes.find((node) => node.kind === "ReviewGate");
  const promptSchema = { type: "string", minLength: 1 };
  const artifactRefsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        artifactId: { type: "string", minLength: 1 },
        mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
      },
      required: ["artifactId", "mediaType"],
      additionalProperties: false,
    },
    minItems: 1,
  };
  input.configuration.fieldIds = ["prompt"];
  input.outputPorts = [{ ...input.outputPorts[0], portId: "prompt", name: "prompt", schema: promptSchema }];
  skill.inputPorts = [{ ...skill.inputPorts[0], portId: "prompt", name: "prompt", schema: promptSchema }];
  skill.inputBindings = [{
    targetPort: "prompt",
    source: { kind: "nodeOutput", nodeId: input.nodeId, portId: "prompt" },
  }];
  skill.outputPorts = [{
    ...skill.outputPorts[0], portId: "artifactRefs", name: "artifactRefs", schema: artifactRefsSchema,
  }];
  review.inputPorts = [{
    ...review.inputPorts[0], portId: "candidate", name: "candidate", schema: artifactRefsSchema,
  }];
  review.inputBindings = [{
    targetPort: "candidate",
    source: { kind: "nodeOutput", nodeId: skill.nodeId, portId: "artifactRefs" },
  }];
  for (const edge of revision.graph.edges) {
    if (edge.edgeId === "edge-input") {
      edge.sourcePort = "prompt";
      edge.targetPort = "prompt";
    }
    if (edge.edgeId === "edge-review") edge.sourcePort = "artifactRefs";
  }

  const imageInputSchema = {
    type: "object",
    properties: { prompt: promptSchema },
    required: ["prompt"],
    additionalProperties: false,
  };
  const imageResultSchema = structuredClone(ImageGenerationResultSchema);
  delete imageResultSchema.$id;
  const plan = makePlan();
  plan.schemaVersion = "workbench-execution-plan-v2";
  plan.planVersion = "2";
  plan.modelRoutingState = "pinned";
  plan.steps[0].inputBindings = [];
  const step = plan.steps.find((candidate) => candidate.kind === "Skill");
  step.inputBindings = structuredClone(skill.inputBindings);
  Object.assign(step, {
    executionMode: "model_call",
    isolation: "process",
    limits: {
      timeoutMs: 30_000, maxSteps: 1, maxModelRequests: 1, maxChildren: 0,
      maxInputBytes: 1_000_000, maxOutputBytes: 4_000_000,
      maxImageCount: 1, maxCostUsdMicros: 500_000,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false,
      filesystem: "none", externalActions: false,
    },
    resultSchema: imageResultSchema,
    evidenceRequirements: [{
      requirementId: "image-output", kind: "artifact", required: true,
      description: "Return one governed image Artifact.",
    }],
    modelRoutingState: "pinned",
    modelProfileRevisionId: "model-revision-stability-1",
    modelCapability: "image_generation",
    parameterSchema: imageInputSchema,
    fallbackModelProfileRevisionIds: [],
  });
  const artifactRefs = [{ artifactId: "artifact-image-1", mediaType: "image/png" }];
  const modelOutput = {
    kind: "image_generation",
    artifactRefs,
    seed: 42,
    format: "png",
    dimensions: { width: 1024, height: 1024 },
    safetyStatus: "passed",
    usage: {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      imageCount: 1, costUsdMicros: 100_000,
    },
    requestedModelRevisionId: "model-revision-stability-1",
    actualModelRevisionId: "model-revision-stability-1",
  };
  const requests = [];
  const fixture = createFixture({
    revision,
    plan,
    skillInputSchema: imageInputSchema,
    skillOutputSchema: imageResultSchema,
    skillExecutionRef: {
      capabilityId: "image-generation", taskIntent: "generate_image",
      adapterVersion: "1", executionMode: "model", requiredModelCapability: "image_generation",
    },
    executionBroker: {
      async execute(request) {
        requests.push(structuredClone(request));
        return {
          status: "completed",
          output: modelOutput,
          requestedModelRevisionId: "model-revision-stability-1",
          actualModelRevisionId: "model-revision-stability-1",
          artifactRefs,
        };
      },
    },
  });
  const run = await fixture.runner.startRun({
    workflowId: revision.workflowId,
    workflowRevisionId: revision.revisionId,
    inputs: { prompt: "Draw a blue circle." },
    resourceRefs: [],
    idempotencyKey: "idem-model-call",
    requestId: "request-model-call",
  });
  await waitFor(async () => !["queued", "running"].includes((await fixture.runner.getRun(run.runId)).run.status));
  assert.equal(requests.length, 1);
  assert.equal(fixture.invocationInputs.length, 0);
  assert.equal(
    Check(ExecutionRequestSchema, requests[0]),
    true,
    JSON.stringify([...Errors(ExecutionRequestSchema, requests[0])]),
  );
  assert.equal(requests[0].mode, "model_call");
  assert.equal(requests[0].isolation, "process");
  assert.deepEqual(requests[0].capabilities, {
    toolAllowlist: [], connectionIds: [], network: false,
    filesystem: "none", externalActions: false,
  });
  assert.deepEqual(requests[0].input, { prompt: "Draw a blue circle." });
  const detail = await fixture.runner.getRun(run.runId);
  const timeline = detail.readModel.nodeTimeline.find((entry) => entry.nodeId === "node-skill");
  assert.equal(timeline.requestedModelRevisionId, "model-revision-stability-1");
  assert.equal(timeline.actualModelRevisionId, "model-revision-stability-1");
  assert.equal(timeline.fallbackUsed, false);
  assert.deepEqual(timeline.artifactRefs, artifactRefs);
  assertProductSafe(detail);
});

test("WorkflowRunner keeps legacy_unpinned model plans readable but refuses execution", async () => {
  const plan = makePlan();
  plan.schemaVersion = "workbench-execution-plan-v2";
  plan.planVersion = "2";
  plan.modelRoutingState = "legacy_unpinned";
  const step = plan.steps.find((candidate) => candidate.kind === "Skill");
  Object.assign(step, {
    executionMode: "bounded_agent",
    isolation: "container",
    limits: {
      timeoutMs: 30_000, maxSteps: 32, maxModelRequests: 16, maxChildren: 0,
      maxInputBytes: 1_000_000, maxOutputBytes: 1_000_000,
      maxImageCount: 0, maxCostUsdMicros: 0,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false,
      filesystem: "none", externalActions: false,
    },
    resultSchema: {
      type: "object", properties: { brief: { type: "string" } },
      required: ["brief"], additionalProperties: false,
    },
    evidenceRequirements: [],
    modelRoutingState: "legacy_unpinned",
    legacyModelProfileId: "historical-profile",
  });
  let calls = 0;
  const fixture = createFixture({
    plan,
    executionBroker: { async execute() { calls += 1; return {}; } },
  });
  const run = await fixture.runner.startRun(startRequest("idem-legacy-model"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "failed");
  const detail = await fixture.runner.getRun(run.runId);
  assert.equal(calls, 0);
  assert.equal(detail.readModel.failure.code, "workflow_model_route_legacy_unpinned");
  assertProductSafe(detail);
});

function startRequest(idempotencyKey) {
  return {
    workflowId: "workflow-runner",
    workflowRevisionId: "revision-runner-1",
    inputs: { topic: "product-safe workflow" },
    resourceRefs: [],
    idempotencyKey,
    requestId: "request-runner",
  };
}

function createFixture({
  store = createStore(),
  ids = createIds(),
  revision = makeRevision(),
  plan = makePlan(),
  skillInputSchema = { type: "object", properties: { topic: { type: "string", minLength: 1 } }, required: ["topic"], additionalProperties: false },
  skillOutputSchema = { type: "object", properties: { brief: { type: "string", minLength: 1 } }, required: ["brief"], additionalProperties: false },
  agentRuntimeOverrides = {},
  skillVersions = [],
  skillExecutionRef = {
    capabilityId: "workflow-conformance",
    taskIntent: "echo",
    adapterVersion: "1",
    executionMode: "deterministic",
  },
  scheduleOnStart = true,
  workerId,
  invocationDelayMs = 0,
  leaseDurationMs,
  resolveResourceText,
  faultInjector,
  executionBroker = null,
} = {}) {
  let invocations = 0;
  const invocationInputs = [];
  const agentRuntime = {
    async invokeSkillNode({ input, workspaceId }) {
      assert.equal(workspaceId, "workspace-local");
      invocationInputs.push(clone(input));
      if (invocations === 0) assert.deepEqual(input, { topic: "product-safe workflow" });
      if (invocationDelayMs) await new Promise((resolve) => setTimeout(resolve, invocationDelayMs));
      invocations += 1;
      return { brief: `Draft ${invocations}: ${input.topic}` };
    },
    async buildAuthoritativeFinal({ runId, finalText }) {
      return {
        finalText,
        evidenceGaps: [],
        reviewPacket: null,
        agentFinalReadModel: {
          schemaVersion: "agent-final-read-model-v1",
          runID: runId,
          finalText,
        },
      };
    },
    ...agentRuntimeOverrides,
  };
  const runner = createWorkflowRunner({
    store,
    idFactory: ids.next,
    clock: () => NOW,
    resolveExecution: async ({ workflowId, revisionId }) => {
      assert.equal(workflowId, revision.workflowId);
      assert.equal(revisionId, revision.revisionId);
      return {
        revision,
        compileResult: { status: "ready", executionPlan: plan },
        workspaceId: "workspace-local",
        skillVersions,
        skills: {
          "skill-draft:1": {
            definition: {
              inputSchema: skillInputSchema,
              outputSchema: skillOutputSchema,
            },
            executionRef: structuredClone(skillExecutionRef),
          },
        },
      };
    },
    resolveResourceText,
    agentRuntime,
    executionBroker,
    scheduleOnStart,
    workerId,
    leaseDurationMs,
    faultInjector,
  });
  return { runner, store, ids, invocationInputs };
}

function makeRevision() {
  const base = { title: "", description: "", position: { x: 0, y: 0 }, reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 30, display: { collapsed: false } };
  const port = (portId) => ({ portId, name: portId, schema: { type: "string", minLength: 1 }, required: true });
  return {
    workflowId: "workflow-runner", revisionId: "revision-runner-1",
    graph: {
      nodes: [
        { ...base, nodeId: "node-input", kind: "Input", title: "Input", inputPorts: [], outputPorts: [port("topic")], inputBindings: [], configuration: { fieldIds: ["topic"] } },
        { ...base, nodeId: "node-skill", kind: "Skill", title: "Draft", skillRef: { skillId: "skill-draft", version: "1" }, inputPorts: [port("topic")], outputPorts: [port("brief")], inputBindings: [{ targetPort: "topic", source: { kind: "nodeOutput", nodeId: "node-input", portId: "topic" } }], configuration: {} },
        { ...base, nodeId: "node-review", kind: "ReviewGate", title: "Review", inputPorts: [port("candidate")], outputPorts: [port("approved")], inputBindings: [{ targetPort: "candidate", source: { kind: "nodeOutput", nodeId: "node-skill", portId: "brief" } }], configuration: { instructions: "Review the draft.", allowRevision: true, revisionTarget: { nodeId: "node-skill", portId: "topic" } }, reviewPolicy: { mode: "required", instructions: "Review the draft." } },
        { ...base, nodeId: "node-output", kind: "Output", title: "Output", inputPorts: [port("content")], outputPorts: [port("final")], inputBindings: [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" } }], configuration: { format: "markdown" } },
      ],
      edges: [
        { edgeId: "edge-input", sourceNodeId: "node-input", sourcePort: "topic", targetNodeId: "node-skill", targetPort: "topic" },
        { edgeId: "edge-review", sourceNodeId: "node-skill", sourcePort: "brief", targetNodeId: "node-review", targetPort: "candidate" },
        { edgeId: "edge-output", sourceNodeId: "node-review", sourcePort: "approved", targetNodeId: "node-output", targetPort: "content" },
      ],
    },
  };
}

function makePlan() {
  const step = (nodeId, kind, dependsOn, inputBindings = []) => ({ nodeId, kind, dependsOn, inputBindings });
  return {
    schemaVersion: "workbench-execution-plan-v1", planVersion: "1", workflowId: "workflow-runner", workflowRevisionId: "revision-runner-1",
    contentHash: "sha256:1234567890abcdef", generatedAt: NOW, maxParallelism: 1, pinnedSkills: [{ skillId: "skill-draft", version: "1" }],
    steps: [
      step("node-input", "Input", []),
      { ...step("node-skill", "Skill", ["node-input"], [{ targetPort: "topic", source: { kind: "nodeOutput", nodeId: "node-input", portId: "topic" } }]), skillRef: { skillId: "skill-draft", version: "1" } },
      step("node-review", "ReviewGate", ["node-skill"], [{ targetPort: "candidate", source: { kind: "nodeOutput", nodeId: "node-skill", portId: "brief" } }]),
      step("node-output", "Output", ["node-review"], [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" } }]),
    ], reviewGates: [{ nodeId: "node-review", dependsOn: ["node-skill"], instructions: "Review the draft." }], primaryOutput: { nodeId: "node-output", portId: "final" },
  };
}

function createStore() {
  const runs = new Map(); const attempts = new Map(); const events = new Map(); const readModels = new Map(); const decisions = new Map(); const commands = new Map(); const jobs = new Map(); const leases = new Map(); const checkpoints = new Map(); const terminalTransitions = new Map(); const heartbeats = []; const idempotency = new Map();
  const terminalTransactionLog = [];
  let transactionDepth = 0;
  const attemptKey = (runId, nodeId, attempt) => `${runId}\u0000${nodeId}\u0000${attempt}`;
  const publicRun = (value) => omit(value, ["eventSequence", "executionPlanSnapshot", "executionSnapshot", "agentFinalReadModel"]);
  const publicAttempt = (value) => omit(value, ["executionInput", "executionOutput", "invocationId", "invocationStatus", "invocationStartedAt", "workerId", "fence"]);
  const rawRunsCollection = { async updateOne({ runId }, { $set }) { Object.assign(runs.get(runId), clone($set)); } };
  const rawAttemptsCollection = { async updateOne({ runId, nodeId, attempt }, { $set }) { Object.assign(attempts.get(attemptKey(runId, nodeId, attempt)), clone($set)); } };
  const store = {
    terminalReadModelsBeforeEvents: true,
    repositories: {
      runs: {
        collection: rawRunsCollection,
        async insert(run) { runs.set(run.runId, { ...publicRun(run), eventSequence: 0 }); return publicRun(runs.get(run.runId)); },
        async get(runId) { return runs.has(runId) ? publicRun(runs.get(runId)) : null; },
        async getInternal(runId) { return runs.has(runId) ? clone(runs.get(runId)) : null; },
        async patch(runId, patch) {
          if (["completed", "failed", "cancelled"].includes(patch.status)) terminalTransactionLog.push({ kind: "run", inTransaction: transactionDepth > 0 });
          Object.assign(runs.get(runId), clone(omit(patch, ["runId", "eventSequence", "executionPlanSnapshot"])));
          return publicRun(runs.get(runId));
        },
        async listByWorkflow(workflowId, { status } = {}) { return [...runs.values()].filter((entry) => entry.workflowId === workflowId && (!status || entry.status === status)).map(publicRun); },
      },
      runJobs: {
        async insert(job) { jobs.set(job.runJobId, clone(job)); return clone(job); },
        async getByRun(runId) { return [...jobs.values()].find((job) => job.runId === runId) ? clone([...jobs.values()].find((job) => job.runId === runId)) : null; },
        async list() { return [...jobs.values()].map(clone); },
        async listRecoverable(now) {
          return [...jobs.values()].filter((job) => job.status === "queued" || (["leased", "running"].includes(job.status) && job.leaseExpiresAt <= now)).map(clone);
        },
        async claimByRun(runId, { workerId: leaseOwner, now, leaseExpiresAt }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          const recoverable = job?.status === "queued" || (["leased", "running"].includes(job?.status) && job.leaseExpiresAt <= now);
          if (!job || !recoverable) return null;
          Object.assign(job, { status: "leased", leaseOwner, heartbeatAt: now, leaseExpiresAt, fence: job.fence + 1, updatedAt: now });
          return clone(job);
        },
        async finishByRun(runId, { workerId: leaseOwner, fence, status, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence) return null;
          Object.assign(job, { status, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
          return clone(job);
        },
        async heartbeatByRun(runId, { workerId: leaseOwner, fence, now, leaseExpiresAt }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence) return null;
          heartbeats.push({ kind: "job", runId, workerId: leaseOwner, fence });
          Object.assign(job, { status: "running", heartbeatAt: now, leaseExpiresAt, updatedAt: now });
          return clone(job);
        },
        async assertActiveFence(runId, { workerId: leaseOwner, fence, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence || !["leased", "running"].includes(job.status) || job.leaseExpiresAt <= now) return null;
          job.lastFencedWriteAt = now;
          return clone(job);
        },
        async requeueByRun(runId, { now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.status !== "paused") return null;
          Object.assign(job, { status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now });
          return clone(job);
        },
        async pauseByRun(runId, { workerId: leaseOwner, fence, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence || !["leased", "running"].includes(job.status)) return null;
          Object.assign(job, { status: "paused", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
          return clone(job);
        },
        async abandonClaimByRun(runId, { workerId: leaseOwner, fence, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence || !["leased", "running"].includes(job.status)) return null;
          Object.assign(job, { status: "queued", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
          return clone(job);
        },
        async cancelByRun(runId, { now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return null;
          Object.assign(job, { status: "cancelled", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
          return clone(job);
        },
        async nextCheckpointSequence(runId, { workerId: leaseOwner, fence, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence) return null;
          job.checkpointSequence = (job.checkpointSequence || 0) + 1;
          job.updatedAt = now;
          return job.checkpointSequence;
        },
        async nextTerminalCheckpointSequence(runId, { now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job) return null;
          job.checkpointSequence = (job.checkpointSequence || 0) + 1;
          job.updatedAt = now;
          return job.checkpointSequence;
        },
      },
      runLeases: {
        async acquire(lease) {
          if (rejectLeaseAcquire) {
            rejectLeaseAcquire = false;
            return null;
          }
          leases.set(lease.runId, clone(lease));
          return clone(lease);
        },
        async heartbeat(runId, { workerId, fence, heartbeatAt, expiresAt }) {
          const lease = leases.get(runId);
          if (!lease || lease.workerId !== workerId || lease.fence !== fence || lease.status !== "active") return null;
          heartbeats.push({ kind: "lease", runId, workerId, fence });
          Object.assign(lease, { heartbeatAt, expiresAt, updatedAt: heartbeatAt });
          return clone(lease);
        },
        async release(runId, { workerId, fence, releasedAt }) {
          const lease = leases.get(runId);
          if (!lease || lease.workerId !== workerId || lease.fence !== fence) return null;
          Object.assign(lease, { status: "released", releasedAt, updatedAt: releasedAt });
          return clone(lease);
        },
        async cancelByRun(runId, { cancelledAt }) {
          const lease = leases.get(runId);
          if (!lease || lease.status !== "active") return null;
          Object.assign(lease, { status: "cancelled", releasedAt: cancelledAt, updatedAt: cancelledAt });
          return clone(lease);
        },
      },
      runCheckpoints: {
        async insert(checkpoint) { checkpoints.set(checkpoint.checkpointId, clone(checkpoint)); return clone(checkpoint); },
      },
      runTerminalTransitions: {
        collection: {
          async findOne({ runId }) { return [...terminalTransitions.values()].find((entry) => entry.runId === runId) ?? null; },
        },
        async insert(value) { terminalTransitions.set(value.terminalTransitionId, clone(value)); return clone(value); },
      },
      runNodeAttempts: {
        collection: rawAttemptsCollection,
        async insert(attempt) { attempts.set(attemptKey(attempt.runId, attempt.nodeId, attempt.attempt), clone(attempt)); return publicAttempt(attempt); },
        async patch(runId, nodeId, attempt, patch) { const value = attempts.get(attemptKey(runId, nodeId, attempt)); Object.assign(value, clone(omit(patch, ["executionInput", "executionOutput"]))); return publicAttempt(value); },
        async patchInternal(runId, nodeId, attempt, patch) { const value = attempts.get(attemptKey(runId, nodeId, attempt)); if (!value) return null; Object.assign(value, clone(patch)); return clone(value); },
        async listByRun(runId) { return sortAttempts([...attempts.values()].filter((entry) => entry.runId === runId)).map(publicAttempt); },
        async listInternalByRun(runId) { return sortAttempts([...attempts.values()].filter((entry) => entry.runId === runId)).map(clone); },
      },
      runEvents: { async listAfter(runId, after = 0) { return (events.get(runId) ?? []).filter((entry) => entry.sequence > after).map(clone); } },
      runReadModels: {
        async get(runId) { return readModels.has(runId) ? clone(readModels.get(runId)) : null; },
        async put(value) {
          if (["completed", "failed", "cancelled"].includes(value.status)) terminalTransactionLog.push({ kind: "readModel", inTransaction: transactionDepth > 0 });
          readModels.set(value.runId, clone(value));
          return clone(value);
        },
      },
      reviewDecisions: {
        async insert(value) { decisions.set(value.decisionId, clone(value)); return omit(value, ["applicationStatus", "appliedAt"]); },
        async listByRun(runId) { return [...decisions.values()].filter((entry) => entry.runId === runId).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).map((entry) => omit(entry, ["applicationStatus", "appliedAt"])); },
        async listInternalByRun(runId) { return [...decisions.values()].filter((entry) => entry.runId === runId).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).map(clone); },
        async patch(decisionId, patch) { const value = decisions.get(decisionId); if (!value) return null; Object.assign(value, clone(patch)); return clone(value); },
      },
      runCommands: { async insert(value) { commands.set(value.runCommandId, clone(value)); return clone(value); } },
    },
    async appendRunEvent(event) {
      const run = runs.get(event.runId); const sequence = ++run.eventSequence; const stored = { ...clone(event), sequence };
      if (["run.completed", "run.failed", "run.cancelled"].includes(stored.type)) terminalTransactionLog.push({ kind: "event", inTransaction: transactionDepth > 0 });
      const terminalReadModel = readModels.get(stored.runId);
      if (stored.type === "run.completed" && (!terminalReadModel?.finalAnswer?.content || terminalReadModel.status !== "completed")) store.terminalReadModelsBeforeEvents = false;
      if (stored.type === "run.failed" && (!terminalReadModel?.failure || terminalReadModel.status !== "failed")) store.terminalReadModelsBeforeEvents = false;
      if (stored.type === "run.cancelled" && terminalReadModel?.status !== "cancelled") store.terminalReadModelsBeforeEvents = false;
      const list = events.get(event.runId) ?? []; list.push(stored); events.set(event.runId, list); return clone(stored);
    },
    async withTransaction(callback, { session } = {}) {
      if (session?.inTransaction) return callback(session);
      const transactionSession = { inTransaction: true };
      transactionDepth += 1;
      try {
        return await callback(transactionSession);
      } finally {
        transactionDepth -= 1;
      }
    },
    async runIdempotentMutation({ scope, key, request }, mutation) {
      const id = `${scope}\u0000${key}`; const fingerprint = JSON.stringify(request);
      const existing = idempotency.get(id);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new WorkflowRunnerError("idempotency_key_reused"); return clone(existing.response); }
      return store.withTransaction(async (session) => {
        const response = await mutation(session); idempotency.set(id, { fingerprint, response: clone(response) }); return clone(response);
      });
    },
  };
  Object.defineProperty(store, "inTransaction", { get: () => transactionDepth > 0 });
  Object.defineProperty(store, "terminalTransactionLog", { get: () => terminalTransactionLog.map(clone) });
  Object.defineProperty(store, "commandLog", { get: () => [...commands.values()].map(clone) });
  Object.defineProperty(store, "jobLog", { get: () => [...jobs.values()].map((job) => ({ runId: job.runId, workspaceId: job.workspaceId, status: job.status, fence: job.fence })) });
  Object.defineProperty(store, "leaseLog", { get: () => [...leases.values()].map(clone) });
  Object.defineProperty(store, "checkpointLog", { get: () => [...checkpoints.values()].sort((a, b) => a.sequence - b.sequence).map(clone) });
  Object.defineProperty(store, "heartbeatLog", { get: () => [...heartbeats].map(clone) });
  Object.defineProperty(store, "terminalTransitionLog", { get: () => [...terminalTransitions.values()].map(clone) });
  let rejectLeaseAcquire = false;
  store.rejectNextLeaseAcquire = () => { rejectLeaseAcquire = true; };
  store.simulateExpiredRun = (runId, { workerId, fence, leaseExpiresAt }) => {
    const run = runs.get(runId);
    run.status = "running";
    run.startedAt = NOW;
    const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
    Object.assign(job, { status: "running", leaseOwner: workerId, fence, leaseExpiresAt, heartbeatAt: leaseExpiresAt });
  };
  store.expireLease = (runId) => {
    const expired = "2026-07-10T09:59:00.000Z";
    const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
    job.leaseExpiresAt = expired;
    job.heartbeatAt = expired;
    const lease = leases.get(runId);
    if (lease) lease.expiresAt = expired;
  };
  store.simulatePausedReview = (runId, decision) => {
    decisions.set(decision.decisionId, clone(decision));
    const run = runs.get(runId);
    run.status = "paused";
    run.reviewDecisions = [clone(decision)];
    const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
    Object.assign(job, { status: "queued", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: NOW });
  };
  store.simulateTerminalRecovery = (runId, { readModel, removeTerminalEvent = false, tamperedFinalOutput, jobStatus = "queued" } = {}) => {
    if (readModel === null) readModels.delete(runId);
    else if (readModel) readModels.set(runId, clone(readModel));
    if (removeTerminalEvent) {
      const runEvents = events.get(runId) ?? [];
      const terminal = runEvents.find((event) => event.type === `run.${runs.get(runId).status}`);
      events.set(runId, runEvents.filter((event) => event !== terminal));
      if (terminal?.sequence === runs.get(runId).eventSequence) runs.get(runId).eventSequence -= 1;
    }
    if (tamperedFinalOutput) {
      const output = sortAttempts([...attempts.values()].filter((entry) => entry.runId === runId && entry.nodeId === "node-output")).at(-1);
      output.executionOutput = { final: tamperedFinalOutput };
    }
    const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
    const expired = "2026-07-10T09:59:00.000Z";
    Object.assign(job, {
      status: jobStatus,
      leaseOwner: jobStatus === "queued" ? null : "dead-terminal-worker",
      leaseExpiresAt: jobStatus === "queued" ? null : expired,
      heartbeatAt: jobStatus === "queued" ? NOW : expired,
      updatedAt: NOW,
    });
    if (jobStatus !== "queued") {
      Object.assign(leases.get(runId), {
        status: "active",
        workerId: "dead-terminal-worker",
        expiresAt: expired,
        releasedAt: null,
        updatedAt: expired,
      });
    }
  };
  return store;
}

function createIds() { let index = 0; return { next(kind) { index += 1; return `${kind}-${index}`; } }; }
function publishedFixtureSkillVersion() {
  return {
    schemaVersion: "workbench-v1",
    skillVersionId: "skill-version-fixture-1",
    skillId: "skill-draft",
    workspaceId: "workspace-local",
    version: "1",
    packageObjectId: "object-fixture-1",
    packageHash: "sha256:1234567890abcdef",
    contentHash: "sha256:abcdef1234567890",
    manifest: {},
    name: "Fixture Skill",
    description: "Fixture Skill description.",
    category: "testing",
    inputSchema: { type: "object", properties: { topic: { type: "string", minLength: 1 } }, required: ["topic"], additionalProperties: false },
    outputSchema: { type: "object", properties: { brief: { type: "string", minLength: 1 } }, required: ["brief"], additionalProperties: false },
    risk: { level: "low", externalAction: false, summary: "No external action." },
    dependencies: [],
    connectionRequirements: [],
    validation: { validationId: "validation-fixture-1", status: "passed", diagnostics: [], testedAt: NOW },
    executionRef: { capabilityId: "workflow-conformance", taskIntent: "echo", adapterVersion: "1", executionMode: "deterministic" },
    publishedBy: "user-local",
    publishedAt: NOW,
  };
}
function sortAttempts(items) { return [...items].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.attempt - b.attempt); }
function omit(value, fields) { const copy = clone(value); for (const field of fields) delete copy[field]; return copy; }
function clone(value) { return structuredClone(value); }
function assertTerminalTransaction(store) {
  assert.deepEqual(store.terminalTransactionLog.slice(-3), [
    { kind: "run", inTransaction: true },
    { kind: "readModel", inTransaction: true },
    { kind: "event", inTransaction: true },
  ]);
}
async function waitFor(predicate, timeoutMs = 2_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("wait_for_timeout"); }
function assertProductSafe(value) { const serialized = JSON.stringify(value); for (const forbidden of ["executionPlanSnapshot", "executionInput", "executionOutput", "provider", "toolName", "artifactPath"]) assert.ok(!serialized.includes(forbidden), `exposed ${forbidden}`); }
function runnerError(code) { const error = new Error(code); error.code = code; return error; }
