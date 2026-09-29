import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Dialog, TextArea } from "../../design-system/index.jsx";
import { useRecentWorkItemThreadQuery, useWorkItemThreadCommentMutation, useWorkItemDecisionMutation } from "../../api/queries.js";
import { AgentMarkdown } from "../agents/AgentMarkdown.js";
import { createStableCreationIntent, isCreationOutcomeUnknown } from "./create-intent.js";
import "./work-item-activity.css";

export function WorkItemActivity({ workspace, item, canContribute }) {
  const zh = workspace.locale.startsWith("zh");
  const activity = useRecentWorkItemThreadQuery(workspace.principal, item.workItemId);
  const mutation = useWorkItemThreadCommentMutation();
  const decisionMutation = useWorkItemDecisionMutation();
  const [mode, setMode] = useState("update");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [outcome, setOutcome] = useState("");
  const [rationale, setRationale] = useState("");
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const intent = useRef(createStableCreationIntent({ kind: "work-update" }));
  const entries = [...new Map((activity.data?.pages || []).flatMap((page) => page.data).map((entry) => [entry.entryId, entry])).values()];
  const unavailable = ["work_item_not_found", "authentication_required", "session_expired"].includes(activity.error?.code);
  const busy = mutation.isPending || decisionMutation.isPending;
  const canPost = canContribute && !workspace.readOnlyWorkspace && !unavailable;
  const canDecide = canPost && item.accountableOwnerUserId === workspace.principal.userId
    && item.members.some((member) => member.userId === workspace.principal.userId && member.accessGrant?.access === "owner");
  const words = (cn, en) => zh ? cn : en;
  const decision = mode === "decision";
  const complete = decision ? question.trim() && options.trim() && outcome.trim() : content.trim();

  function startUpdate(nextMode = "update") {
    if (uncertain) { setOpen(true); return; }
    intent.current.begin(); setMode(nextMode); setContent(""); setQuestion(""); setOptions(""); setOutcome(""); setRationale("");
    setError(""); setUncertain(false); setSubmitted(false); setOpen(true);
  }
  async function submit(event) {
    event.preventDefault();
    if (!complete || busy) return;
    const data = decision ? { question: question.trim(), options: [...new Set(options.split("\n").map((value) => value.trim()).filter(Boolean))],
      chosenOutcome: outcome.trim(), ...(rationale.trim() ? { rationale: rationale.trim() } : {}) } : { content: content.trim() };
    if (decision && (data.options.length > 16 || data.options.some((value) => value.length > 1000))) {
      setError(words("最多填写 16 个选项，每项不超过 1000 字。", "Use up to 16 options, with at most 1000 characters each.")); return;
    }
    setError("");
    try {
      await (decision ? decisionMutation : mutation).mutateAsync({ principal: workspace.principal, workItemId: item.workItemId,
        data, idempotencyKey: intent.current.keyFor(data) });
      setOpen(false); setContent(""); setUncertain(false); intent.current.reset(); setSubmitted(true);
    } catch (cause) {
      const unknown = isCreationOutcomeUnknown(cause); setUncertain(unknown);
      setError(unknown ? words("还未确认是否提交成功。内容已保留，请重试；不会重复发布。", "The submission could not be confirmed. Your text is retained; retrying will not post twice.")
        : ["work_item_not_found", "work_item_access_forbidden", "work_item_thread_write_forbidden", "work_item_decision_write_forbidden"].includes(cause.code)
          ? words("你已无法提交到这项工作。请关闭窗口并刷新，确认当前权限。", "You can no longer post to this work. Close and refresh to check your access.")
          : words("未能提交，内容已保留，请重试。", "Could not submit. Your text is retained; please retry."));
    }
  }
  const renderEntry = (entry) => <ActivityEntry key={entry.entryId} entry={entry} workspace={workspace}
    decision={workspace.selectedWorkItemState?.data?.data?.decisions?.find((value) => value.decisionId === entry.decisionId)} />;
  return <section className="workItemActivity" aria-label={words("团队进展", "Team updates")}>
    <header><h3>{words("团队进展", "Team updates")}</h3><div>
      <button type="button" className="workActivityRefresh" aria-label={words("刷新团队进展", "Refresh team updates")} disabled={activity.isFetching} onClick={() => activity.refetch()}><RefreshCw size={14} /></button>
      {canDecide ? <Button variant="plain" size="sm" onClick={() => startUpdate("decision")}>{words("记录决定", "Record decision")}</Button> : null}
      {canPost ? <Button variant="secondary" size="sm" onClick={() => startUpdate()}>{words("更新进展", "Post update")}</Button> : null}
    </div></header>
    {submitted ? <p role="status" className="workActivityNotice">{words("已分享给这项工作的成员。", "Shared with this work item's members.")}</p> : null}
    {activity.isPending ? <p role="status">{words("正在读取进展…", "Loading updates…")}</p> : null}
    {activity.error ? <p role="alert">{unavailable ? words("无法访问这项工作的进展，请刷新确认权限。", "These updates are unavailable. Refresh to check access.") : words("进展暂时无法刷新，请重试。", "Could not refresh updates. Please retry.")}</p> : null}
    {!unavailable && entries.length ? <>
      <div className="workActivityEntries">{entries.slice(0, 3).map(renderEntry)}</div>
      {entries.length > 3 || activity.hasNextPage ? <details className="workActivityHistory"><summary>{words("更早的进展", "Earlier updates")}</summary>
        <div className="workActivityEntries">{entries.slice(3).map(renderEntry)}</div>
        {activity.hasNextPage ? <Button variant="plain" size="sm" disabled={activity.isFetchingNextPage} onClick={() => activity.fetchNextPage()}>{activity.isFetchingNextPage ? words("正在读取…", "Loading…") : words("查看更多", "Load more")}</Button> : null}
      </details> : null}
    </> : !activity.isPending && !activity.error ? <p className="workActivityEmpty">{words("还没有进展。把已完成的内容、遇到的问题或下一步留在这里。", "No updates yet. Share what is done, what is blocked, or what comes next.")}</p> : null}
    <Dialog open={open} title={decision ? words("记录决定", "Record decision") : words("更新进展", "Post update")} onClose={() => !busy && setOpen(false)}
      actions={<><Button variant="plain" disabled={busy} onClick={() => setOpen(false)}>{uncertain ? words("稍后重试", "Retry later") : words("取消", "Cancel")}</Button><Button variant="primary" type="submit" form="work-activity-form" disabled={busy || !complete}>{busy ? words("正在提交…", "Submitting…") : uncertain ? words("重试提交", "Retry submission") : words("分享给成员", "Share with members")}</Button></>}>
      <form id="work-activity-form" className="workActivityForm" onSubmit={submit}>
        <p>{words(`这里的内容会分享给这项工作的 ${item.members.length} 位成员。`, `This content will be shared with the ${item.members.length} members of this work item.`)}</p>
        {decision ? <>
          <TextArea label={words("要解决什么问题", "Question")} hiddenLabel={false} value={question} onChange={setQuestion} rows={2} maxLength={1000} disabled={busy || uncertain} />
          <TextArea label={words("讨论过的选项（每行一个）", "Options considered (one per line)")} hiddenLabel={false} value={options} onChange={setOptions} rows={3} maxLength={16000} disabled={busy || uncertain} />
          <TextArea label={words("最终决定", "Chosen outcome")} hiddenLabel={false} value={outcome} onChange={setOutcome} rows={2} maxLength={2000} disabled={busy || uncertain} />
          <TextArea label={words("决定的依据（可选）", "Rationale (optional)")} hiddenLabel={false} value={rationale} onChange={setRationale} rows={2} maxLength={4000} disabled={busy || uncertain} />
        </> : <TextArea label={words("进展内容", "Update")} hiddenLabel={false} value={content} onChange={setContent} rows={7} maxLength={8000} disabled={busy || uncertain}
          placeholder={words("写下进展，或粘贴你用 Codex、Claude Code、Pi 等完成并愿意分享的内容…", "Write an update, or paste work from your Agent that you want to share…")} /> }
        {error ? <p role="alert" className="workFormError">{error}</p> : null}
      </form>
    </Dialog>
  </section>;
}

function ActivityEntry({ entry, workspace, decision }) {
  const zh = workspace.locale.startsWith("zh");
  const member = workspace.participantDirectory.find((person) => person.userId === entry.createdByUserId);
  const author = entry.createdByUserId === workspace.principal.userId ? (zh ? "你" : "You") : member?.displayName || member?.username || (zh ? "团队成员" : "Team member");
  const kind = { handoff: ["交接", "Handoff"], decision: ["决定", "Decision"], artifact: ["文件", "File"], comment: ["进展", "Update"] }[entry.kind]?.[zh ? 0 : 1] || (zh ? "进展" : "Update");
  const body = decision ? `${zh ? "问题" : "Question"}：${decision.question}\n\n${zh ? "决定" : "Outcome"}：${decision.chosenOutcome}${decision.rationale ? `\n\n${zh ? "依据" : "Rationale"}：${decision.rationale}` : ""}` : entry.summary;
  const long = body.length > 240 || body.split("\n").filter((line) => line.trim()).length > 4;
  return <article className="workActivityEntry">
    <header><strong>{author}</strong><span>{kind}</span><time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString(workspace.locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
    {long ? <details><summary>{body.replace(/\s+/g, " ").slice(0, 120)}… <span>{zh ? "展开" : "Read more"}</span></summary><AgentMarkdown content={body} /></details> : <AgentMarkdown content={body} />}
  </article>;
}
