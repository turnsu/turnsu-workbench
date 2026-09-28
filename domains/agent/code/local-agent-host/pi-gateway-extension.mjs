// Loaded only in the selected Pi child process. No user-wide models.json/settings are changed.
export default function gatewayExtension(pi) {
  const profile = JSON.parse(process.env.TURNSU_GATEWAY_PROFILE || 'null');
  if (!profile || !process.env.TURNSU_GATEWAY_KEY) throw new Error('Turnsu 模型连接不可用。');
  pi.registerProvider(profile.provider, {
    name: 'Turnsu 工作台连接', baseUrl: profile.baseUrl, api: profile.api, apiKey: process.env.TURNSU_GATEWAY_KEY,
    models: [{ id: profile.model, name: profile.model, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
