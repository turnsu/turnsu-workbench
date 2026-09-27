import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { CommandIntakeService } from "../../src/coordination/index.mjs";
import {
  createSkillValidationCoordinator,
  createSkillTestRunner,
  formatSkillPackage,
  hashSkillPackageObject,
} from "../../src/skills/index.mjs";
import { formatSkillDraftEtag } from "../../src/store/index.mjs";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const NOW = "2026-07-13T09:00:00.000Z";
const IMAGE = "python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891";

test("Skill lifecycle application persists exact public records, hides private evidence, and enforces workspace/idempotency", async () => {
  const harness = makeHarness();
  const testRequest = request({
    testCase: {
      name: "echoes approved input",
      purpose: "Confirm the package returns the reviewed object.",
      input: { value: "approved" },
      expectedOutput: { value: "approved" },
      timeoutSeconds: 5,
    },
  });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "test-key-1",
    ifMatch: harness.etag,
    request: testRequest,
    auth: harness.owner,
  });
  assert.equal(accepted.status, "queued");
  await harness.skillTestRunner.waitForIdle();
  const created = await harness.application.getSkillTestRun({
    skillId: "skill-1",
    testRunId: accepted.testRunId,
    auth: harness.owner,
  });
  const replay = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "test-key-1",
    ifMatch: harness.etag,
    request: testRequest,
    auth: harness.owner,
  });
  assert.deepEqual(replay, created);
  assert.equal(created.status, "passed");
  assertProductSafe(created);
  assert.equal(harness.records.evidence.size, 1);
  assert.equal(harness.records.evidence.get(created.testRunId).networkDenied, true);
  const testCommand = [...harness.records.commands.values()].find(({ kind }) => kind === "skill_test");
  assert.equal(testCommand.commandId, created.testRunId);
  assert.equal(testCommand.sessionId, "draft-1");
  assert.equal(testCommand.turnId, created.testRunId);
  assert.equal(testCommand.invocationId, harness.executionCalls[0].invocationId);
  assert.equal(testCommand.attemptId, harness.executionCalls[0].attemptId);
  assert.equal(harness.executionCalls[0].requestedBy, "user-a");
  assert.equal(harness.executionCalls[0].draftId, "draft-1");
  assert.equal(harness.executionCalls[0].commandStatusAtExecution, "running");
  assert.equal(harness.executionCalls[0].targetStatusAtExecution, "running");

  await assert.rejects(
    () => harness.application.createSkillTest({
      skillId: "skill-1",
      draftId: "draft-1",
      idempotencyKey: "test-key-1",
      ifMatch: harness.etag,
      request: request({ testCase: { ...testRequest.data.testCase, purpose: "Different body" } }),
      auth: harness.owner,
    }),
    (error) => error?.code === "idempotency_key_reused",
  );

  const validation = await harness.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "validation-key-1",
    ifMatch: harness.etag,
    request: request({ testRunIds: [created.testRunId], permissionAcknowledged: true }),
    auth: harness.owner,
  });
  assert.equal(validation.status, "passed");
  assertProductSafe(validation);
  assert.equal(harness.records.bindings.size, 1);
  assert.deepEqual(harness.lifecycleTransitions, ["validating", "tested"]);
  assert.equal(harness.records.assets.get("skill-1").lifecycle, "tested");
  assert.deepEqual(
    [...harness.records.commands.values()].map(({ kind, status, userId, workspaceId }) => ({
      kind, status, userId, workspaceId,
    })),
    [
      { kind: "skill_test", status: "completed", userId: "user-a", workspaceId: "workspace-a" },
      { kind: "skill_validation", status: "completed", userId: "user-a", workspaceId: "workspace-a" },
    ],
  );
  assert.equal(Object.hasOwn(validation, "imageDigest"), false);
  const binding = [...harness.records.bindings.values()][0];
  assert.deepEqual(
    await harness.coordinator.probeExecution({
      workspaceId: "workspace-a",
      executionRef: binding.executionRef,
    }),
    { status: "ready", ready: true, code: "uploaded_skill_ready" },
  );
  assert.deepEqual(
    await harness.coordinator.executePublished({
      workspaceId: "workspace-a",
      executionRef: binding.executionRef,
      input: { value: "published" },
    }),
    { value: "published" },
  );
  assert.deepEqual(
    await harness.coordinator.probeExecution({
      workspaceId: "workspace-b",
      executionRef: binding.executionRef,
    }),
    { status: "blocked", ready: false, code: "uploaded_skill_unavailable" },
  );
  await assert.rejects(
    () => harness.coordinator.executePublished({
      workspaceId: "workspace-b",
      executionRef: binding.executionRef,
      input: { value: "must-not-run" },
    }),
    (error) => error?.code === "uploaded_skill_execution_binding_missing",
  );
  const validationReplay = await harness.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "validation-key-1",
    ifMatch: harness.etag,
    request: request({ testRunIds: [created.testRunId], permissionAcknowledged: true }),
    auth: harness.owner,
  });
  assert.deepEqual(validationReplay, validation);
  await assert.rejects(
    () => harness.application.createSkillValidation({
      skillId: "skill-1",
      draftId: "draft-1",
      idempotencyKey: "validation-key-1",
      ifMatch: harness.etag,
      request: request({ testRunIds: ["different-test-run"], permissionAcknowledged: true }),
      auth: harness.owner,
    }),
    (error) => error?.code === "idempotency_key_reused",
  );

  const loaded = await harness.application.getSkillValidation({
    skillId: "skill-1",
    validationId: validation.validationId,
    auth: harness.owner,
  });
  assert.deepEqual(loaded, validation);
  await assert.rejects(
    () => harness.application.getSkillValidation({
      skillId: "skill-1",
      validationId: validation.validationId,
      auth: { userId: "user-b", activeWorkspaceId: "workspace-b" },
    }),
    (error) => error?.code === "skill_validation_not_found",
  );
});

test("Skill test intake returns queued before background execution and startup recovery drains accepted work", async () => {
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const harness = makeHarness({ executionGate });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "async-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "async",
        purpose: "Prove the request does not wait for execution.",
        input: { value: "async" },
        expectedOutput: { value: "async" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.startedAt, null);
  releaseExecution();
  await harness.skillTestRunner.waitForIdle();
  assert.equal((await harness.application.getSkillTestRun({
    skillId: "skill-1",
    testRunId: accepted.testRunId,
    auth: harness.owner,
  })).status, "passed");

  const recovering = makeHarness({ scheduleTests: false });
  const queued = await recovering.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "recover-queued-test",
    ifMatch: recovering.etag,
    request: request({
      testCase: {
        name: "recover queued",
        purpose: "Recover accepted work after restart.",
        input: { value: "recover" },
        expectedOutput: { value: "recover" },
        timeoutSeconds: 5,
      },
    }),
    auth: recovering.owner,
  });
  assert.equal(queued.status, "queued");
  assert.equal(recovering.executionCalls.length, 0);
  assert.deepEqual(await recovering.skillTestRunner.recover(), {
    recoveredTestRunIds: [queued.testRunId],
  });
  await recovering.skillTestRunner.waitForIdle();
  assert.equal(recovering.records.tests.get(queued.testRunId).status, "passed");
  assert.equal(recovering.records.commands.get(queued.testRunId).status, "completed");
});

test("Skill validation rolls back validating state when execution binding persistence fails", async () => {
  const bindingFailure = coded("binding_write_failed");
  const harness = makeHarness({ bindingInsertError: bindingFailure });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "binding-failure-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "binding failure",
        purpose: "Prove lifecycle and validation evidence roll back together.",
        input: { value: "ok" },
        expectedOutput: { value: "ok" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  await harness.skillTestRunner.waitForIdle();

  await assert.rejects(
    () => harness.application.createSkillValidation({
      skillId: "skill-1",
      draftId: "draft-1",
      idempotencyKey: "binding-failure-validation",
      ifMatch: harness.etag,
      request: request({ testRunIds: [accepted.testRunId], permissionAcknowledged: true }),
      auth: harness.owner,
    }),
    (error) => error === bindingFailure,
  );

  assert.deepEqual(harness.lifecycleTransitions, ["validating"]);
  assert.equal(harness.records.assets.get("skill-1").lifecycle, "draft");
  assert.equal(harness.records.validations.size, 0);
  assert.equal(harness.records.bindings.size, 0);
  assert.equal(
    [...harness.records.commands.values()].some(({ kind }) => kind === "skill_validation"),
    false,
  );
});

test("startup recovery fences a stale running invocation and advances the durable execution attempt", async () => {
  const harness = makeHarness({ scheduleTests: false });
  const queued = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "recover-running-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "recover running",
        purpose: "Retry a stale running execution with a new identity.",
        input: { value: "retry" },
        expectedOutput: { value: "retry" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const firstIdentity = harness.coordinator.testExecutionIdentity(queued.testRunId, 1);
  const command = harness.records.commands.get(queued.testRunId);
  harness.records.commands.set(queued.testRunId, {
    ...command,
    ...firstIdentity,
    status: "running",
  });
  const target = harness.records.tests.get(queued.testRunId);
  harness.records.tests.set(queued.testRunId, {
    ...target,
    status: "running",
    startedAt: NOW,
  });
  harness.invocations.set(firstIdentity.invocationId, {
    invocationId: firstIdentity.invocationId,
    workspaceId: "workspace-a",
    status: "running",
    result: null,
  });

  assert.deepEqual(await harness.skillTestRunner.recover(), {
    recoveredTestRunIds: [queued.testRunId],
  });
  await harness.skillTestRunner.waitForIdle();
  const completed = harness.records.tests.get(queued.testRunId);
  assert.equal(completed.status, "passed");
  assert.equal(completed.executionAttempt, 2);
  assert.equal(harness.records.commands.get(queued.testRunId).status, "completed");
  assert.notEqual(harness.executionCalls[0].invocationId, firstIdentity.invocationId);
});

test("terminal settlement failure is durable and retries without redispatch", async () => {
  let materialExpired = false;
  const harness = makeHarness({
    failTerminalCommandSettle: true,
    materialResolver: async () => {
      if (materialExpired) throw coded("attachment_expired");
      return [];
    },
  });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "atomic-terminal-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "atomic terminal",
        purpose: "Prove both terminal records share one transaction.",
        input: { value: "atomic" },
        expectedOutput: { value: "atomic" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  await harness.skillTestRunner.waitForIdle();
  const retryable = harness.records.tests.get(accepted.testRunId);
  assert.equal(retryable.status, "running");
  assert.equal(retryable.settlementFailureCode, "simulated_product_command_settlement_failure");
  assert.match(retryable.settlementRetryAt, /^2026-/);
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "running");
  assert.equal(harness.executionCalls.length, 1);

  materialExpired = true;
  harness.setFailTerminalCommandSettle(false);
  await waitUntil(() => harness.records.tests.get(accepted.testRunId)?.status === "passed");
  await harness.skillTestRunner.waitForIdle();
  const settled = harness.records.tests.get(accepted.testRunId);
  assert.equal(settled.status, "passed");
  assert.equal(settled.settlementFailureCode, null);
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "completed");
  assert.equal(harness.executionCalls.length, 1);
  assert.equal(harness.materialResolutionCalls.length, 1);
});

test("two Skill test runners use one durable claim and dispatch only once", async () => {
  const harness = makeHarness({ scheduleTests: false });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "dual-runner-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "dual runner",
        purpose: "Only one durable claim may dispatch this test.",
        input: { value: "once" },
        expectedOutput: { value: "once" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const first = harness.createRunner({ runnerId: "runner-a" });
  const second = harness.createRunner({ runnerId: "runner-b" });

  await Promise.all([
    first.schedule(accepted.testRunId),
    second.schedule(accepted.testRunId),
  ]);
  await Promise.all([first.waitForIdle(), second.waitForIdle()]);

  assert.equal(harness.executionCalls.length, 1);
  assert.equal(harness.records.tests.get(accepted.testRunId).status, "passed");
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "completed");
});

test("a late result from an old execution attempt cannot overwrite the newer attempt", async () => {
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const harness = makeHarness({ executionGate });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "late-attempt-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "late attempt",
        purpose: "Fence a result emitted after a newer attempt owns the target.",
        input: { value: "old" },
        expectedOutput: { value: "old" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  await waitUntil(() => harness.records.tests.get(accepted.testRunId)?.status === "running");
  const attemptOne = harness.records.tests.get(accepted.testRunId);
  harness.records.tests.set(accepted.testRunId, {
    ...attemptOne,
    executionAttempt: 2,
    runnerClaimOwner: "runner-new",
    runnerClaimFence: attemptOne.runnerClaimFence + 1,
  });

  releaseExecution();
  await harness.skillTestRunner.waitForIdle();

  const current = harness.records.tests.get(accepted.testRunId);
  assert.equal(current.status, "running");
  assert.equal(current.executionAttempt, 2);
  assert.equal(current.runnerClaimOwner, "runner-new");
  assert.equal(harness.executionCalls.length, 1);
});

test("startup recovery schedules business execution without blocking readiness", async () => {
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const harness = makeHarness({ executionGate, scheduleTests: false });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "non-blocking-recovery-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "non-blocking recovery",
        purpose: "Server recovery returns before the governed execution completes.",
        input: { value: "background" },
        expectedOutput: { value: "background" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });

  const recovered = await Promise.race([
    harness.skillTestRunner.recover(),
    new Promise((_, reject) => setTimeout(
      () => reject(coded("recovery_blocked_on_business_execution")),
      50,
    )),
  ]);
  assert.deepEqual(recovered, { recoveredTestRunIds: [accepted.testRunId] });
  await waitUntil(() => harness.records.tests.get(accepted.testRunId)?.status === "running");
  releaseExecution();
  await harness.skillTestRunner.waitForIdle();
  assert.equal(harness.records.tests.get(accepted.testRunId).status, "passed");
});

test("recovery observes cancellation_requested and settles without dispatch", async () => {
  const harness = makeHarness({ scheduleTests: false });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "cancel-recovery-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "cancel recovery",
        purpose: "Cancellation remains authoritative across restart.",
        input: { value: "cancel" },
        expectedOutput: { value: "cancel" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  await harness.commandIntake.requestCancellation({
    principal: { workspaceId: "workspace-a", userId: "user-a" },
    commandId: accepted.testRunId,
    at: NOW,
  });

  await harness.skillTestRunner.recover();
  await harness.skillTestRunner.waitForIdle();

  assert.equal(harness.records.tests.get(accepted.testRunId).status, "cancelled");
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "cancelled");
  assert.equal(harness.executionCalls.length, 0);
});

test("queued Skill test cancellation is durable, idempotent, and never dispatches", async () => {
  const harness = makeHarness({ scheduleTests: false });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "queued-cancel-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "queued cancel",
        purpose: "Cancel before execution starts.",
        input: { value: "cancel" },
        expectedOutput: { value: "cancel" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const cancellationRequest = request({ reason: "No longer needed." });

  assert.equal(await harness.application.cancelSkillTest({
    skillId: "skill-1",
    testRunId: accepted.testRunId,
    idempotencyKey: "cancel-skill-test-1",
    request: cancellationRequest,
    auth: harness.owner,
  }), accepted.testRunId);
  await harness.skillTestRunner.waitForIdle();

  assert.equal(harness.records.tests.get(accepted.testRunId).status, "cancelled");
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "cancelled");
  assert.equal(harness.executionCalls.length, 0);
  const cancellationCommands = [...harness.records.commands.values()]
    .filter((command) => command.kind === "cancel_skill_test");
  assert.equal(cancellationCommands.length, 1);
  assert.equal(cancellationCommands[0].targetCommandId, accepted.testRunId);
  assert.equal(cancellationCommands[0].status, "completed");

  assert.equal(await harness.application.cancelSkillTest({
    skillId: "skill-1",
    testRunId: accepted.testRunId,
    idempotencyKey: "cancel-skill-test-1",
    request: cancellationRequest,
    auth: harness.owner,
  }), accepted.testRunId);
  assert.equal(
    [...harness.records.commands.values()].filter((command) => command.kind === "cancel_skill_test").length,
    1,
  );
  await assert.rejects(
    () => harness.application.cancelSkillTest({
      skillId: "skill-1",
      testRunId: accepted.testRunId,
      idempotencyKey: "cancel-skill-test-1",
      request: request({ reason: "A different reason." }),
      auth: harness.owner,
    }),
    (error) => error?.code === "idempotency_key_reused",
  );
});

test("running Skill test cancellation aborts the exact attempt and fences a late result", async () => {
  let started;
  const executionStarted = new Promise((resolve) => { started = resolve; });
  let executionSignal = null;
  const harness = makeHarness({
    executionHandler: async ({ executionRequest, signal }) => {
      executionSignal = signal;
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return {
        status: "completed",
        output: structuredClone(executionRequest.input),
        summary: "late completion after cancellation",
      };
    },
  });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "running-cancel-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "running cancel",
        purpose: "Abort one exact active attempt.",
        input: { value: "running" },
        expectedOutput: { value: "running" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  await executionStarted;

  await harness.application.cancelSkillTest({
    skillId: "skill-1",
    testRunId: accepted.testRunId,
    idempotencyKey: "cancel-running-test",
    request: request({ reason: "Stop the active test." }),
    auth: harness.owner,
  });
  await harness.skillTestRunner.waitForIdle();

  assert.equal(executionSignal.aborted, true);
  assert.equal(harness.records.tests.get(accepted.testRunId).status, "cancelled");
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "cancelled");
  assert.ok(harness.cancellationCalls.some(({ invocationId }) =>
    invocationId === harness.coordinator.testExecutionIdentity(accepted.testRunId, 1).invocationId));
});

test("claim heartbeat preserves one owner through a long dispatch", async () => {
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const harness = makeHarness({ executionGate, scheduleTests: false });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "heartbeat-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "heartbeat",
        purpose: "Renew ownership while execution waits.",
        input: { value: "long" },
        expectedOutput: { value: "long" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const first = harness.createRunner({ runnerId: "heartbeat-owner", claimHeartbeatMs: 5 });
  const second = harness.createRunner({ runnerId: "heartbeat-peer", claimHeartbeatMs: 5 });
  const firstOperation = first.schedule(accepted.testRunId);
  await waitUntil(() => harness.claimRenewals
    .filter(({ claimOwner }) => claimOwner === "heartbeat-owner").length >= 3);

  await second.schedule(accepted.testRunId);
  assert.equal(harness.executionCalls.length, 1);
  releaseExecution();
  await firstOperation;
  await waitUntil(() => harness.records.tests.get(accepted.testRunId)?.status === "passed");
  assert.equal(harness.executionCalls.length, 1);
  await Promise.all([first.stop(), second.stop()]);
});

test("claim loss aborts the exact attempt and the old runner cannot settle", async () => {
  let observedSignal = null;
  let renewalCount = 0;
  const harness = makeHarness({
    scheduleTests: false,
    renewClaimHook: async ({ testRunId }, { record, records }) => {
      renewalCount += 1;
      if (renewalCount !== 1) return undefined;
      records.tests.set(testRunId, {
        ...record,
        runnerClaimOwner: "replacement-runner",
        runnerClaimFence: record.runnerClaimFence + 1,
      });
      return null;
    },
    executionHandler: async ({ signal }) => {
      observedSignal = signal;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw signal.reason;
    },
  });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "claim-loss-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "claim loss",
        purpose: "Fence an obsolete runner.",
        input: { value: "old" },
        expectedOutput: { value: "old" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const runner = harness.createRunner({
    runnerId: "obsolete-runner",
    claimHeartbeatMs: 5,
    retryDelayMs: 10_000,
  });
  await runner.schedule(accepted.testRunId);

  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason?.code, "skill_test_claim_lost");
  const current = harness.records.tests.get(accepted.testRunId);
  assert.equal(current.status, "running");
  assert.equal(current.runnerClaimOwner, "replacement-runner");
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "running");
  assert.ok(harness.cancellationCalls.some(({ invocationId }) =>
    invocationId === harness.coordinator.testExecutionIdentity(accepted.testRunId, 1).invocationId));
  await runner.stop();
});

test("claim renewal failure retries a Broker-cancelled invocation as a new attempt", async () => {
  let renewalCount = 0;
  let executionCount = 0;
  const harness = makeHarness({
    scheduleTests: false,
    renewClaimHook: async () => {
      renewalCount += 1;
      if (renewalCount === 1) throw coded("simulated_claim_renewal_outage");
      return undefined;
    },
    executionHandler: async ({ executionRequest, signal }) => {
      executionCount += 1;
      if (executionCount === 1) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw signal.reason;
      }
      return {
        status: "completed",
        output: structuredClone(executionRequest.input),
        summary: "completed after recovery",
      };
    },
  });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "claim-renewal-outage-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "claim renewal outage",
        purpose: "Retry an infrastructure-cancelled Broker attempt.",
        input: { value: "recover" },
        expectedOutput: { value: "recover" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const interruptedRunner = harness.createRunner({
    runnerId: "renewal-outage-runner",
    claimHeartbeatMs: 5,
    retryDelayMs: 10_000,
  });
  await interruptedRunner.schedule(accepted.testRunId);

  const interrupted = harness.records.tests.get(accepted.testRunId);
  assert.equal(interrupted.status, "running");
  assert.equal(interrupted.runnerClaimOwner, null);
  assert.equal(interrupted.settlementFailureCode, "skill_test_claim_renewal_failed");
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "running");
  const firstIdentity = harness.coordinator.testExecutionIdentity(accepted.testRunId, 1);
  assert.equal(harness.invocations.get(firstIdentity.invocationId)?.result?.status, "cancelled");
  await interruptedRunner.stop();

  const recoveryRunner = harness.createRunner({ runnerId: "renewal-recovery-runner" });
  await recoveryRunner.schedule(accepted.testRunId, { recovering: true });
  const recovered = harness.records.tests.get(accepted.testRunId);
  assert.equal(recovered.status, "passed");
  assert.equal(recovered.executionAttempt, 2);
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "completed");
  assert.equal(executionCount, 2);
  await recoveryRunner.stop();
});

test("runner stop aborts active work without misreporting user cancellation", async () => {
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  let observedSignal = null;
  let executionCount = 0;
  const harness = makeHarness({
    scheduleTests: false,
    executionHandler: async ({ executionRequest, signal }) => {
      executionCount += 1;
      if (executionCount > 1) {
        return {
          status: "completed",
          output: structuredClone(executionRequest.input),
          summary: "completed after runner restart",
        };
      }
      observedSignal = signal;
      executionStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw signal.reason;
    },
  });
  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "runner-stop-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "runner stop",
        purpose: "Leave work recoverable when the process stops.",
        input: { value: "stop" },
        expectedOutput: { value: "stop" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  const runner = harness.createRunner({ runnerId: "stopping-runner" });
  runner.schedule(accepted.testRunId);
  await started;
  await runner.stop();

  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason?.code, "skill_test_runner_stopped");
  assert.equal(harness.records.tests.get(accepted.testRunId).status, "running");
  assert.equal(harness.records.tests.get(accepted.testRunId).runnerClaimOwner, null);
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "running");
  assert.equal(await runner.schedule(accepted.testRunId), null);

  const replacement = harness.createRunner({ runnerId: "replacement-runner" });
  await replacement.schedule(accepted.testRunId, { recovering: true });
  assert.equal(harness.records.tests.get(accepted.testRunId).status, "passed");
  assert.equal(harness.records.tests.get(accepted.testRunId).executionAttempt, 2);
  assert.equal(harness.records.commands.get(accepted.testRunId).status, "completed");
  assert.equal(executionCount, 2);
  await replacement.stop();
});

test("failed and stale tests cannot create an execution binding", async () => {
  const failed = makeHarness();
  const failedAccepted = await failed.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "failed-test",
    ifMatch: failed.etag,
    request: request({
      testCase: {
        name: "mismatch",
        purpose: "Prove failed output stays failed.",
        input: { value: "actual" },
        expectedOutput: { value: "expected" },
        timeoutSeconds: 5,
      },
    }),
    auth: failed.owner,
  });
  assert.equal(failedAccepted.status, "queued");
  await failed.skillTestRunner.waitForIdle();
  const failedRun = await failed.application.getSkillTestRun({
    skillId: "skill-1",
    testRunId: failedAccepted.testRunId,
    auth: failed.owner,
  });
  assert.equal(failedRun.status, "failed");
  const failedValidation = await failed.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "failed-validation",
    ifMatch: failed.etag,
    request: request({ testRunIds: [failedRun.testRunId], permissionAcknowledged: true }),
    auth: failed.owner,
  });
  assert.equal(failedValidation.status, "failed");
  assert.equal(failed.records.bindings.size, 0);
  assert.deepEqual(failed.lifecycleTransitions, ["validating", "draft"]);
  assert.equal(failed.records.assets.get("skill-1").lifecycle, "draft");
  assert.equal(
    [...failed.records.commands.values()].find(({ kind }) => kind === "skill_test")?.status,
    "failed",
  );

  const stale = makeHarness();
  const passedAccepted = await stale.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "passed-before-change",
    ifMatch: stale.etag,
    request: request({
      testCase: {
        name: "passes",
        purpose: "Create evidence for the original draft.",
        input: { value: "ok" },
        expectedOutput: { value: "ok" },
        timeoutSeconds: 5,
      },
    }),
    auth: stale.owner,
  });
  assert.equal(passedAccepted.status, "queued");
  await stale.skillTestRunner.waitForIdle();
  const passedRun = await stale.application.getSkillTestRun({
    skillId: "skill-1",
    testRunId: passedAccepted.testRunId,
    auth: stale.owner,
  });
  stale.context.contentHash = `sha256:${"9".repeat(64)}`;
  const staleValidation = await stale.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "stale-validation",
    ifMatch: stale.etag,
    request: request({ testRunIds: [passedRun.testRunId], permissionAcknowledged: true }),
    auth: stale.owner,
  });
  assert.equal(staleValidation.status, "failed");
  assert.ok(staleValidation.diagnostics.some(({ code }) => code === "skill_test_run_stale"));
  assert.equal(stale.records.bindings.size, 0);
  assert.deepEqual(stale.lifecycleTransitions, ["validating", "draft"]);
  assert.equal(stale.records.assets.get("skill-1").lifecycle, "draft");
  assert.equal(
    [...stale.records.commands.values()].find(({ kind }) => kind === "skill_test")?.status,
    "completed",
  );
});

test("instructions-only Skills test through the configured product Prompt runtime", async () => {
  const harness = makeHarness({
    promptOnly: true,
    files: [{
      path: "SKILL.md",
      content: "---\nname: prompt-echo\ndescription: Return the provided object.\n---\nReturn the input object.",
    }],
  });
  harness.coordinator.configurePromptRuntime({
    async probe() {
      return { ready: true };
    },
    async executeTest() { throw new Error("direct_prompt_test_forbidden"); },
  });

  const accepted = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "prompt-test",
    ifMatch: harness.etag,
    request: request({
      testCase: {
        name: "prompt echo",
        purpose: "Verify the product Prompt runtime.",
        input: { value: "prompt" },
        expectedOutput: { value: "prompt" },
        timeoutSeconds: 5,
      },
    }),
    auth: harness.owner,
  });
  assert.equal(accepted.status, "queued");
  await harness.skillTestRunner.waitForIdle();
  const created = await harness.application.getSkillTestRun({
    skillId: "skill-1",
    testRunId: accepted.testRunId,
    auth: harness.owner,
  });
  assert.equal(created.status, "passed");
  assert.equal(harness.executionCalls.length, 1);
  assert.equal(harness.executionCalls[0].requestedBy, "user-a");
  assert.equal(harness.executionCalls[0].promptTool, true);
  const testPackage = await harness.coordinator.loadExecutionPackage({
    workspaceId: "workspace-a",
    executionRef: harness.executionCalls[0].executionRef,
  });
  assert.deepEqual(testPackage.files.map(({ path }) => path), ["SKILL.md"]);

  const validation = await harness.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "prompt-validation",
    ifMatch: harness.etag,
    request: request({ testRunIds: [created.testRunId], permissionAcknowledged: true }),
    auth: harness.owner,
  });
  assert.equal(validation.status, "passed");
  assert.equal(validation.runtimeSummary.runtimeLabel, "Product Prompt Gateway");
  const binding = [...harness.records.bindings.values()][0];
  assert.equal(binding.executorKind, "prompt_tool");
  assert.match(binding.executionRef.capabilityId, /^prompt-/);
  assert.deepEqual(
    await harness.coordinator.probeExecution({
      workspaceId: "workspace-a",
      executionRef: binding.executionRef,
    }),
    { status: "ready", ready: true, code: "prompt_tool_skill_ready" },
  );
});

function makeHarness({
  files = [
    { path: "SKILL.md", content: "---\nname: uploaded-echo\ndescription: Echo a reviewed JSON object.\ndisable-model-invocation: true\n---\n" },
    { path: "skill.runtime.json", content: `${JSON.stringify({
      runtime: "python3.12",
      entrypoint: "scripts/main.py",
      protocol: { stdin: "json", stdout: "json" },
      permissions: {
        network: false,
        connections: [],
        externalActions: false,
        filesystem: "scratch-only",
      },
    }, null, 2)}\n` },
    { path: "scripts/main.py", content: "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n" },
  ],
  executionGate = null,
  promptOnly = false,
  executionHandler = null,
  materialResolver = async () => [],
  renewClaimHook = null,
  scheduleTests = true,
  failTerminalCommandSettle = false,
  bindingInsertError = null,
  runnerClock = () => NOW,
} = {}) {
  const inspection = inspectSkillPackage({ files });
  const bytes = formatSkillPackage(files);
  const objectHash = hashSkillPackageObject(bytes);
  const draft = {
    schemaVersion: "workbench-v1",
    skillDraftId: "draft-1",
    skillId: "skill-1",
    workspaceId: "workspace-a",
    baseVersionId: null,
    revision: 1,
    name: "Uploaded echo",
    description: "Echo a reviewed object.",
    category: "utility",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk: { level: "low", externalAction: false, summary: "No external action." },
    dependencies: [],
    connectionRequirements: [],
    files: [{ path: "package.skill-package", objectId: "object-1", contentHash: objectHash, mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: bytes.byteLength }],
    updatedBy: "user-a",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const context = {
    draft,
    uploadId: "upload-1",
    objectId: "object-1",
    objectHash,
    packageHash: inspection.contentHash,
    contentHash: `sha256:${"8".repeat(64)}`,
    inspection,
  };
  const skillAsset = {
    schemaVersion: "workbench-v1",
    skillId: "skill-1",
    workspaceId: "workspace-a",
    ownerId: "user-a",
    visibility: "private",
    lifecycle: "draft",
    currentDraftId: "draft-1",
    latestPublishedVersionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const records = {
    assets: new Map([[skillAsset.skillId, skillAsset]]),
    tests: new Map(),
    evidence: new Map(),
    validations: new Map(),
    bindings: new Map(),
    commands: new Map(),
  };
  const lifecycleTransitions = [];
  const idempotency = new Map();
  const claimRenewals = [];
  const materialResolutionCalls = [];
  const cancellationCalls = [];
  let ids = 0;
  let failTerminalSettle = failTerminalCommandSettle;
  const store = {
    async connect() {},
    async authorizeWorkspace({ workspaceId }) {
      if (workspaceId !== "workspace-a") return { workspaceId };
      return { workspaceId };
    },
    async getSkillDraft({ skillId, draftId, workspaceId }) {
      if (
        workspaceId !== "workspace-a"
        || skillId !== draft.skillId
        || draftId !== draft.skillDraftId
      ) {
        throw coded("skill_draft_not_found");
      }
      return {
        skill: structuredClone(records.assets.get(skillId)),
        draft: structuredClone(draft),
      };
    },
    async withTransaction(callback) {
      const snapshots = Object.fromEntries(
        Object.entries(records).map(([key, value]) => [
          key,
          new Map([...value.entries()].map(([id, record]) => [id, structuredClone(record)])),
        ]),
      );
      try {
        return await callback({ id: "session-1" });
      } catch (error) {
        for (const [key, snapshot] of Object.entries(snapshots)) {
          records[key].clear();
          for (const [id, record] of snapshot) records[key].set(id, record);
        }
        throw error;
      }
    },
    async runIdempotentMutation({ scope, key, request: body, workspaceId }, mutation) {
      const recordKey = `${workspaceId}:${scope}:${key}`;
      const serialized = JSON.stringify(body);
      const existing = idempotency.get(recordKey);
      if (existing) {
        if (existing.serialized !== serialized) throw coded("idempotency_key_reused");
        return structuredClone(existing.response);
      }
      const snapshots = Object.fromEntries(
        Object.entries(records).map(([name, value]) => [
          name,
          new Map([...value.entries()].map(([id, record]) => [id, structuredClone(record)])),
        ]),
      );
      try {
        const response = await mutation({ id: "session-1" });
        idempotency.set(recordKey, { serialized, response: structuredClone(response) });
        return response;
      } catch (error) {
        for (const [name, snapshot] of Object.entries(snapshots)) {
          records[name].clear();
          for (const [id, record] of snapshot) records[name].set(id, record);
        }
        throw error;
      }
    },
    async runIdempotentExternalMutation({
      scope,
      key,
      request: body,
      workspaceId,
      operationIdKind,
      recover,
      replay,
    }, mutation) {
      const recordKey = `${workspaceId}:${scope}:${key}`;
      const serialized = JSON.stringify(body);
      const existing = idempotency.get(recordKey);
      if (existing) {
        if (existing.serialized !== serialized) throw coded("idempotency_key_reused");
        return replay
          ? replay(structuredClone(existing.response), existing.operationId)
          : structuredClone(existing.response);
      }
      const operationId = `${operationIdKind}-${idempotency.size + 1}`;
      const recovered = typeof recover === "function" ? await recover(operationId) : null;
      const response = recovered ?? await mutation(operationId);
      idempotency.set(recordKey, { serialized, operationId, response: structuredClone(response) });
      return response;
    },
    async resolveSkillValidationContext({ workspaceId }) {
      if (workspaceId !== "workspace-a") throw coded("skill_not_found");
      return structuredClone(context);
    },
    repositories: {
      skillAssets: {
        async get(skillId, { workspaceId } = {}) {
          const asset = records.assets.get(skillId);
          return asset && (!workspaceId || asset.workspaceId === workspaceId)
            ? structuredClone(asset)
            : null;
        },
        async patch(skillId, patch, { workspaceId } = {}) {
          const asset = records.assets.get(skillId);
          if (!asset || (workspaceId && asset.workspaceId !== workspaceId)) return null;
          const updated = { ...asset, ...structuredClone(patch) };
          records.assets.set(skillId, updated);
          if (patch.lifecycle) lifecycleTransitions.push(patch.lifecycle);
          return structuredClone(updated);
        },
      },
      productCommands: {
        async get({ commandId, workspaceId, userId }) {
          const record = records.commands.get(commandId);
          return record?.workspaceId === workspaceId && record?.userId === userId
            ? structuredClone(record)
            : null;
        },
        async getInternal(commandId) {
          const record = records.commands.get(commandId);
          return record ? structuredClone(record) : null;
        },
        async listRecoverableSkillTests() {
          return [...records.commands.values()]
            .filter((record) => record.kind === "skill_test"
              && ["accepted", "running", "cancellation_requested"].includes(record.status))
            .map((record) => structuredClone(record));
        },
        async insertAccepted(command) {
          const record = { ...structuredClone(command), status: "accepted", finishedAt: null };
          records.commands.set(record.commandId, record);
          return structuredClone(record);
        },
        async compareAndSet({ commandId, workspaceId, userId }, expectedStatuses, patch) {
          const record = records.commands.get(commandId);
          if (!record || record.workspaceId !== workspaceId || record.userId !== userId
            || !expectedStatuses.includes(record.status)) return null;
          if (failTerminalSettle
            && ["completed", "failed", "blocked", "cancelled"].includes(patch.status)) {
            throw coded("simulated_product_command_settlement_failure");
          }
          const updated = { ...record, ...structuredClone(patch) };
          records.commands.set(commandId, updated);
          return structuredClone(updated);
        },
      },
      uploads: {
        async get(uploadId, { workspaceId }) {
          if (workspaceId !== "workspace-a" || uploadId !== "upload-1") return null;
          return { uploadId, workspaceId, objectId: "object-1", state: "promoted", inspection };
        },
      },
      skillTestRuns: {
        async insert(record) { records.tests.set(record.testRunId, structuredClone(record)); return record; },
        async get(testRunId, { workspaceId }) {
          const record = records.tests.get(testRunId);
          return record && (!workspaceId || record.workspaceId === workspaceId)
            ? structuredClone(record)
            : null;
        },
        async claim(testRunId, {
          workspaceId,
          claimOwner,
          now,
          leaseExpiresAt,
          expectedStatuses,
        }) {
          const record = records.tests.get(testRunId);
          const claimAvailable = !record?.runnerClaimOwner
            || record.runnerClaimOwner === claimOwner
            || String(record.runnerClaimExpiresAt ?? "") <= now;
          if (!record || record.workspaceId !== workspaceId
            || !expectedStatuses.includes(record.status) || !claimAvailable) return null;
          const updated = {
            ...record,
            runnerClaimOwner: claimOwner,
            runnerClaimExpiresAt: leaseExpiresAt,
            runnerClaimFence: (record.runnerClaimFence ?? 0) + 1,
            updatedAt: now,
          };
          records.tests.set(testRunId, updated);
          return structuredClone(updated);
        },
        async renewClaim(testRunId, {
          workspaceId,
          claimOwner,
          claimFence,
          now,
          leaseExpiresAt,
        }) {
          const record = records.tests.get(testRunId);
          claimRenewals.push({
            testRunId,
            workspaceId,
            claimOwner,
            claimFence,
            now,
            leaseExpiresAt,
          });
          if (renewClaimHook) {
            const overridden = await renewClaimHook({
              testRunId,
              workspaceId,
              claimOwner,
              claimFence,
              now,
              leaseExpiresAt,
            }, { record: structuredClone(record), records });
            if (overridden !== undefined) {
              return overridden === null ? null : structuredClone(overridden);
            }
          }
          if (!record || record.workspaceId !== workspaceId
            || !["queued", "running"].includes(record.status)
            || record.runnerClaimOwner !== claimOwner
            || record.runnerClaimFence !== claimFence
            || String(record.runnerClaimExpiresAt ?? "") <= now) return null;
          const updated = { ...record, runnerClaimExpiresAt: leaseExpiresAt, updatedAt: now };
          records.tests.set(testRunId, updated);
          return structuredClone(updated);
        },
        async transition(testRunId, {
          workspaceId,
          expectedStatuses,
          expectedExecutionAttempt,
          expectedClaimOwner,
          expectedClaimFence,
          expectedClaimValidAt,
          patch,
        }) {
          const record = records.tests.get(testRunId);
          if (!record
            || record.workspaceId !== workspaceId
            || !expectedStatuses.includes(record.status)
            || (Number.isSafeInteger(expectedExecutionAttempt)
              && record.executionAttempt !== expectedExecutionAttempt)
            || (expectedClaimOwner && record.runnerClaimOwner !== expectedClaimOwner)
            || (Number.isSafeInteger(expectedClaimFence)
              && record.runnerClaimFence !== expectedClaimFence)
            || (expectedClaimValidAt
              && String(record.runnerClaimExpiresAt ?? "") <= expectedClaimValidAt)) return null;
          const updated = {
            ...record,
            ...structuredClone(patch),
            testRunId: record.testRunId,
            workspaceId: record.workspaceId,
            skillId: record.skillId,
            skillDraftId: record.skillDraftId,
            packageHash: record.packageHash,
            contentHash: record.contentHash,
            testCase: record.testCase,
          };
          records.tests.set(testRunId, updated);
          return structuredClone(updated);
        },
        async listRecoverable() {
          return [...records.tests.values()]
            .filter((record) => ["queued", "running"].includes(record.status))
            .map((record) => structuredClone(record));
        },
      },
      skillTestEvidence: {
        async insertInternal(record) { records.evidence.set(record.testRunId, structuredClone(record)); return record; },
        async getInternal(testRunId, { workspaceId }) {
          const record = records.evidence.get(testRunId);
          return record?.workspaceId === workspaceId ? structuredClone(record) : null;
        },
      },
      skillValidations: {
        async insert(record) { records.validations.set(record.validationId, structuredClone(record)); return record; },
        async get(validationId, { workspaceId }) {
          const record = records.validations.get(validationId);
          return record?.workspaceId === workspaceId ? structuredClone(record) : null;
        },
      },
      skillExecutionBindings: {
        async insertInternal(record) {
          if (bindingInsertError) throw bindingInsertError;
          records.bindings.set(record.validationId, structuredClone(record));
          return record;
        },
        async getExactInternal(query) {
          return [...records.bindings.values()].find((record) =>
            record.workspaceId === query.workspaceId
            && record.skillId === query.skillId
            && record.skillDraftId === query.skillDraftId
            && record.draftRevision === query.draftRevision
            && record.contentHash === query.contentHash
            && record.packageHash === query.packageHash) ?? null;
        },
        async getByExecutionRefInternal({ workspaceId, executionRef }) {
          return [...records.bindings.values()].find((record) =>
            record.workspaceId === workspaceId
            && JSON.stringify(record.executionRef) === JSON.stringify(executionRef)) ?? null;
        },
      },
    },
  };
  const objectStore = {
    async read({ workspaceId, objectId }) {
      if (workspaceId !== "workspace-a" || objectId !== "object-1") throw coded("object_not_found");
      return { object: { workspaceId, objectId, state: "promoted", contentHash: objectHash }, bytes };
    },
  };
  const coordinator = createSkillValidationCoordinator({
    store,
    objectStore,
    ...(promptOnly ? {} : {
      isolatedExecutor: { async execute({ input }) { return structuredClone(input); } },
      imageDigest: IMAGE,
    }),
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  const executionCalls = [];
  const invocations = new Map();
  const executionBroker = {
    async getInvocation(invocationId) {
      return invocations.get(invocationId) ?? null;
    },
    async execute(executionRequest, { signal } = {}) {
      const testRunId = executionRequest.lineage.productCommandId;
      executionCalls.push(structuredClone({
        invocationId: executionRequest.invocationId,
        attemptId: executionRequest.attemptId,
        requestedBy: executionRequest.actor.userId,
        draftId: executionRequest.lineage.sessionId,
        promptTool: executionRequest.mode === "bounded_agent",
        executionRef: executionRequest.metadata.executionRef,
        commandStatusAtExecution: records.commands.get(testRunId)?.status,
        targetStatusAtExecution: records.tests.get(testRunId)?.status,
      }));
      invocations.set(executionRequest.invocationId, {
        ...structuredClone(executionRequest),
        status: "running",
        result: null,
      });
      if (executionHandler) {
        const result = await executionHandler({
          executionRequest: structuredClone(executionRequest),
          signal,
          invocations,
        });
        invocations.set(executionRequest.invocationId, {
          ...structuredClone(executionRequest),
          status: result.status,
          result: structuredClone(result),
        });
        return result;
      }
      if (executionGate) await executionGate;
      const result = {
        status: "completed",
        output: structuredClone(executionRequest.input),
        summary: "completed",
      };
      invocations.set(executionRequest.invocationId, {
        ...structuredClone(executionRequest),
        result: structuredClone(result),
      });
      return result;
    },
    async cancel(invocationId, options = {}) {
      cancellationCalls.push({ invocationId, ...structuredClone(options) });
      const current = invocations.get(invocationId);
      if (!current) return null;
      const result = current.result ?? { status: "cancelled", output: null, summary: "cancelled" };
      invocations.set(invocationId, { ...current, status: "cancelled", result });
      return result;
    },
  };
  const commandIntake = new CommandIntakeService({ store, now: () => NOW });
  const createRunner = ({
    runnerId = `runner-${++ids}`,
    retryDelayMs = 10,
    claimLeaseMs = 1_000,
    claimHeartbeatMs = 10,
  } = {}) => (
    createSkillTestRunner({
      store,
      commandIntake,
      skillValidationService: coordinator,
      executionDispatcher: executionBroker,
      materialResolver: async (input) => {
        materialResolutionCalls.push(structuredClone({
          workspaceId: input.workspaceId,
          requestedBy: input.requestedBy,
          bindings: input.bindings,
        }));
        return materialResolver(input);
      },
      modelService: {
        async resolveTurnSelection(options) {
          assert.equal(options.userId, "user-a");
          assert.deepEqual(options.requiredCapabilities, ["chat", "tool_calling"]);
          return { modelProfileRevisionId: "model-revision-test" };
        },
      },
      clock: runnerClock,
      runnerId,
      claimLeaseMs,
      claimHeartbeatMs,
      retryDelayMs,
    })
  );
  const skillTestRunner = createRunner();
  const application = createWorkbenchApplication({
    store,
    skillValidationService: coordinator,
    skillTestRunner: scheduleTests ? skillTestRunner : {
      schedule() {},
      cancel(testRunId) { return skillTestRunner.cancel(testRunId); },
    },
    commandIntake,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  return {
    application,
    commandIntake,
    coordinator,
    skillTestRunner,
    context,
    executionCalls,
    cancellationCalls,
    claimRenewals,
    materialResolutionCalls,
    invocations,
    records,
    lifecycleTransitions,
    createRunner,
    setFailTerminalCommandSettle(value) { failTerminalSettle = Boolean(value); },
    owner: { userId: "user-a", activeWorkspaceId: "workspace-a" },
    etag: formatSkillDraftEtag(draft),
  };
}

function request(data) {
  return { schemaVersion: "workbench-api-v1", data };
}

function assertProductSafe(value) {
  const forbidden = new Set([
    "workspaceid", "requestedby", "objectid", "objecthash", "packageobjectid",
    "packagehash", "contenthash", "manifest", "executionref", "imagedigest",
    "provider", "tool", "artifact", "artifactpath",
  ]);
  const visit = (entry) => {
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key.toLowerCase()), false, `forbidden public field ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

async function waitUntil(predicate, { timeoutMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw coded("test_wait_timed_out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
