import { useState } from "react";
import {
  ArrowUpRight,
  CircleDashed,
  Columns3,
  GripVertical,
  Library,
  List,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { productActorName, productDescription, productTitle } from "../../utils/productCopy.js";

function countSteps(loop) {
  return loop.workflow?.nodes?.length || 0;
}

function isProductLoop(loop) {
  const text = `${loop?.title || ""} ${loop?.description || ""}`.toLowerCase();
  return !/(imported focus loop|browser lifecycle verification|conformance|fixture)/.test(text);
}

function uniqueLoops(items) {
  const seen = new Set();
  return items.filter((loop) => {
    const key = String(loop.title || loop.id).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function versionLabel(loop, t) {
  const revision = loop.canonicalRevision?.revision
    || loop.canonicalRevision?.revisionNumber
    || loop.templateVersion
    || loop.version;
  if (revision) {
    const value = String(revision);
    if (value.startsWith("v") || value.includes(".")) return value.startsWith("v") ? value : `v${value}`;
    if (/^\d+$/.test(value) && Number(value) > 99) return t("loopsBoard.draft");
    return t("loopsBoard.draftRevision", { revision: value });
  }
  const raw = String(loop.currentRevisionId || "");
  const semantic = raw.match(/(?:^|[^\d])(\d+\.\d+(?:\.\d+)?)(?:$|[^\d])/i)?.[1];
  return semantic ? `v${semantic}` : t("loopsBoard.draft");
}

function ownerLabel(item, locale, t) {
  return item.owner && item.owner !== "You"
    ? productActorName(item.owner, locale)
    : t("loopsBoard.you");
}

function ownerInitial(item, locale, t) {
  return ownerLabel(item, locale, t).trim().slice(0, 1).toUpperCase() || "Y";
}

function setDragPayload(event, payload) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-loop-lifecycle", JSON.stringify(payload));
}

function LoopCard({ loop, stage, featured = false, locale, onOpen, onMore, onPrimary, primaryLabel, primaryIcon, t }) {
  const steps = countSteps(loop);
  const readySteps = loop.readiness === "Ready" ? steps : Math.max(0, steps - 1);
  return (
    <article
      className={`lifecycleCard ${featured ? "featured" : ""}`}
      draggable
      onDragStart={(event) => setDragPayload(event, { kind: "workflow", id: loop.id, stage })}
      data-loop-stage={stage}
      data-workflow-id={loop.id}
    >
      <div className="lifecycleCardTopline">
        <GripVertical size={16} className="lifecycleGrip" aria-hidden="true" />
        <button type="button" className="lifecycleCardTitle" onClick={() => onOpen(loop.id)} title={productTitle(loop, locale)}>
          {productTitle(loop, locale)}
        </button>
        <span className="lifecycleVersion">{versionLabel(loop, t)}</span>
      </div>
      <p className="lifecycleGoal">{productDescription(loop, locale) || t("loopsBoard.noGoal")}</p>
      <div className="lifecycleOwnerRow">
        <span className="lifecycleAvatar" aria-hidden="true">{ownerInitial(loop, locale, t)}</span>
        <span>{ownerLabel(loop, locale, t)}</span>
        <span className={`lifecycleStateDot ${stage}`} aria-hidden="true" />
        <span>{stage === "ready" ? t("loopsBoard.ready") : t("loopsBoard.inProgress")}</span>
      </div>
      {featured && stage === "draft" ? (
        <div className="lifecycleProgress" aria-label={t("loopsBoard.stepProgress", { ready: readySteps, count: steps })}>
          <span><i style={{ width: `${steps ? (readySteps / steps) * 100 : 0}%` }} /></span>
          <small>{t("loopsBoard.stepProgress", { ready: readySteps, count: steps })}</small>
        </div>
      ) : null}
      <div className="lifecycleCardActions">
        {featured && stage === "draft" ? (
          <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => onOpen(loop.id)}>{t("actions.editLoop")}</Button>
        ) : null}
        <Button
          variant={featured && stage === "draft" ? "secondary" : "ghost"}
          size="sm"
          icon={primaryIcon}
          onClick={() => onPrimary(loop.id)}
          data-testid={`loopops.loops.action.${loop.id}`}
        >
          {primaryLabel}
        </Button>
        {featured ? <button type="button" className="lifecycleMore" aria-label={t("actions.more")} onClick={() => onMore(loop.id)}><MoreHorizontal size={16} /></button> : null}
      </div>
    </article>
  );
}

function SharedCard({ release, workspace }) {
  const t = workspace.t;
  const hasUpdate = Boolean(release.canAdopt);
  return (
    <article
      className="lifecycleCard sharedCard"
      draggable
      onDragStart={(event) => setDragPayload(event, { kind: "release", id: release.releaseId, assetId: release.assetId, stage: "shared" })}
      data-loop-stage="shared"
    >
      <div className="lifecycleCardTopline">
        <button type="button" className="lifecycleCardTitle" onClick={() => workspace.openLibraryLoop(release.assetId)}>{release.title}</button>
        <span className="lifecycleVersion">{release.version ? `v${release.version}` : "v1.0.0"}</span>
      </div>
      <p className="lifecycleGoal">{release.description || release.releaseNotes || t("library.noReleaseNotes")}</p>
      <div className="lifecycleOwnerRow">
        <span className="lifecycleAvatar violet" aria-hidden="true">{String(release.ownerName || t("loopsBoard.team")).slice(0, 1).toUpperCase()}</span>
        <span>{release.ownerName || t("loopsBoard.team")}</span>
        <span className="lifecycleStateDot shared" aria-hidden="true" />
        <span>{hasUpdate ? t("loopsBoard.updateAvailable") : t("loopsBoard.published")}</span>
      </div>
      <div className="lifecycleCardActions">
        <Button variant="ghost" size="sm" icon={<ArrowUpRight size={14} />} onClick={() => workspace.openLibraryLoop(release.assetId)}>
          {hasUpdate ? t("loopsBoard.reviewUpdate") : t("loopsBoard.openRelease")}
        </Button>
      </div>
    </article>
  );
}

function Lane({ stage, title, count, children, dropLabel, onDropStage }) {
  return (
    <section
      className="lifecycleLaneV2"
      data-stage={stage}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-loop-lifecycle")) event.preventDefault();
      }}
      onDrop={(event) => {
        const value = event.dataTransfer.getData("application/x-loop-lifecycle");
        if (!value) return;
        event.preventDefault();
        try { onDropStage(JSON.parse(value), stage); } catch { onDropStage(null, stage); }
      }}
    >
      <header className="lifecycleLaneV2Header">
        <span className={`lifecycleLaneDot ${stage}`} aria-hidden="true" />
        <h2>{title}</h2>
        <span className="lifecycleLaneCount">{count}</span>
      </header>
      <div className="lifecycleLaneV2List">{children}</div>
      {dropLabel ? <div className="lifecycleDropTarget">{dropLabel}</div> : null}
    </section>
  );
}

export function LoopsBoardView({ workspace }) {
  const t = workspace.t;
  const [view, setView] = useState("board");
  const [command, setCommand] = useState("");
  const [transitionMessage, setTransitionMessage] = useState("");
  const loops = uniqueLoops(workspace.loops.filter((loop) => loop.type === "LoopWorkflow" && isProductLoop(loop)));
  const sampleOrder = new Map([
    ["Weekly Product Review", 0],
    ["Meeting Follow-up", 1],
    ["Pre-market Research", 2],
  ]);
  const drafts = loops
    .filter((loop) => loop.readiness !== "Ready")
    .map((loop, index) => ({ loop, index }))
    .sort((a, b) => (sampleOrder.get(a.loop.title) ?? 100 + a.index) - (sampleOrder.get(b.loop.title) ?? 100 + b.index))
    .map(({ loop }) => loop);
  const ready = loops.filter((loop) => loop.readiness === "Ready");
  const shared = workspace.teamLibrary.filter((release) => release.assetKind === "loop");

  function requestTransition(payload, target) {
    if (!payload || payload.stage === target) return setTransitionMessage(t("loopsBoard.transitionNoChange"));
    if (payload.kind === "workflow" && payload.stage === "draft" && target === "ready") return workspace.editLoop(payload.id, "outline");
    if (payload.kind === "workflow" && payload.stage === "ready" && target === "shared") return workspace.openPublishReview(payload.id);
    if (payload.kind === "release" && payload.stage === "shared" && target === "draft") {
      return workspace.useTeamReleaseAsStartingPoint(payload.id, t("library.startingPointName", { title: shared.find((item) => item.releaseId === payload.id)?.title || t("library.loop") }));
    }
    setTransitionMessage(t("loopsBoard.transitionBlocked"));
  }

  function submitCommand(event) {
    event.preventDefault();
    if (command.trim()) workspace.openCreateLoop("goal", { goal: command.trim() });
  }

  return (
    <div className="surface lifecycleBoard lifecycleBoardV2" data-testid="loopops.loops.board">
      <header className="baselinePageHeading">
        <h1>{t("loopsBoard.lifecycleTitle")}</h1>
        <div className="lifecycleViewToggle" role="group" aria-label={t("loopsBoard.viewLabel")}>
          <button type="button" className={view === "list" ? "active" : ""} aria-pressed={view === "list"} onClick={() => setView("list")} data-testid="loopops.loops.view.list"><List size={15} />{t("loopsBoard.listView")}</button>
          <button type="button" className={view === "board" ? "active" : ""} aria-pressed={view === "board"} onClick={() => setView("board")} data-testid="loopops.loops.view.board"><Columns3 size={15} />{t("loopsBoard.boardView")}</button>
        </div>
      </header>

      <div className="lifecycleCommandRow">
        <div>
          <form className="loopCommand loopCommandV2" aria-label={t("loopsBoard.commandLabel")} onSubmit={submitCommand}>
            <Sparkles size={19} aria-hidden="true" />
            <label><span className="srOnly">{t("loopsBoard.commandTitle")}</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("loopsBoard.commandPlaceholder")} data-testid="loopops.loops.ai-command" /></label>
            <kbd>⌘ K</kbd>
            <Button type="submit" variant="primary" disabled={workspace.readOnlyWorkspace || !command.trim()}>{t("loopsBoard.draftProposal")}</Button>
          </form>
          <p className="loopCommandSafety">{t("loopsBoard.commandSafety")}</p>
        </div>
        <div className="lifecycleQuickActions">
          <Button variant="secondary" icon={<Plus size={15} />} disabled={workspace.readOnlyWorkspace} onClick={() => workspace.openCreateLoop("goal")} data-testid="loopops.topbar.primary.create-loop">{t("actions.createLoop")}</Button>
          <Button variant="secondary" icon={<Upload size={15} />} disabled={workspace.readOnlyWorkspace} onClick={workspace.openLoopImportDialog} data-testid="loopops.loops.upload">{t("loopTransfer.uploadLoop")}</Button>
          <Button variant="secondary" icon={<Plus size={15} />} disabled={workspace.readOnlyWorkspace} onClick={() => workspace.openCreateSkillDialog("create")}>{t("actions.createSkill")}</Button>
          <Button variant="secondary" icon={<Upload size={15} />} disabled={workspace.readOnlyWorkspace} onClick={() => workspace.openCreateSkillDialog("files")}>{t("globalCreate.uploadSkill")}</Button>
        </div>
      </div>

      {transitionMessage ? <div className="lifecycleTransitionMessage" role="status"><span>{transitionMessage}</span><Button variant="plain" size="sm" onClick={() => setTransitionMessage("")}>{t("actions.dismiss")}</Button></div> : null}

      <div className={`lifecycleBoardLanesV2 ${view === "list" ? "listView" : ""}`}>
        <Lane stage="draft" title={t("loopsBoard.drafts")} count={drafts.length} onDropStage={requestTransition} dropLabel={t("loopsBoard.dropReady")}>
          {drafts.map((loop, index) => <LoopCard key={loop.id} loop={loop} stage="draft" featured={index === 0} locale={workspace.locale} onOpen={(id) => workspace.editLoop(id, "canvas")} onMore={workspace.openLoop} onPrimary={(id) => index === 0 ? workspace.prepareRun(id) : workspace.editLoop(id, "canvas")} primaryLabel={index === 0 ? t("actions.testLoop") : t("actions.continueBuilding")} primaryIcon={<Play size={14} />} t={t} />)}
        </Lane>
        <Lane stage="ready" title={t("loopsBoard.ready")} count={ready.length} onDropStage={requestTransition} dropLabel={t("loopsBoard.dropShared")}>
          {ready.map((loop) => <LoopCard key={loop.id} loop={loop} stage="ready" locale={workspace.locale} onOpen={workspace.openLoop} onMore={workspace.openLoop} onPrimary={workspace.prepareRun} primaryLabel={t("actions.testLoop")} primaryIcon={<Play size={14} />} t={t} />)}
          {!ready.length ? (
            <div className="lifecycleEmptyState">
              <CircleDashed size={22} aria-hidden="true" />
              <strong>{t("loopsBoard.emptyReady")}</strong>
              {drafts[0] ? <Button variant="secondary" size="sm" onClick={() => workspace.editLoop(drafts[0].id, "definition")}>{t("actions.continueBuilding")}</Button> : null}
            </div>
          ) : null}
        </Lane>
        <Lane stage="shared" title={t("loopsBoard.shared")} count={shared.length} onDropStage={requestTransition}>
          {shared.map((release) => <SharedCard key={release.releaseId} release={release} workspace={workspace} />)}
          {!shared.length ? (
            <div className="lifecycleEmptyState">
              <Library size={22} aria-hidden="true" />
              <strong>{t("loopsBoard.emptyShared")}</strong>
              <Button variant="secondary" size="sm" onClick={() => workspace.setActivePage("library")}>{t("nav.library")}</Button>
            </div>
          ) : null}
        </Lane>
      </div>
      <footer className="lifecycleBoardFooter"><span>{t("loopsBoard.localTime")}</span><span>{new Intl.DateTimeFormat(workspace.locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date())}</span></footer>
    </div>
  );
}
