import assert from "node:assert/strict";
import test from "node:test";

import {
  hashSessionToken,
  MongoWorkbenchSessionStore,
} from "../../src/security/mongo-workbench-session-store.mjs";

test("durable session store hashes browser tokens and rechecks workspace membership", async () => {
  let now = "2026-07-10T00:00:00.000Z";
  const sessions = [];
  const store = {
    repositories: {
      sessions: {
        async insert(session) { sessions.push(structuredClone(session)); },
        async getByTokenHash(tokenHash) {
          return structuredClone(sessions.find((session) => session.tokenHash === tokenHash && session.revokedAt === null) ?? null);
        },
        async revoke(sessionId, revokedAt) {
          const session = sessions.find((entry) => entry.sessionId === sessionId && entry.revokedAt === null);
          if (session) session.revokedAt = revokedAt;
          return structuredClone(session ?? null);
        },
      },
    },
    async connect() {},
    async authorizeWorkspace({ userId, workspaceId }) {
      if (userId !== "user-alpha" || workspaceId !== "workspace-alpha") {
        const error = new Error("forbidden");
        error.code = "workspace_access_forbidden";
        throw error;
      }
    },
  };
  const sessionStore = new MongoWorkbenchSessionStore({
    store,
    clock: () => now,
    ttlMilliseconds: 1_000,
    tokenFactory: () => "browser-token",
    csrfTokenFactory: () => "c".repeat(32),
    idFactory: () => "session-alpha",
  });

  const issued = await sessionStore.issue({ userId: "user-alpha", activeWorkspaceId: "workspace-alpha" });
  assert.equal(issued.token, "browser-token");
  assert.equal(sessions[0].tokenHash, hashSessionToken("browser-token"));
  assert.equal(JSON.stringify(sessions[0]).includes("browser-token"), false);
  const active = await sessionStore.get("browser-token");
  assert.deepEqual(active, {
    sessionId: "session-alpha",
    csrfToken: "c".repeat(32),
    expiresAt: "2026-07-10T00:00:01.000Z",
    userId: "user-alpha",
    activeWorkspaceId: "workspace-alpha",
  });

  now = "2026-07-10T00:00:01.000Z";
  assert.equal(await sessionStore.get("browser-token"), null);
  assert.equal(sessions[0].revokedAt, now);
});
