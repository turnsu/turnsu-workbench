import {
  AgentKernelError,
  MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
  SessionPort,
  cloneValue,
  freeze,
  normalizeSessionRef,
} from "../../agent-kernel/src/contracts.mjs";

/** Test-only SessionPort provider. It is deliberately in-memory and has no
 * Product/SQL semantics, so it cannot be mistaken for a production authority. */
export class MemorySessionPort extends SessionPort {
  #events = new Map();

  async append(event) {
    if (!event || event.schemaVersion !== MODEL_VISIBLE_EVENT_SCHEMA_VERSION) {
      throw new AgentKernelError("memory_session_event_invalid");
    }
    const session = normalizeSessionRef(event.session, "memory_session_event_invalid");
    const key = sessionKey(session);
    const events = this.#events.get(key) ?? [];
    const copied = freeze(cloneValue(event, "memory_session_event_invalid"));
    events.push(copied);
    this.#events.set(key, events);
    return freeze({ cursor: events.length });
  }

  async *replay(session, { afterCursor = 0 } = {}) {
    const normalized = normalizeSessionRef(session, "memory_session_ref_invalid");
    if (!Number.isInteger(afterCursor) || afterCursor < 0) {
      throw new AgentKernelError("memory_session_cursor_invalid");
    }
    for (const event of (this.#events.get(sessionKey(normalized)) ?? []).slice(afterCursor)) {
      yield freeze(cloneValue(event, "memory_session_event_invalid"));
    }
  }

  async checkpoint(session) {
    const normalized = normalizeSessionRef(session, "memory_session_ref_invalid");
    return freeze({ cursor: (this.#events.get(sessionKey(normalized)) ?? []).length });
  }

  read(session) {
    const normalized = normalizeSessionRef(session, "memory_session_ref_invalid");
    return freeze((this.#events.get(sessionKey(normalized)) ?? []).map((event) => (
      freeze(cloneValue(event, "memory_session_event_invalid"))
    )));
  }
}

function sessionKey(session) {
  return `${session.sessionId}\u0000${session.branchId ?? ""}`;
}
