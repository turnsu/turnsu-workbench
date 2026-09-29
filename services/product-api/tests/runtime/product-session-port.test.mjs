import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionGrant,
  createMinimalAgentKernel,
  toModelVisibleEvent,
} from "../../../../packages/agent-kernel/src/index.mjs";
import { createScriptedAgentLoop } from "../../../../packages/agent-testkit/src/index.mjs";
import { InMemoryAgentPersistence } from "../../src/agents/agent-persistence.mjs";
import { createProductAgentSessionPort } from "../../src/runtime/product-session-port.mjs";

test("Product Agent SessionPort stores Kernel-visible content in the existing Product Session ledger and replays it", async (t) => {
  const persistence = new InMemoryAgentPersistence();
  const session = sessionFixture();
  const turn = turnFixture(session);
  await persistence.createSession(session);
  await persistence.createTurn(turn);
  await persistence.appendMessage({
    schemaVersion: "workbench-v1",
    messageId: "product-user-message",
    sessionId: session.sessionId,
    turnId: turn.turnId,
    role: "user",
    kind: "turn",
    content: "Persist this Product Session context.",
    createdAt: "2026-08-14T00:00:00.000Z",
  });
  const port = createProductAgentSessionPort({ persistence, session, turn });
  const loop = createScriptedAgentLoop({
    onRun: async function* () {
      yield {
        type: "message",
        modelVisible: true,
        payload: { role: "assistant", text: "This came from the Harness." },
      };
    },
  });
  const kernel = createMinimalAgentKernel({
    loop,
    sessionPort: port,
    idFactory: (() => {
      let sequence = 0;
      return (kind) => `${kind}-${++sequence}`;
    })(),
  });
  t.after(() => kernel.dispose());
  const sessionRef = { sessionId: session.sessionId, branchId: null };
  const output = await collect(kernel.run({
    runId: "product-kernel-run",
    session: sessionRef,
    executionGrant: grant(),
    input: { message: "continue" },
  }));
  assert.deepEqual(output.map((event) => event.type), ["message", "run.completed"]);

  const events = await persistence.listEvents(session.sessionId, { after: 0, limit: 20 }, {
    userId: session.userId,
    workspaceId: session.workspaceId,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "kernel.message");
  assert.deepEqual(events[0].modelVisibleEvent.payload, { role: "assistant", text: "This came from the Harness." });
  assert.equal(events[0].productCommandId, turn.productCommandId);

  const replay = await collect(port.replay(sessionRef));
  assert.deepEqual(replay.map((event) => event.payload.text), [
    "Persist this Product Session context.",
    "This came from the Harness.",
  ]);
  assert.deepEqual(await port.checkpoint(sessionRef), { cursor: events[0].sequence });
  const retry = await port.append(toModelVisibleEvent(output[0]));
  assert.deepEqual(retry, { cursor: events[0].sequence, eventId: output[0].eventId });
  const afterRetry = await persistence.listEvents(session.sessionId, { after: 0, limit: 20 }, {
    userId: session.userId,
    workspaceId: session.workspaceId,
  });
  assert.equal(afterRetry.length, 1, "a repeated Kernel event must not consume a second Product Session sequence");
});

function sessionFixture() {
  return {
    schemaVersion: "workbench-v1",
    sessionId: "product-session",
    definitionId: "main",
    userId: "product-user",
    workspaceId: "product-workspace",
    scope: { kind: "main" },
    title: "Product bridge task",
    source: { kind: "manual" },
    taskStatus: "idle",
    archived: false,
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    sessionEpoch: 1,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function turnFixture(session) {
  return {
    schemaVersion: "workbench-v1",
    turnId: "product-turn",
    sessionId: session.sessionId,
    productCommandId: "product-command",
    sessionEpoch: 1,
    turnFence: 1,
    kind: "agent_message",
    status: "queued",
    modelRoutingState: "pinned",
    requestedModelRevisionId: "model-revision",
    actualModelRevisionId: null,
    artifactRefs: [],
    input: { message: "Persist this Product Session context." },
    result: null,
    queuedAt: "2026-08-14T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function grant() {
  return createExecutionGrant({
    grantId: "product-grant",
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: ["none"],
    allowedEffectClasses: ["read"],
    maxToolCalls: 1,
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
