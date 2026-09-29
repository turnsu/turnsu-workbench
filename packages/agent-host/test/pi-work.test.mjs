import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { LocalAgentHost } from '../host.mjs';
import { PiConnection } from '../pi.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-pi-test-')); const projectPath = join(root, 'project'); await mkdir(projectPath);
  let started; const start = new Promise((resolve) => { started = resolve; });
  let host, hooks, sends = 0; const replies = [], calls = [];
  const piFactory = (options) => {
    hooks = options;
    return { ready: Promise.resolve(), closed: false, close: async () => {}, respond: async (...args) => replies.push(args), request: async (type, params) => {
      calls.push({ type, params });
      if (type === 'get_state') return { isStreaming: true, isCompacting: false, pendingMessageCount: 0 };
      if (type === 'get_messages') return { messages: [] };
      if (type === 'get_available_models') return { models: [{ provider: 'example', id: 'model/variant', name: 'Example' }] };
      if (type === 'set_model') return {};
      if (type === 'prompt') { sends++; await writeFile(options.sessionPath, '{"type":"session"}\n'); options.onEvent({ type: 'agent_start' }); started(); return {}; }
      if (type === 'abort') { options.onEvent({ type: 'agent_settled' }); return {}; }
      throw new Error(type);
    } };
  };
  const directory = join(root, 'state'); host = new LocalAgentHost({ directory, piFactory });
  const project = await host.command('project.open', { path: projectPath });
  const session = await host.command('session.create', { projectId: project.id, agent: 'pi' });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { project, session, calls, replies, start, get host() { return host; }, get hooks() { return hooks; }, get sends() { return sends; }, async reopen() { await host.close(); host = new LocalAgentHost({ directory, piFactory }); } };
}

test('Pi stays running through agent_end and retry, completes only on settled, and preserves native selection', async (t) => {
  const f = await fixture(t); const id = f.session.id;
  const models = await f.host.command('models.list', { agent: 'pi', sessionId: id });
  await f.host.command('session.model', { sessionId: id, model: models[0].id });
  const input = { sessionId: id, inputId: 'pi-input', text: 'Process this project' };
  await f.host.command('session.send', input); await f.start;
  f.hooks.onEvent({ type: 'message_end', message: { role: 'assistant', timestamp: 1, content: [], stopReason: 'error', errorMessage: 'temporary error' } });
  f.hooks.onEvent({ type: 'agent_end', messages: [] });
  assert.equal((await f.host.command('session.read', { sessionId: id })).status, 'running');
  await assert.rejects(f.host.command('session.send', { ...input, inputId: 'other' }), /正在处理/);
  f.hooks.onEvent({ type: 'auto_retry_end', success: true });
  f.hooks.onEvent({ type: 'message_end', message: { role: 'assistant', timestamp: 2, content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Actual result' }], stopReason: 'stop' } });
  f.hooks.onEvent({ type: 'agent_settled' });
  const result = await f.host.command('session.read', { sessionId: id });
  assert.equal(result.status, 'idle'); assert.equal(result.messages.at(-1).text, 'Actual result');
  assert.deepEqual(f.calls.find((c) => c.type === 'set_model').params, { provider: 'example', modelId: 'model/variant' });
  await f.reopen();
  const restored = await f.host.command('session.resume', { sessionId: id });
  assert.equal(restored.agent, 'pi'); assert.equal(restored.native_id, result.native_id);
  await f.host.command('session.send', input); assert.equal(f.sends, 1);
});

test('Pi extension dialogs preserve native choices and reject stale or cross-task responses', async (t) => {
  const f = await fixture(t); const id = f.session.id;
  await f.host.command('session.send', { sessionId: id, inputId: 'dialog', text: 'Run' }); await f.start;
  f.hooks.onEvent({ type: 'extension_ui_request', id: 'native-dialog', method: 'select', title: 'Choose an action', options: ['Allow', 'Block'] });
  const session = await f.host.command('session.read', { sessionId: id }); const request = session.interactions[0];
  assert.equal(session.status, 'waiting');
  await assert.rejects(f.host.command('interaction.respond', { id: request.id, sessionId: 'other', answers: { answer: 'Allow' } }));
  await assert.rejects(f.host.command('interaction.respond', { id: request.id, sessionId: id, answers: { answer: 'Invented option' } }));
  await f.host.command('interaction.respond', { id: request.id, sessionId: id, answers: { answer: 'Block' } });
  assert.deepEqual(f.replies, [['native-dialog', { value: 'Block' }]]);
  await assert.rejects(f.host.command('interaction.respond', { id: request.id, sessionId: id, answers: { answer: 'Allow' } }));
  await f.host.command('session.stop', { sessionId: id });
  assert.equal((await f.host.command('session.read', { sessionId: id })).status, 'interrupted');
});

test('Pi provider errors are not reported as successful completion', async (t) => {
  const f = await fixture(t); const id = f.session.id;
  await f.host.command('session.send', { sessionId: id, inputId: 'failure', text: 'Run' }); await f.start;
  f.hooks.onEvent({ type: 'message_end', message: { role: 'assistant', timestamp: 4, content: [], stopReason: 'error', errorMessage: 'Account rejected' } });
  f.hooks.onEvent({ type: 'agent_settled' });
  const result = await f.host.command('session.read', { sessionId: id });
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'Account rejected');
});

test('Pi RPC preserves Unicode separators and split UTF-8 records while correlating responses', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit');
  child.stdin = new Writable({ write(bytes, _, done) {
    const request = JSON.parse(bytes.toString());
    child.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: { sessionId: 'native' } }) + '\n'); done();
  }, final(done) { child.emit('exit'); done(); } });
  const events = [];
  const connection = new PiConnection({ cwd: '/', binary: '/test/pi', checkVersion: false, spawnProcess: () => child, onEvent: (e) => events.push(e), onExit() {} });
  await connection.ready;
  const content = Buffer.from(JSON.stringify({ type: 'message_update', text: '中文\u2028保留\u2029完整' }) + '\n');
  for (let i = 0; i < content.length; i++) child.stdout.write(content.subarray(i, i + 1));
  assert.equal(events.length, 1); assert.equal(events[0].text, '中文\u2028保留\u2029完整');
  await connection.close();
});


test('closing during the real version process prevents a later Pi RPC launch', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-pi-closing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'pi');
  await writeFile(binary, '#!/usr/bin/env node\nsetTimeout(() => console.log("0.87.0"), 1000);\n', { mode: 0o700 });
  let launches = 0;
  const connection = new PiConnection({ cwd: directory, binary, onEvent() {}, onExit() {}, spawnProcess() { launches++; throw new Error('Must not launch after close'); } });
  const rejected = assert.rejects(connection.ready, /已关闭/);
  await connection.close(); await rejected;
  assert.equal(launches, 0); assert.equal(connection.closed, true);
});

test('stopping Pi while it asks a question cancels that dialog before interrupting', async (t) => {
  const f = await fixture(t); const id = f.session.id;
  await f.host.command('session.send', { sessionId: id, inputId: 'cancel-dialog', text: 'Run' }); await f.start;
  f.hooks.onEvent({ type: 'extension_ui_request', id: 'cancel-me', method: 'confirm', title: 'Continue?' });
  await f.host.command('session.stop', { sessionId: id });
  assert.deepEqual(f.replies, [['cancel-me', { cancelled: true }]]);
  const state = await f.host.command('session.read', { sessionId: id });
  assert.equal(state.status, 'interrupted'); assert.equal(state.interactions.length, 0);
});
