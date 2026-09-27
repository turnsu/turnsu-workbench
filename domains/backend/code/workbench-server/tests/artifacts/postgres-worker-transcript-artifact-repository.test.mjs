import assert from "node:assert/strict";
import test from "node:test";

import { PostgresWorkerTranscriptArtifactRepository } from "../../src/artifacts/index.mjs";

class ScriptedStore {
  constructor(steps) { this.steps = [...steps]; }
  bindAdapter(factory) {
    return factory({ execute: async (_uow, config) => {
      const step = this.steps.shift();
      assert.ok(step, `unexpected query: ${config.text}`);
      assert.match(config.text, step.match);
      if (step.values) step.values(config.values);
      return step.result ?? { rows: [] };
    } });
  }
  async withTransaction(work) { return work({ kind: "test-uow" }); }
  assertDrained() { assert.equal(this.steps.length, 0); }
}

const record = Object.freeze({
  schemaVersion: "workbench-v1",
  transcriptArtifactId: "worker-transcript-alpha",
  artifactKind: "worker_transcript",
  workspaceId: "workspace-alpha",
  ownerUserId: "user-alpha",
  objectScope: { objectKind: "agent_session", objectId: "session-alpha" },
  invocationId: "invocation-alpha",
  attemptId: "attempt-alpha",
  sensitivity: "sensitive",
  state: "pending",
  objectId: "object-worker-transcript-alpha",
  mediaType: "application/json",
  byteLength: 31,
  contentHash: `sha256:${"a".repeat(64)}`,
  ciphertextByteLength: 47,
  ciphertextHash: `sha256:${"b".repeat(64)}`,
  encryption: {
    envelopeVersion: "worker-transcript-envelope-v1",
    algorithm: "AES-256-GCM",
    keyId: "transcript-key-v1",
    ivBase64: "AAAAAAAAAAAAAAAA",
    authTagBase64: "AAAAAAAAAAAAAAAAAAAAAA==",
    aadHash: `sha256:${"c".repeat(64)}`,
  },
  expiresAt: "2026-08-11T00:00:00.000Z",
  readyAt: null,
  deletedAt: null,
  deletionReason: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

function row(overrides = {}) {
  return {
    schema_version: record.schemaVersion,
    transcript_artifact_id: record.transcriptArtifactId,
    artifact_kind: record.artifactKind,
    workspace_id: record.workspaceId,
    owner_user_id: record.ownerUserId,
    object_scope_kind: record.objectScope.objectKind,
    object_scope_id: record.objectScope.objectId,
    invocation_id: record.invocationId,
    attempt_id: record.attemptId,
    sensitivity: record.sensitivity,
    state: record.state,
    object_id: record.objectId,
    media_type: record.mediaType,
    byte_length: record.byteLength,
    content_hash: record.contentHash,
    ciphertext_byte_length: record.ciphertextByteLength,
    ciphertext_hash: record.ciphertextHash,
    encryption: record.encryption,
    expires_at: record.expiresAt,
    ready_at: null,
    deleted_at: null,
    deletion_reason: null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...overrides,
  };
}

test("PostgreSQL Worker transcript metadata stores only encrypted-object metadata before pending state", async () => {
  const store = new ScriptedStore([
    {
      match: /INSERT INTO public\.product_objects/,
      values(values) {
        assert.deepEqual(values.slice(0, 5), [
          record.workspaceId, record.objectId, record.ciphertextHash,
          record.ciphertextByteLength, record.createdAt,
        ]);
        assert.equal(JSON.stringify(values).includes("plaintext"), false);
      },
    },
    {
      match: /INSERT INTO public\.worker_transcript_artifacts/,
      values(values) {
        assert.deepEqual(values.slice(0, 10), [
          record.workspaceId, record.transcriptArtifactId, record.schemaVersion, record.objectId,
          record.ownerUserId, record.objectScope.objectKind, record.objectScope.objectId,
          record.invocationId, record.attemptId, "pending",
        ]);
        assert.deepEqual(JSON.parse(values[15]), record.encryption);
      },
      result: { rows: [row()] },
    },
  ]);
  const repository = new PostgresWorkerTranscriptArtifactRepository({ store });
  assert.deepEqual(await repository.createPending(record), record);
  store.assertDrained();
});

test("PostgreSQL Worker transcript transition keeps state/object promotion atomic and audit stays safe", async () => {
  const readyAt = "2026-08-10T00:01:00.000Z";
  const store = new ScriptedStore([
    {
      match: /WITH updated AS \([\s\S]*UPDATE public\.worker_transcript_artifacts[\s\S]*UPDATE public\.product_objects/,
      values(values) {
        assert.deepEqual(values.slice(0, 5), [
          record.workspaceId, record.transcriptArtifactId, "pending", "ready", readyAt,
        ]);
      },
      result: { rows: [row({ state: "ready", ready_at: readyAt, updated_at: readyAt })] },
    },
    {
      match: /INSERT INTO public\.worker_transcript_audit_events/,
      values(values) {
        assert.deepEqual(values, [
          record.workspaceId, record.transcriptArtifactId, record.ownerUserId,
          "worker_transcript_artifact.read", "allowed", null,
          record.objectScope.objectKind, record.objectScope.objectId,
          record.invocationId, record.attemptId, readyAt,
        ]);
      },
    },
  ]);
  const repository = new PostgresWorkerTranscriptArtifactRepository({ store });
  const transitioned = await repository.transition({
    workspaceId: record.workspaceId,
    transcriptArtifactId: record.transcriptArtifactId,
    expectedState: "pending",
    nextState: "ready",
    patch: { readyAt, updatedAt: readyAt },
  });
  assert.equal(transitioned.state, "ready");
  await repository.appendAudit({
    workspaceId: record.workspaceId,
    transcriptArtifactId: record.transcriptArtifactId,
    actorUserId: record.ownerUserId,
    action: "worker_transcript_artifact.read",
    outcome: "allowed",
    reasonCode: null,
    objectScope: record.objectScope,
    invocationId: record.invocationId,
    attemptId: record.attemptId,
    occurredAt: readyAt,
  });
  store.assertDrained();
});

test("PostgreSQL Worker transcript list always scopes state and expiry inside the query", async () => {
  const store = new ScriptedStore([{
    match: /FROM public\.worker_transcript_artifacts/,
    values(values) {
      assert.deepEqual(values, [record.workspaceId, ["ready"], record.expiresAt, 3]);
    },
    result: { rows: [row({ state: "ready", ready_at: record.updatedAt })] },
  }]);
  const repository = new PostgresWorkerTranscriptArtifactRepository({ store });
  const records = await repository.list({
    workspaceId: record.workspaceId, states: ["ready"], expiresBefore: record.expiresAt, limit: 3,
  });
  assert.equal(records[0].transcriptArtifactId, record.transcriptArtifactId);
  store.assertDrained();
});
