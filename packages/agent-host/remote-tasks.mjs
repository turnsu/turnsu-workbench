import { readBoundedFile } from './bounded-file.mjs';
import { ManagedConnections } from './managed-connections.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { AgentConnections, remoteAgents } from './agent-connections.mjs';
import { Manus } from './manus.mjs';
import { downloadArtifact } from './artifact-download.mjs';

const fail = message => { throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
export class RemoteTasks {
  constructor(host, { manusFactory = profile => new Manus(profile), download = downloadArtifact } = {}) {
    this.host = host; this.db = host.db; this.connections = new AgentConnections(); this.manusFactory = manusFactory; this.download = download; this.polling = new Map(); this.watching = new Map(); this.downloads = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_tasks(session_id TEXT PRIMARY KEY REFERENCES sessions(id),connection_id TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '{}',state TEXT NOT NULL,waiting TEXT,url TEXT,deadline INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS remote_materials(input_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),files TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_artifacts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),metadata TEXT NOT NULL,path TEXT);
      CREATE TABLE IF NOT EXISTS remote_actions(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),operation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT);
      UPDATE remote_actions SET status='uncertain' WHERE status='sending';`);
    this.managed = new ManagedConnections(host);
    if (!this.db.prepare('PRAGMA table_info(remote_tasks)').all().some(c => c.name === 'provider_native_id')) this.db.exec('ALTER TABLE remote_tasks ADD COLUMN provider_native_id TEXT');
    if (!this.db.prepare('PRAGMA table_info(remote_tasks)').all().some(c => c.name === 'local_requests')) this.db.exec("ALTER TABLE remote_tasks ADD COLUMN local_requests TEXT NOT NULL DEFAULT '[]'");
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'agent_connection_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN agent_connection_id TEXT');
    this.timer = setInterval(() => { for (const [id, at] of this.watching) if (at <= this.host.clock()) this.poll(id).catch(e => { if (!this.closed) { this.watching.delete(id); this.host.updateSession(id, 'interrupted', e.message); } }); }, 5000); this.timer.unref();
  }
  configure(profiles) {
    const next = new AgentConnections(); next.configure(profiles);
    for (const row of this.db.prepare('SELECT id,agent_connection_id,status FROM sessions WHERE agent_connection_id IS NOT NULL').all()) {
      const old = this.connections.profiles.get(row.agent_connection_id), value = next.profiles.get(row.agent_connection_id);
      if (old && !value) fail('已有会话使用该 Agent 连接，请保留账号以便恢复。');
      if (old?.accountId && value?.accountId !== old.accountId) fail('连接已绑定另一个账号，请新建连接。');
      if (old && JSON.stringify(old) !== JSON.stringify(value) && !value?.revoked && ['starting','running','waiting','stopping'].includes(row.status)) fail('请先停止使用该连接的任务，再更新密钥。');
    }
    this.connections = next;
    for (const profile of next.list().filter(p => p.revoked)) for (const row of this.db.prepare("SELECT id FROM sessions WHERE agent_connection_id=? AND status IN ('starting','running','waiting','stopping')").all(profile.id)) { this.watching.delete(row.id); this.host.updateSession(row.id, 'interrupted', '此账号凭据已从工作台撤销。远端已发出的任务可能继续，请在原生服务核对。'); }
    this.host.changed(); return { configured: true };
  }
  async verifyProfile(profile) { const checked = await this.manusFactory(profile).check(); return { ...profile, accountId: checked.identity }; }
  agents() { return Object.values(remoteAgents).map(agent => ({ ...agent, installed: agent.id === 'manus' ? this.connections.list().some(p => p.accountId && !p.revoked) : Boolean(this.managed?.available(agent.id)), availabilityLabel: '未连接' })); }
  async check(id) { return this.manusFactory(this.connections.get(id)).check(); }
  adapter(session) {
    if (session.agent === 'manus') return this.manusFactory(this.connections.get(session.agent_connection_id));
    if (!this.managed) fail('请先连接 Turnsu 托管接入服务。');
    return this.managed.adapter(session);
  }
  create({ projectId, agent, agentConnectionId }) {
    this.host.project(projectId);
    if (!remoteAgents[agent]) fail('未知远端 Agent。');
    if (this.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(projectId)) fail('先在私有项目中明确授权材料外发，再使用外部 Agent。');
    if (agent === 'manus') { const profile = this.connections.get(agentConnectionId); if (!profile.accountId) fail('请先完成 Manus 账号连接检查。'); }
    else this.managed?.assertConnection(agentConnectionId, agent) || fail('请先连接此 Agent。');
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at,agent,agent_connection_id) VALUES(?,?,?,'idle',?,?,?)").run(id, projectId, '新任务', this.host.clock(), agent, agentConnectionId);
      this.db.prepare("INSERT INTO remote_tasks(session_id,connection_id,state) VALUES(?,?,'ready')").run(id, agentConnectionId); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.host.changed(id); return this.host.readSession(id);
  }
  state(id) {
    const row = this.db.prepare('SELECT * FROM remote_tasks WHERE session_id=?').get(id);
    if (!row) return null;
    return { ...row, localRequests: JSON.parse(row.local_requests || '[]'), cursor: undefined, waiting: row.waiting ? JSON.parse(row.waiting) : null, capabilities: remoteAgents[this.host.session(id).agent], artifacts: this.db.prepare('SELECT * FROM remote_artifacts WHERE session_id=? ORDER BY rowid DESC LIMIT 50').all(id).map(a => ({ ...a, metadata: JSON.parse(a.metadata) })) };
  }
  async files(projectId, paths = []) {
    if (!Array.isArray(paths) || paths.length > 10 || paths.some(p => typeof p !== 'string' || p.length > 300)) fail('每次最多选择 10 份项目材料。');
    const files = []; let total = 0;
    for (const path of paths) {
      const suffix = extname(path).toLowerCase(); if (!mime[suffix]) fail('外发材料支持 Excel、Word、PDF、文字与常见图片。');
      const source = await this.host.pathInProject(projectId, path);
      const data = await readBoundedFile(source, 20 * 1024 * 1024);
      await this.host.pathInProject(projectId, path);
      if ((total += data.length) > 32 * 1024 * 1024) fail('单次材料总量不能超过 32 MB。');
      files.push({ path, filename: basename(path), mime: mime[suffix], sha256: hash(data), bytes: data.length, data });
    }
    return files;
  }
  async prepare(session, inputId, paths, acknowledged) {
    if (acknowledged !== true) fail('请确认将本次提示词和选定材料发送给所选 Agent 服务。');
    this.adapter(session); // Fail before admitting an input if account or connector is unavailable.
    const previous = this.db.prepare('SELECT * FROM remote_materials WHERE input_id=?').get(inputId);
    if (previous) {
      const files = JSON.parse(previous.files);
      if (previous.session_id !== session.id || JSON.stringify(files.map(f => f.path)) !== JSON.stringify(paths || [])) fail('同一请求不能改变已选材料。');
      return files;
    }
    const files = await this.files(session.project_id, paths || []);
    if (!remoteAgents[session.agent].files && files.length) fail('此 Agent 接口不支持文件附件，请使用明确选定的文字引用。');
    const directory = join(this.host.directory, 'remote-materials', hash(inputId)); await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = [];
    try {
      for (let index = 0; index < files.length; index++) { const { data, ...file } = files[index]; const staged = join(directory, `${index}.bin`); await writeFile(staged, data, { mode: 0o600, flag: 'wx' }); metadata.push({ ...file, staged }); }
      this.db.prepare('INSERT INTO remote_materials VALUES(?,?,?)').run(inputId, session.id, JSON.stringify(metadata));
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return metadata;
  }
  fence(session) {
    const original = session.agent === 'manus' ? JSON.stringify(this.connections.get(session.agent_connection_id)) : null;
    return () => { if (this.closed) fail('工作台已关闭，远端结果尚未确认。'); this.adapter(session); if (session.agent === 'manus' && JSON.stringify(this.connections.get(session.agent_connection_id)) !== original) fail('此账号凭据已变化，请先核对原生任务。'); };
  }
  async send(session, inputId, prompt) {
    const current = this.fence(session), adapter = this.adapter(session), saved = this.db.prepare('SELECT files FROM remote_materials WHERE input_id=?').get(inputId);
    const files = saved ? JSON.parse(saved.files) : [], parts = [];
    for (const file of files) { const bytes = await readBoundedFile(file.staged, 20 * 1024 * 1024); if (hash(bytes) !== file.sha256) fail('选定材料快照已变化，已停止发送。'); parts.push({ type: 'file', filename: file.filename, file_data: `data:${file.mime};base64,${bytes.toString('base64')}`, visibility: 'visible' }); }
    const receipt = await adapter.send(session.native_id, prompt, parts, inputId);
    this.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run(receipt.taskId, session.id);
    current();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run(receipt.taskId, session.id);
      this.db.prepare("UPDATE remote_tasks SET state=?,waiting=NULL,url=COALESCE(?,url),deadline=? WHERE session_id=?").run(receipt.state || 'running', receipt.url || null, this.host.clock() + 6 * 3600_000, session.id);
      this.db.prepare("UPDATE submissions SET status='accepted',native_turn_id=? WHERE id=?").run(receipt.taskId, inputId); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.host.updateSession(session.id, ['waiting','waiting_external'].includes(receipt.state) ? 'waiting' : receipt.state === 'uncertain' ? 'interrupted' : 'running'); this.watching.set(session.id, this.host.clock());
  }
  poll(id) {
    if (this.polling.has(id)) return this.polling.get(id);
    const pending = this.performPoll(id).finally(() => this.polling.delete(id)); this.polling.set(id, pending); return pending;
  }
  async performPoll(id) {
    const session = this.host.session(id), row = this.db.prepare('SELECT * FROM remote_tasks WHERE session_id=?').get(id);
    if (!row || !session.native_id) fail('原生任务 ID 尚未确认。请在服务端检查已有任务，再绑定恢复；不要直接重发。');
    const current = this.fence(session), result = await this.adapter(session).poll(session.native_id, JSON.parse(row.cursor));
    if (this.closed) return;
    current();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of result.events) {
        if (typeof event.id !== 'string') fail('外部事件缺少标识，保留原游标。');
        const content = event.assistant_message || event.error_message;
        if (event.removedArtifact) this.db.prepare("DELETE FROM remote_artifacts WHERE session_id=? AND path IS NULL AND json_extract(metadata,'$.managed_uri')=?").run(id,event.removedArtifact);
        if (typeof content?.content === 'string') this.host.message(id, `${id}:remote:${event.id}`, event.error_message ? 'notice' : 'assistant', content.content);
        for (const attachment of content?.attachments || []) {
          if ((typeof attachment.url !== 'string' && typeof attachment.managed_uri !== 'string') || typeof attachment.filename !== 'string') continue;
          const key = hash(`${id}:${event.id}:${attachment.file_uid || attachment.url}`);
          this.db.prepare('INSERT OR IGNORE INTO remote_artifacts VALUES(?,?,?,NULL)').run(key, id, JSON.stringify(attachment));
        }
      }
      if (result.nativeTaskId) this.db.prepare('UPDATE remote_tasks SET provider_native_id=? WHERE session_id=?').run(result.nativeTaskId, id);
      this.db.prepare('UPDATE remote_tasks SET local_requests=? WHERE session_id=?').run(JSON.stringify(result.localRequests || []), id);
      this.db.prepare('UPDATE remote_tasks SET cursor=?,state=?,waiting=?,url=COALESCE(?,url) WHERE session_id=?').run(JSON.stringify(result.cursor), result.state, ['waiting','uncertain'].includes(result.state) ? JSON.stringify(result.waiting || (row.waiting ? JSON.parse(row.waiting) : null)) : null, result.url || null, id);
      if (['completed', 'failed'].includes(result.state)) this.db.prepare("UPDATE submissions SET status=? WHERE session_id=? AND status='accepted'").run(result.state, id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    const deadline = row.deadline || this.host.clock() + 6 * 3600_000;
    if (this.db.prepare("SELECT 1 FROM submissions WHERE session_id=? AND status='unknown'").get(id)) { this.watching.delete(id); this.host.updateSession(id, 'interrupted', '存在未确认提交，请核对原生任务后明确处理；不会自动重发。'); }
    else if (result.state === 'completed') { this.watching.delete(id); this.host.updateSession(id, 'idle'); }
    else if (['uncertain','revoked','stopped'].includes(result.state)) { this.watching.delete(id); this.host.updateSession(id, 'interrupted', result.waiting?.waiting_description || '远端交接已停止或状态未确认，请先核对原生结果。'); }
    else if (result.state === 'failed') { this.watching.delete(id); this.host.updateSession(id, 'failed', '远端任务失败，请查看最后的原生进展。'); }
    else if (this.host.clock() >= deadline) { this.watching.delete(id); this.host.updateSession(id, 'interrupted', '远端任务尚未确认结束，已停止后台查询。可以恢复查询，不会重新发送任务。'); }
    else { this.watching.set(id, this.host.clock() + (['waiting','waiting_external'].includes(result.state) ? 30_000 : 5000)); this.host.updateSession(id, ['waiting','waiting_external'].includes(result.state) ? 'waiting' : 'running', result.backgroundUnknown ? '主 Agent 已停止，后台工作状态尚未确认。' : null); }
    return this.host.readSession(id);
  }
  async resume(id) { this.db.prepare('UPDATE remote_tasks SET deadline=? WHERE session_id=?').run(this.host.clock() + 6 * 3600_000, id); return this.poll(id); }
  async recover({ sessionId, nativeId, inputId, outcome, acknowledged }) {
    const session = this.host.session(sessionId);
    const submission = this.db.prepare("SELECT * FROM submissions WHERE id=? AND session_id=? AND status='unknown'").get(inputId, sessionId);
    if (acknowledged !== true || !submission || !['received', 'not_received'].includes(outcome)) fail('请先核对原生任务中的本次输入，再处理不确定提交。');
    if (outcome === 'not_received') {
      this.db.prepare("UPDATE submissions SET status='failed' WHERE id=?").run(inputId); this.host.updateSession(sessionId, 'idle'); return this.host.readSession(sessionId);
    }
    if (!session.native_id) {
      if (typeof nativeId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(nativeId)) fail('请填写已核对的原生任务 ID。');
      await this.adapter(session).poll(nativeId, {}); // Prove this account can read it before pinning the identity.
      this.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run(nativeId, sessionId);
    } else if (nativeId && nativeId !== session.native_id) fail('不能把已有会话改绑到其他任务。');
    this.db.prepare("UPDATE submissions SET status='accepted' WHERE id=?").run(inputId); return this.resume(sessionId);
  }
  async review(id) { const session = this.host.session(id); const adapter = this.adapter(session); if (!adapter.review) fail('请在 Agent 原生界面处理批准。'); return adapter.review(session.native_id); }
  artifact({ sessionId, artifactId }) {
    const key = `${sessionId}:${artifactId}`;
    if (this.downloads.has(key)) return this.downloads.get(key);
    if (this.downloads.size >= 2) fail('已有成果正在同步，请稍后再下载。');
    const pending = this.saveArtifact(sessionId, artifactId).finally(() => this.downloads.delete(key)); this.downloads.set(key, pending); return pending;
  }
  async saveArtifact(sessionId, artifactId) {
    const session = this.host.session(sessionId), row = this.db.prepare('SELECT * FROM remote_artifacts WHERE id=? AND session_id=?').get(artifactId, sessionId);
    if (!row) fail('成果不属于此任务。');
    if (row.path) { await this.host.pathInProject(session.project_id, row.path); return { path: row.path, existing: true }; }
    const attachment = JSON.parse(row.metadata), extension = extname(attachment.filename).toLowerCase();
    if (!mime[extension]) fail('此文件类型请在原生 Agent 中检查后下载。');
    const current = this.fence(session);
    const bytes = attachment.managed_uri && !attachment.url ? await this.adapter(session).download(session.native_id, attachment) : await this.download(attachment.url);
    current();
    if (['.xlsx','.docx'].includes(extension) && !bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]))) fail('成果文件格式与名称不一致，未写入项目。');
    if (extension === '.pdf' && bytes.subarray(0,5).toString() !== '%PDF-') fail('成果不是有效的 PDF，未写入项目。');
    const root = await this.host.pathInProject(session.project_id, '.');
    const directory = `Outputs/Agent-${randomUUID()}`;
    await mkdir(join(root, 'Outputs'), { recursive: true });
    await this.host.pathInProject(session.project_id, 'Outputs');
    await mkdir(join(root, directory));
    const name = basename(attachment.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(-150) || `result${extension}`;
    const path = `${directory}/${name}`; await writeFile(join(root, path), bytes, { flag: 'wx', mode: 0o600 });
    this.db.prepare('UPDATE remote_artifacts SET path=?,metadata=? WHERE id=?').run(path, JSON.stringify({ ...attachment, sha256: hash(bytes), bytes: bytes.length }), artifactId);
    this.host.changed(sessionId); this.host.notify({ type: 'capability-changed', projectId: session.project_id });
    return { path, sha256: hash(bytes), bytes: bytes.length };
  }
  async action({ sessionId, requestId, operation, input }) {
    const session = this.host.session(sessionId), payload = JSON.stringify({ operation, input: input ?? null });
    if (typeof requestId !== 'string' || requestId.length > 128 || !session.native_id || !['stop','approve'].includes(operation)) fail('外部任务操作无效。');
    const previous = this.db.prepare('SELECT * FROM remote_actions WHERE request_id=?').get(requestId);
    if (previous) { if (previous.session_id !== sessionId || previous.payload !== payload) fail('请求标识已用于其他操作。'); if (previous.status !== 'completed') fail('这次操作尚未确认，请先刷新原生任务状态。'); return JSON.parse(previous.result); }
    if (operation === 'stop' && remoteAgents[session.agent].stop === false) fail('此 Agent 没有公开停止接口，请在原生应用中停止。');
    const adapter = this.adapter(session), waiting = this.state(sessionId).waiting;
    this.db.prepare("INSERT INTO remote_actions VALUES(?,?,?,?,'sending',NULL)").run(requestId, sessionId, operation, payload);
    try {
      const result = operation === 'stop' ? await adapter.stop(session.native_id) : await adapter.approve(session.native_id, waiting, input);
      this.db.prepare("UPDATE remote_actions SET status='completed',result=? WHERE request_id=?").run(JSON.stringify(result), requestId);
      await this.poll(sessionId); return result;
    } catch (e) { this.db.prepare("UPDATE remote_actions SET status=? WHERE request_id=? AND status='sending'").run(e.rejected ? 'failed' : 'uncertain', requestId); throw e; }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.watching.clear(); await Promise.allSettled([...this.polling.values(), ...this.downloads.values()]); }
}
