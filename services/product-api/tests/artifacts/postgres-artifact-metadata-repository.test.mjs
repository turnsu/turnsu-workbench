import assert from "node:assert/strict";
import test from "node:test";

import { PostgresArtifactMetadataRepository } from "../../src/artifacts/index.mjs";

class ScriptedStore {
  constructor(steps) { this.steps = [...steps]; }
  bindAdapter(factory) {
    return factory({
      execute: async (_uow, config) => {
        const step = this.steps.shift();
        assert.ok(step, `unexpected query: ${config.text}`);
        assert.match(config.text, step.match);
        if (step.assertValues) step.assertValues(config.values);
        return step.result ?? { rows: [], rowCount: 0 };
      },
    });
  }
  async withTransaction(work) { return work({ kind: "test-uow" }); }
  assertDrained() { assert.equal(this.steps.length, 0); }
}

const record = Object.freeze({
  schemaVersion: "workbench-v1",
  artifactId: "artifact-alpha",
  workspaceId: "workspace-alpha",
  objectId: "object-alpha",
  state: "pending",
  mediaType: "image/png",
  byteLength: 11,
  contentHash: `sha256:${"a".repeat(64)}`,
  ownerUserId: "user-alpha",
  invocationId: "invocation-alpha",
  attemptId: "attempt-alpha",
  fence: 3,
  capabilityLeaseId: "capability-alpha",
  requestedModelRevisionId: "model-requested",
  actualModelRevisionId: "model-actual",
  expiresAt: null,
  readyAt: null,
  failureCode: null,
  dimensions: { width: 1, height: 1 },
  generation: { seed: 1 },
  source: { kind: "model" },
  execution: { invocationId: "invocation-alpha", attemptId: "attempt-alpha", fence: 3 },
  objectScope: { kind: "workspace" },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

function row(overrides = {}) {
  return {
    schema_version: record.schemaVersion,
    artifact_id: record.artifactId,
    workspace_id: record.workspaceId,
    object_id: record.objectId,
    state: record.state,
    media_type: record.mediaType,
    byte_length: record.byteLength,
    content_hash: record.contentHash,
    owner_user_id: record.ownerUserId,
    invocation_id: record.invocationId,
    attempt_id: record.attemptId,
    execution_fence: record.fence,
    capability_lease_id: record.capabilityLeaseId,
    requested_model_revision_id: record.requestedModelRevisionId,
    actual_model_revision_id: record.actualModelRevisionId,
    expires_at: null,
    ready_at: null,
    failure_code: null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    payload: {
      dimensions: record.dimensions,
      generation: record.generation,
      source: record.source,
      execution: record.execution,
      objectScope: record.objectScope,
    },
    ...overrides,
  };
}

test("PostgreSQL Artifact metadata creates the governed object reference before pending metadata", async () => {
  const store = new ScriptedStore([
    {
      match: /INSERT INTO public\.product_objects/,
      assertValues(values) {
        assert.deepEqual(values.slice(0, 6), [
          record.workspaceId, record.objectId, record.contentHash, record.byteLength,
          record.mediaType, record.createdAt,
        ]);
        assert.deepEqual(JSON.parse(values[6]), { source: "artifact_metadata", artifactId: record.artifactId });
      },
    },
    {
      match: /INSERT INTO public\.product_artifact_metadata/,
      assertValues(values) {
        assert.equal(values[0], record.workspaceId);
        assert.equal(values[1], record.artifactId);
        assert.equal(values[11], record.fence);
        assert.equal(values[16], record.createdAt);
        assert.deepEqual(JSON.parse(values[18]).execution, record.execution);
      },
      result: { rows: [row()] },
    },
  ]);
  const repository = new PostgresArtifactMetadataRepository({ store });
  assert.deepEqual(await repository.createPending(record), record);
  store.assertDrained();
});

test("PostgreSQL Artifact metadata transitions only the matching fence and state", async () => {
  const readyAt = "2026-08-10T00:00:01.000Z";
  const store = new ScriptedStore([{
    match: /UPDATE public\.product_artifact_metadata/,
    assertValues(values) {
      assert.deepEqual(values.slice(0, 4), [record.workspaceId, record.artifactId, "pending", "ready"]);
      assert.equal(values[4], readyAt);
      assert.equal(values[8], record.fence);
    },
    result: { rows: [row({ state: "ready", ready_at: readyAt, updated_at: readyAt })] },
  }]);
  const repository = new PostgresArtifactMetadataRepository({ store });
  const transitioned = await repository.transition({
    workspaceId: record.workspaceId,
    artifactId: record.artifactId,
    expectedState: "pending",
    nextState: "ready",
    expectedFence: record.fence,
    patch: { readyAt, updatedAt: readyAt },
  });
  assert.equal(transitioned.state, "ready");
  assert.equal(transitioned.readyAt, readyAt);
  store.assertDrained();
});

test("PostgreSQL Artifact metadata list and delete keep workspace and expected-state predicates", async () => {
  const store = new ScriptedStore([
    {
      match: /FROM public\.product_artifact_metadata/,
      assertValues(values) {
        assert.deepEqual(values, [record.workspaceId, ["ready"], null, null,
          record.invocationId, record.attemptId, null, 3]);
      },
      result: { rows: [row({ state: "ready", ready_at: "2026-08-10T00:00:01.000Z" })] },
    },
    {
      match: /DELETE FROM public\.product_artifact_metadata/,
      assertValues(values) { assert.deepEqual(values, [record.workspaceId, record.artifactId, ["ready"]]); },
      result: { rows: [{ artifact_id: record.artifactId }] },
    },
  ]);
  const repository = new PostgresArtifactMetadataRepository({ store });
  const listed = await repository.list({
    workspaceId: record.workspaceId, states: ["ready"], invocationId: record.invocationId,
    attemptId: record.attemptId, limit: 3,
  });
  assert.equal(listed.length, 1);
  assert.equal(await repository.delete({
    workspaceId: record.workspaceId, artifactId: record.artifactId, expectedStates: ["ready"],
  }), true);
  store.assertDrained();
});
