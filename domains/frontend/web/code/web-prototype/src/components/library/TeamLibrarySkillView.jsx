import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Info, RefreshCw, X } from "lucide-react";

import { NativeSkillDialog } from "./NativeSkillDialog.jsx";
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
  const [nativeOpen, setNativeOpen] = useState(false);
  const zh = workspace.locale === "zh";
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const connectionActions = useTeamConnectionActions(workspace);
  const busy = Boolean(connectionActions.busyAction);

  useEffect(() => setReviewUpdate(Boolean(release?.canAdopt)), [release?.releaseId, release?.canAdopt]);

  const facts = useMemo(() => [
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

          <div className="libraryLoopTitle"><h1>{release.title}</h1><StatusPill tone="info">{t("library.skill")}</StatusPill><span>{release.versionLabel}</span></div>

          <p>{release.description || release.releaseNotes}</p>
        </div>
        <div className="libraryLoopActions"><Button variant="primary" disabled={workspace.readOnlyWorkspace} onClick={() => setNativeOpen(true)}>{zh ? "用自己的 Agent 使用" : "Use with my Agent"}</Button>
          {!installation ? <Button variant="secondary" icon={<Download size={15} />} disabled={workspace.readOnlyWorkspace || busy} title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined} onClick={() => connectionActions.install(release)} data-testid="loopops.library.skill.install">{zh ? "添加到 Turnsu" : "Add to Turnsu"}</Button> : <StatusPill tone="success">{zh ? "已添加到 Turnsu" : "Added to Turnsu"}</StatusPill>}
        </div>
      </header>

      <div className="librarySkillLayout">
        <main className="librarySkillMain">
          <section className="libraryReleaseNotes"><h3>{zh ? "版本说明" : "Release notes"}</h3><p>{release.releaseNotes || t("library.noReleaseNotes")}</p></section>
          <details className="librarySkillTechnicalDetails"><summary>{zh ? "技能参数与适用范围" : "Skill parameters and compatibility"}</summary>
            <div className="librarySkillFacts">
              {facts.map(([label, value]) => <section key={label}><h3>{label}</h3><p>{value}</p></section>)}
            </div>
          </details>
        </main>
        {reviewUpdate ? (
          <aside className="libraryUpdateReview" data-testid="loopops.library.skill.update-review">
            <div className="libraryUpdateTitle"><div><p className="objectKicker">{t("actions.reviewUpdate")}</p><h3>{t("library.updateTitle")}</h3></div><button type="button" aria-label={t("actions.close")} onClick={() => setReviewUpdate(false)}><X size={16} /></button></div>
            <div className="versionTransition"><strong>{installedVersion}</strong><span>→</span><strong>{release.versionLabel}</strong></div>
            <p>{release.releaseNotes || t("library.noReleaseNotes")}</p>
            <div className="updateImpactNote"><Info size={16} /><span>{t("library.skillUpdateImpact")}</span></div>
            <div className="updateReviewActions">
              <Button variant="secondary" disabled={busy} onClick={() => setReviewUpdate(false)}>{t("actions.keepCurrentVersion")}</Button>
              <Button
                variant="primary"
                icon={<RefreshCw size={15} />}
                disabled={workspace.readOnlyWorkspace || busy}
                onClick={() => connectionActions.update(release, (result) => {
                  workspace.navigateToPath(`/library?updateDraftId=${encodeURIComponent(result.data.updateDraftId)}`);
                })}
                data-testid="loopops.library.skill.apply-update"
              >
                {t("actions.updateInstalledVersion")}
              </Button>
            </div>
          </aside>
        ) : null}
      </div>
      {nativeOpen ? <NativeSkillDialog key={release.releaseId} release={release} locale={workspace.locale} onClose={() => setNativeOpen(false)} /> : null}
      <ConnectionRebindingSheet {...connectionActions.sheetProps} readOnly={workspace.readOnlyWorkspace} onRequestAccess={workspace.requestWorkspaceAccess} t={t} />
    </div>
  );
}
