import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAgentHost } from '../host.mjs';

// Actual local SQLite and directories through native authenticated Product HTTP/PostgreSQL.
export async function verifyDesktopProjectMembersFlow({ directory, owner, member, memberUserId, pool }) {
  const created = await owner.desktopCall(await owner.identity(), 'createProject', { data: { title: '桌面成员调整验收', objective: '由负责人明确调整共享范围', members: [{ userId: memberUserId }] }, idempotencyKey: randomUUID() });
  const projectId = created.data.projectId, data = join(directory, 'project-members-owner-state');
  const path = join(directory, 'project-members-owner'), peerPath = join(directory, 'project-members-peer'); await mkdir(path); await mkdir(peerPath);
  const attempts = []; let lose = true;
  function open(state, client, drop = false) {
    const host = new LocalAgentHost({ directory: state, connectionFactory: () => assert.fail('membership must not invoke a model') });
    host.cloud = { identity: (...args) => client.identity(...args), viewer: (...args) => client.viewer(...args), fileCall: (...args) => client.fileCall(...args), close: async () => {},
      async desktopCall(...args) { attempts.push(structuredClone(args)); const response = await client.desktopCall(...args); if (drop && lose) { lose = false; throw new Error('lost membership receipt'); } return response; } };
    if (host.shared) host.shared.cloud = host.cloud;
    return host;
  }
  let a = open(data, owner, true), b = open(join(directory, 'project-members-peer-state'), member);
  try {
    const local = await a.command('project.open', { path }), peer = await b.command('project.open', { path: peerPath });
    await a.command('sync.attach', { projectId: local.id, remoteId: projectId });
    await writeFile(join(path, 'shared.md'), '撤权前已经共享的资料'); await a.command('sync.retry', { projectId: local.id });
    await b.command('sync.attach', { projectId: peer.id, remoteId: projectId }); await b.command('sync.retry', { projectId: peer.id });
    assert.equal(await readFile(join(peerPath, 'shared.md'), 'utf8'), '撤权前已经共享的资料');
    const opened = await a.command('cloud.projectMembers.open', { projectId });
    assert.ok(opened.project.members.some(person => person.userId === memberUserId));
    const saved = await a.command('cloud.projectMembers.save', { id: opened.id, memberIds: [] });
    const args = { id: saved.id, expectedHash: saved.hash, confirm: true };
    await assert.rejects(a.command('cloud.projectMembers.submit', args), /尚未确认/);
    await a.close(); a = open(data, owner);
    const restored = await a.command('cloud.projectMembers.open', { projectId }); assert.equal(restored.id, saved.id); assert.equal(restored.status, 'pending');
    const receipt = await a.command('cloud.projectMembers.submit', args);
    assert.equal(receipt.status, 'done'); assert.deepEqual(attempts[0], attempts[1]); assert.equal(receipt.receipt.members.length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_lifecycle_events WHERE project_id=$1 AND kind='project_members_revise'", [projectId])).rows[0].n, 1);
    await assert.rejects(member.fileCall(await member.identity(), 'turnsu_project_files', { pathParams: { projectId } }), error => [403, 404].includes(error.status));
    await writeFile(join(path, 'shared.md'), '仅剩余成员可见的新资料'); await a.command('sync.retry', { projectId: local.id });
    await b.command('sync.retry', { projectId: peer.id });
    assert.equal(await readFile(join(peerPath, 'shared.md'), 'utf8'), '撤权前已经共享的资料', 'revocation cannot erase already downloaded bytes or download new content');
    const next = await a.command('cloud.projectMembers.open', { projectId }); assert.notEqual(next.id, saved.id);
    const add = await a.command('cloud.projectMembers.save', { id: next.id, memberIds: [memberUserId] });
    await a.command('cloud.projectMembers.submit', { id: add.id, expectedHash: add.hash, confirm: true });
    const visible = await member.fileCall(await member.identity(), 'turnsu_project', { pathParams: { projectId } });
    assert.ok(visible.data.members.some(person => person.userId === memberUserId));
  } finally { await a.close(); await b.close(); }
}
