import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { gatewayEnvironment } from '../opencode.mjs';

test('OpenCode gateway keeps existing native policy and never puts the API key in inline config', () => {
  const gateway = { id: 'company', name: 'Company', baseUrl: 'https://gateway.example.test/v1', apiKey: 'private-key' };
  const env = gatewayEnvironment(gateway, 'turnsu-company/another/model', { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask' }, provider: { existing: { name: 'Existing' } } }) });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.permission.edit, 'ask');
  assert.equal(config.provider.existing.name, 'Existing');
  assert.equal(config.provider['turnsu-company'].models['another/model'].name, 'another/model');
  assert.equal(config.model, 'turnsu-company/another/model');
  assert.equal(config.small_model, config.model);
  assert.equal(env.TURNSU_GATEWAY_KEY, 'private-key');
  assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes('private-key'));
  assert.throws(() => gatewayEnvironment(gateway, 'other/model', {}), /选择模型/);
});

test('OpenCode keeps its native session, approval, result and stop boundaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-opencode-'));
  const directory = join(root, 'state'), path = join(root, 'project'); await mkdir(path);
  let host; const created = [], sent = [], answers = [];
  const opencodeFactory = options => {
    const connection = { options, closed: false, sessionId: options.sessionId || 'native-opencode-1',
      models: [{ id: 'provider/model', name: 'Model' }], ready: Promise.resolve(),
      async send(prompt, model) { sent.push({ prompt, model }); return sent.length; },
      respond(id, decision) { answers.push({ id, decision }); options.onEvent({ type: 'permission_closed', id }); },
      async stop() { options.onEvent({ type: 'result', stopReason: 'cancelled' }); },
      async close() { this.closed = true; },
    };
    created.push(connection); return connection;
  };
  host = new LocalAgentHost({ directory, opencodeFactory, idleTimeoutMs: 1000 });
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path });
  await host.command('agent.preference.save', { scope: 'project', projectId: project.id, agentId: 'opencode' });
  const session = await host.command('session.create', { projectId: project.id, agent: 'opencode' });
  assert.equal((await host.command('agent.preference.read', { projectId: project.id })).agentId, 'opencode');
  assert.deepEqual(await host.command('models.list', { agent: 'opencode', sessionId: session.id }), [{ id: 'provider/model', name: 'Model' }]);
  await host.command('session.model', { sessionId: session.id, model: 'provider/model' });
  await host.command('session.send', { sessionId: session.id, inputId: 'first', text: 'Create a report' });
  assert.deepEqual(sent, [{ prompt: 'Create a report', model: 'provider/model' }]);
  assert.equal((await host.command('session.read', { sessionId: session.id })).native_id, 'native-opencode-1');
  created[0].options.onEvent({ type: 'update', turn: 1, update: { sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'Report ' } } });
  created[0].options.onEvent({ type: 'update', turn: 1, update: { sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'ready.' } } });
  created[0].options.onEvent({ type: 'permission', id: 'approve-1', title: 'Edit report', tool: 'edit', options: [{ name: 'Allow once', kind: 'allow_once' }] });
  assert.equal((await host.command('session.read', { sessionId: session.id })).status, 'waiting');
  await host.command('interaction.respond', { sessionId: session.id, id: 'approve-1', decision: 'accept' });
  assert.deepEqual(answers, [{ id: 'approve-1', decision: 'accept' }]);
  created[0].options.onEvent({ type: 'result', stopReason: 'end_turn' });
  let state = await host.command('session.read', { sessionId: session.id });
  assert.equal(state.status, 'idle'); assert.equal(state.lastSubmission.status, 'completed');
  assert.equal(state.messages.find(message => message.role === 'assistant').text, 'Report ready.');
  await host.close(); host = new LocalAgentHost({ directory, opencodeFactory });
  await host.command('session.resume', { sessionId: session.id });
  assert.equal(created[1].options.sessionId, 'native-opencode-1');
  await host.command('session.send', { sessionId: session.id, inputId: 'second', text: 'Continue' });
  await host.command('session.stop', { sessionId: session.id });
  state = await host.command('session.read', { sessionId: session.id });
  assert.equal(state.status, 'interrupted'); assert.notEqual(state.lastSubmission.status, 'completed');
  assert.equal(sent.length, 2, 'reopening must not repeat the first prompt');
});

test('existing Agent preferences survive the OpenCode schema migration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-opencode-migration-'));
  let host = new LocalAgentHost({ directory: root });
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });
  await host.command('agent.preference.save', { scope: 'personal', agentId: 'claude' });
  host.db.exec("BEGIN IMMEDIATE; CREATE TABLE agent_preferences_old(scope TEXT PRIMARY KEY,agent_id TEXT NOT NULL CHECK(agent_id IN ('codex','pi','claude'))); INSERT INTO agent_preferences_old SELECT * FROM agent_preferences; DROP TABLE agent_preferences; ALTER TABLE agent_preferences_old RENAME TO agent_preferences; COMMIT");
  await host.close(); host = new LocalAgentHost({ directory: root });
  assert.equal((await host.command('agent.preference.read')).personal, 'claude');
  await host.command('agent.preference.save', { scope: 'personal', agentId: 'opencode' });
  assert.equal((await host.command('agent.preference.read')).personal, 'opencode');
});
