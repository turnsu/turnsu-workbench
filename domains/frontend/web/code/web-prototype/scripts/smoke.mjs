import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(target) : [target];
});
const assertCheck = (condition, message) => { if (!condition) throw new Error(message); };

const packageJson = JSON.parse(read("package.json"));
const sourceFiles = walk(src).filter((file) => /\.(js|jsx|css)$/.test(file));
const source = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const visibleFiles = sourceFiles.filter((file) => file.includes(`${path.sep}components${path.sep}`) || /i18n\.js$|styles\.css$/.test(file));
const visibleSource = visibleFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const app = read("src/App.jsx");
const main = read("src/main.jsx");
const workspace = read("src/state/useWorkbenchWorkspace.js");
const serverState = read("src/state/server/useWorkbenchServerState.js");
const api = read("src/api/client.js");
const queries = read("src/api/queries.js");
const createSkillDialog = read("src/components/skills/CreateSkillDialog.jsx");
const updateSkillDialog = read("src/components/skills/UpdateSkillDialog.jsx");
const skillLifecycleView = read("src/components/skills/SkillLifecycleView.jsx");
const skillPackageEditor = read("src/components/skills/SkillPackageEditor.jsx");
const runStreamHook = read("src/state/run-stream/useRunStream.js");
const runDetails = read("src/components/runs/RunDetailsView.jsx");
const objectQueryState = read("src/components/shared/ObjectQueryState.jsx");
const teamLibrary = read("src/components/library/TeamLibraryView.jsx");
const workspaceShell = read("src/components/shell/WorkspaceShell.jsx");
const globalNav = read("src/components/shell/GlobalNav.jsx");
const loopImportDialog = read("src/components/loops/LoopImportDialog.jsx");
const loopsBoard = read("src/components/loops/LoopsBoardView.jsx");
const createLoop = read("src/components/loops/CreateLoopView.jsx");
const loopOverview = read("src/components/loops/LoopOverviewView.jsx");
const editorHook = read("src/state/editor/useWorkflowEditor.js");
const builder = read("src/components/templates/TemplatesBuilderView.jsx");
const mainAgent = read("src/components/agents/MainAgentView.jsx");
const modelPicker = read("src/components/models/ModelPicker.jsx");
const canvas = read("src/components/canvas/LoopCanvas.jsx");
const vite = read("vite.config.mjs");
const i18n = read("src/i18n.js");
const modularStyles = ["src/styles/shell.css", "src/styles/library.css", "src/styles/lifecycle.css"]
  .map(read)
  .join("\n");

const requiredFiles = [
  "src/api/client.js",
  "src/api/queries.js",
  "src/api/queryClient.js",
  "src/state/useWorkbenchWorkspace.js",
  "src/state/server/useWorkbenchServerState.js",
  "src/state/server/presentationAdapters.js",
  "src/state/editor/editorState.js",
  "src/state/editor/editorDraftStorage.js",
  "src/state/editor/workflowDraftActions.js",
  "src/state/run-stream/runStreamState.js",
  "src/state/run-stream/useRunStream.js",
  "src/routing/workbenchRoutes.js",
  "src/components/canvas/LoopCanvas.jsx",
  "src/components/templates/TemplatesBuilderView.jsx",
  "src/components/runs/RunDetailsView.jsx",
  "src/components/shared/ObjectQueryState.jsx",
  "src/components/skills/SkillsView.jsx",
  "src/components/skills/SkillLifecycleView.jsx",
  "src/components/skills/SkillPackageEditor.jsx",
  "src/components/loops/LoopsBoardView.jsx",
  "src/components/loops/CreateLoopView.jsx",
  "src/components/loops/LoopOverviewView.jsx",
  "src/components/loops/LoopImportDialog.jsx",
  "src/components/runs/RunPreflightView.jsx",
  "src/components/library/TeamLibraryView.jsx",
  "src/components/library/TeamLibraryLoopView.jsx",
  "src/components/library/TeamLibrarySkillView.jsx",
  "src/components/shell/GlobalNav.jsx",
  "src/components/agents/MainAgentView.jsx",
  "src/components/agents/SkillCreatorAgentPanel.jsx",
  "src/components/models/ModelPicker.jsx",
  "src/components/models/ChatComposer.jsx",
  "src/components/models/ImageComposer.jsx",
  "src/components/models/ArtifactImage.jsx",
  "src/state/models/modelCatalog.js",
  "src/state/agents/useMainAgent.js",
  "src/components/connections/ConnectionRebindingSheet.jsx",
  "src/components/connections/useConnectionRebindingAction.js",
  "src/components/connections/useTeamConnectionActions.js",
];
requiredFiles.forEach((file) => assertCheck(fs.existsSync(path.join(root, file)), `missing boundary: ${file}`));
assertCheck(!fs.existsSync(path.join(root, "src/components/shell/SidebarNav.jsx")), "legacy sidebar must be physically removed from production");
assertCheck(!fs.existsSync(path.join(root, "src/data/navigation.js")), "legacy sidebar navigation data must be physically removed");
for (const retiredToken of ["--panel", "--border", "--border-strong", "--soft"]) {
  assertCheck(!modularStyles.includes(`var(${retiredToken})`), `modular styles reference undefined token ${retiredToken}`);
}
const retiredMockFiles = [
  "src/state/useLoopOpsWorkspace.js",
  "src/state/loopopsActions.js",
  "src/workspacePersistence.js",
  "src/data/skillCatalog.js",
  "src/data/workflowLibrary.js",
  "src/data/runLedgers.js",
  "src/data/resourceSources.js",
  "src/data/builderConversations.js",
  "src/components/chat/ScopedChatPanel.jsx",
];
retiredMockFiles.forEach((file) => assertCheck(!fs.existsSync(path.join(root, file)), `retired mock boundary returned: ${file}`));

const anchors = [
  "loopops.prototype.shell",
  "loopops.workflows.surface",
  "loopops.loops.board",
  "loopops.loops.overview",
  "loopops.loops.upload",
  "loopops.create-loop.page",
  "loopops.create-loop.mode.${id}",
  "loopops.loop-import.dialog",
  "loopops.loop-import.file",
  "loopops.loop-import.check",
  "loopops.loop-import.commit",
  "loopops.loop-overview.export",
  "loopops.runs.preflight",
  "loopops.loop-overview.primary",
  "loopops.preflight.start",
  "loopops.library.surface",
  "loopops.workflows.run-ledger",
  "loopops.workflows.run-detail",
  "loopops.runs.review-panel",
  "loopops.runs.review-history",
  "loopops.runs.final-answer",
  "loopops.runs.evidence-gaps",
  "loopops.runs.review.comment",
  "loopops.runs.retry",
  "loopops.skills.surface",
  "loopops.skill.overview",
  "loopops.skill.instructions",
  "loopops.skill.files",
  "loopops.skill.editor",
  "loopops.skill.tests",
  "loopops.skill.versions",
  "loopops.templates.surface",
  "loopops.builder.palette",
  "loopops.builder.canvas",
  "loopops.builder.canvas-dropzone",
  "loopops.builder.selected-node",
  "loopops.builder.inspector",
  "loopops.builder.debug-panel",
  "loopops.builder.run-inputs",
  "loopops.builder.compile-diagnostics",
  "loopops.builder.assistant.toggle",
  "loopops.builder.minimap",
  "loopops.builder.mobile-library.open",
  "loopops.builder.mobile-library.close",
  "loopops.builder.revision-conflict",
  "loopops.builder.revision-conflict.download",
  "loopops.builder.revision-conflict.reload",
];
anchors.forEach((anchor) => assertCheck(source.includes(anchor), `missing data-testid anchor: ${anchor}`));

assertCheck(packageJson.dependencies["@tanstack/react-query"], "TanStack Query must own server state");
assertCheck(packageJson.dependencies["@astryxdesign/core"], "Astryx core dependency missing");
assertCheck(packageJson.dependencies["@flowgram.ai/editor"], "FlowGram dependency missing");
assertCheck(main.includes("QueryClientProvider"), "React root must provide QueryClient");
assertCheck(app.includes("useWorkbenchWorkspace"), "App must use the backend-backed workspace");
assertCheck(!app.includes("useLoopOpsWorkspace"), "App must not use the legacy mock workspace");
assertCheck(!workspace.includes("../data/"), "production workspace must not import fixture catalogs");
assertCheck(!workspace.includes("loopopsActions"), "production workspace must not use client compile/run actions");
assertCheck(workspace.includes("useWorkbenchServerState"), "workspace must separate server state");
assertCheck(workspace.includes("useWorkflowEditor"), "workspace must separate editor state");
assertCheck(workspace.includes("retryCreationProposal"), "failed Builder proposals must be retryable against the same saved Workflow");
assertCheck(workspace.includes("definition-only change") && workspace.includes("exactly one updateDefinition operation"), "new empty Workflow proposals must not invent graph node shapes");
assertCheck(workspace.includes("useRunStream"), "workspace must separate run stream state");
assertCheck(api.includes("PORTABLE_LOOP_PACKAGE_MEDIA_TYPE"), "Loop download must use its portable media type");
assertCheck(api.includes("requestPortableLoop"), "Loop download must not parse the package as an API envelope");
assertCheck(api.includes("Content-Disposition") || api.includes("content-disposition"), "Loop download must preserve its safe filename");
assertCheck(queries.includes('assetKind: "loop"') && queries.includes("inspectResumableLoopPackage"), "Loop upload must use the resumable asset transport");
assertCheck(queries.includes("commitLoopImport") && queries.includes("ifMatch"), "Loop import commit must preserve the reviewed ETag");
assertCheck(loopsBoard.includes("workspace.openLoopImportDialog") && loopsBoard.includes("workspace.readOnlyWorkspace"), "Loop upload must be explicit and permission-aware");
assertCheck(loopOverview.includes("workspace.exportSelectedLoop") && !loopOverview.includes("disabled={workspace.readOnlyWorkspace}"), "Loop export must defer viewer access to backend authorization");
assertCheck(loopImportDialog.includes("skillMappings") && loopImportDialog.includes("materialMappings") && loopImportDialog.includes("connectionMappings"), "Loop import must review every dependency class");
assertCheck(loopImportDialog.includes("workspace.openCreateResourceDialog") && loopImportDialog.includes('workspace.setActivePage("skills")'), "Missing import dependencies need visible recovery actions");
assertCheck(loopImportDialog.includes("ConnectionRebindingSheet"), "Loop import must reuse explicit workspace connection rebinding");
assertCheck(loopImportDialog.includes("loopTransfer.importBoundary"), "Loop import must explain that it creates a private blocked draft");
for (const restrictedLabel of [">provider<", ">secret<", ">schema<", ">artifact<", ">objectId<"]) {
  assertCheck(!loopImportDialog.includes(restrictedLabel), `Loop import renders restricted internal label ${restrictedLabel}`);
}
assertCheck(runStreamHook.includes("workbenchKeys.runs(event.workflowId)"), "terminal Run events must refresh Workflow Run history");
assertCheck(editorHook.includes("refreshedCleanEtag"), "clean editor state must accept a stronger ETag for the same revision");
assertCheck(serverState.includes("reloadWorkflow()"), "workflow conflicts must refetch the latest server version");
assertCheck(workspace.includes("downloadUnsavedWorkflowDraft"), "workflow conflicts must preserve local changes before destructive reload");

assertCheck(api.includes('const API_PREFIX = "/api/workbench/v1"'), "Product API prefix missing");
assertCheck(api.includes('credentials: "same-origin"'), "API must use same-origin credentials");
assertCheck(api.includes('headers["Idempotency-Key"]'), "mutations must carry idempotency keys");
assertCheck(api.includes("resolvedIdempotencyKey"), "session recovery must preserve the original idempotency key");
assertCheck(api.includes("sessionRefreshPromise"), "concurrent session recovery must use one refresh request");
assertCheck(api.includes('request("/workspace", { retrySession: false })'), "expired sessions must be recoverable without reloading the page");
assertCheck(api.includes('headers["If-Match"]'), "revision saves must carry If-Match");
assertCheck(api.includes("openRunEventStream"), "Run SSE client missing");
assertCheck(api.includes("listTeamLibrary"), "Team library API client missing");
assertCheck(api.includes("useTeamReleaseAsStartingPoint"), "Team starting-point API client missing");
assertCheck(api.includes("forkTeamLoopRelease"), "Team Loop Fork API client missing");
assertCheck(api.includes("duplicateLoop"), "Workflow copy API client missing");
assertCheck(api.includes("createLoopDraftFromRun"), "Run-to-workflow API client missing");
assertCheck(api.includes("listResources"), "Material list API client missing");
assertCheck(api.includes("createResource"), "Material create API client missing");
assertCheck(api.includes("listConnections"), "Connection list API client missing");
assertCheck(api.includes("createConnection"), "Connection create API client missing");
assertCheck(api.includes("updateConnection"), "Connection update API client missing");
assertCheck(api.includes("validateConnection"), "Connection validation API client missing");
assertCheck(api.includes("createSkillTest"), "Skill test API client missing");
assertCheck(api.includes("createSkillValidation"), "Skill validation API client missing");
assertCheck(api.includes("getSkillDraftPackage"), "Skill package read API client missing");
assertCheck(api.includes("replaceSkillDraftPackage"), "Skill package replacement API client missing");
assertCheck(vite.includes('target: "http://127.0.0.1:8798"'), "Vite must proxy the frozen Product server port");
assertCheck(vite.includes('LOOP_WORKBENCH_OFFLINE_BUILD === "1" ? "./" : "/"'), "Product API builds must use root-relative assets while offline review remains explicit");
assertCheck(!source.includes("auth-token.json"), "browser source must not read daemon credentials");
assertCheck(!source.includes("wechat-agent-daemon"), "browser source must not call the Agent daemon");

assertCheck(builder.includes("readOnly={isTemplate}"), "templates must render a read-only graph");
assertCheck(!builder.includes("loopops.templates.list") && !builder.includes("templateGroup"), "owned Loop Builder must not restore the historical Templates-first rail");
assertCheck(builder.includes("mobileCanvasMode"), "Canvas mode must expose the dedicated mobile layout class");
assertCheck(builder.includes("mobilePaletteOpen"), "mobile Canvas must own a temporary resource drawer state");
assertCheck(!builder.includes("ScopedChatPanel"), "Builder must not retain a local assistant fallback");
assertCheck(builder.includes("workspace.sendChat(workspace.composer, builderModelRevisionId)"), "Builder assistant must submit its selected immutable model revision");
assertCheck(builder.includes("loopops.templates.builder-patch-receipt"), "Builder must show a reviewable proposal receipt");
assertCheck(builder.includes("workspace.applyBuilderPatch"), "Builder proposal must require explicit apply");
assertCheck(workspace.includes("server.mutations.generateLoopProposal"), "Builder must generate proposals through Product API state");
assertCheck(workspace.includes("server.mutations.applyLoopProposal"), "Builder must apply proposals through Product API state");
assertCheck(workspace.includes("server.mutations.dismissLoopProposal"), "Builder must dismiss proposals through Product API state");
assertCheck(!workspace.includes("stageBuilderPatch"), "Builder must not retain local sample proposal generation");
assertCheck(builder.includes("loopops.builder.duplicate"), "Builder must expose an explicit workflow copy action");
assertCheck(source.includes("loopops.runs.create-draft"), "Run detail must expose a continue-from-run action");
assertCheck(builder.includes("workspace.runInputs"), "Builder must collect real run inputs");
assertCheck(builder.includes("paletteMaterials"), "Builder must expose server-backed materials");
assertCheck(workspace.includes("addResourceToLoop"), "Builder must attach a material through the editor draft");
assertCheck(workspace.includes("pendingSkillAdd"), "Add-to-workflow must survive loading a different target revision");
assertCheck(workspace.includes("editor.state?.workflowId !== pendingSkillAdd.loopId"), "pending Skill insertion must wait for the requested target revision");
assertCheck(workspace.includes('if (!loopId)') && workspace.includes('navigateToPage("create-loop")'), "Add-to-workflow needs a route-based creation recovery when no workflow exists");
assertCheck(!fs.existsSync(path.join(root, "src/components/workflows/CreateLoopDialog.jsx")), "retired Loop creation dialog must be physically removed");
assertCheck(workspace.includes("pendingSkillForNewWorkflow"), "Skill creation recovery must remain visible in the create workflow dialog");
assertCheck(!workspace.includes("duplicateWorkflowUnavailable"), "Workflow copy must not remain a dead-control fallback");
assertCheck(canvas.includes("readOnly = false"), "canvas must support immutable template mode");
assertCheck(canvas.includes("onClick={handleMinimapPointer}"), "minimap must remain interactive");
assertCheck(canvas.includes('data-selected={selectedNodeId === node.id ? "true" : undefined}'), "selected node QA anchor missing");

const directAstryx = sourceFiles.filter((file) => fs.readFileSync(file, "utf8").includes("@astryxdesign"))
  .filter((file) => !file.endsWith(path.join("src", "design-system", "index.jsx")));
assertCheck(directAstryx.length === 0, `Astryx imports escaped the design system: ${directAstryx.join(", ")}`);
const directFlowgram = sourceFiles.filter((file) => fs.readFileSync(file, "utf8").includes("@flowgram.ai"))
  .filter((file) => !file.endsWith(path.join("src", "components", "canvas", "flowgramAdapter.js")));
assertCheck(directFlowgram.length === 0, `FlowGram imports escaped the adapter: ${directFlowgram.join(", ")}`);

const visibleSourceOutsideApprovedModelPicker = visibleFiles
  .filter((file) => !file.includes(`${path.sep}components${path.sep}models${path.sep}`))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
assertCheck(!/\bprovider\b/i.test(visibleSourceOutsideApprovedModelPicker), "provider internals leaked outside the approved model picker");
for (const pattern of [/\bartifact path\b/i, /\bbearer token\b/i]) {
  assertCheck(!pattern.test(visibleSource), `internal term leaked into visible UI: ${pattern}`);
}

assertCheck(app.includes("MainAgentView"), "Main Agent must have a Product route");
assertCheck(mainAgent.includes('kind: "agent_message"') === false, "typed Agent Turn payloads must stay in Agent state, not the visual component");
assertCheck(mainAgent.includes("ImageComposer") && mainAgent.includes("ChatComposer"), "Main Agent must expose typed Chat and Image composers");
assertCheck(mainAgent.includes("imageParameterSupport"), "Main Agent image fields must follow the selected model's public parameter support");
assertCheck(read("src/state/agents/useMainAgent.js").includes("selectModel.mutateAsync"), "Agent model selection must update the server-owned Session preference");
assertCheck(mainAgent.includes('requiredCapabilities={["chat", "tool_calling"]}') && mainAgent.includes('requiredCapabilities={["image_generation"]}'), "Main Agent pickers must be capability-specific");
assertCheck(modelPicker.includes('data-selection-kind={selectionKind}'), "ModelPicker must preserve profile versus immutable revision selection semantics");
assertCheck(api.includes("artifactContentUrl") && !mainAgent.includes("data:"), "generated images must render through authorized Artifact URLs, not data URLs");
assertCheck(createLoop.includes("builderModelRevisionId") && builder.includes("builderModelRevisionId"), "Loop Creator and Builder must pin the selected proposal model revision");
assertCheck(createLoop.includes("builderModelReady") && builder.includes("builderModelReady"), "disabled or historical model revisions must not submit proposals");
assertCheck(builder.includes("WorkflowModelSettings") && builder.includes("NodeModelOverride"), "Builder must expose capability defaults and model-backed Skill overrides");
assertCheck(skillLifecycleView.includes("SkillCreatorAgentPanel"), "Skill Creator must submit proposal Turns through the shared model selection path");
for (const value of [...i18n.matchAll(/:\s*"([^"]*)"/g)].map((match) => match[1])) {
  for (const pattern of [/\bcontract\b/i, /\bledger\b/i, /\bpatch receipt\b/i, /\bmock run\b/i, /\bscoped\b/i, /契约/, /克隆/, /回执/]) {
    assertCheck(!pattern.test(value), `internal copy remains: ${value}`);
  }
}

assertCheck(source.includes(':root[data-theme="dark"]'), "explicit dark mode missing");
assertCheck(source.includes('data-locale={workspace.locale}'), "locale mode missing");
assertCheck(source.includes("grid-template-columns: 316px minmax(0, 1fr)"), "Builder must preserve canvas-first width");
assertCheck(source.includes("minmax(520px, 1fr)"), "Builder canvas minimum height missing");
assertCheck(app.includes("LoopsBoardView"), "Loops lifecycle board must own the Loops route");
assertCheck(loopsBoard.includes('data-testid="loopops.loops.ai-command"'), "Loops board must expose the AI-native command entry");
assertCheck(loopsBoard.includes('data-testid="loopops.loops.view.board"') && loopsBoard.includes('data-testid="loopops.loops.view.list"'), "Loops board must expose stable board/list views");
assertCheck(loopsBoard.includes("onDrop") && loopsBoard.includes("draggable"), "Lifecycle board transitions must support drag requests with keyboard-equivalent actions");
assertCheck(app.includes("CreateLoopView"), "Loop creation must have a dedicated route surface");
assertCheck(createLoop.includes("workspace.createWorkflow") && createLoop.includes("workspace.createWorkflowProposal") && createLoop.includes("workspace.openLoopImportDialog"), "Loop creation modes must call Product-backed actions");
assertCheck(createLoop.includes('data-testid="loopops.create-loop.proposal-review"'), "Goal-based Loop creation must review the AI proposal before opening the editable draft");
assertCheck(workspace.includes("server.mutations.generateLoopProposal") && workspace.includes("creationProposalContext"), "Goal-based Loop creation must use the Product API proposal path");
for (const mode of ["goal", "blank", "starting", "upload", "duplicate"]) {
  assertCheck(createLoop.includes(`id: "${mode}"`), `Loop creation mode is missing: ${mode}`);
}
assertCheck(!createLoop.includes("actions.makeCopy"), "Loop copy action must use an existing localized label");
assertCheck(app.includes("LoopOverviewView"), "Loop object overview must have a dedicated surface");
assertCheck(app.includes("RunPreflightView"), "Run preflight must have a dedicated surface");
assertCheck(app.includes("TeamLibraryView"), "Team library must have a dedicated route");
assertCheck(app.includes("TeamLibrarySkillView"), "Team Skill detail must have a dedicated route");
assertCheck(app.includes("LoopPublishView"), "Loop publish review must have a dedicated route");
assertCheck(app.includes("TeamLibraryLoopView"), "Team Loop detail/update must have a dedicated route");
assertCheck(workspaceShell.includes("GlobalNav") && !workspaceShell.includes("SidebarNav"), "production shell must use the global top navigation");
for (const anchor of [
  "loopops.global-nav",
  "loopops.global-create",
  "loopops.global-create.skill",
  "loopops.global-create.upload-skill",
  "loopops.global-create.loop",
  "loopops.global-create.upload-loop",
  "loopops.inbox",
  "loopops.account-menu",
]) {
  assertCheck(globalNav.includes(anchor), `global shell control missing: ${anchor}`);
}
assertCheck(teamLibrary.includes("workspace.openLibrarySkill"), "Team Skill rows must open a real detail route");
assertCheck(!source.includes("PublishLoopDialog"), "legacy publish dialog must be physically removed");
assertCheck(builder.includes("workspace.openPublishReview(loop.id)"), "Builder publish must use the rendered Loop identity");
assertCheck(!builder.includes("openPublishReview(selectedLoop.id)"), "Builder publish must not reference an undefined selection alias");
assertCheck(source.includes('navigateToPage("loop-overview"'), "opening a Loop must navigate to its object overview");
assertCheck(source.includes('navigateToPage("run-preflight"'), "ready Loop actions must navigate to preflight before execution");
assertCheck(source.includes("parseWorkbenchPath"), "addressable product route parser missing");
assertCheck(source.includes("window.history"), "product navigation must update browser history");
assertCheck(source.includes('"loopops.topbar.primary.create-skill"'), "Skills primary action must create a Skill");
assertCheck(!workspace.includes("createPublishedSkill"), "Skill creation must not upload, validate, and publish in one hidden mutation");
assertCheck(queries.includes('["ready_draft", "needs_decision"]'), "Skill package inspection must preserve the executable decision state");
assertCheck(queries.includes("skillPackagePromotionData(inspected, { permissionAcknowledged })"), "Skill package promotion must receive explicit review state");
assertCheck(!queries.includes("WeakSet"), "Executable package acknowledgement must not use hidden module state");
assertCheck(createSkillDialog.includes('data-testid="loopops.create-skill.executable-confirmation"'), "Executable package review confirmation is missing");
assertCheck(createSkillDialog.includes('data-testid="loopops.create-skill.executable-acknowledgement"'), "Executable package review checkbox is missing");
assertCheck(createSkillDialog.includes('testId: "loopops.create-skill.mode-files"'), "Skill creation must support device files");
assertCheck(createSkillDialog.includes('testId: "loopops.create-skill.mode-github"'), "Skill creation must support a public GitHub repository");
assertCheck(createSkillDialog.includes('data-testid="loopops.create-skill.upload-status"'), "Skill creation must expose transfer progress");
assertCheck(createSkillDialog.includes('data-testid="loopops.create-skill.retry"'), "Interrupted Skill transfers need a visible recovery action");
assertCheck(createSkillDialog.includes("uploadProgress("), "Skill transfer progress must be derived from received bytes");
assertCheck(serverState.includes("capabilities.resources === true"), "Optional material queries must follow workspace capabilities");
assertCheck(serverState.includes("error: bootstrap.error || activeSession.error || null"), "Only workspace/session bootstrap errors may replace the entire workspace");
assertCheck(serverState.includes("membership: activeSession.data?.data?.membership"), "Workspace role must come from the session authority");
assertCheck(app.includes('data-testid="loopops.workspace.read-only"') && app.includes('data-testid="loopops.workspace.request-access"'), "View-only workspaces need a visible access recovery action");
assertCheck(objectQueryState.includes("permissions.copyRequest"), "Permission object states need an access request action");
assertCheck(serverState.includes("surfaceState") && serverState.includes("retrySurface"), "Object surfaces need isolated loading and recovery state");
assertCheck(workspace.includes("ui.route.skillId") && workspace.includes("managedSkills.find((skill) => skill.id === ui.route.skillId) || null"), "An invalid Skill route must not fall back to the first Skill");
assertCheck(app.includes('data-testid="loopops.workspace.offline"'), "The workspace needs a visible offline state");
assertCheck(objectQueryState.includes("requestId") && objectQueryState.includes('return "notFound"'), "Object errors need not-found and support diagnostics");
assertCheck(runStreamHook.includes("connectionAttempt") && runStreamHook.includes("browser_offline"), "Run updates must support explicit reconnect and offline state");
assertCheck(runDetails.includes('data-testid="loopops.runs.reconnect"'), "Run detail needs a visible live-update recovery action");
assertCheck(runDetails.includes('data-testid="loopops.runs.review.approve"') && runDetails.includes("reviewBusy"), "Review decisions need stable actions and a pending lock");
assertCheck(runDetails.includes('data-testid="loopops.runs.review.comment"'), "Review decisions need a persisted reviewer note field");
assertCheck(runDetails.includes('data-testid="loopops.runs.evidence-gaps"'), "Run details must expose authoritative evidence gaps");
assertCheck(runDetails.includes("TERMINAL.has(run.status)"), "Completed runs must support an explicit rerun");
assertCheck(workspace.includes('activeRun.status === "completed"') && workspace.includes("activeRun.canonical?.inputs"), "A completed Run must start again from its immutable revision and saved information");
assertCheck(workspace.includes('navigateToPage("runs", { loopId: activeRun.loopId, runId: retryRunId })'), "Rerun must navigate the route and event stream to the new Run");
assertCheck(!teamLibrary.includes("onClick={() => workspace.adoptTeamRelease(release)}"), "Team library rows must not apply updates without review");
assertCheck(teamLibrary.includes("libraryInlineUpdateReview") && teamLibrary.includes("loopops.library.apply-update."), "Team library updates need an explicit review and confirmation step");
assertCheck(source.includes('data-testid="loopops.connections.rebinding"'), "Team connection rebinding sheet missing");
assertCheck(source.includes('data-testid="loopops.connections.submit-bindings"'), "Connection rebinding needs explicit confirmation");
assertCheck(source.includes("connectionBindings"), "Team lifecycle actions must submit explicit connection bindings");
assertCheck(source.includes("workspace.readOnlyWorkspace") && source.includes("connections.viewerReason"), "Connection setup must remain read-only for viewers");
const connectionSheet = fs.readFileSync(path.join(root, "src/components/connections/ConnectionRebindingSheet.jsx"), "utf8");
for (const internalField of ["secret", "provider", "accountLabel", "executionRef", "packageHash", "objectId"]) {
  assertCheck(!connectionSheet.includes(internalField), `Connection UI references restricted field ${internalField}`);
}
assertCheck(i18n.includes('"skillCreate.executableIsolationSummary"'), "Executable isolation copy is missing");
assertCheck(queries.includes("createSkillUpdateDraft"), "Skill updates must start as an explicit editable draft");
assertCheck(queries.includes("useSkillVersionsQuery"), "Skill version history must load from the Product API");
assertCheck(queries.includes("useSkillUsageQuery"), "Skill usage impact must load from the Product API");
assertCheck(queries.includes("useSkillVersionDiffQuery"), "Skill version comparison must load from the Product API");
assertCheck(queries.includes("useLoopSkillUpdatePreviewQuery"), "Loop Skill update review must load from an addressable Product API query");
assertCheck(queries.includes("refreshSkillLifecycle(variables.skillId)"), "Skill publication must refresh detail, version history, and usage from server authority");
assertCheck(workspace.includes("...(skillVersionId ? { skillVersionId } : {})"), "Workspace navigation must preserve immutable Skill version route parameters");
assertCheck(queries.includes("useSkillDraftPackageQuery"), "Skill package editor must load server state");
assertCheck(queries.includes("replaceSkillDraftPackage"), "Skill package edits must use a Product API mutation");
assertCheck(skillPackageEditor.includes("workspace.saveSelectedSkillPackage"), "Skill package editor must not save only in browser state");
assertCheck(
  skillPackageEditor.includes('const REQUIRED_FILES = ["SKILL.md", "scripts/main.py", "skill.runtime.json"]'),
  "Skill package editor must preserve the required runtime manifest",
);
assertCheck(
  skillPackageEditor.includes('kind: "runtime_manifest"'),
  "Skill package editor must keep runtime settings as a typed package file",
);
assertCheck(skillPackageEditor.includes("permissionAcknowledged"), "Skill file replacement must require executable-content review");
assertCheck(workspace.includes('error?.code === "skill_draft_conflict"'), "Skill package conflicts must not blindly retry a stale ETag");
assertCheck(skillPackageEditor.includes('data-testid="loopops.skill.package.conflict"'), "Skill package conflicts need a visible recovery state");
assertCheck(skillPackageEditor.includes("workspace.reloadSelectedSkillDraft"), "Skill package conflicts must reload server authority explicitly");
assertCheck(skillPackageEditor.includes('data-testid="loopops.skill.package.conflict.comparison"'), "Skill package conflicts need a side-by-side comparison");
assertCheck(skillPackageEditor.includes('data-testid="loopops.skill.package.conflict.merge"'), "Skill package conflicts need an explicit merge save action");
assertCheck(skillPackageEditor.includes("loadLatestSkillPackageForConflict"), "Conflict review must read server authority without replacing local edits");
assertCheck(workspace.includes("ifMatchOverride || selectedSkillDraftEtag"), "Conflict merge must save against the latest reviewed ETag");
assertCheck(
  workspace.includes("const visibleSkillDraft = selectedManagedSkill?.canonical?.draft || null"),
  "published Skills must not expose their retained source draft as an editable draft",
);
assertCheck(!workspace.includes("selectManagedSkill("), "Skill update success must not call an undefined selection helper");
assertCheck(workspace.includes("setSelectedManagedSkillId(skill.id)"), "Skill update success must retain the updated Skill selection");
assertCheck(source.includes('data-testid="loopops.loop-update.review"'), "Loop Skill updates need a dedicated review surface");
assertCheck(source.includes('navigateToPage("loop-update"'), "Skill usage must open an addressable Loop update review route");
assertCheck(source.includes('paletteSource: "workspace"'), "Builder must include published workspace Skills in its Skill library");
assertCheck(source.includes("workspace.addManagedSkillToLoop"), "Builder must pin workspace Skills through their published asset path");
assertCheck(
  createLoop.includes('id: "starting"')
    && createLoop.includes("setMode(id)")
    && workspace.includes('setCreateLoopInitialMode(["goal", "blank", "starting", "upload", "duplicate"]'),
  "Use template must remain available through the starting-point creation mode",
);
assertCheck(
  skillLifecycleView.includes(") : canCreateUpdate ? (") && !skillLifecycleView.includes("disabled={!canCreateUpdate}"),
  "read-only catalog Skills must not expose owner-only update actions",
);
assertCheck(updateSkillDialog.includes("initialFocusSelector=\"[data-testid='loopops.skill-update.name']\""), "Skill update dialog must declare its meaningful initial focus target");
assertCheck(createSkillDialog.includes("initialFocusSelector=") && createSkillDialog.includes("returnFocusSelector="), "Skill creation dialog must own initial focus and opener restoration");
for (const internalField of ["executionRef", "packageHash", "contentHash", "objectId"]) {
  assertCheck(!skillPackageEditor.includes(internalField), `Skill package UI references internal field ${internalField}`);
}
assertCheck(!queries.slice(queries.indexOf("const createSkillUpdateDraft"), queries.indexOf("const deprecateSkill")).includes("publishSkill("), "creating a Skill update draft must not publish it");
assertCheck(updateSkillDialog.includes("createSkillUpdateDraft"), "Skill update dialog must create a draft before test and publication");
assertCheck(!updateSkillDialog.includes("releaseNotes") && !updateSkillDialog.includes("form.version"), "Skill update dialog must not collect publication fields before validation");
assertCheck(source.includes('navigateToPage("skill-overview"'), "Skill selection must open an addressable object route");
assertCheck(source.includes('loop?.readiness === "Ready"'), "preflight must include server-derived readiness in its start gate");
assertCheck(source.includes("nav.loops"), "primary Loop navigation missing");
assertCheck(source.includes("nav.library"), "primary Team library navigation missing");

console.log("web_prototype_smoke=pass");
console.log("web_prototype_server_state=tanstack-query");
console.log("web_prototype_execution=product-api");
