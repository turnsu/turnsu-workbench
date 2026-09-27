import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { Check, Errors, AttachmentProcessingResultSchema } from "@looloomi/workbench-contracts";
import { AuthService } from "../../src/auth/auth-service.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";
import { FilesystemObjectStore } from "../../src/storage/index.mjs";
import { createInputAttachmentService, DockerAttachmentExtractionSandbox } from "../../src/attachments/index.mjs";

test("private attachments survive restart and repeated uploads have independent lifetimes", {
  skip: process.env.WORKBENCH_POSTGRES_INTEGRATION !== "1"
    || process.env.WORKBENCH_ATTACHMENT_DOCKER_INTEGRATION !== "1",
  timeout: 60_000,
}, async (t) => {
  const connectionString = process.env.WORKBENCH_POSTGRES_URL;
  assert.match(new URL(connectionString).pathname, /_test$/);
  const pool = new Pool({ connectionString, max: 4 });
  const store = new ProductPostgresStore({ pool });
  const root = await mkdtemp(join(tmpdir(), "turnsu-attachment-integration-"));
  t.after(async () => { await store.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await store.runMigrations();
  const auth = new AuthService({ store, persistence: store.createAuthPersistence(),
    bootstrapAdminToken: "attachment-test-bootstrap", workspaceId: "attachment-test-workspace",
    workspaceName: "Attachment test", bcryptCost: 10 });
  const account = await auth.register({ username: "attachment-owner", password: "Attachment-Test-2026!",
    bootstrapToken: "attachment-test-bootstrap", idempotencyKey: "attachment-owner" });
  const principal = { workspaceId: account.workspaceId, requestedBy: account.user.userId };
  const buildService = async () => {
    const objectStore = new FilesystemObjectStore({ rootDir: join(root, "objects") });
    const extractionSandbox = new DockerAttachmentExtractionSandbox({
      image: process.env.WORKBENCH_ATTACHMENT_EXTRACTOR_IMAGE, tempRoot: root });
    await objectStore.initialize();
    await extractionSandbox.initialize();
    const persistence = store.createInputAttachmentPersistence();
    const insertRepresentation = persistence.insertRepresentation.bind(persistence);
    persistence.insertRepresentation = async (...args) => {
      try { return await insertRepresentation(...args); }
      catch (error) { t.diagnostic(`${error.code}: ${error.message}`); throw error; }
    };
    return createInputAttachmentService({ persistence, objectStore, extractionSandbox });
  };
  const service = await buildService();
  const content = Buffer.from("# Turnsu 试用\n参与人数：6 人。成功标准：至少 5 人在 8 分钟内完成。\n");
  const input = { ...principal, idempotencyKey: "upload-first", fileName: "trial.md", mediaType: "text/markdown", content };
  const first = await service.create(input);
  assert.equal(first.attachment.processing.status, "ready", JSON.stringify(first.attachment.processing));
  assert.equal(Check(AttachmentProcessingResultSchema, first), true,
    JSON.stringify([...Errors(AttachmentProcessingResultSchema, first)]));
  assert.deepEqual(await service.create(input), first, "an exact retry returns the original receipt");
  const ref = ({ attachmentId, version, contentHash, mediaType }) => ({ attachmentId, version, contentHash, mediaType });
  const restarted = await buildService();
  const restored = await restarted.get({ ...principal, attachmentId: first.attachment.attachmentId });
  assert.equal(Check(AttachmentProcessingResultSchema, restored), true,
    JSON.stringify([...Errors(AttachmentProcessingResultSchema, restored)]));
  const parts = await restarted.resolveForTurn({ ...principal, refs: [ref(first.attachment)] });
  assert.equal(parts.length, 1);
  assert.ok(parts[0].text.includes(content.toString("utf8").normalize("NFKC")));
  const firstPage = await restarted.readText({ ...principal, ref: ref(first.attachment), limit: 10 });
  const lastPage = await restarted.readText({ ...principal, ref: ref(first.attachment), offset: firstPage.nextOffset });
  assert.equal(firstPage.text + lastPage.text, content.toString("utf8").normalize("NFKC"));
  assert.equal(lastPage.nextOffset, null);
  await assert.rejects(restarted.readText({ ...principal, ref: ref(first.attachment), offset: -1 }), { code: "attachment_range_invalid" });
  await assert.rejects(restarted.readText({ ...principal, requestedBy: "another-user", ref: ref(first.attachment) }), { code: "attachment_forbidden" });
  const second = await restarted.create({ ...input, idempotencyKey: "upload-second" });
  assert.equal(second.attachment.processing.status, "ready", JSON.stringify(second.attachment.processing));
  assert.notEqual(second.attachment.attachmentId, first.attachment.attachmentId);
  assert.equal((await restarted.list(principal)).data.length, 2);
  await restarted.delete({ ...principal, attachmentId: first.attachment.attachmentId });
  await assert.rejects(restarted.resolveForTurn({ ...principal, refs: [ref(first.attachment)] }),
    (error) => error.code === "attachment_deleted");
  await assert.rejects(restarted.readText({ ...principal, ref: ref(first.attachment) }), { code: "attachment_deleted" });
  const surviving = await restarted.resolveForTurn({ ...principal, refs: [ref(second.attachment)] });
  assert.ok(surviving[0].text.includes(content.toString("utf8").normalize("NFKC")), "deleting one upload cannot delete another upload's bytes");
});
