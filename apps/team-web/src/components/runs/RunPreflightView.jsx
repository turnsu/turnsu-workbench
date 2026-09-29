import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Database, FileText, GitBranch, Play, ShieldCheck, X } from "lucide-react";

import { useAttachmentMutations } from "../../api/queries.js";
import { Button } from "../shared/Button.jsx";
import { ObjectQueryState } from "../shared/ObjectQueryState.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import {
  acceptsMaterialMediaType,
  materialAcceptAttribute,
  materialFormatSummary,
  materialMediaTypeForFile,
  normalizeMaterialMediaTypes,
} from "../skills/material-formats.js";
import { productFieldLabel, productNodeTitle, productTitle } from "../../utils/productCopy.js";

function skillVersions(nodes = []) {
  return nodes
    .filter((node) => node.type === "Skill")
    .map((node) => ({ id: node.id, title: node.title, version: node.skillVersion || node.canonical?.skillRef?.version || "-" }));
}

function resolvedModels(plan, revision, nodes) {
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

function requiredSkillMaterials(nodes, skills) {
  return nodes.flatMap((node) => {
    if (node.type !== "Skill") return [];
    const skill = skills.find((candidate) => (
      candidate.id === node.skillId
      && (!node.skillVersion || candidate.version === node.skillVersion)
    ));
    const schema = skill?.canonical?.inputSchema;
    if (schema?.type !== "object") return [];
    const required = new Set(schema.required || []);
    return Object.entries(schema.properties || {}).flatMap(([materialKey, definition]) => (
      definition?.format === "attachment"
        ? [{
            nodeId: node.id,
            nodeTitle: node.title,
            materialKey,
            label: definition.title || materialKey,
            description: definition.description || "",
            acceptedMediaTypes: normalizeMaterialMediaTypes(
              definition.acceptedMediaTypes,
              { defaultToAll: true },
            ),
            required: required.has(materialKey),
          }]
        : []
    ));
  });
}

function bindingKey(field) {
  return `${field.nodeId}:${field.materialKey}`;
}

function operationId(field) {
  return `run-material-${field.nodeId}-${field.materialKey}-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
}

export function RunPreflightView({ workspace }) {
  const t = workspace.t;
  const attachmentMutations = useAttachmentMutations();
  const [materialStatus, setMaterialStatus] = useState({});
  const materialUploadTokens = useRef(new Map());
  const loop = workspace.selectedWorkflow;
  const revision = workspace.editorState?.draft || loop?.canonicalRevision;
  const nodes = loop?.workflow?.nodes || [];
  const skills = skillVersions(nodes);
  const fields = revision?.inputForm?.fields || [];
  const materials = workspace.resources.filter((resource) => (revision?.resourceRefs || []).some((ref) => ref.resourceId === resource.resourceId));
  const skillMaterials = useMemo(
    () => requiredSkillMaterials(nodes, workspace.skills),
    [nodes, workspace.skills],
  );
  const reviewSteps = nodes.filter((node) => node.type === "Review Gate");
  const executionPlan = workspace.editorState?.compile?.result?.executionPlan
    || revision?.compile?.executionPlan
    || revision?.executionPlan;
  const externalActionNodeIds = new Set(
    (executionPlan?.steps || [])
      .filter((step) => step.capabilities?.externalActions === true)
      .map((step) => step.nodeId),
  );
  const externalActions = nodes.filter((node) => externalActionNodeIds.has(node.id || node.nodeId));
  const missing = fields.filter((field) => field.required && !String(workspace.runInputs[field.fieldId] || "").trim());
  const missingSkillMaterials = skillMaterials.filter((field) => (
    field.required && !workspace.runMaterialBindings[bindingKey(field)]?.binding
  ));
  const dirty = Boolean(workspace.editorState?.dirty);
  const ready = loop?.readiness === "Ready";
  const preflightState = workspace.surfaceState?.preflight || workspace.surfaceState?.workflow;
  const planReady = workspace.editorState?.compile?.status === "ready"
    && Boolean(executionPlan);
  const canStart = Boolean(
    loop
      && ready
      && planReady
      && !dirty
      && !missing.length
      && !missingSkillMaterials.length
      && !attachmentMutations.createAttachment.isPending
      && !preflightState?.loading
      && !preflightState?.error
      && workspace.canRunWorkflow,
  );
  const savedVersion = loop?.canonicalRevision?.revisionNumber || loop?.canonicalRevision?.revision || 1;
  const modelRoutes = resolvedModels(executionPlan, revision, nodes);

  useEffect(() => {
    if (!loop || dirty || !workspace.canRunWorkflow || workspace.editorState?.compile?.status === "compiling") return;
    const hasResolvedPlan = Boolean(workspace.editorState?.compile?.result?.executionPlan);
    if (!hasResolvedPlan) workspace.compileSelectedWorkflow();
  }, [loop?.id, workspace.editorState?.baseRevision?.revisionId, workspace.canRunWorkflow]);

  if (preflightState?.loading || preflightState?.error) {
    return (
      <ObjectQueryState
        workspace={workspace}
        state={preflightState}
        objectLabel={t("object.loopWorkflow")}
        onRetry={() => workspace.retrySurface("preflight")}
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
    else document.querySelector("[data-testid='loopops.preflight.inputs'] input, [data-testid='loopops.preflight.skill-materials'] select")?.focus();
  }

  function chooseResource(field, resourceId) {
    const key = bindingKey(field);
    materialUploadTokens.current.set(key, operationId(field));
    const previousAttachmentId = materialStatus[key]?.attachmentId;
    if (previousAttachmentId) {
      attachmentMutations.deleteAttachment.mutate({
        attachmentId: previousAttachmentId,
        idempotencyKey: operationId(field),
      });
    }
    const resource = workspace.resources.find((item) => item.resourceId === resourceId);
    if (resource && !acceptsMaterialMediaType(field.acceptedMediaTypes, resource.mediaType)) {
      workspace.setRunMaterialBinding(field.nodeId, field.materialKey, null);
      setMaterialStatus((current) => ({
        ...current,
        [key]: {
          label: resource.label,
          status: "failed",
          error: t("runPreflight.materialFormatMismatch"),
        },
      }));
      return;
    }
    workspace.setRunMaterialBinding(field.nodeId, field.materialKey, resource ? {
      materialKey: field.materialKey,
      source: {
        kind: "workspace_resource",
        resource: {
          resourceId: resource.resourceId,
          version: resource.version,
          label: resource.label,
          contentHash: resource.contentHash,
        },
      },
    } : null);
    setMaterialStatus((current) => ({
      ...current,
      [key]: resource ? { label: resource.label, status: "ready" } : null,
    }));
  }

  async function uploadMaterial(field, file) {
    if (!file) return;
    const key = bindingKey(field);
    const mediaType = materialMediaTypeForFile(file);
    if (!mediaType || !acceptsMaterialMediaType(field.acceptedMediaTypes, mediaType)) {
      workspace.setRunMaterialBinding(field.nodeId, field.materialKey, null);
      setMaterialStatus((current) => ({
        ...current,
        [key]: {
          label: file.name,
          status: "failed",
          error: t("runPreflight.materialFormatMismatch"),
        },
      }));
      return;
    }
    const uploadToken = operationId(field);
    materialUploadTokens.current.set(key, uploadToken);
    const previousAttachmentId = materialStatus[key]?.attachmentId;
    let createdAttachmentId = "";
    workspace.setRunMaterialBinding(field.nodeId, field.materialKey, null);
    setMaterialStatus((current) => ({
      ...current,
      [key]: { label: file.name, status: "processing" },
    }));
    try {
      const result = await attachmentMutations.createAttachment.mutateAsync({
        file,
        idempotencyKey: operationId(field),
      });
      const attachment = result.data.attachment;
      createdAttachmentId = attachment.attachmentId;
      if (materialUploadTokens.current.get(key) !== uploadToken) {
        await attachmentMutations.deleteAttachment.mutateAsync({
          attachmentId: attachment.attachmentId,
          idempotencyKey: operationId(field),
        }).catch(() => {});
        return;
      }
      if (attachment.processing.status !== "ready") {
        throw new Error(attachment.processing.message || "attachment_processing_failed");
      }
      workspace.setRunMaterialBinding(field.nodeId, field.materialKey, {
        materialKey: field.materialKey,
        source: {
          kind: "attachment",
          attachment: {
            attachmentId: attachment.attachmentId,
            version: attachment.version,
            contentHash: attachment.contentHash,
            mediaType: attachment.mediaType,
          },
        },
      });
      setMaterialStatus((current) => ({
        ...current,
        [key]: {
          label: attachment.fileName,
          status: "ready",
          attachmentId: attachment.attachmentId,
        },
      }));
      if (previousAttachmentId && previousAttachmentId !== attachment.attachmentId) {
        attachmentMutations.deleteAttachment.mutate({
          attachmentId: previousAttachmentId,
          idempotencyKey: operationId(field),
        });
      }
    } catch (error) {
      if (materialUploadTokens.current.get(key) !== uploadToken) return;
      if (createdAttachmentId) {
        attachmentMutations.deleteAttachment.mutate({
          attachmentId: createdAttachmentId,
          idempotencyKey: operationId(field),
        });
      }
      setMaterialStatus((current) => ({
        ...current,
        [key]: {
          label: file.name,
          status: "failed",
          error: error?.message || t("runPreflight.materialUploadFailed"),
        },
      }));
    }
  }

  function removeMaterial(field) {
    const key = bindingKey(field);
    materialUploadTokens.current.set(key, operationId(field));
    const attachmentId = materialStatus[key]?.attachmentId
      || workspace.runMaterialBindings[key]?.binding?.source?.attachment?.attachmentId;
    workspace.setRunMaterialBinding(field.nodeId, field.materialKey, null);
    setMaterialStatus((current) => ({ ...current, [key]: null }));
    if (attachmentId) {
      attachmentMutations.deleteAttachment.mutate({
        attachmentId,
        idempotencyKey: operationId(field),
      });
    }
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

          {skillMaterials.length ? (
            <section className="preflightSection" data-testid="loopops.preflight.skill-materials">
              <div className="preflightSectionTitle">
                <FileText size={16} />
                <div>
                  <h3>{t("runPreflight.skillMaterials")}</h3>
                  <p>{t("runPreflight.skillMaterialsCaption")}</p>
                </div>
              </div>
              <div className="runMaterialBindings">
                {skillMaterials.map((field) => {
                  const key = bindingKey(field);
                  const selected = workspace.runMaterialBindings[key]?.binding;
                  const selectedResourceId = selected?.source?.kind === "workspace_resource"
                    ? selected.source.resource.resourceId
                    : "";
                  const status = materialStatus[key] || (selected ? {
                    label: selected.source.kind === "attachment"
                      ? selected.source.attachment.attachmentId
                      : selected.source.resource.label,
                    status: "ready",
                  } : null);
                  return (
                    <div className="runMaterialBinding" key={key}>
                      <div className="runMaterialHeading">
                        <strong>{field.label}{field.required ? " *" : ""}</strong>
                        <span>{field.nodeTitle}</span>
                      </div>
                      {field.description ? <p>{field.description}</p> : null}
                      <p>{t("runPreflight.acceptedFormats", { formats: materialFormatSummary(field.acceptedMediaTypes, workspace.locale) })}</p>
                      <div className="runMaterialControls">
                        <select
                          value={selectedResourceId}
                          onChange={(event) => chooseResource(field, event.target.value)}
                          aria-label={t("runPreflight.chooseWorkspaceMaterial")}
                        >
                          <option value="">{t("runPreflight.chooseWorkspaceMaterial")}</option>
                          {workspace.resources
                            .filter((resource) => (
                              resource.readiness?.status === "ready"
                              && resource.contentHash
                              && acceptsMaterialMediaType(
                                field.acceptedMediaTypes,
                                resource.mediaType,
                              )
                            ))
                            .map((resource) => (
                              <option key={resource.resourceId} value={resource.resourceId}>
                                {resource.label}
                              </option>
                            ))}
                        </select>
                        <label className="runMaterialUpload">
                          <span>{t("runPreflight.orUploadMaterial")}</span>
                          <input
                            type="file"
                            accept={materialAcceptAttribute(field.acceptedMediaTypes)}
                            onChange={(event) => uploadMaterial(field, event.target.files?.[0])}
                          />
                        </label>
                      </div>
                      {status ? (
                        <div className={`runMaterialStatus runMaterialStatus-${status.status}`}>
                          <FileText size={14} />
                          <span>{status.label}</span>
                          <small>
                            {status.status === "processing"
                              ? t("runPreflight.materialProcessing")
                              : status.error || t("runPreflight.materialReady")}
                          </small>
                          <button type="button" onClick={() => removeMaterial(field)} aria-label={t("actions.remove")}>
                            <X size={14} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

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
            {skillMaterials.length ? (
              <li className={missingSkillMaterials.length ? "blocked" : "ready"}>
                <CheckCircle2 size={15} />
                <span>{missingSkillMaterials.length ? t("runPreflight.missingSkillMaterials", { count: missingSkillMaterials.length }) : t("runPreflight.skillMaterialsReady")}</span>
              </li>
            ) : null}
            <li className={ready && planReady ? "ready" : "blocked"}><CheckCircle2 size={15} /><span>{ready && planReady ? t("runPreflight.versionPinned") : t("runPreflight.setupNeeded")}</span></li>
            <li className="ready"><CheckCircle2 size={15} /><span>{t("runPreflight.reviewVisible", { count: reviewSteps.length })}</span></li>
          </ul>
          {!canStart ? <div className="preflightBlocked" role="status" data-testid="loopops.preflight.blocked"><p>{dirty ? t("runPreflight.saveBeforeRun") : missing.length ? t("runPreflight.fillRequired") : missingSkillMaterials.length ? t("runPreflight.bindRequiredMaterials") : t("runPreflight.finishSetup")}</p><Button variant="secondary" onClick={ready && !dirty ? recover : () => workspace.editLoop(loop.id, "definition")}>{dirty || !ready ? t("actions.openBuilder") : t("runPreflight.fillInputs")}</Button></div> : null}
          <Button
            variant="primary"
            icon={<Play size={15} />}
            disabled={!canStart}
            onClick={() => workspace.runLoopInAgent(loop.id)}
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
