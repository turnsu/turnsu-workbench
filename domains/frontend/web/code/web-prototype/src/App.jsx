import { WorkspaceShell } from "./components/shell/WorkspaceShell.jsx";
import { TeamLibraryView } from "./components/library/TeamLibraryView.jsx";
import { TeamLibraryLoopView } from "./components/library/TeamLibraryLoopView.jsx";
import { TeamLibrarySkillView } from "./components/library/TeamLibrarySkillView.jsx";
import { LoopsBoardView } from "./components/loops/LoopsBoardView.jsx";
import { LoopOverviewView } from "./components/loops/LoopOverviewView.jsx";
import { LoopPublishView } from "./components/loops/LoopPublishView.jsx";
import { LoopSkillUpdateView } from "./components/loops/LoopSkillUpdateView.jsx";
import { CreateLoopView } from "./components/loops/CreateLoopView.jsx";
import { LoopImportDialog } from "./components/loops/LoopImportDialog.jsx";
import { RunDetailsView } from "./components/runs/RunDetailsView.jsx";
import { RunPreflightView } from "./components/runs/RunPreflightView.jsx";
import { SkillsView } from "./components/skills/SkillsView.jsx";
import { SkillLifecycleView } from "./components/skills/SkillLifecycleView.jsx";
import { CreateSkillDialog } from "./components/skills/CreateSkillDialog.jsx";
import { TemplatesBuilderView } from "./components/templates/TemplatesBuilderView.jsx";
import { CreateResourceDialog } from "./components/resources/CreateResourceDialog.jsx";
import { EmptyState } from "./components/shared/EmptyState.jsx";
import { ObjectQueryState } from "./components/shared/ObjectQueryState.jsx";
import { useWorkbenchWorkspace } from "./state/useWorkbenchWorkspace.js";

function withQueryState(workspace, name, objectLabel, surface, testId, backPage = null) {
  const state = workspace.surfaceState?.[name];
  if (!state?.loading && !state?.error) return surface;
  return (
    <ObjectQueryState
      workspace={workspace}
      state={state}
      objectLabel={objectLabel}
      onRetry={() => workspace.retrySurface(name)}
      onRequestAccess={workspace.requestWorkspaceAccess}
      onBack={backPage ? () => workspace.setActivePage(backPage) : null}
      backLabel={backPage ? workspace.t(backPage === "skills" ? "actions.backToSkills" : "actions.openLoops") : null}
      testId={testId}
    />
  );
}

function CurrentSurface({ workspace }) {
  switch (workspace.activePage) {
    case "loops":
    case "workflows":
      return withQueryState(workspace, "loops", workspace.t("page.loops.title"), <LoopsBoardView workspace={workspace} />, "loopops.loops.query-state");
    case "runs":
      return <RunDetailsView workspace={workspace} />;
    case "loop-overview":
      return <LoopOverviewView workspace={workspace} />;
    case "run-preflight":
      return <RunPreflightView workspace={workspace} />;
    case "loop-publish":
      return withQueryState(workspace, "workflow", workspace.t("object.loopWorkflow"), <LoopPublishView workspace={workspace} />, "loopops.publish.query-state", "loops");
    case "loop-update":
      return withQueryState(workspace, "loopUpdate", workspace.t("loopUpdate.objectLabel"), <LoopSkillUpdateView workspace={workspace} />, "loopops.loop-update.query-state", "loops");
    case "create-loop":
      return <CreateLoopView workspace={workspace} />;
    case "skills":
      return withQueryState(workspace, "skills", workspace.t("page.skills.title"), <SkillsView workspace={workspace} />, "loopops.skills.query-state");
    case "skill-overview":
    case "skill-editor":
    case "skill-instructions":
    case "skill-files":
    case "skill-tests":
    case "skill-versions":
      return <SkillLifecycleView workspace={workspace} />;
    case "builder":
      return workspace.route.loopId
        ? withQueryState(workspace, "workflow", workspace.t("object.loopWorkflow"), <TemplatesBuilderView workspace={workspace} />, "loopops.builder.query-state", "loops")
        : withQueryState(workspace, "loops", workspace.t("page.builder.title"), <TemplatesBuilderView workspace={workspace} />, "loopops.builder.query-state", "loops");
    case "library":
      return <TeamLibraryView workspace={workspace} />;
    case "library-loop-detail":
      return <TeamLibraryLoopView workspace={workspace} />;
    case "library-skill-detail":
      return <TeamLibrarySkillView workspace={workspace} />;
    default:
      return <LoopsBoardView workspace={workspace} />;
  }
}

export function App() {
  const workspace = useWorkbenchWorkspace();

  return (
    <WorkspaceShell workspace={workspace}>
      {workspace.error ? (
        <EmptyState
          title={workspace.t("error.serviceTitle")}
          body={workspace.t("error.serviceBody")}
          actionLabel={workspace.t("actions.retry")}
          onAction={workspace.retry}
        />
      ) : workspace.loading && !workspace.loops.length && !workspace.skills.length ? (
        <EmptyState
          title={workspace.t("state.loadingWorkspace")}
          body={workspace.t("state.loadingWorkspaceBody")}
          testId="loopops.workspace.loading"
        />
      ) : (
        <>
          {!workspace.online ? (
            <div className="workspaceConnectionBanner" role="status" aria-live="polite" data-testid="loopops.workspace.offline">
              <div>
                <strong>{workspace.t("offline.bannerTitle")}</strong>
                <span>{workspace.t("offline.bannerBody")}</span>
              </div>
              <button type="button" onClick={workspace.retry}>{workspace.t("actions.retry")}</button>
            </div>
          ) : workspace.connectionRecovered ? (
            <div className="workspaceRecoveryBanner" role="status" aria-live="polite" data-testid="loopops.workspace.recovered">
              <div>
                <strong>{workspace.t("offline.recoveredTitle")}</strong>
                <span>{workspace.t("offline.recoveredBody")}</span>
              </div>
              <button type="button" onClick={workspace.dismissConnectionRecovery}>{workspace.t("actions.dismiss")}</button>
            </div>
          ) : workspace.readOnlyWorkspace ? (
            <div className="workspacePermissionBanner" role="status" aria-live="polite" data-testid="loopops.workspace.read-only">
              <div>
                <strong>{workspace.t("permissions.readOnlyTitle")}</strong>
                <span>{workspace.t("permissions.readOnlyBody")}</span>
              </div>
              <button type="button" onClick={workspace.requestWorkspaceAccess} data-testid="loopops.workspace.request-access">
                {workspace.t("permissions.copyRequest")}
              </button>
            </div>
          ) : workspace.staleSurfaceError ? (
            <div className="workspaceConnectionBanner" role="status" aria-live="polite" data-testid="loopops.workspace.refresh-warning">
              <strong>{workspace.t("refreshWarning.title")}</strong>
              <span>{workspace.t("refreshWarning.body")}</span>
              <button type="button" onClick={workspace.retryStaleSurface}>{workspace.t("actions.retry")}</button>
            </div>
          ) : null}
          <CurrentSurface workspace={workspace} />
        </>
      )}
      <CreateResourceDialog workspace={workspace} />
      <CreateSkillDialog workspace={workspace} />
      <LoopImportDialog workspace={workspace} />
    </WorkspaceShell>
  );
}
