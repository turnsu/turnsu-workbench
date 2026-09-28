import { createHash } from "node:crypto";

export const RUN_STATE_EVENT_SCHEMA_VERSION = "workbench-run-state-event-v2";
export const RUN_STATE_MODEL_VERSION = 2;
export const RUN_LIFECYCLE_FIELDS = Object.freeze([
  "status",
  "currentNodeId",
  "startedAt",
  "finishedAt",
  "updatedAt",
]);

const RUN_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "partial",
  "effect_outcome_unknown",
]);

const RUN_STATUS_TRANSITIONS = Object.freeze({
  queued: new Set(["queued", "running", "cancellation_requested", "cancelled", "failed"]),
  running: new Set([
    "running",
    "waiting_review",
    "cancellation_requested",
    "completed",
    "failed",
    "cancelled",
    "partial",
    "effect_outcome_unknown",
  ]),
  waiting_review: new Set(["waiting_review", "paused", "cancellation_requested", "cancelled", "failed"]),
  paused: new Set(["paused", "running", "cancellation_requested", "cancelled", "failed"]),
  cancellation_requested: new Set([
    "cancellation_requested",
    "cancelled",
    "partial",
    "effect_outcome_unknown",
    "failed",
  ]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
  partial: new Set(["partial"]),
  effect_outcome_unknown: new Set(["effect_outcome_unknown"]),
});

export class RunStateEventError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "RunStateEventError";
    this.code = code;
    this.details = details;
  }
}

export function emptyRunLifecycleState() {
  return {
    status: null,
    currentNodeId: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: null,
  };
}

export function lifecycleStateFromRun(run) {
  const state = emptyRunLifecycleState();
  for (const field of RUN_LIFECYCLE_FIELDS) {
    state[field] = run?.[field] ?? null;
  }
  return state;
}

export function lifecyclePatchFromRunPatch(patch) {
  return Object.fromEntries(
    RUN_LIFECYCLE_FIELDS
      .filter((field) => Object.hasOwn(patch ?? {}, field))
      .map((field) => [field, patch[field] ?? null]),
  );
}

export function applyRunLifecyclePatch(state, patch) {
  const next = { ...emptyRunLifecycleState(), ...structuredClone(state) };
  for (const [field, value] of Object.entries(lifecyclePatchFromRunPatch(patch))) {
    next[field] = value;
  }
  validateLifecycleState(next);
  validateLifecycleTransition(state, next);
  return next;
}

export function hashRunLifecycleState(state) {
  validateLifecycleState(state);
  return `sha256:${createHash("sha256").update(canonicalJson(state)).digest("hex")}`;
}

export function sourceHashForLegacyRun(run) {
  return `sha256:${createHash("sha256").update(canonicalJson({
    base: immutableRunBaseFromRun(run),
    lifecycle: lifecycleStateFromRun(run),
  })).digest("hex")}`;
}

export function immutableRunBaseFromRun(run) {
  const base = structuredClone(run ?? {});
  for (const field of [
    ...RUN_LIFECYCLE_FIELDS,
    "_id",
    "workspaceId",
    "requestedBy",
    "eventSequence",
    "nodeRuns",
    "reviewDecisions",
    "authoritativeReadModel",
    "agentFinalReadModel",
    "stateEventSequence",
    "stateHash",
  ]) {
    delete base[field];
  }
  if (base.executionSnapshot && typeof base.executionSnapshot === "object") {
    delete base.executionSnapshot.workspaceId;
    delete base.executionSnapshot.requestedBy;
  }
  return base;
}

export function createInitialRunStateEvent({ run, eventId, commandId, occurredAt }) {
  const state = lifecycleStateFromRun(run);
  return createEnvelope({
    run,
    eventId,
    sequence: 1,
    transitionType: "run_queued",
    priorStateHash: hashRunLifecycleState(emptyRunLifecycleState()),
    stateHash: hashRunLifecycleState(state),
    payload: { state, base: immutableRunBaseFromRun(run) },
    commandId,
    occurredAt,
  });
}

export function createLegacyImportEvent({ run, eventId, commandId, occurredAt }) {
  const state = lifecycleStateFromRun(run);
  return createEnvelope({
    run,
    eventId,
    sequence: 1,
    transitionType: "run_state_imported",
    priorStateHash: hashRunLifecycleState(emptyRunLifecycleState()),
    stateHash: hashRunLifecycleState(state),
    payload: {
      state,
      base: immutableRunBaseFromRun(run),
      sourceHash: sourceHashForLegacyRun(run),
    },
    commandId,
    occurredAt,
  });
}

export function createRunStateTransitionEvent({
  run,
  patch,
  eventId,
  commandId,
  occurredAt,
  transitionType,
  attemptId,
  effectReceiptId,
}) {
  const lifecyclePatch = lifecyclePatchFromRunPatch(patch);
  if (Object.keys(lifecyclePatch).length === 0) return null;
  const prior = lifecycleStateFromRun(run);
  const next = applyRunLifecyclePatch(prior, lifecyclePatch);
  const priorStateHash = hashRunLifecycleState(prior);
  if (run.stateHash !== priorStateHash) {
    throw new RunStateEventError(
      "run_state_prior_hash_invalid",
      "The Run projection no longer matches its authoritative event stream.",
      { runId: run.runId },
    );
  }
  return createEnvelope({
    run,
    eventId,
    sequence: run.stateEventSequence + 1,
    transitionType: transitionType ?? inferTransitionType(prior, next),
    priorStateHash,
    stateHash: hashRunLifecycleState(next),
    payload: { patch: lifecyclePatch },
    commandId,
    occurredAt,
    attemptId,
    effectReceiptId,
  });
}

export function foldRunStateEvents(events, { expectedRunId, snapshot = null } = {}) {
  validateFoldSnapshot(snapshot, expectedRunId);
  let state = snapshot ? structuredClone(snapshot.state) : emptyRunLifecycleState();
  let stateHash = snapshot ? snapshot.stateHash : hashRunLifecycleState(state);
  let sequence = snapshot ? snapshot.sequence : 0;
  let base = snapshot ? structuredClone(snapshot.base) : null;
  for (const event of events ?? []) {
    if (!event || event.schemaVersion !== RUN_STATE_EVENT_SCHEMA_VERSION
      || (expectedRunId && event.runId !== expectedRunId)
      || event.sequence !== sequence + 1
      || event.priorStateHash !== stateHash) {
      throw new RunStateEventError("run_state_event_chain_invalid", "The Run state event chain is invalid.", {
        runId: expectedRunId ?? event?.runId ?? null,
        sequence: event?.sequence ?? null,
      });
    }
    if (["run_queued", "run_state_imported"].includes(event.transitionType)) {
      if (sequence !== 0 || !event.payload?.state || !event.payload?.base) {
        throw new RunStateEventError("run_state_event_chain_invalid");
      }
      state = applyRunLifecyclePatch(emptyRunLifecycleState(), event.payload.state);
      base = structuredClone(event.payload.base);
    } else {
      state = applyRunLifecyclePatch(state, event.payload?.patch ?? {});
    }
    stateHash = hashRunLifecycleState(state);
    if (event.stateHash !== stateHash) {
      throw new RunStateEventError("run_state_event_hash_invalid", "A Run state event has an invalid resulting hash.", {
        runId: event.runId,
        sequence: event.sequence,
      });
    }
    sequence = event.sequence;
  }
  return { state, stateHash, sequence, base };
}

export function runProjectionMatchesFold(run, fold) {
  return run?.stateModelVersion === RUN_STATE_MODEL_VERSION
    && run?.stateEventSequence === fold.sequence
    && run?.stateHash === fold.stateHash
    && hashRunLifecycleState(lifecycleStateFromRun(run)) === fold.stateHash;
}

function createEnvelope({
  run,
  eventId,
  sequence,
  transitionType,
  priorStateHash,
  stateHash,
  payload,
  commandId,
  occurredAt,
  attemptId,
  effectReceiptId,
}) {
  for (const [value, code] of [
    [run?.runId, "run_state_run_id_invalid"],
    [run?.workspaceId, "run_state_workspace_id_invalid"],
    [eventId, "run_state_event_id_invalid"],
    [commandId, "run_state_command_id_invalid"],
    [transitionType, "run_state_transition_type_invalid"],
  ]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new RunStateEventError(code);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(Date.parse(occurredAt))) {
    throw new RunStateEventError("run_state_event_envelope_invalid");
  }
  return {
    schemaVersion: RUN_STATE_EVENT_SCHEMA_VERSION,
    eventId,
    runId: run.runId,
    workspaceId: run.workspaceId,
    sequence,
    transitionType,
    priorStateHash,
    stateHash,
    payload: structuredClone(payload),
    ...(attemptId ? { attemptId } : {}),
    ...(effectReceiptId ? { effectReceiptId } : {}),
    commandId,
    occurredAt: new Date(occurredAt).toISOString(),
  };
}

function inferTransitionType(prior, next) {
  if (prior.status !== next.status) {
    if (next.status === "running" && prior.status === "queued") return "run_started";
    if (next.status === "waiting_review") return "review_requested";
    if (next.status === "paused") return "review_decision_received";
    if (RUN_TERMINAL_STATUSES.has(next.status)) return `run_${next.status}`;
    return `run_${String(next.status).replace(/[^a-z0-9_]/g, "_")}`;
  }
  if (prior.currentNodeId !== next.currentNodeId) return "current_node_changed";
  return "run_lifecycle_updated";
}

function validateLifecycleState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new RunStateEventError("run_state_invalid");
  for (const field of RUN_LIFECYCLE_FIELDS) {
    if (!Object.hasOwn(state, field)) throw new RunStateEventError("run_state_invalid");
  }
  if (state.status !== null && !Object.hasOwn(RUN_STATUS_TRANSITIONS, state.status)) {
    throw new RunStateEventError("run_state_invalid");
  }
  if (state.currentNodeId !== null && (typeof state.currentNodeId !== "string" || state.currentNodeId.length > 128)) {
    throw new RunStateEventError("run_state_invalid");
  }
  for (const field of ["startedAt", "finishedAt", "updatedAt"]) {
    if (state[field] !== null && (typeof state[field] !== "string" || !Number.isFinite(Date.parse(state[field])))) {
      throw new RunStateEventError("run_state_invalid");
    }
  }
  if (RUN_TERMINAL_STATUSES.has(state.status) && state.finishedAt === null) {
    throw new RunStateEventError("run_terminal_finished_at_required");
  }
  if (!RUN_TERMINAL_STATUSES.has(state.status) && state.finishedAt !== null) {
    throw new RunStateEventError("run_non_terminal_finished_at_forbidden");
  }
}

function validateLifecycleTransition(prior, next) {
  if (prior?.status === null) {
    if (next.status !== null && next.status !== "queued") {
      throw new RunStateEventError("run_state_transition_invalid", "A Run event stream must begin in queued state.");
    }
    return;
  }
  if (next.status === null || !RUN_STATUS_TRANSITIONS[prior.status]?.has(next.status)) {
    throw new RunStateEventError(
      "run_state_transition_invalid",
      `Run state cannot transition from ${prior.status} to ${next.status}.`,
      { priorStatus: prior.status, nextStatus: next.status },
    );
  }
}

function validateFoldSnapshot(snapshot, expectedRunId) {
  if (snapshot === null || snapshot === undefined) return;
  if (
    snapshot.schemaVersion !== "workbench-run-state-snapshot-v2"
    || !Number.isSafeInteger(snapshot.sequence)
    || snapshot.sequence < 1
    || typeof snapshot.stateHash !== "string"
    || !snapshot.base
    || (expectedRunId && snapshot.runId !== expectedRunId)
  ) {
    throw new RunStateEventError("run_state_snapshot_invalid", "The Run state checkpoint snapshot is invalid.");
  }
  validateLifecycleState(snapshot.state);
  if (hashRunLifecycleState(snapshot.state) !== snapshot.stateHash) {
    throw new RunStateEventError("run_state_snapshot_hash_invalid", "The Run state checkpoint hash is invalid.");
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
