import {
  AgentKernelError,
  SessionPort,
  normalizeModelVisibleEvent,
  normalizeSessionRef,
} from "../../agent-kernel/src/index.mjs";

/**
 * Product-facing SessionPort adapter.  Its ledger is an injected semantic
 * port, deliberately not a repository or SQL client: production may provide
 * PostgreSQL, while a standalone tool can provide JSONL without giving the
 * Harness any Product persistence knowledge.
 */
export class ProductSessionPort extends SessionPort {
  #session;
  #ledger;

  constructor({ session, ledger } = {}) {
    super();
    this.#session = normalizeSessionRef(session, "product_session_ref_invalid");
    if (!ledger
      || typeof ledger.appendModelVisibleEvent !== "function"
      || typeof ledger.replayModelVisibleEvents !== "function") {
      throw new AgentKernelError("product_session_ledger_invalid");
    }
    if (ledger.checkpointModelVisibleEvents !== undefined
      && typeof ledger.checkpointModelVisibleEvents !== "function") {
      throw new AgentKernelError("product_session_ledger_invalid");
    }
    this.#ledger = ledger;
  }

  async append(event) {
    const normalized = normalizeModelVisibleEvent(event, "product_session_event_invalid");
    this.#assertSameSession(normalized.session);
    const receipt = await this.#ledger.appendModelVisibleEvent({
      session: this.#session,
      event: normalized,
    });
    return immutableValue(receipt, "product_session_append_receipt_invalid");
  }

  async *replay(session, { afterCursor = 0 } = {}) {
    const normalized = normalizeSessionRef(session, "product_session_ref_invalid");
    this.#assertSameSession(normalized);
    assertCursor(afterCursor);
    for await (const item of this.#ledger.replayModelVisibleEvents({
      session: this.#session,
      afterCursor,
    })) {
      const event = normalizeModelVisibleEvent(item?.event ?? item, "product_session_replay_event_invalid");
      this.#assertSameSession(event.session);
      yield event;
    }
  }

  async checkpoint(session) {
    const normalized = normalizeSessionRef(session, "product_session_ref_invalid");
    this.#assertSameSession(normalized);
    if (typeof this.#ledger.checkpointModelVisibleEvents !== "function") {
      throw new AgentKernelError("product_session_checkpoint_unavailable");
    }
    return immutableValue(await this.#ledger.checkpointModelVisibleEvents({ session: this.#session }),
      "product_session_checkpoint_invalid");
  }

  #assertSameSession(value) {
    if (value.sessionId !== this.#session.sessionId || value.branchId !== this.#session.branchId) {
      throw new AgentKernelError("product_session_scope_mismatch");
    }
  }
}

export function createProductSessionPort(options = {}) {
  return new ProductSessionPort(options);
}

function assertCursor(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentKernelError("product_session_cursor_invalid");
  }
}

function immutableValue(value, code) {
  try {
    return deepFreeze(structuredClone(value));
  } catch (error) {
    throw new AgentKernelError(code, code, { cause: error });
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
