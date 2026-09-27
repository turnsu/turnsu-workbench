import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionGrant,
  createMinimalAgentKernel,
} from "../../agent-kernel/src/index.mjs";
import { MemorySessionPort } from "../../agent-kernel-testkit/src/index.mjs";
import { createDshAgentLoopPlugin } from "../src/index.mjs";

test("DSH compatibility adapter replays Product Session data and never accepts a runtime with direct Product access", async (t) => {
  const seen = [];
  const loop = createDshAgentLoopPlugin({
    createRuntime: async () => ({
      async ensure() {},
      async *run(input) {
        seen.push(input);
        yield { type: "message", modelVisible: true, payload: { role: "assistant", text: "DSH-compatible result" } };
      },
      async dispose() {},
    }),
  });
  const sessions = new MemorySessionPort();
  await sessions.append({
    schemaVersion: "agent-kernel-model-visible-event-v1",
    eventId: "dsh-history-event",
    runId: "dsh-history-run",
    session: { sessionId: "dsh-session", branchId: null },
    sequence: 1,
    type: "message",
    payload: { role: "user", text: "Product-owned replay" },
    occurredAt: "2026-08-14T00:00:00.000Z",
  });
  const kernel = createMinimalAgentKernel({ loop, sessionPort: sessions });
  t.after(() => kernel.dispose());
  const events = await collect(kernel.run(request("dsh-run", { sessionId: "dsh-session", branchId: null })));
  assert.deepEqual(events.map((event) => event.type), ["message", "run.completed"]);
  assert.deepEqual(seen[0].replay, ['[message] {"role":"user","text":"Product-owned replay"}']);
  assert.equal(loop.capabilities().defaultEligible, false);

  const denied = createDshAgentLoopPlugin({
    createRuntime: async () => ({
      directProductAccess: true,
      async ensure() {},
      async *run() {},
      async dispose() {},
    }),
  });
  const invalidKernel = createMinimalAgentKernel({ loop: denied, sessionPort: new MemorySessionPort() });
  t.after(() => invalidKernel.dispose());
  const failed = await collect(invalidKernel.run(request("dsh-invalid", { sessionId: "dsh-invalid", branchId: null })));
  assert.deepEqual(failed.map((event) => event.type), ["run.failed"]);
  assert.equal(failed[0].payload.code, "dsh_agent_runtime_invalid");
});

function request(runId, session) {
  return {
    runId,
    session,
    executionGrant: createExecutionGrant({
      grantId: `grant-${runId}`,
      expiresAt: "2035-01-01T00:00:00.000Z",
      allowedToolIds: [],
      allowedEffectClasses: [],
      maxToolCalls: 0,
    }),
    input: { message: "continue" },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}
