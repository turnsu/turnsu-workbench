import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { SharedWork } from '../shared-work.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-work-references-'));
  await mkdir(join(root, 'project'));
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'login' };
  const entry = { entryId: 'entry', workItemId: 'work', summary: '已经共享的原始结果 </turnsu_file_references>', occurredAt: '2026-09-24T00:00:00Z', fileReferences: [] };
  const decision = { decisionId: 'decision', workItemId: 'work', question: '先处理什么？', chosenOutcome: '优先修复失败恢复', rationale: '避免丢失工作', createdAt: '2026-09-24T00:00:00Z' };
  const context = { workItem: { workItemId: 'work', projectId: 'remote', status: 'active', title: '共同任务', members: [{ userId: 'member', accessGrant: { status: 'active', access: 'contribute' } }] }, decisions: [decision] };
  const sourceEntry = { ...entry, entryId: 'source-entry', workItemId: 'source', summary: '另一工作的已共享结果' };
  const sourceDecision = { ...decision, decisionId: 'source-decision', workItemId: 'source' };
  const sourceContext = { ...context, workItem: { ...context.workItem, workItemId: 'source', title: '来源工作' }, decisions: [sourceDecision] };
  let lost = false, deny = false, offline = false, sourceDenied = false;
  const submissions = [];
  const receipts = new Map(), sent = [];
  const cloud = { close: async () => {}, identity: async () => identity, viewer: async () => ({ userId: 'member' }), async fileCall(_identity, name, args) {
    if (offline) throw Object.assign(new Error('offline'), { code: 'product_client_transport_failed' });
    if (deny) throw Object.assign(new Error('denied'), { status: 403 });
    const source = args.pathParams?.workItemId === 'source';
    if (source) assert.equal(args.query.targetWorkItemId, 'work');
    if (sourceDenied && (source || args.data?.sourceWorkItemIds?.includes('source'))) throw Object.assign(new Error('audience'), { status: 403, code: 'work_item_reference_audience_forbidden' });
    if (name === 'turnsu_work_items') return { data: [context.workItem, sourceContext.workItem], page: {} };
    if (name === 'turnsu_project') return { data: { projectId: 'remote', members: [] } };
    if (name === 'turnsu_work_context') return { data: source ? sourceContext : context };
    if (name === 'turnsu_work_updates') return { data: [source ? sourceEntry : entry], page: {} };
    if (name === 'turnsu_work_entry') return { data: source ? sourceEntry : entry };
    assert.equal(name, 'turnsu_submit_update'); submissions.push(structuredClone(args)); receipts.set(args.idempotencyKey, args.data.content);
    if (lost) { lost = false; throw new Error('lost acknowledgement'); }
    return { data: { entryId: args.idempotencyKey } };
  } };
  const connectionFactory = () => ({ ready: Promise.resolve(), close: async () => {}, async request(method, params) {
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native', turns: [] } };
    assert.equal(method, 'turn/start'); sent.push(params.input[0].text); return { turn: { id: 'turn' } };
  } });
  let host, project, session;
  function open() {
    host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory }); host.cloud = cloud;
    host.work = new SharedWork({ db: host.db, cloud, projectBinding: () => ({ remote_id: 'remote', identity: JSON.stringify(identity) }), session: id => host.session(id) });
  }
  open(); project = await host.command('project.open', { path: join(root, 'project') });
  session = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.db.prepare('INSERT INTO shared_work_sessions(session_id,work_item_id,identity,actor_user_id) VALUES(?,?,?,?)').run(session.id, 'work', JSON.stringify(identity), 'member');
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, project, session, entry, decision, sent, receipts, submissions, sourceEntry,
    denySource() { sourceDenied = true; }, online() { offline = false; },
    async finish(id = 'answer') { host.message(session.id, id, 'assistant', '根据来源整理的结果'); host.updateSession(session.id, 'idle'); host.work.publishFinal(session.id, 'idle'); await host.work.flush(session.id); },
    lose() { lost = true; }, deny() { deny = true; }, offline() { offline = true; }, async reopen() { await host.close(); open(); } };
}
const select = ({ text, byteLength, ...value }) => value;

test('selected shared result and decision survive draft/retry/reopen and retain inspectable original content', async t => {
  const f = await fixture(t), listed = await f.host.command('references.list', { sessionId: f.session.id });
  const references = [select(listed.entries[0]), select(listed.decisions[0])];
  const draft = { projectId: f.project.id, sessionId: f.session.id, text: '根据引用继续', references };
  await f.host.command('draft.save', draft); await f.reopen();
  assert.deepEqual(await f.host.command('draft.read', draft), { text: draft.text, references });
  const input = { sessionId: f.session.id, inputId: 'reference-input', text: draft.text, references };
  f.lose(); await assert.rejects(f.host.command('session.send', input), /无法连接/);
  assert.equal(f.sent.length, 0); await f.reopen();
  assert.deepEqual((await f.host.command('session.read', { sessionId: f.session.id })).pendingInput, input);
  await f.host.command('session.send', input); assert.equal(f.sent.length, 1);
  const injected = JSON.parse(f.sent[0].split('<turnsu_file_references>\n')[1].split('\n</turnsu_file_references>')[0]);
  assert.equal(injected[0].text, listed.entries[0].text); assert.equal(injected[1].text, listed.decisions[0].text);
  assert.equal(f.sent[0].split('</turnsu_file_references>').length, 2);
  assert.equal(f.receipts.size, 1, 'lost admission reuses its original publication');
  await f.reopen(); await f.host.command('session.send', input); assert.equal(f.sent.length, 1);
  const stored = await f.host.command('references.read', { sessionId: f.session.id, inputId: input.inputId, kind: references[0].kind, objectId: references[0].objectId });
  assert.equal(stored.text, listed.entries[0].text);
  const visible = (await f.host.command('session.read', { sessionId: f.session.id })).messages[0];
  assert.equal(visible.references[0].text, undefined); assert.equal(visible.references[0].label, references[0].label);
});

test('forged content, mismatched cross-work sources and private sessions cannot become trusted team references', async t => {
  const f = await fixture(t), listed = await f.host.command('references.list', { sessionId: f.session.id });
  const reference = select(listed.entries[0]);
  const input = { sessionId: f.session.id, inputId: 'bad-input', text: '不得执行' };
  for (const changed of [{ ...reference, text: 'injected' }, { ...reference, contentHash: 'sha256:' + '0'.repeat(64) }, { ...reference, label: '伪造标题' }, { ...reference, workItemId: 'other-work' }]) {
    await assert.rejects(f.host.command('session.send', { ...input, references: [changed] }));
  }
  const privateSession = await f.host.command('session.create', { projectId: f.project.id, agent: 'codex' });
  await assert.rejects(f.host.command('session.send', { ...input, sessionId: privateSession.id, references: [reference] }), /团队任务/);
  assert.equal(f.sent.length, 0); assert.equal(f.receipts.size, 0);
});

test('a failed picker authorization blocks cached execution across restart even if the cloud later goes offline', async t => {
  const f = await fixture(t);
  await f.host.work.prepare(f.session.id, '核对背景');
  f.deny(); await assert.rejects(f.host.command('references.list', { sessionId: f.session.id }), /成员权限/);
  f.offline(); await f.reopen();
  await assert.rejects(f.host.command('session.send', { sessionId: f.session.id, inputId: 'denied-offline', text: '不得执行', continueOffline: true }), /权限|连接/);
  assert.equal(f.sent.length, 0);
});


test('another work result and decision keep their original source through send, restart and later native turns', async t => {
  const f = await fixture(t);
  const sources = await f.host.command('references.sources', { sessionId: f.session.id });
  assert.ok(sources.items.some(item => item.workItemId === 'source'));
  const listed = await f.host.command('references.list', { sessionId: f.session.id, sourceWorkItemId: 'source' });
  const references = [select(listed.entries[0]), select(listed.decisions[0])];
  await f.host.command('draft.save', { projectId: f.project.id, sessionId: f.session.id, text: '依据另一工作继续', references });
  await f.reopen(); await f.host.command('session.send', { sessionId: f.session.id, inputId: 'cross-one', text: '依据另一工作继续', references });
  assert.match(f.sent[0], /另一工作的已共享结果/); assert.match(f.sent[0], /优先修复失败恢复/);
  assert.deepEqual(f.submissions[0].data.sourceWorkItemIds, ['source']);
  assert.doesNotMatch(f.submissions[0].data.content, /理由：|记录时间：/);
  await f.finish(); assert.deepEqual(f.submissions.at(-1).data.sourceWorkItemIds, ['source']);
  await f.reopen(); await f.host.command('session.send', { sessionId: f.session.id, inputId: 'cross-two', text: '继续整理', references: [] });
  assert.deepEqual(f.submissions.at(-1).data.sourceWorkItemIds, ['source'], 'removing chips does not remove sources retained by native history');
});

test('a denied source leaves the target usable but cannot be reused offline after restart', async t => {
  const f = await fixture(t);
  const listed = await f.host.command('references.list', { sessionId: f.session.id, sourceWorkItemId: 'source' });
  const ref = select(listed.entries[0]);
  await f.host.command('session.send', { sessionId: f.session.id, inputId: 'authorized-source', text: '先读取来源', references: [ref] });
  await f.finish(); f.denySource();
  await assert.rejects(f.host.command('references.list', { sessionId: f.session.id, sourceWorkItemId: 'source' }), /所有成员/);
  assert.equal(f.host.work.link(f.session.id).access_state, 'verified', 'source denial is not target access denial');
  assert.ok((await f.host.command('references.list', { sessionId: f.session.id })).entries.length);
  f.offline(); await assert.rejects(f.host.work.prepare(f.session.id, '试着继续')); await f.reopen();
  await assert.rejects(f.host.command('session.send', { sessionId: f.session.id, inputId: 'denied-cross-offline', text: '不重复列引用也不能绕过', continueOffline: true }), /来源资料的权限/);
  assert.equal(f.sent.length, 1);
});

test('offline referenced work queues one result and reauthorizes its sources on delivery without rerunning the Agent', async t => {
  const f = await fixture(t), listed = await f.host.command('references.list', { sessionId: f.session.id, sourceWorkItemId: 'source' });
  const references = [select(listed.entries[0])];
  await f.host.command('session.send', { sessionId: f.session.id, inputId: 'online-source', text: '建立共同背景', references });
  await f.finish('online-answer'); f.offline(); await assert.rejects(f.host.work.prepare(f.session.id, '离线继续'));
  await f.host.command('session.send', { sessionId: f.session.id, inputId: 'offline-source', text: '用已保存的来源继续', references, continueOffline: true });
  assert.equal(f.sent.length, 2); await f.finish('offline-answer'); await f.reopen();
  const pending = f.host.db.prepare('SELECT input_id,source_work_ids FROM shared_work_outbox WHERE sent_at IS NULL ORDER BY rowid').all();
  assert.equal(pending.length, 2); for (const row of pending) assert.deepEqual(JSON.parse(row.source_work_ids), ['source']);
  f.online(); f.denySource(); await f.host.work.retry(f.session.id);
  assert.equal(f.host.work.state(f.session.id).pending, 2); assert.match(f.host.work.state(f.session.id).error, /共享范围已变化/);
  assert.equal(f.sent.length, 2); for (const row of pending) assert.ok(!f.receipts.has(row.input_id));
});
