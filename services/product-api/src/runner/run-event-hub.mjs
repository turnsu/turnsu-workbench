export class RunEventHub {
  #listeners = new Map();

  subscribe(runId, listener) {
    if (typeof listener !== "function") throw new TypeError("run_event_listener_required");
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(runId);
    };
  }

  publish(event) {
    for (const listener of this.#listeners.get(event.runId) ?? []) {
      try {
        listener(structuredClone(event));
      } catch {
        // Delivery is best effort; the durable event log remains the source of truth.
      }
    }
  }
}
