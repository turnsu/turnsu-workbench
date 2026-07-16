import {
  loadSkillDraftConflictSnapshot,
  useActiveSessionQuery,
  useRunQuery,
  useResourcesQuery,
  useRunComparisonQuery,
  useSkillAssetsQuery,
  useSkillDraftQuery,
  useInstallationsQuery,
  useLoopSkillUpdatePreviewQuery,
  useSkillsQuery,
  useTemplatesQuery,
  useTeamLibraryQuery,
  useWorkbenchMutations,
  useWorkflowQuery,
  useWorkflowRevisionQuery,
  useWorkflowRunsQuery,
  useWorkflowsQuery,
  useWorkspaceBootstrap,
} from "../../api/queries.js";

export function useWorkbenchServerState({ selectedWorkflowId, selectedManagedSkillId, activeRunId, comparisonRunId, targetSkillVersionId } = {}) {
  const bootstrap = useWorkspaceBootstrap();
  const enabled = bootstrap.isSuccess;
  const activeSession = useActiveSessionQuery(enabled);
  const capabilities = bootstrap.data?.data?.workspace?.capabilities || {};
  const skills = useSkillsQuery(enabled);
  const skillAssets = useSkillAssetsQuery(enabled);
  const selectedSkillAsset = skillAssets.data?.data?.find((item) => item.skill?.skillId === selectedManagedSkillId);
  const selectedSkillDraftId = selectedSkillAsset?.skill?.currentDraftId || selectedSkillAsset?.draft?.skillDraftId || "";
  const skillDraft = useSkillDraftQuery(selectedManagedSkillId, selectedSkillDraftId, enabled);
  const templates = useTemplatesQuery(enabled);
  const teamLibrary = useTeamLibraryQuery(enabled);
  const installations = useInstallationsQuery(enabled);
  const resources = useResourcesQuery(enabled && capabilities.resources === true);
  const workflows = useWorkflowsQuery(enabled);
  const workflow = useWorkflowQuery(selectedWorkflowId, enabled);
  const revisionId = workflow.data?.data?.currentRevisionId
    || workflows.data?.data?.find((item) => item.workflowId === selectedWorkflowId)?.currentRevisionId
    || "";
  const revision = useWorkflowRevisionQuery(selectedWorkflowId, revisionId, enabled);
  const loopSkillUpdatePreview = useLoopSkillUpdatePreviewQuery(
    selectedWorkflowId,
    targetSkillVersionId,
    enabled,
  );
  const runs = useWorkflowRunsQuery(selectedWorkflowId, enabled);
  const run = useRunQuery(activeRunId, enabled);
  const runComparison = useRunComparisonQuery(activeRunId, comparisonRunId, enabled);
  const mutations = useWorkbenchMutations();
  const queries = [bootstrap, activeSession, skills, skillAssets, skillDraft, templates, teamLibrary, installations, resources, workflows, workflow, revision, loopSkillUpdatePreview, runs, run, runComparison];
  const surfaceQueries = {
    skills: [skills, skillAssets],
    skill: [skillAssets, skillDraft],
    loops: [workflows, templates],
    workflow: [workflow, revision],
    loopUpdate: [loopSkillUpdatePreview],
    run: [run],
    library: [teamLibrary, installations],
  };
  const surfaceState = Object.fromEntries(Object.entries(surfaceQueries).map(([name, items]) => [name, {
    loading: items.some((query) => query.isLoading),
    fetching: items.some((query) => query.isFetching),
    error: items.find((query) => query.error && query.data === undefined)?.error || null,
    staleError: items.find((query) => query.error && query.data !== undefined)?.error || null,
  }]));
  const staleSurface = Object.entries(surfaceState).find(([, state]) => state.staleError) || null;

  return {
    bootstrap,
    workspace: bootstrap.data?.data?.workspace || null,
    session: activeSession.data?.data?.session || null,
    membership: activeSession.data?.data?.membership || null,
    capabilities,
    skills: skills.data?.data || [],
    skillAssets: skillAssets.data?.data || [],
    skillDraft: skillDraft.data?.data || null,
    skillDraftEtag: skillDraft.data?.etag || "",
    templates: templates.data?.data || [],
    teamLibrary: teamLibrary.data?.data || [],
    installations: installations.data?.data || [],
    resources: resources.data?.data || [],
    workflows: workflows.data?.data || [],
    workflow: workflow.data?.data || null,
    workflowEtag: workflow.data?.etag || revision.data?.etag || "",
    revision: revision.data?.data || null,
    loopSkillUpdatePreview: loopSkillUpdatePreview.data?.data || null,
    loopSkillUpdatePreviewEtag: loopSkillUpdatePreview.data?.etag || "",
    runs: runs.data?.data || [],
    runDetail: run.data?.data || null,
    runComparison: runComparison.data?.data || null,
    revisionId,
    surfaceState,
    staleSurfaceName: staleSurface?.[0] || "",
    staleSurfaceError: staleSurface?.[1]?.staleError || null,
    mutations,
    inspectSkillPackage: mutations.inspectSkillPackage,
    importSkillRepository: mutations.importSkillRepository,
    reloadSkillDraft() {
      return skillDraft.refetch();
    },
    reloadWorkflow() {
      return workflow.refetch();
    },
    loadSkillDraftConflictSnapshot,
    reloadLoopSkillUpdatePreview() {
      return loopSkillUpdatePreview.refetch();
    },
    loading: bootstrap.isLoading || activeSession.isLoading,
    fetching: queries.some((query) => query.isFetching),
    error: bootstrap.error || activeSession.error || null,
    retry() {
      return Promise.all([bootstrap.refetch(), activeSession.refetch()]);
    },
    retrySurface(name) {
      return Promise.all((surfaceQueries[name] || []).filter((query) => query.error).map((query) => query.refetch()));
    },
  };
}
