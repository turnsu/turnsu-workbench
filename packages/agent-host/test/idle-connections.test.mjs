import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

test('idle native connections are released while running and permission-waiting work survives; resume uses the same native session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-idle-')); await mkdir(join(root, 'project'));
  let now = 0; const created = [];
  const host = new LocalAgentHost({ directory: join(root, 'state'), clock: () => now, idleTimeoutMs: 1000, idleConnectionLimit: 1,
    claudeFactory: options => { const c = { options, ready: Promise.resolve(), closed: false, async close() { this.closed = true; }, models: [] }; created.push(c); return c; } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const p = await host.command('project.open', { path: join(root, 'project') });
  const sessions = [];
  for (let i = 0; i < 3; i++) { const s = await host.command('session.create', { projectId: p.id, agent: 'claude' }); sessions.push(s); await host.command('session.resume', { sessionId: s.id }); }
  host.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run('native-preserved', sessions[0].id);
  host.db.prepare("UPDATE sessions SET status='running' WHERE id=?").run(sessions[1].id);
  host.db.prepare("UPDATE sessions SET status='waiting' WHERE id=?").run(sessions[2].id);
  now = 1001;
  await host.reapIdleConnections();
  assert(created[0].closed); assert(!created[1].closed); assert(!created[2].closed);
  assert.equal((await host.command('session.read', { sessionId: sessions[0].id })).native_id, 'native-preserved');
  assert.equal(created.length, 3, 'reading saved history must not restart a native process');
  await host.command('session.resume', { sessionId: sessions[0].id });
  assert.equal(created[3].options.sessionId, 'native-preserved'); assert.equal(created[3].options.resume, true);
});

test('Codex unloads idle threads without stopping another active thread, then closes the idle app-server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-codex-idle-')); await mkdir(join(root, 'project'));
  let now = 0; const calls = [], servers = [];
  const host = new LocalAgentHost({ directory: join(root, 'state'), clock: () => now, idleTimeoutMs: 1000,
    connectionFactory: () => { const c = { ready: Promise.resolve(), closed: false, async close() { this.closed = true; }, async request(method, params) { calls.push({ method, params }); return method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : { thread: { id: params.threadId || 'native-' + calls.length, turns: [] } }; } }; servers.push(c); return c; } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const p = await host.command('project.open', { path: join(root, 'project') });
  const a = await host.command('session.create', { projectId: p.id, agent: 'codex' }), b = await host.command('session.create', { projectId: p.id, agent: 'codex' });
  await host.command('session.resume', { sessionId: a.id }); await host.command('session.resume', { sessionId: b.id });
  const native = (await host.command('session.read', { sessionId: a.id })).native_id;
  host.db.prepare("UPDATE sessions SET status='running' WHERE id=?").run(b.id);
  now = 1001; await host.reapIdleConnections();
  assert.deepEqual(calls.filter(c => c.method === 'thread/unsubscribe').map(c => c.params.threadId), [native]); assert(!servers[0].closed);
  host.updateSession(b.id, 'idle'); now += 1001; await host.reapIdleConnections(); assert(servers[0].closed);
  await host.command('session.resume', { sessionId: a.id });
  assert.equal(servers.length, 2); assert.equal(calls.at(-1).method, 'thread/resume'); assert.equal(calls.at(-1).params.threadId, native);
});
