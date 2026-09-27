import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStore } from '../store.mjs';
import { WorkResults } from '../work-results.mjs';

async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/turnsu-result-actions-');
  let store = openStore(directory), actor = 'owner', etag = '"version-one"', lose = false;
  const accepted = new Map(), calls = [], identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'device' };
  const work = { get db() { return store.db; }, async context() { return { etag, viewerUserId: actor, workItem: { workItemId: 'work', accountableOwnerUserId: 'owner', members: [{ userId: actor, accessGrant: { status: 'active', access: actor === 'owner' ? 'owner' : 'contribute' } }] } }; }, cloud: {
    identity: async () => ({ ...identity }), async desktopCall(bound, operation, input) {
      assert.deepEqual(bound, identity); calls.push(structuredClone(input));
      if (accepted.has(input.idempotencyKey)) { assert.deepEqual(input, accepted.get(input.idempotencyKey).input); return accepted.get(input.idempotencyKey).response; }
      assert.equal(input.ifMatch, etag); etag = '"version-two"';
      const response = { data: { workItem: { workItemId: 'work', status: 'completed' } }, etag };
      accepted.set(input.idempotencyKey, { input: structuredClone(input), response });
      if (lose) { lose = false; throw new Error('receipt lost after commit'); }
      return response;
    },
  } };
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('local', '/private/tmp/not-used', 'local', 1);
  let service = new WorkResults(work);
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get service() { return service; }, accepted, calls, identity, setActor(value) { actor = value; }, lose() { lose = true; }, advance() { etag = '"changed"'; }, async reopen() { await service.close(); store.close(); store = openStore(directory); service = new WorkResults(work); } };
}
const review = { projectId: 'local', workItemId: 'work', actionId: 'review-one', kind: 'accept', entryId: 'result-entry', contentHash: 'sha256:' + 'a'.repeat(64), submissionId: 'submission-one', etag: '"version-one"', feedback: '已核对结果', confirm: true };

test('acceptance receipt loss survives desktop restart without changing the reviewed result or original version', async t => {
  const f = await fixture(t); f.lose();
  await assert.rejects(f.service.submit(review), /尚未确认/);
  assert.equal((await f.service.state(review)).actions.length, 1);
  await assert.rejects(f.service.submit({ ...review, actionId: 'second-action' }), /先核对原提交/);
  await f.reopen();
  assert.equal((await f.service.state(review)).actions[0].data.feedback, review.feedback);
  await f.service.submit({ projectId: 'local', workItemId: 'work', kind: 'accept', actionId: 'review-one', confirm: true, retry: true });
  assert.equal(f.accepted.size, 1); assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal((await f.service.state(review)).actions.length, 0);
});

test('a stale result, unconfirmed click, contributor approval, or empty revision request cannot be submitted', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.submit({ ...review, confirm: false }), /明确确认/);
  await assert.rejects(f.service.submit({ ...review, kind: 'request_changes', feedback: ' ' }), /要改什么/);
  f.setActor('member'); await assert.rejects(f.service.submit(review), /负责人/);
  f.setActor('owner'); f.advance(); await assert.rejects(f.service.submit(review), /已更新/);
  assert.equal(f.calls.length, 0);
});

test('another account cannot discover or replay a pending acceptance, but the same member may reconnect', async t => {
  const f = await fixture(t); f.lose(); await assert.rejects(f.service.submit(review));
  f.setActor('another-member'); f.identity.clientSessionId = 'different-login';
  assert.equal((await f.service.state(review)).actions.length, 0);
  await assert.rejects(f.service.submit({ ...review, retry: true }), /切回/);
  f.setActor('owner'); f.identity.clientSessionId = 'owner-reconnected';
  await f.service.submit({ ...review, retry: true }); assert.equal(f.accepted.size, 1);
});
