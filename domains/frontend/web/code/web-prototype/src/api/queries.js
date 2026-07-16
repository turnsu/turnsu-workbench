import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  encodeBytesBase64,
  formatSkillPackageBytes,
  PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
  WorkbenchApiError,
  workbenchApi,
} from "./client.js";
import { workbenchKeys } from "./queryKeys.js";

const RESUMABLE_CHUNK_SIZE_BYTES = 512 * 1024;

function reportUploadProgress(onProgress, upload, phase) {
  const receivedBytes = upload?.transfer?.receivedBytes || 0;
  const totalBytes = upload?.sizeBytes || 0;
  onProgress?.({
    phase,
    percent: totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0,
    receivedBytes,
    totalBytes,
  });
}

function requireUsableUpload(upload) {
  if (["ready_draft", "needs_decision"].includes(upload?.state)) return upload;
  throw new WorkbenchApiError({
    code: "skill_package_validation_failed",
    message: "The Skill package needs changes before it can be used.",
    details: { state: upload?.state, findings: upload?.findings || [] },
  });
}

function requirePortableLoopUpload(upload) {
  if (upload?.assetKind === "loop" && upload?.state === "ready_draft") return upload;
  throw new WorkbenchApiError({
    code: "loop_upload_not_ready",
    message: "The Loop file needs changes before it can be imported.",
    details: { state: upload?.state, findings: upload?.findings || [] },
  });
}

async function portableLoopBytes(data) {
  if (data?.bytes instanceof Uint8Array) return data.bytes;
  if (data?.bytes instanceof ArrayBuffer) return new Uint8Array(data.bytes);
  if (typeof data?.file?.arrayBuffer === "function") return new Uint8Array(await data.file.arrayBuffer());
  throw new WorkbenchApiError({
    code: "loop_file_required",
    message: "Choose a Loop file to continue.",
  });
}

export async function inspectResumableLoopPackage({
  api = workbenchApi,
  data,
  idempotencyKey,
  onProgress,
}) {
  const bytes = await portableLoopBytes(data);
  if (bytes.byteLength < 2 || bytes.byteLength > 12 * 1024 * 1024) {
    throw new WorkbenchApiError({
      code: "loop_file_size_invalid",
      message: "Choose a Loop file smaller than 12 MB.",
    });
  }
  const created = await api.createUpload({
    assetKind: "loop",
    filename: data.file?.name || data.filename || "import.loop.json",
    sizeBytes: bytes.byteLength,
    mediaType: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
    ingestMethod: "resumable",
  }, { idempotencyKey: `${idempotencyKey}:upload` });
  const uploadId = created.data.uploadId;
  let current = await api.getUpload(uploadId);
  reportUploadProgress(onProgress, current.data, current.data.state === "selecting" ? "uploading" : "checking");

  if (current.data.state === "selecting") {
    const expectedChunks = Math.max(1, Math.ceil(bytes.byteLength / RESUMABLE_CHUNK_SIZE_BYTES));
    if (current.data.assetKind !== "loop"
      || current.data.ingestMethod !== "resumable"
      || current.data.sizeBytes !== bytes.byteLength
      || current.data.transfer?.chunkSizeBytes !== RESUMABLE_CHUNK_SIZE_BYTES
      || current.data.transfer?.totalChunks !== expectedChunks) {
      throw new WorkbenchApiError({
        code: "upload_session_invalid",
        message: "The Loop transfer could not be resumed.",
      });
    }
    const receivedChunks = new Set(current.data.transfer.receivedChunks || []);
    for (let index = 0; index < expectedChunks; index += 1) {
      if (receivedChunks.has(index)) continue;
      const start = index * RESUMABLE_CHUNK_SIZE_BYTES;
      current = await api.uploadChunk(uploadId, index, {
        contentBase64: encodeBytesBase64(bytes.subarray(start, start + RESUMABLE_CHUNK_SIZE_BYTES)),
      }, { idempotencyKey: `${idempotencyKey}:chunk:${index}` });
      reportUploadProgress(onProgress, current.data, "uploading");
    }
    current = await api.completeUpload(uploadId, {
      idempotencyKey: `${idempotencyKey}:complete`,
    });
  }
  reportUploadProgress(onProgress, current.data, "checking");
  return { upload: requirePortableLoopUpload(current.data), idempotencyKey };
}

export async function beginPortableLoopImport({
  api = workbenchApi,
  data,
  idempotencyKey,
  onProgress,
}) {
  const inspected = await inspectResumableLoopPackage({ api, data, idempotencyKey, onProgress });
  onProgress?.({ phase: "preparing", percent: 100, receivedBytes: inspected.upload.sizeBytes, totalBytes: inspected.upload.sizeBytes });
  const created = await api.createLoopImport(
    { uploadId: inspected.upload.uploadId },
    { idempotencyKey: `${idempotencyKey}:import` },
  );
  return { upload: inspected.upload, loopImport: created.data, etag: created.etag };
}

export async function loadPortableLoopImportOptions({ api = workbenchApi, portableLoop }) {
  const skillRequirements = portableLoop?.requirements?.skills || [];
  const skillEntries = await Promise.all(skillRequirements.map(async (requirement) => {
    try {
      const result = await api.listSkillVersions(requirement.skillId);
      return [requirement.ref, (result.data || []).filter((version) => (
        version.skillId === requirement.skillId
        && version.version === requirement.version
        && version.contentHash === requirement.contentHash
      ))];
    } catch {
      return [requirement.ref, []];
    }
  }));
  const [resources, connections] = await Promise.all([
    api.listResources(),
    api.listConnections(),
  ]);
  return {
    skillsByRef: Object.fromEntries(skillEntries),
    resources: resources.data || [],
    connections: connections.data || [],
  };
}

export async function inspectResumableSkillPackage({
  api = workbenchApi,
  data,
  idempotencyKey,
  onProgress,
}) {
  const packageBytes = formatSkillPackageBytes(data.files);
  const created = await api.createUpload({
    filename: data.filename,
    sizeBytes: packageBytes.byteLength,
    mediaType: "application/vnd.looloomi.skill-package+json",
    ingestMethod: "resumable",
  }, { idempotencyKey: `${idempotencyKey}:upload` });
  const uploadId = created.data.uploadId;
  let current = await api.getUpload(uploadId);
  reportUploadProgress(
    onProgress,
    current.data,
    current.data.state === "selecting" ? "uploading" : "checking",
  );

  if (current.data.state === "selecting") {
    const expectedChunks = Math.max(1, Math.ceil(packageBytes.byteLength / RESUMABLE_CHUNK_SIZE_BYTES));
    if (current.data.ingestMethod !== "resumable"
      || current.data.sizeBytes !== packageBytes.byteLength
      || current.data.transfer?.chunkSizeBytes !== RESUMABLE_CHUNK_SIZE_BYTES
      || current.data.transfer?.totalChunks !== expectedChunks) {
      throw new WorkbenchApiError({
        code: "upload_session_invalid",
        message: "The package upload could not be resumed.",
      });
    }
    const receivedChunks = new Set(current.data.transfer.receivedChunks || []);
    for (let index = 0; index < expectedChunks; index += 1) {
      if (receivedChunks.has(index)) continue;
      const start = index * RESUMABLE_CHUNK_SIZE_BYTES;
      current = await api.uploadChunk(uploadId, index, {
        contentBase64: encodeBytesBase64(packageBytes.subarray(start, start + RESUMABLE_CHUNK_SIZE_BYTES)),
      }, { idempotencyKey: `${idempotencyKey}:chunk:${index}` });
      reportUploadProgress(onProgress, current.data, "uploading");
    }
    current = await api.completeUpload(uploadId, {
      idempotencyKey: `${idempotencyKey}:complete`,
    });
    reportUploadProgress(onProgress, current.data, "checking");
  }

  return { upload: requireUsableUpload(current.data), metadata: data, idempotencyKey };
}

export async function importSkillRepositoryPackage({
  api = workbenchApi,
  data,
  idempotencyKey,
  onProgress,
}) {
  reportUploadProgress(onProgress, null, "importing");
  const imported = await api.importSkillRepository({
    repositoryUrl: data.repositoryUrl,
    ref: data.ref,
    skillDirectory: data.skillDirectory,
  }, { idempotencyKey });
  reportUploadProgress(onProgress, imported.data, "checking");
  return { upload: requireUsableUpload(imported.data), metadata: data, idempotencyKey };
}

export function skillPackagePromotionData(inspected, { permissionAcknowledged = false } = {}) {
  const state = inspected?.upload?.state;
  if (state === "ready_draft") return {};
  if (state === "needs_decision" && permissionAcknowledged === true) {
    return { permissionAcknowledged: true };
  }
  if (state === "needs_decision") {
    throw new WorkbenchApiError({
      code: "upload_review_acknowledgement_required",
      message: "Review the executable package boundary before continuing.",
    });
  }
  throw new WorkbenchApiError({
    code: "upload_promotion_blocked",
    message: "Resolve package validation before promoting this upload.",
    details: { state },
  });
}

export function useWorkspaceBootstrap() {
  return useQuery({
    queryKey: workbenchKeys.workspace,
    queryFn: () => workbenchApi.bootstrap(),
    staleTime: Infinity,
  });
}

export function useActiveSessionQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.session,
    queryFn: () => workbenchApi.getActiveSession(),
    enabled,
    staleTime: Infinity,
  });
}

export function useSkillsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skills(),
    queryFn: () => workbenchApi.listSkills(),
    enabled,
  });
}

export function useSkillAssetsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillAssets(),
    queryFn: () => workbenchApi.listSkillAssets(),
    enabled,
  });
}

export function useSkillDraftQuery(skillId, draftId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillDraft(skillId, draftId),
    queryFn: () => workbenchApi.getSkillDraft(skillId, draftId),
    enabled: enabled && Boolean(skillId && draftId),
  });
}

export function useSkillDraftPackageQuery(skillId, draftId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillDraftPackage(skillId, draftId),
    queryFn: () => workbenchApi.getSkillDraftPackage(skillId, draftId),
    enabled: enabled && Boolean(skillId && draftId),
  });
}

export async function loadSkillDraftConflictSnapshot(skillId, draftId) {
  const [draft, packageResult] = await Promise.all([
    workbenchApi.getSkillDraft(skillId, draftId),
    workbenchApi.getSkillDraftPackage(skillId, draftId),
  ]);
  return {
    draft: draft.data,
    etag: draft.etag,
    package: packageResult.data,
  };
}

export function useSkillVersionsQuery(skillId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillVersions(skillId),
    queryFn: () => workbenchApi.listSkillVersions(skillId),
    enabled: enabled && Boolean(skillId),
  });
}

export function useSkillUsageQuery(skillId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillUsage(skillId),
    queryFn: () => workbenchApi.getSkillUsage(skillId),
    enabled: enabled && Boolean(skillId),
  });
}

export function useSkillVersionDiffQuery(skillId, fromVersionId, toVersionId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillVersionDiff(skillId, fromVersionId, toVersionId),
    queryFn: () => workbenchApi.getSkillVersionDiff(skillId, fromVersionId, toVersionId),
    enabled: enabled && Boolean(skillId && fromVersionId && toVersionId && fromVersionId !== toVersionId),
  });
}

export function useLoopSkillUpdatePreviewQuery(workflowId, skillVersionId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.loopSkillUpdatePreview(workflowId, skillVersionId),
    queryFn: () => workbenchApi.getLoopSkillUpdatePreview(workflowId, skillVersionId),
    enabled: enabled && Boolean(workflowId && skillVersionId),
  });
}

export function useTemplatesQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.templates(),
    queryFn: () => workbenchApi.listTemplates(),
    enabled,
  });
}

export function useTeamLibraryQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.teamLibrary(),
    queryFn: () => workbenchApi.listTeamLibrary(),
    enabled,
  });
}

export function useInstallationsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.installations(),
    queryFn: () => workbenchApi.listInstallations(),
    enabled,
  });
}

export function useResourcesQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.resources(),
    queryFn: () => workbenchApi.listResources(),
    enabled,
  });
}

export function useConnectionsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.connections(),
    queryFn: () => workbenchApi.listConnections(),
    enabled,
  });
}

export function useConnectionMutations() {
  const queryClient = useQueryClient();
  const refreshConnections = () => queryClient.invalidateQueries({ queryKey: workbenchKeys.connections() });
  const createConnection = useMutation({
    mutationFn: ({ capabilityKey, label, permissionSummary, idempotencyKey }) => workbenchApi.createConnection({
      capabilityKey,
      label,
      configuration: { accountLabel: label, permissionSummary },
    }, { idempotencyKey }),
    onSuccess: refreshConnections,
  });
  const updateConnection = useMutation({
    async mutationFn({ connectionId, label, permissionSummary, idempotencyKey }) {
      const current = await workbenchApi.getConnection(connectionId);
      return workbenchApi.updateConnection(connectionId, {
        label,
        configuration: { accountLabel: label, permissionSummary },
        enabled: true,
      }, {
        ifMatch: current.etag,
        idempotencyKey,
      });
    },
    onSuccess: refreshConnections,
  });
  const validateConnection = useMutation({
    async mutationFn({ connectionId, ifMatch, idempotencyKey }) {
      const etag = ifMatch || (await workbenchApi.getConnection(connectionId)).etag;
      return workbenchApi.validateConnection(connectionId, { ifMatch: etag, idempotencyKey });
    },
    onSuccess: refreshConnections,
  });
  return { createConnection, updateConnection, validateConnection };
}

export function useWorkflowsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workflows(),
    queryFn: () => workbenchApi.listWorkflows(),
    enabled,
  });
}

export function useWorkflowQuery(workflowId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workflow(workflowId),
    queryFn: () => workbenchApi.getWorkflow(workflowId),
    enabled: enabled && Boolean(workflowId),
  });
}

export function useWorkflowRevisionQuery(workflowId, revisionId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.revision(workflowId, revisionId),
    queryFn: () => workbenchApi.getWorkflowRevision(workflowId, revisionId),
    enabled: enabled && Boolean(workflowId && revisionId),
  });
}

export function useWorkflowRunsQuery(workflowId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.runs(workflowId),
    queryFn: () => workbenchApi.listWorkflowRuns(workflowId),
    enabled: enabled && Boolean(workflowId),
    refetchInterval(query) {
      const active = query.state.data?.data?.some((run) => !["completed", "failed", "cancelled"].includes(run.status));
      return active ? 1_000 : false;
    },
  });
}

export function useRunQuery(runId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.run(runId),
    queryFn: () => workbenchApi.getRun(runId),
    enabled: enabled && Boolean(runId),
    // SSE is the primary update path. Poll only non-terminal Runs so a proxy or
    // transient EventSource disconnect cannot leave the review surface stale.
    refetchInterval(query) {
      const status = query.state.data?.data?.run?.status;
      return status && !["completed", "failed", "cancelled"].includes(status) ? 1_000 : false;
    },
  });
}

export function useRunComparisonQuery(runId, otherRunId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.runComparison(runId, otherRunId),
    queryFn: () => workbenchApi.getRunComparison(runId, otherRunId),
    enabled: enabled && Boolean(runId && otherRunId && runId !== otherRunId),
    staleTime: 5_000,
  });
}

export function useWorkbenchMutations() {
  const queryClient = useQueryClient();
  const upsertWorkflowList = (workflow) => {
    queryClient.setQueryData(workbenchKeys.workflows(), (current) => {
      const existing = current?.data || [];
      return {
        ...(current || {}),
        data: [workflow, ...existing.filter((item) => item.workflowId !== workflow.workflowId)],
      };
    });
  };
  const refreshCatalogs = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["workbench", "skills"] }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "skill-assets"] }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "templates"] }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "workflows"] }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "team-library"] }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "installations"] }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "resources"] }),
  ]);
  const refreshSkillLifecycle = (skillId) => Promise.all([
    queryClient.invalidateQueries({ queryKey: workbenchKeys.skill(skillId) }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "skill-draft", skillId] }),
    queryClient.invalidateQueries({ queryKey: workbenchKeys.skillVersions(skillId) }),
    queryClient.invalidateQueries({ queryKey: workbenchKeys.skillUsage(skillId) }),
  ]);
  const useTemplate = useMutation({
    async mutationFn({ templateId, data, idempotencyKey }) {
      const created = await workbenchApi.useTemplate(templateId, data, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  const createLoop = useMutation({
    async mutationFn({ data, idempotencyKey }) {
      const created = await workbenchApi.createLoop(data, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  const duplicateLoop = useMutation({
    async mutationFn({ workflowId, data, idempotencyKey }) {
      const created = await workbenchApi.duplicateLoop(workflowId, data, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  const createSkill = useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createSkill(data, { idempotencyKey }),
    onSuccess: refreshCatalogs,
  });
  const createResource = useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createResource(data, { idempotencyKey }),
    onSuccess: refreshCatalogs,
  });
  const publishSkill = useMutation({
    mutationFn: ({ skillId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.publishSkill(skillId, data, { ifMatch, idempotencyKey })
    ),
    onSuccess: (_result, variables) => Promise.all([
      refreshCatalogs(),
      refreshSkillLifecycle(variables.skillId),
    ]),
  });
  const createSkillUpdateDraft = useMutation({
    async mutationFn({ skill, data, idempotencyKey }) {
      const currentDraft = skill.canonical?.sourceDraft || skill.canonical?.draft;
      const currentVersion = skill.canonical?.version;
      if (!currentDraft?.skillDraftId || !currentVersion?.skillVersionId) {
        throw new WorkbenchApiError({
          code: "skill_update_not_ready",
          message: "Publish this Skill before creating an update.",
        });
      }
      const draft = await workbenchApi.getSkillDraft(skill.id, currentDraft.skillDraftId);
      const next = await workbenchApi.createNextSkillDraft(skill.id, {
        baseVersionId: currentVersion.skillVersionId,
      }, { ifMatch: draft.etag, idempotencyKey: `${idempotencyKey}:draft` });
      const edited = await workbenchApi.updateSkillDraft(skill.id, next.data.skillDraftId, {
        name: data.name,
        description: data.description,
        category: data.category,
      }, { ifMatch: next.etag, idempotencyKey: `${idempotencyKey}:edit` });
      return { skillId: skill.id, draft: edited.data, etag: edited.etag };
    },
    onSuccess: refreshCatalogs,
  });
  const deprecateSkill = useMutation({
    mutationFn: ({ skillId, data, idempotencyKey }) => (
      workbenchApi.deprecateSkill(skillId, data, { idempotencyKey })
    ),
    onSuccess: refreshCatalogs,
  });
  const inspectSkillPackage = useMutation({
    mutationFn: inspectResumableSkillPackage,
  });
  const inspectLoopPackage = useMutation({
    mutationFn: beginPortableLoopImport,
  });
  const loadLoopImportOptions = useMutation({
    mutationFn: loadPortableLoopImportOptions,
  });
  const refreshLoopImport = useMutation({
    mutationFn: (importId) => workbenchApi.getLoopImport(importId),
  });
  const commitLoopImport = useMutation({
    mutationFn: ({ importId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.commitLoopImport(importId, data, { ifMatch, idempotencyKey })
    ),
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  const exportLoop = useMutation({
    mutationFn: ({ workflowId, revisionId, ifNoneMatch }) => (
      workbenchApi.exportLoop(workflowId, revisionId, { ifNoneMatch })
    ),
  });
  const importSkillRepository = useMutation({
    mutationFn: importSkillRepositoryPackage,
  });
  const createSkillFromInspectedPackage = useMutation({
    async mutationFn({ inspected, permissionAcknowledged, idempotencyKey }) {
      const data = inspected.metadata;
      const uploadId = inspected.upload.uploadId;
      await workbenchApi.promoteUpload(
        uploadId,
        skillPackagePromotionData(inspected, { permissionAcknowledged }),
        { idempotencyKey: `${idempotencyKey}:promote` },
      );
      const created = await workbenchApi.createSkill({
        name: data.name,
        description: data.description,
        category: data.category,
        uploadId,
      }, { idempotencyKey: `${idempotencyKey}:create` });
      const draft = await workbenchApi.getSkillDraft(created.data.skill.skillId, created.data.draft.skillDraftId);
      return { upload: inspected.upload, created: created.data, draft };
    },
    onSuccess: refreshCatalogs,
  });
  const updateSkillDraft = useMutation({
    mutationFn: ({ skillId, draftId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.updateSkillDraft(skillId, draftId, data, { ifMatch, idempotencyKey })
    ),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.skillDraft(variables.skillId, variables.draftId), result);
      return refreshCatalogs();
    },
  });
  const replaceSkillDraftPackage = useMutation({
    async mutationFn({ skillId, draftId, data, ifMatch, idempotencyKey }) {
      const upload = await workbenchApi.createUpload({
        filename: data.filename,
        sizeBytes: data.sizeBytes,
        mediaType: "application/vnd.looloomi.skill-package+json",
      }, { idempotencyKey: `${idempotencyKey}:upload` });
      const inspected = await workbenchApi.uploadSkillPackage(upload.data.uploadId, {
        files: data.files,
      }, { idempotencyKey: `${idempotencyKey}:inspect` });
      if (!["ready_draft", "needs_decision"].includes(inspected.data.state)) {
        throw new WorkbenchApiError({
          code: "skill_package_validation_failed",
          message: "The Skill package needs changes before it can be saved.",
          details: { state: inspected.data.state, findings: inspected.data.findings || [] },
        });
      }
      await workbenchApi.promoteUpload(
        upload.data.uploadId,
        skillPackagePromotionData({ upload: inspected.data }, {
          permissionAcknowledged: data.permissionAcknowledged,
        }),
        { idempotencyKey: `${idempotencyKey}:promote` },
      );
      return workbenchApi.replaceSkillDraftPackage(
        skillId,
        draftId,
        { uploadId: upload.data.uploadId },
        { ifMatch, idempotencyKey: `${idempotencyKey}:replace` },
      );
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.skillDraft(variables.skillId, variables.draftId), result);
      queryClient.invalidateQueries({ queryKey: workbenchKeys.skillDraftPackage(variables.skillId, variables.draftId) });
      return refreshCatalogs();
    },
  });
  const runSkillTest = useMutation({
    mutationFn: ({ skillId, draftId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.createSkillTest(skillId, draftId, data, { ifMatch, idempotencyKey })
    ),
  });
  const validateSkill = useMutation({
    mutationFn: ({ skillId, draftId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.createSkillValidation(skillId, draftId, data, { ifMatch, idempotencyKey })
    ),
  });
  const saveRevision = useMutation({
    mutationFn: ({ workflowId, data, ifMatch, idempotencyKey }) => workbenchApi.saveLoopRevision(workflowId, data, { ifMatch, idempotencyKey }),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.workflow(variables.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(variables.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return queryClient.invalidateQueries({ queryKey: ["workbench", "workflows"] });
    },
  });
  const updateLoopSkill = useMutation({
    async mutationFn({ workflowId, data, ifMatch, idempotencyKey }) {
      const workflow = ifMatch ? null : await workbenchApi.getWorkflow(workflowId);
      return workbenchApi.createLoopSkillUpdate(workflowId, data, {
        ifMatch: ifMatch || workflow.etag,
        idempotencyKey,
      });
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.workflow(variables.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(variables.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      queryClient.removeQueries({ queryKey: ["workbench", "loop-skill-update", variables.workflowId] });
      return refreshCatalogs();
    },
  });
  const generateLoopProposal = useMutation({
    mutationFn: ({ workflowId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.generateLoopProposal(workflowId, data, { ifMatch, idempotencyKey })
    ),
  });
  const applyLoopProposal = useMutation({
    async mutationFn({ workflowId, proposalId, data, ifMatch, idempotencyKey }) {
      const applied = await workbenchApi.applyLoopProposal(workflowId, proposalId, data, {
        ifMatch,
        idempotencyKey,
      });
      const workflow = await workbenchApi.getWorkflow(workflowId);
      const revision = await workbenchApi.getWorkflowRevision(workflowId, workflow.data.currentRevisionId);
      return {
        proposal: applied.data,
        workflow: workflow.data,
        revision: revision.data,
        etag: workflow.etag,
      };
    },
    onSuccess(result) {
      queryClient.setQueryData(workbenchKeys.workflow(result.workflow.workflowId), {
        data: result.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.workflow.workflowId, result.revision.revisionId),
        { data: result.revision, etag: result.etag },
      );
      return queryClient.invalidateQueries({ queryKey: ["workbench", "workflows"] });
    },
  });
  const dismissLoopProposal = useMutation({
    mutationFn: ({ workflowId, proposalId, data, ifMatch, idempotencyKey }) => (
      workbenchApi.dismissLoopProposal(workflowId, proposalId, data, { ifMatch, idempotencyKey })
    ),
  });
  const compile = useMutation({
    mutationFn: ({ workflowId, revisionId, idempotencyKey }) => workbenchApi.compileWorkflow(workflowId, revisionId, { idempotencyKey }),
    onSuccess: (_result, variables) => Promise.all([
      queryClient.invalidateQueries({ queryKey: workbenchKeys.workflow(variables.workflowId) }),
      queryClient.invalidateQueries({ queryKey: workbenchKeys.revision(variables.workflowId, variables.revisionId) }),
    ]),
  });
  const publishLoop = useMutation({
    mutationFn: ({ workflowId, data, ifMatch, idempotencyKey }) => workbenchApi.publishLoop(workflowId, data, { ifMatch, idempotencyKey }),
    onSuccess: (_result, variables) => Promise.all([
      refreshCatalogs(),
      queryClient.invalidateQueries({ queryKey: workbenchKeys.workflow(variables.workflowId) }),
    ]),
  });
  const startRun = useMutation({
    mutationFn: ({ workflowId, data, idempotencyKey }) => workbenchApi.startRun(workflowId, data, { idempotencyKey }),
    onSuccess: (_result, variables) => queryClient.invalidateQueries({ queryKey: ["workbench", "runs", variables.workflowId] }),
  });
  const createLoopDraftFromRun = useMutation({
    async mutationFn({ runId, data, idempotencyKey }) {
      const created = await workbenchApi.createLoopDraftFromRun(runId, data, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  const review = useMutation({
    mutationFn: ({ runId, data, idempotencyKey }) => workbenchApi.submitReviewDecision(runId, data, { idempotencyKey }),
    onSuccess: (_result, variables) => queryClient.invalidateQueries({ queryKey: workbenchKeys.run(variables.runId) }),
  });
  const cancelRun = useMutation({
    mutationFn: ({ runId, data, idempotencyKey }) => workbenchApi.cancelRun(runId, data, { idempotencyKey }),
    onSuccess: (_result, variables) => Promise.all([
      queryClient.invalidateQueries({ queryKey: workbenchKeys.run(variables.runId) }),
      queryClient.invalidateQueries({ queryKey: ["workbench", "runs"] }),
    ]),
  });
  const retryRun = useMutation({
    mutationFn: ({ runId, data, idempotencyKey }) => workbenchApi.retryRun(runId, data, { idempotencyKey }),
    onSuccess: (result, variables) => Promise.all([
      queryClient.invalidateQueries({ queryKey: workbenchKeys.run(variables.runId) }),
      queryClient.invalidateQueries({ queryKey: ["workbench", "runs"] }),
      result.data?.runId
        ? queryClient.invalidateQueries({ queryKey: workbenchKeys.run(result.data.runId) })
        : Promise.resolve(),
    ]),
  });
  const installTeamRelease = useMutation({
    mutationFn: ({ releaseId, data, idempotencyKey }) => workbenchApi.installTeamRelease(releaseId, data, { idempotencyKey }),
    onSuccess: refreshCatalogs,
  });
  const adoptInstallationRelease = useMutation({
    mutationFn: ({ installationId, releaseId, connectionBindings = [], idempotencyKey }) => (
      workbenchApi.adoptInstallationRelease(
        installationId,
        { releaseId, connectionBindings },
        { idempotencyKey },
      )
    ),
    onSuccess: refreshCatalogs,
  });
  const useTeamReleaseAsStartingPoint = useMutation({
    async mutationFn({ releaseId, data, idempotencyKey }) {
      const created = await workbenchApi.useTeamReleaseAsStartingPoint(releaseId, data, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  const forkTeamLoopRelease = useMutation({
    async mutationFn({ releaseId, data, idempotencyKey }) {
      const created = await workbenchApi.forkTeamLoopRelease(releaseId, data, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess(result) {
      upsertWorkflowList(result.data.workflow);
      queryClient.setQueryData(workbenchKeys.workflow(result.data.workflow.workflowId), {
        data: result.data.workflow,
        etag: result.etag,
      });
      queryClient.setQueryData(
        workbenchKeys.revision(result.data.workflow.workflowId, result.data.revision.revisionId),
        { data: result.data.revision, etag: result.etag },
      );
      return refreshCatalogs();
    },
  });
  return {
    useTemplate, createLoop, duplicateLoop, createSkill, createResource, publishSkill, createSkillUpdateDraft, deprecateSkill, inspectSkillPackage, inspectLoopPackage, loadLoopImportOptions, refreshLoopImport, commitLoopImport, exportLoop, importSkillRepository, createSkillFromInspectedPackage, updateSkillDraft, replaceSkillDraftPackage, runSkillTest, validateSkill, saveRevision, updateLoopSkill, generateLoopProposal, applyLoopProposal, dismissLoopProposal, compile, publishLoop, startRun, createLoopDraftFromRun, review, cancelRun, retryRun,
    installTeamRelease, adoptInstallationRelease, useTeamReleaseAsStartingPoint, forkTeamLoopRelease,
  };
}
