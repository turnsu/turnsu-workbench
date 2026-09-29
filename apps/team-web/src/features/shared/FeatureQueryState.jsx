import { ObjectQueryState } from "../../components/shared/ObjectQueryState.jsx";

export function withFeatureQueryState(
  workspace,
  name,
  objectLabel,
  surface,
  testId,
  backPage = null,
) {
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
      backLabel={backPage
        ? workspace.t(backPage === "skills" ? "actions.backToSkills" : "actions.openLoops")
        : null}
      testId={testId}
    />
  );
}
