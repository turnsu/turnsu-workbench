import manifest from './document-pack/manifest.json' with { type: 'json' };
import { readBoundedFile, dockerBind } from './bounded-file.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable } from './codex.mjs';
import { runCapability } from './capability-process.mjs';
import { closeNativeProcess } from './native-process.mjs';

const pack = process.env.TURNSU_DOCUMENT_PACK || fileURLToPath(new URL('./document-pack/', import.meta.url));
const VERSION = manifest.version;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = message => { throw new Error(message); };
const validPath = path => typeof path === 'string' && path.length <= 300 && !path.includes('\\') && !path.startsWith('/') && !path.includes(':') && path.split('/').every(part => part !== '..' && part !== '' && (part === '.' || !part.startsWith('.')));
const within = (path, root) => root === '.' || path === root || path.startsWith(root + '/');

export const documentTool = { name: 'turnsu_document', description: 'Read, create, edit or convert an authorized project .xlsx/.docx/.pdf. Never overwrites originals. Read returns source locations and coverage warnings. Requires the Turnsu documents package and project grant. Create content: xlsx {sheets:[{name,rows:[[cell]]}]}, docx {title,paragraphs,tables}, pdf {title,paragraphs}. Edit changes: xlsx {cells:[{sheet,cell,value}]}, docx {paragraphs:[{paragraph,text}]}, pdf {keepPages:[1,2]}.', inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['read', 'create', 'edit', 'convert'] }, path: { type: 'string' }, output: { type: 'string', description: 'New basename including .xlsx/.docx/.pdf, saved to approved output directory.' }, options: { type: 'object' }, content: { type: 'object' }, changes: { type: 'object' } }, required: ['operation'], additionalProperties: false } };

export class Capabilities {
  constructor(host, { runner = runCapability } = {}) {
    this.host = host; this.db = host.db; this.runner = runner; this.children = new Set(); this.running = new Map(); this.pending = new Set(); this.calls = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS capability_packages(id TEXT PRIMARY KEY,version TEXT NOT NULL,status TEXT NOT NULL,config TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS capability_grants(project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,config TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,kind));
      CREATE TABLE IF NOT EXISTS capability_receipts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),session_id TEXT,tool TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_containers(name TEXT PRIMARY KEY,scratch TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capability_receipts_project ON capability_receipts(project_id,created_at DESC);
      UPDATE capability_packages SET status='failed',error='上次安装被中断，可以重新安装。' WHERE status='installing';
      UPDATE capability_receipts SET status='uncertain' WHERE status='running';`);
    this.cleanupReady = Promise.resolve().then(() => this.cleanup()).catch(e => { this.cleanupError = e.message; });
    if (!this.db.prepare('PRAGMA table_info(capability_receipts)').all().some(c => c.name === 'request_hash')) this.db.exec('ALTER TABLE capability_receipts ADD COLUMN request_hash TEXT');
    if (!this.db.prepare('PRAGMA table_info(capability_receipts)').all().some(c => c.name === 'grant_hash')) this.db.exec('ALTER TABLE capability_receipts ADD COLUMN grant_hash TEXT');
  }
  list(projectId) {
    if (projectId) this.host.project(projectId);
    const pkg = this.db.prepare("SELECT * FROM capability_packages WHERE id='documents'").get();
    const grant = projectId && this.db.prepare("SELECT * FROM capability_grants WHERE project_id=? AND kind='documents'").get(projectId);
    return { manifest, cleanupError: this.cleanupError || null, documents: pkg ? { ...pkg, config: JSON.parse(pkg.config) } : { id: 'documents', version: VERSION, status: 'not_installed' }, docker: Boolean(executable('docker')),
      grant: grant ? { ...grant, config: JSON.parse(grant.config), active: !grant.revoked && grant.expires_at > this.host.clock() } : null,
      receipts: projectId ? this.db.prepare("SELECT id,project_id,session_id,tool,status,created_at,json_object('path',json_extract(result,'$.path'),'error',substr(json_extract(result,'$.error'),1,2000)) AS result FROM capability_receipts WHERE project_id=? ORDER BY created_at DESC LIMIT 20").all(projectId).map(row => ({ ...row, result: JSON.parse(row.result) })) : [] };
  }
  install({ office = false, ocr = false, acknowledged }) {
    if (acknowledged !== true || typeof office !== 'boolean' || typeof ocr !== 'boolean') error('请确认安装官方文件包及所选组件。');
    if (this.installing || this.running.size) error('正在安装或执行文件任务，请稍后重试。');
    const docker = executable('docker'); if (!docker) error('请先安装并启动 Docker 兼容运行环境，再检查文件能力。普通 Agent 任务不受影响。');
    this.db.prepare("INSERT INTO capability_packages VALUES('documents',?,'installing',?,NULL) ON CONFLICT(id) DO UPDATE SET status='installing',error=NULL").run(VERSION, JSON.stringify({ office, ocr }));
    this.host.changed();
    this.installing = this.performInstall(docker, { office, ocr }).finally(() => { this.installing = null; this.host.changed(); });
    return this.list();
  }
  async performInstall(docker, config) {
    try {
      const tag = `turnsu-documents:${VERSION}-${randomUUID()}`;
      const result = await this.runner(docker, ['build', '--build-arg', `OFFICE=${config.office ? 1 : 0}`, '--build-arg', `OCR=${config.ocr ? 1 : 0}`, '-t', tag, pack], { timeout: 900_000, maxBytes: 4_000_000, children: this.children });
      if (result.code) error('文件环境构建失败。请检查 Docker 和软件源网络后重试；项目文件未改动。');
      const inspected = await this.runner(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], { children: this.children });
      const image = inspected.stdout.trim(); if (inspected.code || !/^sha256:[a-f0-9]{64}$/.test(image)) error('文件环境没有返回不可变镜像标识。');
      const versions = await this.runner(docker, ['run', '--rm', '--network', 'none', '--memory=128m', '--read-only', '--entrypoint', 'python', image, '-c', 'import importlib.metadata,json,platform; print(json.dumps({"python":platform.python_version(),"packages":{p:importlib.metadata.version(p) for p in ["openpyxl","python-docx","pypdf","reportlab"]}}))']);
      if (versions.code) error('文件运行环境自检失败，请重新安装。');
      const runtime = JSON.parse(versions.stdout);
      if (Object.entries(manifest.dependencies).some(([name,version]) => runtime.packages[name] !== version) || runtime.python !== manifest.runtime.python) error('文件依赖版本未通过检查。');
      this.db.prepare("UPDATE capability_packages SET version=?,status='enabled',config=?,error=NULL WHERE id='documents'").run(VERSION, JSON.stringify({ ...config, image, runtime }));
      this.db.prepare("UPDATE capability_grants SET revoked=1 WHERE kind='documents'").run();
    } catch (e) { this.db.prepare("UPDATE capability_packages SET status='failed',error=? WHERE id='documents'").run(e.message); }
  }
  async grant({ projectId, reads, output = 'Outputs', hours = 8, acknowledged }) {
    const project = this.host.project(projectId), pkg = this.list(projectId).documents;
    if (pkg.status !== 'enabled') error('请先安装并启用文件能力包。');
    if (acknowledged !== true || !Array.isArray(reads) || reads.length > 20 || reads.some(p => !validPath(p)) || !validPath(output) || output === '.' || !Number.isFinite(hours) || hours <= 0 || hours > 720) error('请确认项目读取范围、独立输出目录及授权时长（最长 30 天）。');
    if (this.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(projectId)) error('共享项目需先核对自动同步的外发范围；当前文件包只支持私有项目。');
    const root = await realpath(project.path), stat = await lstat(root);
    for (const path of reads) await this.host.pathInProject(projectId, path);
    await this.outputDirectory(projectId, output);
    const config = { reads, output, image: pkg.config.image, root, device: stat.dev, inode: stat.ino, mode: 'isolated' };
    this.db.prepare("INSERT INTO capability_grants VALUES(?,'documents',?,?,0) ON CONFLICT(project_id,kind) DO UPDATE SET config=excluded.config,expires_at=excluded.expires_at,revoked=0").run(projectId, JSON.stringify(config), this.host.clock() + hours * 3600_000);
    this.host.changed(); return this.list(projectId);
  }
  async outputDirectory(projectId, path) {
    const root = await realpath(this.host.project(projectId).path); let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment); await mkdir(current, { recursive: false, mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) error('输出目录必须是项目内的普通目录。');
    }
    if (await realpath(current) !== current) error('输出目录发生变化，请重新授权。');
    return current;
  }
  async authorize(projectId) {
    const state = this.list(projectId), grant = state.grant;
    if (!grant?.active || state.documents.status !== 'enabled' || grant.config.image !== state.documents.config.image) error('文件工具尚未授权、授权已过期或包已更新。请在“能力与权限”确认。');
    const root = await realpath(this.host.project(projectId).path), stat = await lstat(root);
    if (root !== grant.config.root || stat.dev !== grant.config.device || stat.ino !== grant.config.inode) error('项目目录发生变化，请重新授权。');
    return grant.config;
  }
  async revoke(projectId) { this.host.project(projectId); this.db.prepare("UPDATE capability_grants SET revoked=1 WHERE project_id=? AND kind='documents'").run(projectId); for (const run of this.running.values()) if (run.projectId === projectId) run.controller.abort(); this.host.changed(); return this.list(projectId); }
  async enable(enabled) {
    if (typeof enabled !== 'boolean' || this.installing) error('文件能力状态不可修改。');
    this.db.prepare("UPDATE capability_packages SET status=? WHERE id='documents' AND status IN ('enabled','disabled')").run(enabled ? 'enabled' : 'disabled');
    if (!enabled) { this.db.prepare("UPDATE capability_grants SET revoked=1 WHERE kind='documents'").run(); for (const run of this.running.values()) run.controller.abort(); }
    this.host.changed(); return this.list();
  }
  async installSkill(projectId) {
    const root = await realpath(this.host.project(projectId).path);
    if (this.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(projectId)) error('请先在私有项目安装并检查技能。');
    let directory = root;
    for (const part of ['.agents', 'skills', 'turnsu-documents']) {
      directory = join(directory, part); await mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) error('技能目录不能是链接。');
    }
    const content = await readFile(join(pack, 'SKILL.md')), destination = join(directory, 'SKILL.md');
    try { await writeFile(destination, content, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; const stat = await lstat(destination); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== content.length || hash(await readFile(destination)) !== hash(content)) error('同名技能已存在且内容不同。已保留原文件，请先在项目中检查。'); }
    this.host.changed(); return { path: '.agents/skills/turnsu-documents/SKILL.md', hash: hash(content) };
  }
  tools(projectId) { return this.list(projectId).grant?.active && this.list(projectId).documents.status === 'enabled' ? [documentTool] : []; }
  call(projectId, sessionId, request, callId) {
    this.host.schedules?.assertTool(sessionId, 'documents');
    const id = callId ? hash(`${projectId}:${sessionId || 'manual'}:${callId}`) : randomUUID();
    const requestHash = hash(JSON.stringify(request));
    if (this.calls.has(id)) {
      if (this.calls.get(id).requestHash !== requestHash) return Promise.reject(new Error('同一工具调用不能改变输入。'));
      return this.calls.get(id).operation;
    }
    const old = this.db.prepare('SELECT * FROM capability_receipts WHERE id=?').get(id);
    if (old) {
      if (old.request_hash !== requestHash) return Promise.reject(new Error('同一工具调用不能改变输入。'));
      if(old.status!=='completed')return Promise.reject(new Error('这次工具调用已执行或中断。请先核对成果，再发起新的调用。'));
      return this.authorize(projectId).then(grant=>{if(old.grant_hash!==hash(JSON.stringify(grant)))error('原调用的授权范围已变化，请核对已有成果；不会自动重放。');return JSON.parse(old.result);});
    }
    this.host.requireResource?.('documents');
    if (this.pending.size >= 2) return Promise.reject(new Error('已有两个文件任务正在处理，请稍后重试。'));
    const operation = this.performCall(projectId, sessionId, request, id, requestHash);
    this.calls.set(id, { operation, requestHash }); this.pending.add(operation);
    operation.finally(() => { this.pending.delete(operation); this.calls.delete(id); }).catch(() => {}); return operation;
  }
  async performCall(projectId, sessionId, request, id, requestHash) {
    if (!['read', 'create', 'edit', 'convert'].includes(request.operation) || JSON.stringify(request).length > 800_000) error('文件操作无效或内容超过上限。');
    if (this.running.size >= 2) error('已有两个文件任务正在处理，请稍后重试。');
    await this.cleanupReady;
    if (this.cleanupError) error(this.cleanupError);
    const grant = await this.authorize(projectId), docker = executable('docker');
    if (!docker) error('隔离环境不可用，请启动 Docker。不会改用本机执行。');
    const controller = new AbortController(), name = `turnsu-doc-${id}`;
    this.running.set(id, { projectId, controller });
    const grantHash=hash(JSON.stringify(grant));
    this.db.prepare("INSERT INTO capability_receipts(id,project_id,session_id,tool,status,result,created_at,request_hash,grant_hash) VALUES(?,?,?,'document','running',NULL,?,?,?)").run(id, projectId, sessionId || null, this.host.clock(), requestHash,grantHash);
    let scratch, receipt;
    try {
      const base = join(this.host.directory, 'capability-jobs'); await mkdir(base, { recursive: true, mode: 0o700 });
      scratch = await mkdtemp(join(base, 'doc-')); const input = join(scratch, 'input'), output = join(scratch, 'output');
      await mkdir(input, { mode: 0o755 }); await mkdir(output, { mode: 0o777 }); await chmod(output, 0o777);
      let source, sourceHash;
      if (request.operation !== 'create') {
        if (!validPath(request.path)) error('文件不在本次授权读取范围。');
        const readable=grant.reads.some(root => within(request.path, root));
        // A create-only grant can inspect its exact generated output, not unrelated files
        // already in the output directory or a replacement at the same path.
        const owned=!readable&&within(request.path,grant.output)&&this.db.prepare("SELECT result FROM capability_receipts WHERE project_id=? AND status='completed' AND json_extract(result,'$.path')=? ORDER BY created_at DESC LIMIT 1").get(projectId,request.path);
        if(!readable&&!owned)error('文件不在本次授权读取范围。');
        const path = await this.host.pathInProject(projectId, request.path), suffix = extname(path).toLowerCase();
        if (!['.xlsx', '.docx', '.pdf'].includes(suffix)) error('请选择 Excel、Word 或 PDF 文件。');
        const bytes = await readBoundedFile(path, 32 * 1024 * 1024);
        if(!readable&&JSON.parse(owned.result).sha256!==hash(bytes))error('成果已被其他操作修改，请重新授权读取范围后核对。');
        if (await this.host.pathInProject(projectId, request.path) !== path) error('输入文件已变化。');
        sourceHash = hash(bytes); source = 'source' + suffix; await writeFile(join(input, source), bytes, { flag: 'wx', mode: 0o644 });
      }
      const needsOutput = request.operation !== 'read';
      if (needsOutput && (typeof request.output !== 'string' || request.output !== basename(request.output) || request.output.length > 100 || !/^[^./\\:][^/\\:]*\.(xlsx|docx|pdf)$/i.test(request.output))) error('请提供新文件名（.xlsx、.docx 或 .pdf），不要包含目录。');
      const target = needsOutput ? 'result' + extname(request.output).toLowerCase() : null;
      const wire = { ...request, source: source ? `/input/${source}` : null, target: target ? `/output/${target}` : null };
      this.db.prepare('INSERT INTO capability_containers VALUES(?,?)').run(name, scratch);
      const result = await this.runner(docker, ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--mount', dockerBind(input, '/input', true), '--mount', dockerBind(output, '/output'), '-i', grant.image], { input: JSON.stringify(wire), signal: controller.signal, children: this.children });
      let parsed; try { parsed = JSON.parse(result.stdout); } catch { error('文件工具没有返回有效结果。请检查隔离环境。'); }
      if (result.code || !parsed.ok) error(parsed.error || '文件处理失败。');
      if(hash(JSON.stringify(await this.authorize(projectId)))!==grantHash)error('执行中的授权范围已变化，未向项目发布成果。请核对后重新执行。');
      if (controller.signal.aborted) error('授权已撤销，未写入项目成果。');
      receipt = { ...parsed.result, source: request.path || null, sourceHash, execution: 'isolated', packageVersion: VERSION };
      if (target) {
        const generated = join(output, target), stat = await lstat(generated);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 32 * 1024 * 1024) error('成果必须是上限以内的普通文件。');
        const destination = await this.outputDirectory(projectId, grant.output), suffix = extname(request.output), stem = basename(request.output, suffix);
        const filename = `${stem}-${id.slice(0, 8)}${suffix}`;
        await copyFile(generated, join(destination, filename), constants.COPYFILE_EXCL);
        receipt.path = `${grant.output}/${filename}`; receipt.sha256 = hash(await readFile(join(destination, filename))); receipt.bytes = stat.size;
      }
      this.db.prepare("UPDATE capability_receipts SET status='completed',result=? WHERE id=?").run(JSON.stringify(receipt), id);
      this.host.notify({ type: 'capability-changed', projectId, sessionId }); this.host.changed(sessionId);
      return receipt;
    } catch (e) { this.db.prepare("UPDATE capability_receipts SET status='failed',result=? WHERE id=?").run(JSON.stringify({ error: e.message }), id); throw e; }
    finally {
      // Killing docker's client does not reliably stop its container. Always remove this exact owned name.
      try { await this.cleanupContainer(name); } catch (e) { this.cleanupError=e.message; if(receipt) { receipt.warnings=[...(receipt.warnings||[]),e.message]; receipt.cleanup='unconfirmed'; this.db.prepare('UPDATE capability_receipts SET result=? WHERE id=?').run(JSON.stringify(receipt),id); } this.host.notify({type:'capability-changed',projectId}); }
      this.running.delete(id); if (scratch && !this.db.prepare('SELECT 1 FROM capability_containers WHERE name=?').get(name)) await rm(scratch, { recursive: true, force: true });
    }
  }
  async cleanupContainer(name) {
    const record=this.db.prepare('SELECT * FROM capability_containers WHERE name=?').get(name); if(!record)return;
    const docker=executable('docker');
    const removed=await this.runner(docker,['rm','-f',name],{timeout:15_000}).catch(()=>null);
    if(!removed||removed.code) {
      const current=await this.runner(docker,['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'],{timeout:5000}).catch(()=>null);
      if(!current||current.code||current.stdout.trim())error('文件工具已停止接收调用，但未确认隔离进程已回收。请恢复 Docker 后重试回收；此前成果仍可查看。');
    }
    await rm(record.scratch,{recursive:true,force:true});this.db.prepare('DELETE FROM capability_containers WHERE name=?').run(name);
  }
  async cleanup() {
    if(this.running.size)error('请先停止正在处理的文件任务。');
    for(const record of this.db.prepare('SELECT name FROM capability_containers').all())await this.cleanupContainer(record.name);
    this.cleanupError=null;return {cleaned:true};
  }
  async close() { for (const run of this.running.values()) run.controller.abort(); await Promise.all([...this.children].map(child => closeNativeProcess(child))); await Promise.allSettled([...this.pending]); await this.installing; await this.cleanupReady; await this.cleanup(); }
}
