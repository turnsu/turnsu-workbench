export const remoteAgents = Object.freeze({
  manus: { id: 'manus', name: 'Manus', kind: 'remote', start: true, followUp: true, stop: true, resume: true, approvals: 'supported-actions', files: true, tools: false, limitation: '使用独立 Manus 云端环境。任务完成前还会核对后台工作；账号原有云端连接器由 Manus 管理。' },
  'workbuddy-local': { id: 'workbuddy-local', name: 'WorkBuddy 本地助理', kind: 'managed', start: true, followUp: true, stop: false, resume: 'message-cursor', approvals: false, files: false, tools: false, limitation: '通过获准 Open API 调用已有本地助理；不保证独立项目会话、目录绑定或停止。批准能力待实际接口验证。' },
  'workbuddy-cloud': { id: 'workbuddy-cloud', name: 'WorkBuddy 云端任务', kind: 'managed', start: true, followUp: true, stop: true, resume: true, approvals: true, files: true, tools: false, limitation: '需要追加云端任务权限，运行在 WorkBuddy 云端环境。' },
  muse: { id: 'muse', name: 'Muse 个人助理', kind: 'handoff', start: 'manual-pickup', followUp: true, stop: 'withdraw-handoff', resume: true, approvals: 'local-actions', files: true, tools: 'approved-handoff', limitation: '通过 Turnsu 任务收件箱双向交接；首次接手需要在 Muse 确认。撤销交接不保证终止 Muse 已经发起的外部动作。' },
});
export function normalizeAgentConnection(input) {
  if (!input || input.provider !== 'manus' || !['api_key','oauth_pkce'].includes(input.mode)) throw new Error('请选择 Manus API v2 密钥连接；其他 Agent 使用各自的授权引导。');
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('连接名称或标识无效。');
  if (input.mode === 'api_key' && input.revoked !== true && (typeof input.apiKey !== 'string' || input.apiKey.length < 8 || input.apiKey.length > 4096 || /[\s\x00-\x1f]/.test(input.apiKey))) throw new Error('请提供有效的 Manus API Key。');
  if (input.accountId != null && (typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 200)) throw new Error('Agent 账号身份无效。');
  if (input.mode === 'oauth_pkce') {
    if (typeof input.clientId !== 'string' || !/^[\w-]{1,200}$/.test(input.clientId) || typeof input.revision !== 'string' || input.revision.length > 100) throw new Error('Manus Team 授权配置无效。');
    if (input.oauth && input.revoked !== true && (typeof input.oauth.accessToken !== 'string' || typeof input.oauth.refreshToken !== 'string' || input.oauth.accessToken.length > 8192 || input.oauth.refreshToken.length > 8192 || !Number.isFinite(input.oauth.expiresAt))) throw new Error('Manus 授权凭据无效。');
    return { accountId: input.accountId || null, id: input.id, provider: 'manus', mode: 'oauth_pkce', name: input.name.trim(), clientId: input.clientId, redirectUri: input.redirectUri, revision: input.revision, ...(input.oauth ? { oauth: input.oauth } : {}), revoked: input.revoked === true, baseUrl: 'https://api.manus.ai/v2', protocol: 'manus-v2' };
  }
  return { accountId: input.accountId || null, id: input.id, provider: 'manus', mode: 'api_key', name: input.name.trim(), apiKey: input.revoked === true ? '' : input.apiKey, revoked: input.revoked === true, baseUrl: 'https://api.manus.ai/v2', protocol: 'manus-v2' };
}
export function publicAgentConnection(input) { const { apiKey, oauth, ...metadata } = input; return metadata; }

export class AgentConnections {
  constructor() { this.profiles = new Map(); }
  configure(profiles) {
    if (!Array.isArray(profiles) || profiles.length > 12) throw new Error('Agent 连接配置无效。');
    const next = profiles.map(normalizeAgentConnection);
    if (new Set(next.map(p => p.id)).size !== next.length) throw new Error('Agent 连接重复。');
    this.profiles = new Map(next.map(p => [p.id, p]));
  }
  list() { return [...this.profiles.values()].map(publicAgentConnection); }
  get(id) { const profile = this.profiles.get(id); if (!profile || profile.revoked) throw new Error('Agent 账号未连接、已撤销或尚未解锁，请在“连接 Agent”处理。'); return profile; }
}

export const serializeAgentSecret = p => p.mode === 'oauth_pkce' ? JSON.stringify(p.oauth || null) : p.apiKey;
export const deserializeAgentSecret = (value, p) => p.mode === 'oauth_pkce' ? { oauth: JSON.parse(value) } : { apiKey: value };
export const agentProfilesForHost = profiles => profiles.map(p => p.mode === 'oauth_pkce' ? publicAgentConnection(p) : p);
