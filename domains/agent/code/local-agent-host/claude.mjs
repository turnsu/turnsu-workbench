import { randomUUID } from 'node:crypto';
import { executable } from './codex.mjs';
import { nativeCommand, closeNativeProcess } from './native-process.mjs';
import { dirname, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

class InputQueue {
  items = []; waiter = null; closed = false;
  push(value) { if (this.closed) throw new Error('Claude Code 输入已关闭。'); if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value, done: false }); } else this.items.push(value); }
  close() { this.closed = true; this.items = []; this.waiter?.({ done: true }); this.waiter = null; }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise((resolve) => { this.waiter = resolve; }); }
}

export class ClaudeConnection {
  constructor({ cwd, sessionId, resume = false, onEvent, onExit, gateway = null, binary = executable('claude'), sdkLoader = () => import('@anthropic-ai/claude-agent-sdk') }) {
    this.closed = false; this.input = new InputQueue(); this.permissions = new Map(); this.sessionId = sessionId; this.onEvent = onEvent;
    this.ready = (async () => {
      if (!binary) throw new Error('请先安装 Claude Code，再重新打开 Turnsu。');
      const launch = nativeCommand(binary, [], executable('node'));
      const sdk = await sdkLoader();
      if (this.closed) throw new Error('Claude Code 连接已关闭。');
      if (resume) {
        const info = await sdk.getSessionInfo(sessionId, { dir: cwd });
        if (!info) throw new Error('Claude Code 原生会话文件不可用，请恢复该会话后继续。桌面保留的结果仍可查看。');
        const history = await sdk.getSessionMessages(sessionId, { dir: cwd });
        if (this.closed) throw new Error('Claude Code 连接已关闭。');
        for (const item of history) if (item.type === 'assistant') onEvent(item);
      }
      this.query = sdk.query({ prompt: this.input, options: {
        cwd, pathToClaudeCodeExecutable: launch.entry || binary, ...(launch.entry ? { executable: 'node' } : {}), ...(resume ? { resume: sessionId } : { sessionId }),
        env: { ...process.env, PATH: `${dirname(launch.file)}${delimiter}${process.env.PATH || ''}`, ...(gateway ? { ANTHROPIC_BASE_URL: gateway.baseUrl.replace(/\/v1$/, ''), ANTHROPIC_API_KEY: gateway.apiKey, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined } : {}) },
        spawnClaudeCodeProcess: options => {
          if (this.closed) throw new Error('Claude Code 连接已关闭。');
          this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
          this.child.stderr.resume(); return this.child;
        },
        permissionMode: 'default', settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' }, includePartialMessages: true,
        extraArgs: { 'replay-user-messages': null },
        canUseTool: (tool, input, options) => this.permission(tool, input, options),
        stderr: () => {},
      } });
      this.reading = (async () => {
        try { for await (const message of this.query) { if (!this.closed) onEvent(message); } }
        catch (error) { if (!this.closed) onEvent({ type: 'connection_error', message: error.message }); }
        finally { if (!this.closed) { this.closed = true; this.cancelPermissions(); this.input.close(); onExit(); } }
      })();
      this.models = await this.query.supportedModels();
      return { models: this.models };
    })();
  }
  permission(tool, input, options) {
    if (this.closed || options.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'Request cancelled' });
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (result) => { options.signal.removeEventListener('abort', abort); this.permissions.delete(id); resolve(result); this.onEvent({ type: 'permission_closed', id }); };
      const abort = () => finish({ behavior: 'deny', message: 'Request cancelled' });
      this.permissions.set(id, { input, tool, finish }); options.signal.addEventListener('abort', abort, { once: true });
      this.onEvent({ type: 'permission', id, tool, input, title: options.title || options.displayName || `允许 Claude Code 使用 ${tool}？`, description: options.description || options.decisionReason || '' });
    });
  }
  respond(id, decision, answers) {
    const item = this.permissions.get(id); if (!item) throw new Error('这个 Claude Code 请求已经结束。');
    if (decision === 'decline') item.finish({ behavior: 'deny', message: 'User declined this request' });
    else if (decision === 'accept') item.finish({ behavior: 'allow', updatedInput: item.tool === 'AskUserQuestion' ? { ...item.input, answers } : item.input });
    else throw new Error('请选择允许一次或拒绝。');
  }
  cancelPermissions() { for (const p of [...this.permissions.values()]) p.finish({ behavior: 'deny', message: 'Request cancelled', interrupt: true }); }
  async send(id, text, model) {
    await this.ready; if (this.closed) throw new Error('Claude Code 已断开，请恢复任务后检查结果。');
    await this.query.setModel(model || undefined);
    this.input.push({ type: 'user', uuid: id, session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content: text } });
  }
  async stop() { this.cancelPermissions(); await this.query.interrupt(); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.cancelPermissions(); this.input.close(); this.query?.close();
    this.closePromise = (async () => { await closeNativeProcess(this.child); await this.reading; })();
    return this.closePromise;
  }
}
