import { Markdown } from "../features/files/Markdown.jsx";
import { ResultTime, ResultFile } from "../features/files/ResultFiles.jsx";
import { Interaction } from "./AgentInteraction.jsx";
import { WorkbenchNavigation, ProjectSwitcher } from './WorkbenchNavigation.jsx';
import { Composer, ComposerAction, AttachmentChip, ToolbarButton } from './WorkbenchControls.jsx';
import { ConversationMessages } from './ConversationMessages.jsx';
import { ConversationSurface, flushConversationSurface } from './ConversationSurface.jsx';
import { WorkbenchSettings } from './WorkbenchSettings.jsx';
import { ProjectsDialog, MoveSessionDialog, SessionActions, RenameSessionDialog, SessionDateDivider } from './WorkspaceNavigation.jsx';

import { EmbeddedPane } from '../features/browser/EmbeddedPane.jsx';
import { ProjectMaterialPicker } from '../features/files/ProjectMaterialPicker.jsx';
import { AgentConnectionsDialog } from '../features/connections/AgentConnectionsDialog.jsx';
import { RemoteTaskPanel } from '../features/connections/RemoteTaskPanel.jsx';
import { ModelConnectionsDialog } from "../features/connections/ModelConnectionsDialog.jsx";
import { SchedulesDialog } from '../features/schedules/SchedulesDialog.jsx';
import { CapabilitiesDialog } from '../features/capabilities/CapabilitiesDialog.jsx';
import "../features/connections/model-connections.css";
import { invoke, listen, beforeClose } from "../platform/desktop-bridge.mjs";
import { LocalDraftNavigation } from "./local-draft-navigation.mjs";
import { createRefreshQueue } from "./refresh-queue.mjs";
import { LocalLoopTrialDialog } from '../features/methods/LocalLoopTrialDialog.jsx';
import { FileReferencePicker, SentFileReference, referenceLabel, referenceKey } from "../features/files/FileReferencePicker.jsx";
import { MethodCaptureDialog } from "../features/methods/MethodCaptureDialog.jsx";
import { LoopCaptureDialog } from "../features/methods/LoopCaptureDialog.jsx";
import { SkillOSPanel } from "../features/methods/SkillOSPanel.jsx";
import { Button, Textarea, ChoiceMenu, MenuItem, AssistantOptions, SelectField } from "../shared/ResearchControls.jsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderOpen, Plus, ArrowUp, ArrowDown, Square, Files, X, ChevronRight, ChevronLeft, FileText, Folder, RotateCcw, LoaderCircle, Check, ShieldCheck, BookOpen, Search, Globe, ArrowUpRight, MoreHorizontal, PanelLeft, Table2, AtSign, ChevronDown, ArrowRight, PanelsTopLeft, Sparkles, Archive, ArchiveRestore, Pin } from "lucide-react";
import "../shared/supporting-panels.css";

import "../features/methods/skill-os.css";
import { TeamWorkDialog } from "../features/team/TeamWorkDialog.jsx";
import { CloudDialog } from "../features/team/CloudDialog.jsx";
import { SyncDialog, syncLabels } from "../features/team/SyncDialog.jsx";
import { WeChatImportDialog } from '../features/wechat/WeChatImportDialog.jsx';
import '../features/wechat/wechat-import.css';
import './workbench.css';
import './workspace-navigation.css';

const command = (method, args = {}) => invoke("local_command", { method, args });
const labels = { idle: "可以继续", starting: "正在连接 Agent", running: "正在处理", waiting: "需要你的回应", stopping: "正在停止", interrupted: "可以恢复", failed: "需要处理" };
const active = (status) => ["starting", "running", "waiting", "stopping"].includes(status);
const agentName = (agent) => ({ pi: 'Pi', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', kimi: 'Kimi Code', omp: 'oh-my-pi', manus: 'Manus', 'workbuddy-local': 'WorkBuddy 本地', 'workbuddy-cloud': 'WorkBuddy 云端', muse: 'Muse' }[agent] || agent);
const compactSessionCount = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const sessionState = (status) => ({ starting: "连接中", running: "进行中", waiting: "待回应", stopping: "停止中", interrupted: "已中断", failed: "需处理" })[status] || "";

export default function App() {
  const [appearance, setAppearance] = useState(() => {
    try { const saved = localStorage.getItem('turnsu.appearance'); return ['light', 'dark'].includes(saved) ? saved : 'system'; }
    catch { return 'system'; }
  });
  const [textSize, setTextSize] = useState(() => {
    try { return localStorage.getItem('turnsu.text-size') === 'large' ? 'large' : 'standard'; }
    catch { return 'standard'; }
  });
  const [systemDark, setSystemDark] = useState(() => {
    try { return matchMedia('(prefers-color-scheme: dark)').matches; }
    catch { return false; }
  });
  const theme = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance;
  useEffect(() => {
    if (appearance !== 'system') return;
    let query;
    const changed = event => setSystemDark(event.matches);
    try { query = matchMedia('(prefers-color-scheme: dark)'); setSystemDark(query.matches); query.addEventListener('change', changed); }
    catch { setSystemDark(false); }
    return () => query?.removeEventListener('change', changed);
  }, [appearance]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.textSize = textSize;
    try { localStorage.setItem('turnsu.appearance', appearance); localStorage.setItem('turnsu.text-size', textSize); }
    catch { setError('外观已切换，但暂时无法记住选择。'); }
  }, [theme, appearance, textSize]);
  const [embeddedOpen,setEmbeddedOpen] = useState(false);
  const [surfaceState,setSurfaceState]=useState(null),[surfaceExpanded,setSurfaceExpanded]=useState(false),[settingsOpen,setSettingsOpen]=useState(false);
  const [compactWorkspace, setCompactWorkspace] = useState(() => matchMedia('(max-width: 1380px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 1380px)');
    const changed = () => setCompactWorkspace(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  const conversationObscured = surfaceExpanded && compactWorkspace;
  const settingsButton = useRef(null);
  const [openPopup, setOpenPopup] = useState('');
  const popupChanged = (id, open) => setOpenPopup(current => open ? id : current === id ? '' : current);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const outputsButton = useRef(null), outputsHeading = useRef(null);
  useEffect(() => {
    if (!outputsOpen) return;
    outputsHeading.current?.focus();
    const close = event => {
      if (event.key === 'Escape') { setOutputsOpen(false); outputsButton.current?.focus(); }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [outputsOpen]);
  const [view, setView] = useState('workbench');
  const [computerState, setComputerState] = useState(null);
  useEffect(() => { let live = true; const read = () => command('computer.status').then(value => { if (live) setComputerState(value); }).catch(() => {}); read(); const sub = listen(({ payload }) => { if (payload.type === 'computer-changed') read(); }); return () => { live = false; sub.then(off => off()); }; }, []);
  const [agentConnectionsOpen, setAgentConnectionsOpen] = useState(false), [agentConnections, setAgentConnections] = useState([]), [agentConnectionId, setAgentConnectionId] = useState('');
  const [remoteMaterials, setRemoteMaterials] = useState(''), [allowExternal, setAllowExternal] = useState(false);
  const agentButton = useRef(null);
  async function readAgentConnections() { const value = await invoke('agent_connection_list'); setAgentConnections(value.connections); }
  useEffect(() => { readAgentConnections().catch(() => {}); }, []);
  const [connectionsOpen, setConnectionsOpen] = useState(false), [connections, setConnections] = useState([]), [connectionId, setConnectionId] = useState('');
  const connectionButton = useRef(null), connectionTrigger = useRef(null);
  function openConnections(event) { connectionTrigger.current = event.currentTarget; setConnectionsOpen(true); }
  async function readConnections() { const value = await invoke('connection_list'); setConnections(value.connections); }
  function closeConnections() { setConnectionsOpen(false); (connectionTrigger.current || connectionButton.current)?.focus(); }
  useEffect(() => { readConnections().catch(() => {}); }, []);
  const [captureOpen, setCaptureOpen] = useState(null);
  const captureTrigger = useRef(null);
  function closeCapture() { setCaptureOpen(null); captureTrigger.current?.focus(); }
  const [workOpen, setWorkOpen] = useState(false);
  const workButton = useRef(null), wasWorkOpen = useRef(false);
  useEffect(() => { if (!workOpen && wasWorkOpen.current) workButton.current?.focus(); wasWorkOpen.current = workOpen; }, [workOpen]);
  const [cloudOpen, setCloudOpen] = useState(false), [syncOpen, setSyncOpen] = useState(false);
  const syncButton = useRef(null), wasSyncOpen = useRef(false);
  useEffect(() => { if (!syncOpen && wasSyncOpen.current) syncButton.current?.focus(); wasSyncOpen.current = syncOpen; }, [syncOpen]);
  const teamButton = useRef(null), wasCloudOpen = useRef(false);
  useEffect(() => { if (!cloudOpen && wasCloudOpen.current) teamButton.current?.focus(); wasCloudOpen.current = cloudOpen; }, [cloudOpen]);
  const [workspace, setWorkspace] = useState({ projects: [], sessions: [], agents: [] });
  const [booting, setBooting] = useState(true);
  const [projectId, setProjectId] = useState(null), [sessionId, setSessionId] = useState(null), [session, setSession] = useState(null);
  const [collectionId, setCollectionId] = useState(null);
  const [sessionView, setSessionView] = useState('recent'), [allProjectSessions, setAllProjectSessions] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false), [movingSession, setMovingSession] = useState(null), [sessionMenu, setSessionMenu] = useState(null);
  const [managementBusy, setManagementBusy] = useState(false), [managementNotice, setManagementNotice] = useState(null);
  const projectManagerTrigger = useRef(null), searchInput = useRef(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [indexLoading, setIndexLoading] = useState(false), [indexError, setIndexError] = useState("");
  const indexQuery = useRef({}), indexVersion = useRef(0), indexTimer = useRef(null);
  const refreshSelected = useRef(false), eventNeedsSession = useRef(false);
  const [editingSessionId, setEditingSessionId] = useState(null), [editedTitle, setEditedTitle] = useState(""), [renameSaving, setRenameSaving] = useState(false);
  const renameButtons = useRef(new Map());
  const [historyPage, setHistoryPage] = useState(null), [historyLoading, setHistoryLoading] = useState(false);
  const historyVersion = useRef(0);
  const [references, setReferences] = useState([]), [referencePicker, setReferencePicker] = useState(false);
  const composerInput = useRef(null);
  const navigation = useRef(null);
  if (!navigation.current) navigation.current = new LocalDraftNavigation(command);
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
  const [draft, setDraft] = useState(""), [draftLoading, setDraftLoading] = useState(false), [navigationStage, setNavigationStage] = useState(null), [draftStatus, setDraftStatus] = useState("");
  const [error, setError] = useState(""), [ready, setReady] = useState(false), [sending, setSending] = useState(false);
  const currentFiles = useRef({});
  const [filePanel, setFilePanel] = useState(false), [folder, setFolder] = useState(""), [fileList, setFileList] = useState(null), [preview, setPreview] = useState(null);
  const [previewRefChecking, setPreviewRefChecking] = useState(false);
  const [wechatOpen, setWechatOpen] = useState(false);
  const [agentId, setAgentId] = useState("codex");
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const overlayOpen = Boolean(openPopup) || Boolean(editingSessionId) || projectsOpen || Boolean(movingSession) || Boolean(sessionMenu) || settingsOpen || agentConnectionsOpen || connectionsOpen || capabilitiesOpen || schedulesOpen || Boolean(captureOpen) || workOpen || syncOpen || cloudOpen || wechatOpen || referencePicker || view !== 'workbench';
  useEffect(()=>{if(embeddedOpen)invoke('embedded_suspend',{suspended:overlayOpen}).catch(e=>setError(e.message));},[overlayOpen,embeddedOpen]);
  const [agentPreference, setAgentPreference] = useState(null), [preferenceSaving, setPreferenceSaving] = useState(false);
  const manualAgentVersion = useRef(0);
  const [creatingSession, setCreatingSession] = useState(false);
  const modelRequest = useRef(0);
  const [models, setModels] = useState(null), [model, setModel] = useState(""), [modelsLoading, setModelsLoading] = useState(false);
  const [fileError, setFileError] = useState(""), [fileLoading, setFileLoading] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false), [importNotice, setImportNotice] = useState('');
  const selected = useRef(null), draftTimer = useRef(null), draftVersion = useRef(0), fileVersion = useRef(0), refreshTimer = useRef(null), composing = useRef(false);
  const refreshQueue = useRef(null);
  const timeline = useRef(null);
  const transcript = useRef(null), composerArea = useRef(null), atBottom = useRef(true), pendingSend = useRef(null);
  const lastMessageSignature = useRef(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false), [hasNewContent, setHasNewContent] = useState(false);
  currentFiles.current = { projectId, filePanel, folder };
  useEffect(()=>{
    let live=true,timer;setSurfaceState(null);setSurfaceExpanded(false);
    if(!sessionId||!['codex','pi','opencode','kimi','omp'].includes(agentId))return;
    const read=()=>command('ui.read',{sessionId}).then(value=>{if(live)setSurfaceState(value);}).catch(e=>{if(live)setError(e.message);});
    read();const sub=listen(({payload})=>{if(payload.sessionId===sessionId&&['ui-changed','changed'].includes(payload.type)){clearTimeout(timer);timer=setTimeout(read,100);}});
    return()=>{live=false;clearTimeout(timer);sub.then(off=>off());};
  },[sessionId,agentId]);
  const project = workspace.projects.find((p) => p.id === projectId);
  const collectionProject = workspace.projects.find(p => p.id === collectionId) || project;
  const filteredSessions = workspace.sessions;
  const isArchived = Boolean(session?.archived_at);
  const sessionPage = workspace.sessionPage || {};
  const visibleMessages = historyPage?.messages || session?.messages || [];
  const historyNavigation = historyPage?.page || session?.messagePage;
  const chosenConnectionId = session?.connection_id || (!sessionId ? connectionId : "");
  const chosenConnection = connections.find(c => c.id === chosenConnectionId);
  const chosenAgent = workspace.agents.find((a) => a.id === agentId);
  const remoteAgent = ['remote', 'managed', 'handoff'].includes(chosenAgent?.kind);
  const chosenAgentConnectionId = session?.agent_connection_id || agentConnectionId;
  const answering = remoteAgent && session?.status === 'waiting' && ['messageAskUser','cascadeAskUser'].includes(session?.remote?.waiting?.waiting_for_event_type);
  useEffect(() => {
    setAllowExternal(false);
    let saved; try { saved = JSON.parse(localStorage.getItem(`turnsu.remoteDraft:${projectId}:${sessionId || ''}`)); } catch {}
    setRemoteMaterials(typeof saved?.materials === 'string' ? saved.materials : '');
    setAgentConnectionId(session?.agent_connection_id || saved?.connectionId || '');
  }, [projectId, sessionId]);
  function updateRemoteDraft(materials, connection) {
    setRemoteMaterials(materials); setAgentConnectionId(connection); setAllowExternal(false);
    try { localStorage.setItem(`turnsu.remoteDraft:${projectId}:${sessionId || ''}`, JSON.stringify({ materials, connectionId: connection })); } catch { setError('无法保存材料选择，请保留所选路径后重试。'); }
  }
  async function tryAgent(agent, connection = '') {
    setAgentConnectionsOpen(false);
    if (!projectId) { setError('请先打开本地项目，再进行 Agent 试运行。'); return; }
    await selectProject(projectId); ++manualAgentVersion.current; setAgentId(agent); setAgentConnectionId(connection); setModel(''); setConnectionId('');
    changeDraft('检查当前项目材料，说明你能使用的工具、读取范围和限制。先不要修改文件。');
    composerInput.current?.focus();
  }

  useLayoutEffect(() => { if (historyPage && transcript.current) transcript.current.scrollTop = 0; }, [historyPage]);
  async function readHistory(direction, cursor) {
    const id = selected.current, version = ++historyVersion.current;
    setHistoryLoading(true); setError('');
    try {
      await flushConversationSurface();
      if (direction === 'latest') {
        const value = await command('session.read', { sessionId: id });
        if (selected.current === id && version === historyVersion.current) { atBottom.current = true; setAwayFromBottom(false); setHasNewContent(false); setHistoryPage(null); setSession(value); }
      } else {
        const page = await command('session.history', { sessionId: id, [direction]: cursor });
        if (selected.current === id && version === historyVersion.current) { atBottom.current = false; setHistoryPage(page); }
      }
    } catch (e) { if (version === historyVersion.current) setError(String(e)); }
    finally { if (version === historyVersion.current) setHistoryLoading(false); }
  }
  async function readSnapshot(includeSession = true) {
    const id = selected.current, version = indexVersion.current;
    const data = await command("workspace.read", indexQuery.current);
    if (version === indexVersion.current) { setWorkspace(data); setReady(true); }
    if (id && includeSession) {
      const value = await command("session.read", { sessionId: id });
      if (selected.current === id) {
        setSession(value);
        // A definitive failure is a new user attempt next time. Uncertain receipts keep their key.
        if (value.lastSubmission?.status === 'failed' && value.lastSubmission.id === pendingSend.current?.inputId) pendingSend.current = null;
      }
    }
    return data;
  }
  function refresh(includeSession = true) {
    refreshSelected.current ||= includeSession;
    if (!refreshQueue.current) refreshQueue.current = createRefreshQueue(() => {
      const include = refreshSelected.current; refreshSelected.current = false;
      return readSnapshot(include);
    });
    return refreshQueue.current();
  }
  async function loadSessionIndex(query) {
    clearTimeout(indexTimer.current);
    indexQuery.current = query; const version = ++indexVersion.current;
    setIndexLoading(true); setIndexError("");
    try {
      const data = await command('workspace.read', query);
      if (version === indexVersion.current) setWorkspace(data);
    } catch (e) { if (version === indexVersion.current) setIndexError(String(e)); }
    finally { if (version === indexVersion.current) setIndexLoading(false); }
  }
  function searchSessions(value) {
    setSessionSearch(value); clearTimeout(indexTimer.current);
    const query = { ...indexQuery.current, search: value, before: undefined, after: undefined };
    // Invalidate older reads immediately, including queued streaming refreshes.
    indexQuery.current = query; ++indexVersion.current; setIndexLoading(true);
    indexTimer.current = setTimeout(() => loadSessionIndex(query), 180);
  }
  function filterSessions(archived, allProjects = allProjectSessions) {
    setSessionView(archived ? 'archived' : 'recent'); setAllProjectSessions(allProjects);
    loadSessionIndex({ projectId: collectionId, search: sessionSearch, archived, allProjects });
  }
  async function initialize() {
    setBooting(true); setError("");
    try {
      const data = await refresh();
      let saved; try { saved = JSON.parse(localStorage.getItem("turnsu.lastSelection")); } catch {}
      if (navigation.current.version === 0 && saved && data.projects.some((p) => p.id === saved.projectId)) {
        let previous;
        if (saved.sessionId) {
          try { previous = await command('session.locate', { sessionId: saved.sessionId }); } catch {}
        }
        await selectProject(previous?.projectId || saved.projectId, previous?.id || null);
      }
    } catch (e) { setError(String(e)); setReady(false); }
    finally { setBooting(false); }
  }
  useEffect(() => beforeClose(async () => { clearTimeout(draftTimer.current); await flushConversationSurface(); await navigation.current.save(); }), []);
  useEffect(() => {
    let dispose, mounted = true;
    listen(({ payload }) => {
      if (payload.type === "open-project-requested") { openProject(); return; }
      if (payload.type === 'capability-changed' && currentFiles.current.filePanel && payload.projectId === currentFiles.current.projectId) {
        const target = currentFiles.current, version = ++fileVersion.current;
        command('files.list', { projectId: target.projectId, path: target.folder }).then(value => { if (version === fileVersion.current && currentFiles.current.projectId === target.projectId) setFileList(value); }).catch(e => setFileError(String(e)));
      }
      if (payload.type === "disconnected") { setError("本地服务已停止。请重新打开 Turnsu，已保存的内容仍在本机。"); return; }
      eventNeedsSession.current ||= !payload.sessionId || payload.sessionId === selected.current;
      if (!refreshTimer.current) refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        const include = eventNeedsSession.current; eventNeedsSession.current = false;
        refresh(include).catch((e) => setError(String(e)));
      }, 160);
    }).then((fn) => { if (!mounted) fn(); else dispose = fn; });
    initialize();
    return () => { mounted = false; dispose?.(); clearTimeout(refreshTimer.current); clearTimeout(indexTimer.current); };
  }, []);
  useEffect(() => { if (collectionId) localStorage.setItem("turnsu.lastSelection", JSON.stringify({ projectId: collectionId, sessionId })); }, [collectionId, sessionId]);
  useEffect(() => {
    if (!session) return;
    const last = session.messages?.at(-1);
    const signature = `${session.id}:${last?.id || ""}:${last?.text?.length || 0}:${session.status}:${session.interactions?.length || 0}`;
    if (lastMessageSignature.current && lastMessageSignature.current !== signature && !atBottom.current) setHasNewContent(true);
    lastMessageSignature.current = signature;
    if (atBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [session]);

  function goToLatest() {
    atBottom.current = true; setAwayFromBottom(false); setHasNewContent(false);
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  useEffect(() => {
    const area = composerArea.current, viewport = transcript.current;
    if (!area || !viewport) return;
    const conversation = area.parentElement;
    const resize = () => {
      conversation.style.setProperty('--composer-height', `${Math.ceil(area.getBoundingClientRect().height)}px`);
      if (atBottom.current) viewport.scrollTop = viewport.scrollHeight;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(area);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    resize();
    return () => { observer.disconnect(); conversation.style.removeProperty('--composer-height'); };
  }, [projectId, sessionId, view, ready, navigationStage, draftLoadFailed, Boolean(visibleMessages.length), isArchived]);

  useEffect(() => {
    if (!filePanel || !preview?.path || !project?.sharing?.syncedAt) return;
    let current = true;
    command("files.read", { projectId, path: preview.path }).then(value => { if (current) setPreview(value); }).catch(e => { if (current) setFileError(String(e)); });
    return () => { current = false; };
  }, [project?.sharing?.syncedAt, projectId, filePanel, preview?.path]);

  async function selectProject(id, nextSession = null, { keepSearch = false, surfaceSaved = false } = {}) {
    if (sending || creatingSession) return;
    clearTimeout(draftTimer.current); setDraftLoading(true); setDraftLoadFailed(false);
    try {
      if (!surfaceSaved) await flushConversationSurface();
      setNavigationStage('saving');
      if(embeddedOpen){await invoke('embedded_hide');setEmbeddedOpen(false);}
      const navigated = await navigation.current.select(id, nextSession, {
        locate: sessionId => command('session.locate', { sessionId }),
        start(location) {
          id = location.workingProjectId || location.projectId;
          const nextCollection = location.projectId;
          setCollectionId(nextCollection); setSessionMenu(null);
          ++historyVersion.current; setHistoryPage(null); setHistoryLoading(false);
          setNavigationStage("reading"); setEditingSessionId(null);
          if (!keepSearch || Boolean(indexQuery.current.archived) !== Boolean(location.archived)) {
            setSessionSearch(""); setSessionView(location.archived ? 'archived' : 'recent'); setAllProjectSessions(false);
            setWorkspace(w => ({ ...w, sessions: [], sessionPage: {} }));
            loadSessionIndex({ projectId: nextCollection, archived: Boolean(location.archived) });
          }
          ++draftVersion.current; ++fileVersion.current; ++modelRequest.current; setModelsLoading(false); setFileList(null); setPreview(null); setImportNotice(''); setFileError(''); setModel(""); setModels(null); setAgentId(indexQuery.current.projectId === id ? workspace.agentPreference?.agentId || 'codex' : workspace.agents.find(agent => agent.installed)?.id || 'codex'); setAgentPreference(null); setConnectionId("");
          setOutputsOpen(false); setView('workbench'); setWorkOpen(false); setSyncOpen(false); setWechatOpen(false); setProjectId(id); selected.current = nextSession; setSurfaceState(null);setSurfaceExpanded(false);setSessionId(nextSession); setSession(null); setError(""); setDraft(""); setReferences([]); setReferencePicker(false); setDraftStatus(""); setFilePanel(false); pendingSend.current = null; atBottom.current = true; lastMessageSignature.current = null; setAwayFromBottom(false); setHasNewContent(false);
        },
        loaded({ draft: saved, session: value }) {
          setDraft(saved.text); setReferences(saved.references); setDraftLoading(false); setDraftLoadFailed(false); setNavigationStage(null);
          if (value) { setSession(value); pendingSend.current = value.pendingInput || null; setModel(value.model || ""); setAgentId(value.agent); setConnectionId(value.connection_id || ""); }
        },
      });
      if (!navigated) return false;
      if (!nextSession && navigation.current.current?.projectId === id && !selected.current) {
        const choiceVersion = manualAgentVersion.current;
        const preference = await command('agent.preference.read', { projectId: id });
        if (navigation.current.current?.projectId === id && !selected.current) { setAgentPreference(preference); if (choiceVersion === manualAgentVersion.current) setAgentId(preference.agentId); }
      }
      return true;
    } catch (e) {
      const loaded = Boolean(navigation.current.current?.loaded);
      setNavigationStage(null);
      setError(loaded ? `草稿未能保存，已保留当前输入。请重试切换任务。${String(e)}` : String(e));
      setDraftLoading(!loaded); setDraftLoadFailed(!loaded);
      return false;
    }
  }
  async function openProject() {
    try { const p = await invoke("open_project"); if (p) { await refresh(); return await selectProject(p.id); } return false; }
    catch (e) { setError(String(e)); return false; }
  }
  function closeSessionMenu({ restoreFocus = true } = {}) {
    const anchor = sessionMenu?.anchor;
    setSessionMenu(null);
    if (restoreFocus) requestAnimationFrame(() => (anchor?.isConnected ? anchor : searchInput.current)?.focus());
  }
  async function manageProject(method, args) { await command(method, args); await refresh(false).catch(e => setError(`项目已更新，列表暂时未刷新：${e.message}`)); }
  async function manageSession(method, item, args = {}) {
    if (managementBusy) return;
    setManagementBusy(true); setError('');
    try {
      if (selected.current === item.id) { clearTimeout(draftTimer.current); await flushConversationSurface(); await navigation.current.save(); }
      const value = await command(method, { sessionId: item.id, ...args });
      setSession(current => current?.id === value.id ? value : current);
      await refresh(false).catch(e => setIndexError(`操作已保存，列表暂时未刷新：${e.message}`));
      return value;
    } finally { setManagementBusy(false); }
  }
  async function archiveSession(item, archived) {
    try {
      const value = await manageSession('session.archive', item, { archived });
      if (!value) return;
      // manageSession saved both drafts before changing archive state. That state
      // unmounts the App; do not ask its now-closed bridge to save a second time.
      if (archived && selected.current === item.id) await selectProject(value.collection_project_id || value.project_id, null, { surfaceSaved: true });
      // Restoring from the list may leave another open conversation. Its App
      // still needs the normal save-before-navigation path.
      if (!archived) await selectProject(value.collection_project_id || value.project_id, value.id);
      setManagementNotice({ text: archived ? '会话已归档，历史、成果和草稿都已保留。' : '已恢复到最近会话。', ...(archived ? { undo: () => archiveSession(value, false) } : {}) });
    } catch (e) { setError(e.message); }
  }
  async function moveSession(targetId) {
    const value = await manageSession('session.move', movingSession, { projectId: targetId });
    if (!value) return;
    setMovingSession(null);
    await selectProject(targetId, value.id);
    setManagementNotice({ text: '会话已移入所选项目，继续使用原工作文件夹。' });
  }
  async function saveAgentPreference(scope) {
    if (!projectId || sessionId || preferenceSaving) return;
    setPreferenceSaving(true); setError('');
    try {
      const preference = await command('agent.preference.save', { scope, projectId, agentId });
      setAgentPreference(preference);
    } catch (e) { setError(String(e)); }
    finally { setPreferenceSaving(false); }
  }
  function changeDraft(value, nextReferences = references) {
    if (!navigation.current.current?.loaded) return;
    navigation.current.edit(value, nextReferences);
    setReferences(nextReferences); setDraft(value); setDraftStatus("正在保存"); clearTimeout(draftTimer.current);
    const id = projectId, version = ++draftVersion.current;
    draftTimer.current = setTimeout(() => command("draft.save", { projectId: id, sessionId, text: value, references: nextReferences }).then(() => { if (version === draftVersion.current) setDraftStatus("已保存到本机"); }).catch(() => { if (version === draftVersion.current) setDraftStatus("保存失败，请保留输入内容"); }), 180);
  }
  useEffect(() => { if (!referencePicker) composerInput.current?.focus(); }, [referencePicker]);
  function closeReferencePicker() { setReferencePicker(false); }
  function addReference(path) {
    if (references.some(item => referenceKey(item) === referenceKey(path))) { closeReferencePicker(); return; }
    if (references.length >= 4) { setError("每次最多引用 4 份资料。"); return; }
    changeDraft(draft, [...references, path]); closeReferencePicker();
  }
  async function useProjectFilePath(path) {
    try{await addMaterialPaths([path]);closeReferencePicker();}catch(e){setError(e.message);}
  }
  async function addPreviewReference(path) {
    if (previewRefChecking) return;
    const currentProject = projectId;
    setPreviewRefChecking(true);
    setFileError('');
    try {
      await command('references.validate', { projectId: currentProject, path });
      if (navigation.current.current?.projectId === currentProject) addReference(path);
    } catch (cause) { if (navigation.current.current?.projectId === currentProject) setFileError(`无法引用此文件：${String(cause)}`); }
    finally { setPreviewRefChecking(false); }
  }
  async function send(continueOffline = false) {
    if (isArchived || !draft.trim() || draftLoading || modelsLoading || sending || (active(session?.status) && !answering)) return;
    if (remoteAgent && (!allowExternal || !chosenAgentConnectionId)) { setError("请选择 Agent 账号，并确认本次提示词与材料外发。"); return; }
    if (!remoteAgent && chosenConnectionId && !model) { setError("请先读取此连接的模型目录并选择模型。"); return; }
    ++historyVersion.current; setHistoryPage(null); setHistoryLoading(false); atBottom.current = true;
    setSending(true); setError(""); clearTimeout(draftTimer.current);
    const submitted = draft, materials = remoteMaterials.split('\n').map(p => p.trim()).filter(Boolean);
    try {
      await command("draft.save", { projectId, sessionId, text: submitted, references });
      let id = selected.current;
      if (remoteAgent) await command("remote.materials", { projectId, paths: materials });
      if (!id) { const s = await command("session.create", { projectId, agent: agentId, connectionId: remoteAgent ? null : chosenConnectionId || null, agentConnectionId: chosenAgentConnectionId }); id = s.id; await command("draft.save", { projectId, sessionId: id, text: submitted, references }); await command("draft.save", { projectId, text: "", references: [] }); navigation.current.adopt(projectId, id, submitted, references); selected.current = id; setSessionId(id); setSession(s); }
      if (!remoteAgent && model && !sessionId) await command("session.model", { sessionId: id, model });
      if (!pendingSend.current || pendingSend.current.text !== submitted || pendingSend.current.sessionId !== id || JSON.stringify(pendingSend.current.references || []) !== JSON.stringify(references) || JSON.stringify(pendingSend.current.materials || []) !== JSON.stringify(remoteAgent ? materials : [])) pendingSend.current = { inputId: crypto.randomUUID(), sessionId: id, text: submitted, references, materials: remoteAgent ? materials : [], allowExternal: remoteAgent ? allowExternal : false };
      const result = await command("session.send", { ...pendingSend.current, ...(continueOffline === true ? { continueOffline: true } : {}) });
      if (selected.current === id) { navigation.current.adopt(projectId, id, "", []); setSession(result); setDraft(""); setReferences([]); setDraftStatus(""); setAllowExternal(false); setRemoteMaterials(""); localStorage.removeItem(`turnsu.remoteDraft:${projectId}:${id}`); localStorage.removeItem(`turnsu.remoteDraft:${projectId}:`); }
      await command("draft.save", { projectId, sessionId: id, text: "", references: [] }); pendingSend.current = null; await refresh();
    } catch (e) {
      setError(String(e));
      if (pendingSend.current) {
        const latest = await command('session.read', { sessionId: pendingSend.current.sessionId }).catch(() => null);
        if (latest?.lastSubmission?.id === pendingSend.current.inputId && latest.lastSubmission.status === 'failed') pendingSend.current = null;
      }
      await refresh().catch(() => {});
    }
    finally { setSending(false); }
  }
  async function loadModels() {
    if (draftLoading || sending || creatingSession) return;
    const request = ++modelRequest.current;
    setModelsLoading(true); setError("");
    try {
      let id = sessionId;
      if (["claude", "opencode", "kimi", "omp"].includes(agentId) && !id && !chosenConnectionId) {
        setCreatingSession(true);
        const s = await command("session.create", { projectId, agent: agentId, connectionId: chosenConnectionId || null });
        await command("draft.save", { projectId, sessionId: s.id, text: draft, references });
        await command("draft.save", { projectId, text: "", references: [] });
        id = s.id; navigation.current.adopt(projectId, id, draft, references); selected.current = id; setSessionId(id); setSession(s); setCreatingSession(false); await refresh();
      }
      if (request !== modelRequest.current) return;
      const available = await command("models.list", { agent: agentId, sessionId: id, projectId, connectionId: chosenConnectionId || null });
      if (request === modelRequest.current) setModels(available);
    } catch (e) { if (request === modelRequest.current) setError(String(e)); }
    finally { if (request === modelRequest.current) { setCreatingSession(false); setModelsLoading(false); } }
  }
  async function chooseModel(value) {
    const id = selected.current, version = modelRequest.current;
    try {
      const next = id ? await command("session.model", { sessionId: id, model: value || null }) : null;
      if (selected.current !== id || version !== modelRequest.current) return;
      if (next) setSession(next); setModel(value);
    } catch (e) { if (selected.current === id && version === modelRequest.current) setError(String(e)); }
  }
  async function chooseConnection(value) {
    if (creatingSession || sending) return;
    setCreatingSession(true); setError('');
    try {
      if (sessionId) setSession(await command('session.connection', { sessionId, connectionId: value || null }));
      ++modelRequest.current; setConnectionId(value); setModels(null); setModel('');
    } catch (e) { setError(String(e)); }
    finally { setCreatingSession(false); }
  }
  async function control(method) { setError(""); try { await command(method, { sessionId }); await refresh(); } catch (e) { setError(String(e)); } }
  async function renameSession(event) {
    event.preventDefault();
    const title = editedTitle.trim();
    if (!title || !editingSessionId || renameSaving) return;
    setRenameSaving(true); setError("");
    try {
      const id = editingSessionId;
      const renamed = await command("session.rename", { sessionId: id, title });
      setWorkspace(current => ({ ...current, sessions: current.sessions.map(item => item.id === id ? { ...item, title: renamed.title } : item) }));
      setSession(current => current?.id === id ? { ...current, title: renamed.title } : current);
      finishRename();
      await refresh().catch(e => setError(`名称已保存，列表刷新暂时失败：${String(e)}`));
    } catch (e) { setError(`会话名称未保存：${String(e)}`); }
    finally { setRenameSaving(false); }
  }
  function finishRename() {
    const id = editingSessionId;
    setEditingSessionId(null); setEditedTitle("");
    requestAnimationFrame(() => (renameButtons.current.get(id) || searchInput.current)?.focus());
  }
  async function listFiles(path = "") {
    const version = ++fileVersion.current; setFileLoading(true); setPreview(null); setFileList(null); setFileError(""); setFolder(path);
    try { const result = await command("files.list", { projectId, path }); if (version === fileVersion.current) setFileList(result); }
    catch (e) { if (version === fileVersion.current) setFileError(String(e)); }
    finally { if (version === fileVersion.current) setFileLoading(false); }
  }
  async function readFile(file) {
    if (file.directory) return listFiles(file.path);
    if (/\.(?:rtf|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(file.path)) return openProjectFile(file.path);
    const version = ++fileVersion.current; setFileLoading(true); setPreview(null); setFileError("");
    try { const result = await command("files.read", { projectId, path: file.path }); if (version === fileVersion.current) setPreview(result); }
    catch (e) { if (version === fileVersion.current) setFileError(String(e)); }
    finally { if (version === fileVersion.current) setFileLoading(false); }
  }
  async function ensureConversation() {
    if(selected.current)return selected.current;
    await command('draft.save',{projectId,text:draft,references});
    const value=await command('session.create',{projectId,agent:agentId,connectionId:chosenConnectionId||null});
    await command('draft.save',{projectId,sessionId:value.id,text:draft,references});
    await command('draft.save',{projectId,text:'',references:[]});
    navigation.current.adopt(projectId,value.id,draft,references);selected.current=value.id;setSessionId(value.id);setSession(value);
    if(model)await command('session.model',{sessionId:value.id,model});
    await refresh(false);return value.id;
  }
  async function addMaterialPaths(paths) {
    const id=await ensureConversation();
    const value=await command('ui.attach',{sessionId:id,paths});
    if(selected.current===id)setSurfaceState(value);
  }
  async function importFiles() {
    if(!projectId||importingFiles||remoteAgent)return;
    setImportingFiles(true);setError('');
    try {
      const result=await invoke('import_files',{projectId});
      if(!result)return;
      if(result.imported.length)await addMaterialPaths(result.imported.map(f=>f.path));
      if(result.failed.length)setError(result.failed.map(f=>f.name+'：'+f.reason).join('；'));
    }catch(e){setError(e.message);}finally{setImportingFiles(false);}
  }
  async function showBrowser(url, expectedSessionId) {
    try {
      const id = expectedSessionId || await ensureConversation();
      if (selected.current !== id) throw new Error('当前对话已切换，请在原对话打开链接。');
      if (typeof url === 'string') await invoke('browser_open', { sessionId: id, url });
      if (selected.current !== id) throw new Error('当前对话已切换，网页保留在原对话。');
      setOutputsOpen(false); setSurfaceExpanded(false); setFilePanel(false); setEmbeddedOpen(true);
    } catch (e) {
      setError(e.message);
      if (expectedSessionId) throw e;
    }
  }
  async function expandSurface(value){
    if(value){setOutputsOpen(false);await invoke('embedded_hide');setEmbeddedOpen(false);setFilePanel(false);}setSurfaceExpanded(value);
  }
  async function showResult(file){
    await invoke('embedded_hide');setOutputsOpen(false);setEmbeddedOpen(false);setSurfaceExpanded(false);
    if(!/\.(rtf|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(file.path))setFilePanel(true);
    await readFile(file);
  }
  async function openProjectFile(path) {
    setFileError('');
    try { await invoke(/\.(?:txt|json|md|markdown|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(path) ? 'open_project_file' : 'reveal_project_file', { projectId, path }); }
    catch (error) { setFileError(String(error)); }
  }

  const currentSurface = surfaceState?.sessionId === sessionId ? surfaceState : null;
  const resultCount = currentSurface?.results?.reduce((count, result) => count + result.files.length, 0) || 0;
  async function toggleOutputs() {
    if (!outputsOpen) { await invoke('embedded_hide'); setEmbeddedOpen(false); setSurfaceExpanded(false); setFilePanel(false); }
    setOutputsOpen(open => !open);
  }
  const activeSurface = !historyPage && surfaceState?.sessionId === sessionId && surfaceState.presentation;
  const surfaceAnchor = activeSurface && (visibleMessages.some(m => m.id === activeSurface.anchor) ? activeSurface.anchor : visibleMessages.at(-1)?.id);
  // One connected App mount follows the presentation anchor without
  // recreating its iframe, bridge, selection or unsaved fields.
  const inlineSurface = activeSurface && !isArchived && <ConversationSurface key={'surface-'+sessionId} container={timeline} anchor={surfaceAnchor} sessionId={sessionId} title={surfaceState.document.title} expanded={surfaceExpanded} onExpand={expandSurface} onOpenFile={showResult} onOpenLink={showBrowser} theme={theme} textSize={textSize}/>;

  return <div className={`app ${surfaceExpanded ? 'hasExpandedSurface' : ''} ${sidebarOpen ? '' : 'sidebarCollapsed'}`}>
    {computerState?.grant && <div className="computerIndicator" role="status"><strong>{computerState.grant.mode === "local" ? "本机电脑操作已授权" : "隔离电脑已启用"}</strong><span>到期 {new Date(computerState.grant.expiresAt).toLocaleTimeString()}</span><button onClick={() => command("computer.stop").then(() => setComputerState(null)).catch(e => setError(e.message))}>暂停并撤销</button></div>}
    <WorkbenchNavigation open={sidebarOpen} view={view} onView={async next => { try { if(next !== view) await flushConversationSurface(); setView(next); } catch(e) { setError(e.message); } }} onSchedules={() => setSchedulesOpen(true)} appearance={appearance} onAppearance={setAppearance} onPopupChange={popupChanged} settingsRef={settingsButton} onSettings={() => setSettingsOpen(true)}>
      <ProjectSwitcher projects={workspace.projects} currentId={collectionId} title={collectionProject?.sharing?.title || collectionProject?.name} disabled={sending || creatingSession || Boolean(navigationStage)} onSelect={selectProject} onOpen={openProject} onManage={() => setProjectsOpen(true)} triggerRef={projectManagerTrigger} onOpenChange={open => popupChanged('projects', open)}/>
      <Button variant="secondary" className="newTask" disabled={sending || creatingSession || Boolean(navigationStage)} onClick={() => { if (collectionId) selectProject(collectionId); else openProject(); }}><Plus size={17}/><span>新工作</span><span className="newTaskLabel">开始对话</span></Button>
      <nav aria-label="项目与任务">{!ready && <p className="railEmpty" role="status">{booting ? "正在读取本机项目…" : "本地项目暂不可用"}</p>}
        {collectionProject && <>
          <div className="sessionFilters" role="group" aria-label="会话范围"><button aria-pressed={sessionView === 'recent'} onClick={() => filterSessions(false)}>最近会话{sessionView === 'recent' && !indexLoading && <span className="sessionFilterCount" title={`${sessionPage.total || 0} 段会话`}>{compactSessionCount.format(sessionPage.total || 0)}</span>}</button><button aria-pressed={sessionView === 'archived'} onClick={() => filterSessions(true)}><Archive size={13}/>已归档{sessionView === 'archived' && !indexLoading && <span className="sessionFilterCount" title={`${sessionPage.total || 0} 段会话`}>{compactSessionCount.format(sessionPage.total || 0)}</span>}</button></div>
          <div className="sessionSearchLine"><label className="sessionSearch"><Search size={14}/><input ref={searchInput} aria-label={allProjectSessions ? "查找所有项目会话" : "查找当前项目会话"} placeholder={sessionView === 'archived' ? "搜索归档" : "搜索对话"} value={sessionSearch} maxLength={200} onChange={e => searchSessions(e.target.value)}/>{sessionSearch && <button aria-label="清除会话搜索" onClick={() => searchSessions("")}><X size={13}/></button>}</label><div className="sessionSearchScope"><button aria-pressed={allProjectSessions} aria-label={allProjectSessions ? '仅看本项目' : '查找所有项目'} title={allProjectSessions ? '当前显示所有项目的会话，点击仅看本项目' : '当前只显示本项目的会话，点击查找所有项目'} onClick={() => filterSessions(sessionView === 'archived', !allProjectSessions)}>{allProjectSessions ? '全部' : '项目内'}</button></div></div>
          {indexError && <p className="railEmpty" role="alert">会话列表读取失败。<button onClick={() => loadSessionIndex(indexQuery.current)}>重试</button></p>}
          <div aria-busy={indexLoading} className={indexLoading ? "sessionIndex loading" : "sessionIndex"}>
          {filteredSessions.map((s, index) => <React.Fragment key={s.id}><SessionDateDivider session={s} previous={filteredSessions[index - 1]}/><div className={`sessionRow ${sessionId === s.id ? "current" : ""}`} data-attention={["waiting", "failed", "interrupted"].includes(s.status) || active(s.status) || undefined} key={s.id}><button className="sessionButton" aria-current={sessionId === s.id ? 'page' : undefined} aria-label={`${s.title}，${agentName(s.agent)}${sessionState(s.status) ? `，${sessionState(s.status)}` : ""}`} title={`${s.title} · ${agentName(s.agent)} · ${new Date(s.updated_at).toLocaleString()}`} disabled={sending || creatingSession || Boolean(navigationStage)} onClick={() => { if (sessionId !== s.id || view !== 'workbench' || draftLoadFailed) selectProject(s.collection_project_id || s.project_id, s.id, { keepSearch: true }); }}><span className={`statusDot ${active(s.status) ? "live" : ""} ${['waiting', 'failed', 'interrupted'].includes(s.status) ? "attention" : ""}`} /><span className="sessionSummary"><span className="sessionTitle">{s.pinned_at>0&&<Pin size={11} className="pinMark"/>}{s.title}</span><span className="sessionMeta"><span className="sessionProjectName">{allProjectSessions ? workspace.projects.find(p => p.id === (s.collection_project_id || s.project_id))?.name : agentName(s.agent)}</span><span className={['waiting', 'failed', 'interrupted'].includes(s.status) ? 'needsAttention' : undefined}>{sessionState(s.status) || new Date(s.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></span></span></button><button ref={element => { if (element) renameButtons.current.set(s.id, element); else renameButtons.current.delete(s.id); }} className="sessionMenuTrigger" aria-label={`会话选项：${s.title}`} title="会话选项" aria-haspopup="menu" aria-expanded={sessionMenu?.session.id === s.id} disabled={managementBusy || sending || creatingSession || Boolean(navigationStage)} onClick={event => setSessionMenu({ session: s, anchor: event.currentTarget })}><MoreHorizontal size={16}/></button></div></React.Fragment>)}
          {!indexLoading && filteredSessions.length === 0 && <p className="railEmpty">{sessionSearch ? "没有匹配的会话，可调整关键词或查找所有项目。" : sessionView === "archived" ? "归档的会话会收在这里，随时可以恢复。" : "还没有会话，从一项新工作开始。"}</p>}
          </div>
          {(sessionPage.older || sessionPage.newer || indexQuery.current.before || indexQuery.current.after) && <nav className="sessionPagination" aria-label="会话列表分页">
            <button disabled={indexLoading || !sessionPage.newer} onClick={() => loadSessionIndex({ ...indexQuery.current, before: undefined, after: sessionPage.newer })}><ChevronLeft size={14}/>较新</button>
            <button disabled={indexLoading} onClick={() => loadSessionIndex({ ...indexQuery.current, before: undefined, after: undefined })}>回到最近</button>
            <button disabled={indexLoading || !sessionPage.older} onClick={() => loadSessionIndex({ ...indexQuery.current, after: undefined, before: sessionPage.older })}>更早<ChevronRight size={14}/></button>
          </nav>}
        </>}
      </nav>
      {!workspace.projects.length && ready && <p className="railEmpty">打开一个文件夹，<br />从已有资料开始工作。</p>}
    </WorkbenchNavigation>
    {sessionMenu && <SessionActions {...sessionMenu} busy={managementBusy} onClose={closeSessionMenu} onRename={() => { setError(''); setEditingSessionId(sessionMenu.session.id); setEditedTitle(sessionMenu.session.title); }} onPin={() => manageSession('session.pin', sessionMenu.session, { pinned: !sessionMenu.session.pinned_at }).catch(e => setError(e.message))} onMove={() => setMovingSession(sessionMenu.session)} onArchive={() => archiveSession(sessionMenu.session, !sessionMenu.session.archived_at)}/>}
    {editingSessionId && <RenameSessionDialog value={editedTitle} busy={renameSaving} error={error} onChange={setEditedTitle} onSubmit={renameSession} onClose={finishRename}/>}
    {projectsOpen && <ProjectsDialog projects={workspace.projects} currentId={collectionId} onClose={() => { setProjectsOpen(false); projectManagerTrigger.current?.focus(); }} onAction={manageProject} onOpen={async id => { if (await selectProject(id)) setProjectsOpen(false); }} onOpenFolder={async () => { if (await openProject()) setProjectsOpen(false); }}/>}
    {movingSession && <MoveSessionDialog session={movingSession} projects={workspace.projects} onClose={() => { const id=movingSession.id;setMovingSession(null);requestAnimationFrame(()=>renameButtons.current.get(id)?.focus()); }} onMove={moveSession}/>}
    {settingsOpen&&<WorkbenchSettings appearance={appearance} textSize={textSize} onAppearance={setAppearance} onTextSize={setTextSize} onClose={()=>{setSettingsOpen(false);settingsButton.current?.focus();}} onAgents={()=>{setSettingsOpen(false);setAgentConnectionsOpen(true);}} onModels={e=>{setSettingsOpen(false);openConnections(e);}} onCapabilities={async()=>{try{await flushConversationSurface();setSettingsOpen(false);setView('skills');}catch(e){setError(e.message);}}} onTeam={()=>{setSettingsOpen(false);setCloudOpen(true);}}/>}
    {agentConnectionsOpen && <AgentConnectionsDialog agents={workspace.agents} onClose={() => { setAgentConnectionsOpen(false); agentButton.current?.focus(); }} onChanged={async () => { await readAgentConnections(); await refresh(); }} onTrial={project ? tryAgent : null} onHosted={() => { setAgentConnectionsOpen(false); setCloudOpen(true); }}/> }
    {connectionsOpen && <ModelConnectionsDialog onClose={closeConnections} onChanged={readConnections}/>}
    {capabilitiesOpen && <CapabilitiesDialog project={project} onClose={() => setCapabilitiesOpen(false)}/>}
    {schedulesOpen && <SchedulesDialog project={project} agents={workspace.agents} initial={{ prompt: draft, agent: agentId, model: session?.model || model, connectionId: chosenConnectionId, agentConnectionId: chosenAgentConnectionId, materials: remoteMaterials.split("\n").map(p => p.trim()).filter(Boolean), references }} onClose={() => setSchedulesOpen(false)} onOpen={async s => { setSchedulesOpen(false); await refresh(); await selectProject(s.project_id, s.id); }}/>}
    {captureOpen && (captureOpen.kind === 'local-trial' ? <LocalLoopTrialDialog session={captureOpen.session} onClose={closeCapture}/> : captureOpen.kind === 'loop' ? <LoopCaptureDialog session={captureOpen.session} message={captureOpen.message} onClose={closeCapture} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }}/> : <MethodCaptureDialog session={captureOpen.session} message={captureOpen.message} onClose={closeCapture} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }}/> )}
    {workOpen && project?.sharing && <TeamWorkDialog project={project} agents={workspace.agents} onClose={() => setWorkOpen(false)} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }}/> }
    {syncOpen && project?.sharing && <SyncDialog project={project} onClose={() => setSyncOpen(false)}/> }
    {cloudOpen && <CloudDialog localProject={project} onClose={() => setCloudOpen(false)} onJoin={async p => { await refresh(); await selectProject(p.id, p.id === projectId ? sessionId : null); }}/>}
    {wechatOpen && project && <WeChatImportDialog projectId={projectId} team={Boolean(session?.sharedWork)} selected={references} onReference={selection => { addReference(selection); setWechatOpen(false); }} onClose={() => setWechatOpen(false)}/>}
    {view === 'skills' ? <main className="skillMain"><SkillOSPanel project={project} agents={workspace.agents} workSession={session?.sharedWork?.workItemId ? { id: session.sharedWork.workItemId, title: session.title } : null} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }} onReturn={() => setView('workbench')} onDocuments={() => setCapabilitiesOpen(true)}/></main> : <main>
      <header><div className="workspaceHeading"><button className="sidebarToggle" aria-label={sidebarOpen ? "收起导航" : "展开导航"} aria-expanded={sidebarOpen} aria-controls="work-navigation" onClick={()=>setSidebarOpen(open=>!open)}><PanelLeft size={18}/></button><div className="taskIdentity">{project ? <><span className="breadcrumb">{collectionProject?.sharing?.title || collectionProject?.name || project.name}{isArchived ? " · 已归档" : ""}</span>{session ? <button className="taskTitle" aria-label="重命名当前会话" title={session.title + " · 点击重命名"} onClick={()=>{setError('');setEditingSessionId(session.id);setEditedTitle(session.title);}}>{session.title}<ChevronDown size={13}/></button> : <strong>{sessionId ? workspace.sessions.find(s => s.id === sessionId)?.title || '正在打开会话' : '新工作'}</strong>}</> : <strong>我的工作台</strong>}</div></div>

        {project?.sharing && <button ref={workButton} onClick={() => setWorkOpen(true)}>团队工作</button>}
        {project?.sharing && <button ref={syncButton} className={`syncBadge ${project.sharing.status}`} onClick={() => setSyncOpen(true)}>{syncLabels[project.sharing.status]}</button>}
        <div className="headerActions">{sessionId&&<ToolbarButton className="outputsTrigger" title="本次成果" ref={outputsButton} aria-label="查看本次成果" aria-pressed={outputsOpen} onClick={()=>toggleOutputs().catch(e=>setError(e.message))}><PanelsTopLeft size={16}/>成果{resultCount>0&&<span>{resultCount}</span>}</ToolbarButton>}{project&&<ToolbarButton aria-label="项目文件" title="项目文件" aria-pressed={filePanel} onClick={()=>{setOutputsOpen(false);setSurfaceExpanded(false);setEmbeddedOpen(false);invoke('embedded_hide').catch(e=>setError(e.message));setFilePanel(!filePanel);if(!filePanel)listFiles();}}><Files size={16}/>文件</ToolbarButton>}{project&&!remoteAgent&&<ToolbarButton aria-label="浏览器" title="浏览器" aria-pressed={embeddedOpen} onClick={()=>embeddedOpen?invoke('embedded_hide').then(()=>setEmbeddedOpen(false)).catch(e=>setError(e.message)):showBrowser()}><Globe size={16}/>浏览器</ToolbarButton>}{project&&<ChoiceMenu label="更多工作选项" className="workMenu" align="end" onOpenChange={open => popupChanged('work', open)} trigger={<MoreHorizontal size={19}/>}><MenuItem onClick={() => setWechatOpen(true)}>导入微信资料</MenuItem><MenuItem onClick={async()=>{try{await flushConversationSurface();setView('skills');}catch(e){setError(e.message);}}}>插件与技能</MenuItem></ChoiceMenu>}</div>
      </header>
      {managementNotice && <div className="managementNotice" role="status"><span>{managementNotice.text}</span>{managementNotice.undo && <button disabled={managementBusy} onClick={managementNotice.undo}>撤销归档</button>}<button aria-label="关闭管理提示" onClick={() => setManagementNotice(null)}><X size={14}/></button></div>}
      {session?.collection_project_id && <div className="workingDirectoryNotice"><Folder size={14}/><span title={project?.path}>工作文件夹仍为 {project?.name} · {project?.path}</span><button onClick={()=>{setFilePanel(true);setOutputsOpen(false);listFiles();}}>查看文件</button></div>}
      <div className="workArea"><section className={`conversation ${project && ready && !navigationStage && !draftLoadFailed && !visibleMessages.length ? "isEmpty" : ""}`}>
        {error && <div className="error" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}><X size={15} /></button></div>}
        {booting ? <div className="workbenchLoading" role="status"><LoaderCircle className="spin" size={22}/><strong>正在恢复本机工作台</strong><span>读取项目、上次会话与草稿…</span></div> : !ready ? <div className="workbenchLoading" role="alert"><strong>暂时无法读取本机工作台</strong><span>项目和会话仍保存在这台电脑。</span><button onClick={initialize}>重新读取</button></div> : !project ? <div className="welcome"><span className="welcomeEyebrow">你的资料 · 你的工作空间</span><h1>把手边的工作，交给助手</h1><p>整理资料、处理表格、准备文档。<br />从一个工作文件夹开始。</p><button className="primary" onClick={openProject}><FolderOpen size={18} />打开本地项目</button><small>文件保留在原来的位置</small></div> : <>
          {(historyNavigation?.older || historyPage) && <nav inert={conversationObscured} className="historyNavigation" aria-label="对话记录"><button disabled={historyLoading || !historyNavigation?.older} onClick={() => readHistory('before', historyNavigation.older)}><ChevronLeft size={14}/>查看更早</button>{historyPage && <><span>较早的对话</span><button disabled={historyLoading || !historyNavigation?.newer} onClick={() => readHistory('after', historyNavigation.newer)}>查看较新<ChevronRight size={14}/></button><button disabled={historyLoading} onClick={() => readHistory('latest')}>回到最新</button></>}{historyLoading && <span role="status">读取中…</span>}</nav>}
          <div className="transcript" ref={transcript} onScroll={() => { const el = transcript.current; const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90; atBottom.current = nearBottom; setAwayFromBottom(!nearBottom && el.scrollHeight > el.clientHeight + 90); if (nearBottom) setHasNewContent(false); }}>
            {navigationStage ? <div className="workbenchLoading" role="status"><LoaderCircle className="spin" size={20}/><strong>{navigationStage === "saving" ? "正在保存当前草稿" : "正在打开会话"}</strong><span>{navigationStage === "saving" ? "保存完成后继续切换" : "读取会话、引用资料与草稿…"}</span></div> : draftLoadFailed ? <div className="workbenchLoading" role="status"><strong>这段会话暂时打不开</strong><span>草稿仍保存在本机。可以重试读取。</span><button onClick={() => selectProject(projectId, sessionId)}>重新读取</button></div> : !visibleMessages.length ? <div className="taskWelcome"><span className="welcomeEyebrow">从一项具体的工作开始</span><h1>今天，一起完成什么？</h1><p>把文件和想法带进来，让助手帮你推进工作。</p>{session && active(session.status) && <div className="activity"><LoaderCircle className="spin" size={14}/>{labels[session.status]}</div>}</div> : <div className="messageColumn"><div className="conversationTimeline" ref={timeline}>{<ConversationMessages messages={visibleMessages} agent={agentName(session.agent)} status={historyPage ? 'idle' : session.status} holdActivityOpen={awayFromBottom} onActivityInteract={() => { atBottom.current = false; }} surfaceAnchor={surfaceAnchor} obscured={conversationObscured}
              renderMarkdown={text => <Markdown onOpenLink={showBrowser} onOpenFile={showResult} projectPath={project?.path} files={[...(currentSurface?.assets || []), ...(currentSurface?.results || []).flatMap(result => result.files)]}>{text}</Markdown>}
              renderReference={(file, message) => <SentFileReference key={referenceKey(file)} sessionId={sessionId} inputId={message.id} file={file}/>}
              renderActions={m => m.id === visibleMessages.at(-1)?.id && m.role === "assistant" && m.kind === "text" && !isArchived && session.status === "idle" && session.lastSubmission?.status === "completed" && !session.capture && !session.loopCapture && !session.localLoopTrial && <details className="reuseReply"><summary><BookOpen size={14}/>保存为可复用方法<ChevronDown size={13}/></summary><div><button className="captureAction" onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, message: m }); }}>保存为常用方法</button><button className="captureAction" onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, message: m, kind: 'loop' }); }}>保存为工作流程</button></div></details>}
            />}</div>{inlineSurface}<div inert={conversationObscured}>{!historyPage&&surfaceState?.sessionId===sessionId&&surfaceState?.results?.length>0&&<section className="conversationResults" aria-label="工作成果"><div className="resultsHeading"><span className="resultHeadingText"><span className="resultEyebrow"><Check size={12}/>已保存到项目</span><strong>本次成果</strong></span><button onClick={()=>toggleOutputs().catch(e=>setError(e.message))}>查看本次成果<ArrowRight size={14}/></button></div>{surfaceState.results.map(result=><div key={result.id}><ResultTime result={result}/>{result.summary&&<p>{result.summary}</p>}<div className="resultFiles">{result.files.map(file=><ResultFile key={file.path} file={file} onOpen={showResult}/>)}</div></div>)}</section>}{session.interactions?.map((item) => <Interaction key={item.id} item={item} sessionId={sessionId} report={setError} />)}
            {session.error && <div className="inlineError">{session.error}</div>}
            </div></div>}
          </div>
          {!navigationStage && !historyPage && !draftLoadFailed && awayFromBottom && <button inert={conversationObscured} className="latestJump" onClick={goToLatest}><ArrowDown size={14}/>{hasNewContent ? "有新内容 · 回到底部" : "回到底部"}</button>}
          <div className="composerArea" ref={composerArea} inert={conversationObscured}>
            {isArchived ? <div className="archiveNotice"><Archive size={20}/><span>这段会话已归档<small>历史、文件和草稿都保留着。恢复后可以继续工作。</small></span><button className="primary" disabled={managementBusy} onClick={() => archiveSession(session, false)}><ArchiveRestore size={15}/>恢复会话</button></div> : <>
            {session && active(session.status) && <div className={`executionStrip ${session.status}`} role="status"><span>{session.status==='waiting'?<ShieldCheck size={15}/>:<LoaderCircle size={15} className="spin"/>}{labels[session.status]}</span><button onClick={goToLatest}>查看进展<ArrowDown size={13}/></button></div>}
            {session?.remote && <RemoteTaskPanel key={session.id} session={session} onChanged={refresh}/>}
            {session?.localLoopTrial && <div className="methodNotice"><span>本机试做 · {session.localLoopTrial.name}</span><button disabled={active(session.status)} onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, kind: 'local-trial' }); }}>核对试做结果</button></div>}
            {session?.loopCapture && <div className="methodNotice"><span>正在整理可复用 Loop</span><button disabled={active(session.status)} onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, kind: 'loop' }); }}>查看流程草稿</button></div>}
            {session?.capture && <div className="methodNotice"><span>{session.capture.installed ? '这份草稿已采用到本机' : '正在整理可复用技能 · 草稿仅在本机'}</span><button disabled={active(session.status)} onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session }); }}>查看技能草稿</button></div>}
            {session?.nativeLoop && <div className="methodNotice"><span>已选择流程：<strong>{session.nativeLoop.name}</strong> · v{session.nativeLoop.version}</span><small>描述任务后发送，由你的 Agent 按步骤处理</small></div>}
            {session?.method && <div className="methodNotice"><span>已选择技能：<strong>{session.method.skillName}</strong> · v{session.method.version}</span><small>描述任务后发送，由你的 Agent 使用</small></div>}
            {session?.sharedWork && <div className="sharedWorkNotice"><span>{session.sharedWork.canContinueOffline ? `团队暂时无法连接。上次资料：${new Date(session.sharedWork.contextFetchedAt).toLocaleString()}。新内容先保存在本机，恢复后核验权限并同步。` : session.sharedWork.error || (session.sharedWork.pending ? '请求与答复正在同步到团队…' : '本次请求与最终答复对工作成员可见')}</span>{(session.sharedWork.error || session.sharedWork.pending > 0 || session.sharedWork.canContinueOffline) && <button onClick={() => control(session.sharedWork.workItemId ? 'work.retry' : 'work.finish')}>重试共享</button>}{session.sharedWork.canContinueOffline && !active(session.status) && <button disabled={!draft.trim() || sending || modelsLoading || draftLoading || !chosenAgent?.installed || session.status === 'interrupted'} onClick={() => send(true)}>用上次资料在本机继续</button>}</div>}
            {session?.status === "interrupted" && <div className="resume"><span>上次执行已中断。恢复后检查结果，再继续。</span><button onClick={() => control("session.resume")}><RotateCcw size={14} />恢复会话</button></div>}
            <Composer>{surfaceState?.sessionId===sessionId&&surfaceState?.assets.length>0&&<div className="materialChips" aria-label="当前工作材料">{surfaceState.assets.map(file=><AttachmentChip key={file.path} name={basename(file.path)} title={file.path} detail={Number.isFinite(file.bytes) ? (file.bytes < 1024 ? '不到 1 KB' : Math.ceil(file.bytes / 1024) + ' KB') : undefined} icon={<FileText size={15}/>} onOpen={()=>showResult(file)} disabled={sending||active(session?.status)} onRemove={()=>command('ui.detach',{sessionId,path:file.path}).then(setSurfaceState).catch(e=>setError(e.message))}/>)}</div>}
              {remoteAgent && <div className="remoteComposer"><label>Agent 账号<select aria-label="Agent 账号" value={chosenAgentConnectionId} disabled={Boolean(sessionId) || sending} onChange={e => updateRemoteDraft(remoteMaterials, e.target.value)}><option value="">选择已连接账号</option>{agentConnections.filter(c => !c.revoked && (c.provider === agentId || c.agents?.includes(agentId))).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}{chosenAgentConnectionId && !agentConnections.some(c => c.id === chosenAgentConnectionId) && <option value={chosenAgentConnectionId}>此任务绑定的账号</option>}</select></label><button onClick={() => setAgentConnectionsOpen(true)}>管理 Agent</button>{chosenAgent?.files && <ProjectMaterialPicker key={projectId} projectId={projectId} paths={remoteMaterials.split('\n').map(p=>p.trim()).filter(Boolean)} disabled={sending} onChange={paths=>updateRemoteDraft(paths.join('\n'),chosenAgentConnectionId)}/>}<label className="externalConsent"><input type="checkbox" checked={allowExternal} disabled={sending} onChange={e => setAllowExternal(e.target.checked)}/>将本次提示词、引用内容与选定材料交给 {chosenAgent?.name}；其原生工具权限由该服务管理。</label></div>}
              {references.length > 0 && <div className="referenceChips" aria-label="已引用资料">{references.map(selection => <span key={referenceKey(selection)}><FileText size={14}/><span title={referenceLabel(selection)}>{referenceLabel(selection)}{typeof selection !== "string" && <small> · {selection.kind === "work-decision" ? "决定" : selection.kind === "work-entry" ? "共享进展" : selection.kind === "wechat-import" ? "微信导入" : "历史版本"}</small>}</span><button disabled={sending || creatingSession || draftLoading} aria-label={`移除引用 ${referenceLabel(selection)}`} onClick={() => changeDraft(draft, references.filter(item => referenceKey(item) !== referenceKey(selection)))}><X size={13}/></button></span>)}</div>}<Textarea ref={composerInput} rows={1} aria-label="任务描述" placeholder={sessionId ? "继续提问，或补充要求…" : "描述你要完成的工作…"} value={draft} disabled={draftLoading || sending || creatingSession} onChange={(e) => changeDraft(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(e) => { if (e.key === "@" && !composing.current && !e.nativeEvent.isComposing && (!e.currentTarget.selectionStart || /\s/.test(draft[e.currentTarget.selectionStart - 1]))) { e.preventDefault(); setReferencePicker(true); return; } if (e.key === "Enter" && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
              <div className="composerToolbar"><div className="composerAccessory"><span className="agentChoice"><span className="agentGlyph"><Sparkles size={13}/></span><select aria-label="执行 Agent" value={agentId} disabled={Boolean(sessionId) || sending || draftLoading || modelsLoading} onChange={(e) => { ++manualAgentVersion.current; setAgentId(e.target.value); setConnectionId(""); setModels(null); setModel(""); }}>
                {workspace.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{agent.installed ? '' : agent.kind ? ' · 未连接' : ' · 未安装'}</option>)}
              </select></span>{!remoteAgent && <AssistantOptions model={model} onOpenChange={open => popupChanged('assistant', open)}><div className="assistantSettingsTitle">助手设置<span>{agentName(agentId)}</span></div>{!sessionId && agentPreference && <div className="agentPreferenceActions"><button disabled={preferenceSaving || agentPreference.project === agentId} onClick={() => saveAgentPreference('project')}>{agentPreference.project === agentId ? '本项目默认' : '设为本项目默认'}</button><button disabled={preferenceSaving || agentPreference.personal === agentId} onClick={() => saveAgentPreference('personal')}>{agentPreference.personal === agentId ? '个人默认' : '设为个人默认'}</button></div>}<label className="modelSetting">执行模型 {!remoteAgent && (models ? <SelectField label="执行模型" value={model} disabled={draftLoading || sending || active(session?.status)} onChange={chooseModel} items={[{value:"",label:chosenConnectionId ? "请选择网关模型" : "沿用会话配置",disabled:Boolean(chosenConnectionId)}, ...models.map(m => ({value:m.id,label:m.name}))]}/> : <button className="modelChoice" disabled={draftLoading || sending || modelsLoading || active(session?.status)} onClick={loadModels}>{modelsLoading ? "读取模型…" : (model || "选择模型")}</button>)}</label><label htmlFor="connection-source">模型来源</label><select id="connection-source" value={chosenConnectionId} disabled={Boolean(sessionId && (!session || session.native_id || session.lastSubmission)) || draftLoading || sending || modelsLoading || creatingSession} onChange={e => chooseConnection(e.target.value)}><option value="">跟随原生 Agent</option>{connections.filter(c => c.agents.includes(agentId)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}{chosenConnectionId && !chosenConnection && <option value={chosenConnectionId}>连接不可用</option>}</select>{chosenConnection && <code title={chosenConnection.baseUrl}>{chosenConnection.baseUrl}</code>}<button className="manageConnections" onClick={openConnections}>管理模型连接<ArrowUpRight size={14}/></button></AssistantOptions>}<span className={chosenAgent?.installed ? "composerHint" : "composerUnavailable"}>{remoteAgent ? (chosenAgent?.installed ? "按选定材料交接" : "请先连接 Agent") : chosenAgent?.installed ? (agentId === "pi" ? "使用 Pi 本机权限" : "在此项目工作") : `请先安装 ${chosenAgent?.name || agentId} CLI`}</span></div><div className="composerTools">{!remoteAgent&&<button aria-label="添加文件" title="添加文件" disabled={importingFiles||sending||creatingSession||draftLoading||active(session?.status)||Boolean(project.sharing)} onClick={importFiles}>{importingFiles?<LoaderCircle className="spin" size={17}/>:<Plus size={18}/>}<span>添加</span></button>}<button className="referenceTrigger" aria-label="引用资料" title="引用资料（@）" disabled={sending || creatingSession || draftLoading} onClick={() => setReferencePicker(true)}><AtSign size={17}/></button></div>{active(session?.status) && !answering ? <ComposerAction busy disabled={remoteAgent && chosenAgent?.stop === false} title={remoteAgent && chosenAgent?.stop === false ? "请在原生应用中停止" : undefined} aria-label="停止执行" onClick={() => control("session.stop")}><Square size={12} /></ComposerAction> : <ComposerAction pending={sending} aria-label="发送任务" disabled={!draft.trim() || sending || modelsLoading || draftLoading || !chosenAgent?.installed || session?.status === "interrupted" || (remoteAgent && (!allowExternal || !chosenAgentConnectionId))} onClick={send}>{sending ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={15} />}</ComposerAction>}</div>

            </Composer>{!visibleMessages.length && !navigationStage && <div className="taskSuggestions">{[{Icon:Files,label:"整理资料",prompt:"整理这些文件，提炼重点"},{Icon:Table2,label:"分析表格",prompt:"分析表格，整理一份结论"},{Icon:FileText,label:"起草文档",prompt:"帮我起草一份工作文档"}].map(({Icon,label,prompt})=><button key={label} onClick={()=>{changeDraft(draft.trim()?draft+'\n\n'+prompt:prompt);composerInput.current?.focus();}}><Icon size={16}/>{label}<ArrowUpRight size={13}/></button>)}</div>}<div className="composerMeta"><span>{draftStatus || (remoteAgent ? "选定内容会外发 · 账号不等于工具授权" : session?.sharedWork ? "团队工作 · 工具日志和原生历史保留在本机" : project.sharing ? "文件与团队共享 · 对话仅在本机" : agentId === "pi" ? "Pi 按本机配置运行 · 扩展请求会在这里显示" : "文件保存在本机 · 执行范围由你确认")}</span>{draft.trim() && active(session?.status) && !answering && <span className="pendingDraftHint">补充要求会保留，停止后可发送</span>}<span className="keyboardHint">Enter 发送 <span>·</span> Shift + Enter 换行</span></div>
            </>}
          </div>
        </>}
      </section>
      {outputsOpen && project && <aside className="outputsPanel" aria-label="本次成果">
        <div className="outputsHeader"><div><h2 ref={outputsHeading} tabIndex={-1}>本次成果</h2><p>这项工作产出的内容，都在这里。</p></div><button aria-label="关闭成果面板" onClick={()=>{setOutputsOpen(false);outputsButton.current?.focus();}}><X size={18}/></button></div>
        <div className="outputsBody">
          {activeSurface && !isArchived && <section><h3>交互内容</h3><button className="surfaceShortcut" onClick={()=>expandSurface(true).catch(e=>setError(e.message))}><span><PanelsTopLeft size={20}/></span><span><strong>{currentSurface.document.title}</strong><small>展开查看</small></span><ArrowUpRight size={16}/></button></section>}
          <section><h3>已保存的文件{resultCount>0&&<span>{resultCount}</span>}</h3>{currentSurface?.results?.length?currentSurface.results.map(result=><div className="outputGroup" key={result.id}><ResultTime result={result}/>{result.summary&&<p>{result.summary}</p>}<div className="resultFiles">{result.files.map(file=><ResultFile key={file.path} file={file} onOpen={showResult}/>)}</div></div>):<p className="outputEmpty">助手生成文件后，会出现在这里。你也可以在对话中继续补充要求。</p>}</section>
          {currentSurface?.assets?.length>0&&<section className="outputSources"><h3>使用的材料<span>{currentSurface.assets.length}</span></h3>{currentSurface.assets.map(file=><button key={file.path} onClick={()=>showResult(file)}><FileText size={16}/><span>{basename(file.path)}</span><ArrowUpRight size={14}/></button>)}</section>}
        </div>
      </aside>}
      {embeddedOpen && sessionId && <EmbeddedPane key={sessionId} sessionId={sessionId} onClose={()=>invoke('embedded_hide').then(()=>setEmbeddedOpen(false)).catch(e=>setError(e.message))} />}
      {filePanel && !embeddedOpen && !surfaceExpanded && project && <aside className="filePanel"><div className="fileHeader"><span><small>{preview ? "文件预览" : "工作资料"}</small><strong>{preview ? basename(preview.path) : "项目文件"}</strong></span><button aria-label="关闭文件面板" onClick={() => setFilePanel(false)}><X size={16} /></button></div><div className="fileTools"><button onClick={() => preview ? setPreview(null) : listFiles(folder.split("/").slice(0, -1).join("/"))} disabled={!preview && !folder}><ChevronLeft size={15} />返回</button><button aria-label="刷新项目文件" onClick={() => listFiles(folder)}><RotateCcw size={15} /></button></div>
        {importNotice && <p className="importNotice" role="status">{importNotice}</p>}
        {preview && <div className="referencePreviewAction"><button disabled={sending || creatingSession || draftLoading || previewRefChecking || references.length >= 4 || references.includes(preview.path)} onClick={() => addPreviewReference(preview.path)}><FileText size={14}/>{previewRefChecking ? '检查中…' : references.includes(preview.path) ? '已引用到任务' : '引用到任务'}</button><button onClick={() => openProjectFile(preview.path)}>{/\.(?:txt|json|md|markdown|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(preview.path) ? '系统打开' : '在文件夹中显示'}</button></div>}
        {fileError && <div className="inlineError" role="alert">{fileError}</div>}
        {fileLoading ? <div className="fileLoading" role="status"><LoaderCircle className="spin" size={16}/>正在读取项目文件…</div> : preview ? <div className={/\.(txt|md)$/i.test(preview.path) ? "filePreview prosePreview" : "filePreview"}>{/\.md$/i.test(preview.path) ? <Markdown>{preview.text}</Markdown> : <pre>{preview.text}</pre>}</div> : <div className="fileList"><p className="filePath">{folder || project.sharing?.title || project.name}</p>{fileList?.entries.map((f) => <div className="fileEntry" key={f.path}><button onClick={() => readFile(f)}>{f.directory ? <Folder size={16} /> : <FileText size={16} />}<span>{f.name}</span>{f.directory && <ChevronRight size={13} />}</button>{!f.directory && <button className="nativeFileAction" onClick={() => openProjectFile(f.path)}>{/\.(?:txt|json|md|markdown|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(f.path) ? '系统打开' : '定位'}</button>}</div>)}{fileList?.entries.length === 0 && <p className="muted">这个文件夹还没有文件。</p>}{fileList?.truncated && <p className="muted">当前显示前 500 项，请进入子文件夹查看。</p>}</div>}
      </aside>}
      </div>
    </main>}
    {referencePicker && project && <FileReferencePicker projectId={projectId} sessionId={sessionId} team={Boolean(session?.sharedWork)} selected={references} onSelect={addReference} onUsePath={useProjectFilePath} onClose={closeReferencePicker} methodContext={{ project, agents: workspace.agents, initialAgent: agentId,
      workSession: session?.sharedWork?.workItemId ? { id: session.sharedWork.workItemId, title: session.title } : null,
      sourceDraft: { ...(sessionId ? { sessionId } : {}), text: draft, references },
      onBeforeUse: async () => { clearTimeout(draftTimer.current); await command("draft.save", { projectId, sessionId, text: draft, references }); },
      onOpen: async s => { await refresh(); await selectProject(s.project_id, s.id); },
    }}/>}
  </div>;
}
function basename(path) { return path.split("/").pop(); }
