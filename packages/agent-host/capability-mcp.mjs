import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { closeNativeProcess } from './native-process.mjs';

// A private client for an application-owned service. No user command interpolation or shell.
export class CapabilityMcp {
  constructor(file, args, { children, timeout = 60_000 } = {}) {
    this.pending = new Map(); this.sequence = 0; this.timeout = timeout;
    this.child = spawn(file, args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); children?.add(this.child);
    let buffer = ''; const decoder = new StringDecoder('utf8');
    this.child.stderr.resume(); this.child.stdin.on('error', () => {});
    this.child.on('error', () => this.fail('电脑工具连接未启动，请检查运行环境。'));
    this.child.on('exit', () => { children?.delete(this.child); this.fail('电脑工具连接已停止。'); });
    this.child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes); if (Buffer.byteLength(buffer) > 8_000_000) { this.fail('电脑结果超过上限。'); this.close(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let message;
        try { message = JSON.parse(line); } catch { this.fail('电脑服务返回了无效协议。'); this.close(); return; }
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(message.error.message || '电脑工具失败。')) : pending.resolve(message.result);
      }
    });
  }
  fail(message) { this.closed = true; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); } this.pending.clear(); }
  async initialize() { await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'turnsu-workbench', version: '1.0.0' } }, 5000); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); return this.request('tools/list', {}, 5000); }
  request(method, params, timeout = this.timeout) {
    if (this.closed) return Promise.reject(new Error('电脑工具连接已停止。'));
    if (this.pending.size >= 4) return Promise.reject(new Error('电脑操作仍在执行，请等待。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('电脑工具响应未确认，请核对当前应用后恢复。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async close() { this.fail('电脑工具连接已停止。'); await closeNativeProcess(this.child); }
}
