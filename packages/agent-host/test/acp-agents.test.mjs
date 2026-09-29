import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost, readableError } from '../host.mjs';
import { AcpConnection } from '../opencode.mjs';

test('ACP choice sends only the explicitly selected native option', () => {
  const connection = Object.create(AcpConnection.prototype), results = [];
  connection.agentName = 'Kimi Code';
  connection.permissions = new Map([['question', { options: [{ optionId: 'first', kind: 'allow_once' }, { optionId: 'second', kind: 'allow_once' }], done: value => results.push(value) }]]);
  assert.throws(() => connection.respond('question', 'accept', 'forged'), /未提供单次允许选项/);
  connection.respond('question', 'accept', 'second');
  assert.deepEqual(results, [{ outcome: 'selected', optionId: 'second' }]);
});

test('Kimi subscription rejection is explained without treating it as a completed task', () => {
  assert.match(readableError('Authentication required: 403 Your current subscription does not have access to Kimi Code right now.'), /没有 Kimi Code 使用权限.*403/);
});

for (const agent of ['kimi', 'omp']) test(`${agent} ACP task keeps its native session, model, permission and stop state`, async t => {
  const root = await mkdtemp(join(tmpdir(), `turnsu-${agent}-acp-`));
  const path = join(root, 'project'); await mkdir(path);
  let host; const connections = [], sent = [], answers = [];
  const factory = options => {
    const connection = { options, closed: false, sessionId: options.sessionId || `${agent}-native-1`,
      models: [{ id: 'provider/model', name: 'Model' }], ready: Promise.resolve(),
      async send(prompt, model) { sent.push({ prompt, model }); return sent.length; },
      respond(id, decision, optionId) { answers.push({ id, decision, optionId }); options.onEvent({ type: 'permission_closed', id }); },
      async stop() { options.onEvent({ type: 'result', stopReason: 'cancelled' }); },
      async close() { this.closed = true; },
    };
    connections.push(connection); return connection;
  };
  const factories = agent === 'kimi' ? { kimiFactory: factory } : { ompFactory: factory };
  const directory = join(root, 'state'); host = new LocalAgentHost({ directory, ...factories });
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path });
  await host.command('agent.preference.save', { scope: 'project', projectId: project.id, agentId: agent });
  const session = await host.command('session.create', { projectId: project.id, agent });
  assert.equal((await host.command('agent.preference.read', { projectId: project.id })).agentId, agent);
  assert.deepEqual(await host.command('models.list', { agent, sessionId: session.id }), [{ id: 'provider/model', name: 'Model' }]);
  await host.command('session.model', { sessionId: session.id, model: 'provider/model' });
  await host.command('session.send', { sessionId: session.id, inputId: 'first', text: 'Read the project' });
  assert.deepEqual(sent, [{ prompt: 'Read the project', model: 'provider/model' }]);
  assert.equal((await host.command('session.read', { sessionId: session.id })).native_id, `${agent}-native-1`);
  connections[0].options.onEvent({ type: 'update', turn: 1, update: { sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'Done' } } });
  connections[0].options.onEvent({ type: 'permission', id: 'approve', title: 'Read file', tool: 'read', options: [{ name: 'Allow once', kind: 'allow_once' }] });
  assert.equal((await host.command('session.read', { sessionId: session.id })).status, 'waiting');
  await host.command('interaction.respond', { sessionId: session.id, id: 'approve', decision: 'accept' });
  assert.deepEqual(answers, [{ id: 'approve', decision: 'accept', optionId: undefined }]);
  connections[0].options.onEvent({ type: 'permission', id: 'question', title: 'Choose an outcome', tool: 'AskUserQuestion', options: [{ optionId: 'first', name: 'Draft', kind: 'allow_once' }, { optionId: 'second', name: 'Finalize', kind: 'allow_once' }] });
  const choice = (await host.command('session.read', { sessionId: session.id })).interactions[0];
  assert.deepEqual(choice.acpChoices.map(option => option.label), ['Draft', 'Finalize']);
  await assert.rejects(host.command('interaction.respond', { sessionId: session.id, id: 'question', decision: 'select', optionId: 'forged' }), /提供的选项/);
  await host.command('interaction.respond', { sessionId: session.id, id: 'question', decision: 'select', optionId: 'second' });
  assert.deepEqual(answers[1], { id: 'question', decision: 'accept', optionId: 'second' });
  connections[0].options.onEvent({ type: 'result', stopReason: 'end_turn' });
  let state = await host.command('session.read', { sessionId: session.id });
  assert.equal(state.status, 'idle'); assert.equal(state.messages.find(message => message.role === 'assistant').text, 'Done');
  await host.close(); host = new LocalAgentHost({ directory, ...factories });
  await host.command('session.resume', { sessionId: session.id });
  assert.equal(connections[1].options.sessionId, `${agent}-native-1`);
  await host.command('session.send', { sessionId: session.id, inputId: 'second', text: 'Continue' });
  await host.command('session.stop', { sessionId: session.id });
  state = await host.command('session.read', { sessionId: session.id });
  assert.equal(state.status, 'interrupted'); assert.notEqual(state.lastSubmission.status, 'completed');
});

test('existing Agent preferences migrate without losing choices when new ACP agents are added', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-acp-preference-'));
  let host = new LocalAgentHost({ directory: root });
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });
  await host.command('agent.preference.save', { scope: 'personal', agentId: 'opencode' });
  host.db.exec("BEGIN IMMEDIATE; CREATE TABLE agent_preferences_old(scope TEXT PRIMARY KEY,agent_id TEXT NOT NULL CHECK(agent_id IN ('codex','pi','claude','opencode'))); INSERT INTO agent_preferences_old SELECT * FROM agent_preferences; DROP TABLE agent_preferences; ALTER TABLE agent_preferences_old RENAME TO agent_preferences; COMMIT");
  await host.close(); host = new LocalAgentHost({ directory: root });
  assert.equal((await host.command('agent.preference.read')).personal, 'opencode');
  await host.command('agent.preference.save', { scope: 'personal', agentId: 'kimi' });
  assert.equal((await host.command('agent.preference.read')).personal, 'kimi');
  await host.command('agent.preference.save', { scope: 'personal', agentId: 'omp' });
  assert.equal((await host.command('agent.preference.read')).personal, 'omp');
});
