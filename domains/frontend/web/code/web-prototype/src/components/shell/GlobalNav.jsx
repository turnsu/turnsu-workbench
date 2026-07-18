import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Boxes,
  ChevronDown,
  FileUp,
  GitBranch,
  Library,
  Plus,
  Sparkles,
  Upload,
  UserRound,
} from "lucide-react";

import { Button } from "../../design-system/index.jsx";

const NAV_ITEMS = [
  { id: "skills", icon: Boxes },
  { id: "loops", icon: GitBranch },
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

export function GlobalNav({ workspace }) {
  const t = workspace.t;
  const [openMenu, setOpenMenu] = useState("");
  const createRef = useRef(null);
  const inboxRef = useRef(null);
  const accountRef = useRef(null);
  useDismissableMenu(openMenu === "create", () => setOpenMenu(""), createRef);
  useDismissableMenu(openMenu === "inbox", () => setOpenMenu(""), inboxRef);
  useDismissableMenu(openMenu === "account", () => setOpenMenu(""), accountRef);

  const issues = useMemo(() => {
    const loopIssues = workspace.loops
      .filter((loop) => loop.type === "LoopWorkflow" && loop.readiness !== "Ready")
      .slice(0, 3)
      .map((loop) => ({
        id: `loop:${loop.id}`,
        title: loop.title,
        detail: t("inbox.loopNeedsWork"),
        action: () => workspace.editLoop(loop.id, "definition"),
      }));
    const skillIssues = workspace.managedSkills
      .filter((skill) => skill.setupState !== "Ready")
      .slice(0, 3)
      .map((skill) => ({
        id: `skill:${skill.id}`,
        title: skill.title,
        detail: t("inbox.skillNeedsWork"),
        action: () => workspace.openSkill(skill.id),
      }));
    const updateIssues = workspace.teamLibrary
      .filter((release) => release.canAdopt)
      .slice(0, 2)
      .map((release) => ({
        id: `release:${release.releaseId}`,
        title: release.title,
        detail: t("inbox.updateAvailable"),
        action: () => release.assetKind === "loop"
          ? workspace.openLibraryLoop(release.assetId)
          : workspace.openLibrarySkill(release.assetId),
      }));
    return [...loopIssues, ...skillIssues, ...updateIssues];
  }, [t, workspace]);

  const primaryPage = workspace.activePage === "agent"
    ? ""
    : ["skills", "skill-overview", "skill-editor", "skill-instructions", "skill-files", "skill-tests", "skill-versions"].includes(workspace.activePage)
      ? "skills"
      : ["library", "library-loop-detail", "library-skill-detail"].includes(workspace.activePage)
        ? "library"
        : "loops";

  const runAndClose = (action) => {
    setOpenMenu("");
    action();
  };

  return (
    <header className="globalNav" data-testid="loopops.global-nav">
      <button type="button" className="globalBrand" onClick={() => workspace.setActivePage("loops")} aria-label={t("brand.openWorkspace")}>
        <span className="globalBrandMark">lo</span>
        <strong>looloomi</strong>
      </button>

      <nav className="globalPrimaryNav" aria-label={t("nav.primary")}>
        {NAV_ITEMS.map(({ id, icon: Icon }) => (
          <button
            type="button"
            key={id}
            className={primaryPage === id ? "active" : ""}
            aria-current={primaryPage === id ? "page" : undefined}
            onClick={() => workspace.setActivePage(id)}
            data-testid={`loopops.nav.${id}`}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{t(`nav.${id}`)}</span>
          </button>
        ))}
      </nav>

      <div className="globalNavActions">
        <button type="button" className={`globalIconAction ${workspace.activePage === "agent" ? "active" : ""}`} aria-label={t("agent.main.title")} onClick={() => workspace.setActivePage("agent")} data-testid="loopops.nav.agent">
          <Sparkles size={18} />
        </button>
        <span className="globalInboxLabel" aria-hidden="true">{t("agent.main.shortTitle")}</span>
        <button className="hiddenTestButton" onClick={() => workspace.setTheme("light")} data-testid="loopops.theme.light" tabIndex={-1} aria-hidden="true">{t("actions.themeLight")}</button>
        <button className="hiddenTestButton" onClick={() => workspace.setTheme("dark")} data-testid="loopops.theme.dark" tabIndex={-1} aria-hidden="true">{t("actions.themeDark")}</button>
        <button className="hiddenTestButton" onClick={() => workspace.setLocale("en")} data-testid="loopops.locale.en" tabIndex={-1} aria-hidden="true">EN</button>
        <button className="hiddenTestButton" onClick={() => workspace.setLocale("zh")} data-testid="loopops.locale.zh" tabIndex={-1} aria-hidden="true">中文</button>
        <div className="globalMenuRoot" ref={createRef}>
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            aria-expanded={openMenu === "create"}
            aria-haspopup="menu"
            onClick={() => setOpenMenu((current) => current === "create" ? "" : "create")}
            data-testid="loopops.global-create"
          >
            {t("globalCreate.label")}
          </Button>
          {openMenu === "create" ? (
            <Menu label={t("globalCreate.label")}>
              {workspace.readOnlyWorkspace ? <p className="globalPopoverNotice">{t("permissions.readOnlyAction")}</p> : null}
              <button type="button" role="menuitem" disabled={workspace.readOnlyWorkspace} onClick={() => runAndClose(() => workspace.openCreateSkillDialog("create"))} data-testid="loopops.global-create.skill">
                <Boxes size={17} /><span><strong>{t("globalCreate.skill")}</strong><small>{t("globalCreate.skillCaption")}</small></span>
              </button>
              <button type="button" role="menuitem" disabled={workspace.readOnlyWorkspace} onClick={() => runAndClose(() => workspace.openCreateSkillDialog("files"))} data-testid="loopops.global-create.upload-skill">
                <FileUp size={17} /><span><strong>{t("globalCreate.uploadSkill")}</strong><small>{t("globalCreate.uploadSkillCaption")}</small></span>
              </button>
              <button type="button" role="menuitem" disabled={workspace.readOnlyWorkspace} onClick={() => runAndClose(() => workspace.openCreateLoop("goal"))} data-testid="loopops.global-create.loop">
                <GitBranch size={17} /><span><strong>{t("globalCreate.loop")}</strong><small>{t("globalCreate.loopCaption")}</small></span>
              </button>
              <button type="button" role="menuitem" disabled={workspace.readOnlyWorkspace} onClick={() => runAndClose(workspace.openLoopImportDialog)} data-testid="loopops.global-create.upload-loop">
                <Upload size={17} /><span><strong>{t("globalCreate.uploadLoop")}</strong><small>{t("globalCreate.uploadLoopCaption")}</small></span>
              </button>
            </Menu>
          ) : null}
        </div>

        <div className="globalMenuRoot" ref={inboxRef}>
          <button type="button" className="globalIconAction" aria-label={t("inbox.title")} aria-expanded={openMenu === "inbox"} aria-haspopup="menu" onClick={() => setOpenMenu((current) => current === "inbox" ? "" : "inbox")} data-testid="loopops.inbox">
            <Bell size={18} />
            {issues.length ? <span className="globalCount">{issues.length}</span> : null}
          </button>
          <span className="globalInboxLabel" aria-hidden="true">{t("inbox.title")}</span>
          {openMenu === "inbox" ? (
            <Menu label={t("inbox.title")}>
              <div className="globalPopoverHeader"><strong>{t("inbox.title")}</strong><span>{t("inbox.count", { count: issues.length })}</span></div>
              {issues.length ? issues.map((issue) => (
                <button type="button" role="menuitem" key={issue.id} onClick={() => runAndClose(issue.action)}>
                  <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
                </button>
              )) : <p className="globalPopoverEmpty">{t("inbox.empty")}</p>}
            </Menu>
          ) : null}
        </div>

        <div className="globalMenuRoot" ref={accountRef}>
          <button type="button" className="accountTrigger" aria-expanded={openMenu === "account"} aria-haspopup="menu" onClick={() => setOpenMenu((current) => current === "account" ? "" : "account")} data-testid="loopops.account-menu">
            <span className="accountAvatar"><UserRound size={16} /></span>
            <span className="accountText"><strong>{workspace.session?.workspace?.name || t("account.workspace")}</strong><small>{workspace.session?.user?.displayName || t("account.you")}</small></span>
            <ChevronDown size={15} />
          </button>
          {openMenu === "account" ? (
            <Menu label={t("account.menu")}>
              <div className="globalPreferenceRow">
                <span>{t("actions.themeMode")}</span>
                <div role="group" aria-label={t("actions.themeMode")}>
                  {["light", "dark"].map((value) => <button type="button" key={value} className={workspace.theme === value ? "active" : ""} aria-pressed={workspace.theme === value} onClick={() => workspace.setTheme(value)} data-testid={`loopops.account.theme.${value}`}>{t(`actions.theme${value === "light" ? "Light" : "Dark"}`)}</button>)}
                </div>
              </div>
              <div className="globalPreferenceRow">
                <span>{t("actions.language")}</span>
                <div role="group" aria-label={t("actions.language")}>
                  <button type="button" className={workspace.locale === "en" ? "active" : ""} aria-pressed={workspace.locale === "en"} onClick={() => workspace.setLocale("en")} data-testid="loopops.account.locale.en">EN</button>
                  <button type="button" className={workspace.locale === "zh" ? "active" : ""} aria-pressed={workspace.locale === "zh"} onClick={() => workspace.setLocale("zh")} data-testid="loopops.account.locale.zh">中文</button>
                </div>
              </div>
            </Menu>
          ) : null}
        </div>
      </div>
    </header>
  );
}
