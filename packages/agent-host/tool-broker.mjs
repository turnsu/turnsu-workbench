import { StringDecoder } from 'node:string_decoder';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Private named pipe / Unix socket; never a renderer-accessible HTTP API.
// Tokens bind one native session. The broker does not expose host.command.
export class ToolBroker {
  constructor(host) { this.host = host; this.tokens = new Map(); this.sockets = new Set(); }
  async start() {
    if (!this.ready) this.ready = (async () => {
      if (process.platform === 'win32') this.path = `\\\\.\\pipe\\turnsu-tools-${randomUUID()}`;
      else { this.directory = await mkdtemp(join(tmpdir(), 'turnsu-tools-')); await chmod(this.directory, 0o700); this.path = join(this.directory, 'tools.sock'); }
      this.server = createServer(socket => {
        this.sockets.add(socket); let buffer = '', pending = false; const decoder = new StringDecoder('utf8');
        socket.setTimeout(300_000, () => socket.destroy()); socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket));
        socket.on('data', bytes => {
          buffer += decoder.write(bytes); if (Buffer.byteLength(buffer) > 1_000_000) { socket.destroy(); return; }
          const end = buffer.indexOf('\n'); if (end < 0) return;
          if (pending) { socket.destroy(); return; } pending = true;
          let request; try { request = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
          buffer = buffer.slice(end + 1);
          this.dispatch(request).then(result => socket.end(JSON.stringify({ result }) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
        });
      });
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
      if (this.directory) await chmod(this.path, 0o600);
    })();
    await this.ready;
  }
  async connection(sessionId) {
    const session = this.host.session(sessionId);
    if (!this.host.capabilities.tools(session.project_id).length && !this.host.computer?.tools(session.project_id).length) return null;
    await this.start();
    const old = [...this.tokens].find(([, id]) => id === sessionId);
    const token = old?.[0] || randomBytes(32).toString('hex'); this.tokens.set(token, sessionId);
    return { path: this.path, token };
  }
  async mcp(sessionId) {
    const connection = await this.connection(sessionId); if (!connection) return [];
    return [{ name: 'turnsu', command: process.execPath, args: [process.env.TURNSU_TOOL_MCP || fileURLToPath(new URL('./tool-mcp.mjs', import.meta.url))], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'TURNSU_TOOL_CONNECTION', value: JSON.stringify(connection) }] }];
  }
  async dispatch(request) {
    const sessionId = this.tokens.get(request.token);
    if (!sessionId || this.host.closing) throw new Error('工具连接已失效，请恢复会话。');
    const session = this.host.session(sessionId);
    if (request.method === 'tools/list') return [...this.host.capabilities.tools(session.project_id), ...(this.host.computer?.tools(session.project_id) || [])];
    if (request.method !== 'tools/call' || !['starting', 'running', 'waiting'].includes(session.status)) throw new Error('工具只能在当前正在执行的任务中调用。');
    if (request.name === 'turnsu_document') return this.host.capabilities.call(session.project_id, sessionId, request.arguments || {}, request.callId);
    if (request.name === 'turnsu_computer' && this.host.computer) return this.host.computer.call(session.project_id, sessionId, request.arguments || {});
    throw new Error('工具未授权。');
  }
  release(sessionId) { for (const [token, id] of this.tokens) if (id === sessionId) this.tokens.delete(token); }
  async close() {
    await this.ready?.catch(() => {}); this.tokens.clear(); for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
