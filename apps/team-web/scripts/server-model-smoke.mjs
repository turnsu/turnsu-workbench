import assert from "node:assert/strict";

import {
  isCurrentPublishedSkill,
  latestTeamReleaseIds,
  skillAssetSummaryToView,
  skillDefinitionToView,
  workflowRevisionToCanvas,
  workflowTemplateToView,
  workflowToView,
} from "../src/state/server/presentationAdapters.js";

const stringSchema = { type: "string", minLength: 1 };
const node = {
  nodeId: "node-skill",
  kind: "Skill",
  title: "Echo",
  description: "Echo supplied text.",
  position: { x: 10, y: 20 },
  inputPorts: [{ portId: "text", name: "Text", schema: stringSchema, required: true }],
  outputPorts: [{ portId: "echo", name: "Echo", schema: stringSchema, required: true }],
  inputBindings: [],
  reviewPolicy: { mode: "none" },
  retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
  timeoutSeconds: 30,
  display: { collapsed: false },
  skillRef: { skillId: "workflow-conformance", version: "1" },
  configuration: {},
};
const revision = {
  revisionId: "revision-1",
  workflowId: "workflow-1",
  graph: { nodes: [node], edges: [] },
  inputForm: { fields: [{ fieldId: "text", label: "Text", description: "", schema: stringSchema, required: true }] },
  outputDefinition: { primary: { nodeId: "node-skill", portId: "echo" }, expectedOutputs: [{ nodeId: "node-skill", portId: "echo", label: "Echo", mediaType: "text/plain" }] },
  resourceRefs: [],
  runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 30 },
};
const skill = skillDefinitionToView({
  skillId: "workflow-conformance",
  version: "1",
  name: "Workflow conformance",
  description: "Echo text.",
  category: "test",
  readiness: { status: "ready", diagnostics: [] },
  inputSchema: { type: "object", properties: { text: stringSchema }, required: ["text"] },
  outputSchema: { type: "object", properties: { echo: stringSchema } },
  risk: { level: "low", externalAction: false, summary: "No external action." },
  dependencies: [],
  setupChecks: [],
  usageCount: 1,
});
assert.equal(skill.id, "workflow-conformance");
assert.deepEqual(skill.inputs, ["text"]);
assert.equal(skill.setupState, "Ready");

const skillDraft = {
  name: "Draft echo",
  description: "Echo a draft value.",
  category: "test",
  inputSchema: { type: "object", properties: { text: stringSchema }, required: ["text"] },
  outputSchema: { type: "object", properties: { echo: stringSchema } },
  risk: { level: "low", externalAction: false, summary: "No external action." },
  dependencies: [],
};
const testedSkill = skillAssetSummaryToView({
  skill: { skillId: "skill-draft-echo", lifecycle: "tested" },
  draft: skillDraft,
  latestVersion: null,
});
assert.equal(testedSkill.title, "Draft echo");
assert.equal(testedSkill.setupState, "Needs source");
const testedUpdate = skillAssetSummaryToView({
  skill: { skillId: "skill-draft-echo", lifecycle: "tested" },
  draft: { ...skillDraft, name: "Tested update" },
  latestVersion: { ...skillDraft, name: "Old published echo", version: "1.0.0", validation: { status: "passed", diagnostics: [] } },
});
assert.equal(testedUpdate.title, "Tested update");
assert.equal(testedUpdate.version, null);
assert.equal(testedUpdate.setupState, "Needs source");
const publishedSkill = skillAssetSummaryToView({
  skill: { skillId: "skill-draft-echo", lifecycle: "published" },
  draft: skillDraft,
  latestVersion: { ...skillDraft, version: "1.0.0", validation: { status: "passed", diagnostics: [] } },
});
assert.equal(publishedSkill.version, "1.0.0");
assert.equal(publishedSkill.setupState, "Ready");

for (const lifecycle of ["draft", "validating", "tested", "deprecated", "archived"]) {
  assert.equal(isCurrentPublishedSkill({
    canonical: {
      skill: { lifecycle },
      version: { skillVersionId: "historical-version", version: "1.0.0" },
    },
  }), false, `${lifecycle} must not expose its historical version as current published state`);
}
assert.equal(isCurrentPublishedSkill({
  canonical: {
    skill: { lifecycle: "published" },
    version: { skillVersionId: "current-version", version: "1.0.0" },
  },
}), true);
assert.equal(isCurrentPublishedSkill({
  canonical: { skill: { lifecycle: "published" }, version: null },
}), false, "published without the pinned version fails closed");

const canvas = workflowRevisionToCanvas(revision);
assert.equal(canvas.nodes[0].id, "node-skill");
assert.equal(canvas.nodes[0].skillId, "workflow-conformance");
assert.equal(canvas.nodes[0].position.x, 10);
assert.equal(canvas.nodes[0].reviewPolicy, "");
assert.equal(canvas.nodes[0].reviewPolicyMode, "none");

const workflow = workflowToView({
  workflowId: "workflow-1",
  name: "Echo workflow",
  description: "Echo and review.",
  status: "ready",
  currentRevisionId: "revision-1",
}, revision);
assert.equal(workflow.type, "LoopWorkflow");
assert.equal(workflow.readiness, "Ready");
assert.equal(workflow.workflow.nodes[0].id, "node-skill");

const template = workflowTemplateToView({
  templateId: "template-1",
  templateVersion: "1",
  name: "Echo template",
  description: "Start with echo.",
  category: "test",
  graph: revision.graph,
  inputForm: revision.inputForm,
  expectedOutputs: revision.outputDefinition.expectedOutputs,
  reviewPolicy: { required: true, gateNodeIds: [] },
  availability: { status: "available", diagnostics: [] },
});
assert.equal(template.type, "LoopTemplate");
assert.equal(template.source, "Preset Templates");

const releases = [
  { releaseId: "release-v1", assetKind: "loop", assetId: "loop-1", versionId: "version-v1", publishedAt: "2026-07-12T00:00:00.000Z" },
  { releaseId: "release-v2", assetKind: "loop", assetId: "loop-1", versionId: "version-v2", publishedAt: "2026-07-13T00:00:00.000Z" },
  { releaseId: "skill-v1", assetKind: "skill", assetId: "skill-1", versionId: "skill-version-v1", publishedAt: "2026-07-11T00:00:00.000Z" },
];
const latestReleaseIds = latestTeamReleaseIds(releases);
assert.equal(latestReleaseIds.get("loop:loop-1"), "release-v2");
assert.equal(latestReleaseIds.get("skill:skill-1"), "skill-v1");
assert.notEqual(latestReleaseIds.get("loop:loop-1"), "release-v1", "an older release must not become an update target");

console.log("web_server_model_smoke=pass");
