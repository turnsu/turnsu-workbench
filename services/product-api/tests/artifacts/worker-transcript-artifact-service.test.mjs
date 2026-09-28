import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORKER_TRANSCRIPT_ARTIFACT_LIMITS,
  createWorkerTranscriptArtifactService,
} from "../../src/artifacts/worker-transcript-artifact-service.mjs";
import { FilesystemObjectStore } from "../../src/storage/filesystem-object-store.mjs";

const SCOPE = Object.freeze({ objectKind: "agent_session", objectId: "session-a" });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fixture({ maxBytes = 1024, auditFailure = false } = {}) {
  let now = "2026-08-01T00:00:00.000Z";
  let sequence = 0;
  let failDelete = false;
  const records = new Map();
  const objects = new Map();
  const audits = [];
  const repository = {
    async createPending(record) {
      if (records.has(record.transcriptArtifactId)) throw new Error("duplicate");
      records.set(record.transcriptArtifactId, clone(record));
      return clone(record);
    },
    async get({ workspaceId, transcriptArtifactId }) {
      const record = records.get(transcriptArtifactId);
      return record?.workspaceId === workspaceId ? clone(record) : null;
    },
    async list({ workspaceId, states, expiresBefore, limit }) {
      return [...records.values()]
        .filter((record) => (!workspaceId || record.workspaceId === workspaceId)
          && (!states || states.includes(record.state))
          && (!expiresBefore || record.expiresAt <= expiresBefore))
        .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt)
          || left.transcriptArtifactId.localeCompare(right.transcriptArtifactId))
        .slice(0, limit)
        .map(clone);
    },
    async transition({ workspaceId, transcriptArtifactId, expectedState, nextState, patch }) {
      const current = records.get(transcriptArtifactId);
      if (!current || current.workspaceId !== workspaceId || current.state !== expectedState) return null;
      const next = { ...current, ...clone(patch), state: nextState };
      records.set(transcriptArtifactId, next);
      return clone(next);
    },
  };
  const objectStore = {
    async put({ workspaceId, objectId, bytes, contentHash, mediaType, metadata, state }) {
      const object = {
        workspaceId,
        objectId,
        contentHash,
        sizeBytes: bytes.byteLength,
        mediaType,
        metadata: clone(metadata),
        state,
      };
      objects.set(`${workspaceId}:${objectId}`, { object, bytes: Buffer.from(bytes) });
      return clone(object);
    },
    async promote({ workspaceId, objectId }) {
      const stored = objects.get(`${workspaceId}:${objectId}`);
      stored.object.state = "promoted";
      return clone(stored.object);
    },
    async read({ workspaceId, objectId }) {
      const stored = objects.get(`${workspaceId}:${objectId}`);
      if (!stored) throw new Error("object_not_found");
      return { object: clone(stored.object), bytes: Buffer.from(stored.bytes) };
    },
    async deleteObject({ workspaceId, objectId }) {
      if (failDelete) throw new Error("object_delete_failed");
      return { deleted: objects.delete(`${workspaceId}:${objectId}`) };
    },
  };
  const service = createWorkerTranscriptArtifactService({
    repository,
    objectStore,
    encryptionKey: Buffer.alloc(32, 7),
    keyId: "transcript-key-v1",
    audit: async (event) => {
      if (auditFailure) throw new Error("audit_unavailable");
      audits.push(clone(event));
    },
    clock: () => now,
    idFactory(kind) {
      sequence += 1;
      return `${kind}-${sequence}`;
    },
    randomBytesFactory(size) {
      return Buffer.alloc(size, sequence + 10);
    },
    maxBytes,
  });
  return {
    service,
    repository,
    objectStore,
    records,
    objects,
    audits,
    setNow(value) { now = value; },
    setDeleteFailure(value) { failDelete = value; },
  };
}

async function commit(service, overrides = {}) {
  return service.commit({
    workspaceId: "workspace-a",
    ownerUserId: "alice",
    objectScope: SCOPE,
    invocationId: "invocation-a",
    attemptId: "attempt-a",
    content: JSON.stringify({ messages: [{ role: "assistant", text: "private transcript body" }] }),
    ttlSeconds: 300,
    ...overrides,
  });
}

test("encrypts Worker transcripts before ObjectStore and returns only a safe reference", async () => {
  const state = fixture();
  const ref = await commit(state.service);

  assert.deepEqual(Object.keys(ref).sort(), [
    "expiresAt",
    "kind",
    "schemaVersion",
    "sensitivity",
    "transcriptArtifactId",
  ]);
  assert.equal(ref.kind, "worker_transcript");
  const metadata = state.records.get(ref.transcriptArtifactId);
  assert.equal(metadata.ownerUserId, "alice");
  assert.equal(metadata.workspaceId, "workspace-a");
  assert.deepEqual(metadata.objectScope, SCOPE);
  assert.equal(metadata.invocationId, "invocation-a");
  assert.equal(metadata.attemptId, "attempt-a");
  assert.equal(metadata.sensitivity, "sensitive");
  assert.equal(metadata.encryption.algorithm, "AES-256-GCM");
  assert.equal(metadata.encryption.envelopeVersion, "worker-transcript-envelope-v1");
  assert.equal(metadata.encryption.keyId, "transcript-key-v1");
  assert.match(metadata.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(metadata).includes("private transcript body"), false);

  const stored = state.objects.get(`workspace-a:${metadata.objectId}`);
  assert.equal(stored.object.mediaType, "application/octet-stream");
  assert.equal(stored.object.state, "promoted");
  assert.equal(stored.bytes.includes(Buffer.from("private transcript body")), false);
  assert.equal(JSON.stringify(stored.object.metadata).includes("private transcript body"), false);
  assert.equal(
    stored.object.contentHash,
    `sha256:${createHash("sha256").update(stored.bytes).digest("hex")}`,
  );

  const result = await state.service.read({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    objectScope: SCOPE,
    transcriptArtifactId: ref.transcriptArtifactId,
  });
  assert.match(result.bytes.toString("utf8"), /private transcript body/);
  assert.deepEqual(result.artifact, ref);
  assert.equal(state.audits.at(-1).action, "worker_transcript_artifact.read");
  assert.equal(state.audits.at(-1).outcome, "allowed");
  assert.equal(JSON.stringify(state.audits).includes("private transcript body"), false);
  assert.equal(JSON.stringify(state.audits).includes("authTagBase64"), false);
});

test("revalidates owner, workspace, and object scope without reading ciphertext", async () => {
  const state = fixture();
  const ref = await commit(state.service);
  let reads = 0;
  const originalRead = state.objectStore.read;
  state.objectStore.read = async (input) => {
    reads += 1;
    return originalRead(input);
  };

  for (const input of [
    { workspaceId: "workspace-a", requestedBy: "bob", objectScope: SCOPE },
    { workspaceId: "workspace-b", requestedBy: "alice", objectScope: SCOPE },
    {
      workspaceId: "workspace-a",
      requestedBy: "alice",
      objectScope: { objectKind: "agent_session", objectId: "session-b" },
    },
  ]) {
    await assert.rejects(
      state.service.read({ ...input, transcriptArtifactId: ref.transcriptArtifactId }),
      (error) => error.code === "worker_transcript_forbidden",
    );
  }
  assert.equal(reads, 0);
  assert.equal(state.audits.length, 3);
  assert.ok(state.audits.every((event) => event.outcome === "denied"));
});

test("rejects tampered ciphertext and records only a safe failed-access audit", async () => {
  const state = fixture();
  const ref = await commit(state.service);
  const metadata = state.records.get(ref.transcriptArtifactId);
  const stored = state.objects.get(`workspace-a:${metadata.objectId}`);
  stored.bytes[0] ^= 0xff;

  await assert.rejects(
    state.service.read({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      objectScope: SCOPE,
      transcriptArtifactId: ref.transcriptArtifactId,
    }),
    (error) => error.code === "worker_transcript_integrity_failed",
  );
  assert.equal(state.audits.at(-1).outcome, "error");
  assert.equal(state.audits.at(-1).reasonCode, "worker_transcript_integrity_failed");
  assert.equal(JSON.stringify(state.audits).includes("private transcript body"), false);
});

test("fails closed when a successful read cannot be audited", async () => {
  const state = fixture({ auditFailure: true });
  const ref = await commit(state.service);
  await assert.rejects(
    state.service.read({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      objectScope: SCOPE,
      transcriptArtifactId: ref.transcriptArtifactId,
    }),
    (error) => error.code === "worker_transcript_audit_failed" && error.retryable === true,
  );
});

test("owner deletion removes ciphertext before marking metadata deleted and can retry storage failure", async () => {
  const state = fixture();
  const ref = await commit(state.service);
  const metadata = state.records.get(ref.transcriptArtifactId);
  state.setDeleteFailure(true);
  await assert.rejects(
    state.service.delete({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      objectScope: SCOPE,
      transcriptArtifactId: ref.transcriptArtifactId,
    }),
    (error) => error.code === "worker_transcript_delete_failed" && error.retryable === true,
  );
  assert.equal(state.records.get(ref.transcriptArtifactId).state, "ready");
  assert.equal(state.objects.has(`workspace-a:${metadata.objectId}`), true);

  state.setDeleteFailure(false);
  const deleted = await state.service.delete({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    objectScope: SCOPE,
    transcriptArtifactId: ref.transcriptArtifactId,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(state.records.get(ref.transcriptArtifactId).state, "deleted");
  assert.equal(state.objects.has(`workspace-a:${metadata.objectId}`), false);
  assert.equal(state.audits.at(-1).action, "worker_transcript_artifact.deleted");
});

test("expired reads never decrypt and TTL cleanup physically removes due ciphertext", async () => {
  const state = fixture();
  const first = await commit(state.service);
  const second = await commit(state.service, {
    invocationId: "invocation-b",
    attemptId: "attempt-b",
    objectScope: { objectKind: "workflow_run", objectId: "run-b" },
  });
  state.setNow("2026-08-01T00:05:00.000Z");

  await assert.rejects(
    state.service.read({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      objectScope: SCOPE,
      transcriptArtifactId: first.transcriptArtifactId,
    }),
    (error) => error.code === "worker_transcript_expired",
  );
  assert.equal(state.records.get(first.transcriptArtifactId).state, "deleted");

  const cleanup = await state.service.cleanupExpired({ workspaceId: "workspace-a" });
  assert.deepEqual(cleanup, { inspected: 1, deleted: 1, failed: 0, failures: [] });
  assert.equal(state.records.get(second.transcriptArtifactId).state, "deleted");
  assert.equal(state.objects.size, 0);
  assert.ok(state.audits.some((event) => event.action === "worker_transcript_artifact.expired"));
});

test("enforces bounded content, short TTL, constructor-only key injection, and key disposal", async () => {
  assert.throws(
    () => createWorkerTranscriptArtifactService({}),
    /worker_transcript_repository_required/,
  );
  assert.equal(WORKER_TRANSCRIPT_ARTIFACT_LIMITS.defaultTtlSeconds, 86_400);
  const state = fixture({ maxBytes: 8 });
  await assert.rejects(
    commit(state.service, { content: "123456789" }),
    (error) => error.code === "worker_transcript_too_large",
  );
  await assert.rejects(
    commit(state.service, { content: "ok", ttlSeconds: 299 }),
    (error) => error.code === "worker_transcript_ttl_invalid",
  );
  state.service.dispose();
  await assert.rejects(
    commit(state.service, { content: "ok" }),
    (error) => error.code === "worker_transcript_service_disposed",
  );
});

test("uses the existing FilesystemObjectStore contract and decrypts after service restart", async (context) => {
  const rootDir = await mkdtemp(join(tmpdir(), "worker-transcript-artifact-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const records = new Map();
  const repository = {
    async createPending(record) {
      records.set(record.transcriptArtifactId, clone(record));
      return clone(record);
    },
    async get({ workspaceId, transcriptArtifactId }) {
      const record = records.get(transcriptArtifactId);
      return record?.workspaceId === workspaceId ? clone(record) : null;
    },
    async list() { return []; },
    async transition({ workspaceId, transcriptArtifactId, expectedState, nextState, patch }) {
      const current = records.get(transcriptArtifactId);
      if (!current || current.workspaceId !== workspaceId || current.state !== expectedState) return null;
      const next = { ...current, ...clone(patch), state: nextState };
      records.set(transcriptArtifactId, next);
      return clone(next);
    },
  };
  const encryptionKey = Buffer.alloc(32, 23);
  const objectStore = await new FilesystemObjectStore({ rootDir }).initialize();
  const options = {
    repository,
    objectStore,
    audit: async () => {},
    encryptionKey,
    keyId: "transcript-key-v1",
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: () => "worker-transcript-restart",
  };
  const original = createWorkerTranscriptArtifactService(options);
  const ref = await commit(original, { content: "restart-only secret" });
  const metadata = records.get(ref.transcriptArtifactId);
  const stored = await objectStore.read({
    workspaceId: "workspace-a",
    objectId: metadata.objectId,
  });
  assert.equal(stored.bytes.includes(Buffer.from("restart-only secret")), false);
  original.dispose();

  const restartedStore = await new FilesystemObjectStore({ rootDir }).initialize();
  const restarted = createWorkerTranscriptArtifactService({ ...options, objectStore: restartedStore });
  const result = await restarted.read({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    objectScope: SCOPE,
    transcriptArtifactId: ref.transcriptArtifactId,
  });
  assert.equal(result.bytes.toString("utf8"), "restart-only secret");
  restarted.dispose();
});
