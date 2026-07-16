import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTextResourceService } from "../../src/resources/index.mjs";
import { FilesystemObjectStore } from "../../src/storage/index.mjs";

test("TextResourceService stores UTF-8 text by workspace and reads it only through the server resolver", async () => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-text-resource-"));
  try {
    const store = createStore();
    const objectStore = await new FilesystemObjectStore({ rootDir: root }).initialize();
    const service = createTextResourceService({ store, objectStore, idFactory: (() => { let count = 0; return (kind) => `${kind}-${++count}`; })() });
    const created = await service.create({
      workspaceId: "workspace-a", requestedBy: "user-a", idempotencyKey: "create-1",
      label: "Meeting notes", mediaType: "text/markdown", content: Buffer.from("# Notes\nAssign an owner."),
    });
    assert.equal(created.version, "1.0.0");
    assert.equal(created.readiness.status, "ready");
    assert.equal(Object.hasOwn(created, "objectId"), false);
    const replay = await service.create({
      workspaceId: "workspace-a", requestedBy: "user-a", idempotencyKey: "create-1",
      label: "Meeting notes", mediaType: "text/markdown", content: Buffer.from("# Notes\nAssign an owner."),
    });
    assert.equal(replay.resourceId, created.resourceId);
    assert.deepEqual(await service.list({ workspaceId: "workspace-a", requestedBy: "user-a" }), [created]);
    assert.equal(await service.readText({ workspaceId: "workspace-a", resourceId: created.resourceId, version: "1.0.0" }), "# Notes\nAssign an owner.");
    await assert.rejects(
      service.readText({ workspaceId: "workspace-b", resourceId: created.resourceId, version: "1.0.0" }),
      { code: "resource_not_ready" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Loop material reuses the caller transaction session", async () => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-embedded-resource-"));
  try {
    const store = createStore();
    const objectStore = await new FilesystemObjectStore({ rootDir: root }).initialize();
    const service = createTextResourceService({ store, objectStore });
    const transactionSession = { id: "loop-import-transaction" };
    const created = await service.createInSession({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      session: transactionSession,
      label: "Included notes",
      mediaType: "text/plain",
      content: Buffer.from("One imported note."),
    });
    assert.equal(created.label, "Included notes");
    assert.equal(store.lastInsertSession, transactionSession);
    assert.equal(store.idempotentMutationCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createStore() {
  const records = new Map();
  const keys = new Map();
  const store = {
    lastInsertSession: null,
    idempotentMutationCount: 0,
    async connect() {},
    async authorizeWorkspace({ userId, workspaceId }) { assert.ok(userId); assert.ok(workspaceId); },
    repositories: {
      resources: {
        async insert(value, options = {}) {
          store.lastInsertSession = options.session ?? null;
          records.set(`${value.workspaceId}:${value.resourceId}`, structuredClone(value));
          return structuredClone(value);
        },
        async get(resourceId, { workspaceId }) { const value = records.get(`${workspaceId}:${resourceId}`); return value ? structuredClone(value) : null; },
        async list({ workspaceId }) { return [...records.values()].filter((value) => value.workspaceId === workspaceId).map((value) => structuredClone(value)); },
      },
    },
    async runIdempotentMutation({ scope, key, workspaceId, request }, mutation) {
      store.idempotentMutationCount += 1;
      const id = `${scope}:${workspaceId}:${key}`;
      const existing = keys.get(id);
      if (existing) { assert.deepEqual(existing.request, request); return structuredClone(existing.value); }
      const value = await mutation({});
      keys.set(id, { request: structuredClone(request), value: structuredClone(value) });
      return structuredClone(value);
    },
  };
  return store;
}
