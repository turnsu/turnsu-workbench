import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSkillMaterialResolver } from "../../src/attachments/index.mjs";
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
    assert.equal(store.lastIdempotencyPrincipal, "user-a");
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

test("Attachment promotion stores a governed derived representation with immutable provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-resource-"));
  try {
    const store = createStore();
    const objectStore = await new FilesystemObjectStore({ rootDir: root }).initialize();
    const service = createTextResourceService({ store, objectStore });
    const sourceBytes = Buffer.from("PK governed DOCX bytes");
    const attachment = {
      attachmentId: "attachment-docx",
      version: 1,
      contentHash: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };

    const created = await service.createFromAttachment({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      idempotencyKey: "promote-docx-1",
      label: "Policy document",
      resolvedAttachment: {
        attachment,
        bytes: sourceBytes,
        contentHash: attachment.contentHash,
        mediaType: attachment.mediaType,
        contextText: "Governed extracted policy text.",
      },
    });

    assert.equal(created.mediaType, "text/plain");
    assert.equal(created.source.kind, "attachment");
    assert.equal(created.source.attachment.attachmentId, "attachment-docx");
    assert.equal(created.source.sourceMediaType, attachment.mediaType);
    assert.equal(created.source.derivedText, true);
    assert.equal(
      await service.readText({
        workspaceId: "workspace-a",
        resourceId: created.resourceId,
        version: created.version,
      }),
      "Governed extracted policy text.",
    );

    await assert.rejects(
      service.createFromAttachment({
        workspaceId: "workspace-a",
        requestedBy: "user-a",
        idempotencyKey: "promote-docx-tampered",
        label: "Tampered",
        resolvedAttachment: {
          attachment,
          bytes: Buffer.from("tampered"),
          contentHash: "sha256:different",
          mediaType: attachment.mediaType,
          contextText: "Should not be stored.",
        },
      }),
      { code: "resource_attachment_invalid" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image Attachment promotion remains a binary governed Resource consumable by Skill materials", async () => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-image-resource-"));
  try {
    const store = createStore();
    const objectStore = await new FilesystemObjectStore({ rootDir: root }).initialize();
    const service = createTextResourceService({ store, objectStore });
    const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const attachment = {
      attachmentId: "attachment-image",
      version: 1,
      contentHash: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
      mediaType: "image/png",
    };

    const created = await service.createFromAttachment({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      idempotencyKey: "promote-image-1",
      label: "Reference image",
      resolvedAttachment: {
        attachment,
        bytes: sourceBytes,
        contentHash: attachment.contentHash,
        mediaType: attachment.mediaType,
        contextText: null,
      },
    });
    const content = await service.readContent({
      workspaceId: "workspace-a",
      resourceId: created.resourceId,
      version: created.version,
    });
    const resolveSkillMaterials = createSkillMaterialResolver({
      store,
      textResourceService: {
        readContent: (input) => service.readContent(input),
        async readText() {
          throw new Error("image_material_must_not_use_readText");
        },
      },
    });
    const [material] = await resolveSkillMaterials({
      workspaceId: "workspace-a",
      requestedBy: "user-a",
      bindings: [{
        materialKey: "reference_image",
        source: {
          kind: "workspace_resource",
          resource: {
            resourceId: created.resourceId,
            version: created.version,
            contentHash: created.contentHash,
          },
        },
      }],
    });

    assert.equal(created.mediaType, "image/png");
    assert.equal(created.readiness.status, "ready");
    assert.equal(content.contextText, null);
    assert.deepEqual(content.bytes, sourceBytes);
    assert.equal(material.kind, "workspace_resource");
    assert.equal(material.mediaType, "image/png");
    assert.equal(material.contextText, null);
    assert.deepEqual(material.bytes, sourceBytes);
    await assert.rejects(
      resolveSkillMaterials({
        workspaceId: "workspace-a",
        requestedBy: "user-a",
        bindings: [{
          materialKey: "reference_image",
          source: {
            kind: "workspace_resource",
            resource: {
              resourceId: created.resourceId,
              version: created.version,
              contentHash: created.contentHash,
            },
          },
        }],
        requirements: [{
          materialKey: "reference_image",
          acceptedMediaTypes: ["text/markdown"],
        }],
      }),
      { code: "skill_material_media_type_mismatch" },
    );
    await assert.rejects(
      service.readText({
        workspaceId: "workspace-a",
        resourceId: created.resourceId,
        version: created.version,
      }),
      { code: "resource_text_invalid" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createStore() {
  const records = new Map();
  const keys = new Map();
  const store = {
    lastInsertSession: null,
    lastIdempotencyPrincipal: null,
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
    async runIdempotentMutation({ scope, key, workspaceId, effectivePrincipalId, request }, mutation) {
      store.idempotentMutationCount += 1;
      store.lastIdempotencyPrincipal = effectivePrincipalId;
      const id = `${scope}:${workspaceId}:${effectivePrincipalId}:${key}`;
      const existing = keys.get(id);
      if (existing) { assert.deepEqual(existing.request, request); return structuredClone(existing.value); }
      const value = await mutation({});
      keys.set(id, { request: structuredClone(request), value: structuredClone(value) });
      return structuredClone(value);
    },
  };
  return store;
}
