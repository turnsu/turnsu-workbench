const REVISION_HASH = `sha256:${"d".repeat(64)}`;
const PLAN_HASH = `sha256:${"e".repeat(64)}`;

const TERMINAL_IDS = Object.freeze({
  workflowId: "characterization-runner-recovery-workflow",
  revisionId: "characterization-runner-recovery-revision",
  compileResultId: "characterization-runner-recovery-compile",
  planId: "characterization-runner-recovery-plan",
  skillId: "characterization-runner-recovery-skill",
  skillVersion: "1",
  revisionHash: REVISION_HASH,
  planHash: PLAN_HASH,
});

const REVIEW_IDS = Object.freeze({
  ...TERMINAL_IDS,
  workflowId: "characterization-runner-review-workflow",
  revisionId: "characterization-runner-review-revision",
  compileResultId: "characterization-runner-review-compile",
  planId: "characterization-runner-review-plan",
  revisionHash: `sha256:${"f".repeat(64)}`,
  planHash: `sha256:${"a".repeat(64)}`,
});

export const POSTGRES_RUNNER_RECOVERY_IDS = TERMINAL_IDS;

export function postgresRunnerRecoveryIds(scenario) {
  return scenario === "waiting-review-handoff" ? REVIEW_IDS : TERMINAL_IDS;
}

function port(portId) {
  return {
    portId,
    name: portId,
    schema: { type: "string", minLength: 1 },
    required: true,
  };
}

function nodeBase() {
  return {
    description: "",
    position: { x: 0, y: 0 },
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 30,
    display: { collapsed: false },
  };
}

export function postgresRunnerRecoveryRevision(scenario = "") {
  const ids = postgresRunnerRecoveryIds(scenario);
  const withReview = scenario === "waiting-review-handoff";
  const base = nodeBase();
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
      skillRef: { skillId: ids.skillId, version: ids.skillVersion },
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
      configuration: { instructions: "Review the durable result.", allowRevision: false },
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
    workflowId: ids.workflowId,
    revisionId: ids.revisionId,
    contentHash: ids.revisionHash,
    graph: { nodes, edges },
    inputForm: {},
    outputDefinition: {},
    runSettings: {},
  };
}

export function postgresRunnerRecoveryPlan(generatedAt = new Date().toISOString(), scenario = "") {
  const ids = postgresRunnerRecoveryIds(scenario);
  const withReview = scenario === "waiting-review-handoff";
  const inputBindings = (targetPort, source) => [{ targetPort, source }];
  const steps = [
    { nodeId: "node-input", kind: "Input", dependsOn: [], inputBindings: [] },
    {
      nodeId: "node-skill",
      kind: "Skill",
      dependsOn: ["node-input"],
      inputBindings: inputBindings("text", {
        kind: "nodeOutput", nodeId: "node-input", portId: "text",
      }),
      skillRef: { skillId: ids.skillId, version: ids.skillVersion },
      executionMode: "deterministic_skill",
      isolation: "process",
      modelRoutingState: "not_applicable",
      capabilities: {
        toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false,
      },
      limits: {
        timeoutMs: 5_000, maxSteps: 1, maxModelRequests: 0, maxChildren: 0,
        maxInputBytes: 1_000, maxOutputBytes: 1_000, maxImageCount: 0, maxCostUsdMicros: 0,
      },
      resultSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
        additionalProperties: false,
      },
      evidenceRequirements: [],
    },
  ];
  let outputSource = { nodeId: "node-skill", portId: "result" };
  if (withReview) {
    steps.push({
      nodeId: "node-review",
      kind: "ReviewGate",
      dependsOn: ["node-skill"],
      inputBindings: inputBindings("candidate", {
        kind: "nodeOutput", nodeId: "node-skill", portId: "result",
      }),
    });
    outputSource = { nodeId: "node-review", portId: "approved" };
  }
  steps.push({
    nodeId: "node-output",
    kind: "Output",
    dependsOn: [outputSource.nodeId],
    inputBindings: inputBindings("content", {
      kind: "nodeOutput", ...outputSource,
    }),
  });
  return {
    schemaVersion: "workbench-execution-plan-v2",
    planVersion: "2",
    planId: ids.planId,
    workflowId: ids.workflowId,
    workflowRevisionId: ids.revisionId,
    generatedAt,
    contentHash: ids.planHash,
    maxParallelism: 1,
    modelRoutingState: "not_applicable",
    pinnedSkills: [{ skillId: ids.skillId, version: ids.skillVersion }],
    steps,
    reviewGates: withReview ? [{
      nodeId: "node-review", dependsOn: ["node-skill"], instructions: "Review the durable result.",
    }] : [],
    primaryOutput: { nodeId: "node-output", portId: "final" },
  };
}

export function postgresRunnerRecoveryExecution({ workspaceId, scopeId, generatedAt, scenario = "" } = {}) {
  const ids = postgresRunnerRecoveryIds(scenario);
  const revision = postgresRunnerRecoveryRevision(scenario);
  const plan = postgresRunnerRecoveryPlan(generatedAt, scenario);
  const skill = {
    skillId: ids.skillId,
    version: ids.skillVersion,
    name: "Characterization recovery effect",
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
    executionRef: {
      capabilityId: "characterization-runner-recovery",
      taskIntent: "record-effect",
      adapterVersion: "1",
      executionMode: "deterministic",
    },
  };
  return {
    revision,
    compileResult: {
      status: "ready",
      compileResultId: ids.compileResultId,
      executionPlan: plan,
    },
    workspaceId,
    scopeId,
    workflowRevisionContentHash: ids.revisionHash,
    compileResultId: ids.compileResultId,
    executionPlanId: ids.planId,
    skillVersions: [skill],
    skills: {
      [`${skill.skillId}:${skill.version}`]: {
        definition: skill,
        executionRef: skill.executionRef,
      },
    },
  };
}

export function postgresRunnerRecoveryStartRequest({ userId, scenario } = {}) {
  const ids = postgresRunnerRecoveryIds(scenario);
  return {
    workflowId: ids.workflowId,
    workflowRevisionId: ids.revisionId,
    inputs: { text: scenario },
    resourceRefs: [],
    materialBindings: [],
    requestedBy: userId,
    retryOf: null,
  };
}
