import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Download,
  GitBranch,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ConnectionRebindingSheet } from "../connections/ConnectionRebindingSheet.jsx";
import { useTeamConnectionActions } from "../connections/useTeamConnectionActions.js";
import { EmptyState } from "../shared/EmptyState.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { productActorName, productDescription, productTitle } from "../../utils/productCopy.js";
import { useModelCatalog } from "../../state/models/index.js";
import {
  useInstallationUpdateDraftQuery,
  useInstallationUpdateImpactQuery,
} from "../../api/queries.js";

const DOMAINS = ["all", "product", "research", "data", "engineering"];
const TYPES = ["all", "skill", "workflow", "starting"];

function localCopy(locale, zh, en) {
  return locale === "zh" ? zh : en;
}

function displayKind(release, workspace) {
  if (release.startingPoint) return localCopy(workspace.locale, "工作流模板", "Workflow template");
  return release.assetKind === "loop" ? workspace.t("library.loop") : workspace.t("library.skill");
}

function domainFor(release) {
  if (["product", "research", "data", "engineering"].includes(release.domain)) {
    return release.domain;
  }
  // Compatibility for a stale cached response. Current Product API supplies
  // the governed domain; the browser never classifies an asset from its copy.
  return "product";
}

function typeMatches(release, type) {
  if (type === "all") return true;
  if (type === "skill") return release.assetKind === "skill";
  if (type === "workflow") return release.assetKind === "loop" && !release.startingPoint;
  return release.assetKind === "loop" && release.startingPoint;
}

function latestByAsset(releases) {
  const newest = new Map();
  releases.forEach((release) => {
    const key = `${release.assetKind}:${release.assetId}`;
    const current = newest.get(key);
    const nextOrder = String(release.publishedAt || release.version || release.versionId || "");
    const currentOrder = String(current?.publishedAt || current?.version || current?.versionId || "");
    if (!current || nextOrder.localeCompare(currentOrder) >= 0) newest.set(key, release);
  });
  return [...newest.values()];
}

function domainLabel(domain, locale) {
  return {
    all: localCopy(locale, "全部领域", "All domains"),
    product: localCopy(locale, "产品", "Product"),
    research: localCopy(locale, "研究", "Research"),
    data: localCopy(locale, "数据", "Data"),
    engineering: localCopy(locale, "工程", "Engineering"),
  }[domain];
}

function typeLabel(type, locale) {
  return {
    all: localCopy(locale, "全部", "All"),
    skill: localCopy(locale, "技能", "Skills"),
    workflow: localCopy(locale, "工作流", "Workflows"),
    starting: localCopy(locale, "工作流模板", "Workflow templates"),
  }[type];
}

function visibilityLabel(release, locale) {
  return release.visibility === "workspace"
    ? localCopy(locale, "工作区可见", "Workspace visible")
    : localCopy(locale, "私有", "Private");
}

function releaseStatus(release, t) {
  if (release.canAdopt) return { tone: "warning", label: t("actions.reviewUpdate") };
  if (release.installed) return { tone: "success", label: t("library.installed") };
  return { tone: "neutral", label: t("library.notInstalled") };
}

function actionMutates(release) {
  return Boolean(release.canAdopt || release.startingPoint || !release.installed);
}

function includedSummary(release, locale) {
  if (release.assetKind === "skill") {
    const inputs = release.skillDetails?.inputs || [];
    const outputs = release.skillDetails?.outputs || [];
    if (!inputs.length && !outputs.length) return localCopy(locale, "未声明输入与输出", "No inputs or outputs declared");
    return `${inputs.length || 0} ${localCopy(locale, "项输入", "inputs")} → ${outputs.length || 0} ${localCopy(locale, "项输出", "outputs")}`;
  }
  const count = (release.dependencies || []).filter((dependency) => dependency.kind === "skill").length;
  return localCopy(locale, `${count} 个固定 Skill`, `${count} pinned Skills`);
}

export function TeamLibraryView({ workspace, navigationKey = "" }) {
  const t = workspace.t;
  const initialQuery = new URLSearchParams(globalThis.location?.search || "");
  const [query, setQuery] = [workspace.query, workspace.setQuery];
  const [reviewReleaseId, setReviewReleaseId] = useState("");
  const [updateDraftId, setUpdateDraftId] = useState(
    () => initialQuery.get("updateDraftId") || "",
  );
  const [connectionTarget, setConnectionTarget] = useState(() => ({
    connectionId: initialQuery.get("connectionId") || "",
    requirementId: initialQuery.get("requirementId") || "",
  }));
  const [setupTarget, setSetupTarget] = useState(() => initialQuery.get("setup") || "");
  const [setupObjectId, setSetupObjectId] = useState(() => initialQuery.get("profileId") || "");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [domain, setDomain] = useState("all");
  const [type, setType] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const connectionActions = useTeamConnectionActions(workspace);

  const releases = useMemo(() => latestByAsset(workspace.teamLibrary), [workspace.teamLibrary]);
  const classified = useMemo(
    () => releases.map((release) => ({ ...release, libraryDomain: domainFor(release) })),
    [releases],
  );
  const visibleReleases = classified.filter((release) => {
    const searchable = `${productTitle(release, workspace.locale)} ${productDescription(release, workspace.locale)} ${release.releaseNotes || ""}`.toLowerCase();
    const domainMatches = domain === "all" || release.libraryDomain === domain;
    const stateMatches = stateFilter === "all"
      || (stateFilter === "installed" && Boolean(release.installation))
      || (stateFilter === "updates" && release.canAdopt);
    return searchable.includes(query.trim().toLowerCase())
      && domainMatches
      && stateMatches
      && typeMatches(release, type);
  });
  const updateDraft = useInstallationUpdateDraftQuery(updateDraftId, Boolean(updateDraftId));
  const draftTargetReleaseId = updateDraft.data?.data?.targetReleaseId || "";
  const selectedRelease = (draftTargetReleaseId
    ? classified.find((release) => release.releaseId === draftTargetReleaseId)
    : null)
    || visibleReleases.find((release) => release.releaseId === selectedReleaseId)
    || visibleReleases[0]
    || null;
  const installedVersionLabel = selectedRelease?.installation
    ? workspace.teamLibrary.find((release) => release.versionId === selectedRelease.installation.pinnedVersionId)?.versionLabel
      || selectedRelease.installation.pinnedVersionId
    : null;
  const updateImpact = useInstallationUpdateImpactQuery(
    selectedRelease?.installation?.installationId,
    selectedRelease?.releaseId,
    Boolean(selectedRelease?.canAdopt && reviewReleaseId === selectedRelease?.releaseId),
  );
  const displayedUpdateImpact = updateDraft.data?.data?.impact || updateImpact.data?.data || null;
  const setupModelCatalog = useModelCatalog({
    profileId: setupObjectId,
    selectionKind: "profile",
    selectedProfileId: setupObjectId,
    enabled: setupTarget === "models" && Boolean(setupObjectId),
  });
  const setupModelProfile = setupModelCatalog.profiles.find((profile) => (
    profile.profileId === setupObjectId
  ));
  const setupModelDecision = setupTarget === "models" && setupObjectId
    ? setupModelCatalog.isPending
      ? { status: "checking", reasonCode: "model_catalog_checking", message: localCopy(workspace.locale, "正在读取目标模型状态…", "Checking the target model…") }
      : setupModelCatalog.error
        ? { status: "unavailable", reasonCode: setupModelCatalog.error.code || "model_catalog_unavailable", message: setupModelCatalog.error.message }
        : setupModelProfile
          ? {
              status: setupModelProfile.readiness,
              reasonCode: `model_${setupModelProfile.readiness}`,
              message: setupModelProfile.readinessReason || localCopy(
                workspace.locale,
                `目标模型当前状态：${setupModelProfile.readiness}`,
                `Target model status: ${setupModelProfile.readiness}`,
              ),
            }
          : { status: "unavailable", reasonCode: "model_profile_not_found", message: localCopy(workspace.locale, "目标模型不存在或你无权查看。", "The target model does not exist or is not visible to you.") }
    : null;
  const setupDecision = setupTarget === "models"
    ? setupModelDecision || {
        status: "needs_setup",
        reasonCode: "model_route_unresolved",
        message: localCopy(
          workspace.locale,
          "当前操作没有可用的受治理模型路由。请联系管理员配置模型目录与凭证。",
          "No governed model route is available for this operation. Contact an administrator to configure the model catalog and credentials.",
        ),
      }
    : setupTarget === "connections"
      ? workspace.creationReadiness?.actions?.connectionSetup?.runnable
      : setupTarget === "resources"
        ? workspace.creationReadiness?.actions?.workspaceResource?.importable
        : null;

  useEffect(() => {
    const currentQuery = new URLSearchParams(globalThis.location?.search || "");
    setUpdateDraftId(currentQuery.get("updateDraftId") || "");
    setConnectionTarget({
      connectionId: currentQuery.get("connectionId") || "",
      requirementId: currentQuery.get("requirementId") || "",
    });
    setSetupTarget(currentQuery.get("setup") || "");
    setSetupObjectId(currentQuery.get("profileId") || "");
  }, [navigationKey]);

  useEffect(() => {
    const targetReleaseId = updateDraft.data?.data?.targetReleaseId;
    if (!targetReleaseId) return;
    setReviewReleaseId(targetReleaseId);
    setSelectedReleaseId(targetReleaseId);
  }, [updateDraft.data?.data?.targetReleaseId]);

  useEffect(() => {
    if (!["applied", "kept_current"].includes(updateDraft.data?.data?.status)) return;
    closeUpdateDraftReview();
  }, [updateDraft.data?.data?.status]);

  useEffect(() => {
    if (draftTargetReleaseId) return;
    if (selectedRelease && selectedRelease.releaseId !== selectedReleaseId) {
      setSelectedReleaseId(selectedRelease.releaseId);
      setReviewReleaseId("");
    }
  }, [draftTargetReleaseId, selectedRelease, selectedReleaseId]);

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

  function openRelease(release) {
    if (release.assetKind === "loop") workspace.openLibraryLoop(release.assetId);
    else workspace.openLibrarySkill(release.assetId);
  }

  function closeUpdateDraftReview() {
    setUpdateDraftId("");
    setReviewReleaseId("");
    if (typeof globalThis.location === "undefined") return;
    const next = new URL(globalThis.location.href);
    next.searchParams.delete("updateDraftId");
    workspace.navigateToPath(
      `${next.pathname}${next.search}${next.hash}`,
      { replace: true },
    );
  }

  function openUpdateDraftReview(nextUpdateDraftId) {
    setUpdateDraftId(nextUpdateDraftId);
    const next = new URL(globalThis.location?.href || "http://localhost/library");
    next.searchParams.set("updateDraftId", nextUpdateDraftId);
    workspace.navigateToPath(`${next.pathname}${next.search}${next.hash}`);
  }

  function closeSetupRecovery() {
    setSetupTarget("");
    setSetupObjectId("");
    const next = new URL(globalThis.location?.href || "http://localhost/library");
    next.searchParams.delete("setup");
    next.searchParams.delete("profileId");
    workspace.navigateToPath(`${next.pathname}${next.search}${next.hash}`, { replace: true });
  }

  async function copySetupDiagnostic() {
    const diagnostic = [
      `workspace=${workspace.creationReadiness?.workspaceId || "unknown"}`,
      `setup=${setupTarget || "unknown"}`,
      `target=${setupObjectId || "unknown"}`,
      `status=${setupDecision?.status || "unknown"}`,
      `reason=${setupDecision?.reasonCode || "unknown"}`,
    ].join("\n");
    try {
      await globalThis.navigator?.clipboard?.writeText?.(diagnostic);
    } catch {
      // The recovery state remains visible when clipboard permission is denied.
    }
  }

  function runPrimaryAction(release) {
    if (release.canAdopt) {
      setReviewReleaseId(release.releaseId);
      return;
    }
    if (release.installed) {
      openRelease(release);
      return;
    }
    connectionActions.install(release);
  }

  function primaryLabel(release) {
    if (release.canAdopt) return localCopy(workspace.locale, "查看影响", "Review impact");
    if (release.installed) return release.assetKind === "loop" ? t("actions.open") : t("actions.viewSkill");
    return t("actions.install");
  }

  function rowAction(release, event) {
    event.stopPropagation();
    if (release.canAdopt) { setSelectedReleaseId(release.releaseId); setReviewReleaseId(release.releaseId); }
    else openRelease(release);
  }

  function closeConnectionTarget() {
    setConnectionTarget({ connectionId: "", requirementId: "" });
    const url = new URL(globalThis.location?.href || "http://localhost/library");
    url.searchParams.delete("connectionId");
    url.searchParams.delete("requirementId");
    globalThis.history?.replaceState?.({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  const typeCounts = Object.fromEntries(TYPES.map((value) => [value, classified.filter((release) => typeMatches(release, value)).length]));
  const domainCounts = Object.fromEntries(DOMAINS.map((value) => [value, classified.filter((release) => value === "all" || release.libraryDomain === value).length]));

  return (
    <div className={`surface m5TeamLibrary ${reviewReleaseId ? "withUpdateReview" : ""}`} data-testid="loopops.library.surface">
      <header className="m5LibraryHeader">
        <div>
          <p>{localCopy(workspace.locale, "使用团队已经积累的方法", "Use methods your team has shared")}</p>
          <h1>{t("page.library.title")}</h1>
        </div>
        <label className="m5LibrarySearch">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("library.search")} aria-label={t("library.search")} />
        </label>
      </header>

      {setupTarget ? (
        <section className="workspaceConnectionBanner" role="status" data-testid={`loopops.library.setup.${setupTarget}`}>
          <div>
            <strong>{setupDecision?.status === "ready" || setupDecision?.status === "degraded"
              ? localCopy(workspace.locale, "目标能力已经恢复", "The target capability is available")
              : localCopy(workspace.locale, "需要管理员完成服务端配置", "Administrator setup is required")}</strong>
            <span>{setupDecision?.message || localCopy(
              workspace.locale,
              "这个恢复入口当前没有可用的受治理配置流程。请联系管理员，并附上诊断信息。",
              "No governed setup flow is available for this recovery target. Contact an administrator and include the diagnostic.",
            )}</span>
            {setupObjectId ? (
              <small>{localCopy(workspace.locale, `目标模型：${setupObjectId}`, `Target model: ${setupObjectId}`)}</small>
            ) : null}
          </div>
          <Button variant="plain" onClick={copySetupDiagnostic}>{localCopy(workspace.locale, "复制诊断", "Copy diagnostic")}</Button>
          {setupDecision?.status === "ready" || setupDecision?.status === "degraded" ? null : (
            <Button variant="plain" onClick={workspace.requestWorkspaceAccess}>{localCopy(workspace.locale, "联系管理员", "Contact administrator")}</Button>
          )}
          <Button variant="plain" onClick={closeSetupRecovery}>{t("actions.dismiss")}</Button>
        </section>
      ) : null}

      {updateDraftId && updateDraft.isError ? (
        <section className="workspaceConnectionBanner" role="alert" data-testid="loopops.library.update-draft-stale">
          <div>
            <strong>{localCopy(workspace.locale, "更新草稿不可用", "Update draft unavailable")}</strong>
            <span>{localCopy(
              workspace.locale,
              "这个链接可能已过期、被处理，或不属于当前用户。现有安装版本没有被修改。",
              "This link may be stale, already resolved, or unavailable to the current user. The installed version was not changed.",
            )}</span>
          </div>
          <Button variant="plain" onClick={() => updateDraft.refetch()}>{t("actions.retry")}</Button>
          <Button variant="plain" onClick={closeUpdateDraftReview}>{localCopy(workspace.locale, "返回资源库", "Return to Library")}</Button>
        </section>
      ) : null}

      <div className="m5LibraryWorkspace">
        <aside className="m5LibraryDomainRail" data-testid="loopops.library.domain-rail">
          <section>
            <h2>{localCopy(workspace.locale, "领域", "Domains")}</h2>
            {DOMAINS.filter((value) => value === "all" || domainCounts[value] > 0 || domain === value).map((value) => (
              <button
                type="button"
                key={value}
                className={domain === value ? "active" : ""}
                aria-pressed={domain === value}
                onClick={() => setDomain(value)}
              >
                <span>{domainLabel(value, workspace.locale)}</span><small>{domainCounts[value]}</small>
              </button>
            ))}
          </section>
          <section>
            <h2>{localCopy(workspace.locale, "状态", "Status")}</h2>
            <button type="button" className={stateFilter === "installed" ? "active" : ""} aria-pressed={stateFilter === "installed"} onClick={() => setStateFilter(stateFilter === "installed" ? "all" : "installed")}>
              <span>{t("library.installed")}</span><small>{classified.filter((release) => release.installation).length}</small>
            </button>
            <button type="button" className={stateFilter === "updates" ? "active" : ""} aria-pressed={stateFilter === "updates"} onClick={() => setStateFilter(stateFilter === "updates" ? "all" : "updates")}>
              <span>{t("actions.reviewUpdate")}</span><small>{classified.filter((release) => release.canAdopt).length}</small>
            </button>
          </section>

        </aside>

        <main className="m5LibraryMain">
          <div className="m5LibraryTypeTabs" role="tablist" aria-label={t("library.filterLabel")} data-testid="loopops.library.type-tabs">
            {TYPES.filter((value) => value === "all" || typeCounts[value] > 0 || type === value).map((value) => (
              <button
                type="button"
                role="tab"
                key={value}
                className={type === value ? "active" : ""}
                aria-selected={type === value}
                onClick={() => setType(value)}
              >
                {typeLabel(value, workspace.locale)} <small>{typeCounts[value]}</small>
              </button>
            ))}
          </div>

          {visibleReleases.length ? (
            <section className="m5LibraryAssetList" role="list" aria-label={t("library.heading")} data-testid="loopops.library.asset-list">
              {visibleReleases.map((release) => {
                const status = releaseStatus(release, t);
                const selected = Boolean(reviewReleaseId && selectedRelease?.releaseId === release.releaseId);
                const busy = connectionActions.busyAction.endsWith(`:${release.releaseId}`);
                const usage = release.assetKind === "skill" ? release.skillDetails?.usageCount : null;
                return (
                  <article
                    className={`m5LibraryAssetRow ${selected ? "selected" : ""}`}
                    key={release.releaseId}
                    role="listitem"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => openRelease(release)}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        openRelease(release);
                      }
                    }}
                    tabIndex={0}
                  >
                    <span className={`m5LibraryAssetIcon ${release.assetKind}`} aria-hidden="true">
                      {release.assetKind === "loop" ? <GitBranch size={16} /> : <Boxes size={16} />}
                    </span>
                    <div className="m5LibraryAssetBody">
                      <div className="m5LibraryAssetTitle">
                        <strong>{productTitle(release, workspace.locale)}</strong>
                        {release.installed || release.canAdopt ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
                      </div>
                      <p>{productDescription(release, workspace.locale) || release.releaseNotes || t("library.noReleaseNotes")}</p>
                      <div className="m5LibraryAssetMeta">
                        <span>{displayKind(release, workspace)}</span>


                        {Number.isFinite(usage) && usage > 0 ? <span>{t("library.usageCount", { count: usage })}</span> : null}
                      </div>
                    </div>
                    <div className="m5LibraryRowAction">
                      <span>{release.versionLabel}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={(workspace.readOnlyWorkspace && release.canAdopt) || busy}
                        title={workspace.readOnlyWorkspace && release.canAdopt ? localCopy(workspace.locale, "只读工作区不能更改资产状态", "This read-only workspace cannot change asset state") : undefined}
                        onClick={(event) => rowAction(release, event)}
                      >
                        {release.canAdopt ? t("actions.reviewUpdate") : localCopy(workspace.locale, "查看用法", "How to use")}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </section>
          ) : (
            <EmptyState
              title={query ? t("library.noMatchesTitle") : t("library.emptyTitle")}
              body={query ? t("library.noMatchesBody", { query }) : t("library.emptyBody")}
              actionLabel={query ? t("actions.clearSearch") : localCopy(workspace.locale, "清除筛选", "Clear filters")}
              onAction={() => {
                setQuery("");
                setDomain("all");
                setType("all");
                setStateFilter("all");
              }}
            />
          )}
        </main>

        {reviewReleaseId || updateDraftId ? <aside className="m5LibraryPreview" data-testid="loopops.library.preview">
          {selectedRelease ? (
            <>
              <header>
                <span className={`m5LibraryAssetIcon large ${selectedRelease.assetKind}`} aria-hidden="true">
                  {selectedRelease.assetKind === "loop" ? <GitBranch size={19} /> : <Boxes size={19} />}
                </span>
                <div><p>{displayKind(selectedRelease, workspace)}</p><h2>{productTitle(selectedRelease, workspace.locale)}</h2></div>
              </header>
              <p className="m5LibraryPreviewPurpose">{productDescription(selectedRelease, workspace.locale) || selectedRelease.releaseNotes || t("library.noReleaseNotes")}</p>

              <section>
                <h3>{localCopy(workspace.locale, "包含内容", "Includes")}</h3>
                <p>{includedSummary(selectedRelease, workspace.locale)}</p>
                {selectedRelease.assetKind === "skill" && selectedRelease.skillDetails?.inputs?.length ? (
                  <div className="m5LibraryChips">{selectedRelease.skillDetails.inputs.slice(0, 4).map((value) => <span key={value}>{value}</span>)}</div>
                ) : null}
              </section>

              {selectedRelease.assetKind === "skill" && Number.isFinite(selectedRelease.skillDetails?.usageCount) ? (
                <section>
                  <h3>{t("library.usedBy")}</h3>
                  <p className="m5LibraryIconFact"><Users size={14} /> {t("library.usageCount", { count: selectedRelease.skillDetails.usageCount })}</p>
                </section>
              ) : null}

              <section>
                <h3>{localCopy(workspace.locale, "版本与治理", "Version and governance")}</h3>
                <dl>
                  <div><dt>{t("library.columns.version")}</dt><dd>{selectedRelease.versionLabel}</dd></div>
                  {selectedRelease.canAdopt ? <div><dt>{localCopy(workspace.locale, "当前安装", "Installed")}</dt><dd>{installedVersionLabel}</dd></div> : null}
                  <div><dt>{localCopy(workspace.locale, "可见性", "Visibility")}</dt><dd>{visibilityLabel(selectedRelease, workspace.locale)}</dd></div>
                  <div><dt>{t("library.columns.maintainer")}</dt><dd>{workspace.participantDirectory?.find((member) => member.userId === selectedRelease.publishedBy)?.displayName || localCopy(workspace.locale, "团队成员", "Team member")}</dd></div>
                </dl>
                <p className="m5LibraryIconFact"><ShieldCheck size={14} /> {t("library.validated")}</p>
              </section>

              {reviewReleaseId === selectedRelease.releaseId ? (
                <section className="m5LibraryUpdateReview" data-testid={`loopops.library.update-review.${selectedRelease.releaseId}`}>
                  <h3>{t("actions.reviewUpdate")}</h3>
                  <p>{selectedRelease.releaseNotes || t("library.noReleaseNotes")}</p>
                  {updateImpact.isLoading ? (
                    <p role="status">{localCopy(workspace.locale, "正在计算影响…", "Calculating impact…")}</p>
                  ) : updateImpact.error ? (
                    <div className="m5LibraryUpdateNote" role="alert">
                      <Info size={15} />
                      <span>{updateImpact.error.message}</span>
                    </div>
                  ) : displayedUpdateImpact ? (
                    <div className="m5LibraryUpdateImpact">
                      <div className="m5LibraryUpdateNote">
                        <Info size={15} />
                        <span>{t("library.updateImpact")}</span>
                      </div>
                      <dl>
                        <div>
                          <dt>{localCopy(workspace.locale, "依赖变化", "Dependency changes")}</dt>
                          <dd>{displayedUpdateImpact.dependencyChanges.length}</dd>
                        </div>
                        <div>
                          <dt>{localCopy(workspace.locale, "连接变化", "Connection changes")}</dt>
                          <dd>{displayedUpdateImpact.connectionChanges.length}</dd>
                        </div>
                        <div>
                          <dt>{localCopy(workspace.locale, "受影响对象", "Affected objects")}</dt>
                          <dd>{displayedUpdateImpact.affectedObjects.length}</dd>
                        </div>
                      </dl>
                      {displayedUpdateImpact.breakingFields.length ? (
                        <p>{localCopy(workspace.locale, "需要重点检查：", "Review carefully: ")}{displayedUpdateImpact.breakingFields.join(", ")}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {updateDraft.data?.data?.status === "conflicted" ? (
                    <div className="m5LibraryUpdateNote" role="alert">
                      <Info size={15} />
                      <span>{updateDraft.data.data.conflictReason}</span>
                    </div>
                  ) : null}
                  <div className="m5LibraryUpdateActions">
                    {updateDraftId && ["pending_review", "ready", "conflicted"].includes(updateDraft.data?.data?.status) ? (
                      <>
                        <Button
                          variant="plain"
                          disabled={workspace.readOnlyWorkspace || connectionActions.updateDecisionPending}
                          onClick={() => connectionActions.keepCurrent(updateDraftId, closeUpdateDraftReview)}
                        >
                          {t("actions.keepCurrentVersion")}
                        </Button>
                        {updateDraft.data?.data?.status === "conflicted" ? (
                          <Button
                            variant="secondary"
                            icon={<RefreshCw size={15} />}
                            disabled={workspace.readOnlyWorkspace || connectionActions.updateDecisionPending}
                            onClick={() => connectionActions.refreshUpdate(updateDraftId)}
                          >
                            {localCopy(workspace.locale, "刷新并重新比较", "Refresh and rebase")}
                          </Button>
                        ) : null}
                        <Button
                          variant="primary"
                          icon={<RefreshCw size={15} />}
                          disabled={workspace.readOnlyWorkspace
                            || connectionActions.updateDecisionPending
                            || updateDraft.data?.data?.status === "conflicted"}
                          onClick={() => connectionActions.applyUpdate(updateDraftId, closeUpdateDraftReview)}
                          data-testid={`loopops.library.apply-update.${selectedRelease.releaseId}`}
                        >
                          {localCopy(workspace.locale, "确认并应用", "Confirm and apply")}
                        </Button>
                      </>
                    ) : !updateDraftId ? (
                      <>
                        <Button variant="plain" onClick={() => setReviewReleaseId("")}>{t("actions.keepCurrentVersion")}</Button>
                        <Button
                          variant="primary"
                          icon={<ArrowRight size={15} />}
                          disabled={workspace.readOnlyWorkspace || updateImpact.isLoading || !displayedUpdateImpact}
                          onClick={() => connectionActions.update(selectedRelease, (result) => {
                            openUpdateDraftReview(result.data.updateDraftId);
                          })}
                        >
                          {localCopy(workspace.locale, "创建更新草稿", "Create update draft")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <footer>
                <Button
                  variant="primary"
                  icon={selectedRelease.canAdopt ? <ArrowRight size={15} /> : selectedRelease.installed ? <ArrowRight size={15} /> : <Download size={15} />}
                  disabled={workspace.readOnlyWorkspace && actionMutates(selectedRelease)}
                  title={workspace.readOnlyWorkspace && actionMutates(selectedRelease) ? localCopy(workspace.locale, "只读工作区不能安装或复制资产", "This read-only workspace cannot install or copy assets") : undefined}
                  onClick={() => runPrimaryAction(selectedRelease)}
                  data-testid={`loopops.library.primary.${selectedRelease.releaseId}`}
                >
                  {primaryLabel(selectedRelease)}
                </Button>
              </footer>
            </>
          ) : (
            <div className="m5LibraryPreviewEmpty">
              <Boxes size={22} aria-hidden="true" />
              <p>{localCopy(workspace.locale, "选择一个资产查看详情。", "Select an asset to preview it.")}</p>
            </div>
          )}
        </aside> : null}
      </div>

      <ConnectionRebindingSheet
        {...connectionActions.sheetProps}
        readOnly={workspace.readOnlyWorkspace}
        onRequestAccess={workspace.requestWorkspaceAccess}
        t={t}
      />
      <ConnectionRebindingSheet
        open={Boolean(connectionTarget.connectionId && connectionTarget.requirementId)}
        actionLabel={t("connections.finishSetup")}
        requirements={connectionTarget.requirementId
          ? [{ requirementId: connectionTarget.requirementId }]
          : []}
        preferredConnectionId={connectionTarget.connectionId}
        submitting={false}
        errorCode=""
        readOnly={workspace.readOnlyWorkspace}
        onClose={closeConnectionTarget}
        onSubmit={closeConnectionTarget}
        onRequestAccess={workspace.requestWorkspaceAccess}
        t={t}
      />
    </div>
  );
}
