import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { Check, CreateProjectDataSchema } from '../../../../backend/code/workbench-contracts/dist/index.js';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/turnsu-project-creation-'), directory = join(root, 'state'), path = join(root, 'local'); await mkdir(path);
  const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', clientSessionId: 'native' };
  const people = [{ userId: 'alice', displayName: '小艾', username: 'alice' }, { userId: 'bob', displayName: '小博', username: 'bob' }];
  let actor = 'owner', lose = false, deny = false, host; const accepted = new Map(), calls = [];
  const cloud = { ready: Promise.resolve(), identity: async () => ({ ...identity }), viewer: async () => ({ userId: actor, workspaceId: identity.workspaceId }), close: async () => {},
    async fileCall(bound, name) { assert.deepEqual(bound, identity); assert.equal(name, 'turnsu_work_people'); return { data: structuredClone(people) }; },
    async desktopCall(bound, name, request) {
      assert.deepEqual(bound, identity); assert.equal(name, 'createProject'); assert.ok(Check(CreateProjectDataSchema, request.data)); calls.push(structuredClone(request));
      if (deny) throw Object.assign(new Error('forbidden'), { status: 403 });
      if (accepted.has(request.idempotencyKey)) { assert.deepEqual(request, accepted.get(request.idempotencyKey).request); return accepted.get(request.idempotencyKey).response; }
      const response = { data: { projectId: `project-${accepted.size}`, workspaceId: identity.workspaceId, accountableOwnerUserId: actor, ...request.data } };
      accepted.set(request.idempotencyKey, { request: structuredClone(request), response });
      if (lose) { lose = false; throw new Error('lost response'); } return response;
    } };
  function open() { host = new LocalAgentHost({ directory, connectionFactory: () => assert.fail('project creation must not invoke an Agent') }); host.cloud = cloud; }
  open(); const project = await host.command('project.open', { path });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, project, calls, accepted, identity, people, actor(value) { actor = value; }, deny() { deny = true; }, lose() { lose = true; }, async reopen() { await host.close(); open(); } };
}
const method = action => 'cloud.projectCreation.' + action;
async function draft(f) {
  const opened = await f.host.command(method('open'), { localProjectId: f.project.id });
  assert.equal(opened.data.title, 'local');
  return f.host.command(method('save'), { id: opened.id, title: '客户反馈', objective: '一起整理反馈', memberIds: ['alice'] });
}

test('reviewed project creation survives a lost receipt and restart with one project and the exact selected members', async t => {
  const f = await fixture(t), saved = await draft(f); assert.equal(f.accepted.size, 0);
  f.lose(); const args = { id: saved.id, expectedHash: saved.hash, confirm: true };
  await assert.rejects(f.host.command(method('submit'), args), /尚未确认/);
  await assert.rejects(f.host.command(method('save'), { id: saved.id, title: '另一个项目', objective: '', memberIds: [] }), /已经提交/);
  await f.reopen(); const reopened = await f.host.command(method('open'), { localProjectId: f.project.id });
  assert.equal(reopened.id, saved.id); assert.equal(reopened.status, 'pending'); assert.equal(reopened.selectedPeople[0].displayName, '小艾');
  const result = await f.host.command(method('submit'), args);
  assert.equal(result.status, 'done'); assert.equal(f.accepted.size, 1); assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(result.project.members, [{ userId: 'alice' }]);
  assert.equal(f.host.snapshot().projects[0].sharing, null); assert.equal(f.host.snapshot().sessions.length, 0);
});

test('stale review, unconfirmed creation and out-of-directory members cannot submit a project', async t => {
  const f = await fixture(t), saved = await draft(f);
  await assert.rejects(f.host.command(method('submit'), { id: saved.id, expectedHash: saved.hash }), /确认创建/);
  await assert.rejects(f.host.command(method('save'), { id: saved.id, title: '客户反馈', objective: '', memberIds: ['stranger'] }), /成员已不在/);
  await f.host.command(method('save'), { id: saved.id, title: '新名称', objective: '', memberIds: [] });
  await assert.rejects(f.host.command(method('submit'), { id: saved.id, expectedHash: saved.hash, confirm: true }), /草稿已变化/);
  assert.equal(f.calls.length, 0);
});

test('another account cannot retry a pending project and later denial cannot turn an uncertain commit into a new creation', async t => {
  const f = await fixture(t), saved = await draft(f); f.lose();
  const args = { id: saved.id, expectedHash: saved.hash, confirm: true };
  await assert.rejects(f.host.command(method('submit'), args)); f.actor('another');
  await assert.rejects(f.host.command(method('status'), { id: saved.id }), /切回/);
  await assert.rejects(f.host.command(method('submit'), args), /切回/); assert.equal(f.calls.length, 1);
  f.actor('owner'); f.identity.clientSessionId = 'reconnected'; f.deny();
  await assert.rejects(f.host.command(method('submit'), args), /管理员/);
  const next = await f.host.command(method('open'), { localProjectId: f.project.id });
  assert.equal(next.id, saved.id); assert.equal(next.status, 'pending'); assert.equal(next.data.title, saved.data.title);
  assert.equal(f.accepted.size, 1);
});

test('a definitive first-attempt rejection preserves the draft for a new reviewed request', async t => {
  const f = await fixture(t), saved = await draft(f); f.deny();
  await assert.rejects(f.host.command(method('submit'), { id: saved.id, expectedHash: saved.hash, confirm: true }), /管理员/);
  const next = await f.host.command(method('open'), { localProjectId: f.project.id });
  assert.notEqual(next.id, saved.id); assert.equal(next.status, 'draft'); assert.equal(next.data.title, saved.data.title);
  assert.equal(f.accepted.size, 0);
});
