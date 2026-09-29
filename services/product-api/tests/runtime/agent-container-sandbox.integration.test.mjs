import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionBroker,
  InMemoryExecutionPersistence,
  ProductToolGateway,
  StdioToolGatewayServer,
} from "../../src/execution/index.mjs";
import {
  AgentContainerSandbox,
  createAgentContainerBackend,
} from "../../src/runtime/index.mjs";

const enabled = process.env.WORKBENCH_AGENT_DOCKER_INTEGRATION === "1";
const image = process.env.WORKBENCH_AGENT_IMAGE;

test("real Agent image runs Pi through the product stdio Gateway with no container credentials", { skip: !enabled }, async (t) => {
  assert.match(image ?? "", /^(?:[^@]+@)?sha256:[a-f0-9]{64}$/);
  const root = await mkdtemp(join(tmpdir(), "looloomi-agent-image-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = new InMemoryExecutionPersistence();
  const modelCalls = [];
  const gateway = new ProductToolGateway({
    persistence,
    modelExecutor: async (call) => {
      modelCalls.push(call);
      return {
        text: JSON.stringify({ response: "Real isolated Pi Worker completed." }),
        requestedModelRevisionId: call.modelProfileRevisionId,
        actualModelRevisionId: call.modelProfileRevisionId,
      };
    },
  });
  const sandbox = new AgentContainerSandbox({
    image,
    gatewayServer: new StdioToolGatewayServer({ gateway }),
    tempRoot: root,
  });
  const broker = new ExecutionBroker({
    persistence,
    clock: () => new Date().toISOString(),
    idFactory: (() => { let sequence = 0; return (kind) => `${kind}-${++sequence}`; })(),
    capacityAuthorizer: { async authorize() { return true; } },
  });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "container",
    backend: createAgentContainerBackend({ sandbox }),
  });
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-real-agent-image",
    attemptId: "attempt-real-agent-image",
    workspaceId: "workspace-agent-image",
    controller: { kind: "agent_turn", controllerId: "turn-real-agent-image", fence: 1 },
    mode: "bounded_agent",
    isolation: "container",
    goal: "Return a response from the real isolated Pi Worker.",
    input: { value: 1 },
    limits: {
      timeoutMs: 30_000, maxSteps: 4, maxModelRequests: 2, maxChildren: 0,
      maxInputBytes: 100_000, maxOutputBytes: 100_000, maxImageCount: 0,
      maxCostUsdMicros: 0,
    },
    capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
    resultSchema: {
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
      additionalProperties: false,
    },
    evidenceRequirements: [],
    metadata: {
      modelProfileRevisionId: "model-revision-agent-image-1",
      fallbackModelProfileRevisionIds: [],
      modelCapability: "structured_output",
      providerSecret: "must-not-cross",
    },
  };

  const result = await broker.execute(request);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.isolation, "container");
  assert.equal(result.requestedModelRevisionId, "model-revision-agent-image-1");
  assert.equal(result.actualModelRevisionId, "model-revision-agent-image-1");
  assert.deepEqual(result.output, { response: "Real isolated Pi Worker completed." });
  assert.equal(modelCalls.length, 1);
  assert.equal(JSON.stringify(modelCalls).includes("must-not-cross"), false);
  assert.equal(JSON.stringify(modelCalls).includes("apiKey"), false);
  assert.equal((await sandbox.scavenge()).containersRemoved, 0);
});

test("real pi-workflow streams dynamic children into the product timeline before parent settlement", { skip: !enabled }, async (t) => {
  assert.match(image ?? "", /^(?:[^@]+@)?sha256:[a-f0-9]{64}$/);
  const root = await mkdtemp(join(tmpdir(), "looloomi-agwab-image-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = new InMemoryExecutionPersistence();
  const modelCalls = [];
  const dockerDiagnostics = [];
  const gateway = new ProductToolGateway({
    persistence,
    modelExecutor: async (call) => {
      modelCalls.push(call);
      const context = JSON.stringify(call.typedInput?.context ?? call.input?.context ?? {});
      if (context.includes("dynamic-decision-v1") && !context.includes("Dynamic Synthesis Handoff")) {
        return {
          text: '<control>{"schema":"dynamic-decision-v1","digest":"Synthesize the bounded result without external sources.","decisionId":"decision-0","round":0,"phase":"orientation","status":"synthesize","nextActions":[{"type":"synthesize","actionId":"synthesize-0","prompt":"Return a concise final answer with no source-backed claims.","outputProfile":"synthesis_v1","inputRefs":[]}]}</control><analysis>Direct synthesis is sufficient.</analysis><refs>[]</refs>',
          requestedModelRevisionId: call.modelProfileRevisionId,
          actualModelRevisionId: call.modelProfileRevisionId,
        };
      }
      return {
        text: '<control>{"schema":"dynamic-task-result-v1","digest":"Completed isolated synthesis.","summary":"Completed isolated synthesis.","claims":[],"caveats":[],"blockers":[],"omissions":[]}</control><analysis>Completed inside the pinned outer node.</analysis><refs>["workflow_artifact:dynamic.decide-r0"]</refs>',
        requestedModelRevisionId: call.modelProfileRevisionId,
        actualModelRevisionId: call.modelProfileRevisionId,
      };
    },
  });
  const sandbox = new AgentContainerSandbox({
    image,
    gatewayServer: new StdioToolGatewayServer({ gateway }),
    tempRoot: root,
    spawnProcess: (...args) => {
      const child = spawn(...args);
      child.stderr?.on("data", (chunk) => dockerDiagnostics.push(Buffer.from(chunk)));
      return child;
    },
  });
  const broker = new ExecutionBroker({
    persistence,
    clock: () => new Date().toISOString(),
    idFactory: (() => { let sequence = 1000; return (kind) => `${kind}-${++sequence}`; })(),
    capacityAuthorizer: { async authorize() { return true; } },
  });
  broker.registerBackend({
    mode: "agent_orchestrator",
    isolation: "container",
    backend: createAgentContainerBackend({ sandbox }),
  });
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-real-agwab-image",
    attemptId: "attempt-real-agwab-image",
    workspaceId: "workspace-agent-image",
    actor: { userId: "user-agent-image" },
    lineage: { productCommandId: "product-command-real-agwab" },
    controller: { kind: "workflow_run", controllerId: "run-real-agwab", fence: 1 },
    mode: "agent_orchestrator",
    isolation: "container",
    goal: "Create one concise response inside this pinned outer node.",
    input: { value: 1 },
    limits: {
      timeoutMs: 60_000, maxSteps: 8, maxModelRequests: 8, maxChildren: 4,
      maxInputBytes: 100_000, maxOutputBytes: 500_000, maxImageCount: 0,
      maxCostUsdMicros: 0,
    },
    capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
    resultSchema: { type: "object", additionalProperties: true },
    evidenceRequirements: [],
    metadata: {
      outerNodeId: "pinned-node-agwab",
      modelProfileRevisionId: "model-revision-agwab-image-1",
      fallbackModelProfileRevisionIds: [],
      modelCapability: "structured_output",
      admittedChildConcurrency: 2,
    },
  };

  const result = await broker.execute(request, {
    childCapacityPool: {
      leases: [1, 2].map((slot) => ({
        admissionId: `admission-real-agwab-${slot}`,
        capacityLeaseId: `capacity-lease-real-agwab-${slot}`,
        fence: 1,
      })),
      async release() {},
    },
  });
  const invocations = await persistence.listInvocations({ controllerId: "run-real-agwab" });
  const children = invocations.filter((item) => item.parentInvocationId === request.invocationId);
  const parentEvents = persistence.events.get(request.invocationId) ?? [];

  assert.equal(result.status, "completed", JSON.stringify({
    result,
    modelRoutes: modelCalls.map((call) => ({
      revisionId: call.modelProfileRevisionId ?? null,
      context: JSON.stringify(call.typedInput?.context ?? call.input?.context ?? {}).slice(-2_000),
    })),
    children: children.map((child) => ({
      invocationId: child.invocationId,
      childRef: child.request?.metadata?.externalChildRef,
      status: child.status,
      summary: child.result?.summary ?? null,
      output: child.result?.output ?? null,
    })),
    parentEvents: parentEvents.map((event) => ({ type: event.type, payload: event.payload })),
    dockerDiagnostics: Buffer.concat(dockerDiagnostics).toString("utf8").slice(-8_000),
  }));
  assert.equal(result.requestedModelRevisionId, "model-revision-agwab-image-1");
  assert.equal(result.actualModelRevisionId, "model-revision-agwab-image-1");
  assert.ok(modelCalls.length >= 2);
  assert.ok(children.length >= 1);
  assert(children.every((child) => child.status === "completed"));
  const childInvocationIds = new Set(children.map((child) => child.invocationId));
  assert(modelCalls.every((call) => childInvocationIds.has(call.invocationId)));
  assert(modelCalls.every((call) => call.invocationId !== request.invocationId));
  assert(parentEvents.some((event) => event.type === "execution.child_started"));
  assert(parentEvents.findIndex((event) => event.type === "execution.child_started")
    < parentEvents.findIndex((event) => event.type === "execution.completed"));
  assert(children.every((child) => child.request.metadata.parentInvocationId === request.invocationId));
  assert.equal((await sandbox.scavenge()).containersRemoved, 0);
});
