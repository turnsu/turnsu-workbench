import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createInputAttachmentService } from "../../src/attachments/input-attachment-service.mjs";
import {
  createModelCallBackend,
  createModelService,
} from "../../src/execution/index.mjs";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matches(value, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(value, branch));
    const actual = value[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$lte" in expected) return actual <= expected.$lte;
      if ("$gt" in expected) return actual > expected.$gt;
    }
    return actual === expected;
  });
}

function cursor(values, filter) {
  let rows = values.filter((value) => matches(value, filter));
  return {
    sort(specification) {
      const entries = Object.entries(specification);
      rows = rows.sort((left, right) => {
        for (const [key, direction] of entries) {
          const comparison = String(left[key]).localeCompare(String(right[key]));
          if (comparison) return direction < 0 ? -comparison : comparison;
        }
        return 0;
      });
      return this;
    },
    limit(limit) {
      rows = rows.slice(0, limit);
      return this;
    },
    async toArray() {
      return rows.map(clone);
    },
  };
}

function fixture({ extractionSandbox = null, deleteFailures = 0 } = {}) {
  let clock = "2026-07-29T00:00:00.000Z";
  let representationId = 0;
  let remainingDeleteFailures = deleteFailures;
  let failingPromotionObjectId = "";
  let attachmentSequence = 0;
  const attachments = new Map();
  const representations = new Map();
  const objects = new Map();
  const deletedObjects = [];
  const idempotencyOptions = [];
  const idempotencyRecords = new Map();
  const objectStore = {
    async put({ workspaceId, objectId, bytes, contentHash, mediaType, state }) {
      const object = {
        objectId,
        workspaceId,
        contentHash,
        sizeBytes: bytes.byteLength,
        mediaType,
        state,
      };
      objects.set(`${workspaceId}:${objectId}`, { object, bytes: Buffer.from(bytes) });
      return { ...clone(object), existed: false };
    },
    async promote({ workspaceId, objectId }) {
      if (objectId === failingPromotionObjectId) throw new Error("object_promotion_failed");
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
      if (remainingDeleteFailures > 0) {
        remainingDeleteFailures -= 1;
        throw new Error("object_delete_failed");
      }
      deletedObjects.push(`${workspaceId}:${objectId}`);
      objects.delete(`${workspaceId}:${objectId}`);
    },
  };
  const store = {
    async connect() {},
    async authorizeWorkspace({ userId, workspaceId }) {
      if (!["alice", "bob"].includes(userId) || !["workspace-a", "workspace-b"].includes(workspaceId)) {
        const error = new Error("forbidden");
        error.code = "forbidden";
        throw error;
      }
    },
    async runIdempotentExternalMutation(options, operation) {
      idempotencyOptions.push({
        scope: options.scope,
        key: options.key,
        workspaceId: options.workspaceId,
        effectivePrincipalId: options.effectivePrincipalId,
        request: clone(options.request),
      });
      const recordKey = `${options.workspaceId}:${options.effectivePrincipalId}:${options.scope}:${options.key}`;
      const request = JSON.stringify(options.request);
      const existing = idempotencyRecords.get(recordKey);
      if (existing) {
        if (existing.request !== request) {
          const failure = new Error("idempotency_key_reused");
          failure.code = "idempotency_key_reused";
          throw failure;
        }
        return clone(existing.response);
      }
      const response = await operation(`attachment-${++attachmentSequence}`);
      idempotencyRecords.set(recordKey, { request, response: clone(response) });
      return clone(response);
    },
    repositories: {
      attachments: {
        collection: {
          find(filter) {
            return cursor([...attachments.values()], filter);
          },
        },
        async insert(value) {
          attachments.set(value.attachmentId, clone(value));
          return clone(value);
        },
        async get(attachmentId, { workspaceId }) {
          const value = attachments.get(attachmentId);
          return value?.workspaceId === workspaceId ? clone(value) : null;
        },
        async patch(attachmentId, patch, { workspaceId }) {
          const value = attachments.get(attachmentId);
          if (!value || value.workspaceId !== workspaceId) return null;
          const next = { ...value, ...clone(patch) };
          attachments.set(attachmentId, next);
          return clone(next);
        },
      },
      attachmentRepresentations: {
        collection: {
          find(filter) {
            return cursor([...representations.values()], filter);
          },
        },
        async insert(value) {
          representations.set(value.representationId, clone(value));
          return clone(value);
        },
      },
    },
  };
  const service = createInputAttachmentService({
    store,
    objectStore,
    extractionSandbox,
    clock: () => clock,
    idFactory(kind) {
      if (kind === "attachment-representation") {
        representationId += 1;
        return `attachment-representation-${representationId}`;
      }
      return `${kind}-1`;
    },
  });
  return {
    service,
    attachments,
    objects,
    deletedObjects,
    idempotencyOptions,
    setClock(value) {
      clock = value;
    },
    failPromotionFor(objectId) {
      failingPromotionObjectId = objectId;
    },
    clearPromotionFailure() {
      failingPromotionObjectId = "";
    },
  };
}

test("personal attachments resolve only for their owner and immutable workspace reference", async () => {
  const { service, idempotencyOptions } = fixture();
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const created = await service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-1",
    fileName: "image.png",
    mediaType: "image/png",
    content: bytes,
    ttlSeconds: 300,
  });
  const attachment = created.attachment;
  const ref = {
    attachmentId: attachment.attachmentId,
    version: attachment.version,
    contentHash: attachment.contentHash,
    mediaType: attachment.mediaType,
  };
  assert.equal(attachment.scope, "personal");
  assert.equal(attachment.objectId, undefined);
  assert.equal(JSON.stringify(created).includes(bytes.toString("base64")), false);
  assert.equal(idempotencyOptions[0].scope, "create-input-attachment:alice");
  assert.equal(idempotencyOptions[0].effectivePrincipalId, "alice");

  const [part] = await service.resolveForTurn({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    refs: [ref],
  });
  assert.equal(part.type, "image");
  assert.equal(part.dataBase64, bytes.toString("base64"));

  await assert.rejects(
    service.resolveForTurn({ workspaceId: "workspace-a", requestedBy: "bob", refs: [ref] }),
    (error) => error.code === "attachment_forbidden",
  );
  await assert.rejects(
    service.resolveForTurn({ workspaceId: "workspace-b", requestedBy: "alice", refs: [ref] }),
    (error) => error.code === "attachment_forbidden",
  );
  await assert.rejects(
    service.resolveForTurn({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      refs: [{ ...ref, contentHash: `sha256:${"0".repeat(64)}` }],
    }),
    (error) => error.code === "attachment_integrity_failed",
  );
});

test("same-workspace collaborators cannot replay another user's private attachment response", async () => {
  const state = fixture();
  const input = {
    workspaceId: "workspace-a",
    idempotencyKey: "shared-browser-key",
    fileName: "image.png",
    mediaType: "image/png",
    content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ttlSeconds: 300,
  };

  const alice = await state.service.create({ ...input, requestedBy: "alice" });
  const bob = await state.service.create({ ...input, requestedBy: "bob" });

  assert.notEqual(alice.attachment.attachmentId, bob.attachment.attachmentId);
  assert.equal(alice.attachment.ownerUserId, "alice");
  assert.equal(bob.attachment.ownerUserId, "bob");
  assert.equal(state.attachments.size, 2);
  assert.deepEqual(
    state.idempotencyOptions.map((item) => [item.scope, item.effectivePrincipalId]),
    [
      ["create-input-attachment:alice", "alice"],
      ["create-input-attachment:bob", "bob"],
    ],
  );
});

test("upload accepts exactly 16 MiB and rejects one byte more before object storage", async () => {
  const state = fixture();
  const maximum = Buffer.alloc(16 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(maximum);

  const accepted = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-maximum",
    fileName: "maximum.png",
    mediaType: "image/png",
    content: maximum,
    ttlSeconds: 300,
  });
  assert.equal(accepted.attachment.sizeBytes, 16 * 1024 * 1024);

  const oversized = Buffer.concat([maximum, Buffer.from([0])]);
  await assert.rejects(
    state.service.create({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      idempotencyKey: "upload-oversized",
      fileName: "oversized.png",
      mediaType: "image/png",
      content: oversized,
      ttlSeconds: 300,
    }),
    (error) => error?.code === "attachment_too_large",
  );
  assert.equal(state.attachments.size, 1);
});

test("sandbox diagnostics never persist host paths in Product attachment processing state", async () => {
  const state = fixture({
    extractionSandbox: {
      async extract() {
        const failure = new Error(
          "open /proc/self/mountinfo failed for /private/var/workbench and /Users/operator/repository",
        );
        failure.code = "attachment_processing_failed";
        throw failure;
      },
    },
  });
  const created = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-host-path-diagnostic",
    fileName: "diagnostic.txt",
    mediaType: "text/plain",
    content: Buffer.from("safe attachment input"),
    ttlSeconds: 300,
  });

  assert.deepEqual(created.attachment.processing, {
    status: "failed",
    code: "attachment_processing_failed",
    message: "Attachment processing failed.",
    retryable: true,
  });
  assert.doesNotMatch(JSON.stringify(created), /mountinfo|\/private\/|\/Users\//);
  assert.doesNotMatch(JSON.stringify(state.attachments.get("attachment-1")), /mountinfo|\/private\/|\/Users\//);
});

test("TTL sweep continues after one attachment physical delete fails", async () => {
  const state = fixture({ deleteFailures: 1 });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-expire-batch",
    fileName: "image.png",
    mediaType: "image/png",
    content: bytes,
    ttlSeconds: 300,
  });
  const first = state.attachments.get("attachment-1");
  state.attachments.set("attachment-2", {
    ...clone(first),
    attachmentId: "attachment-2",
    objectId: "object-attachment-2",
  });
  state.objects.set("workspace-a:object-attachment-2", {
    object: {
      objectId: "object-attachment-2",
      workspaceId: "workspace-a",
      contentHash: first.contentHash,
      sizeBytes: bytes.byteLength,
      mediaType: "image/png",
      state: "promoted",
    },
    bytes: Buffer.from(bytes),
  });
  state.setClock("2026-07-29T00:05:01.000Z");

  const result = await state.service.expireDue();

  assert.equal(result.expired, 1);
  assert.equal(result.failed, 1);
  assert.equal(state.attachments.get("attachment-1").deletedAt, null);
  assert.equal(
    state.attachments.get("attachment-2").processing.status,
    "expired",
  );
  assert.equal(state.objects.has("workspace-a:object-attachment-2"), false);
});

test("TTL sweep keyset pages past a failed first batch without starving later attachments", async () => {
  const state = fixture({ deleteFailures: 1 });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-expire-many",
    fileName: "image.png",
    mediaType: "image/png",
    content: bytes,
    ttlSeconds: 300,
  });
  const first = state.attachments.get("attachment-1");
  for (let index = 2; index <= 1002; index += 1) {
    const attachmentId = `attachment-${String(index).padStart(4, "0")}`;
    const objectId = `object-${attachmentId}`;
    state.attachments.set(attachmentId, {
      ...clone(first),
      attachmentId,
      objectId,
    });
    state.objects.set(`workspace-a:${objectId}`, {
      object: {
        objectId,
        workspaceId: "workspace-a",
        contentHash: first.contentHash,
        sizeBytes: bytes.byteLength,
        mediaType: "image/png",
        state: "promoted",
      },
      bytes: Buffer.from(bytes),
    });
  }
  state.setClock("2026-07-29T00:05:01.000Z");

  const result = await state.service.expireDue();

  assert.equal(result.expired, 1001);
  assert.equal(result.failed, 1);
  assert.equal(
    [...state.attachments.values()].filter((item) => item.processing.status === "expired").length,
    1001,
  );
});

test("PostgreSQL-style attachment persistence can run the startup TTL sweep without a legacy store", async () => {
  let sweeps = 0;
  const persistence = Object.fromEntries([
    "authorizeWorkspace", "runIdempotentExternalMutation", "getAttachment",
    "listAttachments", "insertAttachment", "patchAttachment",
    "listRepresentations", "insertRepresentation",
  ].map((name) => [name, async () => {
    throw new Error(`unexpected_${name}`);
  }]));
  persistence.listExpiredAttachments = async () => {
    sweeps += 1;
    return [];
  };
  const service = createInputAttachmentService({
    persistence,
    objectStore: {
      async put() {},
      async promote() {},
      async read() {},
      async deleteObject() {},
    },
  });

  assert.deepEqual(await service.expireDue(), { expired: 0, failed: 0, failures: [] });
  assert.equal(sweeps, 1);
});

test("personal image upload reaches a vision Agent model call in OpenAI-compatible wire format", async () => {
  const state = fixture();
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const created = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-vision-1",
    fileName: "diagram.png",
    mediaType: "image/png",
    content: bytes,
    ttlSeconds: 300,
  });
  const attachment = created.attachment;
  let providerBody = null;
  const modelService = createModelService({
    defaultModelProfileId: "vision",
    profiles: [{
      id: "vision",
      label: "Vision",
      provider: "custom",
      protocol: "openai-compatible",
      baseUrl: "https://vision.example/v1",
      model: "vision-model",
      credentialRef: "vision",
      capabilities: ["chat", "image_input"],
      fallback: [],
      enabled: true,
    }],
    credentials: { vision: "test-only-credential" },
    fetchImpl: async (_url, options) => {
      providerBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "A diagram." } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const backend = createModelCallBackend({
    modelService,
    attachmentResolver: state.service.resolveForTurn.bind(state.service),
  });
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-vision-1",
    attemptId: "attempt-vision-1",
    workspaceId: "workspace-a",
    controller: { kind: "agent_turn", controllerId: "agent-turn-vision-1", fence: 1 },
    mode: "model_call",
    isolation: "process",
    input: {
      messages: [{ role: "user", content: "Describe this image." }],
      tools: [],
    },
    limits: {
      timeoutMs: 30_000,
      maxSteps: 1,
      maxModelRequests: 1,
      maxChildren: 0,
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxImageCount: 8,
      maxCostUsdMicros: 1_000_000,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    modelProfileRevisionId: "vision:revision:1",
    modelCapability: "image_input",
    fallbackModelProfileRevisionIds: [],
    metadata: {
      agentSessionId: "agent-session-vision-1",
      agentTurnId: "agent-turn-vision-1",
      requestedBy: "alice",
      attachmentRefs: [{
        attachmentId: attachment.attachmentId,
        version: attachment.version,
        contentHash: attachment.contentHash,
        mediaType: attachment.mediaType,
      }],
    },
  };
  const result = await backend.execute({
    request,
    lease: {
      capabilityLeaseId: "lease-vision-1",
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      fence: 1,
    },
  });

  assert.equal(result.actualModelRevisionId, "vision:revision:1");
  assert.deepEqual(providerBody.messages[0].content[1], {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
  });
  assert.equal(JSON.stringify(providerBody).includes("test-only-credential"), false);
});

test("document materials expose original bytes to Script Skills and bounded derived text to Prompt Skills", async () => {
  const state = fixture({
    extractionSandbox: {
      async extract({ bytes, mediaType }) {
        assert.equal(mediaType, "text/markdown");
        return {
          kind: "text",
          text: Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n"),
          evidence: [{ paragraph: 1 }],
        };
      },
    },
  });
  const bytes = Buffer.from("# Agenda\n\nMeet at 10:00.\n");
  const created = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-material-1",
    fileName: "agenda.md",
    mediaType: "text/markdown",
    content: bytes,
    ttlSeconds: 300,
  });
  const attachment = created.attachment;
  const [material] = await state.service.resolveMaterialBindings({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    bindings: [{
      materialKey: "agenda",
      source: {
        kind: "attachment",
        attachment: {
          attachmentId: attachment.attachmentId,
          version: attachment.version,
          contentHash: attachment.contentHash,
          mediaType: attachment.mediaType,
        },
      },
    }],
  });
  assert.deepEqual(material.bytes, bytes);
  assert.equal(material.contextText, "# Agenda\n\nMeet at 10:00.\n");
  assert.equal(Object.hasOwn(material, "objectId"), false);
});

test("expired and deleted attachments physically remove bytes and cannot be resolved", async () => {
  const state = fixture();
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const created = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-1",
    fileName: "image.png",
    mediaType: "image/png",
    content: bytes,
    ttlSeconds: 300,
  });
  const ref = {
    attachmentId: created.attachment.attachmentId,
    version: 1,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    mediaType: "image/png",
  };
  state.setClock("2026-07-29T00:05:01.000Z");
  await assert.rejects(
    state.service.resolveForTurn({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      refs: [ref],
    }),
    (error) => error.code === "attachment_expired",
  );
  assert.equal(state.objects.size, 0);
  assert.ok(state.deletedObjects.includes("workspace-a:object-attachment-1"));
  const expired = await state.service.get({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    attachmentId: ref.attachmentId,
  });
  assert.equal(expired.attachment.processing.status, "expired");
  assert.equal(expired.attachment.deletedAt, "2026-07-29T00:05:01.000Z");

  const second = fixture();
  const uploaded = await second.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-2",
    fileName: "image.png",
    mediaType: "image/png",
    content: bytes,
    ttlSeconds: 300,
  });
  const deleted = await second.service.delete({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    attachmentId: uploaded.attachment.attachmentId,
  });
  assert.equal(deleted.processing.status, "deleted");
  assert.equal(second.objects.size, 0);
  await assert.rejects(
    second.service.resolveForTurn({
      workspaceId: "workspace-a",
      requestedBy: "alice",
      refs: [{
        attachmentId: uploaded.attachment.attachmentId,
        version: uploaded.attachment.version,
        contentHash: uploaded.attachment.contentHash,
        mediaType: uploaded.attachment.mediaType,
      }],
    }),
    (error) => error.code === "attachment_deleted",
  );
});

test("attachment deletion remains retryable when physical object removal fails", async () => {
  const state = fixture({ deleteFailures: 1 });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const created = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-delete-retry",
    fileName: "image.png",
    mediaType: "image/png",
    content: bytes,
  });

  await assert.rejects(state.service.delete({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    attachmentId: created.attachment.attachmentId,
  }), /object_delete_failed/);
  const retained = await state.service.get({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    attachmentId: created.attachment.attachmentId,
  });
  assert.equal(retained.attachment.processing.status, "ready");
  assert.equal(retained.attachment.deletedAt, null);

  const deleted = await state.service.delete({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    attachmentId: created.attachment.attachmentId,
  });
  assert.equal(deleted.processing.status, "deleted");
  assert.ok(deleted.deletedAt);
  assert.equal(state.objects.size, 0);
});

test("failed derived-object promotion cannot leave a representation row that is later marked ready", async () => {
  const state = fixture({
    extractionSandbox: {
      async extract({ bytes }) {
        return {
          kind: "utf8_text",
          text: Buffer.from(bytes).toString("utf8"),
          evidence: [],
        };
      },
    },
  });
  state.failPromotionFor("object-attachment-representation-1");
  const blocked = await state.service.create({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    idempotencyKey: "upload-representation-retry",
    fileName: "notes.md",
    mediaType: "text/markdown",
    content: Buffer.from("# governed"),
  });
  assert.equal(blocked.attachment.processing.status, "failed");
  assert.equal(blocked.representations.length, 0);

  state.clearPromotionFailure();
  const ready = await state.service.retry({
    workspaceId: "workspace-a",
    requestedBy: "alice",
    attachmentId: blocked.attachment.attachmentId,
  });
  assert.equal(ready.attachment.processing.status, "ready");
  assert.equal(ready.representations.length, 1);
});
