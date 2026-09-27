import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductExecutionGrant,
  productToolEffectMap,
} from "../../src/runtime/product-execution-grant.mjs";
import { createExecutionGrant } from "../../../../../agent/code/agent-kernel/src/index.mjs";

test("private material reads have a read-only grant without an external connection", () => {
  assert.deepEqual(productToolEffectMap({ toolAllowlist: ["turnsu_materials", "unknown.tool", "lark.docs.fetch"],
    connectionIds: [], externalActions: false }), { turnsu_materials: "read" });
});

test("Product ExecutionGrant is lease-bound and fails closed for no-tool or undeclared Tool capability", () => {
  const base = {
    invocationId: "invocation-grant",
    capabilityLeaseId: "lease-grant",
    expiresAt: "2035-01-01T00:00:00.000Z",
    maxToolCalls: 5,
    scopeRef: "session-grant",
  };
  const none = createProductExecutionGrant({
    ...base,
    capabilities: { toolAllowlist: ["unknown.tool"], connectionIds: [], externalActions: false },
  });
  assert.deepEqual(none.allowedToolIds, []);
  assert.deepEqual(none.allowedEffectClasses, []);
  assert.equal(none.maxToolCalls, 0);
  assert.equal(createExecutionGrant(none).allows({
    toolId: "unknown.tool", effectClass: "read", now: "2026-08-14T00:00:00.000Z",
  }), false);

  const read = createProductExecutionGrant({
    ...base,
    capabilities: {
      toolAllowlist: ["lark.docs.fetch", "lark.im.send_message"],
      connectionIds: ["connection-lark"],
      externalActions: false,
    },
  });
  assert.deepEqual(read.allowedToolIds, ["lark.docs.fetch"]);
  assert.deepEqual(read.allowedEffectClasses, ["read"]);
  const rehydrated = createExecutionGrant(read);
  assert.equal(rehydrated.allows({
    toolId: "lark.docs.fetch", effectClass: "read", now: "2026-08-14T00:00:00.000Z",
  }), true);
  assert.equal(rehydrated.allows({
    toolId: "lark.im.send_message", effectClass: "external_write", now: "2026-08-14T00:00:00.000Z",
  }), false);
  assert.deepEqual(productToolEffectMap({
    toolAllowlist: ["lark.docs.fetch", "lark.im.send_message", "unknown.tool"],
    connectionIds: ["connection-lark"],
    externalActions: true,
  }), {
    "lark.docs.fetch": "read",
    "lark.im.send_message": "external_write",
  });
});
