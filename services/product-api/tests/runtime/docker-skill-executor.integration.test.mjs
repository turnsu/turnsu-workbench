import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createDockerSkillExecutor,
  DockerSkillExecutorError,
} from "../../src/runtime/index.mjs";
import {
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
} from "../../src/skills/index.mjs";
import { createFilesystemObjectStore } from "../../src/storage/index.mjs";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const executeFile = promisify(execFile);
const ENABLED = process.env.WORKBENCH_DOCKER_INTEGRATION === "1";
const IMAGE = process.env.WORKBENCH_DOCKER_IMAGE
  ?? "python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891";
const SKILL = `---\nname: docker-isolation-proof\ndescription: Prove uploaded Skill isolation in Docker.\ndisable-model-invocation: true\n---\n`;
const RUNTIME_MANIFEST = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
}, null, 2)}\n`;
const SCRIPT = String.raw`import json
import os
import socket
import sys
import time

request = json.load(sys.stdin)
mode = request.get("mode")

if mode == "sleep":
    time.sleep(60)
    result = {"completed": True}
elif mode == "isolation":
    def write_denied(path):
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("forbidden")
            return False
        except OSError:
            return True

    try:
        connection = socket.create_connection(("1.1.1.1", 53), timeout=0.5)
        connection.close()
        egress_denied = False
    except OSError:
        egress_denied = True

    mount_sources = ""
    for mount_file in ("/proc/self/mountinfo", "/proc/mounts"):
        with open(mount_file, "r", encoding="utf-8") as handle:
            mount_sources += handle.read()

    result = {
        "package_write_denied": write_denied("/workspace/skill/host-write"),
        "root_write_denied": write_denied("/root/root-write"),
        "egress_denied": egress_denied,
        "non_root": os.getuid() != 0,
        "host_bind_source_hidden": request["host_path_token"] not in mount_sources,
    }
else:
    result = {"ok": True, "echo": request}

json.dump(result, sys.stdout, separators=(",", ":"))
`;

test("real Docker executor enforces uploaded Skill isolation and cleanup", {
  skip: !ENABLED,
  timeout: 90_000,
}, async (t) => {
  try {
    await executeFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5_000 });
  } catch {
    t.skip("Docker daemon is unavailable");
    return;
  }
  try {
    await executeFile("docker", ["image", "inspect", IMAGE], { timeout: 5_000 });
  } catch {
    t.skip(`digest-pinned image is not installed locally: ${IMAGE}`);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "looloomi-docker-executor-integration-"));
  const objectRoot = join(root, "objects");
  const executionRoot = join(root, "executions");
  const objectStore = await createFilesystemObjectStore({ rootDir: objectRoot });
  let sequence = 0;
  const containerNames = [];
  const idFactory = () => {
    const id = `docker-integration-${++sequence}`;
    containerNames.push(`looloomi-skill-${id}`);
    return id;
  };
  t.after(async () => {
    for (const name of containerNames) {
      await executeFile("docker", ["rm", "--force", name], { timeout: 5_000 }).catch(() => {});
      await executeFile("docker", ["rm", "--force", `${name}-staging`], { timeout: 5_000 }).catch(() => {});
      await executeFile("docker", ["volume", "rm", `${name}-input`], { timeout: 5_000 }).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });

  const files = [
    { path: "SKILL.md", content: SKILL },
    { path: "skill.runtime.json", content: RUNTIME_MANIFEST },
    { path: "scripts/main.py", content: SCRIPT },
  ];
  const inspection = inspectSkillPackage({ files });
  assert.equal(inspection.status, "needs_review");
  const bytes = formatSkillPackage(files);
  const objectContentHash = hashSkillPackageObject(bytes);
  const objectId = objectIdForSkillPackage(objectContentHash);
  await objectStore.put({
    workspaceId: "workspace-docker-proof",
    objectId,
    bytes,
    contentHash: objectContentHash,
    mediaType: SKILL_PACKAGE_MEDIA_TYPE,
    metadata: { source: "docker-integration-proof" },
  });
  await objectStore.promote({ workspaceId: "workspace-docker-proof", objectId });

  const baseRequest = {
    workspaceId: "workspace-docker-proof",
    objectId,
    objectContentHash,
    packageContentHash: inspection.contentHash,
    inspection,
  };
  const makeExecutor = (limits) => createDockerSkillExecutor({
    objectStore,
    image: IMAGE,
    tempRoot: executionRoot,
    idFactory,
    limits,
  });

  const executor = makeExecutor({ timeoutMs: 8_000 });
  assert.deepEqual(await executor.execute({
    ...baseRequest,
    input: { mode: "happy", value: 7 },
  }), {
    ok: true,
    echo: { mode: "happy", value: 7 },
  });
  assert.deepEqual(await executor.execute({
    ...baseRequest,
    input: { mode: "isolation", host_path_token: executionRoot.split("/").at(-1) },
  }), {
    package_write_denied: true,
    root_write_denied: true,
    egress_denied: true,
    non_root: true,
    host_bind_source_hidden: true,
  });

  await assert.rejects(
    makeExecutor({ timeoutMs: 300 }).execute({ ...baseRequest, input: { mode: "sleep" } }),
    isCode("skill_execution_timed_out"),
  );

  const controller = new AbortController();
  const cancelled = makeExecutor({ timeoutMs: 8_000 }).execute({
    ...baseRequest,
    input: { mode: "sleep" },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(cancelled, isCode("skill_execution_cancelled"));

  assert.deepEqual(await readdir(executionRoot), []);
  const { stdout: remaining } = await executeFile("docker", [
    "ps", "--all", "--filter", "name=looloomi-skill-docker-integration", "--format", "{{.Names}}",
  ], { timeout: 5_000 });
  assert.equal(remaining.trim(), "");
  const { stdout: remainingVolumes } = await executeFile("docker", [
    "volume", "ls", "--filter", "name=looloomi-skill-docker-integration", "--format", "{{.Name}}",
  ], { timeout: 5_000 });
  assert.equal(remainingVolumes.trim(), "");
});

function isCode(code) {
  return (error) => error instanceof DockerSkillExecutorError && error.code === code;
}
