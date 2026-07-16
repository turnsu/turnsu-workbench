import { LayoutTemplate, Plus, Save, Send } from "lucide-react";
import { Button } from "../../design-system/index.jsx";

const titles = {
  workflows: ["page.loops.title", "page.loops.caption"],
  loops: ["page.loops.title", "page.loops.caption"],
  skills: ["page.skills.title", "page.skills.caption"],
  "skill-overview": ["page.skillOverview.title", "page.skillOverview.caption"],
  "skill-editor": ["page.skillEditor.title", "page.skillEditor.caption"],
  "skill-instructions": ["page.skillInstructions.title", "page.skillInstructions.caption"],
  "skill-files": ["page.skillFiles.title", "page.skillFiles.caption"],
  "skill-tests": ["page.skillTests.title", "page.skillTests.caption"],
  "skill-versions": ["page.skillVersions.title", "page.skillVersions.caption"],
  builder: ["page.builder.title", "page.builder.caption"],
  library: ["page.library.title", "page.library.caption"],
  runs: ["page.runs.title", "page.runs.caption"],
  "loop-overview": ["page.loopOverview.title", "page.loopOverview.caption"],
  "run-preflight": ["page.runPreflight.title", "page.runPreflight.caption"],
  "loop-publish": ["page.loopPublish.title", "page.loopPublish.caption"],
  "loop-update": ["page.loopUpdate.title", "page.loopUpdate.caption"],
  "create-loop": ["page.loops.title", "page.loops.caption"],
  "library-loop-detail": ["page.libraryLoop.title", "page.libraryLoop.caption"],
  "library-skill-detail": ["page.librarySkill.title", "page.librarySkill.caption"],
};

function primaryForPage(workspace) {
  switch (workspace.activePage) {
    case "workflows":
    case "loops":
      return ["actions.createLoop", () => workspace.createWorkflow(), "loopops.topbar.primary.create-loop", <Plus size={15} />];
    case "skills":
      return null;
    case "builder":
      return ["actions.saveCurrentWorkflow", workspace.saveWorkspace, "loopops.topbar.primary.save-workflow", <Save size={15} />];
    case "library":
      return null;
    case "runs":
      return ["actions.openLoops", () => workspace.setActivePage("loops"), "loopops.topbar.primary.open-loops", <LayoutTemplate size={15} />];
    case "loop-overview":
    case "skill-overview":
    case "skill-editor":
    case "skill-instructions":
    case "skill-files":
    case "skill-tests":
    case "skill-versions":
    case "run-preflight":
    case "loop-publish":
    case "loop-update":
    case "create-loop":
    case "library-loop-detail":
    case "library-skill-detail":
      return null;
    default:
      return ["actions.createWorkflow", workspace.createWorkflow, "loopops.topbar.primary.create-workflow", <Plus size={15} />];
  }
}

export function TopBar({ workspace }) {
  if (["loops", "workflows", "create-loop", "builder"].includes(workspace.activePage)) return null;

  const [titleKey, captionKey] = titles[workspace.activePage] || titles.workflows;
  const primary = primaryForPage(workspace);
  const t = workspace.t;
  const isBuilderSurface = workspace.activePage === "builder";
  const primaryRequiresWrite = ["workflows", "loops", "skills", "builder"].includes(workspace.activePage);
  const primaryDisabled = (primaryRequiresWrite && workspace.readOnlyWorkspace)
    || (isBuilderSurface && !workspace.canSaveWorkflow);
  const primaryDisabledReason = workspace.readOnlyWorkspace && primaryRequiresWrite
    ? t("permissions.readOnlyAction")
    : isBuilderSurface && !workspace.canSaveWorkflow ? t("state.saveBlocked") : undefined;

  return (
    <header className="topbar">
      <div className="topbarTitle">
        <h1>{t(titleKey)}</h1>
        <p>{t(captionKey)}</p>
      </div>
      <div className="topActions">
        <div className={`saveState ${workspace.editorState?.conflict ? "error" : ""}`} data-testid="loopops.workspace.save-status">
          {isBuilderSurface
            ? workspace.editorState?.conflict
              ? t("state.workflowConflict")
              : workspace.editorState?.dirty
                ? t("state.currentWorkflowUnsaved")
                : t("state.currentWorkflowSaved")
            : workspace.serverState?.fetching ? t("state.syncing") : t("state.serverSaved")}
        </div>
        {primary ? (
          <Button
            variant="primary"
            icon={primary[3] || <Send size={15} />}
            onClick={primary[1]}
            disabled={primaryDisabled}
            title={primaryDisabledReason}
            data-testid={primary[2]}
          >
            {t(primary[0])}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
