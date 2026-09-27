import assert from "node:assert/strict";
import test from "node:test";

import { createProductArtifactMetadataRepositoryFixture } from "./product-artifact-metadata-repository-fixture.mjs";

function repositoryFixture() {
  const calls = [];
  const repository = {
    async create(record) { calls.push(["create", record]); return record; },
    async getById(artifactId, options) { calls.push(["getById", artifactId, options]); return { artifactId }; },
    async getReady() {},
    async listPending(options) { calls.push(["listPending", options]); return []; },
    async listForCleanup(options) { calls.push(["listForCleanup", options]); return []; },
    async markReady(artifactId, transition) { calls.push(["markReady", artifactId, transition]); return { artifactId, state: "ready" }; },
    async markFailed(artifactId, transition) { calls.push(["markFailed", artifactId, transition]); return { artifactId, state: "failed" }; },
    async delete(artifactId, options) { calls.push(["delete", artifactId, options]); return true; },
  };
  return { calls, adapter: createProductArtifactMetadataRepositoryFixture(repository) };
}

test("product Artifact repository adapter maps the governed metadata port without exposing collections", async () => {
  const { calls, adapter } = repositoryFixture();
  await adapter.createPending({ artifactId: "artifact-1", state: "pending" });
  await adapter.get({ workspaceId: "workspace-alpha", artifactId: "artifact-1" });
  await adapter.list({ workspaceId: "workspace-alpha", states: ["pending"], updatedBefore: "2026-07-18T08:00:00.000Z", limit: 5 });
  await adapter.list({ workspaceId: "workspace-alpha", states: ["ready"], expiresBefore: "2026-07-19T08:00:00.000Z", limit: 10 });
  await adapter.transition({
    workspaceId: "workspace-alpha",
    artifactId: "artifact-1",
    expectedState: "pending",
    nextState: "ready",
    expectedFence: 3,
    patch: { updatedAt: "2026-07-18T08:00:00.000Z" },
  });
  await adapter.delete({ workspaceId: "workspace-alpha", artifactId: "artifact-1", expectedStates: ["ready"] });

  assert.deepEqual(calls, [
    ["create", { artifactId: "artifact-1", state: "pending" }],
    ["getById", "artifact-1", { workspaceId: "workspace-alpha" }],
    ["listPending", { workspaceId: "workspace-alpha", before: "2026-07-18T08:00:00.000Z", limit: 5 }],
    ["listForCleanup", {
      workspaceId: "workspace-alpha",
      states: ["ready"],
      expiresBefore: "2026-07-19T08:00:00.000Z",
      limit: 10,
    }],
    ["markReady", "artifact-1", {
      workspaceId: "workspace-alpha",
      expectedState: "pending",
      expectedFence: 3,
      updatedAt: "2026-07-18T08:00:00.000Z",
    }],
    ["delete", "artifact-1", { workspaceId: "workspace-alpha", expectedStates: ["ready"] }],
  ]);
});

test("the test-only Artifact fixture resolves an injected repository Store lazily", async () => {
  const { calls, adapter: direct } = repositoryFixture();
  const repository = direct.repository;
  let connects = 0;
  const store = {
    repositories: null,
    async connect() {
      connects += 1;
      this.repositories = { productArtifacts: repository };
    },
  };
  const adapter = createProductArtifactMetadataRepositoryFixture(store);
  await adapter.get({ workspaceId: "workspace-alpha", artifactId: "artifact-1" });
  assert.equal(connects, 1);
  assert.deepEqual(calls, [["getById", "artifact-1", { workspaceId: "workspace-alpha" }]]);
});
