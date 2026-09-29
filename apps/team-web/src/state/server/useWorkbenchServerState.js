import {
  loadSkillDraftConflictSnapshot,
  useActiveSessionQuery,
  useConnectionsQuery,
  useRunQuery,
  useResourcesQuery,
  useRegisteredToolPackagesQuery,
  useSkillAssetsQuery,
  useSkillDraftQuery,
  useSkillRuntimesQuery,
  useInstallationsQuery,
  useSkillsQuery,
  useTemplatesQuery,
  useTeamLibraryQuery,
  useWorkbenchMutations,
  useWorkflowQuery,
  useWorkflowRevisionQuery,
  useWorkflowRunsQuery,
  useWorkflowsQuery,
  useWorkspaceBootstrap,
  useWorkspaceFeatureReadiness,
} from "../../api/queries.js";

const featureNeeds = Object.freeze({
  skills: new Set(["skills", "builder", "library"]),
  skillAssets: new Set(["skills", "builder", "library"]),
  skillRuntimes: new Set(["skills"]),
  registeredToolPackages: new Set(["skills"]),
  templates: new Set(["loops", "builder"]),
  teamLibrary: new Set(["library", "loops"]),
  installations: new Set(["library"]),
  resources: new Set(["builder"]),
  workflows: new Set(["loops", "builder", "runs", "library"]),
  workflow: new Set(["loops", "builder", "runs"]),
  runs: new Set(["loops", "builder", "runs"]),
  run: new Set(["runs"]),
});

function featureEnabled(feature, resource) {
  return featureNeeds[resource]?.has(feature) === true;
}

export function useWorkbenchServerState({
  feature = "loops",
  activePage = "",
  selectedWorkflowId,
  selectedManagedSkillId,
  activeRunId,
} = {}) {
  const bootstrap = useWorkspaceBootstrap();
  const enabled = bootstrap.isSuccess;
  const featureReadiness = useWorkspaceFeatureReadiness(enabled);
  const activeSession = useActiveSessionQuery(enabled);
  const capabilities = bootstrap.data?.data?.workspace?.capabilities || {};
  const needsRunPreflight = feature === "loops" && activePage === "run-preflight";
  const needsSkillTestMaterials = feature === "skills"
    && ["skill-tests", "create-skill"].includes(activePage);
  const skills = useSkillsQuery(enabled && featureEnabled(feature, "skills"));
  const skillAssets = useSkillAssetsQuery(enabled && featureEnabled(feature, "skillAssets"));
  const skillRuntimes = useSkillRuntimesQuery(enabled && featureEnabled(feature, "skillRuntimes"));
  const registeredToolPackages = useRegisteredToolPackagesQuery(
    enabled && featureEnabled(feature, "registeredToolPackages"),
  );
  const selectedSkillAsset = skillAssets.data?.data?.find((item) => item.skill?.skillId === selectedManagedSkillId);
  const selectedSkillDraftId = selectedSkillAsset?.skill?.currentDraftId || selectedSkillAsset?.draft?.skillDraftId || "";
  const skillDraft = useSkillDraftQuery(
    selectedManagedSkillId,
    selectedSkillDraftId,
    enabled && feature === "skills",
  );
  const templates = useTemplatesQuery(enabled && featureEnabled(feature, "templates"));
  const teamLibrary = useTeamLibraryQuery(enabled && featureEnabled(feature, "teamLibrary"));
  const installations = useInstallationsQuery(enabled && featureEnabled(feature, "installations"));
  const resources = useResourcesQuery(
    enabled
      && capabilities.resources === true
      && (featureEnabled(feature, "resources") || needsRunPreflight || needsSkillTestMaterials),
  );
  const connections = useConnectionsQuery(enabled && needsSkillTestMaterials);
  const workflows = useWorkflowsQuery(enabled && featureEnabled(feature, "workflows"));
  const workflow = useWorkflowQuery(
    selectedWorkflowId,
    enabled && featureEnabled(feature, "workflow"),
  );
  const revisionId = workflow.data?.data?.currentRevisionId
    || workflows.data?.data?.find((item) => item.workflowId === selectedWorkflowId)?.currentRevisionId
    || "";
  const revision = useWorkflowRevisionQuery(
    selectedWorkflowId,
    revisionId,
    enabled && featureEnabled(feature, "workflow"),
  );
  const runs = useWorkflowRunsQuery(
    selectedWorkflowId,
    enabled && featureEnabled(feature, "runs"),
  );
  const run = useRunQuery(activeRunId, enabled && featureEnabled(feature, "run"));
  const mutations = useWorkbenchMutations();
  const queries = [bootstrap, featureReadiness, activeSession, skills, skillAssets, skillRuntimes, registeredToolPackages, skillDraft, templates, teamLibrary, installations, resources, connections, workflows, workflow, revision, runs, run];
  const surfaceQueries = {
    skills: [skills, skillAssets, skillRuntimes, registeredToolPackages],
    skill: [skillAssets, skillDraft],
    loops: [workflows, templates],
    workflow: [workflow, revision],
    preflight: [workflow, revision, resources],
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
    featureReadiness: featureReadiness.data?.data || null,
    featureReadinessState: {
      loading: featureReadiness.isLoading,
      error: featureReadiness.error || null,
      retry: featureReadiness.refetch,
    },
    skills: skills.data?.data || [],
    skillAssets: skillAssets.data?.data || [],
    skillRuntimes: skillRuntimes.data?.data || [],
    skillRuntimesState: {
      loading: skillRuntimes.isLoading,
      error: skillRuntimes.error || null,
      retry: skillRuntimes.refetch,
    },
    registeredToolPackages: registeredToolPackages.data?.data || [],
    registeredToolPackagesState: {
      loading: registeredToolPackages.isLoading,
      error: registeredToolPackages.error || null,
      retry: registeredToolPackages.refetch,
    },
    skillDraft: skillDraft.data?.data || null,
    skillDraftEtag: skillDraft.data?.etag || "",
    templates: templates.data?.data || [],
    teamLibrary: teamLibrary.data?.data || [],
    installations: installations.data?.data || [],
    resources: resources.data?.data || [],
    connections: connections.data?.data || [],
    workflows: workflows.data?.data || [],
    workflow: workflow.data?.data || null,
    workflowEtag: workflow.data?.etag || revision.data?.etag || "",
    revision: revision.data?.data || null,
    runs: runs.data?.data || [],
    runDetail: run.data?.data || null,
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
    loading: bootstrap.isLoading || featureReadiness.isLoading || activeSession.isLoading,
    fetching: queries.some((query) => query.isFetching),
    error: bootstrap.error || featureReadiness.error || activeSession.error || null,
    retry() {
      return Promise.all([bootstrap.refetch(), featureReadiness.refetch(), activeSession.refetch()]);
    },
    retrySurface(name) {
      return Promise.all((surfaceQueries[name] || []).filter((query) => query.error).map((query) => query.refetch()));
    },
  };
}
