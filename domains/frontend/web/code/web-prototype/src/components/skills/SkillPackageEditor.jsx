import { useEffect, useMemo, useState } from "react";
import { FileCode2, RefreshCw, Save, ShieldCheck } from "lucide-react";

import { useSkillDraftPackageQuery } from "../../api/queries.js";
import { Button } from "../shared/Button.jsx";
import { Section } from "../shared/Section.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

function runtimeFromFiles(files = []) {
  const source = files.find((file) => file.path === "skill.runtime.json")?.content;
  try {
    const runtime = JSON.parse(source || "{}");
    return typeof runtime.runtime === "string"
      && typeof runtime.entrypoint === "string"
      && runtime.entrypoint.length > 0
      ? runtime
      : null;
  } catch {
    return null;
  }
}

function packagePaths(files = []) {
  return files.map((file) => file.path);
}

function fileKind(file) {
  if (file.kind) return file.kind;
  if (file.path === "SKILL.md") return "instructions";
  if (file.path === "skill.runtime.json") return "runtime_manifest";
  if (file.path.startsWith("scripts/")) return "executable";
  return "other";
}

function normalizeFiles(files = []) {
  return files.map((file) => ({
    path: file.path,
    kind: fileKind(file),
    content: file.content || "",
  }));
}

function hasRequiredFrontmatter(content) {
  if (!content.startsWith("---\n")) return false;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return false;
  const frontmatter = content.slice(4, end);
  return /^name:\s*\S+/m.test(frontmatter) && /^description:\s*\S+/m.test(frontmatter);
}

function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

function packagePayload(files, draft) {
  return {
    filename: `${draft.name || "skill"}.skill-package`,
    sizeBytes: files.reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0),
    files: files.map((file) => ({ path: file.path, contentBase64: base64(file.content) })),
    permissionAcknowledged: true,
  };
}

export function SkillPackageEditor({ workspace, draft, mode }) {
  const t = workspace.t;
  const packageQuery = useSkillDraftPackageQuery(draft?.skillId, draft?.skillDraftId, Boolean(draft));
  const [files, setFiles] = useState([]);
  const [baseline, setBaseline] = useState([]);
  const [selectedPath, setSelectedPath] = useState(mode === "instructions" ? "SKILL.md" : "");
  const [permissionAcknowledged, setPermissionAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [conflictReview, setConflictReview] = useState(null);
  const [conflictLoading, setConflictLoading] = useState(false);
  const [mergeChoices, setMergeChoices] = useState({});
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);

  const serverFiles = useMemo(() => {
    return normalizeFiles(packageQuery.data?.data?.files || []);
  }, [packageQuery.data?.data?.revision, draft?.skillDraftId, draft?.revision]);

  useEffect(() => {
    setFiles(serverFiles);
    setBaseline(serverFiles);
    setPermissionAcknowledged(false);
    setConflict(null);
    setConflictReview(null);
    setMergeChoices({});
    setConfirmReload(false);
  }, [serverFiles]);

  useEffect(() => {
    const runtime = runtimeFromFiles(serverFiles);
    setSelectedPath(mode === "instructions"
      ? "SKILL.md"
      : runtime?.entrypoint || serverFiles.find((file) => file.path !== "SKILL.md")?.path || "SKILL.md");
  }, [mode, serverFiles]);

  if (!draft) {
    const skill = workspace.selectedManagedSkill;
    const canCreateUpdate = Boolean(
      skill?.canonical?.version
      && skill?.canonical?.skill?.lifecycle !== "deprecated"
      && skill?.canCreateUpdate,
    );
    return (
      <Section title={t("skillLifecycle.noDraftTitle")}>
        <p>{t("skillPackage.createUpdateToEdit")}</p>
        <Button
          variant="primary"
          disabled={!canCreateUpdate}
          onClick={() => workspace.openSkillUpdateDialog(skill)}
          data-testid="loopops.skill.package.create-update"
        >
          {t("actions.createSkillUpdate")}
        </Button>
      </Section>
    );
  }

  if (packageQuery.isLoading) {
    return <Section title={t("skillPackage.loadingTitle")}><p className="muted">{t("state.loading")}</p></Section>;
  }

  if (packageQuery.isError) {
    return (
      <Section title={t("skillPackage.loadFailedTitle")}>
        <p>{t("skillPackage.loadFailedBody")}</p>
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => packageQuery.refetch()}>
          {t("actions.retry")}
        </Button>
      </Section>
    );
  }

  const selected = files.find((file) => file.path === selectedPath) || files[0];
  const instruction = files.find((file) => file.path === "SKILL.md")?.content || "";
  const requiredFiles = packagePaths(files);
  const runtimeManifestFile = files.find((file) => file.path === "skill.runtime.json");
  const runtime = runtimeFromFiles(files);
  const script = runtime ? files.find((file) => file.path === runtime.entrypoint)?.content || "" : "";
  const dirty = JSON.stringify(files) !== JSON.stringify(baseline);
  const validRuntime = !runtimeManifestFile || Boolean(runtime && script.trim());
  const valid = hasRequiredFrontmatter(instruction) && validRuntime;

  function updateSelected(content) {
    setFiles((current) => current.map((file) => file.path === selected.path ? { ...file, content } : file));
  }

  async function save() {
    if (!dirty || !valid || !permissionAcknowledged || saving) return;
    setSaving(true);
    try {
      const result = await workspace.saveSelectedSkillPackage(packagePayload(files, draft));
      if (result?.conflict) {
        setConflict(result);
        setConflictReview(null);
        setConfirmReload(false);
      } else if (result) {
        setBaseline(files);
        setPermissionAcknowledged(false);
        await packageQuery.refetch();
      }
    } finally {
      setSaving(false);
    }
  }

  async function reviewConflict() {
    if (conflictLoading) return;
    setConflictLoading(true);
    try {
      const snapshot = await workspace.loadLatestSkillPackageForConflict();
      if (!snapshot?.etag) return;
      const latestFiles = normalizeFiles(snapshot.package?.files || []);
      const comparisonPaths = [...new Set([...packagePaths(files), ...packagePaths(latestFiles)])];
      setConflictReview({ ...snapshot, files: latestFiles });
      setMergeChoices(Object.fromEntries(comparisonPaths.map((path) => [path, "local"])));
      setConfirmReload(false);
    } finally {
      setConflictLoading(false);
    }
  }

  async function saveConflictSelection() {
    if (!conflictReview?.etag || saving || !permissionAcknowledged) return;
    const comparisonPaths = [...new Set([...packagePaths(files), ...packagePaths(conflictReview.files)])];
    const mergedFiles = comparisonPaths.map((path) => {
      const localFile = files.find((file) => file.path === path);
      const latestFile = conflictReview.files.find((file) => file.path === path);
      return mergeChoices[path] === "latest" ? (latestFile || localFile) : (localFile || latestFile);
    }).filter(Boolean);
    setSaving(true);
    try {
      const result = await workspace.saveSelectedSkillPackage(
        packagePayload(mergedFiles, draft),
        null,
        conflictReview.etag,
      );
      if (result?.conflict) {
        setConflict(result);
        setConflictReview(null);
        setMergeChoices({});
      } else if (result) {
        setFiles(mergedFiles);
        setBaseline(mergedFiles);
        setPermissionAcknowledged(false);
        setConflict(null);
        setConflictReview(null);
        setMergeChoices({});
        await packageQuery.refetch();
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (reloading) return;
    setReloading(true);
    try {
      await workspace.reloadSelectedSkillDraft();
      await packageQuery.refetch();
      setConflict(null);
      setConflictReview(null);
      setMergeChoices({});
    } finally {
      setReloading(false);
    }
  }

  return (
    <div className="skillLifecycleBody skillPackageEditor" data-testid={`loopops.skill.package.${mode}`}>
      {conflict ? (
        <div className="inlineRecovery skillPackageConflict" role="alert" data-testid="loopops.skill.package.conflict">
          <span>
            <strong>{t(confirmReload ? "skillPackage.discardTitle" : "skillPackage.conflictTitle")}</strong>
            <small>{t(confirmReload ? "skillPackage.discardBody" : "skillPackage.conflictBody")}</small>
          </span>
          <div className="sectionActionRow">
            {confirmReload ? (
              <Button variant="secondary" disabled={reloading} onClick={() => setConfirmReload(false)}>
                {t("actions.cancel")}
              </Button>
            ) : null}
            {!confirmReload ? (
              <Button
                variant="secondary"
                disabled={conflictLoading || reloading}
                onClick={reviewConflict}
                data-testid="loopops.skill.package.conflict.compare"
              >
                {conflictLoading ? t("state.loading") : t("skillPackage.compareChanges")}
              </Button>
            ) : null}
            <Button
              variant={confirmReload ? "destructive" : "secondary"}
              icon={<RefreshCw size={15} />}
              disabled={reloading}
              onClick={confirmReload ? reloadLatest : () => setConfirmReload(true)}
              data-testid="loopops.skill.package.conflict.reload"
            >
              {reloading ? t("state.loading") : t(confirmReload ? "skillPackage.discardAndReload" : "skillPackage.reviewConflict")}
            </Button>
          </div>
        </div>
      ) : null}
      {conflictReview ? (
        <section className="skillPackageConflictReview" aria-labelledby="skill-package-conflict-title" data-testid="loopops.skill.package.conflict.comparison">
          <header>
            <div>
              <strong id="skill-package-conflict-title">{t("skillPackage.comparisonTitle")}</strong>
              <p>{t("skillPackage.comparisonBody")}</p>
            </div>
          </header>
          <div className="skillPackageConflictFiles">
            {[...new Set([...requiredFiles, ...packagePaths(conflictReview.files)])].map((path) => {
              const localFile = files.find((file) => file.path === path);
              const latestFile = conflictReview.files.find((file) => file.path === path);
              const changed = (localFile?.content || "") !== (latestFile?.content || "");
              return (
                <article key={path}>
                  <div className="skillPackageConflictFileHeader">
                    <span><FileCode2 size={15} /><strong>{path}</strong></span>
                    <StatusPill tone={changed ? "warning" : "neutral"}>{t(changed ? "skillPackage.fileChanged" : "skillPackage.fileUnchanged")}</StatusPill>
                  </div>
                  <div className="skillPackageConflictChoice" role="radiogroup" aria-label={path}>
                    <label>
                      <input
                        type="radio"
                        name={`conflict-${path}`}
                        value="local"
                        checked={mergeChoices[path] !== "latest"}
                        onChange={() => setMergeChoices((current) => ({ ...current, [path]: "local" }))}
                      />
                      <span>{t("skillPackage.keepMine")}</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`conflict-${path}`}
                        value="latest"
                        checked={mergeChoices[path] === "latest"}
                        onChange={() => setMergeChoices((current) => ({ ...current, [path]: "latest" }))}
                      />
                      <span>{t("skillPackage.useLatest")}</span>
                    </label>
                  </div>
                  <div className="skillPackageConflictColumns">
                    <label>
                      <span>{t("skillPackage.yourChanges")}</span>
                      <textarea readOnly value={localFile?.content || ""} rows={9} />
                    </label>
                    <label>
                      <span>{t("skillPackage.latestDraft")}</span>
                      <textarea readOnly value={latestFile?.content || ""} rows={9} />
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
          <footer className="sectionActionRow">
            <Button variant="secondary" onClick={() => setConflictReview(null)}>
              {t("skillPackage.closeComparison")}
            </Button>
            <Button
              variant="primary"
              disabled={saving || !permissionAcknowledged}
              onClick={saveConflictSelection}
              data-testid="loopops.skill.package.conflict.merge"
            >
              {saving ? t("skillPackage.savingMerged") : t("skillPackage.saveMerged")}
            </Button>
          </footer>
        </section>
      ) : null}
      <Section
        title={t(mode === "instructions" ? "skillPackage.instructionsTitle" : "skillPackage.filesTitle")}
        caption={t(mode === "instructions" ? "skillPackage.instructionsCaption" : "skillPackage.filesCaption")}
        actions={<StatusPill tone={dirty ? "warning" : "success"}>{dirty ? t("state.unsavedChanges") : t("state.saved")}</StatusPill>}
      >
        <div className={`skillPackageWorkspace ${mode === "instructions" ? "instructionsOnly" : ""}`}>
          {mode === "files" ? (
            <nav className="skillPackageFileRail" aria-label={t("skillPackage.fileNavigation")}>
              {files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  className={selected?.path === file.path ? "active" : ""}
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                >
                  <FileCode2 size={15} />
                  <span><strong>{file.path}</strong><small>{t(`skillPackage.kind.${file.kind}`)}</small></span>
                </button>
              ))}
            </nav>
          ) : null}
          <label className="skillCodeEditor">
            <span>{mode === "instructions" ? t("skillPackage.instructionsLabel") : selected?.path}</span>
            <textarea
              value={mode === "instructions" ? instruction : selected?.content || ""}
              onChange={(event) => {
                if (mode === "instructions") {
                  setFiles((current) => current.map((file) => file.path === "SKILL.md" ? { ...file, content: event.target.value } : file));
                } else {
                  updateSelected(event.target.value);
                }
              }}
              rows={mode === "instructions" ? 20 : 22}
              spellCheck={mode === "instructions"}
              aria-describedby="skill-package-editor-help"
              data-testid={`loopops.skill.package.${mode}.editor`}
            />
          </label>
        </div>
        <div id="skill-package-editor-help" className="skillPackageHelp">
          {!hasRequiredFrontmatter(instruction) ? <p className="formError">{t("skillPackage.frontmatterMissing")}</p> : null}
          {runtimeManifestFile && (!runtime || !script.trim()) ? <p className="formError">{t("skillPackage.scriptMissing")}</p> : null}
          <p className="muted">{t("skillPackage.fixedPackageNote")}</p>
        </div>
      </Section>

      <Section title={t("skillPackage.saveReviewTitle")} caption={t("skillPackage.saveReviewCaption")}>
        <label className="permissionAcknowledgement">
          <input
            type="checkbox"
            checked={permissionAcknowledged}
            onChange={(event) => setPermissionAcknowledged(event.target.checked)}
            data-testid="loopops.skill.package.acknowledge"
          />
          <span>
            <strong>{t("skillPackage.permissionAcknowledgement")}</strong>
            <small>{t("skillPackage.permissionSummary")}</small>
          </span>
        </label>
        <div className="skillPackageSaveRow">
          <span>{t("skillPackage.saveEffect")}</span>
          <Button
            variant="primary"
            icon={permissionAcknowledged ? <Save size={15} /> : <ShieldCheck size={15} />}
            disabled={!dirty || !valid || !permissionAcknowledged || saving || Boolean(conflict)}
            onClick={save}
            data-testid="loopops.skill.package.save"
          >
            {saving ? t("actions.saving") : t("skillPackage.saveAction")}
          </Button>
        </div>
      </Section>
    </div>
  );
}
