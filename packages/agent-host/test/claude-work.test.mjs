import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { ClaudeConnection } from '../claude.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-claude-test-')); const path = join(root, 'project'); await mkdir(path);
  let hooks, host; const replies = [], starts = [], constructors = [];
  const claudeFactory = (options) => {
    hooks = options; constructors.push(options);
    return { ready: Promise.resolve(), models: [{ value: 'native-model', displayName: 'Native model' }], closed: false,
      async send(inputId, prompt, model) { starts.push({ inputId, prompt, model }); options.onEvent({ type: 'user', uuid: inputId, session_id: options.sessionId }); },
      respond(id, decision, answers) { replies.push({ id, decision, answers }); options.onEvent({ type: 'permission_closed', id }); },
      async stop() { options.onEvent({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_tools', session_id: options.sessionId }); },
      async close() {},
    };
  };
  const directory = join(root, 'state'); host = new LocalAgentHost({ directory, claudeFactory });
  const project = await host.command('project.open', { path });
  const session = await host.command('session.create', { projectId: project.id, agent: 'claude' });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { project, session, replies, starts, constructors, get host() { return host; }, get hooks() { return hooks; }, async reopen() { await host.close(); host = new LocalAgentHost({ directory, claudeFactory }); } };
}

test('Claude tasks keep their native model/session across restart and do not replay accepted input', async (t) => {
  const f = await fixture(t); const sessionId = f.session.id;
  await f.host.command('models.list', { agent: 'claude', sessionId });
  await f.host.command('session.model', { sessionId, model: 'native-model' });
  const input = { sessionId, inputId: 'claude-input', text: 'Work in the project' };
  await f.host.command('session.send', input);
  f.hooks.onEvent({ type: 'assistant', uuid: 'message', session_id: sessionId, message: { id: 'api-message', content: [{ type: 'text', text: 'Real output' }, { type: 'thinking', thinking: 'private' }] } });
  f.hooks.onEvent({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', session_id: sessionId });
  await f.reopen(); await f.host.command('session.resume', { sessionId });
  assert.equal(f.constructors.at(-1).resume, true); assert.equal(f.constructors.at(-1).sessionId, sessionId);
  await f.host.command('session.send', input); assert.equal(f.starts.length, 1); assert.equal(f.starts[0].model, 'native-model');
  const saved = await f.host.command('session.read', { sessionId }); assert.equal(saved.agent, 'claude'); assert.equal(saved.messages.at(-1).text, 'Real output');
});

test('Claude multi-select questions bind answers to original question text and reject late approvals', async (t) => {
  const f = await fixture(t); const sessionId = f.session.id;
  await f.host.command('session.send', { sessionId, inputId: 'ask', text: 'Start' });
  f.hooks.onEvent({ type: 'permission', id: 'question', tool: 'AskUserQuestion', title: 'Choose', input: { questions: [{ question: 'Which outputs?', options: [{ label: 'File' }, { label: 'Summary' }], multiSelect: true }] } });
  const read = await f.host.command('session.read', { sessionId }); assert.equal(read.status, 'waiting');
  await assert.rejects(f.host.command('interaction.respond', { sessionId: 'other', id: 'question', answers: { 0: ['File'] } }));
  await assert.rejects(f.host.command('interaction.respond', { sessionId, id: 'question', answers: { 0: ['Unknown'] } }));
  await f.host.command('interaction.respond', { sessionId, id: 'question', answers: { 0: ['File', 'Summary'] } });
  assert.deepEqual(f.replies, [{ id: 'question', decision: 'accept', answers: { 'Which outputs?': 'File, Summary' } }]);
  await assert.rejects(f.host.command('interaction.respond', { sessionId, id: 'question', decision: 'accept' }));
});

test('Claude API error and interruption remain distinct from success', async (t) => {
  const f = await fixture(t); const sessionId = f.session.id;
  await f.host.command('session.send', { sessionId, inputId: 'error', text: 'Start' });
  f.hooks.onEvent({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'model_error', result: 'Authentication failed' });
  let state = await f.host.command('session.read', { sessionId }); assert.equal(state.status, 'failed'); assert.equal(state.error, 'Authentication failed');
  await f.host.command('session.send', { sessionId, inputId: 'stop', text: 'Start again' });
  await f.host.command('session.stop', { sessionId });
  state = await f.host.command('session.read', { sessionId }); assert.equal(state.status, 'interrupted');
});

test('SDK callback passes the exact approved input and cancels pending approval on AbortSignal', async () => {
  let options, done = false, waiting;
  const events = [];
  const query = { supportedModels: async () => [], setModel: async () => {}, close() { done = true; waiting?.({ done: true }); }, [Symbol.asyncIterator]() { return this; }, next() { return done ? Promise.resolve({ done: true }) : new Promise((resolve) => { waiting = resolve; }); } };
  const c = new ClaudeConnection({ cwd: '/test', sessionId: 'session', binary: '/test/claude', onEvent: (event) => events.push(event), onExit() {}, sdkLoader: async () => ({ query(args) { options = args.options; return query; } }) });
  await c.ready;
  assert.equal(options.pathToClaudeCodeExecutable, '/test/claude'); assert.equal(options.permissionMode, 'default');
  const controller = new AbortController(); const input = { command: 'example', nested: { preserve: true } };
  let pending = options.canUseTool('Bash', input, { signal: controller.signal, toolUseID: 'tool' });
  const request = events.at(-1); c.respond(request.id, 'accept');
  assert.deepEqual(await pending, { behavior: 'allow', updatedInput: input });
  pending = options.canUseTool('Bash', input, { signal: controller.signal, toolUseID: 'other' });
  const stale = events.at(-1).id; controller.abort(); assert.equal((await pending).behavior, 'deny');
  assert.throws(() => c.respond(stale, 'accept'), /已经结束/);
  await c.close();
});

test('closing during SDK loading prevents a later native process launch', async () => {
  let release, queries = 0;
  const loaded = new Promise(resolve => { release = resolve; });
  const connection = new ClaudeConnection({ cwd: '/test', sessionId: 'closing', binary: '/test/claude', onEvent() {}, onExit() {}, sdkLoader: () => loaded });
  const rejected = assert.rejects(connection.ready, /已关闭/);
  await connection.close();
  release({ query() { queries++; throw new Error('Must not launch after close'); } });
  await rejected; assert.equal(queries, 0);
});

test('a late Claude permission during cancellation is declined without reopening the task', async (t) => {
  const f = await fixture(t); const sessionId = f.session.id;
  await f.host.command('session.send', { sessionId, inputId: 'late-question', text: 'Start' });
  f.host.updateSession(sessionId, 'stopping');
  f.hooks.onEvent({ type: 'permission', id: 'late', tool: 'Read', input: { file_path: 'result.md' } });
  assert.deepEqual(f.replies, [{ id: 'late', decision: 'decline', answers: undefined }]);
  const state = await f.host.command('session.read', { sessionId });
  assert.equal(state.status, 'stopping'); assert.equal(state.interactions.length, 0);
});
