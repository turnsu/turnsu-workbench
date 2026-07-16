import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWorkflowSkillExecutorRegistry,
} from "../../../../../agent/code/agent-runtime/core/workflow/workflow-skill-executor-registry.mjs";
import { createGateEngine } from "../../../../../agent/code/agent-runtime/core/gates/gate-engine.mjs";
import { createAgentRuntimeCore } from "../../../../../agent/code/agent-runtime/core/run-loop/agent-runtime-core.mjs";
import {
  registerWorkflowConformanceExecutor,
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
  WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
} from "../../../../../agent/code/agent-runtime/extensions/workflow-conformance/binding.mjs";
import { createPiBackedAgentRuntime, createPiKernelAdapter } from "../../../../../agent/code/agent-runtime/kernels/pi/pi-kernel-adapter.mjs";
import { resolveRuntimePaths } from "../../../../../agent/code/agent-runtime/lib/runtime-paths.mjs";

import { createWorkflowRunner } from "../../src/runner/index.mjs";
import { createInProcessAgentAdapter } from "../../src/runtime/index.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const DATABASE_NAME = process.env.MONGODB_DB ?? "looloomi_workbench_test";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../../../");
const agentRuntimeRoot = join(repoRoot, "domains", "agent", "code", "agent-runtime");

test("Mongo WorkflowRunner runs the conformance adapter across review, idempotency, restart, and final authority", { skip: !ENABLED, timeout: 90_000 }, async (t) => {
  if (!DATABASE_NAME.endsWith("_test")) throw new Error(`integration_database_must_end_in_test:${DATABASE_NAME}`);
  const runtimeRoot = mkdtempSync(join(tmpdir(), "looloomi-runner-integration-"));
  const previous = { testMode: process.env.WECHAT_AGENT_TEST_MODE, runtimeRoot: process.env.WECHAT_AGENT_RUNTIME_ROOT, offline: process.env.PI_OFFLINE };
  process.env.WECHAT_AGENT_TEST_MODE = "1";
  process.env.WECHAT_AGENT_RUNTIME_ROOT = runtimeRoot;
  process.env.PI_OFFLINE = "1";
  const store = new ProductMongoStore({ uri: MONGODB_URI, dbName: DATABASE_NAME, serverSelectionTimeoutMS: 5_000 });
  let piRuntime;
  t.after(async () => {
    piRuntime?.session?.dispose?.();
    await store.dropTestDatabase(); await store.close(); rmSync(runtimeRoot, { recursive: true, force: true });
    restore("WECHAT_AGENT_TEST_MODE", previous.testMode); restore("WECHAT_AGENT_RUNTIME_ROOT", previous.runtimeRoot); restore("PI_OFFLINE", previous.offline);
  });
  await stage("prepare product database", async () => {
    await store.connect(); await store.dropTestDatabase(); await store.connect();
  });
  const appendRunEvent = store.appendRunEvent.bind(store);
  let terminalReadModelPersistedBeforeEvent = false;
  store.appendRunEvent = async (event, options) => {
    if (event.type === "run.completed") {
      const transactionOptions = options?.session ? { session: options.session } : {};
      const [terminalRun, terminalReadModel] = await Promise.all([
        store.repositories.runs.getInternal(event.runId, transactionOptions),
        store.repositories.runReadModels.get(event.runId, transactionOptions),
      ]);
      terminalReadModelPersistedBeforeEvent = Boolean(
        terminalRun?.status === "completed"
        && terminalReadModel?.status === "completed"
        && terminalReadModel.finalAnswer?.content,
      );
    }
    return appendRunEvent(event, options);
  };

  const runtimePaths = resolveRuntimePaths({ env: process.env });
  piRuntime = createPiBackedAgentRuntime({
    projectRoot: repoRoot, agentRuntimeRoot, piAgentDir: runtimePaths.piAgentDir,
    piExtensionPath: join(agentRuntimeRoot, "extensions", "workflow-conformance", "extension.ts"),
    piSkillPath: join(agentRuntimeRoot, "skills"), piPromptPath: join(agentRuntimeRoot, "prompts"),
    projectToolNames: [WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME],
    discoverExtensionPaths: () => [join(agentRuntimeRoot, "extensions", "workflow-conformance", "extension.ts")],
    discoverExtensionPackages: () => [{ id: "workflow-conformance", extensionPath: join(agentRuntimeRoot, "extensions", "workflow-conformance", "extension.ts"), manifest: { testOnly: true } }],
    now: () => "2026-07-10T00:00:00.000Z", safeId: () => "pi-runner-integration",
  });
  const piKernel = createPiKernelAdapter(piRuntime);
  const agentRuntime = createInProcessAgentAdapter({
    agentRuntimeCore: createAgentRuntimeCore({ router: {}, gateEngine: createGateEngine({ now: () => "2026-07-10T00:00:00.000Z" }), piKernel,
      finalOutput: { buildAgentFinalReadModelV1(args) { return { schemaVersion: "agent-final-read-model-v1", runID: args.runID, finalText: args.finalText }; } }, artifacts: {}, providerExecutor: {} }),
    piKernel, executorRegistry: registerWorkflowConformanceExecutor(createWorkflowSkillExecutorRegistry()), defaultTimeoutMs: 5_000, maxTimeoutMs: 5_000,
    now: () => "2026-07-10T00:00:00.000Z",
  });
  const revision = makeRevision(); const plan = makePlan(); let index = 0;
  const buildRunner = ({ scheduleOnStart = true, workerId } = {}) => createWorkflowRunner({ store, agentRuntime, clock: () => "2026-07-10T00:00:00.000Z", idFactory: (kind) => `${kind}-${++index}`,
    scheduleOnStart,
    workerId,
    resolveExecution: async () => ({ revision, compileResult: { status: "ready", executionPlan: plan }, workspaceId: "workspace-local", skills: { "workflow-conformance:1": { definition: { inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { echo: { type: "string", minLength: 1 }, charCount: { type: "integer", minimum: 0 } }, required: ["echo", "charCount"], additionalProperties: false } }, executionRef: WORKFLOW_CONFORMANCE_EXECUTION_REF } } }),
  });
  const runner = buildRunner();
  const first = await stage("start first run", () => runner.startRun(request("idem-first")));
  await waitFor(async () => (await runner.getRun(first.runId)).run.status === "waiting_review");
  await waitFor(async () => (await store.repositories.runJobs.getByRun(first.runId))?.status === "paused");
  const pausedJob = await store.repositories.runJobs.getByRun(first.runId);
  assert.equal(pausedJob.status, "paused");
  assert.equal(pausedJob.fence, 1);
  assert.equal(pausedJob.checkpointSequence, 3);
  assert.equal((await store.repositories.runLeases.collection.findOne({ runId: first.runId })).status, "released");
  assert.deepEqual(
    (await store.repositories.runCheckpoints.collection.find({ runId: first.runId }).sort({ sequence: 1 }).toArray())
      .map((checkpoint) => checkpoint.sequence),
    [1, 2, 3],
  );
  const replay = await runner.startRun(request("idem-first"));
  assert.equal(replay.runId, first.runId);
  await assert.rejects(() => runner.startRun({ ...request("idem-first"), inputs: { text: "different" } }), (error) => error?.code === "idempotency_key_reused");
  await runner.submitReviewDecision(decision(first.runId, "approve", "decision-first"));
  await waitFor(async () => (await runner.getRun(first.runId)).run.status === "completed");
  const completed = await runner.getRun(first.runId);
  assert.equal(completed.readModel.finalAnswer.content, "mongo proof");
  assert.equal(completed.readModel.finalAnswer.content, completed.readModel.finalAnswer.content);
  assert.equal(terminalReadModelPersistedBeforeEvent, true);
  const events = await runner.listEvents(first.runId);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, i) => i + 1));
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal((await store.repositories.runReadModels.get(first.runId)).finalAnswer.content, "mongo proof");
  const internalCompleted = await store.repositories.runs.getInternal(first.runId);
  assert.equal(internalCompleted.agentFinalReadModel.schemaVersion, "agent-final-read-model-v1");
  assert.equal(internalCompleted.agentFinalReadModel.runID, first.runId);
  assert.equal(internalCompleted.agentFinalReadModel.finalText, "mongo proof");
  assert.equal(Object.hasOwn(completed.run, "agentFinalReadModel"), false);
  const completedJob = await store.repositories.runJobs.getByRun(first.runId);
  assert.equal(completedJob.status, "completed");
  assert.equal(completedJob.checkpointSequence, 6);
  assert.deepEqual(
    (await store.repositories.runCheckpoints.collection.find({ runId: first.runId }).sort({ sequence: 1 }).toArray())
      .map((checkpoint) => checkpoint.sequence),
    [1, 2, 3, 4, 5, 6],
  );

  const revised = await runner.startRun(request("idem-revise"));
  await waitFor(async () => (await runner.getRun(revised.runId)).run.status === "waiting_review");
  await runner.submitReviewDecision(decision(revised.runId, "revise", "decision-revise", ["Repeat the deterministic draft."]));
  await waitFor(async () => (await runner.getRun(revised.runId)).run.nodeRuns.filter((entry) => entry.nodeId === "node-skill").length === 2);
  assert.deepEqual((await runner.getRun(revised.runId)).run.nodeRuns.filter((entry) => entry.nodeId === "node-skill").map((entry) => entry.attempt), [1, 2]);
  await runner.cancelRun({ runId: revised.runId, idempotencyKey: "command-cancel", requestedBy: "user-local", reason: "Stop this review." });
  await waitFor(async () => (await runner.getRun(revised.runId)).run.status === "cancelled");
  const retried = await runner.retryRun({ runId: revised.runId, idempotencyKey: "command-retry", requestedBy: "user-local", reason: "Retry the saved revision." });
  await waitFor(async () => (await runner.getRun(retried.runId)).run.status === "waiting_review");
  const commands = await store.repositories.runCommands.list({ workspaceId: "workspace-local" });
  assert.deepEqual(commands.map((entry) => entry.command).sort(), ["cancel", "retry"]);

  const rejected = await runner.startRun(request("idem-reject"));
  await waitFor(async () => (await runner.getRun(rejected.runId)).run.status === "waiting_review");
  await runner.submitReviewDecision(decision(rejected.runId, "reject", "decision-reject"));
  await waitFor(async () => (await runner.getRun(rejected.runId)).run.status === "cancelled");
  assert.equal((await runner.getRun(rejected.runId)).readModel.finalAnswer, null);

  const restarted = buildRunner();
  assert.equal((await restarted.getRun(first.runId)).run.status, "completed");
  const deferred = await buildRunner({ scheduleOnStart: false }).startRun(request("idem-durable-recover"));
  assert.equal((await runner.getRun(deferred.runId)).run.status, "queued");
  const recovered = buildRunner({ workerId: "mongo-recovery-worker" });
  assert.deepEqual((await recovered.recover()).recoveredRunIds, [deferred.runId]);
  await waitFor(async () => (await recovered.getRun(deferred.runId)).run.status === "waiting_review");
  assert.equal((await store.repositories.runJobs.getByRun(deferred.runId)).fence, 1);
  const rerun = await restarted.startRun(request("idem-rerun"));
  assert.notEqual(rerun.runId, first.runId);
  await waitFor(async () => (await restarted.getRun(rerun.runId)).run.status === "waiting_review");
  await restarted.submitReviewDecision(decision(rerun.runId, "approve", "decision-rerun"));
  await waitFor(async () => (await restarted.getRun(rerun.runId)).run.status === "completed");
});

function request(idempotencyKey) { return { workflowId: "workflow-conformance-runner", workflowRevisionId: "revision-conformance-runner-1", inputs: { text: "mongo proof" }, resourceRefs: [], idempotencyKey, requestId: "request-conformance" }; }
function decision(runId, decisionValue, idempotencyKey, requestedChanges = []) { return { runId, nodeId: "node-review", decision: decisionValue, requestedChanges, idempotencyKey, decidedBy: "user-local" }; }
function makeRevision() {
  const base = { description: "", position: { x: 0, y: 0 }, reviewPolicy: { mode: "none" }, retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 }, timeoutSeconds: 30, display: { collapsed: false } };
  const port = (portId) => ({ portId, name: portId, schema: { type: "string", minLength: 1 }, required: true });
  return { workflowId: "workflow-conformance-runner", revisionId: "revision-conformance-runner-1", graph: { nodes: [
    { ...base, nodeId: "node-input", kind: "Input", title: "Input", inputPorts: [], outputPorts: [port("text")], inputBindings: [], configuration: { fieldIds: ["text"] } },
    { ...base, nodeId: "node-skill", kind: "Skill", title: "Echo", skillRef: { skillId: "workflow-conformance", version: "1" }, inputPorts: [port("text")], outputPorts: [port("echo")], inputBindings: [{ targetPort: "text", source: { kind: "nodeOutput", nodeId: "node-input", portId: "text" } }], configuration: {} },
    { ...base, nodeId: "node-review", kind: "ReviewGate", title: "Review", inputPorts: [port("candidate")], outputPorts: [port("approved")], inputBindings: [{ targetPort: "candidate", source: { kind: "nodeOutput", nodeId: "node-skill", portId: "echo" } }], configuration: { instructions: "Review.", allowRevision: true, revisionTarget: { nodeId: "node-skill", portId: "text" } }, reviewPolicy: { mode: "required", instructions: "Review." } },
    { ...base, nodeId: "node-output", kind: "Output", title: "Output", inputPorts: [port("content")], outputPorts: [port("final")], inputBindings: [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" } }], configuration: { format: "markdown" } },
  ], edges: [
    { edgeId: "input-skill", sourceNodeId: "node-input", sourcePort: "text", targetNodeId: "node-skill", targetPort: "text" },
    { edgeId: "skill-review", sourceNodeId: "node-skill", sourcePort: "echo", targetNodeId: "node-review", targetPort: "candidate" },
    { edgeId: "review-output", sourceNodeId: "node-review", sourcePort: "approved", targetNodeId: "node-output", targetPort: "content" },
  ] } };
}
function makePlan() { const step = (nodeId, kind, dependsOn, inputBindings = []) => ({ nodeId, kind, dependsOn, inputBindings }); return { schemaVersion: "workbench-execution-plan-v1", planVersion: "1", workflowId: "workflow-conformance-runner", workflowRevisionId: "revision-conformance-runner-1", generatedAt: "2026-07-10T00:00:00.000Z", contentHash: "sha256:1234567890abcdef", maxParallelism: 1, pinnedSkills: [{ skillId: "workflow-conformance", version: "1" }], steps: [step("node-input", "Input", []), { ...step("node-skill", "Skill", ["node-input"], [{ targetPort: "text", source: { kind: "nodeOutput", nodeId: "node-input", portId: "text" } }]), skillRef: { skillId: "workflow-conformance", version: "1" } }, step("node-review", "ReviewGate", ["node-skill"], [{ targetPort: "candidate", source: { kind: "nodeOutput", nodeId: "node-skill", portId: "echo" } }]), step("node-output", "Output", ["node-review"], [{ targetPort: "content", source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" } }])], reviewGates: [{ nodeId: "node-review", dependsOn: ["node-skill"], instructions: "Review." }], primaryOutput: { nodeId: "node-output", portId: "final" } }; }
async function waitFor(predicate, timeoutMs = 10_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("wait_for_timeout"); }
function restore(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
async function stage(label, action) {
  try {
    return await action();
  } catch (error) {
    const wrapped = new Error(`${label}: ${error?.stack ?? error?.message ?? error}`);
    wrapped.cause = error;
    throw wrapped;
  }
}
