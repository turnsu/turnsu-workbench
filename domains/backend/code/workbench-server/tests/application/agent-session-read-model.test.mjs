import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const NOW = "2026-08-01T00:00:00.000Z";

test("Agent Session PATCH is user-scoped, transactional, and idempotent", async () => {
  const transactionSession = { id: "session-patch-transaction" };
  const idempotencyResults = new Map();
  const updateInputs = [];
  const session = {
    schemaVersion: "workbench-v1",
    sessionId: "agent-session-patch",
    definitionId: "main",
    userId: "user-surface",
    workspaceId: "workspace-surface",
    scope: { kind: "main" },
    title: "Renamed task",
    source: { kind: "manual" },
    taskStatus: "running",
    archived: true,
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: "agent-turn-running",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async runIdempotentMutation(options, mutation) {
      const identity = `${options.scope}:${options.key}`;
      if (idempotencyResults.has(identity)) return idempotencyResults.get(identity);
      const result = await mutation(transactionSession);
      idempotencyResults.set(identity, result);
      return result;
    },
  };
  const application = createWorkbenchApplication({
    store,
    agentTurnRunner: {
      async updateSession(input) {
        updateInputs.push(input);
        return session;
      },
    },
    clock: () => NOW,
  });
  const request = {
    schemaVersion: "workbench-api-v1",
    data: { title: "Renamed task", archived: true },
  };
  const input = {
    sessionId: session.sessionId,
    idempotencyKey: "patch-session-once",
    request,
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  };

  const first = await application.updateAgentSession(input);
  const replay = await application.updateAgentSession(input);

  assert.deepEqual(replay, first);
  assert.equal(updateInputs.length, 1);
  assert.equal(updateInputs[0].userId, session.userId);
  assert.equal(updateInputs[0].workspaceId, session.workspaceId);
  assert.equal(updateInputs[0].transactionSession, transactionSession);
  assert.equal(first.activeTurnId, "agent-turn-running");
  assert.equal(first.taskStatus, "running");
});

test("Agent Session taskStatus filtering uses the authoritative Loop Run projection", async () => {
  const listInputs = [];
  const base = {
    schemaVersion: "workbench-v1",
    definitionId: "main",
    userId: "user-surface",
    workspaceId: "workspace-surface",
    scope: { kind: "main" },
    title: "Task",
    archived: false,
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const pages = new Map([
    [null, pagedSessions([{
      ...base,
      sessionId: "agent-session-loop-now-running",
      source: { kind: "loop_run", runId: "run-now-running" },
      taskStatus: "completed",
    }], "second-page")],
    ["second-page", pagedSessions([{
      ...base,
      sessionId: "agent-session-manual-completed",
      source: { kind: "manual" },
      taskStatus: "completed",
    }, {
      ...base,
      sessionId: "agent-session-loop-now-completed",
      source: { kind: "loop_run", runId: "run-now-completed" },
      taskStatus: "queued",
    }], null)],
  ]);
  const runSnapshotReads = [];
  const application = createWorkbenchApplication({
    store: {
      async connect() {},
      async authorizeWorkspace() { return { role: "member" }; },
    },
    agentTurnRunner: {
      async listSessions(input) {
        listInputs.push(input);
        return pages.get(input.cursor ?? null);
      },
    },
    runner: {
      async getRunAt(runId, snapshotAt) {
        runSnapshotReads.push([runId, snapshotAt]);
        return { run: { status: runId === "run-now-completed" ? "completed" : "running" } };
      },
    },
    clock: () => NOW,
  });

  const result = await application.listAgentSessions({
    query: { taskStatus: "completed", limit: 2 },
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.deepEqual(
    result.data.map((session) => [session.sessionId, session.taskStatus]),
    [
      ["agent-session-manual-completed", "completed"],
      ["agent-session-loop-now-completed", "completed"],
    ],
  );
  assert.deepEqual(result.page, { nextCursor: null, hasMore: false });
  assert.equal(listInputs.length, 2);
  assert.equal(listInputs[0].projectLoopTaskStatus, true);
  assert.equal(listInputs[0].taskStatus, "completed");
  assert.equal(listInputs[1].cursor, "second-page");
  assert.equal(listInputs[1].limit, 2);
  assert.deepEqual(runSnapshotReads, [
    ["run-now-running", NOW],
    ["run-now-completed", NOW],
  ]);
});

function pagedSessions(items, nextCursor) {
  Object.defineProperty(items, "page", {
    enumerable: false,
    value: { snapshotAt: NOW, nextCursor, hasMore: Boolean(nextCursor) },
  });
  return items;
}
