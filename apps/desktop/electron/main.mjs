import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, nativeImage, Notification, powerMonitor, protocol, safeStorage, session, shell, Tray, utilityProcess } from 'electron';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ComputerRuntime } from '../host-dist/computer-runtime.mjs';
import { HostClient } from './host-client.mjs';
import { ManusAuth } from './manus-auth.mjs';
import { ConnectionVault } from './connection-vault.mjs';
import { normalizeAgentConnection, publicAgentConnection, serializeAgentSecret, deserializeAgentSecret, agentProfilesForHost } from '../host-dist/agent-connections.mjs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = process.env.TURNSU_DESKTOP_STATE || join(app.getPath('appData'), 'ai.turnsu.desktop');
app.setName('Turnsu 工作台');
app.setPath('userData', join(stateDirectory, 'electron'));
protocol.registerSchemesAsPrivileged([{ scheme: 'turnsu', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window, host, vault, agentVault, manusAuth, hostReady, tray, computer, quitting = false, closing = false, configuring = false;
const closeReplies = new Map();
const localOrigin = 'turnsu://app/index.html';
const safeSender = event => window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === localOrigin;
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

async function applyConnections(profiles, target = vault) {
  if (configuring) throw new Error('连接正在更新，请稍后重试。');
  configuring = true;
  const previous = target.profiles, method = target === vault ? 'desktop.connections.configure' : 'desktop.agents.configure';
  try {
    await host.request(method, { connections: target === agentVault ? agentProfilesForHost(profiles) : profiles });
    try { await target.write(profiles); }
    catch (error) { await host.request(method, { connections: target === agentVault ? agentProfilesForHost(previous) : previous }); throw error; }
    return target.list();
  } finally { configuring = false; }
}

async function invoke(operation, args = {}) {
  await hostReady;
  if (configuring) throw new Error('连接正在更新，请稍后重试。');
  switch (operation) {
    case 'computer_install': {
      if ((await host.request('capabilities.list')).documents.status === 'installing') throw new Error('正在准备文件环境，请完成后再准备电脑环境。');
      return computer.install(args);
    }
    case 'computer_app_picker': {
      const selected = await dialog.showOpenDialog(window, { title: '选择允许操作的本机应用', properties: ['openFile'], ...(process.platform === 'darwin' ? { filters: [{ name: '应用', extensions: ['app'] }] } : process.platform === 'win32' ? { filters: [{ name: '应用', extensions: ['exe'] }] } : {}) });
      if (selected.canceled || !selected.filePaths[0]) return null;
      const path = selected.filePaths[0];
      if (process.platform === 'darwin') {
        if (!path.endsWith('.app')) throw new Error('请选择应用程序。');
        const result = await promisify(execFile)('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(path, 'Contents', 'Info.plist')], { timeout: 5000, maxBuffer: 8192 });
        const identity = result.stdout.trim(); if (!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(identity)) throw new Error('应用没有可验证的标识。');
        return { identity };
      }
      return { identity: path };
    }
    case 'background_settings': {
      const supported = ['darwin', 'win32'].includes(process.platform);
      if (Object.hasOwn(args, 'openAtLogin')) {
        if (!supported || typeof args.openAtLogin !== 'boolean') throw new Error('此系统不支持设置登录自启。');
        app.setLoginItemSettings({ openAtLogin: args.openAtLogin });
      }
      return { supported, openAtLogin: supported ? app.getLoginItemSettings().openAtLogin : false };
    }
    case 'local_command':
      if (!args || typeof args.method !== 'string' || args.method.length > 100 || ['project.open', 'files.import', 'files.resolve', 'cloud.authorization'].includes(args.method) || args.method.startsWith('desktop.') || JSON.stringify(args).length > 150_000) throw new Error('不支持这个桌面操作。');
      if (args.method === 'capabilities.install' && (await computer.status()).installing) throw new Error('正在准备电脑环境，请完成后再准备文件环境。');
      return host.request(args.method, args.args);
    case 'open_project': {
      const selected = await dialog.showOpenDialog(window, { title: '打开本地项目', properties: ['openDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return null;
      return host.request('project.open', { path: selected.filePaths[0] });
    }
    case 'import_files': {
      if (typeof args.projectId !== 'string') throw new Error('请先打开本地项目。');
      const selected = await dialog.showOpenDialog(window, { title: '导入项目资料', properties: ['openFile', 'multiSelections'] });
      if (selected.canceled || !selected.filePaths.length) return null;
      return host.request('files.import', { projectId: args.projectId, paths: selected.filePaths });
    }
    case 'open_project_file': {
      if (typeof args.projectId !== 'string' || typeof args.path !== 'string') throw new Error('请选择项目文件。');
      const file = await host.request('files.resolve', { projectId: args.projectId, path: args.path });
      if (!/\.(?:txt|md|markdown|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(file.path)) throw new Error('这种文件请从项目文件夹手动打开。');
      const failure = await shell.openPath(file.path);
      if (failure) throw new Error(`系统无法打开此文件：${failure}`);
      return { opened: true };
    }
    case 'reveal_project_file': {
      if (typeof args.projectId !== 'string' || typeof args.path !== 'string') throw new Error('请选择项目文件。');
      const file = await host.request('files.resolve', { projectId: args.projectId, path: args.path });
      shell.showItemInFolder(file.path); return { opened: true };
    }
    case 'open_cloud_authorization': {
      const { url } = await host.request('cloud.authorization');
      if (!url) throw new Error('授权已结束，请重新连接团队。');
      const parsed = new URL(url);
      if (parsed.username || parsed.password || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('授权地址不可用。');
      await shell.openExternal(parsed.href); return { opened: true };
    }
    case 'connection_list': return vault.list();
    case 'connection_save': return applyConnections(await vault.prepare(args));
    case 'connection_remove': {
      const usage = await host.request('connections.usage', { id: args.id });
      if (usage.sessions) throw new Error('已有会话使用这个连接，请保留它以便继续历史任务。可以更新密钥。');
      if (vault.error) throw new Error(vault.error);
      return applyConnections(vault.profiles.filter(p => p.id !== args.id));
    }
    case 'connection_check': return host.request('connections.check', { id: args.id });
    case 'agent_connection_list': return { ...agentVault.list(), oauth: manusAuth.status() };
    case 'manus_authorize': return manusAuth.begin(args);
    case 'manus_authorize_cancel': return manusAuth.cancel();
    case 'agent_connection_save': {
      if (args.mode !== 'api_key') throw new Error('Team 账号请使用浏览器授权。');
      const profiles = await agentVault.prepare({ ...args, revoked: false, accountId: null });
      const candidate = profiles.at(-1);
      const verified = await host.request('desktop.agents.verify', { connection: candidate });
      const previous = agentVault.profiles.find(p => p.id === verified.id);
      if (previous?.accountId && previous.accountId !== verified.accountId) throw new Error('密钥属于另一个账号，请添加新连接。');
      return applyConnections([...profiles.slice(0, -1), verified], agentVault);
    }
    case 'agent_connection_remove': {
      if (agentVault.error) throw new Error(agentVault.error);
      const previous = agentVault.profiles.find(p => p.id === args.id);
      const result = await applyConnections(agentVault.profiles.map(p => p.id === args.id ? { ...p, apiKey: '', oauth: null, revoked: true } : p), agentVault);
      try { if (previous && !previous.revoked) await manusAuth.revoke(previous); } catch { result.revokeNotice = '本机凭据已停用，但服务端撤销尚未确认，请在 Manus 的 Authorized Apps 中撤销授权。'; }
      return result;
    }
    case 'agent_connection_check': return host.request('agents.check', { id: args.id });
    case 'open_managed_authorization': {
      const { url } = await host.request('desktop.managed.authorization');
      if (!url || new URL(url).origin !== 'https://www.workbuddy.cn') throw new Error('WorkBuddy 授权已结束，请重新连接。');
      await shell.openExternal(url); return { opened: true };
    }
    case 'open_agent_task': {
      const value = await host.request('session.read', { sessionId: args.sessionId });
      const url = new URL(value.remote?.url || '');
      const hosts = value.agent === 'manus' ? ['manus.im','manus.ai'] : value.agent?.startsWith('workbuddy-') ? ['workbuddy.cn','www.workbuddy.cn'] : ['muse.ai'];
      if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname)) throw new Error('此任务尚未返回可信的原生地址。');
      await shell.openExternal(url.href); return { opened: true };
    }
    case 'open_agent_guide': {
      const urls = { manus: 'https://manus.im/settings/api', workbuddy: 'https://open.workbuddy.cn/docs/third-party-app', muse: 'https://muse.ai/platform', kimi: 'https://moonshotai.github.io/kimi-cli/', codex: 'https://developers.openai.com/codex/cli', opencode: 'https://opencode.ai/docs/', omp: 'https://github.com/can1357/oh-my-pi', pi: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent' };
      if (!urls[args.agent]) throw new Error('没有该 Agent 的配置指引。');
      await shell.openExternal(urls[args.agent]); return { opened: true };
    }
    case 'open_gateway': await shell.openExternal('https://gateway.turnsu.org/keys'); return { opened: true };
    default: throw new Error('不支持这个桌面操作。');
  }
}

async function requestClose() {
  if (closing || quitting) return;
  closing = true;
  try {
    let snapshot;
    try { snapshot = await host.request('workspace.read', {}, 2000); } catch {}
    if (snapshot?.activeSessionCount > 0) {
      const result = await dialog.showMessageBox(window, { type: 'question', message: '仍有 Agent 在工作', detail: '退出会停止本机执行。重开后可检查已有结果，再继续任务。', buttons: ['继续工作', '停止并退出'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    if (window && !window.isDestroyed() && !window.webContents.isCrashed()) {
      const id = randomUUID();
      const saved = await new Promise(resolve => {
        const timer = setTimeout(() => { closeReplies.delete(id); resolve(false); }, 5000);
        closeReplies.set(id, value => { clearTimeout(timer); closeReplies.delete(id); resolve(value); });
        window.webContents.send('desktop:prepare-close', id);
      });
      if (!saved) {
        const result = await dialog.showMessageBox(window, { type: 'warning', message: '尚未确认草稿已保存', detail: '请先复制未保存的输入。直接退出只能保留最后一次已保存的内容。', buttons: ['返回工作台', '直接退出'], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return;
      }
    }
    await manusAuth?.close(); await host?.close(); await computer?.close(); quitting = true; app.quit();
  } catch(error) { await dialog.showMessageBox(window, { type: 'error', message: '退出尚未完成', detail: error.message || '请检查运行环境后重试。' }); } finally { closing = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); requestClose(); } });
  app.whenReady().then(async () => {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  protocol.handle('turnsu', async request => {
    const url = new URL(request.url);
    let path;
    try { path = resolve(root, 'dist', '.' + decodeURIComponent(url.pathname)); } catch { return new Response('Not found', { status: 404 }); }
    if (url.hostname !== 'app' || request.method !== 'GET' || !path.startsWith(resolve(root, 'dist') + sep)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(path).href);
    return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), 'Content-Security-Policy': csp } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  vault = new ConnectionVault(stateDirectory, safeStorage);
  agentVault = new ConnectionVault(stateDirectory, safeStorage, { filename: 'agent-connections.json', normalize: normalizeAgentConnection, present: publicAgentConnection, serializeSecret: serializeAgentSecret, deserializeSecret: deserializeAgentSecret });
  manusAuth = new ManusAuth({ vault: agentVault, openExternal: url => shell.openExternal(url), save: profile => applyConnections([...agentVault.profiles.filter(p => p.id !== profile.id), profile], agentVault), withLock: async work => { if (configuring) throw new Error('连接正在更新，请稍后重试。'); configuring = true; try { return await work(); } finally { configuring = false; } } });
  const hostRoot = resolve(root.replace(/\.asar$/, '.asar.unpacked'), 'host-dist');
  process.env.TURNSU_COMPUTER_PACK = resolve(hostRoot, 'computer-pack');
  computer = new ComputerRuntime(stateDirectory, payload => { if (window && !window.isDestroyed()) window.webContents.send('desktop:host-event', payload); });
  const child = utilityProcess.fork(resolve(hostRoot, 'desktop-entry.mjs'), [stateDirectory], { serviceName: 'Turnsu Local Host', stdio: 'pipe', env: { ...process.env, TURNSU_GATEWAY_EXTENSION: resolve(hostRoot, 'pi-gateway-extension.mjs'), TURNSU_DOCUMENT_PACK: resolve(hostRoot, 'document-pack'), TURNSU_TOOL_MCP: resolve(hostRoot, 'tool-mcp.mjs'), TURNSU_TOOLS_EXTENSION: resolve(hostRoot, 'pi-tools-extension.mjs') } });
  // Host/SDK diagnostics can contain private paths. UI errors travel through the structured channel.
  child.stdout?.resume(); child.stderr?.resume();
  host = new HostClient(child, payload => {
    if (window && !window.isDestroyed()) window.webContents.send('desktop:host-event', payload);
    if (payload.type === 'schedule-changed' && ['completed', 'failed', 'waiting', 'uncertain'].includes(payload.status) && Notification.isSupported()) {
      const notice = new Notification({ title: 'Turnsu 定时任务', body: payload.status === 'completed' ? '任务已完成，可在工作台核对成果。' : '任务需要处理，请回工作台查看。' });
      notice.on('click', () => { window?.show(); window?.focus(); }); notice.show();
    }
  }, (method, args) => computer.dispatch(method, args), args => manusAuth.authorize(args));
  hostReady = Promise.all([vault.read(), agentVault.read()]).then(async () => {
    await host.request('desktop.connections.configure', { connections: vault.profiles });
    await host.request('desktop.agents.configure', { connections: agentProfilesForHost(agentVault.profiles) });
    await host.request('desktop.scheduler.start');
  });
  hostReady.catch(() => {});
  window = new BrowserWindow({ title: 'Turnsu 工作台', width: 1180, height: 800, minWidth: 800, minHeight: 600, show: false, backgroundColor: '#f8f8f7', webPreferences: { preload: resolve(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  tray = new Tray(nativeImage.createFromPath(resolve(root, 'dist/brand/turnsu-icon-32.png')).resize({ width: 18, height: 18 }));
  tray.setToolTip('Turnsu 工作台');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '停止电脑操作', click: () => host.request('computer.stop').catch(() => computer.stop()) }, { label: '打开工作台', click: () => { window.show(); window.focus(); } }, { type: 'separator' }, { label: '退出工作台（停止本地调度）', click: requestClose }]));
  tray.on('click', () => { window.show(); window.focus(); });
  window.on('close', event => {
    if (!quitting) { event.preventDefault(); hostReady.then(() => host.request('schedules.background')).then(state => state.required ? window.hide() : requestClose()).catch(() => requestClose()); }
  });
  app.on('activate', () => { window?.show(); window?.focus(); });
  globalShortcut.register('CommandOrControl+Shift+Escape', () => host.request('computer.stop').catch(() => computer.stop()));
  powerMonitor.on('lock-screen', () => hostReady.then(() => host.request('computer.stop')).catch(() => {}));
  powerMonitor.on('suspend', () => hostReady.then(() => host.request('computer.stop')).catch(() => {}));
  powerMonitor.on('resume', () => hostReady.then(() => host.request('desktop.scheduler.start')).catch(() => {}));
  window.once('ready-to-show', () => window.show());
  ipcMain.handle('desktop:invoke', async (event, operation, args) => {
    if (!safeSender(event)) return { ok: false, error: '操作来源不可用。' };
    try { return { ok: true, value: await invoke(operation, args) }; }
    catch (error) { return { ok: false, error: error.message || '操作未完成，请稍后重试。' }; }
  });
  ipcMain.on('desktop:close-ready', (event, reply) => { if (safeSender(event)) closeReplies.get(reply?.id)?.(reply.saved === true); });
  const menu = [
    ...(process.platform === 'darwin' ? [{ label: 'Turnsu 工作台', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '文件', submenu: [{ label: '打开项目…', accelerator: 'CmdOrCtrl+O', click: () => window.webContents.send('desktop:host-event', { type: 'open-project-requested' }) }, { type: 'separator' }, { role: 'quit', label: '退出工作台' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  await window.loadURL(localOrigin);
  }).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); quitting = true; Promise.resolve(host?.close()).finally(() => app.exit(1)); });
}
