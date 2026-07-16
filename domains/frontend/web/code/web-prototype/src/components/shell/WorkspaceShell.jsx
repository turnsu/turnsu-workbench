import { GlobalNav } from "./GlobalNav.jsx";
import { TopBar } from "./TopBar.jsx";
import { ToastStack } from "../shared/ToastStack.jsx";
import { LoopTheme } from "../../design-system/index.jsx";

export function WorkspaceShell({ workspace, children }) {
  return (
    <LoopTheme mode={workspace.theme}>
      <div
        className={`shell page-${workspace.activePage}`}
        data-theme={workspace.theme}
        data-locale={workspace.locale}
        data-testid="loopops.prototype.shell"
      >
        <GlobalNav workspace={workspace} />
        <main className="workspace">
          <TopBar workspace={workspace} />
          <div className="workspaceBody">{children}</div>
        </main>
        <ToastStack toasts={workspace.toasts} dismissToast={workspace.dismissToast} t={workspace.t} />
      </div>
    </LoopTheme>
  );
}
