import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { normalizeConnection, discoverModels } from '../model-connections.mjs';

async function gateway(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, key: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer test-turnsu-key') { res.writeHead(401).end('a private diagnostic that must not reach the UI'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'company-model' }, { id: 'company-model' }, { id: 'another/model' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, profile: { id: 'company', name: 'Turnsu 网关', protocol: 'responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-turnsu-key' } };
}

test('gateway discovery uses the selected endpoint and bearer token; errors disclose no server diagnostics', async t => {
  const f = await gateway(t);
  assert.deepEqual((await discoverModels(f.profile)).map(m => m.id), ['another/model', 'company-model']);
  assert.deepEqual(f.requests[0], { path: '/v1/models', key: 'Bearer test-turnsu-key' });
  await assert.rejects(discoverModels({ ...f.profile, apiKey: 'invalid' }), error => /令牌/.test(error.message) && !error.message.includes('diagnostic'));
  for (const baseUrl of ['http://example.com/v1', 'https://a:secret@example.com/v1', 'https://example.com/v1?key=secret', 'file:///tmp/model']) assert.throws(() => normalizeConnection({ ...f.profile, baseUrl }));
  assert.equal(normalizeConnection({ ...f.profile, baseUrl: 'https://gateway.turnsu.org' }).baseUrl, 'https://gateway.turnsu.org/v1');
});

test('saved task source survives reopening; native and gateway tasks never share connections or approvals', async t => {
  const f = await gateway(t), root = await mkdtemp(join(tmpdir(), 'turnsu-models-'));
  const directory = join(root, 'state'), path = join(root, 'project'); await mkdir(path);
  const clients = [], replies = [];
  const connectionFactory = options => {
    const threadId = `thread-${clients.length}`, requests = [];
    const client = { ready: Promise.resolve(), closed: false, options, requests, threadId,
      request: async (method, params) => { requests.push({ method, params }); if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || threadId, turns: [] } }; if (method === 'turn/start') return { turn: { id: 'turn-1' } }; throw new Error(method); },
      respond: (id, value) => replies.push({ threadId, id, value }), reject() {}, close: async () => { client.closed = true; },
    }; clients.push(client); return client;
  };
  let host = new LocalAgentHost({ directory, connectionFactory });
  t.after(async () => { if (!host.closing) await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.configureConnections([f.profile]);
  const project = await host.command('project.open', { path });
  const native = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  const company = await host.command('session.create', { projectId: project.id, agent: 'codex', connectionId: f.profile.id });
  const prepared = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  // Skill/Loop preparation creates an idle task before any provider is connected.
  assert.equal((await host.command('session.connection', { sessionId: prepared.id, connectionId: f.profile.id })).connection_id, f.profile.id);
  await assert.rejects(host.configureConnections([]), /已有会话/);
  await assert.rejects(host.command('session.create', { projectId: project.id, agent: 'claude', connectionId: f.profile.id }), /协议/);
  await host.command('models.list', { sessionId: company.id, agent: 'codex' });
  await host.command('session.model', { sessionId: company.id, model: 'company-model' });
  await host.command('draft.save', { projectId: project.id, sessionId: company.id, text: '未发送的公司任务' });
  await host.command('session.send', { sessionId: native.id, inputId: 'native-input', text: 'native request' });
  await host.command('session.send', { sessionId: company.id, inputId: 'gateway-input', text: 'gateway request' });
  await assert.rejects(host.command('session.connection', { sessionId: company.id, connectionId: null }), /新建任务/);
  assert.equal(clients[0].options.gateway, null);
  assert.equal(clients[1].options.gateway.apiKey, f.profile.apiKey);
  assert.equal(clients[1].requests[0].params.modelProvider, 'turnsu_company');
  clients[0].options.onRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: clients[0].threadId } });
  clients[1].options.onRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: clients[1].threadId } });
  const approval = (await host.command('session.read', { sessionId: company.id })).interactions[0];
  await host.command('interaction.respond', { sessionId: company.id, id: approval.id, decision: 'decline' });
  assert.equal(replies[0].threadId, clients[1].threadId);
  assert.equal((await host.command('session.read', { sessionId: native.id })).interactions.length, 1);
  await assert.rejects(host.configureConnections([{ ...f.profile, apiKey: 'rotated' }]), /先结束/);
  assert.ok(!JSON.stringify(await host.command('connections.list')).includes(f.profile.apiKey));
  await host.close(); host = new LocalAgentHost({ directory, connectionFactory });
  const reopened = await host.command('session.read', { sessionId: company.id });
  assert.equal(reopened.connection_id, f.profile.id); assert.equal(reopened.model, 'company-model');
  assert.equal((await host.command('draft.read', { projectId: project.id, sessionId: company.id })).text, '未发送的公司任务');
  await assert.rejects(host.command('session.resume', { sessionId: company.id }), /连接不可用/);
  assert.equal(clients.length, 2);
  await host.configureConnections([f.profile]); await host.command('session.resume', { sessionId: company.id });
  assert.equal(clients[2].requests[0].params.threadId, reopened.native_id);
  await host.close();
  assert.ok(!(await readFile(join(directory, 'local.sqlite'))).includes(Buffer.from(f.profile.apiKey)));
});

test('Pi source keeps slash-containing model IDs and rejects native or other-connection catalogs', async t => {
  const f = await gateway(t), root = await mkdtemp(join(tmpdir(), 'turnsu-pi-models-'));
  const path = join(root, 'project'); await mkdir(path);
  const host = new LocalAgentHost({ directory: join(root, 'state') });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.configureConnections([{ ...f.profile, protocol: 'chat' }]);
  const project = await host.command('project.open', { path });
  const session = await host.command('session.create', { projectId: project.id, agent: 'pi', connectionId: f.profile.id });
  const models = await host.command('models.list', { sessionId: session.id, agent: 'pi' });
  assert.equal(models[0].id, 'turnsu-company/another/model');
  await host.command('session.model', { sessionId: session.id, model: models[0].id });
  await assert.rejects(host.command('session.model', { sessionId: session.id, model: 'openai/another/model' }), /此连接/);
  await assert.rejects(host.command('session.model', { sessionId: session.id, model: null }), /明确的模型/);
});

test('OpenCode keeps a selected chat gateway and exact model separate from its native account', async t => {
  const f = await gateway(t), root = await mkdtemp(join(tmpdir(), 'turnsu-opencode-gateway-'));
  const path = join(root, 'project'); await mkdir(path);
  const connections = [];
  const host = new LocalAgentHost({ directory: join(root, 'state'), opencodeFactory: options => {
    const connection = { options, sessionId: 'native-gateway-session', ready: Promise.resolve(), closed: false,
      async send(prompt, model) { this.sent = { prompt, model }; },
      async close() { this.closed = true; },
    };
    connections.push(connection); return connection;
  } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.configureConnections([{ ...f.profile, protocol: 'chat' }]);
  const project = await host.command('project.open', { path });
  const session = await host.command('session.create', { projectId: project.id, agent: 'opencode', connectionId: f.profile.id });
  const models = await host.command('models.list', { sessionId: session.id, agent: 'opencode' });
  assert.equal(models[0].id, 'turnsu-company/another/model');
  await host.command('session.model', { sessionId: session.id, model: models[0].id });
  await host.command('session.send', { sessionId: session.id, inputId: 'gateway-prompt', text: 'Report' });
  assert.equal(connections[0].options.gateway.apiKey, f.profile.apiKey);
  assert.equal(connections[0].options.model, models[0].id);
  assert.equal(connections[0].sent.model, models[0].id);
  connections[0].options.onEvent({ type: 'result', stopReason: 'end_turn' });
  await host.command('session.model', { sessionId: session.id, model: models[1].id });
  assert.equal(connections[0].closed, true, 'a gateway model change must release the old native process');
  await host.command('session.send', { sessionId: session.id, inputId: 'gateway-prompt-2', text: 'Continue' });
  assert.equal(connections[1].options.sessionId, 'native-gateway-session');
  assert.equal(connections[1].options.model, models[1].id);
  assert.equal(connections[1].sent.model, models[1].id);
  assert.ok(!(await readFile(join(root, 'state/local.sqlite'))).includes(Buffer.from(f.profile.apiKey)));
});
