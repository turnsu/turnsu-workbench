import { randomUUID } from 'node:crypto';
import { ConnectorError, requireValue } from './store.mjs';

async function json(response, max = 2_000_000) {
  let bytes = 0; const parts = [];
  for await (const part of response.body) { if ((bytes += part.length) > max) throw new ConnectorError('WorkBuddy 响应超过读取上限。',502); parts.push(part); }
  let result; try { result = JSON.parse(Buffer.concat(parts).toString()); } catch { throw new ConnectorError('WorkBuddy 响应格式不可用。',502); }
  requireValue(response.ok, `WorkBuddy 请求失败（HTTP ${response.status}）。`, response.status === 401 ? 401 : 502); return result;
}
export class WorkBuddy {
  constructor({ clientId, clientSecret, callback, fetch: fetcher = fetch }) { Object.assign(this, { clientId, clientSecret, callback, fetch: fetcher }); }
  async token(parameters) {
    const response = await this.fetch('https://www.workbuddy.cn/openapi/v2/token', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...parameters }), signal: AbortSignal.timeout(20_000) });
    const value = await json(response);
    requireValue(typeof value.access_token === 'string' && value.token_type === 'Bearer' && Number.isFinite(value.expires_in) && value.expires_in > 30, 'WorkBuddy 没有返回有效的授权凭据。',502); return value;
  }
  async api(accessToken, path, body) {
    requireValue(path.startsWith('/localassistant') || /^\/tasks(?:\/[a-zA-Z0-9_-]+)?$/.test(path), 'WorkBuddy API 路径不可用。');
    const value = await json(await this.fetch(`https://www.workbuddy.cn/openapi/v2${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) }));
    requireValue(value && typeof value === 'object' && (value.code === undefined || value.code === 0), 'WorkBuddy 未接受本次请求。请检查授权或原生任务。',502);
    if (path.startsWith('/localassistant')) requireValue(value.code === 0 && value.data, '本地助理响应缺少 data。',502);
    return value.code === 0 ? value.data : value;
  }
  async artifacts(ticket, taskId, offset = 0) {
    const origin = cloudEndpoint(ticket.link, taskId).origin;
    const url = new URL('/api/session/artifacts', origin);
    for (const [key, value] of Object.entries({sessionId: taskId, limit: 50, offset})) url.searchParams.set(key, value);
    const value = await json(await this.fetch(url, { headers: { Authorization: `Bearer ${ticket.token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }));
    requireValue(value.code === 0 && value.data?.sessionId === taskId && Array.isArray(value.data?.artifacts) && value.data.artifacts.length <= 50, 'WorkBuddy 成果列表不可用。',502);
    return value.data;
  }
  async artifactBytes(ticket, taskId, uri) {
    const origin = cloudEndpoint(ticket.link, taskId).origin;
    requireValue(typeof uri === 'string' && /^agent:\/\/\/artifacts\/[^?#]+$/.test(uri), '成果路径不可用。');
    const url = new URL(uri.slice('agent://'.length), origin);
    requireValue(url.origin === origin && url.pathname.startsWith('/artifacts/'), '成果路径越界。',403);
    const response = await this.fetch(url, {headers: {Authorization: `Bearer ${ticket.token}`}, redirect: 'error', signal: AbortSignal.timeout(30_000)});
    requireValue(response.ok, 'WorkBuddy 成果暂不可下载，请刷新后重试。',502);
    let size = 0; const chunks = [];
    for await (const bytes of response.body) { requireValue((size += bytes.length) <= 20_000_000, '成果超过 20 MB，请在原生服务下载。',413); chunks.push(bytes); }
    return Buffer.concat(chunks);
  }
  authorize(state, scopes) { const url = new URL('https://www.workbuddy.cn/openapi/v2/authorize'); for (const [key, value] of Object.entries({ response_type: 'code', client_id: this.clientId, redirect_uri: this.callback, scope: scopes.join(' '), state })) url.searchParams.set(key,value); return url.href; }
}

export function cloudEndpoint(link, taskId) {
  let url; try { url = new URL(link); } catch { throw new ConnectorError('WorkBuddy 尚未提供 ACP 地址。',502); }
  const sandbox = url.hostname.endsWith('.agentos-run.net') && url.pathname === '/acp';
  const gateway = url.hostname === 'acp.workbuddy.cn' && url.pathname === `/sessions/${taskId}`;
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443') && (sandbox || gateway), 'WorkBuddy ACP 地址不在官方任务域名范围。',502);
  return url;
}

// The cloud API uses paired GET-SSE / POST JSON-RPC, not a WebSocket or the local CLI.
export class WorkBuddyCloudChannel {
  constructor({ task, ticket, fetch: fetcher = fetch, onEvent, onState, onClose = () => {} }) {
    this.task = task; this.ticket = ticket; this.fetch = fetcher; this.onEvent = onEvent; this.onState = onState; this.onClose = onClose; this.text = ''; this.serial = 0; this.receivedBytes = 0; this.lastFlush = Date.now();
    this.controller = new AbortController(); this.pending = new Map(); this.closed = false; this.permission = null;
  }
  async start() {
    const url = cloudEndpoint(this.ticket.link, this.task.native_id);
    const response = await this.fetch(url, { headers: { Authorization: `Bearer ${this.ticket.token}`, Accept: 'text/event-stream' }, redirect: 'error', signal: this.controller.signal });
    this.connectionId = response.headers.get('Acp-Connection-Id');
    requireValue(response.ok && this.connectionId && response.headers.get('content-type')?.includes('text/event-stream'), 'WorkBuddy 实时通道未建立。',502);
    this.reading = this.consume(response).catch(async () => { if (!this.closed) await this.onState('uncertain', null); }).finally(() => this.close());
    this.initialized = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'turnsu-workbench', version: '0.3.0' } });
    await this.request('session/load', { sessionId: this.task.native_id, cwd: '/workspace', mcpServers: [] });
    this.deadline = setTimeout(() => { this.onState('uncertain', null).catch(() => {}); this.close(); }, 30 * 60_000); this.deadline.unref();
  }
  async post(message) {
    requireValue(!this.closed, '实时通道已断开，请核对原生结果后恢复。',409);
    const response = await this.fetch(this.ticket.link, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.ticket.token}`, 'Content-Type': 'application/json', 'Acp-Connection-Id': this.connectionId }, body: JSON.stringify(message), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]) });
    await response.body?.cancel(); requireValue(response.ok, `WorkBuddy 实时请求尚未确认（HTTP ${response.status}）。`,502);
  }
  request(method, params) {
    const id = randomUUID(); let timer;
    return new Promise((resolve, reject) => { timer = setTimeout(() => { this.pending.delete(id); reject(new ConnectorError('WorkBuddy 实时查询超时。',504)); }, 30_000); this.pending.set(id, { resolve, reject, timer }); this.post({ jsonrpc:'2.0', id, method, params }).catch(error => { this.pending.delete(id); clearTimeout(timer); reject(error); }); });
  }
  async prompt(prompt, files) {
    const content = [{ type:'text', text: prompt }];
    if (files.length) {
      requireValue(this.initialized?.agentCapabilities?.promptCapabilities?.embeddedContext === true, '此 WorkBuddy 云端未声明附件上下文能力；材料没有发送。');
      for (const file of files) { const match = /^data:([^;]+);base64,(.+)$/s.exec(file.file_data || ''); requireValue(match, '文件材料格式无效。'); content.push({ type:'resource', resource: { uri:`turnsu-material:///${encodeURIComponent(file.filename)}`, mimeType:match[1], blob:match[2] } }); }
    }
    this.promptId = randomUUID(); await this.post({ jsonrpc:'2.0', id:this.promptId, method:'session/prompt', params:{ sessionId:this.task.native_id, prompt:content } });
  }
  async stop() { await this.post({ jsonrpc:'2.0', method:'session/cancel', params:{ sessionId:this.task.native_id } }); return { requested:true }; }
  async approve(input) {
    const request = this.permission;
    requireValue(request && input?.requestId === String(request.id) && request.params.options.some(o => o.optionId === input.optionId && o.kind === 'allow_once'), '请选择当前请求的单次授权选项。');
    await this.post({ jsonrpc:'2.0', id:request.id, result:{ outcome:{ outcome:'selected', optionId:input.optionId } } }); this.permission = null; await this.onState('running',null); return { submitted:true };
  }
  async consume(response) {
    const decoder = new TextDecoder(); let buffer = '', serial = 0;
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream:true }).replace(/\r\n/g,'\n'); requireValue(buffer.length <= 2_000_000,'WorkBuddy 实时帧过大。',502);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0,end); buffer = buffer.slice(end+2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (!data) continue;
        const message = JSON.parse(data); const pending = this.pending.get(message.id);
        if (pending && !message.method) { this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new ConnectorError('WorkBuddy 拒绝协议请求。',502)) : pending.resolve(message.result); continue; }
        if (message.id === this.promptId && !message.method) { await this.flushText(); await this.onState(message.error ? 'failed' : message.result?.stopReason === 'end_turn' ? 'completed' : 'stopped', null); return; }
        if (message.method === 'session/request_permission') { await this.flushText(); this.permission = message; await this.onState('waiting', { requestId:String(message.id), operation:message.params.toolCall, options:(message.params.options || []).filter(o => o.kind === 'allow_once'), waiting_description:message.params.toolCall?.title || 'WorkBuddy 需要授权' }); continue; }
        if (message.id !== undefined && message.method) { await this.post({ jsonrpc:'2.0',id:message.id,error:{ code:-32601,message:'Desktop resource access is not provided by this connector.' } }); continue; }
        if (message.method === 'session/update' && message.params?.sessionId === this.task.native_id) {
          const update = message.params.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') { this.receivedBytes += Buffer.byteLength(update.content.text); requireValue(this.receivedBytes <= 4_000_000, '任务进展超过同步上限，请在原生服务核对。',502); this.text += update.content.text; if (this.text.length >= 512 || Date.now() - this.lastFlush >= 500) await this.flushText(); }
          else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') { await this.flushText(); requireValue(++serial <= 2000, '任务工具事件超过同步上限。',502); await this.onEvent(`${this.connectionId}:tool:${serial}`, { progress:{ title:update.title, status:update.status } }); }
        }
        // Durable artifact snapshots are read from the provider REST endpoint during poll.
      }
    }
    if (!this.closed) throw new ConnectorError('WorkBuddy 实时流结束，执行结果尚未确认。',502);
  }
  async flushText() { if (!this.text) return; const content = this.text; this.text = ''; this.lastFlush = Date.now(); await this.onEvent(`${this.connectionId}:text:${++this.serial}`, {assistant_message: {content}}); }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.deadline); this.controller.abort(); for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new ConnectorError('WorkBuddy 实时连接已关闭。',409)); } this.pending.clear(); this.onClose(); }
}
