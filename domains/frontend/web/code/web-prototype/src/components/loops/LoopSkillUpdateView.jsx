import {
  ArrowLeft,
  ArrowRight,
  Cable,
  CheckCircle2,
  GitCommitHorizontal,
  ListChecks,
  ShieldCheck,
} from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ConnectionRebindingSheet } from "../connections/ConnectionRebindingSheet.jsx";
import { useConnectionRebindingAction } from "../connections/useConnectionRebindingAction.js";
import { StatusPill } from "../shared/StatusPill.jsx";

export function LoopSkillUpdateView({ workspace }) {
  const t = workspace.t;
  const preview = workspace.loopSkillUpdatePreview;
  const rebinding = useConnectionRebindingAction({
    readOnly: workspace.readOnlyWorkspace,
    onError(error) {
      workspace.pushToast(error?.message || t("loopUpdate.failed"));
    },
  });

  if (!preview) return null;

  const changedItems = preview.changes.filter((item) => item.changed);
  const requirements = preview.targetVersion.connectionRequirements.filter((item) => item.required);
  const busy = Boolean(rebinding.busyAction);

  function createDraft() {
    return rebinding.run({
      actionKey: `loop-update:${preview.workflowId}:${preview.targetVersion.skillVersionId}`,
      actionLabel: t("loopUpdate.createDraft"),
      requirements,
      execute(connectionBindings) {
        return workspace.applyLoopSkillUpdate(
          preview,
          connectionBindings,
          undefined,
          { propagateConnectionError: true },
        );
      },
    });
  }

  return (
    <div className="surface loopUpdatePage" data-testid="loopops.loop-update.review">
      <header className="loopUpdateHeader">
        <div>
          <button type="button" className="backLink" onClick={() => workspace.openLoop(preview.workflowId)}>
            <ArrowLeft size={15} /> {t("actions.backToLoop")}
          </button>
          <p className="objectKicker">{t("loopUpdate.kicker")}</p>
          <h2>{t("loopUpdate.title", { title: preview.workflowName })}</h2>
          <p>{t("loopUpdate.caption")}</p>
        </div>
      </header>

      <div className="loopUpdateLayout">
        <main className="loopUpdateMain">
          <section className="loopUpdateSection">
            <h3><GitCommitHorizontal size={17} /> {t("loopUpdate.versionChange")}</h3>
            <div className="loopUpdateVersions">
              <div><span>{t("loopUpdate.current")}</span><strong>{preview.currentVersion.name}</strong><small>{preview.currentVersion.version}</small></div>
              <ArrowRight size={18} aria-hidden="true" />
              <div><span>{t("loopUpdate.new")}</span><strong>{preview.targetVersion.name}</strong><small>{preview.targetVersion.version}</small></div>
            </div>
          </section>

          <section className="loopUpdateSection">
            <h3><ListChecks size={17} /> {t("loopUpdate.changes")}</h3>
            <ul className="loopUpdateChanges" data-testid="loopops.loop-update.changes">
              {(changedItems.length ? changedItems : preview.changes).map((item) => (
                <li key={item.field}>
                  <span><strong>{t(`skills.diff.${item.field}`)}</strong><small>{workspace.locale === "en" ? item.summary : t("loopUpdate.changed")}</small></span>
                  <StatusPill tone={item.severity === "warning" ? "warning" : "info"}>{t("loopUpdate.changed")}</StatusPill>
                </li>
              ))}
            </ul>
          </section>

          <section className="loopUpdateSection">
            <h3><CheckCircle2 size={17} /> {t("loopUpdate.affectedSteps")}</h3>
            <ul className="loopUpdateSteps">
              {preview.affectedNodes.map((node) => <li key={node.nodeId}><span>{node.title}</span><small>{t("loopUpdate.stepWillUse", { version: preview.targetVersion.version })}</small></li>)}
            </ul>
          </section>

          <section className="loopUpdateSection">
            <h3><Cable size={17} /> {t("loopUpdate.connections")}</h3>
            {requirements.length ? (
              <ul className="loopUpdateSteps">{requirements.map((item) => <li key={item.requirementId}><span>{item.label}</span><small>{item.permissionSummary}</small></li>)}</ul>
            ) : <p>{t("loopUpdate.noNewConnections")}</p>}
          </section>
        </main>

        <aside className="loopUpdateRail">
          <div className="loopUpdateSafety"><ShieldCheck size={18} /><div><strong>{t("loopUpdate.safeTitle")}</strong><p>{t("loopUpdate.safeBody")}</p></div></div>
          <div className="loopUpdateNotice"><strong>{t("loopUpdate.testAgain")}</strong><p>{t("loopUpdate.testAgainBody")}</p></div>
          <div className="loopUpdateActions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => workspace.openLoop(preview.workflowId)}
              data-testid="loopops.loop-update.cancel"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={workspace.readOnlyWorkspace || busy}
              title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined}
              onClick={createDraft}
              data-testid="loopops.loop-update.create-draft"
            >
              {t("loopUpdate.createDraft")}
            </Button>
          </div>
        </aside>
      </div>

      <ConnectionRebindingSheet
        {...rebinding.sheetProps}
        readOnly={workspace.readOnlyWorkspace}
        onRequestAccess={workspace.requestWorkspaceAccess}
        t={t}
      />
    </div>
  );
}
