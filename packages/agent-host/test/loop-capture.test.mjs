import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { initialLoopDraft } from '../../../services/product-api/src/loops/initial-loop-draft.mjs';
import { Check } from '../../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';

const definition = { goal: '整理反馈', context: '团队反馈', constraints: ['不虚构依据'], doneWhen: ['按类整理'], verify: ['检查原话'], expectedResult: '反馈分类', stopRules: ['缺少资料时提问'] };
const document = () => ({ name: '反馈分类', description: '保留依据', definition, ...initialLoopDraft(), resourceRefs: [] });

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/turnsu-loop-capture-'), path = join(root, 'project'); await mkdir(path);
  let host, calls = [];
  const open = () => { host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => ({ ready: Promise.resolve(), closed: false, close: async () => {}, async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'native-loop-capture', turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'capture-turn' } };
    throw new Error(method);
  } }) }); };
  open(); const project = await host.command('project.open', { path }), source = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.db.prepare('INSERT INTO submissions VALUES(?,?,?,NULL,?)').run('source', source.id, 'PRIVATE_REQUEST', 'completed');
  host.message(source.id, 'private', 'user', 'PRIVATE_HISTORY'); host.message(source.id, 'answer', 'assistant', '逐条分类反馈，保留原文依据。');
  const input = { sessionId: source.id, messageId: 'answer', requestId: 'loop-one' };
  const task = await host.command('loopCapture.create', input);
  const folder = join(path, '.turnsu-loop-drafts/loop-one'); await mkdir(folder, { recursive: true });
  const file = join(folder, 'LOOP.json');
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path, project, source, input, task, file, calls, get host() { return host; }, async candidate(value = document()) { await writeFile(file, JSON.stringify(value, null, 2)); }, async reopen() { await host.close(); open(); } };
}

test('Loop capture keeps the selected answer local, preserves Agent choice, and validates a real bounded file', async t => {
  const f = await fixture(t);
  assert.equal(f.task.agent, 'codex'); assert.equal(f.task.sharedWork, null); assert.equal(f.calls.length, 0);
  assert.match(f.task.loopCapture.path, /LOOP.json$/);
  const prompt = (await f.host.command('draft.read', { projectId: f.project.id, sessionId: f.task.id })).text;
  assert.doesNotMatch(prompt, /JSON|PRIVATE_|LOOP.json/);
  await assert.rejects(f.host.command('loopCapture.preview', { sessionId: f.task.id }), /还没有写入/);
  await f.candidate(); const draft = await f.host.command('loopCapture.preview', { sessionId: f.task.id }); assert.deepEqual(draft.document, document());
  await f.reopen(); assert.equal((await f.host.command('loopCapture.create', f.input)).id, f.task.id);
  await assert.rejects(f.host.command('loopCapture.create', { ...f.input, messageId: 'private' }), /不同的工作/);
  await f.host.command('session.send', { sessionId: f.task.id, inputId: 'explicit-loop-prompt', text: prompt });
  const sent = f.calls.find(c => c.method === 'turn/start').params.input[0].text;
  assert.match(sent, /逐条分类反馈/); assert.match(sent, /LOOP.json/); assert.doesNotMatch(sent, /PRIVATE_/);
  f.host.updateSession(f.task.id, 'idle');
  await writeFile(f.file, '{broken'); await assert.rejects(f.host.loopCapture.preview(f.task.id), /完整 JSON/);
  await f.candidate({ name: 'missing graph' }); await assert.rejects(f.host.loopCapture.preview(f.task.id), /有效目标/);
  await f.candidate(); await rm(f.file); await writeFile(join(f.root, 'outside.json'), JSON.stringify(document())); await symlink(join(f.root, 'outside.json'), f.file);
  await assert.rejects(f.host.loopCapture.preview(f.task.id), /链接/);
});

test('private Loop transfer survives a lost accepted revision, local edits and restart without replacing the reviewed graph', async t => {
  const f = await fixture(t); await f.candidate(); const draft = await f.host.loopCapture.preview(f.task.id);
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'native' };
  let actor = 'owner', lose = true, latest = 'revision-initial', revoked = false, denySave = false; const accepted = new Map(), mutations = [];
  const cloud = { identity: async () => identity, viewer: async () => ({ userId: actor, workspaceId: identity.workspaceId }), close: async () => {}, async fileCall(current, name, input) {
    assert.deepEqual(current, identity); assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, input), name);
    if (revoked) throw Object.assign(new Error('revoked'), { status: 403 });
    if (name === 'turnsu_loop_draft') return { data: { workflowId: 'workflow-one', currentRevisionId: latest }, etag: '"workflow-one-1"' };
    if (name === 'turnsu_compile_loop') return { data: { status: 'blocked', warnings: [{ message: '模型未配置' }] } };
    if (name === 'turnsu_save_loop_draft' && denySave) throw Object.assign(new Error('invalid dependency'), { status: 422 });
    mutations.push(name);
    if (!accepted.has(input.idempotencyKey)) accepted.set(input.idempotencyKey, structuredClone(input));
    assert.deepEqual(accepted.get(input.idempotencyKey), input);
    if (name === 'turnsu_create_loop_draft') return { data: { workflow: { workflowId: 'workflow-one' }, revision: { revisionId: 'revision-initial' } } };
    assert.equal(name, 'turnsu_save_loop_draft'); latest = 'revision-saved';
    if (lose) { lose = false; throw new Error('accepted response lost'); }
    return { data: { workflow: { workflowId: 'workflow-one' }, revision: { revisionId: latest, ...input.data } } };
  } };
  f.host.cloud = cloud;
  const input = { sessionId: f.task.id, expectedHash: draft.hash, confirm: true };
  await assert.rejects(f.host.loopCapture.save({ ...input, confirm: false }), /确认保存/);
  await assert.rejects(f.host.loopCapture.save({ ...input, expectedHash: 'wrong' }), /已经变化/);
  assert.equal(mutations.length, 0);
  await assert.rejects(f.host.loopCapture.save(input), /尚未确认/);
  assert.equal(f.host.loopCapture.view(f.host.loopCapture.saved(f.task.id)).saved, false);
  assert.throws(() => f.host.loopCapture.reset(input), /不能丢弃/);
  await f.candidate({ ...document(), name: 'Changed local document' }); await f.reopen(); f.host.cloud = cloud;
  const saved = await f.host.loopCapture.save(input); assert.equal(saved.saved, true); assert.equal(accepted.size, 2);
  assert.deepEqual(saved.document, draft.document); assert.deepEqual(saved.draft.revision.graph, draft.document.graph);
  assert.equal((await f.host.loopCapture.check(f.task.id)).compilation.status, 'blocked');
  await f.candidate({ ...document(), definition: { ...definition, goal: '按主题整理反馈并核对来源' } });
  const update = await f.host.loopCapture.preview(f.task.id), updateInput = { ...input, expectedHash: update.hash, update: true };
  latest = 'revision-external';
  await assert.rejects(f.host.loopCapture.save(updateInput), /已有更新版本/);
  assert.equal(f.host.loopCapture.view(f.host.loopCapture.saved(f.task.id)).hash, draft.hash, 'stale cloud base preserves prior receipt and local edit');
  latest = 'revision-saved'; denySave = true;
  await assert.rejects(f.host.loopCapture.save(updateInput), /保存被拒绝/);
  assert.equal(f.host.loopCapture.view(f.host.loopCapture.saved(f.task.id)).canRestart, true);
  await f.reopen(); f.host.cloud = cloud;
  f.host.loopCapture.reset(updateInput);
  assert.equal(f.host.loopCapture.view(f.host.loopCapture.saved(f.task.id)).hash, draft.hash, 'definitively rejected update restores the earlier saved workflow after restart');
  assert.equal(f.host.loopCapture.view(f.host.loopCapture.saved(f.task.id)).saved, true);
  denySave = false;
  latest = 'revision-external'; await assert.rejects(f.host.loopCapture.check(f.task.id), /已有更新版本/);
  assert.equal((await f.host.loopCapture.cloudState(f.task.id)).saved.compilation, null, 'do not show old compilation as current after an external edit');
  actor = 'other'; await assert.rejects(f.host.loopCapture.save(input), /切回/); await assert.rejects(f.host.loopCapture.cloudState(f.task.id), /切回/);
  actor = 'owner'; revoked = true; await assert.rejects(f.host.loopCapture.save(input), /访问权限/);
});
