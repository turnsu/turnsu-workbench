import {
  assertRemoteWorkerTransport,
  remoteBackendUnavailable,
  remoteTransportDisconnected,
} from "./remote-worker-transport.mjs";

export const REMOTE_EXECUTION_MODES = Object.freeze([
  "deterministic_skill",
  "bounded_agent",
  "agent_orchestrator",
]);

const MAX_REORDER_WINDOW = 256;
const MAX_REMOTE_EVENTS = 10_000;
const MAX_REMOTE_EVENT_BYTES = 1_000_000;
const INTERNAL_RESULT_KEYS = new Set([
  "deviceId",
  "deviceName",
  "remoteExecutionId",
  "transportId",
  "hostPath",
  "socketPath",
  "imageDigest",
]);

export function createRemoteExecutionBackend({ transport, maxResumeAttempts = 2 } = {}) {
  assertRemoteWorkerTransport(transport);
  if (!Number.isInteger(maxResumeAttempts) || maxResumeAttempts < 0 || maxResumeAttempts > 10) {
    throw new TypeError("remote_resume_attempts_invalid");
  }
  const active = new Map();

  return Object.freeze({
    async execute({ request, lease, signal, emit, checkpoint }) {
      if (!request || request.isolation !== "remote" || !lease
        || typeof emit !== "function" || typeof checkpoint !== "function") {
        throw new TypeError("remote_execution_request_invalid");
      }
      throwIfAborted(signal);
      const probe = await translateUnavailable(() => transport.probe({ signal }));
      if (probe?.available !== true) throw remoteBackendUnavailable();

      const dispatched = await translateUnavailable(() => transport.dispatch({
        request: remoteRequestEnvelope(request),
        lease: remoteLeaseEnvelope(lease),
        signal,
      }));
      let remoteExecutionId = validateRemoteExecutionId(dispatched?.remoteExecutionId);
      const execution = {
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        remoteExecutionId,
        cancelRequested: false,
      };
      active.set(request.invocationId, execution);
      const cancelFromSignal = () => { void cancelExecution(execution, signal?.reason); };
      if (signal?.aborted) cancelFromSignal();
      else signal?.addEventListener("abort", cancelFromSignal, { once: true });

      let nextSequence = 1;
      let resumeAttempts = 0;
      const pending = new Map();
      const eventIdSequences = new Map();
      const sequenceEventIds = new Map();
      let receivedEvents = 0;
      try {
        await checkpoint({ phase: "remote_dispatched", remoteSequence: 0 });
        while (true) {
          throwIfAborted(signal);
          try {
            const stream = await transport.streamEvents({
              remoteExecutionId,
              afterSequence: nextSequence - 1,
              signal,
            });
            const iterator = asyncIterator(stream);
            try {
              while (true) {
                const item = await nextWithAbort(iterator, signal);
                if (item.done) break;
                receivedEvents += 1;
                if (receivedEvents > MAX_REMOTE_EVENTS) throw invalidRemoteEvent("remote_event_limit_exceeded");
                const event = validateRemoteEvent(item.value);
                receiveRemoteEvent({ event, pending, eventIdSequences, sequenceEventIds, nextSequence });
                if (pending.size > MAX_REORDER_WINDOW) throw invalidRemoteEvent("remote_event_reorder_window_exceeded");
                while (pending.has(nextSequence)) {
                  const ordered = pending.get(nextSequence);
                  pending.delete(nextSequence);
                  await emit("execution.remote_event", {
                    remoteSequence: ordered.sequence,
                    type: ordered.type,
                    ...(ordered.status ? { status: ordered.status } : {}),
                    payload: stripInternalDetails(ordered.payload ?? {}),
                  });
                  if (ordered.checkpoint !== undefined) {
                    await checkpoint({
                      phase: "remote_running",
                      remoteSequence: ordered.sequence,
                      transportState: stripInternalDetails(ordered.checkpoint),
                    });
                  }
                  nextSequence += 1;
                  if (ordered.type === "execution.result") {
                    return validateRemoteResult(ordered.result);
                  }
                }
              }
            } finally {
              void closeIterator(iterator).catch(() => {});
            }
            throw remoteTransportDisconnected("The remote event stream ended before a result was received.");
          } catch (error) {
            throwIfAborted(signal);
            if (!isRecoverableDisconnect(error) || resumeAttempts >= maxResumeAttempts) {
              throw translateRemoteError(error);
            }
            resumeAttempts += 1;
            const transportCheckpoint = await translateUnavailable(() => transport.checkpoint({
              remoteExecutionId,
              afterSequence: nextSequence - 1,
              signal,
            }));
            await checkpoint({
              phase: "remote_recovering",
              remoteSequence: nextSequence - 1,
              resumeAttempt: resumeAttempts,
              transportState: stripInternalDetails(transportCheckpoint ?? {}),
            });
            const resumed = await translateUnavailable(() => transport.resume({
              remoteExecutionId,
              afterSequence: nextSequence - 1,
              checkpoint: structuredClone(transportCheckpoint ?? {}),
              signal,
            }));
            if (resumed?.remoteExecutionId !== undefined) {
              remoteExecutionId = validateRemoteExecutionId(resumed.remoteExecutionId);
              execution.remoteExecutionId = remoteExecutionId;
            }
          }
        }
      } finally {
        signal?.removeEventListener("abort", cancelFromSignal);
        if (active.get(request.invocationId) === execution) active.delete(request.invocationId);
        await Promise.resolve(transport.dispose({
          remoteExecutionId: execution.remoteExecutionId,
          invocationId: execution.invocationId,
          attemptId: execution.attemptId,
        })).catch(() => {});
      }
    },

    async cancel({ invocationId, reason } = {}) {
      const execution = active.get(invocationId);
      if (!execution) return false;
      await cancelExecution(execution, reason);
      return true;
    },
  });

  async function cancelExecution(execution, reason) {
    if (execution.cancelRequested) return;
    execution.cancelRequested = true;
    await Promise.resolve(transport.cancel({
      remoteExecutionId: execution.remoteExecutionId,
      invocationId: execution.invocationId,
      attemptId: execution.attemptId,
      reason: safeReason(reason),
    })).catch(() => {});
  }
}

function remoteRequestEnvelope(request) {
  const safeMetadataKeys = new Set([
    "executionRef", "outerNodeId", "definitionId", "agentSessionId", "agentTurnId",
    "objectKind", "objectId", "branchId", "proposalKind", "parentInvocationId",
    "externalChildRef",
  ]);
  return {
    schemaVersion: request.schemaVersion,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    controller: structuredClone(request.controller),
    mode: request.mode,
    isolation: request.isolation,
    goal: request.goal,
    input: structuredClone(request.input),
    limits: structuredClone(request.limits),
    capabilities: structuredClone(request.capabilities),
    resultSchema: structuredClone(request.resultSchema),
    evidenceRequirements: structuredClone(request.evidenceRequirements),
    metadata: Object.fromEntries(Object.entries(request.metadata ?? {})
      .filter(([key]) => safeMetadataKeys.has(key))
      .map(([key, value]) => [key, structuredClone(value)])),
  };
}

function remoteLeaseEnvelope(lease) {
  return {
    capabilityLeaseId: lease.capabilityLeaseId,
    invocationId: lease.invocationId,
    attemptId: lease.attemptId,
    workspaceId: lease.workspaceId,
    fence: lease.fence,
    status: lease.status,
    capabilities: structuredClone(lease.capabilities),
    expiresAt: lease.expiresAt,
  };
}

export function registerRemoteExecutionBackends({ broker, transport, modes = REMOTE_EXECUTION_MODES } = {}) {
  if (typeof broker?.registerBackend !== "function") throw new TypeError("execution_broker_required");
  assertRemoteWorkerTransport(transport);
  if (!Array.isArray(modes) || modes.length === 0
    || modes.some((mode) => !REMOTE_EXECUTION_MODES.includes(mode))) {
    throw new TypeError("remote_execution_modes_invalid");
  }
  const backend = createRemoteExecutionBackend({ transport });
  return modes.map((mode) => broker.registerBackend({ mode, isolation: "remote", backend }));
}

function receiveRemoteEvent({ event, pending, eventIdSequences, sequenceEventIds, nextSequence }) {
  const previousSequence = eventIdSequences.get(event.eventId);
  if (previousSequence !== undefined) {
    if (previousSequence !== event.sequence) throw invalidRemoteEvent("remote_event_id_reused");
    return false;
  }
  const previousEventId = sequenceEventIds.get(event.sequence);
  if (previousEventId !== undefined) {
    if (previousEventId !== event.eventId) throw invalidRemoteEvent("remote_event_sequence_conflict");
    return false;
  }
  if (event.sequence < nextSequence) throw invalidRemoteEvent("remote_event_sequence_replayed_with_new_id");
  eventIdSequences.set(event.eventId, event.sequence);
  sequenceEventIds.set(event.sequence, event.eventId);
  pending.set(event.sequence, event);
  return true;
}

function validateRemoteEvent(event) {
  if (!isPlainObject(event)
    || typeof event.eventId !== "string" || event.eventId.length < 1 || event.eventId.length > 256
    || !Number.isInteger(event.sequence) || event.sequence < 1
    || typeof event.type !== "string" || event.type.length < 1 || event.type.length > 256
    || (event.status !== undefined && (typeof event.status !== "string" || event.status.length > 64))
    || !isJsonValue(event.payload ?? {})
    || (event.checkpoint !== undefined && !isJsonValue(event.checkpoint))
    || (event.type === "execution.result" && !isPlainObject(event.result))
    || byteLength(event) > MAX_REMOTE_EVENT_BYTES) {
    throw invalidRemoteEvent("remote_event_invalid");
  }
  return structuredClone(event);
}

function validateRemoteResult(result) {
  if (!isPlainObject(result)
    || (result.status !== undefined && typeof result.status !== "string")
    || (result.output !== undefined && !isJsonValue(result.output))
    || (result.summary !== undefined && typeof result.summary !== "string")
    || (result.evidence !== undefined && (!Array.isArray(result.evidence) || !result.evidence.every(isPlainObject)))
    || (result.children !== undefined && (!Array.isArray(result.children) || !result.children.every(isPlainObject)))
    || (result.usage !== undefined && !isPlainObject(result.usage))) {
    throw invalidRemoteEvent("remote_result_invalid");
  }
  const sanitized = stripInternalDetails(result);
  return {
    ...(sanitized.status !== undefined ? { status: sanitized.status } : {}),
    ...(Object.hasOwn(sanitized, "output") ? { output: sanitized.output } : {}),
    ...(sanitized.summary !== undefined ? { summary: sanitized.summary } : {}),
    evidence: sanitized.evidence ?? [],
    usage: sanitized.usage ?? {},
    ...(sanitized.children !== undefined ? { children: sanitized.children } : {}),
  };
}

function stripInternalDetails(value) {
  if (Array.isArray(value)) return value.map(stripInternalDetails);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !INTERNAL_RESULT_KEYS.has(key))
    .map(([key, item]) => [key, stripInternalDetails(item)]));
}

function validateRemoteExecutionId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw invalidRemoteEvent("remote_execution_id_invalid");
  }
  return value;
}

function asyncIterator(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw invalidRemoteEvent("remote_event_stream_invalid");
  }
  return stream[Symbol.asyncIterator]();
}

async function nextWithAbort(iterator, signal) {
  throwIfAborted(signal);
  if (!signal) return iterator.next();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("execution_cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function closeIterator(iterator) {
  if (typeof iterator?.return !== "function") return;
  await iterator.return();
}

async function translateUnavailable(operation) {
  try {
    return await operation();
  } catch (error) {
    throw translateRemoteError(error);
  }
}

function translateRemoteError(error) {
  if (error?.status && error?.productSafe === true) return error;
  if (isRecoverableDisconnect(error)) return remoteBackendUnavailable();
  if (error?.status === "cancelled" || error?.status === "permission_denied" || error?.status === "blocked") return error;
  return remoteBackendUnavailable();
}

function isRecoverableDisconnect(error) {
  return error?.recoverable === true || error?.code === "remote_transport_disconnected";
}

function invalidRemoteEvent(code) {
  const error = new Error(code);
  error.name = "RemoteExecutionProtocolError";
  error.code = code;
  error.status = "failed";
  error.productSafe = true;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("execution_cancelled");
}

function safeReason(reason) {
  if (typeof reason === "string") return reason.slice(0, 256);
  if (typeof reason?.code === "string") return reason.code.slice(0, 256);
  return "cancelled";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}
