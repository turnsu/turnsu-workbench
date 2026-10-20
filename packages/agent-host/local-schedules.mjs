import { randomUUID, createHash } from 'node:crypto';
import { remoteAgents } from './agent-connections.mjs';

const agents = new Set(['codex', 'pi', 'claude', 'opencode', 'kimi', 'omp', ...Object.keys(remoteAgents)]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = new Set(['starting', 'running', 'waiting', 'stopping']);
const fail = message => { throw new Error(message); };
const string = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

export function validateTiming(input) {
  const t = { ...input };
  if (!['once', 'interval', 'daily', 'weekly'].includes(t.kind)) fail('请选择有效的执行频率。');
  if (typeof t.timezone !== 'string') fail('请选择时区。');
  try { new Intl.DateTimeFormat('en', { timeZone: t.timezone }).format(); } catch { fail('时区不可用。'); }
  if (['once', 'interval'].includes(t.kind) && !Number.isSafeInteger(t.startAt)) fail('请选择开始时间。');
  if (t.kind === 'interval' && (!Number.isInteger(t.minutes) || t.minutes < 1 || t.minutes > 525600)) fail('执行间隔应为 1 分钟至 1 年。');
  if (['daily', 'weekly'].includes(t.kind) && (!Number.isInteger(t.hour) || t.hour < 0 || t.hour > 23 || !Number.isInteger(t.minute) || t.minute < 0 || t.minute > 59)) fail('请选择有效的时间。');
  if (t.kind === 'weekly' && (!Number.isInteger(t.weekday) || t.weekday < 0 || t.weekday > 6)) fail('请选择星期。');
  return t;
}

function calendar(t) {
  return new Intl.DateTimeFormat('en-US', { timeZone: t.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
}
function parts(format, at) { return Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value])); }
function localKey(p) { return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }

// Find the next actual instant, not a UTC approximation of a local calendar time.
// Non-existent DST times are skipped; repeated local times share one occurrence key.
export function nextOccurrence(t, after, previousKey = null) {
  if (t.kind === 'once') return t.startAt > after ? { at: t.startAt, key: String(t.startAt) } : null;
  if (t.kind === 'interval') {
    const period = t.minutes * 60_000;
    const at = t.startAt + Math.max(0, Math.floor((after - t.startAt) / period) + 1) * period;
    return { at, key: String(at) };
  }
  const format = calendar(t), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let at = Math.floor(after / 60_000) * 60_000 + 60_000, end = at + 9 * 86400_000; at < end; at += 60_000) {
    const p = parts(format, at), key = localKey(p);
    if (+p.hour === t.hour && +p.minute === t.minute && (t.kind !== 'weekly' || p.weekday === days[t.weekday]) && key !== previousKey) return { at, key };
  }
  fail('无法计算下一次时间，请检查时区与频率。');
}

export function latestOccurrence(t, first, now) {
  if (t.kind === 'once') return first;
  if (t.kind === 'interval') {
    const at = first.at + Math.floor((now - first.at) / (t.minutes * 60_000)) * t.minutes * 60_000;
    return { at, key: String(at) };
  }
  // At most one local week; never enumerate months of missed runs on startup.
  let current = nextOccurrence(t, Math.max(first.at - 1, now - 8 * 86400_000));
  let latest = first;
  while (current && current.at <= now) { latest = current; current = nextOccurrence(t, current.at, current.key); }
  return latest;
}

export class LocalSchedules {
  constructor(host) {
    this.host = host; this.db = host.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_schedules(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,spec TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,next_at INTEGER,next_key TEXT,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS local_schedules_due ON local_schedules(status,next_at);
      CREATE TABLE IF NOT EXISTS local_schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES local_schedules(id),revision INTEGER NOT NULL,occurrence_key TEXT NOT NULL,scheduled_at INTEGER NOT NULL,session_id TEXT REFERENCES sessions(id),status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,UNIQUE(schedule_id,revision,occurrence_key));
      CREATE INDEX IF NOT EXISTS local_schedule_runs_recent ON local_schedule_runs(schedule_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS scheduled_tool_scopes(session_id TEXT PRIMARY KEY,scope TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(local_schedule_runs)').all().some(c => c.name === 'spec')) this.db.exec('ALTER TABLE local_schedule_runs ADD COLUMN spec TEXT');
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), 15_000); this.timer.unref(); this.tick().catch(() => {}); } }
  async close() { clearInterval(this.timer); this.timer = null; this.closed = true; await this.ticking; }
  hasActive() { return !!this.db.prepare("SELECT 1 FROM local_schedules WHERE status='active' LIMIT 1").get(); }
  list({ projectId } = {}) {
    if (projectId) this.host.project(projectId);
    const columns = "id,project_id,name,revision,status,next_at,next_key,updated_at,json_extract(spec,'$.agent') AS agent,json_extract(spec,'$.timing') AS timing";
    const rows = projectId ? this.db.prepare(`SELECT ${columns} FROM local_schedules WHERE project_id=? ORDER BY updated_at DESC LIMIT 100`).all(projectId) : this.db.prepare(`SELECT ${columns} FROM local_schedules ORDER BY updated_at DESC LIMIT 100`).all();
    // Pinned prompts and scopes remain in SQLite until an individual edit/approval is opened.
    return { items: rows.map(row => ({ ...row, timing: JSON.parse(row.timing), runs: this.db.prepare('SELECT id,revision,scheduled_at,session_id,status,substr(error,1,2000) AS error FROM local_schedule_runs WHERE schedule_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10').all(row.id) })), backgroundRequired: this.hasActive() };
  }
  read({ id }) {
    const row = this.db.prepare('SELECT * FROM local_schedules WHERE id=?').get(id);
    if (!row) fail('计划不可用。');
    return { ...row, spec: JSON.parse(row.spec) };
  }
  async save(input) {
    this.host.project(input.projectId);
    if (this.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(input.projectId)) fail('定时任务目前只在私有本地项目中运行。');
    if (!string(input.name, 80) || !string(input.prompt, 80_000) || !agents.has(input.agent)) fail('请填写名称、任务和可用的本机 Agent。');
    if (input.acknowledge !== true) fail('请确认后台运行与所选原生 Agent 的权限范围。');
    if (!['skip', 'latest'].includes(input.misfire)) fail('请选择错过时的处理方式。');
    if (input.references && (!Array.isArray(input.references) || input.references.length > 10 || input.references.some(p => typeof p !== 'string'))) fail('定时引用仅支持选定的项目文字文件。二进制文件请通过已授权文件工具处理。');
    for (const path of input.references || []) await this.host.references.local(input.projectId, path);
    if (remoteAgents[input.agent]) {
      if (input.externalConsent !== true) fail('请确认按此计划向固定 Agent 外发提示词与所选材料。');
      if (input.agent === 'manus') { if (!this.host.remote.connections.get(input.agentConnectionId).accountId) fail('请先检查 Manus 账号。'); }
      else this.host.remote.managed.assertConnection(input.agentConnectionId, input.agent);
      await this.host.remote.files(input.projectId, input.materials || []);
      if (!remoteAgents[input.agent].files && input.materials?.length) fail('此 Agent 接口不支持文件材料。');
    } else {
      this.host.modelConnections.get(input.connectionId || null, input.agent);
      if (input.connectionId && !string(input.model, 200)) fail('请先选择此网关连接的模型，再保存定时任务。');
    }
    const timing = validateTiming(input.timing), now = this.host.clock();
    const previous = input.id ? this.db.prepare('SELECT * FROM local_schedules WHERE id=?').get(input.id) : null;
    if (!previous && this.db.prepare('SELECT count(*) AS n FROM local_schedules').get().n >= 100) fail('本机最多保留 100 个计划。');
    if (input.id && (!previous || previous.project_id !== input.projectId)) fail('定时任务不存在。');
    if (previous && input.revision !== previous.revision) fail('计划已修改，请重新读取。');
    const skill = input.skill ? await this.host.projectSkills.read({ projectId: input.projectId, agent: input.agent, ...input.skill }) : null;
    if (timing.kind === 'once' && timing.startAt <= now) fail('一次任务的时间必须在未来。');
    const next = nextOccurrence(timing, now), id = previous?.id || randomUUID();
    const spec = { prompt: input.prompt, agent: input.agent, model: input.model || null, connectionId: input.connectionId || null, agentConnectionId: input.agentConnectionId || null, materials: input.materials || [], externalExpires: remoteAgents[input.agent] ? now + 30 * 86400_000 : null, references: input.references || [], timing, misfire: input.misfire, skill: skill ? { path: skill.path, expectedHash: skill.hash } : null, permissions: this.permissions(input.projectId) };
    this.db.prepare(`INSERT INTO local_schedules VALUES(?,?,?,?,1,'active',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,spec=excluded.spec,revision=local_schedules.revision+1,status='active',next_at=excluded.next_at,next_key=excluded.next_key,updated_at=excluded.updated_at`).run(id, input.projectId, input.name.trim(), JSON.stringify(spec), next?.at || null, next?.key || null, now);
    this.host.changed(); return { id };
  }
  permissions(projectId) {
    const grant = this.host.capabilities.list(projectId).grant;
    const computer = this.host.computer?.active;
    return { documents: grant?.active ? { config: grant.config, expiresAt: grant.expires_at } : null, computer: computer?.projectId === projectId && computer.expiresAt > this.host.clock() ? { id: computer.id, manifest: computer.manifest, expiresAt: computer.expiresAt } : null };
  }
  assertTool(sessionId, kind) {
    if (!sessionId) return;
    const row = this.db.prepare('SELECT scope FROM scheduled_tool_scopes WHERE session_id=?').get(sessionId); if (!row) return;
    const saved = JSON.parse(row.scope), current = this.permissions(this.host.session(sessionId).project_id);
    if (!saved[kind] || digest(saved[kind]) !== digest(current[kind])) fail('定时任务的工具范围未授权或已变化，请核对计划并重新批准；原生 Agent 自带工具仍由其原生权限控制。');
  }
  review({ runId }) {
    const run = this.db.prepare("SELECT * FROM local_schedule_runs WHERE id=? AND status='waiting' AND error IS NOT NULL").get(runId);
    if (!run) fail('此执行不再等待核对。');
    const row = this.db.prepare('SELECT * FROM local_schedules WHERE id=?').get(run.schedule_id), spec = JSON.parse(run.spec);
    const result = {runId,projectId:row.project_id,name:row.name,agent:spec.agent,agentConnectionId:spec.agentConnectionId,model:spec.model,connectionId:spec.connectionId,prompt:spec.prompt,skill:spec.skill,references:spec.references,materials:spec.materials,previousPermissions:spec.permissions,currentPermissions:this.permissions(row.project_id),external: Boolean(remoteAgents[spec.agent])};
    return {...result,reviewHash:digest(result)};
  }
  async approve({ runId, acknowledged, reviewHash }) {
    const run = this.db.prepare("SELECT * FROM local_schedule_runs WHERE id=? AND status='waiting' AND error IS NOT NULL").get(runId);
    if (!run || acknowledged !== true || this.host.operations.has(run.session_id)) fail('请先核对计划当前的 Agent、材料及工具范围。');
    const reviewed = this.review({runId}); if (!reviewHash || reviewed.reviewHash !== reviewHash) fail('任务或权限已变化，请重新核对后批准。');
    const row = this.db.prepare('SELECT * FROM local_schedules WHERE id=?').get(run.schedule_id);
    const spec = JSON.parse(run.spec);
    spec.permissions = this.permissions(row.project_id); if (remoteAgents[spec.agent]) spec.externalExpires = this.host.clock() + 30 * 86400_000;
    this.db.prepare('UPDATE local_schedule_runs SET spec=?,error=NULL,status=\'starting\' WHERE id=?').run(JSON.stringify(spec),runId);
    this.db.prepare('INSERT INTO scheduled_tool_scopes VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET scope=excluded.scope').run(run.session_id,JSON.stringify(spec.permissions));
    this.host.updateSession(run.session_id,'idle'); await this.execute(row,run.session_id,run.id,spec); return this.host.readSession(run.session_id);
  }
  pause({ id, paused }) {
    const row = this.db.prepare('SELECT * FROM local_schedules WHERE id=?').get(id);
    if (!row || typeof paused !== 'boolean') fail('计划不可用。');
    const next = paused ? null : nextOccurrence(JSON.parse(row.spec).timing, this.host.clock());
    this.db.prepare('UPDATE local_schedules SET status=?,next_at=?,next_key=?,updated_at=? WHERE id=?').run(paused ? 'paused' : next ? 'active' : 'finished', next?.at || null, next?.key || null, this.host.clock(), id);
    this.host.changed(); return { saved: true };
  }
  resolve({ runId, acknowledged }) {
    const run = this.db.prepare('SELECT * FROM local_schedule_runs WHERE id=?').get(runId);
    if (!run || run.status !== 'uncertain' || acknowledged !== true) fail('请先核对不确定执行的会话和成果。');
    if (run.session_id && active.has(this.host.session(run.session_id).status)) fail('执行尚未结束。');
    this.db.prepare("UPDATE local_schedule_runs SET status='reviewed' WHERE id=?").run(runId);
    this.host.changed(); return { saved: true };
  }
  reconcile() {
    for (const run of this.db.prepare("SELECT * FROM local_schedule_runs WHERE status IN ('starting','running','waiting') LIMIT 100").all()) {
      if (run.status === 'waiting' && run.error) continue;
      const s = run.session_id ? this.host.session(run.session_id) : null;
      const submission = s ? this.db.prepare('SELECT status FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(s.id) : null;
      const status = !submission ? 'uncertain' : s.status === 'idle' && submission.status === 'completed' ? 'completed' : s.status === 'interrupted' ? 'uncertain' : s.status === 'failed' ? 'failed' : s.status === 'waiting' ? 'waiting' : 'running';
      if (status !== run.status) { this.db.prepare('UPDATE local_schedule_runs SET status=?,error=? WHERE id=?').run(status, s?.error || (status === 'uncertain' ? '先检查已有会话和成果，不自动重跑。' : null), run.id); this.host.notify({ type: 'schedule-changed', id: run.schedule_id, status, sessionId: run.session_id }); }
    }
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.performTick().finally(() => { this.ticking = null; }); return this.ticking;
  }
  async performTick() {
    this.reconcile();
    const now = this.host.clock();
    const rows = this.db.prepare("SELECT * FROM local_schedules WHERE status='active' AND next_at<=? ORDER BY next_at LIMIT 50").all(now);
    for (const row of rows) {
      if (this.closed) return;
      const spec = JSON.parse(row.spec), first = { at: row.next_at, key: row.next_key }, latest = latestOccurrence(spec.timing, first, now);
      const next = nextOccurrence(spec.timing, now, latest.key);
      const missed = now - latest.at >= 60_000;
      await this.dispatch(row, latest, spec.misfire === 'skip' && missed ? 'skipped' : null, { next });
    }
  }
  async runNow({ id, requestId }) {
    if (!string(requestId, 128)) fail('缺少执行请求标识。');
    const row = this.db.prepare('SELECT * FROM local_schedules WHERE id=?').get(id);
    if (!row) fail('计划不可用。');
    this.reconcile();
    return this.dispatch(row, { at: this.host.clock(), key: `manual:${requestId}` });
  }
  async dispatch(row, occurrence, skipped = null, advance = null) {
    const prior = this.db.prepare('SELECT * FROM local_schedule_runs WHERE schedule_id=? AND revision=? AND occurrence_key=?').get(row.id, row.revision, occurrence.key);
    if (prior) return prior;
    const spec = JSON.parse(row.spec), now = this.host.clock(), runId = randomUUID();
    const unfinished = this.db.prepare("SELECT 1 FROM local_schedule_runs WHERE schedule_id=? AND status IN ('starting','running','waiting','uncertain') LIMIT 1").get(row.id);
    const projectBusy = this.db.prepare('SELECT status FROM sessions WHERE project_id=?').all(row.project_id).some(s => active.has(s.status));
    const skip = skipped || (unfinished || projectBusy ? 'skipped_busy' : null);
    const sessionId = skip ? null : randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (advance) this.db.prepare('UPDATE local_schedules SET next_at=?,next_key=?,status=? WHERE id=? AND revision=?').run(advance.next?.at || null, advance.next?.key || null, advance.next ? 'active' : 'finished', row.id, row.revision);
      if (sessionId) {
        this.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at,agent,connection_id,model,agent_connection_id) VALUES(?,?,?,'idle',?,?,?,?,?)").run(sessionId, row.project_id, `定时 · ${row.name}`, now, spec.agent, spec.connectionId, spec.model || null, spec.agentConnectionId || null);
        this.db.prepare('INSERT INTO scheduled_tool_scopes VALUES(?,?)').run(sessionId,JSON.stringify(spec.permissions || { documents:null,computer:null }));
        if (remoteAgents[spec.agent]) this.db.prepare("INSERT INTO remote_tasks(session_id,connection_id,state) VALUES(?,?,'ready')").run(sessionId,spec.agentConnectionId);
      }
      this.db.prepare('INSERT INTO local_schedule_runs(id,schedule_id,revision,occurrence_key,scheduled_at,session_id,status,error,created_at,spec) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId, row.id, row.revision, occurrence.key, occurrence.at, sessionId, skip || 'starting', null, now, row.spec);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    if (!skip && (digest(spec.permissions || {documents:null,computer:null}) !== digest(this.permissions(row.project_id)) || (remoteAgents[spec.agent] && spec.externalExpires <= this.host.clock()))) {
      const message='计划的授权范围已变化或过期。请核对当前能力与权限，再批准这次执行。';
      this.db.prepare("UPDATE local_schedule_runs SET status='waiting',error=? WHERE id=?").run(message,runId); this.host.updateSession(sessionId,'waiting',message);
    } else if (!skip) await this.execute(row,sessionId,runId,spec);
    this.host.notify({ type: 'schedule-changed', id: row.id, status: skip || this.db.prepare('SELECT status FROM local_schedule_runs WHERE id=?').get(runId).status, sessionId }); this.host.changed(sessionId);
    return this.db.prepare('SELECT * FROM local_schedule_runs WHERE id=?').get(runId);
  }
  async execute(row,sessionId,runId,spec) {
      try {
        if (spec.skill) {
          await this.host.projectSkills.read({ projectId: row.project_id, agent: spec.agent, ...spec.skill });
          this.db.prepare('INSERT INTO native_method_starts VALUES(?,?,?)').run(runId, JSON.stringify({ kind: 'project-skill', projectId: row.project_id, agent: spec.agent, ...spec.skill }), sessionId);
        }
        await this.host.command('session.send', { sessionId, inputId: runId, text: spec.prompt, references: spec.references, materials: spec.materials, allowExternal: Boolean(remoteAgents[spec.agent]) });
      } catch (error) {
        const submitted = this.db.prepare('SELECT status FROM submissions WHERE id=?').get(runId);
        this.db.prepare('UPDATE local_schedule_runs SET status=?,error=? WHERE id=?').run(submitted && !['failed', 'completed'].includes(submitted.status) ? 'uncertain' : 'failed', error.message, runId);
      }
    this.host.changed(sessionId);
  }
}
