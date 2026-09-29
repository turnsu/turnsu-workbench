import { ProjectMaterialPicker } from './ProjectMaterialPicker.jsx';
import { AgentConnectionsDialog } from './AgentConnectionsDialog.jsx';
import { RemoteTaskPanel } from './RemoteTaskPanel.jsx';
import { ModelConnectionsDialog } from "./ModelConnectionsDialog.jsx";
import { SchedulesDialog } from './SchedulesDialog.jsx';
import { CapabilitiesDialog } from './CapabilitiesDialog.jsx';
import "./model-connections.css";
import { invoke, listen, beforeClose } from "./desktop-bridge.mjs";
import { LocalDraftNavigation } from "./local-draft-navigation.mjs";
import { createRefreshQueue } from "./refresh-queue.mjs";
import { LocalLoopTrialDialog } from './LocalLoopTrialDialog.jsx';
import { FileReferencePicker, SentFileReference, referenceLabel, referenceKey } from "./FileReferencePicker.jsx";
import { MethodCaptureDialog } from "./MethodCaptureDialog.jsx";
import { LoopCaptureDialog } from "./LoopCaptureDialog.jsx";
import { SkillOSPanel } from "./SkillOSPanel.jsx";
import { Button, Textarea } from "./ScaffoldControls.jsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FolderOpen, Plus, ArrowUp, ArrowDown, Square, Files, X, ChevronRight, ChevronLeft, FileText, Folder, RotateCcw, LoaderCircle, Check, ShieldCheck, MessageSquare, BookOpen, Laptop, Pencil, Search, Settings2 } from "lucide-react";
import "./style.css";
import "./scaffold.css";
import "./skill-os.css";
import { TeamWorkDialog } from "./TeamWorkDialog.jsx";
import { CloudDialog } from "./CloudDialog.jsx";
import { SyncDialog, syncLabels } from "./SyncDialog.jsx";
import { WeChatImportDialog } from './WeChatImportDialog.jsx';
import './wechat-import.css';

const command = (method, args = {}) => invoke("local_command", { method, args });
const labels = { idle: "可以继续", starting: "正在连接 Agent", running: "正在处理", waiting: "需要你的回应", stopping: "正在停止", interrupted: "可以恢复", failed: "需要处理" };
const active = (status) => ["starting", "running", "waiting", "stopping"].includes(status);
const agentName = (agent) => ({ pi: 'Pi', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', kimi: 'Kimi Code', omp: 'oh-my-pi', manus: 'Manus', 'workbuddy-local': 'WorkBuddy 本地', 'workbuddy-cloud': 'WorkBuddy 云端', muse: 'Muse' }[agent] || agent);
const sessionState = (status) => ({ starting: "连接中", running: "进行中", waiting: "待回应", stopping: "停止中", interrupted: "已中断", failed: "需处理" })[status] || "";

function Markdown({ children }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[图片：{alt || "未加载外部图片"}]</span>, a: ({ children }) => <span className="reference">{children}</span> }}>{children}</ReactMarkdown>;
}
function Interaction({ item, sessionId, report }) {
  const [answers, setAnswers] = useState(() => Object.fromEntries(item.questions.map((q) => [q.id, q.prefill || ""]))); const [saving, setSaving] = useState(false);
  async function respond(decision, optionId) {
    setSaving(true);
    try { await command("interaction.respond", { id: item.id, sessionId, decision, optionId, answers }); }
    catch (error) { report(String(error)); }
    finally { setSaving(false); }
  }
  return <section className="interaction" aria-label={item.title}>
    <strong><ShieldCheck size={16} />{item.title}</strong>
    {item.questions.length ? item.questions.map((q) => <label key={q.id}>{q.question}
      {q.options?.length > 0 && <div className="options">{q.options.map((o) => <button key={o.label} title={o.description} onClick={() => setAnswers((a) => ({ ...a, [q.id]: q.multiSelect ? (Array.isArray(a[q.id]) && a[q.id].includes(o.label) ? a[q.id].filter((v) => v !== o.label) : [...(Array.isArray(a[q.id]) ? a[q.id] : []), o.label]) : o.label }))} aria-pressed={Array.isArray(answers[q.id]) ? answers[q.id].includes(o.label) : answers[q.id] === o.label}>{o.label}</button>)}</div>}
      {q.multiline ? <textarea value={Array.isArray(answers[q.id]) ? answers[q.id].join(", ") : answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} aria-label={q.question} /> : <input type={q.isSecret ? "password" : "text"} value={Array.isArray(answers[q.id]) ? answers[q.id].join(", ") : answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} placeholder="填写回答" />}
    </label>) : <pre>{item.command}</pre>}
    <div className="interactionActions">{item.acpChoices?.length > 1 ? <><button disabled={saving} onClick={() => respond('decline')}>取消</button>{item.acpChoices.map(option => <button key={option.id} className="primary" disabled={saving} onClick={() => respond('select', option.id)}>{option.label}</button>)}</> : <>{item.method.startsWith("claude/") && item.questions.length > 0 && <button disabled={saving} onClick={() => respond("decline")}>取消</button>}{item.method.startsWith("pi/") && item.questions.length > 0 && <button disabled={saving} onClick={() => respond("cancel")}>取消</button>}{item.questions.length ? <button className="primary" disabled={saving || item.questions.some((q) => Array.isArray(answers[q.id]) ? !answers[q.id].length : !answers[q.id]?.trim())} onClick={() => respond()}>提交回答</button> : <><button disabled={saving} onClick={() => respond("decline")}>拒绝</button><button className="primary" disabled={saving} onClick={() => respond("accept")}>{item.method === "pi/confirm" ? "确认" : "允许一次"}</button></>}</>}</div>
  </section>;
}

function App() {
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
  const [agentPreference, setAgentPreference] = useState(null), [preferenceSaving, setPreferenceSaving] = useState(false);
  const manualAgentVersion = useRef(0);
  const [creatingSession, setCreatingSession] = useState(false);
  const modelRequest = useRef(0);
  const [models, setModels] = useState(null), [model, setModel] = useState(""), [modelsLoading, setModelsLoading] = useState(false);
  const [fileError, setFileError] = useState(""), [fileLoading, setFileLoading] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false), [importNotice, setImportNotice] = useState('');
  const selected = useRef(null), draftTimer = useRef(null), draftVersion = useRef(0), fileVersion = useRef(0), refreshTimer = useRef(null), composing = useRef(false);
  const refreshQueue = useRef(null);
  const transcript = useRef(null), atBottom = useRef(true), pendingSend = useRef(null);
  const lastMessageSignature = useRef(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false), [hasNewContent, setHasNewContent] = useState(false);
  currentFiles.current = { projectId, filePanel, folder };
  const project = workspace.projects.find((p) => p.id === projectId);
  const projectSessions = workspace.sessions.filter((s) => s.project_id === projectId);
  const filteredSessions = projectSessions;
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
    const query = { projectId: indexQuery.current.projectId, search: value };
    // Invalidate older reads immediately, including queued streaming refreshes.
    indexQuery.current = query; ++indexVersion.current; setIndexLoading(true);
    indexTimer.current = setTimeout(() => loadSessionIndex(query), 180);
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
        await selectProject(saved.projectId, previous?.projectId === saved.projectId ? previous.id : null);
      }
    } catch (e) { setError(String(e)); setReady(false); }
    finally { setBooting(false); }
  }
  useEffect(() => beforeClose(async () => { clearTimeout(draftTimer.current); await navigation.current.save(); }), []);
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
  useEffect(() => { if (projectId) localStorage.setItem("turnsu.lastSelection", JSON.stringify({ projectId, sessionId })); }, [projectId, sessionId]);
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
    if (!filePanel || !preview?.path || !project?.sharing?.syncedAt) return;
    let current = true;
    command("files.read", { projectId, path: preview.path }).then(value => { if (current) setPreview(value); }).catch(e => { if (current) setFileError(String(e)); });
    return () => { current = false; };
  }, [project?.sharing?.syncedAt, projectId, filePanel, preview?.path]);

  async function selectProject(id, nextSession = null) {
    if (sending || creatingSession) return;
    clearTimeout(draftTimer.current); setDraftLoading(true); setDraftLoadFailed(false); setNavigationStage("saving");
    try {
      await navigation.current.select(id, nextSession, {
        start() {
          ++historyVersion.current; setHistoryPage(null); setHistoryLoading(false);
          setNavigationStage("reading"); setEditingSessionId(null);
          if (indexQuery.current.projectId !== id) {
            setSessionSearch(""); setWorkspace(w => ({ ...w, sessions: [], sessionPage: {} }));
            loadSessionIndex({ projectId: id });
          }
          ++draftVersion.current; ++fileVersion.current; ++modelRequest.current; setModelsLoading(false); setFileList(null); setPreview(null); setImportNotice(''); setFileError(''); setModel(""); setModels(null); setAgentId(indexQuery.current.projectId === id ? workspace.agentPreference?.agentId || 'codex' : workspace.agents.find(agent => agent.installed)?.id || 'codex'); setAgentPreference(null); setConnectionId("");
          setView('workbench'); setWorkOpen(false); setSyncOpen(false); setWechatOpen(false); setProjectId(id); selected.current = nextSession; setSessionId(nextSession); setSession(null); setError(""); setDraft(""); setReferences([]); setReferencePicker(false); setDraftStatus(""); setFilePanel(false); pendingSend.current = null; atBottom.current = true; lastMessageSignature.current = null; setAwayFromBottom(false); setHasNewContent(false);
        },
        loaded({ draft: saved, session: value }) {
          setDraft(saved.text); setReferences(saved.references); setDraftLoading(false); setDraftLoadFailed(false); setNavigationStage(null);
          if (value) { setSession(value); pendingSend.current = value.pendingInput || null; setModel(value.model || ""); setAgentId(value.agent); setConnectionId(value.connection_id || ""); }
        },
      });
      if (!nextSession && navigation.current.current?.projectId === id && !selected.current) {
        const choiceVersion = manualAgentVersion.current;
        const preference = await command('agent.preference.read', { projectId: id });
        if (navigation.current.current?.projectId === id && !selected.current) { setAgentPreference(preference); if (choiceVersion === manualAgentVersion.current) setAgentId(preference.agentId); }
      }
    } catch (e) {
      const loaded = Boolean(navigation.current.current?.loaded);
      setNavigationStage(null);
      setError(loaded ? `草稿未能保存，已保留当前输入。请重试切换任务。${String(e)}` : String(e));
      setDraftLoading(!loaded); setDraftLoadFailed(!loaded);
    }
  }
  async function openProject() {
    try { const p = await invoke("open_project"); if (p) { await refresh(); await selectProject(p.id); } }
    catch (e) { setError(String(e)); }
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
  function useProjectFilePath(path) {
    const fileLine = `项目文件路径：${JSON.stringify(path)}`;
    changeDraft(draft.trim() ? `${draft.trimEnd()}\n${fileLine}` : `请尝试读取当前${fileLine}。`);
    closeReferencePicker();
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
    if (!draft.trim() || draftLoading || modelsLoading || sending || (active(session?.status) && !answering)) return;
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
    requestAnimationFrame(() => renameButtons.current.get(id)?.focus());
  }
  async function listFiles(path = "") {
    const version = ++fileVersion.current; setFileLoading(true); setPreview(null); setFileList(null); setFileError(""); setFolder(path);
    try { const result = await command("files.list", { projectId, path }); if (version === fileVersion.current) setFileList(result); }
    catch (e) { if (version === fileVersion.current) setFileError(String(e)); }
    finally { if (version === fileVersion.current) setFileLoading(false); }
  }
  async function readFile(file) {
    if (file.directory) return listFiles(file.path);
    if (/\.(?:pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(file.path)) return openProjectFile(file.path);
    const version = ++fileVersion.current; setFileLoading(true); setPreview(null); setFileError("");
    try { const result = await command("files.read", { projectId, path: file.path }); if (version === fileVersion.current) setPreview(result); }
    catch (e) { if (version === fileVersion.current) setFileError(String(e)); }
    finally { if (version === fileVersion.current) setFileLoading(false); }
  }
  async function importFiles() {
    if (!projectId || importingFiles) return;
    setImportingFiles(true); setImportNotice(''); setFileError('');
    try {
      const result = await invoke('import_files', { projectId });
      if (!result) return;
      setFilePanel(true);
      await listFiles('Imported');
      setImportNotice(result.imported.length ? `已导入 ${result.imported.length} 个文件到 Imported，原文件未更改。` : '没有文件导入。');
      if (result.failed.length) setFileError(result.failed.map(file => `${file.name}：${file.reason}`).join('；'));
    } catch (error) { setFileError(String(error)); setFilePanel(true); }
    finally { setImportingFiles(false); }
  }
  async function openProjectFile(path) {
    setFileError('');
    try { await invoke(/\.(?:txt|md|markdown|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(path) ? 'open_project_file' : 'reveal_project_file', { projectId, path }); }
    catch (error) { setFileError(String(error)); }
  }

  return <div className="app">
    {computerState?.grant && <div className="computerIndicator" role="status"><strong>{computerState.grant.mode === "local" ? "本机电脑操作已授权" : "隔离电脑已启用"}</strong><span>到期 {new Date(computerState.grant.expiresAt).toLocaleTimeString()}</span><button onClick={() => command("computer.stop").then(() => setComputerState(null)).catch(e => setError(e.message))}>暂停并撤销</button></div>}
    <aside className="sidebar">
      <img className="brand" src="./brand/turnsu-lockup.svg" alt="Turnsu" />
      <nav className="productNav" aria-label="主要区域"><Button variant={view === 'workbench' ? 'secondary' : 'ghost'} aria-current={view === 'workbench' ? 'page' : undefined} onClick={() => setView('workbench')}><MessageSquare size={17}/>工作台</Button><Button variant={view === 'skills' ? 'secondary' : 'ghost'} aria-current={view === 'skills' ? 'page' : undefined} onClick={() => setView('skills')}><BookOpen size={17}/>Skill OS</Button></nav>
      <Button variant="outline" className="openProject" disabled={sending || creatingSession} onClick={openProject}><FolderOpen size={17} />打开项目<span>＋</span></Button>
      <div className="railHeading">项目</div>
      <nav aria-label="项目与任务">{!ready && <p className="railEmpty" role="status">{booting ? "正在读取本机项目…" : "本地项目暂不可用"}</p>}{workspace.projects.map((p) => <div className="projectGroup" key={p.id}>
        <button className={`projectButton ${projectId === p.id ? "selected" : ""}`} disabled={sending || creatingSession} onClick={() => selectProject(p.id)}><Folder size={16} /><span>{p.sharing?.title || p.name}</span></button>
        {projectId === p.id && <>
          <button className={`sessionButton newTask ${!sessionId ? "current" : ""}`} disabled={sending || creatingSession || Boolean(navigationStage)} onClick={() => { if (sessionId || view !== 'workbench' || draftLoadFailed) selectProject(p.id); }}><Plus size={15} />新任务</button>
          {<label className="sessionSearch"><Search size={14}/><input aria-label="查找当前项目会话" placeholder="查找会话" value={sessionSearch} maxLength={200} onChange={e => searchSessions(e.target.value)}/>{sessionSearch && <button aria-label="清除会话搜索" onClick={() => searchSessions("")}><X size={13}/></button>}</label>}
          <div className="sessionListHeading">{sessionSearch ? "搜索结果" : "最近会话"} <span>{indexLoading ? "读取中…" : sessionPage.total || 0}</span></div>
          {indexError && <p className="railEmpty" role="alert">会话列表读取失败。<button onClick={() => loadSessionIndex(indexQuery.current)}>重试</button></p>}
          <div aria-busy={indexLoading} className={indexLoading ? "sessionIndex loading" : "sessionIndex"}>
          {filteredSessions.map((s) => editingSessionId === s.id ? <form className="sessionRename" key={s.id} onSubmit={renameSession} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); finishRename(); } }}><input autoFocus aria-label="会话名称" maxLength={80} required value={editedTitle} disabled={renameSaving} onChange={e => setEditedTitle(e.target.value)}/><button aria-label="保存会话名称" disabled={renameSaving || !editedTitle.trim()} type="submit"><Check size={14}/></button><button aria-label="取消重命名" disabled={renameSaving} type="button" onClick={finishRename}><X size={14}/></button></form> : <div className={`sessionRow ${sessionId === s.id ? "current" : ""}`} key={s.id}><button className="sessionButton" aria-current={sessionId === s.id ? 'page' : undefined} aria-label={`${s.title}，${agentName(s.agent)}${sessionState(s.status) ? `，${sessionState(s.status)}` : ""}`} title={`${s.title} · ${agentName(s.agent)} · ${new Date(s.updated_at).toLocaleString()}`} disabled={sending || creatingSession || Boolean(navigationStage)} onClick={() => { if (sessionId !== s.id || view !== 'workbench' || draftLoadFailed) selectProject(p.id, s.id); }}><span className={`statusDot ${active(s.status) ? "live" : ""} ${['waiting', 'failed', 'interrupted'].includes(s.status) ? "attention" : ""}`} /><span className="sessionTitle">{s.title}</span><small className={`taskAgent ${['waiting', 'failed', 'interrupted'].includes(s.status) ? "attention" : ""}`}>{sessionState(s.status) || ({ pi: 'Pi', claude: 'CC', opencode: 'OC', codex: 'C', kimi: 'KM', omp: 'OMP' }[s.agent] || '?')}</small></button><button ref={element => { if (element) renameButtons.current.set(s.id, element); else renameButtons.current.delete(s.id); }} className="renameTrigger" aria-label={`重命名会话：${s.title}`} title="重命名" disabled={sending || creatingSession || Boolean(navigationStage)} onClick={() => { setEditingSessionId(s.id); setEditedTitle(s.title); }}><Pencil size={13}/></button></div>)}
          {!indexLoading && sessionSearch && filteredSessions.length === 0 && <p className="railEmpty">当前项目没有匹配的会话。</p>}
          </div>
          {(sessionPage.older || sessionPage.newer || indexQuery.current.before || indexQuery.current.after) && <nav className="sessionPagination" aria-label="会话列表分页">
            <button disabled={indexLoading || !sessionPage.newer} onClick={() => loadSessionIndex({ projectId, search: sessionSearch, after: sessionPage.newer })}><ChevronLeft size={14}/>较新</button>
            <button disabled={indexLoading} onClick={() => loadSessionIndex({ projectId, search: sessionSearch })}>回到最近</button>
            <button disabled={indexLoading || !sessionPage.older} onClick={() => loadSessionIndex({ projectId, search: sessionSearch, before: sessionPage.older })}>更早<ChevronRight size={14}/></button>
          </nav>}
        </>}
      </div>)}</nav>
      {!workspace.projects.length && ready && <p className="railEmpty">打开一个文件夹，<br />从已有资料开始工作。</p>}
      <button ref={teamButton} className="teamConnection" onClick={() => setCloudOpen(true)}><Plus size={15}/>连接团队</button>
      <button ref={agentButton} className="teamConnection" onClick={() => setAgentConnectionsOpen(true)}><Settings2 size={15}/>连接 Agent</button>
      <button ref={connectionButton} className="teamConnection" onClick={openConnections}><Settings2 size={15}/>模型连接</button>
      <button className="teamConnection" onClick={() => setSchedulesOpen(true)}><Settings2 size={15}/>定时任务</button>
      <button className="teamConnection" onClick={() => setCapabilitiesOpen(true)}><Settings2 size={15}/>能力与权限</button>
      <div className="localFoot"><Laptop size={15} /><span>本地工作台<small>项目与会话保存在这台电脑</small></span></div>
    </aside>
    {agentConnectionsOpen && <AgentConnectionsDialog agents={workspace.agents} onClose={() => { setAgentConnectionsOpen(false); agentButton.current?.focus(); }} onChanged={async () => { await readAgentConnections(); await refresh(); }} onTrial={project ? tryAgent : null} onHosted={() => { setAgentConnectionsOpen(false); setCloudOpen(true); }}/> }
    {connectionsOpen && <ModelConnectionsDialog onClose={closeConnections} onChanged={readConnections}/>}
    {capabilitiesOpen && <CapabilitiesDialog project={project} onClose={() => setCapabilitiesOpen(false)}/>}
    {schedulesOpen && <SchedulesDialog project={project} agents={workspace.agents} initial={{ prompt: draft, agent: agentId, model: session?.model || model, connectionId: chosenConnectionId, agentConnectionId: chosenAgentConnectionId, materials: remoteMaterials.split("\n").map(p => p.trim()).filter(Boolean), references }} onClose={() => setSchedulesOpen(false)} onOpen={async s => { setSchedulesOpen(false); await refresh(); await selectProject(s.project_id, s.id); }}/>}
    {captureOpen && (captureOpen.kind === 'local-trial' ? <LocalLoopTrialDialog session={captureOpen.session} onClose={closeCapture}/> : captureOpen.kind === 'loop' ? <LoopCaptureDialog session={captureOpen.session} message={captureOpen.message} onClose={closeCapture} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }}/> : <MethodCaptureDialog session={captureOpen.session} message={captureOpen.message} onClose={closeCapture} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }}/> )}
    {workOpen && project?.sharing && <TeamWorkDialog project={project} agents={workspace.agents} onClose={() => setWorkOpen(false)} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }}/> }
    {syncOpen && project?.sharing && <SyncDialog project={project} onClose={() => setSyncOpen(false)}/> }
    {cloudOpen && <CloudDialog localProject={project} onClose={() => setCloudOpen(false)} onJoin={async p => { await refresh(); await selectProject(p.id, p.id === projectId ? sessionId : null); }}/>}
    {wechatOpen && project && <WeChatImportDialog projectId={projectId} team={Boolean(session?.sharedWork)} selected={references} onReference={selection => { addReference(selection); setWechatOpen(false); }} onClose={() => setWechatOpen(false)}/>}
    {view === 'skills' ? <main className="skillMain"><SkillOSPanel project={project} agents={workspace.agents} workSession={session?.sharedWork?.workItemId ? { id: session.sharedWork.workItemId, title: session.title } : null} onOpen={async s => { await refresh(); await selectProject(s.project_id, s.id); }} onReturn={() => setView('workbench')}/></main> : <main>
      <header><div>{project ? <><span className="breadcrumb">{project.sharing?.title || project.name}<ChevronRight size={13} /></span><strong>{session?.title || (sessionId ? workspace.sessions.find(s => s.id === sessionId)?.title : null) || "新任务"}</strong></> : <strong>我的工作台</strong>}</div>
        {project?.sharing && <button ref={workButton} onClick={() => setWorkOpen(true)}>团队工作</button>}
        {project?.sharing && <button ref={syncButton} className={`syncBadge ${project.sharing.status}`} onClick={() => setSyncOpen(true)}>{syncLabels[project.sharing.status]}</button>}
        {project && <button onClick={() => setWechatOpen(true)}><FileText size={16}/>微信资料</button>}
        {project && <button disabled={importingFiles || Boolean(project.sharing)} title={project.sharing ? '团队项目的文件可能同步给成员；请在团队文件中核对共享范围。私有导入请打开本地项目。' : '复制文件到当前本地项目，保留原文件'} onClick={importFiles}><Plus size={16} />{importingFiles ? '正在导入…' : '导入文件'}</button>}
        {project && <button aria-pressed={filePanel} onClick={() => { setFilePanel(!filePanel); if (!filePanel) listFiles(); }}><Files size={16} />项目文件</button>}
      </header>
      <div className="workArea"><section className="conversation">
        {error && <div className="error" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}><X size={15} /></button></div>}
        {booting ? <div className="workbenchLoading" role="status"><LoaderCircle className="spin" size={22}/><strong>正在恢复本机工作台</strong><span>读取项目、上次会话与草稿…</span></div> : !ready ? <div className="workbenchLoading" role="alert"><strong>暂时无法读取本机工作台</strong><span>项目和会话仍保存在这台电脑。</span><button onClick={initialize}>重新读取</button></div> : !project ? <div className="welcome"><img src="./brand/turnsu-symbol.svg" alt="" /><h1>从手边的项目开始</h1><p>用你自己的 Agent，处理文件、推进工作。<br />不需要先配置云端工作台。</p><button className="primary" onClick={openProject}><FolderOpen size={18} />打开本地项目</button><small>文件保留在原来的位置</small></div> : <>
          {(historyNavigation?.older || historyPage) && <nav className="historyNavigation" aria-label="对话记录"><button disabled={historyLoading || !historyNavigation?.older} onClick={() => readHistory('before', historyNavigation.older)}><ChevronLeft size={14}/>查看更早</button>{historyPage && <><span>较早的对话</span><button disabled={historyLoading || !historyNavigation?.newer} onClick={() => readHistory('after', historyNavigation.newer)}>查看较新<ChevronRight size={14}/></button><button disabled={historyLoading} onClick={() => readHistory('latest')}>回到最新</button></>}{historyLoading && <span role="status">读取中…</span>}</nav>}
          <div className="transcript" ref={transcript} onScroll={() => { const el = transcript.current; const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90; atBottom.current = nearBottom; setAwayFromBottom(!nearBottom && el.scrollHeight > el.clientHeight + 90); if (nearBottom) setHasNewContent(false); }}>
            {navigationStage ? <div className="workbenchLoading" role="status"><LoaderCircle className="spin" size={20}/><strong>{navigationStage === "saving" ? "正在保存当前草稿" : "正在打开会话"}</strong><span>{navigationStage === "saving" ? "保存完成后继续切换" : "读取会话、引用资料与草稿…"}</span></div> : draftLoadFailed ? <div className="workbenchLoading" role="status"><strong>这段会话暂时打不开</strong><span>草稿仍保存在本机。可以重试读取。</span><button onClick={() => selectProject(projectId, sessionId)}>重新读取</button></div> : !visibleMessages.length ? <div className="taskWelcome"><span className="eyebrow">{project.sharing?.title || project.name}</span><h1>今天想完成什么？</h1><p>说说目标，Agent 会在这个项目里与你一起完成。</p>{session && active(session.status) && <div className="activity"><LoaderCircle className="spin" size={14}/>{labels[session.status]}</div>}</div> : <div className="messageColumn">{visibleMessages.map((m) => <article key={m.id} className={`message ${m.role}`}>
              {m.role === "tool" ? <details><summary>{m.kind === "file" ? <FileText size={14} /> : <ChevronRight size={14} />}<span>{m.kind === "file" ? "文件变更" : "执行操作"}</span></summary><pre>{m.text}</pre></details> : m.role === "user" ? <><p>{m.text}</p>{m.references?.map(file => <SentFileReference key={referenceKey(file)} sessionId={sessionId} inputId={m.id} file={file}/>)}</> : <Markdown>{m.text}</Markdown>}
              {m.role === "assistant" && m.kind === "text" && session.status === "idle" && session.lastSubmission?.status === "completed" && !session.capture && !session.loopCapture && !session.localLoopTrial && <><button className="captureAction" onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, message: m }); }}>整理为技能</button><button className="captureAction" onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, message: m, kind: 'loop' }); }}>整理为 Loop</button></>}
            </article>)}{session.interactions?.map((item) => <Interaction key={item.id} item={item} sessionId={sessionId} report={setError} />)}
            {active(session.status) && <div className="activity"><LoaderCircle className="spin" size={14} />{labels[session.status]}</div>}
            {session.error && <div className="inlineError">{session.error}</div>}
            </div>}
          </div>
          {!navigationStage && !historyPage && !draftLoadFailed && awayFromBottom && <button className="latestJump" onClick={goToLatest}><ArrowDown size={14}/>{hasNewContent ? "有新内容 · 回到底部" : "回到底部"}</button>}
          <div className="composerArea">
            {session?.remote && <RemoteTaskPanel key={session.id} session={session} onChanged={refresh}/>}
            {session?.localLoopTrial && <div className="methodNotice"><span>本机试做 · {session.localLoopTrial.name}</span><button disabled={active(session.status)} onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, kind: 'local-trial' }); }}>核对试做结果</button></div>}
            {session?.loopCapture && <div className="methodNotice"><span>正在整理可复用 Loop</span><button disabled={active(session.status)} onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session, kind: 'loop' }); }}>查看流程草稿</button></div>}
            {session?.capture && <div className="methodNotice"><span>{session.capture.installed ? '这份草稿已采用到本机' : '正在整理可复用技能 · 草稿仅在本机'}</span><button disabled={active(session.status)} onClick={e => { captureTrigger.current = e.currentTarget; setCaptureOpen({ session }); }}>查看技能草稿</button></div>}
            {session?.nativeLoop && <div className="methodNotice"><span>已选择流程：<strong>{session.nativeLoop.name}</strong> · v{session.nativeLoop.version}</span><small>描述任务后发送，由你的 Agent 按步骤处理</small></div>}
            {session?.method && <div className="methodNotice"><span>已选择技能：<strong>{session.method.skillName}</strong> · v{session.method.version}</span><small>描述任务后发送，由你的 Agent 使用</small></div>}
            {session?.sharedWork && <div className="sharedWorkNotice"><span>{session.sharedWork.canContinueOffline ? `团队暂时无法连接。上次资料：${new Date(session.sharedWork.contextFetchedAt).toLocaleString()}。新内容先保存在本机，恢复后核验权限并同步。` : session.sharedWork.error || (session.sharedWork.pending ? '请求与答复正在同步到团队…' : '本次请求与最终答复对工作成员可见')}</span>{(session.sharedWork.error || session.sharedWork.pending > 0 || session.sharedWork.canContinueOffline) && <button onClick={() => control(session.sharedWork.workItemId ? 'work.retry' : 'work.finish')}>重试共享</button>}{session.sharedWork.canContinueOffline && !active(session.status) && <button disabled={!draft.trim() || sending || modelsLoading || draftLoading || !chosenAgent?.installed || session.status === 'interrupted'} onClick={() => send(true)}>用上次资料在本机继续</button>}</div>}
            {session?.status === "interrupted" && <div className="resume"><span>上次执行已中断。恢复后检查结果，再继续。</span><button onClick={() => control("session.resume")}><RotateCcw size={14} />恢复会话</button></div>}
            <div className="composer">{!remoteAgent && <div className="connectionSource"><label htmlFor="connection-source">模型来源</label><select id="connection-source" value={chosenConnectionId} disabled={Boolean(sessionId && (!session || session.native_id || session.lastSubmission)) || draftLoading || sending || modelsLoading || creatingSession} onChange={e => chooseConnection(e.target.value)}><option value="">跟随原生 Agent</option>{connections.filter(c => c.agents.includes(agentId)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}{chosenConnectionId && !chosenConnection && <option value={chosenConnectionId}>连接不可用</option>}</select>{chosenConnection && <code title={chosenConnection.baseUrl}>{chosenConnection.baseUrl}</code>}<button onClick={openConnections}>管理连接</button></div>}
              {remoteAgent && <div className="remoteComposer"><label>Agent 账号<select aria-label="Agent 账号" value={chosenAgentConnectionId} disabled={Boolean(sessionId) || sending} onChange={e => updateRemoteDraft(remoteMaterials, e.target.value)}><option value="">选择已连接账号</option>{agentConnections.filter(c => !c.revoked && (c.provider === agentId || c.agents?.includes(agentId))).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}{chosenAgentConnectionId && !agentConnections.some(c => c.id === chosenAgentConnectionId) && <option value={chosenAgentConnectionId}>此任务绑定的账号</option>}</select></label><button onClick={() => setAgentConnectionsOpen(true)}>管理 Agent</button>{chosenAgent?.files && <ProjectMaterialPicker key={projectId} projectId={projectId} paths={remoteMaterials.split('\n').map(p=>p.trim()).filter(Boolean)} disabled={sending} onChange={paths=>updateRemoteDraft(paths.join('\n'),chosenAgentConnectionId)}/>}<label className="externalConsent"><input type="checkbox" checked={allowExternal} disabled={sending} onChange={e => setAllowExternal(e.target.checked)}/>将本次提示词、引用内容与选定材料交给 {chosenAgent?.name}；其原生工具权限由该服务管理。</label></div>}
              {references.length > 0 && <div className="referenceChips" aria-label="已引用资料">{references.map(selection => <span key={referenceKey(selection)}><FileText size={14}/><span title={referenceLabel(selection)}>{referenceLabel(selection)}{typeof selection !== "string" && <small> · {selection.kind === "work-decision" ? "决定" : selection.kind === "work-entry" ? "共享进展" : selection.kind === "wechat-import" ? "微信导入" : "历史版本"}</small>}</span><button disabled={sending || creatingSession || draftLoading} aria-label={`移除引用 ${referenceLabel(selection)}`} onClick={() => changeDraft(draft, references.filter(item => referenceKey(item) !== referenceKey(selection)))}><X size={13}/></button></span>)}</div>}<Textarea ref={composerInput} aria-label="任务描述" placeholder={sessionId ? "继续这项工作…" : "描述你想完成的工作…"} value={draft} disabled={draftLoading || sending || creatingSession} onChange={(e) => changeDraft(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(e) => { if (e.key === "@" && !composing.current && !e.nativeEvent.isComposing && (!e.currentTarget.selectionStart || /\s/.test(draft[e.currentTarget.selectionStart - 1]))) { e.preventDefault(); setReferencePicker(true); return; } if (e.key === "Enter" && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
              <div className="composerToolbar"><button className="referenceTrigger" aria-label="引用资料" title="引用资料（@）" disabled={sending || creatingSession || draftLoading} onClick={() => setReferencePicker(true)}>＠</button><span className="agentChoice"><select aria-label="执行 Agent" value={agentId} disabled={Boolean(sessionId) || sending || draftLoading || modelsLoading} onChange={(e) => { ++manualAgentVersion.current; setAgentId(e.target.value); setConnectionId(""); setModels(null); setModel(""); }}>
                {workspace.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{agent.installed ? '' : agent.kind ? ' · 未连接' : ' · 未安装'}</option>)}
              </select> {!remoteAgent && (models ? <select aria-label="执行模型" value={model} disabled={draftLoading || sending || active(session?.status)} onChange={(e) => chooseModel(e.target.value)}><option value="" disabled={Boolean(chosenConnectionId)}>{chosenConnectionId ? "请选择网关模型" : "沿用会话配置"}</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select> : <button className="modelChoice" disabled={draftLoading || sending || modelsLoading || active(session?.status)} onClick={loadModels}>{modelsLoading ? "读取模型…" : (model || "选择模型")}</button>)}</span><span className="composerHint">{remoteAgent ? (chosenAgent?.installed ? "按选定材料交接" : "请先连接 Agent") : chosenAgent?.installed ? (agentId === "pi" ? "使用 Pi 本机权限" : "在此项目工作") : `请先安装 ${chosenAgent?.name || agentId} CLI`}</span>{active(session?.status) && !answering ? <button disabled={remoteAgent && chosenAgent?.stop === false} title={remoteAgent && chosenAgent?.stop === false ? "请在原生应用中停止" : undefined} className="send" aria-label="停止执行" onClick={() => control("session.stop")}><Square size={15} /></button> : <button className="send" aria-label="发送任务" disabled={!draft.trim() || sending || modelsLoading || draftLoading || !chosenAgent?.installed || session?.status === "interrupted" || (remoteAgent && (!allowExternal || !chosenAgentConnectionId))} onClick={send}>{sending ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button>}</div>
            </div><div className="composerMeta"><span>{draftStatus || (remoteAgent ? "选定内容会外发 · 账号不等于工具授权" : session?.sharedWork ? "团队工作 · 工具日志和原生历史保留在本机" : project.sharing ? "文件与团队共享 · 对话仅在本机" : agentId === "pi" ? "Pi 按本机配置运行 · 扩展请求会在这里显示" : "仅在本机 · 需要权限时会询问你")}</span>{!sessionId && agentPreference ? <span className="agentPreferenceActions"><button disabled={preferenceSaving || agentPreference.project === agentId} onClick={() => saveAgentPreference('project')}>{agentPreference.project === agentId ? '本项目默认' : '设为本项目默认'}</button><button disabled={preferenceSaving || agentPreference.personal === agentId} onClick={() => saveAgentPreference('personal')}>{agentPreference.personal === agentId ? '个人默认' : '设为个人默认'}</button></span> : <span>@ 资料和方法 · Enter 发送</span>}</div>
          </div>
        </>}
      </section>
      {filePanel && project && <aside className="filePanel"><div className="fileHeader"><strong>{preview ? basename(preview.path) : "项目文件"}</strong><button aria-label="关闭文件面板" onClick={() => setFilePanel(false)}><X size={16} /></button></div><div className="fileTools"><button onClick={() => preview ? setPreview(null) : listFiles(folder.split("/").slice(0, -1).join("/"))} disabled={!preview && !folder}><ChevronLeft size={15} />返回</button><button aria-label="刷新项目文件" onClick={() => listFiles(folder)}><RotateCcw size={15} /></button></div>
        {importNotice && <p className="importNotice" role="status">{importNotice}</p>}
        {preview && <div className="referencePreviewAction"><button disabled={sending || creatingSession || draftLoading || previewRefChecking || references.length >= 4 || references.includes(preview.path)} onClick={() => addPreviewReference(preview.path)}><FileText size={14}/>{previewRefChecking ? '检查中…' : references.includes(preview.path) ? '已引用到任务' : '引用到任务'}</button><button onClick={() => openProjectFile(preview.path)}>系统打开</button></div>}
        {fileError && <div className="inlineError" role="alert">{fileError}</div>}
        {fileLoading ? <div className="fileLoading" role="status"><LoaderCircle className="spin" size={16}/>正在读取项目文件…</div> : preview ? <div className="filePreview">{/\.md$/i.test(preview.path) ? <Markdown>{preview.text}</Markdown> : <pre>{preview.text}</pre>}</div> : <div className="fileList"><p className="filePath">{folder || project.sharing?.title || project.name}</p>{fileList?.entries.map((f) => <div className="fileEntry" key={f.path}><button onClick={() => readFile(f)}>{f.directory ? <Folder size={16} /> : <FileText size={16} />}<span>{f.name}</span>{f.directory && <ChevronRight size={13} />}</button>{!f.directory && <button className="nativeFileAction" onClick={() => openProjectFile(f.path)}>{/\.(?:txt|md|markdown|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(f.path) ? '系统打开' : '定位'}</button>}</div>)}{fileList?.entries.length === 0 && <p className="muted">这个文件夹还没有文件。</p>}{fileList?.truncated && <p className="muted">当前显示前 500 项，请进入子文件夹查看。</p>}</div>}
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
createRoot(document.getElementById("root")).render(<App />);
