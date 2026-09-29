import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStore } from '../store.mjs';
import { MethodRelease } from '../method-release.mjs';
import { Check } from '../../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-method-release-'));
  let store, release, revision = 1, actor = 'owner', lose = null, replayDenied = false;
  const receipts = new Map(), trials = new Map(), identity = { origin: 'https://team.example.test', workspaceId: 'team', clientSessionId: 'native' };
  const calls = [];
  const cloud = { identity: async () => identity, viewer: async () => ({ userId: actor }),
    async fileCall(expected, name, input) {
      assert.deepEqual(expected, identity); assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, input), name);
      calls.push({ name, input });
      if (name === 'turnsu_skill_draft') return { data: { skillId: 'skill', skillDraftId: 'draft', revision, inputSchema: {} }, etag: `"draft-${revision}"` };
      if (name === 'turnsu_skill_test') return { data: structuredClone(trials.get(input.pathParams.testRunId)) };
      if (name === 'turnsu_skill_validation') return { data: { validationId: 'validation', status: 'passed' } };
      if (replayDenied) throw Object.assign(new Error('changed state after uncertain request'), { status: 409 });
      if (!receipts.has(input.idempotencyKey)) {
        let data;
        if (name === 'turnsu_test_skill') {
          const id = 'trial-' + (trials.size + 1); data = { testRunId: id, testCase: input.data.testCase, status: 'queued', outputPreview: null, completedAt: null, diagnostics: [] }; trials.set(id, structuredClone(data));
        } else if (name === 'turnsu_cancel_skill_test') { trials.get(input.pathParams.testRunId).status = 'cancelled'; data = input.pathParams.testRunId; }
        else if (name === 'turnsu_validate_skill') data = { validationId: 'validation', status: 'passed' };
        else if (name === 'turnsu_publish_skill') data = { version: { version: '1.0.0' }, release: { releaseId: 'release-one' } };
        else throw new Error(name);
        receipts.set(input.idempotencyKey, { data });
      }
      if (lose === name) { lose = null; throw new Error('lost response'); }
      return structuredClone(receipts.get(input.idempotencyKey));
    } };
  function open() {
    store = openStore(directory);
    release = new MethodRelease({ db: store.db, cloud, saved: sessionId => store.db.prepare('SELECT * FROM method_publications WHERE session_id=?').get(sessionId) });
  }
  open();
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project', directory, 'Project', Date.now());
  store.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at,agent) VALUES('session','project','Skill','idle',?,'codex')").run(Date.now());
  store.db.prepare('INSERT INTO method_publications(session_id,id,identity,actor,payload,receipts) VALUES(?,?,?,?,?,?)').run('session', 'publication', JSON.stringify(identity), 'owner', '{}', JSON.stringify({ created: { data: { skill: { skillId: 'skill' }, draft: { skillDraftId: 'draft', revision: 1 } } } }));
  t.after(async () => { await release.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get release() { return release; }, calls, receipts, trials,
    async reopen() { await release.close(); store.close(); open(); }, lose(name) { lose = name; }, denyReplay(value) { replayDenied = value; }, switchActor() { actor = 'other'; }, changeDraft() { revision++; },
    pass(id) { Object.assign(trials.get(id), { status: 'passed', outputPreview: { result: '完整试运行结果'.repeat(300), evidence: 'Additional evidence must remain visible' }, completedAt: '2026-09-23T00:00:00Z' }); } };
}
const trialRequest = { sessionId: 'session', requestId: 'test-one', kind: 'test', sample: '真实资料', purpose: '保留证据' };

test('trial uncertainty survives reopening; changed-state rejection cannot permit duplicate execution', async t => {
  const f = await fixture(t); f.lose('turnsu_test_skill');
  await assert.rejects(f.release.submit(trialRequest), /尚未确认/);
  const calls = f.calls.length; await f.reopen(); assert.equal(f.calls.length, calls);
  f.denyReplay(true); await assert.rejects(f.release.retry('test-one'), /尚未确认/);
  assert.equal((await f.release.state('session')).pending.length, 1);
  await assert.rejects(f.release.submit({ ...trialRequest, requestId: 'duplicate' }), /上次操作/);
  f.denyReplay(false); await f.release.retry('test-one');
  assert.equal(f.trials.size, 1);
  await assert.rejects(f.release.submit({ ...trialRequest, requestId: 'while-running' }), /尚未结束/);
  await f.release.submit({ sessionId: 'session', requestId: 'cancel', kind: 'cancel', testRunId: 'trial-1' });
  assert.equal((await f.release.state('session')).trials[0].status, 'cancelled');
});

test('publication binds reviewed output and exact draft, and lost receipts resume one release', async t => {
  const f = await fixture(t); await f.release.submit(trialRequest); f.pass('trial-1');
  const state = await f.release.state('session');
  assert.ok(state.trials[0].outputPreview.result.length > 1000);
  const publish = { sessionId: 'session', requestId: 'publish-one', kind: 'publish', testRunId: 'trial-1', confirm: true, reviewedOutputHash: state.trials[0].reviewedOutputHash };
  await assert.rejects(f.release.submit({ ...publish, confirm: false }), /完整试运行结果/);
  await assert.rejects(f.release.submit({ ...publish, reviewedOutputHash: 'different' }), /完整试运行结果/);
  f.lose('turnsu_publish_skill'); await assert.rejects(f.release.submit(publish), /尚未确认/);
  const mutations = f.receipts.size; await f.reopen(); await f.release.retry('publish-one');
  assert.equal(f.receipts.size, mutations);
  assert.equal((await f.release.state('session')).published.release.releaseId, 'release-one');
  f.switchActor(); await assert.rejects(f.release.retry('publish-one'), /保存这份草稿的团队账户/);
});

test('changing the cloud draft invalidates a previous trial and blocks unreviewed execution', async t => {
  const f = await fixture(t); await f.release.submit(trialRequest); f.pass('trial-1');
  const before = await f.release.state('session'); f.changeDraft();
  assert.equal((await f.release.state('session')).trials[0].currentDraft, false);
  await assert.rejects(f.release.submit({ sessionId: 'session', requestId: 'publish', kind: 'publish', testRunId: 'trial-1', confirm: true, reviewedOutputHash: before.trials[0].reviewedOutputHash }), /草稿已经变化/);
  await assert.rejects(f.release.submit({ ...trialRequest, requestId: 'new-test' }), /本次预览不再一致/);
  assert.equal(f.receipts.size, 1);
});
