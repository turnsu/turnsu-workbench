import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { executable } from './codex.mjs';
import { closeNativeProcess, nativeCommand } from './native-process.mjs';

function modelOptions(options = []) {
  const model = options.find(option => option.category === 'model' && option.type === 'select');
  const values = model?.options?.flatMap(option => Array.isArray(option.options) ? option.options : [option]) || [];
  return { configId: model?.id || null, models: values.filter(value => typeof value.value === 'string').map(value => ({ id: value.value, name: value.name || value.value })) };
}

async function startupRequest(client, method, params) {
  let timer;
  try {
    return await Promise.race([
      client.agent.request(method, params),
      new Promise((_, reject) => { timer = setTimeout(() => { client.close(); reject(new Error('OpenCode 未在 30 秒内响应；请检查 CLI、账号和本机资源后重试。')); }, 30_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function gatewayEnvironment(gateway, model, environment = process.env) {
  if (!gateway) return environment;
  const provider = `turnsu-${gateway.id}`;
  if (!model?.startsWith(`${provider}/`)) throw new Error('请先为此 OpenCode 网关会话选择模型。');
  const upstream = model.slice(provider.length + 1);
  let inherited = {};
  if (environment.OPENCODE_CONFIG_CONTENT) {
    try { inherited = JSON.parse(environment.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('OpenCode 原有内联配置不是有效 JSON，请检查本机环境变量。'); }
    if (!inherited || typeof inherited !== 'object' || Array.isArray(inherited) || (inherited.provider && (typeof inherited.provider !== 'object' || Array.isArray(inherited.provider)))) throw new Error('OpenCode 原有内联配置结构无效，请检查本机环境变量。');
  }
  const inlineConfig = { ...inherited, provider: { ...inherited.provider, [provider]: { npm: '@ai-sdk/openai-compatible', name: gateway.name, options: { baseURL: gateway.baseUrl, apiKey: '{env:TURNSU_GATEWAY_KEY}' }, models: { [upstream]: { name: upstream } } } }, model, small_model: model };
  return { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig), TURNSU_GATEWAY_KEY: gateway.apiKey };
}

// One private ACP process owns one native session. Closing it releases its private server,
// while OpenCode keeps the native session for a later session/load.
export class OpenCodeConnection {
  constructor({ cwd, sessionId = null, gateway = null, model = null, onEvent, onExit, binary = executable('opencode'), spawnProcess = spawn }) {
    this.closed = false;
    this.onEvent = onEvent;
    this.permissions = new Map();
    this.modelConfigId = null;
    this.models = [];
    this.replaying = false;
    this.turn = 0;
    this.ready = (async () => {
      if (!binary) throw new Error('请先安装 OpenCode CLI，再重新打开 Agent 列表。');
      const launch = nativeCommand(binary, ['acp'], executable('node'));
      if (this.closed) throw new Error('OpenCode 连接已关闭。');
      const env = gatewayEnvironment(gateway, model);
      this.child = spawnProcess(launch.file, launch.args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stderr?.resume();
      this.child.on('error', () => this.disconnected(onExit));
      this.child.on('exit', () => this.disconnected(onExit));
      const stream = acp.ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout), { maxMessageBytes: 16_000_000 });
      this.client = acp.client({ name: 'turnsu-workbench' })
        .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => this.permission(params, signal, onEvent))
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          if (!this.closed && !this.replaying && params.sessionId === this.sessionId) onEvent({ type: 'update', update: params.update, turn: this.turn });
        }).connect(stream);
      const initialized = await startupRequest(this.client, acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { session: { configOptions: {} } }, clientInfo: { name: 'turnsu-workbench', version: '0.3.0' },
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error('OpenCode 的 ACP 协议版本与当前工作台不兼容，请更新 OpenCode。');
      if (sessionId && !initialized.agentCapabilities?.loadSession) throw new Error('此 OpenCode 版本不能恢复原生会话；已有本机结果仍可查看。');
      this.replaying = Boolean(sessionId);
      try {
        const session = sessionId
          ? await startupRequest(this.client, acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] })
          : await startupRequest(this.client, acp.methods.agent.session.new, { cwd, mcpServers: [] });
        this.sessionId = sessionId || session.sessionId;
        if (!this.sessionId) throw new Error('OpenCode 未返回原生会话标识。');
        const catalog = modelOptions(session.configOptions);
        this.modelConfigId = catalog.configId; this.models = catalog.models;
      } finally { this.replaying = false; }
      return { sessionId: this.sessionId, models: this.models };
    })();
  }

  disconnected(onExit) {
    if (this.closed) return;
    this.closed = true;
    this.cancelPermissions();
    this.client?.close();
    onExit();
  }

  permission(params, signal, onEvent) {
    if (this.closed || signal.aborted || params.sessionId !== this.sessionId) return { outcome: { outcome: 'cancelled' } };
    const id = randomUUID();
    return new Promise(resolve => {
      const done = outcome => {
        signal.removeEventListener('abort', abort);
        this.permissions.delete(id);
        resolve({ outcome });
        onEvent({ type: 'permission_closed', id });
      };
      const abort = () => done({ outcome: 'cancelled' });
      this.permissions.set(id, { options: params.options, done });
      signal.addEventListener('abort', abort, { once: true });
      onEvent({ type: 'permission', id, title: params.toolCall.title || 'OpenCode 请求权限', tool: params.toolCall.name || params.toolCall.kind || 'tool', options: params.options });
    });
  }

  respond(id, decision) {
    const request = this.permissions.get(id);
    if (!request) throw new Error('这个 OpenCode 权限请求已结束。');
    if (decision === 'decline') return request.done({ outcome: 'cancelled' });
    if (decision !== 'accept') throw new Error('请选择允许一次或拒绝。');
    const once = request.options.find(option => option.kind === 'allow_once');
    if (!once) throw new Error('OpenCode 未提供单次允许选项，不能扩大授权范围。');
    request.done({ outcome: 'selected', optionId: once.optionId });
  }

  cancelPermissions() { for (const request of [...this.permissions.values()]) request.done({ outcome: 'cancelled' }); }

  async send(text, model) {
    await this.ready;
    if (this.closed) throw new Error('OpenCode 已断开，请恢复任务后核对结果。');
    if (model) {
      if (!this.modelConfigId || !this.models.some(item => item.id === model)) throw new Error('所选 OpenCode 模型不在当前原生会话的可用列表中。');
      await startupRequest(this.client, acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: this.modelConfigId, value: model });
    }
    const turn = ++this.turn;
    this.client.agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
      .then(result => { if (!this.closed) this.onEvent({ type: 'result', turn, stopReason: result.stopReason }); })
      .catch(error => { if (!this.closed) this.onEvent({ type: 'error', turn, message: error.message }); });
    return turn;
  }

  async stop() {
    await this.ready;
    this.cancelPermissions();
    await this.client.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.cancelPermissions(); this.client?.close();
    this.closePromise = (async () => { await closeNativeProcess(this.child); await this.ready.catch(() => {}); })();
    return this.closePromise;
  }
}
