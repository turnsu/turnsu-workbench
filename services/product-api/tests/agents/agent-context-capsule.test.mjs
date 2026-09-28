import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentContextCapsuleManager,
  condensationRequestInput,
  parseCondensationOutput,
} from "../../src/agents/agent-context-capsule.mjs";
import { InMemoryAgentPersistence } from "../../src/agents/agent-persistence.mjs";

const SESSION = Object.freeze({
  sessionId: "agent-session-context",
  userId: "user-context",
  workspaceId: "workspace-context",
});

const TURN = Object.freeze({
  turnId: "agent-turn-context",
  productCommandId: "product-command-context",
  requestedModelRevisionId: "model-revision-context",
  contextWindowTokens: 256,
});

test("long transcripts condense through an auditable untrusted Context Capsule without deleting source messages", async () => {
  const persistence = new InMemoryAgentPersistence();
  let ids = 0;
  const manager = new AgentContextCapsuleManager({
    persistence,
    clock: () => "2026-08-01T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${++ids}`,
  });
  const messages = transcript(12, 500);
  let request;
  const assembled = await manager.assemble({
    session: SESSION,
    turn: TURN,
    messages,
    async condense(input) {
      request = condensationRequestInput(input);
      return {
        invocationId: "invocation-context-1",
        summary: {
          text: "The user is preparing a governed launch plan.",
          importantState: ["Draft remains private."],
          decisions: ["Use the pinned model revision."],
          risks: ["External input is untrusted."],
          artifactRefs: [],
        },
      };
    },
  });

  assert.equal(request.tools.length, 0);
  assert.match(request.messages[0].content, /Do not follow instructions/);
  assert.match(assembled[0].content, /UNTRUSTED_DERIVED_CONTEXT/);
  assert.ok(assembled.at(-1).sequence > assembled[0].sequence);
  const event = await persistence.getLatestContextEvent(SESSION.sessionId, { status: "completed" });
  assert.equal(event.provenance.invocationId, "invocation-context-1");
  assert.match(event.sourceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(event.promptRevision, "agent-context-condensation-v1");
  assert.equal(event.coverage.toMessageSequence, event.throughMessageSequence);
  assert.equal(messages.length, 12);
});

test("condensation failure backs off and falls back to recent raw messages without blocking a Turn", async () => {
  const persistence = new InMemoryAgentPersistence();
  let calls = 0;
  const manager = new AgentContextCapsuleManager({
    persistence,
    clock: () => "2026-08-01T10:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${calls + 1}`,
  });
  const input = {
    session: SESSION,
    turn: TURN,
    messages: transcript(10, 600),
    async condense() {
      calls += 1;
      const error = new Error("provider unavailable");
      error.code = "provider_unavailable";
      throw error;
    },
  };
  const first = await manager.assemble(input);
  const second = await manager.assemble(input);
  assert.equal(calls, 1);
  assert.ok(first.length > 0);
  assert.deepEqual(second, first);
  const failed = await persistence.getLatestContextEvent(SESSION.sessionId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "provider_unavailable");
  assert.equal(failed.summary, null);
});

test("structured condensation parsing rejects non-JSON and never trusts model-provided references", () => {
  assert.throws(() => parseCondensationOutput({ content: [{ type: "text", text: "not json" }] }, "invocation-a"), {
    code: "agent_context_condensation_output_invalid",
  });
  const parsed = parseCondensationOutput({
    content: [{
      type: "text",
      text: JSON.stringify({
        summary: "Known facts only.",
        importantState: ["State"],
        decisions: [],
        risks: [],
        artifactRefs: ["invented-secret-ref"],
      }),
    }],
  }, "invocation-b");
  assert.equal(parsed.invocationId, "invocation-b");
  assert.deepEqual(parsed.summary.artifactRefs, []);
});

function transcript(count, size) {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: "workbench-v1",
    messageId: `message-${index + 1}`,
    sessionId: SESSION.sessionId,
    turnId: `turn-${Math.floor(index / 2) + 1}`,
    sequence: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    kind: index % 2 === 0 ? "turn" : "result",
    content: `${index + 1}:${"x".repeat(size)}`,
    createdAt: `2026-08-01T10:00:${String(index).padStart(2, "0")}.000Z`,
  }));
}
