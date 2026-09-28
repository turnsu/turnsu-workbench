import {
  assertRemoteWorkerTransport,
  remoteBackendUnavailable,
  remoteTransportDisconnected,
} from "./remote-worker-transport.mjs";

export const REMOTE_EXECUTION_MODES = Object.freeze([
  "deterministic_skill",
  "model_call",
  "bounded_agent",
  "agent_orchestrator",
]);

const MAX_REORDER_WINDOW = 256;
const MAX_REMOTE_EVENTS = 10_000;
const MAX_REMOTE_EVENT_BYTES = 1_000_000;
const REMOTE_EVENT_TYPES = new Set([
  "worker.started",
  "worker.progress",
  "worker.checkpoint",
  "worker.artifact",
  "worker.blocked",
  "worker.completed",
  "worker.failed",
  "worker.cancelled",
  "execution.result",
]);
const REMOTE_EVENT_STATUSES = new Set([
  "running", "completed", "failed", "cancelled", "blocked", "partial", "timeout",
  "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
]);
const REMOTE_RESULT_STATUSES = new Set([
  "completed", "failed", "cancelled", "blocked", "partial", "timeout",
  "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
]);
const CHECKPOINT_PHASES = new Set([
  "started", "running", "checkpointing", "recovering", "completed", "failed", "cancelled", "blocked",
]);
const ARTIFACT_REFERENCE_PATTERN = /^artifact:sha256:[a-f0-9]{16,64}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
      if (!Array.isArray(probe.supportedModes) || !probe.supportedModes.includes(request.mode)) {
        throw remoteBackendUnavailable(`The remote backend does not advertise ${request.mode} support.`);
      }

      const dispatched = await translateUnavailable(() => transport.dispatch({
        request: remoteRequestEnvelope(request),
        lease: remoteLeaseEnvelope(lease),
        // Device selection is Product-control-plane data, not Worker input.
        // A remote transport may use it to select an already-authorized
        // endpoint, but the endpoint receives only remoteRequestEnvelope().
        dispatchContext: remoteDispatchContext(request),
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
                    payload: ordered.payload,
                  });
                  if (ordered.checkpoint !== undefined) {
                    await checkpoint({
                      phase: "remote_running",
                      remoteSequence: ordered.sequence,
                      transportState: ordered.checkpoint,
                    });
                  }
                  nextSequence += 1;
                  if (ordered.type === "execution.result") {
                    return validateRemoteResult(ordered.result, request);
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
              transportState: sanitizeRemoteCheckpoint(transportCheckpoint ?? {}),
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
    "externalChildRef", "modelProfileRevisionId", "capability",
    "fallbackModelProfileRevisionIds",
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
    ...(request.mode === "model_call" ? {
      modelProfileRevisionId: request.modelProfileRevisionId,
      modelCapability: request.modelCapability,
      fallbackModelProfileRevisionIds: structuredClone(request.fallbackModelProfileRevisionIds ?? []),
    } : {}),
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

function remoteDispatchContext(request) {
  return {
    workspaceId: request.workspaceId,
    ownerUserId: typeof request.actor?.userId === "string" ? request.actor.userId : null,
    capacityLeaseId: typeof request.capacityAuthority?.capacityLeaseId === "string"
      ? request.capacityAuthority.capacityLeaseId
      : null,
    capacityFence: Number.isInteger(request.capacityAuthority?.fence)
      ? request.capacityAuthority.fence
      : null,
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
    || !REMOTE_EVENT_TYPES.has(event.type)
    || (event.status !== undefined && !REMOTE_EVENT_STATUSES.has(event.status))
    || !isJsonValue(event.payload ?? {})
    || (event.checkpoint !== undefined && !isJsonValue(event.checkpoint))
    || (event.type === "execution.result" && !isPlainObject(event.result))
    || (event.type !== "execution.result" && event.result !== undefined)
    || byteLength(event) > MAX_REMOTE_EVENT_BYTES) {
    throw invalidRemoteEvent("remote_event_invalid");
  }
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    ...(event.status !== undefined ? { status: event.status } : {}),
    payload: sanitizeRemoteEventPayload(event.type, event.payload ?? {}),
    ...(event.checkpoint !== undefined
      ? { checkpoint: sanitizeRemoteCheckpoint(event.checkpoint) }
      : {}),
    ...(event.type === "execution.result" ? { result: structuredClone(event.result) } : {}),
  };
}

function validateRemoteResult(result, request) {
  if (!isPlainObject(result)
    || (result.status !== undefined && !REMOTE_RESULT_STATUSES.has(result.status))
    || (result.output !== undefined && !isJsonValue(result.output))
    || (result.evidence !== undefined && (!Array.isArray(result.evidence) || !result.evidence.every(isPlainObject)))
    || (result.usage !== undefined && !isPlainObject(result.usage))) {
    throw invalidRemoteEvent("remote_result_invalid");
  }
  const status = result.status ?? "completed";
  return {
    ...(result.status !== undefined ? { status } : {}),
    ...(Object.hasOwn(result, "output")
      ? { output: projectResultBySchema(result.output, request.resultSchema) }
      : {}),
    summary: resultSummary(status),
    evidence: sanitizeRemoteEvidence(result.evidence ?? [], request.evidenceRequirements ?? []),
    usage: sanitizeRemoteUsage(result.usage ?? {}),
  };
}

function sanitizeRemoteEventPayload(type, payload) {
  if (!isPlainObject(payload)) throw invalidRemoteEvent("remote_event_payload_invalid");
  switch (type) {
    case "worker.progress":
      return compactObject({
        percent: boundedInteger(payload.percent, 0, 100),
        currentStep: boundedInteger(payload.currentStep, 0, 10_000),
        totalSteps: boundedInteger(payload.totalSteps, 0, 10_000),
      });
    case "worker.checkpoint":
      return sanitizeRemoteCheckpoint(payload);
    case "worker.artifact":
      return isProductArtifactReference(payload.ref) ? { ref: payload.ref } : {};
    default:
      return {};
  }
}

function sanitizeRemoteCheckpoint(value) {
  if (!isPlainObject(value)) throw invalidRemoteEvent("remote_checkpoint_invalid");
  return compactObject({
    phase: CHECKPOINT_PHASES.has(value.phase) ? value.phase : undefined,
    cursor: boundedInteger(value.cursor, 0, Number.MAX_SAFE_INTEGER),
    percent: boundedInteger(value.percent, 0, 100),
    currentStep: boundedInteger(value.currentStep, 0, 10_000),
    totalSteps: boundedInteger(value.totalSteps, 0, 10_000),
  });
}

function sanitizeRemoteEvidence(evidence, requirements) {
  const byId = new Map(requirements.map((item) => [item.requirementId, item]));
  const sanitized = [];
  for (const item of evidence.slice(0, 256)) {
    const requirement = typeof item.requirementId === "string" ? byId.get(item.requirementId) : undefined;
    if (!requirement || item.kind !== requirement.kind) continue;
    const entry = { requirementId: requirement.requirementId, kind: requirement.kind };
    if (requirement.kind === "artifact") {
      if (!isProductArtifactReference(item.ref)) continue;
      entry.ref = item.ref;
    }
    sanitized.push(entry);
  }
  return sanitized;
}

function sanitizeRemoteUsage(usage) {
  return compactObject({
    steps: boundedInteger(usage.steps, 0, Number.MAX_SAFE_INTEGER),
    modelRequests: boundedInteger(usage.modelRequests, 0, Number.MAX_SAFE_INTEGER),
    inputBytes: boundedInteger(usage.inputBytes, 0, Number.MAX_SAFE_INTEGER),
    outputBytes: boundedInteger(usage.outputBytes, 0, Number.MAX_SAFE_INTEGER),
  });
}

function projectResultBySchema(value, schema) {
  if (!isPlainObject(schema)) throw invalidRemoteEvent("remote_result_schema_invalid");
  if (Array.isArray(schema.enum)) {
    const match = schema.enum.find((item) => JSON.stringify(item) === JSON.stringify(value));
    return match === undefined ? null : structuredClone(match);
  }
  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) return {};
      const properties = isPlainObject(schema.properties) ? schema.properties : {};
      return Object.fromEntries(Object.entries(properties)
        .filter(([key]) => Object.hasOwn(value, key))
        .map(([key, childSchema]) => [key, projectResultBySchema(value[key], childSchema)]));
    }
    case "array":
      if (!Array.isArray(value) || !isPlainObject(schema.items)) return [];
      return value.slice(0, 10_000).map((item) => projectResultBySchema(item, schema.items));
    case "string":
      return typeof value === "string" ? value : "";
    case "integer":
      return Number.isSafeInteger(value) ? value : 0;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    case "boolean":
      return typeof value === "boolean" ? value : false;
    case "null":
      return null;
    default:
      throw invalidRemoteEvent("remote_result_schema_unsupported");
  }
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isProductArtifactReference(value) {
  return typeof value === "string" && ARTIFACT_REFERENCE_PATTERN.test(value);
}

function resultSummary(status) {
  return {
    completed: "Remote execution completed.",
    partial: "Remote execution completed with a partial result.",
    cancelled: "Remote execution was cancelled.",
    blocked: "Remote execution was blocked.",
    timeout: "Remote execution timed out.",
    permission_denied: "Remote execution was denied.",
    sandbox_unavailable: "Remote execution sandbox was unavailable.",
    remote_backend_unavailable: "Remote execution backend was unavailable.",
  }[status] ?? "Remote execution failed.";
}

function validateRemoteExecutionId(value) {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
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
