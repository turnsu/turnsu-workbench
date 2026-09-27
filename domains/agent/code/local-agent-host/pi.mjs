import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, delimiter } from 'node:path';
import { executable } from './codex.mjs';

const run = promisify(execFile);
export class PiConnection {
  constructor({ cwd, sessionPath, onEvent, onExit, binary = executable('pi'), spawnProcess = spawn, checkVersion = true }) {
    this.pending = new Map(); this.dialogs = new Map(); this.closed = false; this.sequence = 0;
    this.ready = (async () => {
      if (!binary) throw new Error('请先安装 Pi CLI，再重新打开 Turnsu。');
      const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` };
      if (checkVersion) {
        let stdout;
        try { ({ stdout } = await run(binary, ['--version'], { env, timeout: 30_000 })); }
        catch { throw new Error('暂时无法启动 Pi。请确认本机 Pi CLI 可以打开，再重试；任务草稿已保留。'); }
        const version = stdout.trim().match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)/);
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < 87)) throw new Error('桌面接入需要 Pi 0.87.0 或更新版本。请更新本机 Pi，现有配置和会话可继续使用。');
      }
      this.child = spawnProcess(binary, ['--mode', 'rpc', ...(sessionPath ? ['--session', sessionPath] : ['--no-session'])], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
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
      const exit = () => {
        if (this.closed) return; this.closed = true;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Pi 连接已断开，请恢复任务后检查结果。')); }
        this.pending.clear(); onExit();
        for (const timer of this.dialogs.values()) clearTimeout(timer); this.dialogs.clear();
      };
      this.child.on('error', exit); this.child.on('exit', exit);
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
    if (!this.child || this.closed) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); resolve(); }, 700);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
