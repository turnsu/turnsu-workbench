import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  FileText,
  ListOrdered,
  LockKeyhole,
  Paperclip,
  Puzzle,
  Sparkles,
  Target,
  UploadCloud,
  Users,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ModelPicker } from "../models/ModelPicker.jsx";
import { defaultModelSelection, useModelCatalog } from "../../state/models/index.js";

const MODES = [
  { id: "goal", icon: Target },
  { id: "blank", icon: FileText },
  { id: "starting", icon: Users },
  { id: "upload", icon: UploadCloud },
  { id: "duplicate", icon: Copy },
];

const EMPTY_FORM = {
  name: "",
  goal: "",
  expectedResult: "",
  context: "",
  constraints: "",
  doneWhen: "",
  verify: "",
  stopRules: "",
};

function lines(value) {
  return String(value || "").split("\n").map((item) => item.trim()).filter(Boolean);
}

function proposalOperationKey(operation) {
  return `builder.proposalOperation.${operation?.op || "unknown"}`;
}

export function CreateLoopView({ workspace }) {
  const t = workspace.t;
  const [mode, setMode] = useState(workspace.createLoopInitialMode || "goal");
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [builderModelRevisionId, setBuilderModelRevisionId] = useState("");
  const builderModels = useModelCatalog({
    capabilities: ["chat", "tool_calling", "structured_output"],
    context: "builder",
    selectedRevisionId: builderModelRevisionId,
  });
  const ownedLoops = useMemo(() => workspace.loops.filter((loop) => loop.type === "LoopWorkflow"), [workspace.loops]);
  const templates = useMemo(() => workspace.loops.filter((loop) => loop.type === "LoopTemplate"), [workspace.loops]);
  const startingPoints = workspace.teamLibrary.filter((release) => release.assetKind === "loop" && release.startingPoint);
  const generatedName = form.name.trim() || form.goal.trim().split(/[.!?。！？\n]/)[0].slice(0, 72);
  const valid = mode === "blank" ? Boolean(form.name.trim()) : Boolean(form.goal.trim());
  const builderModelReady = builderModels.options.some((option) => option.value === builderModelRevisionId && !option.disabled);

  useEffect(() => {
    const prefill = workspace.createLoopPrefill;
    if (!prefill) return;
    const goal = String(prefill.goal || "").trim();
    setForm((current) => ({ ...current, ...prefill, goal, name: String(prefill.name || goal).trim().slice(0, 72) }));
  }, [workspace.createLoopPrefill]);

  useEffect(() => {
    if (!builderModelRevisionId && builderModels.profiles.length) {
      setBuilderModelRevisionId(defaultModelSelection(builderModels.profiles, "structured_output", "revision"));
    }
  }, [builderModelRevisionId, builderModels.profiles]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function details() {
    return {
      name: generatedName || t("loopCreate.defaultName"),
      goal: mode === "blank" ? t("loopCreate.blankGoal") : form.goal.trim(),
      expectedResult: form.expectedResult.trim(),
      context: form.context.trim(),
      constraints: lines(form.constraints),
      doneWhen: lines(form.doneWhen),
      verify: lines(form.verify),
      stopRules: lines(form.stopRules),
    };
  }

  async function create(event) {
    event.preventDefault();
    if (!valid || busy || workspace.readOnlyWorkspace || (mode === "goal" && !builderModelReady)) return;
    setBusy(true);
    try {
      if (mode === "goal") await workspace.createWorkflowProposal(details(), builderModelRevisionId);
      else await workspace.createWorkflow(details());
    } finally {
      setBusy(false);
    }
  }

  function proposalLabel(operation) {
    const key = proposalOperationKey(operation);
    const translated = t(key);
    return translated === key ? t("builder.proposalOperation.unknown") : translated;
  }

  if (workspace.creationProposalContext && workspace.pendingPatch) {
    const definition = details();
    const definitionRows = [
      [t("loopCreate.desiredOutcome"), definition.goal],
      [t("loopCreate.requiredInformation"), definition.context],
      [t("loopCreate.constraintsReference"), definition.constraints.join("; ")],
      [t("loopOverview.expectedResult"), definition.expectedResult],
    ].filter(([, value]) => String(value || "").trim());

    return (
      <div className="surface createProposalPage" data-testid="loopops.create-loop.proposal-review" aria-live="polite">
        <header className="createProposalHeader">
          <div className="createLoopBreadcrumb"><button type="button" onClick={() => workspace.setActivePage("loops")}>{t("nav.loops")}</button><span>/</span><span>{t("loopCreate.title")}</span><span>/</span><span>{t("loopCreate.proposalKicker")}</span></div>
          <div><h1>{t("loopCreate.proposalReviewTitle")}</h1><p>{t("loopCreate.proposalReviewIntro", { title: workspace.creationProposalContext.title })}</p></div>
        </header>
        <div className="createProposalLayout">
          <ol className="proposalProgress" aria-label={t("loopCreate.proposalKicker")}>
            <li className="done"><span><CheckCircle2 size={15} /></span><div><strong>{t("loopCreate.desiredOutcome")}</strong><small>{t("status.ready")}</small></div></li>
            <li className="active"><span>2</span><div><strong>{t("loopCreate.proposalKicker")}</strong><small>{t("state.reviewRequired")}</small></div></li>
            <li><span>3</span><div><strong>{t("loopCreate.continue")}</strong><small>{t("loopCreate.proposalSafety")}</small></div></li>
          </ol>
          <main className="proposalReviewMain">
            <section className="proposalDefinition">
              <h2>{t("builder.definitionTitle")}</h2>
              <dl>{definitionRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </section>
            <section className="proposalOperations">
              <div className="proposalSectionHeading"><h2>{t("builder.proposalChanges")}</h2><span>{t("builder.proposalChangeCount", { count: workspace.pendingPatch.operations.length })}</span></div>
              <ol>{workspace.pendingPatch.operations.map((operation, index) => <li key={`${operation.op}-${index}`}><span>{index + 1}</span><div><strong>{proposalLabel(operation)}</strong><small>{t("loopCreate.proposalSafety")}</small></div><CheckCircle2 size={16} /></li>)}</ol>
            </section>
            <p className="proposalSafetyNote"><Sparkles size={16} /> {t("loopCreate.proposalSafety")}</p>
          </main>
          <aside className="proposalReviewRail">
            <section><h3>{t("builder.proposalSummary")}</h3><dl><div><dt>{t("builder.proposalChangeCount", { count: workspace.pendingPatch.operations.length })}</dt><dd>{workspace.pendingPatch.operations.length}</dd></div><div><dt>{t("object.skillPackage")}</dt><dd>{t("status.ready")}</dd></div></dl></section>
            <section><h3>{t("builder.validationHeading")}</h3><ul><li><CheckCircle2 size={15} /> {t("publish.definitionReady")}</li><li><CheckCircle2 size={15} /> {t("loopCreate.proposalSafety")}</li></ul></section>
          </aside>
        </div>
        <footer className="createProposalFooter"><Button variant="secondary" disabled={workspace.builderAssistantBusy} onClick={workspace.dismissBuilderPatch} data-testid="loopops.create-loop.proposal-dismiss">{t("loopCreate.keepEmptyDraft")}</Button><Button variant="primary" disabled={workspace.builderAssistantBusy || workspace.pendingPatch.status !== "proposed"} onClick={workspace.applyBuilderPatch} data-testid="loopops.create-loop.proposal-apply">{t("actions.applyPatch")}</Button></footer>
      </div>
    );
  }

  return (
    <div className="surface createLoopPage createLoopPageV2" data-testid="loopops.create-loop.page">
      <header className="createLoopHeader">
        <div className="createLoopBreadcrumb"><button type="button" onClick={() => workspace.setActivePage("loops")}>{t("nav.loops")}</button><span>/</span><span>{t("loopCreate.title")}</span></div>
        <h1>{t("loopCreate.title")}</h1>
        <p>{t("loopCreate.referenceIntro")}</p>
      </header>

      <form className="createLoopShell" onSubmit={create} aria-busy={busy || workspace.builderAssistantBusy}>
        <nav className="createLoopModes" aria-label={t("loopCreate.chooseMethod")}>
          {MODES.map(({ id, icon: Icon }) => (
            <button key={id} type="button" className={mode === id ? "selected" : ""} aria-pressed={mode === id} onClick={() => setMode(id)} data-testid={`loopops.create-loop.mode.${id}`}>
              <Icon size={25} aria-hidden="true" />
              <span><strong>{t(`loopCreate.mode.${id}`)}</strong><small>{t(`loopCreate.mode.${id}.caption`)}</small></span>
            </button>
          ))}
        </nav>

        <section className="createLoopWorkspace">
          {mode === "goal" ? (
            <div className="createGoalForm">
              <div className="createLoopSectionHeading"><h2>{t("loopCreate.describeGoalHeading")}</h2><p>{t("loopCreate.describeGoalCaption")}</p></div>
              <label className="createField">
                <span>{t("loopCreate.desiredOutcome")} <b aria-hidden="true">*</b></span>
                <textarea value={form.goal} onChange={(event) => update("goal", event.target.value)} placeholder={t("loopCreate.goalReferencePlaceholder")} rows={4} data-testid="loopops.create-loop.goal" autoFocus />
                <small>{t("loopCreate.desiredOutcomeHint")}</small>
              </label>
              <div className="createField">
                <span>{t("loopCreate.exampleResult")}</span>
                <button type="button" className="createFileDrop" onClick={workspace.openCreateResourceDialog} data-testid="loopops.create-loop.example-file"><Paperclip size={15} /> <strong>{t("loopCreate.attachFile")}</strong><span>{t("loopCreate.orDragDrop")}</span></button>
                <small>{t("loopCreate.exampleResultHint")}</small>
              </div>
              <label className="createField">
                <span>{t("loopCreate.requiredInformation")}</span>
                <input value={form.context} onChange={(event) => update("context", event.target.value)} placeholder={t("loopCreate.requiredInformationPlaceholder")} />
                <small>{t("loopCreate.requiredInformationHint")}</small>
              </label>
              <label className="createField">
                <span>{t("loopCreate.constraintsReference")}</span>
                <textarea value={form.constraints} onChange={(event) => update("constraints", event.target.value)} placeholder={t("loopCreate.constraintsReferencePlaceholder")} rows={3} />
                <small>{t("loopCreate.constraintsReferenceHint")}</small>
              </label>

              <section className="aiHelpPanel" aria-labelledby="ai-help-title">
                <h3 id="ai-help-title">{t("loopCreate.aiHelp")}</h3>
                <div><Sparkles size={17} /><strong>{t("loopCreate.aiDefinition")}</strong><span>{t("loopCreate.aiDefinitionCopy")}</span></div>
                <div><Puzzle size={17} /><strong>{t("loopCreate.aiSkills")}</strong><span>{t("loopCreate.aiSkillsCopy")}</span></div>
                <div><ListOrdered size={17} /><strong>{t("loopCreate.aiSteps")}</strong><span>{t("loopCreate.aiStepsCopy")}</span></div>
              </section>

              <ModelPicker
                options={builderModels.options}
                requiredCapabilities={["chat", "tool_calling", "structured_output"]}
                value={builderModelRevisionId}
                onChange={setBuilderModelRevisionId}
                label={t("model.builder")}
                hint={t("model.turnPinHint")}
                loading={builderModels.isLoading}
                unavailableLabel={t("model.unavailable")}
                historicalLabel={t("model.historical")}
                testId="loopops.create-loop.model"
              />

              {workspace.creationProposalContext && workspace.pendingPatch ? (
                <section className="createLoopProposalReview" data-testid="loopops.create-loop.proposal-review" aria-live="polite">
                  <div><p className="objectKicker">{t("loopCreate.proposalKicker")}</p><h3>{t("loopCreate.proposalTitle", { title: workspace.creationProposalContext.title })}</h3><p>{workspace.pendingPatch.summary}</p></div>
                  <ul>{workspace.pendingPatch.operations.slice(0, 6).map((operation, index) => <li key={`${operation.op}-${index}`}>{proposalLabel(operation)}</li>)}</ul>
                  <p className="muted">{t("loopCreate.proposalSafety")}</p>
                  <div className="buttonRow"><Button variant="secondary" disabled={workspace.builderAssistantBusy} onClick={workspace.dismissBuilderPatch} data-testid="loopops.create-loop.proposal-dismiss">{t("loopCreate.keepEmptyDraft")}</Button><Button variant="primary" disabled={workspace.builderAssistantBusy || workspace.pendingPatch.status !== "proposed"} onClick={workspace.applyBuilderPatch} data-testid="loopops.create-loop.proposal-apply">{t("actions.applyPatch")}</Button></div>
                </section>
              ) : workspace.creationProposalContext && workspace.builderProposalError ? (
                <section className="createLoopProposalError" role="alert" data-testid="loopops.create-loop.proposal-error"><strong>{t("loopCreate.proposalUnavailable")}</strong><p>{workspace.builderProposalError}</p><div className="buttonRow"><Button variant="secondary" disabled={workspace.builderAssistantBusy} onClick={workspace.retryCreationProposal} data-testid="loopops.create-loop.proposal-retry">{t("loopCreate.retryProposal")}</Button><Button variant="secondary" onClick={workspace.openCreationDraft}>{t("loopCreate.continueWithoutProposal")}</Button></div></section>
              ) : null}
            </div>
          ) : null}

          {mode === "blank" ? (
            <div className="createLoopAlternative" data-testid="loopops.create-loop.blank">
              <FileText size={28} /><h2>{t("loopCreate.blankHeading")}</h2><p>{t("loopCreate.blankCaption")}</p>
              <label className="createField"><span>{t("loopCreate.name")}</span><input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={t("loopCreate.namePlaceholder")} data-testid="loopops.create-loop.name" /></label>
            </div>
          ) : null}

          {mode === "starting" ? (
            <div className="createLoopChoiceList" data-testid="loopops.create-loop.starting-points"><h2>{t("loopCreate.startingHeading")}</h2>{[...templates.map((item) => ({ ...item, sourceKind: "template" })), ...startingPoints.map((item) => ({ ...item, sourceKind: "release" }))].map((item) => <article key={item.id || item.releaseId}><div><strong>{item.title}</strong><p>{item.description || item.releaseNotes}</p></div><Button variant="secondary" onClick={() => item.sourceKind === "template" ? workspace.cloneLoop(item.id) : workspace.useTeamReleaseAsStartingPoint(item.releaseId, item.title)} data-testid={`loopops.create-loop.starting-point.${item.sourceKind}.${item.id || item.releaseId}`}>{t("actions.useStartingPoint")}</Button></article>)}{!templates.length && !startingPoints.length ? <p className="emptyInline">{t("loopCreate.noStartingPoints")}</p> : null}</div>
          ) : null}

          {mode === "upload" ? <div className="createLoopAlternative" data-testid="loopops.create-loop.upload"><UploadCloud size={30} /><h2>{t("loopCreate.uploadHeading")}</h2><p>{t("loopCreate.uploadCaption")}</p><Button variant="primary" disabled={workspace.readOnlyWorkspace} onClick={workspace.openLoopImportDialog}>{t("loopTransfer.uploadLoop")}</Button></div> : null}

          {mode === "duplicate" ? <div className="createLoopChoiceList" data-testid="loopops.create-loop.duplicates"><h2>{t("loopCreate.duplicateHeading")}</h2>{ownedLoops.map((loop) => <article key={loop.id}><div><strong>{loop.title}</strong><p>{loop.description}</p></div><Button variant="secondary" disabled={workspace.readOnlyWorkspace || busy} onClick={() => workspace.duplicateWorkflow(loop.id)}>{t("actions.duplicate")}</Button></article>)}{!ownedLoops.length ? <p className="emptyInline">{t("loopCreate.noLoopsToDuplicate")}</p> : null}</div> : null}
        </section>

        <footer className="createLoopFooter">
          <div className="createAutosave"><CheckCircle2 size={16} /><span>{t("loopCreate.autosaved")}</span></div>
          <div className="createFooterSafety"><LockKeyhole size={15} /><span>{t("loopCreate.proposalSafety")}</span></div>
          <div className="createFooterActions">
            <Button variant="secondary" type="button" onClick={() => workspace.setActivePage("loops")}>{t("actions.cancel")}</Button>
            {mode === "goal" ? <Button type="button" variant="secondary" disabled={!valid || busy || workspace.readOnlyWorkspace} onClick={() => workspace.createWorkflow(details())} data-testid="loopops.create-loop.save-empty">{t("loopCreate.saveEmptyDraft")}</Button> : null}
            {(mode === "goal" || mode === "blank") ? <Button type="submit" variant="primary" disabled={!valid || busy || workspace.readOnlyWorkspace || (mode === "goal" && !builderModelReady)} data-testid="loopops.create-loop.submit">{busy || workspace.builderAssistantBusy ? t("loopCreate.preparingProposal") : t(mode === "goal" ? "loopCreate.reviewProposal" : "loopCreate.continue")}</Button> : null}
          </div>
        </footer>
      </form>
    </div>
  );
}
