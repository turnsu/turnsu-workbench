const fail = message => { throw new Error(message); };
const operations = { submit: 'submitWorkItemResult', accept: 'reviewWorkItemResult', request_changes: 'reviewWorkItemResult' };
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const sameTeam = (a, b) => a.origin === b.origin && a.workspaceId === b.workspaceId;
function readable(error) {
  if (error?.status === 412 || /conflict/.test(error?.code || '')) return '工作或成果已更新。请读取最新内容，再决定是否提交或验收。';
  if ([401, 403, 404].includes(error?.status)) return '暂时无法提交，请核对当前团队账户和工作权限。成果与本机记录仍保留。';
  if (error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return '这次操作未被接受。请读取最新成果，检查提交内容后重试。';
  return '尚未确认提交结果。原内容已保存在本机，请核对原提交，不要重复操作。';
}

// Product owns the immutable submission/review and Work status. This is only the desktop's
// durable original request; it never guesses that a result was accepted from a native Agent turn.
export class WorkResults {
  constructor(work) { this.work = work; this.db = work.db; this.pending = new Map(); }
  async bound(projectId, workItemId) {
    const context = await this.work.context(projectId, workItemId);
    return { context, identity: await this.work.cloud.identity(), actor: context.viewerUserId };
  }
  same(row, bound) {
    if (row.actor !== bound.actor || !sameTeam(JSON.parse(row.identity), bound.identity)) fail('请切回提交这份成果的团队账户。');
  }
  async state({ projectId, workItemId }) {
    const bound = await this.bound(projectId, workItemId);
    const rows = this.db.prepare("SELECT * FROM work_result_actions WHERE project_id=? AND work_item_id=? AND actor=? AND status='pending' ORDER BY rowid").all(projectId, workItemId, bound.actor);
    return { actions: rows.filter(row => sameTeam(JSON.parse(row.identity), bound.identity)).map(row => ({ id: row.id, kind: row.kind, error: row.error, data: JSON.parse(row.payload).data })) };
  }
  submit(args) {
    if (!text(args.actionId, 100) || !Object.hasOwn(operations, args.kind) || args.confirm !== true) return Promise.reject(new Error('请检查这份成果并明确确认本次操作。'));
    const signature = JSON.stringify(args), old = this.pending.get(args.actionId);
    if (old) return old.signature === signature ? old.promise : Promise.reject(new Error('原操作正在提交，请先核对。'));
    const promise = this.perform(args).finally(() => this.pending.delete(args.actionId));
    this.pending.set(args.actionId, { signature, promise }); return promise;
  }
  async perform(args) {
    const bound = await this.bound(args.projectId, args.workItemId);
    let row = this.db.prepare('SELECT * FROM work_result_actions WHERE id=?').get(args.actionId);
    if (row) {
      this.same(row, bound);
      if (row.project_id !== args.projectId || row.work_item_id !== args.workItemId || row.kind !== args.kind) fail('同一操作不能用于另一项工作或成果。');
      if (!args.retry) fail('这次操作已有记录，请核对原提交。');
      if (row.status === 'rejected') fail(row.error);
      if (row.status === 'done') return { actionId: row.id, ...JSON.parse(row.receipt) };
    } else {
      if (args.retry) fail('找不到原提交，请重新打开团队工作。');
      const uncertain = this.db.prepare("SELECT identity FROM work_result_actions WHERE project_id=? AND work_item_id=? AND actor=? AND status='pending'").all(args.projectId, args.workItemId, bound.actor);
      if (uncertain.some(item => sameTeam(JSON.parse(item.identity), bound.identity))) fail('上次成果提交尚未确认，请先核对原提交。');
      if (!text(args.entryId, 128) || !text(args.contentHash, 128) || !text(args.etag, 512)) fail('请先读取这份成果的完整内容和最新工作状态。');
      const grant = bound.context.workItem.members.find(member => member.userId === bound.actor)?.accessGrant;
      if (grant?.status !== 'active' || !['owner', 'contribute'].includes(grant.access)) fail('你目前不能提交这项工作的成果。');
      if (args.kind !== 'submit' && bound.context.workItem.accountableOwnerUserId !== bound.actor) fail('请由这项工作的负责人验收成果。');
      // Never replace the version the human actually saw with the fresh preflight version.
      if (args.etag !== bound.context.etag) fail('工作或成果已更新。请读取最新内容后再确认。');
      const data = { entryId: args.entryId, contentHash: args.contentHash, confirm: true };
      const pathParams = { workItemId: args.workItemId };
      if (args.kind !== 'submit') {
        if (!text(args.submissionId, 128) || typeof args.feedback !== 'string' || args.feedback.length > 2000 || (args.kind === 'request_changes' && !args.feedback.trim())) fail('请选定待验收成果；需要修改时，请说明要改什么。');
        Object.assign(data, { decision: args.kind, feedback: args.feedback }); pathParams.submissionId = args.submissionId;
      }
      const payload = { pathParams, data, ifMatch: args.etag, idempotencyKey: 'desktop-result-' + args.actionId };
      this.db.prepare("INSERT INTO work_result_actions(id,project_id,work_item_id,actor,identity,kind,payload,status) VALUES(?,?,?,?,?,?,?,'pending')").run(args.actionId, args.projectId, args.workItemId, bound.actor, JSON.stringify(bound.identity), args.kind, JSON.stringify(payload));
      row = this.db.prepare('SELECT * FROM work_result_actions WHERE id=?').get(args.actionId);
    }
    try {
      const result = await this.work.cloud.desktopCall(bound.identity, operations[row.kind], JSON.parse(row.payload));
      this.db.prepare("UPDATE work_result_actions SET status='done',receipt=?,error='' WHERE id=?").run(JSON.stringify(result), row.id);
      return { actionId: row.id, ...result };
    } catch (error) {
      const rejected = !args.retry && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      const message = readable(error);
      this.db.prepare('UPDATE work_result_actions SET status=?,error=? WHERE id=?').run(rejected ? 'rejected' : 'pending', message, row.id);
      throw new Error(message);
    }
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(item => item.promise)); }
}
