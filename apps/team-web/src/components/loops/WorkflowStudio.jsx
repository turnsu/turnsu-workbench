import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, CircleAlert, FileText, LoaderCircle, Play, Plus, Redo2, Save, Search, Settings2, Trash2, Undo2, X } from "lucide-react";
import { WorkflowModelSettings, NodeModelOverride } from "../models/WorkflowModelSettings.jsx";
import { AgentMarkdown } from "../agents/AgentMarkdown.js";
import { useLoopTaskRun } from "../../state/agents/useLoopTaskRun.js";
import { inputSourceOptions } from "../../state/editor/workflowDraftActions.js";
import { productTitle } from "../../utils/productCopy.js";
import { WorkflowGraphCanvas, nodeIcon, nodeKindLabel } from "./WorkflowGraphCanvas.jsx";
import "./workflow-studio.css";

const sourceKey = (source) => JSON.stringify([source.nodeId, source.portId]);
const statusLabel = (status, zh) => ({ completed: zh ? "已完成" : "Completed", failed: zh ? "失败" : "Failed", running: zh ? "正在运行" : "Running", queued: zh ? "排队中" : "Queued", waiting_review: zh ? "等待复核" : "Awaiting review", cancelled: zh ? "已取消" : "Cancelled", partial: zh ? "部分完成" : "Partial" }[status] || status);
function Field({ label, value, onChange, rows, ...props }) {
  return <label className="studioField"><span>{label}</span>{rows ? <textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} {...props} /> : <input type="text" value={value} onChange={(event) => onChange(event.target.value)} {...props} />}</label>;
}
function Lines({ value, onChange, label }) {
  const [text, setText] = useState((value || []).join("\n"));
  useEffect(() => setText((value || []).join("\n")), [value]);
  return <Field label={label} value={text} onChange={setText} rows={3} onBlur={() => onChange(text.split("\n").map((line) => line.trim()).filter(Boolean))} />;
}

export function WorkflowStudio({ workspace }) {
  const zh = workspace.locale?.startsWith("zh");
  const loop = workspace.selectedLoop;
  const state = workspace.editorState;
  const draft = state?.draft || loop?.canonicalRevision;
  const graph = draft?.graph || { nodes: [], edges: [] };
  const fields = draft?.inputForm?.fields || [];
  const [panel, setPanel] = useState(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [runTab, setRunTab] = useState("inputs");
  const [submitted, setSubmitted] = useState(null);
  const [chosenRunId, setChosenRunId] = useState("");
  const [runError, setRunError] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const closeRef = useRef(null);
  const readonly = workspace.readOnlyWorkspace || loop?.type === "LoopTemplate";
  const dirty = Boolean(state?.dirty);
  const saving = state?.saveStatus === "saving";
  const locked = readonly || busy || saving || Boolean(state?.conflict);
  const node = panel === "node" ? graph.nodes.find((entry) => entry.nodeId === workspace.selectedNodeId) : null;
  const workflowRuns = workspace.runs.filter((run) => run.loopId === loop?.id);
  const latest = workflowRuns[0];
  const runId = chosenRunId || submitted?.run.runId || latest?.id || "";
  const run = useLoopTaskRun({ source: { kind: "loop_run", runId } }, Boolean(runId));
  const currentRun = run.detail?.run;
  const currentResult = run.detail?.readModel;
  const currentVersion = currentRun?.workflowRevisionId === state?.baseRevision.revisionId && !dirty;
  const nodeStatuses = currentVersion ? Object.fromEntries((currentRun?.nodeRuns || []).map((item) => [item.nodeId, item.status])) : {};
  const running = Boolean(currentRun && !run.terminal);
  const missingInputs = fields.some((field) => field.required && !String(workspace.runInputs[field.fieldId] ?? "").trim());
  const skills = useMemo(() => {
    const entries = new Map(workspace.skills.map((skill) => [skill.id, { ...skill, managed: false }]));
    workspace.managedSkills.filter((skill) => skill.canAddToWorkflow).forEach((skill) => entries.set(skill.id, { ...skill, managed: true }));
    return [...entries.values()];
  }, [workspace.skills, workspace.managedSkills]);
  const visibleSkills = skills.filter((skill) => `${skill.title} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => { if (panel) closeRef.current?.focus(); }, [panel]);
  useEffect(() => { if (panel === "node" && !node) setPanel(null); }, [node, panel]);
  useEffect(() => { setPanel(null); setSubmitted(null); setChosenRunId(""); }, [loop?.id]);

  function selectNode(id) {
    if (!id) { setPanel(null); return; }
    workspace.setSelectedNodeId(id); setPanel("node");
  }
  function addControl(groupId) {
    const group = workspace.resourcePalette.find((entry) => entry.id === groupId);
    if (!group) return;
    workspace.addPaletteItemToLoop({ groupId, title: group.items[0] }, nextPosition());
    setPanel("node");
  }
  function nextPosition() {
    const positions = graph.nodes.map((item) => item.position).filter(Boolean);
    return { x: Math.max(0, ...positions.map((item) => item.x)) + (positions.length ? 340 : 64), y: 80 };
  }
  function addSkill(skill) {
    const fn = skill.managed ? workspace.addManagedSkillToLoop : workspace.addSkillToLoop;
    fn(skill.id, loop.id, nextPosition()); setPanel("node");
  }
  async function startRun() {
    if (locked || missingInputs || running) return;
    setBusy(true); setRunError(false);
    try {
      const result = await workspace.saveAndRunWorkflow({ stayInBuilder: true });
      if (result?.data?.run) { setSubmitted(result.data); setChosenRunId(result.data.run.runId); setRunTab("result"); }
      else setRunError(true);
    } finally { setBusy(false); }
  }
  const panelTitle = node ? node.title : ({ add: zh ? "添加步骤" : "Add a step", brief: zh ? "流程说明" : "Workflow brief", settings: zh ? "运行设置" : "Run settings", run: zh ? "试运行" : "Test run" }[panel] || "");
  const selectedSkill = node?.kind === "Skill" ? skills.find((skill) => skill.id === node.skillRef?.skillId) : null;
  const execution = selectedSkill?.canonical?.execution || selectedSkill?.canonical?.definition?.execution
    || selectedSkill?.canonical?.version?.execution || selectedSkill?.canonical?.draft?.execution;
  const modelBacked = selectedSkill?.executionMode === "model" || execution?.executionMode === "model"
    || execution?.mode === "model" || Boolean(node?.configuration?.modelProfileId);
  const modelCapability = selectedSkill?.requiredModelCapability || execution?.requiredModelCapability
    || execution?.requiredCapability || execution?.capability || node?.configuration?.requiredModelCapability || "chat";

  return <section className="workflowStudio" data-testid="loopops.workflow-studio" onKeyDown={(event) => {
    if (event.key === "Escape" && panel) setPanel(null);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.target.closest('input, textarea, select, [contenteditable]') && !locked) {
      event.preventDefault(); event.shiftKey ? workspace.redoWorkflow() : workspace.undoWorkflow();
    }
  }}>
    <header className="studioHeader">
      <button type="button" className="studioBack" aria-label={zh ? "返回工作流" : "Back to workflows"} onClick={() => workspace.openLoop(loop.id)}><ArrowLeft size={18} /></button>
      <div className="studioIdentity"><h1>{productTitle(loop, workspace.locale)}</h1><span role="status">{saving ? zh ? "保存中…" : "Saving…" : dirty ? zh ? "有未保存修改" : "Unsaved changes" : <><Check size={12} />{zh ? "已保存" : "Saved"}</>}</span></div>
      <div className="studioHeaderActions">
        <button type="button" className="studioIconButton" aria-label={zh ? "撤销" : "Undo"} disabled={locked || !state?.past?.length} onClick={workspace.undoWorkflow}><Undo2 size={16} /></button>
        <button type="button" className="studioIconButton" aria-label={zh ? "重做" : "Redo"} disabled={locked || !state?.future?.length} onClick={workspace.redoWorkflow}><Redo2 size={16} /></button>
        <button type="button" className="studioSave" disabled={locked || !workspace.canSaveWorkflow} onClick={workspace.saveWorkspace}><Save size={15} /><span>{zh ? "保存" : "Save"}</span></button>
        <button type="button" className={`studioPrimary ${panel === 'run' ? 'active' : ''}`} disabled={readonly} aria-expanded={panel === "run"} onClick={() => setPanel(panel === "run" ? null : "run")}><Play size={14} />{zh ? "试运行" : "Test run"}</button>
      </div>
    </header>
    {state?.conflict ? <div className="studioConflict" role="alert"><span>{zh ? "服务器上已有新版本。请先保留自己的修改，再载入最新版本。" : "This workflow has changed. Preserve your edits before reloading."}</span><button type="button" onClick={workspace.downloadUnsavedWorkflowDraft}>{zh ? "下载修改" : "Download edits"}</button><button type="button" onClick={() => confirmReload ? workspace.reloadLatestWorkflow() : setConfirmReload(true)}>{confirmReload ? zh ? "放弃修改并载入" : "Discard and reload" : zh ? "载入最新版本" : "Reload"}</button></div> : null}
    <div className="studioToolbar">
      <button type="button" className={panel === 'add' ? 'active' : ''} disabled={locked} onClick={() => { setPanel(panel === "add" ? null : "add"); setQuery(""); }} aria-expanded={panel === "add"}><Plus size={16} />{zh ? "添加步骤" : "Add step"}</button>
      <button type="button" className={panel === 'brief' ? 'active' : ''} onClick={() => setPanel(panel === "brief" ? null : "brief")} aria-expanded={panel === "brief"}><FileText size={15} />{zh ? "流程说明" : "Brief"}</button>
      <button type="button" className={panel === 'settings' ? 'active' : ''} onClick={() => setPanel(panel === "settings" ? null : "settings")} aria-expanded={panel === "settings"}><Settings2 size={15} />{zh ? "运行设置" : "Settings"}</button>
      <span className="studioGraphCount">{zh ? `${graph.nodes.length} 个步骤 · ${graph.edges.length} 条连接` : `${graph.nodes.length} steps · ${graph.edges.length} connections`}</span>
    </div>
    <div className={`studioBody ${panel ? "panelOpen" : ""}`}>
      <div className="studioCanvasSlot">
        <WorkflowGraphCanvas graph={graph} locale={workspace.locale} selectedNodeId={panel === 'node' ? node?.nodeId : null} onSelect={selectNode}
          onMove={workspace.updateNodePosition} onBind={workspace.bindWorkflowInput} onArrange={workspace.arrangeWorkflowNodes}
          onAdd={() => setPanel("add")} readOnly={locked} nodeStatuses={nodeStatuses} />
        <div className="studioMobileSteps">{graph.nodes.map((entry) => <button key={entry.nodeId} type="button" onClick={() => selectNode(entry.nodeId)}>{entry.title}</button>)}</div>
      </div>
      {panel ? <aside className={`studioPanel panel-${panel}`} aria-label={panelTitle}>
        <header className="studioPanelHeader"><div><small>{node ? nodeKindLabel(node.kind, zh) : zh ? "工作流" : "Workflow"}</small><h2>{panelTitle}</h2></div><button ref={closeRef} type="button" aria-label={zh ? "关闭面板" : "Close panel"} onClick={() => setPanel(null)}><X size={18} /></button></header>
        <div className="studioPanelContent">
          {panel === "add" ? <>
            <label className="studioSearch"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索技能或步骤" : "Search skills and steps"} aria-label={zh ? "搜索技能或步骤" : "Search skills and steps"} /></label>
            <h3>{zh ? "基础步骤" : "Basic steps"}</h3>
            {[["palette-inputs", "Input", zh ? "输入" : "Input", zh ? "每次运行时提供的材料" : "Materials provided at run time"], ["palette-controls", "ReviewGate", zh ? "人工复核" : "Human review", zh ? "等待确认后继续" : "Wait for a decision"], ["palette-outputs", "Output", zh ? "结果" : "Output", zh ? "选择工作流最终交付物" : "The final deliverable"]].filter((entry) => !query || `${entry[2]} ${entry[3]}`.toLowerCase().includes(query.toLowerCase())).map(([group, kind, title, description]) => { const Icon = nodeIcon(kind); return <button type="button" className="studioLibraryItem" key={group} disabled={locked} onClick={() => addControl(group)}><span className={`studioLibraryIcon kind-${kind}`}><Icon size={17} /></span><span><strong>{title}</strong><small>{description}</small></span><Plus size={15} /></button>; })}
            <h3>{zh ? "已发布技能" : "Published skills"}</h3>
            {visibleSkills.map((skill) => <button type="button" className="studioLibraryItem" key={skill.id} disabled={locked} onClick={() => addSkill(skill)}><span className="studioLibraryIcon kind-Skill"><Plus size={17} /></span><span><strong>{skill.title}</strong><small>{skill.description}</small></span><Plus size={15} /></button>)}
            {!visibleSkills.length ? <p>{zh ? "没有匹配的已发布技能。" : "No matching published skills."}</p> : null}
            {workspace.resources.length ? <><h3>{zh ? "资料" : "Materials"}</h3>{workspace.resources.filter((resource) => resource.label.toLowerCase().includes(query.toLowerCase())).map((resource) => <button type="button" className="studioLibraryItem" key={resource.resourceId} disabled={locked} onClick={() => { workspace.addResourceToLoop(resource, nextPosition()); setPanel("node"); }}><FileText size={17} /><span><strong>{resource.label}</strong></span><Plus size={15} /></button>)}</> : null}
          </> : null}
          {node ? <fieldset disabled={locked}>
            <Field label={zh ? "步骤名称" : "Step name"} value={node.title} onChange={(title) => workspace.updateWorkflowStep(node.nodeId, { title })} />
            <Field label={zh ? "这一步做什么" : "Instructions"} rows={4} value={node.description || ""} onChange={(description) => workspace.updateWorkflowStep(node.nodeId, { description })} />
            {node.kind === "Input" ? fields.filter((field) => node.configuration?.fieldIds?.includes(field.fieldId)).map((field) => <Field key={field.fieldId} label={zh ? "运行时显示的输入名称" : "Run input label"} value={field.label} onChange={(label) => workspace.updateWorkflowInputLabel(field.fieldId, label)} />) : null}
            {node.inputPorts.length ? <h3>{zh ? "输入来源" : "Input sources"}</h3> : null}
            {node.inputPorts.map((port) => {
              const source = node.inputBindings.find((binding) => binding.targetPort === port.portId)?.source;
              const options = inputSourceOptions(graph, node.nodeId, port.portId);
              const value = source?.kind === "nodeOutput" ? sourceKey(source) : source ? "preserve" : "";
              return <label className="studioField" key={port.portId}><span>{port.name}{port.required ? " *" : ""}<small>{port.schema.type}</small></span><select value={value} onChange={(event) => { if (event.target.value === "preserve") return; const [nodeId, portId] = event.target.value ? JSON.parse(event.target.value) : []; workspace.bindWorkflowInput(node.nodeId, port.portId, nodeId ? { nodeId, portId } : null); }}>
                <option value="">{zh ? "未连接" : "Not connected"}</option>
                {source && source.kind !== "nodeOutput" ? <option value="preserve">{zh ? "保留现有绑定" : "Keep existing binding"}</option> : null}
                {source?.kind === "nodeOutput" && !options.some((option) => sourceKey(option) === value) ? <option value={value} disabled>{zh ? "来源不可用" : "Source unavailable"}</option> : null}
                {options.map((option) => <option value={sourceKey(option)} key={sourceKey(option)}>{option.nodeTitle} → {option.name}</option>)}
              </select></label>;
            })}
            {node.outputPorts.length ? <><h3>{zh ? "输出" : "Outputs"}</h3><div className="studioOutputPorts">{node.outputPorts.map((port) => <span key={port.portId}>{port.name}<small>{port.schema.type}</small></span>)}</div></> : null}
            <details className="studioAdvanced"><summary>{zh ? "复核与模型设置" : "Review and model settings"}<ChevronDown size={14} /></summary><div>
              <label className="studioCheck"><input type="checkbox" checked={node.reviewPolicy.mode === "required"} disabled={node.kind === "ReviewGate"} onChange={(event) => workspace.updateWorkflowStep(node.nodeId, { reviewPolicy: event.target.checked ? { mode: "required", instructions: zh ? "确认结果符合任务要求后再继续。" : "Confirm the result before continuing." } : { mode: "none" } })} />{zh ? "完成后需要人工复核" : "Require human review"}</label>
              {node.reviewPolicy.mode === "required" ? <Field label={zh ? "复核说明" : "Review instructions"} rows={3} value={node.reviewPolicy.instructions || ""} onChange={(instructions) => workspace.updateWorkflowStep(node.nodeId, { reviewPolicy: { ...node.reviewPolicy, instructions } })} /> : null}
              {modelBacked ? <NodeModelOverride capability={modelCapability} value={node.configuration?.modelProfileId || ""} onChange={workspace.updateSelectedNodeModel} t={workspace.t} disabled={locked} /> : null}
            </div></details>
            <button type="button" className="studioRemove" onClick={() => { workspace.removeWorkflowNode(node.nodeId); setPanel(null); }}><Trash2 size={14} />{zh ? "移除步骤" : "Remove step"}</button>
          </fieldset> : null}
          {panel === "brief" ? <fieldset disabled={locked}>
            <p>{zh ? "流程的共同目标。具体处理方式在各步骤里修改。" : "The workflow goal. Edit individual instructions in each step."}</p>
            <Field label={zh ? "目标" : "Goal"} rows={5} value={draft?.definition?.goal || ""} onChange={(value) => workspace.updateLoopDefinition("goal", value)} />
            <Field label={zh ? "预期结果" : "Expected result"} rows={3} value={draft?.definition?.expectedResult || ""} onChange={(value) => workspace.updateLoopDefinition("expectedResult", value)} />
            <details className="studioAdvanced"><summary>{zh ? "背景与完成标准" : "Context and completion criteria"}<ChevronDown size={14} /></summary><div>
              <Field label={zh ? "背景" : "Context"} rows={3} value={draft?.definition?.context || ""} onChange={(value) => workspace.updateLoopDefinition("context", value)} />
              {[["doneWhen", zh ? "完成标准" : "Done when"], ["constraints", zh ? "约束" : "Constraints"], ["verify", zh ? "检查方式" : "Verification"], ["stopRules", zh ? "停止条件" : "Stop conditions"]].map(([key, label]) => <Lines key={key} value={draft?.definition?.[key]} label={label} onChange={(value) => workspace.updateLoopDefinition(key, value)} />)}
            </div></details>
          </fieldset> : null}
          {panel === "settings" ? <><p>{zh ? "当前工作流使用 Turnsu 托管 Agent。" : "This workflow uses the Turnsu managed Agent."}</p><WorkflowModelSettings settings={draft?.runSettings || {}} onChange={workspace.updateRunSetting} disabled={locked} t={workspace.t} /><div className="studioPublish"><h3>{zh ? "发布版本" : "Publish version"}</h3><p>{zh ? "保存并验证后，进入发布检查。" : "Save and verify before the publishing check."}</p><button type="button" disabled={dirty || locked} onClick={() => workspace.openPublishReview(loop.id)}>{zh ? "发布检查" : "Publishing check"}</button></div></> : null}
          {panel === "run" ? <>
            <div className="studioRunTabs" role="tablist" aria-label={zh ? "试运行内容" : "Test run content"}><button type="button" role="tab" aria-selected={runTab === 'inputs'} onClick={() => setRunTab('inputs')}>{zh ? "运行输入" : "Inputs"}</button><button type="button" role="tab" aria-selected={runTab === 'result'} onClick={() => setRunTab('result')}>{zh ? "运行结果" : "Results"}{running ? <LoaderCircle size={12} className="studioSpinner" /> : null}</button></div>
            {runTab === "result" && workflowRuns.length > 1 ? <label className="studioField studioRunHistory"><span>{zh ? "运行记录" : "Run history"}</span><select disabled={running || busy} value={runId} onChange={(event) => setChosenRunId(event.target.value)}>{!workflowRuns.some((item) => item.id === runId) ? <option value={runId}>{zh ? "本次运行" : "Current run"}</option> : null}{workflowRuns.map((item, index) => <option key={item.id} value={item.id}>{index === 0 ? zh ? "最近 · " : "Latest · " : ""}{statusLabel(item.status, zh)} · {new Date(item.startedAt).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</option>)}</select></label> : null}
            {runTab === "inputs" ? <><p>{zh ? "用一份实际材料检查这条流程。未保存的修改会先保存为新版本。" : "Test with real materials. Unsaved changes are saved as a new revision first."}</p><fieldset disabled={locked || running}>{fields.map((field) => <Field key={field.fieldId} label={`${field.label}${field.required ? ' *' : ''}`} rows={7} value={workspace.runInputs[field.fieldId] || ""} onChange={(value) => workspace.setRunInput(field.fieldId, value)} placeholder={zh ? `在此输入${field.label}` : `Enter ${field.label}`} />)}{!fields.length ? <p>{zh ? "无需额外输入。" : "No additional inputs required."}</p> : null}</fieldset>
              <button type="button" className="studioPrimary studioStartRun" disabled={locked || missingInputs || running || (!workspace.canRunWorkflow && !workspace.canSaveWorkflow)} onClick={startRun}>{busy ? <LoaderCircle size={15} className="studioSpinner" /> : <Play size={14} />}{busy ? zh ? "正在准备…" : "Preparing…" : dirty ? zh ? "保存并试运行" : "Save and run" : zh ? "开始试运行" : "Start run"}</button>
              {runError ? <p role="alert" className="studioRunError">{zh ? "试运行未启动。请按错误提示修正后重试。" : "The run did not start. Resolve the reported issue and retry."}</p> : null}
            </> : run.loading ? <p role="status">{zh ? "正在读取运行…" : "Loading run…"}</p> : run.error ? <div role="alert"><p>{zh ? "暂时无法读取结果。" : "Could not load the result."}</p><button type="button" onClick={run.retry}>{zh ? "重新加载" : "Retry"}</button></div> : !currentRun ? <div className="studioNoResult"><Play size={24} /><p>{zh ? "还没有试运行结果" : "No test results yet"}</p><button type="button" onClick={() => setRunTab("inputs")}>{zh ? "填写运行输入" : "Provide inputs"}</button></div> : <>
              <div className={`studioRunStatus status-${currentRun.status}`}><span>{running ? <LoaderCircle size={15} className="studioSpinner" /> : currentRun.status === "completed" ? <Check size={15} /> : <CircleAlert size={15} />}{statusLabel(currentRun.status, zh)}</span><small>{currentVersion ? zh ? "当前保存版本" : "Current saved revision" : zh ? "之前版本的结果" : "Earlier revision"}</small></div>
              <ol className="studioRunSteps">{(currentResult?.nodeTimeline || []).map((item) => <li key={`${item.nodeId}:${item.attempt}`}><span className={`studioStepDot status-${item.status}`} /><span>{graph.nodes.find((entry) => entry.nodeId === item.nodeId)?.title || item.summary}</span><small>{statusLabel(item.status, zh)}</small></li>)}</ol>
              {currentResult?.failure ? <p className="studioRunError" role="alert">{zh && currentResult.failure.message === "The workflow could not complete." ? "这次运行未完成。请查看失败步骤，检查设置后重试。" : currentResult.failure.message}</p> : null}
              {currentResult?.finalAnswer?.content ? <div className="studioResult"><h3>{zh ? "最终结果" : "Final result"}</h3><AgentMarkdown content={currentResult.finalAnswer.content} locale={workspace.locale} /></div> : null}
              {currentRun.status === "waiting_review" ? <button type="button" onClick={() => workspace.openRun(currentRun.runId)}>{zh ? "打开运行，处理复核" : "Open run to review"}</button> : null}
              {running ? <button type="button" disabled={run.cancelling} onClick={() => Promise.resolve(run.cancel(zh ? "用户从工作流编辑器停止试运行" : "Stopped from workflow editor")).catch(() => setRunError(true))}>{zh ? "停止运行" : "Stop run"}</button> : <button type="button" onClick={() => setRunTab("inputs")}>{zh ? "调整输入，再试一次" : "Try another input"}</button>}
            </>}
            {workspace.compilePreview?.diagnostics?.length ? <ul className="studioRunError" role="status">{workspace.compilePreview.diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul> : null}
          </> : null}
        </div>
      </aside> : null}
    </div>
  </section>;
}
