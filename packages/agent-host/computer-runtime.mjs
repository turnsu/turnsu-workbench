import { dockerBind } from './bounded-file.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapability } from './capability-process.mjs';
import { closeNativeProcess } from './native-process.mjs';
import { executable } from './codex.mjs';
import { DRIVER_VERSION } from './computer-policy.mjs';
import { CapabilityMcp } from './capability-mcp.mjs';
import { readBoundedFile } from './bounded-file.mjs';

const assets = {
  'darwin-arm64': ['darwin-universal-binary.tar.gz', 'a93d21bab914b2d854776f46f71a53bddd4e483ef762aeb74137d3ac306cbf65'],
  'darwin-x64': ['darwin-universal-binary.tar.gz', 'a93d21bab914b2d854776f46f71a53bddd4e483ef762aeb74137d3ac306cbf65'],
  'linux-arm64': ['linux-arm64-binary.tar.gz', 'a77007a57ddac6f5b46a49fa9d7c39d9f22b461bd6b50af736b45946b0207875'],
  'linux-x64': ['linux-x86_64-binary.tar.gz', 'fff2016e0dea320df9be3aa52fc942c4ea4ca651df32cf3e950119bbc3097d29'],
  'win32-arm64': ['windows-arm64-binary.zip', '72d8713401ad1eb65f3046fe1c9d531840d36b3d5f999c79ac5fe1d4e8cff7e3'],
  'win32-x64': ['windows-x86_64-binary.zip', '7b0ec893797fdeb0514d96f5797ad6aa53617eadcba2e47856461f60140c757b'],
};
const fail = message => { throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pack = process.env.TURNSU_COMPUTER_PACK || fileURLToPath(new URL('./computer-pack/', import.meta.url));

// Instantiated in Electron's main process: the signed application directly owns the embedded
// driver, its TCC attribution, the stop action, and all child processes. Never a global daemon.
export class ComputerRuntime {
  constructor(directory, notify = () => {}) {
    this.directory = join(directory, 'computer-runtime'); this.notify = notify; this.children = new Set(); this.active = null; this.ready = this.restore();
  }
  async restore() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.config = JSON.parse(await readFile(join(this.directory, 'installed.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') this.error = '电脑操作环境记录不可用，请重新准备。'; }
    try {
      const saved = JSON.parse(await readBoundedFile(join(this.directory, 'active.json'), 4096));
      if (!/^[a-f0-9-]{36}$/.test(saved.id) || !['isolated', 'local'].includes(saved.mode)) fail('电脑操作回收记录无效，请联系管理员核对运行环境。');
      // A crash never resumes an old grant. Local drivers stop when the inherited pipe closes.
      this.active = { id: saved.id, mode: saved.mode, ...(saved.mode === 'isolated' ? { container: `turnsu-cua-${saved.id}` } : {}) };
      await this.performStop();
    } catch (e) { if (e.code !== 'ENOENT') { this.cleanupPending = true; this.error = e.message; } }
  }
  async status() { await this.ready; return { version: DRIVER_VERSION, installed: this.config?.version === DRIVER_VERSION, isolatedReady: Boolean(this.config?.image), installing: Boolean(this.installing), error: this.error || null, cleanupPending: Boolean(this.cleanupPending), active: this.active ? { mode: this.active.mode, id: this.active.id } : null, platform: process.platform, docker: Boolean(executable('docker')) }; }
  async install({ acknowledged, mode = 'isolated' }) {
    await this.ready;
    if (acknowledged !== true || !['isolated', 'local'].includes(mode)) fail('请确认准备电脑操作运行环境。');
    if (this.installing || this.active || this.cleanupPending) fail('请先停止当前电脑操作，等待环境准备与回收完成。');
    this.installing = this.performInstall(mode).catch(e => { this.error = e.message; }).finally(() => { this.installing = null; this.notify({ type: 'computer-changed' }); });
    return this.status();
  }
  async performInstall(mode) {
    this.error = null; const config = { ...this.config, version: DRIVER_VERSION };
    if (mode === 'isolated') {
      const docker = executable('docker'); if (!docker) fail('未找到 Docker。请安装并启动本机容器运行环境后重新准备隔离电脑。');
      const tag = `turnsu-computer:${DRIVER_VERSION}-${randomUUID()}`;
      const build = await runCapability(docker, ['build', '-t', tag, process.env.TURNSU_COMPUTER_PACK || pack], { timeout: 900_000, maxBytes: 8_000_000, children: this.children });
      if (build.code) fail('隔离电脑构建失败。请检查 Docker 与软件源网络后重试。');
      const image = await runCapability(docker, ['image', 'inspect', '--format', '{{.Id}}', tag]);
      if (image.code || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) fail('隔离电脑镜像未完成校验。');
      config.image = image.stdout.trim();
    } else {
      const asset = assets[`${process.platform}-${process.arch}`]; if (!asset) fail('此系统架构暂不支持本机电脑操作。');
      const response = await fetch(`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${DRIVER_VERSION}/cua-driver-rs-${DRIVER_VERSION}-${asset[0]}`, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) fail('Cua 官方运行包下载失败，请检查网络。');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { if ((size += chunk.length) > 200_000_000) fail('运行包超过上限。'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks); if (hash(bytes) !== asset[1]) fail('运行包校验失败，已拒绝安装。');
      const directory = join(this.directory, `driver-${DRIVER_VERSION}-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
      const archive = join(directory, 'release.' + (asset[0].endsWith('.zip') ? 'zip' : 'tar.gz')); await writeFile(archive, bytes, { mode: 0o600 });
      const name = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
      const unpack = await runCapability('tar', ['-xf', archive, '-C', directory, name]);
      if (unpack.code) fail('无法展开运行包，请检查系统 tar 工具。');
      const binary = join(directory, name); if (process.platform !== 'win32') await chmod(binary, 0o700);
      const version = await runCapability(binary, ['--version']);
      if (version.code || !version.stdout.includes(DRIVER_VERSION)) fail('电脑操作运行时版本不符或依赖缺失。');
      config.binary = binary; config.binaryHash = hash(await readFile(binary)); await rm(archive);
    }
    const temp = join(this.directory, `${randomUUID()}.json`); await writeFile(temp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await rename(temp, join(this.directory, 'installed.json')); this.config = config;
  }
  async start(config) {
    await this.ready;
    if (this.active || this.cleanupPending || this.starting || this.installing) fail('已有电脑运行时或待回收环境，请先停止后重试。');
    if (!config.manifest || config.manifest.version !== 3 || !config.manifest.allow?.tools?.length) fail('电脑操作策略缺失或无效。');
    this.starting = true;
    try {
      if (this.config?.version !== DRIVER_VERSION) fail('请先准备固定版本的电脑操作环境。');
      const manifestPath = join(config.scratch, 'capabilities.json'); await writeFile(manifestPath, JSON.stringify(config.manifest), { mode: 0o644, flag: 'wx' });
      this.active = { ...config, manifestHash: hash(JSON.stringify(config.manifest)) };
      await writeFile(join(this.directory, 'active.json'), JSON.stringify({id:config.id,mode:config.mode}), {mode:0o600,flag:'wx'});
      if (config.mode === 'isolated') {
        const docker = executable('docker'); if (!docker || !this.config.image) fail('隔离环境未就绪。请重新检查，不会自动切换本机。');
        this.active.container = `turnsu-cua-${config.id}`;
        this.launchDriver(docker, ['run', '-i', '--name', this.active.container, '--network', config.network ? 'bridge' : 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt', `seccomp=${join(process.env.TURNSU_COMPUTER_PACK || pack, 'seccomp.json')}`, '--pids-limit=256', '--memory=1024m', '--cpus=1', '--shm-size=128m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--tmpfs', '/home/cua:rw,nosuid,nodev,size=512m,uid=1000,gid=1000', '--mount', dockerBind(manifestPath, '/policy.json', true), '--mount', dockerBind(join(config.scratch, 'input'), '/input', true), '--mount', dockerBind(join(config.scratch, 'output'), '/output'), this.config.image]);
      } else {
        const binary = this.config.binary;
        if (!binary || hash(await readFile(binary)) !== this.config.binaryHash) fail('本机 Driver 未安装或文件已变化，请重新准备。');
        const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\turnsu-cua-${config.id}` : join(config.scratch, 'driver.sock'); this.active.endpoint = endpoint;
        this.launchDriver(binary, ['serve', '--embedded', '--parent-liveness-stdio', '--permission-mode', 'bounded', '--capability-manifest', manifestPath, '--approve-capability-manifest', '--socket', endpoint]);
      }
      let last;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          this.rpc = config.mode === 'isolated'
            ? new CapabilityMcp(executable('docker'), ['exec', '-i', this.active.container, '/opt/cua/cua-driver', 'mcp', '--embedded', '--socket', '/tmp/driver.sock'], { children: this.children })
            : new CapabilityMcp(this.config.binary, ['mcp', '--embedded', '--socket', this.active.endpoint], { children: this.children });
          const catalog = await this.rpc.initialize();
          if (!Array.isArray(catalog.tools) || config.manifest.allow.tools.some(name => !catalog.tools.some(tool => tool.name === name))) fail('Driver 没有提供授权清单中的工具。');
          this.toolCatalog = catalog.tools.filter(tool => config.manifest.allow.tools.includes(tool.name));
          if (config.mode === 'isolated') {
            const prepared = await this.rpc.request('tools/call', { name: 'browser_prepare', arguments: { session: `turnsu-${config.id}`, allow_launch: true, profile: { mode: 'isolated_new' } } });
            if (prepared.isError || prepared.structuredContent?.status !== 'ok' || !prepared.structuredContent?.prepared_pid) fail('隔离浏览器未通过实际启动检查。');
            this.active.browser = prepared.structuredContent;
          }
          return { started: true, browser: this.active.browser };
        } catch (e) { last = e.message; await this.rpc?.close(); this.rpc = null; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      fail('电脑操作尚未就绪。请检查图形环境、系统权限与运行包；不会启动其他模式。' + (last ? ' 运行时未通过检查。' : ''));
    } catch (e) { await this.stop(); throw e; }
    finally { this.starting = false; }
  }
  launchDriver(binary, args) {
    // Keep the dedicated liveness pipe open. EOF also reaches the fixed Driver through Docker.
    // No reconnect or automatic restart may preserve authorization after the owner dies.
    const child = spawn(binary, args, {shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:{...process.env}});
    this.driver=child;this.children.add(child);child.stdin.on('error',()=>{});child.stdout.resume();child.stderr.resume();child.on('error',()=>{});
    child.on('exit',()=>{this.children.delete(child);if(this.driver===child){this.driver=null;this.cleanupPending=true;this.rpc?.close().catch(()=>{});this.error='电脑操作进程已退出。请停止并重新授权；不会自动恢复操作。';this.notify({type:'computer-changed'});}});
  }
  async dispatch(method, args = {}) {
    if (method === 'status') return this.status();
    if (method === 'start') return this.start(args);
    if (method === 'stop') return this.stop();
    if (this.cleanupPending || !this.active || args.grantId !== this.active.id || args.manifestHash !== this.active.manifestHash || Date.now() >= this.active.expiresAt) fail('电脑操作授权已失效。');
    if (method === 'describe') return { tools: this.toolCatalog, mode: this.active.mode, inputs: this.active.inputs, browser: this.active.browser };
    if (method !== 'call' || !this.active.manifest.allow.tools.includes(args.tool)) fail('未授权的电脑工具。');
    const parameters = {...(args.arguments || {})};
    if(this.toolCatalog.find(tool=>tool.name===args.tool)?.inputSchema?.properties?.session) parameters.session = `turnsu-${this.active.id}`;
    try {
      const result = await this.rpc.request('tools/call', { name: args.tool, arguments: parameters });
      if (result.isError || result.structuredContent?.status === 'refused' || result.structuredContent?.effect === 'refused' || result.structuredContent?.refusal) fail(result.structuredContent?.refusal?.message || JSON.stringify(result).slice(0, 2000));
      return result;
    } catch (error) {
      // A timed-out click may already have changed the application. End this grant rather than
      // admitting another action on an uncertain desktop; the user must inspect and reauthorize.
      await this.stop().catch(()=>{});
      throw error;
    }
  }
  async stop() {
    await this.ready;
    if (this.stopping) return this.stopping;
    this.stopping = this.performStop().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async performStop() {
    const active = this.active; this.cleanupPending = true;
    const driver = this.driver; this.driver = null;
    await this.rpc?.close(); this.rpc = null;
    await Promise.all([...this.children].map(child => closeNativeProcess(child)));
    if (active?.container) {
      const docker = executable('docker');
      const removed = await runCapability(docker, ['rm', '-f', active.container], { timeout: 15_000 }).catch(() => null);
      if (!removed || removed.code) {
        const existing = await runCapability(docker, ['ps', '-a', '--filter', `name=^/${active.container}$`, '--format', '{{.Names}}'], { timeout: 5000 }).catch(() => null);
        if (!existing || existing.code || existing.stdout.trim()) { this.error = '电脑操作通道已停用，但未能确认隔离环境已退出。请恢复 Docker 后再次停止；不会启动新的操作。'; this.notify({ type: 'computer-changed' }); throw new Error(this.error); }
      }
    }
    if (driver) await closeNativeProcess(driver);
    await rm(join(this.directory, 'active.json'), {force:true});
    this.active = null; this.cleanupPending = false; this.error = null;
    this.toolCatalog = null; this.notify({ type: 'computer-changed' }); return { stopped: true };
  }
  async close() { await this.ready; await this.stop(); await this.installing; }
}
