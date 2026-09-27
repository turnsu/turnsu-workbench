import { useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronDown, GitBranch, Play, Plus, Save, Trash2 } from "lucide-react";
import { Button, TextArea as ControlTextArea, TextInput as ControlTextInput } from "../../design-system/index.jsx";
import { WorkflowModelSettings } from "../models/WorkflowModelSettings.jsx";
import { inputSourceOptions } from "../../state/editor/workflowDraftActions.js";
import { productTitle } from "../../utils/productCopy.js";
import "./workflow-document.css";

const copy = {
  zh: {
    method: "可复用的工作方法", brief: "工作说明", steps: "执行步骤", test: "试运行", advanced: "高级画布",
    intro: "说明要完成什么，安排需要的步骤，再用一次真实输入检查结果。",
    goal: "每次要完成什么", outcome: "期望得到的结果", done: "怎样才算完成", context: "背景与约束",
    background: "背景资料", constraints: "必须遵守", verify: "检查方法", stop: "何时停下来询问",
    optional: "补充说明", stepsHint: "每一步选择需要的内容来源；执行先后由这些依赖决定。",
    add: "添加步骤", library: "选择已发布技能", empty: "还没有可用技能。先在技能库发布一个技能。",
    source: "内容来源", choose: "选择内容来源", missing: "请补齐内容来源", bound: "来源已配置",
    savedBinding: "保留现有设置", unavailable: "当前来源不可用，请重新选择", outputs: "产出", settings: "编辑这一步",
    title: "步骤名称", purpose: "这一步做什么", review: "完成后需要人工复核", reviewInstructions: "复核说明",
    reviewDefault: "确认结果符合本次任务要求后再继续。", remove: "移除步骤", required: "必填", input: "运行时填写",
    tryHint: "提供一份实际材料，结果会在任务中打开。", current: "当前执行环境", runtime: "Turnsu 托管 Agent",
    saveRun: "保存并试运行", running: "正在准备…", dirty: "有未保存的修改", saved: "已保存", save: "保存草稿",
    publish: "发布版本", publishHint: "试运行通过后，再发布可重复使用的版本。", inputLabel: "材料名称",
    noInput: "这个工作流无需额外输入。", model: "运行设置", modelHint: "托管 Agent 使用的模型与限制",
    conflict: "工作流已被更新。先下载自己的修改，再重新载入最新版本。", download: "下载我的修改",
    reload: "重新载入", confirmReload: "放弃本地修改并载入", template: "这是模板；创建自己的工作流后才能编辑。",
    noSteps: "添加一个技能，开始安排执行步骤。", noSources: "没有可选来源。添加输入，或检查其他步骤的产出。",
    addInput: "添加输入", addReview: "添加人工复核", addOutput: "添加结果", versions: "保存与发布",
  },
  en: {
    method: "A reusable way of working", brief: "Instructions", steps: "Steps", test: "Try it", advanced: "Advanced canvas",
    intro: "Describe the outcome, arrange the steps, then check the result with a real input.",
    goal: "What should happen each time?", outcome: "Expected result", done: "What counts as done?", context: "Context and constraints",
    background: "Background", constraints: "Constraints", verify: "How to verify", stop: "When to ask for help", optional: "More detail",
    stepsHint: "Choose the source of each step’s input. These dependencies determine execution order.",
    add: "Add a step", library: "Choose a published skill", empty: "No skills available. Publish a skill in the library first.",
    source: "Input source", choose: "Choose a source", missing: "Choose input sources", bound: "Sources configured",
    savedBinding: "Keep existing setting", unavailable: "Source unavailable — choose again", outputs: "Produces", settings: "Edit this step",
    title: "Step name", purpose: "What this step does", review: "Require a human review", reviewInstructions: "Review instructions",
    reviewDefault: "Confirm the result meets the task requirements before continuing.", remove: "Remove step", required: "Required", input: "Provided at run time",
    tryHint: "Use a real example. The result opens in a task.", current: "Execution environment", runtime: "Turnsu managed Agent",
    saveRun: "Save and try", running: "Preparing…", dirty: "Unsaved changes", saved: "Saved", save: "Save draft",
    publish: "Publish version", publishHint: "Test the workflow before publishing a reusable version.", inputLabel: "Input name",
    noInput: "This workflow requires no additional input.", model: "Run settings", modelHint: "Model and limits for the managed Agent",
    conflict: "This workflow has changed. Download your edits, then reload the latest version.", download: "Download my edits",
    reload: "Reload latest", confirmReload: "Discard local edits and reload", template: "This is a template. Create your own workflow to edit it.",
    noSteps: "Add a skill to start arranging the work.", noSources: "No available sources. Add an input or check other steps’ outputs.",
    addInput: "Add input", addReview: "Add human review", addOutput: "Add result", versions: "Save and publish",
  },
};
const lines = (value) => Array.isArray(value) ? value.join("\n") : value || "";
const splitLines = (value) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const sourceValue = (source) => JSON.stringify([source.nodeId, source.portId]);
const TextArea = (props) => <ControlTextArea hiddenLabel={false} {...props} />;
const TextInput = (props) => <ControlTextInput hiddenLabel={false} {...props} />;

function LineList({ value, onChange, ...props }) {
  const [text, setText] = useState(lines(value));
  useEffect(() => { setText(lines(value)); }, [value]);
  return <TextArea {...props} value={text} onChange={setText} onBlur={() => onChange(splitLines(text))} rows={2} width="100%" />;
}

export function WorkflowDocumentView({ workspace, availableSkills, onOpenCanvas, initialSection }) {
  const c = copy[workspace.locale?.startsWith("zh") ? "zh" : "en"];
  const loop = workspace.selectedLoop;
  const draft = workspace.editorState?.draft || loop.canonicalRevision;
  const graph = draft?.graph || { nodes: [], edges: [] };
  const definition = draft?.definition || {};
  const [expanded, setExpanded] = useState(initialSection === "outline" ? workspace.selectedNodeId : "");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const isTemplate = loop.type === "LoopTemplate";
  const dirty = Boolean(workspace.editorState?.dirty);
  const readOnly = isTemplate || workspace.readOnlyWorkspace;
  const conflict = Boolean(workspace.editorState?.conflict);
  const fields = draft?.inputForm?.fields || [];
  const missingInputs = fields.some((field) => field.required && !String(workspace.runInputs[field.fieldId] ?? "").trim());
  const update = (field, value) => workspace.updateLoopDefinition(field, value);

  async function tryWorkflow() {
    if (busy) return;
    setBusy(true);
    try { await workspace.saveAndRunWorkflow(); } finally { setBusy(false); }
  }

  return <section className="workflowDocument" data-testid="loopops.workflow-document">
    <header className="methodHeader">
      <div>
        <button type="button" className="methodBack" onClick={() => workspace.openLoop(loop.id)}><ArrowLeft size={14} />{workspace.t("nav.loops")}</button>
        <div className="methodTitle"><h1>{productTitle(loop, workspace.locale)}</h1><span>{workspace.t("builder.draftLabel")}</span></div>
        <p className="methodSaveState" role="status">{dirty ? c.dirty : c.saved}</p>
      </div>
      <div className="methodHeaderActions">
        <Button variant="ghost" icon={<GitBranch size={15} />} disabled={busy} onClick={onOpenCanvas} data-testid="loopops.builder.tab.canvas">{c.advanced}</Button>
        <Button variant="secondary" icon={<Save size={15} />} disabled={!workspace.canSaveWorkflow || busy || readOnly} onClick={workspace.saveWorkspace} data-testid="loopops.topbar.primary.save-workflow">{c.save}</Button>
      </div>
    </header>
    {conflict ? <div className="methodConflict" role="alert"><p>{c.conflict}</p><div className="buttonRow">
      <Button variant="secondary" onClick={workspace.downloadUnsavedWorkflowDraft}>{c.download}</Button>
      <Button variant={confirmReload ? "destructive" : "secondary"} onClick={() => confirmReload ? workspace.reloadLatestWorkflow() : setConfirmReload(true)}>{confirmReload ? c.confirmReload : c.reload}</Button>
    </div></div> : null}
    {isTemplate ? <p className="methodNotice">{c.template}</p> : null}
    <div className="methodLayout">
      <div className="methodContent">
        <section className="methodSection">
          <div className="methodSectionHeading"><span>01</span><div><h2>{c.brief}</h2><p>{c.intro}</p></div></div>
          <fieldset disabled={readOnly || busy}>
            <TextArea label={c.goal} value={definition.goal || ""} onChange={(value) => update("goal", value)} rows={3} width="100%" />
            <TextArea label={c.outcome} value={definition.expectedResult || ""} onChange={(value) => update("expectedResult", value)} rows={2} width="100%" />
            <LineList label={c.done} value={definition.doneWhen} onChange={(value) => update("doneWhen", value)} />
            <details className="methodMore"><summary>{c.context}<ChevronDown size={14} /></summary><div>
              <TextArea label={c.background} value={definition.context || ""} onChange={(value) => update("context", value)} rows={2} width="100%" />
              {[['constraints', c.constraints], ['verify', c.verify], ['stopRules', c.stop]].map(([key, label]) => <LineList key={key} label={label} value={definition[key]} onChange={(value) => update(key, value)} />)}
            </div></details>
          </fieldset>
        </section>
        <section className="methodSection" data-testid="loopops.builder.outline">
          <div className="methodSectionHeading"><span>02</span><div><h2>{c.steps}</h2><p>{c.stepsHint}</p></div></div>
          <div className="methodStepList">
            {graph.nodes.map((node) => {
              const missing = node.inputPorts.some((port) => port.required && !node.inputBindings.some((binding) => binding.targetPort === port.portId));
              const open = expanded === node.nodeId;
              return <article className={`methodStep ${open ? "expanded" : ""}`} key={node.nodeId}>
                <button type="button" className="methodStepToggle" aria-expanded={open} aria-controls={`step-${node.nodeId}`} onClick={() => setExpanded(open ? "" : node.nodeId)}>
                  <span className="methodStepIcon">{node.kind === "Input" ? "↳" : node.kind === "Output" ? <Check size={15} /> : "·"}</span>
                  <span><strong>{node.title}</strong><small>{node.kind === "Input" ? c.input : missing ? c.missing : node.inputPorts.length ? c.bound : workspace.t(`nodeType.${node.kind.toLowerCase()}`)}</small></span>
                  <ChevronDown size={16} />
                </button>
                {open ? <fieldset id={`step-${node.nodeId}`} disabled={readOnly || busy} className="methodStepFields">
                  <TextInput label={c.title} value={node.title} onChange={(title) => workspace.updateWorkflowStep(node.nodeId, { title })} width="100%" />
                  <TextArea label={c.purpose} value={node.description || ""} onChange={(description) => workspace.updateWorkflowStep(node.nodeId, { description })} rows={3} width="100%" />
                  {node.kind === "Input" ? fields.filter((field) => node.configuration?.fieldIds?.includes(field.fieldId)).map((field) => <TextInput key={field.fieldId} label={c.inputLabel} value={field.label} onChange={(label) => workspace.updateWorkflowInputLabel(field.fieldId, label)} width="100%" />) : null}
                  {node.inputPorts.map((port) => {
                    const binding = node.inputBindings.find((item) => item.targetPort === port.portId)?.source;
                    const options = inputSourceOptions(graph, node.nodeId, port.portId);
                    const current = binding?.kind === "nodeOutput" ? sourceValue(binding) : binding ? "preserve" : "";
                    const available = options.some((option) => sourceValue(option) === current);
                    return <label className="methodSource" key={port.portId}><span>{port.name || port.portId} · {c.source}{port.required ? " *" : ""}</span>
                      <select value={current} onChange={(event) => {
                        if (event.target.value === "preserve") return;
                        const [nodeId, portId] = event.target.value ? JSON.parse(event.target.value) : [];
                        workspace.bindWorkflowInput(node.nodeId, port.portId, nodeId ? { nodeId, portId } : null);
                      }}>
                        <option value="">{c.choose}</option>
                        {binding && binding.kind !== "nodeOutput" ? <option value="preserve">{c.savedBinding}</option> : null}
                        {binding?.kind === "nodeOutput" && !available ? <option value={current} disabled>{c.unavailable}</option> : null}
                        {options.map((option) => <option key={sourceValue(option)} value={sourceValue(option)}>{option.nodeTitle} → {option.name}</option>)}
                      </select>
                      {!options.length ? <small>{c.noSources}</small> : null}
                    </label>;
                  })}
                  {node.outputPorts.length ? <p className="methodProduces">{c.outputs}: {node.outputPorts.map((port) => port.name || port.portId).join(" / ")}</p> : null}
                  <label className="methodReview"><input type="checkbox" checked={node.reviewPolicy.mode === "required"} disabled={node.kind === "ReviewGate"} onChange={(event) => workspace.updateWorkflowStep(node.nodeId, { reviewPolicy: event.target.checked ? { mode: "required", instructions: c.reviewDefault } : { mode: "none" } })} />{c.review}</label>
                  {node.reviewPolicy.mode === "required" ? <TextArea label={c.reviewInstructions} value={node.reviewPolicy.instructions || ""} onChange={(instructions) => workspace.updateWorkflowStep(node.nodeId, { reviewPolicy: { ...node.reviewPolicy, instructions } })} rows={2} width="100%" /> : null}
                  {!readOnly ? <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => workspace.removeWorkflowNode(node.nodeId)}>{c.remove}</Button> : null}
                </fieldset> : null}
              </article>;
            })}
            {!graph.nodes.length ? <p>{c.noSteps}</p> : null}
          </div>
          {!readOnly ? <div className="methodAdd">
            <Button variant="secondary" icon={<Plus size={15} />} aria-expanded={libraryOpen} disabled={busy} onClick={() => setLibraryOpen(!libraryOpen)}>{c.add}</Button>
            {libraryOpen ? <div className="methodLibrary"><h3>{c.library}</h3>
              {availableSkills.map((skill) => <button type="button" key={skill.id} disabled={busy} onClick={() => { skill.paletteSource === "workspace" ? workspace.addManagedSkillToLoop(skill.id) : workspace.addSkillToLoop(skill.id); setLibraryOpen(false); }}><span><strong>{skill.title}</strong><small>{skill.description}</small></span><Plus size={16} /></button>)}
              {!availableSkills.length ? <p>{c.empty}</p> : null}
              <div className="methodAddControls">{[['palette-inputs', c.addInput], ['palette-controls', c.addReview], ['palette-outputs', c.addOutput]].map(([groupId, label]) => <Button key={groupId} variant="ghost" disabled={busy} onClick={() => { const group = workspace.resourcePalette.find((entry) => entry.id === groupId); workspace.addPaletteItemToLoop({ title: group.items[0], groupId }); setLibraryOpen(false); }}>{label}</Button>)}</div>
            </div> : null}
          </div> : null}
        </section>
        <details className="methodMore methodRunSettings"><summary><span>{c.model}<small>{c.modelHint}</small></span><ChevronDown size={14} /></summary><div><WorkflowModelSettings settings={draft?.runSettings || {}} onChange={workspace.updateRunSetting} t={workspace.t} disabled={readOnly || busy} /></div></details>
      </div>
      <aside className="methodTry">
        <div className="methodSectionHeading"><span>03</span><div><h2>{c.test}</h2><p>{c.tryHint}</p></div></div>
        <div className="methodRuntime"><span>{c.current}</span><strong>{c.runtime}</strong></div>
        <fieldset disabled={busy || readOnly}>
          {fields.map((field) => <TextArea key={field.fieldId} label={`${field.label}${field.required ? " *" : ""}`} value={workspace.runInputs[field.fieldId] || ""} onChange={(value) => workspace.setRunInput(field.fieldId, value)} placeholder={field.description || field.label} rows={5} width="100%" />)}
          {!fields.length ? <p>{c.noInput}</p> : null}
        </fieldset>
        <Button variant="primary" icon={<Play size={15} />} disabled={busy || readOnly || conflict || missingInputs || (!workspace.canRunWorkflow && !workspace.canSaveWorkflow)} onClick={tryWorkflow} data-testid="loopops.builder.mock-run">{busy ? c.running : dirty ? c.saveRun : c.test}</Button>
        {workspace.compilePreview?.diagnostics?.length ? <ul className="methodDiagnostics" role="status">{workspace.compilePreview.diagnostics.map((item, i) => <li key={i}>{item.message}</li>)}</ul> : null}
        <div className="methodPublish"><h3>{c.versions}</h3><p>{c.publishHint}</p><Button variant="secondary" disabled={dirty || busy || readOnly} onClick={() => workspace.openPublishReview(loop.id)} data-testid="loopops.builder.publish">{c.publish}</Button></div>
      </aside>
    </div>
  </section>;
}
