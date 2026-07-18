import { useEffect } from "react";
import { ArrowLeft, CheckCircle2, Database, GitBranch, Play, ShieldCheck } from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { productFieldLabel, productNodeTitle, productTitle } from "../../utils/productCopy.js";

function skillVersions(nodes = []) {
  return nodes
    .filter((node) => node.type === "Skill")
    .map((node) => ({ id: node.id, title: node.title, version: node.skillVersion || node.canonical?.skillRef?.version || "-" }));
}

function resolvedModels(editorState, revision, nodes) {
  const plan = editorState?.compile?.result?.executionPlan
    || revision?.compile?.executionPlan
    || revision?.executionPlan;
  return (plan?.steps || []).flatMap((step) => {
    const revisionId = step.modelProfileRevisionId
      || step.requestedModelRevisionId
      || step.modelRoute?.requestedModelRevisionId;
    if (!revisionId) return [];
    const node = nodes.find((candidate) => (candidate.id || candidate.nodeId) === step.nodeId);
    const capability = step.modelCapability || step.capability || step.modelRoute?.capability || "chat";
    const runSettingKey = capability === "image_generation"
      ? "imageGenerationModelProfileId"
      : "agentControllerModelProfileId";
    const source = node?.canonical?.configuration?.modelProfileId
      ? "node"
      : revision?.runSettings?.[runSettingKey] ? "run" : "workspace";
    return [{
      nodeId: step.nodeId,
      capability,
      revisionId,
      source,
    }];
  });
}

export function RunPreflightView({ workspace }) {
  const t = workspace.t;
  const loop = workspace.selectedWorkflow;
  const revision = workspace.editorState?.draft || loop?.canonicalRevision;
  const nodes = loop?.workflow?.nodes || [];
  const skills = skillVersions(nodes);
  const fields = revision?.inputForm?.fields || [];
  const materials = workspace.resources.filter((resource) => (revision?.resourceRefs || []).some((ref) => ref.resourceId === resource.resourceId));
  const reviewSteps = nodes.filter((node) => node.type === "Review Gate");
  const externalActions = nodes.filter((node) => {
    if (node.type !== "Skill") return false;
    return workspace.skills.find((skill) => skill.id === node.skillId)?.canonical?.risk?.externalAction;
  });
  const missing = fields.filter((field) => field.required && !String(workspace.runInputs[field.fieldId] || "").trim());
  const dirty = Boolean(workspace.editorState?.dirty);
  const ready = loop?.readiness === "Ready";
  const planReady = workspace.editorState?.compile?.status === "ready"
    && Boolean(workspace.editorState?.compile?.result?.executionPlan);
  const canStart = Boolean(loop && ready && planReady && !dirty && !missing.length && workspace.canRunWorkflow);
  const savedVersion = loop?.canonicalRevision?.revisionNumber || loop?.canonicalRevision?.revision || 1;
  const modelRoutes = resolvedModels(workspace.editorState, revision, nodes);

  useEffect(() => {
    if (!loop || dirty || !workspace.canRunWorkflow || workspace.editorState?.compile?.status === "compiling") return;
    const hasResolvedPlan = Boolean(workspace.editorState?.compile?.result?.executionPlan);
    if (!hasResolvedPlan) workspace.compileSelectedWorkflow();
  }, [loop?.id, workspace.editorState?.baseRevision?.revisionId, workspace.canRunWorkflow]);

  if (workspace.surfaceState?.workflow?.loading || workspace.surfaceState?.workflow?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={workspace.surfaceState.workflow}
        objectLabel={t("object.loopWorkflow")}
        onRetry={() => workspace.retrySurface("workflow")}
        onBack={() => workspace.setActivePage("loops")}
        backLabel={t("actions.openLoops")}
        testId="loopops.preflight.query-state"
      />
    );
  }

  if (!loop) {
    return (
      <div className="surface objectPageEmpty" data-testid="loopops.runs.preflight">
        <h2>{t("runPreflight.noLoop")}</h2>
        <Button variant="secondary" onClick={() => workspace.setActivePage("loops")}>{t("actions.openLoops")}</Button>
      </div>
    );
  }

  function recover() {
    if (dirty) workspace.editLoop(loop.id, "definition");
    else document.querySelector("[data-testid='loopops.preflight.inputs'] input")?.focus();
  }

  return (
    <div className="surface runPreflightPage" data-testid="loopops.runs.preflight">
      <header className="preflightHeader">
        <div>
          <button type="button" className="backLink" onClick={() => workspace.openLoop(loop.id)}>
            <ArrowLeft size={15} /> {t("runPreflight.backToLoop")}
          </button>
          <p className="objectKicker">{productTitle(loop, workspace.locale)}</p>
          <h2>{t("runPreflight.title")}</h2>
          <p>{t("runPreflight.caption")}</p>
        </div>
        <StatusPill tone={canStart ? "success" : "warning"}>{canStart ? t("runPreflight.ready") : t("runPreflight.needsAttention")}</StatusPill>
      </header>

      <div className="preflightLayout">
        <main className="preflightMain">
          <section className="preflightSection" data-testid="loopops.preflight.inputs">
            <div className="preflightSectionTitle"><Database size={16} /><div><h3>{t("runPreflight.requiredInfo")}</h3><p>{t("runPreflight.requiredInfoCaption")}</p></div></div>
            <div className="preflightInputs">
              {fields.map((field) => (
                <label key={field.fieldId}>
                  <span>{productFieldLabel(field.label, workspace.locale)}{field.required ? " *" : ""}</span>
                  <input
                    value={workspace.runInputs[field.fieldId] || ""}
                    onChange={(event) => workspace.setRunInput(field.fieldId, event.target.value)}
                    placeholder={workspace.locale === "zh" ? productFieldLabel(field.label, workspace.locale) : field.description || field.label}
                  />
                </label>
              ))}
              {!fields.length ? <p className="muted">{t("runPreflight.noInputs")}</p> : null}
            </div>
          </section>

          <section className="preflightSection">
            <div className="preflightSectionTitle"><GitBranch size={16} /><div><h3>{t("runPreflight.fixedVersions")}</h3><p>{t("runPreflight.fixedVersionsCaption")}</p></div></div>
            <div className="preflightRows">
              <div><span>{t("runPreflight.loopRevision")}</span><strong>{t("runPreflight.savedVersion", { version: savedVersion })}</strong></div>
              {skills.map((skill) => <div key={skill.id}><span>{productNodeTitle(skill, workspace.locale)}</span><strong>v{skill.version}</strong></div>)}
            </div>
          </section>

          {modelRoutes.length ? (
            <section className="preflightSection" data-testid="loopops.preflight.models">
              <div className="preflightSectionTitle"><ShieldCheck size={16} /><div><h3>{t("model.resolvedRoutes")}</h3><p>{t("model.resolvedRoutesHint")}</p></div></div>
              <div className="resolvedModelRows">
                {modelRoutes.map((route) => (
                  <div key={`${route.nodeId}:${route.capability}`}>
                    <span>{productNodeTitle(nodes.find((node) => node.id === route.nodeId) || { title: route.nodeId }, workspace.locale)}<small>{route.capability} · {t("model.inheritedFrom", { source: t(`model.source.${route.source}`) })}</small></span>
                    <strong>{route.revisionId}</strong>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="preflightSection">
            <div className="preflightSectionTitle"><ShieldCheck size={16} /><div><h3>{t("runPreflight.reviewAndActions")}</h3><p>{t("runPreflight.reviewAndActionsCaption")}</p></div></div>
            <dl className="preflightFacts">
              <dt>{t("runPreflight.materials")}</dt><dd>{materials.length ? materials.map((item) => item.label).join(", ") : t("runPreflight.none")}</dd>
              <dt>{t("runPreflight.reviewPoints")}</dt><dd>{reviewSteps.length ? reviewSteps.map((item) => productNodeTitle(item, workspace.locale)).join(", ") : t("runPreflight.none")}</dd>
              <dt>{t("runPreflight.externalActions")}</dt><dd>{externalActions.length ? externalActions.map((item) => productNodeTitle(item, workspace.locale)).join(", ") : t("runPreflight.noExternalActions")}</dd>
            </dl>
          </section>
        </main>

        <aside className="preflightRail">
          <h3>{t("runPreflight.checklist")}</h3>
          <ul className="preflightChecklist">
            <li className={dirty ? "blocked" : "ready"}><CheckCircle2 size={15} /><span>{dirty ? t("runPreflight.saveNeeded") : t("runPreflight.saved")}</span></li>
            <li className={missing.length ? "blocked" : "ready"}><CheckCircle2 size={15} /><span>{missing.length ? t("runPreflight.missingInputs", { count: missing.length }) : t("runPreflight.inputsReady")}</span></li>
            <li className={ready && planReady ? "ready" : "blocked"}><CheckCircle2 size={15} /><span>{ready && planReady ? t("runPreflight.versionPinned") : t("runPreflight.setupNeeded")}</span></li>
            <li className="ready"><CheckCircle2 size={15} /><span>{t("runPreflight.reviewVisible", { count: reviewSteps.length })}</span></li>
          </ul>
          {!canStart ? <div className="preflightBlocked" role="status" data-testid="loopops.preflight.blocked"><p>{dirty ? t("runPreflight.saveBeforeRun") : missing.length ? t("runPreflight.fillRequired") : t("runPreflight.finishSetup")}</p><Button variant="secondary" onClick={ready && !dirty ? recover : () => workspace.editLoop(loop.id, "definition")}>{dirty || !ready ? t("actions.openBuilder") : t("runPreflight.fillInputs")}</Button></div> : null}
          <Button
            variant="primary"
            icon={<Play size={15} />}
            disabled={!canStart}
            onClick={() => workspace.runLoop(loop.id)}
            data-testid="loopops.preflight.start"
          >
            {t("actions.startTestRun")}
          </Button>
          <Button variant="plain" onClick={() => workspace.editLoop(loop.id, "outline")} data-testid="loopops.preflight.review-steps">{t("runPreflight.reviewSteps")}</Button>
        </aside>
      </div>
    </div>
  );
}
