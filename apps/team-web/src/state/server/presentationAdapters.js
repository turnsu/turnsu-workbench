const titleCase = (value) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";

export function isCurrentPublishedSkill(skill) {
  return skill?.canonical?.skill?.lifecycle === "published"
    && Boolean(skill?.canonical?.version);
}

export function latestTeamReleaseIds(releases = []) {
  const latestByAsset = new Map();
  for (const release of releases) {
    const key = `${release.assetKind}:${release.assetId}`;
    const current = latestByAsset.get(key);
    const candidateOrder = `${release.publishedAt || ""}:${release.releaseId || ""}`;
    const currentOrder = current ? `${current.publishedAt || ""}:${current.releaseId || ""}` : "";
    if (!current || candidateOrder > currentOrder) latestByAsset.set(key, release);
  }
  return new Map([...latestByAsset].map(([key, release]) => [key, release.releaseId]));
}

function schemaFields(schema) {
  if (schema?.type !== "object") return [];
  return Object.keys(schema.properties || {});
}

function readiness(status) {
  return status === "ready" || status === "available" ? "Ready" : "Needs source";
}

function nodeType(kind) {
  return {
    Input: "Input",
    Skill: "Skill",
    Material: "Knowledge",
    Transform: "Transform",
    ReviewGate: "Review Gate",
    Output: "Output",
  }[kind] || kind;
}

export function workflowNodeToCanvasNode(node) {
  return {
    id: node.nodeId,
    type: nodeType(node.kind),
    title: node.title,
    subtitle: node.description,
    purpose: node.description,
    inputs: node.inputPorts.map((port) => port.name || port.portId),
    outputs: node.outputPorts.map((port) => port.name || port.portId),
    reviewPolicy: node.reviewPolicy?.instructions || "",
    reviewPolicyMode: node.reviewPolicy?.mode || "none",
    position: { ...node.position },
    ...(node.skillRef ? { skillId: node.skillRef.skillId, skillVersion: node.skillRef.version } : {}),
    canonical: node,
  };
}

export function workflowEdgeToCanvasEdge(edge) {
  return {
    id: edge.edgeId,
    from: edge.sourceNodeId,
    to: edge.targetNodeId,
    sourcePort: edge.sourcePort,
    targetPort: edge.targetPort,
    canonical: edge,
  };
}

export function workflowRevisionToCanvas(revision) {
  return {
    nodes: (revision?.graph?.nodes || []).map(workflowNodeToCanvasNode),
    edges: (revision?.graph?.edges || []).map(workflowEdgeToCanvasEdge),
  };
}

function revisionDetails(revision) {
  const canvas = workflowRevisionToCanvas(revision);
  return {
    workflow: canvas,
    requiredInputs: (revision?.inputForm?.fields || []).map((field) => field.label || field.fieldId),
    requiredKnowledge: (revision?.resourceRefs || []).map((resource) => resource.label),
    review: revision?.graph?.nodes?.some((node) => node.kind === "ReviewGate") ? "Review before publishing" : "No manual review",
    outputShape: (revision?.outputDefinition?.expectedOutputs || []).map((output) => output.label).join(", "),
  };
}

export function skillDefinitionToView(skill) {
  const execution = skill.execution || {};
  return {
    id: skill.skillId,
    version: skill.version,
    kind: "SkillPackage",
    source: "Installed",
    title: skill.name,
    description: skill.description,
    setupState: readiness(skill.readiness?.status),
    risk: titleCase(skill.risk?.level || "low"),
    inputs: schemaFields(skill.inputSchema),
    outputs: schemaFields(skill.outputSchema),
    dependencies: (skill.dependencies || []).map((dependency) => dependency.id),
    usedBy: [],
    bestFor: [skill.category].filter(Boolean),
    scenarios: [skill.category].filter(Boolean),
    actionBoundary: skill.risk?.externalAction ? skill.risk.summary : "No external action",
    externalAction: skill.risk?.externalAction ? skill.risk.summary : "No external action",
    evidence: skill.risk?.summary || "No additional setup information.",
    usageCount: skill.usageCount || 0,
    readinessDiagnostics: skill.readiness?.diagnostics || [],
    executionMode: execution.executionMode || "deterministic",
    requiredModelCapability: execution.requiredModelCapability || null,
    canonical: skill,
  };
}

export function skillAssetSummaryToView(summary) {
  const skill = summary?.skill;
  const sourceDraft = summary?.draft;
  const draft = ["draft", "validating", "tested"].includes(skill?.lifecycle) ? sourceDraft : null;
  const version = summary?.latestVersion;
  // A current personal branch is the asset being edited/tested even when an
  // older immutable published version remains available for existing pins.
  const definition = draft || version;
  const execution = definition?.execution || {};
  if (!skill || !definition) return null;
  const retired = ["deprecated", "archived"].includes(skill.lifecycle);
  const ready = Boolean(version && skill.lifecycle === "published");
  return {
    id: skill.skillId,
    version: draft ? null : (version?.version || null),
    kind: "SkillAsset",
    source: "Workspace",
    title: definition.name,
    description: definition.description,
    setupState: retired ? "Retired" : (ready ? "Ready" : "Needs source"),
    risk: titleCase(definition.risk?.level || "low"),
    inputs: schemaFields(definition.inputSchema),
    outputs: schemaFields(definition.outputSchema),
    dependencies: (definition.dependencies || []).map((dependency) => dependency.id),
    usedBy: [],
    bestFor: [definition.category].filter(Boolean),
    scenarios: [definition.category].filter(Boolean),
    actionBoundary: definition.risk?.externalAction ? definition.risk.summary : "No external action",
    externalAction: definition.risk?.externalAction ? definition.risk.summary : "No external action",
    evidence: !draft && version?.validation?.status === "passed"
      ? "This published version passed its readiness check."
      : "Finish preparing this Skill before using it in a workflow.",
    usageCount: 0,
    readinessDiagnostics: draft ? [] : (version?.validation?.diagnostics || []),
    executionMode: execution.executionMode || "deterministic",
    requiredModelCapability: execution.requiredModelCapability || null,
    canAddToWorkflow: ready,
    canEdit: skill.allowedActions?.includes("edit") === true,
    canPublish: skill.allowedActions?.includes("publish") === true,
    canCreateUpdate: skill.allowedActions?.includes("create_version") === true,
    canRetire: skill.allowedActions?.includes("retire") === true,
    retired,
    canonical: { skill, draft, sourceDraft, version },
  };
}

export function publishedSkillAssetToDefinition(summary) {
  const version = summary?.latestVersion;
  if (!version?.skillId || !version.version) return null;
  return {
    schemaVersion: version.schemaVersion,
    skillId: version.skillId,
    version: version.version,
    name: version.name,
    description: version.description,
    category: version.category,
    inputSchema: structuredClone(version.inputSchema),
    outputSchema: structuredClone(version.outputSchema),
    risk: structuredClone(version.risk),
    dependencies: structuredClone(version.dependencies),
  };
}

export function workflowTemplateToView(template) {
  const revision = {
    graph: template.graph,
    inputForm: template.inputForm,
    outputDefinition: { expectedOutputs: template.expectedOutputs },
    resourceRefs: [],
  };
  return {
    id: template.templateId,
    templateVersion: template.templateVersion,
    type: "LoopTemplate",
    source: "Preset Templates",
    title: template.name,
    description: template.description,
    domain: template.category,
    owner: "Workspace",
    readiness: readiness(template.availability?.status),
    ...revisionDetails(revision),
    review: template.reviewPolicy?.required ? "Review before publishing" : "No manual review",
    canonical: template,
  };
}

export function workflowToView(workflow, revision = null) {
  const details = revisionDetails(revision);
  return {
    id: workflow.workflowId,
    type: "LoopWorkflow",
    source: "Owned Workflows",
    title: workflow.name,
    description: workflow.description,
    domain: workflow.sourceTemplate?.templateId || "Workflow",
    owner: "You",
    readiness: readiness(workflow.status),
    currentRevisionId: workflow.currentRevisionId,
    sourceTemplate: workflow.sourceTemplate,
    latestCompile: workflow.latestCompile,
    latestRun: workflow.latestRun,
    ...details,
    canonical: workflow,
    canonicalRevision: revision,
  };
}

export function runToView(run, readModel = null) {
  return {
    id: run.runId,
    loopId: run.workflowId,
    workflowRevisionId: run.workflowRevisionId,
    status: run.status,
    startedAt: run.startedAt || run.queuedAt,
    reviewState: run.status === "waiting_review" ? "Needs follow-up" : run.status,
    nodeTimeline: readModel?.nodeTimeline || run.nodeRuns || [],
    finalAnswer: readModel?.finalAnswer || null,
    evidenceGaps: readModel?.evidenceGaps || [],
    reviewPacket: readModel?.reviewPacket || null,
    reviewDecisions: readModel?.reviewDecisions || run.reviewDecisions || [],
    failure: readModel?.failure || null,
    recoveryActions: readModel?.recoveryActions || [],
    canonical: run,
    readModel,
  };
}
