import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { WorkbenchNavigationContext } from "./WorkbenchNavigation.jsx";
import { WorkspaceSettings } from "./WorkspaceSettings.jsx";
import { TurnsuBrand } from "../shared/TurnsuBrand.jsx";
import "../../styles/workbench.css";
import { GlobalNav } from "./GlobalNav.jsx";
import { TopBar } from "./TopBar.jsx";
import { ToastStack } from "../shared/ToastStack.jsx";
import { LoopTheme } from "../../design-system/index.jsx";

export function WorkspaceShell({ workspace, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState("");
  const taskActions = useRef(null);
  const menuTrigger = useRef(null);
  const zh = workspace.locale === "zh";
  const closeSidebar = () => { setSidebarOpen(false); queueMicrotask(() => menuTrigger.current?.focus()); };
  useEffect(() => {
    if (!sidebarOpen) return;
    const sidebar = document.getElementById("workbench-sidebar");
    const controls = () => [...(sidebar?.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex='0']") || [])].filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
    controls()[0]?.focus();
    const handleKeys = (event) => {
      if (event.key === "Escape") { event.preventDefault(); closeSidebar(); }
      if (event.key !== "Tab") return;
      const items = controls();
      if (!items.length) return;
      if (event.shiftKey && (document.activeElement === items[0] || !sidebar?.contains(document.activeElement))) {
        event.preventDefault(); items.at(-1).focus();
      } else if (!event.shiftKey && (document.activeElement === items.at(-1) || !sidebar?.contains(document.activeElement))) {
        event.preventDefault(); items[0].focus();
      }
    };
    const desktop = matchMedia("(min-width: 821px)");
    const onResize = () => { if (desktop.matches) setSidebarOpen(false); };
    desktop.addEventListener("change", onResize);
    document.addEventListener("keydown", handleKeys);
    return () => { document.removeEventListener("keydown", handleKeys); desktop.removeEventListener("change", onResize); };
  }, [sidebarOpen]);
  const navigation = useMemo(() => ({ taskActions, activeSessionId, setActiveSessionId,
    openSettings: () => setSettingsOpen(true), closeSidebar: () => setSidebarOpen(false),
  }), [activeSessionId]);
  return (
    <WorkbenchNavigationContext.Provider value={navigation}>
    <LoopTheme mode={workspace.theme}>
      <div
        className={`shell turnsuWorkbench ${sidebarOpen ? "sidebarOpen" : ""} feature-${workspace.featureScope || "agent"} page-${workspace.activePage}`}
        data-theme={workspace.theme}
        data-locale={workspace.locale}
        data-testid="loopops.prototype.shell"
      >
        <a className="workspaceSkipLink" href="#workspace-content">{workspace.locale === "zh" ? "跳到工作区" : "Skip to workspace"}</a>
        <div className="workbenchMobileHeader" inert={sidebarOpen || undefined}>
          <button ref={menuTrigger} type="button" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={zh ? "打开导航和任务" : "Open navigation and tasks"} aria-expanded={sidebarOpen} aria-controls="workbench-sidebar"><PanelLeftOpen size={20} /></button>
          <TurnsuBrand />
          <button type="button" onClick={() => { if (taskActions.current) taskActions.current.newTask(); else workspace.navigateToPath(`/?new=${crypto.randomUUID()}`); }} aria-label={zh ? "新任务" : "New task"}>＋</button>
        </div>
        {sidebarOpen ? <button type="button" className="workbenchDrawerBackdrop" aria-label={zh ? "关闭导航" : "Close navigation"} onClick={closeSidebar} /> : null}
        <GlobalNav workspace={workspace} onClose={closeSidebar} sidebarOpen={sidebarOpen} />
        <main inert={sidebarOpen || undefined} className="workspace" id="workspace-content" tabIndex={-1}>
          <TopBar workspace={workspace} />
          <div className="workspaceBody">{children}</div>
        </main>
        <WorkspaceSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} workspace={workspace} />
        <ToastStack toasts={workspace.toasts} dismissToast={workspace.dismissToast} t={workspace.t} />
      </div>
    </LoopTheme>
    </WorkbenchNavigationContext.Provider>
  );
}
