import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-history-test-')); await mkdir(join(root, 'project'));
  const host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => { throw new Error('history must not start an Agent'); } });
  const project = await host.command('project.open', { path: join(root, 'project') });
  const session = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { host, project, session, add(id, text, at = 1) { host.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id, session.id, 'assistant', text, 'text', at); } };
}

test('large history opens recent records and cursor navigation returns every record once, including equal timestamps', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 123; i++) f.add('record-' + i, 'Message ' + i);
  const recent = await f.host.command('session.read', { sessionId: f.session.id });
  assert.equal(recent.messages.length, 40); assert.equal(recent.messages[0].id, 'record-83');
  let page = { messages: recent.messages, page: recent.messagePage }, all = [...page.messages];
  f.add('new-arrival', 'Arrived while looking at history', 2);
  while (page.page.older) {
    page = await f.host.command('session.history', { sessionId: f.session.id, before: page.page.older });
    all = [...page.messages, ...all];
  }
  assert.deepEqual(all.map(row => row.id), Array.from({ length: 123 }, (_, i) => 'record-' + i));
  const forwards = [...page.messages];
  while (page.page.newer) {
    page = await f.host.command('session.history', { sessionId: f.session.id, after: page.page.newer });
    forwards.push(...page.messages);
  }
  assert.deepEqual(forwards.map(row => row.id), [...all.map(row => row.id), 'new-arrival']);
  const other = await f.host.command('session.create', { projectId: f.project.id, agent: 'codex' });
  await assert.rejects(f.host.command('session.history', { sessionId: other.id, before: 'record-1' }), /历史/);
});

test('large individual answers are not silently truncated and do not force other history into the same response', async t => {
  const f = await fixture(t);
  f.add('older', 'a'.repeat(200000)); f.add('middle', 'b'.repeat(200000)); f.add('latest', 'c'.repeat(700000));
  const recent = await f.host.command('session.read', { sessionId: f.session.id });
  assert.deepEqual(recent.messages.map(row => row.id), ['latest']); assert.equal(recent.messages[0].text.length, 700000);
  const prior = await f.host.command('session.history', { sessionId: f.session.id, before: recent.messagePage.older });
  assert.deepEqual(prior.messages.map(row => row.id), ['middle']); assert.equal(prior.messages[0].text.length, 200000);
});

test('an explicitly selected older answer can still be captured as a Skill after history becomes windowed', async t => {
  const f = await fixture(t);
  f.add('old-answer', 'Old proven steps with clear evidence');
  for (let i = 0; i < 80; i++) f.add('later-' + i, 'Other unrelated answer');
  f.host.db.prepare("INSERT INTO submissions VALUES(?,?,?,NULL,'completed')").run('completed-input', f.session.id, 'Task');
  assert.equal((await f.host.command('session.read', { sessionId: f.session.id })).messages.some(message => message.id === 'old-answer'), false);
  const capture = await f.host.command('capture.create', { sessionId: f.session.id, messageId: 'old-answer', requestId: 'older-capture' });
  const instruction = f.host.db.prepare('SELECT instruction FROM method_captures WHERE session_id=?').get(capture.id).instruction;
  assert.match(instruction, /Old proven steps/); assert.doesNotMatch(instruction, /Other unrelated/);
});
