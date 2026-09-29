import {
  remoteBackendUnavailable,
  remoteTransportDisconnected,
} from "../execution/remote-worker-transport.mjs";

export const DEVICE_WORKER_PROTOCOL_VERSION = "workbench-device-worker-v1";
export const DEVICE_LOCAL_DETERMINISTIC_CAPABILITY = "local_deterministic_skill";

const MAX_MESSAGE_BYTES = 1_000_000;
const MAX_ACTIVE_EXECUTIONS_PER_DEVICE = 1;
const REMOTE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Ephemeral connection registry for outbound Desktop workers.
 *
 * A connection is accepted only after the Product server has authenticated a
 * native bearer session and resolved its registered Device.  This registry
 * intentionally owns no Product truth: durable Device identity, native token
 * revocation, capability leases, and execution events stay in PostgreSQL and
 * the existing Execution Broker.  It merely binds a live outbound socket to a
 * verified Device and translates the seven-method RemoteWorkerTransport
 * boundary into a narrow message protocol.
 */
export class DeviceWorkerConnectionRegistry {
  #connections = new Map();
  #executions = new Map();
  #sequence = 0;
  #clock;
  #idFactory;
  #leaseStore;

  constructor({
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${++this.#sequence}`,
    leaseStore = null,
  } = {}) {
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("device_worker_registry_dependencies_invalid");
    }
    if (leaseStore !== null && ["issue", "assertActive"].some((method) => typeof leaseStore[method] !== "function")) {
      throw new TypeError("device_worker_registry_lease_store_invalid");
    }
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#leaseStore = leaseStore;
  }

  accept({ binding, send, terminate } = {}) {
    const normalized = normalizeBinding(binding);
    if (typeof send !== "function" || typeof terminate !== "function") {
      throw new TypeError("device_worker_connection_callbacks_invalid");
    }
    const previous = this.#connections.get(normalized.deviceId);
    if (previous) this.#closeConnection(previous, "device_reconnected");
    const connection = {
      binding: normalized,
      send,
      terminate,
      ready: false,
      closed: false,
      connectionId: stableId(this.#idFactory("device-connection"), "device_connection_id_invalid"),
      connectedAt: iso(this.#clock()),
      activeExecutionIds: new Set(),
    };
    this.#connections.set(normalized.deviceId, connection);
    this.#send(connection, {
      type: "device.connected",
      protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
      deviceId: normalized.deviceId,
      connectionId: connection.connectionId,
    });
    return Object.freeze({
      receive: (raw) => this.#receive(connection, raw),
      close: (reason = "device_transport_disconnected") => this.#closeConnection(connection, reason),
      get connectionId() { return connection.connectionId; },
    });
  }

  async probe() {
    return {
      available: [...this.#connections.values()].some((connection) => connection.ready && !connection.closed),
      supportedModes: ["deterministic_skill"],
    };
  }

  async dispatch({ request, lease, dispatchContext } = {}) {
    assertDeviceDeterministicRequest(request, lease, dispatchContext);
    const connection = this.#selectConnection({ request, dispatchContext });
    if (!connection) {
      throw remoteBackendUnavailable("No ready Desktop Device is available for this Product principal.");
    }
    const remoteExecutionId = stableId(this.#idFactory("device-remote-execution"), "device_remote_execution_id_invalid");
    const deviceLease = this.#leaseStore
      ? await this.#leaseStore.issue({
        binding: connection.binding,
        request,
        lease,
        connectionId: connection.connectionId,
        dispatchContext,
      })
      : localDeviceLease({ connection, request, lease, remoteExecutionId });
    const execution = {
      remoteExecutionId,
      deviceId: connection.binding.deviceId,
      connection,
      deviceLease,
      queue: new AsyncEventQueue(),
      lastCheckpoint: { cursor: 0 },
      closed: false,
      request: structuredClone(request),
      lease: structuredClone(lease),
      dispatchContext: structuredClone(dispatchContext),
    };
    this.#executions.set(remoteExecutionId, execution);
    connection.activeExecutionIds.add(remoteExecutionId);
    try {
      // `dispatchContext` never crosses the Device boundary. It includes the
      // effective user only to select that user's registered Desktop.
      this.#send(connection, {
        type: "device.dispatch",
        protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
        remoteExecutionId,
        request: workerRequestEnvelope(request),
        lease: structuredClone(lease),
        dispatch: {
          deviceId: connection.binding.deviceId,
          fence: lease.fence,
          expiresAt: lease.expiresAt,
          deviceExecutionLeaseId: deviceLease.deviceExecutionLeaseId,
          connectionFence: deviceLease.connectionFence,
        },
      });
    } catch (error) {
      this.#finishExecution(execution, error);
      throw error;
    }
    return { remoteExecutionId, deviceId: connection.binding.deviceId };
  }

  streamEvents({ remoteExecutionId, afterSequence = 0, signal } = {}) {
    const execution = this.#execution(remoteExecutionId);
    return execution.queue.iterate({ afterSequence, signal });
  }

  async checkpoint({ remoteExecutionId, afterSequence = 0 } = {}) {
    const execution = this.#execution(remoteExecutionId);
    return {
      ...structuredClone(execution.lastCheckpoint),
      cursor: Math.max(Number(execution.lastCheckpoint.cursor ?? 0), afterSequence),
      deviceId: execution.deviceId,
    };
  }

  async resume({ remoteExecutionId, afterSequence = 0, checkpoint = {} } = {}) {
    const execution = this.#execution(remoteExecutionId);
    if (execution.connection.closed || !execution.connection.ready) {
      throw remoteTransportDisconnected("The selected Desktop Device is no longer connected.");
    }
    this.#send(execution.connection, {
      type: "device.resume",
      protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
      remoteExecutionId,
      afterSequence,
      checkpoint: jsonClone(checkpoint, "device_checkpoint_invalid"),
    });
    return { remoteExecutionId };
  }

  async cancel({ remoteExecutionId, reason = "cancelled" } = {}) {
    const execution = this.#executions.get(remoteExecutionId);
    if (!execution || execution.closed) return { cancelled: false };
    if (!execution.connection.closed) {
      this.#send(execution.connection, {
        type: "device.cancel",
        protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
        remoteExecutionId,
        reason: safeReason(reason),
      });
    }
    return { cancelled: true };
  }

  async dispose({ remoteExecutionId } = {}) {
    const execution = this.#executions.get(remoteExecutionId);
    if (!execution) return { disposed: false };
    if (!execution.connection.closed) {
      this.#send(execution.connection, {
        type: "device.dispose",
        protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
        remoteExecutionId,
      });
    }
    this.#finishExecution(execution);
    return { disposed: true };
  }

  disconnectDevice(deviceId, { reason = "device_revoked" } = {}) {
    const connection = this.#connections.get(deviceId);
    if (!connection) return false;
    this.#closeConnection(connection, reason);
    return true;
  }

  close() {
    for (const connection of [...this.#connections.values()]) {
      this.#closeConnection(connection, "server_shutdown");
    }
  }

  async #receive(connection, raw) {
    if (connection.closed) return;
    let message;
    try {
      message = parseMessage(raw);
      if (!connection.ready) {
        if (message.type !== "device.ready") throw protocolError("device_ready_required");
        if (message.protocolVersion !== DEVICE_WORKER_PROTOCOL_VERSION
          || !Array.isArray(message.supportedModes)
          || message.supportedModes.length !== 1
          || message.supportedModes[0] !== "deterministic_skill"
          || !connection.binding.capabilityInventory.includes(DEVICE_LOCAL_DETERMINISTIC_CAPABILITY)) {
          throw protocolError("device_protocol_incompatible");
        }
        connection.ready = true;
        this.#send(connection, {
          type: "device.ready_ack",
          protocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
          deviceId: connection.binding.deviceId,
          connectionId: connection.connectionId,
        });
        return;
      }
      if (message.type !== "device.event") throw protocolError("device_message_unrecognized");
      await this.#receiveEvent(connection, message);
    } catch (error) {
      this.#send(connection, {
        type: "device.protocol_error",
        code: safeProtocolCode(error),
      });
      this.#closeConnection(connection, safeProtocolCode(error));
    }
  }

  async #receiveEvent(connection, message) {
    const remoteExecutionId = stableId(message.remoteExecutionId, "device_remote_execution_id_invalid");
    const execution = this.#executions.get(remoteExecutionId);
    if (!execution || execution.closed || execution.connection !== connection
      || execution.deviceId !== connection.binding.deviceId) {
      throw protocolError("device_execution_fenced");
    }
    if (this.#leaseStore) {
      await this.#leaseStore.assertActive({
        deviceExecutionLeaseId: execution.deviceLease.deviceExecutionLeaseId,
        binding: connection.binding,
        request: execution.request,
        lease: execution.lease,
        connectionId: connection.connectionId,
        dispatchContext: execution.dispatchContext,
      });
    }
    const event = jsonClone(message.event, "device_event_invalid");
    if (!event || typeof event !== "object" || Array.isArray(event)) throw protocolError("device_event_invalid");
    if (Number.isInteger(event.sequence) && event.sequence >= 0) {
      execution.lastCheckpoint = event.checkpoint === undefined
        ? { cursor: event.sequence }
        : { cursor: event.sequence, transportState: jsonClone(event.checkpoint, "device_checkpoint_invalid") };
    }
    execution.queue.push(event);
  }

  #selectConnection({ request, dispatchContext }) {
    const ownerUserId = dispatchContext?.ownerUserId;
    if (typeof ownerUserId !== "string" || !ownerUserId) return null;
    return [...this.#connections.values()]
      .filter((connection) => (
        !connection.closed
        && connection.ready
        && connection.binding.workspaceId === request.workspaceId
        && connection.binding.ownerUserId === ownerUserId
        && connection.binding.capabilityInventory.includes(DEVICE_LOCAL_DETERMINISTIC_CAPABILITY)
        && connection.activeExecutionIds.size < MAX_ACTIVE_EXECUTIONS_PER_DEVICE
      ))
      .sort((left, right) => left.connectedAt.localeCompare(right.connectedAt)
        || left.binding.deviceId.localeCompare(right.binding.deviceId))[0] ?? null;
  }

  #execution(remoteExecutionId) {
    const execution = this.#executions.get(remoteExecutionId);
    if (!execution || execution.closed) throw remoteBackendUnavailable("The Device execution is unavailable.");
    return execution;
  }

  #finishExecution(execution, error = null) {
    if (execution.closed) return;
    execution.closed = true;
    this.#executions.delete(execution.remoteExecutionId);
    execution.connection.activeExecutionIds.delete(execution.remoteExecutionId);
    if (error) execution.queue.fail(error);
    else execution.queue.end();
  }

  #closeConnection(connection, reason) {
    if (connection.closed) return;
    connection.closed = true;
    if (this.#connections.get(connection.binding.deviceId) === connection) {
      this.#connections.delete(connection.binding.deviceId);
    }
    for (const remoteExecutionId of [...connection.activeExecutionIds]) {
      const execution = this.#executions.get(remoteExecutionId);
      if (execution) this.#finishExecution(execution, remoteTransportDisconnected(
        reason === "device_revoked"
          ? "The selected Desktop Device was revoked."
          : "The selected Desktop Device disconnected.",
      ));
    }
    try { connection.terminate(reason); } catch {}
  }

  #send(connection, value) {
    if (connection.closed) throw remoteTransportDisconnected("The selected Desktop Device disconnected.");
    connection.send(jsonClone(value, "device_message_invalid"));
  }
}

function assertDeviceDeterministicRequest(request, lease, dispatchContext) {
  if (!request || request.isolation !== "remote" || request.mode !== "deterministic_skill"
    || request.metadata?.executionRef?.capabilityId !== DEVICE_LOCAL_DETERMINISTIC_CAPABILITY
    || request.capabilities?.network !== false
    || request.capabilities?.externalActions !== false
    || request.capabilities?.filesystem !== "none"
    || !Array.isArray(request.capabilities?.connectionIds)
    || request.capabilities.connectionIds.length !== 0
    || request.limits?.maxModelRequests !== 0
    || request.limits?.maxChildren !== 0
    || !lease
    || lease.workspaceId !== request.workspaceId
    || lease.status !== "active"
    || !Number.isInteger(lease.fence)
    || typeof dispatchContext?.ownerUserId !== "string"
    || !dispatchContext.ownerUserId) {
    throw remoteBackendUnavailable("The request is not eligible for the restricted Desktop capability.");
  }
}

function workerRequestEnvelope(request) {
  const cloned = structuredClone(request);
  // Selection data stays server-side even if a future generic transport puts
  // it onto the input envelope by accident.
  delete cloned.actor;
  delete cloned.dispatchContext;
  return cloned;
}

function localDeviceLease({ connection, request, lease, remoteExecutionId }) {
  return Object.freeze({
    deviceExecutionLeaseId: `device-lease:${remoteExecutionId}`,
    workspaceId: request.workspaceId,
    deviceId: connection.binding.deviceId,
    nativeClientSessionId: connection.binding.clientSessionId,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    capabilityLeaseId: lease.capabilityLeaseId,
    capacityLeaseId: "test-capacity-lease",
    fence: lease.fence,
    connectionId: connection.connectionId,
    connectionFence: 1,
    status: "active",
    issuedAt: connection.connectedAt,
    expiresAt: lease.expiresAt,
    revokedAt: null,
    updatedAt: connection.connectedAt,
  });
}

function normalizeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("device_worker_binding_invalid");
  }
  const capabilityInventory = value.capabilityInventory;
  if (!Array.isArray(capabilityInventory)
    || capabilityInventory.some((item) => typeof item !== "string")
    || !capabilityInventory.includes(DEVICE_LOCAL_DETERMINISTIC_CAPABILITY)) {
    throw new TypeError("device_worker_binding_capabilities_invalid");
  }
  return Object.freeze({
    deviceId: stableId(value.deviceId, "device_worker_binding_invalid"),
    workspaceId: stableId(value.workspaceId, "device_worker_binding_invalid"),
    ownerUserId: stableId(value.ownerUserId, "device_worker_binding_invalid"),
    clientSessionId: stableId(value.clientSessionId, "device_worker_binding_invalid"),
    capabilityInventory: Object.freeze([...new Set(capabilityInventory)].sort()),
    workerProtocolVersion: text(value.workerProtocolVersion, "device_worker_binding_invalid"),
  });
}

function parseMessage(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (Buffer.byteLength(source, "utf8") > MAX_MESSAGE_BYTES) throw protocolError("device_message_too_large");
  let value;
  try { value = JSON.parse(source); } catch { throw protocolError("device_message_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    throw protocolError("device_message_invalid");
  }
  return value;
}

function jsonClone(value, code) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) throw new Error(code);
    return JSON.parse(encoded);
  } catch {
    throw protocolError(code);
  }
}

class AsyncEventQueue {
  #entries = [];
  #waiters = [];
  #closed = false;
  #error = null;

  push(value) {
    if (this.#closed) return;
    this.#entries.push(structuredClone(value));
    this.#flush();
  }

  end() {
    if (this.#closed) return;
    this.#closed = true;
    this.#flush();
  }

  fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#flush();
  }

  async *iterate({ afterSequence = 0, signal } = {}) {
    let index = 0;
    while (true) {
      const entry = await this.#next(index, signal);
      if (entry.done) return;
      index = entry.index + 1;
      const event = entry.value;
      if (!Number.isInteger(event?.sequence) || event.sequence > afterSequence) yield structuredClone(event);
    }
  }

  #next(index, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("device_execution_cancelled"));
    if (index < this.#entries.length) return Promise.resolve({ value: this.#entries[index], index, done: false });
    if (this.#closed) {
      if (this.#error) return Promise.reject(this.#error);
      return Promise.resolve({ done: true });
    }
    return new Promise((resolve, reject) => {
      const waiter = { index, resolve, reject, signal, abort: null };
      if (signal) {
        waiter.abort = () => {
          this.#waiters = this.#waiters.filter((item) => item !== waiter);
          reject(signal.reason ?? new Error("device_execution_cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #flush() {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.index < this.#entries.length) {
        waiter.resolve({ value: this.#entries[waiter.index], index: waiter.index, done: false });
      } else if (this.#error) {
        waiter.reject(this.#error);
      } else if (this.#closed) {
        waiter.resolve({ done: true });
      } else {
        this.#waiters.push(waiter);
      }
    }
  }
}

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeProtocolCode(error) {
  const candidate = String(error?.code ?? "device_message_invalid");
  return /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : "device_message_invalid";
}

function safeReason(value) {
  return typeof value === "string" ? value.slice(0, 256) : "cancelled";
}

function stableId(value, code) {
  if (typeof value !== "string" || !REMOTE_EXECUTION_ID.test(value)) throw protocolError(code);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw protocolError(code);
  return value;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("device_worker_registry_clock_invalid");
  return date.toISOString();
}
