import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildDockerSkillArguments,
  cleanupSkillInvocationDirectory,
  createDockerSkillExecutor,
  DOCKER_SKILL_INVOCATION_LABEL,
  DOCKER_SKILL_OWNER_LABEL,
  DOCKER_SKILL_OWNER_VALUE,
  DockerSkillExecutorError,
  scavengeDockerSkillExecutions,
} from "../../src/runtime/docker-skill-executor.mjs";
import {
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
} from "../../src/skills/index.mjs";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const IMAGE = "python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891";
const NODE_IMAGE = "node@sha256:3c1f5749ec84a47b8b30cb4c7a43ce6fd80a99e462b255220309abb745526442";
const SKILL = `---\nname: isolated-proof\ndescription: Prove bounded isolated execution.\ndisable-model-invocation: true\n---\n`;
const SCRIPT = "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n";
const RUNTIME_MANIFEST = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
}, null, 2)}\n`;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.closed = false;
  }

  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }

  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.close(null, signal));
    return true;
  }
}

function executablePackage(script = SCRIPT, extraFiles = []) {
  const files = [
    { path: "SKILL.md", content: SKILL },
    { path: "skill.runtime.json", content: RUNTIME_MANIFEST },
    ...extraFiles,
    { path: "scripts/main.py", content: script },
  ];
  const inspection = inspectSkillPackage({ files });
  const bytes = formatSkillPackage(files);
  const objectContentHash = hashSkillPackageObject(bytes);
  const objectId = objectIdForSkillPackage(objectContentHash);
  const objectStore = {
    async read({ workspaceId, objectId: requestedObjectId }) {
      return {
        object: {
          workspaceId,
          objectId: requestedObjectId,
          contentHash: objectContentHash,
          mediaType: SKILL_PACKAGE_MEDIA_TYPE,
          state: "promoted",
        },
        bytes: Buffer.from(bytes),
      };
    },
  };
  return {
    objectStore,
    request: {
      workspaceId: "workspace-proof",
      objectId,
      objectContentHash,
      packageContentHash: inspection.contentHash,
      inspection,
      input: { value: 7 },
    },
  };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "looloomi-docker-executor-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function createDockerController(calls, {
  containers = [],
  volumes = [],
  defaultRunning = false,
  failCommand = null,
} = {}) {
  const state = new Map(containers.map((name) => [name, { running: true }]));
  const volumeState = new Set(volumes);
  return async (args) => {
    calls.push(args);
    const command = `${args[0]} ${args[1]}`;
    if (command === failCommand || (typeof failCommand === "function" && failCommand(args))) {
      return controlResult(1, "", "failed");
    }
    if (command === "container ls") {
      const invocationFilter = args.find((value) => value.startsWith(`label=${DOCKER_SKILL_INVOCATION_LABEL}=`));
      const requestedName = invocationFilter?.slice(`label=${DOCKER_SKILL_INVOCATION_LABEL}=`.length);
      const names = [...state.keys()].filter((name) => !requestedName || name === requestedName);
      return controlResult(0, names.length ? `${names.join("\n")}\n` : "");
    }
    if (command === "container create") {
      const name = args[args.indexOf("--name") + 1];
      state.set(name, { running: name.endsWith("-staging") ? false : defaultRunning });
      return controlResult(0, `${name}-id\n`);
    }
    if (command === "container cp") return controlResult();
    const containerName = args.at(-1);
    if (command === "container inspect") {
      const current = state.get(containerName);
      if (!current) return controlResult(1, "", "not found");
      return controlResult(0, `${JSON.stringify({
        [DOCKER_SKILL_OWNER_LABEL]: DOCKER_SKILL_OWNER_VALUE,
        [DOCKER_SKILL_INVOCATION_LABEL]: containerName,
      })} ${current.running}\n`);
    }
    if (command === "container kill") {
      const current = state.get(containerName);
      if (!current) return controlResult(1, "", "not found");
      current.running = false;
      return controlResult();
    }
    if (command === "container rm") {
      state.delete(containerName);
      return controlResult();
    }
    if (command === "volume create") {
      const name = args.at(-1);
      volumeState.add(name);
      return controlResult(0, `${name}\n`);
    }
    if (command === "volume ls") {
      const invocationFilter = args.find((value) => value.startsWith(`label=${DOCKER_SKILL_INVOCATION_LABEL}=`));
      const requestedName = invocationFilter?.slice(`label=${DOCKER_SKILL_INVOCATION_LABEL}=`.length);
      const names = [...volumeState].filter((name) => !requestedName || name === requestedName);
      return controlResult(0, names.length ? `${names.join("\n")}\n` : "");
    }
    if (command === "volume inspect") {
      const name = args.at(-1);
      if (!volumeState.has(name)) return controlResult(1, "", "not found");
      return controlResult(0, `${JSON.stringify({
        [DOCKER_SKILL_OWNER_LABEL]: DOCKER_SKILL_OWNER_VALUE,
        [DOCKER_SKILL_INVOCATION_LABEL]: name,
      })}\n`);
    }
    if (command === "volume rm") {
      volumeState.delete(args.at(-1));
      return controlResult();
    }
    return controlResult(1, "", "unsupported command");
  };
}

function controlResult(code = 0, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

test("Docker executor requires a digest-pinned image", () => {
  const { objectStore } = executablePackage();
  assert.throws(
    () => createDockerSkillExecutor({ objectStore, image: "python:3.13" }),
    /docker_skill_executor_digest_pinned_image_required/,
  );
  assert.throws(
    () => createDockerSkillExecutor({ objectStore }),
    /docker_skill_executor_digest_pinned_image_required/,
  );
});

test("Docker runtime readiness verifies the daemon and every pinned image", async () => {
  const { objectStore } = executablePackage();
  const calls = [];
  const executor = createDockerSkillExecutor({
    objectStore,
    images: new Map([
      ["python3.12", IMAGE],
      ["nodejs20-typescript", NODE_IMAGE],
    ]),
    dockerControl: async (args) => {
      calls.push(args);
      return args.at(-1) === NODE_IMAGE
        ? controlResult(1, "", "not found")
        : controlResult(0, "sha256:verified\n", "");
    },
  });

  assert.deepEqual(await executor.probeRuntimes(), [
    { runtimeId: "python3.12", available: true, verified: true, reasonCode: "ready" },
    { runtimeId: "nodejs20-typescript", available: false, verified: true, reasonCode: "skill_runtime_image_unavailable" },
  ]);
  assert.ok(calls.every((args) => args[0] === "image" && args[1] === "inspect"));
});

test("Docker executor dispatches Node.js 20 TypeScript through its governed image", () => {
  const args = buildDockerSkillArguments({
    image: NODE_IMAGE,
    containerName: "looloomi-skill-node-proof",
    inputVolumeName: "looloomi-skill-node-proof-input",
    runtimeManifest: {
      runtime: "nodejs20-typescript",
      entrypoint: "scripts/main.ts",
      protocol: { stdin: "json", stdout: "json" },
      permissions: {
        network: false,
        connections: [],
        externalActions: false,
        filesystem: "scratch-only",
      },
      limits: { timeoutSeconds: 45, memoryMiB: 256 },
    },
  });

  assert.equal(args.includes("--network"), true);
  assert.equal(args.includes("none"), true);
  assert.equal(args.includes("--read-only"), true);
  assert.deepEqual(option(args, "--memory"), [String(256 * 1024 * 1024)]);
  assert.deepEqual(args.slice(0, 2), ["container", "create"]);
  assert.deepEqual(option(args, "--mount"), [
    "type=volume,src=looloomi-skill-node-proof-input,dst=/workspace,readonly",
  ]);
  assert.deepEqual(args.slice(-3), [NODE_IMAGE, "tsx", "/workspace/skill/scripts/main.ts"]);
});

test("Docker executor emits the deterministic isolation policy and one JSON stdin object", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = executablePackage();
  const calls = [];
  const controls = [];
  const controlledDocker = createDockerController(controls);
  let receivedInput;
  let materializedMode;
  const dockerControl = async (args) => {
    if (`${args[0]} ${args[1]}` === "container cp" && args.at(-1).endsWith(":/workspace/skill")) {
      const packageRoot = args[2].slice(0, -2);
      materializedMode = {
        root: (await stat(packageRoot)).mode & 0o777,
        skill: (await stat(join(packageRoot, "SKILL.md"))).mode & 0o777,
        manifest: (await stat(join(packageRoot, "skill.runtime.json"))).mode & 0o777,
        script: (await stat(join(packageRoot, "scripts/main.py"))).mode & 0o777,
      };
    }
    return controlledDocker(args);
  };
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    const chunks = [];
    child.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stdin.on("finish", () => {
      receivedInput = Buffer.concat(chunks).toString("utf8");
      child.stdout.end('{"ok":true,"value":7}\n');
      child.stderr.end();
      child.close(0);
    });
    return child;
  };
  const executor = createDockerSkillExecutor({
    objectStore: fixture.objectStore,
    image: IMAGE,
    tempRoot: root,
    idFactory: () => "policy-proof",
    dockerEnvironment: { PATH: "/safe/bin" },
    spawnProcess,
    dockerControl,
  });

  assert.deepEqual(await executor.execute(fixture.request), { ok: true, value: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "docker");
  assert.deepEqual(calls[0].options.env, { PATH: "/safe/bin" });
  assert.equal(receivedInput, '{"value":7}\n');
  assert.deepEqual(materializedMode, { root: 0o555, skill: 0o444, manifest: 0o444, script: 0o444 });

  assert.deepEqual(calls[0].args, [
    "container", "start", "--attach", "--interactive", "looloomi-skill-policy-proof",
  ]);
  const args = controls.find((entry) => entry[0] === "container"
    && entry[1] === "create"
    && entry.includes("looloomi-skill-policy-proof"));
  assert.ok(args);
  assert.deepEqual(option(args, "--pull"), ["never"]);
  assert.equal(args.includes("--rm"), false);
  assert.deepEqual(options(args, "--label"), [
    `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
    `${DOCKER_SKILL_INVOCATION_LABEL}=looloomi-skill-policy-proof`,
  ]);
  assert.deepEqual(option(args, "--network"), ["none"]);
  assert.equal(args.includes("--read-only"), true);
  assert.deepEqual(option(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(option(args, "--security-opt"), ["no-new-privileges"]);
  assert.deepEqual(option(args, "--user"), ["65534:65534"]);
  assert.deepEqual(option(args, "--pids-limit"), ["64"]);
  assert.deepEqual(option(args, "--memory"), [String(128 * 1024 * 1024)]);
  assert.deepEqual(option(args, "--cpus"), ["0.5"]);
  assert.match(option(args, "--tmpfs")[0], /^\/tmp:rw,noexec,nosuid,nodev,size=\d+,mode=1777$/);
  assert.deepEqual(option(args, "--mount"), [
    "type=volume,src=looloomi-skill-policy-proof-input,dst=/workspace,readonly",
  ]);
  assert.equal(args.some((value) => value.includes(root)), false);
  assert.equal(args.some((value) => value.startsWith("type=bind")), false);
  assert.equal(args.includes("--env"), false);
  assert.deepEqual(args.slice(-3), [IMAGE, "python3.12", "/workspace/skill/scripts/main.py"]);
  assert.ok(controls.some((entry) => entry[0] === "volume" && entry[1] === "create"));
  assert.ok(controls.some((entry) => entry[0] === "container"
    && entry[1] === "create"
    && entry.includes("looloomi-skill-policy-proof-staging")));
  assert.ok(controls.some((entry) => entry[0] === "container" && entry[1] === "cp"));
  assert.ok(controls.some((entry) => entry[0] === "volume" && entry[1] === "rm"));
  assert.deepEqual(await readdir(root), []);
});

test("Docker executor blocks substituted objects and stale inspections before spawn", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = executablePackage();
  let spawnCount = 0;
  const executor = createDockerSkillExecutor({
    objectStore: fixture.objectStore,
    image: IMAGE,
    tempRoot: root,
    spawnProcess: () => {
      spawnCount += 1;
      return new FakeChild();
    },
    dockerControl: async () => {},
  });

  await assert.rejects(
    executor.execute({ ...fixture.request, objectContentHash: `sha256:${"0".repeat(64)}` }),
    isCode("skill_execution_blocked"),
  );
  await assert.rejects(
    executor.execute({ ...fixture.request, inspection: { ...fixture.request.inspection, status: "passed" } }),
    isCode("skill_execution_blocked"),
  );
  await assert.rejects(
    executor.execute({ ...fixture.request, packageContentHash: `sha256:${"1".repeat(64)}` }),
    isCode("skill_execution_blocked"),
  );
  await assert.rejects(
    executor.execute({ ...fixture.request, input: { toJSON: () => [] } }),
    isCode("skill_execution_blocked"),
  );
  assert.equal(spawnCount, 0);
  assert.deepEqual(await readdir(root), []);
});

test("unsupported package layouts and unavailable Docker return one product-safe blocked error", async (t) => {
  const root = await temporaryRoot(t);
  const expanded = executablePackage(SCRIPT, [{ path: "references/extra.txt", content: "extra" }]);
  const expandedExecutor = createDockerSkillExecutor({
    objectStore: expanded.objectStore,
    image: IMAGE,
    tempRoot: root,
    spawnProcess: () => assert.fail("unsupported packages must not spawn Docker"),
    dockerControl: async () => {},
  });
  await assert.rejects(expandedExecutor.execute(expanded.request), isCode("skill_execution_blocked"));

  const fixture = executablePackage();
  const unavailableExecutor = createDockerSkillExecutor({
    objectStore: fixture.objectStore,
    image: IMAGE,
    tempRoot: root,
    spawnProcess: () => {
      const failure = new Error("docker unavailable with internal host details");
      failure.code = "ENOENT";
      throw failure;
    },
    dockerControl: async () => {},
  });
  await assert.rejects(
    unavailableExecutor.execute(fixture.request),
    (error) => isCode("skill_execution_blocked")(error)
      && error.message === "This uploaded Skill is not available for isolated execution."
      && !error.message.includes("host details"),
  );
  assert.deepEqual(await readdir(root), []);
});

test("Docker executor enforces JSON-object stdout", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = executablePackage();
  const controls = [];
  const spawnProcess = () => {
    const child = new FakeChild();
    child.stdin.on("finish", () => {
      child.stdout.end("[]\n");
      child.close(0);
    });
    return child;
  };
  const executor = createDockerSkillExecutor({
    objectStore: fixture.objectStore,
    image: IMAGE,
    tempRoot: root,
    spawnProcess,
    dockerControl: createDockerController(controls),
  });
  await assert.rejects(executor.execute(fixture.request), isCode("skill_execution_invalid_output"));
  assert.deepEqual(await readdir(root), []);
});

test("timeout and AbortSignal cancellation kill the named container and clean temporary files", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = executablePackage();
  const controls = [];
  const dockerControl = createDockerController(controls, { defaultRunning: true });
  let sequence = 0;
  let notifySpawn;
  const spawned = () => new Promise((resolve) => { notifySpawn = resolve; });
  let currentSpawn = spawned();
  const spawnProcess = () => {
    const child = new FakeChild();
    notifySpawn?.();
    return child;
  };
  const makeExecutor = (timeoutMs) => createDockerSkillExecutor({
    objectStore: fixture.objectStore,
    image: IMAGE,
    tempRoot: root,
    limits: { timeoutMs },
    idFactory: () => `termination-${++sequence}`,
    spawnProcess,
    dockerControl,
  });

  const timedOut = makeExecutor(10).execute(fixture.request);
  await currentSpawn;
  await assert.rejects(timedOut, isCode("skill_execution_timed_out"));

  const controller = new AbortController();
  currentSpawn = spawned();
  const cancelled = makeExecutor(5_000).execute({ ...fixture.request, signal: controller.signal });
  await currentSpawn;
  controller.abort();
  await assert.rejects(cancelled, isCode("skill_execution_cancelled"));

  assert.deepEqual(controls.filter((args) => args[1] === "kill").map((args) => args.at(-1)), [
    "looloomi-skill-termination-1",
    "looloomi-skill-termination-2",
  ]);
  assert.ok(controls.filter((args) => args[0] === "container" && args[1] === "inspect").length >= 4);
  assert.equal(controls.filter((args) => args[0] === "container" && args[1] === "rm").length, 4);
  assert.deepEqual(await readdir(root), []);
});

test("stdout and stderr overflow kill the named container", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = executablePackage();
  const controls = [];
  const dockerControl = createDockerController(controls, { defaultRunning: true });
  let sequence = 0;

  for (const channel of ["stdout", "stderr"]) {
    const spawnProcess = () => {
      const child = new FakeChild();
      child.stdin.on("finish", () => child[channel].write(Buffer.alloc(33, 65)));
      return child;
    };
    const executor = createDockerSkillExecutor({
      objectStore: fixture.objectStore,
      image: IMAGE,
      tempRoot: root,
      limits: { maxStdoutBytes: 32, maxStderrBytes: 32, maxOutputBytes: 32 },
      idFactory: () => `overflow-${++sequence}`,
      spawnProcess,
      dockerControl,
    });
    await assert.rejects(executor.execute(fixture.request), isCode("skill_execution_output_limit"));
  }

  assert.deepEqual(controls.filter((args) => args[1] === "kill").map((args) => args.at(-1)), [
    "looloomi-skill-overflow-1",
    "looloomi-skill-overflow-2",
  ]);
  assert.deepEqual(await readdir(root), []);
});

test("container and temporary cleanup failures return one product-safe fail-closed error", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = executablePackage();
  const controls = [];
  const spawnProcess = () => {
    const child = new FakeChild();
    child.stdin.on("finish", () => {
      child.stdout.end('{"ok":true}\n');
      child.close(0);
    });
    return child;
  };
  const executor = createDockerSkillExecutor({
    objectStore: fixture.objectStore,
    image: IMAGE,
    tempRoot: root,
    idFactory: () => "cleanup-failure",
    spawnProcess,
    dockerControl: createDockerController(controls, { failCommand: "container rm" }),
  });
  await assert.rejects(
    executor.execute(fixture.request),
    (error) => isCode("skill_execution_cleanup_failed")(error)
      && error.message === "The isolated Skill environment could not be cleaned up safely."
      && !error.message.includes(root),
  );
  assert.deepEqual(await readdir(root), []);

  const invocationRoot = await mkdtemp(join(root, "execution-"));
  await assert.rejects(
    cleanupSkillInvocationDirectory(invocationRoot, {
      removePath: async () => { throw new Error(`private path: ${invocationRoot}`); },
    }),
    (error) => isCode("skill_execution_cleanup_failed")(error) && !error.message.includes(invocationRoot),
  );
});

test("startup scavenging removes only labelled containers and invocation directories", async (t) => {
  const root = await temporaryRoot(t);
  const ownedRoot = join(root, "execution-owned");
  const unownedRoot = join(root, "execution-unowned");
  await mkdir(ownedRoot);
  await mkdir(unownedRoot);
  await writeFile(join(ownedRoot, ".looloomi-skill-invocation.json"), JSON.stringify({
    owner: `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
    containerName: "looloomi-skill-stale",
    inputVolumeName: "looloomi-skill-stale-input",
  }));
  await writeFile(join(unownedRoot, ".looloomi-skill-invocation.json"), JSON.stringify({
    owner: "another-product=v1",
    containerName: "looloomi-skill-unowned",
  }));

  const controls = [];
  const result = await scavengeDockerSkillExecutions({
    dockerControl: createDockerController(controls, {
      containers: [
        "looloomi-skill-stale",
        "looloomi-skill-stale-staging",
        "looloomi-skill-other-server",
      ],
      volumes: ["looloomi-skill-stale-input"],
    }),
    tempRoot: root,
  });
  assert.deepEqual(result, { containersRemoved: 2, volumesRemoved: 1, directoriesRemoved: 1 });
  assert.deepEqual(await readdir(root), ["execution-unowned"]);
  assert.ok(controls.some((args) => args[1] === "kill"));
  assert.ok(controls.some((args) => args[1] === "inspect"));
  assert.ok(controls.some((args) => args[1] === "rm"));
  for (const args of controls.filter((entry) => entry[0] === "container" && entry[1] === "ls")) {
    assert.ok(args.includes(`label=${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`));
  }
  assert.equal(controls.some((args) => args.includes("looloomi-skill-other-server")), false);
});

function option(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `${name} missing`);
  return [args[index + 1]];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function isCode(code) {
  return (error) => error instanceof DockerSkillExecutorError && error.code === code && error.productSafe === true;
}
