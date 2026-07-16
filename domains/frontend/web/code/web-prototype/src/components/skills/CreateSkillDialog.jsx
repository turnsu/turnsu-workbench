import { useEffect, useMemo, useState } from "react";
import { FileUp } from "lucide-react";

import { Button, Dialog, SegmentedControl } from "../../design-system/index.jsx";

const initialForm = {
  name: "",
  description: "",
  category: "",
};

const initialRepository = {
  repositoryUrl: "",
  ref: "main",
  skillDirectory: "",
};

async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

function encodeText(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

function skillSlug(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || `workspace-skill-${Date.now()}`;
}

function draftSkillFile(form) {
  const name = skillSlug(form.name);
  const description = form.description.trim().replace(/[\r\n]+/g, " ");
  return `---\nname: ${name}\ndescription: ${description}\ncompatibility: Local only\ndisable-model-invocation: true\n---\n\n# ${form.name.trim()}\n\n${description}\n`;
}

function uploadProgress(upload, fallbackPhase) {
  if (Number.isFinite(upload?.percent)) {
    return {
      ...upload,
      phase: upload.phase || fallbackPhase,
      error: false,
    };
  }
  const totalBytes = Number(upload?.sizeBytes) || 0;
  const receivedBytes = Number(upload?.transfer?.receivedBytes) || 0;
  const complete = upload?.transfer?.complete === true
    || ["ready_draft", "needs_decision", "promoted"].includes(upload?.state);
  const phase = complete
    ? "complete"
    : ["quarantined", "scanning", "parsing"].includes(upload?.state)
      ? "checking"
      : fallbackPhase;
  return {
    phase,
    totalBytes,
    receivedBytes,
    percent: complete ? 100 : totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0,
    error: upload?.state === "failed",
  };
}

export function CreateSkillDialog({ workspace }) {
  const [form, setForm] = useState(initialForm);
  const [files, setFiles] = useState([]);
  const [mode, setMode] = useState(workspace.createSkillDialogMode || "create");
  const [repository, setRepository] = useState(initialRepository);
  const [submitting, setSubmitting] = useState(false);
  const [decisionAcknowledged, setDecisionAcknowledged] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [retryKey, setRetryKey] = useState(null);
  const t = workspace.t;
  const readyToInspect = Boolean(
    form.name.trim()
    && form.description.trim()
    && form.category.trim()
    && (mode === "create" || (mode === "files" ? files.length : repository.repositoryUrl.trim())),
  );
  const inspected = workspace.pendingSkillPackage;
  const needsDecision = inspected?.upload?.state === "needs_decision";
  const fileLabel = useMemo(() => files.map((file) => file.name).join(", "), [files]);

  useEffect(() => {
    if (workspace.createSkillDialogOpen) setMode(workspace.createSkillDialogMode || "create");
  }, [workspace.createSkillDialogMode, workspace.createSkillDialogOpen]);

  function resetLocalState() {
    setForm(initialForm);
    setFiles([]);
    setMode(workspace.createSkillDialogMode || "create");
    setRepository(initialRepository);
    setTransfer(null);
    setRetryKey(null);
    setDecisionAcknowledged(false);
  }

  async function preparePackage(event) {
    event?.preventDefault();
    if (!readyToInspect || submitting || inspected) return;
    setSubmitting(true);
    setTransfer({ phase: mode === "repository" ? "importing" : "preparing", percent: 0, receivedBytes: 0, totalBytes: 0, error: false });
    try {
      const metadata = {
        name: form.name.trim(),
        description: form.description.trim(),
        category: form.category.trim(),
      };
      const onProgress = (progress) => setTransfer(uploadProgress(
        progress,
        mode === "repository" ? "importing" : "uploading",
      ));
      let result;
      if (mode !== "repository") {
        const packageFiles = mode === "create" ? [{
          path: "SKILL.md",
          contentBase64: encodeText(draftSkillFile(form)),
        }] : await Promise.all(files.map(async (file) => ({
          path: file.webkitRelativePath || file.name,
          contentBase64: await encodeFile(file),
        })));
        result = await workspace.inspectSkillPackage({
          ...metadata,
          filename: mode === "create" ? `${skillSlug(form.name)}-draft` : files.length === 1 ? files[0].name : "skill-package",
          sizeBytes: mode === "create" ? draftSkillFile(form).length : files.reduce((total, file) => total + file.size, 0),
          files: packageFiles,
        }, retryKey, onProgress);
      } else {
        result = await workspace.importSkillRepository({
          ...metadata,
          repositoryUrl: repository.repositoryUrl.trim(),
          ref: repository.ref.trim() || "main",
          skillDirectory: repository.skillDirectory.trim(),
        }, retryKey, onProgress);
      }
      if (result?.failed) {
        setRetryKey(result.idempotencyKey);
        setTransfer((current) => ({ ...(current ?? {}), phase: "paused", error: true }));
      } else if (result) {
        setRetryKey(null);
        setTransfer((current) => ({ ...(current ?? {}), phase: "complete", percent: 100, error: false }));
      }
    } catch {
      setTransfer((current) => ({ ...(current ?? {}), phase: "paused", error: true }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={workspace.createSkillDialogOpen}
      title={t("skillCreate.title")}
      initialFocusSelector='[data-testid="loopops.create-skill.name"]'
      returnFocusSelector='[data-testid="loopops.global-create"], [data-testid="loopops.topbar.primary.create-skill"], [data-testid="loopops.skills.create"]'
      onClose={() => {
        resetLocalState();
        workspace.closeCreateSkillDialog();
      }}
      actions={(
        <>
          <Button
            variant="secondary"
            onClick={() => {
              resetLocalState();
              workspace.closeCreateSkillDialog();
            }}
            data-testid="loopops.create-skill.cancel"
          >
            {t("actions.cancel")}
          </Button>
          {inspected ? (
            <Button
              variant="primary"
              onClick={async () => {
                if (needsDecision && !decisionAcknowledged) return;
                setSubmitting(true);
                try {
                  const result = await workspace.createSkillDraftFromPackage({
                    permissionAcknowledged: needsDecision && decisionAcknowledged,
                  });
                  if (result) {
                    resetLocalState();
                  }
                } finally {
                  setSubmitting(false);
                }
              }}
              disabled={submitting || (needsDecision && !decisionAcknowledged)}
              data-testid="loopops.create-skill.create-draft"
            >
              {submitting ? t("skillCreate.creatingDraft") : t("skillCreate.createDraft")}
            </Button>
          ) : (
            <Button variant="primary" type="submit" form="create-skill-form" disabled={!readyToInspect || submitting} data-testid="loopops.create-skill.submit">
              {submitting ? t("skillCreate.preparing") : t("skillCreate.confirm")}
            </Button>
          )}
        </>
      )}
    >
      <form id="create-skill-form" className="createLoopForm skillUploadFlow" onSubmit={preparePackage}>
        <p>{t("skillCreate.intro")}</p>
        <ol className="lifecycleSteps" aria-label={t("skillCreate.progressLabel")}>
          <li className={!inspected ? "active" : "complete"}>{t("skillCreate.stepUpload")}</li>
          <li className={inspected ? "active" : ""}>{t("skillCreate.stepReview")}</li>
          <li>{t("skillCreate.stepTest")}</li>
          <li>{t("skillCreate.stepPublish")}</li>
        </ol>
        {inspected ? (
          <section className="packageReview" data-testid="loopops.create-skill.package-review">
            <div className="packageReviewSummary">
              <strong>{t(needsDecision ? "skillCreate.packageNeedsDecision" : "skillCreate.packageReady")}</strong>
              <span>{t("skillCreate.fileCount", { count: inspected.upload.inspection?.inventory?.length || files.length })}</span>
            </div>
            {inspected.upload.findings?.length ? (
              <ul className="issueList">
                {inspected.upload.findings.map((finding, index) => (
                  <li key={`${finding.code || "finding"}-${index}`}>{finding.message || finding.code}</li>
                ))}
              </ul>
            ) : <p className="muted">{t("skillCreate.noBlockingFindings")}</p>}
            {needsDecision ? (
              <div data-testid="loopops.create-skill.executable-confirmation">
                <p>{t("skillCreate.executableIsolationSummary")}</p>
                <label className="permissionAcknowledgement">
                  <input
                    type="checkbox"
                    checked={decisionAcknowledged}
                    onChange={(event) => setDecisionAcknowledged(event.target.checked)}
                    data-testid="loopops.create-skill.executable-acknowledgement"
                  />
                  <span>
                    <strong>{t("skillCreate.executableAcknowledgement")}</strong>
                    <small>{t("skillCreate.executableAcknowledgementDetail")}</small>
                  </span>
                </label>
              </div>
            ) : null}
            <p className="muted">{t("skillCreate.nextAfterDraft")}</p>
          </section>
        ) : null}
        <fieldset disabled={Boolean(inspected)}>
          <SegmentedControl
            label={t("skillCreate.sourceMode")}
            value={mode}
            onChange={(value) => {
              setMode(value);
              setTransfer(null);
              setRetryKey(null);
            }}
            layout="fill"
            options={[
              { value: "create", label: t("skillCreate.modeCreate"), testId: "loopops.create-skill.mode-create" },
              { value: "files", label: t("skillCreate.modeFiles"), testId: "loopops.create-skill.mode-files" },
              { value: "repository", label: t("skillCreate.modeRepository"), testId: "loopops.create-skill.mode-github" },
            ]}
          />
        <label>
          <span>{t("skillCreate.name")}</span>
          <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} data-testid="loopops.create-skill.name" />
        </label>
        <label>
          <span>{t("skillCreate.description")}</span>
          <textarea rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} data-testid="loopops.create-skill.description" />
        </label>
        <label>
          <span>{t("skillCreate.category")}</span>
          <input value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} data-testid="loopops.create-skill.category" />
        </label>
        {mode === "create" ? (
          <div className="skillCreateBlankNote" data-testid="loopops.create-skill.blank-package">
            <strong>{t("skillCreate.blankPackageTitle")}</strong>
            <small>{t("skillCreate.blankPackageBody")}</small>
          </div>
        ) : mode === "files" ? (
          <label className="skillPackagePicker">
            <span>{t("skillCreate.files")}</span>
            <input
              type="file"
              multiple
              className="visuallyHidden"
              onChange={(event) => {
                setFiles(Array.from(event.target.files || []));
                setTransfer(null);
                setRetryKey(null);
              }}
              data-testid="loopops.create-skill.files"
            />
            <span className="skillPackagePickerAction">
              <FileUp size={17} aria-hidden="true" />
              <span>
                <strong>{t("skillCreate.chooseFiles")}</strong>
                <small>{fileLabel ? t("skillCreate.selectedFiles", { count: files.length }) : t("skillCreate.noFiles")}</small>
              </span>
            </span>
            {fileLabel ? <small className="skillPackagePickerNames" title={fileLabel}>{fileLabel}</small> : <small>{t("skillCreate.filesHint")}</small>}
          </label>
        ) : (
          <div className="repositoryImportFields" data-testid="loopops.create-skill.repository-fields">
            <label>
              <span>{t("skillCreate.repositoryUrl")}</span>
              <input
                type="url"
                value={repository.repositoryUrl}
                placeholder="https://github.com/owner/repository"
                onChange={(event) => setRepository((current) => ({ ...current, repositoryUrl: event.target.value }))}
                data-testid="loopops.create-skill.repository-url"
              />
            </label>
            <div className="repositoryImportOptional">
              <label>
                <span>{t("skillCreate.repositoryRef")}</span>
                <input
                  value={repository.ref}
                  onChange={(event) => setRepository((current) => ({ ...current, ref: event.target.value }))}
                  data-testid="loopops.create-skill.repository-ref"
                />
              </label>
              <label>
                <span>{t("skillCreate.repositoryDirectory")}</span>
                <input
                  value={repository.skillDirectory}
                  placeholder={t("skillCreate.repositoryDirectoryPlaceholder")}
                  onChange={(event) => setRepository((current) => ({ ...current, skillDirectory: event.target.value }))}
                  data-testid="loopops.create-skill.repository-directory"
                />
              </label>
            </div>
            <small>{t("skillCreate.repositoryHint")}</small>
          </div>
        )}
        </fieldset>
        {transfer && !inspected ? (
          <section className={`skillTransferStatus ${transfer.error ? "error" : ""}`} aria-live="polite" data-testid="loopops.create-skill.upload-status">
            <div>
              <strong>{t(`skillCreate.transfer.${transfer.phase || "preparing"}`)}</strong>
              <span>{Math.max(0, Math.min(100, Math.round(transfer.percent || 0)))}%</span>
            </div>
            <progress max="100" value={Math.max(0, Math.min(100, transfer.percent || 0))} data-testid="loopops.create-skill.upload-progress" />
            {transfer.error ? (
              <Button type="button" variant="secondary" onClick={preparePackage} disabled={submitting} data-testid="loopops.create-skill.retry">
                {t("skillCreate.retryTransfer")}
              </Button>
            ) : null}
          </section>
        ) : null}
      </form>
    </Dialog>
  );
}
