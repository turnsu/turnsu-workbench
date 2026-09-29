import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, RefreshCw } from "lucide-react";
import { workbenchApi, isTerminalRunStatus } from "../../api/client.js";
import { AgentMarkdown } from "../agents/AgentMarkdown.js";
import { Button } from "../../design-system/index.jsx";
import "./work-item-loops.css";

const operationId = () => `team-loop-${crypto.randomUUID()}`;
const statusText = (status, zh) => ({ queued: ["排队中", "Queued"], running: ["正在执行", "Running"], completed: ["结果待验收", "Result ready for review"], failed: ["执行失败", "Failed"], cancelled: ["已取消", "Cancelled"], cancellation_requested: ["正在取消", "Cancelling"], waiting_review: ["等待复核", "Awaiting review"], partial: ["部分完成", "Partial"], effect_outcome_unknown: ["外部操作待核对", "Reconciliation required"] }[status]?.[zh ? 0 : 1] || status);

export function WorkItemLoops({ workspace, item, canRun }) {
  const zh = workspace.locale.startsWith("zh");
  const [viewingRunId, setViewingRunId] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [prepared, setPrepared] = useState(null);
  const [inputs, setInputs] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const creation = useRef(null);
  const invocation = useRef(null);
  const principal = workspace.principal;
  const runs = useQuery({ queryKey: ["workbench", "work-item-loop-runs", principal, item.workItemId],
    queryFn: () => workbenchApi.listWorkItemLoopRuns(item.workItemId), refetchInterval: 5000 });
  const catalog = useQuery({ queryKey: ["workbench", "team-loop-picker", principal], enabled: choosing,
    queryFn: async () => {
      const [releases, workflows] = await Promise.all([workbenchApi.listTeamLibrary({ limit: 100 }), workbenchApi.listWorkflows()]);
      return releases.data.filter((release) => release.assetKind === "loop").map((release) => ({ ...release, name: workflows.data.find((flow) => flow.workflowId === release.assetId)?.name || (zh ? "团队工作流" : "Team workflow") }));
    } });

  async function prepare(release) {
    setBusy(true); setError("");
    if (creation.current?.releaseId !== release.releaseId) creation.current = { releaseId: release.releaseId, key: operationId() };
    try {
      const copy = await workbenchApi.createLoopFromRelease(release.releaseId, {}, { idempotencyKey: creation.current.key });
      setPrepared({ release, ...copy.data });
      setInputs(Object.fromEntries(copy.data.revision.inputForm.fields.filter((field) => field.schema?.type === "boolean").map((field) => [field.fieldId, false])));
      invocation.current = null; setChoosing(false);
    } catch (cause) { setError(cause?.message || (zh ? "无法准备工作流，请重试。" : "Could not prepare this workflow.")); }
    finally { setBusy(false); }
  }

  async function execute(event) {
    event.preventDefault();
    if (!prepared || busy) return;
    setBusy(true); setError("");
    const data = { workflowId: prepared.workflow.workflowId, workflowRevisionId: prepared.revision.revisionId,
      inputs, resourceRefs: prepared.revision.resourceRefs, materialBindings: [], shareFinalOutput: true };
    const digest = JSON.stringify(data);
    if (invocation.current?.digest !== digest) invocation.current = { digest, key: operationId() };
    try {
      const key = invocation.current.key;
      const compile = await workbenchApi.compileWorkflow(data.workflowId, data.workflowRevisionId, { idempotencyKey: `${key}:compile` });
      if (compile.data.status !== "ready") throw new Error(compile.data.warnings?.find((warning) => warning.severity === "error")?.message || (zh ? "请先在工作流中补齐执行配置。" : "Complete the execution configuration in the workflow first."));
      await workbenchApi.startWorkItemLoopRun(item.workItemId, data, { idempotencyKey: key });
      await runs.refetch(); setPrepared(null); invocation.current = null; creation.current = null;
    } catch (cause) { setError(cause?.message || (zh ? "无法开始执行，请重试。" : "Could not start execution.")); }
    finally { setBusy(false); }
  }

  async function inspectRun(runId) {
    setError("");
    try {
      const detail = await workbenchApi.getRun(runId);
      workspace.navigateToPath(`/loops/${detail.data.run.workflowId}/runs/${runId}`);
    } catch (cause) { setError(cause.message); }
  }

  const fields = prepared?.revision.inputForm.fields || [];
  const canExecute = canRun && !["completed", "cancelled"].includes(item.status);
  const values = runs.data?.data || [];
  const viewing = values.find((run) => run.runId === viewingRunId);
  return <section className="workItemLoops" aria-label={zh ? "工作成果" : "Results"}>
    <header><h3>{viewing ? viewing.workflowName : zh ? "工作成果" : "Results"}</h3>{viewing ? <Button variant="plain" size="sm" onClick={() => setViewingRunId(null)}>{zh ? "收起成果" : "Close result"}</Button> : <button type="button" aria-label={zh ? "刷新成果" : "Refresh results"} onClick={() => runs.refetch()}><RefreshCw size={14} /></button>}</header>
    {canExecute && !prepared && !viewing ? <Button variant="secondary" size="sm" aria-label={zh ? "使用团队方法" : "Use a team workflow"} icon={<Play size={13} />} disabled={busy} onClick={() => setChoosing(!choosing)}>{zh ? "使用团队方法" : "Use a team workflow"}</Button> : null}
    {choosing && canExecute ? <div className="workLoopPicker">
      {catalog.isPending ? <p role="status">{zh ? "正在读取团队版本…" : "Loading releases…"}</p> : null}
      {catalog.error ? <p role="alert">{catalog.error.message}</p> : null}
      {catalog.data?.map((release) => <button type="button" key={release.releaseId} disabled={busy} onClick={() => prepare(release)}><strong>{release.name}</strong><small>v{release.version}</small></button>)}
      {catalog.data?.length === 0 ? <p>{zh ? "还没有发布的团队工作流。请先完成试运行并发布。" : "Publish a tested workflow to make it available here."}</p> : null}
    </div> : null}
    {prepared && canExecute ? <form className="workLoopForm" onSubmit={execute}>
      <strong>{prepared.release.name}</strong>
      <p>{zh ? `输入和结果会分享给这项工作的 ${item.members.length} 位成员，使用你的模型账户。` : `Visible to the ${item.members.length} members of this work item. Uses your model and quota.`}</p>
      {fields.map((field) => <RunInput key={field.fieldId} field={field} value={inputs[field.fieldId]} disabled={busy} zh={zh} onChange={(value) => { invocation.current = null; setInputs((current) => { const next = { ...current, [field.fieldId]: value }; if (value === undefined) delete next[field.fieldId]; return next; }); }} />)}
      <div className="workLoopActions"><Button type="submit" variant="primary" disabled={busy}>{busy ? zh ? "正在准备…" : "Preparing…" : zh ? "执行并共享结果" : "Run and share result"}</Button><Button variant="plain" type="button" disabled={busy} onClick={() => setPrepared(null)}>{zh ? "取消" : "Cancel"}</Button></div>
      <button type="button" className="workLoopConfigure" disabled={busy} onClick={() => workspace.navigateToPath(`/loops/${prepared.workflow.workflowId}/edit`)}>{zh ? "调整此方法" : "Open copy to inspect model and steps"}</button>
    </form> : null}
    {error || runs.error ? <p role="alert" className="workFormError">{error || runs.error.message}</p> : null}
    {!values.length && !runs.isPending ? <p className="workLoopEmpty">{zh ? "还没有成果。继续处理这项工作，或选择团队已有的方法。" : "No results yet. Continue this work or use a team method."}</p> : null}
    {viewing ? <div className="workResultReader">
      <p className="workResultReviewNote">{zh ? "请核对成果后再决定下一步。" : "Review this result before deciding what comes next."}</p>
      {viewing.finalAnswer ? <AgentMarkdown content={viewing.finalAnswer.content} /> : null}
      <details className="workResultInputs"><summary>{zh ? "查看本次提交的内容" : "View submitted input"}</summary>{Object.values(viewing.inputs).map((value, index) => <p key={index}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</p>)}</details>
    </div> : <>
      {values[0] ? <Outcome run={values[0]} workspace={workspace} zh={zh} onRead={setViewingRunId} onInspect={inspectRun} /> : null}
      {values.length > 1 ? <details className="workResultHistory"><summary>{zh ? `以前的成果（${values.length - 1}）` : `Earlier results (${values.length - 1})`}</summary>{values.slice(1).map((run) => <Outcome key={run.runId} run={run} workspace={workspace} zh={zh} onRead={setViewingRunId} onInspect={inspectRun} />)}</details> : null}
    </>}

  </section>;
}

function Outcome({ run, workspace, zh, onRead, onInspect }) {
  const member = workspace.participantDirectory.find((entry) => entry.userId === run.requestedByUserId);
  return <article className="workLoopOutcome">
    <div><strong>{run.workflowName}</strong><span role="status" className={`workLoopStatus status-${run.status}`}>{statusText(run.status, zh)}</span></div>
    <small>{run.requestedByUserId === workspace.principal.userId ? zh ? "你" : "You" : member?.displayName || member?.username || (zh ? "团队成员" : "Team member")} · {new Date(run.createdAt).toLocaleString(workspace.locale)}</small>
    {run.finalAnswer ? <Button variant="secondary" size="sm" onClick={() => onRead(run.runId)}>{zh ? "查看成果" : "View result"}</Button> : null}
    {run.requestedByUserId === workspace.principal.userId && (!isTerminalRunStatus(run.status) || run.status === "failed") ? <Button variant="secondary" size="sm" onClick={() => onInspect(run.runId)}>{run.status === "failed" ? zh ? "查看问题" : "Review problem" : zh ? "查看进度" : "View progress"}</Button> : null}
  </article>;
}

function RunInput({ field, value, onChange, disabled, zh }) {
  const schema = field.schema || {};
  const [text, setText] = useState("");
  const title = `${field.label}${field.required ? " *" : ""}`;
  if (schema.type === "boolean") return <label><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{title}</label>;
  if (schema.enum) return <label><span>{title}</span><select value={value ?? ""} required={field.required} disabled={disabled} onChange={(event) => onChange(schema.enum.find((entry) => String(entry) === event.target.value))}><option value="">{zh ? "请选择" : "Choose"}</option>{schema.enum.map((entry) => <option key={String(entry)} value={String(entry)}>{String(entry)}</option>)}</select></label>;
  if (["number", "integer"].includes(schema.type)) return <label><span>{title}</span><input type="number" value={value ?? ""} min={schema.minimum} max={schema.maximum} step={schema.type === "integer" ? 1 : "any"} required={field.required} disabled={disabled} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} /></label>;
  const structured = ["object", "array"].includes(schema.type);
  return <label><span>{title}{structured ? " (JSON)" : ""}</span><textarea rows={5} value={structured ? text : value ?? ""} required={field.required} minLength={schema.minLength} maxLength={schema.maxLength} disabled={disabled} onChange={(event) => {
    if (!structured) { onChange(event.target.value); return; }
    setText(event.target.value);
    try { onChange(JSON.parse(event.target.value)); event.target.setCustomValidity(""); }
    catch { event.target.setCustomValidity(zh ? "请输入有效 JSON。" : "Enter valid JSON."); }
  }} />{field.description ? <small>{field.description}</small> : null}</label>;
}
