import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable } from './codex.mjs';
import { nativeCommand, closeNativeProcess } from './native-process.mjs';

const run = promisify(execFile);
export class PiConnection {
  constructor({ cwd, sessionPath, onEvent, onExit, tools = null, gateway = null, model = null, binary = executable('pi'), spawnProcess = spawn, checkVersion = true }) {
    this.pending = new Map(); this.dialogs = new Map(); this.closed = false; this.sequence = 0;
    this.startController = new AbortController();
    this.disconnect = () => {
      if (this.closed) return; this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Pi 连接已断开，请恢复任务后检查结果。')); }
      this.pending.clear(); onExit();
      for (const timer of this.dialogs.values()) clearTimeout(timer); this.dialogs.clear();
    };
    this.ready = (async () => {
      if (!binary) throw new Error('请先安装 Pi CLI，再重新打开 Turnsu。');
      const env = { ...process.env, PATH: `${dirname(binary)}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` };
      const providerArgs = [];
      if (tools) { env.TURNSU_TOOL_CONNECTION = JSON.stringify(tools); providerArgs.push('--extension', process.env.TURNSU_TOOLS_EXTENSION || fileURLToPath(new URL('./pi-tools-extension.mjs', import.meta.url))); }
      if (gateway) {
        const provider = `turnsu-${gateway.id}`;
        if (!model?.startsWith(provider + '/')) throw new Error('请先为此 Pi 连接选择模型。');
        env.TURNSU_GATEWAY_KEY = gateway.apiKey;
        env.TURNSU_GATEWAY_PROFILE = JSON.stringify({ provider, baseUrl: gateway.protocol === 'messages' ? gateway.baseUrl.replace(/\/v1$/, '') : gateway.baseUrl, api: { responses: 'openai-responses', messages: 'anthropic-messages', chat: 'openai-completions' }[gateway.protocol], model: model.slice(provider.length + 1) });
        providerArgs.push('--extension', process.env.TURNSU_GATEWAY_EXTENSION || fileURLToPath(new URL('./pi-gateway-extension.mjs', import.meta.url)), '--provider', provider, '--model', model.slice(provider.length + 1));
      }
      if (checkVersion) {
        let stdout;
        try { const launch = nativeCommand(binary, ['--version'], executable('node')); ({ stdout } = await run(launch.file, launch.args, { env, timeout: 30_000, signal: this.startController.signal })); }
        catch { throw new Error(this.closed ? 'Pi 连接已关闭。' : '暂时无法启动 Pi。请确认本机 Pi CLI 可以打开，再重试；任务草稿已保留。'); }
        const version = stdout.trim().match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)/);
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < 87)) throw new Error('桌面接入需要 Pi 0.87.0 或更新版本。请更新本机 Pi，现有配置和会话可继续使用。');
      }
      if (this.closed) throw new Error('Pi 连接已关闭。');
      const launch = nativeCommand(binary, ['--mode', 'rpc', ...providerArgs, ...(sessionPath ? ['--session', sessionPath] : ['--no-session'])], executable('node'));
      this.child = spawnProcess(launch.file, launch.args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stderr.on('data', () => {});
      let buffer = '';
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 16_000_000) { this.child.kill('SIGTERM'); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.type === 'response') {
            const pending = this.pending.get(message.id); if (!pending) continue;
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.success) pending.resolve(message.data); else pending.reject(Object.assign(new Error(message.error || 'Pi 请求失败。'), { rejected: true }));
          } else {
            if (message.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(message.method)) {
              const timer = message.timeout ? setTimeout(() => this.dialogClosed(message.id), message.timeout) : null;
              this.dialogs.set(message.id, timer);
              for (const pending of this.pending.values()) if (pending.type === 'prompt') clearTimeout(pending.timer);
            }
            onEvent(message);
          }
        }
      });
      this.child.on('error', this.disconnect); this.child.on('exit', this.disconnect);
      return this.request('get_state');
    })();
  }
  write(message) {
    if (!this.child || this.closed || this.child.stdin.destroyed) return Promise.reject(new Error('Pi 连接已断开。'));
    return new Promise((resolve, reject) => this.child.stdin.write(JSON.stringify(message) + '\n', (e) => e ? reject(e) : resolve()));
  }
  request(type, params = {}) {
    const id = `turnsu-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, type, timer: null, arm: () => {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Pi 尚未确认操作。请恢复会话检查结果，不要重复发送。')); }, 30_000);
      } };
      pending.arm(); this.pending.set(id, pending);
      this.write({ ...params, id, type }).catch((e) => { clearTimeout(pending.timer); this.pending.delete(id); reject(e); });
    });
  }
  dialogClosed(id) {
    clearTimeout(this.dialogs.get(id)); this.dialogs.delete(id);
    if (!this.dialogs.size) for (const pending of this.pending.values()) if (pending.type === 'prompt') pending.arm();
  }
  async respond(id, response) { await this.write({ type: 'extension_ui_response', id, ...response }); this.dialogClosed(id); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.disconnect(); this.startController.abort();
    this.closePromise = (async () => { await closeNativeProcess(this.child); await this.ready.catch(() => {}); })();
    return this.closePromise;
  }
}
