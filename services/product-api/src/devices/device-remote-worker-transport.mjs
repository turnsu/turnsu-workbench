import { RemoteWorkerTransport } from "../execution/remote-worker-transport.mjs";

/**
 * Existing Broker transport adapter for an outbound, registered Desktop.
 * The registry is intentionally the only route to a Device socket; callers
 * cannot address a Device ID or post a generic Worker command through HTTP.
 */
export class DeviceRemoteWorkerTransport extends RemoteWorkerTransport {
  #registry;

  constructor({ registry } = {}) {
    super();
    if (!registry
      || ["probe", "dispatch", "streamEvents", "checkpoint", "cancel", "resume", "dispose"].some((method) => (
        typeof registry[method] !== "function"
      ))) {
      throw new TypeError("device_worker_registry_required");
    }
    this.#registry = registry;
  }

  async probe(input = {}) { return this.#registry.probe(input); }

  async dispatch(input = {}) { return this.#registry.dispatch(input); }

  streamEvents(input = {}) { return this.#registry.streamEvents(input); }

  async checkpoint(input = {}) { return this.#registry.checkpoint(input); }

  async cancel(input = {}) { return this.#registry.cancel(input); }

  async resume(input = {}) { return this.#registry.resume(input); }

  async dispose(input = {}) { return this.#registry.dispose(input); }
}
