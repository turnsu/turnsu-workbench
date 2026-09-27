import assert from "node:assert/strict";
import test from "node:test";

import { PostgresInputAttachmentPersistence } from "../../src/attachments/index.mjs";

class ScriptedStore {
  constructor(steps) { this.steps = [...steps]; }
  bindAdapter(factory) {
    return factory({ execute: async (_uow, config) => {
      const step = this.steps.shift();
      assert.ok(step, `unexpected query: ${config.text}`);
      assert.match(config.text, step.match);
      step.assertValues?.(config.values);
      return step.result ?? { rows: [], rowCount: 0 };
    } });
  }
  async withTransaction(work) { return work({ kind: "test-uow" }); }
  assertDrained() { assert.equal(this.steps.length, 0); }
}

const attachment = Object.freeze({
  schemaVersion: "workbench-v1", attachmentId: "attachment-alpha", version: 1,
  workspaceId: "workspace-alpha", ownerUserId: "user-alpha", scope: "personal",
  fileName: "brief.md", mediaType: "text/markdown", sizeBytes: 12,
  contentHash: `sha256:${"a".repeat(64)}`, objectId: "object-attachment-alpha",
  source: "user_upload", processing: { status: "processing", code: null, message: "Processing attachment.", retryable: false },
  expiresAt: "2026-08-17T00:00:00.000Z", deletedAt: null,
  createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
});

const row = (overrides = {}) => ({
  workspace_id: attachment.workspaceId, attachment_id: attachment.attachmentId,
  attachment_version: attachment.version, owner_user_id: attachment.ownerUserId,
  schema_version: attachment.schemaVersion, scope_kind: "personal", file_name: attachment.fileName,
  media_type: attachment.mediaType, size_bytes: attachment.sizeBytes, content_hash: attachment.contentHash,
  object_id: attachment.objectId, source: "user_upload", processing_status: attachment.processing.status,
  processing_code: null, processing_message: attachment.processing.message,
  processing_retryable: false, expires_at: attachment.expiresAt, deleted_at: null,
  created_at: attachment.createdAt, updated_at: attachment.updatedAt, ...overrides,
});

test("PostgreSQL attachment persistence creates a governed object and immutable personal attachment row", async () => {
  const store = new ScriptedStore([
    { match: /INSERT INTO public\.product_objects/, assertValues(values) {
      assert.deepEqual(values.slice(0, 7), [attachment.workspaceId, attachment.objectId, "attachment_source", attachment.contentHash, attachment.sizeBytes, attachment.mediaType, attachment.createdAt]);
    } },
    { match: /INSERT INTO public\.input_attachments/, assertValues(values) {
      assert.equal(values[0], attachment.workspaceId); assert.equal(values[1], attachment.attachmentId);
      assert.equal(values[3], attachment.ownerUserId); assert.equal(values[9], attachment.objectId);
    }, result: { rows: [row()] } },
  ]);
  const persistence = new PostgresInputAttachmentPersistence({ store });
  assert.deepEqual(await persistence.insertAttachment(attachment), attachment);
  store.assertDrained();
});

test("PostgreSQL attachment persistence authorizes active membership and scopes list cursor to its owner", async () => {
  const store = new ScriptedStore([
    { match: /FROM public\.workspace_memberships/, assertValues(values) { assert.deepEqual(values, [attachment.workspaceId, attachment.ownerUserId]); }, result: { rows: [{ role: "member", status: "active" }] } },
    { match: /FROM public\.input_attachments/, assertValues(values) {
      assert.deepEqual(values, [attachment.workspaceId, attachment.ownerUserId, attachment.updatedAt, attachment.attachmentId, 2]);
    }, result: { rows: [row()] } },
  ]);
  const persistence = new PostgresInputAttachmentPersistence({ store });
  assert.equal((await persistence.authorizeWorkspace({ workspaceId: attachment.workspaceId, userId: attachment.ownerUserId, minimumRole: "member" })).role, "member");
  assert.equal((await persistence.listAttachments({ workspaceId: attachment.workspaceId, ownerUserId: attachment.ownerUserId, cursor: { updatedAt: attachment.updatedAt, attachmentId: attachment.attachmentId }, limit: 2 })).length, 1);
  store.assertDrained();
});

test("PostgreSQL attachment receipt rejects a conflicting replay before calling the mutation", async () => {
  const store = new ScriptedStore([
    { match: /INSERT INTO public\.product_idempotency_receipts/, result: { rows: [] } },
    { match: /SELECT request_hash, response, created_at/, result: { rows: [{ request_hash: `sha256:${"f".repeat(64)}`, response: null, created_at: attachment.createdAt }] } },
  ]);
  const persistence = new PostgresInputAttachmentPersistence({ store, clock: () => attachment.createdAt });
  await assert.rejects(
    persistence.runIdempotentExternalMutation({
      scope: "create-input-attachment:user-alpha", key: "attachment-key", request: { fileName: attachment.fileName },
      workspaceId: attachment.workspaceId, effectivePrincipalId: attachment.ownerUserId,
      recover: async () => null,
    }, async () => { throw new Error("mutation must not run"); }),
    (error) => error?.code === "idempotency_key_reused",
  );
  store.assertDrained();
});
