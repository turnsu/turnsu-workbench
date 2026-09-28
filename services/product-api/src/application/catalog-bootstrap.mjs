import {
  skillDefinitionExample,
  workflowTemplateExample,
} from "../../../../packages/contracts/examples/canonical-examples.mjs";
import {
  Check,
  ProductObjectSchema,
  SkillSchema,
  SkillVersionSchema,
} from "@turnsu/workbench-contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
  WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_SKILL_ID,
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
} from "../../../../packages/agent-runtime/public-api.mjs";
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
      ? "../../../../packages/agent-runtime/skills/workflow-conformance.md"
      : "../../../../packages/agent-runtime/skills/meeting-action-extractor.md",
    import.meta.url,
  ), "utf8");
  const inspection = inspectSkillPackage({ files: [{ path: "SKILL.md", content: source }] });
  if (inspection.status !== "passed") throw new Error("bundled_skill_package_invalid");
  return { source, inspection };
}

function contentHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requireLifecycleRepositories(store) {
  const { skillAssets, skillVersions, objects } = store.repositories || {};
  const methods = [
    [skillAssets, ["get", "insert", "patch"]],
    [skillVersions, ["get", "getBySkillRef", "insert"]],
    [objects, ["get", "getByWorkspaceContentHash", "insert"]],
  ];
  if (methods.some(([repository, required]) => (
    required.some((method) => typeof repository?.[method] !== "function")
  ))) {
    throw new Error("system_catalog_lifecycle_repositories_unavailable");
  }
  return { skillAssets, skillVersions, objects };
}

async function ensureBundledSkillVersion({ store, skill, now, testMode }) {
  const { skillAssets, skillVersions, objects } = requireLifecycleRepositories(store);
  const workspaceId = skill.workspaceId || "workspace-local";
  const version = skill.version;
  const expectedSkillVersionId = `skill-version-system-${skill.skillId}-${version}`;
  const asset = await skillAssets.get(skill.skillId);
  const assetContract = asset ? { ...asset } : null;
  if (assetContract) delete assetContract.nameNormalized;
  if (asset && (asset.ownerId !== "system-catalog" || asset.workspaceId !== workspaceId)) {
    throw new Error("system_catalog_skill_owner_conflict");
  }
  const exactAssetIdentity = asset
    && asset.schemaVersion === "workbench-v1"
    && asset.skillId === skill.skillId
    && asset.workspaceId === workspaceId
    && asset.ownerId === "system-catalog"
    && asset.currentDraftId === null
    && asset.latestPublishedVersionId === expectedSkillVersionId
    && asset.retirement === undefined;
  const currentPublishedAsset = exactAssetIdentity
    && asset.lifecycle === "published"
    && asset.visibility === "workspace"
    && Check(SkillSchema, assetContract);
  const legacyReadyAsset = exactAssetIdentity
    && asset.lifecycle === "ready"
    && asset.visibility === "private"
    && Check(SkillSchema, { ...assetContract, lifecycle: "published" });
  if (asset && !currentPublishedAsset && !legacyReadyAsset) {
    throw new Error("system_catalog_skill_asset_conflict");
  }
  const patch = {
    latestPublishedVersionId: expectedSkillVersionId,
    lifecycle: "published",
    visibility: "workspace",
    updatedAt: now,
  };
  const assetCandidate = asset
    ? { ...assetContract, ...patch }
    : {
        schemaVersion: "workbench-v1",
        skillId: skill.skillId,
        workspaceId,
        ownerId: "system-catalog",
        visibility: "workspace",
        lifecycle: "published",
        currentDraftId: null,
        latestPublishedVersionId: expectedSkillVersionId,
        createdAt: now,
        updatedAt: now,
      };
  if (!Check(SkillSchema, assetCandidate)) {
    throw new Error("system_catalog_skill_asset_conflict");
  }
  const { source, inspection } = bundledPackage(testMode);
  const objectId = `object-system-${skill.skillId}-${inspection.contentHash.slice("sha256:".length, 28)}`;
  const expectedObject = {
    schemaVersion: "workbench-v1",
    objectId,
    workspaceId,
    contentHash: inspection.contentHash,
    mediaType: "application/vnd.looloomi.skill-package+json",
    sizeBytes: Buffer.byteLength(source, "utf8"),
  };
  const expectedVersion = {
    skillVersionId: expectedSkillVersionId,
    workspaceId,
    skillId: skill.skillId,
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
    inputSchema: skill.inputSchema,
    outputSchema: skill.outputSchema,
    risk: skill.risk,
    dependencies: skill.dependencies,
    connectionRequirements: [],
    executionRef: skill.executionRef,
  };
  const [versionById, versionByRef] = await Promise.all([
    skillVersions.get(expectedVersion.skillVersionId),
    skillVersions.getBySkillRef(skill.skillId, version, { workspaceId }),
  ]);
  if (
    Boolean(versionById) !== Boolean(versionByRef)
    || (versionById && !isDeepStrictEqual(versionById, versionByRef))
  ) {
    throw new Error("system_catalog_skill_version_conflict");
  }
  let publishedVersion = versionByRef;
  if (publishedVersion) {
    const exactFields = Object.entries(expectedVersion).every(([field, expected]) => (
      isDeepStrictEqual(publishedVersion[field], expected)
    ));
    if (
      !Check(SkillVersionSchema, publishedVersion)
      || publishedVersion.validation.status !== "passed"
      || publishedVersion.publishedBy !== "system-catalog"
      || !exactFields
    ) {
      throw new Error("system_catalog_skill_version_conflict");
    }
  }
  const [objectById, objectByTuple] = await Promise.all([
    objects.get(objectId),
    objects.getByWorkspaceContentHash(workspaceId, inspection.contentHash),
  ]);
  if (
    Boolean(objectById) !== Boolean(objectByTuple)
    || (objectById && !isDeepStrictEqual(objectById, objectByTuple))
  ) {
    throw new Error("system_catalog_skill_object_conflict");
  }
  const packageObject = objectById;
  if (packageObject) {
    const exactObjectFields = Object.entries(expectedObject).every(([field, expected]) => (
      isDeepStrictEqual(packageObject[field], expected)
    ));
    if (!Check(ProductObjectSchema, packageObject) || !exactObjectFields) {
      throw new Error("system_catalog_skill_object_conflict");
    }
  } else if (publishedVersion) {
    throw new Error("system_catalog_skill_object_conflict");
  }
  if (!publishedVersion) {
    if (!packageObject) {
      await objects.insert({
        ...expectedObject,
        createdAt: now,
      });
    }
    publishedVersion = await skillVersions.insert({
      schemaVersion: "workbench-v1",
      skillVersionId: expectedVersion.skillVersionId,
      skillId: skill.skillId,
      workspaceId,
      version,
      packageObjectId: objectId,
      packageHash: inspection.contentHash,
      contentHash: expectedVersion.contentHash,
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
  }
  if (asset) await skillAssets.patch(skill.skillId, patch, { workspaceId });
  else await skillAssets.insert(assetCandidate);
  return publishedVersion;
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
  requireLifecycleRepositories(store);
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
    skill.readiness = { status: "ready", diagnostics: [] };
    skill.setupChecks = [{ checkId: "runtime-probe", label: "Runtime probe", status: "passed", message: probe.code ?? "ready" }];
    template.availability = { status: "available", diagnostics: [] };
    await ensureBundledSkillVersion({ store, skill, now, testMode });
  } else {
    const diagnostic = blockedDiagnostic(probe?.code ?? "runtime_binding_not_registered");
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
