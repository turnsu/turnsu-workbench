import { createHash } from 'node:crypto';
const confirmations = new Set(['gmailSendAction', 'outlookSendMailsAction', 'deployAction', 'terminalExecute', 'googleCalendarCreate', 'googleCalendarUpdate', 'googleCalendarDelete', 'outlookCalendarCreate', 'outlookCalendarUpdate', 'outlookCalendarDelete', 'shopifyAction', 'instagramCreateResult', 'mapreduceAction']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Manus API v2 only. No model endpoint fallback and no retry of ambiguous mutations.
export class Manus {
  constructor(profile, { fetch: fetcher = fetch, authorize = null } = {}) { this.profile = profile; this.fetch = fetcher; this.authorize = authorize; }
  async request(operation, data, { read = false, signal } = {}) {
    const url = new URL(`https://api.manus.ai/v2/${operation}`);
    if (read) for (const [key, value] of Object.entries(data || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const auth = this.profile.mode === 'oauth_pkce' ? this.authorize ? await this.authorize({ id: this.profile.id, revision: this.profile.revision }) : this.profile.oauth?.accessToken ? { Authorization: `Bearer ${this.profile.oauth.accessToken}` } : null : { 'x-manus-api-key': this.profile.apiKey };
    if (!auth) throw new Error('请在桌面端重新完成 Manus Team 授权。');
    const response = await this.fetch(url, { method: read ? 'GET' : 'POST', redirect: 'error', headers: { ...auth, ...(read ? {} : { 'Content-Type': 'application/json' }) }, ...(read ? {} : { body: JSON.stringify(data) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    let text = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) { text += decoder.decode(chunk, { stream: true }); if (Buffer.byteLength(text) > 2_000_000) throw new Error('Manus 响应超过上限，请分批读取。'); }
    text += decoder.decode();
    let result; try { result = JSON.parse(text); } catch { throw new Error('Manus 未返回有效响应，请先核对任务是否已创建。'); }
    if (!response.ok || result.ok !== true) {
      const code = result.error?.code || `HTTP_${response.status}`;
      const error = new Error(`Manus 请求未完成（${String(code).slice(0, 100)}）。请检查账号权限或在 Manus 中核对当前任务。`);
      error.rejected = response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status); error.status = response.status; throw error;
    }
    return result;
  }
  async check() { const result = await this.request('user.me', {}, { read: true }); if (typeof result.user_id !== 'string' || !result.user_id) throw new Error('Manus 没有返回有效的账号身份。'); return { connected: true, identity: result.user_id, verification: 'account-only' }; }
  async send(taskId, prompt, files = []) {
    const message = { content: [{ type: 'text', text: prompt, visibility: 'visible' }, ...files] };
    const result = await this.request(taskId ? 'task.sendMessage' : 'task.create', taskId ? { task_id: taskId, message } : { message, interactive_mode: true, share_visibility: 'private', hide_in_task_list: false });
    if (typeof result.task_id !== 'string' || !result.task_id) throw new Error('Manus 没有返回任务 ID，请先核对原生任务，不要重复提交。');
    return { taskId: result.task_id, url: result.task_url || null };
  }
  async poll(taskId, cursor) {
    const messages = await this.request('task.listMessages', { task_id: taskId, order: 'asc', limit: 50, ...(cursor?.page ? { cursor: cursor.page } : cursor?.event ? { start_event_id: cursor.event } : {}) }, { read: true });
    if (!Array.isArray(messages.messages)) throw new Error('Manus 任务事件格式不可用，保留当前游标。');
    const detail = await this.request('task.detail', { task_id: taskId }, { read: true });
    if (!detail.task || detail.task.id !== taskId) throw new Error('Manus 返回的任务不匹配。');
    const events = messages.messages;
    const next = { event: events.at(-1)?.id || cursor?.event || null, page: messages.has_more ? messages.next_cursor : null };
    if (messages.has_more && !next.page) throw new Error('Manus 缺少下一页游标，停止自动读取。');
    const completed = detail.task.status === 'stopped' && detail.task.has_running_background_jobs === false && !messages.has_more;
    const state = completed ? 'completed' : detail.task.status === 'error' ? 'failed' : detail.task.status === 'waiting' ? 'waiting' : 'running';
    const waiting = detail.task.status === 'waiting' ? [...events].reverse().find(e => e.status_update?.agent_status === 'waiting')?.status_update.status_detail : null;
    return { state, events, cursor: next, waiting, backgroundUnknown: detail.task.status === 'stopped' && detail.task.has_running_background_jobs === undefined, more: Boolean(messages.has_more), url: detail.task.task_url };
  }
  async stop(taskId) { await this.request('task.stop', { task_id: taskId }); return { requested: true }; }
  async review(taskId) {
    const detail = await this.request('task.detail', { task_id: taskId }, { read: true });
    const latest = await this.request('task.listMessages', { task_id: taskId, order: 'desc', limit: 100 }, { read: true });
    const waiting = latest.messages?.find(e => e.status_update)?.status_update;
    const target = waiting?.status_detail;
    if (detail.task?.id !== taskId || detail.task.status !== 'waiting' || waiting?.agent_status !== 'waiting' || !confirmations.has(target?.waiting_for_event_type) || !target.waiting_for_event_id) throw new Error('此请求需要在 Manus 原生界面检查和处理。');
    const events = await this.request('task.listMessages', { task_id: taskId, verbose: true, start_event_id: target.waiting_for_event_id, order: 'asc', limit: 1 }, { read: true });
    const event = events.messages?.find(e => e.id === target.waiting_for_event_id && e.type === 'tool_used');
    if (!event?.tool_used?.params && !event?.tool_used?.result) throw new Error('未取得批准所需的实际操作内容，请在 Manus 中检查。');
    const schema = target.confirm_input_schema;
    if (schema && ((schema.required || []).some(k => k !== 'accept') || schema.properties?.accept?.type !== 'boolean')) throw new Error('此请求需要额外配置，请在 Manus 中处理。');
    const context = { taskId, waiting: target, operation: event.tool_used };
    return { ...context, reviewHash: digest(context) };
  }
  async approve(taskId, _waiting, input) {
    if (!input || input.accept !== true || typeof input.reviewHash !== 'string') throw new Error('请先查看实际操作内容，再确认这一次操作。');
    const reviewed = await this.review(taskId);
    if (reviewed.reviewHash !== input.reviewHash) throw new Error('待批准操作已变化，请重新查看；没有发送批准。');
    const result = await this.request('task.confirmAction', { task_id: taskId, event_id: reviewed.waiting.waiting_for_event_id, input: { accept: true } });
    return { submitted: result.confirmed === true };
  }
}
