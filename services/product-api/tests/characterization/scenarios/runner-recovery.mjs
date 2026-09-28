import assert from "node:assert/strict";

const LEASE_DURATION_MS = 1_000;
const BOUNDARIES = Object.freeze([
  {
    boundary: "post-claim",
    expectedStatus: "completed",
    expectedRecoveredCount: 1,
    expectedEffects: 1,
    waitForLeaseExpiry: true,
  },
  {
    boundary: "post-attempt-invocation-persistence",
    expectedStatus: "failed",
    expectedRecoveredCount: 1,
    expectedFailureCode: "side_effect_outcome_unknown",
    // The governed Broker durably records one invocation before this fault.
    // Its outcome remains unknown after recovery; this count is the immutable
    // invocation record, not a claim that the external effect completed.
    expectedEffects: 1,
    waitForLeaseExpiry: true,
  },
  {
    boundary: "waiting-review-handoff",
    expectedStatus: "completed",
    expectedRecoveredCount: 0,
    expectedEffects: 1,
    resumeReview: true,
  },
  {
    boundary: "terminal-commit-before-publish",
    expectedStatus: "completed",
    expectedRecoveredCount: 0,
    expectedEffects: 1,
  },
]);

function requireContext(context) {
  assert.equal(typeof context?.adapter, "string");
  assert.equal(typeof context?.ids, "function");
  assert.equal(typeof context?.deferCleanup, "function");
  assert.equal(typeof context?.runnerRecovery?.spawn, "function");
  assert.equal(typeof context?.runnerRecovery?.snapshot, "function");
  assert.equal(typeof context?.runnerRecovery?.waitUntilLeaseExpired, "function");
  return context;
}

async function runSigkillDurableBoundaries(rawContext) {
  const context = requireContext(rawContext);
  const children = new Set();
  context.deferCleanup(async () => {
    await Promise.allSettled([...children].map((child) => child.stop()));
  });

  const outcomes = [];
  for (const scenario of BOUNDARIES) {
    try {
      outcomes.push(await exerciseBoundary({ context, children, scenario }));
    } catch (error) {
      error.message = `${scenario.boundary}:${error.message}`;
      throw error;
    }
  }

  return {
    result: {
      status: "passed",
      killedProcesses: outcomes.length,
      recoveredBoundaries: outcomes.filter((item) => item.recoveredCount > 0).length,
    },
    errors: outcomes
      .filter((item) => item.failureCode)
      .map((item) => ({ code: item.failureCode, retryable: false })),
    state: {
      boundaries: outcomes.map((item) => ({
        boundary: item.boundary,
        runStatus: item.runStatus,
        readModelStatus: item.readModelStatus,
        jobStatus: item.jobStatus,
        recoveredCount: item.recoveredCount,
        secondRecoveryCount: item.secondRecoveryCount,
        terminalEventCount: item.terminalEventCount,
        checkpointCount: item.checkpointCount,
        terminalTransitionCount: item.terminalTransitionCount,
        leaseCount: item.leaseCount,
        activeLeaseCount: item.activeLeaseCount,
        effectCount: item.effectCount,
        effectInvocationIdsUnique: item.effectInvocationIdsUnique,
        outcomeUnknownConverged: item.outcomeUnknownConverged,
        reviewDecisionApplied: item.reviewDecisionApplied,
        terminalMarkerLinked: item.terminalMarkerLinked,
        contiguousEventSequence: item.contiguousEventSequence,
        contiguousStateSequence: item.contiguousStateSequence,
        contiguousCheckpointSequence: item.contiguousCheckpointSequence,
      })),
    },
    events: outcomes
      .flatMap((item) => item.events)
      .map((event, index) => ({
        sequence: index + 1,
        type: event.type,
        status: event.status,
      })),
    invariants: {
      sigkillOccursAfterDurableBoundaryMarker: outcomes.every((item) => item.sigkillObserved),
      firstRestartReachesExpectedTerminalState: outcomes.every((item) => item.runStatus === item.expectedStatus),
      secondRecoveryIsIdempotent: outcomes.every((item) => item.secondRecoveryCount === 0),
      runAndReadModelConverge: outcomes.every((item) => item.runStatus === item.readModelStatus),
      eventSequencesRemainContiguous: outcomes.every((item) => item.contiguousEventSequence),
      stateSequencesRemainContiguous: outcomes.every((item) => item.contiguousStateSequence),
      checkpointSequencesRemainContiguous: outcomes.every((item) => item.contiguousCheckpointSequence),
      oneTerminalEventPerRun: outcomes.every((item) => item.terminalEventCount === 1),
      oneTerminalTransitionPerRun: outcomes.every((item) => item.terminalTransitionCount === 1),
      oneSkillAttemptPerRecoveredRun: outcomes.every((item) => item.skillAttemptCount === 1),
      terminalJobsReleaseOwnership: outcomes.every((item) => item.jobOwnerCleared),
      terminalRunsHaveNoActiveLease: outcomes.every((item) => item.activeLeaseCount === 0),
      terminalRunsHaveOneReleasedOrCancelledLease: outcomes.every((item) => item.leaseCount === 1 && item.terminalLeaseReleased),
      effectCountsMatchBoundaryContract: outcomes.every((item) => item.effectCount === item.expectedEffects),
      effectInvocationIdentityIsUnique: outcomes.every((item) => item.effectInvocationIdsUnique),
      unknownOutcomeConvergesAcrossReadModelAndAttempt: outcomes.every((item) => item.outcomeUnknownConverged),
      reviewApprovalIsAppliedExactlyOnce: outcomes.every((item) => item.reviewDecisionApplied),
      terminalEventLinksExactDurableBoundary: outcomes.every((item) => item.terminalMarkerLinked),
    },
  };
}

async function exerciseBoundary({ context, children, scenario }) {
  const expectedStatus = scenario.expectedStatus;
  const killed = await WorkerHarness.spawn({
    context,
    scenario: scenario.boundary,
    workerId: context.ids(`${scenario.boundary}-killed`),
    faultBoundary: scenario.boundary,
  });
  children.add(killed);
  let restarted = null;
  try {
    const run = await killed.command("start");
    // Keep the recovery outcome handled while waiting for the durable fault
    // marker. Otherwise a premature worker exit turns into an unhandled
    // assertion rejection and hides the actual boundary failure.
    const interruptedRecovery = killed.command("recover", {}, 20_000).then(
      (recovery) => ({ kind: "recovery", recovery }),
      (error) => ({ kind: "error", error }),
    );
    const observed = await Promise.race([
      killed.waitForFault(scenario.boundary, 10_000).then((fault) => ({ kind: "fault", fault })),
      interruptedRecovery,
    ]);
    if (observed.kind !== "fault") {
      const detail = observed.kind === "recovery"
        ? JSON.stringify(observed.recovery)
        : [observed.error?.code, observed.error?.message].filter(Boolean).join(":") || "unknown";
      const snapshot = await durableSnapshot(context, run.runId, scenario.boundary);
      throw new Error(
        `worker_recovery_completed_before_fault:${scenario.boundary}:${detail}`
        + `:snapshot:${JSON.stringify(snapshot)}:worker_stderr:${killed.stderr}`,
      );
    }
    const { fault } = observed;
    assert.equal(fault.context.runId, run.runId);

    const beforeKill = await durableSnapshot(context, run.runId, scenario.boundary);
    assert.equal(beforeKill.run?.runId, run.runId);
    assertBoundaryState(beforeKill, scenario.boundary);
    await killed.sigkill();
    const interrupted = await interruptedRecovery;
    assert.equal(interrupted.kind, "error");
    assert.match(interrupted.error.message, /worker_exited.*SIGKILL/);

    if (scenario.waitForLeaseExpiry) {
      await context.runnerRecovery.waitUntilLeaseExpired({ runId: run.runId, timeoutMs: 5_000 });
    }

    restarted = await WorkerHarness.spawn({
      context,
      scenario: scenario.boundary,
      workerId: context.ids(`${scenario.boundary}-restarted`),
    });
    children.add(restarted);
    const firstRecovery = await restarted.command("recover", {}, 20_000);
    const afterFirstRecovery = await durableSnapshot(context, run.runId, scenario.boundary);
    assert.equal(
      firstRecovery.recoveredRunIds.length,
      scenario.expectedRecoveredCount,
      `unexpected_recovery_count:${scenario.boundary}:${JSON.stringify({ firstRecovery, afterFirstRecovery })}`,
    );
    if (scenario.expectedRecoveredCount === 1) {
      assert.deepEqual(firstRecovery.recoveredRunIds, [run.runId]);
    }

    const secondRecovery = await restarted.command("recover", {}, 20_000);
    assert.deepEqual(
      secondRecovery.recoveredRunIds,
      [],
      `second_recovery_not_idempotent:${JSON.stringify(afterFirstRecovery)}:worker_stderr:${restarted.stderr}`,
    );
    const afterSecondRecovery = await durableSnapshot(context, run.runId, scenario.boundary);
    assert.deepEqual(afterSecondRecovery, afterFirstRecovery);

    if (scenario.resumeReview) {
      assert.equal(afterSecondRecovery.run.status, "waiting_review");
      await restarted.command("approve", { runId: run.runId }, 20_000);
      try {
        await waitFor(async () => (
          (await context.runnerRecovery.snapshot({ runId: run.runId, scenario: scenario.boundary })).run?.status === "completed"
        ), { timeoutMs: 10_000, label: `${scenario.boundary}:review-completion` });
      } catch (error) {
        const diagnostic = await context.runnerRecovery.snapshot({
          runId: run.runId,
          scenario: scenario.boundary,
        });
        error.message = `${error.message}:${JSON.stringify(diagnostic)}`;
        throw error;
      }
    }

    const final = await durableSnapshot(context, run.runId, scenario.boundary);
    assert.equal(
      final.run.status,
      expectedStatus,
      `unexpected_final_run_status:${scenario.boundary}:${JSON.stringify(final)}:worker_stderr:${restarted.stderr}`,
    );
    assert.equal(final.readModel.status, expectedStatus);
    assert.equal(final.job.status, expectedStatus);
    assert.equal(final.job.leaseOwner, null);
    assert.equal(final.job.leaseExpiresAt, null);
    assert.equal(final.leases.filter((lease) => lease.status === "active").length, 0);
    assert.equal(final.leases.length, 1);
    assert.ok(["released", "cancelled"].includes(final.leases[0].status));
    assert.equal(final.effects.length, scenario.expectedEffects);
    assert.equal(final.effects.every((effect) => (
      typeof effect.invocationId === "string" && effect.invocationId.length > 0
    )), true);
    assert.equal(new Set(final.effects.map((effect) => effect.invocationId)).size, final.effects.length);
    assertContiguous(final.events.map((event) => event.sequence));
    assertContiguous(final.stateEvents.map((event) => event.sequence));
    assertContiguous(final.checkpoints.map((checkpoint) => checkpoint.sequence));
    assert.equal(final.job.checkpointSequence, final.checkpoints.length);
    const terminalEvents = final.events.filter((event) => event.type === `run.${expectedStatus}`);
    assert.equal(terminalEvents.length, 1);
    assertTerminalLinkage(final, expectedStatus);
    const skillAttempts = final.attempts.filter((attempt) => attempt.nodeId === "node-skill");
    assert.equal(skillAttempts.length, 1);
    assert.deepEqual(skillAttempts.map((attempt) => attempt.attempt), [1]);
    if (scenario.expectedFailureCode) {
      assert.equal(final.readModel.failure?.code, scenario.expectedFailureCode);
      assert.equal(skillAttempts[0].failureCode, scenario.expectedFailureCode);
      assert.equal(skillAttempts[0].invocationStatus, "outcome_unknown");
    }
    const reviewDecisionApplied = scenario.resumeReview
      ? final.decisions.length === 1
        && final.decisions[0].decision === "approve"
        && final.decisions[0].applicationStatus === "applied"
      : final.decisions.length === 0;
    assert.equal(reviewDecisionApplied, true);
    const outcomeUnknownConverged = scenario.expectedFailureCode
      ? final.readModel.failure?.code === scenario.expectedFailureCode
        && skillAttempts[0].failureCode === scenario.expectedFailureCode
        && skillAttempts[0].invocationStatus === "outcome_unknown"
      : true;

    return {
      boundary: scenario.boundary,
      expectedStatus,
      expectedEffects: scenario.expectedEffects,
      runStatus: final.run.status,
      readModelStatus: final.readModel.status,
      jobStatus: final.job.status,
      recoveredCount: firstRecovery.recoveredRunIds.length,
      secondRecoveryCount: secondRecovery.recoveredRunIds.length,
      terminalEventCount: terminalEvents.length,
      checkpointCount: final.checkpoints.length,
      terminalTransitionCount: final.terminalTransitions.length,
      skillAttemptCount: skillAttempts.length,
      leaseCount: final.leases.length,
      activeLeaseCount: final.leases.filter((lease) => lease.status === "active").length,
      terminalLeaseReleased: ["released", "cancelled"].includes(final.leases[0].status),
      effectCount: final.effects.length,
      effectInvocationIdsUnique: final.effects.every((effect) => (
        typeof effect.invocationId === "string" && effect.invocationId.length > 0
      )) && new Set(final.effects.map((effect) => effect.invocationId)).size === final.effects.length,
      outcomeUnknownConverged,
      reviewDecisionApplied,
      terminalMarkerLinked: terminalLinkageMatches(final, expectedStatus),
      contiguousEventSequence: isContiguous(final.events.map((event) => event.sequence)),
      contiguousStateSequence: isContiguous(final.stateEvents.map((event) => event.sequence)),
      contiguousCheckpointSequence: isContiguous(final.checkpoints.map((checkpoint) => checkpoint.sequence)),
      jobOwnerCleared: final.job.leaseOwner === null && final.job.leaseExpiresAt === null,
      sigkillObserved: killed.exited?.signal === "SIGKILL",
      failureCode: scenario.expectedFailureCode ?? null,
      events: final.events,
    };
  } finally {
    if (restarted) {
      await restarted.stop();
      children.delete(restarted);
    }
    await killed.stop();
    children.delete(killed);
  }
}

async function durableSnapshot(context, runId, scenario) {
  return context.runnerRecovery.snapshot({ runId, scenario });
}

function assertBoundaryState(snapshot, boundary) {
  if (boundary === "post-claim") {
    // B3's PostgreSQL claim function atomically writes run.started and moves
    // the Run projection to running. The historical Mongo job claim leaves
    // the Run queued until the runner performs its next transition.
    const claimedRunStatus = usesEventDurableBoundary(snapshot) ? "running" : "queued";
    assert.equal(snapshot.run.status, claimedRunStatus);
    assert.equal(snapshot.readModel.status, claimedRunStatus);
    assert.ok(["leased", "running"].includes(snapshot.job.status));
    assert.deepEqual(snapshot.attempts, []);
    if (!usesEventDurableBoundary(snapshot)) assert.deepEqual(snapshot.checkpoints, []);
    assert.equal(snapshot.leases.filter((lease) => lease.status === "active").length, 1);
    assert.equal(snapshot.effects.length, 0);
    assert.equal(snapshot.terminalTransitions.length, 0);
    return;
  }
  if (boundary === "post-attempt-invocation-persistence") {
    const skillAttempt = snapshot.attempts.find((attempt) => attempt.nodeId === "node-skill");
    assert.equal(snapshot.run.status, "running");
    assert.equal(snapshot.readModel.status, "running");
    assert.equal(skillAttempt?.status, "running");
    assert.equal(skillAttempt?.invocationStatus, "started");
    assert.equal(skillAttempt?.hasInvocationIdentity, true);
    assert.equal(snapshot.leases.filter((lease) => lease.status === "active").length, 1);
    assert.equal(snapshot.effects.length, 1);
    assert.equal(snapshot.terminalTransitions.length, 0);
    return;
  }
  if (boundary === "waiting-review-handoff") {
    assert.equal(snapshot.run.status, "waiting_review");
    assert.equal(snapshot.readModel.status, "waiting_review");
    assert.equal(snapshot.job.status, "paused");
    if (!usesEventDurableBoundary(snapshot)) {
      assert.deepEqual(snapshot.checkpoints.map((checkpoint) => checkpoint.sequence), [1, 2, 3]);
    }
    assert.equal(snapshot.events.filter((event) => event.type === "review.requested").length, 1);
    assert.equal(snapshot.leases.filter((lease) => lease.status === "active").length, 0);
    assert.equal(snapshot.effects.length, 1);
    assert.equal(snapshot.terminalTransitions.length, 0);
    return;
  }
  if (boundary === "terminal-commit-before-publish") {
    assert.equal(snapshot.run.status, "completed");
    assert.equal(snapshot.readModel.status, "completed");
    assert.equal(snapshot.job.status, "completed");
    assert.equal(snapshot.leases.filter((lease) => lease.status === "active").length, 0);
    assert.equal(snapshot.effects.length, 1);
    assert.equal(snapshot.terminalTransitions.length, 1);
    if (!usesEventDurableBoundary(snapshot)) {
      assert.equal(snapshot.checkpoints.filter((checkpoint) => checkpoint.terminal).length, 1);
    }
    assertTerminalLinkage(snapshot, "completed");
  }
}

function terminalLinkageMatches(snapshot, expectedStatus) {
  const terminalEvents = snapshot.events.filter((event) => event.type === `run.${expectedStatus}`);
  const terminalCheckpoints = snapshot.checkpoints.filter((checkpoint) => checkpoint.terminal);
  const [transition] = snapshot.terminalTransitions;
  if (usesEventDurableBoundary(snapshot)) {
    return terminalEvents.length === 1
      && snapshot.terminalTransitions.length === 1
      && transition.status === expectedStatus
      && transition.eventId === terminalEvents[0].eventId
      && transition.checkpointId === null;
  }
  return terminalEvents.length === 1
    && terminalCheckpoints.length === 1
    && snapshot.terminalTransitions.length === 1
    && transition.status === expectedStatus
    && transition.eventId === terminalEvents[0].eventId
    && transition.checkpointId === terminalCheckpoints[0].checkpointId;
}

function usesEventDurableBoundary(snapshot) {
  return snapshot?.durableBoundaryMode === "event";
}

function assertTerminalLinkage(snapshot, expectedStatus) {
  assert.equal(terminalLinkageMatches(snapshot, expectedStatus), true);
}

class WorkerHarness {
  constructor(child) {
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    this.requestSequence = 0;
    this.pending = new Map();
    this.faults = new Map();
    this.faultWaiters = new Set();
    this.exited = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.stdout += chunk;
      this.#resolveFaultWaiters();
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    child.on("message", (message) => {
      if (message?.type === "fault") {
        this.faults.set(message.boundary, message);
        this.#resolveFaultWaiters();
      }
      if (message?.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(workerError(message.error));
      }
    });
    child.once("error", (error) => this.#rejectWaiters(error));
    child.once("exit", (code, signal) => {
      this.exited = { code, signal };
      const error = new Error(`worker_exited:${code ?? "null"}:${signal ?? "none"}\n${this.stderr}`);
      this.#rejectWaiters(error);
    });
  }

  static async spawn({ context, scenario, workerId, faultBoundary = "" }) {
    const child = await context.runnerRecovery.spawn({
      scenario,
      workerId,
      faultBoundary,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    assertWorkerChild(child);
    const harness = new WorkerHarness(child);
    return harness;
  }

  command(command, data = {}, timeoutMs = 10_000) {
    if (this.exited) {
      return Promise.reject(new Error(`worker_exited:${this.exited.code}:${this.exited.signal}`));
    }
    const requestId = `request-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`worker_command_timeout:${command}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ requestId, command, ...data }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  waitForFault(boundary, timeoutMs) {
    const fault = this.faults.get(boundary);
    if (fault?.marker && this.stdout.includes(fault.marker)) return Promise.resolve(fault);
    return new Promise((resolve, reject) => {
      const waiter = {
        boundary,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.faultWaiters.delete(waiter);
          reject(new Error(`fault_marker_timeout:${boundary}`));
        }, timeoutMs),
      };
      this.faultWaiters.add(waiter);
    });
  }

  async sigkill() {
    if (this.exited) return this.exited;
    assert.equal(this.child.kill("SIGKILL"), true);
    await waitFor(() => Boolean(this.exited), { timeoutMs: 5_000, label: "child-sigkill-exit" });
    assert.equal(this.exited.signal, "SIGKILL");
    return this.exited;
  }

  async stop() {
    if (this.exited) return;
    try {
      await this.command("close", {}, 2_000);
      await waitFor(() => Boolean(this.exited), { timeoutMs: 2_000, label: "child-clean-exit" });
    } catch {
      if (!this.exited) await this.sigkill();
    }
  }

  #resolveFaultWaiters() {
    for (const waiter of this.faultWaiters) {
      const fault = this.faults.get(waiter.boundary);
      if (!fault?.marker || !this.stdout.includes(fault.marker)) continue;
      clearTimeout(waiter.timer);
      this.faultWaiters.delete(waiter);
      waiter.resolve(fault);
    }
  }

  #rejectWaiters(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.faultWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.faultWaiters.clear();
  }
}

function assertWorkerChild(child) {
  if (!child?.stdout || !child?.stderr
    || typeof child.on !== "function"
    || typeof child.once !== "function"
    || typeof child.send !== "function"
    || typeof child.kill !== "function"
    || child.exitCode !== null
    || child.signalCode !== null) {
    throw new TypeError("characterization_runner_recovery_child_invalid");
  }
}

function isContiguous(sequences) {
  return sequences.every((sequence, index) => sequence === index + 1);
}

function assertContiguous(sequences) {
  assert.equal(isContiguous(sequences), true);
}

async function waitFor(predicate, { timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const error = new Error(`wait_for_timeout:${label}`);
  error.code = "characterization_wait_timeout";
  throw error;
}

function workerError(payload) {
  const error = new Error(payload?.message ?? "worker_error");
  error.name = payload?.name ?? "Error";
  error.code = payload?.code;
  error.stack = payload?.stack ?? error.stack;
  return error;
}

export const scenarios = [
  { id: "runner.sigkill-durable-boundaries", run: runSigkillDurableBoundaries },
];
