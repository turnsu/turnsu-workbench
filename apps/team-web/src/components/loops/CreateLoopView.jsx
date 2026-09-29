import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, CircleDashed, FileInput, FileOutput, WandSparkles, ClipboardCheck, FileText } from "lucide-react";
import { Button } from "../shared/Button.jsx";
import { ModelSwitch } from "../models/ModelSwitch.jsx";
import { useWorkbenchNavigation } from "../shell/WorkbenchNavigation.jsx";
import { defaultModelSelection, useModelCatalog } from "../../state/models/index.js";

const EMPTY_FORM = { name: "", goal: "", expectedResult: "", context: "", constraints: "", doneWhen: "", verify: "", stopRules: "" };
const lines = (value) => String(value || "").split("\n").map((item) => item.trim()).filter(Boolean);
const initialMode = (value) => value === "blank" ? "blank" : "goal";

// A readable layout of the proposed graph, not an execution plan. Parallel
// branches keep their source order and disconnected/cyclic nodes remain visible.
function reviewNodes(graph) {
  const remaining = [...(graph?.nodes || [])];
  const ordered = [];
  while (remaining.length) {
    const index = remaining.findIndex((node) => !(graph.edges || []).some((edge) => edge.targetNodeId === node.nodeId && remaining.some((source) => source.nodeId === edge.sourceNodeId)));
    if (index < 0) return [...ordered, ...remaining];
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

export function CreateLoopView({ workspace }) {
  const t = workspace.t;
  const copy = (zh, en) => workspace.locale === "zh" ? zh : en;
  const navigation = useWorkbenchNavigation();
  const [mode, setMode] = useState(initialMode(workspace.createLoopInitialMode));
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [builderModelProfileId, setBuilderModelProfileId] = useState("");
  const [validationAttempted, setValidationAttempted] = useState(false);
  const builderModels = useModelCatalog({ capabilities: ["chat", "tool_calling"], context: "builder", selectionKind: "profile", selectedProfileId: builderModelProfileId });
  const readiness = workspace.creationReadiness?.actions || {};
  const gate = mode === "blank" ? readiness.blankLoop?.draftable : readiness.stagedLoopProposal?.draftable;
  const modelReady = builderModels.options.some((option) => option.value === builderModelProfileId && !option.disabled);
  const pending = busy || workspace.builderAssistantBusy;
  const maySubmit = !pending && !workspace.readOnlyWorkspace && gate?.status === "ready" && (mode === "blank" || modelReady);
  const failed = Boolean(workspace.creationProposalContext && workspace.builderProposalError);

  useEffect(() => {
    const prefill = workspace.createLoopPrefill;
    if (prefill) setForm((current) => ({ ...current, ...prefill, goal: String(prefill.goal || "").trim(), name: String(prefill.name || "").trim().slice(0, 72) }));
  }, [workspace.createLoopPrefill]);
  useEffect(() => {
    if (!workspace.creationProposalContext && !workspace.pendingPatch) setMode(initialMode(workspace.createLoopInitialMode));
  }, [workspace.createLoopInitialMode, workspace.creationProposalContext, workspace.pendingPatch]);
  useEffect(() => {
    if (!builderModelProfileId && builderModels.profiles.length) setBuilderModelProfileId(defaultModelSelection(builderModels.profiles, "tool_calling", "profile"));
  }, [builderModelProfileId, builderModels.profiles]);

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); setValidationAttempted(false); }
  function details() {
    return { name: form.name.trim() || form.goal.trim().split(/[.!?。！？\n]/)[0].slice(0, 72) || copy("新的工作流", "New workflow"),
      goal: mode === "blank" ? t("loopCreate.blankGoal") : form.goal.trim(), expectedResult: form.expectedResult.trim(), context: form.context.trim(),
      constraints: lines(form.constraints), doneWhen: lines(form.doneWhen), verify: lines(form.verify), stopRules: lines(form.stopRules) };
  }
  async function create(event) {
    event.preventDefault();
    if (!(mode === "blank" ? form.name.trim() : form.goal.trim())) { setValidationAttempted(true); return; }
    if (!maySubmit) return;
    setBusy(true);
    try {
      if (mode === "goal") await workspace.createWorkflowProposal(details(), builderModelProfileId);
      else await workspace.createWorkflow(details());
    } finally { setBusy(false); }
  }
  function updateDefinition(field, value) {
    const draft = workspace.creationProposalDraft;
    if (draft) workspace.updateCreationProposalDraft({ definition: { ...draft.definition, [field]: ["constraints", "doneWhen", "verify", "stopRules"].includes(field) ? lines(value) : value } });
  }
  function updateNodeTitle(nodeId, title) {
    const draft = workspace.creationProposalDraft;
    if (draft) workspace.updateCreationProposalDraft({ graph: { ...draft.graph, nodes: draft.graph.nodes.map((node) => node.nodeId === nodeId ? { ...node, title } : node) } });
  }
  function recovery() {
    if (gate?.reasonCode === "model_route_unresolved") navigation?.openSettings?.();
    else if (gate?.recoveryRoute) workspace.navigateToPath(gate.recoveryRoute);
  }
  function gateMessage() {
    if (!gate) return copy("正在检查可用能力…", "Checking availability…");
    if (gate.reasonCode === "model_route_unresolved") return copy("还没有可用的模型。请在设置中连接模型，或联系管理员为你启用。", "No model is available. Connect one in Settings or ask your administrator to enable it.");
    if (gate.status === "forbidden") return copy("当前账号只有查看权限。请联系工作空间管理员。", "Your account has view-only access. Contact your workspace administrator.");
    return copy("工作流生成服务暂时不可用。你可以保留描述，稍后重试，或手动创建草稿。", "Workflow generation is unavailable. Keep your description and try again later, or create a draft manually.");
  }
  function errorMessage() {
    const message = workspace.builderProposalError;
    return message === "The Workbench request could not be completed."
      ? copy("生成暂时失败，你的描述仍然保留。请重试。", "Generation failed. Your description is preserved; please try again.") : message;
  }
  const back = <button className="loopCreateBack" type="button" onClick={() => workspace.setActivePage("loops")}><ArrowLeft size={16} />{copy("工作流", "Workflows")}</button>;

  if (workspace.creationProposalContext && workspace.pendingPatch) {
    const proposal = workspace.pendingPatch;
    const draft = workspace.creationProposalDraft || proposal.draft;
    const definition = draft?.definition || details();
    const nodeLabels = { Input: copy("提供资料", "Input"), Output: copy("返回结果", "Output"), Skill: copy("技能处理", "Skill"), Transform: copy("整理资料", "Transform"), ReviewGate: copy("人工确认", "Review"), Material: copy("参考资料", "Material") };
    const nodeIcons = { Input: FileInput, Output: FileOutput, Skill: WandSparkles, Transform: WandSparkles, ReviewGate: ClipboardCheck, Material: FileText };
    return <div className="turnsuLoopCreate turnsuLoopReview" data-testid="loopops.create-loop.proposal-review">
      {back}
      <header><p className="loopCreateEyebrow">{copy("检查草稿", "Review draft")}</p><h1>{copy("先看清楚，再开始运行", "Review it before running")}</h1><p>{copy("检查目标和步骤，保存后再补充配置、试跑。", "Review the goal and steps, then save and test the workflow.")}</p></header>
      <p className="loopDraftNotice"><CircleDashed size={16} />{copy("尚未保存或运行。保存后只有你能看到这份草稿。", "Not saved or run yet. The saved draft is private to you.")}</p>
      {workspace.builderProposalError ? <p className="loopCreateStatus" role="alert">{errorMessage()}</p> : null}
      {(proposal.diagnostics || []).length > 0 ? <section className="loopProposalDiagnostics" aria-label={copy("需要留意", "Needs attention")}>
        {proposal.diagnostics.map((item, index) => <div key={`${item.code}-${index}`} role={item.severity === "error" ? "alert" : "status"}><strong>{copy(item.severity === "error" ? "需要修改" : "还需补充", item.severity === "error" ? "Changes needed" : "Still needed")}</strong><p>{item.message}</p>{item.recoveryAction ? <small>{item.recoveryAction}</small> : null}</div>)}
      </section> : null}
      <section className="loopReviewDefinition">
        <label className="createField"><span>{copy("工作流名称", "Workflow name")}</span><input disabled={pending || workspace.readOnlyWorkspace} value={draft?.name || ""} onChange={(event) => workspace.updateCreationProposalDraft({ name: event.target.value })} /></label>
        {proposal.summary ? <details className="loopCreateDetails"><summary>{copy("查看生成说明", "How this draft was generated")}<ChevronDown size={16} /></summary><p>{proposal.summary}</p></details> : null}
        <details className="loopCreateDetails"><summary>{copy("目标与补充说明", "Goal and details")}<ChevronDown size={16} /></summary><div>
          <label className="createField"><span>{copy("目标", "Goal")}</span><textarea rows={4} value={definition.goal || ""} onChange={(event) => updateDefinition("goal", event.target.value)} /></label>
          <label className="createField"><span>{copy("需要的资料", "Required information")}</span><textarea rows={2} value={definition.context || ""} onChange={(event) => updateDefinition("context", event.target.value)} /></label>
          <label className="createField"><span>{copy("限制和暂停条件", "Constraints and stop conditions")}</span><textarea rows={2} value={(definition.constraints || []).join("\n")} onChange={(event) => updateDefinition("constraints", event.target.value)} /></label>
        </div></details>
      </section>
      <section className="loopReviewSteps"><h2>{copy("建议步骤", "Proposed steps")}</h2><ul>{reviewNodes(draft?.graph).map((node, index) => {
        const Icon = nodeIcons[node.kind] || CircleDashed;
        const sources = (draft.graph.edges || []).filter((edge) => edge.targetNodeId === node.nodeId).map((edge) => draft.graph.nodes.find((source) => source.nodeId === edge.sourceNodeId)?.title).filter(Boolean);
        return <li key={node.nodeId}><span className="loopStepIcon"><Icon size={16} /></span><div><input disabled={pending || workspace.readOnlyWorkspace} aria-label={copy(`步骤名称 ${index + 1}`, `Step name ${index + 1}`)} value={node.title} onChange={(event) => updateNodeTitle(node.nodeId, event.target.value)} /><p>{node.description || nodeLabels[node.kind] || node.kind}</p>{sources.length ? <small className="loopStepSource">{copy("接收：", "Receives: ")}{[...new Set(sources)].join(" · ")}</small> : null}</div><small>{nodeLabels[node.kind] || node.kind}</small></li>;
      })}</ul></section>
      <footer className="loopReviewActions"><Button variant="plain" disabled={pending || workspace.readOnlyWorkspace} onClick={workspace.dismissBuilderPatch} data-testid="loopops.create-loop.proposal-dismiss">{copy("放弃草稿", "Discard draft")}</Button><Button variant="primary" disabled={pending || workspace.readOnlyWorkspace || proposal.status !== "proposed" || !draft?.name?.trim() || !definition.goal?.trim()} onClick={workspace.applyBuilderPatch} data-testid="loopops.create-loop.proposal-apply">{pending ? copy("正在保存…", "Saving…") : copy("保存草稿，继续编辑", "Save draft and continue")}</Button></footer>
    </div>;
  }

  return <div className="turnsuLoopCreate" data-testid="loopops.create-loop.page">
    {back}
    <header><p className="loopCreateEyebrow">{copy("新建工作流", "New workflow")}</p><h1>{mode === "goal" ? copy("把重复的工作交给 Turnsu", "Let Turnsu handle recurring work") : copy("从一个空白草稿开始", "Start with a blank draft")}</h1><p>{mode === "goal" ? copy("描述你想完成的任务，先生成一份可检查、可修改的草稿。", "Describe the task to get a draft you can review and edit.") : copy("给工作流起个名字，再自行添加步骤。", "Name the workflow, then add its steps.")}</p></header>
    <div className="loopCreateModes" role="group" aria-label={copy("创建方式", "Creation method")}><button type="button" aria-pressed={mode === "goal"} disabled={pending} onClick={() => setMode("goal")} data-testid="loopops.create-loop.entry.document">{copy("描述任务", "Describe a task")}</button><button type="button" aria-pressed={mode === "blank"} disabled={pending} onClick={() => setMode("blank")} data-testid="loopops.create-loop.entry.blank">{copy("手动创建", "Create manually")}</button></div>
    {workspace.stagedProposalRestoreFailedId ? <section className="loopCreateStatus" role="alert"><strong>{copy("无法恢复这份草稿", "This draft could not be restored")}</strong><p>{errorMessage()}</p><Button variant="secondary" onClick={workspace.retryStagedProposalRestore}>{t("actions.retry")}</Button><Button variant="plain" onClick={workspace.clearStaleCreationProposal}>{copy("重新描述任务", "Start a new draft")}</Button></section> : null}
    <form onSubmit={create} aria-busy={pending}>
      <fieldset disabled={pending || workspace.readOnlyWorkspace} className="loopCreateFields">
        {mode === "goal" ? <>
          <label className="createField loopCreateGoal"><span>{copy("你想重复完成什么任务？", "What task would you like to repeat?")}</span><textarea value={form.goal} onChange={(event) => update("goal", event.target.value)} placeholder={copy("例如：把团队每周的试用反馈整理成三项改进建议，保留原话依据，按影响排序。", "For example: turn the team's weekly feedback into three prioritized improvements, with quotes as evidence.")} rows={6} aria-invalid={validationAttempted && !form.goal.trim()} data-testid="loopops.create-loop.document" autoFocus />{validationAttempted && !form.goal.trim() ? <small role="alert">{copy("请先描述你想完成的任务。", "Describe the task first.")}</small> : null}</label>
          <details className="loopCreateDetails"><summary>{copy("补充说明（可选）", "More details (optional)")}<ChevronDown size={16} /></summary><div>
            <label className="createField"><span>{copy("工作流名称", "Workflow name")}</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={copy("不填则根据任务自动命名", "Leave blank to name it from the task")} /></label>
            <label className="createField"><span>{copy("每次需要提供的资料", "Information needed each time")}</span><textarea rows={2} value={form.context} onChange={(event) => update("context", event.target.value)} placeholder={copy("例如：本周的反馈原文和产品版本", "For example: this week's feedback and product version")} /></label>
            <label className="createField"><span>{copy("限制和暂停条件", "Constraints and stop conditions")}</span><textarea rows={2} value={form.constraints} onChange={(event) => update("constraints", event.target.value)} placeholder={copy("例如：缺少依据时询问我，不自动向外发送", "For example: ask when evidence is missing; do not send externally")} /></label>
          </div></details>
        </> : <label className="createField"><span>{copy("工作流名称", "Workflow name")}</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={copy("例如：每周反馈整理", "For example: weekly feedback review")} aria-invalid={validationAttempted && !form.name.trim()} data-testid="loopops.create-loop.name" />{validationAttempted && !form.name.trim() ? <small role="alert">{copy("请输入工作流名称。", "Enter a workflow name.")}</small> : null}</label>}
      </fieldset>
      {(!gate || gate.status !== "ready") ? <section className="loopCreateStatus" role="status"><p>{gateMessage()}</p>{gate?.recoveryRoute ? <Button type="button" variant="secondary" onClick={recovery}>{gate.reasonCode === "model_route_unresolved" ? copy("打开设置", "Open settings") : copy("查看恢复方式", "Recovery options")}</Button> : null}</section> : null}
      {failed ? <section className="loopCreateStatus" role="alert" data-testid="loopops.create-loop.proposal-error"><strong>{copy("草稿还没有生成", "The draft was not generated")}</strong><p>{errorMessage()}</p><div className="buttonRow"><Button type="button" variant="secondary" disabled={pending} onClick={workspace.retryCreationProposal} data-testid="loopops.create-loop.proposal-retry">{copy("重新生成", "Try again")}</Button><Button type="button" variant="plain" disabled={pending || readiness.blankLoop?.draftable?.status !== "ready"} onClick={workspace.openCreationDraft}>{copy("保存为手动草稿", "Save a manual draft")}</Button></div></section> : null}
      <footer className="loopCreateActions">{mode === "goal" ? <ModelSwitch options={builderModels.options} selectionKind="profile" requiredCapabilities={["chat", "tool_calling"]} value={builderModelProfileId} onChange={setBuilderModelProfileId} disabled={pending} label={copy("生成草稿的模型", "Draft model")} loading={builderModels.isLoading} unavailableLabel={t("model.unavailable")} historicalLabel={t("model.historical")} groupLabels={{ text: t("model.groupText"), image: t("model.groupImage") }} testId="loopops.create-loop.model" /> : <span />}<Button type="submit" variant="primary" disabled={!maySubmit} data-testid="loopops.create-loop.submit">{pending ? copy("正在准备草稿…", "Preparing draft…") : mode === "goal" ? copy("生成草稿", "Generate draft") : copy("创建空白草稿", "Create blank draft")}</Button></footer>
      <p className="loopCreateFootnote">{pending ? copy("正在整理目标和步骤，通常需要一点时间。", "Organizing the goal and steps. This can take a moment.") : copy("草稿默认私有；确认并试跑后，再决定是否自动执行。", "Drafts are private. Review and test before enabling automatic runs.")}</p>
    </form>
  </div>;
}
