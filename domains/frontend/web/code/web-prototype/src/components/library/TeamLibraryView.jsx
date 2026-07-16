import { useEffect, useState } from "react";
import { Boxes, CheckCircle2, Download, GitBranch, Info, MoreHorizontal, RefreshCw, Search, Users } from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ConnectionRebindingSheet } from "../connections/ConnectionRebindingSheet.jsx";
import { useTeamConnectionActions } from "../connections/useTeamConnectionActions.js";
import { EmptyState } from "../shared/EmptyState.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { productActorName, productDescription, productTitle } from "../../utils/productCopy.js";

function displayKind(release, t) {
  return release.assetKind === "loop" ? t("library.loop") : t("library.skill");
}

export function TeamLibraryView({ workspace }) {
  const t = workspace.t;
  const [query, setQuery] = [workspace.query, workspace.setQuery];
  const [reviewReleaseId, setReviewReleaseId] = useState("");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [kind, setKind] = useState("all");
  const connectionActions = useTeamConnectionActions(workspace);
  const releases = workspace.teamLibrary.filter((release) => {
    const searchable = `${release.title} ${release.description} ${release.releaseNotes} ${release.assetKind}`.toLowerCase();
    const kindMatches = kind === "all"
      || release.assetKind === kind
      || (kind === "starting" && release.assetKind === "loop" && release.startingPoint)
      || (kind === "installed" && release.installed)
      || (kind === "updates" && release.canAdopt);
    return searchable.includes(query.toLowerCase()) && kindMatches;
  });
  const selectedRelease = releases.find((release) => release.releaseId === selectedReleaseId) || releases[0] || null;

  useEffect(() => {
    if (selectedRelease && selectedRelease.releaseId !== selectedReleaseId) setSelectedReleaseId(selectedRelease.releaseId);
  }, [selectedRelease, selectedReleaseId]);

  if (workspace.surfaceState?.library?.loading || workspace.surfaceState?.library?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={workspace.surfaceState.library}
        objectLabel={t("page.library.title")}
        onRetry={() => workspace.retrySurface("library")}
        onBack={() => workspace.setActivePage("loops")}
        backLabel={t("actions.openLoops")}
        testId="loopops.library.query-state"
      />
    );
  }

  return (
    <div className="surface teamLibrary teamLibraryV1" data-testid="loopops.library.surface">
      <div className="teamLibraryToolbar">
        <label className="librarySearch">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("library.search")} aria-label={t("library.search")} />
        </label>
        <div className="libraryKindFilter" role="group" aria-label={t("library.filterLabel")}>
          {["all", "skill", "loop", "starting", "installed", "updates"].map((value) => (
            <button type="button" key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => setKind(value)} data-testid={`loopops.library.filter.${value}`}>
              {t(`library.filter.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {releases.length ? (
        <div className="teamLibraryWorkspace">
          <section className="teamAssetTable" role="table" aria-label={t("library.heading")}>
            <div className="teamAssetRow teamAssetHeader" role="row">
              <span>{t("library.columns.asset")}</span><span>{t("library.columns.purpose")}</span><span>{t("library.columns.maintainer")}</span><span>{t("library.columns.version")}</span><span>{t("library.columns.validation")}</span><span>{t("library.columns.usage")}</span><span>{t("library.columns.status")}</span><span>{t("library.columns.action")}</span>
            </div>
            {releases.map((release) => {
              const canStart = release.assetKind === "loop" && release.startingPoint;
              const busy = connectionActions.busyAction.endsWith(`:${release.releaseId}`);
              const maintainer = productActorName(release.publishedBy, workspace.locale) || t("library.productTeam");
              return (
                <article className={`teamAssetRow ${selectedRelease?.releaseId === release.releaseId ? "selected" : ""}`} key={release.releaseId} role="row" onClick={() => setSelectedReleaseId(release.releaseId)} tabIndex={0}>
                  <span className="teamAssetIdentity" role="cell"><span className={`teamAssetIcon ${release.assetKind}`}>{release.assetKind === "loop" ? <GitBranch size={16} /> : <Boxes size={16} />}</span><span><strong>{productTitle(release, workspace.locale)}</strong><small>{displayKind(release, t)}</small></span></span>
                  <span className="teamAssetPurpose" role="cell">{productDescription(release, workspace.locale) || t("library.noReleaseNotes")}</span>
                  <span className="teamAssetMaintainer" role="cell"><span>{maintainer.slice(0, 1).toUpperCase()}</span><small>{maintainer}</small></span>
                  <span role="cell">{release.versionLabel}</span>
                  <span className="teamAssetValidated" role="cell"><CheckCircle2 size={14} /><small>{t("library.validated")}</small></span>
                  <span role="cell">{t("library.usageCount", { count: release.usageCount || 0 })}</span>
                  <span role="cell">{release.canAdopt ? <StatusPill tone="warning">{t("actions.reviewUpdate")}</StatusPill> : release.installed ? <StatusPill tone="success">{t("library.installed")}</StatusPill> : <StatusPill>{t("library.notInstalled")}</StatusPill>}</span>
                  <span className="teamAssetActions" role="cell">
                    {release.canAdopt ? <Button variant="secondary" disabled={workspace.readOnlyWorkspace || busy} onClick={(event) => { event.stopPropagation(); setSelectedReleaseId(release.releaseId); setReviewReleaseId(release.releaseId); }} data-testid={`loopops.library.review-update.${release.releaseId}`}>{t("actions.reviewUpdate")}</Button>
                      : canStart ? <Button variant="secondary" disabled={workspace.readOnlyWorkspace || busy} onClick={(event) => { event.stopPropagation(); connectionActions.startingPoint(release, `${release.title} ${t("library.copySuffix")}`); }}>{t("actions.useStartingPoint")}</Button>
                        : release.installed ? <button type="button" className="rowMoreAction" aria-label={t("actions.open")} onClick={(event) => { event.stopPropagation(); release.assetKind === "loop" ? workspace.openLibraryLoop(release.assetId) : workspace.openLibrarySkill(release.assetId); }}><MoreHorizontal size={16} /></button>
                          : <Button variant="secondary" icon={<Download size={14} />} disabled={workspace.readOnlyWorkspace || busy} onClick={(event) => { event.stopPropagation(); connectionActions.install(release); }}>{t("actions.install")}</Button>}
                  </span>
                </article>
              );
            })}
          </section>
          <aside className="teamAssetPreview">
            {selectedRelease ? <>
              <header><span className={`teamAssetIcon large ${selectedRelease.assetKind}`}>{selectedRelease.assetKind === "loop" ? <GitBranch size={20} /> : <Boxes size={20} />}</span><div><p>{displayKind(selectedRelease, t)}</p><h2>{productTitle(selectedRelease, workspace.locale)}</h2></div></header>
              <p className="teamAssetPreviewPurpose">{productDescription(selectedRelease, workspace.locale) || t("library.noReleaseNotes")}</p>
              <dl><dt>{t("library.columns.maintainer")}</dt><dd>{productActorName(selectedRelease.publishedBy, workspace.locale) || t("library.productTeam")}</dd><dt>{t("library.columns.version")}</dt><dd>{selectedRelease.versionLabel}</dd><dt>{t("library.columns.validation")}</dt><dd>{t("library.validated")}</dd></dl>
              <section><h3>{t("library.connections")}</h3><p>{t("publish.connectionsRebound")}</p></section>
              <section><h3>{t("library.usedBy")}</h3><p><Users size={15} /> {t("library.usageCount", { count: selectedRelease.usageCount || 0 })}</p></section>
              {reviewReleaseId === selectedRelease.releaseId ? <section className="libraryInlineUpdateReview" data-testid={`loopops.library.update-review.${selectedRelease.releaseId}`}><h3>{t("actions.reviewUpdate")}</h3><p>{selectedRelease.releaseNotes || t("library.noReleaseNotes")}</p><div className="updateImpactNote"><Info size={16} /><span>{t("library.updateImpact")}</span></div><div className="buttonRow"><Button variant="secondary" disabled={connectionActions.busyAction.endsWith(`:${selectedRelease.releaseId}`)} onClick={() => setReviewReleaseId("")}>{t("actions.keepCurrentVersion")}</Button><Button variant="primary" icon={<RefreshCw size={15} />} disabled={workspace.readOnlyWorkspace || connectionActions.busyAction.endsWith(`:${selectedRelease.releaseId}`)} onClick={() => connectionActions.update(selectedRelease, () => setReviewReleaseId(""))} data-testid={`loopops.library.apply-update.${selectedRelease.releaseId}`}>{t("actions.updateInstalledVersion")}</Button></div></section> : null}
              <footer><Button variant="primary" onClick={() => selectedRelease.assetKind === "loop" ? workspace.openLibraryLoop(selectedRelease.assetId) : workspace.openLibrarySkill(selectedRelease.assetId)} data-testid={`loopops.library.open.${selectedRelease.releaseId}`}>{selectedRelease.assetKind === "loop" ? (selectedRelease.startingPoint ? t("actions.useStartingPoint") : t("actions.open")) : t("actions.viewSkill")}</Button></footer>
            </> : null}
          </aside>
        </div>
      ) : (
        <EmptyState
          title={query ? t("library.noMatchesTitle") : t("library.emptyTitle")}
          body={query ? t("library.noMatchesBody", { query }) : t("library.emptyBody")}
          actionLabel={query ? t("actions.clearSearch") : t("actions.openLoops")}
          onAction={query ? () => setQuery("") : () => workspace.setActivePage("loops")}
        />
      )}
      <ConnectionRebindingSheet
        {...connectionActions.sheetProps}
        readOnly={workspace.readOnlyWorkspace}
        onRequestAccess={workspace.requestWorkspaceAccess}
        t={t}
      />
    </div>
  );
}
