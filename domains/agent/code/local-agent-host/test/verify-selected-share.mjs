import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

// Existing native-auth Product fixture; all files/SQLite are isolated. No model is invoked.
export async function verifySelectedShare({ directory, owner, member, projectId }) {
  const source = join(directory, 'existing-local-project'), peer = join(directory, 'selected-peer');
  for (const path of [source, peer]) { await mkdir(path); await mkdir(join(path, 'deliverables')); }
  await writeFile(join(source, 'deliverables/result.md'), '本地已有的成果');
  await writeFile(join(source, 'private-notes.md'), 'PRIVATE_EXISTING_PROJECT_NOTES');
  await writeFile(join(source, 'deliverables/.env'), 'PRIVATE_CREDENTIAL');
  const scope = [{ path: 'deliverables', kind: 'directory' }];
  function open(path, client) {
    const host = new LocalAgentHost({ directory: path, connectionFactory: () => { assert.fail('sharing existing files must not start an Agent'); } });
    host.cloud = { identity: (...args) => client.identity(...args), viewer: (...args) => client.viewer(...args), fileCall: (...args) => client.fileCall(...args), close: async () => {} };
    if (host.shared) host.shared.cloud = host.cloud;
    if (host.work) host.work.cloud = host.cloud;
    return host;
  }
  const statePath = join(directory, 'selected-owner-state'); let a = open(statePath, owner), b = open(join(directory, 'selected-member-state'), member);
  try {
    const p = await a.command('project.open', { path: source }), q = await b.command('project.open', { path: peer });
    const privateTask = await a.command('session.create', { projectId: p.id, agent: 'codex' });
    a.message(privateTask.id, 'existing-private-history', 'assistant', 'PRIVATE_EXISTING_NATIVE_HISTORY');
    await a.command('draft.save', { projectId: p.id, sessionId: privateTask.id, text: '未提交的私人草稿', references: ['private-notes.md'] });
    await a.command('sync.attach', { projectId: p.id, remoteId: projectId, scope }); await a.command('sync.retry', { projectId: p.id });
    await b.command('sync.attach', { projectId: q.id, remoteId: projectId, scope }); await b.command('sync.retry', { projectId: q.id });
    assert.equal(await readFile(join(peer, 'deliverables/result.md'), 'utf8'), '本地已有的成果');
    for (const path of ['private-notes.md', 'deliverables/.env', 'assets/result.bin']) await assert.rejects(readFile(join(peer, path)), { code: 'ENOENT' });
    assert.equal((await a.command('session.read', { sessionId: privateTask.id })).sharedWork, null);
    assert.deepEqual(await a.command('draft.read', { projectId: p.id, sessionId: privateTask.id }), { text: '未提交的私人草稿', references: ['private-notes.md'] });
    const work = await a.command('work.start', { projectId: p.id, agent: 'codex', description: '接续所选目录中的成果', requestId: 'selected-share-work' });
    await assert.rejects(a.command('session.send', { sessionId: work.id, inputId: 'excluded-file-input', text: '参考这份资料', references: ['private-notes.md'] }), /共享范围/);
    const context = await a.work.prepare(work.id, '核对共享范围');
    assert.match(context.prompt, /deliverables/);
    const updates = await a.command('work.read', { projectId: p.id, workItemId: a.work.state(work.id).workItemId });
    assert.ok(!JSON.stringify(updates).includes('PRIVATE_EXISTING'));
    await a.close(); a = open(statePath, owner);
    assert.deepEqual((await a.command('sync.status', { projectId: p.id })).scope, scope);
    assert.match((await a.command('session.read', { sessionId: privateTask.id })).messages[0].text, /PRIVATE_EXISTING_NATIVE_HISTORY/);
    await writeFile(join(peer, 'deliverables/result.md'), '同事接续后的成果'); await b.command('sync.retry', { projectId: q.id }); await a.command('sync.retry', { projectId: p.id });
    assert.equal(await readFile(join(source, 'deliverables/result.md'), 'utf8'), '同事接续后的成果');
    await rm(join(source, 'deliverables/result.md')); await a.command('sync.retry', { projectId: p.id }); await b.command('sync.retry', { projectId: q.id });
    await assert.rejects(readFile(join(peer, 'deliverables/result.md')), { code: 'ENOENT' });
    const files = await a.shared.remote(a.shared.binding(p.id)); assert.ok(files.every(file => file.path.startsWith('deliverables/')));
    const all = await owner.fileCall(await owner.identity(), 'turnsu_project_files', { pathParams: { projectId }, query: { limit: 100 } });
    assert.ok(!all.data.some(file => file.path === 'private-notes.md' || file.path.includes('.env')));
    assert.equal(await readFile(join(source, 'private-notes.md'), 'utf8'), 'PRIVATE_EXISTING_PROJECT_NOTES');
  } finally { await a.close(); await b.close(); }
}
