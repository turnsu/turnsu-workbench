import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, FileText, FlaskConical, History, Pencil, ShieldCheck } from "lucide-react";

import { Button } from "../shared/Button.jsx";
import { ObjectHeader } from "../shared/ObjectHeader.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { Section } from "../shared/Section.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import {
  useSkillUsageQuery,
  useSkillVersionDiffQuery,
  useSkillVersionsQuery,
} from "../../api/queries.js";
import { RetireSkillDialog } from "./RetireSkillDialog.jsx";
import { SkillPackageEditor } from "./SkillPackageEditor.jsx";
import { UpdateSkillDialog } from "./UpdateSkillDialog.jsx";
import { productDescription, productTitle } from "../../utils/productCopy.js";

const routeTabs = [
  { page: "skill-overview", label: "skillLifecycle.tabs.overview" },
  { page: "skill-instructions", label: "skillLifecycle.tabs.instructions" },
  { page: "skill-files", label: "skillLifecycle.tabs.files" },
  { page: "skill-editor", label: "skillLifecycle.tabs.edit" },
  { page: "skill-tests", label: "skillLifecycle.tabs.tests" },
  { page: "skill-versions", label: "skillLifecycle.tabs.versions" },
];

const routeTestIds = {
  "skill-overview": "loopops.skill.overview",
  "skill-instructions": "loopops.skill.instructions",
  "skill-files": "loopops.skill.files",
  "skill-editor": "loopops.skill.editor",
  "skill-tests": "loopops.skill.tests",
  "skill-versions": "loopops.skill.versions",
};

function lifecycleLabel(skill, t) {
  if (skill?.canonical?.skill?.lifecycle === "deprecated") return t("status.retired");
  if (skill?.canonical?.version) return t("skillLifecycle.published");
  return t("skillLifecycle.draft");
}

function schemaFields(schema) {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  return Object.entries(properties).map(([key, value]) => ({
    key,
    label: value?.title || key,
    type: value?.type || "value",
    required: required.has(key),
  }));
}

function ReadableFields({ fields, empty, requiredLabel, optionalLabel }) {
  if (!fields.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="skillFieldList">
      {fields.map((field) => (
        <li key={field.key}>
          <span>
            <strong>{field.label}</strong>
          </span>
          <StatusPill tone={field.required ? "info" : "neutral"}>
            {field.required ? requiredLabel : optionalLabel}
          </StatusPill>
        </li>
      ))}
    </ul>
  );
}

export function SkillLifecycleView({ workspace }) {
  const t = workspace.t;
  const skill = workspace.selectedManagedSkill;
  const draft = workspace.selectedSkillDraft;
  const version = skill?.canonical?.version || null;
  const model = draft || version;
  const page = workspace.activePage;
  const queryState = workspace.surfaceState?.skill;

  if (queryState?.loading || queryState?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={queryState}
        objectLabel={t("object.skillPackage")}
        onRetry={() => workspace.retrySurface("skill")}
        onBack={() => workspace.setActivePage("skills")}
        backLabel={t("actions.backToSkills")}
        testId="loopops.skill.query-state"
      />
    );
  }

  if (!skill || !model) {
    return (
      <div className="surface skillLifecycleSurface">
        <Button variant="plain" icon={<ArrowLeft size={15} />} onClick={() => workspace.setActivePage("skills")}>
          {t("actions.backToSkills")}
        </Button>
        <Section title={t("skillLifecycle.notFoundTitle")}>
          <p>{t("skillLifecycle.notFoundBody")}</p>
        </Section>
      </div>
    );
  }

  const inputFields = schemaFields(model.inputSchema);
  const outputFields = schemaFields(model.outputSchema);
  const isPublished = Boolean(version);
  const primary = page === "skill-overview"
    ? isPublished
      ? { label: t("actions.addToWorkflow"), action: () => workspace.addManagedSkillToLoop(skill.id) }
      : { label: t("actions.continueEditing"), action: () => workspace.openSkill(skill.id, "skill-editor") }
    : null;

  return (
    <div className="surface skillLifecycleSurface" data-testid={routeTestIds[page] || routeTestIds["skill-overview"]}>
      <div className="objectRouteBack">
        <Button variant="plain" icon={<ArrowLeft size={15} />} onClick={() => workspace.setActivePage("skills")}>
          {t("actions.backToSkills")}
        </Button>
      </div>
      <ObjectHeader
        mark={workspace.locale === "zh" ? "技" : "Sk"}
        kicker={t("skillLifecycle.kicker")}
        title={productTitle({ title: model.name }, workspace.locale)}
        description={productDescription({ title: model.name, description: model.description }, workspace.locale)}
        meta={[
          { value: lifecycleLabel(skill, t), tone: isPublished ? "success" : "info" },
          { label: t("skills.risk"), value: t(`risk.${model.risk?.level || "low"}`) },
          { label: t("skillLifecycle.version"), value: version?.version || t("skillLifecycle.notPublished") },
        ]}
        primaryLabel={primary?.label}
        onPrimary={primary?.action}
      />

      <nav className="objectRouteTabs" aria-label={t("skillLifecycle.navigation")}>
        {routeTabs.map((tab) => (
          <button
            type="button"
            key={tab.page}
            className={page === tab.page ? "active" : ""}
            aria-current={page === tab.page ? "page" : undefined}
            onClick={() => workspace.openSkill(skill.id, tab.page)}
            data-testid={`loopops.skill.tab.${tab.page.replace("skill-", "")}`}
          >
            {t(tab.label)}
          </button>
        ))}
      </nav>

      {page === "skill-instructions" ? (
        <SkillPackageEditor workspace={workspace} draft={draft} mode="instructions" />
      ) : page === "skill-files" ? (
        <SkillPackageEditor workspace={workspace} draft={draft} mode="files" />
      ) : page === "skill-editor" ? (
        <SkillEditor workspace={workspace} draft={draft} />
      ) : page === "skill-tests" ? (
        <SkillTests workspace={workspace} draft={draft} />
      ) : page === "skill-versions" ? (
        <SkillVersions workspace={workspace} skill={skill} draft={draft} version={version} />
      ) : (
        <SkillOverview
          workspace={workspace}
          skill={skill}
          model={model}
          inputFields={inputFields}
          outputFields={outputFields}
        />
      )}
      <UpdateSkillDialog workspace={workspace} />
      <RetireSkillDialog workspace={workspace} />
    </div>
  );
}

function SkillOverview({ workspace, skill, model, inputFields, outputFields }) {
  const t = workspace.t;
  const files = model.files || [];
  return (
    <div className="skillLifecycleBody">
      <div className="skillOverviewGrid">
        <Section title={t("skills.needs")} caption={t("skillLifecycle.needsCaption")}>
          <ReadableFields
            fields={inputFields}
            empty={t("skillLifecycle.noRequiredInfo")}
            requiredLabel={t("skillLifecycle.required")}
            optionalLabel={t("skillLifecycle.optional")}
          />
        </Section>
        <Section title={t("skills.creates")} caption={t("skillLifecycle.createsCaption")}>
          <ReadableFields
            fields={outputFields}
            empty={t("skillLifecycle.noCreatedInfo")}
            requiredLabel={t("skillLifecycle.always")}
            optionalLabel={t("skillLifecycle.mayCreate")}
          />
        </Section>
      </div>
      <Section title={t("skillLifecycle.permissions")} caption={t("skillLifecycle.permissionsCaption")}>
        <dl className="propertyGrid">
          <dt>{t("skillLifecycle.outsideActions")}</dt>
          <dd>{model.risk?.externalAction ? t("skillLifecycle.outsideActionsYes") : t("skillLifecycle.outsideActionsNo")}</dd>
          <dt>{t("skillLifecycle.connections")}</dt>
          <dd>{model.connectionRequirements?.length
            ? model.connectionRequirements.map((item) => item.label || item.kind).join(", ")
            : t("skillLifecycle.noConnections")}</dd>
          <dt>{t("skillLifecycle.safetyNote")}</dt>
          <dd>{["No external action", "No external action is configured."].includes(model.risk?.summary) ? t("skills.noExternalAction") : model.risk?.summary || t("skillLifecycle.noAdditionalRisk")}</dd>
        </dl>
      </Section>
      <Section title={t("skillLifecycle.files")} caption={t("skillLifecycle.filesCaption")}>
        {files.length ? (
          <ul className="skillFileList">
            {files.map((file) => (
              <li key={file.path}>
                <FileText size={15} />
                <span><strong>{file.path}</strong><small>{file.sizeBytes} B</small></span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">{t("skillLifecycle.filesUnavailable")}</p>}
      </Section>
      <Section title={t("skills.usedBy")}>
        {skill.usedBy.length ? <ul className="cleanList">{skill.usedBy.map((name) => <li key={name}>{name}</li>)}</ul> : <p className="muted">{t("skills.notUsedYet")}</p>}
      </Section>
    </div>
  );
}

function SkillEditor({ workspace, draft }) {
  const t = workspace.t;
  const [form, setForm] = useState({ name: "", description: "", category: "", riskSummary: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      name: draft?.name || "",
      description: draft?.description || "",
      category: draft?.category || "",
      riskSummary: draft?.risk?.summary || "",
    });
  }, [draft?.skillDraftId, draft?.revision]);

  if (!draft) {
    return <Section title={t("skillLifecycle.publishedOnlyTitle")}><p>{t("skillLifecycle.publishedOnlyBody")}</p></Section>;
  }

  const dirty = form.name.trim() !== draft.name
    || form.description.trim() !== draft.description
    || form.category.trim() !== draft.category
    || form.riskSummary.trim() !== (draft.risk?.summary || "");
  const valid = Boolean(form.name.trim() && form.description.trim() && form.category.trim());

  async function save(event) {
    event.preventDefault();
    if (!dirty || !valid || saving) return;
    setSaving(true);
    try {
      await workspace.saveSelectedSkillDraft({
        name: form.name.trim(),
        description: form.description.trim(),
        category: form.category.trim(),
        risk: { ...draft.risk, summary: form.riskSummary.trim() || draft.risk.summary },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="skillLifecycleBody skillEditorForm" onSubmit={save}>
      <Section
        title={t("skillLifecycle.overviewSettings")}
        caption={t("skillLifecycle.overviewSettingsCaption")}
        actions={<StatusPill tone={dirty ? "warning" : "success"}>{dirty ? t("state.unsavedChanges") : t("state.saved")}</StatusPill>}
      >
        <div className="skillFormGrid">
          <label><span>{t("skillCreate.name")}</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
          <label><span>{t("skillCreate.category")}</span><input value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} /></label>
          <label className="spanTwo"><span>{t("skillCreate.description")}</span><textarea rows={4} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="spanTwo"><span>{t("skillLifecycle.safetyNote")}</span><textarea rows={3} value={form.riskSummary} onChange={(event) => setForm((current) => ({ ...current, riskSummary: event.target.value }))} /></label>
        </div>
      </Section>
      <Section title={t("skillLifecycle.needsAndCreates")} caption={t("skillLifecycle.schemaEditingLater")}>
        <div className="skillOverviewGrid">
          <ReadableFields fields={schemaFields(draft.inputSchema)} empty={t("skillLifecycle.noRequiredInfo")} requiredLabel={t("skillLifecycle.required")} optionalLabel={t("skillLifecycle.optional")} />
          <ReadableFields fields={schemaFields(draft.outputSchema)} empty={t("skillLifecycle.noCreatedInfo")} requiredLabel={t("skillLifecycle.always")} optionalLabel={t("skillLifecycle.mayCreate")} />
        </div>
      </Section>
      <div className="stickyActionBar">
        <span>{dirty ? t("skillLifecycle.saveBeforeTesting") : t("skillLifecycle.readyForTesting")}</span>
        <Button variant="primary" type="submit" icon={<Pencil size={15} />} disabled={!dirty || !valid || saving} data-testid="loopops.skill.editor.save">
          {saving ? t("actions.saving") : t("actions.saveSkillDetails")}
        </Button>
      </div>
    </form>
  );
}

function SkillTests({ workspace, draft }) {
  const t = workspace.t;
  const lifecycle = workspace.selectedSkillLifecycle;
  const [form, setForm] = useState({
    name: "",
    purpose: "",
    input: "{\n  \n}",
    expectedOutput: "",
    timeoutSeconds: "30",
  });
  const [permissionAcknowledged, setPermissionAcknowledged] = useState(false);
  const [publish, setPublish] = useState({ version: "1.0.0", releaseNotes: "" });
  const [formError, setFormError] = useState("");
  const busy = workspace.serverState.mutations.runSkillTest.isPending
    || workspace.serverState.mutations.validateSkill.isPending
    || workspace.serverState.mutations.publishSkill.isPending;

  const testRun = lifecycle.testRun;
  const validation = lifecycle.validation;
  const testPassed = testRun?.status === "passed";
  const validationPassed = validation?.status === "passed";

  const testCase = useMemo(() => {
    try {
      const input = JSON.parse(form.input || "{}");
      const expectedOutput = form.expectedOutput.trim() ? JSON.parse(form.expectedOutput) : undefined;
      if (!input || Array.isArray(input) || typeof input !== "object") return null;
      if (expectedOutput !== undefined && (!expectedOutput || Array.isArray(expectedOutput) || typeof expectedOutput !== "object")) return null;
      return {
        name: form.name.trim(),
        purpose: form.purpose.trim(),
        input,
        ...(expectedOutput ? { expectedOutput } : {}),
        timeoutSeconds: Number(form.timeoutSeconds),
      };
    } catch {
      return null;
    }
  }, [form]);

  if (!draft) return <Section title={t("skillLifecycle.noDraftTitle")}><p>{t("skillLifecycle.noDraftBody")}</p></Section>;

  async function runTest(event) {
    event.preventDefault();
    if (!testCase?.name || !testCase?.purpose || !Number.isInteger(testCase.timeoutSeconds)) {
      setFormError(t("skillLifecycle.testFormInvalid"));
      return;
    }
    setFormError("");
    await workspace.runSelectedSkillTest(testCase);
  }

  return (
    <div className="skillLifecycleBody skillTestLayout">
      <Section title={t("skillLifecycle.runTestTitle")} caption={t("skillLifecycle.runTestCaption")}>
        <form className="skillTestForm" onSubmit={runTest} data-testid="loopops.skill.tests.form">
          <div className="skillFormGrid">
            <label><span>{t("skillLifecycle.testName")}</span><input data-testid="loopops.skill.tests.name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
            <label><span>{t("skillLifecycle.timeout")}</span><input data-testid="loopops.skill.tests.timeout" type="number" min="1" max="120" value={form.timeoutSeconds} onChange={(event) => setForm((current) => ({ ...current, timeoutSeconds: event.target.value }))} /></label>
            <label className="spanTwo"><span>{t("skillLifecycle.testPurpose")}</span><input data-testid="loopops.skill.tests.purpose" value={form.purpose} onChange={(event) => setForm((current) => ({ ...current, purpose: event.target.value }))} /></label>
            <label><span>{t("skillLifecycle.exampleInput")}</span><textarea data-testid="loopops.skill.tests.input" rows={7} value={form.input} onChange={(event) => setForm((current) => ({ ...current, input: event.target.value }))} spellCheck="false" /></label>
            <label><span>{t("skillLifecycle.expectedResult")}</span><textarea data-testid="loopops.skill.tests.expected" rows={7} value={form.expectedOutput} onChange={(event) => setForm((current) => ({ ...current, expectedOutput: event.target.value }))} placeholder={t("skillLifecycle.expectedOptional")} spellCheck="false" /></label>
          </div>
          {formError ? <p className="formError" role="alert">{formError}</p> : null}
          <Button variant="primary" type="submit" icon={<FlaskConical size={15} />} disabled={busy} data-testid="loopops.skill.tests.run">
            {busy ? t("skillLifecycle.runningTest") : t("actions.runSkillTest")}
          </Button>
        </form>
        {testRun ? <ResultPanel title={t("skillLifecycle.latestTest")} status={testRun.status} diagnostics={testRun.diagnostics} output={testRun.outputPreview} t={t} testId="loopops.skill.tests.result" /> : null}
      </Section>

      <Section title={t("skillLifecycle.reviewPermissionsTitle")} caption={t("skillLifecycle.reviewPermissionsCaption")}>
        <label className="permissionAcknowledgement">
          <input data-testid="loopops.skill.tests.permission-acknowledgement" type="checkbox" checked={permissionAcknowledged} onChange={(event) => setPermissionAcknowledged(event.target.checked)} />
          <span><strong>{t("skillLifecycle.permissionAcknowledgement")}</strong><small>{t("skillLifecycle.permissionSummary")}</small></span>
        </label>
        <Button
          variant="primary"
          icon={<ShieldCheck size={15} />}
          disabled={!testPassed || !permissionAcknowledged || busy}
          onClick={() => workspace.validateSelectedSkill()}
          data-testid="loopops.skill.tests.validate"
        >
          {t("actions.validateSkill")}
        </Button>
        {!testPassed ? <p className="actionReason" data-testid="loopops.skill.tests.validation-reason">{t("skillLifecycle.validationNeedsPassedTest")}</p> : !permissionAcknowledged ? <p className="actionReason" data-testid="loopops.skill.tests.validation-reason">{t("skillLifecycle.validationNeedsAcknowledgement")}</p> : null}
        {validation ? <ResultPanel title={t("skillLifecycle.validationResult")} status={validation.status} diagnostics={validation.diagnostics} t={t} testId="loopops.skill.tests.validation-result" /> : null}
      </Section>

      <Section title={t("skillLifecycle.publishTitle")} caption={t("skillLifecycle.publishCaption")}>
        <div className="skillPublishRow">
          <label><span>{t("skillLifecycle.versionName")}</span><input data-testid="loopops.skill.tests.publish-version" value={publish.version} onChange={(event) => setPublish((current) => ({ ...current, version: event.target.value }))} /></label>
          <label><span>{t("skillLifecycle.releaseNotes")}</span><input data-testid="loopops.skill.tests.release-notes" value={publish.releaseNotes} onChange={(event) => setPublish((current) => ({ ...current, releaseNotes: event.target.value }))} /></label>
          <Button
            variant="primary"
            icon={<Check size={15} />}
            disabled={!validationPassed || !publish.version.trim() || busy}
            onClick={() => workspace.publishSelectedSkill({ version: publish.version.trim(), releaseNotes: publish.releaseNotes.trim() })}
            data-testid="loopops.skill.tests.publish"
          >
            {t("actions.publishSkillVersion")}
          </Button>
        </div>
        {!validationPassed ? <p className="actionReason" data-testid="loopops.skill.tests.publish-reason">{t("skillLifecycle.publishNeedsValidation")}</p> : null}
      </Section>
    </div>
  );
}

function ResultPanel({ title, status, diagnostics = [], output, t, testId }) {
  return (
    <div className={`skillResult skillResult-${status}`} data-testid={testId} data-status={status}>
      <header><strong>{title}</strong><StatusPill>{t(`skillLifecycle.status.${status}`)}</StatusPill></header>
      {output ? <pre>{JSON.stringify(output, null, 2)}</pre> : null}
      {diagnostics.length ? (
        <ul className="issueList">{diagnostics.map((item, index) => <li key={`${item.code || "issue"}-${index}`}>{item.message}</li>)}</ul>
      ) : <p className="muted">{t("skillLifecycle.noIssues")}</p>}
    </div>
  );
}

function SkillVersions({ workspace, skill, draft, version }) {
  const t = workspace.t;
  const skillId = skill.id;
  const versionsQuery = useSkillVersionsQuery(skillId);
  const usageQuery = useSkillUsageQuery(skillId);
  const versions = versionsQuery.data?.data || [];
  const [comparison, setComparison] = useState({ fromVersionId: "", toVersionId: "" });

  useEffect(() => {
    if (!versions.length) {
      setComparison({ fromVersionId: "", toVersionId: "" });
      return;
    }
    setComparison((current) => {
      const ids = new Set(versions.map((item) => item.skillVersionId));
      const toVersionId = ids.has(current.toVersionId) ? current.toVersionId : versions[0].skillVersionId;
      const fallbackFrom = versions.find((item) => item.skillVersionId !== toVersionId)?.skillVersionId || "";
      const fromVersionId = ids.has(current.fromVersionId) && current.fromVersionId !== toVersionId
        ? current.fromVersionId
        : fallbackFrom;
      return current.fromVersionId === fromVersionId && current.toVersionId === toVersionId
        ? current
        : { fromVersionId, toVersionId };
    });
  }, [versions.map((item) => item.skillVersionId).join("|")]);

  const diffQuery = useSkillVersionDiffQuery(
    skillId,
    comparison.fromVersionId,
    comparison.toVersionId,
    versions.length > 1,
  );
  const usage = usageQuery.data?.data || null;
  const diff = diffQuery.data?.data || null;
  const lifecycle = skill.canonical?.skill?.lifecycle;
  const canCreateUpdate = Boolean(version && !draft && lifecycle !== "deprecated" && skill.canCreateUpdate);

  function localizedDate(value) {
    if (!value) return t("skillLifecycle.notAvailable");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(workspace.locale === "zh" ? "zh-CN" : "en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function comparisonLabel(entry) {
    if (workspace.locale === "en" && entry.summary) return entry.summary;
    return entry.changed ? t("skillLifecycle.diffChanged") : t("skillLifecycle.diffUnchanged");
  }

  return (
    <div className="skillLifecycleBody">
      <Section
        title={t("skillLifecycle.versionHistory")}
        caption={t("skillLifecycle.versionHistoryCaption")}
        actions={(
          <div className="sectionActionRow">
            {draft ? (
              <Button variant="secondary" onClick={() => workspace.openSkill(skillId, "skill-editor")}>
                {t("actions.continueEditing")}
              </Button>
            ) : canCreateUpdate ? (
              <Button
                variant="primary"
                onClick={() => workspace.openSkillUpdateDialog(skill)}
                data-testid="loopops.skill-versions.create-update"
              >
                {t("actions.createSkillUpdate")}
              </Button>
            ) : null}
            {skill.canRetire ? (
              <Button variant="plain" onClick={() => workspace.openRetireSkillDialog(skill)}>
                {t("actions.stopUsingSkill")}
              </Button>
            ) : null}
          </div>
        )}
      >
        {versionsQuery.isLoading ? <p className="muted">{t("skillLifecycle.loadingVersions")}</p> : null}
        {versionsQuery.error ? (
          <div className="inlineRecovery" role="alert">
            <span>{t("skillLifecycle.versionLoadFailed")}</span>
            <Button variant="secondary" onClick={() => versionsQuery.refetch()}>{t("actions.retry")}</Button>
          </div>
        ) : null}
        <ol className="versionTimeline" data-testid="loopops.skill-versions.timeline">
          {draft ? (
            <li data-testid="loopops.skill-versions.current-draft">
              <Pencil size={16} />
              <span><strong>{t("skillLifecycle.currentDraft")}</strong><small>{t("skillLifecycle.draftRevision", { revision: draft.revision })}</small></span>
              <StatusPill tone="info">{t("skillLifecycle.draft")}</StatusPill>
            </li>
          ) : null}
          {versions.map((item, index) => (
            <li key={item.skillVersionId} data-testid={`loopops.skill-version.${item.skillVersionId}`} data-version={item.version}>
              <History size={16} />
              <span>
                <strong>{item.version}</strong>
                <small>{t("skillLifecycle.publishedAt", { date: localizedDate(item.publishedAt) })}</small>
              </span>
              <StatusPill tone={index === 0 ? "success" : "neutral"}>
                {index === 0 ? t("skillLifecycle.currentPublished") : t("skillLifecycle.published")}
              </StatusPill>
            </li>
          ))}
        </ol>
        {!versionsQuery.isLoading && !versionsQuery.error && !draft && !versions.length ? (
          <p className="muted">{t("skillLifecycle.noVersionHistory")}</p>
        ) : null}
      </Section>

      <Section title={t("skillLifecycle.compareVersions")} caption={t("skillLifecycle.compareVersionsCaption")}>
        {versions.length > 1 ? (
          <>
            <div className="versionCompareControls">
              <label>
                <span>{t("skillLifecycle.earlierVersion")}</span>
                <select
                  value={comparison.fromVersionId}
                  onChange={(event) => setComparison((current) => ({ ...current, fromVersionId: event.target.value }))}
                  data-testid="loopops.skill-versions.compare-from"
                >
                  {versions.filter((item) => item.skillVersionId !== comparison.toVersionId).map((item) => (
                    <option value={item.skillVersionId} key={item.skillVersionId}>{item.version}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("skillLifecycle.newerVersion")}</span>
                <select
                  value={comparison.toVersionId}
                  onChange={(event) => setComparison((current) => ({ ...current, toVersionId: event.target.value }))}
                  data-testid="loopops.skill-versions.compare-to"
                >
                  {versions.filter((item) => item.skillVersionId !== comparison.fromVersionId).map((item) => (
                    <option value={item.skillVersionId} key={item.skillVersionId}>{item.version}</option>
                  ))}
                </select>
              </label>
            </div>
            {diffQuery.isFetching ? <p className="muted">{t("skillLifecycle.loadingComparison")}</p> : null}
            {diffQuery.error ? (
              <div className="inlineRecovery" role="alert">
                <span>{t("skillLifecycle.comparisonFailed")}</span>
                <Button variant="secondary" onClick={() => diffQuery.refetch()}>{t("actions.retry")}</Button>
              </div>
            ) : null}
            {diff ? (
              <ul className="versionDiffList" data-testid="loopops.skill-versions.diff">
                {diff.entries.map((entry) => (
                  <li key={entry.field} className={entry.changed ? "changed" : "unchanged"} data-testid={`loopops.skill-versions.diff.${entry.field}`} data-changed={entry.changed ? "true" : "false"}>
                    <span>
                      <strong>{t(`skills.diff.${entry.field}`)}</strong>
                      <small>{comparisonLabel(entry)}</small>
                    </span>
                    <StatusPill tone={entry.changed ? (entry.severity === "warning" ? "warning" : "info") : "neutral"}>
                      {entry.changed ? t("skillLifecycle.changed") : t("skillLifecycle.unchanged")}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : <p className="muted">{t("skillLifecycle.compareNeedsTwoVersions")}</p>}
      </Section>

      <div data-testid="loopops.skill-versions.usage-impact">
        <Section title={t("skillLifecycle.usageImpact")} caption={t("skillLifecycle.usageImpactCaption")}>
          {usageQuery.isLoading ? <p className="muted">{t("skillLifecycle.loadingUsage")}</p> : null}
          {usageQuery.error ? (
            <div className="inlineRecovery" role="alert">
              <span>{t("skillLifecycle.usageLoadFailed")}</span>
              <Button variant="secondary" onClick={() => usageQuery.refetch()}>{t("actions.retry")}</Button>
            </div>
          ) : null}
          {usage?.affectedWorkflows?.length ? (
            <ul className="usageImpactList" data-testid="loopops.skill-versions.usage">
              {usage.affectedWorkflows.map((workflow) => (
                <li key={workflow.workflowId} data-testid={`loopops.skill-versions.usage.${workflow.workflowId}`}>
                  <span><strong>{workflow.name}</strong><small>{t("skillLifecycle.workflowKeepsVersion")}</small></span>
                  <Button
                    variant="secondary"
                    disabled={!usage.latestVersionId || workspace.readOnlyWorkspace}
                    onClick={() => workspace.openLoopSkillUpdate(workflow.workflowId, usage.latestVersionId)}
                    data-testid={`loopops.skill-versions.review-update.${workflow.workflowId}`}
                  >
                    {t("actions.reviewUpdate")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : !usageQuery.isLoading && !usageQuery.error ? <p className="muted" data-testid="loopops.skill-versions.usage-empty">{t("skillLifecycle.noUsageImpact")}</p> : null}
        </Section>
      </div>
    </div>
  );
}
