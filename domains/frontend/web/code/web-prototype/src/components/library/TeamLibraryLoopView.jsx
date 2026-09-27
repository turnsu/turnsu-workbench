import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileInput,
  Flag,
  GitBranch,
  Info,
  ListChecks,
  LockKeyhole,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ConnectionRebindingSheet } from "../connections/ConnectionRebindingSheet.jsx";
import { useTeamConnectionActions } from "../connections/useTeamConnectionActions.js";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

function newestRelease(items) {
  return [...items].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))[0] || null;
}

function definitionValue(value, fallback) {
  if (Array.isArray(value)) return value.join("; ") || fallback;
  return String(value || fallback);
}

export function TeamLibraryLoopView({ workspace }) {
  const t = workspace.t;
  const loopId = workspace.route.loopId;
  const releases = workspace.teamLibrary.filter((item) => item.assetKind === "loop" && item.assetId === loopId);
  const release = newestRelease(releases);
  const workflow = workspace.selectedWorkflow;
  const definition = workflow?.canonicalRevision?.definition || workspace.editorState?.baseRevision?.definition || {};
  const nodes = workflow?.workflow?.nodes || [];
  const inputCount = workflow?.requiredInputs?.length || 0;
  const reviewCount = nodes.filter((node) => node.type === "Review Gate").length;
  const installation = release?.installation || null;
  const installedRelease = releases.find((item) => item.versionId === installation?.pinnedVersionId) || null;
  const installedVersion = installedRelease?.versionLabel || installation?.pinnedVersionId || "-";
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const [creatingCopy, setCreatingCopy] = useState(false);
  const connectionActions = useTeamConnectionActions(workspace);
  const busy = Boolean(connectionActions.busyAction);

  useEffect(() => setReviewUpdate(Boolean(release?.canAdopt)), [release?.releaseId, release?.canAdopt]);

  const facts = useMemo(() => [
    { icon: Sparkles, label: t("library.helpTitle"), value: definitionValue(definition.goal, workflow?.description || release?.description) },
    { icon: FileInput, label: t("library.requiredInformation"), value: inputCount ? t("loopsBoard.stepCount", { count: inputCount }) : t("runPreflight.none") },
    { icon: Flag, label: t("library.expectedResult"), value: definitionValue(definition.expectedResult, release?.description) },
    { icon: ListChecks, label: t("library.skillSequence"), value: t("loopsBoard.stepCount", { count: nodes.length }) },
    { icon: CheckCircle2, label: t("library.reviewPoint"), value: reviewCount ? t("runPreflight.reviewVisible", { count: reviewCount }) : t("runPreflight.none") },
    { icon: LockKeyhole, label: t("library.permissions"), value: t("publish.noExternalWrite") },
    { icon: GitBranch, label: t("library.exampleResult"), value: release?.releaseNotes || t("library.noReleaseNotes") },
    { icon: Download, label: t("library.usedBy"), value: installation ? t("library.installed") : t("runPreflight.none") },
  ], [definition, inputCount, installation, nodes.length, release, reviewCount, t, workflow?.description]);

  if (workspace.surfaceState?.library?.loading || workspace.surfaceState?.library?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={workspace.surfaceState.library}
        objectLabel={t("library.loop")}
        onRetry={() => workspace.retrySurface("library")}
        onBack={() => workspace.setActivePage("library")}
        backLabel={t("actions.backToLibrary")}
        testId="loopops.library.loop-query-state"
      />
    );
  }

  if (!release) {
    return (
      <div className="surface objectPageEmpty" data-testid="loopops.library.loop-detail">
        <h2>{t("library.noLoop")}</h2>
        <Button variant="secondary" onClick={() => workspace.setActivePage("library")}>{t("actions.backToLibrary")}</Button>
      </div>
    );
  }

  return (
    <div className={`surface libraryLoopPage ${reviewUpdate ? "withUpdateReview" : ""}`} data-testid="loopops.library.loop-detail">
      <header className="libraryLoopHeader">
        <div>
          <button type="button" className="backLink" onClick={() => workspace.setActivePage("library")}><ArrowLeft size={15} /> {t("actions.backToLibrary")}</button>
          <p className="objectKicker">{t("library.detailKicker")}</p>
          <div className="libraryLoopTitle"><h2>{release.title}</h2><StatusPill tone="info">{t("library.loop")}</StatusPill><span>{release.versionLabel}</span></div>
          <p className="libraryLoopMeta"><span>{t("library.maintainedBy")}</span><span><CheckCircle2 size={14} /> {t("library.validated")}</span></p>
          <p>{release.description || release.releaseNotes}</p>
        </div>
        <div className="libraryLoopActions">
          <Button variant="primary" icon={<FileInput size={15} />} disabled={workspace.readOnlyWorkspace || busy || creatingCopy}
            onClick={async () => { setCreatingCopy(true); try { await workspace.useTeamLoop(release.releaseId); } finally { setCreatingCopy(false); } }}
            data-testid="turnsu.library.use-loop">{t(creatingCopy ? "library.creatingCopy" : "library.useLoop")}</Button>
          {!installation ? <Button variant="secondary" icon={<Download size={15} />} disabled={workspace.readOnlyWorkspace || busy} title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined} onClick={() => connectionActions.install(release)} data-testid="loopops.library.install">{t("actions.install")}</Button> : null}
        </div>
      </header>

      <div className="libraryLoopExplainer"><Info size={16} /><span>{t("library.useLoopExplainer")}</span></div>

      {release.canAdopt ? (
        <div className="libraryUpdateBanner">
          <Info size={16} />
          <span>{t("library.updateAvailable", { current: installedVersion, next: release.versionLabel })}</span>
          <Button variant="secondary" size="sm" onClick={() => setReviewUpdate(true)} data-testid="loopops.library.review-update">{t("actions.reviewUpdate")}</Button>
        </div>
      ) : null}

      <nav className="objectPageTabs" aria-label={t("loopOverview.sections")}><span className="active" aria-current="page">{t("loopOverview.overview")}</span></nav>

      <div className="libraryLoopLayout">
        <main className="libraryLoopMain">
          <div className="libraryFactList">
            {facts.map(({ icon: Icon, label, value }) => (
              <section key={label}>
                <Icon size={18} />
                <h3>{label}</h3>
                <p>{value}</p>
              </section>
            ))}
          </div>
        </main>

        {reviewUpdate ? (
          <aside className="libraryUpdateReview" data-testid="loopops.library.update-review">
            <div className="libraryUpdateTitle"><div><p className="objectKicker">{t("actions.reviewUpdate")}</p><h3>{t("library.updateTitle")}</h3></div><button type="button" aria-label={t("actions.close")} onClick={() => setReviewUpdate(false)}><X size={16} /></button></div>
            <div className="versionTransition"><strong>{installedVersion}</strong><span>→</span><strong>{release.versionLabel}</strong></div>
            <h4>{t("library.whatsNew", { version: release.versionLabel })}</h4>
            <p>{release.releaseNotes || t("library.noReleaseNotes")}</p>
            <div className="updateImpactNote"><Info size={16} /><span>{t("library.updateImpact")}</span></div>
            <div className="updateReviewActions">
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setReviewUpdate(false)}>{t("actions.keepCurrentVersion")}</Button>
              <Button
                variant="primary"
                icon={<RefreshCw size={15} />}
                disabled={workspace.readOnlyWorkspace || busy}
                title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined}
                onClick={() => connectionActions.update(release, (result) => {
                  workspace.navigateToPath(`/library?updateDraftId=${encodeURIComponent(result.data.updateDraftId)}`);
                })}
                data-testid="loopops.library.apply-update"
              >
                {t("actions.updateInstalledVersion")}
              </Button>
            </div>
            <p className="safeVersionNote"><LockKeyhole size={14} /> {t("library.currentVersionSafe")}</p>
          </aside>
        ) : null}
      </div>
      <ConnectionRebindingSheet
        {...connectionActions.sheetProps}
        readOnly={workspace.readOnlyWorkspace}
        onRequestAccess={workspace.requestWorkspaceAccess}
        t={t}
      />
    </div>
  );
}
