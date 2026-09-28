import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell, utilityProcess } from 'electron';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HostClient } from './host-client.mjs';
import { ConnectionVault } from './connection-vault.mjs';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = process.env.TURNSU_DESKTOP_STATE || join(app.getPath('appData'), 'ai.turnsu.desktop');
app.setName('Turnsu 工作台');
app.setPath('userData', join(stateDirectory, 'electron'));
protocol.registerSchemesAsPrivileged([{ scheme: 'turnsu', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window, host, vault, hostReady, quitting = false, closing = false, configuring = false;
const closeReplies = new Map();
const localOrigin = 'turnsu://app/index.html';
const safeSender = event => window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === localOrigin;
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

async function applyConnections(profiles) {
  if (configuring) throw new Error('模型连接正在更新，请稍后重试。');
  configuring = true;
  const previous = vault.profiles;
  try {
    await host.request('desktop.connections.configure', { connections: profiles });
    try { await vault.write(profiles); }
    catch (error) { await host.request('desktop.connections.configure', { connections: previous }); throw error; }
    return vault.list();
  } finally { configuring = false; }
}

async function invoke(operation, args = {}) {
  await hostReady;
  if (configuring) throw new Error('模型连接正在更新，请稍后重试。');
  switch (operation) {
    case 'local_command':
      if (!args || typeof args.method !== 'string' || args.method.length > 100 || args.method === 'project.open' || args.method === 'cloud.authorization' || args.method.startsWith('desktop.') || JSON.stringify(args).length > 150_000) throw new Error('不支持这个桌面操作。');
      return host.request(args.method, args.args);
    case 'open_project': {
      const selected = await dialog.showOpenDialog(window, { title: '打开本地项目', properties: ['openDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return null;
      return host.request('project.open', { path: selected.filePaths[0] });
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
    if (snapshot?.sessions.some(s => ['starting', 'running', 'waiting', 'stopping'].includes(s.status))) {
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
    await host?.close(); quitting = true; app.quit();
  } finally { closing = false; }
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
  const hostRoot = resolve(root.replace(/\.asar$/, '.asar.unpacked'), 'host-dist');
  const child = utilityProcess.fork(resolve(hostRoot, 'desktop-entry.mjs'), [stateDirectory], { serviceName: 'Turnsu Local Host', stdio: 'pipe', env: { ...process.env, TURNSU_GATEWAY_EXTENSION: resolve(hostRoot, 'pi-gateway-extension.mjs') } });
  // Host/SDK diagnostics can contain private paths. UI errors travel through the structured channel.
  child.stdout?.resume(); child.stderr?.resume();
  host = new HostClient(child, payload => { if (window && !window.isDestroyed()) window.webContents.send('desktop:host-event', payload); });
  hostReady = vault.read().then(() => host.request('desktop.connections.configure', { connections: vault.profiles }));
  hostReady.catch(() => {});
  window = new BrowserWindow({ title: 'Turnsu 工作台', width: 1180, height: 800, minWidth: 800, minHeight: 600, show: false, backgroundColor: '#f8f8f7', webPreferences: { preload: resolve(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); requestClose(); } });
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
