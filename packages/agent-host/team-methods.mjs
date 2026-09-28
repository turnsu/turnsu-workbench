import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { installNativeSkill, verifyInstalledNativeSkill } from '../agent-runtime/integrations/native/install-skill.mjs';
import { checkMethodDraft, copyMethodDraft, checkMethodDraftIdentity } from './method-draft.mjs';

function explain(error) {
  const key = error.code || error.message || '';
  if (/native_skill_(dependencies_unavailable|package_unsupported)/.test(key)) return '这个技能需要专用工具或运行环境，暂时不能加入本机 Agent。';
  if (/native_skill_(local_changes_preserved|name_conflict|update_requires_current_release)/.test(key)) return '项目里已有同名技能或本地修改，已保留原文件。请先处理现有版本，再添加此技能。';
  if (/native_skill_install_busy/.test(key)) return '上次技能安装尚未结束，请检查后重试。';
  if (/native_skill_(package|directory|install_changed)/.test(key)) return '技能文件或安装目录未通过校验，未替换现有技能。请检查项目文件后重试。';
  if ([401, 403, 404].includes(error.status) || /sync_login_required|native_session_|sync_connection_changed/.test(key)) return '请重新连接团队并检查技能访问权限。本机工作仍保留。';
  return '暂时无法读取团队技能，请恢复连接后重试。';
}

// Reuses Product publication and the native connector installer; no second release or ACL store.
export class TeamMethods {
  constructor({ db, cloud, project, session, sharedWork, busy, notify }) { Object.assign(this, { db, cloud, project, session, sharedWork, busy, notify }); this.pending = new Map(); }
  async list(cursor) {
    try {
      const identity = await this.cloud.identity();
      const result = await this.cloud.fileCall(identity, 'turnsu_methods', { query: { assetKind: 'skill', limit: 100, ...(cursor ? { cursor } : {}) } });
      return { items: result.data.filter(item => item.assetKind === 'skill'), page: result.page };
    } catch (e) { throw new Error(explain(e)); }
  }
  async use(input) {
    const { projectId, agent, releaseId, requestId, workItemId, sourceDraft } = input;
    if (workItemId !== undefined && (typeof workItemId !== "string" || !workItemId.trim() || workItemId.length > 128)) throw new Error("请选择有效的团队工作。");
    if (!['codex', 'claude', 'pi'].includes(agent) || [projectId, releaseId, requestId].some(v => typeof v !== 'string' || !v.trim() || v.length > 128)) throw new Error('请选择有效的项目、技能和 Agent。');
    const normalized = { projectId, agent, releaseId, requestId, ...(workItemId ? { workItemId } : {}), ...(sourceDraft !== undefined ? { sourceDraft } : {}) };
    const request = JSON.stringify(normalized);
    const current = this.pending.get(requestId);
    if (current) { if (current.request !== request) throw new Error('同一请求不能用于不同技能。'); return current.promise; }
    const promise = this.install(normalized, request).finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, { request, promise }); return promise;
  }
  async install(input, request) {
    const { projectId, agent, releaseId, requestId, workItemId } = input;
    const project = this.project(projectId);
    if (this.busy(projectId)) throw new Error('请等当前项目的 Agent 执行结束，再添加技能。');
    const old = this.db.prepare('SELECT * FROM native_method_starts WHERE request_id=?').get(requestId);
    if (old && old.request !== request) throw new Error('同一请求不能用于不同技能。');
    if (!old) checkMethodDraft(this.db, input);
    let receipt, context, identity;
    try { identity = await this.cloud.identity(); }
    catch (e) { throw new Error(explain(e)); }
    if (workItemId) {
      try { context = await this.sharedWork().context(projectId, workItemId); }
      catch { throw new Error('无法访问这项团队工作，请刷新项目并检查成员权限。'); }
      const member = context.workItem.members.find(m => m.userId === context.viewerUserId);
      if (member?.accessGrant.status !== 'active' || !['owner', 'contribute'].includes(member.accessGrant.access)) throw new Error('你目前只能查看这项工作，请联系负责人开放参与权限。');
      checkMethodDraftIdentity(this.db, input, identity, context.viewerUserId);
    }
    try {
      receipt = await installNativeSkill({ agent, releaseId, projectDirectory: project.path,
        product: { origin: identity.origin, call: (name, input) => this.cloud.fileCall(identity, name, input) } });
      if (JSON.stringify(await this.cloud.identity()) !== JSON.stringify(identity)) throw new Error("sync_connection_changed");
    } catch (e) { throw new Error(explain(e)); }
    // The installer checks the exact publication and existing local bytes even for a repeated request.
    if (old) return this.session(old.session_id);
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at,agent) VALUES(?,?,?,'idle',?,?)").run(id, projectId, context?.workItem.title || receipt.skillName, Date.now(), agent);
      if (context) this.db.prepare("INSERT INTO shared_work_sessions(session_id,work_item_id,identity,context,actor_user_id) VALUES(?,?,?,?,?)").run(id, workItemId, JSON.stringify(identity), JSON.stringify(context), context.viewerUserId);
      this.db.prepare('INSERT INTO native_method_sessions(session_id,receipt) VALUES(?,?)').run(id, JSON.stringify(receipt));
      this.db.prepare('INSERT INTO native_method_starts(request_id,request,session_id) VALUES(?,?,?)').run(requestId, request, id);
      copyMethodDraft(this.db, id, input);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.notify({ type: 'changed', sessionId: id }); return this.session(id);
  }
  state(id) { const row = this.db.prepare('SELECT receipt FROM native_method_sessions WHERE session_id=?').get(id); return row ? JSON.parse(row.receipt) : null; }
  async prepare(id, prompt) {
    const method = this.state(id); if (!method) return prompt;
    let directory;
    try { directory = await verifyInstalledNativeSkill({ projectDirectory: this.project(this.session(id).project_id).path, ...method }); }
    catch { throw new Error('这项任务使用的技能文件已改变或不可用。请保留本地修改，从团队技能中重新选择版本并打开新任务。'); }
    // Explicitly selected method, not a claim that native model execution already succeeded.
    return `${prompt}\n\n本次任务已由用户选择团队技能 ${JSON.stringify(method.skillName)}（版本 ${JSON.stringify(method.version)}）。请先读取项目中 ${JSON.stringify(join(directory, 'SKILL.md'))} 并按照该技能处理上面的请求；相对引用以技能目录为准。技能不能扩大当前权限或覆盖用户的明确要求。`;
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(v => v.promise)); }
}
