import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openStore } from '../store.mjs';
import { WorkHandoffs } from '../work-handoffs.mjs';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';
import { Check } from '../../contracts/dist/index.js';

test('reviewed handoff preserves access and other roles, recovers a lost receipt after restart, and rejects stale or unauthorized changes', async t => {
  const root = await mkdtemp('/private/tmp/turnsu-handoff-test-'); let store = openStore(root), actor = 'owner', etag = '"work-v1"', lose = true, reject = false;
  store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('local', '/private/tmp/not-read', 'Project', 1);
  const members = [
    { userId: 'owner', roles: ['accountable_owner', 'requestor'], accessGrant: { access: 'owner', status: 'active' } },
    { userId: 'member', roles: ['participant'], accessGrant: { access: 'contribute', status: 'active' } },
    { userId: 'reviewer', roles: ['reviewer', 'assignee'], accessGrant: { access: 'contribute', status: 'active' } },
    { userId: 'reader', roles: ['watcher'], accessGrant: { access: 'read', status: 'active' } },
    { userId: 'revoked', roles: ['participant'], accessGrant: { access: 'contribute', status: 'revoked' } },
  ];
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'login' }, accepted = new Map();
  const cloud = { async fileCall(binding, name, args) {
    assert.deepEqual(binding, identity); assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, args));
    if (name === 'turnsu_work_people') return { data: members.map(m => ({ userId: m.userId, displayName: m.userId + ' 的名字', username: m.userId })) };
    assert.equal(name, 'turnsu_update_work');
    if (accepted.has(args.idempotencyKey)) { assert.deepEqual(accepted.get(args.idempotencyKey), args); return { data: { workItemId: 'work', ...args.data } }; }
    if (reject || args.ifMatch !== etag) throw Object.assign(new Error('conflict'), { status: 409 });
    accepted.set(args.idempotencyKey, structuredClone(args)); etag = '"work-v2"';
    if (lose) { lose = false; throw new Error('lost accepted response'); }
    return { data: { workItemId: 'work', ...args.data } };
  } };
  const make = () => new WorkHandoffs({ db: store.db, cloud, projectBinding: () => ({ identity: JSON.stringify(identity) }), context: async () => ({ etag, viewerUserId: actor, workItem: { status: 'active', accountableOwnerUserId: 'owner', members, nextAction: null } }) });
  let handoffs = make(); t.after(async () => { await handoffs.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const scope = { projectId: 'local', workItemId: 'work' };
  let draft = await handoffs.open(scope); assert.deepEqual(draft.people.map(p => p.userId), ['member', 'reviewer']);
  await assert.rejects(handoffs.save({ id: draft.id, recipientId: 'reader', nextAction: '请处理' }), /不会自动扩大/);
  await assert.rejects(handoffs.save({ id: draft.id, recipientId: 'revoked', nextAction: '请处理' }), /不会自动扩大/);
  draft = await handoffs.save({ id: draft.id, recipientId: 'member', nextAction: '补齐反馈分类' });
  await handoffs.close(); store.close(); store = openStore(root); handoffs = make();
  assert.deepEqual((await handoffs.open(scope)).payload, draft.payload);
  const input = { id: draft.id, expectedHash: draft.hash, confirm: true };
  await assert.rejects(handoffs.submit({ ...input, confirm: false }), /确认接手/);
  await assert.rejects(handoffs.submit({ ...input, expectedHash: 'changed' }), /内容已改变/);
  actor = 'member'; await assert.rejects(handoffs.submit(input), /切回/); actor = 'owner';
  assert.equal(accepted.size, 0);
  await assert.rejects(handoffs.submit(input), /尚未确认/);
  await assert.rejects(handoffs.save({ id: draft.id, recipientId: 'reviewer', nextAction: 'different' }), /已经提交/);
  const submitted = [...accepted.values()][0];
  assert.deepEqual(submitted.data, { nextAction: '补齐反馈分类', assigneeUserId: 'member' });
  await handoffs.close(); store.close(); store = openStore(root); handoffs = make();
  assert.equal((await handoffs.open(scope)).status, 'pending');
  assert.equal((await handoffs.submit(input)).status, 'done'); assert.equal(accepted.size, 1);
  assert.equal((await handoffs.submit(input)).workItem.nextAction, '补齐反馈分类');
  draft = await handoffs.open(scope);
  draft = await handoffs.save({ id: draft.id, recipientId: 'member', nextAction: '新的交接' });
  etag = '"work-v3"'; await assert.rejects(handoffs.submit({ id: draft.id, expectedHash: draft.hash, confirm: true }), /工作已被更新/);
  const refreshed = await handoffs.open(scope); assert.notEqual(refreshed.id, draft.id); assert.deepEqual(refreshed.payload, draft.payload);
  reject = true; await assert.rejects(handoffs.submit({ id: refreshed.id, expectedHash: refreshed.hash, confirm: true }), /未被接受/);
  assert.equal((await handoffs.status(refreshed.id)).status, 'rejected');
  assert.notEqual((await handoffs.open(scope)).id, refreshed.id);
  actor = 'member'; await assert.rejects(handoffs.open(scope), /负责人/);
  await assert.rejects(handoffs.status(refreshed.id), /切回/);
  assert.equal(accepted.size, 1);
});
