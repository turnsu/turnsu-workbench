import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Download, Info, RefreshCw, ShieldCheck, X } from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ConnectionRebindingSheet } from "../connections/ConnectionRebindingSheet.jsx";
import { useTeamConnectionActions } from "../connections/useTeamConnectionActions.js";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

function newestRelease(items) {
  return [...items].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))[0] || null;
}

function readableList(values, fallback) {
  return Array.isArray(values) && values.length ? values.join(", ") : fallback;
}

export function TeamLibrarySkillView({ workspace }) {
  const t = workspace.t;
  const skillId = workspace.route.skillId;
  const releases = workspace.teamLibrary.filter((item) => item.assetKind === "skill" && item.assetId === skillId);
  const release = newestRelease(releases);
  const skill = release?.skillDetails;
  const installation = release?.installation || null;
  const installedRelease = releases.find((item) => item.versionId === installation?.pinnedVersionId) || null;
  const installedVersion = installedRelease?.versionLabel || installation?.pinnedVersionId || "-";
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const connectionActions = useTeamConnectionActions(workspace);
  const busy = Boolean(connectionActions.busyAction);

  useEffect(() => setReviewUpdate(Boolean(release?.canAdopt)), [release?.releaseId, release?.canAdopt]);

  const facts = useMemo(() => [
    [t("library.skillPurpose"), release?.description || t("library.noReleaseNotes")],
    [t("skills.needs"), readableList(skill?.inputs, t("runPreflight.none"))],
    [t("skills.creates"), readableList(skill?.outputs, t("runPreflight.none"))],
    [t("skills.dependsOn"), readableList(skill?.dependencies, t("runPreflight.none"))],
    [t("skills.risk"), skill?.risk || t("risk.low")],
    [t("library.compatibility"), release?.compatibility || release?.compatibilityLabel || t("library.currentWorkspace")],
  ], [release, skill, t]);

  if (workspace.surfaceState?.library?.loading || workspace.surfaceState?.library?.error) {
    return <ObjectQueryState workspace={workspace} state={workspace.surfaceState.library} objectLabel={t("library.skill")} onRetry={() => workspace.retrySurface("library")} onBack={() => workspace.setActivePage("library")} backLabel={t("actions.backToLibrary")} testId="loopops.library.skill-query-state" />;
  }

  if (!release) {
    return <div className="surface objectPageEmpty" data-testid="loopops.library.skill-detail"><h2>{t("library.noSkill")}</h2><Button variant="secondary" onClick={() => workspace.setActivePage("library")}>{t("actions.backToLibrary")}</Button></div>;
  }

  return (
    <div className={`surface librarySkillPage ${reviewUpdate ? "withUpdateReview" : ""}`} data-testid="loopops.library.skill-detail">
      <header className="librarySkillHeader">
        <div>
          <button type="button" className="backLink" onClick={() => workspace.setActivePage("library")}><ArrowLeft size={15} /> {t("actions.backToLibrary")}</button>
          <p className="objectKicker">{t("library.skillDetailKicker")}</p>
          <div className="libraryLoopTitle"><h2>{release.title}</h2><StatusPill tone="info">{t("library.skill")}</StatusPill><span>{release.versionLabel}</span></div>
          <p className="libraryLoopMeta"><span>{t("library.maintainedBy")}</span><span><CheckCircle2 size={14} /> {t("library.validated")}</span></p>
          <p>{release.description || release.releaseNotes}</p>
        </div>
        <div className="libraryLoopActions">
          {!installation ? <Button variant="primary" icon={<Download size={15} />} disabled={workspace.readOnlyWorkspace || busy} title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined} onClick={() => connectionActions.install(release)} data-testid="loopops.library.skill.install">{t("actions.install")}</Button> : <StatusPill tone="success">{t("library.installed")}</StatusPill>}
        </div>
      </header>

      <div className="libraryLoopExplainer"><ShieldCheck size={16} /><span>{t("library.skillInstallExplainer")}</span></div>
      <div className="librarySkillLayout">
        <main className="librarySkillMain">
          <div className="librarySkillFacts">
            {facts.map(([label, value]) => <section key={label}><h3>{label}</h3><p>{value}</p></section>)}
          </div>
          <section className="libraryReleaseNotes"><h3>{t("library.exampleResult")}</h3><p>{release.releaseNotes || t("library.noReleaseNotes")}</p></section>
        </main>
        {reviewUpdate ? (
          <aside className="libraryUpdateReview" data-testid="loopops.library.skill.update-review">
            <div className="libraryUpdateTitle"><div><p className="objectKicker">{t("actions.reviewUpdate")}</p><h3>{t("library.updateTitle")}</h3></div><button type="button" aria-label={t("actions.close")} onClick={() => setReviewUpdate(false)}><X size={16} /></button></div>
            <div className="versionTransition"><strong>{installedVersion}</strong><span>→</span><strong>{release.versionLabel}</strong></div>
            <p>{release.releaseNotes || t("library.noReleaseNotes")}</p>
            <div className="updateImpactNote"><Info size={16} /><span>{t("library.skillUpdateImpact")}</span></div>
            <div className="updateReviewActions"><Button variant="secondary" disabled={busy} onClick={() => setReviewUpdate(false)}>{t("actions.keepCurrentVersion")}</Button><Button variant="primary" icon={<RefreshCw size={15} />} disabled={workspace.readOnlyWorkspace || busy} onClick={() => connectionActions.update(release, () => setReviewUpdate(false))} data-testid="loopops.library.skill.apply-update">{t("actions.updateInstalledVersion")}</Button></div>
          </aside>
        ) : null}
      </div>
      <ConnectionRebindingSheet {...connectionActions.sheetProps} readOnly={workspace.readOnlyWorkspace} onRequestAccess={workspace.requestWorkspaceAccess} t={t} />
    </div>
  );
}
