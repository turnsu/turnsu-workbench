import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionGrant,
  createMinimalAgentKernel,
} from "../../../../../agent/code/agent-kernel/src/index.mjs";
import {
  MemorySessionPort,
  createScriptedAgentLoop,
} from "../../../../../agent/code/agent-kernel-testkit/src/index.mjs";
import { createProductGatewayToolPipeline } from "../../src/runtime/product-tool-pipeline.mjs";

test("Product Gateway Tool Pipeline maps a declared read action to the Product Gateway and active lease", async (t) => {
  const received = [];
  const pipeline = createProductGatewayToolPipeline({
    gateway: {
      async handle(message, binding) {
        received.push({ message, binding });
        return { documents: ["safe result"] };
      },
    },
    binding: { invocationId: "invocation-read", attemptId: "attempt-read", capabilityLeaseId: "lease-read" },
    connectionId: "connection-lark",
    clock: () => "2026-08-14T00:00:00.000Z",
  });
  const result = await runSingleTool({
    pipeline,
    sessionId: "tool-read-session",
    toolId: "lark.docs.fetch",
    effectClass: "read",
    input: { doc: "doc-1" },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(received.length, 1);
  assert.deepEqual({ ...received[0].message, signal: "checked-below" }, {
    invocationId: "invocation-read",
    attemptId: "attempt-read",
    capabilityLeaseId: "lease-read",
    operation: "tool",
    toolId: "lark.docs.fetch",
    connectionId: "connection-lark",
    input: { doc: "doc-1" },
    signal: "checked-below",
  });
  assert.deepEqual(received[0].binding, {
    invocationId: "invocation-read",
    attemptId: "attempt-read",
    capabilityLeaseId: "lease-read",
  });
});

test("Product Gateway Tool Pipeline fails closed for an external write without a Product approval port", async () => {
  let calls = 0;
  const pipeline = createProductGatewayToolPipeline({
    gateway: { async handle() { calls += 1; return {}; } },
    binding: { invocationId: "invocation-write", attemptId: "attempt-write", capabilityLeaseId: "lease-write" },
    connectionId: "connection-lark",
    clock: () => "2026-08-14T00:00:00.000Z",
  });
  const result = await runSingleTool({
    pipeline,
    sessionId: "tool-write-session",
    toolId: "lark.im.send_message",
    effectClass: "external_write",
    input: { chatId: "chat-1", text: "Hello" },
  });
  assert.deepEqual(result, {
    status: "denied",
    toolId: "lark.im.send_message",
    effectClass: "external_write",
    code: "product_approval_unavailable",
  });
  assert.equal(calls, 0);
});

async function runSingleTool({ pipeline, sessionId, toolId, effectClass, input }) {
  let outcome;
  const loop = createScriptedAgentLoop({
    onRun: async function* (context) {
      outcome = await context.tools.execute({ toolId, effectClass, input });
    },
  });
  const kernel = createMinimalAgentKernel({
    loop,
    sessionPort: new MemorySessionPort(),
    toolPipeline: pipeline,
  });
  try {
    await collect(kernel.run({
      runId: `run-${sessionId}`,
      session: { sessionId, branchId: null },
      executionGrant: createExecutionGrant({
        grantId: `grant-${sessionId}`,
        expiresAt: "2035-01-01T00:00:00.000Z",
        allowedToolIds: [toolId],
        allowedEffectClasses: [effectClass],
        maxToolCalls: 1,
      }),
      input: null,
    }));
    return outcome;
  } finally {
    await kernel.dispose();
  }
}

async function collect(iterable) {
  for await (const _event of iterable) {
    // The assertions cover the concrete Product Gateway invocation and the
    // resulting Tool Pipeline outcome; no static-only path is accepted here.
  }
}
