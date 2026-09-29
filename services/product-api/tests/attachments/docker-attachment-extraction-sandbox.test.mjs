import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockerAttachmentExtractionSandbox } from "../../src/attachments/docker-attachment-extraction-sandbox.mjs";

const IMAGE = `attachment-extractor@sha256:${"a".repeat(64)}`;
const MANAGED_DIRECTORY = "looloomi-attachment-extraction-v1";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stderr = new PassThrough();
  }

  kill() {}
}

function outputDirectory(args) {
  const mount = args.find((value) => typeof value === "string" && value.endsWith(",dst=/output"));
  return /(?:^|,)src=([^,]+)/.exec(mount)?.[1];
}

test("attachment extraction sandbox removes every prior owned work directory on startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managedRoot = join(root, MANAGED_DIRECTORY);
  const stale = join(managedRoot, "workbench-attachment-ABC123");
  const fresh = join(managedRoot, "workbench-attachment-DEF456");
  const traversalLike = join(managedRoot, "workbench-attachment-..");
  const foreign = join(managedRoot, "other-service");
  const sibling = join(root, "workbench-attachment-GHI789");
  await Promise.all([
    mkdir(stale, { recursive: true }),
    mkdir(fresh, { recursive: true }),
    mkdir(traversalLike, { recursive: true }),
    mkdir(foreign, { recursive: true }),
    mkdir(sibling),
  ]);
  await Promise.all([stale, fresh].map(async (directory) => {
    const input = join(directory, "input");
    await mkdir(input);
    await writeFile(join(input, "source.bin"), "stale bytes", { mode: 0o444 });
    await chmod(input, 0o555);
  }));
  const sandbox = new DockerAttachmentExtractionSandbox({
    image: IMAGE,
    tempRoot: root,
  });
  const result = await sandbox.initialize();
  const names = (await readdir(managedRoot)).sort();

  assert.deepEqual(result.removed.sort(), [
    "workbench-attachment-ABC123",
    "workbench-attachment-DEF456",
  ]);
  assert.deepEqual(names, ["other-service", "workbench-attachment-.."]);
  assert.ok((await readdir(root)).includes("workbench-attachment-GHI789"));
});

test("attachment extraction startup refuses a symlinked managed root without deleting its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "looloomi-attachment-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await mkdir(join(outside, "workbench-attachment-ABC123"));
  await symlink(outside, join(root, MANAGED_DIRECTORY), "dir");
  const sandbox = new DockerAttachmentExtractionSandbox({ image: IMAGE, tempRoot: root });

  await assert.rejects(sandbox.initialize(), {
    code: "attachment_processing_unavailable",
    message: "The attachment extraction sandbox is unavailable.",
  });
  assert.deepEqual(await readdir(outside), ["workbench-attachment-ABC123"]);
});

test("Docker diagnostics with host paths never cross the attachment sandbox boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnProcess = () => {
    const child = new FakeChild();
    setImmediate(() => {
      child.stderr.end("open /proc/self/mountinfo: mount source /Users/operator/private failed");
      child.emit("exit", 1);
    });
    return child;
  };
  const sandbox = new DockerAttachmentExtractionSandbox({
    image: IMAGE,
    tempRoot: root,
    spawnProcess,
  });

  await assert.rejects(
    sandbox.extract({ bytes: Buffer.from("secret"), mediaType: "text/plain" }),
    (error) => error?.code === "attachment_processing_failed"
      && error.message === "Attachment extraction failed in the sandbox."
      && !/mountinfo|\/Users\//.test(error.message),
  );
  assert.deepEqual(await readdir(join(root, MANAGED_DIRECTORY)), []);
});

test("structured worker validation survives a nonzero Docker exit without leaking diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnProcess = (_binary, args) => {
    const child = new FakeChild();
    setImmediate(async () => {
      await writeFile(join(outputDirectory(args), "result.json"), JSON.stringify({
        ok: false,
        code: "attachment_limit_exceeded",
        message: "/Users/operator/private should never escape",
      }));
      child.emit("exit", 1);
    });
    return child;
  };
  const sandbox = new DockerAttachmentExtractionSandbox({
    image: IMAGE,
    tempRoot: root,
    spawnProcess,
  });

  await assert.rejects(
    sandbox.extract({ bytes: Buffer.from("PK malicious"), mediaType: "application/pdf" }),
    (error) => error?.code === "attachment_limit_exceeded"
      && error.message === "The attachment exceeds a processing limit."
      && !/operator|\/Users\//.test(error.message),
  );
  assert.deepEqual(await readdir(join(root, MANAGED_DIRECTORY)), []);
});

test("Docker unavailability fails closed and never falls back to host extraction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-no-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnProcess = () => {
    const child = new FakeChild();
    setImmediate(() => {
      const failure = new Error("docker_not_found");
      failure.code = "ENOENT";
      child.emit("error", failure);
    });
    return child;
  };
  const sandbox = new DockerAttachmentExtractionSandbox({
    image: IMAGE,
    tempRoot: root,
    spawnProcess,
  });

  await assert.rejects(
    sandbox.extract({ bytes: Buffer.from("host-readable text"), mediaType: "text/plain" }),
    (error) => error?.code === "attachment_processing_unavailable",
  );
  assert.deepEqual(await readdir(join(root, MANAGED_DIRECTORY)), []);
});
