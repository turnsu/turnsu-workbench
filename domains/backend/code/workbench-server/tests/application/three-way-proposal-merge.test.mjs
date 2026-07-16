import assert from "node:assert/strict";
import test from "node:test";

import { mergeWorkflowProposal } from "../../src/proposals/three-way-proposal-merge.mjs";
import { makeRevision } from "../compiler/fixtures.mjs";

test("three-way merge rebases non-overlapping node, Definition, settings, Resource, and Skill pin changes", () => {
  const base = makeRevision();
  base.definition = definition("Base goal", "Base context");
  const current = structuredClone(base);
  const proposed = structuredClone(base);
  current.definition.context = "Canonical context changed by another collaborator.";
  current.graph.nodes[0].title = "Canonical input title";
  proposed.definition.goal = "Proposed goal";
  proposed.runSettings.defaultTimeoutSeconds = 240;
  proposed.graph.nodes[1].skillRef = { ...proposed.graph.nodes[1].skillRef, version: "1.1.0" };
  proposed.resourceRefs.push({ resourceId: "resource-new", version: "1", label: "New resource" });

  const result = mergeWorkflowProposal({ base, current, proposed });

  assert.equal(result.status, "merged");
  assert.equal(result.merged.definition.context, current.definition.context);
  assert.equal(result.merged.definition.goal, "Proposed goal");
  assert.equal(result.merged.graph.nodes[0].title, "Canonical input title");
  assert.equal(result.merged.graph.nodes[1].skillRef.version, "1.1.0");
  assert.equal(result.merged.runSettings.defaultTimeoutSeconds, 240);
  assert(result.merged.resourceRefs.some((resource) => resource.resourceId === "resource-new"));
});

test("same-path conflict returns hashes and leaves the canonical revision unchanged", () => {
  const base = makeRevision();
  base.definition = definition("Base goal", "Base context");
  const current = structuredClone(base);
  const proposed = structuredClone(base);
  current.definition.goal = "Canonical goal";
  proposed.definition.goal = "Agent goal";
  const before = structuredClone(current);

  const result = mergeWorkflowProposal({ base, current, proposed });

  assert.equal(result.status, "conflicted");
  assert.equal(result.merged, null);
  assert.equal(result.conflicts[0].path, "/definition/goal");
  assert.match(result.conflicts[0].baseValueHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(current, before);
});

test("concurrent edits to different fields on the same node do not conflict", () => {
  const base = makeRevision();
  const current = structuredClone(base);
  const proposed = structuredClone(base);
  current.graph.nodes[1].title = "Canonical title";
  proposed.graph.nodes[1].description = "Agent description";

  const result = mergeWorkflowProposal({ base, current, proposed });

  assert.equal(result.status, "merged");
  assert.equal(result.merged.graph.nodes[1].title, "Canonical title");
  assert.equal(result.merged.graph.nodes[1].description, "Agent description");
});

function definition(goal, context) {
  return {
    goal,
    context,
    constraints: [],
    doneWhen: ["Complete"],
    verify: [],
    expectedResult: "A result",
    stopRules: [],
  };
}
