export const REMOTE_WORKER_TRANSPORT_METHODS = Object.freeze([
  "probe",
  "dispatch",
  "streamEvents",
  "checkpoint",
  "cancel",
  "resume",
  "dispose",
]);

export class RemoteWorkerTransportError extends Error {
  constructor(code, message = code, { status = "remote_backend_unavailable", recoverable = false } = {}) {
    super(message);
    this.name = "RemoteWorkerTransportError";
    this.code = code;
    this.status = status;
    this.recoverable = recoverable;
    this.productSafe = true;
  }
}

export class RemoteWorkerTransport {
  async probe() { throw notImplemented(); }

  async dispatch() { throw notImplemented(); }

  streamEvents() { throw notImplemented(); }

  async checkpoint() { throw notImplemented(); }

  async cancel() { throw notImplemented(); }

  async resume() { throw notImplemented(); }

  async dispose() { throw notImplemented(); }
}

export function assertRemoteWorkerTransport(transport) {
  if (!transport || REMOTE_WORKER_TRANSPORT_METHODS.some((method) => (
    typeof transport[method] !== "function"
    || transport[method] === RemoteWorkerTransport.prototype[method]
  ))) {
    throw new TypeError("remote_worker_transport_invalid");
  }
  return transport;
}

export function remoteTransportDisconnected(message = "The remote Worker connection was interrupted.") {
  return new RemoteWorkerTransportError("remote_transport_disconnected", message, { recoverable: true });
}

export function remoteBackendUnavailable(message = "The remote backend is unavailable.") {
  return new RemoteWorkerTransportError("remote_backend_unavailable", message);
}

function notImplemented() {
  return new RemoteWorkerTransportError("remote_worker_transport_not_implemented");
}
