import { StringDecoder } from 'node:string_decoder';
import { callBroker } from './tool-client.mjs';
import { randomUUID } from 'node:crypto';
const transportId = randomUUID();
const connection = JSON.parse(process.env.TURNSU_TOOL_CONNECTION || 'null');
if (!connection?.path || !connection?.token) throw new Error('private_tool_connection_required');
let buffer = ''; const decoder = new StringDecoder('utf8');
process.stdin.on('data', bytes => {
  buffer += decoder.write(bytes); if (Buffer.byteLength(buffer) > 1_000_000) process.exit(1);
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    handle(request).then(result => output({ jsonrpc: '2.0', id: request.id, result }), error => output({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
function output(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'turnsu-project-tools', version: '1.0.0' } };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools: await callBroker(connection, { method: 'tools/list' }) };
  if (request.method === 'tools/call') {
    try { const result = await callBroker(connection, { method: 'tools/call', name: request.params.name, arguments: request.params.arguments, callId: `${transportId}:${request.id}` }); return { content: Array.isArray(result.content) ? result.content : [{ type: 'text', text: JSON.stringify(result) }], isError: false }; }
    catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  }
  throw new Error('不支持这个工具协议操作。');
}
