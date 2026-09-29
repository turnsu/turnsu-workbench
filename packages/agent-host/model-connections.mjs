export const gatewayDefault = 'https://gateway.turnsu.org/v1';
export const protocolAgents = Object.freeze({ responses: ['codex', 'pi'], messages: ['claude', 'pi'], chat: ['pi', 'opencode'] });

export function normalizeConnection(input) {
  if (!input || typeof input !== 'object') throw new Error('请填写模型连接。');
  const { id, protocol } = input;
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('连接标识无效。');
  if (!Object.hasOwn(protocolAgents, protocol)) throw new Error('请选择受支持的模型协议。');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 60) throw new Error('连接名称应为 1–60 个字符。');
  let url;
  try { url = new URL(input.baseUrl); } catch { throw new Error('请输入完整的 API 地址。'); }
  if (url.username || url.password || url.search || url.hash || url.href.length > 2048) throw new Error('API 地址不能包含账号、密钥、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程模型连接需要 HTTPS；HTTP 仅用于本机服务。');
  const baseUrl = url.href.replace(/\/+$/, '') + (url.pathname === '/' ? '/v1' : '');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new Error('请输入有效的 API Key。');
  return { id, name, baseUrl, protocol, apiKey };
}

export function publicConnection({ id, name, baseUrl, protocol }) {
  return { id, name, baseUrl, protocol, agents: protocolAgents[protocol] };
}

export async function discoverModels(connection, fetcher = fetch) {
  const profile = normalizeConnection(connection);
  let response;
  try { response = await fetcher(`${profile.baseUrl}/models`, { headers: { Authorization: `Bearer ${profile.apiKey}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('无法读取模型目录，请检查地址、网络或服务状态。连接不会自动切换。'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? '网关拒绝了此令牌，请检查密钥、模型授权或令牌状态。' : `模型目录读取失败（HTTP ${response.status}），请稍后重试。`); }
  let bytes = 0, chunks = [];
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1_000_000) throw new Error('模型目录过大，请检查 API 地址。'); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('该地址没有返回有效的模型目录。'); }
  if (!Array.isArray(body.data)) throw new Error('该地址没有返回兼容的模型目录。');
  const ids = new Set();
  for (const model of body.data) if (typeof model.id === 'string' && model.id.length > 0 && model.id.length <= 256 && !/[\x00-\x1f]/.test(model.id)) ids.add(model.id);
  if (!ids.size) throw new Error('此令牌没有可用模型，请在网关检查授权后重试。');
  if (ids.size > 1000) throw new Error('模型目录超过 1000 项，请在网关缩小此令牌可用范围。');
  return [...ids].sort().map(id => ({ id, name: id }));
}

export class ModelConnections {
  constructor() { this.profiles = new Map(); this.updating = new Set(); }
  get(id, agent) {
    if (!id) return null;
    if (this.updating.has(id)) throw new Error('模型连接正在更新，请稍后重试。');
    const profile = this.profiles.get(id);
    if (!profile) throw new Error('此任务的模型连接不可用，请在模型连接设置中恢复密钥；不会改用其他账号。');
    if (agent && !protocolAgents[profile.protocol].includes(agent)) throw new Error('这个模型协议不适用于所选 Agent。');
    return profile;
  }
  list() { return [...this.profiles.values()].map(publicConnection); }
  async models(id, agent) {
    const profile = this.get(id, agent), models = await discoverModels(profile);
    return ['pi', 'opencode'].includes(agent) ? models.map(m => ({ ...m, id: `turnsu-${id}/${m.id}`, provider: `turnsu-${id}`, modelId: m.id })) : models;
  }
}
