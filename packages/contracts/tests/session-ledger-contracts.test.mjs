import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  checkSessionEventSemantics,
  SessionDomainEnvelopeSchema,
  WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS,
} from "../dist/index.js";

const HASH = `sha256:${"a".repeat(64)}`;

test("Session-domain SSE is a strict replay envelope and not a generic event endpoint", () => {
  const endpoint = WORKBENCH_V1_SESSION_LEDGER_ENDPOINTS.getSessionDomainEvents;
  assert.equal(endpoint.path, "/api/workbench/v1/session-domain/events");
  assert.equal(endpoint.responseMediaType, "text/event-stream");
  assert.deepEqual(endpoint.optionalRequestHeaders, ["Last-Event-ID"]);
  assert.equal(Check(endpoint.querySchema, { after: 0, limit: 200 }), true);
  assert.equal(Check(endpoint.querySchema, { after: -1 }), false);
  assert.equal(Check(SessionDomainEnvelopeSchema, {
    domain: "session", seq: 4, eventId: "event-alpha", sessionId: "session-alpha",
    sessionKind: "personal_task", sessionSequence: 3, scopeId: "scope-alpha",
    actor: { principalId: "alice", kind: "user" },
    authorizer: { kind: "principal", principal: { principalId: "alice", kind: "user" } },
    lineage: { productCommandId: "command-alpha", turnId: "turn-alpha" },
    payloadClass: "product_safe",
    payloadRef: { id: "event-alpha", kind: "turn_completed", state: "completed", contentHash: HASH },
    occurredAt: "2026-08-12T04:00:00.000Z",
  }), true);
  assert.equal(checkSessionEventSemantics({
    domain: "session", seq: 4, eventId: "event-alpha", sessionId: "session-alpha",
    sessionKind: "personal_task", sessionSequence: 3, scopeId: "scope-alpha",
    actor: { principalId: "alice", kind: "user" },
    authorizer: { kind: "principal", principal: { principalId: "alice", kind: "user" } },
    lineage: { productCommandId: "command-alpha", turnId: "turn-alpha" },
    payloadClass: "product_safe",
    payloadRef: { id: "event-alpha", kind: "turn_completed", state: "completed", contentHash: HASH },
    occurredAt: "2026-08-12T04:00:00.000Z",
  }), true);
});
