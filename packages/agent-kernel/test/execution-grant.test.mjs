import assert from "node:assert/strict";
import test from "node:test";

import { createExecutionGrant } from "../src/index.mjs";

test("a zero-capability ExecutionGrant is an explicit deny-all Product authority", () => {
  const grant = createExecutionGrant({
    grantId: "grant-no-tools",
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: [],
    allowedEffectClasses: [],
    maxToolCalls: 0,
  });
  assert.equal(grant.allows({
    toolId: "attempted.tool",
    effectClass: "read",
    now: "2026-08-14T00:00:00.000Z",
  }), false);
  assert.throws(() => createExecutionGrant({
    grantId: "grant-invalid-positive-budget",
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: [],
    allowedEffectClasses: [],
    maxToolCalls: 1,
  }), (error) => error?.code === "execution_grant_invalid");
});
