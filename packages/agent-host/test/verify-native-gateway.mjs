// Actual installed native Agent + an isolated compatible endpoint; no production key or paid inference.
// Usage: node test/verify-native-gateway.mjs codex|claude|pi [protocol]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { PiConnection } from '../pi.mjs';

const agent = process.argv[2] || 'codex';
if (!['codex', 'claude', 'pi'].includes(agent)) throw new Error('Supported acceptance agents: codex, claude, pi');
const protocol = process.argv[3] || { codex: 'responses', claude: 'messages', pi: 'chat' }[agent];
const root = await mkdtemp(join(tmpdir(), 'turnsu-codex-gateway-'));
process.env.CODEX_HOME = join(root, 'codex'); await mkdir(process.env.CODEX_HOME);
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude'); await mkdir(process.env.CLAUDE_CONFIG_DIR);
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
process.env.PI_CODING_AGENT_DIR = join(root, 'pi'); await mkdir(process.env.PI_CODING_AGENT_DIR);
const requests = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const path = new URL(request.url, 'http://localhost').pathname;
  requests.push({ url: path, method: request.method, auth: request.headers.authorization, apiKey: request.headers['x-api-key'], body: body ? JSON.parse(body) : null });
  if (request.headers.authorization !== 'Bearer test-private-key' && request.headers['x-api-key'] !== 'test-private-key') { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid test token' } })); return; }
  if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'turnsu-contract-model' }] })); return; }
  if (path === '/v1/chat/completions') {
    const chunk = { id: 'chatcmpl_contract', object: 'chat.completion.chunk', created: 1, model: 'turnsu-contract-model' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant', content: 'Turnsu gateway connection verified.' }, {}]) response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: delta.content ? null : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n'); return;
  }
  if (path === '/v1/messages') {
    const text = 'Turnsu gateway connection verified.';
    const events = [
      { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'turnsu-contract-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end(); return;
  }
  if (path !== '/v1/responses') { response.writeHead(404).end(); return; }
  const text = 'Turnsu gateway connection verified.';
  const part = { type: 'output_text', text, annotations: [] };
  const item = { id: 'msg_contract', type: 'message', status: 'completed', role: 'assistant', content: [part] };
  const result = { id: 'resp_contract', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'turnsu-contract-model', output: [item], usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of [
    { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text },
    { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: result },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let host;
try {
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  host = new LocalAgentHost({ directory: join(root, 'state'), ...(agent === 'pi' && process.env.TURNSU_TEST_PI_BIN ? { piFactory: options => new PiConnection({ ...options, binary: process.env.TURNSU_TEST_PI_BIN }) } : {}) });
  await host.configureConnections([{ id: 'contract', name: '合同测试网关', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol, apiKey: 'test-private-key' }]);
  const project = await host.command('project.open', { path: projectPath });
  const session = await host.command('session.create', { projectId: project.id, agent, connectionId: 'contract' });
  await host.command('models.list', { sessionId: session.id, agent });
  await host.command('session.model', { sessionId: session.id, model: agent === 'pi' ? 'turnsu-contract/turnsu-contract-model' : 'turnsu-contract-model' });
  await host.command('session.send', { sessionId: session.id, inputId: 'native-contract-input', text: 'Reply with one sentence. Do not use tools.' });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && ['starting', 'running', 'waiting'].includes(host.session(session.id).status)) await new Promise(resolve => setTimeout(resolve, 100));
  const state = await host.command('session.read', { sessionId: session.id });
  assert.equal(state.status, 'idle', state.error || JSON.stringify(state));
  assert.ok(state.messages.some(m => m.role === 'assistant' && m.text.includes('gateway connection verified')));
  const relay = requests.find(r => r.url === ({ responses: '/v1/responses', messages: '/v1/messages', chat: '/v1/chat/completions' }[protocol]));
  if (protocol !== 'messages') assert.equal(relay?.auth, 'Bearer test-private-key'); else assert.equal(relay?.apiKey, 'test-private-key'); assert.equal(relay?.body.model, 'turnsu-contract-model');
  assert.equal(relay?.body.stream, true);
  console.log(JSON.stringify({ status: 'passed', native: agent, model: 'controlled local HTTP SSE', realGateway: false, requests: requests.map(r => ({ path: r.url, method: r.method })) }));
} finally { await host?.close(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
