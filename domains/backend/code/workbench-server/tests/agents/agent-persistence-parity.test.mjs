import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryAgentPersistence,
  MongoAgentPersistence,
} from "../../src/agents/index.mjs";

const NOW = "2026-07-18T00:00:00.000Z";
const LATER = "2026-07-18T00:00:01.000Z";

test("InMemory and Mongo Agent persistence keep pinned routing and history semantics in parity", async () => {
  for (const [label, persistence] of [
    ["in-memory", new InMemoryAgentPersistence()],
    ["mongo", new MongoAgentPersistence({ store: fakeMongoStore() })],
  ]) {
    const session = await persistence.createSession({
      schemaVersion: "workbench-v1",
      sessionId: `agent-session-${label}`,
      definitionId: "main",
      userId: "alice",
      workspaceId: "workspace-alpha",
      scope: { kind: "main" },
      status: "active",
      lastUsedModelProfileId: null,
      modelPreferenceState: "preference_only",
      activeTurnId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const preferred = await persistence.updateSessionModel(
      session.sessionId,
      "profile-chat",
      LATER,
    );
    assert.equal(preferred.lastUsedModelProfileId, "profile-chat", label);
    assert.equal(preferred.modelPreferenceState, "preference_only", label);

    const created = await persistence.createTurn({
      schemaVersion: "workbench-v1",
      turnId: `agent-turn-${label}`,
      sessionId: session.sessionId,
      kind: "agent_message",
      status: "queued",
      modelRoutingState: "pinned",
      requestedModelRevisionId: "model-revision-chat-1",
      actualModelRevisionId: null,
      artifactRefs: [],
      modelCapability: "tool_calling",
      input: { message: "hello" },
      result: null,
      queuedAt: NOW,
      startedAt: null,
      finishedAt: null,
      updatedAt: NOW,
    });
    assert.equal(created.requestedModelRevisionId, "model-revision-chat-1", label);
    const claimed = await persistence.claimNextTurn(session.sessionId, LATER);
    assert.equal(claimed.modelCapability, "tool_calling", label);
    await persistence.addInvocation(created.turnId, `invocation-${label}`, LATER);
    await persistence.completeTurn(created.turnId, "completed", {
      kind: "agent_message",
      response: "done",
      proposalId: null,
      handoffId: null,
      invocationIds: [`invocation-${label}`],
      requestedModelRevisionId: "model-revision-chat-1",
      actualModelRevisionId: "model-revision-chat-1",
      artifactRefs: [],
    }, LATER, {
      actualModelRevisionId: "model-revision-chat-1",
      artifactRefs: [],
    });
    const [listed] = await persistence.listTurns(
      session.sessionId,
      { after: 0, limit: 10 },
      { userId: "alice", workspaceId: "workspace-alpha" },
    );
    assert.equal(listed.modelRoutingState, "pinned", label);
    assert.equal(listed.actualModelRevisionId, "model-revision-chat-1", label);
    assert.equal(Object.hasOwn(listed, "modelCapability"), false, label);
  }
});

function fakeMongoStore() {
  const names = [
    "agentSessions",
    "agentTurns",
    "agentMessages",
    "agentBranches",
    "agentSessionEvents",
    "agentHandoffs",
  ];
  const repositories = Object.fromEntries(names.map((name) => {
    const collection = new FakeCollection();
    return [name, {
      collection,
      async insert(value) {
        await collection.insertOne(value);
        return structuredClone(value);
      },
      async get(id) {
        const key = name === "agentBranches" ? "branchId" : "id";
        return collection.findOne({ [key]: id });
      },
    }];
  }));
  return {
    repositories,
    async connect() {},
    async withTransaction(work) { return work({}); },
  };
}

class FakeCollection {
  docs = [];

  async insertOne(value) {
    this.docs.push(structuredClone(value));
    return { acknowledged: true };
  }

  async findOne(filter, options = {}) {
    const values = this.docs.filter((value) => matches(value, filter));
    sortValues(values, options.sort);
    return structuredClone(values[0] ?? null);
  }

  async findOneAndUpdate(filter, update) {
    const value = this.docs.find((candidate) => matches(candidate, filter));
    if (!value) return null;
    applyUpdate(value, update);
    return structuredClone(value);
  }

  async updateOne(filter, update) {
    const value = this.docs.find((candidate) => matches(candidate, filter));
    if (value) applyUpdate(value, update);
    return { matchedCount: value ? 1 : 0 };
  }

  find(filter) {
    let values = this.docs.filter((value) => matches(value, filter));
    return {
      sort(spec) { sortValues(values, spec); return this; },
      limit(limit) { values = values.slice(0, limit); return this; },
      async toArray() { return structuredClone(values); },
    };
  }
}

function matches(value, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(value, branch));
    const actual = readPath(value, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, "$exists")) return (actual !== undefined) === expected.$exists;
      if (Object.hasOwn(expected, "$gt")) return actual > expected.$gt;
      if (Object.hasOwn(expected, "$ne")) return actual !== expected.$ne;
    }
    return actual === expected;
  });
}

function applyUpdate(value, update) {
  for (const [path, next] of Object.entries(update.$set ?? {})) writePath(value, path, structuredClone(next));
  for (const path of Object.keys(update.$unset ?? {})) deletePath(value, path);
  for (const [path, amount] of Object.entries(update.$inc ?? {})) {
    writePath(value, path, Number(readPath(value, path) ?? 0) + amount);
  }
  for (const [path, item] of Object.entries(update.$addToSet ?? {})) {
    const items = readPath(value, path) ?? [];
    if (!items.includes(item)) items.push(item);
    writePath(value, path, items);
  }
}

function sortValues(values, spec = {}) {
  const [path, direction] = Object.entries(spec)[0] ?? [];
  if (!path) return;
  values.sort((left, right) => direction * (readPath(left, path) > readPath(right, path) ? 1 : -1));
}

function readPath(value, path) {
  return path.split(".").reduce((current, segment) => current?.[segment], value);
}

function writePath(value, path, next) {
  const parts = path.split(".");
  const key = parts.pop();
  const target = parts.reduce((current, segment) => (current[segment] ??= {}), value);
  target[key] = next;
}

function deletePath(value, path) {
  const parts = path.split(".");
  const key = parts.pop();
  const target = parts.reduce((current, segment) => current?.[segment], value);
  if (target) delete target[key];
}
