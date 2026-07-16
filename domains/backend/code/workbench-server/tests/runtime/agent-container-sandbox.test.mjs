import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ExecutionBroker, InMemoryExecutionPersistence } from "../../src/execution/index.mjs";
import {
  AgentContainerSandbox,
  buildAgentContainerArguments,
  createAgentContainerBackend,
} from "../../src/runtime/index.mjs";

const IMAGE = `looloomi-agent@sha256:${"a".repeat(64)}`;
const VERSIONS = {
  "com.looloomi.pi.version": "0.80.7",
  "com.looloomi.pi-subagent.version": "0.4.8",
  "com.looloomi.pi-workflow.version": "0.8.1",
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }
  close(code = 0) { queueMicrotask(() => this.emit("close", code)); }
  kill() { this.killed = true; this.close(null); }
}

const request = (overrides = {}) => ({
  schemaVersion: "workbench-execution-fabric-v1",
  invocationId: "invocation-agent-a",
  attemptId: "attempt-agent-a",
  workspaceId: "workspace-a",
  controller: { kind: "agent_turn", controllerId: "turn-a", fence: 1 },
  mode: "bounded_agent",
  isolation: "container",
  goal: "Return a bounded result.",
  input: { value: 1 },
  limits: { timeoutMs: 1_000, maxSteps: 3, maxModelRequests: 1, maxChildren: 0, maxInputBytes: 10_000, maxOutputBytes: 10_000 },
  capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
  resultSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
  evidenceRequirements: [],
  metadata: { outerNodeId: "node-agent", providerSecret: "must-not-cross", hostPath: "/private/repo" },
  ...overrides,
});

const lease = {
  capabilityLeaseId: "lease-agent-a",
  invocationId: "invocation-agent-a",
  attemptId: "attempt-agent-a",
};

test("Agent container arguments share the strict isolation policy and mount no source worktree", () => {
  const args = buildAgentContainerArguments({
    image: IMAGE,
    containerName: "looloomi-agent-proof",
    invocationId: "invocation-agent-a",
    inputRoot: "/tmp/input",
    outputRoot: "/tmp/output",
    gatewaySocketPath: "/tmp/gateway.sock",
    gatewayNonce: "nonce-a",
    limits: { pids: 64, memoryBytes: 256 * 1024 * 1024, cpus: 0.5, tmpfsBytes: 1024, maxStdoutBytes: 1024, maxStderrBytes: 1024, maxArtifactFiles: 4, maxOutputBytes: 4096 },
  });
  assert.deepEqual(option(args, "--network"), "none");
  assert.equal(args.includes("--read-only"), true);
  assert.deepEqual(option(args, "--cap-drop"), "ALL");
  assert.deepEqual(option(args, "--security-opt"), "no-new-privileges");
  assert.deepEqual(option(args, "--user"), "65534:65534");
  assert.deepEqual(option(args, "--pids-limit"), "64");
  assert.deepEqual(option(args, "--memory"), String(256 * 1024 * 1024));
  assert.deepEqual(option(args, "--cpus"), "0.5");
  const mounts = options(args, "--mount");
  assert.equal(mounts.length, 3);
  assert.match(mounts[0], /dst=\/work\/input,readonly$/);
  assert.match(mounts[1], /dst=\/work\/output$/);
  assert.match(mounts[2], /dst=\/run\/looloomi\/gateway.sock$/);
  assert.equal(args.some((item) => item.includes("domains/") || item.includes("providerSecret")), false);
  assert.deepEqual(args.slice(-4), [IMAGE, "node", "/opt/looloomi-agent/worker.mjs", "/work/input/request.json"]);
});

test("Agent sandbox passes only governed input and strips image, host, and socket details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-sandbox-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let payload;
  let environment;
  const gatewayServer = {
    async open() { return { socketPath: "/tmp/gateway.sock", containerSocketPath: "/run/looloomi/gateway.sock", nonce: "nonce-a", async close() {} }; },
  };
  const dockerControl = async (args) => {
    if (args[0] === "image") return { code: 0, stdout: `${JSON.stringify(VERSIONS)}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "not found" };
  };
  const spawnProcess = (_command, args, optionsValue) => {
    environment = optionsValue.env;
    const child = new FakeChild();
    queueMicrotask(async () => {
      const inputMount = options(args, "--mount").find((item) => item.includes("dst=/work/input"));
      const inputRoot = inputMount.match(/src=(.*),dst=\/work\/input,readonly$/)[1];
      payload = JSON.parse(await readFile(join(inputRoot, "request.json"), "utf8"));
      child.stdout.end(JSON.stringify({
        output: { ok: true },
        summary: "done",
        evidence: [],
        usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        imageDigest: IMAGE,
        hostPath: root,
        socketPath: "/tmp/gateway.sock",
      }));
      child.close(0);
    });
    return child;
  };
  const sandbox = new AgentContainerSandbox({ image: IMAGE, gatewayServer, dockerControl, spawnProcess, tempRoot: root, dockerEnvironment: { PATH: "/safe/bin" } });
  const result = await sandbox.run({ request: request(), lease });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(Object.hasOwn(result, "imageDigest"), false);
  assert.equal(Object.hasOwn(result, "hostPath"), false);
  assert.equal(Object.hasOwn(result, "socketPath"), false);
  assert.deepEqual(environment, { PATH: "/safe/bin" });
  assert.deepEqual(payload.metadata, { outerNodeId: "node-agent" });
  assert.equal(JSON.stringify(payload).includes("must-not-cross"), false);
  assert.deepEqual(payload.runtimeVersions, { pi: "0.80.7", subagent: "0.4.8", workflow: "0.8.1" });
});

test("Agent artifact output is bounded and Docker unavailability never falls back to process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-output-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gatewayServer = {
    async open() { return { socketPath: "/tmp/gateway.sock", containerSocketPath: "/run/looloomi/gateway.sock", nonce: "nonce-a", async close() {} }; },
  };
  const dockerControl = async (args) => {
    if (args[0] === "image") return { code: 0, stdout: `${JSON.stringify(VERSIONS)}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "not found" };
  };
  const sandbox = new AgentContainerSandbox({
    image: IMAGE,
    gatewayServer,
    dockerControl,
    tempRoot: root,
    spawnProcess: (_command, args) => {
      const child = new FakeChild();
      queueMicrotask(async () => {
        const outputMount = options(args, "--mount").find((item) => item.includes("dst=/work/output"));
        const outputRoot = outputMount.match(/src=(.*),dst=\/work\/output$/)[1];
        await writeFile(join(outputRoot, "oversized.txt"), "x".repeat(33));
        child.stdout.end(JSON.stringify({ output: {}, summary: "done", evidence: [], usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 } }));
        child.close(0);
      });
      return child;
    },
  });
  await assert.rejects(sandbox.run({ request: request({ limits: { ...request().limits, maxOutputBytes: 32 } }), lease }), { code: "agent_sandbox_output_limit" });

  let processFallbackCalls = 0;
  const persistence = new InMemoryExecutionPersistence();
  let id = 0;
  const broker = new ExecutionBroker({ persistence, clock: () => "2026-07-16T12:00:00.000Z", idFactory: (kind) => `${kind}-${++id}` });
  broker.registerBackend({ mode: "bounded_agent", isolation: "process", backend: { async execute() { processFallbackCalls += 1; return {}; } } });
  broker.registerBackend({ mode: "bounded_agent", isolation: "container", backend: createAgentContainerBackend({ sandbox: { async run() { const error = new Error("docker down"); error.status = "sandbox_unavailable"; throw error; } } }) });
  const result = await broker.execute(request());
  assert.equal(result.status, "sandbox_unavailable");
  assert.equal(result.isolation, "container");
  assert.equal(processFallbackCalls, 0);
});

function option(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `${name} missing`);
  return args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name) values.push(args[index + 1]);
  return values;
}
