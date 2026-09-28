import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { LocalDraftNavigation } from '../../../apps/desktop/src/local-draft-navigation.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-draft-navigation-')); await mkdir(join(root, 'project'));
  let host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => { throw new Error('No provider should start for navigation'); } });
  const project = await host.command('project.open', { path: join(root, 'project') });
  const sessions = [];
  for (const name of ['A', 'B', 'C']) {
    const session = await host.command('session.create', { projectId: project.id, agent: 'codex' });
    await host.command('draft.save', { projectId: project.id, sessionId: session.id, text: `草稿 ${name}`, references: [`${name}.md`] }); sessions.push(session);
  }
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, project, sessions, async reopen() { await host.close(); host = new LocalAgentHost({ directory: join(root, 'state') }); } };
}

test('switching away while a draft is loading never overwrites that draft and ignores the late response', async t => {
  const f = await fixture(t), [a, b, c] = f.sessions, blockedRead = deferred(), readStarted = deferred();
  const command = async (method, args) => {
    const result = await f.host.command(method, args);
    if (method === 'draft.read' && args.sessionId === b.id) { readStarted.resolve(); await blockedRead.promise; }
    return result;
  };
  const navigation = new LocalDraftNavigation(command), displayed = [];
  const callbacks = { start() {}, loaded(value) { displayed.push(value.draft); } };
  await navigation.select(f.project.id, a.id, callbacks);
  navigation.edit('A 尚未自动保存的新内容', ['new-A.md']);
  const selectingB = navigation.select(f.project.id, b.id, callbacks); await readStarted.promise;
  await navigation.select(f.project.id, c.id, callbacks);
  blockedRead.resolve(); await selectingB;
  assert.equal(displayed.at(-1).sessionId, c.id);
  assert.equal(displayed.at(-1).text, '草稿 C');
  assert.equal(displayed.length, 2, 'late B must not replace C');
  await f.reopen();
  assert.deepEqual(await f.host.command('draft.read', { projectId: f.project.id, sessionId: b.id }), { text: '草稿 B', references: ['B.md'] });
  assert.deepEqual(await f.host.command('draft.read', { projectId: f.project.id, sessionId: a.id }), { text: 'A 尚未自动保存的新内容', references: ['new-A.md'] });
});

test('a failed source save keeps the edited task open; a later retry preserves it before navigating', async t => {
  const f = await fixture(t), [a, b] = f.sessions; let failSave = false;
  const navigation = new LocalDraftNavigation(async (method, args) => {
    if (method === 'draft.save' && failSave) throw new Error('Disk temporarily unavailable');
    return f.host.command(method, args);
  });
  const selected = [], callbacks = { start() { selected.push(navigation.current.sessionId); }, loaded() {} };
  await navigation.select(f.project.id, a.id, callbacks); navigation.edit('不能丢失的输入', ['keep.md']); failSave = true;
  await assert.rejects(navigation.select(f.project.id, b.id, callbacks), /Disk/);
  assert.equal(navigation.current.sessionId, a.id); assert.equal(navigation.current.text, '不能丢失的输入');
  assert.deepEqual(selected, [a.id]);
  failSave = false; await navigation.select(f.project.id, b.id, callbacks); await f.reopen();
  assert.equal((await f.host.command('draft.read', { projectId: f.project.id, sessionId: a.id })).text, '不能丢失的输入');
});

test('a failed destination read remains non-writable and can be retried without deleting stored content', async t => {
  const f = await fixture(t), [a, b] = f.sessions; let failRead = true;
  const navigation = new LocalDraftNavigation((method, args) => {
    if (method === 'draft.read' && args.sessionId === b.id && failRead) throw new Error('Read unavailable');
    return f.host.command(method, args);
  });
  const callbacks = { start() {}, loaded() {} };
  await navigation.select(f.project.id, a.id, callbacks);
  await assert.rejects(navigation.select(f.project.id, b.id, callbacks), /Read unavailable/);
  assert.equal(navigation.current.loaded, false); navigation.edit('', []); await navigation.save();
  failRead = false; await navigation.select(f.project.id, b.id, callbacks);
  assert.equal(navigation.current.text, '草稿 B'); assert.deepEqual(navigation.current.references, ['B.md']);
});
