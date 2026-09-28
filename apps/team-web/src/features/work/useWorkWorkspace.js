import { useEffect, useMemo, useState } from "react";

import {
  useProjectsQuery,
  useProjectDetailQuery,
  useTeamWorkMutations,
  useWorkItemDetailQuery,
  useWorkItemPromotionParticipantsQuery,
  useWorkItemsQuery,
} from "../../api/queries.js";
import { useShellWorkspace } from "../shell/useShellWorkspace.js";

const WORK_FILTERS = new Set(["all", "my", "active", "blocked", "review", "completed"]);

function sameRouteQuery() {
  return new URLSearchParams(globalThis.location?.search || "");
}

function normalizeWorkFilter(value) {
  return WORK_FILTERS.has(value) ? value : "all";
}

function replaceQuery(workspace, change) {
  const target = new URL(globalThis.location?.href || "http://localhost/work");
  target.pathname = "/work";
  change(target.searchParams);
  workspace.navigateToPath(`${target.pathname}${target.search}${target.hash}`, { replace: true });
}

export function useWorkWorkspace({ preferenceScope = "anonymous", navigationKey = "" } = {}) {
  const shell = useShellWorkspace({ preferenceScope });
  const principal = shell.session?.userId && shell.serverState?.workspace?.workspaceId
    ? { userId: shell.session.userId, workspaceId: shell.serverState.workspace.workspaceId }
    : { userId: "", workspaceId: "" };
  const enabled = Boolean(principal.userId && principal.workspaceId);
  const projects = useProjectsQuery(principal, { status: "active", limit: 100 }, enabled);
  const workItems = useWorkItemsQuery(principal, { limit: 100 }, enabled);
  const participants = useWorkItemPromotionParticipantsQuery(principal, enabled);
  const mutations = useTeamWorkMutations();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState("");
  const [createMode, setCreateMode] = useState("");
  const [workFilter, setWorkFilter] = useState("all");
  const selectedProjectDetail = useProjectDetailQuery(
    principal,
    selectedProjectId,
    enabled && Boolean(selectedProjectId),
  );
  const selectedWorkItemDetail = useWorkItemDetailQuery(
    principal,
    selectedWorkItemId,
    enabled && Boolean(selectedWorkItemId),
  );

  useEffect(() => {
    const params = sameRouteQuery();
    setSelectedProjectId(params.get("project") || "");
    setSelectedWorkItemId(params.get("workItem") || "");
    setCreateMode(params.get("create") === "project" ? "project" : params.get("create") === "work-item" ? "work-item" : "");
    setWorkFilter(normalizeWorkFilter(params.get("view")));
  }, [navigationKey]);

  const listedProjects = projects.data?.data || [];
  const listedWorkItems = workItems.data?.data || [];

  useEffect(() => {
    if (selectedProjectId && projects.isSuccess && !projects.isFetching
      && !listedProjects.some((project) => project.projectId === selectedProjectId)) {
      replaceQuery(shell, (params) => params.delete("project"));
    }
  }, [listedProjects, projects.isFetching, projects.isSuccess, selectedProjectId, shell]);

  useEffect(() => {
    if (selectedWorkItemId && workItems.isSuccess && !workItems.isFetching
      && !listedWorkItems.some((item) => item.workItemId === selectedWorkItemId)) {
      replaceQuery(shell, (params) => params.delete("workItem"));
    }
  }, [listedWorkItems, workItems.isFetching, workItems.isSuccess, selectedWorkItemId, shell]);

  const state = useMemo(() => ({
    loading: projects.isLoading || workItems.isLoading || participants.isLoading,
    fetching: projects.isFetching || workItems.isFetching || participants.isFetching || selectedProjectDetail.isFetching || selectedWorkItemDetail.isFetching,
    error: [projects, workItems, participants].find((query) => query.error && query.data === undefined)?.error || null,
    staleError: [projects, workItems, participants, selectedProjectDetail, selectedWorkItemDetail].find((query) => query.error && query.data !== undefined)?.error || null,
  }), [projects, workItems, participants, selectedProjectDetail, selectedWorkItemDetail]);

  function selectProject(projectId) {
    replaceQuery(shell, (params) => {
      if (projectId) params.set("project", projectId);
      else params.delete("project");
      params.delete("workItem");
    });
  }

  function selectWorkItem(workItemId) {
    replaceQuery(shell, (params) => {
      if (workItemId) params.set("workItem", workItemId);
      else params.delete("workItem");
    });
  }

  function openCreate(mode) {
    replaceQuery(shell, (params) => {
      params.set("create", mode);
      if (mode === "project") params.delete("workItem");
    });
  }

  function closeCreate() {
    replaceQuery(shell, (params) => params.delete("create"));
  }

  function selectWorkFilter(nextFilter) {
    const normalized = normalizeWorkFilter(nextFilter);
    setWorkFilter(normalized);
    replaceQuery(shell, (params) => {
      if (normalized === "all") params.delete("view");
      else params.set("view", normalized);
    });
  }

  function continueInPrivateBranch(workItemId) {
    if (!workItemId) return;
    // The Agent surface displays the safe handoff first, then accepts the
    // first continuation Turn through the atomic Agent-entry endpoint.
    shell.navigateToPath(`/?workItem=${encodeURIComponent(workItemId)}`, { replace: false });
  }

  return {
    ...shell,
    principal,
    teamWorkState: state,
    projects: listedProjects,
    workItems: listedWorkItems,
    selectedProject: selectedProjectDetail.data?.data
      ? { ...selectedProjectDetail.data.data, etag: selectedProjectDetail.data.etag }
      : null,
    selectedProjectState: selectedProjectDetail,
    selectedWorkItem: selectedWorkItemDetail.data?.data?.workItem
      ? { ...selectedWorkItemDetail.data.data.workItem, etag: selectedWorkItemDetail.data.etag }
      : null,
    selectedWorkItemState: selectedWorkItemDetail,
    participantDirectory: participants.data?.data || [],
    selectedProjectId,
    selectedWorkItemId,
    createMode,
    workFilter,
    canCreateProject: ["owner", "admin"].includes(shell.membershipRole),
    canCreateWorkItem: Boolean(shell.membershipRole && shell.membershipRole !== "viewer"),
    teamWorkMutations: mutations,
    selectProject,
    selectWorkItem,
    openCreate,
    closeCreate,
    selectWorkFilter,
    continueInPrivateBranch,
    retry() {
      return Promise.all([shell.retry(), projects.refetch(), workItems.refetch(), participants.refetch()]);
    },
    retryStaleSurface() {
      return Promise.all([projects.refetch(), workItems.refetch(), participants.refetch()]);
    },
  };
}
