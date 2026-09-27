import { createHash, randomUUID } from 'node:crypto';
const fail = message => { throw new Error(message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const sameWorkspace = (a, b) => a.origin === b.origin && a.workspaceId === b.workspaceId;
const validId = value => typeof value === 'string' && value.trim() && value.length <= 128;
function readable(error) {
  if (error.status === 412) return '项目成员已被其他人修改。请重新读取名单并确认，不会覆盖对方的修改。';
  if ([401, 403, 404].includes(error.status)) return '当前账户无法调整此项目成员，请核对原团队账户和项目管理权限。';
  if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return '成员调整未能完成，请重新读取名单后核对。';
  return '尚未确认成员是否调整。原请求已保存在本机，请核对原结果。';
}

// Private human review/outbox only; Product remains the membership and permission authority.
export class ProjectMembers {
  constructor(host) { this.host = host; this.db = host.db; this.pending = new Map(); }
  get cloud() { return this.host.cloud; }
  row(id) { const row = this.db.prepare('SELECT * FROM project_member_drafts WHERE id=?').get(id); if (!row) fail('找不到这份成员调整，请重新打开。'); return row; }
  view(row) { return { id: row.id, ...JSON.parse(row.payload), hash: digest(row.payload), status: row.status, error: row.error, receipt: row.receipt ? JSON.parse(row.receipt) : null }; }
  async bound() {
    let identity, viewer;
    try { identity = await this.cloud.identity(); viewer = await this.cloud.viewer(); }
    catch { fail('请连接原团队账户，再核对项目成员。'); }
    if (!viewer.userId || viewer.workspaceId !== identity.workspaceId) fail('团队账户已变化，请重新连接。');
    return { identity, actor: viewer.userId, viewer };
  }
  same(row, bound) { if (row.actor !== bound.actor || !sameWorkspace(JSON.parse(row.identity), bound.identity)) fail('请切回调整此名单的原团队账户。'); }
  async people(bound) {
    let response;
    try { response = await this.cloud.fileCall(bound.identity, 'turnsu_work_people', {}); }
    catch { fail('暂时无法读取团队名单，请检查连接和访问权限后重试。'); }
    return response.data.map(({ userId, displayName, username }) => ({ userId, displayName, username }));
  }
  async open({ projectId }) {
    if (!validId(projectId)) fail('请选择团队项目。');
    const bound = await this.bound();
    let response;
    try { response = await this.cloud.fileCall(bound.identity, 'turnsu_project', { pathParams: { projectId } }); }
    catch { fail('暂时无法读取此项目，请检查原团队连接和项目访问权限后重试。'); }
    const people = await this.people(bound), current = await this.bound();
    if (bound.actor !== current.actor || !sameWorkspace(bound.identity, current.identity)) fail('团队账户已变化，请重新打开。');
    const project = response.data;
    if (!response.etag || project.workspaceId !== bound.identity.workspaceId || project.projectId !== projectId) fail('未能核对项目的当前版本，请重试。');
    let row = this.db.prepare("SELECT * FROM project_member_drafts WHERE project_id=? AND actor=? AND status IN ('draft','pending','rejected') ORDER BY rowid DESC").all(projectId, bound.actor).find(value => sameWorkspace(JSON.parse(value.identity), bound.identity));
    if (!row || row.status === 'rejected') {
      const id = randomUUID(), members = project.members.filter(person => person.userId !== project.accountableOwnerUserId).map(({ userId }) => ({ userId }));
      const payload = { project, ifMatch: response.etag, data: { members }, selectedPeople: members.map(member => people.find(person => person.userId === member.userId) || { ...member, displayName: '当前名单中的成员', username: '' }) };
      this.db.exec('BEGIN');
      try {
        if (row) this.db.prepare("UPDATE project_member_drafts SET status='superseded' WHERE id=?").run(row.id);
        this.db.prepare("INSERT INTO project_member_drafts(id,project_id,actor,identity,payload,status) VALUES(?,?,?,?,?,'draft')").run(id, projectId, bound.actor, JSON.stringify(bound.identity), JSON.stringify(payload));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      row = this.row(id);
    }
    return { ...this.view(row), people, actor: bound.actor };
  }
  async status({ id }) { const row = this.row(id); this.same(row, await this.bound()); return this.view(row); }
  async save({ id, memberIds }) {
    if (!Array.isArray(memberIds) || memberIds.length > 63 || memberIds.some(value => !validId(value)) || new Set(memberIds).size !== memberIds.length) fail('请选择有效的成员。');
    const bound = await this.bound(); this.same(this.row(id), bound);
    const people = await this.people(bound), current = await this.bound(), row = this.row(id); this.same(row, current);
    if (!sameWorkspace(bound.identity, current.identity) || bound.actor !== current.actor) fail('团队账户已变化，请重新打开。');
    if (row.status !== 'draft' || this.pending.has(id)) fail('这份调整已经提交，请先核对原结果。');
    const payload = JSON.parse(row.payload), selected = memberIds.map(userId => people.find(person => person.userId === userId));
    if (memberIds.includes(payload.project.accountableOwnerUserId)) fail('项目负责人会保留，无需重复选择。');
    if (selected.some(person => !person)) fail('所选成员已不在团队名单，请重新核对。');
    payload.data.members = [...memberIds].sort().map(userId => ({ userId })); payload.selectedPeople = selected;
    this.db.prepare("UPDATE project_member_drafts SET payload=?,error='' WHERE id=?").run(JSON.stringify(payload), id);
    return this.view(this.row(id));
  }
  submit(args) {
    if (args.confirm !== true) return Promise.reject(new Error('请核对成员变化后确认。'));
    const old = this.pending.get(args.id);
    if (old) return old.hash === args.expectedHash ? old.promise : Promise.reject(new Error('另一份成员调整正在提交。'));
    const promise = this.execute(args).finally(() => this.pending.delete(args.id)); this.pending.set(args.id, { hash: args.expectedHash, promise }); return promise;
  }
  async execute({ id, expectedHash }) {
    const bound = await this.bound(), row = this.row(id); this.same(row, bound);
    if (expectedHash !== digest(row.payload)) fail('名单已变化，请重新核对后确认。');
    if (!['draft', 'pending', 'done'].includes(row.status)) fail('请重新读取项目成员后确认。');
    const payload = JSON.parse(row.payload);
    this.db.prepare("UPDATE project_member_drafts SET status='pending',error='' WHERE id=?").run(id);
    try {
      const response = await this.cloud.desktopCall(bound.identity, 'reviseProjectMembers', { pathParams: { projectId: row.project_id }, data: payload.data, ifMatch: payload.ifMatch, idempotencyKey: 'desktop-members-' + id });
      this.same(row, await this.bound());
      if (response.data.projectId !== row.project_id || response.data.workspaceId !== bound.identity.workspaceId) fail('成员回执与原项目不一致。');
      this.db.prepare("UPDATE project_member_drafts SET status='done',receipt=?,error='' WHERE id=?").run(JSON.stringify(response.data), id);
      this.host.changed(); return this.view(this.row(id));
    } catch (error) {
      const rejected = row.status === 'draft' && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
      const message = readable(error);
      this.db.prepare('UPDATE project_member_drafts SET status=?,error=? WHERE id=?').run(rejected ? 'rejected' : row.status === 'done' ? 'done' : 'pending', message, id);
      fail(message);
    }
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(value => value.promise)); }
}
