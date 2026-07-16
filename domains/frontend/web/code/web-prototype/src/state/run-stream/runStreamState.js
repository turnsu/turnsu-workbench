const EVENT_RECEIVED = "run-stream/event-received";
const CONNECTION_STARTED = "run-stream/connection-started";
const CONNECTED = "run-stream/connected";
const DISCONNECTED = "run-stream/disconnected";
const READ_MODEL_REFRESHED = "run-stream/read-model-refreshed";

const RUN_STATUS_BY_EVENT = Object.freeze({
  "run.queued": "queued",
  "run.started": "running",
  "review.requested": "waiting_review",
  "run.paused": "paused",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
});

const NODE_STATUS_BY_EVENT = Object.freeze({
  "node.started": "running",
  "node.progress": "running",
  "node.completed": "completed",
  "node.failed": "failed",
});

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const READ_MODEL_EVENTS = new Set([
  "review.requested",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export function createRunStreamState() {
  return { byRunId: {} };
}

export function runEventReceived(event) {
  return { type: EVENT_RECEIVED, event };
}

export function runStreamConnectionStarted(runId) {
  return { type: CONNECTION_STARTED, runId };
}

export function runStreamConnected(runId) {
  return { type: CONNECTED, runId };
}

export function runStreamDisconnected(runId, { reason = null, retryable = true } = {}) {
  return { type: DISCONNECTED, runId, reason, retryable };
}

export function runReadModelRefreshed(runId) {
  return { type: READ_MODEL_REFRESHED, runId };
}

export function runStreamReducer(state = createRunStreamState(), action = {}) {
  switch (action.type) {
    case EVENT_RECEIVED:
      return reduceEvent(state, action.event);
    case CONNECTION_STARTED:
      return updateConnection(state, action.runId, {
        status: "connecting",
        reason: null,
        retryable: false,
      });
    case CONNECTED:
      return updateConnection(state, action.runId, {
        status: "connected",
        reason: null,
        retryable: false,
      });
    case DISCONNECTED:
      return updateConnection(state, action.runId, {
        status: "disconnected",
        reason: action.reason ?? null,
        retryable: action.retryable !== false,
      });
    case READ_MODEL_REFRESHED:
      return updateEntry(state, action.runId, (entry) => {
        if (!entry.readModelRefreshRequired) return entry;
        return { ...entry, readModelRefreshRequired: false };
      });
    default:
      return state;
  }
}

export function reduceRunEvents(state, events = []) {
  return events.reduce(
    (current, event) => runStreamReducer(current, runEventReceived(event)),
    state,
  );
}

export function selectRunStream(state, runId) {
  return state?.byRunId?.[runId] ?? null;
}

export function selectRunEventCursor(state, runId) {
  return selectRunStream(state, runId)?.lastSequence ?? 0;
}

function reduceEvent(state, event) {
  if (!isEventIdentityValid(event)) return state;
  const current = selectRunStream(state, event.runId) ?? createRunEntry(event.runId);
  if (event.sequence <= current.lastSequence || current.seenEventIds[event.eventId] !== undefined) {
    return state;
  }

  let next = {
    ...current,
    workflowId: event.workflowId ?? current.workflowId,
    workflowRevisionId: event.workflowRevisionId ?? current.workflowRevisionId,
    lastSequence: event.sequence,
    seenEventIds: { ...current.seenEventIds, [event.eventId]: event.sequence },
    updatedAt: event.occurredAt ?? current.updatedAt,
  };

  const runStatus = RUN_STATUS_BY_EVENT[event.type];
  if (runStatus) next.status = runStatus;

  const nodeStatus = NODE_STATUS_BY_EVENT[event.type];
  if (nodeStatus && event.nodeId) {
    next.status = "running";
    next.nodes = {
      ...current.nodes,
      [event.nodeId]: {
        nodeId: event.nodeId,
        status: nodeStatus,
        summary: event.summary,
        occurredAt: event.occurredAt,
        lastSequence: event.sequence,
      },
    };
    next.currentNodeId = nodeStatus === "running" ? event.nodeId : null;
  }

  if (event.type === "review.requested") {
    next.currentNodeId = event.nodeId ?? null;
    next.pendingReview = {
      nodeId: event.nodeId ?? null,
      summary: event.summary,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    };
  } else if (event.type === "run.paused" || TERMINAL_EVENTS.has(event.type)) {
    next.currentNodeId = null;
    next.pendingReview = null;
  }

  if (TERMINAL_EVENTS.has(event.type)) {
    next.terminal = {
      type: event.type,
      status: runStatus,
      summary: event.summary,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    };
  }

  if (READ_MODEL_EVENTS.has(event.type)) next.readModelRefreshRequired = true;

  return {
    ...state,
    byRunId: { ...state.byRunId, [event.runId]: next },
  };
}

function updateConnection(state, runId, connection) {
  return updateEntry(state, runId, (entry) => ({ ...entry, connection }));
}

function updateEntry(state, runId, update) {
  if (typeof runId !== "string" || runId.length === 0) return state;
  const current = selectRunStream(state, runId) ?? createRunEntry(runId);
  const next = update(current);
  if (next === current) return state;
  return {
    ...state,
    byRunId: { ...state.byRunId, [runId]: next },
  };
}

function createRunEntry(runId) {
  return {
    runId,
    workflowId: null,
    workflowRevisionId: null,
    status: "idle",
    connection: {
      status: "idle",
      reason: null,
      retryable: false,
    },
    lastSequence: 0,
    seenEventIds: {},
    currentNodeId: null,
    nodes: {},
    pendingReview: null,
    terminal: null,
    readModelRefreshRequired: false,
    updatedAt: null,
  };
}

function isEventIdentityValid(event) {
  return Boolean(
    event
      && typeof event.runId === "string"
      && event.runId.length > 0
      && typeof event.eventId === "string"
      && event.eventId.length > 0
      && Number.isInteger(event.sequence)
      && event.sequence > 0,
  );
}
