import { sessionIndex } from './session-index.mjs';
import { AgentPreferences } from './agent-preferences.mjs';
import { WeChatImports } from './wechat-imports.mjs';
import { ModelConnections, normalizeConnection } from './model-connections.mjs';
import { ProjectMembers } from './project-members.mjs';
import { messageHistory } from "./message-history.mjs";
import { randomUUID } from "node:crypto";
import { realpath, stat, readdir, open, mkdir } from "node:fs/promises";
import { basename, join, resolve, relative, isAbsolute, sep, parse } from "node:path";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { openStore } from "./store.mjs";
import { CodexConnection, discoverAgents } from "./codex.mjs";
import { PiConnection } from "./pi.mjs";
import { ClaudeConnection } from "./claude.mjs";
import { DesktopCloud } from "./cloud.mjs";
import { ProjectCreation } from './project-creation.mjs';
import { SharedFiles } from "./shared-files.mjs";
import { TeamLoops } from "./team-loops.mjs";
import { TeamMethods } from "./team-methods.mjs";
import { SharedWork } from "./shared-work.mjs";
import { MethodCapture } from "./method-capture.mjs";
import { LoopCapture } from "./loop-capture.mjs";
import { LocalLoopTrials } from "./local-loop-trials.mjs";
import { LocalLoopPublication } from "./local-loop-publication.mjs";
import { NativeLoopMethods } from "./native-loop-methods.mjs";
import { ProjectSkills } from "./project-skills.mjs";
import { FileReferences, referencePaths } from "./file-references.mjs";
import { MethodPublication } from "./method-publication.mjs";
import { MemberAgentWork } from './member-agent-work.mjs';

const text = (value, max = 100_000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("内容为空或超过长度限制。");
  return value;
};
const busyStates = new Set(["starting", "running", "waiting", "stopping"]);
export function readableError(value) {
  let message = value || "";
  try { const parsed = JSON.parse(message); message = parsed.error?.message || parsed.message || message; } catch {}
  if (/requires a newer version of Codex/i.test(message)) return "当前模型需要更新版本的 Codex。请从下方选择本机可用的模型，再发送任务；也可以先更新 Codex CLI。";
  return message;
}

export class LocalAgentHost {
  constructor({ directory, notify = () => {}, clock = () => Date.now(), idleTimeoutMs = 300_000, idleConnectionLimit = 2, connectionFactory = (options) => new CodexConnection(options), piFactory = (options) => new PiConnection(options), claudeFactory = (options) => new ClaudeConnection(options), wechatRoot = undefined, wechatGroupRoot = undefined }) {
    this.modelConnections = new ModelConnections(); this.codexConnections = new Map();
    this.claudeFactory = claudeFactory; this.claudeConnections = new Map(); this.claudeStreams = new Map();
    this.directory = directory; this.piFactory = piFactory; this.piConnections = new Map(); this.piErrors = new Map(); this.modelCatalogs = new Map();
    this.store = openStore(directory); this.db = this.store.db;
    this.agentPreferences = new AgentPreferences(this.db);
    this.wechat = new WeChatImports(this, { ...(wechatRoot === undefined ? {} : { bridgeRoot: wechatRoot }), ...(wechatGroupRoot === undefined ? {} : { groupRoot: wechatGroupRoot }) });
    this.references = new FileReferences(this);
    this.notify = notify; this.connectionFactory = connectionFactory; this.capture = new MethodCapture(this); this.loopCapture = new LoopCapture(this);
    this.localLoopTrials = new LocalLoopTrials(this);
    this.localLoopPublication = new LocalLoopPublication(this); this.nativeLoops = new NativeLoopMethods(this);
    this.projectSkills = new ProjectSkills(this);
    this.clock = clock; this.idleTimeoutMs = idleTimeoutMs; this.idleConnectionLimit = idleConnectionLimit;
    this.nativeTouched = new Map(); this.codexTouched = new Map(); this.releasing = new Map(); this.releasingCodex = new Map();
    this.idleTimer = setInterval(() => { this.reapIdleConnections().catch(() => {}); }, 30_000); this.idleTimer.unref();
    this.connection = null; this.liveSessions = new Set(); this.interactions = new Map(); this.operations = new Set();
    if (this.db.prepare('SELECT 1 FROM shared_projects LIMIT 1').get()) this.sharing();
    if (this.db.prepare('SELECT 1 FROM shared_work_sessions LIMIT 1').get()) this.teamWork();
  }
  touchNative(id) { this.nativeTouched.set(id, this.clock()); }
  reapIdleConnections() {
    if (this.closing) return Promise.resolve();
    if (this.reaping) return this.reaping;
    this.reaping = this.releaseIdleConnections().finally(() => { this.reaping = null; });
    return this.reaping;
  }
  async releaseIdleConnections() {
    const ids = new Set([...this.liveSessions, ...this.piConnections.keys(), ...this.claudeConnections.keys()]);
    const idle = [...ids].map(id => this.session(id))
      .filter(s => !busyStates.has(s.status) && !this.operations.has(s.id))
      .sort((a, b) => (this.nativeTouched.get(b.id) || 0) - (this.nativeTouched.get(a.id) || 0));
    for (const [index, s] of idle.entries()) {
      if (this.closing) return;
      if (index < this.idleConnectionLimit && this.clock() - (this.nativeTouched.get(s.id) || 0) < this.idleTimeoutMs) continue;
      if (busyStates.has(this.session(s.id).status) || this.operations.has(s.id)) continue;
      const release = (async () => {
        if (s.agent === 'codex') {
          const connection = this.codexConnections.get(s.connection_id || 'native');
          if (connection && !connection.closed && s.native_id) {
            const result = await connection.request('thread/unsubscribe', { threadId: s.native_id });
            if (!['unsubscribed', 'notLoaded', 'notSubscribed'].includes(result?.status)) return;
          }
          this.liveSessions.delete(s.id);
        } else {
          const map = s.agent === 'pi' ? this.piConnections : this.claudeConnections;
          const connection = map.get(s.id); map.delete(s.id);
          await connection?.close(); this.claudeStreams.delete(s.id); this.piErrors.delete(s.id);
        }
        this.nativeTouched.delete(s.id);
      })();
      this.releasing.set(s.id, release);
      try { await release; } catch { /* Keep a failed Codex unsubscribe resumable; close its server when all work is idle. */ }
      finally { this.releasing.delete(s.id); }
    }
    for (const [key, connection] of this.codexConnections) {
      if (this.closing) return;
      const members = [...this.liveSessions].map(id => this.session(id)).filter(s => (s.connection_id || 'native') === key);
      // Pending model discovery and in-flight input admission also own this process.
      if (members.some(s => busyStates.has(s.status) || this.operations.has(s.id)) || connection.pending?.size) continue;
      const admissions = [...this.operations].some(id => { const s = this.session(id); return s.agent === 'codex' && (s.connection_id || 'native') === key; });
      if (admissions || members.some(s => this.clock() - (this.nativeTouched.get(s.id) || 0) < this.idleTimeoutMs)) continue;
      if (this.clock() - (this.codexTouched.get(key) || 0) < this.idleTimeoutMs) continue;
      this.codexConnections.delete(key); this.codexTouched.delete(key);
      for (const s of members) { this.liveSessions.delete(s.id); this.nativeTouched.delete(s.id); }
      if (this.connection === connection) this.connection = null;
      const release = connection.close(); this.releasingCodex.set(key, release);
      try { await release; } finally { this.releasingCodex.delete(key); }
    }
  }
  assistance() { this.memberAgentWork ||= new MemberAgentWork(this); return this.memberAgentWork; }
  teamMethods() {
    this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
    this.methods ||= new TeamMethods({ db: this.db, cloud: this.cloud, project: id => this.project(id), session: id => this.readSession(id), sharedWork: () => this.teamWork(),
      busy: id => this.db.prepare('SELECT status FROM sessions WHERE project_id=?').all(id).some(s => busyStates.has(s.status)), notify: this.notify });
    return this.methods;
  }
  teamWork() {
    this.sharing();
    if (!this.work) {
      this.work = new SharedWork({ db: this.db, cloud: this.cloud, projectBinding: id => this.shared.binding(id), session: id => this.session(id), notify: this.notify });
      this.work.startTimer();
      for (const s of this.db.prepare("SELECT s.id,(SELECT status FROM submissions WHERE session_id=s.id ORDER BY rowid DESC LIMIT 1) AS submitted_status FROM sessions s JOIN shared_work_sessions w ON w.session_id=s.id").all()) if (['completed','failed','interrupted'].includes(s.submitted_status)) this.work.publishFinal(s.id, s.submitted_status === 'completed' ? 'idle' : s.submitted_status);
    }
    return this.work;
  }
  sharing() {
    this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
    this.shared ||= new SharedFiles({ db: this.db, cloud: this.cloud, project: id => this.project(id), notify: event => {
      if (event.type === 'sync-changed' && this.work && this.shared?.snapshot(event.projectId)?.status === 'access') this.work.failedScope(event.projectId, null, Object.assign(new Error('project_access_denied'), { status: 403 }));
      this.notify(event);
    },
      isBusy: id => this.db.prepare('SELECT status FROM sessions WHERE project_id=?').all(id).some(s => busyStates.has(s.status)) });
    this.shared.start(); return this.shared;
  }
  changed(sessionId = null) { this.notify({ type: "changed", sessionId }); }
  session(id) {
    const result = this.db.prepare("SELECT sessions.*,projects.path AS cwd FROM sessions JOIN projects ON projects.id=sessions.project_id WHERE sessions.id=?").get(text(id, 128));
    if (!result) throw new Error("找不到这段会话。");
    return result;
  }
  project(id) {
    const result = this.db.prepare("SELECT * FROM projects WHERE id=?").get(text(id, 128));
    if (!result) throw new Error("找不到这个本地项目。");
    return result;
  }
  snapshot(args = {}) {
    if (args.projectId) this.project(args.projectId);
    const agents = discoverAgents();
    return { projects: this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all().map(p => ({ ...p, sharing: this.shared?.snapshot(p.id) || null })),
      ...sessionIndex(this.db, args),
      activeSessionCount: this.db.prepare("SELECT count(*) AS count FROM sessions WHERE status IN ('starting','running','waiting','stopping')").get().count,
      agents, agentPreference: this.agentPreferences.read(args.projectId, agents) };
  }
  readSession(id) {
    const session = this.session(id); session.error = readableError(session.error);
    const method = this.db.prepare("SELECT receipt FROM native_method_sessions WHERE session_id=?").get(id);
    const history = messageHistory(this.db, id);
    const pending = this.db.prepare('SELECT r.* FROM input_references r LEFT JOIN submissions s ON s.id=r.input_id WHERE r.session_id=? AND s.id IS NULL ORDER BY r.rowid DESC LIMIT 1').get(id);
    return { ...session, nativeLoop: this.nativeLoops.state(id), pendingInput: pending ? { inputId: pending.input_id, sessionId: id, text: pending.prompt, references: JSON.parse(pending.paths) } : null, capture: this.capture.state(id), loopCapture: this.loopCapture.state(id), localLoopTrial: this.localLoopTrials.state(id), method: method ? JSON.parse(method.receipt) : null, lastSubmission: this.db.prepare("SELECT id,status FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(id) || null, sharedWork: this.work?.state(id) || null, messages: history.messages, messagePage: history.page,
      interactions: [...this.interactions.values()].filter((item) => item.sessionId === id).map(({ nativeId, ...item }) => item) };
  }
  updateSession(id, status, error = null) {
    this.touchNative(id);
    this.db.prepare("UPDATE sessions SET status=?,error=?,updated_at=? WHERE id=?").run(status, error, Date.now(), id); this.changed(id);
  }
  message(sessionId, id, role, content, kind = "text", append = false) {
    const old = this.db.prepare("SELECT text FROM messages WHERE id=? AND session_id=?").get(id, sessionId);
    const value = (append ? (old?.text || "") : "") + content;
    // Keep visible output bounded; the native session retains its complete original history.
    const bounded = value.length > 1_000_000 ? value.slice(0, 1_000_000) + "\n[内容过长，完整内容保留在原生会话中]" : value;
    this.db.prepare("INSERT INTO messages(id,session_id,role,text,kind,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,kind=excluded.kind").run(id, sessionId, role, bounded, kind, Date.now());
    this.changed(sessionId);
  }
  async configureConnections(profiles) {
    if (!Array.isArray(profiles) || profiles.length > 12) throw new Error("模型连接配置无效。");
    const next = new Map(profiles.map(p => { const value = normalizeConnection(p); return [value.id, value]; }));
    if (next.size !== profiles.length) throw new Error("模型连接标识重复。");
    const previous = this.modelConnections.profiles;
    const changed = new Set([...previous.keys(), ...next.keys()].filter(id => JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id))));
    const sessions = this.db.prepare("SELECT id,connection_id,status,agent FROM sessions WHERE connection_id IS NOT NULL").all().filter(s => changed.has(s.connection_id));
    if (sessions.some(s => !next.has(s.connection_id))) throw new Error("已有会话使用此连接，请保留连接以便恢复任务。");
    if (sessions.some(s => this.operations.has(s.id) || busyStates.has(s.status))) throw new Error("请先结束使用此连接的任务，再更新模型连接。");
    this.modelConnections.updating = changed;
    try {
      for (const id of changed) {
        const connection = this.codexConnections.get(id);
        await connection?.close(); this.codexConnections.delete(id);
      }
      for (const session of sessions) {
        this.liveSessions.delete(session.id);
        for (const map of [this.piConnections, this.claudeConnections]) { await map.get(session.id)?.close(); map.delete(session.id); }
      }
      this.modelConnections.profiles = next;
      for (const key of this.modelCatalogs.keys()) if ([...changed].some(id => key.endsWith(':' + id))) this.modelCatalogs.delete(key);
      return { configured: true };
    } finally { this.modelConnections.updating = new Set(); }
  }
  modelCatalogKey(session) { return session.connection_id ? `${session.agent}:${session.connection_id}` : session.agent; }
  async codex(connectionId = null) {
    const key = connectionId || 'native';
    await this.releasingCodex.get(key);
    this.codexTouched.set(key, this.clock());
    const gateway = this.modelConnections.get(connectionId, 'codex');
    let connection = this.codexConnections.get(key);
    if (!connection || connection.closed) {
      connection = this.connectionFactory({ gateway, onEvent: e => this.onEvent(e), onRequest: e => this.onRequest(e, connection), onExit: () => {
        if (this.closing || this.codexConnections.get(key) !== connection) return;
        const sessions = this.db.prepare("SELECT id,status FROM sessions WHERE agent='codex' AND connection_id IS ?").all(connectionId);
        for (const session of sessions) {
          this.liveSessions.delete(session.id);
          for (const [id, item] of this.interactions) if (item.sessionId === session.id) this.interactions.delete(id);
          if (busyStates.has(session.status)) this.updateSession(session.id, "interrupted", "Agent 已断开。恢复会话后可检查结果并继续。");
        }
      } });
      this.codexConnections.set(key, connection);
      if (!connectionId) this.connection = connection;
    }
    await connection.ready; return connection;
  }
  async ensureSession(id) {
    await this.releasing.get(id); this.touchNative(id);
    const session = this.session(id);
    if (session.connection_id) { this.modelConnections.get(session.connection_id, session.agent); if (!session.model) throw new Error("请先读取模型目录并选择模型，再发送任务。"); }
    if (session.agent === "pi") { await this.pi(id); return this.session(id); }
    if (session.agent === "claude") { await this.claude(id); return this.session(id); }
    const connection = await this.codex(session.connection_id);
    if (this.liveSessions.has(id)) return session;
    const params = { ...(session.connection_id ? { modelProvider: `turnsu_${session.connection_id.replaceAll("-", "")}` } : {}), cwd: session.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", ...(session.model ? { model: session.model } : {}) };
    const result = session.native_id
      ? await connection.request("thread/resume", { ...params, threadId: session.native_id })
      : await connection.request("thread/start", params);
    if (!result?.thread?.id) throw new Error("Codex 未返回有效会话。");
    this.db.prepare("UPDATE sessions SET native_id=? WHERE id=?").run(result.thread.id, id);
    this.liveSessions.add(id);
    for (const turn of result.thread.turns || []) for (const item of turn.items || []) this.readItem(id, item);
    return this.session(id);
  }
  async claude(id) {
    await this.releasing.get(id); this.touchNative(id);
    const existing = this.claudeConnections.get(id);
    if (existing && !existing.closed) { await existing.ready; return existing; }
    const session = this.session(id);
    const connection = this.claudeFactory({ gateway: this.modelConnections.get(session.connection_id, "claude"), cwd: session.cwd, sessionId: session.native_id || id, resume: Boolean(session.native_id), recoverHistory: session.status === "interrupted", onEvent: (event) => this.onClaudeEvent(id, event), onExit: () => {
      if (this.closing) return;
      for (const [key, item] of this.interactions) if (item.sessionId === id) this.interactions.delete(key);
      if (busyStates.has(this.session(id).status)) this.updateSession(id, "interrupted", "Claude Code 已断开。恢复任务后核对上次结果。");
    } });
    this.claudeConnections.set(id, connection);
    try { await connection.ready; return connection; }
    catch (e) { await connection.close(); this.claudeConnections.delete(id); throw e; }
  }
  onClaudeEvent(id, event) {
    if (this.closing) return;
    if (event.session_id && !event.parent_tool_use_id) this.db.prepare("UPDATE sessions SET native_id=? WHERE id=?").run(event.session_id, id);
    if (event.type === "permission") {
      if (this.session(id).status === "stopping") { this.claudeConnections.get(id)?.respond(event.id, "decline"); return; }
      this.interactions.set(event.id, { id: event.id, nativeId: event.id, sessionId: id, method: event.tool === "AskUserQuestion" ? "claude/question" : "claude/approval", title: event.title, command: [event.description, event.tool, JSON.stringify(event.input, null, 2)].filter(Boolean).join("\n"), questions: event.tool === "AskUserQuestion" ? (event.input.questions || []).map((q, i) => ({ id: String(i), question: q.question, options: q.options, multiSelect: Boolean(q.multiSelect) })) : [] });
      this.updateSession(id, "waiting"); return;
    }
    if (event.type === "permission_closed") { this.interactions.delete(event.id); if (this.session(id).status === "waiting" && ![...this.interactions.values()].some((i) => i.sessionId === id)) this.updateSession(id, "running"); return; }
    if (event.type === "connection_error") { this.updateSession(id, "interrupted", readableError(event.message)); return; }
    if (event.parent_tool_use_id) return;
    if (event.type === "user") {
      if (event.uuid) this.db.prepare("UPDATE submissions SET status='accepted' WHERE id=? AND session_id=? AND status='sending'").run(event.uuid, id);
      if (this.session(id).status === "starting") this.updateSession(id, "running");
    }
    if (event.type === "stream_event") {
      if (event.event.type === "message_start") this.claudeStreams.set(id, { id: event.event.message.id, blocks: new Map() });
      const stream = this.claudeStreams.get(id);
      if (stream && event.event.type === "content_block_delta" && event.event.delta.type === "text_delta") {
        stream.blocks.set(event.event.index, (stream.blocks.get(event.event.index) || "") + event.event.delta.text);
        this.message(id, `${id}:claude:${stream.id}`, "assistant", [...stream.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join("\n"));
      }
    }
    if (event.type === "assistant") {
      const content = event.message.content || [];
      const value = content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (value) this.message(id, `${id}:claude:${event.message.id || event.uuid}`, "assistant", value);
      for (const part of content.filter((p) => p.type === "tool_use")) this.message(id, `${id}:claude:tool:${part.id}`, "tool", part.input?.command || part.input?.file_path || part.name, ["Edit", "Write"].includes(part.name) ? "file" : "command");
    }
    if (event.type === "result") {
      const interrupted = this.session(id).status === "stopping" || (event.terminal_reason && event.terminal_reason !== "completed");
      const failed = event.is_error || event.subtype !== "success";
      const status = this.session(id).status === "stopping" || ["aborted_streaming", "aborted_tools"].includes(event.terminal_reason) ? "interrupted" : failed ? "failed" : interrupted ? "interrupted" : "idle";
      const error = failed ? readableError(event.errors?.join("\n") || event.result || "Claude Code 未完成任务，请检查账户后继续。") : interrupted ? "本次执行已停止或需要继续处理，请核对结果后恢复任务。" : null;
      for (const [key, item] of this.interactions) if (item.sessionId === id) this.interactions.delete(key);
      this.db.prepare("UPDATE submissions SET status=? WHERE session_id=? AND status IN ('sending','accepted')").run(status === "idle" ? "completed" : status, id);
      this.updateSession(id, status, error); this.work?.publishFinal(id, status);
    }
  }
  async pi(id) {
    await this.releasing.get(id); this.touchNative(id);
    const existing = this.piConnections.get(id);
    if (existing && !existing.closed) { await existing.ready; return existing; }
    const session = this.session(id);
    const directory = join(this.directory, "pi", id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const sessionPath = join(directory, "session.jsonl");
    if (session.native_id) {
      try { await stat(sessionPath); } catch (e) {
        throw new Error("Pi 的原生会话文件不可用，请恢复该文件后继续；已有结果仍保留在桌面。");
      }
    }
    const connection = this.piFactory({ gateway: this.modelConnections.get(session.connection_id, "pi"), model: session.model, cwd: session.cwd, sessionPath, onEvent: (event) => this.onPiEvent(id, event), onExit: () => {
      if (this.closing) return;
      for (const [key, item] of this.interactions) if (item.sessionId === id) this.interactions.delete(key);
      if (busyStates.has(this.session(id).status)) this.updateSession(id, "interrupted", "Pi 已断开，恢复会话后检查上次执行结果。");
    } });
    this.piConnections.set(id, connection);
    try {
      await connection.ready;
      await this.rememberPiFile(id);
      if (session.status === 'interrupted' || this.db.prepare("SELECT 1 FROM submissions WHERE session_id=? AND status='unknown' LIMIT 1").get(id)) {
        const history = await connection.request("get_messages");
        for (const item of history.messages || []) this.piMessage(id, item);
      }
      return connection;
    } catch (e) { await connection.close(); this.piConnections.delete(id); throw e; }
  }
  rememberPiFile(id) {
    const path = join(this.directory, "pi", id, "session.jsonl");
    try { statSync(path); if (!this.closing) this.db.prepare("UPDATE sessions SET native_id=? WHERE id=?").run(path, id); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  piMessage(id, message) {
    if (message?.role !== "assistant") return;
    const content = (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
    if (content) this.message(id, `${id}:pi:${message.timestamp}`, "assistant", content);
    if (message.stopReason === "error") this.piErrors.set(id, message.errorMessage || "Pi 执行失败，请检查本机模型账户后继续。");
    else if (message.stopReason === "aborted") this.piErrors.set(id, "interrupted");
  }
  onPiEvent(id, event) {
    if (event.type === "message_update" || event.type === "message_end") this.piMessage(id, event.message);
    if (event.type === "agent_start" && this.session(id).status !== "stopping") this.updateSession(id, "running");
    if (event.type === "tool_execution_start") this.message(id, `${id}:pi:tool:${event.toolCallId}`, "tool", event.args?.command || event.args?.path || event.toolName, ["write", "edit"].includes(event.toolName) ? "file" : "command");
    if (event.type === "auto_retry_end" && event.success) this.piErrors.delete(id);
    if (event.type === "agent_settled") {
      try { this.rememberPiFile(id); } catch { this.message(id, `${id}:pi:storage`, "notice", "暂时无法确认 Pi 会话文件，请检查本机存储后再关闭。"); }
      const error = this.piErrors.get(id); this.piErrors.delete(id);
      const status = error === "interrupted" || this.session(id).status === "stopping" ? "interrupted" : error ? "failed" : "idle";
      for (const [key, item] of this.interactions) if (item.sessionId === id) this.interactions.delete(key);
      this.db.prepare("UPDATE submissions SET status=? WHERE session_id=? AND status IN ('sending','accepted')").run(status === "idle" ? "completed" : status, id);
      this.updateSession(id, status, error && error !== "interrupted" ? readableError(error) : null); this.work?.publishFinal(id, status);
    }
    if (event.type === "extension_ui_request") {
      if (["confirm", "select", "input", "editor"].includes(event.method)) {
        if (this.session(id).status === "stopping") { this.piConnections.get(id)?.respond(event.id, { cancelled: true }).catch(() => {}); return; }
        const key = randomUUID();
        this.interactions.set(key, { id: key, nativeId: event.id, sessionId: id, method: `pi/${event.method}`, title: event.title || "Pi 需要你的回应", command: event.message || "", questions: event.method === "confirm" ? [] : [{ id: "answer", question: event.title || "填写回答", options: event.options?.map((label) => ({ label })), prefill: event.prefill || "", multiline: event.method === "editor" }], expiresAt: event.timeout ? Date.now() + event.timeout : null });
        this.updateSession(id, "waiting");
        if (event.timeout) { const timer = setTimeout(() => { if (this.closing || !this.interactions.delete(key)) return; if (this.session(id).status === "waiting") this.updateSession(id, "running"); }, event.timeout); timer.unref(); }
      } else if (event.method === "notify") this.message(id, `${id}:pi:notice:${event.id}`, "notice", event.message || "Pi 通知");
    }
  }
  readItem(sessionId, item) {
    if (item.type === "agentMessage") this.message(sessionId, `${sessionId}:${item.id}`, "assistant", item.text || "");
    else if (item.type === "commandExecution") this.message(sessionId, `${sessionId}:${item.id}`, "tool", item.command || "执行命令", "command");
    else if (item.type === "fileChange") this.message(sessionId, `${sessionId}:${item.id}`, "tool", (item.changes || []).map((c) => c.path).join("\n") || "更新文件", "file");
  }
  onEvent({ method, params = {} }) {
    const session = params.threadId && this.db.prepare("SELECT * FROM sessions WHERE native_id=?").get(params.threadId);
    if (!session) return;
    if (method === "item/agentMessage/delta") this.message(session.id, `${session.id}:${params.itemId}`, "assistant", params.delta || "", "text", true);
    if (method === "item/completed" || method === "item/started") this.readItem(session.id, params.item || {});
    if (method === "turn/started") {
      this.db.prepare("UPDATE submissions SET native_turn_id=?,status='accepted' WHERE session_id=? AND status='sending'").run(params.turn.id, session.id);
      this.updateSession(session.id, "running");
    }
    if (method === "turn/completed") {
      for (const [key, item] of this.interactions) if (item.sessionId === session.id) this.interactions.delete(key);
      this.db.prepare("UPDATE submissions SET status=? WHERE session_id=? AND native_turn_id=?").run(params.turn.status, session.id, params.turn.id);
      this.updateSession(session.id, params.turn.status === "completed" ? "idle" : params.turn.status === "interrupted" ? "interrupted" : "failed", params.turn.error?.message || null);
      this.work?.publishFinal(session.id, this.session(session.id).status);
    }
    if (method === "error" && !params.willRetry) this.updateSession(session.id, "failed", params.error?.message || "Agent 执行失败，请检查登录或稍后恢复。");
  }
  onRequest({ id, method, params }, connection = this.connection) {
    const session = params?.threadId && this.db.prepare("SELECT * FROM sessions WHERE native_id=?").get(params.threadId);
    if (!session) { connection.reject(id); return; }
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].includes(method)) {
      connection.reject(id);
      this.message(session.id, `${session.id}:unsupported:${id}`, "notice", "Agent 请求了当前桌面版尚未支持的交互，此请求已拒绝。"); return;
    }
    const key = randomUUID();
    this.interactions.set(key, { id: key, nativeId: id, sessionId: session.id, method, title: method.endsWith("requestUserInput") ? "Agent 需要你的回答" : "允许这次操作？", command: params.command || params.reason || "修改项目文件", questions: params.questions || [] });
    this.updateSession(session.id, "waiting");
  }
  async pathInProject(projectId, requested = "") {
    const project = this.project(projectId);
    const root = await realpath(project.path);
    const candidate = await realpath(resolve(root, requested));
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("只能查看当前项目内的文件。");
    return candidate;
  }
  async command(method, args = {}) {
    if (method.startsWith('assistance.')) {
      const service = this.assistance();
      if (method === 'assistance.list') return service.list(args);
      if (method === 'assistance.models') return service.models();
      if (method === 'assistance.catalog') return service.catalog(args);
      if (method === 'assistance.submit') return service.submit(args);
      throw new Error('工作台不支持这个操作。');
    }
    if (method === 'nativeLoops.list') return this.nativeLoops.list(args.cursor);
    if (method === 'nativeLoops.use') return this.nativeLoops.use(args);
    if (method === 'skills.list') return this.projectSkills.list(args);
    if (method === 'skills.read') return this.projectSkills.read(args);
    if (method === 'skills.use') return this.projectSkills.use(args);
    if (method === 'localLoopTrial.publication') return this.localLoopPublication.view(args.sessionId);
    if (method === 'localLoopTrial.changeVersion') return this.localLoopPublication.changeVersion(args);
    if (method === 'localLoopTrial.publish') {
      this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
      return this.localLoopPublication.publish(args);
    }
    if (method.startsWith('localLoopTrial.')) {
      if (method === 'localLoopTrial.create') return this.localLoopTrials.create(args);
      if (method === 'localLoopTrial.review') return this.localLoopTrials.review(args.sessionId);
      if (method === 'localLoopTrial.saved') return this.localLoopTrials.saved(args.sessionId);
      if (method === 'localLoopTrial.record') {
        this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
        return this.localLoopTrials.record(args);
      }
      throw new Error('工作台不支持这个操作。');
    }
    if (method.startsWith('loopCapture.')) {
      if (method === 'loopCapture.create') { if (args.includeTeamSkills) this.teamMethods(); return this.loopCapture.create(args); }
      if (method === 'loopCapture.preview') return this.loopCapture.preview(args.sessionId);
      this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
      if (method === 'loopCapture.cloud') return this.loopCapture.cloudState(args.sessionId);
      if (method === 'loopCapture.save') return this.loopCapture.save(args);
      if (method === 'loopCapture.check') return this.loopCapture.check(args.sessionId);
      if (method === 'loopCapture.reset') return this.loopCapture.reset(args);
      throw new Error('工作台不支持这个操作。');
    }
    if (['capture.cloud', 'capture.saveCloud', 'capture.resetCloud', 'capture.trials', 'capture.releaseAction', 'capture.retryRelease'].includes(method)) {
      this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
      this.publication ||= new MethodPublication({ host: this, cloud: this.cloud });
      if (method === 'capture.trials') return this.publication.release.state(args.sessionId);
      if (method === 'capture.releaseAction') return this.publication.release.submit(args);
      if (method === 'capture.retryRelease') return this.publication.release.retry(args.requestId);
      if (method === 'capture.resetCloud') return this.publication.reset(args);
      return method === 'capture.cloud' ? this.publication.state(args.sessionId) : this.publication.prepare(args);
    }
    if (method.startsWith('loops.')) {
      this.teamWork();
      this.loops ||= new TeamLoops({ db: this.db, cloud: this.cloud, work: this.work, notify: this.notify });
      if (method === 'loops.inspect') return this.loops.actions.inspect(args);
      if (method === 'loops.action') return this.loops.actions.submit(args);
      if (method === 'loops.retryAction') return this.loops.actions.retry(args.requestId);
      if (method === 'loops.catalog') return this.loops.catalog(args.projectId,args.workItemId,args.cursor);
      if (method === 'loops.state') return this.loops.state(args.projectId,args.workItemId);
      if (method === 'loops.prepare') return this.loops.prepare(args);
      if (method === 'loops.draft') return this.loops.draft(args.preparationId,args.inputs);
      if (method === 'loops.run') return this.loops.run(args);
      if (method === 'loops.retry') return this.loops.retry(args.requestId);
      throw new Error('工作台不支持这个操作。');
    }
    if (method === 'capture.create') return this.capture.create(args);
    if (method === 'capture.preview') return this.capture.preview(args.sessionId);
    if (method === 'capture.adopt') return this.capture.adopt(args);
    if (method === 'capture.use') return this.capture.use(args);
    if (method === 'methods.list') return this.teamMethods().list(args.cursor);
    if (method === 'methods.use') return this.teamMethods().use(args);
    if (method.startsWith('work.')) {
      const work = this.teamWork();
      if (method === 'work.decision.open') return work.decisions.open(args);
      if (method === 'work.result.state') return work.results.state(args);
      if (method === 'work.result.submit') return work.results.submit(args);
      if (method === 'work.handoff.open') return work.handoffs.open(args);
      if (method === 'work.handoff.save') return work.handoffs.save(args);
      if (method === 'work.handoff.submit') return work.handoffs.submit(args);
      if (method === 'work.handoff.status') return work.handoffs.status(args.id);
      if (method === 'work.members') return work.handoffs.members(args);
      if (method === 'work.decision.status') return work.decisions.status(args.id);
      if (method === 'work.decision.save') return work.decisions.save(args);
      if (method === 'work.decision.submit') return work.decisions.submit(args);
      if (method === 'work.list') return work.list(text(args.projectId, 128));
      if (method === 'work.read') return work.context(text(args.projectId, 128), text(args.workItemId, 128), args.cursor);
      if (method === 'work.file') return work.file({ projectId: text(args.projectId, 128), workItemId: text(args.workItemId, 128), revisionId: text(args.revisionId, 128) });
      if (method === 'work.start') return work.start(args);
      if (method === 'work.continue') return work.continue(args);
      if (method === 'work.finish') { const saved = this.db.prepare('SELECT request FROM shared_work_starts WHERE session_id=?').get(args.sessionId); if (!saved) throw new Error('找不到待创建的工作。'); return work.start(JSON.parse(saved.request)); }
      if (method === 'work.retry') { this.session(args.sessionId); return work.retry(args.sessionId); }
      throw new Error('工作台不支持这个操作。');
    }
    if (method.startsWith('sync.')) {
      const shared = this.sharing(), id = text(args.projectId, 128); this.project(id);
      if (method === 'sync.attach') { const result = await shared.attach(id, text(args.remoteId, 128), args.scope); shared.sync(id).catch(() => {}); this.changed(); return result; }
      if (method === 'sync.status') return shared.snapshot(id);
      if (method === 'sync.retry') return shared.sync(id);
      if (method === 'sync.pause') return shared.pause(id);
      if (method === 'sync.resume') return shared.resume(id);
      if (method === 'sync.resolve') return shared.resolve(id, text(args.path, 512), args.choice, args.expectedHeadRevisionId === undefined ? undefined : text(args.expectedHeadRevisionId, 128));
      if (method === 'sync.preview') return shared.preview(id, text(args.path, 512), text(args.revisionId, 128));
      throw new Error('工作台不支持这个操作。');
    }
    if (method.startsWith("cloud.")) {
      this.cloud ||= new DesktopCloud({ directory: this.directory, notify: this.notify });
      await this.cloud.ready;
      if (method.startsWith('cloud.projectMembers.')) {
        this.projectMembers ||= new ProjectMembers(this);
        const action = method.slice('cloud.projectMembers.'.length);
        if (!['open', 'save', 'submit', 'status'].includes(action)) throw new Error('工作台不支持这个成员操作。');
        return this.projectMembers[action](args);
      }
      if (method.startsWith('cloud.projectCreation.')) {
        this.projectCreation ||= new ProjectCreation(this);
        const action = method.slice('cloud.projectCreation.'.length);
        if (!['open', 'save', 'submit', 'status'].includes(action)) throw new Error('工作台不支持这个项目操作。');
        return this.projectCreation[action](args);
      }
      if (method === "cloud.status") return this.cloud.snapshot();
      if (method === "cloud.connect") return this.cloud.connect(text(args.origin, 2048));
      if (method === "cloud.authorization") return { url: this.cloud.authorizationUrl || null };
      if (method === "cloud.cancel") return this.cloud.cancel();
      if (method === "cloud.projects") return this.cloud.projects(args.cursor);
      if (method === "cloud.project") return this.cloud.project(text(args.projectId, 128));
      if (method === "cloud.disconnect") {
        if (this.shared) for (const b of this.db.prepare('SELECT project_id FROM shared_projects').all()) await this.shared.pause(b.project_id);
        return this.cloud.disconnect();
      }
      throw new Error("工作台不支持这个操作。");
    }
    switch (method) {
      case "workspace.read": return this.snapshot(args);
      case "agent.preference.read": {
        if (args.projectId) this.project(args.projectId);
        return this.agentPreferences.read(args.projectId, discoverAgents());
      }
      case "agent.preference.save": {
        this.agentPreferences.save(args);
        this.changed();
        return this.agentPreferences.read(args.projectId, discoverAgents());
      }
      case 'wechat.handoffs': return this.wechat.listHandoffs();
      case 'wechat.preview': return this.wechat.preview(args.id, { offset: args.offset });
      case 'wechat.import': return this.wechat.import(args.projectId, args.id);
      case 'wechat.imports': return this.wechat.list(args.projectId, { before: args.before });
      case 'wechat.records': return this.wechat.records(args.projectId, args.id, args.offset || 0);
      case "session.locate": { const s = this.session(args.sessionId); return { id: s.id, projectId: s.project_id }; }
      case "connections.list": return this.modelConnections.list();
      case "connections.usage": return { sessions: this.db.prepare("SELECT count(*) AS count FROM sessions WHERE connection_id=?").get(text(args.id, 64)).count };
      case "connections.check": return { models: await this.modelConnections.models(text(args.id, 64)), verified: 'catalog-only' };

      case "models.list": {
        const target = args.sessionId ? this.session(args.sessionId) : { agent: args.agent || 'codex', connection_id: args.connectionId || null };
        if (target.connection_id) {
          const models = await this.modelConnections.models(target.connection_id, target.agent);
          this.modelCatalogs.set(this.modelCatalogKey(target), models); return models;
        }
        if (args.agent === "claude") {
          const session = this.session(args.sessionId); if (session.agent !== "claude") throw new Error("请在 Claude Code 任务内选择模型。");
          const connection = await this.claude(session.id);
          const models = connection.models.map((m) => ({ id: m.value, name: m.displayName }));
          this.modelCatalogs.set("claude", models); return models;
        }
        if (args.agent === "pi") {
          const session = this.session(args.sessionId); if (session.agent !== "pi") throw new Error("请在 Pi 任务内选择模型。");
          const result = await (await this.pi(session.id)).request("get_available_models");
          const models = result.models.map((m) => ({ id: `${m.provider}/${m.id}`, name: `${m.name || m.id} · ${m.provider}`, provider: m.provider, modelId: m.id }));
          this.modelCatalogs.set("pi", models); return models;
        }
        const connection = await this.codex(); let cursor = null, models = [];
        do { const page = await connection.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }); models.push(...page.data.filter((m) => !m.hidden).map((m) => ({ id: m.model, name: m.displayName }))); cursor = page.nextCursor; } while (cursor);
        this.modelCatalogs.set("codex", models); return models;
      }
      case "session.model": {
        const session = this.session(args.sessionId);
        if (this.operations.has(session.id) || busyStates.has(session.status)) throw new Error("请等待当前任务结束后再切换模型。");
        if (session.connection_id && !args.model) throw new Error("请为网关连接选择明确的模型。");
        if (args.model !== null && !this.modelCatalogs.get(this.modelCatalogKey(session))?.some((m) => m.id === args.model)) throw new Error("请刷新并选择此连接返回的模型。");
        if (session.agent === 'pi' && session.connection_id) { await this.piConnections.get(session.id)?.close(); this.piConnections.delete(session.id); }
        this.db.prepare("UPDATE sessions SET model=? WHERE id=?").run(args.model, session.id); this.changed(session.id); return this.readSession(session.id);
      }
      case "session.connection": {
        const session = this.session(args.sessionId);
        if (session.native_id || this.operations.has(session.id) || busyStates.has(session.status) || this.db.prepare('SELECT 1 FROM submissions WHERE session_id=? LIMIT 1').get(session.id)) throw new Error('这个会话已经连接过 Agent；请新建任务以选择另一模型来源。');
        const connectionId = args.connectionId || null; this.modelConnections.get(connectionId, session.agent);
        this.db.prepare('UPDATE sessions SET connection_id=?,model=NULL WHERE id=?').run(connectionId, session.id);
        this.changed(session.id); return this.readSession(session.id);
      }
      case "project.open": {
        const path = await realpath(text(args.path, 4096));
        if (!(await stat(path)).isDirectory() || path === parse(path).root || path === homedir()) throw new Error("请选择具体的项目文件夹。");
        let project = this.db.prepare("SELECT * FROM projects WHERE path=?").get(path);
        if (!project) { const id = randomUUID(); this.db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run(id, path, basename(path), Date.now()); project = this.project(id); }
        this.changed(); return project;
      }
      case "draft.read": {
        this.project(args.projectId);
        if (args.sessionId && this.session(args.sessionId).project_id !== args.projectId) throw new Error("这个任务不属于当前项目。");
        return { references: this.references.draft(args.projectId, args.sessionId), text: args.sessionId ? this.db.prepare("SELECT text FROM session_drafts WHERE session_id=?").get(args.sessionId)?.text || "" : this.db.prepare("SELECT text FROM drafts WHERE project_id=?").get(args.projectId)?.text || "" };
      }
      case "draft.save": {
        this.project(args.projectId);
        if (typeof args.text !== "string" || args.text.length > 100_000) throw new Error("输入内容超过长度限制。");
        const paths = referencePaths(args.references ?? this.references.draft(args.projectId, args.sessionId));
        if (args.sessionId && this.session(args.sessionId).project_id !== args.projectId) throw new Error("这个任务不属于当前项目。");
        this.db.exec("BEGIN");
        try {
          if (args.sessionId) this.db.prepare("INSERT INTO session_drafts VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET text=excluded.text").run(args.sessionId, args.text);
          else this.db.prepare("INSERT INTO drafts VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET text=excluded.text").run(args.projectId, args.text);
          this.references.saveDraft(args.projectId, args.sessionId, paths);
          this.db.exec("COMMIT");
        } catch (e) { this.db.exec("ROLLBACK"); throw e; }
        return { saved: true };
      }
      case "session.create": {
        this.project(args.projectId); if (!["codex", "pi", "claude"].includes(args.agent)) throw new Error("这个 Agent 的桌面接入尚未完成。");
        const connectionId = args.connectionId || null; this.modelConnections.get(connectionId, args.agent);
        const id = randomUUID(); this.db.prepare("INSERT INTO sessions(id,project_id,native_id,title,status,error,updated_at,agent,connection_id) VALUES(?,?,NULL,?,'idle',NULL,?,?,?)").run(id, args.projectId, "新任务", Date.now(), args.agent, connectionId); this.changed(id); return this.readSession(id);
      }
      case "session.rename": {
        const session = this.session(args.sessionId);
        const title = text(args.title, 80).trim().replace(/\s+/g, " ");
        this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, session.id);
        this.changed(session.id);
        return this.readSession(session.id);
      }
      case "references.read": {
        this.session(args.sessionId);
        const snapshot = this.references.snapshot(text(args.inputId, 128));
        if (!snapshot || snapshot.session_id !== args.sessionId || !this.db.prepare('SELECT 1 FROM submissions WHERE id=? AND session_id=?').get(args.inputId, args.sessionId)) throw new Error("找不到这次发送的引用文件。");
        const file = snapshot.files.find(file => args.kind === 'wechat-import' ? file.kind === 'wechat-import' && file.importId === args.importId && file.offset === args.offset : args.objectId ? file.objectId === args.objectId && file.kind === args.kind : file.path === args.path && !file.kind);
        if (!file) throw new Error("找不到这次发送的引用文件。");
        return file;
      }
      case "references.list": return this.references.work.list({ sessionId: text(args.sessionId, 128), cursor: args.cursor, sourceWorkItemId: args.sourceWorkItemId });
      case "references.sources": return this.references.work.sources({ sessionId: text(args.sessionId, 128), cursor: args.cursor });
      case "session.history": { this.session(args.sessionId); return messageHistory(this.db, args.sessionId, { before: args.before, after: args.after }); }
      case "session.read": return this.readSession(args.sessionId);
      case "session.resume": {
        const id = text(args.sessionId, 128);
        if (this.operations.has(id)) throw new Error("正在处理上一项操作。");
        this.operations.add(id);
        try { await this.ensureSession(id); if (!busyStates.has(this.session(id).status)) this.updateSession(id, "idle"); return this.readSession(id); }
        finally { this.operations.delete(id); }
      }
      case "session.send": {
        const prompt = text(args.text), inputId = text(args.inputId, 128), session = this.session(args.sessionId);
        const paths = referencePaths(args.references);
        this.references.check(inputId, session.id, prompt, paths);
        const old = this.db.prepare("SELECT * FROM submissions WHERE id=?").get(inputId);
        if (old) {
          if (old.session_id !== session.id || old.prompt !== prompt || (!this.references.snapshot(inputId) && paths.length)) throw new Error("同一请求不能用于不同内容。");
          if (old.status === 'failed') throw new Error('上次请求未完成，输入仍保留。处理错误后可以重新发送。');
          if (old.status === 'unknown') throw new Error('上次请求是否开始尚未确认，请先恢复会话并核对结果，避免重复执行。');
          return this.readSession(session.id);
        }
        if (this.operations.has(session.id) || busyStates.has(session.status)) throw new Error("Agent 正在处理，请先等待或停止当前任务。");
        if (session.status === "interrupted") throw new Error("请先恢复会话，核对上次执行结果。");
        this.operations.add(session.id);
        let prepared, nativePrompt;
        try {
          prepared = this.work ? await this.work.prepare(session.id, prompt, { continueOffline: args.continueOffline === true }) : { prompt, context: null };
          const files = await this.references.prepare(session, inputId, prompt, paths, { continueOffline: prepared.offline === true });
          prepared.prompt = this.references.inject(prepared.prompt, files);
          nativePrompt = this.db.prepare("SELECT 1 FROM native_method_sessions WHERE session_id=?").get(session.id) ? await this.teamMethods().prepare(session.id, prepared.prompt) : prepared.prompt;
          nativePrompt = await this.capture.prepare(session.id, nativePrompt);
          nativePrompt = await this.projectSkills.prepare(session.id, nativePrompt);
          nativePrompt = this.loopCapture.prepare(session.id, nativePrompt);
          nativePrompt = await this.localLoopTrials.prepare(session.id, nativePrompt);
          nativePrompt = await this.nativeLoops.prepare(session.id, nativePrompt);
          const method = this.methods?.state(session.id);
          const nativeLoop = this.nativeLoops.state(session.id);
          const sharedPrompt = prompt + (files.length ? `\n\n引用资料：${files.map(file => file.label || file.path).join("、")}` : "");
          await this.work?.admitInput(session.id, inputId, method ? `使用团队技能「${method.skillName}」v${method.version}\n\n${sharedPrompt}` : nativeLoop ? `使用团队流程「${nativeLoop.name}」v${nativeLoop.version}\n\n${sharedPrompt}` : sharedPrompt, files.filter(file => file.revisionId).map(file => file.revisionId), { continueOffline: prepared.offline === true });
        }
        catch (e) { this.operations.delete(session.id); throw e; }
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare("INSERT INTO submissions VALUES(?,?,?,NULL,'sending')").run(inputId, session.id, prompt);
          this.db.prepare("INSERT INTO messages VALUES(?,?,?,?,'text',?)").run(inputId, session.id, "user", prompt, Date.now());
          this.db.prepare("UPDATE sessions SET title=CASE WHEN title='新任务' THEN ? ELSE title END,status='starting',error=NULL,updated_at=? WHERE id=?").run(prompt.slice(0, 42), Date.now(), session.id);
          if (prepared.context) {
            this.db.prepare('INSERT INTO shared_work_turns VALUES(?,?,?,?)').run(inputId, session.id, JSON.stringify(prepared.context), nativePrompt);
          }
          this.db.exec("COMMIT");
        } catch (e) { this.db.exec("ROLLBACK"); this.operations.delete(session.id); throw e; }
        this.changed(session.id);
        this.work?.flush(session.id).catch(() => {});
        let dispatched = false;
        try {
          await this.shared?.running.get(session.project_id);
          const native = await this.ensureSession(session.id);
          if (["stopping", "interrupted"].includes(this.session(session.id).status)) {
            this.db.prepare("UPDATE submissions SET status='interrupted' WHERE id=?").run(inputId);
            this.updateSession(session.id, "interrupted"); return this.readSession(session.id);
          }
          if (session.agent === "claude") {
            const connection = await this.claude(session.id); dispatched = true;
            await connection.send(inputId, nativePrompt, native.model);
            if (this.session(session.id).status === "starting") this.updateSession(session.id, "running");
            return this.readSession(session.id);
          }
          if (session.agent === "pi") {
            const connection = await this.pi(session.id);
            if (native.model) {
              const slash = native.model.indexOf("/");
              await connection.request("set_model", { provider: native.model.slice(0, slash), modelId: native.model.slice(slash + 1) });
            }
            this.piErrors.delete(session.id); dispatched = true;
            // Extension commands may await the user's answer before acknowledging the prompt.
            // Keep the durable submission visible without holding a desktop IPC call open.
            connection.request("prompt", { message: nativePrompt }).then(async () => {
              if (this.closing) return;
              this.db.prepare("UPDATE submissions SET status='accepted' WHERE id=? AND status='sending'").run(inputId);
              const state = await connection.request("get_state");
              await this.rememberPiFile(session.id);
              if (this.closing) return;
              if (this.db.prepare("SELECT id FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(session.id)?.id !== inputId) return;
              if (busyStates.has(this.session(session.id).status) && !state.isStreaming && !state.isCompacting && !state.pendingMessageCount) this.onPiEvent(session.id, { type: "agent_settled" });
              else if (this.session(session.id).status === "starting") this.updateSession(session.id, "running");
            }).catch((error) => {
              if (this.closing) return;
              if (!["sending", "accepted"].includes(this.db.prepare("SELECT status FROM submissions WHERE id=?").get(inputId)?.status)) return;
              this.db.prepare("UPDATE submissions SET status=? WHERE id=? AND status IN ('sending','accepted')").run(error.rejected ? "failed" : "unknown", inputId);
              this.updateSession(session.id, error.rejected ? "failed" : "interrupted", readableError(error.message));
            });
            return this.readSession(session.id);
          }
          const connection = await this.codex(session.connection_id);
          dispatched = true;
          const result = await connection.request("turn/start", { threadId: native.native_id, ...(native.model ? { model: native.model } : {}), clientUserMessageId: inputId, input: [{ type: "text", text: nativePrompt, text_elements: [] }] });
          this.db.prepare("UPDATE submissions SET native_turn_id=?,status=CASE WHEN status='sending' THEN 'accepted' ELSE status END WHERE id=?").run(result.turn.id, inputId);
          if (this.session(session.id).status === "starting") this.updateSession(session.id, "running");
          return this.readSession(session.id);
        } catch (error) {
          this.db.prepare("UPDATE submissions SET status=? WHERE id=? AND status='sending'").run(dispatched && !error.rejected ? "unknown" : "failed", inputId);
          this.updateSession(session.id, dispatched && !error.rejected ? "interrupted" : "failed", error.message); throw error;
        } finally { this.operations.delete(session.id); }
      }
      case "session.stop": {
        const session = this.session(args.sessionId);
        if (session.agent === "claude") {
          if (!busyStates.has(session.status)) throw new Error("当前没有可停止的执行。");
          this.updateSession(session.id, "stopping"); await (await this.claude(session.id)).stop(); return { accepted: true };
        }
        if (session.agent === "pi") {
          if (!busyStates.has(session.status)) throw new Error("当前没有可停止的执行。");
          this.updateSession(session.id, "stopping");
          const connection = await this.pi(session.id);
          for (const [key, item] of this.interactions) if (item.sessionId === session.id) { await connection.respond(item.nativeId, { cancelled: true }); this.interactions.delete(key); }
          await connection.request("abort");
          const state = await connection.request("get_state");
          if (this.session(session.id).status === "stopping" && !state.isStreaming && !state.isCompacting) this.onPiEvent(session.id, { type: "agent_settled" });
          return { accepted: true };
        }
        const turn = this.db.prepare("SELECT native_turn_id FROM submissions WHERE session_id=? AND native_turn_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(session.id);
        if (!busyStates.has(session.status) || !turn) throw new Error("当前没有可停止的执行；若连接中断请恢复会话。");
        await (await this.codex(session.connection_id)).request("turn/interrupt", { threadId: session.native_id, turnId: turn.native_turn_id });
        if (busyStates.has(this.session(session.id).status)) this.updateSession(session.id, "stopping"); return { accepted: true };
      }
      case "interaction.respond": {
        const item = this.interactions.get(args.id);
        if (!item || item.sessionId !== args.sessionId) throw new Error("这个请求已结束，请查看最新会话。");
        let response;
        if (item.method.startsWith("claude/")) {
          const answers = {};
          if (item.questions.length && args.decision !== "decline") for (const question of item.questions) {
            const answer = args.answers?.[question.id];
            if (Array.isArray(answer)) {
              if (!question.multiSelect || !answer.length || answer.some((v) => typeof v !== "string" || !question.options?.some((o) => o.label === v))) throw new Error("请选择有效的回答。");
              answers[question.question] = answer.join(", ");
            } else answers[question.question] = text(answer, 20_000);
          }
          const connection = this.claudeConnections.get(item.sessionId);
          if (!connection || connection.closed) throw new Error("Claude Code 已断开，请恢复任务。");
          connection.respond(item.nativeId, item.questions.length && args.decision !== "decline" ? "accept" : args.decision, answers);
          return { accepted: true };
        }
        if (item.method.startsWith("pi/")) {
          if (item.expiresAt && item.expiresAt <= Date.now()) { this.interactions.delete(item.id); throw new Error("这个请求已过期。"); }
          if (args.decision === "cancel") response = { cancelled: true };
          else if (item.method === "pi/confirm") {
            if (!["accept", "decline"].includes(args.decision)) throw new Error("请选择确认或取消。");
            response = { confirmed: args.decision === "accept" };
          } else {
            const value = args.answers?.answer;
            if (typeof value !== "string" || value.length > 20_000 || (item.method === "pi/select" && !item.questions[0].options?.some((o) => o.label === value))) throw new Error("请选择有效的回答。");
            response = { value };
          }
          const connection = this.piConnections.get(item.sessionId); if (!connection || connection.closed) throw new Error("Pi 已断开，请恢复会话。");
          await connection.respond(item.nativeId, response); this.interactions.delete(item.id); this.updateSession(item.sessionId, "running"); return { accepted: true };
        }
        if (item.method.endsWith("requestUserInput")) {
          const answers = {};
          for (const question of item.questions) answers[question.id] = { answers: [text(args.answers?.[question.id], 20_000)] };
          response = { answers };
        } else {
          if (!["accept", "decline"].includes(args.decision)) throw new Error("请选择允许一次或拒绝。");
          response = { decision: args.decision };
        }
        (await this.codex(this.session(item.sessionId).connection_id)).respond(item.nativeId, response); this.interactions.delete(item.id);
        this.updateSession(item.sessionId, [...this.interactions.values()].some((i) => i.sessionId === item.sessionId) ? "waiting" : "running"); return { accepted: true };
      }
      case "files.list": {
        const path = await this.pathInProject(args.projectId, args.path || "");
        const entries = await readdir(path, { withFileTypes: true });
        return { path: args.path || "", entries: entries.filter((e) => !e.name.startsWith(".") && !["node_modules", "target"].includes(e.name) && !e.isSymbolicLink()).map((e) => ({ name: e.name, directory: e.isDirectory(), path: [args.path, e.name].filter(Boolean).join("/") })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).slice(0, 500), truncated: entries.length > 500 };
      }
      case "files.read": {
        const path = await this.pathInProject(args.projectId, text(args.path, 4096));
        const file = await open(path, "r");
        try {
          const info = await file.stat(); if (!info.isFile() || info.size > 1_000_000) throw new Error("此文件不支持文本预览，或超过 1 MB。");
          const bytes = await file.readFile(); if (bytes.includes(0)) throw new Error("此文件是二进制文件，暂不支持预览。");
          return { path: args.path, text: bytes.toString("utf8") };
        } finally { await file.close(); }
      }
      default: throw new Error("工作台不支持这个操作。");
    }
  }
  async close() { this.closing = true; clearInterval(this.idleTimer); await this.reaping; await this.projectMembers?.close(); await this.projectCreation?.close(); await this.memberAgentWork?.close(); await this.capture.close(); await this.loopCapture.close(); await this.localLoopTrials.close(); await this.localLoopPublication.close(); await this.nativeLoops.close(); await this.publication?.close(); await this.loops?.close(); await this.methods?.close(); await this.work?.close(); await this.shared?.close(); await Promise.all([this.cloud?.close(), ...[...this.codexConnections.values()].map(c => c.close()), ...[...this.piConnections.values(), ...this.claudeConnections.values()].map((c) => c.close())]); this.store.close(); }
}
