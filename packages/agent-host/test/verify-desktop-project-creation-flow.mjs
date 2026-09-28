import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

// Actual host/SQLite -> native-auth Product -> PostgreSQL. Creating/sharing invokes no model.
export async function verifyDesktopProjectCreationFlow({ directory, owner, member, memberUserId, pool }) {
  const path = join(directory, 'create-project-source'), peerPath = join(directory, 'create-project-peer');
  await mkdir(path); await mkdir(join(path, 'deliverables')); await mkdir(peerPath);
  await writeFile(join(path, 'deliverables/result.md'), '已有本地成果'); await writeFile(join(path, 'private.md'), 'PRIVATE_BEFORE_TEAM_CREATION');
  const data = join(directory, 'create-project-source-state'); const attempts = []; let lose = true, createdId;
  function open(state, client, drop = false) {
    const host = new LocalAgentHost({ directory: state, connectionFactory: () => assert.fail('project creation cannot run an Agent') });
    host.cloud = { identity: (...args) => client.identity(...args), viewer: (...args) => client.viewer(...args), fileCall: (...args) => client.fileCall(...args), close: async () => {},
      async desktopCall(...args) {
        attempts.push(structuredClone(args)); const result = await client.desktopCall(...args); createdId ||= result.data.projectId;
        if (drop && lose) { lose = false; throw new Error('commit succeeded but response was lost'); } return result;
      } };
    if (host.shared) host.shared.cloud = host.cloud;
    return host;
  }
  let a = open(data, owner, true), b = open(join(directory, 'create-project-peer-state'), member);
  try {
    const project = await a.command('project.open', { path }), privateTask = await a.command('session.create', { projectId: project.id, agent: 'codex' });
    a.message(privateTask.id, 'private-before-create', 'assistant', 'PRIVATE_NATIVE_HISTORY_BEFORE_CREATION');
    const opened = await a.command('cloud.projectCreation.open', { localProjectId: project.id });
    assert.ok(opened.people.some(person => person.userId === memberUserId));
    const saved = await a.command('cloud.projectCreation.save', { id: opened.id, title: '桌面直接创建并共享', objective: '一起核对已有成果', memberIds: [memberUserId] });
    const input = { id: saved.id, expectedHash: saved.hash, confirm: true };
    await assert.rejects(a.command('cloud.projectCreation.submit', input), /尚未确认/);
    await a.close(); a = open(data, owner);
    const restored = await a.command('cloud.projectCreation.open', { localProjectId: project.id });
    assert.equal(restored.id, saved.id); assert.equal(restored.status, 'pending');
    const receipt = await a.command('cloud.projectCreation.submit', input);
    assert.equal(receipt.project.projectId, createdId); assert.deepEqual(attempts[0], attempts[1]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE title=$1 AND workspace_id=$2', [receipt.project.title, receipt.project.workspaceId])).rows[0].n, 1);
    assert.equal((await member.fileCall(await member.identity(), 'turnsu_project', { pathParams: { projectId: createdId } })).data.title, receipt.project.title);
    assert.equal(a.snapshot().projects[0].sharing, null);
    assert.equal((await member.fileCall(await member.identity(), 'turnsu_project_files', { pathParams: { projectId: createdId } })).data.length, 0, 'creation alone uploads no local files');
    await a.command('sync.attach', { projectId: project.id, remoteId: createdId, scope: [{ path: 'deliverables', kind: 'directory' }] });
    await a.command('sync.retry', { projectId: project.id });
    const peer = await b.command('project.open', { path: peerPath }); await b.command('sync.attach', { projectId: peer.id, remoteId: createdId }); await b.command('sync.retry', { projectId: peer.id });
    assert.equal(await readFile(join(peerPath, 'deliverables/result.md'), 'utf8'), '已有本地成果');
    await assert.rejects(readFile(join(peerPath, 'private.md')), { code: 'ENOENT' });
    assert.equal((await a.command('session.read', { sessionId: privateTask.id })).sharedWork, null);
    assert.match((await a.command('session.read', { sessionId: privateTask.id })).messages[0].text, /PRIVATE_NATIVE_HISTORY/);
  } finally { await a.close(); await b.close(); }
}
