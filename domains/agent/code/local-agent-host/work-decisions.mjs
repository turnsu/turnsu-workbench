import { createHash, randomUUID } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty = () => ({ question: '', chosenOutcome: '', rationale: '' });
const fail = message => { throw new Error(message); };
function fields(value) {
  const result = {};
  for (const [key, max] of [['question', 1000], ['chosenOutcome', 1000], ['rationale', 4000]]) {
    if (typeof value[key] !== 'string' || value[key].length > max) fail('决定内容超过长度限制。');
    result[key] = value[key];
  }
  return result;
}

// Only local drafts and uncertain receipts live here; Product owns the actual immutable Decision.
export class WorkDecisions {
  constructor(work) { this.work = work; this.db = work.db; this.pending = new Map(); }
  row(id) { const row = this.db.prepare('SELECT * FROM work_decision_drafts WHERE id=?').get(id); if (!row) fail('找不到这份决定草稿，请重新打开。'); return row; }
  view(row) { const payload = JSON.parse(row.payload); return { id: row.id, payload, hash: digest(payload), status: row.status, error: row.error, decision: row.receipt ? JSON.parse(row.receipt) : null }; }
  async context(projectId, workItemId) {
    let context, binding;
    try { context = await this.work.context(projectId, workItemId); binding = this.work.projectBinding(projectId); }
    catch { fail('暂时无法读取团队工作，请检查连接和成员权限。本机草稿仍保留。'); }
    const grant = context.workItem.members.find(member => member.userId === context.viewerUserId)?.accessGrant;
    if (context.workItem.accountableOwnerUserId !== context.viewerUserId || grant?.status !== 'active' || grant.access !== 'owner') fail('正式决定需要由这项工作的负责人确认。');
    return { context, binding, identity: JSON.parse(binding.identity) };
  }
  async open({ projectId, workItemId }) {
    const { context, identity } = await this.context(projectId, workItemId);
    let row = this.db.prepare("SELECT * FROM work_decision_drafts WHERE project_id=? AND work_item_id=? AND actor=? AND status<>'done' ORDER BY rowid DESC LIMIT 1").get(projectId, workItemId, context.viewerUserId);
    if (row) {
      const original = JSON.parse(row.identity);
      if (original.origin !== identity.origin || original.workspaceId !== identity.workspaceId) fail('请切回这份决定草稿所属的团队账户。');
      this.db.prepare('UPDATE work_decision_drafts SET identity=? WHERE id=?').run(JSON.stringify(identity), row.id);
    } else {
      const id = randomUUID();
      this.db.prepare("INSERT INTO work_decision_drafts(id,project_id,work_item_id,actor,identity,payload,status) VALUES(?,?,?,?,?,?,'draft')").run(id, projectId, workItemId, context.viewerUserId, JSON.stringify(identity), JSON.stringify(empty()));
      row = this.row(id);
    }
    return this.view(this.row(row.id));
  }
  async status(id) {
    const row = this.row(id), { context, identity } = await this.context(row.project_id, row.work_item_id), original = JSON.parse(row.identity);
    if (context.viewerUserId !== row.actor || original.origin !== identity.origin || original.workspaceId !== identity.workspaceId) fail('请切回创建这份决定草稿的团队账户。');
    return this.view(this.row(id));
  }
  async save({ id, payload }) {
    let row = this.row(id); const value = fields(payload);
    let identity;
    try { identity = await this.work.cloud.identity(); } catch { fail('团队连接暂时不可用，请保留输入内容，恢复连接后重试保存。'); }
    if (JSON.stringify(identity) !== row.identity) fail('团队登录已变化，请重新打开这份决定草稿。');
    row = this.row(id);
    if (row.status === 'pending' || row.status === 'done' || this.pending.has(id)) fail('这次决定已经提交，请先核对结果。');
    if (row.status === 'rejected') {
      const next = randomUUID();
      this.db.prepare("INSERT INTO work_decision_drafts(id,project_id,work_item_id,actor,identity,payload,status) VALUES(?,?,?,?,?,?,'draft')").run(next, row.project_id, row.work_item_id, row.actor, row.identity, JSON.stringify(value));
      return this.view(this.row(next));
    }
    this.db.prepare('UPDATE work_decision_drafts SET payload=?,error=\'\' WHERE id=?').run(JSON.stringify(value), id);
    return this.view(this.row(id));
  }
  submit(args) {
    if (args.confirm !== true) return Promise.reject(new Error('请由负责人确认要记录的决定。'));
    const old = this.pending.get(args.id);
    if (old) return old.hash === args.expectedHash ? old.promise : Promise.reject(new Error('正在提交另一份内容，请等待结果。'));
    const promise = this.execute(args).finally(() => this.pending.delete(args.id));
    this.pending.set(args.id, { hash: args.expectedHash, promise }); return promise;
  }
  async execute({ id, expectedHash }) {
    const row = this.row(id), payload = fields(JSON.parse(row.payload));
    if (digest(payload) !== expectedHash) fail('草稿内容已改变，请检查后重新确认。');
    const { context, identity } = await this.context(row.project_id, row.work_item_id), original = JSON.parse(row.identity);
    if (context.viewerUserId !== row.actor || original.origin !== identity.origin || original.workspaceId !== identity.workspaceId) fail('请切回创建这份决定草稿的团队账户。');
    if (row.status === 'done') return this.view(row);
    if (row.status === 'rejected') fail(row.error);
    if (!payload.question.trim() || !payload.chosenOutcome.trim()) fail('请填写要决定的问题和已确认的结论。');
    const fresh = row.status === 'draft';
    this.db.prepare("UPDATE work_decision_drafts SET status='pending',error='' WHERE id=?").run(id);
    try {
      const result = await this.work.cloud.fileCall(identity, 'turnsu_record_decision', { pathParams: { workItemId: row.work_item_id }, idempotencyKey: 'desktop-decision-' + id,
        data: { question: payload.question, options: [payload.chosenOutcome], chosenOutcome: payload.chosenOutcome, ...(payload.rationale ? { rationale: payload.rationale } : {}) } });
      this.db.prepare("UPDATE work_decision_drafts SET status='done',receipt=?,error='' WHERE id=?").run(JSON.stringify(result.data), id);
      return this.view(this.row(id));
    } catch (error) {
      const rejected = fresh && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      const message = rejected ? '这次决定未被接受，请检查负责人权限和填写内容后重试。' : '尚未确认提交结果。原内容已保留，请重试核对，不要重复新建。';
      this.db.prepare('UPDATE work_decision_drafts SET status=?,error=? WHERE id=?').run(rejected ? 'rejected' : 'pending', message, id);
      fail(message);
    }
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(item => item.promise)); }
}
