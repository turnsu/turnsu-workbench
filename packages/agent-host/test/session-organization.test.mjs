import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-organize-'));
  let host, calls = [], hooks;
  const open = () => host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: options => {
    hooks = options;
    return { ready: Promise.resolve(), closed: false, pending: new Map(), close: async () => {}, request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'original-native', turns: [] } };
      if (method === 'turn/start') return { turn: { id: 'turn-' + calls.length } };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      throw new Error('Unexpected provider request: ' + method);
    } };
  } });
  open();
  const projects = [];
  for (const name of ['客服资料', '季度回访']) { const path = join(root, name); await mkdir(path); projects.push(await host.command('project.open', { path })); }
  const session = await host.command('session.create', { projectId: projects[0].id, agent: 'codex' });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projects, session, calls, get host() { return host; }, get hooks() { return hooks; }, async reopen() { await host.close(); open(); } };
}

test('organizing a conversation preserves its native Agent, working files, draft and next execution directory', async t => {
  const f = await fixture(t), [source, target] = f.projects, id = f.session.id;
  await writeFile(join(source.path, '订单.txt'), '原始材料');
  await f.host.command('session.send', { sessionId: id, inputId: 'first', text: '核对订单' });
  f.host.updateSession(id, 'idle');
  await f.host.command('draft.save', { projectId: source.id, sessionId: id, text: '保留这段草稿', references: ['订单.txt'] });
  await f.host.command('session.move', { sessionId: id, projectId: target.id });
  assert.equal((await f.host.command('workspace.read', { projectId: source.id })).sessions.length, 0);
  assert.equal((await f.host.command('workspace.read', { projectId: target.id })).sessions[0].id, id);
  await f.reopen();
  const current = await f.host.command('session.read', { sessionId: id });
  assert.equal(current.project_id, source.id);
  assert.equal(current.collection_project_id, target.id);
  assert.equal(current.cwd, source.path);
  assert.equal(current.native_id, 'original-native');
  assert.equal(current.agent, 'codex');
  assert.equal(current.messages[0].text, '核对订单');
  assert.equal((await f.host.command('draft.read', { projectId: source.id, sessionId: id })).text, '保留这段草稿');
  assert.deepEqual((await f.host.command('draft.read', { projectId: source.id, sessionId: id })).references, ['订单.txt']);
  assert.equal(await readFile(join(source.path, '订单.txt'), 'utf8'), '原始材料');
  await assert.rejects(readFile(join(target.path, '订单.txt')), { code: 'ENOENT' });
  const located = await f.host.command('session.locate', { sessionId: id });
  assert.equal(located.projectId, target.id); assert.equal(located.workingProjectId, source.id);
  await f.host.command('session.resume', { sessionId: id });
  await f.host.command('session.send', { sessionId: id, inputId: 'follow-up', text: '继续核对' });
  const resumed = f.calls.find(call => call.method === 'thread/resume');
  assert.equal(resumed.params.cwd, source.path);
  assert.equal(resumed.params.threadId, 'original-native');
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
});

test('archive is reversible across restart, preserves drafts and prevents hidden execution', async t => {
  const f = await fixture(t), id = f.session.id, projectId = f.projects[0].id;
  await f.host.command('session.rename', { sessionId: id, title: '客户回访记录' });
  await f.host.command('draft.save', { projectId, sessionId: id, text: '待补充的要求' });
  await f.host.command('session.archive', { sessionId: id, archived: true });
  assert.equal((await f.host.command('workspace.read', { projectId })).sessionPage.total, 0);
  assert.equal((await f.host.command('workspace.read', { projectId, archived: true, search: '回访' })).sessions[0].id, id);
  for (const [method, args] of [['session.send', { inputId: 'hidden', text: '不应执行' }], ['session.resume', {}], ['ui.commit', {}]]) {
    await assert.rejects(f.host.command(method, { sessionId: id, ...args }), /归档/);
  }
  await f.reopen();
  assert.ok((await f.host.command('session.read', { sessionId: id })).archived_at);
  assert.equal((await f.host.command('draft.read', { projectId, sessionId: id })).text, '待补充的要求');
  await f.host.command('session.archive', { sessionId: id, archived: false });
  assert.equal((await f.host.command('workspace.read', { projectId })).sessions[0].id, id);
  assert.equal(f.calls.length, 0);
});

test('moving and archiving refuse active work and cannot cross a team sharing boundary', async t => {
  const f = await fixture(t), id = f.session.id, target = f.projects[1];
  for (const status of ['starting', 'running', 'waiting', 'stopping']) {
    f.host.updateSession(id, status);
    await assert.rejects(f.host.command('session.archive', { sessionId: id, archived: true }), /结束/);
    await assert.rejects(f.host.command('session.move', { sessionId: id, projectId: target.id }), /结束/);
  }
  f.host.updateSession(id, 'idle'); f.host.operations.add(id);
  await assert.rejects(f.host.command('session.move', { sessionId: id, projectId: target.id }), /结束/);
  f.host.operations.delete(id);
  f.host.db.prepare("INSERT INTO shared_projects(project_id,remote_id,identity,title,device,inode,paused) VALUES(?,?,'{}','团队',1,1,1)").run(target.id, 'remote');
  await assert.rejects(f.host.command('session.move', { sessionId: id, projectId: target.id }), /团队/);
  assert.equal((await f.host.command('session.read', { sessionId: id })).collection_project_id, null);
});

test('pins, cross-project search and archive filters keep bounded, reversible pagination', async t => {
  const f = await fixture(t), projectId = f.projects[0].id;
  for (let i = 0; i < 85; i++) f.host.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES(?,?,?,'idle',?)").run('history-' + i, projectId, '记录 ' + i, i + 1);
  await f.host.command('session.pin', { sessionId: 'history-2', pinned: true });
  await f.host.command('session.archive', { sessionId: 'history-4', archived: true });
  await f.host.command('session.move', { sessionId: 'history-6', projectId: f.projects[1].id });
  const first = await f.host.command('workspace.read', { projectId });
  assert.equal(first.sessions[0].id, 'history-2'); assert.ok(first.sessions.length <= 40);
  const second = await f.host.command('workspace.read', { projectId, before: first.sessionPage.older });
  assert.ok(!second.sessions.some(s => first.sessions.some(old => old.id === s.id)));
  assert.deepEqual((await f.host.command('workspace.read', { projectId, after: second.sessionPage.newer })).sessions.map(s => s.id), first.sessions.map(s => s.id));
  assert.equal((await f.host.command('workspace.read', { allProjects: true, search: '记录 6' })).sessions.find(s => s.id === 'history-6').collection_project_id, f.projects[1].id);
  assert.equal((await f.host.command('workspace.read', { allProjects: true, archived: true })).sessions[0].id, 'history-4');
  assert.equal((await f.host.command('workspace.read')).sessions.length, 0);
  assert.equal(f.calls.length, 0);
});

test('project naming and pinning never rename folders or inherit another project settings', async t => {
  const f = await fixture(t), [project] = f.projects;
  await assert.rejects(f.host.command('project.rename', { projectId: project.id, name: ' ' }), /名称/);
  await f.host.command('project.rename', { projectId: project.id, name: '  客服\n回访  ' });
  await f.host.command('project.pin', { projectId: project.id, pinned: true });
  await f.reopen();
  const current = (await f.host.command('workspace.read')).projects[0];
  assert.equal(current.id, project.id); assert.equal(current.name, '客服 回访'); assert.equal(current.path, project.path); assert.ok(current.pinned_at);
  assert.equal(f.calls.length, 0);
});
