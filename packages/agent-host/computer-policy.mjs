import { isAbsolute } from 'node:path';

export const DRIVER_VERSION = '0.30.4';
const browserTools = ['start_session', 'end_session', 'list_windows', 'browser_prepare', 'get_browser_state', 'browser_navigate', 'browser_click', 'browser_type', 'browser_download'];
const appTools = ['start_session', 'end_session', 'launch_app', 'list_windows', 'get_window_state', 'click', 'type_text', 'press_key', 'scroll'];
const fail = message => { throw new Error(message); };

// This constructs a complete reviewed policy. Agent-provided YAML and tool lists are never accepted.
export function computerPolicy(input, { platform = process.platform, inputDirectory, outputDirectory }) {
  if (input.acknowledged !== true || !['isolated', 'local'].includes(input.mode) || !['browser', 'app'].includes(input.target)) fail('请明确确认电脑操作模式和范围。');
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 480) fail('电脑操作授权应为 1 至 480 分钟。');
  if (input.mode === 'isolated' && input.target !== 'browser') fail('隔离电脑当前支持浏览器任务；本机应用请选择明确授权的本机模式。');
  const manifest = { version: 3, expires_after: `${input.minutes}m`, idle_timeout: '5m', allow: { tools: input.target === 'browser' ? browserTools : appTools }, resources: { desktop: { display: false }, files: { read: [{ dir: inputDirectory, recursive: true }], write: [{ dir: outputDirectory, recursive: true }] } } };
  if (input.target === 'browser') {
    if (!Array.isArray(input.origins) || !input.origins.length || input.origins.length > 20) fail('请列出允许操作的网站来源。');
    const origins = input.origins.map(value => {
      let url; try { url = new URL(value); } catch { fail('网站来源无效。'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('请输入完整 HTTPS 来源，不包含路径、参数或账号。');
      return url.origin;
    });
    if (input.mode === 'isolated') manifest.resources.apps = [{ executable: '/usr/lib/chromium/chromium', launch: true, windows: 'all', terminate: 'driver_launched' }];
    manifest.resources.browser = { origins: [...new Set(['about:blank', ...origins])], profiles: [{ kind: input.mode === 'local' ? 'existing_profile' : 'isolated' }] };
  } else {
    if (!Array.isArray(input.apps) || !input.apps.length || input.apps.length > 5) fail('请选择最多 5 个获准应用。');
    manifest.resources.apps = input.apps.map(app => {
      if (typeof app !== 'string' || app.length > 1000 || /[\r\n\0]/.test(app)) fail('应用标识无效。');
      if (platform === 'darwin' ? !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(app) : !isAbsolute(app)) fail(platform === 'darwin' ? '请输入应用的 Bundle ID。' : '应用必须使用完整可执行文件路径。');
      return { [platform === 'darwin' ? 'bundle_id' : 'executable']: app, launch: true, windows: 'all', terminate: 'driver_launched' };
    });
  }
  if (input.mode === 'local' && input.target === 'browser') {
    const scoped = computerPolicy({...input,target:'app'}, {platform,inputDirectory,outputDirectory});
    manifest.resources.apps = scoped.resources.apps;
  }
  return manifest;
}

export function computerTool(manifest) {
  return { name: 'turnsu_computer', description: 'Operate the single Turnsu-authorized computer. Call describe first to obtain the exact Cua schema. Only listed tools and reviewed resources are allowed. Never switch from isolation to the host computer. Stop on user takeover, permission failure or lock screen. Returned screenshots are ephemeral.', inputSchema: { type: 'object', properties: { tool: { type: 'string', enum: ['describe', ...manifest.allow.tools] }, arguments: { type: 'object' } }, required: ['tool'], additionalProperties: false } };
}
