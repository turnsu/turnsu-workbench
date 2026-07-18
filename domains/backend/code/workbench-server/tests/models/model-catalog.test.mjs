import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  Check,
  ModelProfileSummarySchema,
  WorkspaceModelRoutingPolicySchema,
} from "@looloomi/workbench-contracts";

import {
  createKeychainCredentialResolver,
  ModelCatalog,
  ModelCatalogImporter,
  normalizeModelProfileConfiguration,
} from "../../src/models/index.mjs";
import {
  ModelProfileRepository,
  ModelProfileRevisionRepository,
  ProductArtifactRepository,
  WorkspaceModelRoutingPolicyRepository,
} from "../../src/store/repositories.mjs";

test("ModelCatalogImporter converges concurrent imports, reuses hashes, and advances only for new config", async () => {
  const fixture = catalogFixture();
  const configuration = {
    profiles: [chatProfile({ defaults: { temperature: 0.2, maxOutputTokens: 2_048 } })],
  };

  const [left, right] = await Promise.all([
    fixture.importer.importConfiguration(configuration),
    fixture.importer.importConfiguration({
      profiles: [chatProfile({ defaults: { maxOutputTokens: 2_048, temperature: 0.2 } })],
    }),
  ]);

  assert.equal(fixture.collections.revisions.documents.length, 1);
  assert.equal(left.profiles[0].revision.revisionId, right.profiles[0].revision.revisionId);
  assert.deepEqual([left.profiles[0].reused, right.profiles[0].reused].sort(), [false, true]);
  assert.match(left.profiles[0].revision.configHash, /^sha256:[a-f0-9]{64}$/);

  const changed = await fixture.importer.importConfiguration({
    profiles: [chatProfile({ providerModelId: "gpt-next" })],
  });
  assert.equal(changed.profiles[0].revision.revisionNumber, 2);
  assert.equal(fixture.collections.profiles.documents[0].currentRevisionId, changed.profiles[0].revision.revisionId);
  assert.equal(fixture.collections.revisions.documents.length, 2);

  const restored = await fixture.importer.importConfiguration(configuration);
  assert.equal(restored.profiles[0].reused, true);
  assert.equal(restored.profiles[0].revision.revisionNumber, 1);
  assert.equal(fixture.collections.profiles.documents[0].currentRevisionId, restored.profiles[0].revision.revisionId);

  await assert.rejects(
    fixture.repositories.modelProfileRevisions.update(restored.profiles[0].revision.revisionId, {}),
    (error) => error?.code === "model_profile_revision_immutable",
  );
  await assert.rejects(
    fixture.repositories.modelProfileRevisions.delete(restored.profiles[0].revision.revisionId),
    (error) => error?.code === "model_profile_revision_immutable",
  );
});

test("ModelCatalog applies global/workspace authorization before list and resolve", async () => {
  const fixture = catalogFixture();
  await fixture.importer.importConfiguration({ profiles: [chatProfile({ profileId: "global-chat" })] });
  const workspaceA = await fixture.importer.importConfiguration({
    profiles: [chatProfile({ profileId: "workspace-a-chat", scope: "workspace", workspaceId: "workspace-a" })],
  });
  const workspaceB = await fixture.importer.importConfiguration({
    profiles: [chatProfile({ profileId: "workspace-b-chat", scope: "workspace", workspaceId: "workspace-b" })],
  });
  await fixture.importer.importConfiguration({
    profiles: [{
      profileId: "global-image",
      displayName: "Global image",
      provider: "stability",
      protocol: "stability_image_v2",
      providerModelId: "stable-image-core",
      capabilities: ["image_generation"],
      credentialRef: "stability",
      scope: "global",
      enabled: true,
    }],
  });

  const workspaceAChat = await fixture.catalog.listProfiles({
    workspaceId: "workspace-a",
    capabilities: ["chat", "tool_calling"],
  });
  assert.deepEqual(workspaceAChat.map((entry) => entry.profileId), ["global-chat", "workspace-a-chat"]);
  assert.ok(workspaceAChat.every((entry) => Check(ModelProfileSummarySchema, entry)));
  assert.equal(Object.hasOwn(workspaceAChat[0].currentRevision, "credentialRef"), false);
  assert.equal(Object.hasOwn(workspaceAChat[0].currentRevision, "endpoint"), false);
  for (const field of ["protocol", "providerModelId", "defaults", "policyVersion", "configHash"]) {
    assert.equal(Object.hasOwn(workspaceAChat[0].currentRevision, field), false, field);
  }

  const images = await fixture.catalog.listProfiles({ workspaceId: "workspace-a", capabilities: ["image_generation"] });
  assert.deepEqual(images.map((entry) => entry.profileId), ["global-image"]);

  await assert.rejects(
    fixture.catalog.resolveRevision({
      revisionId: workspaceB.profiles[0].revision.revisionId,
      workspaceId: "workspace-a",
      requireReady: false,
    }),
    (error) => error?.code === "model_profile_forbidden",
  );
  const internal = await fixture.catalog.resolveRevision({
    revisionId: workspaceA.profiles[0].revision.revisionId,
    workspaceId: "workspace-a",
  });
  assert.equal(internal.revision.credentialRef, "openai-main");
});

test("workspace routing policy imports idempotently and updates with a version CAS", async () => {
  const fixture = catalogFixture();
  await fixture.importer.importConfiguration({
    profiles: [chatProfile({ profileId: "workspace-chat", scope: "workspace", workspaceId: "workspace-a" })],
  });
  const input = {
    workspaceId: "workspace-a",
    defaultProfileIdsByCapability: { chat: "workspace-chat", tool_calling: "workspace-chat" },
    workflowFallbackAllowed: false,
  };
  const first = await fixture.catalog.importWorkspacePolicy(input);
  const replay = await fixture.catalog.importWorkspacePolicy(input);
  const changed = await fixture.catalog.importWorkspacePolicy({ ...input, workflowFallbackAllowed: true });

  assert.equal(first.policy.policyVersion, "1");
  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(replay.policy.policyVersion, "1");
  assert.equal(changed.policy.policyVersion, "2");
  assert.equal(Check(WorkspaceModelRoutingPolicySchema, changed.policy), true);
  assert.equal((await fixture.catalog.getWorkspacePolicy("workspace-a")).workflowFallbackAllowed, true);
  const [summary] = await fixture.catalog.listProfiles({ workspaceId: "workspace-a", capabilities: ["chat"] });
  assert.deepEqual(summary.defaultForCapabilities, ["chat", "tool_calling"]);
  await assert.rejects(
    fixture.catalog.importWorkspacePolicy({
      ...input,
      defaultProfileIdsByCapability: { image_generation: "workspace-chat" },
    }),
    (error) => error?.code === "model_capability_mismatch",
  );
});

test("profile current-revision CAS and Artifact transitions enforce current state, fence, and workspace", async () => {
  const profiles = new ModelProfileRepository(new FakeCollection({ uniqueKeys: [["profileId"]] }));
  await profiles.insert({
    profileId: "profile-a",
    displayName: "A",
    scope: "global",
    enabled: true,
    currentRevisionId: "revision-1",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(await profiles.advanceCurrentRevision("profile-a", {
    expectedCurrentRevisionId: "stale",
    currentRevisionId: "revision-2",
    updatedAt: "2026-07-18T00:00:01.000Z",
  }), null);
  assert.equal((await profiles.advanceCurrentRevision("profile-a", {
    expectedCurrentRevisionId: "revision-1",
    currentRevisionId: "revision-2",
    updatedAt: "2026-07-18T00:00:01.000Z",
  })).currentRevisionId, "revision-2");

  const artifacts = new ProductArtifactRepository(new FakeCollection({ uniqueKeys: [["artifactId"]] }));
  assert.throws(() => artifacts.create({
    artifactId: "artifact-invalid",
    workspaceId: "workspace-a",
    attemptId: "attempt-a",
    state: "ready",
    fence: 7,
  }), /product_artifact_initial_metadata_invalid/);
  await artifacts.create({
    artifactId: "artifact-a",
    workspaceId: "workspace-a",
    attemptId: "attempt-a",
    state: "pending",
    fence: 7,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(await artifacts.getById("artifact-a", { workspaceId: "workspace-b" }), null);
  assert.deepEqual((await artifacts.listForCleanup({
    workspaceId: "workspace-a",
    states: ["pending"],
    attemptId: "attempt-a",
    before: "2026-07-18T00:00:01.000Z",
  })).map(({ artifactId }) => artifactId), ["artifact-a"]);
  assert.throws(() => artifacts.listForCleanup({ states: ["pending"] }), /artifact_workspace_id_required/);
  assert.equal(await artifacts.markReady("artifact-a", {
    workspaceId: "workspace-a",
    expectedFence: 6,
    readyAt: "2026-07-18T00:00:01.000Z",
  }), null);
  const ready = await artifacts.markReady("artifact-a", {
    workspaceId: "workspace-a",
    expectedFence: 7,
    readyAt: "2026-07-18T00:00:01.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
  });
  assert.equal(ready.state, "ready");
  assert.equal((await artifacts.getReady("artifact-a", { workspaceId: "workspace-a" })).state, "ready");
  assert.equal(await artifacts.markFailed("artifact-a", {
    workspaceId: "workspace-a",
    expectedFence: 7,
    failureCode: "late_failure",
  }), null);
  assert.equal(await artifacts.delete("artifact-a", { workspaceId: "workspace-b" }), false);
  assert.equal(await artifacts.delete("artifact-a", { workspaceId: "workspace-a", expectedStates: ["ready"] }), true);
});

test("config normalization rejects secrets and incompatible protocols, with explicit loopback opt-in", () => {
  assert.throws(
    () => normalizeModelProfileConfiguration({ ...chatProfile(), apiKey: "do-not-store" }),
    /model_profile_operator_field_forbidden:apiKey/,
  );
  assert.throws(
    () => normalizeModelProfileConfiguration({
      ...chatProfile(),
      defaults: { secret: "do-not-store" },
    }),
    /model_profile_operator_field_forbidden:secret/,
  );
  assert.throws(
    () => normalizeModelProfileConfiguration({
      profileId: "stability-ultra",
      displayName: "Unsupported Stability model",
      provider: "stability",
      protocol: "stability_image_v2",
      providerModelId: "stable-image-ultra",
      capabilities: ["image_generation"],
      credentialRef: "stability",
    }),
    /model_provider_model_unsupported/,
  );
  assert.throws(
    () => normalizeModelProfileConfiguration({
      ...chatProfile(),
      capabilities: ["image_generation"],
    }),
    /model_capability_protocol_mismatch/,
  );
  assert.throws(
    () => normalizeModelProfileConfiguration({ ...chatProfile(), endpoint: "http://127.0.0.1:9000/v1" }),
    /model_provider_endpoint_invalid/,
  );
  assert.equal(normalizeModelProfileConfiguration(
    { ...chatProfile(), endpoint: "http://127.0.0.1:9000/v1" },
    { allowLoopbackEndpoints: true },
  ).revision.endpoint, "http://127.0.0.1:9000/v1");
});

test("Keychain resolver is lazy, bounded, and maps helper failures without exposing credential identity", async () => {
  const calls = [];
  const resolver = createKeychainCredentialResolver({
    service: "com.looloomi.workbench.test",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild({ code: 0, stdout: "secret-value\n" });
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(await resolver.resolve("openai-main"), "secret-value");
  assert.deepEqual(calls[0].args, [
    "find-generic-password", "-w", "-s", "com.looloomi.workbench.test", "-a", "model-credential:openai-main",
  ]);
  assert.equal(calls[0].command, "/usr/bin/security");

  const missing = createKeychainCredentialResolver({
    service: "com.looloomi.workbench.test",
    spawnProcess: () => fakeChild({ code: 44, stderr: "not found: openai-main" }),
  });
  await assert.rejects(
    missing.resolve("openai-main"),
    (error) => error?.code === "credential_unavailable"
      && error.productSafe === true
      && !error.message.includes("openai-main"),
  );

  const oversized = createKeychainCredentialResolver({
    service: "com.looloomi.workbench.test",
    maxOutputBytes: 8,
    spawnProcess: () => fakeChild({ code: 0, stdout: "123456789" }),
  });
  await assert.rejects(oversized.resolve("openai-main"), (error) => error?.code === "credential_unavailable");
});

function chatProfile(overrides = {}) {
  return {
    profileId: "openai-chat",
    displayName: "OpenAI chat",
    provider: "openai",
    protocol: "openai_compatible_chat",
    providerModelId: "gpt-model",
    capabilities: ["chat", "tool_calling", "structured_output"],
    parameterSchemaVersion: "model-parameters-v1",
    defaults: {},
    limits: { maxOutputTokens: 4096 },
    credentialRef: "openai-main",
    endpoint: "https://api.openai.com/v1",
    policyVersion: 1,
    scope: "global",
    enabled: true,
    ...overrides,
  };
}

function catalogFixture() {
  const collections = {
    profiles: new FakeCollection({ uniqueKeys: [["profileId"]] }),
    revisions: new FakeCollection({
      uniqueKeys: [["revisionId"], ["profileId", "revisionNumber"], ["profileId", "configHash"]],
    }),
    policies: new FakeCollection({ uniqueKeys: [["workspaceId"]] }),
  };
  const repositories = {
    modelProfiles: new ModelProfileRepository(collections.profiles),
    modelProfileRevisions: new ModelProfileRevisionRepository(collections.revisions),
    modelRoutingPolicies: new WorkspaceModelRoutingPolicyRepository(collections.policies),
  };
  let tail = Promise.resolve();
  const withTransaction = (operation) => {
    const result = tail.then(() => operation({ transaction: true }));
    tail = result.catch(() => {});
    return result;
  };
  let sequence = 0;
  const catalog = new ModelCatalog({
    repositories,
    withTransaction,
    clock: () => new Date("2026-07-18T00:00:00.000Z"),
    idFactory: (kind) => `${kind}-${++sequence}`,
    readinessResolver: async () => ({ state: "ready" }),
  });
  return {
    catalog,
    importer: new ModelCatalogImporter({ catalog }),
    repositories,
    collections,
  };
}

class FakeCollection {
  constructor({ documents = [], uniqueKeys = [] } = {}) {
    this.documents = documents.map((document) => structuredClone(document));
    this.uniqueKeys = uniqueKeys;
  }

  find(filter = {}) {
    return new FakeCursor(this.documents.filter((document) => matches(document, filter)));
  }

  async findOne(filter = {}) {
    const document = this.documents.find((entry) => matches(entry, filter));
    return document ? structuredClone(document) : null;
  }

  async insertOne(value) {
    const document = structuredClone(value);
    this.#assertUnique(document);
    this.documents.push(document);
    return { acknowledged: true };
  }

  async updateOne(filter, update, { upsert = false } = {}) {
    let document = this.documents.find((entry) => matches(entry, filter));
    if (!document && upsert) {
      document = baseFromFilter(filter);
      applyUpdate(document, update, true);
      this.#assertUnique(document);
      this.documents.push(document);
      return { upsertedCount: 1, matchedCount: 0 };
    }
    if (!document) return { upsertedCount: 0, matchedCount: 0 };
    const candidate = structuredClone(document);
    applyUpdate(candidate, update, false);
    this.#assertUnique(candidate, document);
    Object.assign(document, candidate);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(filter, update) {
    const document = this.documents.find((entry) => matches(entry, filter));
    if (!document) return null;
    const candidate = structuredClone(document);
    applyUpdate(candidate, update, false);
    this.#assertUnique(candidate, document);
    Object.assign(document, candidate);
    return structuredClone(document);
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index >= 0) this.documents.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  }

  #assertUnique(candidate, current = null) {
    for (const keys of this.uniqueKeys) {
      if (this.documents.some((document) => document !== current
        && keys.every((key) => document[key] === candidate[key]))) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
    }
  }
}

class FakeCursor {
  constructor(documents) {
    this.documents = documents.map((document) => structuredClone(document));
  }

  sort(specification) {
    const entries = Object.entries(specification);
    this.documents.sort((left, right) => {
      for (const [key, direction] of entries) {
        if (left[key] === right[key]) continue;
        return direction * (left[key] > right[key] ? 1 : -1);
      }
      return 0;
    });
    return this;
  }

  limit(value) {
    this.documents = this.documents.slice(0, value);
    return this;
  }

  async toArray() {
    return structuredClone(this.documents);
  }
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(document, branch));
    const actual = document[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, "$in")) return expected.$in.includes(actual);
      if (Object.hasOwn(expected, "$lte")) return actual <= expected.$lte;
    }
    return actual === expected;
  });
}

function baseFromFilter(filter) {
  return Object.fromEntries(Object.entries(filter).filter(([key, value]) =>
    !key.startsWith("$") && (!value || typeof value !== "object")));
}

function applyUpdate(document, update, inserting) {
  if (update.$set) Object.assign(document, structuredClone(update.$set));
  if (inserting && update.$setOnInsert) Object.assign(document, structuredClone(update.$setOnInsert));
}

function fakeChild({ code, stdout = "", stderr = "" }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}
