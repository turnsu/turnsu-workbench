import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  GitBranch,
  Link2,
  ListChecks,
  LockKeyhole,
  Tag,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

function nextVersion(value = "") {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : "1.0.0";
}

function skillNodes(nodes) {
  return nodes.filter((node) => node.type === "Skill");
}

export function LoopPublishView({ workspace }) {
  const t = workspace.t;
  const loop = workspace.selectedWorkflow;
  const nodes = loop?.workflow?.nodes || [];
  const releases = workspace.teamLibrary
    .filter((release) => release.assetKind === "loop" && release.assetId === loop?.id)
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const previousRelease = releases[0] || null;
  const runs = workspace.runs.filter((run) => run.loopId === loop?.id);
  const latestCompletedRun = runs.find((run) => (
    run.status === "completed" && run.workflowRevisionId === loop?.currentRevisionId
  )) || null;
  const [version, setVersion] = useState(() => nextVersion(previousRelease?.versionLabel));
  const [releaseNotes, setReleaseNotes] = useState("");
  const [startingPoint, setStartingPoint] = useState(true);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const checks = useMemo(() => [
    { ready: !workspace.editorState?.dirty, label: workspace.editorState?.dirty ? t("publish.saveRequired") : t("state.currentWorkflowSaved") },
    { ready: loop?.readiness === "Ready", label: loop?.readiness === "Ready" ? t("publish.validationPassed") : t("publish.readyRequired") },
    { ready: Boolean(latestCompletedRun), label: latestCompletedRun ? t("publish.latestRunPassed") : t("publish.latestRunMissing") },
    { ready: Boolean(releaseNotes.trim()), label: releaseNotes.trim() ? t("publish.notes") : t("publish.releaseNotesRequired") },
    { ready: consent, label: t("publish.consent") },
  ], [consent, latestCompletedRun, loop?.readiness, releaseNotes, t, workspace.editorState?.dirty]);
  const allChecksReady = checks.every((item) => item.ready);
  const canPublish = Boolean(loop && version.trim() && allChecksReady && !submitting);
  const reviewCount = nodes.filter((node) => node.type === "Review Gate").length;
  const dependencies = skillNodes(nodes);

  if (!loop) {
    return (
      <div className="surface objectPageEmpty" data-testid="loopops.publish.surface">
        <h2>{t("loopOverview.notFound")}</h2>
        <Button variant="secondary" onClick={() => workspace.setActivePage("loops")}>{t("actions.openLoops")}</Button>
      </div>
    );
  }

  async function submit(event) {
    event.preventDefault();
    if (!canPublish) return;
    setSubmitting(true);
    try {
      await workspace.publishSelectedLoop({ version: version.trim(), releaseNotes: releaseNotes.trim(), startingPoint });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="surface publishReviewPage" onSubmit={submit} data-testid="loopops.publish.surface">
      <header className="publishReviewHeader">
        <div>
          <button type="button" className="backLink" onClick={() => workspace.openLoop(loop.id)}>
            <ArrowLeft size={15} /> {t("actions.backToLoop")}
          </button>
          <p className="objectKicker">{t("loopOverview.kicker")}</p>
          <h2>{t("publish.reviewTitle", { title: loop.title })}</h2>
          <p>{t("publish.reviewCaption")}</p>
        </div>
      </header>

      <div className="publishReviewLayout">
        <main className="publishReviewMain">
          <section className="publishSection">
            <h3><Tag size={16} /> {t("publish.release")}</h3>
            <div className="publishFields">
              <label><span>{t("publish.version")}</span><input value={version} onChange={(event) => setVersion(event.target.value)} data-testid="loopops.publish.version" /></label>
              <label className="wide"><span>{t("publish.notes")}</span><textarea value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} rows={3} data-testid="loopops.publish.notes" /></label>
            </div>
            <label className="checkRow"><input type="checkbox" checked={startingPoint} onChange={(event) => setStartingPoint(event.target.checked)} /><span>{t("publish.startingPoint")}</span></label>
          </section>

          <section className="publishSection">
            <h3><ListChecks size={16} /> {t("publish.changes")}</h3>
            <div className="publishReviewRows">
              <span>{t("publish.definitionChanged")}</span>
              <span>{t("publish.stepsChanged", { count: nodes.length })}</span>
              <span>{t("publish.skillsChanged", { count: dependencies.length })}</span>
              <span>{t("publish.reviewChanged", { count: reviewCount })}</span>
            </div>
          </section>

          <section className="publishSection">
            <h3><CheckCircle2 size={16} /> {t("publish.validation")}</h3>
            <div className="publishEvidence">
              <div><CheckCircle2 size={16} /><span>{t("publish.validationPassed")}</span></div>
              <div className={latestCompletedRun ? "" : "muted"}><CheckCircle2 size={16} /><span>{latestCompletedRun ? t("publish.latestRunPassed") : t("publish.latestRunMissing")}</span></div>
            </div>
          </section>

          <section className="publishSection">
            <h3><LockKeyhole size={16} /> {t("publish.permissions")}</h3>
            <p>{t("publish.noExternalWrite")}</p>
            <p>{t("publish.connectionsRebound")}</p>
          </section>

          <section className="publishSection">
            <h3><Link2 size={16} /> {t("publish.dependencies")}</h3>
            <div className="dependencyRows">
              {dependencies.map((node) => <div key={node.id}><strong>{node.title}</strong><span>{node.skillVersion || t("runPreflight.none")}</span></div>)}
              {!dependencies.length ? <p>{t("runPreflight.none")}</p> : null}
            </div>
          </section>
        </main>

        <aside className="publishReviewRail">
          <div className={`publishReadiness ${allChecksReady ? "ready" : "blocked"}`}>
            {allChecksReady ? <CheckCircle2 size={22} /> : <AlertCircle size={22} />}
            <div><h3>{allChecksReady ? t("publish.ready") : t("publish.blocked")}</h3><p>{t("publish.immutableNotice")}</p></div>
          </div>
          <dl className="publishFacts">
            <dt>{t("publish.savedVersion")}</dt><dd>{loop.currentRevisionId}</dd>
            <dt>{t("publish.version")}</dt><dd>{version || "-"}</dd>
            <dt>{t("library.shared")}</dt><dd>{t("publish.teamVisibility")}</dd>
          </dl>
          <ul className="publishChecklist">
            {checks.map((item) => <li key={item.label} className={item.ready ? "ready" : "blocked"}><span>{item.ready ? <Check size={13} /> : "!"}</span>{item.label}</li>)}
          </ul>
          <label className="publishConsent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{t("publish.consent")}</span></label>
          <Button variant="primary" type="submit" disabled={!canPublish} data-testid="loopops.publish.submit">{submitting ? t("state.syncing") : t("publish.confirm")}</Button>
          <Button variant="secondary" type="button" onClick={() => workspace.openLoop(loop.id)}>{t("actions.backToLoop")}</Button>
        </aside>
      </div>
    </form>
  );
}
