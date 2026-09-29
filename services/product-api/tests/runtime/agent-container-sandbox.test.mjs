import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "com.looloomi.pi.version": "0.85.1",
  "com.looloomi.pi-subagent.version": "0.4.8",
  "com.looloomi.pi-workflow.version": "0.10.1",
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
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
  limits: {
    timeoutMs: 1_000, maxSteps: 3, maxModelRequests: 1, maxChildren: 0,
    maxInputBytes: 10_000, maxOutputBytes: 10_000, maxImageCount: 0, maxCostUsdMicros: 1_000_000,
  },
  capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
  resultSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
  evidenceRequirements: [],
  metadata: {
    outerNodeId: "node-agent",
    modelProfileRevisionId: "model-revision-agent-a",
    modelCapability: "tool_calling",
    fallbackModelProfileRevisionIds: [],
    providerSecret: "must-not-cross",
    hostPath: "/private/repo",
  },
  ...overrides,
});

const lease = {
  capabilityLeaseId: "lease-agent-a",
  invocationId: "invocation-agent-a",
  attemptId: "attempt-agent-a",
  expiresAt: "2035-01-01T00:00:00.000Z",
};

test("Agent container arguments share the strict isolation policy and mount no source worktree", () => {
  const args = buildAgentContainerArguments({
    image: IMAGE,
    containerName: "looloomi-agent-proof",
    invocationId: "invocation-agent-a",
    outputRoot: "/tmp/output",
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
  assert.equal(options(args, "--ulimit").includes("fsize=4096:4096"), true);
  assert.equal(args.includes("--interactive"), true);
  assert.deepEqual(options(args, "--env"), [
    "HOME=/tmp",
    "HTTP_PROXY=",
    "HTTPS_PROXY=",
    "NO_PROXY=",
    "http_proxy=",
    "https_proxy=",
    "no_proxy=",
  ]);
  const mounts = options(args, "--mount");
  assert.equal(mounts.length, 1);
  assert.match(mounts[0], /dst=\/work\/output$/);
  assert.equal(args.some((item) => item.includes("domains/") || item.includes("providerSecret")), false);
  assert.deepEqual(args.slice(-3), [IMAGE, "node", "/opt/turnsu/packages/agent-runtime/worker/worker.mjs"]);
  const hostOwned = buildAgentContainerArguments({
    image: IMAGE,
    containerName: "looloomi-agent-host-owned",
    invocationId: "invocation-agent-a",
    outputRoot: "/tmp/output",
    containerUser: "1001:1001",
    limits: { maxOutputBytes: 4096 },
  });
  assert.equal(option(hostOwned, "--user"), "1001:1001");
  assert.throws(() => buildAgentContainerArguments({
    image: IMAGE,
    containerName: "looloomi-agent-root-forbidden",
    invocationId: "invocation-agent-a",
    outputRoot: "/tmp/output",
    containerUser: "0:0",
    limits: { maxOutputBytes: 4096 },
  }), { message: "agent_container_arguments_invalid" });
});

test("Agent sandbox passes only governed input and strips image, host, and socket details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-sandbox-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let payload;
  let environment;
  const gatewayRequests = [];
  const workerEvents = [];
  let childUpdate;
  const gatewayServer = {
    async open(binding) {
      return {
        async handle(message) {
          gatewayRequests.push({ binding, message });
          return { text: "model result" };
        },
        snapshot() {
          return binding.invocationId === "invocation-agent-a"
            ? {
                requestedModelRevisionId: "model-revision-agent-a",
                actualModelRevisionId: "model-revision-agent-a",
                usage: { steps: 1, modelRequests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, imageCount: 0, costUsdMicros: 30 },
              }
            : { requestedModelRevisionId: null, actualModelRevisionId: null,
                usage: { steps: 1, modelRequests: 1, inputTokens: 50, outputTokens: 10, totalTokens: 60, imageCount: 0, costUsdMicros: 10 } };
        },
        async close() {},
      };
    },
  };
  const dockerControl = async (args) => {
    if (args[0] === "image") return { code: 0, stdout: `${JSON.stringify(VERSIONS)}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "not found" };
  };
  const spawnProcess = (_command, args, optionsValue) => {
    environment = optionsValue.env;
    const child = new FakeChild();
    let source = "";
    child.stdin.on("data", (chunk) => {
      source += chunk.toString("utf8");
      while (source.includes("\n")) {
        const newline = source.indexOf("\n");
        const frame = JSON.parse(source.slice(0, newline));
        source = source.slice(newline + 1);
        if (frame.kind === "start") {
          payload = frame.payload;
          child.stdout.write(`${JSON.stringify({
            kind: "event",
            type: "kernel.model_visible",
            payload: {
              modelVisibleEvent: {
                schemaVersion: "agent-kernel-model-visible-event-v1",
                eventId: "kernel-event-sandbox-a",
                runId: "kernel-run-sandbox-a",
                session: { sessionId: "session-sandbox-a", branchId: null },
                sequence: 1,
                type: "message",
                payload: { role: "assistant", text: "Kernel-visible output." },
                occurredAt: "2026-08-14T00:00:00.000Z",
              },
            },
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            kind: "rpc_request",
            id: "rpc-1",
            message: {
              operation: "model",
              invocationId: payload.invocationId,
              attemptId: payload.attemptId,
              capabilityLeaseId: payload.gateway.capabilityLeaseId,
              input: { context: "safe" },
            },
          })}\n`);
        } else if (frame.kind === "rpc_response" && frame.id === "rpc-1") {
          assert.equal(frame.ok, true);
          child.stdout.write(`${JSON.stringify({ kind: "child_request", id: "child-1", update: { childRef: "child-a", status: "running" } })}\n`);
        } else if (frame.kind === "child_response") {
          assert.equal(frame.ok, true);
          child.stdout.write(`${JSON.stringify({
            kind: "rpc_request",
            id: "rpc-child",
            message: {
              operation: "model",
              invocationId: frame.result.invocationId,
              attemptId: frame.result.attemptId,
              capabilityLeaseId: frame.result.capabilityLeaseId,
              input: { context: "child-safe" },
            },
          })}\n`);
        } else if (frame.kind === "rpc_response" && frame.id === "rpc-child") {
          assert.equal(frame.ok, true);
          child.stdout.end(`${JSON.stringify({
            kind: "result",
            result: {
              output: { ok: true },
              summary: "done",
              evidence: [],
              usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
              imageDigest: IMAGE,
              hostPath: root,
              socketPath: "/tmp/gateway.sock",
            },
          })}\n`);
          child.close(0);
        }
      }
    });
    return child;
  };
  const sandbox = new AgentContainerSandbox({ image: IMAGE, gatewayServer, dockerControl, spawnProcess, tempRoot: root, dockerEnvironment: { PATH: "/safe/bin" } });
  const result = await sandbox.run({
    request: request({
      mode: "agent_orchestrator",
      limits: { ...request().limits, maxModelRequests: 2, maxChildren: 1 },
    }),
    lease,
    reportChild(update) {
      childUpdate = update;
      return {
        invocationId: "invocation-child-a",
        attemptId: "attempt-child-a",
        capabilityLeaseId: "lease-child-a",
      };
    },
    emit(type, value) { workerEvents.push({ type, value }); },
  });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.requestedModelRevisionId, "model-revision-agent-a");
  assert.equal(result.actualModelRevisionId, "model-revision-agent-a");
  assert.equal(result.usage.totalTokens, 180);
  assert.equal(result.usage.inputTokens, 150);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.usage.costUsdMicros, 40);
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(Object.hasOwn(result, "imageDigest"), false);
  assert.equal(Object.hasOwn(result, "hostPath"), false);
  assert.equal(Object.hasOwn(result, "socketPath"), false);
  assert.deepEqual(environment, { PATH: "/safe/bin" });
  assert.deepEqual(payload.metadata, { outerNodeId: "node-agent" });
  assert.equal(JSON.stringify(payload).includes("must-not-cross"), false);
  assert.deepEqual(payload.runtimeVersions, { pi: "0.85.1", subagent: "0.4.8", workflow: "0.10.1" });
  assert.equal(Object.hasOwn(payload, "agentKernel"), false);
  assert.deepEqual(payload.gateway, { transport: "stdio-jsonl-v1", capabilityLeaseId: "lease-agent-a" });
  assert.deepEqual({ ...payload.executionGrant, grantId: "checked-below" }, {
    schemaVersion: "agent-kernel-execution-grant-v1",
    grantId: "checked-below",
    expiresAt: "2035-01-01T00:00:00.000Z",
    allowedToolIds: [],
    allowedEffectClasses: [],
    maxToolCalls: 0,
    scopeRef: "invocation-agent-a",
  });
  assert.equal(JSON.stringify(gatewayRequests).includes("must-not-cross"), false);
  assert.equal(gatewayRequests.length, 2);
  assert.equal(gatewayRequests[0].binding.capabilityLeaseId, "lease-agent-a");
  assert.equal(gatewayRequests[1].binding.capabilityLeaseId, "lease-child-a");
  assert.equal(gatewayRequests[1].message.invocationId, "invocation-child-a");
  assert.deepEqual(childUpdate, { childRef: "child-a", status: "running" });
  assert.deepEqual(workerEvents.filter((event) => event.type === "agent.kernel.model_visible"), [{
    type: "agent.kernel.model_visible",
    value: {
      modelVisibleEvent: {
        schemaVersion: "agent-kernel-model-visible-event-v1",
        eventId: "kernel-event-sandbox-a",
        runId: "kernel-run-sandbox-a",
        session: { sessionId: "session-sandbox-a", branchId: null },
        sequence: 1,
        type: "message",
        payload: { role: "assistant", text: "Kernel-visible output." },
        occurredAt: "2026-08-14T00:00:00.000Z",
      },
    },
  }]);
});

test("Agent artifact output is bounded and Docker unavailability never falls back to process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-output-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gatewayServer = {
    async open() { return { async handle() { return {}; }, async close() {} }; },
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
      child.stdin.once("data", async () => {
        const outputMount = options(args, "--mount").find((item) => item.includes("dst=/work/output"));
        const outputRoot = outputMount.match(/src=(.*),dst=\/work\/output$/)[1];
        await writeFile(join(outputRoot, "oversized.txt"), "x".repeat(33));
        child.stdout.end(`${JSON.stringify({ kind: "result", result: { output: {}, summary: "done", evidence: [], usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 } } })}\n`);
        child.close(0);
      });
      return child;
    },
  });
  await assert.rejects(sandbox.run({ request: request({ limits: { ...request().limits, maxOutputBytes: 32 } }), lease }), { code: "agent_sandbox_output_limit" });

  let processFallbackCalls = 0;
  const persistence = new InMemoryExecutionPersistence();
  let id = 0;
  const broker = new ExecutionBroker({
    persistence,
    clock: () => "2026-07-16T12:00:00.000Z",
    idFactory: (kind) => `${kind}-${++id}`,
    capacityAuthorizer: { async authorize() { return true; } },
  });
  broker.registerBackend({ mode: "bounded_agent", isolation: "process", backend: { async execute() { processFallbackCalls += 1; return {}; } } });
  broker.registerBackend({ mode: "bounded_agent", isolation: "container", backend: createAgentContainerBackend({ sandbox: { async run() { const error = new Error("docker down"); error.status = "sandbox_unavailable"; throw error; } } }) });
  const result = await broker.execute(request());
  assert.equal(result.status, "sandbox_unavailable");
  assert.equal(result.isolation, "container");
  assert.equal(processFallbackCalls, 0);
});

test("Agent sandbox commits streamed Worker transcript as a governed Artifact and exposes only its safe reference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-transcript-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commits = [];
  const events = [];
  let eventSessionId = null;
  const transcriptArtifactService = {
    async commit(input) {
      commits.push(input);
      return {
        schemaVersion: "workbench-v1",
        kind: "worker_transcript",
        transcriptArtifactId: "worker-transcript-a",
        sensitivity: "sensitive",
        expiresAt: "2026-08-02T00:00:00.000Z",
      };
    },
  };
  const gatewayServer = {
    async open() { return { async handle() { return {}; }, async close() {} }; },
  };
  const dockerControl = async (args) => args[0] === "image"
    ? { code: 0, stdout: `${JSON.stringify(VERSIONS)}\n`, stderr: "" }
    : { code: 1, stdout: "", stderr: "not found" };
  const privateTranscript = JSON.stringify({ messages: [{ role: "assistant", text: "private worker trace" }] });
  const spawnProcess = () => {
    const child = new FakeChild();
    child.stdin.once("data", () => {
      if (eventSessionId) child.stdout.write(`${JSON.stringify({ kind: "event", type: "kernel.model_visible",
        payload: { modelVisibleEvent: { session: { sessionId: eventSessionId, branchId: null } } } })}\n`);
      const bytes = Buffer.from(privateTranscript, "utf8");
      const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      child.stdout.write(`${JSON.stringify({
        kind: "transcript_start",
        mediaType: "application/json",
        byteLength: bytes.byteLength,
        contentHash,
      })}\n`);
      child.stdout.write(`${JSON.stringify({
        kind: "transcript_chunk",
        sequence: 1,
        bytesBase64: bytes.toString("base64"),
      })}\n`);
      child.stdout.write(`${JSON.stringify({ kind: "transcript_end", chunks: 1 })}\n`);
      child.stdout.end(`${JSON.stringify({
        kind: "result",
        result: {
          status: "completed",
          output: { ok: true },
          summary: "done",
          evidence: [],
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        },
      })}\n`);
      setImmediate(() => child.close(0));
    });
    return child;
  };
  const sandbox = new AgentContainerSandbox({
    image: IMAGE,
    gatewayServer,
    dockerControl,
    spawnProcess,
    tempRoot: root,
    transcriptArtifactService,
    requireTranscriptArtifact: true,
  });
  const result = await sandbox.run({
    request: request({
      actor: { userId: "user-a" },
      lineage: {
        productCommandId: "command-a",
        sessionId: "session-a",
        turnId: "turn-a",
      },
    }),
    lease,
  });
  assert.equal(commits.length, 1);
  assert.equal(Buffer.from(commits[0].content).toString("utf8"), privateTranscript);
  assert.deepEqual(commits[0].objectScope, { objectKind: "agent_session", objectId: "session-a" });
  assert.equal(commits[0].ownerUserId, "user-a");
  assert.equal(JSON.stringify(result).includes("private worker trace"), false);
  assert.deepEqual(result.evidence, [{ kind: "worker_transcript", ref: "worker-transcript:worker-transcript-a" }]);
  eventSessionId = "builder-proposal-a";
  await sandbox.run({ request: request({ actor: { userId: "user-a" },
    lineage: { productCommandId: "builder-command-a", sessionId: "builder-proposal-a", turnId: "builder-proposal-a" },
    metadata: { agentKind: "builder_proposal", objectKind: "staged_loop", objectId: "proposal-a" },
  }), lease, emit: (type, payload) => events.push({ type, payload }) });
  assert.deepEqual(commits[1].objectScope, { objectKind: "builder_proposal", objectId: "proposal-a" });
  assert.equal(commits[1].ownerUserId, "user-a");
  assert.equal(events[0].type, "agent.builder.model_visible");
  eventSessionId = "unrelated-session";
  await assert.rejects(sandbox.run({ request: request({ actor: { userId: "user-a" },
    lineage: { productCommandId: "builder-command-a", sessionId: "builder-proposal-a", turnId: "builder-proposal-a" },
    metadata: { agentKind: "builder_proposal", objectKind: "staged_loop", objectId: "proposal-a" },
  }), lease, emit: (type, payload) => events.push({ type, payload }) }), { code: "builder_worker_session_mismatch" });
  assert.equal(events.length, 1);
  assert.equal(commits.length, 2);
});

test("Agent sandbox fails closed when a Worker transcript has no governed host storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-transcript-missing-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gatewayServer = {
    async open() { return { async handle() { return {}; }, async close() {} }; },
  };
  const dockerControl = async (args) => args[0] === "image"
    ? { code: 0, stdout: `${JSON.stringify(VERSIONS)}\n`, stderr: "" }
    : { code: 1, stdout: "", stderr: "not found" };
  const sandbox = new AgentContainerSandbox({
    image: IMAGE,
    gatewayServer,
    dockerControl,
    tempRoot: root,
    spawnProcess() { throw new Error("must_not_spawn"); },
    requireTranscriptArtifact: true,
  });
  await assert.rejects(sandbox.run({ request: request(), lease }), {
    code: "worker_transcript_storage_unavailable",
  });
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
