import { useEffect, useState } from "react";

import { Button, Dialog, TextArea } from "../../design-system/index.jsx";

function shortHash(value) {
  const hash = String(value || "");
  return hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash;
}

export function WorkItemHandoffDialog({
  open,
  detailQuery,
  threadQuery,
  currentUserId = "",
  locale = "en",
  onClose,
  onContinue = null,
  onAddComment = null,
  onRecordDecision = null,
  continuing = false,
  postingComment = false,
  recordingDecision = false,
  continuationError = "",
}) {
  const detail = detailQuery?.data?.data || null;
  const workItem = detail?.workItem || null;
  const handoff = detail?.handoffCapsule || null;
  const threadEntries = threadQuery?.data?.data || [];
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState("");
  const [decisionQuestion, setDecisionQuestion] = useState("");
  const [decisionOptions, setDecisionOptions] = useState("");
  const [decisionOutcome, setDecisionOutcome] = useState("");
  const [decisionRationale, setDecisionRationale] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const currentMember = workItem?.members?.find((member) => member.userId === currentUserId) || null;
  const canContinue = Boolean(
    onContinue
    && currentMember
    && ["owner", "contribute"].includes(currentMember.accessGrant?.access),
  );
  const canComment = Boolean(
    onAddComment
    && currentMember
    && ["owner", "contribute"].includes(currentMember.accessGrant?.access),
  );
  const canRecordDecision = Boolean(
    onRecordDecision
    && currentMember?.accessGrant?.access === "owner"
    && workItem?.accountableOwnerUserId === currentUserId,
  );
  const busy = continuing || postingComment || recordingDecision;
  useEffect(() => {
    setComment("");
    setCommentError("");
    setDecisionQuestion("");
    setDecisionOptions("");
    setDecisionOutcome("");
    setDecisionRationale("");
    setDecisionError("");
  }, [open, workItem?.workItemId]);
  const copy = locale === "zh"
    ? {
        fallbackTitle: "团队工作",
        loading: "正在读取可访问的共享交接…",
        unavailable: "此工作不存在、你没有权限，或访问已被撤销。",
        objective: "协作目标",
        handoff: "交接摘要",
        decisions: "已共享决策",
        artifacts: "已共享产物",
        thread: "共享动态",
        loadingThread: "正在读取共享动态…",
        threadUnavailable: "共享动态暂时不可用，请稍后重试。",
        noThread: "尚无更多共享动态。",
        commentLabel: "添加协作备注",
        commentPlaceholder: "写下可安全共享给团队的进展、风险或下一步…",
        commentSend: "发布备注",
        commenting: "正在发布…",
        commentReadOnly: "你可以查看这条共享动态，但没有发布权限。",
        recordDecision: "记录团队决策",
        decisionQuestion: "决策问题",
        decisionQuestionPlaceholder: "这次团队需要明确什么选择？",
        decisionOptions: "备选项（每行一个）",
        decisionOutcome: "已选择的结果",
        decisionOutcomePlaceholder: "明确写下最终选择…",
        decisionRationale: "依据（可选）",
        recordDecisionSubmit: "记录决策",
        recordingDecision: "正在记录…",
        decisionOwnerOnly: "只有负责人可以记录团队决策；其他成员可以通过备注提出建议。",
        threadKinds: {
          handoff: "交接",
          decision: "决策",
          artifact: "产物",
          comment: "备注",
        },
        access: "你的访问权限",
        members: "参与成员",
        continue: "写下我的下一步",
        continueHint: "根据已共享的信息继续工作。提交下一步后，将创建你的私人任务；原作者的私人对话不会被带入。",
        continuing: "正在准备继续任务…",
        close: "关闭",
        noDecisions: "这次交接没有共享决策。",
        noArtifacts: "这次交接没有共享产物。",
      }
    : {
        fallbackTitle: "Shared Work Item",
        loading: "Loading the shared handoff you are allowed to view…",
        unavailable: "This shared Work Item does not exist, is unavailable to your account, or access was revoked.",
        objective: "Collaboration objective",
        handoff: "Handoff summary",
        decisions: "Shared decisions",
        artifacts: "Shared artifacts",
        thread: "Shared activity",
        loadingThread: "Loading the shared activity you are allowed to view…",
        threadUnavailable: "Shared activity is temporarily unavailable. Try again shortly.",
        noThread: "No additional shared activity yet.",
        commentLabel: "Add a collaboration note",
        commentPlaceholder: "Share a team-safe update, risk, or next step…",
        commentSend: "Post note",
        commenting: "Posting…",
        commentReadOnly: "You can view this shared activity but cannot post to it.",
        recordDecision: "Record a team Decision",
        decisionQuestion: "Decision question",
        decisionQuestionPlaceholder: "What choice does the team need to settle?",
        decisionOptions: "Options (one per line)",
        decisionOutcome: "Chosen outcome",
        decisionOutcomePlaceholder: "State the final choice…",
        decisionRationale: "Rationale (optional)",
        recordDecisionSubmit: "Record Decision",
        recordingDecision: "Recording…",
        decisionOwnerOnly: "Only the accountable owner can record a team Decision; other members can propose one in a note.",
        threadKinds: {
          handoff: "Handoff",
          decision: "Decision",
          artifact: "Artifact",
          comment: "Note",
        },
        access: "Your access",
        members: "Participants",
        continue: "Write my next task",
        continueHint: "The Agent composer opens next. Your private branch and first task are created atomically only when you submit; the source private task is not carried over.",
        continuing: "Preparing your next task…",
        close: "Close",
        noDecisions: "No decision was shared with this handoff.",
        noArtifacts: "No artifact was shared with this handoff.",
      };

  async function submitComment(event) {
    event.preventDefault();
    const content = comment.trim();
    if (!content) return;
    setCommentError("");
    try {
      await onAddComment?.(content);
      setComment("");
    } catch (error) {
      setCommentError(error?.message || copy.threadUnavailable);
    }
  }

  async function submitDecision(event) {
    event.preventDefault();
    const question = decisionQuestion.trim();
    const options = decisionOptions.split("\n").map((value) => value.trim()).filter(Boolean);
    const chosenOutcome = decisionOutcome.trim();
    if (!question || options.length === 0 || !chosenOutcome) return;
    setDecisionError("");
    try {
      await onRecordDecision?.({
        question,
        options,
        chosenOutcome,
        ...(decisionRationale.trim() ? { rationale: decisionRationale.trim() } : {}),
      });
      setDecisionQuestion("");
      setDecisionOptions("");
      setDecisionOutcome("");
      setDecisionRationale("");
    } catch (error) {
      setDecisionError(error?.message || copy.threadUnavailable);
    }
  }

  return (
    <Dialog
      open={open}
      title={workItem?.title || copy.fallbackTitle}
      onClose={onClose}
      initialFocusSelector="[data-testid='loopops.main-agent.work-item.detail.close']"
      returnFocusSelector="[data-testid='loopops.main-agent.work-item.detail.open'], [data-testid='loopops.main-agent.work-item.open']"
      actions={(
        <>
          {canContinue ? (
            <Button
              variant="primary"
              onClick={onContinue}
              disabled={busy}
              data-testid="loopops.main-agent.work-item.detail.continue"
            >
              {continuing ? copy.continuing : copy.continue}
            </Button>
          ) : null}
          <Button
            variant={canContinue ? "secondary" : "primary"}
            onClick={onClose}
            disabled={busy}
            data-testid="loopops.main-agent.work-item.detail.close"
          >
            {copy.close}
          </Button>
        </>
      )}
    >
      <section className="agentWorkItemHandoff" data-testid="loopops.main-agent.work-item.detail">
        {detailQuery?.isLoading ? <p role="status">{copy.loading}</p> : null}
        {detailQuery?.error ? <p role="alert">{copy.unavailable}</p> : null}
        {workItem && handoff ? (
          <>
            <div className="agentWorkItemHandoffMeta">
              <span>{locale === "zh" ? ({ draft: "草稿", ready: "待开始", active: "进行中", waiting_review: "待审核", completed: "已完成", blocked: "已阻塞", cancelled: "已取消" }[workItem.status] || workItem.status) : workItem.status}</span>
              <span>{locale === "zh" ? ({ low: "低优先级", medium: "中优先级", high: "高优先级", urgent: "紧急" }[workItem.priority] || workItem.priority) : workItem.priority}</span>
              <span>{copy.members}: {workItem.members.length}</span>
              {currentMember ? <span>{copy.access}: {locale === "zh" ? ({ owner: "负责人", contribute: "可协作", read: "只读" }[currentMember.accessGrant.access] || currentMember.accessGrant.access) : currentMember.accessGrant.access}</span> : null}
            </div>
            {canContinue ? <p className="agentWorkItemContinuationHint">{copy.continueHint}</p> : null}
            {continuationError ? <p role="alert">{continuationError}</p> : null}
            <section>
              <h3>{copy.objective}</h3>
              <p>{workItem.objective}</p>
            </section>
            <section>
              <h3>{copy.handoff}</h3>
              <p className="agentWorkItemHandoffSummary">{handoff.summary}</p>
            </section>
            <section>
              <h3>{copy.decisions}</h3>
              {detail.decisions.length ? (
                <ol className="agentWorkItemDecisionList">
                  {detail.decisions.map((decision) => (
                    <li key={decision.decisionId}>
                      <strong>{decision.question}</strong>
                      <span>{decision.chosenOutcome}</span>
                      {decision.rationale ? <p>{decision.rationale}</p> : null}
                    </li>
                  ))}
                </ol>
              ) : <p className="agentWorkItemEmpty">{copy.noDecisions}</p>}
              {canRecordDecision ? (
                <details className="agentWorkItemDecisionDisclosure">
                  <summary>{copy.recordDecision}</summary>
                  <form className="agentWorkItemDecisionForm" onSubmit={submitDecision}>
                  <TextArea
                    label={copy.decisionQuestion}
                    hiddenLabel={false}
                    value={decisionQuestion}
                    onChange={setDecisionQuestion}
                    placeholder={copy.decisionQuestionPlaceholder}
                    rows={2}
                    maxLength={1_000}
                    disabled={busy}
                    data-testid="loopops.main-agent.work-item.decision.question"
                  />
                  <TextArea
                    label={copy.decisionOptions}
                    hiddenLabel={false}
                    value={decisionOptions}
                    onChange={setDecisionOptions}
                    rows={3}
                    maxLength={16_000}
                    disabled={busy}
                    data-testid="loopops.main-agent.work-item.decision.options"
                  />
                  <TextArea
                    label={copy.decisionOutcome}
                    hiddenLabel={false}
                    value={decisionOutcome}
                    onChange={setDecisionOutcome}
                    placeholder={copy.decisionOutcomePlaceholder}
                    rows={2}
                    maxLength={2_000}
                    disabled={busy}
                    data-testid="loopops.main-agent.work-item.decision.outcome"
                  />
                  <TextArea
                    label={copy.decisionRationale}
                    hiddenLabel={false}
                    value={decisionRationale}
                    onChange={setDecisionRationale}
                    rows={2}
                    maxLength={4_000}
                    disabled={busy}
                    data-testid="loopops.main-agent.work-item.decision.rationale"
                  />
                  {decisionError ? <p role="alert">{decisionError}</p> : null}
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={busy || !decisionQuestion.trim() || !decisionOptions.trim() || !decisionOutcome.trim()}
                    data-testid="loopops.main-agent.work-item.decision.submit"
                  >
                    {recordingDecision ? copy.recordingDecision : copy.recordDecisionSubmit}
                  </Button>
                </form>
                </details>
              ) : currentMember ? <p className="agentWorkItemDecisionOwnerOnly">{copy.decisionOwnerOnly}</p> : null}
            </section>
            <section>
              <h3>{copy.artifacts}</h3>
              {workItem.artifactRefs.length ? (
                <ul className="agentWorkItemArtifactList">
                  {workItem.artifactRefs.map((artifact) => (
                    <li key={artifact.artifactId}>
                      <strong>{artifact.mediaType}</strong>
                      <span>{artifact.artifactId}</span>
                      <code>{shortHash(artifact.contentHash)}</code>
                    </li>
                  ))}
                </ul>
              ) : <p className="agentWorkItemEmpty">{copy.noArtifacts}</p>}
            </section>
            <section className="agentWorkItemThread">
              <h3>{copy.thread}</h3>
              {threadQuery?.isLoading ? <p role="status">{copy.loadingThread}</p> : null}
              {threadQuery?.error ? <p role="alert">{copy.threadUnavailable}</p> : null}
              {!threadQuery?.isLoading && !threadQuery?.error && threadEntries.length === 0 ? (
                <p className="agentWorkItemEmpty">{copy.noThread}</p>
              ) : null}
              {threadEntries.length ? (
                <ol className="agentWorkItemThreadList">
                  {threadEntries.map((entry) => (
                    <li key={entry.entryId}>
                      <div>
                        <strong>{copy.threadKinds[entry.kind] || entry.kind}</strong>
                        <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>
                      </div>
                      <p>{entry.summary}</p>
                    </li>
                  ))}
                </ol>
              ) : null}
              {canComment ? (
                <form className="agentWorkItemCommentForm" onSubmit={submitComment}>
                  <TextArea
                    label={copy.commentLabel}
                    hiddenLabel={false}
                    value={comment}
                    onChange={setComment}
                    placeholder={copy.commentPlaceholder}
                    rows={3}
                    maxLength={8_000}
                    disabled={busy}
                    data-testid="loopops.main-agent.work-item.thread.comment"
                  />
                  {commentError ? <p role="alert">{commentError}</p> : null}
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={busy || !comment.trim()}
                    data-testid="loopops.main-agent.work-item.thread.comment.submit"
                  >
                    {postingComment ? copy.commenting : copy.commentSend}
                  </Button>
                </form>
              ) : currentMember ? <p className="agentWorkItemCommentReadOnly">{copy.commentReadOnly}</p> : null}
            </section>
          </>
        ) : null}
      </section>
    </Dialog>
  );
}
