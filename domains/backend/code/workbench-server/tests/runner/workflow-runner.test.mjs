import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  Errors,
  ExecutionRequestSchema,
  ImageGenerationResultSchema,
  RunEventSchema,
  RunExecutionSnapshotSchema,
} from "@looloomi/workbench-contracts";

import {
  createWorkflowRunner,
  WorkflowRunnerError,
} from "../../src/runner/index.mjs";
import { createStoreRunControl } from "../../src/runner/run-lease-coordinator.mjs";
import { createRepositoryWorkflowRunPersistence } from "./fixtures/repository-workflow-run-persistence.mjs";
import { CommandIntakeService } from "../../src/coordination/command-intake-service.mjs";
import { connectionApprovalSnapshot } from "../../src/connections/workspace-connection-service.mjs";
import { createRunStateTransitionEvent } from "../../src/runner/run-state-events.mjs";

const NOW = "2026-07-10T10:00:00.000Z";

test("WorkflowRunner persists review continuation, attempts, event order, and authoritative final", async () => {
  const fixture = createFixture();
  const run = await fixture.runner.startRun(startRequest("idem-approve"));
  assert.equal(run.status, "queued");
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");

  const waiting = await fixture.runner.getRun(run.runId);
  assert.equal(
    (await fixture.store.repositories.productCommands.getInternalByRun(run.runId)).status,
    "running",
  );
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
  assert.equal(
    (await fixture.store.repositories.productCommands.getInternalByRun(run.runId)).status,
    "completed",
  );
  const events = await fixture.runner.listEvents(run.runId, 0);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(fixture.store.terminalReadModelsBeforeEvents, true);
  assert.equal(terminalPublishedOutsideTransaction, true);
  assertTerminalTransaction(fixture.store);
  assertProductSafe(completed);
});

test("review presents the full candidate instead of silently approving a 1000 character preview", async()=>{
  const fixture=createFixture({workerExecutionOverrides:{async execute({input}){return{brief:input.topic};}}}),input=startRequest('long-review');input.inputs.topic='完整内容'.repeat(400);
  const run=await fixture.runner.startRun(input);
  await waitFor(async()=>(await fixture.runner.getRun(run.runId)).run.status==='waiting_review');
  const waiting=await fixture.runner.getRun(run.runId);
  assert.ok(waiting.readModel.reviewPacket.items[0].includes(input.inputs.topic));
  assert.equal(waiting.readModel.reviewPacket.contentTruncated,undefined);
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
  const command = await fixture.store.repositories.productCommands.getInternalByRun(run.runId);
  assert.equal(command.kind, "workflow_run");
  assert.equal(command.status, "accepted");
  assert.equal(command.userId, "system");
  const internalRun = await fixture.store.repositories.runs.getInternal(run.runId);
  assert.equal(internalRun.workspaceId, "workspace-local");
  assert.equal(internalRun.requestedBy, "system");
  assert.equal(
    Check(RunExecutionSnapshotSchema, internalRun.executionSnapshot),
    true,
    JSON.stringify([...Errors(RunExecutionSnapshotSchema, internalRun.executionSnapshot)]),
  );
  assert.equal(Object.hasOwn(internalRun.executionSnapshot, "workspaceId"), false);
  assert.equal(Object.hasOwn(internalRun.executionSnapshot, "requestedBy"), false);
  assert.equal(internalRun.executionSnapshot.loopVersionId, null);
  assert.equal(Object.hasOwn(run, "workspaceId"), false);
  assert.equal(Object.hasOwn(run, "requestedBy"), false);
});

test("WorkflowRunner preserves a resolved Loop version only inside the immutable execution snapshot", async () => {
  const fixture = createFixture({
    scheduleOnStart: false,
    loopVersionId: "loop-version-runner-7",
  });
  const run = await fixture.runner.startRun(startRequest("idem-loop-version-snapshot"));
  const internalRun = await fixture.store.repositories.runs.getInternal(run.runId);

  assert.equal(internalRun.executionSnapshot.loopVersionId, "loop-version-runner-7");
  assert.equal(
    Check(RunExecutionSnapshotSchema, internalRun.executionSnapshot),
    true,
    JSON.stringify([...Errors(RunExecutionSnapshotSchema, internalRun.executionSnapshot)]),
  );
});

test("WorkflowRunner rolls back ProductCommand intake when Run persistence fails", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  fixture.store.failNextRunInsert();

  await assert.rejects(
    fixture.runner.startRun(startRequest("idem-intake-rollback")),
    /fixture_run_insert_failed/,
  );

  assert.deepEqual(fixture.store.productCommandLog, []);
  assert.deepEqual(fixture.store.jobLog, []);
});

test("WorkflowRunner persists a Run companion in the same intake transaction", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  let companionPersistedInTransaction = false;

  const result = await fixture.runner.startRunWithCompanion(
    startRequest("idem-run-companion"),
    {
      kind: "agent-session",
      async persist({ run }) {
        companionPersistedInTransaction = fixture.store.inTransaction;
        return { sessionId: "agent-session-companion", source: { runId: run.runId } };
      },
    },
  );

  assert.equal(companionPersistedInTransaction, true);
  assert.equal(result.companion.source.runId, result.run.runId);
  assert.equal(fixture.store.productCommandLog.length, 1);
  assert.equal(fixture.store.jobLog.length, 1);
});

test("WorkflowRunner does not persist or schedule a Run when its transactional companion fails", async () => {
  const fixture = createFixture({ scheduleOnStart: false });

  await assert.rejects(
    fixture.runner.startRunWithCompanion(
      startRequest("idem-run-companion-failure"),
      {
        kind: "agent-session",
        async persist() {
          throw new Error("fixture_agent_session_insert_failed");
        },
      },
    ),
    /fixture_agent_session_insert_failed/,
  );

  assert.deepEqual(fixture.store.productCommandLog, []);
  assert.deepEqual(fixture.store.jobLog, []);
  assert.deepEqual(await fixture.store.repositories.runs.listByWorkflow("workflow-1"), []);
});

test("WorkflowRunner accepts non-user command authority only for Scheduler to Automation", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  await assert.rejects(
    fixture.runner.startRun({
      ...startRequest("idem-invalid-command-authority"),
      commandAuthority: {
        actorPrincipalId: "user-local",
        actorPrincipalKind: "user",
        effectivePrincipalId: "automation-local",
        effectivePrincipalKind: "automation",
      },
    }),
    (error) => error instanceof WorkflowRunnerError
      && error.code === "run_command_authority_kind_invalid",
  );
  assert.deepEqual(fixture.store.productCommandLog, []);
  assert.deepEqual(fixture.store.jobLog, []);
});

test("WorkflowRunner projects event-sourced Run status at a stable Session-page timestamp", async () => {
  let now = "2026-07-10T10:00:00.000Z";
  const fixture = createFixture({ scheduleOnStart: false, clock: () => now });
  const run = await fixture.runner.startRun(startRequest("idem-run-as-of"));
  const snapshotAt = now;

  now = "2026-07-10T10:00:01.000Z";
  await fixture.runner.recover();
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");

  assert.equal((await fixture.runner.getRun(run.runId)).run.status, "waiting_review");
  assert.equal((await fixture.runner.getRunAt(run.runId, snapshotAt)).run.status, "queued");
});

test("WorkflowRunner refuses to create a Run without every immutable pinned Skill version", async () => {
  const fixture = createFixture({ scheduleOnStart: false, skillVersions: [] });
  await assert.rejects(
    fixture.runner.startRun(startRequest("idem-incomplete-snapshot")),
    (error) => error?.code === "workflow_execution_snapshot_incomplete",
  );
  assert.equal((await fixture.store.repositories.runJobs.list()).length, 0);
});

test("WorkflowRunner lists bounded recent runs within the authenticated workspace only", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  const localA = await fixture.runner.startRun(startRequest("idem-recent-local-a"));
  const foreign = await fixture.runner.startRun(startRequest("idem-recent-foreign"));
  const localB = await fixture.runner.startRun(startRequest("idem-recent-local-b"));
  fixture.store.setRunWorkspace(foreign.runId, "workspace-foreign");

  const localRuns = await fixture.runner.listRecentRuns("workspace-local", { limit: 1 });
  assert.equal(localRuns.length, 1);
  assert.ok([localA.runId, localB.runId].includes(localRuns[0].runId));
  assert.equal(Object.hasOwn(localRuns[0], "executionSnapshot"), false);

  const foreignRuns = await fixture.runner.listRecentRuns("workspace-foreign", { limit: 3 });
  assert.deepEqual(foreignRuns.map((run) => run.runId), [foreign.runId]);
  assert.equal(Object.hasOwn(foreignRuns[0], "executionSnapshot"), false);
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

test("startup recovery drains and atomically imports an active legacy Run before execution", async () => {
  const initial = createFixture({ scheduleOnStart: false });
  const run = await initial.runner.startRun(startRequest("idem-legacy-cutover"));
  initial.store.simulateLegacyRun(run.runId);

  const restarted = createFixture({ store: initial.store, ids: initial.ids, workerId: "legacy-cutover-worker" });
  const recovery = await restarted.runner.recover();
  assert.deepEqual(recovery.recoveredRunIds, [run.runId]);
  await waitFor(async () => (await restarted.runner.getRun(run.runId)).run.status === "waiting_review");

  const internal = await initial.store.repositories.runs.getInternal(run.runId);
  assert.equal(internal.stateModelVersion, 2);
  assert.equal(internal.legacyImportSourceHash, undefined);
  const stateEvents = initial.store.stateEventLog.filter((event) => event.runId === run.runId);
  assert.equal(stateEvents[0].transitionType, "run_state_imported");
  assert.match(stateEvents[0].payload.sourceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(initial.store.jobLog[0].fence, 2);
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

test("WorkflowRunner consumes the injected product run-control port for its worker lease", async () => {
  const store = createStore();
  const calls = [];
  const runControl = {
    async claimRunJob(runId, input) {
      calls.push("claim");
      return store.repositories.runJobs.claimByRun(runId, input);
    },
    async acquireLease(input) {
      calls.push("acquire");
      return store.repositories.runLeases.acquire(input);
    },
    async releaseLease(runId, input) {
      calls.push("release");
      return store.repositories.runLeases.release(runId, input);
    },
    async abandonRunJob(runId, input) {
      calls.push("abandon");
      return store.repositories.runJobs.abandonClaimByRun(runId, input);
    },
  };
  const fixture = createFixture({ store, scheduleOnStart: false, runControl });
  const run = await fixture.runner.startRun(startRequest("idem-injected-run-control"));
  await fixture.runner.recover();
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
  assert.deepEqual(calls.slice(0, 2), ["claim", "acquire"]);
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
  assert.deepEqual(
    Object.keys(detail.readModel.failure).sort(),
    ["code", "message", "retryable"],
    "an unknown external effect must remain inside the strict product-safe failure contract",
  );
  assert.equal(workerA.invocationInputs.length + workerB.invocationInputs.length, 0);
  assert.equal(terminalEvents.length, 1);
  assert.equal(initial.store.jobLog[0].fence, 2);
  assert.deepEqual((await workerB.runner.recover()).recoveredRunIds, []);
  await workerARecovery;
});

test("receipt recovery uses the exact original effect without calling a model or issuing a fresh write", async () => {
  const plan = makePlan();
  plan.steps[1].capabilities = {
    toolAllowlist: ["lark.task.create"],
    connectionIds: ["lark.task"],
    network: false,
    filesystem: "none",
    externalActions: true,
  };
  const connectionBindings = [{
    requirementId: "lark.task",
    connectionId: "connection-effect-recovery",
    connectionRevision: 3,
    capabilityKey: "lark.task",
    driverKey: "lark",
    validationExpiresAt: "2099-01-01T00:00:00.000Z",
  }];
  const initial = createFixture({
    scheduleOnStart: false,
    plan,
    connectionBindings,
  });
  const run = await initial.runner.startRun(startRequest("idem-effect-receipt-recovery"));
  let signalFaultReached;
  const faultReached = new Promise((resolve) => { signalFaultReached = resolve; });
  let resumeFault;
  const blocked = new Promise((resolve) => { resumeFault = resolve; });
  const workerA = createFixture({
    store: initial.store,
    ids: initial.ids,
    plan,
    connectionBindings,
    workerId: "worker-effect-original",
    executionBroker: {
      async execute() { throw new Error("original invocation must remain interrupted"); },
      async cancel() { return { status: "effect_outcome_unknown" }; },
    },
    faultInjector: async (boundary) => {
      if (boundary !== "post-attempt-invocation-persistence") return;
      signalFaultReached();
      await blocked;
    },
  });
  const workerARecovery = workerA.runner.recover();
  await faultReached;
  const originalAttempt = (await initial.store.repositories.runNodeAttempts.listInternalByRun(run.runId))
    .find((attempt) => attempt.nodeId === "node-skill");
  const approval = initial.connectionBindings[0];
  const effectId = "effect-original-task-create-1";
  let providerWrites = 1;
  initial.store.simulateExternalEffectReceipt({
    schemaVersion: "workbench-internal-v1",
    workspaceId: "workspace-local",
    effectId,
    action: "lark.task.create",
    argumentDigest: `sha256:${"e".repeat(64)}`,
    actorId: "system",
    skillName: "Fixture Skill",
    controllerId: run.runId,
    nodeId: "node-skill",
    ...approval,
    invocationId: originalAttempt.invocationId,
    attemptId: originalAttempt.nodeRunId,
    driverCapabilities: { idempotency: "provider_key", reconcile: "query", cancel: "none" },
    status: "succeeded",
    output: { brief: "Original provider result" },
    receipt: { receiptId: `lark-effect:${effectId}` },
    createdAt: NOW,
    updatedAt: NOW,
  });
  initial.store.expireLease(run.runId);

  let modelCalls = 0;
  let recoveryCalls = 0;
  const workerB = createFixture({
    store: initial.store,
    ids: initial.ids,
    plan,
    connectionBindings,
    workerId: "worker-effect-recovery",
    executionBroker: {
      async execute(request) {
        if (!request.metadata?.effectRecovery) {
          modelCalls += 1;
          providerWrites += 1;
          return { status: "completed", output: { brief: "Changed model arguments" } };
        }
        recoveryCalls += 1;
        assert.deepEqual(request.metadata.effectRecovery, {
          schemaVersion: "workbench-effect-recovery-v1",
          effectId,
          action: "lark.task.create",
          connectionId: approval.connectionId,
          requirementId: approval.requirementId,
          approvalFingerprint: approval.approvalFingerprint,
          credentialBindingFingerprint: approval.credentialBindingFingerprint,
          driverBackend: approval.driverBackend,
          sourceInvocationId: originalAttempt.invocationId,
          sourceAttemptId: originalAttempt.nodeRunId,
        });
        return {
          status: "completed",
          output: { brief: "Original provider result" },
          evidence: [{
            requirementId: `effect-recovery:${effectId}`,
            kind: "validation",
            ref: effectId,
          }],
          usage: { steps: 1, modelRequests: 0 },
        };
      },
      async cancel() { return { status: "effect_outcome_unknown" }; },
    },
  });
  assert.deepEqual((await workerB.runner.recover()).recoveredRunIds, [run.runId]);
  await waitFor(async () => (await workerB.runner.getRun(run.runId)).run.status === "waiting_review");
  resumeFault();
  await workerARecovery;

  const detail = await workerB.runner.getRun(run.runId);
  const attempts = detail.readModel.nodeTimeline.filter((attempt) => attempt.nodeId === "node-skill");
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["effect_outcome_unknown", "completed"]);
  assert.equal(attempts[1].summary, "Draft completed from its durable effect receipt.");
  assert.equal(modelCalls, 0, "the model path must never be called during receipt recovery");
  assert.equal(providerWrites, 1, "receipt recovery must not issue a second provider write");
  assert.equal(recoveryCalls, 1);
  const recoveryEvents = (await workerB.runner.listEvents(run.runId))
    .filter((event) => event.type.startsWith("node.effect_recovery_"));
  assert.deepEqual(
    recoveryEvents.map((event) => event.type),
    ["node.effect_recovery_started", "node.effect_recovery_completed"],
  );
  for (const event of recoveryEvents) {
    assert.equal(Check(RunEventSchema, event), true);
  }
});

test("WorkflowRunner renews its durable lease while a Skill invocation is still running", async () => {
  const fixture = createFixture({ invocationDelayMs: 1_100, leaseDurationMs: 1_000 });
  const run = await fixture.runner.startRun(startRequest("idem-lease-heartbeat"));

  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review", 3_000);

  assert.ok(fixture.store.heartbeatLog.length >= 2);
  assert.equal(fixture.store.jobLog[0].status, "paused");
});

test("WorkflowRunner leaves execution state untouched when its lease heartbeat is fenced", async () => {
  const fixture = createFixture({
    leaseDurationMs: 1_000,
    workerExecutionOverrides: {
      async execute({ signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  });
  fixture.store.rejectNextHeartbeat();

  const run = await fixture.runner.startRun(startRequest("idem-lease-heartbeat-fenced"));
  await waitFor(async () => fixture.store.rejectedHeartbeatCount === 1, 1_000);

  const internalRun = await fixture.store.repositories.runs.getInternal(run.runId);
  const attempts = await fixture.store.repositories.runNodeAttempts.listInternalByRun(run.runId);
  const skillAttempt = attempts.find((attempt) => attempt.nodeId === "node-skill");
  assert.equal(internalRun.status, "running");
  assert.equal(skillAttempt.status, "running");
  assert.equal(["started", "running"].includes(skillAttempt.invocationStatus), true);
  assert.equal(skillAttempt.completedAt, null);
});

test("WorkflowRunner retries a transient lease heartbeat failure before lease expiry", async () => {
  const fixture = createFixture({ invocationDelayMs: 1_100, leaseDurationMs: 1_000 });
  fixture.store.failNextHeartbeat();

  const run = await fixture.runner.startRun(startRequest("idem-lease-heartbeat-transient"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review", 3_000);

  assert.equal(fixture.store.failedHeartbeatCount, 1);
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
  initial.store.setProductCommandStatus(run.runId, "accepted");
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
  assert.equal(
    (await initial.store.repositories.productCommands.getInternalByRun(run.runId)).status,
    "completed",
  );
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

test("invalid revision requests leave the current review and execution untouched", async () => {
  for (const configured of [true, false]) {
    const revision = makeRevision();
    if (!configured) delete revision.graph.nodes.find(node => node.nodeId === 'node-review').configuration.revisionTarget;
    const fixture = createFixture({ revision });
    const run = await fixture.runner.startRun(startRequest('invalid-revision'));
    await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === 'waiting_review');
    const before = await fixture.runner.getRun(run.runId);
    await assert.rejects(fixture.runner.submitReviewDecision({
      runId: run.runId, nodeId: 'node-review', decision: 'revise',
      requestedChanges: configured ? ['  '] : ['Change the result.'],
      idempotencyKey: 'invalid-change', decidedBy: 'user-local',
    }), { code: configured ? 'review_changes_required' : 'review_feedback_target_missing' });
    const after = await fixture.runner.getRun(run.runId);
    assert.equal(after.run.status, 'waiting_review');
    assert.deepEqual(after.run.nodeRuns, before.run.nodeRuns);
    assert.equal(fixture.invocationInputs.length, 1);
  }
});

test("WorkflowRunner revise only retries the ReviewGate direct upstream Skill and reject cancels", async () => {
  const fixture = createFixture();
  const revised = await fixture.runner.startRun(startRequest("idem-revise"));
  await waitFor(async () => (await fixture.runner.getRun(revised.runId)).run.status === "waiting_review");
  const oldReview=(await fixture.runner.getRun(revised.runId)).run.nodeRuns.find(n=>n.status==="waiting_review").nodeRunId;
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
  await assert.rejects(fixture.runner.submitReviewDecision({
    runId:revised.runId,nodeId:'node-review',decision:'approve',requestedChanges:[],
    expectedNodeRunId:oldReview,idempotencyKey:'stale-decision',decidedBy:'user-local',
  }),{code:'review_stale'});
  await fixture.runner.submitReviewDecision({
    runId: revised.runId,
    expectedNodeRunId:waiting.run.nodeRuns.find(n=>n.status==='waiting_review').nodeRunId,
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
  const replay = await fixture.runner.startRun({ ...request, requestId: "request-runner-retry" });
  assert.equal(replay.runId, first.runId);
  const peer = await fixture.runner.startRun({ ...request, requestedBy: "user-peer" });
  assert.notEqual(peer.runId, first.runId);
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
  const fixture = createFixture({
    skillVersions: [publishedFixtureSkillVersion()],
    loopVersionId: "loop-version-retry-3",
  });
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
  assert.equal(
    (await fixture.store.repositories.productCommands.getInternalByRun(first.runId)).status,
    "cancelled",
  );
  fixture.store.setFoldedRunAuthority(first.runId, {
    workspaceId: "workspace-event-copy-must-not-win",
    requestedBy: "user-event-copy-must-not-win",
  });

  const retried = await fixture.runner.retryRun({
    runId: first.runId,
    idempotencyKey: "idem-command-retry",
    requestedBy: "user-local",
    reason: "Try the same revision again.",
  });
  assert.notEqual(retried.runId, first.runId);
  await waitFor(async () => (await fixture.runner.getRun(retried.runId)).run.status === "waiting_review");
  assert.deepEqual(fixture.store.commandLog.map((entry) => entry.command), ["cancel", "retry"]);
  const retriedInternal = await fixture.store.repositories.runs.getInternal(retried.runId);
  assert.equal(retriedInternal.workspaceId, "workspace-local");
  assert.equal(retriedInternal.requestedBy, "user-local");
  assert.equal(retriedInternal.executionSnapshot.loopVersionId, "loop-version-retry-3");
  assert.equal(Object.hasOwn(retriedInternal.executionSnapshot, "requestedBy"), false);
  assert.equal(
    (await fixture.store.repositories.productCommands.getInternalByRun(first.runId)).status,
    "cancelled",
  );
  assert.equal(
    (await fixture.store.repositories.productCommands.getInternalByRun(retried.runId)).status,
    "running",
  );
});

test("WorkflowRunner routes PostgreSQL queued cancellation through the dedicated command intake", async () => {
  const accepted = [];
  const fixture = createFixture({
    scheduleOnStart: false,
    cancellationCommandIntake: {
      async accept({ principal, command }) {
        accepted.push({ principal: structuredClone(principal), command: structuredClone(command) });
        return {
          run: {
            runId: command.runId,
            status: "cancelled",
            currentNodeId: null,
            updatedAt: NOW,
          },
          event: {
            schemaVersion: "workbench-run-event-v1",
            eventId: "queued-cancel-event",
            runId: command.runId,
            sequence: 2,
            type: "run.cancelled",
            status: "cancelled",
            nodeId: null,
            summary: "Run cancelled before execution started.",
            occurredAt: NOW,
          },
        };
      },
    },
  });
  Object.defineProperty(fixture.store, "persistenceDriver", { value: "postgres" });
  fixture.store.repositories.runCommands.insert = async () => {
    throw new Error("legacy_run_command_owner_reached");
  };
  const first = await fixture.runner.startRun(startRequest("postgres-cancel-queued"));
  const cancelled = await fixture.runner.cancelRun({
    runId: first.runId,
    idempotencyKey: "postgres-cancel-queued-command",
    requestedBy: "user-local",
    reason: "Stop before execution.",
    authorizationDecisionId: "decision-queued-cancel",
    authorizationScopeId: "scope-local",
    authorizationAction: "workflow_run_cancel",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(accepted, [{
    principal: { workspaceId: "workspace-local", userId: "user-local" },
    command: {
      commandId: accepted[0].command.commandId,
      workspaceId: "workspace-local",
      scopeId: "scope-local",
      authorizationDecisionId: "decision-queued-cancel",
      argumentDigest: accepted[0].command.argumentDigest,
      runId: first.runId,
      requestedBy: "user-local",
      reason: "Stop before execution.",
    },
  }]);
  assert.match(accepted[0].command.argumentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fixture.store.commandLog.length, 0);
});

test("WorkflowRunner rolls back retry audit and ProductCommand when the replacement Run fails", async () => {
  const fixture = createFixture({ scheduleOnStart: false });
  const first = await fixture.runner.startRun(startRequest("idem-retry-atomic-first"));
  const cancelled = await fixture.runner.cancelRun({
    runId: first.runId,
    idempotencyKey: "idem-retry-atomic-cancel",
    requestedBy: "user-local",
  });
  assert.equal(cancelled.status, "cancelled");
  fixture.store.failNextRunInsert();

  await assert.rejects(
    fixture.runner.retryRun({
      runId: first.runId,
      idempotencyKey: "idem-retry-atomic-failure",
      requestedBy: "user-local",
      reason: "Retry after failure.",
    }),
    /fixture_run_insert_failed/,
  );

  assert.deepEqual(fixture.store.commandLog.map((entry) => entry.command), ["cancel"]);
  assert.equal(fixture.store.productCommandLog.length, 1);
  assert.deepEqual(fixture.store.jobLog.map((entry) => entry.runId), [first.runId]);
});

test("WorkflowRunner blocks retry when an external effect in the retry lineage is unresolved or already applied", async () => {
  for (const [status, expectedCode] of [
    ["outcome_unknown", "run_retry_effect_outcome_unresolved"],
    ["succeeded", "run_retry_external_effect_already_applied"],
  ]) {
    const fixture = createFixture({ skillVersions: [publishedFixtureSkillVersion()] });
    const first = await fixture.runner.startRun(startRequest(`idem-effect-${status}`));
    await waitFor(async () => (await fixture.runner.getRun(first.runId)).run.status === "waiting_review");
    await fixture.runner.cancelRun({
      runId: first.runId,
      idempotencyKey: `idem-effect-cancel-${status}`,
      requestedBy: "user-local",
    });
    fixture.store.simulateExternalEffectReceipt({
      workspaceId: "workspace-local",
      effectId: `effect-${status}`,
      controllerId: first.runId,
      status,
      createdAt: NOW,
    });

    await assert.rejects(
      fixture.runner.retryRun({
        runId: first.runId,
        idempotencyKey: `idem-effect-retry-${status}`,
        requestedBy: "user-local",
      }),
      (error) => error?.code === expectedCode
        && error?.details?.effectId === `effect-${status}`,
    );
    assert.deepEqual(fixture.store.commandLog.map((entry) => entry.command), ["cancel"]);
  }
});

test("WorkflowRunner snapshots governed Connection revisions and restores them for execution and retry", async () => {
  const plan = makePlan();
  Object.assign(plan.steps[1], {
    capabilities: {
      toolAllowlist: ["lark.docs.read"],
      connectionIds: ["lark.docs"],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
  });
  const requests = [];
  const connectionBindings = [{
    requirementId: "lark.docs",
    connectionId: "connection-1",
    connectionRevision: 7,
    capabilityKey: "lark.docs",
    driverKey: "lark",
    validationExpiresAt: "2026-08-10T10:00:00.000Z",
  }];
  const fixture = createFixture({
    plan,
    connectionBindings,
    executionBroker: {
      async execute(request) {
        requests.push(structuredClone(request));
        return {
          status: "completed",
          output: { brief: `Draft ${requests.length}: product-safe workflow` },
          summary: "Completed.",
        };
      },
      async cancel() {},
    },
  });
  const first = await fixture.runner.startRun({
    ...startRequest("idem-connection-snapshot"),
    requestedBy: "user-local",
  });
  await waitFor(async () => (await fixture.runner.getRun(first.runId)).run.status === "waiting_review");
  const firstInternal = await fixture.store.repositories.runs.getInternal(first.runId);
  assert.deepEqual(firstInternal.executionSnapshot.connectionBindings, fixture.connectionBindings);
  assert.deepEqual(requests[0].capabilities.connectionIds, ["connection-1"]);
  assert.deepEqual(requests[0].metadata.connectionSnapshots, fixture.connectionBindings);

  await fixture.runner.cancelRun({
    runId: first.runId,
    idempotencyKey: "idem-connection-cancel",
    requestedBy: "user-local",
  });
  const retry = await fixture.runner.retryRun({
    runId: first.runId,
    idempotencyKey: "idem-connection-retry",
    requestedBy: "user-local",
  });
  await waitFor(async () => (await fixture.runner.getRun(retry.runId)).run.status === "waiting_review");
  assert.deepEqual(requests[1].metadata.connectionSnapshots, fixture.connectionBindings);
});

test("WorkflowRunner keeps Review waiting and records no decision when the approved Connection drifts", async () => {
  const plan = makePlan();
  plan.steps[1].capabilities = {
    toolAllowlist: ["lark.docs.read"],
    connectionIds: ["lark.docs"],
    network: false,
    filesystem: "none",
    externalActions: false,
  };
  let calls = 0;
  const fixture = createFixture({
    plan,
    connectionBindings: [{
      requirementId: "lark.docs",
      connectionId: "connection-review",
      connectionRevision: 3,
      capabilityKey: "lark.docs",
      driverKey: "lark",
      validationExpiresAt: "2099-01-01T00:00:00.000Z",
    }],
    executionBroker: {
      async execute() {
        calls += 1;
        return { status: "completed", output: { brief: "Draft" }, summary: "Completed." };
      },
      async cancel() {},
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-review-connection-drift"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
  fixture.store.patchConnection("connection-review", {
    revision: 4,
    validation: {
      status: "valid",
      principal: "replacement-account",
      scopes: ["fixture:read"],
      effects: ["read", "write"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });

  await assert.rejects(
    fixture.runner.submitReviewDecision({
      runId: run.runId,
      nodeId: "node-review",
      decision: "approve",
      idempotencyKey: "idem-review-connection-drift-decision",
      decidedBy: "user-local",
    }),
    (error) => error?.code === "connection_reapproval_required"
      && error?.details?.stage === "review_decision",
  );
  const detail = await fixture.runner.getRun(run.runId);
  assert.equal(detail.run.status, "waiting_review");
  assert.equal(detail.readModel.reviewDecisions.length, 0);
  assert.equal(calls, 1);
});

test("WorkflowRunner blocks retry and startup recovery after Connection approval drift", async () => {
  const plan = makePlan();
  plan.steps[1].capabilities = {
    toolAllowlist: ["lark.docs.read"],
    connectionIds: ["lark.docs"],
    network: false,
    filesystem: "none",
    externalActions: false,
  };
  const binding = {
    requirementId: "lark.docs",
    connectionId: "connection-recovery",
    connectionRevision: 5,
    capabilityKey: "lark.docs",
    driverKey: "lark",
    validationExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const retryFixture = createFixture({ plan, connectionBindings: [binding] });
  const retrySource = await retryFixture.runner.startRun(startRequest("idem-retry-connection-drift"));
  await waitFor(async () => (await retryFixture.runner.getRun(retrySource.runId)).run.status === "waiting_review");
  await retryFixture.runner.cancelRun({
    runId: retrySource.runId,
    idempotencyKey: "idem-retry-connection-drift-cancel",
    requestedBy: "user-local",
  });
  retryFixture.store.patchConnection(binding.connectionId, { revision: 6 });
  await assert.rejects(
    retryFixture.runner.retryRun({
      runId: retrySource.runId,
      idempotencyKey: "idem-retry-connection-drift-command",
      requestedBy: "user-local",
    }),
    (error) => error?.code === "connection_reapproval_required"
      && error?.details?.stage === "run_recovery",
  );
  assert.deepEqual(retryFixture.store.commandLog.map((entry) => entry.command), ["cancel"]);

  let recoveryCalls = 0;
  const recoveryFixture = createFixture({
    plan,
    connectionBindings: [binding],
    scheduleOnStart: false,
    executionBroker: {
      async execute() { recoveryCalls += 1; },
      async cancel() {},
    },
  });
  await recoveryFixture.runner.startRun(startRequest("idem-recovery-connection-drift"));
  recoveryFixture.store.patchConnection(binding.connectionId, { revision: 6 });
  await assert.rejects(
    recoveryFixture.runner.recover(),
    (error) => error?.code === "connection_reapproval_required"
      && error?.details?.stage === "run_recovery",
  );
  assert.equal(recoveryCalls, 0);
});

test("WorkflowRunner keeps legacy Connection Runs readable but refuses safe replay", async () => {
  const plan = makePlan();
  plan.steps[1].capabilities = {
    toolAllowlist: ["lark.docs.read"],
    connectionIds: ["lark.docs"],
    network: false,
    filesystem: "none",
    externalActions: false,
  };
  const fixture = createFixture({
    plan,
    connectionBindings: [{
      requirementId: "lark.docs",
      connectionId: "connection-legacy",
      connectionRevision: 2,
      capabilityKey: "lark.docs",
      driverKey: "lark",
      validationExpiresAt: "2099-01-01T00:00:00.000Z",
    }],
  });
  const run = await fixture.runner.startRun(startRequest("idem-legacy-connection-snapshot"));
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");
  await fixture.runner.cancelRun({
    runId: run.runId,
    idempotencyKey: "idem-legacy-connection-cancel",
    requestedBy: "user-local",
  });
  fixture.store.stripRunConnectionApproval(run.runId);

  assert.equal((await fixture.runner.getRun(run.runId)).run.status, "cancelled");
  await assert.rejects(
    fixture.runner.retryRun({
      runId: run.runId,
      idempotencyKey: "idem-legacy-connection-retry",
      requestedBy: "user-local",
    }),
    (error) => error?.code === "run_connection_snapshot_unavailable",
  );
  assert.deepEqual(fixture.store.commandLog.map((entry) => entry.command), ["cancel"]);
});

test("WorkflowRunner does not abort an active invocation when the cancel command cannot be persisted", async () => {
  let invocationStarted;
  const started = new Promise((resolve) => { invocationStarted = resolve; });
  let finishInvocation;
  const finish = new Promise((resolve) => { finishInvocation = resolve; });
  let aborted = false;
  const fixture = createFixture({
    workerExecutionOverrides: {
      async execute({ signal }) {
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
    workerExecutionOverrides: {
      async execute({ input }) {
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
  assert.equal(requests[0].metadata.requestedBy, "system");
  assert.equal(requests[0].metadata.skillName, "Fixture Skill");
  assert.equal(requests[0].metadata.externalActionConfirmed, false);
});

test("WorkflowRunner fails closed and preserves the failure across recovery and retry when the Broker is unavailable", async () => {
  const fixture = createFixture({
    executionBroker: null,
    scheduleOnStart: false,
  });
  const run = await fixture.runner.startRun(startRequest("idem-broker-unavailable"));
  assert.equal((await fixture.runner.getRun(run.runId)).run.status, "queued");

  assert.deepEqual((await fixture.runner.recover()).recoveredRunIds, [run.runId]);
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "failed");

  const failed = await fixture.runner.getRun(run.runId);
  assert.equal(failed.readModel.failure.code, "workflow_execution_broker_unavailable");
  assert.equal(
    failed.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === "node-skill").failure.code,
    "workflow_execution_broker_unavailable",
  );
  assert.equal(fixture.invocationInputs.length, 0);
  assert.deepEqual(
    (await fixture.runner.listEvents(run.runId)).slice(-2).map((event) => event.type),
    ["node.failed", "run.failed"],
  );

  const retry = await fixture.runner.retryRun({
    runId: run.runId,
    idempotencyKey: "idem-broker-unavailable-retry",
    requestedBy: "user-local",
    reason: "Retry after checking the worker control plane.",
  });
  assert.deepEqual((await fixture.runner.recover()).recoveredRunIds, [retry.runId]);
  await waitFor(async () => (await fixture.runner.getRun(retry.runId)).run.status === "failed");
  assert.equal(
    (await fixture.runner.getRun(retry.runId)).readModel.failure.code,
    "workflow_execution_broker_unavailable",
  );
  assert.equal(fixture.invocationInputs.length, 0);
});

test("WorkflowRunner preserves an unknown external effect outcome instead of claiming cancellation", async () => {
  const plan = makePlan();
  plan.steps[1].capabilities = {
    toolAllowlist: ["lark.task.create"],
    connectionIds: ["connection-lark"],
    network: false,
    filesystem: "none",
    externalActions: true,
  };
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const fixture = createFixture({
    plan,
    connectionBindings: [{
      requirementId: "connection-lark",
      connectionId: "connection-lark",
      connectionRevision: 1,
      capabilityKey: "lark.task.create",
      driverKey: "lark",
      validationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }],
    executionBroker: {
      async execute(executionRequest, { signal }) {
        entered(executionRequest.invocationId);
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { status: "completed", output: { brief: "late result" }, summary: "late" };
      },
      async cancel() { return { status: "effect_outcome_unknown" }; },
    },
  });
  const run = await fixture.runner.startRun(startRequest("idem-external-effect-cancel"));
  await started;
  const cancelled = await fixture.runner.cancelRun({
    runId: run.runId,
    idempotencyKey: "idem-external-effect-cancel-command",
    requestedBy: "user-local",
  });

  assert.equal(cancelled.status, "effect_outcome_unknown");
  const detail = await fixture.runner.getRun(run.runId);
  assert.equal(detail.readModel.status, "effect_outcome_unknown");
  assert.equal(detail.readModel.failure.code, "effect_outcome_unknown");
  assert.equal(detail.run.nodeRuns.find((nodeRun) => nodeRun.nodeId === "node-skill").status, "effect_outcome_unknown");
  assert.equal(fixture.store.jobLog[0].status, "effect_outcome_unknown");
  assert.deepEqual(
    (await fixture.runner.listEvents(run.runId)).filter((event) => event.type.startsWith("run.")).map((event) => event.type).slice(-2),
    ["run.cancellation_requested", "run.effect_outcome_unknown"],
  );
});

test("startup recovery settles a durably requested cancellation from the Broker result", async () => {
  let invocationId;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let releaseCancel;
  const cancellation = new Promise((resolve) => { releaseCancel = resolve; });
  const initial = createFixture({
    executionBroker: {
      async execute(executionRequest, { signal }) {
        invocationId = executionRequest.invocationId;
        entered();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { status: "cancelled" };
      },
      async cancel() { return cancellation; },
    },
  });
  const run = await initial.runner.startRun(startRequest("idem-recover-cancellation"));
  await started;
  const pendingCancel = initial.runner.cancelRun({
    runId: run.runId,
    idempotencyKey: "idem-recover-cancellation-command",
    requestedBy: "user-local",
  });
  await waitFor(async () => (await initial.runner.getRun(run.runId)).run.status === "cancellation_requested");
  assert.equal(
    (await initial.store.repositories.productCommands.getInternalByRun(run.runId)).status,
    "cancellation_requested",
  );

  const restarted = createFixture({
    store: initial.store,
    ids: initial.ids,
    workerId: "cancel-recovery-worker",
    executionBroker: {
      async execute() { throw new Error("must_not_execute"); },
      async getInvocation(candidate) {
        assert.equal(candidate, invocationId);
        return { result: { status: "partial" } };
      },
      async cancel() { throw new Error("settled_result_should_be_reused"); },
    },
  });
  const recovered = await restarted.runner.recover();
  assert.deepEqual(recovered.recoveredRunIds, []);
  assert.equal((await restarted.runner.getRun(run.runId)).run.status, "partial");
  assert.equal(initial.store.jobLog[0].status, "partial");

  releaseCancel({ status: "partial" });
  assert.equal((await pendingCancel).status, "partial");
  const terminalEvents = (await restarted.runner.listEvents(run.runId))
    .filter((event) => event.type === "run.partial");
  assert.equal(terminalEvents.length, 1);
});

test("WorkflowRunner keeps Skill file inputs out of JSON input and dispatches only immutable material refs", async () => {
  const requests = [];
  const attachment = {
    attachmentId: "attachment-run-1",
    version: 1,
    contentHash: `sha256:${"d".repeat(64)}`,
    mediaType: "text/markdown",
  };
  const fixture = createFixture({
    skillInputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", minLength: 1 },
        source_file: {
          type: "string",
          format: "attachment",
          acceptedMediaTypes: ["text/markdown"],
        },
      },
      required: ["topic", "source_file"],
      additionalProperties: false,
    },
    executionBroker: {
      async execute(executionRequest) {
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
  const run = await fixture.runner.startRun({
    ...startRequest("idem-broker-material"),
    materialBindings: [{
      nodeId: "node-skill",
      binding: {
        materialKey: "source_file",
        source: { kind: "attachment", attachment },
      },
    }],
  });
  await waitFor(async () => (await fixture.runner.getRun(run.runId)).run.status === "waiting_review");

  assert.deepEqual(requests[0].input, { topic: "product-safe workflow" });
  assert.deepEqual(requests[0].metadata.materialBindings, [{
    materialKey: "source_file",
    source: { kind: "attachment", attachment },
  }]);
  assert.deepEqual(requests[0].metadata.materialRequirements, [{
    materialKey: "source_file",
    acceptedMediaTypes: ["text/markdown"],
  }]);
  assert.doesNotMatch(JSON.stringify(await fixture.runner.getRun(run.runId)), /attachment-run-1/);

  const missingFixture = createFixture({
    skillInputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", minLength: 1 },
        source_file: { type: "string", format: "attachment" },
      },
      required: ["topic", "source_file"],
      additionalProperties: false,
    },
    executionBroker: { async execute() { throw new Error("must_not_execute"); } },
  });
  const missing = await missingFixture.runner.startRun(startRequest("idem-broker-material-missing"));
  await waitFor(async () => (await missingFixture.runner.getRun(missing.runId)).run.status === "failed");
  assert.equal(
    (await missingFixture.runner.getRun(missing.runId)).readModel.failure.code,
    "run_material_bindings_required",
  );
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
  workerExecutionOverrides = {},
  skillVersions = null,
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
  runControl,
  executionBroker,
  cancellationCommandIntake = null,
  connectionBindings = [],
  loopVersionId = null,
  clock = () => NOW,
} = {}) {
  const runPersistence = createRepositoryWorkflowRunPersistence({ store });
  const governedConnectionBindings = connectionBindings.map((binding) => {
    const connection = {
      schemaVersion: "workbench-v1",
      connectionId: binding.connectionId,
      workspaceId: "workspace-local",
      revision: binding.connectionRevision ?? 1,
      capabilityKey: binding.capabilityKey ?? binding.requirementId,
      driverKey: binding.driverKey ?? "lark",
      driverBackend: "production",
      credentialState: "bound",
      credentialBindingFingerprint: binding.credentialBindingFingerprint
        ?? `sha256:${"a".repeat(64)}`,
      status: "connected",
      validation: {
        status: "valid",
        principal: binding.principal ?? `${binding.connectionId}-principal`,
        scopes: ["fixture:read"],
        effects: ["read", "write"],
        expiresAt: binding.validationExpiresAt ?? "2099-01-01T00:00:00.000Z",
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.setConnection(connection);
    return connectionApprovalSnapshot(connection, {
      requirementId: binding.requirementId,
      now: Date.parse(clock()),
    });
  });
  const immutableSkillVersions = skillVersions ?? [{
    ...publishedFixtureSkillVersion(),
    inputSchema: structuredClone(skillInputSchema),
    outputSchema: structuredClone(skillOutputSchema),
    executionRef: structuredClone(skillExecutionRef),
  }];
  let invocations = 0;
  const invocationInputs = [];
  const workerExecution = {
    async execute({ input, workspaceId }) {
      assert.equal(workspaceId, "workspace-local");
      invocationInputs.push(clone(input));
      if (invocations === 0) assert.deepEqual(input, { topic: "product-safe workflow" });
      if (invocationDelayMs) await new Promise((resolve) => setTimeout(resolve, invocationDelayMs));
      invocations += 1;
      return { brief: `Draft ${invocations}: ${input.topic}` };
    },
    ...workerExecutionOverrides,
  };
  const agentRuntime = {
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
  const productExecutionBroker = executionBroker === undefined ? {
    async execute(request, { signal }) {
      const output = await workerExecution.execute({
        invocationId: request.invocationId,
        workspaceId: request.workspaceId,
        executionRef: request.metadata.executionRef,
        input: structuredClone(request.input),
        timeoutMs: request.limits.timeoutMs,
        signal,
      });
      return {
        schemaVersion: "workbench-execution-fabric-v1",
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        status: "completed",
        isolation: request.isolation,
        output,
        summary: "completed",
        evidence: [],
        usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
        startedAt: NOW,
        finishedAt: NOW,
      };
    },
  } : executionBroker;
  const runner = createWorkflowRunner({
    store,
    commandIntake: new CommandIntakeService({ store, now: clock }),
    cancellationCommandIntake,
    idFactory: ids.next,
    clock,
    resolveExecution: async ({ workflowId, revisionId }) => {
      assert.equal(workflowId, revision.workflowId);
      assert.equal(revisionId, revision.revisionId);
      return {
        revision,
        compileResult: { status: "ready", executionPlan: plan },
        workspaceId: "workspace-local",
        loopVersionId,
        skillVersions: immutableSkillVersions,
        connectionBindings: structuredClone(governedConnectionBindings),
        connectionIds: [...new Set(governedConnectionBindings.map((binding) => binding.connectionId))],
        skills: {
          "skill-draft:1": {
            definition: {
              name: "Fixture Skill",
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
    executionBroker: productExecutionBroker,
    scheduleOnStart,
    workerId,
    leaseDurationMs,
    faultInjector,
    runControl: Object.freeze({ ...createStoreRunControl(store), ...(runControl ?? {}) }),
    runPersistence,
  });
  return { runner, store, ids, invocationInputs, connectionBindings: governedConnectionBindings };
}

function makeRevision() {
  const base = { title: "", description: "", position: { x: 0, y: 0 }, reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 30, display: { collapsed: false } };
  const port = (portId) => ({ portId, name: portId, schema: { type: "string", minLength: 1 }, required: true });
  return {
    workflowId: "workflow-runner", revisionId: "revision-runner-1",
    inputForm: {
      fields: [{
        fieldId: "topic",
        label: "Topic",
        description: "The workflow topic.",
        schema: { type: "string", minLength: 1 },
        required: true,
      }],
    },
    outputDefinition: {
      primary: { nodeId: "node-output", portId: "final" },
      expectedOutputs: [{
        nodeId: "node-output",
        portId: "final",
        label: "Final",
        mediaType: "text/markdown",
      }],
    },
    runSettings: {
      maxParallelism: 1,
      defaultTimeoutSeconds: 30,
      workflowFallbackAllowed: false,
    },
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
  const runs = new Map(); const attempts = new Map(); const events = new Map(); const stateEvents = new Map(); const readModels = new Map(); const decisions = new Map(); const commands = new Map(); const productCommands = new Map(); const jobs = new Map(); const leases = new Map(); const checkpoints = new Map(); const terminalTransitions = new Map(); const externalEffectReceipts = new Map(); const connections = new Map(); const heartbeats = []; const idempotency = new Map();
  const terminalTransactionLog = [];
  let transactionDepth = 0;
  let failRunInsert = false;
  let rejectHeartbeat = false;
  let rejectedHeartbeatCount = 0;
  let failHeartbeat = false;
  let failedHeartbeatCount = 0;
  const attemptKey = (runId, nodeId, attempt) => `${runId}\u0000${nodeId}\u0000${attempt}`;
  const publicRun = (value) => omit(value, [
    "eventSequence",
    "executionPlanSnapshot",
    "executionSnapshot",
    "agentFinalReadModel",
    "skillMaterialBindings",
    "stateModelVersion",
    "stateEventSequence",
    "stateHash",
    "creationCommandId",
    "workspaceId",
    "requestedBy",
  ]);
  const publicAttempt = (value) => omit(value, ["executionInput", "executionOutput", "invocationId", "invocationStatus", "invocationStartedAt", "workerId", "fence"]);
  const rawRunsCollection = { async updateOne({ runId }, { $set }) { Object.assign(runs.get(runId), clone($set)); } };
  const rawAttemptsCollection = { async updateOne({ runId, nodeId, attempt }, { $set }) { Object.assign(attempts.get(attemptKey(runId, nodeId, attempt)), clone($set)); } };
  const store = {
    terminalReadModelsBeforeEvents: true,
    repositories: {
      connections: {
        async get(connectionId, { workspaceId }) {
          const value = connections.get(connectionId);
          return value?.workspaceId === workspaceId ? clone(value) : null;
        },
      },
      runs: {
        collection: rawRunsCollection,
        async insert(run) {
          if (failRunInsert) {
            failRunInsert = false;
            throw new Error("fixture_run_insert_failed");
          }
          runs.set(run.runId, {
            ...publicRun(run),
            workspaceId: run.workspaceId,
            requestedBy: run.requestedBy,
            executionSnapshot: clone(run.executionSnapshot),
            skillMaterialBindings: clone(run.skillMaterialBindings ?? []),
            stateModelVersion: run.stateModelVersion,
            stateEventSequence: run.stateEventSequence,
            stateHash: run.stateHash,
            creationCommandId: run.creationCommandId,
            eventSequence: 0,
          });
          return publicRun(runs.get(run.runId));
        },
        async get(runId) { return runs.has(runId) ? publicRun(runs.get(runId)) : null; },
        async getInternal(runId) { return runs.has(runId) ? clone(runs.get(runId)) : null; },
        async patch(runId, patch) {
          if (["completed", "failed", "cancelled"].includes(patch.status)) terminalTransactionLog.push({ kind: "run", inTransaction: transactionDepth > 0 });
          Object.assign(runs.get(runId), clone(omit(patch, ["runId", "eventSequence", "executionPlanSnapshot"])));
          return publicRun(runs.get(runId));
        },
        async patchStateProjection(runId, { expectedSequence, expectedStateHash, nextSequence, nextStateHash, patch }) {
          const run = runs.get(runId);
          if (!run || run.stateModelVersion !== 2 || run.stateEventSequence !== expectedSequence || run.stateHash !== expectedStateHash) return null;
          if (["completed", "failed", "cancelled"].includes(patch.status)) terminalTransactionLog.push({ kind: "run", inTransaction: transactionDepth > 0 });
          Object.assign(run, clone(omit(patch, ["runId", "stateModelVersion", "stateEventSequence", "stateHash", "creationCommandId", "eventSequence"])), {
            stateEventSequence: nextSequence,
            stateHash: nextStateHash,
          });
          return clone(run);
        },
        async importStateModelV2(runId, { stateEventSequence, stateHash, creationCommandId }) {
          const run = runs.get(runId);
          if (!run || run.stateModelVersion === 2 || ["completed", "failed", "cancelled"].includes(run.status)) return null;
          Object.assign(run, { stateModelVersion: 2, stateEventSequence, stateHash, creationCommandId });
          return clone(run);
        },
        async repairStateProjection(runId, { state, stateEventSequence, stateHash }) {
          const run = runs.get(runId);
          if (!run || run.stateModelVersion !== 2) return null;
          Object.assign(run, clone(state), { stateEventSequence, stateHash });
          return clone(run);
        },
        async listByWorkflow(workflowId, { status } = {}) { return [...runs.values()].filter((entry) => entry.workflowId === workflowId && (!status || entry.status === status)).map(publicRun); },
        async listByWorkspace(workspaceId, { limit = 50 } = {}) {
          return [...runs.values()]
            .filter((entry) => entry.workspaceId === workspaceId)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId))
            .slice(0, limit)
            .map(publicRun);
        },
      },
      runJobs: {
        async insert(job) { jobs.set(job.runJobId, clone(job)); return clone(job); },
        async getByRun(runId) { return [...jobs.values()].find((job) => job.runId === runId) ? clone([...jobs.values()].find((job) => job.runId === runId)) : null; },
        async list() { return [...jobs.values()].map(clone); },
        async listRecoverable(now) {
          return [...jobs.values()].filter((job) => ["queued", "cancellation_requested"].includes(job.status) || (["leased", "running"].includes(job.status) && job.leaseExpiresAt <= now)).map(clone);
        },
        async claimByRun(runId, { workerId: leaseOwner, now, leaseExpiresAt }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          const recoverable = job?.status === "queued" || (["leased", "running"].includes(job?.status) && job.leaseExpiresAt <= now);
          if (!job || !recoverable) return null;
          Object.assign(job, { status: "leased", leaseOwner, heartbeatAt: now, leaseExpiresAt, fence: job.fence + 1, updatedAt: now });
          return clone(job);
        },
        async claimMigrationDrainByRun(runId, { workerId: leaseOwner, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          const drainable = job?.status === "queued" || job?.status === "paused"
            || (["leased", "running"].includes(job?.status) && job.leaseExpiresAt <= now);
          if (!job || !drainable) return null;
          Object.assign(job, {
            status: "migration_draining",
            leaseOwner,
            leaseExpiresAt: null,
            heartbeatAt: now,
            fence: job.fence + 1,
            updatedAt: now,
          });
          return clone(job);
        },
        async completeMigrationDrainByRun(runId, { workerId: leaseOwner, fence, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.status !== "migration_draining" || job.leaseOwner !== leaseOwner || job.fence !== fence) return null;
          Object.assign(job, { status: "queued", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
          return clone(job);
        },
        async finishByRun(runId, { workerId: leaseOwner, fence, status, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.leaseOwner !== leaseOwner || job.fence !== fence) return null;
          Object.assign(job, { status, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
          return clone(job);
        },
        async heartbeatByRun(runId, { workerId: leaseOwner, fence, now, leaseExpiresAt }) {
          if (failHeartbeat) {
            failHeartbeat = false;
            failedHeartbeatCount += 1;
            throw Object.assign(new Error("fixture_serialization_failure"), { code: "40001" });
          }
          if (rejectHeartbeat) {
            rejectHeartbeat = false;
            rejectedHeartbeatCount += 1;
            return null;
          }
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
        async requestCancellationByRun(runId, { now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || !["queued", "leased", "running", "paused"].includes(job.status)) return null;
          Object.assign(job, {
            status: "cancellation_requested",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
            fence: job.fence + 1,
            updatedAt: now,
          });
          return clone(job);
        },
        async settleCancellationByRun(runId, { status, now }) {
          const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
          if (!job || job.status !== "cancellation_requested") return null;
          Object.assign(job, { status, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now });
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
        async listWhere({ runId }, { limit = 100, sort = { sequence: 1 } } = {}) {
          const direction = sort.sequence ?? 1;
          return [...checkpoints.values()]
            .filter((checkpoint) => checkpoint.runId === runId && checkpoint.state?.runState)
            .sort((left, right) => direction * (left.sequence - right.sequence))
            .slice(0, limit)
            .map(clone);
        },
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
      runStateEvents: {
        async append(value) {
          const list = stateEvents.get(value.runId) ?? [];
          if (list.some((event) => event.eventId === value.eventId || event.sequence === value.sequence)) throw new Error("duplicate_run_state_event");
          list.push(clone(value));
          stateEvents.set(value.runId, list);
          return clone(value);
        },
        async getLatest(runId) { return clone((stateEvents.get(runId) ?? []).at(-1) ?? null); },
        async listByRun(runId) { return (stateEvents.get(runId) ?? []).map(clone); },
        async listByRunAfter(runId, afterSequence) {
          return (stateEvents.get(runId) ?? []).filter((event) => event.sequence > afterSequence).map(clone);
        },
      },
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
      productCommands: {
        async get({ workspaceId, userId, commandId }) {
          const value = productCommands.get(commandId);
          return value?.workspaceId === workspaceId && value?.userId === userId
            ? clone(value)
            : null;
        },
        async insertAccepted(value, { session } = {}) {
          if (productCommands.has(value.commandId)) throw new Error("product_command_duplicate");
          productCommands.set(value.commandId, { ...clone(value), status: "accepted", finishedAt: null });
          session?.rollbacks?.push(() => productCommands.delete(value.commandId));
          return clone(productCommands.get(value.commandId));
        },
        async compareAndSet({ workspaceId, userId, commandId }, expectedStatuses, patch, { session } = {}) {
          const value = productCommands.get(commandId);
          if (
            !value
            || value.workspaceId !== workspaceId
            || value.userId !== userId
            || !expectedStatuses.includes(value.status)
          ) return null;
          const before = clone(value);
          Object.assign(value, clone(patch));
          session?.rollbacks?.push(() => productCommands.set(commandId, before));
          return clone(value);
        },
        async getInternalByRun(runId) {
          const value = [...productCommands.values()].find((entry) => entry.sessionId === runId);
          return value ? clone(value) : null;
        },
      },
      runCommands: {
        async insert(value, { session } = {}) {
          commands.set(value.runCommandId, clone(value));
          session?.rollbacks?.push(() => commands.delete(value.runCommandId));
          return clone(value);
        },
      },
      externalEffectReceipts: {
        async listWhere(filter, { limit = 1000 } = {}) {
          return [...externalEffectReceipts.values()]
            .filter((entry) => Object.entries(filter).every(([key, value]) => entry[key] === value))
            .slice(0, limit)
            .map(clone);
        },
      },
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
      const transactionSession = { inTransaction: true, rollbacks: [] };
      transactionDepth += 1;
      try {
        return await callback(transactionSession);
      } catch (error) {
        for (const rollback of transactionSession.rollbacks.reverse()) rollback();
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    async runIdempotentMutation({ scope, key, request, workspaceId, effectivePrincipalId }, mutation) {
      const id = `${workspaceId ?? "global"}\u0000${effectivePrincipalId}\u0000${scope}\u0000${key}`; const fingerprint = JSON.stringify(request);
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
  Object.defineProperty(store, "productCommandLog", { get: () => [...productCommands.values()].map(clone) });
  Object.defineProperty(store, "jobLog", { get: () => [...jobs.values()].map((job) => ({ runId: job.runId, workspaceId: job.workspaceId, status: job.status, fence: job.fence })) });
  Object.defineProperty(store, "leaseLog", { get: () => [...leases.values()].map(clone) });
  Object.defineProperty(store, "checkpointLog", { get: () => [...checkpoints.values()].sort((a, b) => a.sequence - b.sequence).map(clone) });
  Object.defineProperty(store, "heartbeatLog", { get: () => [...heartbeats].map(clone) });
  Object.defineProperty(store, "rejectedHeartbeatCount", { get: () => rejectedHeartbeatCount });
  Object.defineProperty(store, "failedHeartbeatCount", { get: () => failedHeartbeatCount });
  Object.defineProperty(store, "terminalTransitionLog", { get: () => [...terminalTransitions.values()].map(clone) });
  Object.defineProperty(store, "stateEventLog", { get: () => [...stateEvents.values()].flat().map(clone) });
  store.setFoldedRunAuthority = (runId, authority) => {
    for (const event of stateEvents.get(runId) ?? []) {
      if (event.payload?.base) Object.assign(event.payload.base, clone(authority));
    }
    for (const checkpoint of checkpoints.values()) {
      if (checkpoint.runId === runId && checkpoint.state?.runState?.base) {
        Object.assign(checkpoint.state.runState.base, clone(authority));
      }
    }
  };
  let rejectLeaseAcquire = false;
  store.rejectNextLeaseAcquire = () => { rejectLeaseAcquire = true; };
  store.rejectNextHeartbeat = () => { rejectHeartbeat = true; };
  store.failNextHeartbeat = () => { failHeartbeat = true; };
  store.failNextRunInsert = () => { failRunInsert = true; };
  store.setProductCommandStatus = (runId, status) => {
    const command = [...productCommands.values()].find((entry) => entry.sessionId === runId);
    if (!command) throw new Error("fixture_product_command_not_found");
    Object.assign(command, {
      status,
      updatedAt: NOW,
      finishedAt: ["completed", "failed", "cancelled", "blocked"].includes(status) ? NOW : null,
    });
  };
  store.simulateExternalEffectReceipt = (receipt) => {
    externalEffectReceipts.set(receipt.effectId, clone(receipt));
  };
  store.setConnection = (connection) => {
    connections.set(connection.connectionId, clone(connection));
  };
  store.patchConnection = (connectionId, patch) => {
    Object.assign(connections.get(connectionId), clone(patch));
  };
  store.stripRunConnectionApproval = (runId) => {
    const legacyBindings = (value) => (value ?? []).map((binding) => ({
      requirementId: binding.requirementId,
      connectionId: binding.connectionId,
      connectionRevision: binding.connectionRevision,
      capabilityKey: binding.capabilityKey,
      driverKey: binding.driverKey,
      validationExpiresAt: binding.validationExpiresAt,
    }));
    runs.get(runId).executionSnapshot.connectionBindings = legacyBindings(
      runs.get(runId).executionSnapshot.connectionBindings,
    );
    const initial = stateEvents.get(runId)?.[0];
    if (initial?.payload?.base?.executionSnapshot) {
      initial.payload.base.executionSnapshot.connectionBindings = legacyBindings(
        initial.payload.base.executionSnapshot.connectionBindings,
      );
    }
    for (const checkpoint of checkpoints.values()) {
      const checkpointSnapshot = checkpoint.runId === runId
        ? checkpoint.state?.runState?.base?.executionSnapshot
        : null;
      if (checkpointSnapshot) {
        checkpointSnapshot.connectionBindings = legacyBindings(checkpointSnapshot.connectionBindings);
      }
    }
  };
  store.simulateLegacyRun = (runId) => {
    const run = runs.get(runId);
    const command = [...productCommands.values()].find((entry) => entry.sessionId === runId);
    if (command) productCommands.delete(command.commandId);
    delete run.stateModelVersion;
    delete run.stateEventSequence;
    delete run.stateHash;
    delete run.creationCommandId;
    stateEvents.delete(runId);
  };
  store.simulateExpiredRun = (runId, { workerId, fence, leaseExpiresAt }) => {
    const run = runs.get(runId);
    forceRunState(run, { status: "running", startedAt: NOW, updatedAt: NOW });
    const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
    Object.assign(job, { status: "running", leaseOwner: workerId, fence, leaseExpiresAt, heartbeatAt: leaseExpiresAt });
  };
  store.setRunWorkspace = (runId, workspaceId) => {
    runs.get(runId).workspaceId = workspaceId;
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
    forceRunState(run, { status: "paused", updatedAt: NOW });
    run.reviewDecisions = [clone(decision)];
    const job = [...jobs.values()].find((candidate) => candidate.runId === runId);
    Object.assign(job, { status: "queued", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: NOW });
  };
  const forceRunState = (run, patch) => {
    const event = createRunStateTransitionEvent({
      run,
      patch,
      eventId: `forced-state-event-${run.stateEventSequence + 1}`,
      commandId: `forced-state-command-${run.stateEventSequence + 1}`,
      occurredAt: patch.updatedAt ?? NOW,
    });
    const list = stateEvents.get(run.runId) ?? [];
    list.push(clone(event));
    stateEvents.set(run.runId, list);
    Object.assign(run, clone(patch), {
      stateEventSequence: event.sequence,
      stateHash: event.stateHash,
    });
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


test("public Run replay skips database maintenance receipts without renumbering the cursor", async () => {
  const fixture = createFixture();
  const entries = ["run.started", "run.lease_renewed", "run.worker_recovered", "review.decided", "run.completed"]
    .map((type, index) => ({ type, sequence: index + 1 }));
  fixture.store.repositories.runEvents.listAfter = async (_runId, after) => entries.filter((event) => event.sequence > after);
  assert.deepEqual(await fixture.runner.listEvents("run-stream", 0), [entries[0], entries[4]]);
  assert.deepEqual(await fixture.runner.listEvents("run-stream", 3), [entries[4]]);
});
