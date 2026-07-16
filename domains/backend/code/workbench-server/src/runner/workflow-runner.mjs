import { Check } from "@looloomi/workbench-contracts";

import { RunEventHub } from "./run-event-hub.mjs";
import { projectPublishedSkillVersion } from "../skills/published-skill-definition.mjs";

const WORKBENCH_SCHEMA_VERSION = "workbench-v1";
const RUN_EVENT_SCHEMA_VERSION = "workbench-run-event-v1";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function hasDurableRunnerRepositories(repositories) {
  const runJobs = repositories?.runJobs;
  const runLeases = repositories?.runLeases;
  return [
    runJobs?.insert,
    runJobs?.list,
    runJobs?.listRecoverable,
    runJobs?.claimByRun,
    runJobs?.finishByRun,
    runJobs?.requeueByRun,
    runJobs?.abandonClaimByRun,
    runJobs?.cancelByRun,
    runJobs?.heartbeatByRun,
    runJobs?.assertActiveFence,
    runJobs?.pauseByRun,
    runJobs?.nextCheckpointSequence,
    runJobs?.nextTerminalCheckpointSequence,
    runLeases?.acquire,
    runLeases?.heartbeat,
    runLeases?.release,
    runLeases?.cancelByRun,
    repositories?.runCheckpoints?.insert,
    repositories?.runTerminalTransitions?.insert,
    repositories?.runNodeAttempts?.patchInternal,
    repositories?.reviewDecisions?.patch,
  ].every((method) => typeof method === "function");
}

export class WorkflowRunnerError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "WorkflowRunnerError";
    this.code = code;
    this.details = details;
  }
}

export function createWorkflowRunner(options) {
  return new WorkflowRunner(options);
}

export class WorkflowRunner {
  #store;
  #resolveExecution;
  #resolveResourceText;
  #agentRuntime;
  #clock;
  #idFactory;
  #hub = new RunEventHub();
  #jobs = new Map();
  #abortControllers = new Map();
  #scheduleOnStart;
  #workerId;
  #leaseDurationMs;
  #leaseTimers = new Map();
  #activeLeases = new Map();
  #faultInjector;

  constructor({
    store,
    resolveExecution,
    resolveResourceText = null,
    agentRuntime,
    clock = () => new Date().toISOString(),
    idFactory,
    scheduleOnStart = true,
    workerId = `worker-${process.pid}`,
    leaseDurationMs = 30000,
    faultInjector = async () => {},
  } = {}) {
    if (
      !store
      || typeof store.runIdempotentMutation !== "function"
      || typeof store.appendRunEvent !== "function"
    ) {
      throw new TypeError("workflow_runner_store_invalid");
    }
    if (!hasDurableRunnerRepositories(store.repositories) && typeof store.connect !== "function") {
      throw new TypeError("workflow_runner_run_job_store_invalid");
    }
    if (typeof resolveExecution !== "function") throw new TypeError("workflow_runner_resolve_execution_required");
    if (resolveResourceText !== null && typeof resolveResourceText !== "function") {
      throw new TypeError("workflow_runner_resource_resolver_invalid");
    }
    for (const method of ["invokeSkillNode", "buildAuthoritativeFinal"]) {
      if (typeof agentRuntime?.[method] !== "function") throw new TypeError("workflow_runner_agent_runtime_invalid");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("workflow_runner_clock_and_id_factory_required");
    }
    if (typeof scheduleOnStart !== "boolean") throw new TypeError("workflow_runner_schedule_option_invalid");
    requiredId(workerId, "workflow_runner_worker_id_invalid");
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1000) {
      throw new TypeError("workflow_runner_lease_duration_invalid");
    }
    if (typeof faultInjector !== "function") throw new TypeError("workflow_runner_fault_injector_invalid");
    this.#store = store;
    this.#resolveExecution = resolveExecution;
    this.#resolveResourceText = resolveResourceText;
    this.#agentRuntime = agentRuntime;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#scheduleOnStart = scheduleOnStart;
    this.#workerId = workerId;
    this.#leaseDurationMs = leaseDurationMs;
    this.#faultInjector = faultInjector;
  }

  async startRun({ workflowId, workflowRevisionId, inputs, resourceRefs, idempotencyKey, requestId }) {
    requiredId(workflowId, "workflow_id_required");
    requiredId(workflowRevisionId, "workflow_revision_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    const execution = await this.#execution(workflowId, workflowRevisionId);
    return this.#createRun({
      workflowId,
      workflowRevisionId,
      inputs,
      resourceRefs,
      idempotencyKey,
      requestId,
      execution,
    });
  }

  async #createRun({ workflowId, workflowRevisionId, inputs, resourceRefs, idempotencyKey, requestId, execution, retryOf = null }) {
    const request = { workflowId, workflowRevisionId, inputs, resourceRefs, requestId, retryOf };
    const result = await this.#store.runIdempotentMutation(
      { scope: `start-run:${workflowId}`, key: idempotencyKey, request },
      async (session) => {
        const now = this.#now();
        const runId = this.#idFactory("run");
        const executionSnapshot = this.#executionSnapshot({ runId, execution, plan: execution.plan, now });
        const run = {
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          runId,
          workflowId,
          workflowRevisionId,
          inputs: cloneObject(inputs, "run_inputs_invalid"),
          resourceRefs: cloneArray(resourceRefs, "run_resource_refs_invalid"),
          executionPlanVersion: execution.plan.schemaVersion,
          executionPlanContentHash: execution.plan.contentHash,
          status: "queued",
          currentNodeId: null,
          idempotencyKey,
          nodeRuns: [],
          reviewDecisions: [],
          authoritativeReadModel: { available: false, version: 0 },
          queuedAt: now,
          startedAt: null,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
          executionPlanSnapshot: structuredClone(execution.plan),
          executionSnapshot,
          ...(retryOf ? { retryOf } : {}),
        };
        await this.#store.repositories.runs.insert(run, { session });
        if (!executionSnapshot.workspaceId) {
          throw new WorkflowRunnerError("run_workspace_missing", "Run workspace is unavailable.", { runId });
        }
        await this.#store.repositories.runJobs.insert({
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          runJobId: this.#idFactory("run-job"),
          runId,
          workspaceId: executionSnapshot.workspaceId,
          status: "queued",
          fence: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          checkpointSequence: 0,
          queuedAt: now,
          updatedAt: now,
        }, { session });
        await this.#putRunSnapshot(run.runId, execution.plan, executionSnapshot, { session });
        await this.#putReadModel(run, {}, { session });
        const event = await this.#appendEvent(run, "run.queued", "queued", "Run queued.", undefined, { session });
        return { run: await this.#publicRun(run.runId, { session }), event };
      },
    );
    this.#hub.publish(result.event);
    if (this.#scheduleOnStart) this.#schedule(result.run.runId, execution);
    return result.run;
  }

  async recover() {
    const jobs = await this.#store.repositories.runJobs.listRecoverable(this.#now());
    const candidates = [];
    for (const job of jobs) {
      const run = await this.#internalRun(job.runId);
      if (!run) continue;
      if (["queued", "running"].includes(run.status)) {
        const execution = await this.#executionForRun(run);
        candidates.push({ kind: "run", runId: run.runId, execution });
      } else if (run.status === "paused") {
        const decisions = await this.#store.repositories.reviewDecisions.listInternalByRun(run.runId);
        const decision = decisions.at(-1);
        if (decision) candidates.push({ kind: "review", runId: run.runId, decision });
      } else if (TERMINAL.has(run.status)) {
        candidates.push({ kind: "terminal", runId: run.runId });
      }
    }
    const recoveredRunIds = (await Promise.all(candidates.map(async (candidate) => (
      await (candidate.kind === "review"
        ? this.#scheduleReview(candidate.decision, { requeue: false })
        : candidate.kind === "terminal"
          ? this.#scheduleTerminal(candidate.runId)
          : this.#schedule(candidate.runId, candidate.execution)) ? candidate.runId : null
    )))).filter(Boolean);
    return { recoveredRunIds };
  }

  async getRun(runId) {
    const run = await this.#publicRun(runId);
    if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
    const readModel = await this.#store.repositories.runReadModels.get(runId);
    return { run, readModel };
  }

  async listRuns(workflowId, query = {}) {
    requiredId(workflowId, "workflow_id_required");
    return this.#store.repositories.runs.listByWorkflow(workflowId, query);
  }

  async cancelRun({ runId, idempotencyKey, requestedBy, reason } = {}) {
    requiredId(runId, "run_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(requestedBy, "run_command_requested_by_required");
    const result = await this.#store.runIdempotentMutation(
      {
        scope: `cancel-run:${runId}`,
        key: idempotencyKey,
        request: { runId, requestedBy, reason: reason ?? null },
      },
      async (session) => {
        const run = await this.#internalRun(runId, { session });
        if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
        const command = await this.#recordCommand({ runId, workspaceId: run.executionSnapshot?.workspaceId, command: "cancel", requestedBy, session });
        const cancelled = await this.#cancelStoredRun(run, { session, reason, abortInvocation: false });
        return { command, run: await this.#publicRun(runId, { session }), event: cancelled.event };
      },
    );
    this.#abortControllers.get(runId)?.abort(new WorkflowRunnerError("run_cancelled"));
    if (result.event) this.#hub.publish(result.event);
    return result.run;
  }

  async retryRun({ runId, idempotencyKey, requestedBy, reason } = {}) {
    requiredId(runId, "run_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(requestedBy, "run_command_requested_by_required");
    const original = await this.#internalRun(runId);
    if (!original) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
    if (!new Set(["failed", "cancelled"]).has(original.status)) {
      throw new WorkflowRunnerError("run_retry_not_allowed", "Only failed or cancelled Runs can be retried.", { runId });
    }
    await this.#store.runIdempotentMutation(
      {
        scope: `retry-run-command:${runId}`,
        key: idempotencyKey,
        request: { runId, requestedBy, reason: reason ?? null },
      },
      async (session) => {
        const current = await this.#internalRun(runId, { session });
        if (!current) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
        return this.#recordCommand({ runId, workspaceId: current.executionSnapshot?.workspaceId, command: "retry", requestedBy, session });
      },
    );
    const execution = await this.#executionForRun(original);
    return this.#createRun({
      workflowId: original.workflowId,
      workflowRevisionId: original.workflowRevisionId,
      inputs: original.inputs,
      resourceRefs: original.resourceRefs,
      idempotencyKey,
      requestId: `retry:${runId}`,
      execution,
      retryOf: runId,
    });
  }

  async submitReviewDecision({ runId, nodeId, decision, comment, requestedChanges = [], idempotencyKey, decidedBy }) {
    requiredId(runId, "run_id_required");
    requiredId(nodeId, "node_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(decidedBy, "review_decided_by_required");
    if (!new Set(["approve", "revise", "reject"]).has(decision)) {
      throw new WorkflowRunnerError("review_decision_invalid");
    }
    if (!Array.isArray(requestedChanges) || requestedChanges.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new WorkflowRunnerError("review_requested_changes_invalid");
    }
    const request = { runId, nodeId, decision, comment, requestedChanges, decidedBy };
    const result = await this.#store.runIdempotentMutation(
      { scope: `review-decision:${runId}`, key: idempotencyKey, request },
      async (session) => {
        const run = await this.#internalRun(runId, { session });
        if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
        if (run.status !== "waiting_review" || run.currentNodeId !== nodeId) {
          throw new WorkflowRunnerError("review_not_waiting", "The Run is not waiting at this Review Gate.", { runId, nodeId });
        }
        const now = this.#now();
        const record = {
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          decisionId: this.#idFactory("review"),
          runId,
          nodeId,
          decision,
          ...(comment === undefined ? {} : { comment }),
          requestedChanges: structuredClone(requestedChanges),
          decidedBy,
          decidedAt: now,
          idempotencyKey,
          applicationStatus: "pending",
          appliedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const storedDecision = await this.#store.repositories.reviewDecisions.insert(record, { session });
        const decisions = await this.#store.repositories.reviewDecisions.listByRun(runId, { session });
        await this.#patchRun(runId, {
          reviewDecisions: decisions,
          status: "paused",
          updatedAt: now,
        }, { session });
        const paused = await this.#internalRun(runId, { session });
        await this.#putReadModel(paused, {}, { session });
        const requeued = await this.#store.repositories.runJobs.requeueByRun(runId, {
          now,
          session,
        });
        if (!requeued) {
          throw new WorkflowRunnerError("review_requeue_conflict", "The review continuation could not be queued.", { runId, nodeId });
        }
        const event = await this.#appendEvent(
          paused,
          "run.paused",
          "paused",
          "Review decision received.",
          nodeId,
          { session },
        );
        return { decision: storedDecision, run: await this.#publicRun(runId, { session }), event };
      },
    );
    this.#hub.publish(result.event);
    this.#scheduleReview(result.decision, { requeue: false });
    return { decision: result.decision, run: result.run };
  }

  listEvents(runId, after = 0) {
    requiredId(runId, "run_id_required");
    if (!Number.isInteger(after) || after < 0) throw new WorkflowRunnerError("event_cursor_invalid");
    return this.#store.repositories.runEvents.listAfter(runId, after);
  }

  subscribe(runId, listener) {
    requiredId(runId, "run_id_required");
    return this.#hub.subscribe(runId, listener);
  }

  #schedule(runId, execution) {
    if (this.#jobs.has(runId)) return this.#jobs.get(runId);
    let job;
    job = Promise.resolve()
      .then(() => this.#executeLeased(runId, (lease) => this.#execute(runId, execution, lease)))
      .finally(() => {
        if (this.#jobs.get(runId) === job) this.#jobs.delete(runId);
      });
    this.#jobs.set(runId, job);
    return job;
  }

  #scheduleTerminal(runId) {
    if (this.#jobs.has(runId)) return this.#jobs.get(runId);
    let job;
    job = Promise.resolve()
      .then(() => this.#executeLeased(runId, (lease) => this.#reconcileTerminalRun(runId, lease)))
      .finally(() => {
        if (this.#jobs.get(runId) === job) this.#jobs.delete(runId);
      });
    this.#jobs.set(runId, job);
    return job;
  }

  #scheduleReview(decision, { requeue = true } = {}) {
    const previous = this.#jobs.get(decision.runId) ?? Promise.resolve();
    let job;
    job = Promise.resolve(previous)
      .catch(() => {})
      .then(async () => {
        if (requeue) {
          const now = this.#now();
          await this.#store.repositories.runJobs.requeueByRun(decision.runId, { now });
        }
        return this.#executeLeased(decision.runId, async (lease) => {
        const run = await this.#internalRun(decision.runId);
        if (!run || TERMINAL.has(run.status)) return;
        const execution = await this.#executionForRun(run);
        if (decision.decision === "reject") return this.#cancelRun(run, decision, lease);
        if (decision.decision === "revise") return this.#reviseRun(run, execution, decision, lease);
        return this.#approveRun(run, execution, decision, lease);
        });
      })
      .finally(() => {
        if (this.#jobs.get(decision.runId) === job) this.#jobs.delete(decision.runId);
      });
    this.#jobs.set(decision.runId, job);
    return job;
  }

  async #executeLeased(runId, operation) {
    const now = this.#now();
    const lease = await this.#store.repositories.runJobs.claimByRun(runId, {
      workerId: this.#workerId,
      now,
      leaseExpiresAt: addMilliseconds(now, this.#leaseDurationMs),
    });
    if (!lease) return false;
    const leaseProjection = await this.#store.repositories.runLeases.acquire({
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      runId,
      runJobId: lease.runJobId,
      workspaceId: lease.workspaceId,
      workerId: this.#workerId,
      fence: lease.fence,
      status: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: lease.leaseExpiresAt,
      releasedAt: null,
      updatedAt: now,
    });
    if (
      !leaseProjection
      || leaseProjection.workerId !== this.#workerId
      || leaseProjection.fence !== lease.fence
      || leaseProjection.status !== "active"
    ) {
      await this.#store.repositories.runJobs.abandonClaimByRun(runId, {
        workerId: this.#workerId,
        fence: lease.fence,
        now: this.#now(),
      });
      return false;
    }
    this.#activeLeases.set(runId, lease);
    this.#startLeaseHeartbeat(runId, lease);
    try {
      await this.#fault("post-claim", { runId, lease });
      await operation(lease);
    } catch (error) {
      if (error?.code !== "run_lease_lost") await this.#failRun(runId, error, lease);
    } finally {
      this.#stopLeaseHeartbeat(runId);
      await this.#releaseLeaseProjection(runId, lease);
      this.#activeLeases.delete(runId);
    }
    return true;
  }

  #startLeaseHeartbeat(runId, lease) {
    const intervalMs = Math.max(250, Math.floor(this.#leaseDurationMs / 3));
    const timer = setInterval(() => {
      const now = this.#now();
      const leaseExpiresAt = addMilliseconds(now, this.#leaseDurationMs);
      Promise.all([
        this.#store.repositories.runJobs.heartbeatByRun(runId, {
          workerId: this.#workerId,
          fence: lease.fence,
          now,
          leaseExpiresAt,
        }),
        this.#store.repositories.runLeases.heartbeat(runId, {
          workerId: this.#workerId,
          fence: lease.fence,
          heartbeatAt: now,
          expiresAt: leaseExpiresAt,
        }),
      ]).then(([job, record]) => {
        if (!job || !record) this.#abortControllers.get(runId)?.abort(new WorkflowRunnerError("run_lease_lost"));
      }).catch(() => {
        this.#abortControllers.get(runId)?.abort(new WorkflowRunnerError("run_lease_lost"));
      });
    }, intervalMs);
    timer.unref?.();
    this.#leaseTimers.set(runId, timer);
  }

  #stopLeaseHeartbeat(runId) {
    const timer = this.#leaseTimers.get(runId);
    if (timer) clearInterval(timer);
    this.#leaseTimers.delete(runId);
  }

  async #execute(runId, execution, lease) {
    let run = await this.#internalRun(runId);
    if (!run || TERMINAL.has(run.status) || run.status === "waiting_review") return;
    if (run.status === "queued") {
      const now = this.#now();
      const started = await this.#fencedTransition(runId, lease, async (options) => {
        await this.#patchRun(runId, { status: "running", startedAt: now, updatedAt: now }, options);
        const current = await this.#internalRun(runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(current, "run.started", "running", "Run started.", undefined, options);
        return { run: current, event };
      });
      run = started.run;
      this.#hub.publish(started.event);
    }
    for (const step of execution.plan.steps) {
      run = await this.#internalRun(runId);
      if (!run || run.status !== "running") return;
      await this.#assertDependencies(run, step);
      const existing = await this.#latestAttempt(runId, step.nodeId);
      if (existing?.status === "completed") continue;
      const existingRunning = existing?.status === "running" && existing?.invocationId;
      if (existingRunning) {
        await this.#failUnknownInvocation(run, existing, lease);
        return;
      }
      const paused = await this.#executeStep(run, execution, step, { lease });
      if (paused) return;
    }
    run = await this.#internalRun(runId);
    if (run?.status === "running") await this.#completeRun(run, execution, lease);
  }

  async #approveRun(run, execution, decision, lease) {
    await this.#fencedTransition(run.runId, lease, async (options) => {
      const attempt = await this.#latestAttempt(run.runId, decision.nodeId, options);
      if (!attempt || attempt.status !== "waiting_review") throw new WorkflowRunnerError("review_gate_attempt_missing");
      const node = nodeFor(execution.revision, decision.nodeId);
      const output = reviewOutput(node, attempt.executionInput);
      const now = this.#now();
      await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
        status: "completed", summary: "Review approved.", executionOutput: output,
        completedAt: now, updatedAt: now,
      }, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#insertCheckpoint(run.runId, attempt, "completed", lease, options);
      await this.#patchRun(run.runId, { status: "running", currentNodeId: null, updatedAt: now }, options);
      await this.#store.repositories.reviewDecisions.patch(decision.decisionId, {
        applicationStatus: "applied",
        appliedAt: now,
        updatedAt: now,
      }, options);
      await this.#putReadModel(await this.#internalRun(run.runId, options), {}, options);
    });
    await this.#execute(run.runId, execution, lease);
  }

  async #reviseRun(run, execution, decision, lease) {
    const gate = execution.plan.steps.find((step) => step.nodeId === decision.nodeId);
    if (!gate) throw new WorkflowRunnerError("review_gate_not_in_plan");
    const gateNode = nodeFor(execution.revision, decision.nodeId);
    const revisionTarget = gateNode.configuration?.revisionTarget;
    if (!revisionTarget || !gate.dependsOn.includes(revisionTarget.nodeId)) {
      throw new WorkflowRunnerError("review_feedback_target_missing", "This Review Gate has no configured Skill input for requested changes.", {
        nodeId: decision.nodeId,
      });
    }
    const step = execution.plan.steps.find((candidate) => candidate.nodeId === revisionTarget.nodeId);
    const targetNode = nodeFor(execution.revision, revisionTarget.nodeId);
    if (step?.kind !== "Skill" || !targetNode.inputPorts.some((port) => port.portId === revisionTarget.portId)) {
      throw new WorkflowRunnerError("review_feedback_target_invalid", "This Review Gate points to an unavailable Skill input.", {
        nodeId: decision.nodeId,
      });
    }
    const originalInput = await this.#bindings(
      await this.#internalRun(run.runId),
      execution.revision,
      step,
      targetNode,
    );
    const revisedValue = appendReviewerFeedback(originalInput[revisionTarget.portId], decision);
    const gateAttempt = await this.#latestAttempt(run.runId, decision.nodeId);
    if (!gateAttempt || gateAttempt.status !== "waiting_review") {
      throw new WorkflowRunnerError("review_gate_attempt_missing");
    }
    await this.#executeStep(await this.#internalRun(run.runId), execution, step, {
      force: true,
      inputOverrides: { [revisionTarget.portId]: revisedValue },
      lease,
      beforeAttempt: async (options) => {
        const now = this.#now();
        await this.#patchAttempt(run.runId, decision.nodeId, gateAttempt.attempt, {
          status: "skipped",
          summary: "Changes requested.",
          completedAt: now,
          updatedAt: now,
        }, options);
        await this.#store.repositories.reviewDecisions.patch(decision.decisionId, {
          applicationStatus: "applying",
          updatedAt: now,
        }, options);
        await this.#patchRun(run.runId, { status: "running", currentNodeId: revisionTarget.nodeId, updatedAt: now }, options);
      },
    });
    await this.#execute(run.runId, execution, lease);
  }

  async #cancelRun(run, decision, lease) {
    const result = await this.#cancelStoredRun(run, { reviewNodeId: decision.nodeId, lease, decision });
    if (result.event) this.#hub.publish(result.event);
  }

  async #recordCommand({ runId, workspaceId, command, requestedBy, session }) {
    if (!workspaceId) throw new WorkflowRunnerError("run_workspace_missing", "Run workspace is unavailable.", { runId });
    const now = this.#now();
    return this.#store.repositories.runCommands.insert({
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      runCommandId: this.#idFactory("run-command"),
      runId,
      workspaceId,
      command,
      requestedBy,
      requestedAt: now,
    }, { session });
  }

  async #cancelStoredRun(run, {
    session,
    reviewNodeId = null,
    lease = null,
    decision = null,
    abortInvocation = true,
  } = {}) {
    if (!run || TERMINAL.has(run.status)) return { event: null };
    if (abortInvocation) {
      this.#abortControllers.get(run.runId)?.abort(new WorkflowRunnerError("run_cancelled"));
    }
    const nodeId = reviewNodeId ?? run.currentNodeId;
    const attempt = nodeId ? await this.#latestAttempt(run.runId, nodeId, session ? { session } : {}) : null;
    if (attempt && ["waiting_review", "running"].includes(attempt.status)) {
      await this.#patchAttempt(run.runId, nodeId, attempt.attempt, {
        status: "cancelled", summary: "Run cancelled.", completedAt: this.#now(), updatedAt: this.#now(),
      }, session ? { session } : {});
    }
    await this.#syncNodeRuns(run.runId, { session });
    const now = this.#now();
    return this.#commitTerminalRun({ runId: run.runId, status: "cancelled", now, session, lease, decision });
  }

  async #executeStep(run, execution, step, { force = false, inputOverrides = null, lease, beforeAttempt = null } = {}) {
    const node = nodeFor(execution.revision, step.nodeId);
    const input = {
      ...(await this.#bindings(run, execution.revision, step, node)),
      ...(inputOverrides ? structuredClone(inputOverrides) : {}),
    };
    const created = await this.#createAttempt(run, node, input, { lease, beforeAttempt });
    const attempt = created.attempt;
    this.#hub.publish(created.event);
    const controller = new AbortController();
    this.#abortControllers.set(run.runId, controller);
    if (node.kind === "Skill") {
      await this.#fault("post-attempt-invocation-persistence", { runId: run.runId, nodeId: node.nodeId, attempt, lease });
      await this.#fencedTransition(run.runId, lease, async () => {});
    }
    try {
      if (node.kind === "ReviewGate") {
        const waiting = await this.#fencedTransition(run.runId, lease, async (options) => {
          const now = this.#now();
          await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
            status: "waiting_review", summary: "Waiting for review.", updatedAt: now,
          }, options);
          await this.#syncNodeRuns(run.runId, options);
          await this.#insertCheckpoint(run.runId, attempt, "waiting_review", lease, options);
          await this.#patchRun(run.runId, { status: "waiting_review", currentNodeId: node.nodeId, updatedAt: now }, options);
          const decisions = await this.#store.repositories.reviewDecisions.listInternalByRun(run.runId, options);
          const applying = decisions.findLast?.((entry) => entry.applicationStatus === "applying")
            ?? [...decisions].reverse().find((entry) => entry.applicationStatus === "applying");
          if (applying) {
            await this.#store.repositories.reviewDecisions.patch(applying.decisionId, {
              applicationStatus: "applied", appliedAt: now, updatedAt: now,
            }, options);
          }
          const current = await this.#internalRun(run.runId, options);
          await this.#putReadModel(current, { reviewPacket: reviewPacket(node, input) }, options);
          const event = await this.#appendEvent(current, "review.requested", "waiting_review", "Review requested.", node.nodeId, options);
          const pausedJob = await this.#store.repositories.runJobs.pauseByRun(run.runId, {
            workerId: this.#workerId, fence: lease.fence, now, session: options.session,
          });
          if (!pausedJob) throw new WorkflowRunnerError("run_lease_lost");
          await this.#store.repositories.runLeases.release(run.runId, {
            workerId: this.#workerId, fence: lease.fence, releasedAt: now, session: options.session,
          });
          return { event };
        });
        await this.#fault("waiting-review-handoff", { runId: run.runId, nodeId: node.nodeId, lease });
        this.#hub.publish(waiting.event);
        return true;
      }
      let output;
      if (node.kind === "Input") output = inputNodeOutput(node, run.inputs);
      else if (node.kind === "Skill") {
        const skill = this.#pinnedSkill(execution, node);
        validatePortInput(node, input);
        validateSchema(skill.definition.inputSchema, input, "skill_input_invalid");
        output = await this.#agentRuntime.invokeSkillNode({
          invocationId: attempt.invocationId,
          workspaceId: run.executionSnapshot?.workspaceId,
          executionRef: skill.executionRef,
          input, timeoutMs: node.timeoutSeconds * 1000, signal: controller.signal,
        });
        validateSchema(skill.definition.outputSchema, output, "skill_output_invalid");
        validatePortOutput(node, output);
      } else if (node.kind === "Output") output = outputNodeOutput(node, input);
      else if (node.kind === "Material") output = await this.#materialOutput(run, node);
      else {
        throw new WorkflowRunnerError(
          "transform_execution_not_supported",
          "This node kind is not supported by the P0 runner.", { nodeId: node.nodeId },
        );
      }
      const now = this.#now();
      const completed = await this.#fencedTransition(run.runId, lease, async (options) => {
        await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
          status: "completed", summary: `${node.title} completed.`, executionOutput: output,
          invocationStatus: attempt.invocationId ? "completed" : undefined,
          completedAt: now, updatedAt: now,
        }, options);
        await this.#syncNodeRuns(run.runId, options);
        await this.#insertCheckpoint(run.runId, attempt, "completed", lease, options);
        const current = await this.#internalRun(run.runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(current, "node.completed", "completed", `${node.title} completed.`, node.nodeId, options);
        return { event };
      });
      this.#hub.publish(completed.event);
      return false;
    } catch (error) {
      if (controller.signal.aborted || (await this.#internalRun(run.runId))?.status === "cancelled") {
        const now = this.#now();
        await this.#fencedTransition(run.runId, lease, async (options) => this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
          status: "cancelled", summary: "Run cancelled.", completedAt: now, updatedAt: now,
        }, options));
        return true;
      }
      const failure = productFailure(error);
      const now = this.#now();
      const failed = await this.#fencedTransition(run.runId, lease, async (options) => {
        await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
          status: "failed", summary: `${node.title} failed.`, failure,
          invocationStatus: attempt.invocationId ? "failed" : undefined,
          completedAt: now, updatedAt: now,
        }, options);
        await this.#syncNodeRuns(run.runId, options);
        await this.#insertCheckpoint(run.runId, attempt, "failed", lease, options);
        const current = await this.#internalRun(run.runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(current, "node.failed", "failed", `${node.title} failed.`, node.nodeId, options);
        return { event };
      });
      this.#hub.publish(failed.event);
      await this.#failRun(run.runId, failure, lease);
      return true;
    } finally {
      if (this.#abortControllers.get(run.runId) === controller) {
        this.#abortControllers.delete(run.runId);
      }
    }
  }

  async #completeRun(run, execution, lease) {
    const output = await this.#latestAttempt(run.runId, execution.plan.primaryOutput.nodeId);
    const finalText = output?.executionOutput?.[execution.plan.primaryOutput.portId];
    if (typeof finalText !== "string" || finalText.length === 0) {
      throw new WorkflowRunnerError("output_final_text_invalid");
    }
    const previousReadModel = await this.#store.repositories.runReadModels.get(run.runId);
    const authoritative = await this.#agentRuntime.buildAuthoritativeFinal({
      runId: run.runId, finalText, evidenceGaps: [], reviewPacket: previousReadModel?.reviewPacket ?? null,
    });
    if (
      authoritative?.finalText !== finalText
      || authoritative?.agentFinalReadModel?.schemaVersion !== "agent-final-read-model-v1"
      || authoritative.agentFinalReadModel.runID !== run.runId
      || authoritative.agentFinalReadModel.finalText !== finalText
    ) {
      throw new WorkflowRunnerError("final_authority_mismatch");
    }
    const now = this.#now();
    const result = await this.#commitTerminalRun({
      runId: run.runId,
      status: "completed",
      now,
      patch: {
        authoritativeReadModel: { available: true, version: 1 },
        agentFinalReadModel: structuredClone(authoritative.agentFinalReadModel),
      },
      readModel: {
        evidenceGaps: authoritative.evidenceGaps,
        reviewPacket: authoritative.reviewPacket,
      },
      lease,
    });
    await this.#fault("terminal-commit-before-publish", { runId: run.runId, status: "completed", lease });
    if (result.event) this.#hub.publish(result.event);
  }

  async #failRun(runId, error, lease = null) {
    const run = await this.#internalRun(runId);
    if (!run || TERMINAL.has(run.status)) return;
    const now = this.#now();
    const result = await this.#commitTerminalRun({
      runId,
      status: "failed",
      now,
      failure: productFailure(error),
      lease,
    });
    await this.#fault("terminal-commit-before-publish", { runId, status: "failed", lease });
    if (result.event) this.#hub.publish(result.event);
  }

  async #reconcileTerminalRun(runId, lease) {
    const run = await this.#internalRun(runId);
    if (!run || !TERMINAL.has(run.status)) return;
    const result = await this.#commitTerminalRun({
      runId,
      status: run.status,
      now: run.finishedAt ?? this.#now(),
      lease,
    });
    await this.#fault("terminal-commit-before-publish", { runId, status: run.status, lease });
    if (result.event) this.#hub.publish(result.event);
  }

  async #commitTerminalRun({ runId, status, now, patch = {}, readModel = {}, failure, session, lease = null, decision = null } = {}) {
    if (!TERMINAL.has(status)) throw new WorkflowRunnerError("run_terminal_status_invalid", "Run terminal status is invalid.", { runId, status });
    const transition = async (options) => {
      let current = await this.#internalRun(runId, options);
      if (!current) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
      const wasTerminal = TERMINAL.has(current.status);
      if (wasTerminal && current.status !== status) {
        throw new WorkflowRunnerError("run_terminal_status_conflict", "Run already has a different terminal status.", {
          runId,
          status: current.status,
        });
      }
      if (!wasTerminal) {
        await this.#patchRun(runId, {
          ...patch,
          status,
          currentNodeId: null,
          finishedAt: now,
          updatedAt: now,
        }, options);
        current = await this.#internalRun(runId, options);
      }
      if (decision) {
        await this.#store.repositories.reviewDecisions.patch(decision.decisionId, {
          applicationStatus: "applied", appliedAt: now, updatedAt: now,
        }, options);
      }
      const terminalProjection = terminalReadModelProjection(current, { failure, readModel });
      await this.#putReadModel(current, terminalProjection, options);
      const terminalType = `run.${status}`;
      const events = await this.#store.repositories.runEvents.listAfter(runId, 0, options);
      const terminalEvents = events.filter((event) => event.type === terminalType);
      const retainedEvent = terminalEvents[0] ?? null;
      const logicalEventId = `terminal:${runId}:${status}`;
      const existingMarker = await this.#store.repositories.runTerminalTransitions.collection.findOne(
        { runId },
        options.session ? { session: options.session } : {},
      );
      let checkpointId = existingMarker?.checkpointId ?? null;
      if (!existingMarker) {
        const sequence = lease
          ? await this.#store.repositories.runJobs.nextCheckpointSequence(runId, {
            workerId: this.#workerId, fence: lease.fence, now, session: options.session,
          })
          : await this.#store.repositories.runJobs.nextTerminalCheckpointSequence(runId, {
            now, session: options.session,
          });
        if (!sequence) throw new WorkflowRunnerError(lease ? "run_lease_lost" : "run_job_missing");
        checkpointId = `checkpoint-${logicalEventId}`;
        await this.#store.repositories.runCheckpoints.insert({
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          checkpointId,
          runId,
          attemptId: "terminal",
          sequence,
          workerId: lease?.leaseOwner ?? this.#workerId,
          fence: lease?.fence ?? null,
          state: { status, terminal: true },
          createdAt: now,
        }, options);
      }
      let event = retainedEvent;
      if (!event) {
        event = await this.#appendEvent(
          current,
          terminalType,
          status,
          terminalEventSummary(status),
          undefined,
          { ...options, occurredAt: current.finishedAt ?? now, eventId: logicalEventId },
        );
      }
      if (!existingMarker) {
        await this.#store.repositories.runTerminalTransitions.insert({
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          terminalTransitionId: logicalEventId,
          logicalEventId,
          runId,
          status,
          eventId: event.eventId,
          checkpointId,
          workerId: lease?.leaseOwner ?? null,
          fence: lease?.fence ?? null,
          committedAt: current.finishedAt ?? now,
        }, options);
      }
      if (lease) {
        const finished = await this.#store.repositories.runJobs.finishByRun(runId, {
          workerId: this.#workerId, fence: lease.fence, status: runJobStatus(status), now, session: options.session,
        });
        if (!finished) throw new WorkflowRunnerError("run_lease_lost");
        await this.#store.repositories.runLeases.release(runId, {
          workerId: this.#workerId, fence: lease.fence, releasedAt: now, session: options.session,
        });
      } else if (status === "cancelled") {
        await this.#store.repositories.runJobs.cancelByRun(runId, { now, session: options.session });
        await this.#store.repositories.runLeases.cancelByRun(runId, { cancelledAt: now, session: options.session });
      }
      return { event: retainedEvent ? null : event };
    };
    if (lease) return this.#fencedTransition(runId, lease, transition, { session });
    return this.#store.withTransaction(
      (transactionSession) => transition({ session: transactionSession }),
      { session },
    );
  }

  async #createAttempt(run, node, executionInput, { lease, beforeAttempt = null } = {}) {
    return this.#fencedTransition(run.runId, lease, async (options) => {
      const previous = await this.#latestAttempt(run.runId, node.nodeId, options);
      const now = this.#now();
      if (beforeAttempt) await beforeAttempt(options);
      const attempt = {
        schemaVersion: WORKBENCH_SCHEMA_VERSION,
        nodeRunId: this.#idFactory("node-run"),
        runId: run.runId,
        nodeId: node.nodeId,
        attempt: (previous?.attempt ?? 0) + 1,
        status: "running",
        summary: "Running.",
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        executionInput: structuredClone(executionInput),
        ...(node.kind === "Skill" ? {
          invocationId: this.#idFactory("invocation"),
          invocationStatus: "started",
          invocationStartedAt: now,
        } : {}),
        workerId: this.#workerId,
        fence: lease.fence,
      };
      await this.#store.repositories.runNodeAttempts.insert(attempt, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#patchRun(run.runId, { currentNodeId: node.nodeId, updatedAt: now }, options);
      const current = await this.#internalRun(run.runId, options);
      await this.#putReadModel(current, {}, options);
      const event = await this.#appendEvent(current, "node.started", "running", `${node.title} started.`, node.nodeId, options);
      return { attempt, event };
    });
  }

  async #insertCheckpoint(runId, attempt, status, lease, options) {
    if (!lease) throw new WorkflowRunnerError("run_lease_missing", "The Run has no active worker lease.", { runId });
    const now = this.#now();
    const sequence = await this.#store.repositories.runJobs.nextCheckpointSequence(runId, {
      workerId: this.#workerId,
      fence: lease.fence,
      now,
      session: options.session,
    });
    if (!sequence) throw new WorkflowRunnerError("run_lease_lost", "The Run worker lease is no longer current.", { runId });
    return this.#store.repositories.runCheckpoints.insert({
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      checkpointId: this.#idFactory("checkpoint"),
      runId,
      attemptId: attempt.nodeRunId,
      sequence,
      workerId: this.#workerId,
      fence: lease.fence,
      state: {
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
        status,
      },
      createdAt: now,
    }, options);
  }

  async #bindings(run, revision, step, node) {
    if (node.kind === "Input") return {};
    const attempts = await this.#store.repositories.runNodeAttempts.listInternalByRun(run.runId);
    const byNode = new Map();
    for (const attempt of attempts) {
      if (attempt.status === "completed") byNode.set(attempt.nodeId, attempt);
    }
    const values = {};
    for (const binding of step.inputBindings) {
      let value;
      if (binding.source.kind === "runInput") value = run.inputs[binding.source.inputKey];
      else if (binding.source.kind === "literal") value = binding.source.value;
      else if (binding.source.kind === "resource") {
        const resource = run.resourceRefs.find((entry) => entry.resourceId === binding.source.resourceId);
        value = resource ? await this.#readResourceText(run, resource) : null;
      }
      else value = byNode.get(binding.source.nodeId)?.executionOutput?.[binding.source.portId];
      values[binding.targetPort] = applyMapping(value, edgeMapping(revision, binding, node.nodeId));
    }
    return values;
  }

  async #assertDependencies(run, step) {
    for (const nodeId of step.dependsOn) {
      const attempt = await this.#latestAttempt(run.runId, nodeId);
      if (attempt?.status !== "completed") throw new WorkflowRunnerError("dependency_not_completed", "A dependency did not complete.", { nodeId });
    }
  }

  async #materialOutput(run, node) {
    const refs = node.configuration.resourceIds.map((resourceId) =>
      run.resourceRefs.find((entry) => entry.resourceId === resourceId),
    );
    if (refs.some((ref) => !ref)) {
      throw new WorkflowRunnerError("resource_ref_not_found", "This material is not attached to the Workflow.", { nodeId: node.nodeId });
    }
    const text = (await Promise.all(refs.map((ref) => this.#readResourceText(run, ref))))
      .join("\n\n");
    const output = Object.fromEntries(node.outputPorts.map((port) => [port.portId, text]));
    validatePortOutput(node, output);
    return output;
  }

  async #readResourceText(run, ref) {
    if (!this.#resolveResourceText) {
      throw new WorkflowRunnerError("resource_execution_unavailable", "Material execution is not configured.", { resourceId: ref.resourceId });
    }
    return this.#resolveResourceText({
      workspaceId: run.executionSnapshot?.workspaceId,
      resourceId: ref.resourceId,
      version: ref.version,
    });
  }

  #pinnedSkill(execution, node) {
    const skills = execution.skills ?? execution.skillDefinitions;
    const resolved = skills?.get?.(`${node.skillRef.skillId}:${node.skillRef.version}`)
      ?? skills?.[`${node.skillRef.skillId}:${node.skillRef.version}`];
    const definition = resolved?.definition ?? resolved;
    if (
      !resolved?.executionRef
      || !definition?.inputSchema
      || !definition?.outputSchema
    ) {
      throw new WorkflowRunnerError("pinned_skill_contract_missing", "The pinned Skill contract is unavailable.", { nodeId: node.nodeId });
    }
    return { definition, executionRef: resolved.executionRef };
  }

  async #execution(workflowId, revisionId) {
    const value = await this.#resolveExecution({ workflowId, revisionId });
    const revision = value?.revision ?? value?.workflowRevision;
    const compileResult = value?.compileResult ?? value?.compile;
    const plan = compileResult?.executionPlan ?? value?.executionPlan;
    if (!revision || !plan || compileResult?.status !== "ready" || plan.workflowId !== workflowId || plan.workflowRevisionId !== revisionId) {
      throw new WorkflowRunnerError("workflow_execution_not_ready");
    }
    return Object.freeze({
      revision: structuredClone(revision),
      plan: structuredClone(plan),
      skills: value.skills,
      skillDefinitions: value.skillDefinitions,
      skillVersions: structuredClone(value.skillVersions ?? []),
      resources: value.resources,
      workspaceId: value.workspaceId ?? null,
    });
  }

  async #executionForRun(run) {
    const snapshot = run.executionSnapshot;
    if (!snapshot?.skillVersions?.length || !snapshot?.graph || !snapshot?.plan) {
      return this.#execution(run.workflowId, run.workflowRevisionId);
    }
    const skills = new Map(snapshot.skillVersions.map((version) => {
      const definition = projectPublishedSkillVersion(version);
      return [`${version.skillId}:${version.version}`, {
        definition,
        executionRef: structuredClone(version.executionRef),
      }];
    }));
    return Object.freeze({
      revision: {
        schemaVersion: snapshot.schemaVersion,
        revisionId: snapshot.workflowRevisionId,
        workflowId: snapshot.workflowId,
        graph: structuredClone(snapshot.graph),
        inputForm: structuredClone(snapshot.inputForm),
        outputDefinition: structuredClone(snapshot.outputDefinition),
        runSettings: structuredClone(snapshot.runSettings),
      },
      plan: structuredClone(snapshot.plan),
      skills,
      skillDefinitions: undefined,
      skillVersions: structuredClone(snapshot.skillVersions),
      resources: new Map(),
      workspaceId: snapshot.workspaceId,
    });
  }

  async #emit(run, type, status, summary, nodeId, options = {}) {
    const event = await this.#appendEvent(run, type, status, summary, nodeId, options);
    this.#hub.publish(event);
    return event;
  }

  async #appendEvent(run, type, status, summary, nodeId, { session, occurredAt, eventId } = {}) {
    return this.#store.appendRunEvent({
      schemaVersion: RUN_EVENT_SCHEMA_VERSION, eventId: eventId ?? this.#idFactory("event"), type, runId: run.runId,
      workflowId: run.workflowId, workflowRevisionId: run.workflowRevisionId, ...(nodeId ? { nodeId } : {}), status, summary, occurredAt: occurredAt ?? this.#now(),
    }, { session });
  }

  async #putReadModel(run, overrides = {}, options = {}) {
    const nodeTimeline = await this.#store.repositories.runNodeAttempts.listByRun(run.runId, options);
    const decisions = await this.#store.repositories.reviewDecisions.listByRun(run.runId, options);
    const existing = await this.#store.repositories.runReadModels.get(run.runId, options);
    const now = this.#now();
    return this.#store.repositories.runReadModels.put({
      ...existing,
      schemaVersion: WORKBENCH_SCHEMA_VERSION, runId: run.runId, workflowId: run.workflowId,
      workflowRevisionId: run.workflowRevisionId, status: run.status, currentNodeId: run.currentNodeId,
      nodeTimeline, finalAnswer: existing?.finalAnswer ?? null, evidenceGaps: existing?.evidenceGaps ?? [],
      reviewPacket: existing?.reviewPacket ?? null, reviewDecisions: decisions,
      failure: existing?.failure ?? null, recoveryActions: existing?.recoveryActions ?? [],
      followUpPrompts: existing?.followUpPrompts ?? [], resourceRefs: run.resourceRefs,
      evidenceRefs: existing?.evidenceRefs ?? [], createdAt: existing?.createdAt ?? run.createdAt ?? now, updatedAt: now,
      ...overrides,
    }, options);
  }

  async #syncNodeRuns(runId, options = {}) {
    const nodeRuns = await this.#store.repositories.runNodeAttempts.listByRun(runId, options);
    await this.#patchRun(runId, { nodeRuns, updatedAt: this.#now() }, options);
  }

  #patchRun(runId, patch, options = {}) { return this.#store.repositories.runs.patch(runId, patch, options); }
  #internalRun(runId, options = {}) { return this.#store.repositories.runs.getInternal(runId, options); }
  #publicRun(runId, options = {}) { return this.#store.repositories.runs.get(runId, options); }
  #latestAttempt(runId, nodeId, options = {}) {
    return this.#store.repositories.runNodeAttempts.listInternalByRun(runId, options).then((items) => items.filter((item) => item.nodeId === nodeId).at(-1) ?? null);
  }

  #executionSnapshot({ runId, execution, plan, now }) {
    return {
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      runId,
      workspaceId: execution.workspaceId,
      workflowId: plan.workflowId,
      workflowRevisionId: plan.workflowRevisionId,
      graph: structuredClone(execution.revision.graph),
      inputForm: structuredClone(execution.revision.inputForm),
      outputDefinition: structuredClone(execution.revision.outputDefinition),
      runSettings: structuredClone(execution.revision.runSettings),
      plan: structuredClone(plan),
      planHash: plan.contentHash,
      skillVersions: structuredClone(execution.skillVersions ?? []),
      resourceObjectIds: (execution.resources ? [...execution.resources.values()] : []).map((resource) => resource.objectId).filter(Boolean).sort(),
      connectionIds: structuredClone(execution.connectionIds ?? []),
      createdAt: now,
    };
  }

  async #putRunSnapshot(runId, plan, executionSnapshot, { session } = {}) {
    const collection = this.#store.repositories.runs.collection;
    if (!collection?.updateOne) throw new WorkflowRunnerError("run_snapshot_persistence_unavailable");
    await collection.updateOne(
      { runId },
      {
        $set: {
          executionPlanSnapshot: structuredClone(plan),
          executionSnapshot: structuredClone(executionSnapshot),
        },
      },
      session ? { session } : {},
    );
  }

  async #patchAttempt(runId, nodeId, attempt, patch, options = {}) {
    const payload = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const updated = await this.#store.repositories.runNodeAttempts.patchInternal(
      runId,
      nodeId,
      attempt,
      payload,
      options,
    );
    if (!updated) throw new WorkflowRunnerError("node_attempt_transition_conflict", "The node attempt changed before this transition.", { runId, nodeId, attempt });
    return updated;
  }

  async #fencedTransition(runId, lease, mutation, { session } = {}) {
    if (!lease) throw new WorkflowRunnerError("run_lease_missing", "The Run has no active worker lease.", { runId });
    return this.#store.withTransaction(async (transactionSession) => {
      const now = this.#now();
      const active = await this.#store.repositories.runJobs.assertActiveFence(runId, {
        workerId: this.#workerId,
        fence: lease.fence,
        now,
        session: transactionSession,
      });
      if (!active) throw new WorkflowRunnerError("run_lease_lost", "The Run worker lease is no longer current.", { runId });
      return mutation({ session: transactionSession });
    }, { session });
  }

  async #releaseLeaseProjection(runId, lease) {
    const run = await this.#internalRun(runId);
    const finishedAt = this.#now();
    await this.#store.withTransaction(async (session) => {
      const job = await this.#store.repositories.runJobs.finishByRun(runId, {
        workerId: this.#workerId,
        fence: lease.fence,
        status: runJobStatus(run?.status),
        now: finishedAt,
        session,
      });
      if (!job) return;
      await this.#store.repositories.runLeases.release(runId, {
        workerId: this.#workerId,
        fence: lease.fence,
        releasedAt: finishedAt,
        session,
      });
    });
  }

  async #failUnknownInvocation(run, attempt, lease) {
    const failure = {
      code: "side_effect_outcome_unknown",
      message: "The previous Skill invocation may have produced an effect, so it was not repeated.",
      retryable: false,
      details: { nodeId: attempt.nodeId, invocationId: attempt.invocationId },
    };
    const now = this.#now();
    await this.#fencedTransition(run.runId, lease, async (options) => {
      await this.#patchAttempt(run.runId, attempt.nodeId, attempt.attempt, {
        status: "failed",
        summary: "The previous Skill result is unknown.",
        failure,
        invocationStatus: "outcome_unknown",
        completedAt: now,
        updatedAt: now,
      }, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#insertCheckpoint(run.runId, attempt, "failed", lease, options);
    });
    await this.#failRun(run.runId, failure, lease);
  }

  #fault(boundary, context) {
    return this.#faultInjector(boundary, structuredClone(context));
  }

  #now() { return String(this.#clock()); }
}

function nodeFor(revision, nodeId) {
  const node = revision.graph?.nodes?.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new WorkflowRunnerError("execution_node_missing", "The execution node is missing.", { nodeId });
  return node;
}

function inputNodeOutput(node, inputs) {
  const output = {};
  for (const fieldId of node.configuration.fieldIds) output[fieldId] = inputs[fieldId];
  validatePortOutput(node, output);
  return output;
}

function outputNodeOutput(node, input) {
  validatePortInput(node, input);
  const first = node.inputPorts[0]?.portId;
  const text = input[first];
  if (typeof text !== "string" || text.length === 0) throw new WorkflowRunnerError("output_final_text_invalid");
  return { [node.outputPorts[0].portId]: text };
}

function reviewOutput(node, input) {
  const first = node.inputPorts[0]?.portId;
  return Object.fromEntries(node.outputPorts.map((port) => [port.portId, input[first]]));
}

function reviewPacket(node, input) {
  return {
    nodeId: node.nodeId,
    title: node.title,
    summary: node.configuration.instructions,
    items: Object.values(input).map(stringifyItem).filter(Boolean),
    canRequestChanges: Boolean(node.configuration.allowRevision && node.configuration.revisionTarget),
  };
}

function stringifyItem(value) { return typeof value === "string" ? value.slice(0, 1000) : JSON.stringify(value).slice(0, 1000); }
function appendReviewerFeedback(value, decision) {
  if (typeof value !== "string") {
    throw new WorkflowRunnerError("review_feedback_target_invalid", "Requested changes require a text Skill input.", { nodeId: decision.nodeId });
  }
  const messages = [decision.comment, ...(decision.requestedChanges || [])]
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
  if (!messages.length) {
    throw new WorkflowRunnerError("review_feedback_missing", "Requested changes need reviewer feedback.", { nodeId: decision.nodeId });
  }
  return `${value}\n\nReviewer feedback:\n${messages.map((item) => `- ${item}`).join("\n")}`;
}
function edgeMapping(revision, binding, targetNodeId) {
  if (binding.source.kind !== "nodeOutput") return undefined;
  return revision.graph.edges?.find((edge) => edge.sourceNodeId === binding.source.nodeId && edge.sourcePort === binding.source.portId && edge.targetNodeId === targetNodeId && edge.targetPort === binding.targetPort)?.mappingExpression;
}
function applyMapping(value, expression) {
  if (expression === undefined || expression === "identity") return structuredClone(value);
  if (typeof expression !== "string" || !expression.startsWith("/")) throw new WorkflowRunnerError("binding_mapping_invalid");
  let current = value;
  for (const raw of expression.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, token)) throw new WorkflowRunnerError("binding_mapping_missing");
    current = current[token];
  }
  return structuredClone(current);
}

function validatePortInput(node, input) { validatePorts(node.inputPorts, input, "skill_input_invalid"); }
function validatePortOutput(node, output) { validatePorts(node.outputPorts, output, "skill_output_invalid"); }
function validateSchema(schema, value, code) { if (!Check(schema, value)) throw new WorkflowRunnerError(code); }
function validatePorts(ports, value, code) {
  for (const port of ports) {
    if (port.required && !Object.hasOwn(value, port.portId)) throw new WorkflowRunnerError(code);
    if (Object.hasOwn(value, port.portId) && !Check(port.schema, value[port.portId])) throw new WorkflowRunnerError(code);
  }
}

function terminalReadModelProjection(run, { failure, readModel }) {
  if (run.status === "completed") {
    return {
      ...readModel,
      status: "completed",
      currentNodeId: null,
      finalAnswer: completedFinalAnswer(run),
      failure: null,
    };
  }
  if (run.status === "failed") {
    const durableFailure = [...(run.nodeRuns ?? [])]
      .reverse()
      .find((nodeRun) => nodeRun.status === "failed" && nodeRun.failure)?.failure;
    return {
      ...readModel,
      status: "failed",
      currentNodeId: null,
      finalAnswer: null,
      failure: structuredClone(failure ?? durableFailure ?? productFailure()),
    };
  }
  return {
    ...readModel,
    status: "cancelled",
    currentNodeId: null,
    finalAnswer: null,
    failure: null,
  };
}

function completedFinalAnswer(run) {
  const authority = run.agentFinalReadModel;
  const snapshot = run.executionSnapshot;
  const outputNodeId = snapshot?.plan?.primaryOutput?.nodeId;
  const outputNode = snapshot?.graph?.nodes?.find((node) => node.nodeId === outputNodeId);
  const format = outputNode?.configuration?.format;
  if (
    authority?.schemaVersion !== "agent-final-read-model-v1"
    || authority.runID !== run.runId
    || typeof authority.finalText !== "string"
    || authority.finalText.length === 0
    || !new Set(["markdown", "text", "json"]).has(format)
  ) {
    throw new WorkflowRunnerError("terminal_run_authority_invalid", "Completed Run authority is unavailable.", { runId: run.runId });
  }
  return {
    format,
    content: authority.finalText,
    createdAt: run.finishedAt,
  };
}

function terminalEventSummary(status) {
  if (status === "completed") return "Run completed.";
  if (status === "failed") return "Run failed.";
  return "Run cancelled.";
}

function productFailure(error) {
  return { code: error?.code ?? "workflow_execution_failed", message: "The workflow could not complete.", retryable: false };
}
function requiredId(value, code) { if (typeof value !== "string" || value.length === 0) throw new WorkflowRunnerError(code); }
function addMilliseconds(value, milliseconds) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new WorkflowRunnerError("runner_clock_invalid");
  return new Date(time + milliseconds).toISOString();
}
function runJobStatus(runStatus) {
  if (["completed", "failed", "cancelled"].includes(runStatus)) return runStatus;
  if (["waiting_review", "paused"].includes(runStatus)) return "paused";
  return "failed";
}
function cloneObject(value, code) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowRunnerError(code); return structuredClone(value); }
function cloneArray(value, code) { if (!Array.isArray(value)) throw new WorkflowRunnerError(code); return structuredClone(value); }
