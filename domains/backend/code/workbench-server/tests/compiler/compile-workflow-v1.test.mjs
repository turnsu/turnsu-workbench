import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  CompileResultSchema,
  ExecutionPlanV2Schema,
  WorkflowRevisionSchema,
} from "@looloomi/workbench-contracts";

import { compileWorkflowV1 } from "../../src/compiler/compile-workflow-v1.mjs";
import {
  NOW,
  makeEdge,
  makeOutputNode,
  makeResolver,
  makeReviewNode,
  makeRevision,
  makeSkillNode,
  numberSchema,
  stringSchema,
} from "./fixtures.mjs";

const compile = (revision, resolver = makeResolver()) =>
  compileWorkflowV1(revision, { resolver, compiledAt: NOW });

const diagnosticFor = (result, code) =>
  result.warnings.find((diagnostic) => diagnostic.code === code);

const assertDiagnostic = (result, code, nodeId) => {
  const diagnostic = diagnosticFor(result, code);
  assert.ok(diagnostic, `missing diagnostic ${code}`);
  if (nodeId !== undefined) {
    assert.equal(diagnostic.nodeId, nodeId);
  }
  return diagnostic;
};

const addSecondBranch = (revision) => {
  const skill = makeSkillNode({
    nodeId: "node-skill-a",
    skillId: "skill-research-a",
  });
  const output = makeOutputNode({
    nodeId: "node-output-a",
    sourceNodeId: skill.nodeId,
  });

  revision.graph.nodes.push(skill, output);
  revision.graph.edges.push(
    makeEdge({
      edgeId: "edge-input-skill-a",
      sourceNodeId: "node-input",
      sourcePort: "topic",
      targetNodeId: skill.nodeId,
      targetPort: "topic",
    }),
    makeEdge({
      edgeId: "edge-skill-a-output-a",
      sourceNodeId: skill.nodeId,
      sourcePort: "brief",
      targetNodeId: output.nodeId,
      targetPort: "content",
    }),
  );
  revision.outputDefinition.primary = {
    nodeId: output.nodeId,
    portId: "final",
  };
  revision.outputDefinition.expectedOutputs.push({
    nodeId: output.nodeId,
    portId: "final",
    label: "Alternate result",
    mediaType: "text/markdown",
  });
};

test("validates the WorkflowRevision contract before resolver calls", () => {
  const revision = { ...makeRevision(), unexpected: true };
  const resolver = makeResolver();

  const result = compile(revision, resolver);

  assert.equal(result.status, "invalid");
  assertDiagnostic(result, "revision_schema_invalid");
  assert.deepEqual(resolver.calls, { skills: [], resources: [] });
  assert.equal(Check(CompileResultSchema, result), true);
});

test("compiles a linear graph to a frozen contract-valid plan", () => {
  const revision = makeRevision();
  assert.equal(Check(WorkflowRevisionSchema, revision), true);

  const result = compile(revision);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.orderedSteps, [
    "node-input",
    "node-skill-b",
    "node-output-b",
  ]);
  assert.equal(Check(CompileResultSchema, result), true);
  assert.equal(Check(ExecutionPlanV2Schema, result.executionPlan), true);
  assert.equal(result.executionPlan.planVersion, "2");
  assert.equal(result.executionPlan.steps[1].executionMode, "deterministic_skill");
  assert.equal(result.executionPlan.steps[1].limits.maxModelRequests, 0);
  assert.deepEqual(result.executionPlan.pinnedSkills, [
    { skillId: "skill-research-b", version: "1.0.0" },
  ]);
  assert.deepEqual(
    result.executionPlan.steps.map(({ nodeId, dependsOn }) => ({
      nodeId,
      dependsOn,
    })),
    [
      { nodeId: "node-input", dependsOn: [] },
      { nodeId: "node-skill-b", dependsOn: ["node-input"] },
      { nodeId: "node-output-b", dependsOn: ["node-skill-b"] },
    ],
  );
  assert.deepEqual(result.executionPlan.primaryOutput, {
    nodeId: "node-output-b",
    portId: "final",
  });
  assert.equal(result.executionPlan.maxParallelism, 1);
  assert.match(result.executionPlan.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result.executionPlan), true);
  assert.equal(Object.isFrozen(result.executionPlan.steps), true);
  assert.equal(Object.isFrozen(result.executionPlan.steps[1].inputBindings[0].source), true);
  assert.throws(
    () => result.executionPlan.steps[1].dependsOn.push("node-other"),
    TypeError,
  );
});

test("sorts each Kahn layer by nodeId in a branched DAG", () => {
  const revision = makeRevision();
  addSecondBranch(revision);

  const result = compile(revision);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.orderedSteps, [
    "node-input",
    "node-skill-a",
    "node-skill-b",
    "node-output-a",
    "node-output-b",
  ]);
  assert.deepEqual(result.executionPlan.pinnedSkills, [
    { skillId: "skill-research-a", version: "1.0.0" },
    { skillId: "skill-research-b", version: "1.0.0" },
  ]);
});

test("rejects a cycle", () => {
  const revision = makeRevision();
  const skill = revision.graph.nodes.find(({ nodeId }) => nodeId === "node-skill-b");
  skill.inputPorts.push({
    portId: "feedback",
    name: "feedback",
    schema: structuredClone(stringSchema),
    required: true,
  });
  skill.inputBindings.push({
    targetPort: "feedback",
    source: {
      kind: "nodeOutput",
      nodeId: "node-output-b",
      portId: "final",
    },
  });
  revision.graph.edges.push(
    makeEdge({
      edgeId: "edge-output-b-skill-b",
      sourceNodeId: "node-output-b",
      sourcePort: "final",
      targetNodeId: "node-skill-b",
      targetPort: "feedback",
    }),
  );

  const result = compile(revision);

  assert.equal(result.status, "invalid");
  assert.deepEqual(result.invalidCycles, [
    { nodeIds: ["node-output-b", "node-skill-b"] },
  ]);
  assertDiagnostic(result, "workflow_cycle");
});

test("rejects dangling edge and binding node and port references", async (t) => {
  await t.test("missing node", () => {
    const revision = makeRevision();
    revision.graph.edges[0].sourceNodeId = "node-missing";

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "edge_node_not_found", "node-skill-b");
  });

  await t.test("missing port", () => {
    const revision = makeRevision();
    revision.graph.edges[0].sourcePort = "missing-port";

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "edge_port_not_found", "node-skill-b");
  });

  await t.test("binding missing node", () => {
    const revision = makeRevision();
    const skill = revision.graph.nodes.find(({ nodeId }) => nodeId === "node-skill-b");
    skill.inputBindings[0].source.nodeId = "node-missing";

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "binding_node_not_found", "node-skill-b");
  });

  await t.test("binding missing port", () => {
    const revision = makeRevision();
    const skill = revision.graph.nodes.find(({ nodeId }) => nodeId === "node-skill-b");
    skill.inputBindings[0].source.portId = "missing-port";

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "binding_port_not_found", "node-skill-b");
  });
});

test("rejects duplicate node, edge, and per-node port IDs", async (t) => {
  await t.test("node ID", () => {
    const revision = makeRevision();
    revision.graph.nodes.push(structuredClone(revision.graph.nodes[0]));
    assertDiagnostic(compile(revision), "duplicate_node_id", "node-input");
  });

  await t.test("edge ID", () => {
    const revision = makeRevision();
    revision.graph.edges.push(structuredClone(revision.graph.edges[0]));
    assertDiagnostic(compile(revision), "duplicate_edge_id", "node-skill-b");
  });

  await t.test("port ID", () => {
    const revision = makeRevision();
    revision.graph.nodes[0].outputPorts.push(
      structuredClone(revision.graph.nodes[0].outputPorts[0]),
    );
    assertDiagnostic(compile(revision), "duplicate_port_id", "node-input");
  });
});

test("rejects incompatible source and target port schemas with node location", () => {
  const revision = makeRevision();
  const skill = revision.graph.nodes.find(({ nodeId }) => nodeId === "node-skill-b");
  skill.inputPorts[0].schema = structuredClone(numberSchema);

  const result = compile(revision);

  assert.equal(result.status, "invalid");
  assert.equal(result.portSchemaMismatches.length, 1);
  assert.deepEqual(result.portSchemaMismatches[0], {
    sourceNodeId: "node-input",
    sourcePort: "topic",
    targetNodeId: "node-skill-b",
    targetPort: "topic",
    message: "Source schema is not assignable to the target schema.",
  });
  assertDiagnostic(result, "port_schema_mismatch", "node-skill-b");
});

test("rejects ambiguous target port bindings", () => {
  const revision = makeRevision();
  const skill = revision.graph.nodes.find(({ nodeId }) => nodeId === "node-skill-b");
  skill.inputBindings.push({
    targetPort: "topic",
    source: { kind: "literal", value: "another topic" },
  });

  const result = compile(revision);

  assert.equal(result.status, "invalid");
  assertDiagnostic(result, "ambiguous_target_binding", "node-skill-b");
});

test("accepts identity and JSON Pointer mappings and rejects JS/JQ expressions", async (t) => {
  await t.test("identity", () => {
    const revision = makeRevision();
    revision.graph.edges[0].mappingExpression = "identity";
    assert.equal(compile(revision).status, "ready");
  });

  await t.test("JSON Pointer", () => {
    const revision = makeRevision();
    const objectSchema = {
      type: "object",
      properties: { value: structuredClone(stringSchema) },
      required: ["value"],
      additionalProperties: false,
    };
    revision.graph.nodes[0].outputPorts[0].schema = structuredClone(objectSchema);
    revision.inputForm.fields[0].schema = structuredClone(objectSchema);
    revision.graph.edges[0].mappingExpression = "/value";
    assert.equal(compile(revision).status, "ready");
  });

  for (const expression of ["jq:.value", "js:value => value", "$.value"]) {
    await t.test(`invalid ${expression}`, () => {
      const revision = makeRevision();
      revision.graph.edges[0].mappingExpression = expression;

      const result = compile(revision);

      assert.equal(result.status, "invalid");
      assertDiagnostic(result, "invalid_mapping_expression", "node-skill-b");
    });
  }
});

test("rejects missing and unreachable Output nodes", async (t) => {
  await t.test("no Output", () => {
    const revision = makeRevision();
    revision.graph.nodes = revision.graph.nodes.filter(
      ({ kind }) => kind !== "Output",
    );
    revision.graph.edges = revision.graph.edges.filter(
      ({ targetNodeId }) => targetNodeId !== "node-output-b",
    );

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "output_node_required");
  });

  await t.test("unreachable Output", () => {
    const revision = makeRevision();
    const orphan = makeOutputNode({ nodeId: "node-output-orphan" });
    orphan.inputPorts = [];
    orphan.inputBindings = [];
    revision.graph.nodes.push(orphan);
    revision.outputDefinition.expectedOutputs.push({
      nodeId: orphan.nodeId,
      portId: "final",
      label: "Orphan result",
      mediaType: "text/markdown",
    });

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assert.ok(result.unreachableNodeIds.includes(orphan.nodeId));
    assertDiagnostic(result, "output_unreachable", orphan.nodeId);
  });
});

test("rejects a missing or invalid explicit primary Output", async (t) => {
  await t.test("missing primary", () => {
    const revision = makeRevision();
    delete revision.outputDefinition.primary;

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "revision_schema_invalid");
  });

  await t.test("multiple Outputs with non-Output primary", () => {
    const revision = makeRevision();
    addSecondBranch(revision);
    revision.outputDefinition.primary = {
      nodeId: "node-input",
      portId: "topic",
    };

    const result = compile(revision);

    assert.equal(result.status, "invalid");
    assertDiagnostic(result, "primary_output_invalid", "node-input");
  });
});

test("uses blocked only for unresolved Skill, adapter, PI, and Resource readiness", async (t) => {
  await t.test("Skill blocked", () => {
    const result = compile(makeRevision(), makeResolver({ skillStatus: "blocked" }));
    assert.equal(result.status, "blocked");
    assert.equal(Check(CompileResultSchema, result), true);
    assert.equal(result.unavailableSkills.length, 1);
    assert.equal(result.unavailableSkills[0].nodeId, "node-skill-b");
    assertDiagnostic(result, "skill_not_ready", "node-skill-b");
  });

  for (const [label, options, code] of [
    ["adapter blocked", { adapterStatus: "blocked" }, "skill_adapter_not_ready"],
    ["PI blocked", { piStatus: "blocked" }, "pi_not_ready"],
  ]) {
    await t.test(label, () => {
      const result = compile(makeRevision(), makeResolver(options));
      assert.equal(result.status, "blocked");
      assertDiagnostic(result, code, "node-skill-b");
    });
  }

  await t.test("Resource blocked", () => {
    const revision = makeRevision();
    revision.resourceRefs.push({
      resourceId: "resource-source-1",
      version: "1.0.0",
      label: "Source material",
    });

    const result = compile(
      revision,
      makeResolver({ resourceStatus: "blocked" }),
    );

    assert.equal(result.status, "blocked");
    assert.equal(Check(CompileResultSchema, result), true);
    assert.deepEqual(result.missingResources, [
      { resourceId: "resource-source-1", label: "Source material" },
    ]);
    assertDiagnostic(result, "resource_not_ready");
  });
});

test("emits ReviewGate metadata in the execution plan", () => {
  const revision = makeRevision();
  const review = makeReviewNode();
  const output = revision.graph.nodes.find(({ nodeId }) => nodeId === "node-output-b");
  output.inputBindings[0].source = {
    kind: "nodeOutput",
    nodeId: review.nodeId,
    portId: "approved",
  };
  revision.graph.nodes.push(review);
  revision.graph.edges[1] = makeEdge({
    edgeId: "edge-skill-b-review",
    sourceNodeId: "node-skill-b",
    sourcePort: "brief",
    targetNodeId: review.nodeId,
    targetPort: "candidate",
  });
  revision.graph.edges.push(
    makeEdge({
      edgeId: "edge-review-output-b",
      sourceNodeId: review.nodeId,
      sourcePort: "approved",
      targetNodeId: "node-output-b",
      targetPort: "content",
    }),
  );

  const result = compile(revision);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.reviewGates, ["node-review"]);
  assert.deepEqual(result.executionPlan.reviewGates, [
    {
      nodeId: "node-review",
      dependsOn: ["node-skill-b"],
      instructions: "Approve, revise, or reject.",
    },
  ]);
});

test("position, edge order, and nodes[] order do not change execution or hash", () => {
  const first = makeRevision();
  addSecondBranch(first);
  const second = structuredClone(first);
  second.graph.nodes.reverse();
  second.graph.edges.reverse();
  second.graph.nodes.forEach((node, index) => {
    node.position = { x: 900 - index * 137, y: index * 83 };
  });

  const firstResult = compile(first);
  const secondResult = compile(second);

  assert.equal(firstResult.status, "ready");
  assert.equal(secondResult.status, "ready");
  assert.deepEqual(secondResult.orderedSteps, firstResult.orderedSteps);
  assert.equal(
    secondResult.executionPlan.contentHash,
    firstResult.executionPlan.contentHash,
  );
  assert.deepEqual(secondResult.executionPlan, firstResult.executionPlan);
});
