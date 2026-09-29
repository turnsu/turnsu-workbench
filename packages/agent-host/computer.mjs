import { readBoundedFile } from './bounded-file.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, lstat, realpath, rm, chmod, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { computerPolicy, computerTool } from './computer-policy.mjs';

const fail = message => { throw new Error(message); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Computer {
  constructor(host, transport) {
    this.host = host; this.transport = transport; this.active = null; this.busy = false; this.generation = 0;
    this.db = host.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS computer_grants(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),config TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL);
      UPDATE computer_grants SET status='expired' WHERE status='active';`);
    this.timer = setInterval(() => { if (this.active && (this.host.clock() >= this.active.expiresAt || this.host.clock() - this.touched >= 300_000)) this.stop().catch(() => {}); }, 10_000); this.timer.unref();
  }
  async status() { const runtime = await this.transport('status'); if (this.active && !runtime.active) { this.db.prepare("UPDATE computer_grants SET status='expired' WHERE id=?").run(this.active.id); this.active = null; this.owner = null; } return { ...runtime, grant: this.active ? { id: this.active.id, projectId: this.active.projectId, mode: this.active.mode, manifest: this.active.manifest, expiresAt: this.active.expiresAt, owner: this.owner } : null }; }
  async start(input) {
    if (this.active || this.starting) fail('同一台电脑只允许一个电脑操作任务。请先停止当前授权。');
    this.host.requireResource?.('computer');
    this.starting = true; const generation = this.generation; let scratch;
    try {
      const project = this.host.project(input.projectId);
      if (this.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(project.id)) fail('请在私有项目中单独授权电脑操作。');
      if (!Array.isArray(input.files) || input.files.length > 20 || input.files.some(p => typeof p !== 'string')) fail('请明确选择本次电脑操作的材料。');
      const id = randomUUID(), root = await realpath(project.path);
      scratch = join(this.host.directory, 'computer-jobs', id);
      const inputDirectory = join(scratch, 'input'), outputDirectory = join(scratch, 'output');
      await mkdir(inputDirectory, { recursive: true, mode: 0o755 }); await chmod(inputDirectory, 0o755); await mkdir(outputDirectory, { mode: 0o777 }); await chmod(outputDirectory, 0o777);
      const inputs = []; let total = 0;
      for (const path of input.files) {
        const source = await this.host.pathInProject(project.id, path), stat = await lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 || (total += stat.size) > 64 * 1024 * 1024) fail('材料必须是总计 64 MB 以内的普通文件。');
        const name = `${inputs.length + 1}-${basename(path)}`;
        const bytes = await readBoundedFile(source, 32 * 1024 * 1024);
        await this.host.pathInProject(project.id, path);
        await writeFile(join(inputDirectory, name), bytes, {flag: 'wx', mode: 0o644});
        inputs.push({ path, staged: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const manifest = computerPolicy(input, { inputDirectory: input.mode === 'isolated' ? '/input' : inputDirectory, outputDirectory: input.mode === 'isolated' ? '/output' : outputDirectory });
      const config = { id, projectId: project.id, root, mode: input.mode, manifest, scratch, inputs, network: input.network === true, expiresAt: this.host.clock() + input.minutes * 60_000 };
      if (generation !== this.generation) fail('电脑操作准备已取消，请重新授权。');
      await this.transport('start', config);
      if (generation !== this.generation) fail('电脑操作准备已取消，请重新授权。');
      this.db.prepare('INSERT INTO computer_grants VALUES(?,?,?,\'active\',?)').run(id, project.id, JSON.stringify(config), config.expiresAt);
      this.active = config; this.owner = null; this.touched = this.host.clock(); this.host.notify({ type: 'computer-changed' }); this.host.changed(); return this.status();
    } catch (e) {
      let stopped=false;try{await this.transport('stop');stopped=true;}catch{}
      if (scratch && stopped) await rm(scratch, { recursive: true, force: true });
      throw e;
    }
    finally { this.starting = false; }
  }
  tools(projectId) { return this.active?.projectId === projectId && this.active.expiresAt > this.host.clock() ? [computerTool(this.active.manifest)] : []; }
  async call(projectId, sessionId, request) {
    this.host.schedules?.assertTool(sessionId, 'computer');
    const grant = this.active;
    if (!grant || grant.projectId !== projectId || grant.expiresAt <= this.host.clock()) fail('电脑操作未授权或已过期。请在能力与权限中重新确认。');
    if (this.owner && this.owner !== sessionId) fail('电脑正由另一项任务使用，请先停止其电脑授权。');
    if (this.busy) fail('上一次电脑操作尚未完成。');
    if (request.tool !== 'describe' && !grant.manifest.allow.tools.includes(request.tool)) fail('电脑工具不在授权清单中。');
    if (JSON.stringify(request).length > 100_000) fail('电脑操作参数超过上限。');
    // Reserve before any async filesystem work, including against another session in this Host.
    this.owner = sessionId; this.busy = true; this.touched = this.host.clock();
    try {
      if (await realpath(this.host.project(projectId).path) !== grant.root) fail('项目目录已变化，请撤销并重新授权。');
      if (this.active !== grant || grant.expiresAt <= this.host.clock()) fail('电脑操作已被暂停或撤销，请核对应用当前状态。');
      const result = await this.transport(request.tool === 'describe' ? 'describe' : 'call', { ...request, grantId: grant.id, manifestHash: digest(grant.manifest) });
      if (this.active !== grant) fail('电脑操作已被暂停或撤销，请核对应用当前状态。');
      return result;
    } catch(error) { await this.status().catch(()=>{}); throw error;
    } finally { this.busy = false; }
  }
  async stop() {
    this.generation++;
    const grant = this.active; this.active = null; this.owner = null;
    if (grant) this.db.prepare("UPDATE computer_grants SET status='revoked' WHERE id=?").run(grant.id);
    await this.transport('stop'); this.host.notify({ type: 'computer-changed' }); this.host.changed();
    // Retain output until explicit collection; never discard a task's generated files on stop.
    return { stopped: true };
  }
  history(projectId) { this.host.project(projectId); return this.db.prepare('SELECT id,status,expires_at FROM computer_grants WHERE project_id=? ORDER BY rowid DESC LIMIT 20').all(projectId); }
  async collect({ projectId, grantId }) {
    const record = this.db.prepare('SELECT * FROM computer_grants WHERE id=? AND project_id=?').get(grantId, projectId);
    if (!record || record.status === 'collected') fail('这次电脑操作没有待收取的成果。');
    if (this.active?.id === grantId) fail('请先停止电脑操作，再收取已完成的文件。');
    const runtime = await this.transport('status');
    if (runtime.active?.id === grantId) fail('操作环境尚未完成停止，请重试停止后再收取成果。');
    const config = JSON.parse(record.config), root = await realpath(this.host.project(projectId).path);
    if (root !== config.root) fail('项目目录已变化，请先核对原项目。');
    const destination = await this.host.capabilities.outputDirectory(projectId, `Outputs/Computer-${grantId}`);
    const base = join(config.scratch, 'output'), files = [], issues = []; let total = 0;
    // Initially collect only regular top-level artifacts; do not follow driver-created links.
    const entries = await readdir(base, { withFileTypes: true });
    if (entries.length > 100) issues.push('文件超过 100 个，未收取的文件仍保留在操作环境目录中。');
    for (const item of entries.slice(0, 100)) {
      const source = join(base, item.name), stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 || (total += stat.size) > 64 * 1024 * 1024 || !/\.(xlsx|docx|pdf|txt|md|csv|png|jpe?g|webp)$/i.test(item.name)) { issues.push(item.name); continue; }
      const target = join(destination, item.name);
      const bytes = await readBoundedFile(source, 32 * 1024 * 1024);
      try { await writeFile(target, bytes, {flag:'wx',mode:0o600}); }
      catch (e) { if (e.code !== 'EEXIST' || (await lstat(target)).isSymbolicLink() || digest(await readBoundedFile(target, 32 * 1024 * 1024)) !== digest(bytes)) throw e; }
      files.push(`Outputs/Computer-${grantId}/${item.name}`);
    }
    if (!issues.length) { this.db.prepare("UPDATE computer_grants SET status='collected' WHERE id=?").run(grantId); await rm(config.scratch, { recursive: true, force: true }); }
    this.host.notify({ type: 'capability-changed', projectId }); return { files, issues, complete: issues.length === 0 };
  }
  async close() { clearInterval(this.timer); await this.stop(); }
}
