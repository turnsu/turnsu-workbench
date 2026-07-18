import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactMetadataSchema, Check } from "@looloomi/workbench-contracts";

import { ArtifactService, ArtifactServiceError, validateImageBytes } from "../../src/artifacts/index.mjs";
import { createFilesystemObjectStore, ObjectStoreError } from "../../src/storage/index.mjs";

const NOW = "2026-07-18T08:00:00.000Z";

class MetadataRepository {
  constructor() { this.records = new Map(); }

  async createPending(record) {
    if (this.records.has(record.artifactId)) throw new Error("artifact_exists");
    this.records.set(record.artifactId, structuredClone(record));
    return structuredClone(record);
  }

  async get({ workspaceId, artifactId }) {
    const record = this.records.get(artifactId);
    return record?.workspaceId === workspaceId ? structuredClone(record) : null;
  }

  async list({ workspaceId, states, expiresBefore, updatedBefore, invocationId, attemptId, objectId, limit = 100 }) {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId
        && (!states || states.includes(record.state))
        && (!expiresBefore || (record.expiresAt && record.expiresAt <= expiresBefore))
        && (!updatedBefore || record.updatedAt <= updatedBefore)
        && (!invocationId || record.execution?.invocationId === invocationId)
        && (!attemptId || record.execution?.attemptId === attemptId)
        && (!objectId || record.objectId === objectId))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async transition({ workspaceId, artifactId, expectedState, nextState, patch }) {
    const current = this.records.get(artifactId);
    if (!current || current.workspaceId !== workspaceId || current.state !== expectedState) return null;
    const next = { ...current, ...structuredClone(patch), state: nextState };
    this.records.set(artifactId, next);
    return structuredClone(next);
  }

  async delete({ workspaceId, artifactId, expectedStates }) {
    const current = this.records.get(artifactId);
    if (!current || current.workspaceId !== workspaceId || !expectedStates.includes(current.state)) return false;
    this.records.delete(artifactId);
    return true;
  }
}

class ExecutionChecker {
  constructor() {
    this.invocation = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-alpha",
      executionFence: 1,
      status: "running",
    };
    this.attempt = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      fence: 1,
      status: "running",
    };
    this.lease = {
      capabilityLeaseId: "lease-1",
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-alpha",
      fence: 1,
      status: "active",
      expiresAt: "2026-07-18T09:00:00.000Z",
    };
  }

  async getInvocation(id) { return id === this.invocation.invocationId ? structuredClone(this.invocation) : null; }
  async getAttempt(id) { return id === this.attempt.attemptId ? structuredClone(this.attempt) : null; }
  async getActiveLease(invocationId, attemptId, now) {
    return this.lease.status === "active"
      && this.lease.invocationId === invocationId
      && this.lease.attemptId === attemptId
      && this.lease.expiresAt > now
      ? structuredClone(this.lease)
      : null;
  }
}

async function fixture(t, { objectStore: suppliedObjectStore, idFactory } = {}) {
  const root = await mkdtemp(join(tmpdir(), "looloomi-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadataRepository = new MetadataRepository();
  const executionPersistence = new ExecutionChecker();
  const objectStore = suppliedObjectStore ?? await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 2048 });
  let sequence = 0;
  const service = new ArtifactService({
    metadataRepository,
    executionPersistence,
    objectStore,
    clock: () => NOW,
    idFactory: idFactory ?? (() => `artifact-${++sequence}`),
    maxArtifactBytes: 1024,
  });
  return { root, metadataRepository, executionPersistence, objectStore, service };
}

function execution() {
  return { invocationId: "invocation-1", attemptId: "attempt-1", capabilityLeaseId: "lease-1", fence: 1 };
}

function modelMetadata() {
  return {
    source: {
      kind: "agent_turn",
      sessionId: "session-1",
      turnId: "turn-1",
      invocationId: "invocation-1",
      attemptId: "attempt-1",
    },
    requestedModelRevisionId: "model-revision-requested-1",
    actualModelRevisionId: "model-revision-actual-1",
  };
}

function png({ width = 2, height = 3 } = {}) {
  const bytes = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  return bytes;
}

function jpeg({ width = 3, height = 2 } = {}) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webp({ width = 4, height = 5 } = {}) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  writeUInt24LE(bytes, width - 1, 24);
  writeUInt24LE(bytes, height - 1, 27);
  return bytes;
}

function losslessWebp({ width = 6, height = 7 } = {}) {
  const bytes = Buffer.alloc(26);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(18, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8L", 12, "ascii");
  bytes.writeUInt32LE(5, 16);
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return bytes;
}

function writeUInt24LE(bytes, value, offset) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

test("governed image commit quarantines, fences, promotes, and exposes only ready product metadata", async (t) => {
  const { service, metadataRepository, objectStore } = await fixture(t);
  const artifact = await service.commitImage({
    workspaceId: "workspace-alpha",
    execution: execution(),
    ...modelMetadata(),
    bytes: png(),
    mediaType: "image/png",
    expectedDimensions: { width: 2, height: 3 },
    format: "png",
    seed: 42,
    safetyStatus: "safe",
    expiresAt: "2026-07-19T08:00:00.000Z",
  });

  assert.deepEqual(artifact.dimensions, { width: 2, height: 3 });
  assert.equal(artifact.schemaVersion, "workbench-v1");
  assert.equal(artifact.workspaceId, "workspace-alpha");
  assert.deepEqual(artifact.source, modelMetadata().source);
  assert.equal(artifact.state, "ready");
  assert.equal(Check(ArtifactMetadataSchema, artifact), true);
  assert.deepEqual(Object.keys(artifact).sort(), [
    "actualModelRevisionId",
    "artifactId",
    "byteLength",
    "contentHash",
    "createdAt",
    "dimensions",
    "expiresAt",
    "mediaType",
    "requestedModelRevisionId",
    "schemaVersion",
    "source",
    "state",
    "workspaceId",
  ]);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of ["objectId", "execution", "capabilityLeaseId", "path", "bytes", "base64", "provider", "generation"]) {
    assert.equal(serialized.includes(forbidden), false, `public artifact exposed ${forbidden}`);
  }

  const internal = metadataRepository.records.get(artifact.artifactId);
  assert.equal(internal.state, "ready");
  assert.equal(internal.objectId.startsWith("object-artifact-"), true);
  assert.equal(JSON.stringify(internal).includes(png().toString("base64")), false);
  assert.equal((await objectStore.stat({ workspaceId: "workspace-alpha", objectId: internal.objectId })).state, "promoted");

  const content = await service.readContent({ workspaceId: "workspace-alpha", artifactId: artifact.artifactId });
  assert.deepEqual(content.bytes, png());
  assert.equal(content.headers["Content-Type"], "image/png");
  assert.equal(content.headers["Content-Length"], String(png().byteLength));
  assert.match(content.headers.ETag, /^"sha256:[a-f0-9]{64}"$/);
  assert.equal(content.headers["X-Content-Type-Options"], "nosniff");
});

test("artifact lookup makes cross-workspace and non-ready records indistinguishable", async (t) => {
  const { service, metadataRepository } = await fixture(t);
  const ready = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
  });
  const internal = metadataRepository.records.get(ready.artifactId);
  metadataRepository.records.set("artifact-pending", { ...internal, artifactId: "artifact-pending", state: "pending" });

  for (const request of [
    { workspaceId: "workspace-beta", artifactId: ready.artifactId },
    { workspaceId: "workspace-alpha", artifactId: "artifact-missing" },
    { workspaceId: "workspace-alpha", artifactId: "artifact-pending" },
  ]) {
    await assert.rejects(
      service.getMetadata(request),
      (error) => error instanceof ArtifactServiceError
        && error.code === "artifact_not_found"
        && error.message === "The requested artifact was not found.",
    );
  }
});

test("PNG, JPEG, and WebP signatures and dimensions are validated against declared MIME", () => {
  assert.deepEqual(validateImageBytes(png({ width: 7, height: 9 }), "image/png"), { width: 7, height: 9 });
  assert.deepEqual(validateImageBytes(jpeg({ width: 11, height: 13 }), "image/jpeg"), { width: 11, height: 13 });
  assert.deepEqual(validateImageBytes(webp({ width: 17, height: 19 }), "image/webp"), { width: 17, height: 19 });
  assert.deepEqual(validateImageBytes(losslessWebp({ width: 23, height: 29 }), "image/webp"), { width: 23, height: 29 });
  assert.throws(() => validateImageBytes(png(), "image/jpeg"), { code: "artifact_image_signature_invalid" });
  assert.throws(() => validateImageBytes(Buffer.from("not an image"), "image/png"), { code: "artifact_image_signature_invalid" });
  assert.throws(() => validateImageBytes(png({ width: 100, height: 100 }), "image/png", { maxPixels: 9_999 }), {
    code: "artifact_image_dimensions_invalid",
  });
  const truncated = webp();
  truncated.writeUInt32LE(1024, 16);
  assert.throws(() => validateImageBytes(truncated, "image/webp"), { code: "artifact_image_invalid" });
});

test("artifact bytes are bounded and strings cannot become persisted Base64 payloads", async (t) => {
  const { service, metadataRepository, objectStore } = await fixture(t);
  await assert.rejects(
    service.commitImage({
      workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: "iVBORw0KGgo=", mediaType: "image/png",
    }),
    (error) => error.code === "artifact_bytes_invalid",
  );
  await assert.rejects(
    service.commitImage({
      workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: Buffer.alloc(1025), mediaType: "image/png",
    }),
    (error) => error.code === "artifact_too_large",
  );
  await assert.rejects(
    service.commitImage({
      workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
      expectedDimensions: { width: 3, height: 2 },
    }),
    (error) => error.code === "artifact_image_dimensions_mismatch",
  );
  assert.equal(metadataRepository.records.size, 0);
  assert.deepEqual(await objectStore.list({ workspaceId: "workspace-alpha" }), []);
});

test("a fence revoked after quarantine or promotion cannot leave a ready artifact", async (t) => {
  for (const fencePoint of ["put", "promote"]) {
    await t.test(fencePoint, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `looloomi-artifact-fence-${fencePoint}-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const base = await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 2048 });
      const metadataRepository = new MetadataRepository();
      const executionPersistence = new ExecutionChecker();
      const objectStore = new Proxy(base, {
        get(target, property) {
          if (property !== fencePoint) return typeof target[property] === "function" ? target[property].bind(target) : target[property];
          return async (...args) => {
            const result = await target[property](...args);
            executionPersistence.lease.status = "revoked";
            executionPersistence.invocation.status = "cancelled";
            executionPersistence.attempt.status = "cancelled";
            return result;
          };
        },
      });
      const service = new ArtifactService({
        metadataRepository, executionPersistence, objectStore, clock: () => NOW,
        idFactory: () => `artifact-fenced-${fencePoint}`, maxArtifactBytes: 1024,
      });
      await assert.rejects(
        service.commitImage({
          workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
        }),
        (error) => error.code === "artifact_execution_fenced",
      );
      assert.equal([...metadataRepository.records.values()].some((record) => record.state === "ready"), false);
      assert.deepEqual(await base.list({ workspaceId: "workspace-alpha" }), []);
    });
  }
});

test("a fence revoked while ready metadata is committed is rolled back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-artifact-ready-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objectStore = await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 2048 });
  const executionPersistence = new ExecutionChecker();
  class RacingMetadataRepository extends MetadataRepository {
    async transition(input) {
      const result = await super.transition(input);
      if (input.nextState === "ready") {
        executionPersistence.lease.status = "revoked";
        executionPersistence.invocation.status = "cancelled";
        executionPersistence.attempt.status = "cancelled";
      }
      return result;
    }
  }
  const metadataRepository = new RacingMetadataRepository();
  const service = new ArtifactService({
    metadataRepository,
    executionPersistence,
    objectStore,
    clock: () => NOW,
    idFactory: () => "artifact-ready-fenced",
    maxArtifactBytes: 1024,
  });

  await assert.rejects(
    service.commitImage({
      workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
    }),
    (error) => error.code === "artifact_execution_fenced",
  );
  assert.equal(metadataRepository.records.size, 0);
  assert.deepEqual(await objectStore.list({ workspaceId: "workspace-alpha" }), []);
});

test("reconciliation recovers active pending metadata and removes fenced and orphaned objects", async (t) => {
  const { service, metadataRepository, executionPersistence, objectStore } = await fixture(t);
  const bytes = png();
  const baseRecord = {
    schemaVersion: "workbench-v1",
    workspaceId: "workspace-alpha",
    state: "pending",
    mediaType: "image/png",
    byteLength: bytes.byteLength,
    contentHash: hash(bytes),
    dimensions: { width: 2, height: 3 },
    generation: { format: "png" },
    ...modelMetadata(),
    invocationId: "invocation-1",
    attemptId: "attempt-1",
    fence: 1,
    capabilityLeaseId: "lease-1",
    execution: execution(),
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    failureCode: null,
  };
  const active = { ...baseRecord, artifactId: "artifact-active", objectId: "object-artifact-active" };
  await metadataRepository.createPending(active);
  await objectStore.put({
    workspaceId: "workspace-alpha", objectId: active.objectId, bytes,
    contentHash: active.contentHash, mediaType: active.mediaType,
    metadata: { source: "product-artifact", artifactId: active.artifactId },
  });

  const fenced = { ...baseRecord, artifactId: "artifact-fenced", objectId: "object-artifact-fenced", execution: { ...execution(), fence: 2 } };
  await metadataRepository.createPending(fenced);
  await objectStore.put({
    workspaceId: "workspace-alpha", objectId: fenced.objectId, bytes,
    contentHash: fenced.contentHash, mediaType: fenced.mediaType,
    metadata: { source: "product-artifact", artifactId: fenced.artifactId },
  });

  await objectStore.put({
    workspaceId: "workspace-alpha", objectId: "object-artifact-orphan", bytes,
    mediaType: "image/png", metadata: { source: "product-artifact", artifactId: "artifact-orphan" },
  });
  await objectStore.promote({ workspaceId: "workspace-alpha", objectId: "object-artifact-orphan" });

  const result = await service.reconcile({ workspaceId: "workspace-alpha" });
  assert.deepEqual(result, { inspected: 2, recovered: 1, deleted: 0, failed: 1, orphansDeleted: 1 });
  assert.equal((await metadataRepository.get({ workspaceId: "workspace-alpha", artifactId: active.artifactId })).state, "ready");
  assert.equal((await metadataRepository.get({ workspaceId: "workspace-alpha", artifactId: fenced.artifactId })).state, "failed");
  await assert.rejects(
    objectStore.stat({ workspaceId: "workspace-alpha", objectId: fenced.objectId }),
    (error) => error instanceof ObjectStoreError && error.code === "object_not_found",
  );
  await assert.rejects(
    objectStore.stat({ workspaceId: "workspace-alpha", objectId: "object-artifact-orphan" }),
    (error) => error instanceof ObjectStoreError && error.code === "object_not_found",
  );
  assert.equal(executionPersistence.invocation.status, "running");
});

test("reconciliation removes a ready Artifact whose authoritative attempt failed", async (t) => {
  const { service, metadataRepository, executionPersistence, objectStore } = await fixture(t);
  const artifact = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
  });
  executionPersistence.lease.status = "revoked";
  executionPersistence.invocation.status = "failed";
  executionPersistence.attempt.status = "failed";

  const result = await service.reconcile({ workspaceId: "workspace-alpha" });
  assert.deepEqual(result, { inspected: 1, recovered: 0, deleted: 1, failed: 0, orphansDeleted: 0 });
  assert.equal(await metadataRepository.get({ workspaceId: "workspace-alpha", artifactId: artifact.artifactId }), null);
  assert.deepEqual(await objectStore.list({ workspaceId: "workspace-alpha" }), []);
});

test("retention and failed-attempt cleanup hide metadata and delete promoted bytes", async (t) => {
  const { service, metadataRepository, objectStore } = await fixture(t);
  const expiring = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
    expiresAt: "2026-07-18T08:30:00.000Z",
  });
  const retained = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: webp(), mediaType: "image/webp",
  });

  assert.deepEqual(await service.cleanupExpired({ workspaceId: "workspace-alpha", now: "2026-07-18T09:00:00.000Z" }), {
    inspected: 1,
    deleted: 1,
  });
  assert.equal(await metadataRepository.get({ workspaceId: "workspace-alpha", artifactId: expiring.artifactId }), null);
  await assert.rejects(service.getMetadata({ workspaceId: "workspace-alpha", artifactId: expiring.artifactId }), {
    code: "artifact_not_found",
  });

  assert.deepEqual(await service.cleanupAttempt({
    workspaceId: "workspace-alpha", invocationId: "invocation-1", attemptId: "attempt-1",
  }), { inspected: 1, deleted: 1 });
  assert.equal(await metadataRepository.get({ workspaceId: "workspace-alpha", artifactId: retained.artifactId }), null);
  assert.deepEqual(await objectStore.list({ workspaceId: "workspace-alpha" }), []);
});

test("content-addressed duplicate Artifacts retain shared bytes until the last reference is deleted", async (t) => {
  const { service, metadataRepository, objectStore } = await fixture(t);
  const first = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
  });
  const second = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: png(), mediaType: "image/png",
  });
  const firstRecord = metadataRepository.records.get(first.artifactId);
  const secondRecord = metadataRepository.records.get(second.artifactId);
  assert.equal(firstRecord.objectId, secondRecord.objectId);
  assert.equal((await objectStore.list({ workspaceId: "workspace-alpha" })).length, 1);

  assert.deepEqual(await service.delete({ workspaceId: "workspace-alpha", artifactId: first.artifactId }), { deleted: true });
  assert.deepEqual((await service.readContent({ workspaceId: "workspace-alpha", artifactId: second.artifactId })).bytes, png());
  assert.equal((await objectStore.list({ workspaceId: "workspace-alpha" })).length, 1);

  assert.deepEqual(await service.delete({ workspaceId: "workspace-alpha", artifactId: second.artifactId }), { deleted: true });
  assert.deepEqual(await objectStore.list({ workspaceId: "workspace-alpha" }), []);
});

test("ready Artifact metadata and content survive service and object-store restart", async (t) => {
  const { root, service, metadataRepository, executionPersistence } = await fixture(t);
  const artifact = await service.commitImage({
    workspaceId: "workspace-alpha", execution: execution(), ...modelMetadata(), bytes: jpeg(), mediaType: "image/jpeg",
  });
  const restartedObjectStore = await createFilesystemObjectStore({ rootDir: root, maxObjectBytes: 2048 });
  const restarted = new ArtifactService({
    metadataRepository,
    executionPersistence,
    objectStore: restartedObjectStore,
    clock: () => NOW,
    idFactory: () => "artifact-after-restart",
    maxArtifactBytes: 1024,
  });

  assert.equal((await restarted.getMetadata({ workspaceId: "workspace-alpha", artifactId: artifact.artifactId })).artifactId, artifact.artifactId);
  assert.deepEqual((await restarted.readContent({ workspaceId: "workspace-alpha", artifactId: artifact.artifactId })).bytes, jpeg());
});

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
