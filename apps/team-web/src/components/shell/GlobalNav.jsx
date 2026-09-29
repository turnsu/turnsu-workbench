import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  SquarePen,
  Settings2,
  X,
  Boxes,
  BriefcaseBusiness,
  Clock3,
  ChevronDown,
  FileUp,
  GitBranch,
  Library,
  Plus,
  UserRound,
} from "lucide-react";

import { useWorkbenchNavigation } from "./WorkbenchNavigation.jsx";
import { AgentSessionRail } from "../agents/AgentSessionRail.jsx";
import { useAgentSessionsQuery } from "../../api/queries.js";

import { Button } from "../../design-system/index.jsx";
import { TurnsuBrand } from "../shared/TurnsuBrand.jsx";
import { useResponsiveCapability } from "../../hooks/useResponsiveCapability.js";
import { translateCore } from "../../i18n/core.js";

const NAV_ITEMS = [
  { id: "work", icon: BriefcaseBusiness },
  { id: "skills", icon: Boxes },
  { id: "loops", icon: GitBranch },
  { id: "automations", icon: Clock3 },
  { id: "library", icon: Library },
];

function useDismissableMenu(open, setOpen, rootRef) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, rootRef, setOpen]);
}

function Menu({ children, label }) {
  return <div className="globalPopover" role="menu" aria-label={label}>{children}</div>;
}

export function GlobalNav({ workspace, onClose, sidebarOpen }) {
  const navigation = useWorkbenchNavigation();
  const principal = { workspaceId: workspace.serverState?.workspace?.workspaceId, userId: workspace.session?.userId };
  const sessions = useAgentSessionsQuery({ definitionId: "main", limit: 100 }, Boolean(principal.userId && principal.workspaceId), principal);
  const zh = workspace.locale === "zh";
  const newTask = () => {
    if (navigation.taskActions.current) navigation.taskActions.current.newTask();
    else workspace.navigateToPath(`/?new=${crypto.randomUUID()}`);
    navigation.closeSidebar();
  };
  const selectTask = (id) => {
    if (navigation.taskActions.current) navigation.taskActions.current.selectTask(id);
    else workspace.navigateToPath(`/?session=${encodeURIComponent(id)}`);
    navigation.closeSidebar();
  };
  const t = (key, replacements) => {
    const common = translateCore(workspace.locale, key, replacements);
    return common === key ? workspace.t(key, replacements) : common;
  };
  const [openMenu, setOpenMenu] = useState("");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const createRef = useRef(null);
  const inboxRef = useRef(null);
  const accountRef = useRef(null);
  const responsive = useResponsiveCapability();
  const readiness = workspace.creationReadiness?.actions || {};
  const skillDraftGate = readiness.promptSkill?.draftable;
  const loopDraftGate = readiness.blankLoop?.draftable;
  const skillImportGate = readiness.skillDirectoryImport?.importable;
  const blocked = (gate) => workspace.readOnlyWorkspace || gate?.status !== "ready";
  useDismissableMenu(openMenu === "create", () => setOpenMenu(""), createRef);
  useDismissableMenu(openMenu === "inbox", () => setOpenMenu(""), inboxRef);
  useDismissableMenu(openMenu === "account", () => setOpenMenu(""), accountRef);

  const issues = useMemo(() => workspace.inboxIssues || [], [workspace.inboxIssues]);

  const primaryPage = workspace.activePage === "agent"
    ? "agent"
    : workspace.activePage === "work"
      ? "work"
    : ["skills", "create-skill", "skill-overview", "skill-editor", "skill-instructions", "skill-files", "skill-tests", "skill-versions"].includes(workspace.activePage)
      ? "skills"
      : ["library", "library-loop-detail", "library-skill-detail"].includes(workspace.activePage)
        ? "library"
        : workspace.activePage === "automations"
          ? "automations"
        : "loops";

  useEffect(() => { if (["skills", "loops", "library"].includes(primaryPage)) setToolsExpanded(true); }, [primaryPage]);

  const runAndClose = (action) => {
    setOpenMenu("");
    action();
  };

  return (
    <header id="workbench-sidebar" role={sidebarOpen ? "dialog" : undefined} aria-modal={sidebarOpen || undefined} aria-label={sidebarOpen ? (zh ? "导航和任务" : "Navigation and tasks") : undefined} className="globalNav" data-testid="loopops.global-nav">
      <div className="workbenchBrandRow">
      <button type="button" className="globalBrand" onClick={() => workspace.setActivePage("agent")} aria-label={t("brand.openWorkspace")}>
        <TurnsuBrand />
      </button>

      <button className="workbenchDrawerClose" type="button" aria-label={zh ? "关闭导航" : "Close navigation"} onClick={onClose}><X size={18} /></button>
      </div>
      <button type="button" className="workbenchNewTask" onClick={newTask} data-testid="loopops.main-agent.session.new"><SquarePen size={17} /><span>{zh ? "新任务" : "New task"}</span></button>
      <p className="globalWorkspaceName">{workspace.serverState?.workspace?.name && workspace.serverState.workspace.name !== "Looloomi" ? workspace.serverState.workspace.name : t("account.workspace")}</p>
      <nav className="globalPrimaryNav" aria-label={t("nav.primary")} data-testid="loopops.mobile.tabbar">
        {NAV_ITEMS.filter((item) => ["work", "automations"].includes(item.id)).map(({ id, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={primaryPage === id ? "active" : ""}
            aria-current={primaryPage === id ? "page" : undefined}
            onClick={() => { workspace.setActivePage(id); navigation.closeSidebar(); }}
            data-testid={`loopops.nav.${id}`}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{id === "work" ? (zh ? "团队工作" : "Team work") : t(`nav.${id}`)}</span>
          </button>
        ))}
        <details className="workbenchTools" open={toolsExpanded} onToggle={(event) => setToolsExpanded(event.currentTarget.open)}>
          <summary>{zh ? "工具与资源" : "Tools and resources"}</summary>
          <div>        {NAV_ITEMS.filter((item) => !["work", "automations"].includes(item.id)).map(({ id, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={primaryPage === id ? "active" : ""}
            aria-current={primaryPage === id ? "page" : undefined}
            onClick={() => { workspace.setActivePage(id); navigation.closeSidebar(); }}
            data-testid={`loopops.nav.${id}`}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{id === "work" ? (zh ? "团队工作" : "Team work") : t(`nav.${id}`)}</span>
          </button>
        ))}</div>
        </details>
      </nav>

      <AgentSessionRail sessions={sessions.data?.data || []} selectedSessionId={navigation.activeSessionId}
        loading={sessions.isPending} error={sessions.error} locale={workspace.locale} onSelect={selectTask}
        hasMore={sessions.hasNextPage} loadingMore={sessions.isFetchingNextPage} onLoadMore={sessions.fetchNextPage} onRetry={sessions.refetch} />
      <div className="globalNavActions">
        <button type="button" className="workbenchSettingsTrigger" onClick={() => { navigation.openSettings(); navigation.closeSidebar(); }}><Settings2 size={17} /><span>{zh ? "设置" : "Settings"}</span></button>
        <div className="globalMenuRoot" ref={createRef}>
          <Button
            variant="ghost"
            icon={<Plus size={16} />}
            aria-label={t("globalCreate.label")}
            aria-expanded={openMenu === "create"}
            aria-haspopup="menu"
            onClick={() => setOpenMenu((current) => current === "create" ? "" : "create")}
            data-testid="loopops.global-create"
          >
            {zh ? "创建技能或工作流" : "Create skill or workflow"}
          </Button>
          {openMenu === "create" ? (
            <Menu label={t("globalCreate.label")}>
              {workspace.readOnlyWorkspace ? <p className="globalPopoverNotice">{t("permissions.readOnlyAction")}</p> : null}
              <button type="button" role="menuitem" disabled={blocked(skillDraftGate)} title={skillDraftGate?.message} onClick={() => runAndClose(() => workspace.navigateToPath("/skills/new?mode=define"))} data-testid="loopops.global-create.skill">
                <Boxes size={17} /><span><strong>{t("globalCreate.skill")}</strong><small>{t("globalCreate.skillCaption")}</small></span>
              </button>
              {responsive.skillPackageImport ? (
                <button type="button" role="menuitem" disabled={blocked(skillImportGate)} title={skillImportGate?.message} onClick={() => runAndClose(() => workspace.navigateToPath("/skills/new?mode=files"))} data-testid="loopops.global-create.upload-skill">
                  <FileUp size={17} /><span><strong>{t("globalCreate.uploadSkill")}</strong><small>{t("globalCreate.uploadSkillCaption")}</small></span>
                </button>
              ) : null}
              <button type="button" role="menuitem" disabled={blocked(loopDraftGate)} title={loopDraftGate?.message} onClick={() => runAndClose(() => workspace.navigateToPath("/loops/new"))} data-testid="loopops.global-create.loop">
                <GitBranch size={17} /><span><strong>{t("globalCreate.loop")}</strong><small>{t("globalCreate.loopCaption")}</small></span>
              </button>
              <button type="button" role="menuitem" disabled={workspace.readOnlyWorkspace} onClick={() => runAndClose(() => workspace.navigateToPath("/work?create=work-item"))} data-testid="loopops.global-create.work-item">
                <BriefcaseBusiness size={17} /><span><strong>{t("globalCreate.workItem")}</strong><small>{t("globalCreate.workItemCaption")}</small></span>
              </button>
            </Menu>
          ) : null}
        </div>

        <div className="globalMenuRoot" ref={inboxRef}>
          <button type="button" className="globalIconAction" aria-label={t("inbox.title")} aria-expanded={openMenu === "inbox"} aria-haspopup="menu" onClick={() => setOpenMenu((current) => current === "inbox" ? "" : "inbox")} data-testid="loopops.inbox">
            <Bell size={18} />
            {workspace.inboxCount ? <span className="globalCount">{workspace.inboxCount}</span> : null}
          </button>
          <span className="globalInboxLabel" aria-hidden="true">{t("inbox.title")}</span>
          {openMenu === "inbox" ? (
            <Menu label={t("inbox.title")}>
              <div className="globalPopoverHeader"><strong>{t("inbox.title")}</strong><span>{t("inbox.count", { count: workspace.inboxCount ?? issues.length })}</span></div>
              {workspace.inboxLoaded && issues.length ? issues.map((issue) => (
                <button type="button" role="menuitem" key={issue.id} onClick={() => runAndClose(issue.action)}>
                  <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
                </button>
              )) : (
                <p className="globalPopoverEmpty">
                  {workspace.inboxLoaded ? t("inbox.empty") : t("inbox.summaryUnavailable")}
                </p>
              )}
              {workspace.inboxHasMore ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={workspace.inboxLoadingMore}
                  onClick={() => workspace.loadMoreInbox()}
                >
                  <span>{t(workspace.inboxLoadingMore ? "inbox.loadingMore" : "inbox.loadMore")}</span>
                </button>
              ) : null}
            </Menu>
          ) : null}
        </div>

        <div className="globalMenuRoot" ref={accountRef}>
          <button type="button" className="accountTrigger" aria-expanded={openMenu === "account"} aria-haspopup="menu" onClick={() => setOpenMenu((current) => current === "account" ? "" : "account")} data-testid="loopops.account-menu">
            <span className="accountAvatar"><UserRound size={16} /></span>
            <span className="accountText"><strong>{workspace.authUser?.username || t("account.you")}</strong><small>{workspace.authUser?.role === "admin" ? "Admin" : t("account.workspace")}</small></span>
            <ChevronDown size={15} />
          </button>
          {openMenu === "account" ? (
            <Menu label={t("account.menu")}>
              <button type="button" role="menuitem" onClick={() => runAndClose(() => { navigation.openSettings(); navigation.closeSidebar(); })}><Settings2 size={17} /><span>{zh ? "设置" : "Settings"}</span></button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(workspace.logout)}
                data-testid="loopops.account.logout"
              >
                <UserRound size={17} />
                <span><strong>退出登录</strong><small>{workspace.authUser?.username || ""}</small></span>
              </button>
            </Menu>
          ) : null}
        </div>
      </div>
    </header>
  );
}
