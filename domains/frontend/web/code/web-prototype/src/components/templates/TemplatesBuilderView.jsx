import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Download,
  GripVertical,
  MessageSquare,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button, SegmentedControl, TextArea, TextInput } from "../../design-system/index.jsx";
import { LoopCanvas } from "../canvas/LoopCanvas.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { productNodePurpose, productNodeTitle, productTitle } from "../../utils/productCopy.js";
import { ModelPicker } from "../models/ModelPicker.jsx";
import { NodeModelOverride, WorkflowModelSettings } from "../models/WorkflowModelSettings.jsx";
import { defaultModelSelection, useModelCatalog } from "../../state/models/index.js";

function listValue(value = []) {
  return Array.isArray(value) ? value.join(", ") : value;
}

function firstValue(value = []) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function flowLabel(inputs = [], outputs = [], t) {
  return t("builder.resourceFlow", {
    input: firstValue(inputs) || "-",
    output: firstValue(outputs) || "-",
  });
}

function draftVersionLabel(loop, t) {
  const candidates = [
    loop?.canonicalRevision?.version,
    loop?.templateVersion,
    loop?.version,
  ];
  const semantic = candidates
    .map((value) => String(value || "").trim().replace(/^v/i, ""))
    .find((value) => /^\d+\.\d+(?:\.\d+)?$/.test(value));
  return semantic ? t("builder.draftVersion", { version: semantic }) : t("builder.draftLabel");
}

function runModeLabel(value, t) {
  if (value === "Manual run") return t("runMode.manual");
  return value;
}

function splitList(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeDragResource(resource) {
  return JSON.stringify(resource);
}

function readDragResource(event) {
  const raw = event.dataTransfer?.getData("application/x-loopops-resource");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hasLoopResource(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes("application/x-loopops-resource") || types.includes("text/plain");
}

function nodeTypeLabel(type, t) {
  const key = String(type || "").toLowerCase().replace(/\s+/g, "-");
  return t(`nodeType.${key}`);
}

function loopTypeLabel(loop, t) {
  if (loop?.type === "LoopTemplate") return t("object.loopTemplate");
  if (loop?.type === "LoopWorkflow") return t("object.loopWorkflow");
  return loop?.type || "";
}

function loopSourceLabel(loop, t) {
  if (loop?.source === "Preset Templates") return t("object.presetTemplates");
  if (loop?.source === "Owned Workflows") return t("object.ownedWorkflows");
  return loop?.source || "";
}

function readinessLabel(value, t) {
  if (value === "Ready") return t("status.ready");
  if (value === "Needs source") return t("status.needsSource");
  return value;
}

function proposalOperationLabel(operation, t) {
  const key = `builder.proposalOperation.${operation?.op || "unknown"}`;
  const label = t(key);
  return label === key ? t("builder.proposalOperation.unknown") : label;
}

const builderTabs = [
  { value: "definition", labelKey: "builder.definitionTab" },
  { value: "outline", labelKey: "builder.outlineTab" },
  { value: "canvas", labelKey: "builder.canvasTab" },
];

const paletteModes = [
  { value: "skills", labelKey: "builder.paletteSkills", groupId: "palette-skills" },
  { value: "inputs", labelKey: "builder.paletteInputs", groupId: "palette-inputs" },
  { value: "materials", labelKey: "builder.paletteMaterials", groupId: "palette-materials" },
  { value: "gates", labelKey: "builder.paletteGates", groupId: "palette-controls" },
  { value: "outputs", labelKey: "builder.paletteOutputs", groupId: "palette-outputs" },
];

export function TemplatesBuilderView({ workspace }) {
  const [builderTab, setBuilderTab] = useState(workspace.builderInitialTab || "canvas");
  const [resourceMode, setResourceMode] = useState("skills");
  const [resourceQuery, setResourceQuery] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(() => (
    typeof window === "undefined" || !window.matchMedia("(max-width: 820px)").matches
  ));
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [dropMessage, setDropMessage] = useState("");
  const [resourcePreview, setResourcePreview] = useState(null);
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false);
  const [confirmConflictReload, setConfirmConflictReload] = useState(false);
  const [builderModelRevisionId, setBuilderModelRevisionId] = useState("");
  const builderModels = useModelCatalog({
    capabilities: ["chat", "tool_calling", "structured_output"],
    context: "builder",
    selectedRevisionId: builderModelRevisionId,
  });
  const builderModelReady = builderModels.options.some((option) => option.value === builderModelRevisionId && !option.disabled);
  const loop = workspace.selectedLoop;
  const t = workspace.t;
  const nodes = loop?.workflow?.nodes || [];
  const displayNodes = nodes.map((node) => ({
    ...node,
    title: productNodeTitle(node, workspace.locale),
    subtitle: productNodePurpose(node, workspace.locale),
  }));
  const edges = loop?.workflow?.edges || [];
  const selectedNode = workspace.selectedNode;
  const selectedSkill = selectedNode?.type === "Skill"
    ? [...workspace.skills, ...workspace.managedSkills].find((skill) => skill.id === selectedNode.skillId)
    : null;
  const selectedSkillExecution = selectedSkill?.canonical?.execution
    || selectedSkill?.canonical?.executionRef
    || selectedSkill?.canonical?.definition?.execution
    || selectedSkill?.canonical?.definition?.executionRef
    || selectedSkill?.canonical?.version?.execution
    || selectedSkill?.canonical?.version?.executionRef
    || selectedSkill?.canonical?.draft?.execution
    || selectedSkill?.canonical?.draft?.executionRef;
  const selectedNodeModelCapability = selectedSkill?.requiredModelCapability
    || selectedSkillExecution?.requiredModelCapability
    || selectedSkillExecution?.requiredCapability
    || selectedSkillExecution?.capability
    || selectedNode?.canonical?.configuration?.requiredModelCapability
    || "chat";
  const selectedNodeIsModelBacked = selectedNode?.type === "Skill" && (
    selectedSkill?.executionMode === "model"
    || selectedSkillExecution?.executionMode === "model"
    || selectedSkillExecution?.mode === "model"
    || Boolean(selectedNode?.canonical?.configuration?.modelProfileId)
  );
  const selectedNodeIndex = selectedNode ? nodes.findIndex((node) => node.id === selectedNode.id) : -1;
  const revisionTargetOptions = nodes
    .filter((node) => node.type === "Skill")
    .flatMap((node) => (node.canonical?.inputPorts || []).map((port) => ({
      value: `${node.id}::${port.portId}`,
      label: `${node.title} - ${port.name || port.portId}`,
    })));
  const preview = workspace.compilePreview;
  const isDirty = Boolean(loop?.dirty || workspace.dirtyLoopIds.includes(loop?.id));
  const isTemplate = loop?.type === "LoopTemplate";
  const canRunSelected = loop?.type === "LoopWorkflow" && workspace.canRunWorkflow;
  const runBlockedReason = isTemplate
    ? t("builder.cloneBeforeRun")
    : isDirty ? t("error.save_before_compile") : t("builder.resolveSetupBeforeRun");
  const runRecoveryLabel = isTemplate
    ? t("actions.cloneTemplate")
    : isDirty ? t("actions.saveCurrentWorkflow") : t("builder.openNodeEditor");
  const isClonedWorkflow = loop?.type === "LoopWorkflow" && loop?.clonedFromTitle;
  const resourceNeedle = resourceQuery.trim().toLowerCase();
  const activePaletteMode = paletteModes.find((mode) => mode.value === resourceMode) || paletteModes[0];
  const activePaletteGroup = workspace.resourcePalette.find((group) => group.id === activePaletteMode.groupId);
  const availableSkills = useMemo(() => {
    const byId = new Map(workspace.skills.map((skill) => [
      skill.id,
      { ...skill, paletteSource: "catalog" },
    ]));
    workspace.managedSkills
      .filter((skill) => skill.canAddToWorkflow)
      .forEach((skill) => byId.set(skill.id, { ...skill, paletteSource: "workspace" }));
    return [...byId.values()];
  }, [workspace.skills, workspace.managedSkills]);
  const visibleSkills = useMemo(
    () =>
      availableSkills.filter((skill) =>
        `${skill.title} ${skill.description} ${skill.inputs.join(" ")} ${skill.outputs.join(" ")}`.toLowerCase().includes(resourceNeedle),
      ),
    [availableSkills, resourceNeedle],
  );
  const visiblePaletteItems = useMemo(
    () =>
      (activePaletteGroup?.items || []).filter((item) => item.toLowerCase().includes(resourceNeedle)),
    [activePaletteGroup, resourceNeedle],
  );
  const visibleMaterials = useMemo(
    () => workspace.resources.filter((resource) => `${resource.label} ${resource.mediaType}`.toLowerCase().includes(resourceNeedle)),
    [workspace.resources, resourceNeedle],
  );
  const paletteModeStats = useMemo(
    () =>
      paletteModes.map((mode) => {
        const group = workspace.resourcePalette.find((item) => item.id === mode.groupId);
        const count =
          mode.value === "skills"
            ? visibleSkills.length
            : mode.value === "materials"
              ? visibleMaterials.length
            : (group?.items || []).filter((item) => item.toLowerCase().includes(resourceNeedle)).length;
        return { ...mode, count };
      }),
    [resourceNeedle, visibleSkills.length, visibleMaterials.length, workspace.resourcePalette],
  );

  useEffect(() => {
    if (!builderModelRevisionId && builderModels.profiles.length) {
      setBuilderModelRevisionId(defaultModelSelection(builderModels.profiles, "structured_output", "revision"));
    }
  }, [builderModelRevisionId, builderModels.profiles]);

  function handleDragStart(event, payload) {
    setDropMessage("");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-loopops-resource", serializeDragResource(payload));
    event.dataTransfer.setData("text/plain", payload.title || "Workflow resource");
  }

  function handleDropResource(payload, position) {
    setDropMessage("");
    if (payload.kind === "workspace-skill") workspace.addManagedSkillToLoop(payload.skillId, workspace.selectedLoopId, position);
    else if (payload.kind === "skill") workspace.addSkillToLoop(payload.skillId, workspace.selectedLoopId, position);
    else if (payload.kind === "material") workspace.addResourceToLoop(payload.resourceId, position);
    else workspace.addPaletteItemToLoop(payload, position);
  }

  function addPaletteResource(item) {
    setDropMessage("");
    workspace.addPaletteItemToLoop({ kind: "palette", groupId: activePaletteGroup?.id, title: item });
  }

  function showSkillPreview(skill) {
    if (skill.paletteSource === "workspace") workspace.setSelectedManagedSkillId(skill.id);
    else workspace.setSelectedSkillId(skill.id);
    setResourcePreview({
      title: skill.title,
      kind: t("nodeType.skill"),
      description: skill.description,
      contract: flowLabel(skill.inputs, skill.outputs, t),
    });
  }

  function showPalettePreview(item) {
    setResourcePreview({
      title: item,
      kind: t(activePaletteMode.labelKey),
      description: t("builder.palettePreviewCopy"),
      contract: t("builder.dragIntoCanvas"),
    });
  }

  function recoverRunBlock() {
    if (isTemplate) workspace.cloneLoop(loop.id);
    else if (isDirty) workspace.saveWorkspace();
    else setInspectorOpen(true);
  }

  function handleSurfaceDragOver(event) {
    if (!hasLoopResource(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleSurfaceDrop(event) {
    const payload = readDragResource(event);
    if (!payload) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-testid='loopops.builder.canvas']")) return;
    event.preventDefault();
    setDropMessage(t("builder.dropOnCanvasOnly"));
  }

  function runSelectedLoop() {
    if (!canRunSelected) return;
    workspace.prepareRun(loop.id);
  }

  return (
    <div
      className={`surface builderSurface cozeBuilder ${inspectorOpen ? "inspectorOpen" : "inspectorCollapsed"} ${builderTab === "canvas" ? "mobileCanvasMode" : ""} ${mobilePaletteOpen ? "mobilePaletteOpen" : ""}`}
      data-testid="loopops.templates.surface"
      onDragOver={handleSurfaceDragOver}
      onDrop={handleSurfaceDrop}
    >
      {loop ? (
        <header className="builderPageHeader">
          <div className="builderPageIdentity">
            <div className="builderBreadcrumb"><button type="button" onClick={() => workspace.setActivePage("loops")}>{t("nav.loops")}</button><span>/</span><button type="button" onClick={() => workspace.openLoop(loop.id)}>{productTitle(loop, workspace.locale)}</button><span>/</span><span>{t("actions.edit")}</span></div>
            <div className="builderTitleLine"><h1>{productTitle(loop, workspace.locale)}</h1><span>{draftVersionLabel(loop, t)}</span></div>
            <p>{isDirty ? t("state.currentWorkflowUnsaved") : t("builder.savedJustNow")} <i aria-hidden="true" /> {readinessLabel(loop.readiness, t)}</p>
          </div>
          <div className="builderPageActions">
            <Button variant="secondary" icon={<Sparkles size={15} />} onClick={() => setAssistantOpen(true)} data-testid="loopops.builder.assistant.open">{t("builder.proposeChange")}</Button>
            <span className="builderActionDivider" />
            <Button variant="secondary" icon={<Save size={15} />} disabled={!workspace.canSaveWorkflow} onClick={workspace.saveWorkspace} data-testid="loopops.topbar.primary.save-workflow">{t("actions.saveDraft")}</Button>
            <Button variant="secondary" icon={<Play size={15} />} disabled={!canRunSelected} onClick={runSelectedLoop}>{t("actions.testLoop")}</Button>
            <Button variant="secondary" disabled={isTemplate || isDirty} onClick={() => workspace.openPublishReview(loop.id)} data-testid="loopops.builder.publish">{t("actions.publish")}</Button>
          </div>
        </header>
      ) : null}

      <aside className="resourcePanel" data-testid="loopops.builder.palette">
        <div className="panelHeader">
          <div>
            <h2>{t("builder.resources")}</h2>
            <p>{t("builder.resourcesCaption")}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mobilePaletteClose"
            icon={<X size={16} />}
            onClick={() => setMobilePaletteOpen(false)}
            data-testid="loopops.builder.mobile-library.close"
          >
            {t("builder.closeLibrary")}
          </Button>
        </div>

        <div className="skillLibrary">
          <div className="libraryHeader">
            <span>{t("builder.libraryHint")}</span>
            <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={workspace.openCreateResourceDialog} data-testid="loopops.builder.material.create">{t("actions.newSource")}</Button>
          </div>
          <TextInput
            label={t("builder.searchLabel")}
            value={resourceQuery}
            onChange={setResourceQuery}
            placeholder={t("builder.search")}
            width="100%"
            data-testid="loopops.builder.palette.search"
          />
          <div className="resourceTypeList" role="tablist" aria-label={t("builder.resourceType")} data-testid="loopops.builder.palette.categories">
            {paletteModeStats.map((item) => (
              <button
                type="button"
                role="tab"
                key={item.value}
                className={`resourceTypeButton ${resourceMode === item.value ? "active" : ""}`}
                aria-selected={resourceMode === item.value}
                onClick={() => setResourceMode(item.value)}
                data-testid={`loopops.builder.palette.filter.${item.value}`}
              >
                <span>{t(item.labelKey)}</span>
                <small>{t("builder.itemCount", { count: item.count })}</small>
              </button>
            ))}
          </div>

          {resourcePreview ? (
            <section className="palettePreview" data-testid="loopops.builder.palette.preview">
              <div>
                <span>{resourcePreview.kind}</span>
                <strong>{resourcePreview.title}</strong>
              </div>
              <p>{resourcePreview.description}</p>
              <small>{resourcePreview.contract}</small>
            </section>
          ) : null}

          <div className="libraryList">
            {resourceMode === "skills"
              ? visibleSkills.map((skill) => (
                  <div
                    className="libraryRow draggableItem"
                    draggable
                    key={skill.id}
                    title={`${skill.title}: ${skill.description}`}
                    onDragStart={(event) => handleDragStart(event, { kind: skill.paletteSource === "workspace" ? "workspace-skill" : "skill", skillId: skill.id, title: skill.title })}
                    data-testid={`loopops.builder.palette.skill.${skill.id}`}
                  >
                    <span className="libraryDragHandle" aria-hidden="true"><GripVertical size={14} /></span>
                    <span className={`riskDot risk-${skill.risk.toLowerCase()}`} aria-hidden="true" />
                    <button type="button" className="librarySelect" onClick={() => showSkillPreview(skill)} title={`${skill.title}: ${flowLabel(skill.inputs, skill.outputs, t)}`}>
                      <span>
                        <strong>{skill.title}</strong>
                        <small>{flowLabel(skill.inputs, skill.outputs, t)}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="libraryAddButton"
                      onClick={() => {
                        if (skill.paletteSource === "workspace") workspace.addManagedSkillToLoop(skill.id);
                        else workspace.addSkillToLoop(skill.id);
                        setMobilePaletteOpen(false);
                      }}
                      aria-label={`${t("actions.addToWorkflow")}: ${skill.title}`}
                      data-testid={`loopops.builder.palette.skill.${skill.id}.add`}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                ))
              : resourceMode === "materials"
                ? visibleMaterials.map((resource) => (
                  <div className="libraryRow draggableItem" draggable key={resource.resourceId} title={resource.label} onDragStart={(event) => handleDragStart(event, { kind: "material", resourceId: resource.resourceId, title: resource.label })} data-testid={`loopops.builder.palette.material.${resource.resourceId}`}>
                    <span className="libraryDragHandle" aria-hidden="true"><GripVertical size={14} /></span>
                    <span className="resourceTypeMark" aria-hidden="true">{resource.label.slice(0, 2)}</span>
                    <button type="button" className="librarySelect" onClick={() => setResourcePreview({ title: resource.label, kind: t("builder.paletteMaterials"), description: t("builder.materialReady"), contract: resource.mediaType })} title={resource.label}><span><strong>{resource.label}</strong><small>{resource.mediaType}</small></span></button>
                    <button type="button" className="libraryAddButton" onClick={() => { workspace.addResourceToLoop(resource.resourceId); setMobilePaletteOpen(false); }} aria-label={`${t("actions.addToWorkflow")}: ${resource.label}`} data-testid={`loopops.builder.palette.material.${resource.resourceId}.add`}><Plus size={14} /></button>
                  </div>
                ))
                : visiblePaletteItems.map((item) => (
                  <div
                    className="libraryRow draggableItem"
                    draggable
                    key={item}
                    title={item}
                    onDragStart={(event) => handleDragStart(event, { kind: "palette", groupId: activePaletteGroup.id, title: item })}
                    data-testid={`loopops.builder.palette.${activePaletteGroup.id}.${item.toLowerCase().replaceAll(" ", "-")}`}
                  >
                    <span className="libraryDragHandle" aria-hidden="true"><GripVertical size={14} /></span>
                    <span className="resourceTypeMark" aria-hidden="true">{item.slice(0, 2)}</span>
                    <button type="button" className="librarySelect" onClick={() => showPalettePreview(item)} title={item}>
                      <span>
                        <strong>{item}</strong>
                        <small>{t("builder.dragIntoCanvas")}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="libraryAddButton"
                      onClick={() => { addPaletteResource(item); setMobilePaletteOpen(false); }}
                      aria-label={`${t("actions.addToWorkflow")}: ${item}`}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                ))}
            {resourceMode === "skills" && !visibleSkills.length ? <p className="muted">{t("builder.noResources")}</p> : null}
            {resourceMode === "materials" && !visibleMaterials.length ? <p className="muted">{t("builder.noMaterials")}</p> : null}
            {resourceMode !== "skills" && resourceMode !== "materials" && !visiblePaletteItems.length ? <p className="muted">{t("builder.noResources")}</p> : null}
          </div>
        </div>
      </aside>

      <section className="workflowBoard" data-testid="loopops.templates.contract-page">
        {loop ? (
          <>
            <header className="workflowTopbar legacyWorkflowTopbar">
              <div>
                <div className="objectKicker">{loopTypeLabel(loop, t)} · {loopSourceLabel(loop, t)}</div>
                <h2>{loop.title}</h2>
                <p>{loop.description}</p>
              </div>
              <div className="workflowActions">
                <StatusPill>{readinessLabel(loop.readiness, t)}</StatusPill>
                <StatusPill tone={isDirty ? "warning" : "success"}>
                  {isDirty ? t("state.unsaved") : t("state.savedShort")}
                </StatusPill>
                {isTemplate ? (
                  <Button variant="primary" onClick={() => workspace.cloneLoop(loop.id)}>
                    {t("actions.cloneTemplate")}
                  </Button>
                ) : <div className="buttonRow"><Button variant="secondary" disabled={isDirty} onClick={workspace.duplicateSelectedWorkflow} title={isDirty ? t("builder.copySavedVersion") : undefined} data-testid="loopops.builder.duplicate">{t("actions.duplicate")}</Button><Button variant="secondary" icon={<Play size={15} />} disabled={!canRunSelected} onClick={runSelectedLoop}>{t("actions.runMock")}</Button><Button variant="secondary" disabled={isDirty} onClick={() => workspace.openPublishReview(loop.id)} data-testid="loopops.builder.publish">{t("actions.publish")}</Button></div>}
              </div>
            </header>

            {workspace.editorState?.conflict ? (
              <section className="workflowConflictRecovery" role="alert" data-testid="loopops.builder.revision-conflict">
                <div>
                  <strong>{t(confirmConflictReload ? "builder.conflictConfirmTitle" : "builder.conflictTitle")}</strong>
                  <p>{t(confirmConflictReload ? "builder.conflictConfirmBody" : "builder.conflictBody")}</p>
                </div>
                <div className="buttonRow">
                  {confirmConflictReload ? (
                    <Button variant="secondary" size="sm" onClick={() => setConfirmConflictReload(false)}>
                      {t("actions.keepEditing")}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Download size={14} />}
                      onClick={workspace.downloadUnsavedWorkflowDraft}
                      data-testid="loopops.builder.revision-conflict.download"
                    >
                      {t("actions.downloadMyChanges")}
                    </Button>
                  )}
                  <Button
                    variant={confirmConflictReload ? "destructive" : "secondary"}
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={confirmConflictReload ? workspace.reloadLatestWorkflow : () => setConfirmConflictReload(true)}
                    data-testid="loopops.builder.revision-conflict.reload"
                  >
                    {t(confirmConflictReload ? "actions.discardAndLoadLatest" : "actions.reviewLatestVersion")}
                  </Button>
                </div>
              </section>
            ) : null}

            {isClonedWorkflow ? (
              <section className="cloneModeBanner" data-testid="loopops.builder.clone-mode">
                <div>
                  <strong>{t("builder.cloneModeTitle", { title: loop.clonedFromTitle })}</strong>
                  <p>{t("builder.cloneModeCopy")}</p>
                </div>
                <div className="buttonRow">
                  {loop.clonedFromTemplateId ? (
                    <Button variant="secondary" size="sm" onClick={() => workspace.selectLoop(loop.clonedFromTemplateId)} data-testid="loopops.builder.clone-mode.return-template">
                      {t("actions.returnTemplate")}
                    </Button>
                  ) : null}
                  <Button variant="secondary" size="sm" onClick={() => workspace.openLoop(loop.id)} data-testid="loopops.builder.clone-mode.open-workflow">
                    {t("actions.openInWorkflows")}
                  </Button>
                </div>
              </section>
            ) : null}

            <div className="canvasToolbar">
              <Button
                variant="secondary"
                size="sm"
                className="mobilePaletteToggle"
                icon={<PanelLeftOpen size={15} />}
                onClick={() => setMobilePaletteOpen(true)}
                aria-expanded={mobilePaletteOpen}
                data-testid="loopops.builder.mobile-library.open"
              >
                {t("builder.openLibrary")}
              </Button>
              <SegmentedControl
                label={t("builder.surfaceTabs")}
                value={builderTab}
                onChange={(value) => {
                  setBuilderTab(value);
                  if (value !== "canvas") setMobilePaletteOpen(false);
                }}
                options={builderTabs.map((item) => ({
                  value: item.value,
                  label: t(item.labelKey),
                  testId: `loopops.builder.tab.${item.value}`,
                }))}
              />
              <div className="toolbarGroup">
                <span>{t("builder.nodes", { count: nodes.length })}</span>
                <span>{t("builder.edges", { count: edges.length })}</span>
                {workspace.connectionStartNodeId ? <StatusPill tone="info">{t("builder.connecting")}</StatusPill> : null}
              </div>
            </div>

            <div className="selectedNodeBar" data-testid="loopops.builder.selected-node">
              {selectedNode ? (
                <>
                  <div className="selectedNodeCopy">
                    <StatusPill tone="info">{nodeTypeLabel(selectedNode.type, t)}</StatusPill>
                    <strong>{productNodeTitle(selectedNode, workspace.locale)}</strong>
                    <span>{flowLabel(selectedNode.inputs, selectedNode.outputs, t)}</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => isTemplate ? workspace.cloneLoop(loop.id) : setInspectorOpen(true)}
                    data-testid="loopops.builder.selected-node.edit"
                  >
                    {isTemplate ? t("actions.cloneTemplate") : t("builder.editContract")}
                  </Button>
                </>
              ) : (
                <p>{t("builder.nodeSummaryNoSelection")}</p>
              )}
            </div>

            {dropMessage ? (
              <div className="builderDropNotice" data-testid="loopops.builder.invalid-drop">
                {dropMessage}
              </div>
            ) : null}

            {builderTab === "definition" ? (
              <section className="builderDefinition" data-testid="loopops.builder.definition">
                <div className="definitionIntro"><h3>{t("builder.definitionTitle")}</h3><p>{t("builder.definitionCaption")}</p></div>
                <TextArea label={t("builder.definitionGoal")} value={workspace.editorState?.draft?.definition?.goal || ""} onChange={(value) => workspace.updateLoopDefinition("goal", value)} disabled={isTemplate} rows={3} width="100%" />
                <TextArea label={t("builder.definitionContext")} value={workspace.editorState?.draft?.definition?.context || ""} onChange={(value) => workspace.updateLoopDefinition("context", value)} disabled={isTemplate} rows={3} width="100%" />
                <TextArea label={t("builder.definitionConstraints")} value={listValue(workspace.editorState?.draft?.definition?.constraints)} onChange={(value) => workspace.updateLoopDefinition("constraints", splitList(value))} disabled={isTemplate} rows={2} width="100%" />
                <TextArea label={t("builder.definitionDoneWhen")} value={listValue(workspace.editorState?.draft?.definition?.doneWhen)} onChange={(value) => workspace.updateLoopDefinition("doneWhen", splitList(value))} disabled={isTemplate} rows={2} width="100%" />
                <TextArea label={t("builder.definitionVerify")} value={listValue(workspace.editorState?.draft?.definition?.verify)} onChange={(value) => workspace.updateLoopDefinition("verify", splitList(value))} disabled={isTemplate} rows={2} width="100%" />
                <TextArea label={t("builder.definitionResult")} value={workspace.editorState?.draft?.definition?.expectedResult || ""} onChange={(value) => workspace.updateLoopDefinition("expectedResult", value)} disabled={isTemplate} rows={2} width="100%" />
                <TextArea label={t("builder.definitionStopRules")} value={listValue(workspace.editorState?.draft?.definition?.stopRules)} onChange={(value) => workspace.updateLoopDefinition("stopRules", splitList(value))} disabled={isTemplate} rows={2} width="100%" />
                <WorkflowModelSettings
                  settings={workspace.editorState?.draft?.runSettings || {}}
                  onChange={workspace.updateRunSetting}
                  t={t}
                  disabled={isTemplate}
                />
              </section>
            ) : builderTab === "outline" ? (
              <section className="builderOutline" data-testid="loopops.builder.outline">
                <div className="definitionIntro"><h3>{t("builder.outlineTitle")}</h3><p>{t("builder.outlineCaption")}</p></div>
                <ol className="outlineList">{nodes.map((node, index) => <li key={node.id}><span>{index + 1}</span><button type="button" onClick={() => workspace.setSelectedNodeId(node.id)}><strong>{node.title}</strong><small>{nodeTypeLabel(node.type, t)} · {flowLabel(node.inputs, node.outputs, t)}</small></button>{!isTemplate ? <div className="buttonRow"><Button variant="ghost" size="sm" icon={<ArrowUp size={14} />} disabled={index === 0} onClick={() => workspace.reorderWorkflowNode(index, index - 1)}>{t("actions.moveUp")}</Button><Button variant="ghost" size="sm" icon={<ArrowDown size={14} />} disabled={index === nodes.length - 1} onClick={() => workspace.reorderWorkflowNode(index, index + 1)}>{t("actions.moveDown")}</Button></div> : null}</li>)}</ol>
              </section>
            ) : builderTab === "canvas" ? (
              <LoopCanvas
                t={t}
                nodes={displayNodes}
                edges={edges}
                selectedNodeId={workspace.selectedNodeId}
                paletteItems={workspace.resourcePalette}
                connectionStartNodeId={workspace.connectionStartNodeId}
                onNodeSelect={workspace.setSelectedNodeId}
                onNodeMove={workspace.updateNodePosition}
                onConnect={workspace.connectWorkflowNodes}
                onConnectionStart={workspace.startNodeConnection}
                onConnectionCancel={workspace.cancelNodeConnection}
                onDropResource={handleDropResource}
                onDeleteNode={workspace.removeWorkflowNode}
                onViewportChange={() => {}}
                readOnly={isTemplate}
              />
            ) : null}

            {workspace.pendingPatch ? (
              <section className="patchReceipt patchReceiptBanner" data-testid="loopops.templates.builder-patch-receipt" aria-labelledby="builder-proposal-title">
                <div>
                  <strong id="builder-proposal-title">{t("builder.patchReceipt")}</strong>
                  <p>{workspace.pendingPatch.summary}</p>
                </div>
                <div className="proposalSummary">
                  <span>{t("builder.proposalChangeCount", { count: workspace.pendingPatch.operations.length })}</span>
                  <ul>
                    {workspace.pendingPatch.operations.slice(0, 4).map((operation, index) => (
                      <li key={`${operation.op}-${index}`}>{proposalOperationLabel(operation, t)}</li>
                    ))}
                  </ul>
                  {workspace.pendingPatch.status !== "proposed" ? (
                    <p className="proposalBlocked" role="alert">{t("builder.proposalNeedsRevision")}</p>
                  ) : null}
                </div>
                <div className="buttonRow">
                  <Button variant="secondary" size="sm" onClick={workspace.dismissBuilderPatch} data-testid="loopops.templates.dismiss-builder-patch">
                    {t("actions.dismissPatch")}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={workspace.builderAssistantBusy || workspace.pendingPatch.status !== "proposed"}
                    title={workspace.pendingPatch.status !== "proposed" ? t("builder.proposalNeedsRevision") : undefined}
                    onClick={workspace.applyBuilderPatch}
                    data-testid="loopops.templates.apply-builder-patch"
                  >
                    {workspace.builderAssistantBusy ? t("builder.applyingProposal") : t("actions.applyPatch")}
                  </Button>
                </div>
              </section>
            ) : null}

            <section className={`assistantDock ${assistantOpen ? "open" : ""}`} data-testid="loopops.builder.chat">
              <button
                type="button"
                className="assistantToggle"
                onClick={() => setAssistantOpen((value) => !value)}
                data-testid="loopops.builder.assistant.toggle"
                aria-expanded={assistantOpen}
              >
                <span><MessageSquare size={15} /> {t("builder.assistant")}</span>
                {assistantOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              </button>
              {assistantOpen ? (
                <div className="assistantPanel">
                  <div className="assistantIntro">
                    <strong>{t("builder.assistantPromptTitle")}</strong>
                    <p>{t("builder.assistantPromptCopy")}</p>
                  </div>
                  <form className="assistantComposer" onSubmit={(event) => {
                    event.preventDefault();
                    if (builderModelReady && workspace.composer.trim() && !isTemplate && !isDirty && !workspace.builderAssistantBusy) {
                      workspace.sendChat(workspace.composer, builderModelRevisionId);
                    }
                  }}>
                    <ModelPicker
                      options={builderModels.options}
                      requiredCapabilities={["chat", "tool_calling", "structured_output"]}
                      value={builderModelRevisionId}
                      onChange={setBuilderModelRevisionId}
                      label={t("model.builder")}
                      hint={t("model.turnPinHint")}
                      loading={builderModels.isLoading}
                      unavailableLabel={t("model.unavailable")}
                      historicalLabel={t("model.historical")}
                      testId="loopops.builder.assistant.model"
                    />
                    <TextArea
                      label={t("builder.assistantPromptLabel")}
                      value={workspace.composer}
                      onChange={workspace.setComposer}
                      placeholder={t("builder.assistantPromptPlaceholder")}
                      rows={3}
                      width="100%"
                      disabled={isTemplate || workspace.builderAssistantBusy}
                    />
                    <div className="assistantComposerFooter">
                      <span>
                        {isTemplate
                          ? t("builder.assistantUseTemplateFirst")
                          : isDirty ? t("builder.assistantSaveFirst") : t("builder.assistantConfirmFirst")}
                      </span>
                      <Button
                        variant="primary"
                        type="submit"
                        size="sm"
                        disabled={isTemplate || isDirty || workspace.builderAssistantBusy || !workspace.composer.trim() || !builderModelReady}
                        data-testid="loopops.builder.assistant.send"
                      >
                        {workspace.builderAssistantBusy ? t("builder.preparingProposal") : t("builder.reviewProposal")}
                      </Button>
                    </div>
                  </form>
                  {workspace.builderProposalError ? (
                    <div className="assistantError" role="alert">
                      <span>{workspace.builderProposalError}</span>
                      <Button variant="secondary" size="sm" onClick={() => workspace.sendChat(workspace.composer, builderModelRevisionId)} disabled={!workspace.composer.trim() || workspace.builderAssistantBusy || !builderModelReady}>
                        {t("actions.retry")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <footer className={`debugDock ${debugOpen ? "expanded" : ""}`} data-testid="loopops.builder.debug-panel">
              <div className="debugSummary">
                <h3>{t("builder.debug")}</h3>
                <p>{runModeLabel(preview.mode, t)} · {preview.reviewGate}</p>
              </div>
              <div className="debugMeta">
                <span>{t("builder.steps", { count: preview.steps.length })}</span>
                <span>{preview.outputShape}</span>
              </div>
              <div className="debugActions">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={debugOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                  onClick={() => setDebugOpen((value) => !value)}
                  data-testid="loopops.builder.debug.toggle"
                >
                  {debugOpen ? t("builder.collapseDebug") : t("builder.expandDebug")}
                </Button>
                <Button
                  variant="primary"
                  icon={<Play size={15} />}
                  disabled={!canRunSelected}
                  onClick={runSelectedLoop}
                  data-testid="loopops.builder.mock-run"
                >
                  {t("actions.startTestRun")}
                </Button>
              </div>
              {!isTemplate ? (
                <div className="runInputGrid" data-testid="loopops.builder.run-inputs">
                  {(workspace.editorState?.draft?.inputForm?.fields || []).map((field) => (
                    <label key={field.fieldId}>
                      <span>{field.label}{field.required ? " *" : ""}</span>
                      <input
                        value={workspace.runInputs[field.fieldId] || ""}
                        onChange={(event) => workspace.setRunInput(field.fieldId, event.target.value)}
                        placeholder={field.description || field.label}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              {!canRunSelected ? (
                <div className="runBlockedNotice" data-testid="loopops.builder.run-blocked">
                  <span>{runBlockedReason}</span>
                  <Button variant="secondary" size="sm" onClick={recoverRunBlock} data-testid="loopops.builder.run-blocked.recover">
                    {runRecoveryLabel}
                  </Button>
                </div>
              ) : null}
              {debugOpen ? (
                <>
                  {preview.diagnostics?.length ? (
                    <ul className="compileDiagnostics" data-testid="loopops.builder.compile-diagnostics">
                      {preview.diagnostics.map((diagnostic) => (
                        <li key={`${diagnostic.code}-${diagnostic.nodeId || "workflow"}`}>{diagnostic.message}</li>
                      ))}
                    </ul>
                  ) : null}
                  <ol className="debugSteps">
                    {preview.steps.slice(0, 6).map((step) => (
                      <li key={`${step.index}-${step.title}`}>
                        <span>{step.index}</span>
                        <strong>{step.title}</strong>
                        <small>{nodeTypeLabel(step.type, t)}</small>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </footer>
          </>
        ) : null}
      </section>


      <aside className={`inspectorPanel contextDrawer ${inspectorOpen ? "open" : "collapsed"}`} data-testid="loopops.builder.inspector">
        {inspectorOpen ? (
          <>
            <header className="drawerHeader">
              <div>
                <h2>{t("builder.inspector")}</h2>
                <p>{t("builder.inspectorCaption")}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                icon={<PanelRightClose size={15} />}
                onClick={() => setInspectorOpen(false)}
                data-testid="loopops.builder.inspector.toggle"
              >
                {t("builder.hideInspector")}
              </Button>
            </header>
            {selectedNode ? (
              <div className="inspectorSections">
              <section className="inspectorSection">
                <h3>{t("builder.basics")}</h3>
                <TextInput
                  label={t("builder.title")}
                  hiddenLabel={false}
                  value={selectedNode.title}
                  onChange={(value) => workspace.updateSelectedNodeField("title", value)}
                  disabled={isTemplate}
                  width="100%"
                  aria-label={t("builder.selectedTitleAria")}
                />
                <TextArea
                  label={t("builder.purpose")}
                  hiddenLabel={false}
                  value={selectedNode.subtitle}
                  onChange={(value) => workspace.updateSelectedNodeField("purpose", value)}
                  disabled={isTemplate}
                  rows={2}
                  width="100%"
                  aria-label={t("builder.selectedPurposeAria")}
                />
              </section>

              {selectedNodeIsModelBacked ? (
                <section className="inspectorSection">
                  <h3>{t("model.runSettings")}</h3>
                  <NodeModelOverride
                    capability={selectedNodeModelCapability}
                    value={selectedNode.canonical?.configuration?.modelProfileId || ""}
                    onChange={workspace.updateSelectedNodeModel}
                    t={t}
                    disabled={isTemplate}
                    testId="loopops.builder.inspector.model"
                  />
                </section>
              ) : null}

              <section className="inspectorSection">
                <h3>{t("builder.contract")}</h3>
                <TextArea
                  label={t("builder.inputs")}
                  hiddenLabel={false}
                  value={listValue(selectedNode.inputs)}
                  onChange={(value) => workspace.updateSelectedNodeField("inputs", splitList(value))}
                  disabled={isTemplate}
                  rows={2}
                  width="100%"
                  aria-label={t("builder.selectedNeedsAria")}
                  data-testid="loopops.builder.inspector.inputs"
                />
                <TextArea
                  label={t("builder.outputs")}
                  hiddenLabel={false}
                  value={listValue(selectedNode.outputs)}
                  onChange={(value) => workspace.updateSelectedNodeField("outputs", splitList(value))}
                  disabled={isTemplate}
                  rows={2}
                  width="100%"
                  aria-label={t("builder.selectedCreatesAria")}
                />
              </section>

              <section className="inspectorSection">
                <h3>{t("builder.reviewSection")}</h3>
                <TextInput
                  label={t("builder.reviewPolicy")}
                  hiddenLabel={false}
                  value={selectedNode.reviewPolicy || t(selectedNode.reviewPolicyMode === "required" ? "builder.reviewRequired" : "builder.noReviewRequired")}
                  onChange={(value) => workspace.updateSelectedNodeField("reviewPolicy", value)}
                  disabled={isTemplate}
                  width="100%"
                  aria-label={t("builder.selectedReviewAria")}
                />
                {selectedNode.type === "Review Gate" ? (
                  <label className="revisionTargetField">
                    <span>{t("builder.revisionTarget")}</span>
                    <select
                      value={selectedNode.canonical?.configuration?.revisionTarget
                        ? `${selectedNode.canonical.configuration.revisionTarget.nodeId}::${selectedNode.canonical.configuration.revisionTarget.portId}`
                        : ""}
                      onChange={(event) => workspace.updateSelectedNodeField("revisionTarget", event.target.value)}
                      disabled={isTemplate}
                      data-testid="loopops.builder.inspector.revision-target"
                    >
                      <option value="">{t("builder.revisionTargetNone")}</option>
                      {revisionTargetOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                    <small>{t("builder.revisionTargetHint")}</small>
                  </label>
                ) : null}
              </section>

              <section className="inspectorSection">
                <h3>{t("builder.actionsSection")}</h3>
                {isTemplate ? (
                  <Button variant="primary" onClick={() => workspace.cloneLoop(loop.id)}>
                    {t("actions.cloneTemplate")}
                  </Button>
                ) : <div className="buttonRow inspectorActions">
                  <Button
                    variant="secondary"
                    icon={<ArrowUp size={15} />}
                    disabled={selectedNodeIndex <= 0}
                    onClick={() => workspace.reorderWorkflowNode(selectedNodeIndex, selectedNodeIndex - 1)}
                  >
                    {t("actions.moveUp")}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<ArrowDown size={15} />}
                    disabled={selectedNodeIndex === nodes.length - 1}
                    onClick={() => workspace.reorderWorkflowNode(selectedNodeIndex, selectedNodeIndex + 1)}
                  >
                    {t("actions.moveDown")}
                  </Button>
                  <Button
                    variant="destructive"
                    icon={<Trash2 size={15} />}
                    onClick={() => workspace.removeWorkflowNode(selectedNode.id)}
                    data-testid="loopops.builder.inspector.delete-node"
                  >
                    {t("actions.deleteNode")}
                  </Button>
                </div>}
              </section>
              </div>
            ) : (
              <p className="muted">{t("builder.selectNode")}</p>
            )}
          </>
        ) : (
          <button
            type="button"
            className="drawerRailButton"
            onClick={() => setInspectorOpen(true)}
            data-testid="loopops.builder.inspector.toggle"
            title={selectedNode ? `${t("builder.nodeEditorRail")}: ${productNodeTitle(selectedNode, workspace.locale)}` : t("builder.selectNode")}
          >
            <PanelRightOpen size={15} />
            <span>{selectedNode ? t("builder.nodeEditorRail") : t("builder.selectNodeRail")}</span>
            <small>{selectedNode ? productNodeTitle(selectedNode, workspace.locale) : t("builder.selectNode")}</small>
          </button>
        )}
      </aside>
    </div>
  );
}
