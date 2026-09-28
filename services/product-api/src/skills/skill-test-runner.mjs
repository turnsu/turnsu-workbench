import { randomUUID } from "node:crypto";

import { validateRequiredConnectionBindings } from "../connections/workspace-connection-service.mjs";
import { ProductStoreError } from "../store/errors.mjs";

const TERMINAL_TARGET_STATUSES = new Set(["passed", "failed", "blocked", "cancelled"]);
const COMMAND_STATUS_BY_TARGET = Object.freeze({
  passed: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
});
const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_CLAIM_HEARTBEAT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export function createSkillTestRunner(options) {
  return new SkillTestRunner(options);
}

// Product-owned durable coordinator for Skill tests. The HTTP request only
// persists the ProductCommand and queued target; this runner owns dispatch,
// restart recovery, and terminal settlement.
export class SkillTestRunner {
  #testRuns;
  #resolveValidationContext;
  #resolveConnectionBindings;
  #commandIntake;
  #validation;
  #executionDispatcher;
  #materialResolver;
  #modelService;
  #clock;
  #runnerId;
  #claimLeaseMs;
  #claimHeartbeatMs;
  #retryDelayMs;
  #active = new Map();
  #controllers = new Map();
  #workspaceIds = new Map();
  #retryTimers = new Map();
  #stopped = false;

  constructor({
    store,
    skillTestPersistence = null,
    resolveSkillValidationContext = null,
    resolveConnectionBindings = null,
    commandIntake,
    skillValidationService,
    executionDispatcher,
    materialResolver,
    modelService = null,
    clock = () => new Date().toISOString(),
    runnerId = `skill-test-runner-${randomUUID()}`,
    claimLeaseMs = DEFAULT_CLAIM_LEASE_MS,
    claimHeartbeatMs = Math.min(DEFAULT_CLAIM_HEARTBEAT_MS, Math.floor(claimLeaseMs / 3)),
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = {}) {
    const testRuns = skillTestPersistence ?? legacySkillTestPersistence(store);
    if (!testRuns?.getTestRun || !testRuns?.listRecoverable || !testRuns?.claim
      || !testRuns?.renewClaim || !testRuns?.transitionTestRun || !testRuns?.withTransaction) {
      throw new TypeError("skill_test_runner_store_required");
    }
    if (!commandIntake?.recover
      || !commandIntake?.recoverByLineage
      || !commandIntake?.listRecoverable
      || !commandIntake?.start
      || !commandIntake?.settle) {
      throw new TypeError("skill_test_runner_command_intake_required");
    }
    if (!skillValidationService?.prepareTestIntake
      || !skillValidationService?.startAcceptedTestRun
      || !skillValidationService?.prepareAcceptedTestExecution
      || !skillValidationService?.classifyAcceptedTestOutcome
      || !skillValidationService?.classifyPersistedAcceptedTestOutcome
      || !skillValidationService?.settleAcceptedTestRun
      || !skillValidationService?.blockedAcceptedTestOutcome
      || !skillValidationService?.cancelledAcceptedTestOutcome
      || !skillValidationService?.requeueAcceptedTestRun
      || !skillValidationService?.testExecutionIdentity) {
      throw new TypeError("skill_test_runner_validation_service_required");
    }
    if (!executionDispatcher?.execute || !executionDispatcher?.cancel || !executionDispatcher?.getInvocation) {
      throw new TypeError("skill_test_runner_execution_dispatcher_required");
    }
    if (typeof materialResolver !== "function") {
      throw new TypeError("skill_test_runner_material_resolver_required");
    }
    if (typeof runnerId !== "string" || runnerId.length === 0
      || !Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1_000
      || !Number.isSafeInteger(claimHeartbeatMs) || claimHeartbeatMs < 1
      || claimHeartbeatMs >= claimLeaseMs
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
      throw new TypeError("skill_test_runner_coordination_invalid");
    }
    this.#testRuns = testRuns;
    this.#resolveValidationContext = resolveSkillValidationContext
      ?? (typeof store?.resolveSkillValidationContext === "function"
        ? (input) => store.resolveSkillValidationContext(input)
        : null);
    this.#resolveConnectionBindings = resolveConnectionBindings
      ?? (store?.repositories
        ? (input) => validateRequiredConnectionBindings({ ...input, repositories: store.repositories })
        : null);
    if (typeof this.#resolveValidationContext !== "function") {
      throw new TypeError("skill_test_runner_validation_context_required");
    }
    this.#commandIntake = commandIntake;
    this.#validation = skillValidationService;
    this.#executionDispatcher = executionDispatcher;
    this.#materialResolver = materialResolver;
    this.#modelService = modelService;
    this.#clock = clock;
    this.#runnerId = runnerId;
    this.#claimLeaseMs = claimLeaseMs;
    this.#claimHeartbeatMs = claimHeartbeatMs;
    this.#retryDelayMs = retryDelayMs;
  }

  schedule(testRunId, { recovering = false, workspaceId = null } = {}) {
    if (this.#stopped) return Promise.resolve(null);
    if (this.#active.has(testRunId)) return this.#active.get(testRunId);
    this.#clearRetry(testRunId);
    const controller = new AbortController();
    this.#controllers.set(testRunId, controller);
    if (workspaceId) this.#workspaceIds.set(testRunId, workspaceId);
    const operation = this.#execute(testRunId, { recovering, workspaceId, controller })
      .catch(() => {
        this.#scheduleRetry(testRunId, { recovering: true, workspaceId });
        return null;
      })
      .finally(() => {
        if (this.#active.get(testRunId) === operation) this.#active.delete(testRunId);
        if (this.#controllers.get(testRunId) === controller) this.#controllers.delete(testRunId);
        if (this.#workspaceIds.get(testRunId) === workspaceId) this.#workspaceIds.delete(testRunId);
      });
    this.#active.set(testRunId, operation);
    return operation;
  }

  cancel(testRunId, { workspaceId = null } = {}) {
    if (this.#stopped) return Promise.resolve(null);
    const controller = this.#controllers.get(testRunId);
    if (controller && !controller.signal.aborted) {
      controller.abort(runnerError(
        "skill_test_cancellation_requested",
        "The Skill test cancellation was requested.",
        "cancelled",
      ));
    }
    return this.#active.get(testRunId) ?? this.schedule(testRunId, { recovering: true, workspaceId });
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    const activeIds = [...this.#controllers.keys()];
    for (const controller of this.#controllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(runnerError(
          "skill_test_runner_stopped",
          "The Skill test runner stopped before execution completed.",
        ));
      }
    }
    await Promise.allSettled(activeIds.map(async (testRunId) => {
      const entry = await this.#testRuns.getTestRun({ testRunId, workspaceId: this.#workspaceIds.get(testRunId) ?? null });
      const target = entry?.record ?? entry;
      if (!target || TERMINAL_TARGET_STATUSES.has(target.status)) return;
      const attempt = target.executionAttempt ?? 1;
      const identity = this.#validation.testExecutionIdentity(testRunId, attempt);
      await this.#executionDispatcher.cancel(identity.invocationId, {
        reason: "skill_test_runner_stopped",
      });
    }));
    await Promise.allSettled([...this.#active.values()]);
  }

  async recover() {
    if (this.#stopped) return { recoveredTestRunIds: [] };
    const [records, commands] = await Promise.all([
      this.#testRuns.listRecoverable(),
      this.#commandIntake.listRecoverable({ kind: "skill_test" }),
    ]);
    const byId = new Map(records.map((record) => [record.testRunId, record]));
    for (const command of commands) {
      if (!byId.has(command.commandId)) {
      const entry = await this.#testRuns.getTestRun({ testRunId: command.commandId, workspaceId: command.workspaceId });
      const target = entry?.record ?? entry;
        if (target) byId.set(command.commandId, target);
      }
    }
    for (const record of byId.values()) {
      this.schedule(record.testRunId, { recovering: record.status === "running", workspaceId: record.workspaceId });
    }
    return { recoveredTestRunIds: [...byId.keys()] };
  }

  async waitForIdle() {
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active.values()]);
    }
  }

  async #execute(testRunId, { recovering, workspaceId, controller }) {
    let state = await this.#loadState(testRunId, { workspaceId });
    if (!state) return null;
    if (TERMINAL_TARGET_STATUSES.has(state.target.status)) {
      await this.#settleCommand(state.principal, testRunId, state.target.status);
      return state.target;
    }

    const claimed = await this.#claim(state.target);
    if (!claimed) {
      this.#scheduleRetry(testRunId, { recovering: true, workspaceId: state.target.workspaceId });
      return null;
    }
    state = await this.#loadState(testRunId, { workspaceId: state.target.workspaceId });
    if (!state || !this.#ownsClaim(state.target, claimed)) return null;
    let attempt = state.target.executionAttempt ?? 1;
    const heartbeat = this.#startClaimHeartbeat({
      testRunId,
      workspaceId: state.target.workspaceId,
      claim: claimed,
      attempt,
      principal: state.principal,
      controller,
    });

    try {
      if (state.command.status === "cancellation_requested") {
        return await this.#cancelRequested(state, claimed, attempt);
      }

      if (recovering && state.target.status === "running") {
        state = await this.#recoverRunning(state, claimed);
        if (!state || TERMINAL_TARGET_STATUSES.has(state.target.status)) return state?.target ?? null;
        attempt = state.target.executionAttempt ?? attempt;
        heartbeat.setAttempt(attempt);
      }

      const recoveredOutcome = state.target.status === "running"
        ? await this.#classifyDurableInvocation(state.target, attempt)
        : null;
      if (recoveredOutcome) {
        return await this.#settleTerminal(testRunId, recoveredOutcome, { attempt, claim: claimed });
      }

      let execution;
      let prepared;
      try {
        execution = await this.#resolveExecutionInput(state, controller.signal);
        throwIfControlAborted(controller.signal);
        prepared = this.#validation.prepareTestIntake(execution.input, execution.inspection);
      } catch (error) {
        throwIfControlAborted(controller.signal);
        return await this.#settleTerminal(
          testRunId,
          this.#blockedOutcome(state.target, error),
          { attempt, claim: claimed },
        );
      }

      const started = await this.#testRuns.withTransaction(async (uow) => {
        const current = await this.#loadState(testRunId, { workspaceId: state.target.workspaceId, uow });
        if (!current || TERMINAL_TARGET_STATUSES.has(current.target.status)) return current?.target ?? null;
        if (!this.#ownsClaim(current.target, claimed)
          || (current.target.executionAttempt ?? 1) !== attempt) {
          throw runnerError("skill_test_transition_conflict", "The Skill test runner lost its execution fence.");
        }
        if (current.command.status === "cancellation_requested") return current.target;
        const identity = this.#validation.testExecutionIdentity(testRunId, attempt);
        if (current.command.status === "accepted") {
          await this.#commandIntake.start({
            principal: current.principal,
            commandId: testRunId,
            ...identity,
            at: this.#timestamp(),
            session: uow,
            uow,
          });
        } else if (current.command.status !== "running") {
          throw runnerError("skill_test_transition_conflict", "The Skill test command cannot be started.");
        }
        return current.target.status === "queued"
          ? this.#validation.startAcceptedTestRun(
              {
                workspaceId: current.target.workspaceId,
                testRunId,
                expectedAttempt: attempt,
                expectedClaimOwner: claimed.runnerClaimOwner,
                expectedClaimFence: claimed.runnerClaimFence,
                expectedClaimValidAt: this.#timestamp(),
              },
              prepared,
              { session: uow, uow },
            )
          : current.target;
      });
      if (!started || TERMINAL_TARGET_STATUSES.has(started.status)) return started;

      const commandAfterStart = await this.#commandIntake.recover({
        principal: state.principal,
        commandId: testRunId,
      });
      if (commandAfterStart?.status === "cancellation_requested") {
        return await this.#cancelRequested(
          { ...state, target: { ...state.target, startedAt: started.startedAt }, command: commandAfterStart },
          claimed,
          attempt,
        );
      }

      let outcome;
      try {
        const dispatch = await this.#validation.prepareAcceptedTestExecution(execution.input, prepared);
        throwIfControlAborted(controller.signal);
        try {
          const result = await this.#dispatch({ ...dispatch, signal: controller.signal });
          throwIfControlAborted(controller.signal);
          outcome = this.#validation.classifyAcceptedTestOutcome(execution.input, prepared, {
            result,
            startedAt: dispatch.startedAt,
          });
        } catch (error) {
          throwIfControlAborted(controller.signal);
          outcome = this.#validation.classifyAcceptedTestOutcome(execution.input, prepared, {
            failure: error,
            startedAt: dispatch.startedAt,
          });
        }
      } catch (error) {
        throwIfControlAborted(controller.signal);
        outcome = this.#blockedOutcome({ ...state.target, startedAt: started.startedAt }, error);
      }
      const commandBeforeSettle = await this.#commandIntake.recover({
        principal: state.principal,
        commandId: testRunId,
      });
      if (commandBeforeSettle?.status === "cancellation_requested") {
        return await this.#cancelRequested(
          { ...state, target: { ...state.target, startedAt: started.startedAt }, command: commandBeforeSettle },
          claimed,
          attempt,
        );
      }
      return await this.#settleTerminal(testRunId, outcome, { attempt, claim: claimed });
    } catch (caught) {
      let error = caught;
      if (isFenceConflict(error)) return null;
      if (error?.code === "skill_test_cancellation_requested") {
        try {
          const latest = await this.#loadState(testRunId, { workspaceId: state.target.workspaceId });
          if (latest?.command.status === "cancellation_requested"
            && this.#ownsClaim(latest.target, claimed)
            && (latest.target.executionAttempt ?? 1) === attempt) {
            return await this.#cancelRequested(latest, claimed, attempt);
          }
        } catch (cancellationError) {
          error = cancellationError;
        }
      }
      await this.#recordSettlementFailure(testRunId, state.target.workspaceId, {
        attempt,
        claim: claimed,
        error,
      });
      this.#scheduleRetry(testRunId, { recovering: true, workspaceId: state.target.workspaceId });
      return null;
    } finally {
      heartbeat.stop();
      if (heartbeat.lost) this.#scheduleRetry(testRunId, { recovering: true, workspaceId: state.target.workspaceId });
    }
  }

  async #recoverRunning(state, claim) {
    const attempt = state.target.executionAttempt ?? 1;
    const identity = this.#validation.testExecutionIdentity(state.target.testRunId, attempt);
    const invocation = await this.#executionDispatcher.getInvocation(identity.invocationId);
    if (!invocation) return state;
    if (invocation.result) {
      if (invocation.result.status !== "cancelled") return state;
      if (["cancellation_requested", "cancelled"].includes(state.command.status)) return state;
    } else {
      await this.#executionDispatcher.cancel(identity.invocationId, {
        reason: "skill_test_startup_recovery",
      });
    }
    const nextAttempt = attempt + 1;
    await this.#testRuns.withTransaction(async (uow) => {
      const current = await this.#loadState(state.target.testRunId, { workspaceId: state.target.workspaceId, uow });
      if (!current || current.target.status !== "running" || current.command.status !== "running") return;
      await this.#commandIntake.requeue({
        principal: current.principal,
        commandId: current.target.testRunId,
        at: this.#timestamp(),
        session: uow,
        uow,
      });
      await this.#validation.requeueAcceptedTestRun({
        workspaceId: current.target.workspaceId,
        testRunId: current.target.testRunId,
        expectedAttempt: attempt,
        nextAttempt,
        expectedClaimOwner: claim.runnerClaimOwner,
        expectedClaimFence: claim.runnerClaimFence,
        expectedClaimValidAt: this.#timestamp(),
      }, { session: uow, uow });
    });
    return this.#loadState(state.target.testRunId, { workspaceId: state.target.workspaceId });
  }

  async #claim(target) {
    const now = this.#timestamp();
    return this.#testRuns.claim({
      workspaceId: target.workspaceId,
      testRunId: target.testRunId,
      claimOwner: this.#runnerId,
      now,
      leaseExpiresAt: addMilliseconds(now, this.#claimLeaseMs),
      expectedStatuses: [target.status],
    });
  }

  #startClaimHeartbeat({ testRunId, workspaceId, claim, attempt, principal, controller }) {
    let stopped = false;
    let lost = false;
    let currentAttempt = attempt;
    let timer = null;
    const cancelExactAttempt = async (reason) => {
      const identity = this.#validation.testExecutionIdentity(testRunId, currentAttempt);
      await this.#executionDispatcher.cancel(identity.invocationId, { reason }).catch(() => null);
    };
    const abort = async (code, message, { claimLost = false } = {}) => {
      if (claimLost) lost = true;
      if (!controller.signal.aborted) {
        controller.abort(runnerError(code, message, "cancelled"));
      }
      await cancelExactAttempt(code);
    };
    const scheduleNext = () => {
      if (stopped || controller.signal.aborted) return;
      timer = setTimeout(tick, this.#claimHeartbeatMs);
    };
    const tick = async () => {
      if (stopped || controller.signal.aborted) return;
      try {
        const now = this.#timestamp();
        const renewed = await this.#testRuns.renewClaim({
          workspaceId,
          testRunId,
          claimOwner: claim.runnerClaimOwner,
          claimFence: claim.runnerClaimFence,
          now,
          leaseExpiresAt: addMilliseconds(now, this.#claimLeaseMs),
        });
        if (stopped || controller.signal.aborted) return;
        if (!renewed) {
          await abort(
            "skill_test_claim_lost",
            "The Skill test runner lost its durable execution claim.",
            { claimLost: true },
          );
          return;
        }
        const command = await this.#commandIntake.recover({
          principal,
          commandId: testRunId,
        });
        if (stopped || controller.signal.aborted) return;
        if (["cancellation_requested", "cancelled"].includes(command?.status)) {
          await abort(
            "skill_test_cancellation_requested",
            "The Skill test cancellation was requested.",
          );
          return;
        }
        scheduleNext();
      } catch {
        if (!stopped) {
          await abort(
            "skill_test_claim_renewal_failed",
            "The Skill test runner could not renew its durable execution claim.",
            { claimLost: true },
          );
        }
      }
    };
    scheduleNext();
    return {
      get lost() { return lost; },
      setAttempt(value) { currentAttempt = value; },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  async #classifyDurableInvocation(target, attempt) {
    const identity = this.#validation.testExecutionIdentity(target.testRunId, attempt);
    const invocation = await this.#executionDispatcher.getInvocation(identity.invocationId);
    if (!invocation?.result) return null;
    if (invocation.workspaceId !== undefined && invocation.workspaceId !== target.workspaceId) {
      throw runnerError(
        "skill_test_execution_identity_conflict",
        "The Skill test execution identity is unavailable.",
      );
    }
    const executionOutcome = invocation.result.status === "completed"
      ? { result: structuredClone(invocation.result.output), startedAt: target.startedAt }
      : {
          failure: executionResultError(invocation.result),
          startedAt: target.startedAt,
        };
    return this.#validation.classifyPersistedAcceptedTestOutcome(target, executionOutcome);
  }

  #ownsClaim(target, claim) {
    return target?.runnerClaimOwner === this.#runnerId
      && target.runnerClaimOwner === claim?.runnerClaimOwner
      && target.runnerClaimFence === claim?.runnerClaimFence;
  }

  async #cancelRequested(state, claim, attempt) {
    const identity = this.#validation.testExecutionIdentity(state.target.testRunId, attempt);
    await this.#executionDispatcher.cancel(identity.invocationId, {
      reason: "skill_test_cancellation_requested",
    });
    const outcome = this.#validation.cancelledAcceptedTestOutcome({
      workspaceId: state.target.workspaceId,
      testRunId: state.target.testRunId,
      skillId: state.target.skillId,
      skillDraftId: state.target.skillDraftId,
      packageHash: state.target.packageHash,
      contentHash: state.target.contentHash,
      testCase: state.target.testCase,
      startedAt: state.target.startedAt,
    });
    return this.#settleTerminal(state.target.testRunId, outcome, { attempt, claim });
  }

  async #resolveExecutionInput(state, signal) {
    const { target, evidence, command, principal } = state;
    const context = await this.#resolveValidationContext({
      skillId: target.skillId,
      draftId: target.skillDraftId,
      workspaceId: target.workspaceId,
      requestedBy: principal.userId,
    });
    if (!sameAcceptedContext(target, evidence, context)) {
      throw runnerError(
        "skill_test_run_stale",
        "The Skill draft or promoted package changed after this test was accepted.",
      );
    }
    const suppliedConnections = target.testCase.connectionBindings ?? [];
    const requirements = context.draft.connectionRequirements ?? [];
    if ((requirements.length || suppliedConnections.length) && !this.#resolveConnectionBindings) {
      throw runnerError("skill_test_connection_binding_unavailable", "Connection binding validation is unavailable for this Skill test.");
    }
    const connectionBindings = requirements.length || suppliedConnections.length
      ? await this.#resolveConnectionBindings({
          requirements,
          connectionBindings: suppliedConnections,
          workspaceId: target.workspaceId,
        })
      : [];
    const materialBindings = target.testCase.materialBindings ?? [];
    const materials = await this.#materialResolver({
      workspaceId: target.workspaceId,
      requestedBy: principal.userId,
      bindings: materialBindings,
      signal,
    });
    return {
      inspection: structuredClone(context.inspection),
      input: {
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        draftId: target.skillDraftId,
        draftRevision: evidence.draftRevision,
        contentHash: evidence.contentHash,
        uploadId: evidence.uploadId,
        objectId: evidence.objectId,
        objectHash: evidence.objectHash,
        packageHash: evidence.packageHash,
        requestedBy: command.userId,
        permissionAcknowledged: true,
        inputSchema: structuredClone(context.draft.inputSchema),
        outputSchema: structuredClone(context.draft.outputSchema),
        testCases: [{
          ...structuredClone(target.testCase),
          ...(connectionBindings.length > 0 ? {
            connectionBindings: connectionBindings.map((binding) => ({
              requirementId: binding.requirementId,
              connectionId: binding.connectionId,
            })),
          } : {}),
        }],
        resolvedMaterialsByTestCase: [materials],
        testRunIds: [target.testRunId],
        executionAttempt: target.executionAttempt ?? 1,
      },
    };
  }

  async #loadState(testRunId, { workspaceId = null, uow = null } = {}) {
    const entry = await this.#testRuns.getTestRun({ testRunId, workspaceId, uow });
    const target = entry?.record ?? entry;
    if (!target) return null;
    const [evidence, command] = await Promise.all([
      entry?.evidence ?? null,
      this.#commandIntake.recoverByLineage({
        commandId: testRunId,
        workspaceId: target.workspaceId,
        kind: "skill_test",
        sessionId: target.skillDraftId,
        turnId: testRunId,
        session: uow,
        uow,
      }),
    ]);
    if (!evidence || !command
      || command.kind !== "skill_test"
      || command.workspaceId !== target.workspaceId
      || command.sessionId !== target.skillDraftId
      || command.turnId !== testRunId) {
      throw runnerError("skill_test_command_identity_mismatch", "The Skill test command lineage is invalid.");
    }
    return {
      target,
      evidence,
      command,
      principal: { workspaceId: command.workspaceId, userId: command.userId },
    };
  }

  async #settleTerminal(testRunId, outcome, { attempt, claim }) {
    return this.#testRuns.withTransaction(async (uow) => {
      const current = await this.#loadState(testRunId, { workspaceId: outcome.workspaceId, uow });
      if (!current) throw runnerError("skill_test_run_not_found", "The Skill test run no longer exists.");
      if ((current.target.executionAttempt ?? 1) !== attempt
        || !this.#ownsClaim(current.target, claim)
        || !claimValidAt(current.target, this.#timestamp())) {
        throw runnerError("skill_test_transition_conflict", "The Skill test result lost its execution fence.");
      }
      if (current.command.status === "cancellation_requested" && outcome.status !== "cancelled") {
        throw runnerError(
          "skill_test_cancellation_requested",
          "The Skill test result cannot settle after cancellation was requested.",
        );
      }
      if (TERMINAL_TARGET_STATUSES.has(current.target.status)) {
        if (current.target.status !== outcome.status) {
          throw runnerError("skill_test_transition_conflict", "The Skill test already has a different terminal result.");
        }
      await this.#settleCommand(current.principal, testRunId, current.target.status, uow);
        return current.target;
      }
      const target = await this.#validation.settleAcceptedTestRun({
        workspaceId: current.target.workspaceId,
        testRunId,
        expectedAttempt: attempt,
        expectedClaimOwner: claim.runnerClaimOwner,
        expectedClaimFence: claim.runnerClaimFence,
        expectedClaimValidAt: this.#timestamp(),
        expectedStatuses: [current.target.status],
        outcome: {
          ...outcome,
          runnerClaimOwner: null,
          runnerClaimExpiresAt: null,
          settlementFailureCode: null,
          settlementRetryAt: null,
        },
      }, { session: uow, uow });
      await this.#settleCommand(current.principal, testRunId, target.status, uow);
      return target;
    });
  }

  async #recordSettlementFailure(testRunId, workspaceId, { attempt, claim, error }) {
    const entry = await this.#testRuns.getTestRun({ testRunId, workspaceId });
    const current = entry?.record ?? entry;
    if (!current || TERMINAL_TARGET_STATUSES.has(current.status)
      || (current.executionAttempt ?? 1) !== attempt
      || !this.#ownsClaim(current, claim)) return null;
    const now = this.#timestamp();
    return this.#testRuns.transitionTestRun({
      workspaceId,
      testRunId,
      expectedStatuses: [current.status],
      expectedExecutionAttempt: attempt,
      expectedClaimOwner: claim.runnerClaimOwner,
      expectedClaimFence: claim.runnerClaimFence,
      expectedClaimValidAt: now,
      patch: {
        status: current.status,
        settlementFailureCode: safeFailureCode(error),
        settlementRetryAt: addMilliseconds(now, this.#retryDelayMs),
        runnerClaimOwner: null,
        runnerClaimExpiresAt: null,
      },
    });
  }

  #scheduleRetry(testRunId, { recovering = true, workspaceId = null } = {}) {
    if (this.#stopped) return;
    if (this.#retryTimers.has(testRunId)) return;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(testRunId);
      this.schedule(testRunId, { recovering, workspaceId });
    }, this.#retryDelayMs);
    timer.unref?.();
    this.#retryTimers.set(testRunId, timer);
  }

  #clearRetry(testRunId) {
    const timer = this.#retryTimers.get(testRunId);
    if (!timer) return;
    clearTimeout(timer);
    this.#retryTimers.delete(testRunId);
  }

  #blockedOutcome(target, error) {
    return this.#validation.blockedAcceptedTestOutcome({
      workspaceId: target.workspaceId,
      testRunId: target.testRunId,
      skillId: target.skillId,
      skillDraftId: target.skillDraftId,
      packageHash: target.packageHash,
      contentHash: target.contentHash,
      testCase: target.testCase,
      startedAt: target.startedAt,
      code: safeFailureCode(error),
    });
  }

  async #settleCommand(principal, testRunId, targetStatus, existingSession = null) {
    const commandStatus = COMMAND_STATUS_BY_TARGET[targetStatus];
    if (!commandStatus) return null;
    const settle = async (uow) => {
      const current = await this.#commandIntake.recover({ principal, commandId: testRunId, session: uow, uow });
      if (!current || ["completed", "failed", "blocked", "cancelled"].includes(current.status)) {
        return current;
      }
      return this.#commandIntake.settle({
        principal,
        commandId: testRunId,
        status: commandStatus,
        at: this.#timestamp(),
        session: uow,
        uow,
      });
    };
    return existingSession ? settle(existingSession) : this.#testRuns.withTransaction(settle);
  }

  async #dispatch({
    workspaceId,
    requestedBy,
    skillId,
    draftId,
    testRunId,
    testCase,
    promptTool,
    invocationId,
    attemptId,
    executionRef,
    inspection,
    input,
    resultSchema,
    signal,
  }) {
    const selection = promptTool
      ? await this.#modelService?.resolveTurnSelection?.({ workspaceId, userId: requestedBy, kind: "interactive", requiredCapabilities: ["chat", "tool_calling"] })
      : null;
    if (promptTool && !selection) {
      throw runnerError("provider_unavailable", "No governed model route is available for Prompt Skill testing.");
    }
    const actions = (inspection?.manifest?.tools ?? [])
      .map((tool) => tool?.action)
      .filter((action) => typeof action === "string");
    const existing = await this.#executionDispatcher.getInvocation(invocationId);
    if (existing?.workspaceId !== undefined && existing.workspaceId !== workspaceId) {
      throw runnerError("skill_test_execution_identity_conflict", "The Skill test execution identity is unavailable.");
    }
    const outcome = existing?.result ?? await this.#executionDispatcher.execute({
      schemaVersion: "workbench-execution-fabric-v1",
      invocationId,
      attemptId,
      workspaceId,
      actor: { userId: requestedBy },
      lineage: { productCommandId: testRunId, sessionId: draftId, turnId: testRunId },
      controller: { kind: "skill_test", controllerId: testRunId, fence: 1 },
      mode: promptTool ? "bounded_agent" : "deterministic_skill",
      isolation: promptTool ? "process" : "container",
      goal: String(testCase?.purpose || testCase?.name || "Validate the Skill.").slice(0, 8_000),
      input: structuredClone(input),
      limits: {
        timeoutMs: Math.min(Number(testCase?.timeoutSeconds ?? 30) * 1_000, 120_000),
        maxSteps: promptTool ? 16 : 1,
        maxModelRequests: promptTool ? 8 : 0,
        maxChildren: 0,
        maxInputBytes: 1_000_000,
        maxOutputBytes: 1_000_000,
        maxImageCount: 0,
        maxCostUsdMicros: 2_000_000,
      },
      capabilities: {
        toolAllowlist: promptTool ? [...new Set(actions)].sort() : [],
        connectionIds: [...new Set(
          (testCase?.connectionBindings ?? []).map((binding) => binding.connectionId),
        )].sort(),
        network: false,
        filesystem: promptTool ? "none" : "scratch_write",
        externalActions: false,
      },
      resultSchema: resultSchema ?? {
        type: "object",
        properties: { result: { type: "string", minLength: 1 } },
        required: ["result"],
        additionalProperties: false,
      },
      evidenceRequirements: [{
        requirementId: `skill-test:${testRunId}`,
        kind: "validation",
        required: true,
        description: "Return one contract-valid Skill test result.",
      }],
      metadata: {
        executionRef: structuredClone(executionRef),
        outerNodeId: `skill-test:${testRunId}`,
        skillId,
        skillDraftId: draftId,
        skillName: inspection?.manifest?.name,
        requestedBy,
        externalActionConfirmed: false,
        materialBindings: structuredClone(testCase?.materialBindings ?? []),
        ...(selection ? {
          modelProfileRevisionId: selection.modelProfileRevisionId,
          modelCapability: "tool_calling",
        } : {}),
        fallbackModelProfileRevisionIds: [],
      },
    }, { signal });
    if (outcome.status !== "completed") {
      const code = outcome.status === "cancelled"
        ? "skill_execution_cancelled"
        : outcome.status === "timeout"
          ? "skill_execution_timed_out"
          : outcome.failureCode ?? `skill_test_${outcome.status}`;
      throw runnerError(code, "The Skill test did not complete.", outcome.status);
    }
    return structuredClone(outcome.output);
  }

  #timestamp() {
    const value = this.#clock();
    return value instanceof Date ? value.toISOString() : String(value);
  }
}

function sameAcceptedContext(target, evidence, context) {
  return Boolean(context?.draft)
    && context.draft.skillDraftId === target.skillDraftId
    && context.draft.skillId === target.skillId
    && context.draft.revision === evidence.draftRevision
    && context.contentHash === evidence.contentHash
    && context.uploadId === evidence.uploadId
    && context.objectId === evidence.objectId
    && context.objectHash === evidence.objectHash
    && context.packageHash === evidence.packageHash
    && target.contentHash === evidence.contentHash
    && target.packageHash === evidence.packageHash;
}

function legacySkillTestPersistence(store) {
  if (!store?.connect || !store?.withTransaction || !store?.repositories?.skillTestRuns
    || !store?.repositories?.skillTestEvidence) return null;
  return {
    async getTestRun({ testRunId, workspaceId = null, uow = null }) {
      await store.connect();
      const options = { ...(workspaceId ? { workspaceId } : {}), ...(uow ? { session: uow } : {}) };
      const record = await store.repositories.skillTestRuns.get(testRunId, options);
      const evidence = record
        ? await store.repositories.skillTestEvidence.getInternal(testRunId, {
            ...options,
            workspaceId: record.workspaceId,
          })
        : null;
      return record && evidence ? { record, evidence } : null;
    },
    async listRecoverable() {
      await store.connect();
      return store.repositories.skillTestRuns.listRecoverable();
    },
    claim({ testRunId, ...request }) {
      return store.repositories.skillTestRuns.claim(testRunId, request);
    },
    renewClaim({ testRunId, ...request }) {
      return store.repositories.skillTestRuns.renewClaim(testRunId, request);
    },
    transitionTestRun({ testRunId, ...request }) {
      return store.repositories.skillTestRuns.transition(testRunId, request);
    },
    withTransaction(work) {
      return store.withTransaction((session) => work(session));
    },
  };
}

function safeFailureCode(error) {
  return typeof error?.code === "string" && error.code.length <= 128
    ? error.code
    : "skill_test_execution_blocked";
}

function addMilliseconds(timestamp, milliseconds) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw runnerError("skill_test_runner_clock_invalid", "The Skill test runner clock is invalid.");
  }
  return new Date(value + milliseconds).toISOString();
}

function claimValidAt(target, timestamp) {
  const expiresAt = Date.parse(target?.runnerClaimExpiresAt ?? "");
  const now = Date.parse(timestamp);
  return Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt > now;
}

function executionResultError(result) {
  const code = result?.status === "cancelled"
    ? "skill_execution_cancelled"
    : result?.status === "timeout"
      ? "skill_execution_timed_out"
      : result?.failureCode ?? `skill_test_${result?.status ?? "failed"}`;
  return runnerError(code, "The Skill test did not complete.", result?.status ?? "blocked");
}

function throwIfControlAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? runnerError(
    "skill_test_execution_aborted",
    "The Skill test execution was aborted by its Product controller.",
    "cancelled",
  );
}

function isFenceConflict(error) {
  return error?.code === "skill_test_transition_conflict";
}

function runnerError(code, message, status = "blocked") {
  const error = new ProductStoreError(code, message);
  error.status = status;
  return error;
}
