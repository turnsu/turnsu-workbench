import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  CircleDashed,
  GripVertical,
  Library,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { productActorName, productDescription, productTitle } from "../../utils/productCopy.js";
import "../../styles/loops.css";

function localCopy(locale, zh, en) {
  return locale === "zh" ? zh : en;
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

function EmptyLane({ icon: Icon, title, body }) {
  return (
    <div className="m5LoopEmpty">
      <Icon size={20} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function RunInAgentButton({ loopId, locale, onRun, stableTestId }) {
  const content = localCopy(locale, "前往 Agent 运行", "Run in Agent");
  if (stableTestId) {
    return (
      <Button
        variant="plain"
        size="sm"
        icon={<Bot size={14} />}
        onClick={() => onRun(loopId)}
        data-testid="loopops.loops.run-in-agent"
      >
        {content}
      </Button>
    );
  }
  return (
    <Button
      variant="plain"
      size="sm"
      icon={<Bot size={14} />}
      onClick={() => onRun(loopId)}
      data-testid={`loopops.loops.run-in-agent.${loopId}`}
    >
      {content}
    </Button>
  );
}

function LoopCard({ loop, stage, locale, onOpen, onMore, onRun, stableRunTestId = false, t }) {
  const isReady = stage === "ready";
  return (
    <article
      className="m5LoopCard"
      draggable
      onDragStart={(event) => setDragPayload(event, { kind: "workflow", id: loop.id, stage })}
      data-loop-stage={stage}
      data-workflow-id={loop.id}
    >
      <div className="m5LoopCardTopline">
        <GripVertical size={15} className="m5LoopGrip" aria-hidden="true" />
        <button type="button" className="m5LoopCardTitle" onClick={() => onOpen(loop.id)}>
          {productTitle(loop, locale)}
        </button>
        <span className="m5LoopVersion">{versionLabel(loop, t)}</span>
      </div>
      <p className="m5LoopGoal">{productDescription(loop, locale) || t("loopsBoard.noGoal")}</p>
      <div className="m5LoopMeta">
        <span className="m5LoopAvatar" aria-hidden="true">{ownerInitial(loop, locale, t)}</span>
        <span>{ownerLabel(loop, locale, t)}</span>
        <i className={`m5LoopStateDot ${stage}`} aria-hidden="true" />
        <span>{isReady ? t("loopsBoard.ready") : t("loopsBoard.draft")}</span>
      </div>
      <div className="m5LoopCardActions">
        {isReady ? (
          <RunInAgentButton loopId={loop.id} locale={locale} onRun={onRun} stableTestId={stableRunTestId} />
        ) : null}
        <Button variant="plain" size="sm" icon={<Pencil size={14} />} onClick={() => onOpen(loop.id)}>
          {t("actions.edit")}
        </Button>
        <button type="button" className="m5LoopMore" aria-label={t("actions.more")} onClick={() => onMore(loop.id)}>
          <MoreHorizontal size={16} />
        </button>
      </div>
    </article>
  );
}

function SharedCard({ release, workspace }) {
  const t = workspace.t;
  return (
    <article
      className="m5LoopCard"
      draggable
      onDragStart={(event) => setDragPayload(event, {
        kind: "release",
        id: release.releaseId,
        assetId: release.assetId,
        stage: "shared",
      })}
      data-loop-stage="shared"
    >
      <div className="m5LoopCardTopline">
        <button type="button" className="m5LoopCardTitle" onClick={() => workspace.openLibraryLoop(release.assetId)}>
          {productTitle(release, workspace.locale)}
        </button>
        <span className="m5LoopVersion">{release.versionLabel || (release.version ? `v${release.version}` : "v1.0.0")}</span>
      </div>
      <p className="m5LoopGoal">{productDescription(release, workspace.locale) || release.releaseNotes || t("library.noReleaseNotes")}</p>
      <div className="m5LoopMeta">
        <span className="m5LoopAvatar shared" aria-hidden="true">
          {String(productActorName(release.publishedBy, workspace.locale) || t("loopsBoard.team")).slice(0, 1).toUpperCase()}
        </span>
        <span>{productActorName(release.publishedBy, workspace.locale) || t("loopsBoard.team")}</span>
        <i className="m5LoopStateDot shared" aria-hidden="true" />
        <span>{release.canAdopt ? t("loopsBoard.updateAvailable") : t("loopsBoard.published")}</span>
      </div>
      <div className="m5LoopCardActions">
        <Button variant="plain" size="sm" icon={<ArrowUpRight size={14} />} onClick={() => workspace.openLibraryLoop(release.assetId)}>
          {release.canAdopt ? t("loopsBoard.reviewUpdate") : t("loopsBoard.openRelease")}
        </Button>
      </div>
    </article>
  );
}

function Lane({ stage, title, count, children, active, onDragTarget, onDropStage, locale }) {
  return (
    <section
      className={`m5LoopLane ${active ? "isDropTarget" : ""}`}
      data-stage={stage}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("application/x-loop-lifecycle")) {
          event.preventDefault();
          onDragTarget(stage);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-loop-lifecycle")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onDragTarget("");
      }}
      onDrop={(event) => {
        const value = event.dataTransfer.getData("application/x-loop-lifecycle");
        onDragTarget("");
        if (!value) return;
        event.preventDefault();
        try { onDropStage(JSON.parse(value), stage); } catch { onDropStage(null, stage); }
      }}
    >
      <header className="m5LoopLaneHeader">
        <i className={`m5LoopLaneDot ${stage}`} aria-hidden="true" />
        <h2>{title}</h2>
        <span>{count}</span>
      </header>
      {active ? <div className="m5LoopDropHint">{localCopy(locale, "放到这里", "Drop here")}</div> : null}
      <div className="m5LoopLaneList">{children}</div>
    </section>
  );
}

export function LoopsBoardView({ workspace }) {
  const t = workspace.t;
  const [command, setCommand] = useState("");
  const [transitionMessage, setTransitionMessage] = useState("");
  const [dragTarget, setDragTarget] = useState("");

  const shared = useMemo(() => {
    const newest = new Map();
    workspace.teamLibrary
      .filter((release) => release.assetKind === "loop")
      .forEach((release) => {
        const current = newest.get(release.assetId);
        const newer = String(release.publishedAt || release.version || "").localeCompare(String(current?.publishedAt || current?.version || ""));
        if (!current || newer >= 0) newest.set(release.assetId, release);
      });
    return [...newest.values()];
  }, [workspace.teamLibrary]);

  const sharedAssetIds = useMemo(() => new Set(shared.map((release) => release.assetId)), [shared]);
  const owned = workspace.loops.filter((loop) => loop.type === "LoopWorkflow" && !sharedAssetIds.has(loop.id));
  const drafts = owned
    .filter((loop) => loop.readiness !== "Ready")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  const ready = owned
    .filter((loop) => loop.readiness === "Ready")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));

  function requestTransition(payload, target) {
    if (!payload || payload.stage === target) {
      setTransitionMessage(t("loopsBoard.transitionNoChange"));
      return;
    }
    if (payload.kind === "workflow" && payload.stage === "draft" && target === "ready") {
      workspace.editLoop(payload.id, "outline");
      return;
    }
    if (payload.kind === "workflow" && payload.stage === "ready" && target === "shared") {
      workspace.openPublishReview(payload.id);
      return;
    }
    setTransitionMessage(t("loopsBoard.transitionBlocked"));
  }

  function submitCommand(event) {
    event.preventDefault();
    if (command.trim()) workspace.openCreateLoop("goal", { goal: command.trim() });
  }

  return (
    <div className="surface m5LoopBoard" data-testid="loopops.loops.board" onDragEnd={() => setDragTarget("")}>
      <header className="m5LoopPageHeader">
        <div>
          <p>{localCopy(workspace.locale, "编排与复用", "Orchestrate and reuse")}</p>
          <h1>{t("loopsBoard.lifecycleTitle")}</h1>
        </div>
        <div className="m5LoopHeaderActions">
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabled={workspace.readOnlyWorkspace}
            onClick={() => workspace.openCreateLoop()}
            data-testid="loopops.topbar.primary.create-loop"
          >
            {t("actions.createLoop")}
          </Button>
        </div>
      </header>

      <form className="m5LoopCommand" aria-label={t("loopsBoard.commandLabel")} onSubmit={submitCommand}>
        <Sparkles size={18} aria-hidden="true" />
        <label>
          <span className="srOnly">{t("loopsBoard.commandTitle")}</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={t("loopsBoard.commandPlaceholder")}
            data-testid="loopops.loops.ai-command"
          />
        </label>
        <span>{localCopy(workspace.locale, "按 Enter 生成提案", "Press Enter for a proposal")}</span>
      </form>
      <p className="m5LoopCommandSafety">{t("loopsBoard.commandSafety")}</p>

      {transitionMessage ? (
        <div className="m5LoopNotice" role="status">
          <span>{transitionMessage}</span>
          <Button variant="plain" size="sm" onClick={() => setTransitionMessage("")}>{t("actions.dismiss")}</Button>
        </div>
      ) : null}

      <div className="m5LoopLanes">
        <Lane stage="draft"
          title={t("loopsBoard.drafts")}
          count={drafts.length}
          active={dragTarget === "draft"}
          onDragTarget={setDragTarget}
          onDropStage={requestTransition}
          locale={workspace.locale}
        >
          {drafts.map((loop) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              stage="draft"
              locale={workspace.locale}
              onOpen={(id) => workspace.editLoop(id, "canvas")}
              onMore={workspace.openLoop}
              onRun={workspace.runLoopInAgent}
              t={t}
            />
          ))}
          {!drafts.length ? (
            <EmptyLane
              icon={CircleDashed}
              title={localCopy(workspace.locale, "暂无草稿", "No drafts")}
              body={localCopy(workspace.locale, "新建的 Loop 会先出现在这里。", "New Loops start here.")}
            />
          ) : null}
        </Lane>
        <Lane stage="ready"
          title={t("loopsBoard.ready")}
          count={ready.length}
          active={dragTarget === "ready"}
          onDragTarget={setDragTarget}
          onDropStage={requestTransition}
          locale={workspace.locale}
        >
          {ready.map((loop, index) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              stage="ready"
              locale={workspace.locale}
              onOpen={workspace.openLoop}
              onMore={workspace.openLoop}
              onRun={workspace.runLoopInAgent}
              stableRunTestId={index === 0}
              t={t}
            />
          ))}
          {!ready.length ? (
            <EmptyLane
              icon={CircleDashed}
              title={t("loopsBoard.emptyReady")}
              body={localCopy(workspace.locale, "完成定义与验证后，Loop 会进入 Ready。", "Loops appear here after definition and validation.")}
            />
          ) : null}
        </Lane>
        <Lane stage="shared"
          title={t("loopsBoard.shared")}
          count={shared.length}
          active={dragTarget === "shared"}
          onDragTarget={setDragTarget}
          onDropStage={requestTransition}
          locale={workspace.locale}
        >
          {shared.map((release) => <SharedCard key={release.releaseId} release={release} workspace={workspace} />)}
          {!shared.length ? (
            <EmptyLane
              icon={Library}
              title={t("loopsBoard.emptyShared")}
              body={localCopy(workspace.locale, "发布后的最新版本会在团队中共享。", "The latest published versions are shared with your team.")}
            />
          ) : null}
        </Lane>
      </div>
    </div>
  );
}
