import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };

// Local review drafts and delivery receipts only. Product owns assignment and access.
// No recipient session is created and no Agent is started by assigning this work.
export class WorkHandoffs {
  constructor(work) { this.work = work; this.db = work.db; this.pending = new Map(); }
  row(id) { const row = this.db.prepare('SELECT * FROM work_handoff_drafts WHERE id=?').get(id); if (!row) fail('找不到这份交接草稿，请重新打开。'); return row; }
  view(row) { const payload = JSON.parse(row.payload); return { id: row.id, payload, hash: hash(payload), status: row.status, error: row.error, workItem: row.receipt ? JSON.parse(row.receipt) : null }; }
  async context(projectId, workItemId, owner = true) {
    let context, binding;
    try { context = await this.work.context(projectId, workItemId); binding = this.work.projectBinding(projectId); }
    catch { fail('暂时无法读取团队工作，请检查连接和成员权限。交接草稿仍保留。'); }
    if (owner) {
      const grant = context.workItem.members.find(m => m.userId === context.viewerUserId)?.accessGrant;
      if (context.workItem.accountableOwnerUserId !== context.viewerUserId || grant?.status !== 'active' || grant.access !== 'owner') fail('请由这项工作的负责人安排交接。');
      if (['completed', 'cancelled'].includes(context.workItem.status)) fail('这项工作已结束，请先在团队工作中重新开启。');
      if (!context.etag) fail('未能确认工作的最新版本，请刷新后重试。');
    }
    return { context, identity: JSON.parse(binding.identity) };
  }
  async names(context, identity) {
    let result;
    try { result = await this.work.cloud.fileCall(identity, 'turnsu_work_people', {}); }
    catch { fail('暂时无法读取成员名单，请恢复团队连接后重试。'); }
    return context.workItem.members.filter(m => m.accessGrant.status === 'active').flatMap(member => {
      const person = result.data.find(p => p.userId === member.userId);
      return person ? [{ userId: member.userId, displayName: person.displayName, username: person.username, access: member.accessGrant.access, roles: member.roles }] : [];
    });
  }
  async members({ projectId, workItemId }) {
    const { context, identity } = await this.context(projectId, workItemId, false);
    return this.names(context, identity);
  }
  sameActor(row, context, identity) {
    const original = JSON.parse(row.identity);
    if (row.actor !== context.viewerUserId || original.origin !== identity.origin || original.workspaceId !== identity.workspaceId) fail('请切回创建这份交接的团队账户。');
  }
  async open({ projectId, workItemId }) {
    const { context, identity } = await this.context(projectId, workItemId);
    const people = (await this.names(context, identity)).filter(m => m.userId !== context.viewerUserId && m.access === 'contribute');
    let row = this.db.prepare("SELECT * FROM work_handoff_drafts WHERE project_id=? AND work_item_id=? AND actor=? AND status<>'done' ORDER BY rowid DESC LIMIT 1").get(projectId, workItemId, context.viewerUserId);
    if (row) this.sameActor(row, context, identity);
    // A rejected/stale draft is explicitly reopened against the newly displayed version.
    if (!row || row.status === 'rejected' || (row.status === 'draft' && row.etag !== context.etag)) {
      const id = randomUUID(), payload = row ? JSON.parse(row.payload) : { recipientId: '', recipientName: '', nextAction: context.workItem.nextAction || '' };
      this.db.prepare("INSERT INTO work_handoff_drafts(id,project_id,work_item_id,actor,identity,etag,payload,status) VALUES(?,?,?,?,?,?,?,'draft')").run(id, projectId, workItemId, context.viewerUserId, JSON.stringify(identity), context.etag, JSON.stringify(payload));
      row = this.row(id);
    }
    return { ...this.view(row), people };
  }
  async status(id) {
    const row = this.row(id), { context, identity } = await this.context(row.project_id, row.work_item_id, false);
    this.sameActor(row, context, identity); return this.view(this.row(id));
  }
  async save({ id, recipientId, nextAction }) {
    if (typeof recipientId !== 'string' || recipientId.length > 128 || typeof nextAction !== 'string' || nextAction.length > 2000) fail('请填写有效的接手成员和下一步。');
    let row = this.row(id);
    const { context, identity } = await this.context(row.project_id, row.work_item_id); this.sameActor(row, context, identity);
    const people = await this.names(context, identity);
    const recipient = people.find(m => m.userId === recipientId && m.userId !== row.actor && m.access === 'contribute');
    if (recipientId && !recipient) fail('请选择已经可以参与这项工作的成员；交接不会自动扩大访问权限。');
    row = this.row(id);
    if (row.status !== 'draft' || this.pending.has(id)) fail('这份交接已经提交，请先核对结果。');
    if (row.etag !== context.etag) fail('工作已被更新，请重新打开交接，检查最新内容后确认。');
    this.db.prepare('UPDATE work_handoff_drafts SET payload=?,error=\'\' WHERE id=?').run(JSON.stringify({ recipientId, recipientName: recipient?.displayName || '', nextAction }), id);
    return this.view(this.row(id));
  }
  submit(args) {
    if (args.confirm !== true) return Promise.reject(new Error('请确认接手成员和下一步后再交接。'));
    const old = this.pending.get(args.id);
    if (old) return old.hash === args.expectedHash ? old.promise : Promise.reject(new Error('正在提交另一份交接内容，请等待结果。'));
    const promise = this.execute(args).finally(() => this.pending.delete(args.id));
    this.pending.set(args.id, { hash: args.expectedHash, promise }); return promise;
  }
  async execute({ id, expectedHash }) {
    const row = this.row(id), payload = JSON.parse(row.payload);
    if (hash(payload) !== expectedHash) fail('交接内容已改变，请检查后重新确认。');
    const { context, identity } = await this.context(row.project_id, row.work_item_id, false); this.sameActor(row, context, identity);
    if (row.status === 'done') return this.view(row);
    if (row.status === 'rejected') fail(row.error);
    const fresh = row.status === 'draft';
    let patch = row.patch && JSON.parse(row.patch);
    if (fresh) {
      await this.context(row.project_id, row.work_item_id); // current owner and open work required
      if (row.etag !== context.etag) fail('工作已被更新，请重新打开交接，检查最新内容后确认。');
      const recipient = context.workItem.members.find(m => m.userId === payload.recipientId);
      if (payload.recipientId === row.actor || recipient?.accessGrant.status !== 'active' || recipient.accessGrant.access !== 'contribute') fail('接手成员已无法参与这项工作，请重新选择。');
      if (!payload.nextAction.trim()) fail('请说明希望同事接着完成什么。');
      patch = { nextAction: payload.nextAction, assigneeUserId: payload.recipientId };
      this.db.prepare("UPDATE work_handoff_drafts SET status='pending',patch=?,error='' WHERE id=?").run(JSON.stringify(patch), id);
    }
    // Uncertain delivery replays the original If-Match and patch, never a freshly merged assignment.
    try {
      const result = await this.work.cloud.fileCall(identity, 'turnsu_update_work', { pathParams: { workItemId: row.work_item_id }, ifMatch: row.etag, idempotencyKey: 'desktop-handoff-' + id, data: patch });
      this.db.prepare("UPDATE work_handoff_drafts SET status='done',receipt=?,error='' WHERE id=?").run(JSON.stringify(result.data), id);
      return this.view(this.row(id));
    } catch (e) {
      const rejected = fresh && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status);
      const message = rejected ? '交接未被接受。工作或成员权限可能已变化，请重新打开并检查后确认。' : '尚未确认交接结果。原成员和内容已保留，请核对并重试，不要重复新建。';
      this.db.prepare('UPDATE work_handoff_drafts SET status=?,error=? WHERE id=?').run(rejected ? 'rejected' : 'pending', message, id); fail(message);
    }
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(item => item.promise)); }
}
