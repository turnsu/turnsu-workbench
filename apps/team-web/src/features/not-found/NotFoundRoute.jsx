import { FeatureFrame } from "../shared/FeatureFrame.jsx";
import { useWorkbenchWorkspace } from "../../state/useWorkbenchWorkspace.js";

export default function NotFoundRoute({ authUser, onLogout, navigationKey }) {
  const workspace = useWorkbenchWorkspace({
    preferenceScope: authUser?.userId || authUser?.username || "anonymous",
    feature: "not-found",
    navigationKey,
  });
  const route = workspace.route;
  const root = route.contextualRoot || "/";
  return (
    <FeatureFrame feature="not-found" workspace={workspace} authUser={authUser} onLogout={onLogout}>
      {() => (
        <main className="surface notFoundSurface" data-testid="loopops.route.not-found">
          <span>404</span>
          <h1>{workspace.locale === "zh" ? "这个页面不存在" : "This page does not exist"}</h1>
          <p>{workspace.locale === "zh" ? "链接可能已过期，或路径不受当前工作台支持。" : "The link may be stale or unsupported by this Workbench."}</p>
          <button type="button" onClick={() => workspace.navigateToPath(root, { replace: true })}>
            {workspace.locale === "zh" ? "返回对应列表" : "Return to the related list"}
          </button>
        </main>
      )}
    </FeatureFrame>
  );
}
