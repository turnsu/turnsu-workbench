import {
  AgentKernelError,
  MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
  normalizeModelVisibleEvent,
  normalizeSessionRef,
} from "../../../../packages/agent-kernel/src/index.mjs";
import { createProductSessionPort } from "../../../../packages/product-bridge/src/index.mjs";

const SCHEMA_VERSION = "workbench-v1";
const LEGACY_RUN_ID = "product-legacy-session";

/**
 * Builds the production SessionPort for exactly one accepted Product Agent
 * turn.  The durable store stays the existing Agent Session ledger; this
 * adapter merely translates the Kernel event contract into that ledger's
 * append-only event records and never exposes PostgreSQL to the Harness.
 */
export function createProductAgentSessionPort({ persistence, session, turn, productCommandId = turn?.productCommandId } = {}) {
  const sessionRef = productSessionRef(session);
  assertTarget({ persistence, session, turn, productCommandId });
  return createProductSessionPort({
    session: sessionRef,
    ledger: new ProductAgentSessionLedger({
      persistence,
      session,
      turn,
      productCommandId,
      sessionRef,
    }),
  });
}

class ProductAgentSessionLedger {
  #persistence;
  #session;
  #turn;
  #productCommandId;
  #sessionRef;
  #access;

  constructor({ persistence, session, turn, productCommandId, sessionRef }) {
    this.#persistence = persistence;
    this.#session = structuredClone(session);
    this.#turn = structuredClone(turn);
    this.#productCommandId = productCommandId;
    this.#sessionRef = sessionRef;
    this.#access = Object.freeze({ userId: session.userId, workspaceId: session.workspaceId });
  }

  async appendModelVisibleEvent({ session, event } = {}) {
    assertSameSession(session, this.#sessionRef);
    const modelVisibleEvent = normalizeModelVisibleEvent(event, "product_session_event_invalid");
    assertSameSession(modelVisibleEvent.session, this.#sessionRef);
    const persisted = await this.#persistence.appendModelVisibleEvent({
      sessionId: this.#session.sessionId,
      turnId: this.#turn.turnId,
      productCommandId: this.#productCommandId,
      event: productEventForModelVisible({
        sessionId: this.#session.sessionId,
        turnId: this.#turn.turnId,
        productCommandId: this.#productCommandId,
        modelVisibleEvent,
      }),
    });
    return Object.freeze({ cursor: persisted.sequence, eventId: persisted.eventId });
  }

  async *replayModelVisibleEvents({ session, afterCursor = 0 } = {}) {
    assertSameSession(session, this.#sessionRef);
    if (!Number.isInteger(afterCursor) || afterCursor < 0) {
      throw new AgentKernelError("product_session_cursor_invalid");
    }
    const historical = afterCursor === 0
      ? await this.#legacyMessages()
      : [];
    const persisted = await this.#kernelEvents(afterCursor);
    for (const event of [...historical, ...persisted].sort(compareReplayEvents)) yield event;
  }

  async checkpointModelVisibleEvents({ session } = {}) {
    assertSameSession(session, this.#sessionRef);
    // Public Session views may deliberately omit allocator fields.  Read the
    // existing append-only event ledger instead of reaching around it for a
    // repository-only sequence.
    const latest = await this.#persistence.listEvents(this.#session.sessionId, { limit: 1 }, this.#access);
    if (!Array.isArray(latest)) throw new AgentKernelError("product_session_unavailable");
    return Object.freeze({ cursor: Number(latest[0]?.sequence ?? 0) });
  }

  async #legacyMessages() {
    const messages = await this.#persistence.listMessages(this.#session.sessionId, this.#access);
    return (Array.isArray(messages) ? messages : []).map((message) => normalizeModelVisibleEvent({
      schemaVersion: MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
      eventId: message.messageId,
      runId: LEGACY_RUN_ID,
      session: this.#sessionRef,
      sequence: message.sequence,
      type: "message",
      payload: {
        role: message.role,
        kind: message.kind,
        text: message.content,
      },
      occurredAt: message.createdAt,
    }, "product_session_legacy_message_invalid"));
  }

  async #kernelEvents(afterCursor) {
    const values = [];
    let cursor = null;
    do {
      const page = await this.#persistence.listModelVisibleEvents(this.#session.sessionId, {
        after: afterCursor,
        ...(cursor ? { cursor } : {}),
        limit: 1000,
      }, this.#access);
      if (!Array.isArray(page)) break;
      for (const event of page) {
        const modelVisibleEvent = event?.modelVisibleEvent;
        if (!modelVisibleEvent || typeof modelVisibleEvent !== "object") continue;
        const normalized = normalizeModelVisibleEvent(modelVisibleEvent, "product_session_persisted_event_invalid");
        assertSameSession(normalized.session, this.#sessionRef);
        values.push(normalized);
      }
      cursor = page.page?.nextCursor ?? null;
    } while (cursor);
    return values;
  }
}

function productSessionRef(session) {
  return normalizeSessionRef({
    sessionId: session?.sessionId,
    branchId: session?.scope?.branchId ?? null,
  }, "product_session_ref_invalid");
}

function assertTarget({ persistence, session, turn, productCommandId }) {
  if (typeof persistence?.appendModelVisibleEvent !== "function"
    || typeof persistence?.listMessages !== "function"
    || typeof persistence?.listEvents !== "function"
    || typeof persistence?.listModelVisibleEvents !== "function"
    || typeof persistence?.getSession !== "function"
    || typeof session?.sessionId !== "string" || !session.sessionId
    || typeof session?.userId !== "string" || !session.userId
    || typeof session?.workspaceId !== "string" || !session.workspaceId
    || typeof turn?.turnId !== "string" || !turn.turnId
    || typeof productCommandId !== "string" || !productCommandId) {
    throw new AgentKernelError("product_session_target_invalid");
  }
}

function productEventForModelVisible({ sessionId, turnId, productCommandId, modelVisibleEvent }) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    eventId: modelVisibleEvent.eventId,
    sessionId,
    turnId,
    type: `kernel.${modelVisibleEvent.type}`,
    status: statusFor(modelVisibleEvent.type),
    summary: `Agent Kernel ${modelVisibleEvent.type}`,
    occurredAt: modelVisibleEvent.occurredAt,
    productCommandId,
    modelVisibleEvent,
  });
}

function statusFor(type) {
  if (type.includes("cancel")) return "cancelled";
  if (type.includes("failed")) return "failed";
  if (type.includes("denied") || type.includes("pending") || type.includes("uncertain")) return "blocked";
  return "completed";
}

function assertSameSession(value, expected) {
  const actual = normalizeSessionRef(value, "product_session_ref_invalid");
  if (actual.sessionId !== expected.sessionId || actual.branchId !== expected.branchId) {
    throw new AgentKernelError("product_session_scope_mismatch");
  }
}

function compareReplayEvents(left, right) {
  const timestamp = left.occurredAt.localeCompare(right.occurredAt);
  if (timestamp !== 0) return timestamp;
  return left.eventId.localeCompare(right.eventId);
}
