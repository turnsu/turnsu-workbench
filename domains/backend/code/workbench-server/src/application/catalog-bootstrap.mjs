import {
  skillDefinitionExample,
  workflowTemplateExample,
} from "../../../workbench-contracts/examples/canonical-examples.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
  WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_SKILL_ID,
} from "../../../../../agent/code/agent-runtime/extensions/workflow-conformance/binding.mjs";
import {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
} from "../../../../../agent/code/agent-runtime/extensions/meeting-action-extractor/binding.mjs";
import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";

const clone = (value) => structuredClone(value);

const blockedDiagnostic = (code) => ({
  code,
  message: "This sample is blocked because no executable runtime binding is available.",
  severity: "error",
  recoveryAction: "Configure and validate an executable Skill binding.",
});

const stringSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 10000 });
const integerSchema = Object.freeze({ type: "integer", minimum: 0, maximum: 10000 });
const actionItemsSchema = Object.freeze({
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string", minLength: 1, maxLength: 2000 } },
    required: ["text"],
    additionalProperties: false,
  },
});

function conformanceGraph(skillRef) {
  const template = clone(workflowTemplateExample);
  const byId = new Map(template.graph.nodes.map((node) => [node.nodeId, node]));
  const input = byId.get("node-input");
  const skill = byId.get("node-skill");
  const review = byId.get("node-review");
  const output = byId.get("node-output");

  Object.assign(input, {
    title: "Text to review",
    description: "Enter the text that the workflow will echo and review.",
    outputPorts: [{ portId: "text", name: "Text", schema: clone(stringSchema), required: true }],
    configuration: { fieldIds: ["text"] },
  });
  Object.assign(skill, {
    title: "Echo text",
    description: "Run the pinned conformance Skill through PI.",
    skillRef,
    inputPorts: [{ portId: "text", name: "Text", schema: clone(stringSchema), required: true }],
    outputPorts: [
      { portId: "echo", name: "Echo", schema: clone(stringSchema), required: true },
      { portId: "charCount", name: "Character count", schema: clone(integerSchema), required: true },
    ],
    inputBindings: [{
      targetPort: "text",
      source: { kind: "nodeOutput", nodeId: "node-input", portId: "text" },
    }],
  });
  Object.assign(review, {
    title: "Review echoed text",
    description: "Pause until the echoed text is approved, revised, or rejected.",
    inputPorts: [{ portId: "candidate", name: "Candidate", schema: clone(stringSchema), required: true }],
    outputPorts: [{ portId: "approved", name: "Approved", schema: clone(stringSchema), required: true }],
    inputBindings: [{
      targetPort: "candidate",
      source: { kind: "nodeOutput", nodeId: "node-skill", portId: "echo" },
    }],
    configuration: {
      instructions: "Confirm the echoed text before publishing.",
      allowRevision: true,
      revisionTarget: { nodeId: "node-skill", portId: "text" },
    },
    reviewPolicy: { mode: "required", instructions: "Approve, request a revision, or reject." },
  });
  Object.assign(output, {
    title: "Reviewed text",
    description: "Publish the approved text as the workflow result.",
    inputPorts: [{ portId: "content", name: "Content", schema: clone(stringSchema), required: true }],
    outputPorts: [{ portId: "final", name: "Final", schema: clone(stringSchema), required: true }],
    inputBindings: [{
      targetPort: "content",
      source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" },
    }],
  });

  return {
    nodes: [input, skill, review, output],
    edges: [
      { edgeId: "edge-input-skill", sourceNodeId: "node-input", sourcePort: "text", targetNodeId: "node-skill", targetPort: "text" },
      { edgeId: "edge-skill-review", sourceNodeId: "node-skill", sourcePort: "echo", targetNodeId: "node-review", targetPort: "candidate" },
      { edgeId: "edge-review-output", sourceNodeId: "node-review", sourcePort: "approved", targetNodeId: "node-output", targetPort: "content" },
    ],
  };
}

function meetingActionGraph(skillRef) {
  const template = clone(workflowTemplateExample);
  const byId = new Map(template.graph.nodes.map((node) => [node.nodeId, node]));
  const input = byId.get("node-input");
  const skill = byId.get("node-skill");
  const review = byId.get("node-review");
  const output = byId.get("node-output");

  Object.assign(input, {
    title: "Meeting notes",
    description: "Enter the meeting notes to review.",
    outputPorts: [{ portId: "transcript", name: "Meeting notes", schema: clone(stringSchema), required: true }],
    configuration: { fieldIds: ["transcript"] },
  });
  Object.assign(skill, {
    title: "Extract action items",
    description: "Find explicit follow-up actions in the supplied meeting notes.",
    skillRef,
    inputPorts: [{ portId: "transcript", name: "Meeting notes", schema: clone(stringSchema), required: true }],
    outputPorts: [
      { portId: "actionItems", name: "Action items", schema: clone(actionItemsSchema), required: true },
      { portId: "summary", name: "Summary", schema: clone(stringSchema), required: true },
    ],
    inputBindings: [{
      targetPort: "transcript",
      source: { kind: "nodeOutput", nodeId: "node-input", portId: "transcript" },
    }],
  });
  Object.assign(review, {
    title: "Review action summary",
    description: "Pause until the extracted action summary is approved, revised, or rejected.",
    inputPorts: [{ portId: "candidate", name: "Summary", schema: clone(stringSchema), required: true }],
    outputPorts: [{ portId: "approved", name: "Approved summary", schema: clone(stringSchema), required: true }],
    inputBindings: [{
      targetPort: "candidate",
      source: { kind: "nodeOutput", nodeId: "node-skill", portId: "summary" },
    }],
    configuration: {
      instructions: "Confirm that the action summary is ready to share.",
      allowRevision: true,
      revisionTarget: { nodeId: "node-skill", portId: "transcript" },
    },
    reviewPolicy: { mode: "required", instructions: "Approve, request a revision, or reject." },
  });
  Object.assign(output, {
    title: "Reviewed action summary",
    description: "Publish the approved action summary as the workflow result.",
    inputPorts: [{ portId: "content", name: "Content", schema: clone(stringSchema), required: true }],
    outputPorts: [{ portId: "final", name: "Final", schema: clone(stringSchema), required: true }],
    inputBindings: [{
      targetPort: "content",
      source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" },
    }],
  });

  return {
    nodes: [input, skill, review, output],
    edges: [
      { edgeId: "edge-input-skill", sourceNodeId: "node-input", sourcePort: "transcript", targetNodeId: "node-skill", targetPort: "transcript" },
      { edgeId: "edge-skill-review", sourceNodeId: "node-skill", sourcePort: "summary", targetNodeId: "node-review", targetPort: "candidate" },
      { edgeId: "edge-review-output", sourceNodeId: "node-review", sourcePort: "approved", targetNodeId: "node-output", targetPort: "content" },
    ],
  };
}

function bundledPackage(testMode) {
  const source = readFileSync(new URL(
    testMode
      ? "../../../../../agent/code/agent-runtime/skills/workflow-conformance.md"
      : "../../../../../agent/code/agent-runtime/skills/meeting-action-extractor.md",
    import.meta.url,
  ), "utf8");
  const inspection = inspectSkillPackage({ files: [{ path: "SKILL.md", content: source }] });
  if (inspection.status !== "passed") throw new Error("bundled_skill_package_invalid");
  return { source, inspection };
}

function contentHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function ensureBundledSkillVersion({ store, skill, now, testMode }) {
  const { skillAssets, skillVersions, objects } = store.repositories || {};
  if (!skillAssets?.get || !skillAssets?.insert || !skillVersions?.getBySkillRef || !skillVersions?.insert || !objects?.get || !objects?.insert) {
    return null;
  }
  const workspaceId = skill.workspaceId || "workspace-local";
  const version = skill.version;
  const existing = await skillVersions.getBySkillRef(skill.skillId, version, { workspaceId });
  if (existing) return existing;

  const { source, inspection } = bundledPackage(testMode);
  const objectId = `object-system-${skill.skillId}-${inspection.contentHash.slice("sha256:".length, 28)}`;
  if (!await objects.get(objectId, { workspaceId })) {
    await objects.insert({
      schemaVersion: "workbench-v1",
      objectId,
      workspaceId,
      contentHash: inspection.contentHash,
      mediaType: "application/vnd.looloomi.skill-package+json",
      sizeBytes: Buffer.byteLength(source, "utf8"),
      createdAt: now,
    });
  }
  const createdVersion = await skillVersions.insert({
    schemaVersion: "workbench-v1",
    skillVersionId: `skill-version-system-${skill.skillId}-${version}`,
    skillId: skill.skillId,
    workspaceId,
    version,
    packageObjectId: objectId,
    packageHash: inspection.contentHash,
    contentHash: contentHash({
      packageHash: inspection.contentHash,
      name: skill.name,
      description: skill.description,
      executionRef: skill.executionRef,
    }),
    manifest: inspection.manifest || {},
    name: skill.name,
    description: skill.description,
    category: skill.category,
    inputSchema: clone(skill.inputSchema),
    outputSchema: clone(skill.outputSchema),
    risk: clone(skill.risk),
    dependencies: clone(skill.dependencies),
    connectionRequirements: [],
    validation: { validationId: `system-${skill.skillId}-${version}`, status: "passed", diagnostics: [], testedAt: now },
    executionRef: clone(skill.executionRef),
    publishedBy: "system-catalog",
    publishedAt: now,
  });
  const asset = await skillAssets.get(skill.skillId, { workspaceId });
  const patch = {
    latestPublishedVersionId: createdVersion.skillVersionId,
    lifecycle: "ready",
    updatedAt: now,
  };
  if (asset) await skillAssets.patch(skill.skillId, patch, { workspaceId });
  else await skillAssets.insert({
    schemaVersion: "workbench-v1",
    skillId: skill.skillId,
    workspaceId,
    ownerId: "system-catalog",
    visibility: "private",
    lifecycle: "ready",
    currentDraftId: null,
    latestPublishedVersionId: createdVersion.skillVersionId,
    createdAt: now,
    updatedAt: now,
  });
  return createdVersion;
}

export async function bootstrapWorkbenchCatalog({
  store,
  agentRuntime,
  testMode = process.env.WORKBENCH_TEST_MODE === "1",
  clock = () => new Date().toISOString(),
  workspaceId,
} = {}) {
  if (typeof store?.connect !== "function") throw new TypeError("catalog_bootstrap_store_invalid");
  await store.connect();
  if (!store.repositories?.skills?.upsert || !store.repositories?.templates?.get || !store.repositories?.templates?.insert) {
    throw new TypeError("catalog_bootstrap_store_invalid");
  }
  const now = clock();
  const skill = clone(skillDefinitionExample);
  const template = clone(workflowTemplateExample);
  skill.skillId = testMode ? WORKFLOW_CONFORMANCE_SKILL_ID : MEETING_ACTION_EXTRACTOR_SKILL_ID;
  skill.version = "1";
  skill.name = testMode ? "Workflow conformance" : "Meeting action extractor";
  skill.description = testMode
    ? "Test-only deterministic conformance Skill."
    : "Extract explicit follow-up actions from meeting notes without external access.";
  skill.display.localized.en = { name: skill.name, description: skill.description };
  skill.inputSchema = clone(testMode
    ? WORKFLOW_CONFORMANCE_INPUT_SCHEMA
    : MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA);
  skill.outputSchema = clone(testMode
    ? WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA
    : MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA);
  skill.executionRef = testMode
    ? clone(WORKFLOW_CONFORMANCE_EXECUTION_REF)
    : clone(MEETING_ACTION_EXTRACTOR_EXECUTION_REF);
  skill.createdAt = now;
  skill.updatedAt = now;
  if (workspaceId) skill.workspaceId = workspaceId;
  template.templateId = testMode ? "template-workflow-conformance" : "template-meeting-action-extractor";
  template.name = testMode ? "Workflow conformance" : "Meeting action Loop";
  template.description = testMode
    ? "Input, Skill, ReviewGate, and Output conformance graph."
    : "Extract and review explicit actions from meeting notes.";
  template.display.localized.en = { name: template.name, description: template.description };
  const skillRef = { skillId: skill.skillId, version: skill.version };
  template.inputForm = {
    fields: [{
      fieldId: testMode ? "text" : "transcript",
      label: testMode ? "Text" : "Meeting notes",
      description: testMode ? "The text to echo and review." : "The notes used to extract explicit follow-up actions.",
      schema: clone(stringSchema),
      required: true,
    }],
  };
  template.graph = testMode ? conformanceGraph(skillRef) : meetingActionGraph(skillRef);
  template.includedSkills = [skillRef];
  template.expectedOutputs = [{
    nodeId: "node-output",
    portId: "final",
    label: "Reviewed text",
    mediaType: "text/plain",
  }];
  template.reviewPolicy = { required: true, gateNodeIds: ["node-review"] };
  template.createdAt = now;
  template.updatedAt = now;

  let probe = { ready: false, status: "blocked", code: "runtime_binding_not_registered" };
  if (typeof agentRuntime?.probeSkill === "function") {
    probe = await agentRuntime.probeSkill(skill.executionRef);
  }
  const ready = probe?.ready === true || probe?.status === "ready";
  if (ready) {
    skill.status = "ready";
    skill.readiness = { status: "ready", diagnostics: [] };
    skill.setupChecks = [{ checkId: "runtime-probe", label: "Runtime probe", status: "passed", message: probe.code ?? "ready" }];
    template.availability = { status: "available", diagnostics: [] };
    await ensureBundledSkillVersion({ store, skill, now, testMode });
  } else {
    const diagnostic = blockedDiagnostic(probe?.code ?? "runtime_binding_not_registered");
    skill.status = "blocked";
    skill.readiness = { status: "blocked", diagnostics: [diagnostic] };
    skill.setupChecks = [{ checkId: "runtime-probe", label: "Runtime probe", status: "failed", message: probe?.code ?? "runtime_binding_not_registered" }];
    template.availability = { status: "blocked", diagnostics: [diagnostic] };
  }
  await store.repositories.skills.upsert(skill);
  if (!await store.repositories.templates.get(template.templateId, template.templateVersion)) {
    await store.repositories.templates.insert(template);
  }
  return { skill, template };
}
