import { useEffect, useMemo, useState } from "react";

import { translate } from "../i18n.js";
import { EDITOR_ACTIONS, revisionToEditorDraft, useWorkflowEditor } from "./editor/index.js";
import {
  addPaletteNodeToDraft,
  addMaterialToDraft,
  addSkillToDraft,
  connectDraftNodes,
  deleteDraftNode,
  moveDraftNode,
  reorderDraftNode,
  updateDraftNode,
} from "./editor/workflowDraftActions.js";
import { useRunStream } from "./run-stream/index.js";
import {
  latestTeamReleaseIds,
  runToView,
  publishedSkillAssetToDefinition,
  skillAssetSummaryToView,
  skillDefinitionToView,
  workflowTemplateToView,
  workflowToView,
} from "./server/presentationAdapters.js";
import { useWorkbenchServerState } from "./server/useWorkbenchServerState.js";
import { useWorkspaceUi } from "./ui/useWorkspaceUi.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const idFactory = (kind) => `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const mutationKey = (candidate) => typeof candidate === "string" && candidate
  ? candidate
  : idFactory("idem");

function editableRevision(baseRevision, draft) {
  return baseRevision && draft ? { ...baseRevision, ...draft } : baseRevision;
}

function previewFromEditor(state, nodes, t) {
  const result = state?.compile?.result;
  const stepById = new Map(nodes.map((node) => [node.id, node]));
  const planSteps = result?.executionPlan?.steps || [];
  const source = planSteps.length
    ? planSteps.map((step, index) => ({
        index: index + 1,
        title: stepById.get(step.nodeId)?.title || step.nodeId,
        type: stepById.get(step.nodeId)?.type || step.kind,
      }))
    : nodes.map((node, index) => ({ index: index + 1, title: node.title, type: node.type }));
  return {
    status: state?.compile?.status || "idle",
    mode: "Manual run",
    reviewGate: result?.reviewGates?.length ? t("builder.reviewRequired") : t("builder.compileBeforeRun"),
    outputShape: result?.executionPlan?.primaryOutput?.portId || t("builder.finalResult"),
    steps: source,
    diagnostics: result?.warnings || state?.compile?.diagnostics || [],
  };
}

export function useWorkbenchWorkspace() {
  const ui = useWorkspaceUi();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [builderSelection, setBuilderSelection] = useState({ kind: "template", id: "" });
  const [builderInitialTab, setBuilderInitialTab] = useState("canvas");
  const [createLoopInitialMode, setCreateLoopInitialMode] = useState("goal");
  const [createLoopPrefill, setCreateLoopPrefill] = useState(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [selectedManagedSkillId, setSelectedManagedSkillId] = useState("");
  const [selectedResourceId, setSelectedResourceId] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [comparisonRunId, setComparisonRunId] = useState("");
  const [selectedLoopIds, setSelectedLoopIds] = useState([]);
  const [templateNodeId, setTemplateNodeId] = useState("");
  const [connectionStartNodeId, setConnectionStartNodeId] = useState("");
  const [runInputs, setRunInputs] = useState({});
  const [savedAt, setSavedAt] = useState("");
  const [composer, setComposer] = useState("");
  const [loopImportDialogOpen, setLoopImportDialogOpen] = useState(false);
  const [createSkillDialogOpen, setCreateSkillDialogOpen] = useState(false);
  const [createSkillDialogMode, setCreateSkillDialogMode] = useState("create");
  const [createResourceDialogOpen, setCreateResourceDialogOpen] = useState(false);
  const [skillUpdateDialog, setSkillUpdateDialog] = useState(null);
  const [retireSkillDialog, setRetireSkillDialog] = useState(null);
  const [pendingSkillPackage, setPendingSkillPackage] = useState(null);
  const [skillLifecycleByDraft, setSkillLifecycleByDraft] = useState({});
  const [pendingSkillAdd, setPendingSkillAdd] = useState(null);
  const [builderProposal, setBuilderProposal] = useState(null);
  const [builderProposalError, setBuilderProposalError] = useState("");
  const [creationProposalContext, setCreationProposalContext] = useState(null);
  const requestedManagedSkillId = ui.route.skillId || selectedManagedSkillId;
  const server = useWorkbenchServerState({
    selectedWorkflowId: ui.route.loopId || selectedWorkflowId,
    selectedManagedSkillId: requestedManagedSkillId,
    activeRunId: ui.route.runId || activeRunId,
    comparisonRunId,
    targetSkillVersionId: ui.route.skillVersionId || "",
  });
  const editor = useWorkflowEditor(server.revision, server.workflowEtag);
  const runStream = useRunStream(activeRunId);

  const t = (key, replacements) => translate(ui.locale, key, replacements);
  const skills = useMemo(() => server.skills.map(skillDefinitionToView), [server.skills]);
  const managedSkills = useMemo(() => server.skillAssets
    .map(skillAssetSummaryToView)
    .filter(Boolean), [server.skillAssets]);
  const templates = useMemo(() => server.templates.map(workflowTemplateToView), [server.templates]);
  const resources = server.resources;
  const selectedDraftRevision = editableRevision(server.revision, editor.state?.draft);
  const workflows = useMemo(() => server.workflows.map((workflow) => {
    const revision = workflow.workflowId === selectedWorkflowId ? selectedDraftRevision : null;
    const view = workflowToView(workflow, revision);
    if (workflow.workflowId === selectedWorkflowId && editor.state) {
      view.dirty = editor.state.dirty;
      view.readiness = editor.state.compile.status === "ready" ? "Ready" : view.readiness;
      const sourceTemplate = templates.find((template) => template.id === workflow.sourceTemplate?.templateId);
      view.clonedFromTitle = sourceTemplate?.title;
      view.clonedFromTemplateId = sourceTemplate?.id;
    }
    return view;
  }), [server.workflows, selectedWorkflowId, selectedDraftRevision, editor.state, templates]);
  const loops = useMemo(() => [...workflows, ...templates], [workflows, templates]);
  const teamLibrary = useMemo(() => {
    const latestReleaseIds = latestTeamReleaseIds(server.teamLibrary);
    return server.teamLibrary.map((release) => {
      const workflow = server.workflows.find((item) => item.workflowId === release.assetId);
      const compatibilitySkill = server.skills.find((item) => item.skillId === release.assetId);
      const skillAsset = server.skillAssets.find((item) => item.skill?.skillId === release.assetId);
      const skill = skillAsset?.latestVersion || skillAsset?.draft || compatibilitySkill;
      const installation = server.installations.find((item) => (
        item.assetKind === release.assetKind && item.upstreamAssetId === release.assetId && item.state !== "removed"
      )) || null;
      return {
        ...release,
        title: workflow?.name || skill?.name || release.assetId,
        description: workflow?.description || skill?.description || release.releaseNotes || "",
        versionLabel: release.version || skill?.version || release.versionId,
        installation,
        installed: installation?.pinnedVersionId === release.versionId,
        canAdopt: Boolean(
          installation
          && latestReleaseIds.get(`${release.assetKind}:${release.assetId}`) === release.releaseId
          && installation.pinnedVersionId !== release.versionId
        ),
        skillDetails: skill ? skillDefinitionToView({ ...skill, status: "ready" }) : null,
      };
    });
  }, [server.teamLibrary, server.installations, server.workflows, server.skills, server.skillAssets]);

  useEffect(() => {
    if (!selectedWorkflowId && server.workflows[0]) setSelectedWorkflowId(server.workflows[0].workflowId);
    if (!selectedTemplateId && server.templates[0]) setSelectedTemplateId(server.templates[0].templateId);
    if (!builderSelection.id) {
      if (server.templates[0]) setBuilderSelection({ kind: "template", id: server.templates[0].templateId });
      else if (server.workflows[0]) setBuilderSelection({ kind: "workflow", id: server.workflows[0].workflowId });
    }
    if (!selectedSkillId && server.skills[0]) setSelectedSkillId(server.skills[0].skillId);
    if (!selectedManagedSkillId && managedSkills[0]) setSelectedManagedSkillId(managedSkills[0].id);
    if (!selectedResourceId && resources[0]) setSelectedResourceId(resources[0].resourceId);
  }, [server.workflows, server.templates, server.skills, selectedWorkflowId, selectedTemplateId, selectedSkillId, selectedManagedSkillId, selectedResourceId, managedSkills, resources, builderSelection.id]);

  useEffect(() => {
    if (ui.route.skillId && managedSkills.some((skill) => skill.id === ui.route.skillId)) {
      setSelectedManagedSkillId(ui.route.skillId);
    }
  }, [ui.route.skillId, managedSkills]);

  useEffect(() => {
    const fields = editor.state?.draft?.inputForm?.fields || [];
    setRunInputs((current) => Object.fromEntries(fields.map((field) => [field.fieldId, current[field.fieldId] ?? ""])));
  }, [editor.state?.baseRevision?.revisionId]);

  useEffect(() => {
    setBuilderProposal(null);
    setBuilderProposalError("");
    setComposer("");
  }, [editor.state?.workflowId, editor.state?.baseRevision?.revisionId]);

  useEffect(() => {
    if (ui.activePage !== "create-loop" && pendingSkillAdd && !pendingSkillAdd.loopId) {
      setPendingSkillAdd(null);
    }
  }, [pendingSkillAdd, ui.activePage]);

  useEffect(() => {
    if (!activeRunId && server.runs[0]) setActiveRunId(server.runs[0].runId);
  }, [server.runs, activeRunId]);

  useEffect(() => {
    const route = ui.route;
    if (route.loopId && server.workflows.some((workflow) => workflow.workflowId === route.loopId)) {
      setSelectedWorkflowId(route.loopId);
      setBuilderSelection({ kind: "workflow", id: route.loopId });
    }
    if (route.runId && route.runId !== activeRunId) {
      setActiveRunId(route.runId);
      setComparisonRunId("");
    }
  }, [ui.route, server.workflows, activeRunId]);

  const selectedWorkflow = ui.route.loopId
    ? workflows.find((workflow) => workflow.id === ui.route.loopId) || null
    : workflows.find((workflow) => workflow.id === selectedWorkflowId) || workflows[0] || null;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) || templates[0] || null;
  const selectedLoop = ui.route.loopId
    ? selectedWorkflow
    : builderSelection.kind === "template"
      ? templates.find((template) => template.id === builderSelection.id) || selectedTemplate || selectedWorkflow
      : workflows.find((workflow) => workflow.id === builderSelection.id) || selectedWorkflow || selectedTemplate;
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) || skills[0] || null;
  const selectedManagedSkill = ui.route.skillId
    ? managedSkills.find((skill) => skill.id === ui.route.skillId) || null
    : managedSkills.find((skill) => skill.id === selectedManagedSkillId) || managedSkills[0] || null;
  const visibleSkillDraft = selectedManagedSkill?.canonical?.draft || null;
  const selectedSkillDraft = visibleSkillDraft
    ? server.skillDraft || visibleSkillDraft
    : null;
  const selectedSkillDraftEtag = selectedSkillDraft ? server.skillDraftEtag || "" : "";
  const skillLifecycleKey = selectedSkillDraft
    ? `${selectedSkillDraft.skillId}:${selectedSkillDraft.skillDraftId}:${selectedSkillDraft.revision}`
    : "";
  const selectedSkillLifecycle = skillLifecycleByDraft[skillLifecycleKey] || {
    testRun: null,
    validation: null,
  };
  const selectedNodeId = selectedLoop?.type === "LoopTemplate"
    ? templateNodeId || selectedLoop.workflow?.nodes?.[0]?.id || ""
    : editor.state?.selectedNodeId || "";
  const selectedNode = selectedLoop?.workflow?.nodes?.find((node) => node.id === selectedNodeId) || null;
  const runViews = server.runs.map((run) => runToView(run));
  const activeRun = server.runDetail
    ? runToView(server.runDetail.run, server.runDetail.readModel)
    : runViews.find((run) => run.id === activeRunId) || null;
  const compilePreview = previewFromEditor(editor.state, selectedLoop?.workflow?.nodes || [], t);
  const dirtyLoopIds = editor.state?.dirty ? [selectedWorkflowId] : [];
  const membershipRole = server.membership?.role || "";
  const readOnlyWorkspace = membershipRole === "viewer";

  async function requestWorkspaceAccess() {
    const request = t("permissions.requestText", {
      workspace: server.workspace?.name || t("permissions.defaultWorkspace"),
      user: server.session?.userId || "",
    });
    try {
      if (typeof globalThis.navigator?.clipboard?.writeText !== "function") throw new Error("clipboard_unavailable");
      await globalThis.navigator.clipboard.writeText(request);
      ui.pushToast(t("permissions.requestCopied"));
    } catch {
      ui.pushToast(t("permissions.requestCopyFailed"));
    }
  }

  const resourcePalette = [
    { id: "palette-inputs", items: [t("builder.resourceTextInput")] },
    { id: "palette-controls", items: [t("builder.resourceReviewGate")] },
    { id: "palette-outputs", items: [t("builder.resourceFinalOutput")] },
  ];

  useEffect(() => {
    if (!pendingSkillAdd || editor.state?.workflowId !== pendingSkillAdd.loopId) return;
    editor.replaceDraft((draft) => addSkillToDraft(
      draft,
      pendingSkillAdd.skill,
      pendingSkillAdd.position,
      () => pendingSkillAdd.nodeId,
    ));
    editor.selectNode(pendingSkillAdd.nodeId);
    setBuilderInitialTab("canvas");
    navigateToPage("builder", { loopId: pendingSkillAdd.loopId, replace: true });
    ui.pushToast(t("toast.addedToWorkflow", {
      nodeTitle: pendingSkillAdd.skill.name,
      loopTitle: workflows.find((workflow) => workflow.id === pendingSkillAdd.loopId)?.title || "",
    }));
    setPendingSkillAdd(null);
  }, [pendingSkillAdd, editor.state?.workflowId]);

  function messageForError(error) {
    const key = `error.${error?.code || "unknown"}`;
    const translated = t(key);
    return translated === key ? (error?.message || t("error.unknown")) : translated;
  }

  function navigateToPage(page, {
    loopId = "",
    runId = "",
    skillId = "",
    skillVersionId = "",
    replace = false,
  } = {}) {
    ui.navigateTo({
      page,
      ...(loopId ? { loopId } : {}),
      ...(runId ? { runId } : {}),
      ...(skillId ? { skillId } : {}),
      ...(skillVersionId ? { skillVersionId } : {}),
    }, { replace });
  }

  function selectLoop(loopId) {
    if (templates.some((item) => item.id === loopId)) {
      setSelectedTemplateId(loopId);
      setBuilderSelection({ kind: "template", id: loopId });
      setTemplateNodeId(templates.find((item) => item.id === loopId)?.workflow?.nodes?.[0]?.id || "");
      return;
    }
    if (workflows.some((item) => item.id === loopId)) {
      setSelectedWorkflowId(loopId);
      setBuilderSelection({ kind: "workflow", id: loopId });
    }
  }

  async function useTemplate(templateId, afterCreate, retryKey) {
    const template = server.templates.find((item) => item.templateId === templateId);
    if (!template) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.useTemplate.mutateAsync({
        templateId,
        data: { templateVersion: template.templateVersion, name: t("workflow.copyName", { title: template.name }) },
        idempotencyKey,
      });
      const { workflow, revision } = result.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      if (afterCreate) {
        const nextDraft = afterCreate(revisionToEditorDraft(revision));
        editor.replaceDraftValue(nextDraft);
      }
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.templateUsed", { title: template.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => useTemplate(templateId, afterCreate, idempotencyKey));
      return null;
    }
  }

  function workflowCreationPayload(details) {
    const name = String(details?.name || "").trim();
    const goal = String(details?.goal || "").trim();
    if (!name || !goal) return null;
    return {
      name,
      description: String(details.description || goal).trim(),
      definition: {
        goal,
        context: String(details.context || "").trim(),
        constraints: Array.isArray(details.constraints) ? details.constraints : [],
        doneWhen: Array.isArray(details.doneWhen) && details.doneWhen.length
          ? details.doneWhen
          : [t("loopCreate.defaultDoneWhen")],
        verify: Array.isArray(details.verify) ? details.verify : [],
        expectedResult: String(details.expectedResult || t("loopCreate.defaultExpectedResult")).trim(),
        stopRules: Array.isArray(details.stopRules) ? details.stopRules : [],
      },
    };
  }

  async function createWorkflow(details = null, retryKey) {
    if (!details) {
      navigateToPage("create-loop");
      return null;
    }
    const data = workflowCreationPayload(details);
    if (!data) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.createLoop.mutateAsync({ data, idempotencyKey });
      const { workflow, revision } = result.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      if (pendingSkillAdd && !pendingSkillAdd.loopId) {
        const queued = pendingSkillAdd;
        editor.replaceDraftValue(addSkillToDraft(
          revisionToEditorDraft(revision),
          queued.skill,
          queued.position,
          () => queued.nodeId,
        ));
        editor.selectNode(queued.nodeId);
        setBuilderInitialTab("canvas");
        setPendingSkillAdd(null);
        ui.pushToast(t("toast.addedToWorkflow", { nodeTitle: queued.skill.name, loopTitle: workflow.name }));
      }
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.loopCreated", { title: workflow.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => createWorkflow(details, idempotencyKey));
      return null;
    }
  }

  async function createWorkflowProposal(details, modelProfileRevisionId = "", retryKey) {
    const data = workflowCreationPayload(details);
    if (!data) return null;
    const createIdempotencyKey = mutationKey(retryKey?.createKey);
    const proposalIdempotencyKey = mutationKey(retryKey?.proposalKey);
    setBuilderProposalError("");
    try {
      const created = await server.mutations.createLoop.mutateAsync({ data, idempotencyKey: createIdempotencyKey });
      const { workflow, revision } = created.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, created.etag);
      const instruction = [
        "For this new empty workflow, propose a definition-only change. Use exactly one updateDefinition operation, preserve all seven definition fields, and do not add graph nodes yet.",
        data.definition.goal,
        data.definition.expectedResult ? `Expected result: ${data.definition.expectedResult}` : "",
        data.definition.context ? `Context: ${data.definition.context}` : "",
        data.definition.constraints.length ? `Constraints: ${data.definition.constraints.join("; ")}` : "",
      ].filter(Boolean).join("\n");
      setCreationProposalContext({ workflowId: workflow.workflowId, title: workflow.name, etag: created.etag, instruction, modelProfileRevisionId });
      const proposal = await server.mutations.generateLoopProposal.mutateAsync({
        workflowId: workflow.workflowId,
        ifMatch: created.etag,
        idempotencyKey: proposalIdempotencyKey,
        data: { instruction, ...(modelProfileRevisionId ? { modelProfileRevisionId } : {}) },
      });
      setBuilderProposal(proposal.data);
      return { created, proposal: proposal.data };
    } catch (error) {
      setBuilderProposalError(messageForError(error));
      return { failed: true, createKey: createIdempotencyKey, proposalKey: proposalIdempotencyKey };
    }
  }

  async function retryCreationProposal(retryKey) {
    if (!creationProposalContext?.workflowId || !creationProposalContext?.instruction) return null;
    const idempotencyKey = mutationKey(retryKey);
    setBuilderProposalError("");
    try {
      const proposal = await server.mutations.generateLoopProposal.mutateAsync({
        workflowId: creationProposalContext.workflowId,
        ifMatch: creationProposalContext.etag,
        idempotencyKey,
        data: {
          instruction: creationProposalContext.instruction,
          ...(creationProposalContext.modelProfileRevisionId ? { modelProfileRevisionId: creationProposalContext.modelProfileRevisionId } : {}),
        },
      });
      setBuilderProposal(proposal.data);
      return proposal.data;
    } catch (error) {
      setBuilderProposalError(messageForError(error));
      return null;
    }
  }

  async function duplicateWorkflow(workflowId, retryKey) {
    const source = workflows.find((workflow) => workflow.id === workflowId && workflow.type === "LoopWorkflow") || null;
    if (!source) return null;
    if (editor.state?.workflowId === source.id && editor.state.dirty) {
      ui.pushToast(t("error.save_before_compile"));
      return null;
    }
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.duplicateLoop.mutateAsync({
        workflowId: source.id,
        data: { name: t("workflow.copyName", { title: source.title }) },
        idempotencyKey,
      });
      const { workflow, revision } = result.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.workflowCopied", { title: workflow.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => duplicateWorkflow(workflowId, idempotencyKey));
      return null;
    }
  }

  async function duplicateSelectedWorkflow(retryKey) {
    return duplicateWorkflow(selectedLoop?.id, retryKey);
  }

  async function inspectPortableLoop(file, onProgress, retryKey) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      return await server.mutations.inspectLoopPackage.mutateAsync({
        data: { file },
        idempotencyKey,
        onProgress,
      });
    } catch (error) {
      return { failed: true, error, idempotencyKey };
    }
  }

  async function loadPortableLoopOptions(portableLoop) {
    try {
      return await server.mutations.loadLoopImportOptions.mutateAsync({ portableLoop });
    } catch (error) {
      return { failed: true, error };
    }
  }

  async function refreshPortableLoopImport(importId) {
    try {
      const result = await server.mutations.refreshLoopImport.mutateAsync(importId);
      return { upload: null, loopImport: result.data, etag: result.etag };
    } catch (error) {
      return { failed: true, error };
    }
  }

  async function commitPortableLoopImport(loopImport, mappings, retryKey) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.commitLoopImport.mutateAsync({
        importId: loopImport.loopImport.importId,
        ifMatch: loopImport.etag,
        idempotencyKey,
        data: mappings,
      });
      const { workflow, revision } = result.data;
      setLoopImportDialogOpen(false);
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      setBuilderInitialTab("definition");
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.loopImported", { title: workflow.name }));
      return result;
    } catch (error) {
      return { failed: true, error, idempotencyKey };
    }
  }

  async function exportSelectedLoop(retryKey) {
    const loop = selectedWorkflow;
    const revisionId = loop?.currentRevisionId;
    if (!loop || !revisionId) {
      ui.pushToast(t("loopTransfer.exportUnavailable"));
      return null;
    }
    try {
      const result = await server.mutations.exportLoop.mutateAsync({
        workflowId: loop.id,
        revisionId,
        retryKey,
      });
      if (!result.bytes) {
        ui.pushToast(t("loopTransfer.exportUnchanged"));
        return result;
      }
      const blob = new Blob([result.bytes], { type: result.mediaType });
      const url = globalThis.URL?.createObjectURL?.(blob);
      if (!url) throw new Error("download_unavailable");
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      globalThis.setTimeout?.(() => globalThis.URL.revokeObjectURL(url), 0);
      ui.pushToast(t("toast.loopExported", { title: loop.title }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), error?.status === 403 ? t("permissions.copyRequest") : t("actions.retry"), error?.status === 403 ? requestWorkspaceAccess : () => exportSelectedLoop(retryKey));
      return null;
    }
  }

  function selectedCanonicalSkill(skillId) {
    return server.skills.find((skill) => skill.skillId === skillId);
  }

  function addSkillDefinitionToLoop(skill, loopId = selectedWorkflowId, position = null) {
    if (!loopId) {
      setPendingSkillAdd({ skill, loopId: "", position, nodeId: idFactory("node") });
      setCreateLoopInitialMode("goal");
      setCreateLoopPrefill({ goal: t("loopCreate.addSkillGoal", { skill: skill.name }) });
      navigateToPage("create-loop");
      return;
    }
    const templateId = templates.some((item) => item.id === loopId)
      ? loopId
      : selectedLoop?.type === "LoopTemplate" ? selectedLoop.id : "";
    const nodeId = idFactory("node");
    const add = (draft) => addSkillToDraft(draft, skill, position, () => nodeId);
    if (templateId) {
      useTemplate(templateId, add).then((result) => {
        if (result) editor.selectNode(nodeId);
      });
      return;
    }
    if (loopId !== selectedWorkflowId || !editor.state) {
      setSelectedWorkflowId(loopId);
      setBuilderSelection({ kind: "workflow", id: loopId });
      setPendingSkillAdd({ skill, loopId, position, nodeId });
      setBuilderInitialTab("canvas");
      navigateToPage("builder", { loopId });
      return;
    }
    editor.replaceDraft(add);
    editor.selectNode(nodeId);
    navigateToPage("builder", { loopId: selectedWorkflowId });
    ui.pushToast(t("toast.addedToWorkflow", { nodeTitle: skill.name, loopTitle: selectedWorkflow?.title || "" }));
  }

  function addSkillToLoop(skillId, loopId = selectedWorkflowId, position = null) {
    const skill = selectedCanonicalSkill(skillId);
    if (skill) addSkillDefinitionToLoop(skill, loopId, position);
  }

  function addManagedSkillToLoop(skillId, loopId = selectedWorkflowId, position = null) {
    const summary = server.skillAssets.find((item) => item.skill?.skillId === skillId);
    const skill = publishedSkillAssetToDefinition(summary);
    if (!skill) {
      ui.pushToast(t("error.skill_validation_failed"));
      return;
    }
    addSkillDefinitionToLoop(skill, loopId, position);
  }

  function addPaletteItemToLoop(resource, position = null) {
    const nodeId = idFactory("node");
    const add = (draft) => addPaletteNodeToDraft(draft, resource, position, () => nodeId);
    if (selectedLoop?.type === "LoopTemplate") {
      useTemplate(selectedLoop.id, add).then((result) => {
        if (result) editor.selectNode(nodeId);
      });
      return;
    }
    if (!editor.state) return;
    editor.replaceDraft(add);
    editor.selectNode(nodeId);
  }

  function addResourceToLoop(resourceId = selectedResourceId, position = null) {
    const resource = typeof resourceId === "object" ? resourceId : resources.find((item) => item.resourceId === resourceId);
    if (!resource) return;
    const nodeId = idFactory("node");
    const add = (draft) => addMaterialToDraft(draft, resource, position, () => nodeId);
    if (selectedLoop?.type === "LoopTemplate") {
      useTemplate(selectedLoop.id, (draft) => add(draft)).then((result) => {
        if (result) editor.selectNode(nodeId);
      });
      return;
    }
    if (!editor.state) return;
    editor.replaceDraft(add);
    editor.selectNode(nodeId);
    ui.pushToast(t("toast.addedMaterial", { title: resource.label }));
  }

  async function createTextResource(data, retryKey) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.createResource.mutateAsync({ data, idempotencyKey });
      setSelectedResourceId(result.data.resourceId);
      addResourceToLoop(result.data);
      setCreateResourceDialogOpen(false);
      return result.data;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => createTextResource(data, idempotencyKey));
      return null;
    }
  }

  async function saveWorkspace(retryKey) {
    if (!editor.state?.dirty) {
      ui.pushToast(t("toast.noChangesToSave"));
      return;
    }
    if (!editor.state.serverEtag) {
      ui.pushToast(t("error.workflow_revision_conflict"));
      return;
    }
    const idempotencyKey = mutationKey(retryKey);
    editor.saveStarted();
    try {
      const result = await server.mutations.saveRevision.mutateAsync({
        workflowId: editor.state.workflowId,
        ifMatch: editor.state.serverEtag,
        idempotencyKey,
        data: {
          baseRevisionId: editor.state.baseRevision.revisionId,
          ...editor.state.draft,
          saveReason: "Saved from the Web workflow editor.",
        },
      });
      editor.saveSucceeded(result.data.revision, result.etag);
      setSavedAt(result.data.revision.updatedAt);
      ui.pushToast(t("toast.workflowSaved"));
    } catch (error) {
      editor.saveFailed(error);
      ui.pushToast(messageForError(error), t("actions.retry"), () => saveWorkspace(idempotencyKey));
    }
  }

  function downloadUnsavedWorkflowDraft() {
    if (!editor.state?.draft || !selectedWorkflow) return false;
    const payload = {
      format: "looloomi-workflow-draft",
      exportedAt: new Date().toISOString(),
      workflowId: editor.state.workflowId,
      workflowName: selectedWorkflow.title,
      baseRevisionId: editor.state.baseRevision.revisionId,
      draft: editor.state.draft,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = globalThis.URL?.createObjectURL?.(blob);
    if (!url) return false;
    const safeName = String(selectedWorkflow.title || "workflow")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "workflow";
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeName}-unsaved-draft.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    globalThis.setTimeout?.(() => globalThis.URL.revokeObjectURL(url), 0);
    ui.pushToast(t("toast.workflowDraftDownloaded"));
    return true;
  }

  async function reloadLatestWorkflow() {
    if (!editor.state?.workflowId) return false;
    try {
      const result = await server.reloadWorkflow();
      if (!result?.data?.data?.currentRevisionId) throw new Error("workflow_reload_failed");
      ui.pushToast(t("toast.latestWorkflowLoaded"));
      return true;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), reloadLatestWorkflow);
      return false;
    }
  }

  async function compileSelectedWorkflow(retryKey) {
    if (!editor.state || editor.state.dirty) {
      ui.pushToast(t("error.save_before_compile"));
      return null;
    }
    const idempotencyKey = mutationKey(retryKey);
    editor.compileStarted();
    try {
      const result = await server.mutations.compile.mutateAsync({
        workflowId: editor.state.workflowId,
        revisionId: editor.state.baseRevision.revisionId,
        idempotencyKey,
      });
      editor.compileSucceeded(result.data);
      if (result.data.status !== "ready") ui.pushToast(t("error.workflow_execution_not_ready"));
      return result.data;
    } catch (error) {
      editor.compileFailed([{ code: error.code || "compile_failed", message: messageForError(error), severity: "error" }]);
      ui.pushToast(messageForError(error), t("actions.retry"), () => compileSelectedWorkflow(idempotencyKey));
      return null;
    }
  }

  async function generateBuilderProposal(instruction = composer, modelProfileRevisionId = "", retryKey) {
    const value = String(instruction || "").trim();
    if (!editor.state || selectedLoop?.type !== "LoopWorkflow" || !value) return null;
    if (editor.state.dirty) {
      setBuilderProposalError(t("builder.assistantSaveFirst"));
      return null;
    }
    const idempotencyKey = mutationKey(retryKey);
    setBuilderProposalError("");
    try {
      const result = await server.mutations.generateLoopProposal.mutateAsync({
        workflowId: editor.state.workflowId,
        ifMatch: editor.state.serverEtag,
        idempotencyKey,
        data: { instruction: value, ...(modelProfileRevisionId ? { modelProfileRevisionId } : {}) },
      });
      setBuilderProposal(result.data);
      setComposer("");
      return result.data;
    } catch (error) {
      setBuilderProposalError(messageForError(error));
      return null;
    }
  }

  async function applyBuilderProposal(retryKey) {
    if (!builderProposal || !editor.state?.serverEtag) return null;
    const idempotencyKey = mutationKey(retryKey);
    setBuilderProposalError("");
    try {
      const result = await server.mutations.applyLoopProposal.mutateAsync({
        workflowId: editor.state.workflowId,
        proposalId: builderProposal.proposalId,
        ifMatch: editor.state.serverEtag,
        idempotencyKey,
        data: { baseRevisionId: builderProposal.baseRevisionId },
      });
      editor.loadRevision(result.revision, result.etag);
      setBuilderProposal(null);
      ui.pushToast(t("toast.builderChangesApplied"));
      if (creationProposalContext?.workflowId === result.workflow.workflowId) {
        setCreationProposalContext(null);
        navigateToPage("builder", { loopId: result.workflow.workflowId });
      }
      return result;
    } catch (error) {
      setBuilderProposalError(messageForError(error));
      return null;
    }
  }

  async function dismissBuilderProposal(retryKey) {
    if (!builderProposal || !editor.state?.serverEtag) return null;
    const idempotencyKey = mutationKey(retryKey);
    setBuilderProposalError("");
    try {
      const result = await server.mutations.dismissLoopProposal.mutateAsync({
        workflowId: editor.state.workflowId,
        proposalId: builderProposal.proposalId,
        ifMatch: editor.state.serverEtag,
        idempotencyKey,
        data: { baseRevisionId: builderProposal.baseRevisionId },
      });
      setBuilderProposal(null);
      if (creationProposalContext?.workflowId === editor.state.workflowId) {
        const workflowId = creationProposalContext.workflowId;
        setCreationProposalContext(null);
        navigateToPage("builder", { loopId: workflowId });
      }
      return result.data;
    } catch (error) {
      setBuilderProposalError(messageForError(error));
      return null;
    }
  }

  async function publishSelectedLoop(details, retryKey) {
    if (!editor.state || editor.state.dirty) { ui.pushToast(t("error.save_before_compile")); return null; }
    const compile = await compileSelectedWorkflow(mutationKey());
    if (compile?.status !== "ready") return null;
    try {
      const result = await server.mutations.publishLoop.mutateAsync({
        workflowId: editor.state.workflowId,
        ifMatch: editor.state.serverEtag,
        idempotencyKey: mutationKey(retryKey),
        data: details,
      });
      ui.pushToast(t("toast.loopPublished"));
      navigateToPage("library-loop-detail", { loopId: editor.state.workflowId });
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => publishSelectedLoop(details, retryKey));
      return null;
    }
  }

  async function runLoop(loopId = selectedWorkflowId, retryOperation) {
    if (loopId !== selectedWorkflowId) {
      selectLoop(loopId);
      navigateToPage("run-preflight", { loopId });
      ui.pushToast(t("toast.openedForRun"));
      return;
    }
    const missing = (editor.state?.draft?.inputForm?.fields || []).filter((field) => field.required && !String(runInputs[field.fieldId] ?? "").trim());
    if (missing.length) {
      ui.pushToast(t("error.run_inputs_missing", { count: missing.length }));
      return;
    }
    const operation = retryOperation?.compileKey && retryOperation?.runKey
      ? retryOperation
      : { compileKey: mutationKey(), runKey: mutationKey() };
    const compile = await compileSelectedWorkflow(operation.compileKey);
    if (compile?.status !== "ready") return;
    try {
      const result = await server.mutations.startRun.mutateAsync({
        workflowId: editor.state.workflowId,
        idempotencyKey: operation.runKey,
        data: {
          workflowRevisionId: editor.state.baseRevision.revisionId,
          inputs: runInputs,
          resourceRefs: editor.state.draft.resourceRefs,
        },
      });
      setActiveRunId(result.data.runId);
      navigateToPage("runs", { loopId: editor.state.workflowId, runId: result.data.runId });
      ui.pushToast(t("toast.runStarted"));
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => runLoop(loopId, operation));
    }
  }

  async function createDraftFromActiveRun(retryKey) {
    if (!activeRun?.id) return null;
    const sourceTitle = selectedWorkflow?.title || t("runs.detailTitle");
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.createLoopDraftFromRun.mutateAsync({
        runId: activeRun.id,
        data: { name: t("workflow.fromRunName", { title: sourceTitle }) },
        idempotencyKey,
      });
      const { workflow, revision } = result.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.workflowFromRunCreated", { title: workflow.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => createDraftFromActiveRun(idempotencyKey));
      return null;
    }
  }

  async function submitReviewDecision(decision, comment = "", retryKey) {
    if (!activeRun?.reviewPacket?.nodeId) return;
    const idempotencyKey = mutationKey(retryKey);
    const reviewerComment = String(comment || "").trim();
    try {
      await server.mutations.review.mutateAsync({
        runId: activeRun.id,
        idempotencyKey,
        data: {
          nodeId: activeRun.reviewPacket.nodeId,
          decision,
          ...(reviewerComment ? { comment: reviewerComment } : {}),
          requestedChanges: decision === "revise" ? [reviewerComment || t("runs.revisionRequest")] : [],
        },
      });
      ui.pushToast(t(`toast.review.${decision}`));
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => submitReviewDecision(decision, reviewerComment, idempotencyKey));
    }
  }

  async function cancelActiveRun(retryKey) {
    if (!activeRun || terminalStatuses.has(activeRun.status)) return;
    const idempotencyKey = mutationKey(retryKey);
    try {
      await server.mutations.cancelRun.mutateAsync({
        runId: activeRun.id,
        idempotencyKey,
        data: { reason: t("runs.cancelReason") },
      });
      ui.pushToast(t("toast.runCancelled"));
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => cancelActiveRun(idempotencyKey));
    }
  }

  async function retryActiveRun(retryKey) {
    if (!activeRun || !terminalStatuses.has(activeRun.status)) return;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = activeRun.status === "completed"
        ? await server.mutations.startRun.mutateAsync({
            workflowId: activeRun.loopId,
            idempotencyKey,
            data: {
              workflowRevisionId: activeRun.workflowRevisionId,
              inputs: activeRun.canonical?.inputs || {},
              resourceRefs: activeRun.canonical?.resourceRefs || [],
            },
          })
        : await server.mutations.retryRun.mutateAsync({
            runId: activeRun.id,
            idempotencyKey,
            data: { reason: t("runs.retryReason") },
          });
      const retryRunId = result.data?.runId;
      if (retryRunId) {
        setActiveRunId(retryRunId);
        setComparisonRunId("");
        navigateToPage("runs", { loopId: activeRun.loopId, runId: retryRunId });
      }
      ui.pushToast(t(activeRun.status === "completed" ? "toast.runRepeated" : "toast.runRetried"));
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => retryActiveRun(idempotencyKey));
    }
  }

  async function installTeamRelease(releaseId, retryKey) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      await server.mutations.installTeamRelease.mutateAsync({
        releaseId,
        idempotencyKey,
        data: { connectionIds: [] },
      });
      ui.pushToast(t("toast.teamInstalled"));
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => installTeamRelease(releaseId, idempotencyKey));
    }
  }

  async function useTeamReleaseAsStartingPoint(releaseId, name, retryKey) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.useTeamReleaseAsStartingPoint.mutateAsync({
        releaseId,
        idempotencyKey,
        data: { name },
      });
      const { workflow, revision } = result.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.teamStartingPointCreated", { title: workflow.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => useTeamReleaseAsStartingPoint(releaseId, name, idempotencyKey));
      return null;
    }
  }

  async function forkTeamLoopRelease(releaseId, name, retryKey) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.forkTeamLoopRelease.mutateAsync({
        releaseId,
        idempotencyKey,
        data: { name },
      });
      const { workflow, revision } = result.data;
      setSelectedWorkflowId(workflow.workflowId);
      setBuilderSelection({ kind: "workflow", id: workflow.workflowId });
      editor.loadRevision(revision, result.etag);
      navigateToPage("builder", { loopId: workflow.workflowId });
      ui.pushToast(t("toast.teamForkCreated", { title: workflow.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => forkTeamLoopRelease(releaseId, name, idempotencyKey));
      return null;
    }
  }

  async function adoptTeamRelease(release, retryKey) {
    if (!release?.installation?.installationId) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      await server.mutations.adoptInstallationRelease.mutateAsync({
        installationId: release.installation.installationId,
        releaseId: release.releaseId,
        idempotencyKey,
      });
      ui.pushToast(t("toast.teamReleaseUpdated", { title: release.title }));
      return true;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => adoptTeamRelease(release, idempotencyKey));
      return null;
    }
  }

  async function inspectSkillPackage(details, retryKey, onProgress) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.inspectSkillPackage.mutateAsync({
        data: details,
        idempotencyKey,
        onProgress,
      });
      setPendingSkillPackage(result);
      ui.pushToast(t("toast.skillPackageChecked"));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => inspectSkillPackage(details, idempotencyKey, onProgress));
      return { failed: true, error, idempotencyKey };
    }
  }

  async function importSkillRepository(details, retryKey, onProgress) {
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.importSkillRepository.mutateAsync({
        data: details,
        idempotencyKey,
        onProgress,
      });
      setPendingSkillPackage(result);
      ui.pushToast(t("toast.skillPackageChecked"));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => importSkillRepository(details, idempotencyKey, onProgress));
      return { failed: true, error, idempotencyKey };
    }
  }

  async function createSkillDraftFromPackage({ permissionAcknowledged = false } = {}, retryKey) {
    if (!pendingSkillPackage) return null;
    const idempotencyKey = mutationKey(retryKey || pendingSkillPackage.idempotencyKey);
    try {
      const result = await server.mutations.createSkillFromInspectedPackage.mutateAsync({
        inspected: pendingSkillPackage,
        permissionAcknowledged,
        idempotencyKey,
      });
      const skillId = result.created.skill.skillId;
      setPendingSkillPackage(null);
      setCreateSkillDialogOpen(false);
      setSelectedManagedSkillId(skillId);
      navigateToPage("skill-overview", { skillId });
      ui.pushToast(t("toast.skillDraftCreated", { title: result.created.draft.name }));
      return result;
    } catch (error) {
      ui.pushToast(
        messageForError(error),
        t("actions.retry"),
        () => createSkillDraftFromPackage({ permissionAcknowledged }, idempotencyKey),
      );
      return null;
    }
  }

  async function saveSelectedSkillDraft(changes, retryKey) {
    if (!selectedSkillDraft || !selectedSkillDraftEtag) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.updateSkillDraft.mutateAsync({
        skillId: selectedSkillDraft.skillId,
        draftId: selectedSkillDraft.skillDraftId,
        data: changes,
        ifMatch: selectedSkillDraftEtag,
        idempotencyKey,
      });
      setSkillLifecycleByDraft((current) => ({ ...current, [skillLifecycleKey]: { testRun: null, validation: null } }));
      ui.pushToast(t("toast.skillDraftSaved"));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => saveSelectedSkillDraft(changes, idempotencyKey));
      return null;
    }
  }

  async function saveSelectedSkillPackage(data, retryKey, ifMatchOverride) {
    const expectedEtag = ifMatchOverride || selectedSkillDraftEtag;
    if (!selectedSkillDraft || !expectedEtag) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.replaceSkillDraftPackage.mutateAsync({
        skillId: selectedSkillDraft.skillId,
        draftId: selectedSkillDraft.skillDraftId,
        data,
        ifMatch: expectedEtag,
        idempotencyKey,
      });
      setSkillLifecycleByDraft((current) => ({
        ...current,
        [skillLifecycleKey]: { testRun: null, validation: null },
      }));
      ui.pushToast(t("toast.skillPackageSaved"));
      return result;
    } catch (error) {
      if (error?.code === "skill_draft_conflict") {
        return { conflict: true, message: messageForError(error) };
      }
      ui.pushToast(messageForError(error), t("actions.retry"), () => saveSelectedSkillPackage(data, idempotencyKey, expectedEtag));
      return null;
    }
  }

  async function loadLatestSkillPackageForConflict() {
    if (!selectedSkillDraft) return null;
    try {
      return await server.loadSkillDraftConflictSnapshot(
        selectedSkillDraft.skillId,
        selectedSkillDraft.skillDraftId,
      );
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), loadLatestSkillPackageForConflict);
      return null;
    }
  }

  async function runSelectedSkillTest(testCase, retryKey) {
    if (!selectedSkillDraft || !selectedSkillDraftEtag) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.runSkillTest.mutateAsync({
        skillId: selectedSkillDraft.skillId,
        draftId: selectedSkillDraft.skillDraftId,
        data: { testCase },
        ifMatch: selectedSkillDraftEtag,
        idempotencyKey,
      });
      setSkillLifecycleByDraft((current) => ({
        ...current,
        [skillLifecycleKey]: { testRun: result.data, validation: null },
      }));
      ui.pushToast(result.data.status === "passed" ? t("toast.skillTestPassed") : t("toast.skillTestNeedsAttention"));
      return result.data;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => runSelectedSkillTest(testCase, idempotencyKey));
      return null;
    }
  }

  async function validateSelectedSkill(retryKey) {
    const testRun = selectedSkillLifecycle.testRun;
    if (!selectedSkillDraft || !selectedSkillDraftEtag || testRun?.status !== "passed") return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.validateSkill.mutateAsync({
        skillId: selectedSkillDraft.skillId,
        draftId: selectedSkillDraft.skillDraftId,
        data: { testRunIds: [testRun.testRunId], permissionAcknowledged: true },
        ifMatch: selectedSkillDraftEtag,
        idempotencyKey,
      });
      setSkillLifecycleByDraft((current) => ({
        ...current,
        [skillLifecycleKey]: { testRun, validation: result.data },
      }));
      ui.pushToast(result.data.status === "passed" ? t("toast.skillValidated") : t("toast.skillValidationNeedsAttention"));
      return result.data;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => validateSelectedSkill(idempotencyKey));
      return null;
    }
  }

  async function publishSelectedSkill({ version, releaseNotes }, retryKey) {
    if (!selectedSkillDraft || !selectedSkillDraftEtag || selectedSkillLifecycle.validation?.status !== "passed") return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.publishSkill.mutateAsync({
        skillId: selectedSkillDraft.skillId,
        data: { version, releaseNotes },
        ifMatch: selectedSkillDraftEtag,
        idempotencyKey,
      });
      navigateToPage("skill-versions", { skillId: selectedSkillDraft.skillId });
      ui.pushToast(t("toast.skillPublished", { title: result.data.version.name }));
      return result.data;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => publishSelectedSkill({ version, releaseNotes }, idempotencyKey));
      return null;
    }
  }

  async function createSkillUpdateDraft(details, retryKey) {
    const skill = skillUpdateDialog;
    if (!skill) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.createSkillUpdateDraft.mutateAsync({
        skill,
        data: details,
        idempotencyKey,
      });
      setSkillUpdateDialog(null);
      setSelectedManagedSkillId(skill.id);
      navigateToPage("skill-editor", { skillId: skill.id });
      ui.pushToast(t("toast.skillUpdateDraftCreated", { title: result.draft.name }));
      return result;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => createSkillUpdateDraft(details, idempotencyKey));
      return null;
    }
  }

  async function retireSkill(reason, retryKey) {
    const skill = retireSkillDialog;
    if (!skill) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      await server.mutations.deprecateSkill.mutateAsync({
        skillId: skill.id,
        data: { reason },
        idempotencyKey,
      });
      setRetireSkillDialog(null);
      ui.pushToast(t("toast.skillRetired", { title: skill.title }));
      return true;
    } catch (error) {
      ui.pushToast(messageForError(error), t("actions.retry"), () => retireSkill(reason, idempotencyKey));
      return null;
    }
  }

  async function applyLoopSkillUpdate(
    preview = server.loopSkillUpdatePreview,
    connectionBindings = [],
    retryKey,
    { propagateConnectionError = false } = {},
  ) {
    if (!preview || !server.loopSkillUpdatePreviewEtag) return null;
    const idempotencyKey = mutationKey(retryKey);
    try {
      const result = await server.mutations.updateLoopSkill.mutateAsync({
        workflowId: preview.workflowId,
        ifMatch: server.loopSkillUpdatePreviewEtag,
        idempotencyKey,
        data: {
          skillId: preview.skillId,
          fromVersion: preview.currentVersion.version,
          toVersion: preview.targetVersion.version,
          connectionBindings,
        },
      });
      setSelectedWorkflowId(preview.workflowId);
      setBuilderSelection({ kind: "workflow", id: preview.workflowId });
      editor.loadRevision(result.data.revision, result.etag);
      navigateToPage("builder", { loopId: preview.workflowId });
      ui.pushToast(t("toast.workflowSkillUpdated", { title: result.data.workflow.name }));
      return result;
    } catch (error) {
      if (propagateConnectionError && ["connection_rebind_required", "connection_not_ready", "connection_binding_invalid"].includes(error?.code)) {
        throw error;
      }
      if (error?.code === "workflow_revision_conflict") {
        ui.pushToast(messageForError(error), t("actions.reloadReview"), server.reloadLoopSkillUpdatePreview);
        return null;
      }
      ui.pushToast(messageForError(error), t("actions.retry"), () => applyLoopSkillUpdate(preview, connectionBindings, idempotencyKey));
      return null;
    }
  }

  function updateSelectedNodeField(field, value) {
    if (selectedLoop?.type === "LoopTemplate" || !editor.state || !selectedNode) return;
    const canonical = selectedNode.canonical;
    let patch;
    if (field === "purpose") patch = { description: value };
    else if (field === "inputs") patch = { inputPorts: canonical.inputPorts.map((port, index) => ({ ...port, name: value[index] || port.name })) };
    else if (field === "outputs") patch = { outputPorts: canonical.outputPorts.map((port, index) => ({ ...port, name: value[index] || port.name })) };
    else if (field === "reviewPolicy") patch = {
      reviewPolicy: /no review/i.test(value)
        ? { mode: "none" }
        : { mode: "required", instructions: value || "Review before continuing." },
    };
    else if (field === "revisionTarget") {
      const configuration = { ...canonical.configuration };
      if (value) {
        const [nodeId, portId] = value.split("::");
        configuration.revisionTarget = { nodeId, portId };
        configuration.allowRevision = true;
      } else {
        delete configuration.revisionTarget;
      }
      patch = { configuration };
    }
    else patch = { [field]: value };
    editor.replaceDraft((draft) => updateDraftNode(draft, selectedNode.id, patch));
  }

  function updateLoopDefinition(field, value) {
    if (selectedLoop?.type === "LoopTemplate" || !editor.state) return;
    editor.replaceDraft((draft) => ({
      ...draft,
      definition: {
        goal: "",
        context: "",
        constraints: [],
        doneWhen: [],
        verify: [],
        expectedResult: selectedLoop?.description || selectedLoop?.title || "Result",
        stopRules: [],
        ...(draft.definition || {}),
        [field]: value,
      },
    }));
  }

  function updateRunSetting(field, value) {
    if (selectedLoop?.type === "LoopTemplate" || !editor.state) return;
    editor.replaceDraft((draft) => {
      const runSettings = { ...(draft.runSettings || {}) };
      if (value === "" || value === undefined || value === null) delete runSettings[field];
      else runSettings[field] = value;
      return { ...draft, runSettings };
    });
  }

  function updateSelectedNodeModel(modelProfileId) {
    if (selectedLoop?.type === "LoopTemplate" || !editor.state || !selectedNode) return;
    const configuration = { ...(selectedNode.canonical?.configuration || {}) };
    if (modelProfileId) configuration.modelProfileId = modelProfileId;
    else delete configuration.modelProfileId;
    editor.replaceDraft((draft) => updateDraftNode(draft, selectedNode.id, { configuration }));
  }

  return {
    ...ui,
    t,
    serverState: server,
    surfaceState: server.surfaceState,
    retrySurface: server.retrySurface,
    staleSurfaceError: server.staleSurfaceError,
    retryStaleSurface() { return server.retrySurface(server.staleSurfaceName); },
    loading: server.loading,
    error: server.error,
    retry: server.retry,
    session: server.session,
    membership: server.membership,
    membershipRole,
    readOnlyWorkspace,
    canWriteWorkspace: Boolean(membershipRole && membershipRole !== "viewer"),
    requestWorkspaceAccess,
    loops,
    teamLibrary,
    skills,
    knowledge: resources,
    resources,
    runs: runViews,
    resourcePalette,
    selectedLoop,
    selectedLoopId: selectedLoop?.id || "",
    selectedWorkflow,
    selectedWorkflowId,
    setSelectedLoopId: selectLoop,
    selectLoop,
    selectedSkill,
    selectedSkillId,
    setSelectedSkillId,
    managedSkills,
    selectedManagedSkill,
    selectedSkillDraft,
    selectedSkillDraftEtag,
    selectedSkillLifecycle,
    selectedManagedSkillId,
    setSelectedManagedSkillId,
    selectedKnowledgeId: selectedResourceId,
    setSelectedKnowledgeId: setSelectedResourceId,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId(nodeId) {
      if (selectedLoop?.type === "LoopTemplate") setTemplateNodeId(nodeId);
      else editor.selectNode(nodeId);
    },
    activeRun,
    activeRunId,
    comparisonRunId,
    activeRunComparison: server.runComparison,
    setActiveRunId(runId) { setActiveRunId(runId); setComparisonRunId(""); },
    compareActiveRunWith(runId) { if (runId && runId !== activeRunId) setComparisonRunId(runId); },
    clearRunComparison() { setComparisonRunId(""); },
    runStream,
    runInputs,
    setRunInput(fieldId, value) { setRunInputs((current) => ({ ...current, [fieldId]: value })); },
    selectedLoopIds,
    toggleLoopSelection(loopId) {
      setSelectedLoopIds((items) => items.includes(loopId) ? items.filter((id) => id !== loopId) : [...items, loopId]);
    },
    dirtyLoopIds,
    compilePreview,
    savedAt: savedAt || (!editor.state?.dirty ? editor.state?.baseRevision?.updatedAt || "" : ""),
    connectionStartNodeId,
    builderInitialTab,
    createLoopInitialMode,
    createLoopPrefill,
    openCreateLoop(mode = "goal", prefill = null) {
      setCreateLoopInitialMode(["goal", "blank", "starting", "upload", "duplicate"].includes(mode) ? mode : "goal");
      setCreateLoopPrefill(prefill && typeof prefill === "object" ? prefill : null);
      navigateToPage("create-loop");
    },
    openLoop(loopId) { selectLoop(loopId); navigateToPage("loop-overview", { loopId }); },
    openSkill(skillId, page = "skill-overview") {
      setSelectedManagedSkillId(skillId);
      navigateToPage(page, { skillId });
    },
    editLoop(loopId = selectedWorkflowId, tab = "definition") {
      selectLoop(loopId);
      setBuilderInitialTab(["definition", "outline", "canvas"].includes(tab) ? tab : "definition");
      navigateToPage("builder", { loopId });
    },
    prepareRun(loopId = selectedWorkflowId) {
      selectLoop(loopId);
      navigateToPage("run-preflight", { loopId });
    },
    openRun(runId) {
      if (!runId) return;
      setActiveRunId(runId);
      setComparisonRunId("");
      navigateToPage("runs", { loopId: selectedWorkflowId, runId });
    },
    openPublishReview(loopId = selectedWorkflowId) {
      selectLoop(loopId);
      navigateToPage("loop-publish", { loopId });
    },
    openLoopSkillUpdate(loopId, skillVersionId) {
      if (!loopId || !skillVersionId) return;
      selectLoop(loopId);
      navigateToPage("loop-update", { loopId, skillVersionId });
    },
    openLibraryLoop(loopId) { navigateToPage("library-loop-detail", { loopId }); },
    openLibrarySkill(skillId) { navigateToPage("library-skill-detail", { skillId }); },
    cloneLoop: useTemplate,
    duplicateWorkflow,
    duplicateSelectedWorkflow,
    createWorkflow,
    createWorkflowProposal,
    retryCreationProposal,
    creationProposalContext,
    openCreationDraft() {
      if (!creationProposalContext?.workflowId) return;
      const workflowId = creationProposalContext.workflowId;
      setCreationProposalContext(null);
      setBuilderProposal(null);
      navigateToPage("builder", { loopId: workflowId });
    },
    pendingSkillForNewWorkflow: pendingSkillAdd && !pendingSkillAdd.loopId ? pendingSkillAdd.skill : null,
    loopImportDialogOpen,
    openLoopImportDialog() { if (!readOnlyWorkspace) setLoopImportDialogOpen(true); },
    closeLoopImportDialog() { setLoopImportDialogOpen(false); },
    inspectPortableLoop,
    loadPortableLoopOptions,
    refreshPortableLoopImport,
    commitPortableLoopImport,
    exportSelectedLoop,
    publishSelectedLoop,
    createSkillDialogOpen,
    createSkillDialogMode,
    openCreateSkillDialog(mode = "create") {
      setCreateSkillDialogMode(["create", "files", "repository"].includes(mode) ? mode : "create");
      setCreateSkillDialogOpen(true);
    },
    closeCreateSkillDialog() { setCreateSkillDialogOpen(false); setPendingSkillPackage(null); },
    createResourceDialogOpen,
    openCreateResourceDialog() { setCreateResourceDialogOpen(true); },
    closeCreateResourceDialog() { setCreateResourceDialogOpen(false); },
    createTextResource,
    pendingSkillPackage,
    inspectSkillPackage,
    importSkillRepository,
    createSkillDraftFromPackage,
    saveSelectedSkillDraft,
    saveSelectedSkillPackage,
    loadLatestSkillPackageForConflict,
    reloadSelectedSkillDraft() {
      return server.reloadSkillDraft();
    },
    runSelectedSkillTest,
    validateSelectedSkill,
    publishSelectedSkill,
    skillUpdateDialog,
    retireSkillDialog,
    openSkillUpdateDialog(skill = selectedManagedSkill) {
      if (skill?.canonical?.version && skill?.canCreateUpdate) setSkillUpdateDialog(skill);
    },
    closeSkillUpdateDialog() { setSkillUpdateDialog(null); },
    openRetireSkillDialog(skill = selectedManagedSkill) { if (skill?.canRetire) setRetireSkillDialog(skill); },
    closeRetireSkillDialog() { setRetireSkillDialog(null); },
    createSkillUpdateDraft,
    retireSkill,
    loopSkillUpdatePreview: server.loopSkillUpdatePreview,
    loopSkillUpdatePreviewEtag: server.loopSkillUpdatePreviewEtag,
    applyLoopSkillUpdate,
    installTeamRelease,
    adoptTeamRelease,
    useTeamReleaseAsStartingPoint,
    forkTeamLoopRelease,
    handleLoopPrimary(loopId) {
      const loop = loops.find((item) => item.id === loopId);
      if (loop?.type === "LoopTemplate") useTemplate(loopId);
      else if (loop?.readiness === "Ready") { selectLoop(loopId); navigateToPage("run-preflight", { loopId }); }
      else { selectLoop(loopId); navigateToPage("builder", { loopId }); }
    },
    addSkillToLoop,
    addManagedSkillToLoop,
    addPaletteItemToLoop,
    addResourceToLoop,
    reorderWorkflowNode(fromIndex, toIndex) {
      if (editor.state) editor.replaceDraft((draft) => reorderDraftNode(draft, fromIndex, toIndex));
    },
    removeWorkflowNode(nodeId = selectedNodeId) {
      if (selectedLoop?.type === "LoopTemplate") return;
      editor.replaceDraft((draft) => deleteDraftNode(draft, nodeId));
    },
    updateSelectedNodeField,
    updateLoopDefinition,
    updateRunSetting,
    updateSelectedNodeModel,
    updateNodePosition(nodeId, position) {
      if (selectedLoop?.type !== "LoopTemplate") editor.replaceDraft((draft) => moveDraftNode(draft, nodeId, position));
    },
    startNodeConnection(nodeId) { setConnectionStartNodeId(nodeId); },
    cancelNodeConnection() { setConnectionStartNodeId(""); },
    completeNodeConnection(nodeId) {
      if (selectedLoop?.type !== "LoopTemplate" && connectionStartNodeId) {
        editor.replaceDraft((draft) => connectDraftNodes(draft, connectionStartNodeId, nodeId, idFactory));
        setConnectionStartNodeId("");
      }
    },
    connectWorkflowNodes(fromNodeId, toNodeId) {
      if (selectedLoop?.type === "LoopTemplate") return;
      if (fromNodeId === toNodeId) { setConnectionStartNodeId(""); return; }
      editor.replaceDraft((draft) => connectDraftNodes(draft, fromNodeId, toNodeId, idFactory));
      setConnectionStartNodeId("");
    },
    compileSelectedWorkflow,
    runLoop,
    createDraftFromActiveRun,
    runSelectedLoops() { runLoop(selectedWorkflowId); },
    submitReviewDecision,
    cancelActiveRun,
    retryActiveRun,
    saveWorkspace,
    downloadUnsavedWorkflowDraft,
    reloadLatestWorkflow,
    canSaveWorkflow: Boolean(editor.state?.dirty && editor.state.serverEtag),
    canRunWorkflow: Boolean(selectedLoop?.type === "LoopWorkflow" && !editor.state?.dirty && !readOnlyWorkspace),
    editorState: editor.state,
    builderAssistantAvailable: true,
    builderAssistantBusy: server.mutations.generateLoopProposal.isPending || server.mutations.applyLoopProposal.isPending || server.mutations.dismissLoopProposal.isPending,
    builderProposalError,
    chatScope: "builder",
    setChatScope() {},
    chatMessages: [],
    composer,
    setComposer,
    sendChat: generateBuilderProposal,
    pendingPatch: builderProposal,
    dismissBuilderPatch: dismissBuilderProposal,
    applyBuilderPatch: applyBuilderProposal,
    createKnowledge() { ui.pushToast(t("feature.resourcesUnavailable")); },
    attachKnowledge() { addResourceToLoop(); },
    selectedKnowledge: resources.find((item) => item.resourceId === selectedResourceId) || null,
    workflowCreationAvailable: true,
    skillCreationAvailable: true,
    runTerminal: activeRun ? terminalStatuses.has(activeRun.status) : false,
  };
}
