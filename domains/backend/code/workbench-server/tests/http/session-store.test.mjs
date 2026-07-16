import assert from "node:assert/strict";
import test from "node:test";

import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

test("session store accepts the application ISO clock without weakening expiry", () => {
  let now = "2026-07-10T00:00:00.000Z";
  const store = new WorkbenchSessionStore({
    clock: () => now,
    ttlMilliseconds: 1_000,
    tokenFactory: () => "session-token",
    csrfTokenFactory: () => "c".repeat(32),
  });
  const issued = store.issue();
  assert.equal(issued.expiresAt, "2026-07-10T00:00:01.000Z");
  assert.equal(store.get("session-token").csrfToken, "c".repeat(32));
  now = "2026-07-10T00:00:01.000Z";
  assert.equal(store.get("session-token"), null);
});
