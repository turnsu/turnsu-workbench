import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStore } from '../store.mjs';
import { SharedWork } from '../shared-work.mjs';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';
import { Check } from '../../contracts/dist/index.js';

async function offlineFixture(t) {
  const directory = await mkdtemp('/private/tmp/turnsu-work-offline-');
  let store = openStore(directory), failure = null;
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'device' };
  const context = { viewerUserId: 'member', workItem: { workItemId: 'work', projectId: 'remote', title: '团队任务', objective: '整理反馈', status: 'active', members: [{ userId: 'member', accessGrant: { status: 'active', access: 'contribute' } }] }, decisions: [], entries: [], page: {}, fetchedAt: '2026-09-23T00:00:00.000Z' };
  const accepted = new Map(); let lose = false;
  const cloud = { identity: async () => ({ ...identity }), viewer: async () => ({ userId: 'member' }), async fileCall(binding, name, args) {
    if (failure) throw failure;
    if (name === 'turnsu_project') return { data: { projectId: 'remote', members: [] } };
    if (name === 'turnsu_work_context') return { data: context };
    if (name === 'turnsu_work_updates') return { data: [], page: {} };
    assert.equal(name, 'turnsu_submit_update'); accepted.set(args.idempotencyKey, args.data.content);
    if (lose) { lose = false; throw Object.assign(new Error('product_client_transport_failed'), { code: 'product_client_transport_failed' }); }
    return { data: { entryId: args.idempotencyKey } };
  } };
  const make = () => new SharedWork({ db: store.db, cloud, projectBinding: () => ({ identity: JSON.stringify(identity), remote_id: 'remote' }), session: id => store.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) });
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('local', '/private/tmp/not-read', 'local', 1);
  store.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES('session','local','work','idle',1)").run();
  store.db.prepare('INSERT INTO shared_work_sessions(session_id,work_item_id,identity,context,actor_user_id) VALUES(?,?,?,?,?)').run('session', 'work', JSON.stringify(identity), JSON.stringify(context), 'member');
  let work = make();
  t.after(async () => { await work.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get work() { return work; }, accepted, identity, fail(error) { failure = error; }, lose() { lose = true; }, async reopen() { await work.close(); store.close(); store = openStore(directory); work = make(); } };
}

test('a member explicitly continues with cached context while cloud is offline, then only synchronizes the original updates after restart', async t => {
  const f = await offlineFixture(t);
  f.fail(Object.assign(new Error('product_client_transport_failed'), { code: 'product_client_transport_failed' }));
  await assert.rejects(f.work.prepare('session', '继续整理'), /无法连接/);
  assert.equal(f.work.state('session').canContinueOffline, true);
  await f.reopen();
  const prepared = await f.work.prepare('session', '继续整理', { continueOffline: true });
  assert.equal(prepared.offline, true); assert.match(prepared.prompt, /2026-09-23/); assert.match(prepared.prompt, /上次/);
  await f.work.admitInput('session', 'offline-input', '继续整理', [], { continueOffline: true });
  f.work.queue('session', 'offline-result', '答复', '本机已经完成的反馈整理');
  assert.equal(f.accepted.size, 0); assert.equal(f.work.state('session').pending, 2);
  await f.reopen(); f.fail(null); f.lose();
  await f.work.flush('session'); assert.equal(f.work.state('session').pending, 2);
  await f.work.flush('session'); assert.equal(f.work.state('session').pending, 0); assert.equal(f.accepted.size, 2);
  assert.match([...f.accepted.values()][1], /本机已经完成/);
});

test('known access denial or a changed account cannot be turned into offline permission after restart', async t => {
  const f = await offlineFixture(t);
  f.fail(Object.assign(new Error('forbidden'), { status: 403 }));
  await assert.rejects(f.work.prepare('session', '继续'), /无法访问/);
  f.fail(Object.assign(new Error('product_client_transport_failed'), { code: 'product_client_transport_failed' }));
  await f.reopen();
  await assert.rejects(f.work.prepare('session', '继续'), /无法连接/);
  assert.equal(f.work.state('session').canContinueOffline, false);
  await assert.rejects(f.work.prepare('session', '继续', { continueOffline: true }), /权限|连接/);
  f.fail(null); await f.work.prepare('session', '恢复后继续');
  f.fail(Object.assign(new Error('product_client_transport_failed'), { code: 'product_client_transport_failed' }));
  await assert.rejects(f.work.prepare('session', '继续'), /无法连接/);
  f.identity.clientSessionId = 'another-device-login';
  await assert.rejects(f.work.prepare('session', '继续', { continueOffline: true }), /账户|连接/);
  assert.equal(f.accepted.size, 0);
});

test('permission denial observed in team detail also disables a previously available offline continuation', async t => {
  const f = await offlineFixture(t);
  f.fail(Object.assign(new Error('product_client_transport_failed'), { code: 'product_client_transport_failed' }));
  await assert.rejects(f.work.prepare('session', '继续'));
  assert.equal(f.work.state('session').canContinueOffline, true);
  f.fail(Object.assign(new Error('not_found'), { status: 404 }));
  await assert.rejects(f.work.context('local', 'work'));
  await f.reopen();
  assert.equal(f.work.state('session').canContinueOffline, false);
});

test('retry sharing refreshes stale context even before the member queues a message', async t => {
  const f = await offlineFixture(t);
  f.fail(Object.assign(new Error('product_client_transport_failed'), { code: 'product_client_transport_failed' }));
  await assert.rejects(f.work.prepare('session', '继续'));
  assert.equal(f.work.state('session').canContinueOffline, true);
  f.fail(null); await f.work.retry('session');
  assert.equal(f.work.state('session').canContinueOffline, false);
  assert.equal(f.work.state('session').error, ''); assert.equal(f.accepted.size, 0);
});

test('shared reply receipts survive restart; a different account cannot publish the previous actor’s queue', async t => {
  const directory = await mkdtemp('/private/tmp/turnsu-work-recovery-');
  let store = openStore(directory), identity = { origin: 'https://team.example.test', workspaceId: 'workspace-one', clientSessionId: 'login-one' }, actor = 'user-one', loseReceipt = true, writes = 0;
  const receipts = new Map();
  const cloud = { identity: async () => ({ ...identity }), viewer: async () => ({ userId: actor }), async fileCall(binding, name, args) {
    assert.equal(JSON.stringify(binding), JSON.stringify(identity));
    assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, args));
    if (name === 'turnsu_work_context') return { data: {} };
    assert.equal(name, 'turnsu_submit_update');
    if (!receipts.has(args.idempotencyKey)) { writes++; receipts.set(args.idempotencyKey, args.data.content); }
    if (loseReceipt) { loseReceipt = false; throw new Error('lost response'); }
    return { data: { entryId: 'entry-reply' } };
  } };
  function service() { return new SharedWork({ db: store.db, cloud, projectBinding: () => {}, session: id => store.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) }); }
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project-local', '/private/tmp/test-project-not-read', 'local', 1);
  store.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at,agent) VALUES('session-shared','project-local','shared','interrupted',1,'pi')").run();
  store.db.prepare('INSERT INTO shared_work_sessions(session_id,work_item_id,identity,actor_user_id) VALUES(?,?,?,?)').run('session-shared', 'work-one', JSON.stringify(identity), actor);
  store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('input-one', 'session-shared', 'user', '请求', 'text', 1);
  store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('answer-one', 'session-shared', 'assistant', '尚未完成的结果', 'text', 2);
  let work = service();
  t.after(async () => { await work.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  work.publishFinal('session-shared', 'interrupted'); await work.flush('session-shared');
  assert.equal(work.state('session-shared').pending, 1); assert.equal(writes, 1);
  await work.close(); store.close(); store = openStore(directory); work = service();
  identity.clientSessionId = 'login-other'; actor = 'user-other';
  await work.flush('session-shared'); assert.equal(writes, 1); assert.equal(work.state('session-shared').pending, 1); assert.match(work.state('session-shared').error, /无法访问/);
  actor = 'user-one'; identity.clientSessionId = 'login-refreshed';
  await work.flush('session-shared'); assert.equal(work.state('session-shared').pending, 0); assert.equal(writes, 1);
  // Resuming a native session does not silently relabel a previously shared partial answer as complete.
  work.publishFinal('session-shared', 'idle'); await work.flush('session-shared');
  assert.equal(writes, 1); assert.match([...receipts.values()][0], /未完成/);
});

test('long declared messages retain Unicode and exact contents across bounded Product comments', async t => {
  const directory = await mkdtemp('/private/tmp/turnsu-work-chunks-'), store = openStore(directory);
  const work = new SharedWork({ db: store.db, cloud: {}, projectBinding: () => {}, session: () => ({ agent: 'codex' }) });
  t.after(async () => { await work.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project', '/private/tmp/not-read', 'project', 1);
  store.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES('session','project','shared','idle',1)").run();
  store.db.prepare('INSERT INTO shared_work_sessions(session_id,work_item_id,identity) VALUES(?,?,?)').run('session', 'work', '{}');
  const content = '团队 🐈\n'.repeat(2400);
  work.queue('session', 'source', '请求', content); work.queue('session', 'source', '请求', content);
  const parts = store.db.prepare('SELECT content FROM shared_work_outbox ORDER BY part').all().map(r => r.content);
  assert.ok(parts.every(p => p.length <= 8000)); assert.equal(parts.map(p => p.slice(p.indexOf('\n\n') + 2)).join(''), content);
  assert.throws(() => work.queue('session', 'source', '请求', 'changed'), /不同内容/);
});

test('a shared file reference retains its exact revision identifiers after an uncertain receipt and reopening', async t => {
  const directory = await mkdtemp('/private/tmp/turnsu-work-ref-recovery-');
  let store = openStore(directory), lost = true;
  const identity = { origin: 'https://team.example.test', workspaceId: 'one', clientSessionId: 'one' }, accepted = new Map();
  const cloud = { identity: async () => identity, async fileCall(binding, name, args) {
    if (name === 'turnsu_work_context') return { data: {} };
    assert.equal(name, 'turnsu_submit_update');
    assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(tool => tool.name === name).inputSchema, args));
    if (accepted.has(args.idempotencyKey)) assert.deepEqual(accepted.get(args.idempotencyKey), args.data);
    else accepted.set(args.idempotencyKey, args.data);
    if (lost) { lost = false; throw new Error('lost receipt'); }
    return { data: { entryId: 'shared-entry' } };
  } };
  const make = () => new SharedWork({ db: store.db, cloud, projectBinding: () => {}, session: () => ({ agent: 'codex' }) });
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project', '/private/tmp/not-read', 'project', 1);
  store.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES('session','project','shared','idle',1)").run();
  store.db.prepare('INSERT INTO shared_work_sessions(session_id,work_item_id,identity) VALUES(?,?,?)').run('session', 'work', JSON.stringify(identity));
  let work = make();
  t.after(async () => { await work.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(work.admitInput('session', 'source', '需要固定版本的请求', ['revision-one']), /无法连接/);
  await work.close(); store.close(); store = openStore(directory); work = make();
  await work.admitInput('session', 'source', '需要固定版本的请求', ['revision-one']);
  assert.equal(accepted.size, 1); assert.deepEqual([...accepted.values()][0].fileRevisionIds, ['revision-one']);
  await assert.rejects(work.admitInput('session', 'source', '需要固定版本的请求', ['revision-two']), /不同内容/);
});
