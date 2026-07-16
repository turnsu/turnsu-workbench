import { useEffect, useMemo, useState } from "react";
import {
  Cable,
  CheckCircle2,
  FileJson2,
  FileText,
  Library,
  Upload,
} from "lucide-react";

import { Button, Dialog } from "../../design-system/index.jsx";
import { ConnectionRebindingSheet } from "../connections/ConnectionRebindingSheet.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";

const initialProgress = { phase: "idle", percent: 0, receivedBytes: 0, totalBytes: 0 };

function productError(t, error) {
  const key = `error.${error?.code || "unknown"}`;
  const translated = t(key);
  return translated === key ? t("loopTransfer.genericError") : translated;
}

function isReadyConnection(connection) {
  return connection?.status === "connected" && connection?.validation?.status === "valid";
}

function optionIndex(items, selectedId, getId) {
  const index = items.findIndex((item) => getId(item) === selectedId);
  return index < 0 ? "" : String(index);
}

function bytesLabel(bytes, t) {
  if (!Number.isFinite(bytes) || bytes <= 0) return t("loopTransfer.sizeUnknown");
  if (bytes < 1024) return t("loopTransfer.bytes", { count: bytes });
  return t("loopTransfer.kilobytes", { count: Math.ceil(bytes / 1024) });
}

export function LoopImportDialog({ workspace }) {
  const t = workspace.t;
  const open = workspace.loopImportDialogOpen;
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(initialProgress);
  const [inspected, setInspected] = useState(null);
  const [options, setOptions] = useState(null);
  const [mappings, setMappings] = useState({ skills: {}, materials: {}, connections: {} });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [connectionRequirement, setConnectionRequirement] = useState(null);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setProgress(initialProgress);
    setInspected(null);
    setOptions(null);
    setMappings({ skills: {}, materials: {}, connections: {} });
    setBusy("");
    setError(null);
    setConnectionRequirement(null);
  }, [open]);

  const portableLoop = inspected?.loopImport?.portableLoop || null;
  const requirements = portableLoop?.requirements || { skills: [], materials: [], connections: [] };
  const embeddedByRef = useMemo(() => Object.fromEntries(
    (portableLoop?.embeddedMaterials || []).map((material) => [material.materialRef, material]),
  ), [portableLoop]);

  function materialCandidates(requirement) {
    return (options?.resources || []).filter((resource) => (
      requirement.acceptedMediaTypes.includes(resource.mediaType)
      && (!requirement.contentHash || resource.contentHash === requirement.contentHash)
      && resource.readiness?.status === "ready"
    ));
  }

  function connectionCandidates(requirement) {
    return (options?.connections || []).filter((connection) => (
      connection.capabilityKey === requirement.capabilityKey && isReadyConnection(connection)
    ));
  }

  function initializeMappings(nextLoop, nextOptions) {
    const next = { skills: {}, materials: {}, connections: {} };
    for (const requirement of nextLoop.requirements.skills) {
      const candidates = nextOptions.skillsByRef[requirement.ref] || [];
      if (candidates.length === 1) next.skills[requirement.ref] = candidates[0].skillVersionId;
    }
    for (const requirement of nextLoop.requirements.materials) {
      const embedded = (nextLoop.embeddedMaterials || []).find((item) => item.materialRef === requirement.ref);
      const candidates = nextOptions.resources.filter((resource) => (
        requirement.acceptedMediaTypes.includes(resource.mediaType)
        && (!requirement.contentHash || resource.contentHash === requirement.contentHash)
        && resource.readiness?.status === "ready"
      ));
      if (embedded) {
        next.materials[requirement.ref] = { kind: "embeddedMaterial", contentHash: embedded.contentHash };
      } else if (candidates.length === 1) {
        next.materials[requirement.ref] = { kind: "workspaceMaterial", resourceId: candidates[0].resourceId };
      }
    }
    for (const requirement of nextLoop.requirements.connections) {
      const candidates = nextOptions.connections.filter((connection) => (
        connection.capabilityKey === requirement.capabilityKey && isReadyConnection(connection)
      ));
      if (candidates.length === 1) next.connections[requirement.ref] = candidates[0].connectionId;
    }
    setMappings(next);
  }

  async function checkFile() {
    if (!file || busy) return;
    setBusy("checking");
    setError(null);
    const result = await workspace.inspectPortableLoop(file, setProgress);
    if (result?.failed) {
      setError(result.error);
      setBusy("");
      return;
    }
    setInspected(result);
    const loaded = await workspace.loadPortableLoopOptions(result.loopImport.portableLoop);
    if (loaded?.failed) {
      setError(loaded.error);
      setBusy("");
      return;
    }
    setOptions(loaded);
    initializeMappings(result.loopImport.portableLoop, loaded);
    setBusy("");
  }

  async function reloadOptions() {
    if (!portableLoop || busy) return;
    setBusy("loading-options");
    setError(null);
    const loaded = await workspace.loadPortableLoopOptions(portableLoop);
    if (loaded?.failed) setError(loaded.error);
    else {
      setOptions(loaded);
      initializeMappings(portableLoop, loaded);
    }
    setBusy("");
  }

  const missing = portableLoop ? [
    ...requirements.skills.filter((item) => !mappings.skills[item.ref]),
    ...requirements.materials.filter((item) => !mappings.materials[item.ref]),
    ...requirements.connections.filter((item) => !mappings.connections[item.ref]),
  ] : [];
  const alreadyCommitted = inspected?.loopImport?.status === "committed";

  async function commit() {
    if (!inspected || missing.length || busy) return;
    setBusy("committing");
    setError(null);
    const result = await workspace.commitPortableLoopImport(inspected, {
      skillMappings: requirements.skills.map((requirement) => ({
        requirementRef: requirement.ref,
        skillVersionId: mappings.skills[requirement.ref],
      })),
      materialMappings: requirements.materials.map((requirement) => ({
        requirementRef: requirement.ref,
        resolution: mappings.materials[requirement.ref],
      })),
      connectionMappings: requirements.connections.map((requirement) => ({
        requirementRef: requirement.ref,
        connectionId: mappings.connections[requirement.ref],
      })),
    });
    if (result?.failed) {
      setError(result.error);
      setBusy("");
    }
  }

  async function refreshImport() {
    if (!inspected?.loopImport?.importId || busy) return;
    setBusy("refreshing");
    const refreshed = await workspace.refreshPortableLoopImport(inspected.loopImport.importId);
    if (refreshed?.failed) setError(refreshed.error);
    else {
      setInspected(refreshed);
      setError(refreshed.loopImport.status === "committed" ? { code: "loop_import_already_committed" } : null);
    }
    setBusy("");
  }

  function chooseAnotherFile() {
    setFile(null);
    setInspected(null);
    setOptions(null);
    setMappings({ skills: {}, materials: {}, connections: {} });
    setProgress(initialProgress);
    setError(null);
  }

  const actions = portableLoop ? (
    <>
      <Button variant="secondary" disabled={Boolean(busy)} onClick={chooseAnotherFile}>{t("loopTransfer.chooseAnother")}</Button>
      <Button
        variant="primary"
        icon={<CheckCircle2 size={15} />}
        disabled={Boolean(busy) || missing.length > 0 || alreadyCommitted}
        title={missing.length ? t("loopTransfer.resolveBeforeImport", { count: missing.length }) : alreadyCommitted ? t("error.loop_import_already_committed") : undefined}
        onClick={commit}
        data-testid="loopops.loop-import.commit"
      >
        {busy === "committing" ? t("loopTransfer.creatingDraft") : t("loopTransfer.createDraft")}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" disabled={Boolean(busy)} onClick={workspace.closeLoopImportDialog}>{t("actions.cancel")}</Button>
      <Button
        variant="primary"
        icon={<Upload size={15} />}
        disabled={!file || Boolean(busy)}
        onClick={checkFile}
        data-testid="loopops.loop-import.check"
      >
        {busy ? t("loopTransfer.checking") : t("loopTransfer.checkFile")}
      </Button>
    </>
  );

  return (
    <>
      <Dialog
        open={open && !connectionRequirement}
        title={t("loopTransfer.importTitle")}
        onClose={busy ? undefined : workspace.closeLoopImportDialog}
        returnFocusSelector='[data-testid="loopops.loops.upload"]'
        actions={actions}
      >
        <div className="loopImportFlow" data-testid="loopops.loop-import.dialog">
          {!portableLoop ? (
            <>
              <p className="loopImportIntro">{t("loopTransfer.importIntro")}</p>
              <label className={`loopFilePicker ${file ? "hasFile" : ""}`}>
                <FileJson2 size={22} aria-hidden="true" />
                <span>
                  <strong>{file?.name || t("loopTransfer.chooseFile")}</strong>
                  <small>{file ? bytesLabel(file.size, t) : t("loopTransfer.fileHelp")}</small>
                </span>
                <input
                  type="file"
                  accept=".loop.json,application/json,application/vnd.looloomi.loop-package+json"
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null);
                    setError(null);
                  }}
                  data-testid="loopops.loop-import.file"
                />
              </label>
              {busy ? (
                <div className="loopTransferProgress" role="status" aria-live="polite">
                  <span>{t(`loopTransfer.phase.${progress.phase}`)}</span>
                  <progress max="100" value={Math.max(4, Math.round(progress.percent || 0))} />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <header className="loopImportSummary">
                <div><FileText size={18} /><span><strong>{portableLoop.name}</strong><small>{portableLoop.description || t("loopTransfer.noDescription")}</small></span></div>
                <StatusPill tone={missing.length ? "warning" : "success"}>{missing.length ? t("loopTransfer.needsSetup", { count: missing.length }) : t("loopTransfer.readyToCreate")}</StatusPill>
              </header>
              <dl className="loopImportFacts">
                <div><dt>{t("loopTransfer.steps")}</dt><dd>{portableLoop.graph.nodes.length}</dd></div>
                <div><dt>{t("loopTransfer.skills")}</dt><dd>{requirements.skills.length}</dd></div>
                <div><dt>{t("loopTransfer.materials")}</dt><dd>{requirements.materials.length}</dd></div>
                <div><dt>{t("loopTransfer.connections")}</dt><dd>{requirements.connections.length}</dd></div>
              </dl>

              <section className="loopImportRequirements" aria-labelledby="loop-import-skills">
                <div className="loopImportSectionTitle"><Library size={16} /><div><h3 id="loop-import-skills">{t("loopTransfer.skillMappings")}</h3><p>{t("loopTransfer.skillMappingsHelp")}</p></div></div>
                {requirements.skills.length ? requirements.skills.map((requirement) => {
                  const candidates = options?.skillsByRef?.[requirement.ref] || [];
                  const value = optionIndex(candidates, mappings.skills[requirement.ref], (item) => item.skillVersionId);
                  return (
                    <div className="loopImportRequirementRow" key={requirement.ref}>
                      <div><strong>{candidates[0]?.name || t("loopTransfer.requiredSkill")}</strong><small>{t("loopTransfer.versionLabel", { version: requirement.version })}</small></div>
                      {candidates.length ? (
                        <label><span>{t("loopTransfer.chooseSkill")}</span><select value={value} onChange={(event) => {
                          const selected = event.target.value === "" ? null : candidates[Number(event.target.value)];
                          setMappings((current) => ({ ...current, skills: { ...current.skills, [requirement.ref]: selected?.skillVersionId || "" } }));
                        }}><option value="">{t("loopTransfer.chooseSkillPlaceholder")}</option>{candidates.map((candidate, index) => <option key={candidate.skillVersionId} value={index}>{candidate.name} {candidate.version}</option>)}</select></label>
                      ) : <Button variant="secondary" onClick={() => { workspace.closeLoopImportDialog(); workspace.setActivePage("skills"); }}>{t("loopTransfer.openSkills")}</Button>}
                    </div>
                  );
                }) : <p className="loopImportNone">{t("loopTransfer.noSkillsNeeded")}</p>}
              </section>

              <section className="loopImportRequirements" aria-labelledby="loop-import-materials">
                <div className="loopImportSectionTitle"><FileText size={16} /><div><h3 id="loop-import-materials">{t("loopTransfer.materialMappings")}</h3><p>{t("loopTransfer.materialMappingsHelp")}</p></div></div>
                {requirements.materials.length ? requirements.materials.map((requirement) => {
                  const embedded = embeddedByRef[requirement.ref];
                  const candidates = materialCandidates(requirement);
                  const selected = mappings.materials[requirement.ref];
                  const values = [
                    ...(embedded ? [{ kind: "embeddedMaterial", contentHash: embedded.contentHash, label: t("loopTransfer.useIncludedMaterial") }] : []),
                    ...candidates.map((resource) => ({ kind: "workspaceMaterial", resourceId: resource.resourceId, label: resource.label })),
                  ];
                  const value = optionIndex(values, selected?.contentHash || selected?.resourceId, (item) => item.contentHash || item.resourceId);
                  return (
                    <div className="loopImportRequirementRow" key={requirement.ref}>
                      <div><strong>{requirement.label}</strong><small>{requirement.description || t("loopTransfer.materialNeeded")}</small></div>
                      {values.length ? (
                        <label><span>{t("loopTransfer.chooseMaterial")}</span><select value={value} onChange={(event) => {
                          const chosen = event.target.value === "" ? null : values[Number(event.target.value)];
                          setMappings((current) => ({ ...current, materials: { ...current.materials, [requirement.ref]: chosen ? { ...(chosen.kind === "embeddedMaterial" ? { kind: chosen.kind, contentHash: chosen.contentHash } : { kind: chosen.kind, resourceId: chosen.resourceId }) } : null } }));
                        }}><option value="">{t("loopTransfer.chooseMaterialPlaceholder")}</option>{values.map((item, index) => <option key={`${item.kind}-${index}`} value={index}>{item.label}</option>)}</select></label>
                      ) : <Button variant="secondary" onClick={() => { workspace.closeLoopImportDialog(); workspace.openCreateResourceDialog(); }}>{t("loopTransfer.addMaterial")}</Button>}
                    </div>
                  );
                }) : <p className="loopImportNone">{t("loopTransfer.noMaterialsNeeded")}</p>}
              </section>

              <section className="loopImportRequirements" aria-labelledby="loop-import-connections">
                <div className="loopImportSectionTitle"><Cable size={16} /><div><h3 id="loop-import-connections">{t("loopTransfer.connectionMappings")}</h3><p>{t("loopTransfer.connectionMappingsHelp")}</p></div></div>
                {requirements.connections.length ? requirements.connections.map((requirement) => {
                  const candidates = connectionCandidates(requirement);
                  const value = optionIndex(candidates, mappings.connections[requirement.ref], (item) => item.connectionId);
                  return (
                    <div className="loopImportRequirementRow" key={requirement.ref}>
                      <div><strong>{requirement.label}</strong><small>{requirement.permissionSummary}</small></div>
                      {candidates.length ? (
                        <label><span>{t("loopTransfer.chooseConnection")}</span><select value={value} onChange={(event) => {
                          const selected = event.target.value === "" ? null : candidates[Number(event.target.value)];
                          setMappings((current) => ({ ...current, connections: { ...current.connections, [requirement.ref]: selected?.connectionId || "" } }));
                        }}><option value="">{t("loopTransfer.chooseConnectionPlaceholder")}</option>{candidates.map((connection, index) => <option key={connection.connectionId} value={index}>{connection.label}</option>)}</select></label>
                      ) : mappings.connections[requirement.ref] ? <StatusPill tone="success">{t("loopTransfer.connectionReady")}</StatusPill> : <Button variant="secondary" onClick={() => setConnectionRequirement(requirement)}>{t("connections.create")}</Button>}
                    </div>
                  );
                }) : <p className="loopImportNone">{t("loopTransfer.noConnectionsNeeded")}</p>}
              </section>
              <p className="loopImportBoundary">{t("loopTransfer.importBoundary")}</p>
            </>
          )}

          {error ? (
            <div className="loopImportError" role="alert">
              <span>{productError(t, error)}</span>
              {error.code === "loop_import_revision_conflict" ? <Button variant="secondary" onClick={refreshImport}>{t("loopTransfer.refreshImport")}</Button> : portableLoop ? <Button variant="secondary" onClick={reloadOptions}>{t("actions.retry")}</Button> : null}
            </div>
          ) : null}
          {portableLoop && missing.length ? <p className="loopImportBlocking" role="status">{t("loopTransfer.resolveBeforeImport", { count: missing.length })}</p> : null}
        </div>
      </Dialog>
      <ConnectionRebindingSheet
        {...{
          open: Boolean(open && connectionRequirement),
          actionLabel: t("loopTransfer.useConnection"),
          requirements: connectionRequirement ? [{ requirementId: connectionRequirement.capabilityKey }] : [],
          submitting: false,
          errorCode: "",
          readOnly: workspace.readOnlyWorkspace,
          onClose: () => setConnectionRequirement(null),
          onRequestAccess: workspace.requestWorkspaceAccess,
          t,
          onSubmit: (bindings) => {
            const connectionId = bindings[0]?.connectionId;
            if (connectionId && connectionRequirement) {
              setMappings((current) => ({ ...current, connections: { ...current.connections, [connectionRequirement.ref]: connectionId } }));
            }
            setConnectionRequirement(null);
          },
        }}
      />
    </>
  );
}
