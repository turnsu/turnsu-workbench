import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { Check, ReviseProjectMembersDataSchema } from '../../contracts/dist/index.js';
const method = action => 'cloud.projectMembers.' + action;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-members-'));
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'native' };
  const people = ['owner', 'alice', 'bob'].map(userId => ({ userId, displayName: userId, username: userId }));
  let actor = 'owner', version = 1, lose = false, deny = false, host;
  let project = { projectId: 'project', workspaceId: 'workspace', accountableOwnerUserId: 'owner', title: '合作项目', members: [{ userId: 'owner', role: 'owner' }, { userId: 'alice', role: 'member' }] };
  const calls = [], accepted = new Map();
  const cloud = { ready: Promise.resolve(), close: async () => {}, identity: async () => ({ ...identity }), viewer: async () => ({ userId: actor, workspaceId: identity.workspaceId }),
    async fileCall(bound, name) { assert.deepEqual(bound, identity); if (name === 'turnsu_work_people') return { data: structuredClone(people) }; assert.equal(name, 'turnsu_project'); return { data: structuredClone(project), etag: 'version-' + version }; },
    async desktopCall(bound, name, input) {
      assert.deepEqual(bound, identity); assert.equal(name, 'reviseProjectMembers'); assert.ok(Check(ReviseProjectMembersDataSchema, input.data)); calls.push(structuredClone(input));
      if (deny) throw Object.assign(new Error('forbidden'), { status: 403 });
      if (accepted.has(input.idempotencyKey)) { assert.deepEqual(input, accepted.get(input.idempotencyKey).input); return accepted.get(input.idempotencyKey).response; }
      if (input.ifMatch !== 'version-' + version) throw Object.assign(new Error('stale'), { status: 412 });
      project = { ...project, members: [{ userId: 'owner', role: 'owner' }, ...input.data.members.map(m => ({ ...m, role: 'member' }))] }; version++;
      const response = { data: structuredClone(project), etag: 'version-' + version }; accepted.set(input.idempotencyKey, { input: structuredClone(input), response });
      if (lose) { lose = false; throw new Error('receipt lost'); } return response;
    } };
  function open() { host = new LocalAgentHost({ directory: join(directory, 'state'), connectionFactory: () => assert.fail('no Agent for member changes') }); host.cloud = cloud; }
  open(); t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  return { get host() { return host; }, calls, accepted, identity, get project() { return project; }, lose() { lose = true; }, deny() { deny = true; }, actor(value) { actor = value; }, concurrent() { version++; project.members.push({ userId: 'bob', role: 'member' }); }, async reopen() { await host.close(); open(); } };
}
async function draft(f, memberIds = ['bob']) {
  const opened = await f.host.command(method('open'), { projectId: 'project' });
  return f.host.command(method('save'), { id: opened.id, memberIds });
}
const submit = (f, saved, overrides = {}) => f.host.command(method('submit'), { id: saved.id, expectedHash: saved.hash, confirm: true, ...overrides });

test('member changes preserve the exact reviewed audience across a lost response and reopening', async t => {
  const f = await fixture(t), saved = await draft(f); assert.deepEqual(f.project.members.map(m => m.userId), ['owner', 'alice']);
  f.lose(); await assert.rejects(submit(f, saved), /尚未确认/);
  await assert.rejects(f.host.command(method('save'), { id: saved.id, memberIds: [] }), /已经提交/);
  await f.reopen(); const restored = await f.host.command(method('open'), { projectId: 'project' });
  assert.equal(restored.id, saved.id); assert.equal(restored.status, 'pending'); assert.deepEqual(restored.data.members, [{ userId: 'bob' }]);
  const result = await submit(f, restored); assert.equal(result.status, 'done'); assert.deepEqual(result.receipt.members.map(m => m.userId), ['owner', 'bob']);
  assert.equal(f.accepted.size, 1); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.host.snapshot({ projectId: f.project.id }).sessions.length, 0);
});

test('concurrent membership edits require a fresh review rather than overwriting the other change', async t => {
  const f = await fixture(t), saved = await draft(f, []); f.concurrent();
  await assert.rejects(submit(f, saved), /其他人修改/); assert.equal(f.accepted.size, 0);
  const fresh = await f.host.command(method('open'), { projectId: 'project' });
  assert.notEqual(fresh.id, saved.id); assert.deepEqual(fresh.data.members.map(m => m.userId), ['alice', 'bob']);
  assert.equal(fresh.status, 'draft'); assert.notEqual(fresh.ifMatch, saved.ifMatch);
});

test('confirmation binds the reviewed list and original account; later denial never creates another request', async t => {
  const f = await fixture(t), saved = await draft(f);
  await assert.rejects(submit(f, saved, { confirm: false }), /确认/);
  await assert.rejects(submit(f, saved, { expectedHash: 'stale' }), /名单已变化/);
  await assert.rejects(f.host.command(method('save'), { id: saved.id, memberIds: ['stranger'] }), /已不在/);
  await assert.rejects(f.host.command(method('save'), { id: saved.id, memberIds: ['owner'] }), /负责人/);
  assert.equal(f.calls.length, 0); f.lose(); await assert.rejects(submit(f, saved));
  f.actor('alice'); await assert.rejects(submit(f, saved), /原团队账户/); assert.equal(f.calls.length, 1);
  f.actor('owner'); f.identity.clientSessionId = 'reconnected'; f.deny(); await assert.rejects(submit(f, saved), /管理权限/);
  await f.reopen(); const restored = await f.host.command(method('open'), { projectId: 'project' }); assert.equal(restored.id, saved.id); assert.equal(restored.status, 'pending');
  assert.equal(f.accepted.size, 1);
});
