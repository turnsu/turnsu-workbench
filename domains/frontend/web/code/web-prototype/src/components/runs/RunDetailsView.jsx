import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Clock3, FileCheck2, RotateCcw, X } from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { useRunInvocationsQuery } from "../../api/queries.js";
import { ArtifactImage } from "../models/ArtifactImage.jsx";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function statusLabel(status, t) {
  const keys = {
    completed: "status.completed",
    running: "status.running",
    queued: "status.queued",
    waiting_review: "status.needsFollowUp",
    paused: "status.needsFollowUp",
    failed: "status.failed",
    cancelled: "status.cancelled",
  };
  return keys[status] ? t(keys[status]) : status;
}

function toneFor(status) {
  if (status === "completed") return "success";
  if (["failed", "cancelled"].includes(status)) return "danger";
  if (["waiting_review", "paused"].includes(status)) return "warning";
  return "info";
}

export function RunDetailsView({ workspace }) {
  const t = workspace.t;
  const run = workspace.activeRun;
  const loop = workspace.loops.find((item) => item.id === run?.loopId) || workspace.selectedWorkflow;
  const history = workspace.runs.filter((entry) => entry.loopId === run?.loopId);
  const previousRun = history.find((entry) => entry.id !== run?.id && TERMINAL.has(entry.status));
  const comparison = workspace.activeRunComparison;
  const connection = workspace.runStream?.connection;
  const reviewBusy = workspace.serverState?.mutations?.review?.isPending === true;
  const cancelBusy = workspace.serverState?.mutations?.cancelRun?.isPending === true;
  const retryBusy = run?.status === "completed"
    ? workspace.serverState?.mutations?.startRun?.isPending === true
    : workspace.serverState?.mutations?.retryRun?.isPending === true;
  const [reviewNote, setReviewNote] = useState("");
  const invocationsQuery = useRunInvocationsQuery(run?.id, Boolean(run?.id));
  const invocations = invocationsQuery.data?.data || [];
  const modelInvocations = invocations.filter((invocation) => (
    invocation.mode === "model_call"
    || invocation.requestedModelRevisionId
    || invocation.actualModelRevisionId
  ));
  const runArtifacts = [...new Map(modelInvocations
    .flatMap((invocation) => invocation.artifactRefs || [])
    .map((artifact) => [artifact.artifactId || artifact, artifact])).values()];

  useEffect(() => setReviewNote(""), [run?.id, run?.reviewPacket?.nodeId]);

  if (workspace.surfaceState?.run?.loading || workspace.surfaceState?.run?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={workspace.surfaceState.run}
        objectLabel={t("page.runs.title")}
        onRetry={() => workspace.retrySurface("run")}
        onBack={() => workspace.setActivePage("loops")}
        backLabel={t("actions.openLoops")}
        testId="loopops.runs.query-state"
      />
    );
  }

  if (!run) {
    return (
      <div className="surface runDetailsEmpty" data-testid="loopops.runs.empty">
        <h2>{t("runs.detailTitle")}</h2>
        <p>{t("workflows.noRunHistory")}</p>
        <Button variant="secondary" icon={<ArrowLeft size={15} />} onClick={() => workspace.setActivePage("loops")}>
          {t("actions.openLoops")}
        </Button>
      </div>
    );
  }

  return (
    <div className="surface runDetailsView" data-testid="loopops.workflows.surface">
      <header className="runDetailsHeader">
        <div>
          <button type="button" className="backLink" onClick={() => workspace.setActivePage("loops")}>
            <ArrowLeft size={15} /> {t("actions.openLoops")}
          </button>
          <p className="objectKicker">{loop?.title || t("page.loops.title")}</p>
          <h2>{t("runs.detailTitle")}</h2>
        </div>
        <div className="runDetailsHeaderMeta">
          <StatusPill tone={toneFor(run.status)}>{statusLabel(run.status, t)}</StatusPill>
          <span><Clock3 size={14} /> {t(connection?.status === "connected" ? "runs.updatesLive" : connection?.status === "connecting" ? "runs.updatesConnecting" : "runs.updatesDelayed")}</span>
        </div>
      </header>

      {!TERMINAL.has(run.status) && connection?.status === "disconnected" ? (
        <div className="inlineRecovery runStreamRecovery" role="status" aria-live="polite" data-testid="loopops.runs.reconnect-state">
          <span>
            <strong>{t(connection.reason === "browser_offline" ? "runs.offlineTitle" : "runs.connectionLostTitle")}</strong>
            <small>{t(connection.reason === "browser_offline" ? "runs.offlineBody" : "runs.connectionLostBody")}</small>
          </span>
          <Button variant="secondary" onClick={workspace.runStream?.reconnect} data-testid="loopops.runs.reconnect">
            {t("runs.reconnect")}
          </Button>
        </div>
      ) : null}

      <div className="runDetailsGrid">
        <main className="runDetailsMain" data-testid="loopops.workflows.run-detail">
          {run.reviewPacket ? (
            <section className="reviewDecisionPanel" data-testid="loopops.runs.review-panel">
              <p className="sectionEyebrow"><FileCheck2 size={14} /> {t("runs.reviewPacket")}</p>
              <h3>{run.reviewPacket.title}</h3>
              <p>{run.reviewPacket.summary}</p>
              <ul className="cleanList">{run.reviewPacket.items.map((item) => <li key={item}>{item}</li>)}</ul>
              {run.reviewDecisions.length ? (
                <div className="reviewHistory" data-testid="loopops.runs.review-history">
                  <h3>{t("runs.reviewHistory")}</h3>
                  <ol className="cleanList">{run.reviewDecisions.map((decision) => <li key={decision.decisionId}><strong>{t(`runs.decision.${decision.decision}`)}</strong>{decision.comment ? <p>{decision.comment}</p> : null}{decision.requestedChanges?.length ? <small>{decision.requestedChanges.join("; ")}</small> : null}<span>{decision.decidedAt}</span></li>)}</ol>
                </div>
              ) : null}
              {["waiting_review", "paused"].includes(run.status) ? (
                <div className="reviewDecisionForm" aria-busy={reviewBusy ? "true" : undefined}>
                  <label>
                    <span>{t("runs.reviewComment")}</span>
                    <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} maxLength={4000} placeholder={t("runs.reviewCommentPlaceholder")} data-testid="loopops.runs.review.comment" />
                  </label>
                  {!run.reviewPacket.canRequestChanges ? <p className="reviewActionHint">{t("runs.reviseUnavailable")}</p> : null}
                  {run.reviewPacket.canRequestChanges && !reviewNote.trim() ? <p className="reviewActionHint">{t("runs.reviseNeedsComment")}</p> : null}
                  <div className="buttonRow">
                    <Button variant="secondary" onClick={() => workspace.submitReviewDecision("reject", reviewNote)} disabled={reviewBusy} data-testid="loopops.runs.review.reject">{t("runs.reject")}</Button>
                    <Button variant="secondary" onClick={() => workspace.submitReviewDecision("revise", reviewNote)} disabled={reviewBusy || !run.reviewPacket.canRequestChanges || !reviewNote.trim()} data-testid="loopops.runs.review.revise">
                      {t("runs.revise")}
                    </Button>
                    <Button variant="primary" onClick={() => workspace.submitReviewDecision("approve", reviewNote)} disabled={reviewBusy} data-testid="loopops.runs.review.approve">{reviewBusy ? t("state.loading") : t("runs.approve")}</Button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {run.evidenceGaps.length ? (
            <section className="evidenceGapPanel" data-testid="loopops.runs.evidence-gaps">
              <p className="sectionEyebrow"><AlertTriangle size={14} /> {t("runs.evidenceGaps")}</p>
              <ul className="cleanList">{run.evidenceGaps.map((gap) => <li key={`${gap.code}-${gap.nodeId || "run"}`}>{gap.summary}</li>)}</ul>
            </section>
          ) : null}

          {run.finalAnswer ? (
            <section className="finalAnswer" data-testid="loopops.runs.final-answer">
              <p className="sectionEyebrow"><FileCheck2 size={14} /> {t("runs.finalAnswer")}</p>
              <p>{run.finalAnswer.content}</p>
            </section>
          ) : null}

          {runArtifacts.length ? (
            <section className="finalAnswer" data-testid="loopops.runs.artifacts">
              <p className="sectionEyebrow"><FileCheck2 size={14} /> {t("agent.image.generatedAlt")}</p>
              {runArtifacts.map((artifact) => <ArtifactImage key={artifact.artifactId || artifact} artifactId={artifact.artifactId || artifact} alt={t("agent.image.generatedAlt")} />)}
            </section>
          ) : null}

          <div className="buttonRow">
            <Button variant="secondary" onClick={workspace.createDraftFromActiveRun} data-testid="loopops.runs.create-draft">
              {t("actions.continueFromRun")}
            </Button>
            {run.status === "completed" && loop ? (
              <Button variant="primary" onClick={() => workspace.openPublishReview(loop.id)} data-testid="loopops.runs.publish">
                {t("actions.publish")}
              </Button>
            ) : null}
          </div>

          {previousRun && !comparison ? (
            <div className="buttonRow">
              <Button variant="secondary" onClick={() => workspace.compareActiveRunWith(previousRun.id)} data-testid="loopops.runs.compare.open">
                {t("actions.comparePreviousRun")}
              </Button>
            </div>
          ) : null}

          {comparison ? (
            <section className="reviewDecisionPanel" data-testid="loopops.runs.comparison">
              <p className="sectionEyebrow">{t("runs.comparisonTitle")}</p>
              <dl className="propertyGrid">
                <dt>{t("runs.thisRun")}</dt>
                <dd>{comparison.left.skillVersions.length ? comparison.left.skillVersions.join(", ") : t("runs.versionUnavailable")}</dd>
                <dt>{t("runs.previousRun")}</dt>
                <dd>{comparison.right.skillVersions.length ? comparison.right.skillVersions.join(", ") : t("runs.versionUnavailable")}</dd>
                <dt>{t("runs.workflowChanged")}</dt>
                <dd>{comparison.workflowRevisionChanged ? t("runs.changed") : t("runs.unchanged")}</dd>
                <dt>{t("runs.resultChanged")}</dt>
                <dd>{comparison.finalAnswerChanged ? t("runs.changed") : t("runs.unchanged")}</dd>
              </dl>
              <Button variant="plain" onClick={workspace.clearRunComparison}>{t("actions.stopComparing")}</Button>
            </section>
          ) : null}

          {run.failure ? <section className="runFailure" role="alert"><h3>{t("runs.failed")}</h3><p>{run.failure.message}</p></section> : null}

          {!TERMINAL.has(run.status) ? (
            <div className="buttonRow"><Button variant="secondary" icon={<X size={15} />} disabled={cancelBusy} onClick={workspace.cancelActiveRun} data-testid="loopops.runs.cancel">{cancelBusy ? t("state.loading") : t("runs.cancel")}</Button></div>
          ) : null}
          {TERMINAL.has(run.status) ? (
            <div className="buttonRow"><Button variant="primary" icon={<RotateCcw size={15} />} disabled={retryBusy} onClick={workspace.retryActiveRun} data-testid="loopops.runs.retry">{retryBusy ? t("state.loading") : t("runs.retry")}</Button></div>
          ) : null}
        </main>

        <aside className="runDetailsRail">
          <section>
            <h3>{t("runs.timeline")}</h3>
            <ol className="pathRows graphRows">
              {run.nodeTimeline.map((nodeRun) => <li key={`${nodeRun.nodeId}-${nodeRun.attempt}`}><span>{nodeRun.attempt}</span><div className="graphRowBody"><strong>{nodeRun.summary || nodeRun.nodeId}</strong><small>{statusLabel(nodeRun.status, t)}</small></div></li>)}
            </ol>
          </section>
          <section data-testid="loopops.workflows.run-ledger">
            <h3>{t("workflows.runLedger")}</h3>
            <div className="timeline">{history.map((entry) => <button type="button" key={entry.id} onClick={() => workspace.setActiveRunId(entry.id)}><span>{entry.startedAt}</span><strong>{statusLabel(entry.status, t)}</strong></button>)}</div>
          </section>
          {modelInvocations.length ? (
            <section data-testid="loopops.runs.model-history">
              <h3>{t("model.resolvedRoutes")}</h3>
              <ul className="cleanList runInvocationModels">
                {modelInvocations.map((invocation) => {
                  const requested = invocation.requestedModelRevisionId || invocation.modelProfileRevisionId;
                  const actual = invocation.actualModelRevisionId || requested;
                  const fallback = Boolean(requested && actual && requested !== actual);
                  return (
                    <li key={invocation.invocationId}>
                      <span><strong>{invocation.capability || invocation.mode}</strong><small>{t("model.requested")}: {requested || "—"}</small></span>
                      <span>{t("model.actual")}: {actual || "—"}{fallback ? ` · ${t("model.fallbackUsed")}` : ""}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
