import { createWorkflowRunner } from "../../../src/runner/index.mjs";
import { ProductMongoStore } from "../../../src/store/index.mjs";

const uri = requiredEnv("MONGODB_URI");
const dbName = requiredEnv("MONGODB_DB");
const workerId = requiredEnv("WORKBENCH_FAULT_WORKER_ID");
const scenario = requiredEnv("WORKBENCH_FAULT_SCENARIO");
const faultBoundary = process.env.WORKBENCH_FAULT_BOUNDARY ?? "";
const leaseDurationMs = Number(process.env.WORKBENCH_FAULT_LEASE_MS ?? 1_000);

if (!dbName.endsWith("_test")) throw new Error(`integration_database_must_end_in_test:${dbName}`);
if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
  throw new Error(`invalid_fault_lease_duration:${leaseDurationMs}`);
}

const store = new ProductMongoStore({
  uri,
  dbName,
  serverSelectionTimeoutMS: 5_000,
});
await store.connect();

let idSequence = 0;
let faultSent = false;
const workflow = scenario === "waiting-review-handoff" ? reviewWorkflow() : terminalWorkflow();
const skillVersion = publishedFixtureSkillVersion();
const skillKey = `${skillVersion.skillId}:${skillVersion.version}`;
const runner = createWorkflowRunner({
  store,
  workerId,
  leaseDurationMs,
  scheduleOnStart: false,
  clock: () => new Date().toISOString(),
  idFactory: (kind) => `${kind}-${workerId}-${++idSequence}`,
  resolveExecution: async () => ({
    revision: workflow.revision,
    compileResult: { status: "ready", executionPlan: workflow.plan },
    workspaceId: "workspace-local",
    skillVersions: [skillVersion],
    skills: {
      [skillKey]: {
        definition: skillVersion,
        executionRef: skillVersion.executionRef,
      },
    },
  }),
  agentRuntime: {
    async invokeSkillNode({ invocationId, input }) {
      await store.db.collection("runner_fault_effects").insertOne({
        invocationId,
        runInput: structuredClone(input),
        workerId,
        scenario,
        createdAt: new Date().toISOString(),
      });
      return { result: `effect:${input.text}` };
    },
    async buildAuthoritativeFinal({ runId, finalText, evidenceGaps, reviewPacket }) {
      return {
        finalText,
        evidenceGaps,
        reviewPacket,
        agentFinalReadModel: {
          schemaVersion: "agent-final-read-model-v1",
          runID: runId,
          finalText,
        },
      };
    },
  },
  faultInjector: async (boundary, context) => {
    if (faultSent || boundary !== faultBoundary) return;
    faultSent = true;
    const marker = `FAULT_BOUNDARY ${boundary} ${context.runId}`;
    process.stdout.write(`${marker}\n`);
    process.send?.({ type: "fault", boundary, context, marker });
    await new Promise(() => {});
  },
});

process.on("message", (message) => {
  void handleMessage(message);
});
process.on("disconnect", () => {
  void store.close().finally(() => process.exit(0));
});
process.send?.({ type: "ready", workerId, pid: process.pid });
process.stdout.write(`WORKER_READY ${workerId} ${process.pid}\n`);

async function handleMessage(message) {
  const requestId = message?.requestId;
  if (!requestId) return;
  try {
    let value;
    if (message.command === "start") {
      value = await runner.startRun({
        workflowId: workflow.revision.workflowId,
        workflowRevisionId: workflow.revision.revisionId,
        inputs: { text: scenario },
        resourceRefs: [],
        idempotencyKey: `start-${scenario}`,
        requestId: `request-${scenario}`,
      });
    } else if (message.command === "recover") {
      value = await runner.recover();
    } else if (message.command === "approve") {
      value = await runner.submitReviewDecision({
        runId: message.runId,
        nodeId: "node-review",
        decision: "approve",
        requestedChanges: [],
        idempotencyKey: `approve-${scenario}`,
        decidedBy: "integration-parent",
      });
    } else if (message.command === "close") {
      await store.close();
      return send({ type: "response", requestId, ok: true, value: null }, true);
    } else {
      throw new Error(`unknown_worker_command:${message.command}`);
    }
    send({ type: "response", requestId, ok: true, value });
  } catch (error) {
    send({
      type: "response",
      requestId,
      ok: false,
      error: {
        name: error?.name,
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
      },
    });
  }
}

function send(message, exitAfterSend = false) {
  if (!process.connected) {
    if (exitAfterSend) process.exit(0);
    return;
  }
  process.send(message, () => {
    if (exitAfterSend) process.exit(0);
  });
}

function terminalWorkflow() {
  const revision = makeRevision(false);
  return { revision, plan: makePlan(revision, false) };
}

function reviewWorkflow() {
  const revision = makeRevision(true);
  return { revision, plan: makePlan(revision, true) };
}

function makeRevision(withReview) {
  const base = {
    description: "",
    position: { x: 0, y: 0 },
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 30,
    display: { collapsed: false },
  };
  const port = (portId) => ({
    portId,
    name: portId,
    schema: { type: "string", minLength: 1 },
    required: true,
  });
  const nodes = [
    {
      ...base,
      nodeId: "node-input",
      kind: "Input",
      title: "Input",
      inputPorts: [],
      outputPorts: [port("text")],
      inputBindings: [],
      configuration: { fieldIds: ["text"] },
    },
    {
      ...base,
      nodeId: "node-skill",
      kind: "Skill",
      title: "Effect",
      skillRef: { skillId: "fault-effect", version: "1" },
      inputPorts: [port("text")],
      outputPorts: [port("result")],
      inputBindings: [{
        targetPort: "text",
        source: { kind: "nodeOutput", nodeId: "node-input", portId: "text" },
      }],
      configuration: {},
    },
  ];
  const edges = [{
    edgeId: "edge-input-skill",
    sourceNodeId: "node-input",
    sourcePort: "text",
    targetNodeId: "node-skill",
    targetPort: "text",
  }];
  let outputSource = { nodeId: "node-skill", portId: "result" };
  if (withReview) {
    nodes.push({
      ...base,
      nodeId: "node-review",
      kind: "ReviewGate",
      title: "Review",
      inputPorts: [port("candidate")],
      outputPorts: [port("approved")],
      inputBindings: [{
        targetPort: "candidate",
        source: { kind: "nodeOutput", nodeId: "node-skill", portId: "result" },
      }],
      configuration: {
        instructions: "Review the durable result.",
        allowRevision: false,
      },
      reviewPolicy: { mode: "required", instructions: "Review the durable result." },
    });
    edges.push({
      edgeId: "edge-skill-review",
      sourceNodeId: "node-skill",
      sourcePort: "result",
      targetNodeId: "node-review",
      targetPort: "candidate",
    });
    outputSource = { nodeId: "node-review", portId: "approved" };
  }
  nodes.push({
    ...base,
    nodeId: "node-output",
    kind: "Output",
    title: "Output",
    inputPorts: [port("content")],
    outputPorts: [port("final")],
    inputBindings: [{
      targetPort: "content",
      source: { kind: "nodeOutput", ...outputSource },
    }],
    configuration: { format: "markdown" },
  });
  edges.push({
    edgeId: "edge-to-output",
    sourceNodeId: outputSource.nodeId,
    sourcePort: outputSource.portId,
    targetNodeId: "node-output",
    targetPort: "content",
  });
  return {
    workflowId: withReview ? "workflow-fault-review" : "workflow-fault-terminal",
    revisionId: withReview ? "revision-fault-review-1" : "revision-fault-terminal-1",
    graph: { nodes, edges },
  };
}

function makePlan(revision, withReview) {
  const steps = [
    { nodeId: "node-input", kind: "Input", dependsOn: [], inputBindings: [] },
    {
      nodeId: "node-skill",
      kind: "Skill",
      dependsOn: ["node-input"],
      inputBindings: [{
        targetPort: "text",
        source: { kind: "nodeOutput", nodeId: "node-input", portId: "text" },
      }],
      skillRef: { skillId: "fault-effect", version: "1" },
    },
  ];
  if (withReview) {
    steps.push({
      nodeId: "node-review",
      kind: "ReviewGate",
      dependsOn: ["node-skill"],
      inputBindings: [{
        targetPort: "candidate",
        source: { kind: "nodeOutput", nodeId: "node-skill", portId: "result" },
      }],
    });
  }
  const outputSource = withReview
    ? { nodeId: "node-review", portId: "approved" }
    : { nodeId: "node-skill", portId: "result" };
  steps.push({
    nodeId: "node-output",
    kind: "Output",
    dependsOn: [outputSource.nodeId],
    inputBindings: [{
      targetPort: "content",
      source: { kind: "nodeOutput", ...outputSource },
    }],
  });
  return {
    schemaVersion: "workbench-execution-plan-v1",
    planVersion: "1",
    workflowId: revision.workflowId,
    workflowRevisionId: revision.revisionId,
    generatedAt: "2026-07-13T00:00:00.000Z",
    contentHash: withReview ? "sha256:review1234567890" : "sha256:terminal12345678",
    maxParallelism: 1,
    pinnedSkills: [{ skillId: "fault-effect", version: "1" }],
    steps,
    reviewGates: withReview
      ? [{ nodeId: "node-review", dependsOn: ["node-skill"], instructions: "Review the durable result." }]
      : [],
    primaryOutput: { nodeId: "node-output", portId: "final" },
  };
}

function publishedFixtureSkillVersion() {
  return {
    schemaVersion: "workbench-v1",
    skillVersionId: "skill-version-fault-effect-1",
    skillId: "fault-effect",
    workspaceId: "workspace-local",
    version: "1",
    packageObjectId: "object-fault-effect-1",
    packageHash: "sha256:1234567890abcdef",
    contentHash: "sha256:abcdef1234567890",
    manifest: {},
    name: "Fault effect",
    description: "Records one test-only durable effect.",
    category: "testing",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "string", minLength: 1 } },
      required: ["result"],
      additionalProperties: false,
    },
    risk: { level: "low", externalAction: false, summary: "Test-only Mongo effect." },
    dependencies: [],
    connectionRequirements: [],
    validation: {
      validationId: "validation-fault-effect-1",
      status: "passed",
      diagnostics: [],
      testedAt: "2026-07-13T00:00:00.000Z",
    },
    executionRef: {
      capabilityId: "workflow-fault-effect",
      taskIntent: "record-effect",
      adapterVersion: "1",
      executionMode: "deterministic",
    },
    publishedBy: "integration-parent",
    publishedAt: "2026-07-13T00:00:00.000Z",
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}
