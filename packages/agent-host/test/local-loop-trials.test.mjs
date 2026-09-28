import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { initialLoopDraft } from '../../../services/product-api/src/loops/initial-loop-draft.mjs';
import { Check } from '../../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/turnsu-local-loop-trial-'), path = join(root, 'project'); await mkdir(path);
  let host; const calls = [];
  const open = () => { host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => ({ ready: Promise.resolve(), closed: false, close: async () => {}, async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'private-native-thread', turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'native-turn' } };
    throw new Error(method);
  } }) }); };
  open(); const project = await host.command('project.open', { path }), source = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.db.prepare('INSERT INTO submissions VALUES(?,?,?,NULL,?)').run('source', source.id, 'PRIVATE_ORIGINAL_REQUEST', 'completed');
  host.message(source.id, 'answer', 'assistant', '整理反馈并核对来源');
  const capture = await host.command('loopCapture.create', { sessionId: source.id, messageId: 'answer', requestId: 'loop-trial' });
  const folder = join(path, '.turnsu-loop-drafts/loop-trial'); await mkdir(folder, { recursive: true });
  const file = join(folder, 'LOOP.json');
  const document = { name: '反馈流程', description: '人工核对反馈', definition: { goal: '保留来源并整理反馈', context: '', constraints: [], doneWhen: ['保留原文'], verify: ['逐条核对'], expectedResult: '反馈报告', stopRules: [] }, ...initialLoopDraft(), resourceRefs: [] };
  // Serialization/admission fixture, not a claim that Input -> Output performs feedback synthesis.
  await writeFile(file, JSON.stringify(document));
  const preview = await host.command('loopCapture.preview', { sessionId: capture.id });
  const input = { sessionId: capture.id, expectedHash: preview.hash, requestId: 'trial-one' };
  const trial = await host.command('localLoopTrial.create', input);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, file, document, capture, preview, input, trial, calls, get host() { return host; },
    async reopen() { await host.close(); open(); },
    async complete() {
      await host.command('session.send', { sessionId: trial.id, inputId: 'trial-input', text: 'PRIVATE_TRIAL_INPUT 请处理资料' });
      host.onEvent({ method: 'item/completed', params: { threadId: 'private-native-thread', item: { id: 'final', type: 'agentMessage', text: '原文：需要共享结果。归类：团队协作。已核对来源。' } } });
      host.onEvent({ method: 'turn/completed', params: { threadId: 'private-native-thread', turn: { id: 'native-turn', status: 'completed' } } });
    } };
}

test('local Loop trial is a private pinned native task and needs no cloud or model at preparation', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0); assert.equal(f.host.cloud, undefined);
  assert.equal(f.trial.agent, 'codex'); assert.equal(f.trial.sharedWork, null); assert.equal(f.trial.localLoopTrial.name, f.document.name);
  assert.throws(() => f.host.localLoopTrials.review(f.trial.id), /请等 Agent 完成/);
  await writeFile(f.file, JSON.stringify({ ...f.document, definition: { ...f.document.definition, goal: 'CHANGED_UNREVIEWED_RECIPE' } }));
  await f.reopen(); assert.equal((await f.host.command('localLoopTrial.create', f.input)).id, f.trial.id);
  await f.complete();
  const prompt = f.calls.find(c => c.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /保留来源并整理反馈/); assert.doesNotMatch(prompt, /PRIVATE_ORIGINAL_REQUEST|CHANGED_UNREVIEWED_RECIPE/);
  const review = f.host.localLoopTrials.review(f.trial.id); assert.match(review.output, /已核对来源/);
  assert.deepEqual(review.criteria, { goal: f.document.definition.goal, expectedResult: '反馈报告', doneWhen: ['保留原文'], verify: ['逐条核对'] });
  assert.doesNotMatch(JSON.stringify(review.criteria), /CHANGED_UNREVIEWED_RECIPE/);
  assert.doesNotMatch(JSON.stringify(review), /private-native-thread|PRIVATE_TRIAL_INPUT|project/);
  f.host.updateSession(f.trial.id, 'interrupted'); assert.throws(() => f.host.localLoopTrials.review(f.trial.id), /中断或失败/);
});

test('reviewed local trial delivery freezes output, stays version-bound, survives restart and never reruns Agent', async t => {
  const f = await fixture(t); await f.complete();
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'native' };
  let actor = 'owner', latest = 'initial', lose = true; const records = new Map();
  const cloud = { close: async () => {}, identity: async () => identity, viewer: async () => ({ userId: actor, workspaceId: 'workspace' }), async fileCall(current, name, input) {
    assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, input), name);
    if (name === 'turnsu_loop_draft') return { data: { workflowId: 'workflow', currentRevisionId: latest }, etag: '"workflow-1"' };
    if (name === 'turnsu_create_loop_draft') return { data: { workflow: { workflowId: 'workflow' }, revision: { revisionId: 'initial' } } };
    if (name === 'turnsu_save_loop_draft') { latest = 'saved'; return { data: { workflow: { workflowId: 'workflow' }, revision: { revisionId: 'saved', contentHash: 'sha256:' + 'a'.repeat(64), ...input.data } } }; }
    assert.equal(name, 'turnsu_record_local_loop_trial');
    if (!records.has(input.idempotencyKey)) records.set(input.idempotencyKey, structuredClone(input));
    assert.deepEqual(records.get(input.idempotencyKey), input);
    if (lose) { lose = false; throw new Error('accepted receipt lost'); }
    return { data: { provenance: 'member_attested_local', cloudReady: false } };
  } };
  f.host.cloud = cloud;
  await f.host.command('loopCapture.save', { sessionId: f.capture.id, expectedHash: f.preview.hash, confirm: true });
  const review = await f.host.command('localLoopTrial.review', { sessionId: f.trial.id });
  const input = { sessionId: f.trial.id, reviewedHash: review.reviewedHash, inputSummary: '合成的团队反馈', reviewNote: '已逐项核对来源与分类', confirm: true };
  await assert.rejects(f.host.command('localLoopTrial.record', { ...input, reviewedHash: 'stale' }), /结果已经变化/);
  await assert.rejects(f.host.command('localLoopTrial.record', input), /尚未确认/);
  f.host.message(f.trial.id, f.trial.id + ':final', 'assistant', 'NEW_OUTPUT_MUST_NOT_REPLACE_REVIEW');
  const nativeCount = f.calls.length;
  await f.reopen(); f.host.cloud = cloud;
  actor = 'other'; await assert.rejects(f.host.command('localLoopTrial.record', { sessionId: f.trial.id, retry: true }), /切回/);
  actor = 'owner'; const saved = await f.host.command('localLoopTrial.record', { sessionId: f.trial.id, retry: true });
  assert.equal(saved.saved, true); assert.equal(records.size, 1); assert.equal(f.calls.length, nativeCount);
  assert.equal(saved.output, review.output);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /PRIVATE_ORIGINAL_REQUEST|PRIVATE_TRIAL_INPUT|private-native-thread|NEW_OUTPUT_MUST_NOT_REPLACE_REVIEW/);
});

test('native publication preserves exact reviewed version and team across restart and uncertain delivery', async t => {
  const f = await fixture(t); await f.complete();
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'native' };
  let actor = 'owner', latest = 'initial', lose = true, duplicate = true; const records = [];
  const receipt = { trialId: 'cloud-trial', workflowId: 'workflow', workflowRevisionId: 'saved', revisionContentHash: 'sha256:' + 'a'.repeat(64) };
  const cloud = { close: async () => {}, identity: async () => identity, viewer: async () => ({ userId: actor, workspaceId: identity.workspaceId }), async fileCall(_identity, name, input) {
    assert.equal(Check(NATIVE_PRODUCT_TOOLS.find(tool => tool.name === name).inputSchema, input), true, name);
    if (name === 'turnsu_loop_draft') return { data: { currentRevisionId: latest }, etag: '"workflow-1"' };
    if (name === 'turnsu_create_loop_draft') return { data: { workflow: { workflowId: 'workflow' }, revision: { revisionId: 'initial' } } };
    if (name === 'turnsu_save_loop_draft') { latest = 'saved'; return { data: { workflow: { workflowId: 'workflow' }, revision: { revisionId: 'saved', contentHash: receipt.revisionContentHash, ...input.data } } }; }
    if (name === 'turnsu_record_local_loop_trial') return { data: receipt };
    assert.equal(name, 'turnsu_publish_native_loop');
    if (duplicate) throw Object.assign(new Error('native_loop_version_exists'), { status: 409, code: 'native_loop_version_exists' });
    records.push(structuredClone(input));
    if (lose) { lose = false; throw new Error('accepted response lost'); }
    return { data: { release: { releaseId: 'native-release' } } };
  } };
  f.host.cloud = cloud;
  await f.host.command('loopCapture.save', { sessionId: f.capture.id, expectedHash: f.preview.hash, confirm: true });
  const review = await f.host.command('localLoopTrial.review', { sessionId: f.trial.id });
  await f.host.command('localLoopTrial.record', { sessionId: f.trial.id, reviewedHash: review.reviewedHash, inputSummary: '原资料摘要', reviewNote: '私人试做确认', confirm: true });
  const input = { sessionId: f.trial.id, version: '1.0.0', releaseNotes: '团队可见说明', confirm: true };
  await assert.rejects(f.host.command('localLoopTrial.publish', { ...input, confirm: false }), /确认发布/);
  await assert.rejects(f.host.command('localLoopTrial.publish', input), /这个版本已发布/);
  await f.reopen(); f.host.cloud = cloud;
  assert.equal((await f.host.command('localLoopTrial.publication', { sessionId: f.trial.id })).canChangeVersion, true);
  await assert.rejects(f.host.command('localLoopTrial.changeVersion', { sessionId: f.trial.id, expectedVersion: 'unseen-version' }), /未知结果/);
  await f.host.command('localLoopTrial.changeVersion', { sessionId: f.trial.id, expectedVersion: '1.0.0' });
  duplicate = false; input.version = '1.0.1';
  await assert.rejects(f.host.command('localLoopTrial.publish', input), /尚未确认发布/);
  await f.reopen(); f.host.cloud = cloud;
  const before = f.calls.length;
  await assert.rejects(f.host.command('localLoopTrial.changeVersion', { sessionId: f.trial.id, expectedVersion: '1.0.1' }), /未知结果/);
  actor = 'other'; await assert.rejects(f.host.command('localLoopTrial.publish', { sessionId: f.trial.id, retry: true }), /切回/);
  actor = 'owner';
  await assert.rejects(f.host.command('localLoopTrial.publish', { ...input, version: '2.0.0' }), /固定记录/);
  const result = await f.host.command('localLoopTrial.publish', { sessionId: f.trial.id, retry: true });
  assert.equal(result.published, true); assert.equal(result.version, '1.0.1'); assert.equal(f.calls.length, before);
  assert.deepEqual(records[0], records[1]); assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_|原资料摘要|私人试做确认|原文：/);
});
