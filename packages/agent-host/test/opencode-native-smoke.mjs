// Manual protocol smoke: run in an isolated environment with an installed OpenCode CLI.
// It creates no model turn and uses a temporary empty project.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeConnection } from '../opencode.mjs';

const cwd = await mkdtemp(join(tmpdir(), 'turnsu-opencode-acp-'));
async function within(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
}
let settleTurn;
let answer = '';
const options = {
  cwd, binary: process.env.TURNSU_OPENCODE_BIN,
  onEvent: event => {
    if (event.type === 'update' && event.update.sessionUpdate === 'agent_message_chunk' && event.update.content?.type === 'text') answer += event.update.content.text;
    if (['result', 'error'].includes(event.type)) settleTurn?.(event);
  },
  onExit: () => {},
};
let connection = new OpenCodeConnection(options);
try {
  const result = await within(connection.ready, 20_000, 'OpenCode ACP 初始化超时。');
  if (!result.sessionId) throw new Error('OpenCode 未创建原生会话。');
  await connection.close();
  if (connection.child?.exitCode === null && connection.child?.signalCode === null) throw new Error('OpenCode 进程未随闲置连接退出。');
  connection = new OpenCodeConnection({ ...options, sessionId: result.sessionId });
  const restored = await within(connection.ready, 20_000, 'OpenCode ACP 会话恢复超时。');
  if (restored.sessionId !== result.sessionId) throw new Error('OpenCode 恢复了错误的原生会话。');
  if (process.env.TURNSU_OPENCODE_TEST_TURN === '1') {
    const turnResult = new Promise(resolve => { settleTurn = resolve; });
    await connection.send('Reply with exactly OK. Do not use tools.', null);
    const outcome = await within(turnResult, 45_000, 'OpenCode 模型回合在 45 秒内未结束。');
    if (outcome.type !== 'result' || outcome.stopReason !== 'end_turn') throw new Error(`OpenCode 模型回合未完成：${outcome.message || outcome.stopReason}`);
    console.log(JSON.stringify({ connected: true, resumed: true, models: result.models.length, turn: outcome.stopReason }));
  } else console.log(JSON.stringify({ connected: true, resumed: true, models: result.models.length }));
  if (process.env.TURNSU_OPENCODE_TEST_GATEWAY === '1') {
    await connection.close();
    let server, calls = [];
    try {
      if (process.env.TURNSU_OPENCODE_GATEWAY_TURN === '1') {
        server = createServer(async (request, response) => {
          calls.push({ path: request.url, authorization: request.headers.authorization });
          if (request.headers.authorization !== 'Bearer synthetic-only-key') { response.writeHead(401).end(); return; }
          if (request.method === 'GET' && request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'another/model' }] })); return; }
          if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
          for await (const _chunk of request) { /* drain request before replying */ }
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          for (const choice of [{ delta: { role: 'assistant', content: 'OK' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
            response.write(`data: ${JSON.stringify({ id: 'chatcmpl-turnsu-smoke', object: 'chat.completion.chunk', created: 1, model: 'another/model', choices: [{ index: 0, ...choice }] })}\n\n`);
          }
          response.end('data: [DONE]\n\n');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      }
      connection = new OpenCodeConnection({ ...options, gateway: { id: 'smoke', name: 'Synthetic gateway', baseUrl: `http://127.0.0.1:${server?.address().port || 19876}/v1`, apiKey: 'synthetic-only-key' }, model: 'turnsu-smoke/another/model' });
    const gateway = await within(connection.ready, 30_000, 'OpenCode 自定义网关会话初始化超时。');
    if (!gateway.models.some(item => item.id === 'turnsu-smoke/another/model')) throw new Error('OpenCode 未识别工作台提供的模型连接。');
    console.log(JSON.stringify({ gateway: true, model: 'turnsu-smoke/another/model' }));
      if (server) {
        answer = '';
        const turnResult = new Promise(resolve => { settleTurn = resolve; });
        await connection.send('Reply with exactly OK. Do not use tools.', 'turnsu-smoke/another/model');
        const outcome = await within(turnResult, 45_000, 'OpenCode 网关模型回合超时。');
        if (outcome.type !== 'result' || outcome.stopReason !== 'end_turn' || !answer.includes('OK') || !calls.some(call => call.path === '/v1/chat/completions')) throw new Error(`OpenCode 未通过所选网关完成推理：${outcome.message || outcome.stopReason}`);
        console.log(JSON.stringify({ gatewayTurn: true, calls: calls.map(call => call.path), answer: answer.trim() }));
      }
    } finally {
      await connection.close();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  }
} finally {
  try {
    await connection.close();
    if (connection.child?.exitCode === null && connection.child?.signalCode === null) throw new Error('OpenCode 恢复连接关闭后进程仍在运行。');
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
