import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

test('startup does not load sessions; project pages and search reach old sessions without starting native Agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-session-index-'));
  const host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => { throw new Error('index must not start native Agents'); } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  for (const id of ['one', 'two']) { await mkdir(join(root, id)); host.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(id, join(root, id), id, 1); }
  const insert = host.db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES(?,?,?,'idle',?)");
  host.db.exec('BEGIN');
  for (let i = 0; i < 10000; i++) insert.run('s-' + String(i).padStart(5, '0'), i < 9000 ? 'one' : 'two', i === 2 ? 'Old 100%_target' : 'Task ' + i, 1);
  host.db.exec('COMMIT');
  assert.equal((await host.command('workspace.read')).sessions.length, 0);
  let result = await host.command('workspace.read', { projectId: 'one' });
  assert.equal(result.sessions.length, 40); assert.equal(result.sessionPage.total, 9000);
  assert(result.sessions.every(s => s.project_id === 'one'));
  const first = result.sessions.map(s => s.id), found = new Set(first);
  while (result.sessionPage.older) {
    result = await host.command('workspace.read', { projectId: 'one', before: result.sessionPage.older });
    assert(result.sessions.length <= 40);
    for (const s of result.sessions) { assert(!found.has(s.id)); found.add(s.id); }
  }
  assert.equal(found.size, 9000);
  result = await host.command('workspace.read', { projectId: 'one', search: '100%_' });
  assert.deepEqual(result.sessions.map(s => s.id), ['s-00002']);
  assert.equal(result.sessionPage.total, 1);
  const recent = await host.command('workspace.read', { projectId: 'one' });
  const older = await host.command('workspace.read', { projectId: 'one', before: recent.sessionPage.older });
  assert.deepEqual((await host.command('workspace.read', { projectId: 'one', after: older.sessionPage.newer })).sessions.map(s => s.id), first);
  assert.deepEqual(await host.command('session.locate', { sessionId: 's-00002' }), { id: 's-00002', projectId: 'one' });
  await assert.rejects(host.command('workspace.read', { projectId: 'one', before: recent.sessionPage.older, after: older.sessionPage.newer }), /方向/);
});
