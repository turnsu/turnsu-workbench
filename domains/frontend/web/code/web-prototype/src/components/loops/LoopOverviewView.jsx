import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  GitBranch,
  History,
  Play,
  Share2,
  Users,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { productDescription, productNodePurpose, productNodeTitle, productTitle } from "../../utils/productCopy.js";

function readinessTone(readiness) {
  return readiness === "Ready" ? "success" : "warning";
}

function definitionItems(definition = {}, t, loop, locale) {
  return [
    [t("loopOverview.goal"), productDescription(loop, locale) || definition.goal],
    [t("loopOverview.context"), definition.context],
    [t("loopOverview.doneWhen"), (definition.doneWhen || []).join("; ")],
    [t("loopOverview.verify"), (definition.verify || []).join("; ")],
    [t("loopOverview.expectedResult"), definition.expectedResult],
    [t("loopOverview.stopRules"), (definition.stopRules || []).join("; ")],
  ].filter(([, value]) => String(value || "").trim());
}

export function LoopOverviewView({ workspace }) {
  const t = workspace.t;
  const loop = workspace.selectedWorkflow;
  const revision = loop?.canonicalRevision || workspace.editorState?.baseRevision;
  const definition = revision?.definition || workspace.editorState?.draft?.definition || {};
  const nodes = loop?.workflow?.nodes || [];
  const runs = workspace.runs.filter((run) => run.loopId === loop?.id);
  const latestRun = runs[0] || null;
  const sharedRelease = workspace.teamLibrary.find((release) => release.assetKind === "loop" && release.assetId === loop?.id);

  if (workspace.surfaceState?.workflow?.loading || workspace.surfaceState?.workflow?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={workspace.surfaceState.workflow}
        objectLabel={t("object.loopWorkflow")}
        onRetry={() => workspace.retrySurface("workflow")}
        onBack={() => workspace.setActivePage("loops")}
        backLabel={t("actions.openLoops")}
        testId="loopops.loop-overview.query-state"
      />
    );
  }

  if (!loop) {
    return (
      <div className="surface objectPageEmpty" data-testid="loopops.loops.overview">
        <h2>{t("loopOverview.notFound")}</h2>
        <Button variant="secondary" onClick={() => workspace.setActivePage("loops")}>{t("actions.openLoops")}</Button>
      </div>
    );
  }

  const readiness = loop.readiness === "Ready" ? t("status.ready") : t("loopsBoard.needsWork");
  const nextAction = loop.readiness === "Ready"
    ? () => workspace.prepareRun(loop.id)
    : () => workspace.editLoop(loop.id, "definition");
  const nextActionLabel = loop.readiness === "Ready" ? t("actions.prepareRun") : t("actions.continueBuilding");

  return (
    <div className="surface loopObjectPage" data-testid="loopops.loops.overview">
      <header className="objectPageHeader">
        <div className="objectPageHeading">
          <button type="button" className="backLink" onClick={() => workspace.setActivePage("loops")}>
            <ArrowLeft size={15} /> {t("actions.openLoops")}
          </button>
          <div className="objectPageTitleRow">
            <div>
              <p className="objectKicker">{t("loopOverview.kicker")}</p>
              <h2>{productTitle(loop, workspace.locale)}</h2>
              <p>{productDescription(loop, workspace.locale) || t("loopsBoard.noGoal")}</p>
            </div>
            <StatusPill tone={readinessTone(loop.readiness)}>{readiness}</StatusPill>
          </div>
        </div>
        <div className="objectPageActions">
          <Button
            variant="secondary"
            icon={<Download size={15} />}
            disabled={!loop.currentRevisionId || workspace.serverState.mutations.exportLoop.isPending}
            title={!loop.currentRevisionId ? t("loopTransfer.exportUnavailable") : t("loopTransfer.exportSavedVersion")}
            onClick={workspace.exportSelectedLoop}
            data-testid="loopops.loop-overview.export"
          >
            {workspace.serverState.mutations.exportLoop.isPending ? t("loopTransfer.exporting") : t("loopTransfer.exportLoop")}
          </Button>
          <Button variant="secondary" onClick={() => workspace.editLoop(loop.id, "definition")}>{t("actions.edit")}</Button>
          <Button variant="primary" icon={loop.readiness === "Ready" ? <Play size={15} /> : <GitBranch size={15} />} onClick={nextAction} data-testid="loopops.loop-overview.primary">
            {nextActionLabel}
          </Button>
        </div>
      </header>

      <nav className="objectPageTabs" aria-label={t("loopOverview.sections")}>
        <span className="active" aria-current="page">{t("loopOverview.overview")}</span>
        <button type="button" onClick={() => workspace.editLoop(loop.id, "definition")} data-testid="loopops.loop-overview.definition">{t("loopOverview.definition")}</button>
        <button type="button" onClick={() => workspace.editLoop(loop.id, "outline")} data-testid="loopops.loop-overview.steps">{t("loopOverview.steps")}</button>
        <button type="button" disabled={!latestRun} title={!latestRun ? t("loopOverview.noRuns") : undefined} onClick={() => latestRun && workspace.openRun(latestRun.id)}>{t("loopOverview.runs")}</button>
        <a href="#loop-versions">{t("loopOverview.versions")}</a>
        <a href="#loop-usage">{t("loopOverview.usage")}</a>
      </nav>

      <div className="objectPageLayout">
        <main className="objectPageMain">
          <section className="objectSection">
            <div className="objectSectionHeading">
              <div><FileText size={16} /><h3>{t("loopOverview.purpose")}</h3></div>
              <Button variant="plain" size="sm" onClick={() => workspace.editLoop(loop.id, "definition")}>{t("loopOverview.editDefinition")}</Button>
            </div>
            <dl className="objectDefinitionList">
              {definitionItems(definition, t, loop, workspace.locale).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          </section>

          <section className="objectSection">
            <div className="objectSectionHeading">
              <div><GitBranch size={16} /><h3>{t("loopOverview.orderedSteps")}</h3></div>
              <Button variant="plain" size="sm" onClick={() => workspace.editLoop(loop.id, "outline")}>{t("loopOverview.editSteps")}</Button>
            </div>
            <ol className="objectStepList">
              {nodes.map((node, index) => (
                <li key={node.id}>
                  <span>{index + 1}</span>
                  <div><strong>{productNodeTitle(node, workspace.locale)}</strong><small>{productNodePurpose(node, workspace.locale)}</small></div>
                  <StatusPill>{t(`nodeType.${String(node.type).toLowerCase().replace(/\s+/g, "-")}`)}</StatusPill>
                </li>
              ))}
            </ol>
          </section>

          <section className="objectSection" id="loop-versions">
            <div className="objectSectionHeading"><div><History size={16} /><h3>{t("loopOverview.versions")}</h3></div></div>
            <dl className="objectPropertyGrid">
              <dt>{t("loopOverview.currentRevision")}</dt><dd>{loop.currentRevisionId || t("loopOverview.notSaved")}</dd>
              <dt>{t("loopOverview.origin")}</dt><dd>{loop.sourceTemplate ? t("loopOverview.fromStartingPoint") : t("loopOverview.createdHere")}</dd>
              <dt>{t("loopOverview.savedState")}</dt><dd>{workspace.editorState?.dirty ? t("state.currentWorkflowUnsaved") : t("state.currentWorkflowSaved")}</dd>
              <dt>{t("loopTransfer.downloadIncludes")}</dt><dd>{t("loopTransfer.savedRevisionOnly")}</dd>
            </dl>
          </section>
        </main>

        <aside className="objectPageRail">
          <section>
            <h3>{t("loopOverview.nextAction")}</h3>
            <p>{loop.readiness === "Ready" ? t("loopOverview.readyNext") : t("loopOverview.draftNext")}</p>
            <Button variant="primary" icon={loop.readiness === "Ready" ? <Play size={15} /> : <GitBranch size={15} />} onClick={nextAction}>{nextActionLabel}</Button>
          </section>
          <section>
            <h3>{t("loopOverview.latestRun")}</h3>
            {latestRun ? (
              <button type="button" className="latestRunButton" onClick={() => workspace.openRun(latestRun.id)}>
                <span>{latestRun.startedAt}</span><strong>{latestRun.status}</strong>
              </button>
            ) : <p>{t("loopOverview.noRuns")}</p>}
          </section>
          <section id="loop-usage">
            <h3>{t("loopOverview.teamUse")}</h3>
            <ul className="compactFacts">
              <li><Users size={14} /><span>{sharedRelease ? t("loopOverview.sharedWithTeam") : t("loopOverview.privateDraft")}</span></li>
              <li><CheckCircle2 size={14} /><span>{t("loopOverview.runCount", { count: runs.length })}</span></li>
              <li><Share2 size={14} /><span>{sharedRelease?.version || t("loopOverview.notPublished")}</span></li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
