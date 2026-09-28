import { createHash, randomUUID } from 'node:crypto';
const fail = message => { throw new Error(message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const sameWorkspace = (a, b) => a.origin === b.origin && a.workspaceId === b.workspaceId;
function readable(error) {
  if (error.status === 403) return '此账户不能创建团队项目，或所选成员已不可用。请由团队管理员核对，草稿仍保留。';
  if ([401, 404].includes(error.status)) return '请重新连接原团队并核对账户，原创建请求仍保留。';
  if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return '项目未能创建，请核对名称和成员后修改草稿。';
  return '尚未确认项目是否创建。原请求已保存在本机，请核对并重试，不会重复创建。';
}

// Pending human-reviewed requests only. Product owns projects, members and authorization.
export class ProjectCreation {
  constructor(host) { this.host = host; this.db = host.db; this.pending = new Map(); }
  get cloud() { return this.host.cloud; }
  row(id) { const value = this.db.prepare('SELECT * FROM project_creation_drafts WHERE id=?').get(id); if (!value) fail('找不到这份项目草稿，请重新打开。'); return value; }
  view(row) { return { id: row.id, ...JSON.parse(row.payload), hash: digest(row.payload), status: row.status, error: row.error, project: row.receipt ? JSON.parse(row.receipt) : null }; }
  async bound() {
    let identity, viewer;
    try { identity = await this.cloud.identity(); viewer = await this.cloud.viewer(); }
    catch { fail('请先连接原团队，再核对项目创建。本机项目和草稿仍保留。'); }
    if (viewer.workspaceId !== identity.workspaceId || !viewer.userId) fail('团队账户已变化，请重新连接。');
    return { identity, actor: viewer.userId };
  }
  same(row, bound) { if (row.actor !== bound.actor || !sameWorkspace(JSON.parse(row.identity), bound.identity)) fail('请切回创建这份草稿的团队账户。'); }
  async people(bound) {
    let response;
    try { response = await this.cloud.fileCall(bound.identity, 'turnsu_work_people', {}); }
    catch { fail('暂时无法读取团队成员，请检查连接后重试。草稿仍保留在本机。'); }
    return response.data.filter(person => person.userId !== bound.actor).map(({ userId, displayName, username }) => ({ userId, displayName, username }));
  }
  async open({ localProjectId = '' } = {}) {
    const project = localProjectId ? this.host.project(localProjectId) : null;
    const bound = await this.bound(), people = await this.people(bound);
    let row = this.db.prepare("SELECT * FROM project_creation_drafts WHERE local_project_id=? AND actor=? AND status IN ('draft','pending','rejected') ORDER BY rowid DESC").all(localProjectId, bound.actor).find(value => sameWorkspace(JSON.parse(value.identity), bound.identity));
    if (!row || row.status === 'rejected') {
      const id = randomUUID(), payload = row?.payload || JSON.stringify({ data: { title: project?.name?.slice(0, 200) || '', objective: '', members: [] }, selectedPeople: [] });
      this.db.exec('BEGIN');
      try {
        if (row) this.db.prepare("UPDATE project_creation_drafts SET status='superseded' WHERE id=?").run(row.id);
        this.db.prepare("INSERT INTO project_creation_drafts(id,local_project_id,actor,identity,payload,status) VALUES(?,?,?,?,?,'draft')").run(id, localProjectId, bound.actor, JSON.stringify(bound.identity), payload);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      row = this.row(id);
    }
    return { ...this.view(row), people };
  }
  async status({ id }) { const row = this.row(id); this.same(row, await this.bound()); return this.view(row); }
  async save({ id, title, objective, memberIds }) {
    if (!text(title, 200) || typeof objective !== 'string' || objective.length > 2000 || !Array.isArray(memberIds) || memberIds.length > 63 || memberIds.some(value => !text(value, 128)) || new Set(memberIds).size !== memberIds.length) fail('请填写项目名称，并选择有效的团队成员。');
    const bound = await this.bound(); this.same(this.row(id), bound);
    const people = await this.people(bound), selected = memberIds.map(userId => people.find(person => person.userId === userId));
    if (selected.some(person => !person)) fail('所选成员已不在当前团队名单中，请重新选择。');
    const row = this.row(id); this.same(row, bound);
    if (row.status !== 'draft' || this.pending.has(id)) fail('这份创建请求已经提交，请先核对原结果。');
    const payload = { data: { title: title.trim(), objective: objective.trim() || title.trim(), members: [...memberIds].sort().map(userId => ({ userId })) }, selectedPeople: selected };
    this.db.prepare("UPDATE project_creation_drafts SET payload=?,error='' WHERE id=?").run(JSON.stringify(payload), id);
    return this.view(this.row(id));
  }
  submit(args) {
    if (args.confirm !== true) return Promise.reject(new Error('请核对项目和成员后确认创建。'));
    const old = this.pending.get(args.id);
    if (old) return old.hash === args.expectedHash ? old.promise : Promise.reject(new Error('另一份创建内容正在提交，请等待结果。'));
    const promise = this.execute(args).finally(() => this.pending.delete(args.id)); this.pending.set(args.id, { hash: args.expectedHash, promise }); return promise;
  }
  async execute({ id, expectedHash }) {
    const bound = await this.bound(), row = this.row(id); this.same(row, bound);
    if (expectedHash !== digest(row.payload)) fail('项目草稿已变化，请重新核对后创建。');
    const { data } = JSON.parse(row.payload);
    if (!text(data.title, 200) || !text(data.objective, 2000)) fail('请先保存有效的项目名称和目标。');
    if (!['draft', 'pending', 'done'].includes(row.status)) fail('请重新打开并修改项目草稿。');
    // Replaying a completed receipt also passes through current Product authorization.
    this.db.prepare("UPDATE project_creation_drafts SET status='pending',error='' WHERE id=?").run(id);
    try {
      const response = await this.cloud.desktopCall(bound.identity, 'createProject', { data, idempotencyKey: 'desktop-project-' + id });
      const current = await this.bound(); this.same(row, current);
      if (response.data.workspaceId !== bound.identity.workspaceId || response.data.accountableOwnerUserId !== bound.actor) fail('项目回执与原团队账户不一致，请重新核对。');
      this.db.prepare("UPDATE project_creation_drafts SET status='done',receipt=?,error='' WHERE id=?").run(JSON.stringify(response.data), id);
      this.host.changed(); return this.view(this.row(id));
    } catch (error) {
      // A later denial cannot prove an earlier uncertain commit never happened.
      const rejected = row.status === 'draft' && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
      const message = readable(error);
      this.db.prepare('UPDATE project_creation_drafts SET status=?,error=? WHERE id=?').run(rejected ? 'rejected' : row.status === 'done' ? 'done' : 'pending', message, id);
      fail(message);
    }
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(value => value.promise)); }
}
