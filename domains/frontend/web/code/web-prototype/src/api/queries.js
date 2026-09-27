import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  encodeBytesBase64,
  formatSkillPackageBytes,
  isTerminalRunStatus,
  WorkbenchApiError,
  workbenchApi,
} from "./client.js";
import { workbenchKeys } from "./queryKeys.js";

const RESUMABLE_CHUNK_SIZE_BYTES = 512 * 1024;
const ATTACHMENT_MEDIA_BY_EXTENSION = Object.freeze({
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

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

export function useWorkspaceFeatureReadiness(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workspaceFeatureReadiness,
    queryFn: ({ signal }) => workbenchApi.getWorkspaceFeatureReadiness({ signal }),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
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

export function useRecentWorkQuery(query = { limit: 3 }, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.recentWork(query),
    queryFn: () => workbenchApi.listRecentWork(query),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateModelProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createModelProfile(data, { idempotencyKey }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench", "model-profiles"] }),
  });
}

export function useModelConfigurationMembersQuery(principal = {}, enabled = true) {
  return useQuery({
    queryKey: ["workbench", "model-configuration-members", principal.workspaceId, principal.userId],
    queryFn: ({ signal }) => workbenchApi.listMembers({ signal }),
    enabled: enabled && Boolean(principal.userId),
    staleTime: 0,
  });
}

export function useModelProfilesQuery(filters = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.modelProfiles(filters),
    queryFn: ({ signal }) => workbenchApi.listModelProfiles(filters, { signal }),
    enabled,
    staleTime: 30_000,
  });
}

export function useAgentDefinitionsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.agentDefinitions,
    queryFn: () => workbenchApi.listAgentDefinitions(),
    enabled,
    staleTime: 60_000,
  });
}

export function useAgentSessionsQuery(query = { definitionId: "main", limit: 100 }, enabled = true, principal = {}) {
  const result = useInfiniteQuery({
    queryKey: workbenchKeys.agentSessions(principal, query),
    initialPageParam: null,
    queryFn: ({ signal, pageParam }) => workbenchApi.listAgentSessions({
      ...query,
      ...(pageParam ? { cursor: pageParam } : {}),
    }, { signal }),
    getNextPageParam: (lastPage) => lastPage.page?.hasMore
      ? lastPage.page.nextCursor
      : undefined,
    enabled,
    refetchInterval(result) {
      const active = result.state.data?.pages?.some((page) => page.data?.some((session) => (
        ["queued", "running", "waiting_review"].includes(session.taskStatus)
      )));
      return active ? 1_500 : false;
    },
  });
  const data = result.data
    ? {
        data: result.data.pages.flatMap((page) => page.data || []),
        page: result.data.pages.at(-1)?.page,
      }
    : undefined;
  return { ...result, data };
}

export function agentSessionRefetchInterval(query) {
  const session = query.state.data?.data;
  return session?.activeTurnId || ["queued", "running"].includes(session?.taskStatus)
    ? 1_000
    : false;
}

export function useAgentSessionQuery(sessionId, enabled = true, principal = {}) {
  return useQuery({
    queryKey: workbenchKeys.agentSession(principal, sessionId),
    queryFn: ({ signal }) => workbenchApi.getAgentSession(sessionId, { signal }),
    enabled: enabled && Boolean(sessionId),
    refetchInterval: agentSessionRefetchInterval,
  });
}

export function useAgentTurnsQuery(sessionId, query = {}, enabled = true, principal = {}) {
  const result = useInfiniteQuery({
    queryKey: workbenchKeys.agentTurns(principal, sessionId, query),
    initialPageParam: null,
    queryFn: ({ signal, pageParam }) => workbenchApi.listAgentTurns(sessionId, {
      ...query,
      ...(pageParam ? { cursor: pageParam } : {}),
    }, { signal }),
    getNextPageParam: (lastPage) => lastPage.page?.hasMore
      ? lastPage.page.nextCursor
      : undefined,
    enabled: enabled && Boolean(sessionId),
    refetchInterval(result) {
      const active = result.state.data?.pages?.some((page) => page.data?.some(
        (turn) => !["completed", "failed", "cancelled", "blocked"].includes(turn.status),
      ));
      return active ? 1_500 : false;
    },
  });
  const orderedPages = result.data ? [...result.data.pages].reverse() : [];
  const data = result.data
    ? {
        data: orderedPages.flatMap((page) => page.data || []),
        page: result.data.pages.at(-1)?.page,
      }
    : undefined;
  return { ...result, data };
}

export function useAgentTurnQuery(sessionId, turnId, enabled = true, principal = {}) {
  return useQuery({
    queryKey: workbenchKeys.agentTurn(principal, sessionId, turnId),
    queryFn: ({ signal }) => workbenchApi.getAgentTurn(sessionId, turnId, { signal }),
    enabled: enabled && Boolean(sessionId && turnId),
    refetchInterval(query) {
      const status = query.state.data?.data?.status;
      return status && !["completed", "failed", "cancelled", "blocked"].includes(status) ? 750 : false;
    },
  });
}

export function useAgentEventsQuery(sessionId, query = {}, enabled = true, principal = {}) {
  const result = useInfiniteQuery({
    queryKey: workbenchKeys.agentEvents(principal, sessionId, query),
    initialPageParam: null,
    queryFn: ({ signal, pageParam }) => workbenchApi.listAgentSessionEvents(sessionId, {
      ...query,
      ...(pageParam ? { cursor: pageParam } : {}),
    }, { signal }),
    getNextPageParam: (lastPage) => lastPage.page?.hasMore
      ? lastPage.page.nextCursor
      : undefined,
    enabled: enabled && Boolean(sessionId),
    refetchInterval: 2_000,
  });
  const orderedPages = result.data ? [...result.data.pages].reverse() : [];
  const data = result.data
    ? {
        data: orderedPages.flatMap((page) => page.data || []),
        page: result.data.pages.at(-1)?.page,
      }
    : undefined;
  return { ...result, data };
}

export function useAgentProposalQuery(
  sessionId,
  proposalId,
  enabled = true,
  principal = {},
) {
  return useQuery({
    queryKey: workbenchKeys.agentProposal(principal, sessionId, proposalId),
    queryFn: ({ signal }) => workbenchApi.getAgentProposal(
      sessionId,
      proposalId,
      { signal },
    ),
    enabled: enabled && Boolean(sessionId && proposalId),
  });
}

export function useInboxQuery(principal = {}, query = { limit: 50 }, enabled = true) {
  const result = useInfiniteQuery({
    queryKey: workbenchKeys.inbox(principal, query),
    initialPageParam: null,
    queryFn: ({ signal, pageParam }) => workbenchApi.getInbox({
      ...query,
      ...(pageParam ? { cursor: pageParam } : {}),
    }, { signal }),
    getNextPageParam: (lastPage) => lastPage.data?.page?.hasMore
      ? lastPage.data.page.nextCursor
      : undefined,
    enabled,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const data = result.data
    ? {
        data: {
          items: result.data.pages.flatMap((page) => page.data?.items || []),
          count: result.data.pages[0]?.data?.count ?? 0,
          page: result.data.pages.at(-1)?.data?.page,
        },
      }
    : undefined;
  return { ...result, data };
}

export function useScopesQuery(principal = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.scopes(principal),
    queryFn: ({ signal }) => workbenchApi.listScopes({ signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId),
    staleTime: 15_000,
  });
}

export function useScopeQuery(principal = {}, scopeId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.scope(principal, scopeId),
    queryFn: ({ signal }) => workbenchApi.getScope(scopeId, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId && scopeId),
    staleTime: 15_000,
  });
}

export function useAutomationsQuery(principal = {}, query = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.automations(principal, query),
    queryFn: ({ signal }) => workbenchApi.listAutomations(query, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId),
    staleTime: 5_000,
    refetchInterval(current) {
      const active = current.state.data?.data?.some((automation) => automation.status === "active");
      return active ? 15_000 : false;
    },
  });
}

export function useAutomationCandidatesQuery(principal = {}, query = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.automationCandidates(principal, query),
    queryFn: ({ signal }) => workbenchApi.listAutomationCandidates(query, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId),
    staleTime: 15_000,
  });
}

export function useAutomationOccurrencesQuery(principal = {}, automationId, query = { limit: 20 }, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.automationOccurrences(principal, automationId, query),
    queryFn: ({ signal }) => workbenchApi.listAutomationOccurrences(automationId, query, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId && automationId),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

export function useAutomationMutations(principal = {}) {
  const queryClient = useQueryClient();
  const refresh = (automationId = "") => Promise.all([
    queryClient.invalidateQueries({ queryKey: workbenchKeys.automations(principal) }),
    queryClient.invalidateQueries({ queryKey: workbenchKeys.automationCandidates(principal) }),
    queryClient.invalidateQueries({ queryKey: workbenchKeys.scopes(principal) }),
    ...(automationId
      ? [
        queryClient.invalidateQueries({ queryKey: workbenchKeys.automation(principal, automationId) }),
        queryClient.invalidateQueries({ queryKey: workbenchKeys.automationOccurrences(principal, automationId) }),
      ]
      : []),
  ]);
  const reviseScopePolicy = useMutation({
    async mutationFn({ scopeId, data, ifMatch, idempotencyKey }) {
      // Scope lists intentionally do not disclose a mutable version. Fetch the
      // selected entity immediately before the write when the caller did not
      // already open it, so every policy revision still has optimistic
      // concurrency protection rather than weakening the endpoint contract.
      const current = ifMatch ? null : await workbenchApi.getScope(scopeId);
      const etag = ifMatch || current?.etag;
      if (!etag) throw new WorkbenchApiError({
        code: "scope_policy_etag_unavailable",
        message: "Reload the scope before changing its policy.",
      });
      return workbenchApi.reviseScopePolicy(scopeId, data, { ifMatch: etag, idempotencyKey });
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.scope(principal, variables.scopeId), result);
      return refresh();
    },
  });
  const createAutomation = useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createAutomation(data, { idempotencyKey }),
    onSuccess: (result) => {
      queryClient.setQueryData(workbenchKeys.automation(principal, result.data.automationId), result);
      return refresh(result.data.automationId);
    },
  });
  const reviseAutomation = useMutation({
    async mutationFn({ automationId, data, ifMatch, idempotencyKey }) {
      // Cards intentionally carry only the product-safe list projection. Fetch
      // the canonical entity when necessary so an edit always has the server's
      // optimistic-concurrency token rather than guessing at a revision.
      const current = ifMatch ? null : await workbenchApi.getAutomation(automationId);
      const etag = ifMatch || current?.etag;
      if (!etag) throw new WorkbenchApiError({
        code: "automation_etag_unavailable",
        message: "Reload the Automation before saving changes.",
      });
      return workbenchApi.reviseAutomation(
        automationId,
        data,
        { ifMatch: etag, idempotencyKey },
      );
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.automation(principal, variables.automationId), result);
      return refresh(variables.automationId);
    },
  });
  const transitionAutomation = useMutation({
    async mutationFn({ automationId, transition, ifMatch, idempotencyKey }) {
      // The list projection is deliberately product-safe and omits the ETag.
      // Resolve the canonical Automation before transition so stale cards fail
      // closed instead of writing with an inferred revision.
      const current = ifMatch ? null : await workbenchApi.getAutomation(automationId);
      const etag = ifMatch || current?.etag;
      if (!etag) throw new WorkbenchApiError({
        code: "automation_etag_unavailable",
        message: "Reload the Automation before changing its state.",
      });
      return workbenchApi.transitionAutomation(
        automationId,
        transition,
        { ifMatch: etag, idempotencyKey },
      );
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(workbenchKeys.automation(principal, variables.automationId), result);
      return refresh(variables.automationId);
    },
  });
  return { reviseScopePolicy, createAutomation, reviseAutomation, transitionAutomation };
}

export function useAttachmentMutations() {
  const queryClient = useQueryClient();
  const createAttachment = useMutation({
    async mutationFn({ file, ttlSeconds, idempotencyKey }) {
      if (!(file instanceof File)) throw new WorkbenchApiError({
        code: "attachment_file_required",
        message: "Choose a file to attach.",
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const mediaType = file.type || ATTACHMENT_MEDIA_BY_EXTENSION[extension] || "";
      return workbenchApi.createAttachment({
        fileName: file.name,
        mediaType,
        contentBase64: encodeBytesBase64(bytes),
        ...(ttlSeconds ? { ttlSeconds } : {}),
      }, { idempotencyKey });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench", "attachments"] }),
  });
  const retryAttachment = useMutation({
    mutationFn: ({ attachmentId, idempotencyKey }) => (
      workbenchApi.retryAttachment(attachmentId, { idempotencyKey })
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench", "attachments"] }),
  });
  const deleteAttachment = useMutation({
    mutationFn: ({ attachmentId, idempotencyKey }) => (
      workbenchApi.deleteAttachment(attachmentId, { idempotencyKey })
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench", "attachments"] }),
  });
  return { createAttachment, retryAttachment, deleteAttachment };
}

export function useRunInvocationsQuery(runId, enabled = true, { pollWhileRunActive = false } = {}) {
  return useQuery({
    queryKey: workbenchKeys.runInvocations(runId),
    queryFn: () => workbenchApi.listRunInvocations(runId),
    enabled: enabled && Boolean(runId),
    refetchInterval(query) {
      if (pollWhileRunActive) return 1_000;
      const active = query.state.data?.data?.some((item) => !["completed", "failed", "cancelled", "blocked"].includes(item.status));
      return active ? 1_000 : false;
    },
  });
}

export function useRunExecutionEventsQuery(runId, query = {}, enabled = true, { pollWhileRunActive = false } = {}) {
  return useQuery({
    queryKey: workbenchKeys.runExecutionEvents(runId, query),
    queryFn: () => workbenchApi.listRunExecutionEvents(runId, query),
    enabled: enabled && Boolean(runId),
    refetchInterval: pollWhileRunActive ? 1_500 : false,
  });
}

export function useArtifactQuery(artifactId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.artifact(artifactId),
    queryFn: () => workbenchApi.getArtifact(artifactId),
    enabled: enabled && Boolean(artifactId),
    staleTime: Infinity,
  });
}

export function useAgentMutations() {
  const queryClient = useQueryClient();
  const createSession = useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createAgentSession(data, { idempotencyKey }),
    onSuccess(result, variables) {
      queryClient.setQueryData(workbenchKeys.agentSession(variables.principal, result.data.sessionId), result);
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
    },
  });
  const selectModel = useMutation({
    mutationFn: ({ sessionId, modelProfileId, idempotencyKey }) => (
      workbenchApi.selectAgentSessionModel(sessionId, { modelProfileId }, { idempotencyKey })
    ),
    onSuccess(result, variables) {
      queryClient.setQueryData(workbenchKeys.agentSession(variables.principal, variables.sessionId), result);
    },
  });
  const createTurn = useMutation({
    mutationFn: ({ sessionId, data, idempotencyKey }) => workbenchApi.createAgentTurn(sessionId, data, { idempotencyKey }),
    onSuccess(result, variables) {
      queryClient.setQueryData(workbenchKeys.agentTurn(variables.principal, variables.sessionId, result.data.turnId), result);
      queryClient.invalidateQueries({
        queryKey: ["workbench", "agent-turns", variables.principal, variables.sessionId],
      });
      queryClient.invalidateQueries({ queryKey: workbenchKeys.agentSession(variables.principal, variables.sessionId) });
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
    },
  });
  const cancelTurn = useMutation({
    mutationFn: ({ sessionId, turnId, data, idempotencyKey }) => (
      workbenchApi.cancelAgentTurn(sessionId, turnId, data, { idempotencyKey })
    ),
    onSuccess(result, variables) {
      queryClient.setQueryData(workbenchKeys.agentTurn(variables.principal, variables.sessionId, variables.turnId), result);
      queryClient.invalidateQueries({
        queryKey: ["workbench", "agent-turns", variables.principal, variables.sessionId],
      });
      queryClient.invalidateQueries({ queryKey: workbenchKeys.agentSession(variables.principal, variables.sessionId) });
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
    },
  });
  const applyProposal = useMutation({
    mutationFn: ({ sessionId, proposalId, idempotencyKey }) => (
      workbenchApi.applyAgentProposal(sessionId, proposalId, { idempotencyKey })
    ),
    onSuccess(result, variables) {
      queryClient.setQueryData(
        workbenchKeys.agentProposal(
          variables.principal,
          variables.sessionId,
          variables.proposalId,
        ),
        result,
      );
      queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] });
      queryClient.invalidateQueries({ queryKey: ["workbench", "skills"] });
      queryClient.invalidateQueries({ queryKey: ["workbench", "workflows"] });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.agentSession(variables.principal, variables.sessionId),
      });
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
    },
  });
  const rejectProposal = useMutation({
    mutationFn: ({ sessionId, proposalId, idempotencyKey }) => (
      workbenchApi.rejectAgentProposal(sessionId, proposalId, { idempotencyKey })
    ),
    onSuccess(result, variables) {
      queryClient.setQueryData(
        workbenchKeys.agentProposal(
          variables.principal,
          variables.sessionId,
          variables.proposalId,
        ),
        result,
      );
      queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.agentSession(variables.principal, variables.sessionId),
      });
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
    },
  });
  return {
    createSession,
    selectModel,
    createTurn,
    cancelTurn,
    applyProposal,
    rejectProposal,
  };
}

export function useWorkItemPromotionParticipantsQuery(principal = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workItemPromotionParticipants(principal),
    queryFn: () => workbenchApi.listWorkItemPromotionParticipants(),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
}

export function useProjectsQuery(principal = {}, query = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.projects(principal, query),
    queryFn: ({ signal }) => workbenchApi.listProjects(query, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

export function useProjectDetailQuery(principal = {}, projectId = "", enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.project(principal, projectId),
    queryFn: ({ signal }) => workbenchApi.getProject(projectId, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId && projectId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry(failureCount, error) {
      return error?.code !== "project_not_found" && failureCount < 2;
    },
  });
}

export function useWorkItemsQuery(principal = {}, query = {}, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workItems(principal, query),
    queryFn: ({ signal }) => workbenchApi.listWorkItems(query, { signal }),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

function invalidateTeamWork(queryClient, principal, { projectId, workItemId } = {}) {
  queryClient.invalidateQueries({ queryKey: ["workbench", "projects", principal] });
  queryClient.invalidateQueries({ queryKey: ["workbench", "work-items", principal] });
  if (projectId) queryClient.invalidateQueries({ queryKey: workbenchKeys.project(principal, projectId) });
  if (workItemId) {
    queryClient.invalidateQueries({ queryKey: workbenchKeys.workItem(principal, workItemId) });
    queryClient.invalidateQueries({ queryKey: workbenchKeys.workItemThread(principal, workItemId) });
  }
}

export function useTeamWorkMutations() {
  const queryClient = useQueryClient();
  return {
    createProject: useMutation({
      mutationFn: ({ data, idempotencyKey }) => workbenchApi.createProject(data, { idempotencyKey }),
      onSuccess(result, variables) {
        invalidateTeamWork(queryClient, variables.principal, { projectId: result.data.projectId });
      },
    }),
    reviseProjectMembers: useMutation({
      mutationFn: ({ projectId, data, ifMatch, idempotencyKey }) => (
        workbenchApi.reviseProjectMembers(projectId, data, { ifMatch, idempotencyKey })
      ),
      onSuccess(_result, variables) {
        invalidateTeamWork(queryClient, variables.principal, { projectId: variables.projectId });
      },
    }),
    createTeamWorkItem: useMutation({
      mutationFn: ({ data, idempotencyKey }) => workbenchApi.createTeamWorkItem(data, { idempotencyKey }),
      onSuccess(result, variables) {
        invalidateTeamWork(queryClient, variables.principal, {
          projectId: result.data.projectId || variables.data.projectId || "",
          workItemId: result.data.workItemId,
        });
      },
    }),
    createTeamWorkItemAgentEntry: useMutation({
      mutationFn: ({ data, idempotencyKey }) => (
        workbenchApi.createTeamWorkItemAgentEntry(data, { idempotencyKey })
      ),
      onSuccess(result, variables) {
        invalidateTeamWork(queryClient, variables.principal, {
          projectId: result.data.workItem.projectId || variables.data.projectId || "",
          workItemId: result.data.workItem.workItemId,
        });
        queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions", variables.principal] });
      },
    }),
    updateTeamWorkItem: useMutation({
      mutationFn: ({ workItemId, data, ifMatch, idempotencyKey }) => (
        workbenchApi.updateTeamWorkItem(workItemId, data, { ifMatch, idempotencyKey })
      ),
      onSuccess(result, variables) {
        invalidateTeamWork(queryClient, variables.principal, {
          projectId: result.data.projectId || "",
          workItemId: variables.workItemId,
        });
      },
    }),
  };
}

export function useWorkItemDetailQuery(principal = {}, workItemId = "", enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workItem(principal, workItemId),
    queryFn: () => workbenchApi.getWorkItem(workItemId),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId && workItemId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry(failureCount, error) {
      return error?.code !== "work_item_not_found" && failureCount < 2;
    },
  });
}

export function useWorkItemThreadEntriesQuery(principal = {}, workItemId = "", enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.workItemThread(principal, workItemId),
    queryFn: () => workbenchApi.listWorkItemThreadEntries(workItemId),
    enabled: enabled && Boolean(principal.workspaceId && principal.userId && workItemId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry(failureCount, error) {
      return error?.code !== "work_item_not_found" && failureCount < 2;
    },
  });
}

export function useRecentWorkItemThreadQuery(principal = {}, workItemId = "") {
  return useInfiniteQuery({
    queryKey: [...workbenchKeys.workItemThread(principal, workItemId), "recent"],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => workbenchApi.listWorkItemThreadEntries(workItemId,
      { order: "desc", limit: 10, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (lastPage) => lastPage.page?.hasMore ? lastPage.page.nextCursor : undefined,
    enabled: Boolean(principal.workspaceId && principal.userId && workItemId),
    refetchInterval: 5000,
    retry: (count, error) => error?.code !== "work_item_not_found" && count < 2,
  });
}

export function useWorkItemPromotionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, data, idempotencyKey }) => (
      workbenchApi.promoteAgentSessionToWorkItem(sessionId, data, { idempotencyKey })
    ),
    onSuccess(_result, variables) {
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItemPromotionParticipants(variables.principal),
      });
    },
  });
}

export function useWorkItemContinuationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workItemId, idempotencyKey }) => (
      workbenchApi.createWorkItemContinuation(workItemId, { idempotencyKey })
    ),
    onSuccess(_result, variables) {
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItem(variables.principal, variables.workItemId),
      });
    },
  });
}

export function useWorkItemContinuationAgentEntryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workItemId, data, idempotencyKey }) => (
      workbenchApi.createWorkItemContinuationAgentEntry(workItemId, data, { idempotencyKey })
    ),
    onSuccess(result, variables) {
      queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItem(variables.principal, variables.workItemId),
      });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItemThread(variables.principal, variables.workItemId),
      });
      return result;
    },
  });
}

export function useWorkItemThreadCommentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workItemId, data, idempotencyKey }) => (
      workbenchApi.createWorkItemThreadComment(workItemId, data, { idempotencyKey })
    ),
    onSuccess(_result, variables) {
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItemThread(variables.principal, variables.workItemId),
      });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItem(variables.principal, variables.workItemId),
      });
    },
  });
}

export function useWorkItemDecisionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workItemId, data, idempotencyKey }) => (
      workbenchApi.recordWorkItemDecision(workItemId, data, { idempotencyKey })
    ),
    onSuccess(_result, variables) {
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItemThread(variables.principal, variables.workItemId),
      });
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.workItem(variables.principal, variables.workItemId),
      });
    },
  });
}

export function useSkillsQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skills(),
    queryFn: () => workbenchApi.listSkills(),
    enabled,
  });
}

export function useSkillRuntimesQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.skillRuntimes,
    queryFn: () => workbenchApi.listSkillRuntimes(),
    enabled,
    staleTime: 60_000,
  });
}

export function useRegisteredToolPackagesQuery(enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.registeredToolPackages,
    queryFn: () => workbenchApi.listRegisteredToolPackages(),
    enabled,
    staleTime: 60_000,
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

export function useSkillTestRunQuery(skillId, testRunId) {
  return useQuery({
    queryKey: workbenchKeys.skillTestRun(skillId, testRunId),
    queryFn: () => workbenchApi.getSkillTestRun(skillId, testRunId),
    enabled: Boolean(skillId && testRunId),
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status;
      return !status || ["queued", "running"].includes(status) ? 1_500 : false;
    },
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

export async function loadWorkflowConflictSnapshot(workflowId) {
  const workflow = await workbenchApi.getWorkflow(workflowId);
  const revision = await workbenchApi.getWorkflowRevision(workflowId, workflow.data.currentRevisionId);
  return { revision: revision.data, etag: workflow.etag };
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

export function useInstallationUpdateImpactQuery(installationId, releaseId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.installationUpdateImpact(installationId, releaseId),
    queryFn: ({ signal }) => workbenchApi.getInstallationUpdateImpact(
      installationId,
      releaseId,
      { signal },
    ),
    enabled: enabled && Boolean(installationId && releaseId),
  });
}

export function useInstallationUpdateDraftQuery(updateDraftId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.installationUpdateDraft(updateDraftId),
    queryFn: ({ signal }) => workbenchApi.getInstallationUpdateDraft(
      updateDraftId,
      { signal },
    ),
    enabled: enabled && Boolean(updateDraftId),
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
  const refreshConnections = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: workbenchKeys.connections() }),
    queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] }),
  ]);
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
  const bindConnectionCredential = useMutation({
    async mutationFn({ connectionId, secretRef, ifMatch, idempotencyKey }) {
      const etag = ifMatch || (await workbenchApi.getConnection(connectionId)).etag;
      return workbenchApi.bindConnectionCredential(connectionId, secretRef, {
        ifMatch: etag,
        idempotencyKey,
      });
    },
    onSuccess: refreshConnections,
  });
  return { createConnection, updateConnection, bindConnectionCredential, validateConnection };
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
    refetchInterval: workflowRunsRefetchInterval,
  });
}

export function useRunQuery(runId, enabled = true) {
  return useQuery({
    queryKey: workbenchKeys.run(runId),
    queryFn: () => workbenchApi.getRun(runId),
    enabled: enabled && Boolean(runId),
    // SSE is the primary update path. Poll only non-terminal Runs so a proxy or
    // transient EventSource disconnect cannot leave the review surface stale.
    refetchInterval: runRefetchInterval,
  });
}

export function workflowRunsRefetchInterval(query) {
  const active = query.state.data?.data?.some((run) => !isTerminalRunStatus(run.status));
  return active ? 1_000 : false;
}

export function runRefetchInterval(query) {
  const status = query.state.data?.data?.run?.status;
  return status && !isTerminalRunStatus(status) ? 1_000 : false;
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
  const createSkill = useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createSkill(data, { idempotencyKey }),
    onSuccess: refreshCatalogs,
  });
  const createResource = useMutation({
    mutationFn: ({ data, idempotencyKey }) => workbenchApi.createResource(data, { idempotencyKey }),
    onSuccess: refreshCatalogs,
  });
  const createResourceFromAttachment = useMutation({
    mutationFn: ({ data, idempotencyKey }) => (
      workbenchApi.createResourceFromAttachment(data, { idempotencyKey })
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench", "resources"] }),
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
  const scaffoldSkillDraftPackage = useMutation({
    mutationFn: ({ data, idempotencyKey }) => (
      workbenchApi.scaffoldSkillDraftPackage(data, { idempotencyKey })
    ),
  });
  const importSkillRepository = useMutation({
    mutationFn: importSkillRepositoryPackage,
  });
  const scanServerSkills = useMutation({
    mutationFn: ({ data }) => workbenchApi.scanServerSkills(data),
  });
  const importServerSkills = useMutation({
    mutationFn: ({ data, idempotencyKey }) => (
      workbenchApi.importServerSkills(data, { idempotencyKey })
    ),
    onSuccess: refreshCatalogs,
  });
  const createSkillFromInspectedPackage = useMutation({
    async mutationFn({ inspected, permissionAcknowledged, idempotencyKey }) {
      const supplied = inspected.metadata || {};
      const manifest = inspected.upload?.inspection?.manifest || {};
      const data = {
        name: String(supplied.name || manifest.name || "").trim(),
        description: String(supplied.description || manifest.description || "").trim(),
        category: String(supplied.category || "other").trim() || "other",
      };
      if (!data.name || !data.description) {
        throw new WorkbenchApiError({
          code: "skill_manifest_identity_missing",
          message: "The inspected SKILL.md must declare a name and description.",
        });
      }
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
  const generateStagedLoopProposal = useMutation({
    mutationFn: ({ data, idempotencyKey }) => (
      workbenchApi.generateStagedLoopProposal(data, { idempotencyKey })
    ),
  });
  const loadStagedLoopProposal = useMutation({
    mutationFn: ({ proposalId }) => workbenchApi.getStagedLoopProposal(proposalId),
  });
  const commitStagedLoopProposal = useMutation({
    mutationFn: ({ proposalId, data, idempotencyKey }) => (
      workbenchApi.commitStagedLoopProposal(proposalId, data, { idempotencyKey })
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
  const dismissStagedLoopProposal = useMutation({
    mutationFn: ({ proposalId, idempotencyKey }) => (
      workbenchApi.dismissStagedLoopProposal(proposalId, { idempotencyKey })
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
  const startLoopAgentTask = useMutation({
    async mutationFn({ workflowId, data, idempotencyKey }) {
      let resolved = data;
      if (!resolved?.workflowRevisionId) {
        const workflow = await workbenchApi.getWorkflow(workflowId);
        resolved = {
          workflowRevisionId: workflow.data.currentRevisionId,
          inputs: {},
          resourceRefs: [],
          ...(data || {}),
        };
      }
      const compiled = await workbenchApi.compileWorkflow(
        workflowId,
        resolved.workflowRevisionId,
        { idempotencyKey: `${idempotencyKey}:compile` },
      );
      if (compiled.data?.status !== "ready") {
        const diagnostics = compiled.data?.warnings || [];
        throw new WorkbenchApiError({
          code: "workflow_not_ready",
          message: diagnostics.find((item) => item.severity === "error")?.message
            || diagnostics[0]?.message || "This Loop needs changes before it can run.",
          details: { diagnostics },
        });
      }
      return workbenchApi.startLoopAgentTask(
        workflowId,
        resolved,
        { idempotencyKey: `${idempotencyKey}:start` },
      );
    },
    onSuccess(result, variables) {
      queryClient.setQueryData(
        workbenchKeys.agentSession({
          userId: result.data.session.userId,
          workspaceId: result.data.session.workspaceId,
        }, result.data.session.sessionId),
        { data: result.data.session },
      );
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workbench", "agent-sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["workbench", "runs", variables.workflowId] }),
      ]);
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
  const createLoopFromRelease = useMutation({
    async mutationFn({ releaseId, idempotencyKey }) {
      const created = await workbenchApi.createLoopFromRelease(releaseId, {}, { idempotencyKey });
      const detail = await workbenchApi.getWorkflow(created.data.workflow.workflowId);
      return { ...created, etag: detail.etag };
    },
    onSuccess: refreshCatalogs,
  });
  const createInstallationUpdateDraft = useMutation({
    mutationFn: ({ installationId, releaseId, connectionBindings = [], idempotencyKey }) => (
      workbenchApi.createInstallationUpdateDraft(
        installationId,
        { releaseId, connectionBindings },
        { idempotencyKey },
      )
    ),
    onSuccess(result) {
      queryClient.setQueryData(
        workbenchKeys.installationUpdateDraft(result.data.updateDraftId),
        result,
      );
      return Promise.all([
        refreshCatalogs(),
        queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] }),
      ]);
    },
  });
  const refreshInstallationUpdateDraft = useMutation({
    mutationFn: ({ updateDraftId, connectionBindings, idempotencyKey }) => (
      workbenchApi.refreshInstallationUpdateDraft(
        updateDraftId,
        connectionBindings ? { connectionBindings } : {},
        { idempotencyKey },
      )
    ),
    onSuccess(result) {
      queryClient.setQueryData(
        workbenchKeys.installationUpdateDraft(result.data.updateDraftId),
        result,
      );
      return queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] });
    },
  });
  const confirmInstallationUpdateDraft = useMutation({
    mutationFn: ({ updateDraftId, connectionBindings, idempotencyKey }) => (
      workbenchApi.confirmInstallationUpdateDraft(
        updateDraftId,
        connectionBindings ? { connectionBindings } : {},
        { idempotencyKey },
      )
    ),
    onSuccess() {
      return Promise.all([
        refreshCatalogs(),
        queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] }),
      ]);
    },
  });
  const keepCurrentInstallationVersion = useMutation({
    mutationFn: ({ updateDraftId, idempotencyKey }) => (
      workbenchApi.keepCurrentInstallationVersion(updateDraftId, { idempotencyKey })
    ),
    onSuccess() {
      return Promise.all([
        refreshCatalogs(),
        queryClient.invalidateQueries({ queryKey: ["workbench", "inbox"] }),
      ]);
    },
  });
  return {
    createLoop, createSkill, createResource, createResourceFromAttachment, publishSkill, createSkillUpdateDraft, deprecateSkill, inspectSkillPackage, scaffoldSkillDraftPackage, importSkillRepository, scanServerSkills, importServerSkills, createSkillFromInspectedPackage, updateSkillDraft, replaceSkillDraftPackage, runSkillTest, validateSkill, saveRevision, loadStagedLoopProposal, generateStagedLoopProposal, commitStagedLoopProposal, dismissStagedLoopProposal, compile, publishLoop, startRun, startLoopAgentTask, review, cancelRun, retryRun,
    installTeamRelease,
    createLoopFromRelease,
    createInstallationUpdateDraft,
    refreshInstallationUpdateDraft,
    confirmInstallationUpdateDraft,
    keepCurrentInstallationVersion,
  };
}
