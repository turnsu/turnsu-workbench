import assert from "node:assert/strict";
import test from "node:test";

import { ConversationTurnCoordinator } from "../../src/coordination/conversation-turn-coordinator.mjs";

test("ConversationTurnCoordinator keeps one active Turn per Session and lets Sessions run concurrently", async () => {
  const queues = new Map([
    ["session-a", [{ turnId: "a-1" }, { turnId: "a-2" }]],
    ["session-b", [{ turnId: "b-1" }]],
  ]);
  const runningBySession = new Map();
  const started = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = new ConversationTurnCoordinator({
    adapter: {
      async recover() { return []; },
      async claimNextTurn(sessionId) {
        return queues.get(sessionId)?.shift() ?? null;
      },
      async loadSession(sessionId) { return { sessionId }; },
      async executeTurn({ session, turn }) {
        assert.equal(runningBySession.has(session.sessionId), false);
        runningBySession.set(session.sessionId, turn.turnId);
        started.push(turn.turnId);
        if (turn.turnId === "a-1") await first;
        runningBySession.delete(session.sessionId);
      },
      async handleTurnError({ error }) { throw error; },
    },
  });

  coordinator.schedule("session-a");
  coordinator.schedule("session-b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set(["a-1", "b-1"]));
  assert.equal(started.includes("a-2"), false);

  releaseFirst();
  await Promise.all([
    coordinator.waitForIdle("session-a"),
    coordinator.waitForIdle("session-b"),
  ]);
  assert.deepEqual(started.filter((id) => id.startsWith("a-")), ["a-1", "a-2"]);
});

test("ConversationTurnCoordinator recovery schedules durable Sessions and abort targets only the active Turn", async () => {
  let observedAbort = false;
  const coordinator = new ConversationTurnCoordinator({
    adapter: {
      async recover() { return ["session-a"]; },
      async claimNextTurn(sessionId) {
        if (sessionId !== "session-a" || observedAbort) return null;
        return { turnId: "turn-a" };
      },
      async loadSession(sessionId) { return { sessionId }; },
      async executeTurn({ signal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        observedAbort = signal.aborted;
      },
      async handleTurnError({ error }) { throw error; },
    },
  });

  assert.deepEqual(await coordinator.recover(), ["session-a"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.abort("session-a", "not-active", new Error("wrong")), false);
  assert.equal(coordinator.abort("session-a", "turn-a", new Error("cancelled")), true);
  await coordinator.waitForIdle("session-a");
  assert.equal(observedAbort, true);
});
