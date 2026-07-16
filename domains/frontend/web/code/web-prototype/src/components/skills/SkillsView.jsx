import { Boxes, FileUp, MoreHorizontal, ShieldCheck, Sparkles } from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { DatabaseTable } from "../shared/DatabaseTable.jsx";
import { ObjectHeader } from "../shared/ObjectHeader.jsx";
import { Section } from "../shared/Section.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { EmptyState } from "../shared/EmptyState.jsx";
import { RetireSkillDialog } from "./RetireSkillDialog.jsx";
import { UpdateSkillDialog } from "./UpdateSkillDialog.jsx";
import { productDescription, productTitle } from "../../utils/productCopy.js";

function skillColumns(t) {
  return [
    { key: "title", label: t("skills.columns.skill"), width: "minmax(140px, 1.15fr)" },
    { key: "purpose", label: t("skills.columns.purpose"), width: "minmax(160px, 1.35fr)" },
    { key: "owner", label: t("skills.columns.owner"), width: "72px" },
    { key: "version", label: t("skills.columns.version"), width: "54px" },
    { key: "validation", label: t("skills.columns.validation"), width: "84px" },
    { key: "usedBy", label: t("skills.columns.usedBy"), width: "54px" },
    { key: "action", label: t("skills.columns.action"), width: "116px" },
  ];
}

const skillSegments = ["All", "Ready", "Needs source", "Low", "Medium", "High"];

const segmentLabelKeys = {
  All: "segments.all",
  Ready: "segments.ready",
  "Needs source": "segments.needsSource",
  Low: "segments.low",
  Medium: "segments.medium",
  High: "segments.high",
};

function setupStateLabel(value, t) {
  if (value === "Ready") return t("status.ready");
  if (value === "Needs source") return t("status.needsSource");
  if (value === "Retired") return t("status.retired");
  return value;
}

function riskLabel(value, t) {
  const key = String(value || "").toLowerCase();
  if (key === "low" || key === "medium" || key === "high") return t(`risk.${key}`);
  return value;
}

function skillSourceLabel(skill, t) {
  if (skill?.source === "Workspace") return t("skills.workspace");
  if (skill?.kind === "SkillPackage" && skill?.source === "Installed") return `${t("object.skillPackage")} · ${t("source.installed")}`;
  if (skill?.source === "Local") return `${t("object.skillPackage")} · ${t("source.local")}`;
  return t("object.skillPackage");
}

function actionBoundaryLabel(value, t) {
  if (["No external action", "No external action is configured."].includes(value)) return t("skills.noExternalAction");
  return value;
}

function isProductSkill(skill) {
  const text = `${skill?.title || ""} ${skill?.description || ""}`.toLowerCase();
  return !/(conformance|fixture|executable review smoke|smoke boundary)/.test(text);
}

function skillOwner(skill, t) {
  if (skill?.source === "Installed") return t("skills.teamOwner");
  return t("skills.youOwner");
}

export function SkillsView({ workspace }) {
  const t = workspace.t;
  const productSkills = workspace.managedSkills.filter(isProductSkill);
  const rows = productSkills.filter((skill) => {
    const haystack = `${skill.title} ${skill.description} ${skill.setupState} ${skill.risk}`.toLowerCase();
    const matchesQuery = haystack.includes(workspace.query.toLowerCase());
    const matchesFilter =
      workspace.skillFilter === "All" ||
      skill.setupState === workspace.skillFilter ||
      skill.risk === workspace.skillFilter;
    return matchesQuery && matchesFilter;
  });
  const selected = rows.find((skill) => skill.id === workspace.selectedManagedSkillId)
    || productSkills.find((skill) => skill.id === workspace.selectedManagedSkillId)
    || rows[0]
    || productSkills[0]
    || null;

  return (
    <div className="surface browseDetail skillsLibraryV1" data-testid="loopops.skills.surface">
      <section className="browsePane">
        <div className="surfaceToolbar">
          <input
            value={workspace.query}
            onChange={(event) => workspace.setQuery(event.target.value)}
            placeholder={t("skills.search")}
            aria-label={t("skills.searchLabel")}
            data-testid="loopops.skills.search"
          />
          <select value={workspace.skillFilter} onChange={(event) => workspace.setSkillFilter(event.target.value)} aria-label={t("skills.filter")}>
            {skillSegments.map((segment) => (
              <option key={segment} value={segment}>{t(segmentLabelKeys[segment])}</option>
            ))}
          </select>
          <Button variant="secondary" icon={<FileUp size={15} />} disabled={workspace.readOnlyWorkspace} title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined} onClick={() => workspace.openCreateSkillDialog("files")} data-testid="loopops.skills.upload">
            {t("globalCreate.uploadSkill")}
          </Button>
          <Button variant="primary" disabled={workspace.readOnlyWorkspace} title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : undefined} onClick={workspace.openCreateSkillDialog} data-testid="loopops.skills.create">
            {t("actions.createSkill")}
          </Button>
        </div>
        <div className="segments">
          {skillSegments.map((item) => (
            <button
              className={workspace.skillFilter === item ? "active" : ""}
              key={item}
              onClick={() => workspace.setSkillFilter(item)}
            >
              {t(segmentLabelKeys[item])}
            </button>
          ))}
        </div>
        {productSkills.length ? <DatabaseTable
          className="skillsTable"
          columns={skillColumns(t)}
          rows={rows}
          getRowId={(row) => row.id}
          selectedId={selected?.id}
          onRowClick={(row) => workspace.setSelectedManagedSkillId(row.id)}
          renderCell={(row, key) => {
            if (key === "title") {
              return (
                <span className="skillIdentityCell">
                  <span className="skillIdentityIcon"><Sparkles size={16} /></span>
                  <span className="nameStack">
                    <strong title={productTitle(row, workspace.locale)}>{productTitle(row, workspace.locale)}</strong>
                    <small>{row.source === "Installed" ? t("source.installed") : t("skills.workspace")}</small>
                  </span>
                </span>
              );
            }
            if (key === "purpose") return <span className="skillPurposeCell" title={productDescription(row, workspace.locale)}>{productDescription(row, workspace.locale)}</span>;
            if (key === "owner") return <span className="skillOwnerCell"><span>{skillOwner(row, t).slice(0, 1)}</span><small>{skillOwner(row, t)}</small></span>;
            if (key === "version") return <span className="skillVersionCell">{row.version || "-"}</span>;
            if (key === "validation") return <span className="skillValidationCell"><ShieldCheck size={14} /><small>{setupStateLabel(row.setupState, t)}</small></span>;
            if (key === "usedBy") return <span className="skillUsageCell">{row.usedBy.length ? row.usedBy.length : 0}</span>;
            if (key === "action") {
              return (
                <span className="skillRowActions">
                  <Button
                    variant={row.canAddToWorkflow ? "secondary" : "plain"}
                    disabled={workspace.readOnlyWorkspace || !row.canAddToWorkflow}
                    title={workspace.readOnlyWorkspace ? t("permissions.readOnlyAction") : row.canAddToWorkflow ? undefined : t("skills.needsPublishing")}
                    onClick={(event) => {
                      event.stopPropagation();
                      workspace.addManagedSkillToLoop(row.id);
                    }}
                    data-testid={`loopops.skills.add.${row.id}`}
                  >
                    {row.canAddToWorkflow ? t("actions.addToWorkflow") : t("skills.needsPublishing")}
                  </Button>
                  <button type="button" className="rowMoreAction" aria-label={t("actions.viewSkill")} onClick={(event) => { event.stopPropagation(); workspace.openSkill(row.id); }}><MoreHorizontal size={16} /></button>
                </span>
              );
            }
            return row[key];
          }}
        /> : <EmptyState
          title={t("skills.emptyTitle")}
          body={t("skills.emptyBody")}
          actionLabel={t("actions.createSkill")}
          onAction={workspace.openCreateSkillDialog}
        />}
      </section>

      <aside className="detailPane skillPreviewPane" data-testid="loopops.skills.detail">
        {selected ? (
          <>
            <ObjectHeader
              mark={<Boxes size={17} />}
              kicker={skillSourceLabel(selected, t)}
              title={productTitle(selected, workspace.locale)}
              description={productDescription(selected, workspace.locale)}
              meta={[
                { value: setupStateLabel(selected.setupState, t) },
                { label: t("skills.risk"), value: riskLabel(selected.risk, t) },
                { label: t("skills.actionBoundary"), value: actionBoundaryLabel(selected.externalAction, t) },
              ]}
              primaryLabel={selected.canAddToWorkflow ? t("actions.addToWorkflow") : t("skills.needsPublishing")}
              primaryDisabled={workspace.readOnlyWorkspace || !selected.canAddToWorkflow}
              onPrimary={() => workspace.addManagedSkillToLoop(selected.id)}
              secondary={(
                <Button variant="plain" onClick={() => workspace.openSkill(selected.id)} data-testid="loopops.skills.view">
                  {t("actions.viewSkill")}
                </Button>
              )}
            />
            <Section title={t("skills.contract")}>
              <dl className="propertyGrid">
                <dt>{t("skills.needs")}</dt>
                <dd>{selected.inputs.join(", ")}</dd>
                <dt>{t("skills.creates")}</dt>
                <dd>{selected.outputs.join(", ")}</dd>
                <dt>{t("skills.dependsOn")}</dt>
                <dd>{selected.dependencies.join(", ")}</dd>
                <dt>{t("skills.bestFor")}</dt>
                <dd>{selected.scenarios.join(", ")}</dd>
              </dl>
            </Section>
            <Section title={t("skills.addTarget")}>
              <div className="targetGrid">
                <Button variant="secondary" disabled={workspace.readOnlyWorkspace || !selected.canAddToWorkflow} onClick={() => workspace.addManagedSkillToLoop(selected.id, workspace.selectedLoopId)}>
                  {t("actions.addToWorkflow")}
                </Button>
                <Button variant="secondary" onClick={() => workspace.setActivePage("loops")}>
                  {t("actions.openLoops")}
                </Button>
              </div>
            </Section>
            <Section title={t("skills.usedBy")}>
              {selected.usedBy.length ? (
                <ul className="cleanList">
                  {selected.usedBy.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : <p className="muted">{t("skills.notUsedYet")}</p>}
            </Section>
            {selected.version ? <Section title={t("skills.versionTitle")}>
              <div className="targetGrid">
                <span className="muted">{t("skills.currentVersion", { version: selected.version })}</span>
                {selected.canCreateUpdate ? (
                  <Button variant="secondary" disabled={workspace.readOnlyWorkspace} onClick={() => workspace.openSkillUpdateDialog(selected)} data-testid="loopops.skill-update.open">
                    {t("actions.createSkillUpdate")}
                  </Button>
                ) : null}
                {selected.canRetire ? <Button variant="plain" disabled={workspace.readOnlyWorkspace} onClick={() => workspace.openRetireSkillDialog(selected)} data-testid="loopops.skill-retire.open">
                  {t("actions.stopUsingSkill")}
                </Button> : null}
              </div>
            </Section> : null}
          </>
        ) : null}
      </aside>
      <UpdateSkillDialog workspace={workspace} />
      <RetireSkillDialog workspace={workspace} />
    </div>
  );
}
