import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStore } from '../store.mjs';
import { WorkDecisions } from '../work-decisions.mjs';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';
import { Check } from '../../contracts/dist/index.js';

test('owner decision drafts and uncertain submissions survive restart without duplicating or changing an accepted decision', async t => {
  const root = await mkdtemp('/private/tmp/turnsu-decision-test-'); let store = openStore(root), actor = 'owner', lose = true;
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'login' }, accepted = new Map();
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('local', '/private/tmp/not-read', 'Project', 1);
  const cloud = { identity: async () => identity, async fileCall(binding, name, args) {
    assert.equal(name, 'turnsu_record_decision'); assert.deepEqual(binding, identity);
    assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(tool => tool.name === name).inputSchema, args));
    if (accepted.has(args.idempotencyKey)) assert.deepEqual(accepted.get(args.idempotencyKey), args.data);
    else accepted.set(args.idempotencyKey, args.data);
    if (lose) { lose = false; throw new Error('response lost'); }
    return { data: { decisionId: 'decision-one', ...args.data } };
  } };
  const make = () => new WorkDecisions({ db: store.db, cloud, projectBinding: () => ({ identity: JSON.stringify(identity) }), context: async () => ({ viewerUserId: actor, workItem: { accountableOwnerUserId: 'owner', members: [{ userId: actor, accessGrant: { access: actor === 'owner' ? 'owner' : 'contribute', status: 'active' } }] } }) });
  let decisions = make(); t.after(async () => { await decisions.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  let draft = await decisions.open({ projectId: 'local', workItemId: 'work' });
  const payload = { question: '先处理什么？', chosenOutcome: '先处理登录失败', rationale: '影响用户进入产品' };
  draft = await decisions.save({ id: draft.id, payload });
  await decisions.close(); store.close(); store = openStore(root); decisions = make();
  const reopened = await decisions.open({ projectId: 'local', workItemId: 'work' }); assert.equal(reopened.id, draft.id); assert.deepEqual(reopened.payload, payload);
  const request = { id: draft.id, expectedHash: draft.hash, confirm: true };
  await assert.rejects(decisions.submit({ ...request, confirm: false }), /负责人确认/);
  await assert.rejects(decisions.submit({ ...request, expectedHash: 'stale' }), /草稿内容/);
  assert.equal(accepted.size, 0);
  await assert.rejects(decisions.submit(request), /尚未确认/);
  await assert.rejects(decisions.save({ id: draft.id, payload: { ...payload, chosenOutcome: 'changed' } }), /已经提交/);
  await decisions.close(); store.close(); store = openStore(root); decisions = make();
  assert.equal((await decisions.status(draft.id)).status, 'pending');
  const done = await decisions.submit(request); assert.equal(done.status, 'done'); assert.equal(accepted.size, 1);
  assert.equal((await decisions.submit(request)).decision.decisionId, 'decision-one');
  actor = 'member'; await assert.rejects(decisions.open({ projectId: 'local', workItemId: 'work' }), /负责人/);
  await assert.rejects(decisions.submit(request), /负责人/); assert.equal(accepted.size, 1);
});
