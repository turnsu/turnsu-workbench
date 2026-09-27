import { AgentKernelError, assertIdentifier, freeze } from "./contracts.mjs";

/**
 * Small hierarchical service context.  It has no product-domain vocabulary:
 * scope names are opaque labels supplied by a bridge or a profile.
 */
export class MinimalKernelContext {
  #parent;
  #scope;
  #metadata;
  #services = new Map();
  #listeners = new Map();
  #effects = [];
  #children = new Set();
  #disposed = false;

  constructor({ parent = null, scope = "root", metadata = {} } = {}) {
    if (parent !== null && !(parent instanceof MinimalKernelContext)) {
      throw new AgentKernelError("kernel_context_parent_invalid");
    }
    this.#parent = parent;
    this.#scope = assertIdentifier(scope, "kernel_context_scope_invalid");
    this.#metadata = freeze(structuredClone(metadata));
    parent?.#children.add(this);
  }

  get parent() { return this.#parent; }
  get scope() { return this.#scope; }
  get metadata() { return this.#metadata; }
  get disposed() { return this.#disposed; }

  child({ scope, metadata = {} } = {}) {
    this.#assertActive();
    return new MinimalKernelContext({ parent: this, scope, metadata });
  }

  provide(token, value, { pinned = false, replace = false } = {}) {
    this.#assertActive();
    const normalizedToken = assertIdentifier(token, "kernel_service_token_invalid");
    if (typeof pinned !== "boolean" || typeof replace !== "boolean") {
      throw new AgentKernelError("kernel_service_options_invalid");
    }
    const local = this.#services.get(normalizedToken) ?? null;
    const inherited = local ? null : this.#findInParent(normalizedToken);
    if (local?.pinned) throw new AgentKernelError("kernel_service_pinned");
    if (local && !replace) throw new AgentKernelError("kernel_service_already_provided");
    if (inherited?.pinned) throw new AgentKernelError("kernel_service_pinned");
    if (inherited && !replace) throw new AgentKernelError("kernel_service_override_forbidden");
    const record = { value, pinned };
    this.#services.set(normalizedToken, record);
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      if (this.#services.get(normalizedToken) !== record) return;
      if (local) this.#services.set(normalizedToken, local);
      else this.#services.delete(normalizedToken);
    };
  }

  use(token, { optional = false } = {}) {
    this.#assertActive();
    const normalizedToken = assertIdentifier(token, "kernel_service_token_invalid");
    const record = this.#services.get(normalizedToken) ?? this.#findInParent(normalizedToken);
    if (!record) {
      if (optional) return undefined;
      throw new AgentKernelError("kernel_service_missing");
    }
    return record.value;
  }

  has(token) {
    this.#assertActive();
    const normalizedToken = assertIdentifier(token, "kernel_service_token_invalid");
    return Boolean(this.#services.get(normalizedToken) ?? this.#findInParent(normalizedToken));
  }

  on(type, listener) {
    this.#assertActive();
    const normalizedType = assertIdentifier(type, "kernel_listener_type_invalid");
    if (typeof listener !== "function") throw new AgentKernelError("kernel_listener_invalid");
    const listeners = this.#listeners.get(normalizedType) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(normalizedType, listeners);
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(normalizedType);
    };
  }

  async emit(event) {
    this.#assertActive();
    const type = assertIdentifier(event?.type, "kernel_event_invalid");
    const lineage = [];
    for (let cursor = this; cursor; cursor = cursor.#parent) lineage.push(cursor);
    for (const context of lineage.reverse()) {
      const listenerTypes = type === "kernel.event" ? [type] : [type, "kernel.event"];
      for (const listenerType of listenerTypes) {
        const listeners = [...(context.#listeners.get(listenerType) ?? [])];
        for (const listener of listeners) await listener(event);
      }
    }
  }

  effect(resource) {
    this.#assertActive();
    const dispose = toDispose(resource);
    const entry = { dispose, disposed: false };
    this.#effects.push(entry);
    return async () => this.#disposeEffect(entry);
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors = [];
    for (const child of [...this.#children]) {
      try { await child.dispose(); } catch (error) { errors.push(error); }
    }
    this.#children.clear();
    for (const entry of [...this.#effects].reverse()) {
      try { await this.#disposeEffect(entry); } catch (error) { errors.push(error); }
    }
    this.#effects.length = 0;
    this.#listeners.clear();
    this.#services.clear();
    this.#parent?.#children.delete(this);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "kernel_context_dispose_failed");
  }

  #findInParent(token) {
    for (let cursor = this.#parent; cursor; cursor = cursor.#parent) {
      const record = cursor.#services.get(token);
      if (record) return record;
    }
    return null;
  }

  async #disposeEffect(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    await entry.dispose();
  }

  #assertActive() {
    if (this.#disposed) throw new AgentKernelError("kernel_context_disposed");
  }
}

function toDispose(resource) {
  if (typeof resource === "function") return resource;
  if (resource && typeof resource.dispose === "function") return () => resource.dispose();
  throw new AgentKernelError("kernel_effect_invalid");
}
