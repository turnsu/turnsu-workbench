import assert from "node:assert/strict";
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
      return { text: JSON.stringify({ response: "Real isolated Pi Worker completed." }) };
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
    limits: { timeoutMs: 30_000, maxSteps: 4, maxModelRequests: 2, maxChildren: 0, maxInputBytes: 100_000, maxOutputBytes: 100_000 },
    capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
    resultSchema: {
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
      additionalProperties: false,
    },
    evidenceRequirements: [],
    metadata: { providerSecret: "must-not-cross" },
  };

  const result = await broker.execute(request);
  assert.equal(result.status, "completed");
  assert.equal(result.isolation, "container");
  assert.deepEqual(result.output, { response: "Real isolated Pi Worker completed." });
  assert.equal(modelCalls.length, 1);
  assert.equal(JSON.stringify(modelCalls).includes("must-not-cross"), false);
  assert.equal(JSON.stringify(modelCalls).includes("apiKey"), false);
  assert.equal((await sandbox.scavenge()).containersRemoved, 0);
});
