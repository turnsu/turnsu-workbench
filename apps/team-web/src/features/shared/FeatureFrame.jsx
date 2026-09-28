import { WorkspaceShell } from "../../components/shell/WorkspaceShell.jsx";
import { EmptyState } from "../../components/shared/EmptyState.jsx";

export function FeatureFrame({
  workspace,
  authUser,
  onLogout,
  feature = "agent",
  children,
  dialogs = null,
}) {
  const authenticatedWorkspace = {
    inboxIssues: [],
    inboxLoaded: false,
    ...workspace,
    featureScope: feature,
    authUser,
    logout: onLogout,
  };

  return (
    <WorkspaceShell workspace={authenticatedWorkspace}>
      {authenticatedWorkspace.error ? (
        <EmptyState
          title={authenticatedWorkspace.t("error.serviceTitle")}
          body={authenticatedWorkspace.t("error.serviceBody")}
          actionLabel={authenticatedWorkspace.t("actions.retry")}
          onAction={authenticatedWorkspace.retry}
        />
      ) : authenticatedWorkspace.loading ? (
        <EmptyState
          title={authenticatedWorkspace.t("state.loadingWorkspace")}
          body={authenticatedWorkspace.t("state.loadingWorkspaceBody")}
          testId="loopops.workspace.loading"
        />
      ) : (
        <>
          {!authenticatedWorkspace.online ? (
            <div className="workspaceConnectionBanner" role="status" aria-live="polite" data-testid="loopops.workspace.offline">
              <div>
                <strong>{authenticatedWorkspace.t("offline.bannerTitle")}</strong>
                <span>{authenticatedWorkspace.t("offline.bannerBody")}</span>
              </div>
              <button type="button" onClick={authenticatedWorkspace.retry}>{authenticatedWorkspace.t("actions.retry")}</button>
            </div>
          ) : authenticatedWorkspace.connectionRecovered ? (
            <div className="workspaceRecoveryBanner" role="status" aria-live="polite" data-testid="loopops.workspace.recovered">
              <div>
                <strong>{authenticatedWorkspace.t("offline.recoveredTitle")}</strong>
                <span>{authenticatedWorkspace.t("offline.recoveredBody")}</span>
              </div>
              <button type="button" onClick={authenticatedWorkspace.dismissConnectionRecovery}>{authenticatedWorkspace.t("actions.dismiss")}</button>
            </div>
          ) : authenticatedWorkspace.readOnlyWorkspace ? (
            <div className="workspacePermissionBanner" role="status" aria-live="polite" data-testid="loopops.workspace.read-only">
              <div>
                <strong>{authenticatedWorkspace.t("permissions.readOnlyTitle")}</strong>
                <span>{authenticatedWorkspace.t("permissions.readOnlyBody")}</span>
              </div>
              <button type="button" onClick={authenticatedWorkspace.requestWorkspaceAccess} data-testid="loopops.workspace.request-access">
                {authenticatedWorkspace.t("permissions.copyRequest")}
              </button>
            </div>
          ) : authenticatedWorkspace.staleSurfaceError ? (
            <div className="workspaceConnectionBanner" role="status" aria-live="polite" data-testid="loopops.workspace.refresh-warning">
              <strong>{authenticatedWorkspace.t("refreshWarning.title")}</strong>
              <span>{authenticatedWorkspace.t("refreshWarning.body")}</span>
              <button type="button" onClick={authenticatedWorkspace.retryStaleSurface}>{authenticatedWorkspace.t("actions.retry")}</button>
            </div>
          ) : null}
          {children(authenticatedWorkspace)}
        </>
      )}
      {dialogs ? dialogs(authenticatedWorkspace) : null}
    </WorkspaceShell>
  );
}
