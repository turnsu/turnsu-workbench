import { assertWorkflowRunPersistence } from "../../../src/runner/workflow-run-persistence.mjs";
import { RUN_STATE_MODEL_VERSION, createRunStateTransitionEvent, foldRunStateEvents } from "../../../src/runner/run-state-events.mjs";

/** Test-only repository fixture for fast WorkflowRunner unit tests. */
export function createRepositoryWorkflowRunPersistence({ store } = {}) {
  // Production always injects the PostgreSQL aggregate owner. Resolve this
  // fixture's in-memory repositories only at a test operation boundary.
  if (typeof store?.withTransaction !== "function" || typeof store.appendRunEvent !== "function") {
    throw new TypeError("repository_workflow_run_persistence_store_required");
  }
  const repositories = () => {
    const value = store.repositories;
    for (const name of [
      "runs", "runJobs", "runLeases", "runStateEvents", "runReadModels",
      "runEvents", "runCheckpoints", "runTerminalTransitions", "reviewDecisions", "externalEffectReceipts",
    ]) {
      if (!value?.[name]) throw new TypeError(`repository_workflow_run_persistence_repository_missing:${name}`);
    }
    return value;
  };
  return assertWorkflowRunPersistence(Object.freeze({
    async createAcceptedAggregate({ run, runJobId, initialStateEvent, executionPlan, executionSnapshot, eventTemplate, uow }) {
      const value = repositories();
      await value.runs.insert(run, { session: uow });
      await value.runStateEvents.append(initialStateEvent, { session: uow });
      await value.runJobs.insert({
        schemaVersion: "workbench-run-job-v1",
        runJobId,
        runId: run.runId,
        workspaceId: run.workspaceId,
        status: "queued",
        fence: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        checkpointSequence: 0,
        queuedAt: run.queuedAt,
        updatedAt: run.queuedAt,
      }, { session: uow });
      await this.saveExecutionSnapshot({ runId: run.runId, executionPlan, executionSnapshot, uow });
      await value.runReadModels.put(initialReadModel(run), { session: uow });
      const event = await store.appendRunEvent({
        ...eventTemplate,
        runId: run.runId,
        workflowId: run.workflowId,
        workflowRevisionId: run.workflowRevisionId,
        sourceStateEventId: initialStateEvent.eventId,
      }, { session: uow });
      return { run: await value.runs.get(run.runId, { session: uow }), event };
    },

    async loadRecoverableAggregates({ now }) {
      const value = repositories();
      const jobs = await value.runJobs.listRecoverable(now);
      const result = [];
      for (const job of jobs) {
        const run = await value.runs.getInternal(job.runId);
        if (!run) continue;
        const decisions = run.status === "paused"
          ? await value.reviewDecisions.listInternalByRun(run.runId)
          : [];
        result.push({ job, run, latestDecision: decisions.at(-1) ?? null });
      }
      return result;
    },

    readInternalRun(runId, options = {}) { return repositories().runs.getInternal(runId, options); },
    readPublicRun(runId, options = {}) { return repositories().runs.get(runId, options); },
    transact(work, { uow } = {}) { return store.withTransaction(work, uow ? { session: uow } : {}); },

    async appendRunEvent({ run, eventTemplate, uow }) {
      const sourceStateEvent = run.stateModelVersion === 2
        ? await repositories().runStateEvents.getLatest(run.runId, { session: uow })
        : null;
      return store.appendRunEvent({
        ...eventTemplate,
        runId: run.runId,
        workflowId: run.workflowId,
        workflowRevisionId: run.workflowRevisionId,
        ...(sourceStateEvent?.eventId ? { sourceStateEventId: sourceStateEvent.eventId } : {}),
      }, { session: uow });
    },

    async projectReadModel({ run, overrides = {}, now, uow }) {
      const value = repositories();
      const [nodeTimeline, decisions, existing] = await Promise.all([
        value.runNodeAttempts.listByRun(run.runId, { session: uow }),
        value.reviewDecisions.listByRun(run.runId, { session: uow }),
        value.runReadModels.get(run.runId, { session: uow }),
      ]);
      return value.runReadModels.put({
        ...existing,
        schemaVersion: "workbench-v1", runId: run.runId, workflowId: run.workflowId,
        workflowRevisionId: run.workflowRevisionId, status: run.status, currentNodeId: run.currentNodeId,
        nodeTimeline, finalAnswer: existing?.finalAnswer ?? null, evidenceGaps: existing?.evidenceGaps ?? [],
        reviewPacket: existing?.reviewPacket ?? null, reviewDecisions: decisions,
        failure: existing?.failure ?? null, recoveryActions: existing?.recoveryActions ?? [],
        followUpPrompts: existing?.followUpPrompts ?? [], resourceRefs: run.resourceRefs,
        evidenceRefs: existing?.evidenceRefs ?? [], createdAt: existing?.createdAt ?? run.createdAt ?? now,
        updatedAt: now, ...overrides,
      }, { session: uow });
    },

    async transitionRunState({ runId, patch, metadata = {}, idFactory, now, uow }) {
      const value = repositories();
      const current = await value.runs.getInternal(runId, { session: uow });
      if (!current) return null;
      if (current.stateModelVersion !== RUN_STATE_MODEL_VERSION) return value.runs.patch(runId, patch, { session: uow });
      const event = createRunStateTransitionEvent({
        run: current, patch, eventId: idFactory("run-state-event"),
        commandId: metadata.commandId ?? idFactory("run-state-command"),
        occurredAt: patch.updatedAt ?? now, transitionType: metadata.transitionType,
        attemptId: metadata.attemptId, effectReceiptId: metadata.effectReceiptId,
      });
      if (!event) return value.runs.patch(runId, patch, { session: uow });
      const latest = await value.runStateEvents.getLatest(runId, { session: uow });
      if (!latest || latest.sequence !== current.stateEventSequence || latest.stateHash !== current.stateHash) {
        const error = new Error("run_state_prior_hash_invalid"); error.code = "run_state_prior_hash_invalid"; throw error;
      }
      await value.runStateEvents.append(event, { session: uow });
      return value.runs.patchStateProjection(runId, {
        expectedSequence: current.stateEventSequence, expectedStateHash: current.stateHash,
        nextSequence: event.sequence, nextStateHash: event.stateHash, patch,
      }, { session: uow });
    },

    async saveExecutionSnapshot({ runId, executionPlan, executionSnapshot, uow }) {
      const collection = repositories().runs.collection;
      if (typeof collection?.updateOne !== "function") {
        throw new TypeError("repository_workflow_run_snapshot_unavailable");
      }
      await collection.updateOne(
        { runId },
        { $set: { executionPlanSnapshot: structuredClone(executionPlan), executionSnapshot: structuredClone(executionSnapshot) } },
        uow ? { session: uow } : {},
      );
    },

    readReadModel(runId, { uow } = {}) {
      return repositories().runReadModels.get(runId, { session: uow });
    },

    listRunStateEvents(runId, { uow } = {}) {
      return repositories().runStateEvents.listByRun(runId, { session: uow });
    },

    listRunsByWorkflow(workflowId, query = {}) {
      return repositories().runs.listByWorkflow(workflowId, query);
    },

    listRecentRuns(workspaceId, query = {}) {
      return repositories().runs.listByWorkspace(workspaceId, query);
    },

    listRunEvents(runId, after = 0, { uow } = {}) {
      return repositories().runEvents.listAfter(runId, after, { session: uow });
    },

    listNodeAttempts(runId, { internal = false, uow } = {}) {
      const attempts = repositories().runNodeAttempts;
      return internal
        ? attempts.listInternalByRun(runId, { session: uow })
        : attempts.listByRun(runId, { session: uow });
    },

    createNodeAttempt(attempt, { uow } = {}) {
      return repositories().runNodeAttempts.insert(attempt, { session: uow });
    },

    async patchNodeAttempt({ runId, nodeId, attempt, patch, uow }) {
      return repositories().runNodeAttempts.patchInternal(
        runId,
        nodeId,
        attempt,
        patch,
        { session: uow },
      );
    },

    async syncNodeRuns({ runId, now, idFactory, uow }) {
      const nodeRuns = await this.listNodeAttempts(runId, { uow });
      return this.transitionRunState({
        runId,
        patch: { nodeRuns, updatedAt: now },
        idFactory,
        now,
        uow,
      });
    },

    async createCheckpoint({ runId, checkpointId, attempt, status, workerId, fence, now, runState, uow }) {
      const sequence = await repositories().runJobs.nextCheckpointSequence(runId, {
        workerId,
        fence,
        now,
        session: uow,
      });
      if (!sequence) return null;
      return repositories().runCheckpoints.insert({
        schemaVersion: "workbench-v1",
        checkpointId,
        runId,
        attemptId: attempt.nodeRunId,
        sequence,
        workerId,
        fence,
        state: {
          nodeId: attempt.nodeId,
          attempt: attempt.attempt,
          status,
          runState,
        },
        createdAt: now,
      }, { session: uow });
    },

    async readRunState(runId, { uow } = {}) {
      const value = repositories();
      const checkpoints = await value.runCheckpoints.listWhere(
        { runId },
        { session: uow, sort: { sequence: -1 }, limit: 1 },
      );
      const snapshot = checkpoints[0]?.state?.runState?.schemaVersion === "workbench-run-state-snapshot-v2"
        ? checkpoints[0].state.runState
        : null;
      const events = snapshot
        ? await value.runStateEvents.listByRunAfter(runId, snapshot.sequence, { session: uow })
        : await value.runStateEvents.listByRun(runId, { session: uow });
      return foldRunStateEvents(events, { expectedRunId: runId, snapshot });
    },

    async withFencedTransaction({ runId, workerId, fence, now, uow, assertActiveFence, mutation }) {
      if (typeof assertActiveFence !== "function" || typeof mutation !== "function") {
        throw new TypeError("repository_workflow_run_fenced_mutation_required");
      }
      return this.transact(async (transaction) => {
        const active = await assertActiveFence(runId, {
          workerId,
          fence,
          now,
          session: transaction,
        });
        if (!active) return null;
        return mutation({ uow: transaction });
      }, { uow });
    },

    async settleTerminalAggregate({
      runId,
      status,
      now,
      patch = {},
      lease = null,
      workerId,
      commandId = null,
      decisionId = null,
      idFactory,
      syncCommandLifecycle,
      readModelFactory,
      eventTemplate,
      uow,
    }) {
      if (typeof syncCommandLifecycle !== "function" || typeof readModelFactory !== "function") {
        throw new TypeError("repository_workflow_run_terminal_callbacks_required");
      }
      const value = repositories();
      let current = await value.runs.getInternal(runId, { session: uow });
      if (!current) return { kind: "not_found", event: null, run: null };
      const terminal = new Set(["completed", "failed", "cancelled", "partial", "effect_outcome_unknown"]);
      if (terminal.has(current.status) && current.status !== status) {
        const error = new Error("run_terminal_status_conflict");
        error.code = "run_terminal_status_conflict";
        throw error;
      }
      if (!terminal.has(current.status)) {
        current = await this.transitionRunState({
          runId,
          patch: { ...patch, status, currentNodeId: null, finishedAt: now, updatedAt: now },
          metadata: { commandId },
          idFactory,
          now,
          uow,
        });
      }
      await syncCommandLifecycle(current, status, { at: current.finishedAt ?? now, uow });
      if (decisionId) {
        await value.reviewDecisions.patch(decisionId, {
          applicationStatus: "applied",
          appliedAt: now,
          updatedAt: now,
        }, { session: uow });
      }
      const existingReadModel = await value.runReadModels.get(runId, { session: uow });
      await this.projectReadModel({
        run: current,
        overrides: readModelFactory({ run: current, readModel: existingReadModel }),
        now,
        uow,
      });
      const terminalType = `run.${status}`;
      const events = await value.runEvents.listAfter(runId, 0, { session: uow });
      const retainedEvent = events.find((event) => event.type === terminalType) ?? null;
      const logicalEventId = `terminal:${runId}:${status}`;
      const existingMarker = await value.runTerminalTransitions.collection.findOne(
        { runId },
        uow ? { session: uow } : {},
      );
      let checkpointId = existingMarker?.checkpointId ?? null;
      if (!existingMarker) {
        const sequence = lease
          ? await value.runJobs.nextCheckpointSequence(runId, {
            workerId,
            fence: lease.fence,
            now,
            session: uow,
          })
          : await value.runJobs.nextTerminalCheckpointSequence(runId, { now, session: uow });
        if (!sequence) {
          const error = new Error(lease ? "run_lease_lost" : "run_job_missing");
          error.code = error.message;
          throw error;
        }
        checkpointId = `checkpoint-${logicalEventId}`;
        const folded = await this.readRunState(runId, { uow });
        await value.runCheckpoints.insert({
          schemaVersion: "workbench-v1",
          checkpointId,
          runId,
          attemptId: "terminal",
          sequence,
          workerId: lease?.leaseOwner ?? workerId,
          fence: lease?.fence ?? null,
          state: {
            status,
            terminal: true,
            runState: {
              schemaVersion: "workbench-run-state-snapshot-v2",
              runId,
              sequence: folded.sequence,
              stateHash: folded.stateHash,
              state: folded.state,
              base: folded.base,
            },
          },
          createdAt: now,
        }, { session: uow });
      }
      const event = retainedEvent ?? await this.appendRunEvent({
        run: current,
        eventTemplate: {
          ...eventTemplate,
          eventId: logicalEventId,
          occurredAt: current.finishedAt ?? now,
        },
        uow,
      });
      if (!existingMarker) {
        await value.runTerminalTransitions.insert({
          schemaVersion: "workbench-v1",
          terminalTransitionId: logicalEventId,
          logicalEventId,
          runId,
          status,
          eventId: event.eventId,
          checkpointId,
          workerId: lease?.leaseOwner ?? null,
          fence: lease?.fence ?? null,
          committedAt: current.finishedAt ?? now,
        }, { session: uow });
      }
      if (lease) {
        const finished = await value.runJobs.finishByRun(runId, {
          workerId,
          fence: lease.fence,
          status: terminalJobStatus(status),
          now,
          session: uow,
        });
        if (!finished) {
          const error = new Error("run_lease_lost");
          error.code = error.message;
          throw error;
        }
        await value.runLeases.release(runId, {
          workerId,
          fence: lease.fence,
          releasedAt: now,
          session: uow,
        });
      } else if (["cancelled", "partial", "effect_outcome_unknown"].includes(status)) {
        const settled = await value.runJobs.settleCancellationByRun(runId, { status, now, session: uow });
        if (!settled && status === "cancelled") {
          await value.runJobs.cancelByRun(runId, { now, session: uow });
        } else if (!settled) {
          const error = new Error("run_cancellation_job_settlement_failed");
          error.code = error.message;
          throw error;
        }
        await value.runLeases.cancelByRun(runId, { cancelledAt: now, session: uow });
      }
      return { kind: "settled", event: retainedEvent ? null : event, run: current };
    },

    async recordReviewDecisionAndRequeue({
      record,
      now,
      idFactory,
      syncCommandLifecycle,
      eventTemplate,
      uow,
    }) {
      if (typeof syncCommandLifecycle !== "function") {
        throw new TypeError("repository_workflow_run_review_lifecycle_required");
      }
      const value = repositories();
      const storedDecision = await value.reviewDecisions.insert(record, { session: uow });
      const decisions = await value.reviewDecisions.listByRun(record.runId, { session: uow });
      const paused = await this.transitionRunState({
        runId: record.runId,
        patch: { reviewDecisions: decisions, status: "paused", updatedAt: now },
        idFactory,
        now,
        uow,
      });
      if (!paused) return null;
      await syncCommandLifecycle(paused, "paused", { at: now, uow });
      await this.projectReadModel({ run: paused, now, uow });
      const requeued = await value.runJobs.requeueByRun(record.runId, { now, session: uow });
      if (!requeued) return null;
      const event = await this.appendRunEvent({
        run: paused,
        eventTemplate,
        uow,
      });
      return {
        decision: storedDecision,
        run: await value.runs.get(record.runId, { session: uow }),
        event,
      };
    },

    async pauseForReview({
      runId,
      nodeId,
      lease,
      workerId,
      now,
      reviewPacket,
      idFactory,
      syncCommandLifecycle,
      eventTemplate,
      uow,
    }) {
      if (typeof syncCommandLifecycle !== "function") {
        throw new TypeError("repository_workflow_run_review_lifecycle_required");
      }
      const value = repositories();
      const waiting = await this.transitionRunState({
        runId,
        patch: { status: "waiting_review", currentNodeId: nodeId, updatedAt: now },
        idFactory,
        now,
        uow,
      });
      if (!waiting) return null;
      await syncCommandLifecycle(waiting, "waiting_review", { at: now, uow });
      const decisions = await value.reviewDecisions.listInternalByRun(runId, { session: uow });
      const applying = decisions.findLast?.((entry) => entry.applicationStatus === "applying")
        ?? [...decisions].reverse().find((entry) => entry.applicationStatus === "applying");
      if (applying) {
        await value.reviewDecisions.patch(applying.decisionId, {
          applicationStatus: "applied",
          appliedAt: now,
          updatedAt: now,
        }, { session: uow });
      }
      await this.projectReadModel({ run: waiting, overrides: { reviewPacket }, now, uow });
      const event = await this.appendRunEvent({ run: waiting, eventTemplate, uow });
      const pausedJob = await value.runJobs.pauseByRun(runId, {
        workerId,
        fence: lease.fence,
        now,
        session: uow,
      });
      if (!pausedJob) return null;
      await value.runLeases.release(runId, {
        workerId,
        fence: lease.fence,
        releasedAt: now,
        session: uow,
      });
      return { event, run: waiting };
    },

    markReviewDecision(decisionId, patch, { uow } = {}) {
      return repositories().reviewDecisions.patch(decisionId, patch, { session: uow });
    },

    requeueReview(runId, { now, uow } = {}) {
      return repositories().runJobs.requeueByRun(runId, { now, session: uow });
    },

    async heartbeatLeaseProjection({ runId, workerId, fence, now, leaseExpiresAt }) {
      return this.transact(async (uow) => {
        const value = repositories();
        const job = await value.runJobs.heartbeatByRun(runId, {
          workerId,
          fence,
          now,
          leaseExpiresAt,
          session: uow,
        });
        if (!job) return null;
        const lease = await value.runLeases.heartbeat(runId, {
          workerId,
          fence,
          heartbeatAt: now,
          expiresAt: leaseExpiresAt,
          session: uow,
        });
        return lease ? { job, lease } : null;
      });
    },

    async releaseLeaseProjection({ runId, workerId, fence, status, now, uow }) {
      return this.transact(async (transaction) => {
        const value = repositories();
        const job = await value.runJobs.finishByRun(runId, {
          workerId,
          fence,
          status,
          now,
          session: transaction,
        });
        if (!job) return null;
        const lease = await value.runLeases.release(runId, {
          workerId,
          fence,
          releasedAt: now,
          session: transaction,
        });
        return lease ? { job, lease } : null;
      }, { uow });
    },

    listEffectReceipts(query, { uow } = {}) {
      return repositories().externalEffectReceipts.listWhere(query, {
        limit: 2,
        sort: { createdAt: 1, effectId: 1 },
        session: uow,
      });
    },

    runIdempotently(operation, mutation) {
      if (typeof mutation !== "function") throw new TypeError("repository_workflow_run_idempotent_mutation_required");
      return store.runIdempotentMutation(operation, mutation);
    },

    async requestCancellation({
      runId,
      now,
      commandId,
      idFactory,
      syncCommandLifecycle,
      eventTemplate,
      uow,
    }) {
      if (typeof syncCommandLifecycle !== "function") {
        throw new TypeError("repository_workflow_run_cancellation_lifecycle_required");
      }
      const value = repositories();
      const current = await this.transitionRunState({
        runId,
        patch: { status: "cancellation_requested", updatedAt: now },
        metadata: { commandId, transitionType: "run_cancellation_requested" },
        idFactory,
        now,
        uow,
      });
      if (!current) return null;
      await syncCommandLifecycle(current, "cancellation_requested", { at: now, uow });
      const job = await value.runJobs.requestCancellationByRun(runId, { now, session: uow });
      if (!job) return null;
      await value.runLeases.cancelByRun(runId, { cancelledAt: now, session: uow });
      await this.projectReadModel({
        run: current,
        overrides: { status: "cancellation_requested", failure: null, recoveryActions: [] },
        now,
        uow,
      });
      const event = await this.appendRunEvent({ run: current, eventTemplate, uow });
      return { run: current, event };
    },
  }));
}

function terminalJobStatus(status) {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function initialReadModel(run) {
  return {
    schemaVersion: "workbench-v1", runId: run.runId, workflowId: run.workflowId,
    workflowRevisionId: run.workflowRevisionId, status: run.status, currentNodeId: run.currentNodeId,
    nodeTimeline: [], finalAnswer: null, evidenceGaps: [], reviewPacket: null,
    reviewDecisions: [], failure: null, recoveryActions: [], followUpPrompts: [],
    resourceRefs: run.resourceRefs, evidenceRefs: [], createdAt: run.createdAt, updatedAt: run.createdAt,
  };
}
