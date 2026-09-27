export const NOW = "2026-07-10T10:00:00.000Z";

export const stringSchema = Object.freeze({
  type: "string",
  minLength: 1,
});

export const numberSchema = Object.freeze({
  type: "number",
});

const retryPolicy = Object.freeze({
  maxAttempts: 1,
  backoffMilliseconds: 0,
});

const noReviewPolicy = Object.freeze({ mode: "none" });
const display = Object.freeze({ collapsed: false });

const port = (portId, schema, required = true) => ({
  portId,
  name: portId,
  schema: structuredClone(schema),
  required,
});

const nodeBase = (nodeId, kind, x) => ({
  nodeId,
  kind,
  title: nodeId,
  description: `${kind} test node`,
  position: { x, y: 100 },
  inputPorts: [],
  outputPorts: [],
  inputBindings: [],
  reviewPolicy: structuredClone(noReviewPolicy),
  retryPolicy: structuredClone(retryPolicy),
  timeoutSeconds: 60,
  display: structuredClone(display),
});

export function makeInputNode({
  nodeId = "node-input",
  fieldId = "topic",
  schema = stringSchema,
  x = 0,
} = {}) {
  return {
    ...nodeBase(nodeId, "Input", x),
    outputPorts: [port(fieldId, schema)],
    configuration: { fieldIds: [fieldId] },
  };
}

export function makeSkillNode({
  nodeId = "node-skill-b",
  skillId = "skill-research-b",
  inputNodeId = "node-input",
  inputPortId = "topic",
  targetPortId = "topic",
  outputPortId = "brief",
  inputSchema = stringSchema,
  outputSchema = stringSchema,
  x = 300,
} = {}) {
  return {
    ...nodeBase(nodeId, "Skill", x),
    skillRef: { skillId, version: "1.0.0" },
    inputPorts: [port(targetPortId, inputSchema)],
    outputPorts: [port(outputPortId, outputSchema)],
    inputBindings: [
      {
        targetPort: targetPortId,
        source: {
          kind: "nodeOutput",
          nodeId: inputNodeId,
          portId: inputPortId,
        },
      },
    ],
    configuration: {},
  };
}

export function makeOutputNode({
  nodeId = "node-output-b",
  sourceNodeId = "node-skill-b",
  sourcePortId = "brief",
  targetPortId = "content",
  outputPortId = "final",
  inputSchema = stringSchema,
  outputSchema = stringSchema,
  x = 600,
} = {}) {
  return {
    ...nodeBase(nodeId, "Output", x),
    inputPorts: [port(targetPortId, inputSchema)],
    outputPorts: [port(outputPortId, outputSchema)],
    inputBindings: [
      {
        targetPort: targetPortId,
        source: {
          kind: "nodeOutput",
          nodeId: sourceNodeId,
          portId: sourcePortId,
        },
      },
    ],
    configuration: { format: "markdown" },
  };
}

export function makeReviewNode({
  nodeId = "node-review",
  sourceNodeId = "node-skill-b",
  sourcePortId = "brief",
  x = 450,
} = {}) {
  return {
    ...nodeBase(nodeId, "ReviewGate", x),
    inputPorts: [port("candidate", stringSchema)],
    outputPorts: [port("approved", stringSchema)],
    inputBindings: [
      {
        targetPort: "candidate",
        source: {
          kind: "nodeOutput",
          nodeId: sourceNodeId,
          portId: sourcePortId,
        },
      },
    ],
    configuration: {
      instructions: "Confirm the result.",
      allowRevision: true,
    },
    reviewPolicy: {
      mode: "required",
      instructions: "Approve, revise, or reject.",
    },
  };
}

export function makeEdge({
  edgeId,
  sourceNodeId,
  sourcePort,
  targetNodeId,
  targetPort,
  mappingExpression,
}) {
  return {
    edgeId,
    sourceNodeId,
    sourcePort,
    targetNodeId,
    targetPort,
    ...(mappingExpression === undefined ? {} : { mappingExpression }),
  };
}

export function makeRevision() {
  const input = makeInputNode();
  const skill = makeSkillNode();
  const output = makeOutputNode();

  return {
    schemaVersion: "workbench-v1",
    revisionId: "revision-compiler-1",
    workflowId: "workflow-compiler",
    revisionNumber: 1,
    baseRevisionId: null,
    graph: {
      nodes: [input, skill, output],
      edges: [
        makeEdge({
          edgeId: "edge-input-skill-b",
          sourceNodeId: input.nodeId,
          sourcePort: "topic",
          targetNodeId: skill.nodeId,
          targetPort: "topic",
        }),
        makeEdge({
          edgeId: "edge-skill-b-output-b",
          sourceNodeId: skill.nodeId,
          sourcePort: "brief",
          targetNodeId: output.nodeId,
          targetPort: "content",
        }),
      ],
    },
    inputForm: {
      fields: [
        {
          fieldId: "topic",
          label: "Topic",
          description: "Topic to research",
          schema: structuredClone(stringSchema),
          required: true,
        },
      ],
    },
    outputDefinition: {
      primary: { nodeId: output.nodeId, portId: "final" },
      expectedOutputs: [
        {
          nodeId: output.nodeId,
          portId: "final",
          label: "Final result",
          mediaType: "text/markdown",
        },
      ],
    },
    resourceRefs: [],
    runSettings: {
      maxParallelism: 1,
      defaultTimeoutSeconds: 300,
      workflowFallbackAllowed: false,
    },
    contentHash: "sha256:0000000000000000",
    authoredBy: "user-test",
    saveReason: "Compiler test fixture",
    compile: { status: "ready", diagnostics: [] },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeSkillDefinition(
  skillRef,
  { readinessStatus = "ready" } = {},
) {
  return {
    schemaVersion: "workbench-v1",
    skillId: skillRef.skillId,
    version: skillRef.version,
    name: skillRef.skillId,
    description: "Compiler test Skill",
    category: "test",
    display: {
      defaultLocale: "en",
      localized: {
        en: {
          name: skillRef.skillId,
          description: "Compiler test Skill",
        },
      },
    },
    inputSchema: {
      type: "object",
      properties: { topic: structuredClone(stringSchema) },
      required: ["topic"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { brief: structuredClone(stringSchema) },
      required: ["brief"],
      additionalProperties: false,
    },
    risk: {
      level: "low",
      externalAction: false,
      summary: "No external action",
    },
    dependencies: [],
    setupChecks: [],
    executionRef: {
      capabilityId: `capability.${skillRef.skillId}`,
      taskIntent: "compile_test",
      adapterVersion: "1.0.0",
      executionMode: "deterministic",
    },
    usageCount: 1,
    readiness: {
      status: readinessStatus,
      diagnostics: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function makeResolver({
  skillReadinessStatus = "ready",
  adapterStatus = "ready",
  piStatus = "ready",
  resourceStatus = "ready",
  resolveSkill,
  resolveResource,
} = {}) {
  const calls = { skills: [], resources: [] };

  return {
    calls,
    resolveSkill(skillRef) {
      calls.skills.push(structuredClone(skillRef));
      if (resolveSkill) {
        return resolveSkill(skillRef);
      }
      return {
        definition: makeSkillDefinition(skillRef, {
          readinessStatus: skillReadinessStatus,
        }),
        adapterReadiness: {
          status: adapterStatus,
          reason: `Adapter is ${adapterStatus}.`,
        },
        piReadiness: {
          status: piStatus,
          reason: `PI is ${piStatus}.`,
        },
      };
    },
    resolveResource(resourceRef) {
      calls.resources.push(structuredClone(resourceRef));
      if (resolveResource) {
        return resolveResource(resourceRef);
      }
      return {
        readiness: {
          status: resourceStatus,
          reason: `Resource is ${resourceStatus}.`,
        },
      };
    },
  };
}
