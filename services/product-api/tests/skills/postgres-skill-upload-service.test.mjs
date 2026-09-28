import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSkillUploadService } from "../../src/skills/index.mjs";

const skillFiles = [{
  path: "SKILL.md",
  content: Buffer.from("---\nname: upload-proof\ndescription: Validate one PostgreSQL package upload.\ndisable-model-invocation: true\n---\n"),
}];

function scriptedStore(steps) {
  const pending = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = pending.shift();
      assert.ok(step, `unexpected query: ${text}`);
      assert.match(text, step.match);
      if (step.values) assert.deepEqual(values, step.values);
      step.verify?.({ text, values });
      return { rows: step.rows ?? [] };
    } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(pending.length, 0); },
  };
}

function objectStore() {
  return {
    async put({ workspaceId, objectId, contentHash, mediaType, bytes }) {
      return { existed: false, workspaceId, objectId, contentHash, mediaType, sizeBytes: bytes.byteLength };
    },
    async promote({ workspaceId, objectId }) { return { workspaceId, objectId, contentHash: "sha256:aaaaaaaaaaaaaaaa", mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: 123 }; },
    async read({ workspaceId, objectId }) { return { object: { workspaceId, objectId, contentHash: "sha256:aaaaaaaaaaaaaaaa", mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: 123, state: "promoted" }, bytes: Buffer.from("package") }; },
  };
}

test("PostgreSQL upload creates a member-owned files intake without legacy repositories", async () => {
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, values: ["workspace-alpha", "alice"], rows: [{ role: "member" }] },
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /INSERT INTO public\.upload_sessions/, values: ["workspace-alpha", "upload-alpha", "alice", "package.skill", 123, "application/vnd.looloomi.skill-package+json", "files", "2026-08-11T00:00:00.000Z", 0, "{}"] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const service = new PostgresSkillUploadService({ store, objectStore: objectStore(), clock: () => "2026-08-11T00:00:00.000Z", idFactory: () => "upload-alpha" });
  const upload = await service.createUpload({ workspaceId: "workspace-alpha", requestedBy: "alice", idempotencyKey: "create-upload-alpha", filename: "package.skill", sizeBytes: 123, mediaType: "application/vnd.looloomi.skill-package+json" });
  assert.equal(upload.state, "selecting");
  assert.equal(upload.uploadId, "upload-alpha");
  store.assertDrained();
});

test("PostgreSQL upload inspection records only governed metadata and leaves bytes in object storage", async () => {
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /FROM public\.upload_sessions/, values: ["workspace-alpha", "upload-alpha", "alice"], rows: [{ state: "selecting" }] },
    { match: /INSERT INTO public\.product_objects/, verify: ({ values }) => {
      assert.ok(Number.isSafeInteger(values[3]) && values[3] > 0);
      assert.match(values[5], /^skill-package:/);
    } },
    { match: /UPDATE public\.upload_sessions/, rows: [{ workspace_id: "workspace-alpha", upload_id: "upload-alpha", requested_by: "alice", schema_version: "workbench-v1", asset_kind: "skill", state: "ready_draft", file_name: "package.skill", size_bytes: 123, media_type: "application/vnd.looloomi.skill-package+json", ingest_method: "files", received_bytes: 123, total_chunks: 0, received_chunks: 0, created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z", payload: { inspection: { status: "passed", manifest: {}, inventory: [], diagnostics: [] } } }] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const service = new PostgresSkillUploadService({ store, objectStore: objectStore(), clock: () => "2026-08-11T00:00:00.000Z", idFactory: () => "unused" });
  const upload = await service.inspectUpload({ workspaceId: "workspace-alpha", requestedBy: "alice", uploadId: "upload-alpha", idempotencyKey: "inspect-upload-alpha", files: skillFiles });
  assert.equal(upload.state, "ready_draft");
  assert.equal(upload.inspection.status, "passed");
  store.assertDrained();
});

test("PostgreSQL upload promotion requires an owned reviewed package before a Draft may bind it", async () => {
  const stored = { workspace_id: "workspace-alpha", upload_id: "upload-alpha", requested_by: "alice", state: "ready_draft", object_id: "object-alpha", object_content_hash: "sha256:aaaaaaaaaaaaaaaa", package_hash: "sha256:bbbbbbbbbbbbbbbb" };
  const store = scriptedStore([
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /FROM public\.upload_sessions/, rows: [stored] },
    { match: /FROM public\.workspace_memberships/, rows: [{ role: "member" }] },
    { match: /pg_advisory_xact_lock/ },
    { match: /FROM public\.product_idempotency_receipts/, rows: [] },
    { match: /INSERT INTO public\.product_idempotency_receipts/ },
    { match: /FROM public\.upload_sessions/, rows: [stored] },
    { match: /UPDATE public\.product_objects/ },
    { match: /UPDATE public\.upload_sessions/, rows: [{ ...stored, schema_version: "workbench-v1", asset_kind: "skill", file_name: "package.skill", size_bytes: 123, media_type: "application/vnd.looloomi.skill-package+json", ingest_method: "files", received_bytes: 123, total_chunks: 0, received_chunks: 0, state: "promoted", created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:01:00.000Z", payload: {} }] },
    { match: /UPDATE public\.product_idempotency_receipts/ },
  ]);
  const service = new PostgresSkillUploadService({ store, objectStore: objectStore(), clock: () => "2026-08-11T00:01:00.000Z", idFactory: () => "unused" });
  const upload = await service.promoteUpload({ workspaceId: "workspace-alpha", requestedBy: "alice", uploadId: "upload-alpha", idempotencyKey: "promote-upload-alpha" });
  assert.equal(upload.state, "promoted");
  store.assertDrained();
});
