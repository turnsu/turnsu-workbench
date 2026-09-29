import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, mkdir, rename, rm, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_MANIFEST = 40_000_000;
const MAX_ITEM = 32 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const PAGE = 40;

function checkId(id) { if (typeof id !== 'string' || !UUID.test(id)) throw new Error('微信交接编号无效。'); return id.toUpperCase(); }
function safeRelative(path) {
  if (typeof path !== 'string' || path.length > 512 || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/u.test(part))) throw new Error('微信原档路径无效。');
  return path;
}
async function durableWrite(path, data) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
}
function summary(row) { return { id: row.id, projectId: row.project_id, batchId: row.batch_id, chatName: row.chat_name, itemCount: row.item_count, recordCount: row.record_count, unparsedCount: row.unparsed_count, importedAt: row.imported_at }; }
function validate(manifest, requestedId) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.action !== 'analyze' || manifest.selection !== 'all' || checkId(manifest.handoffID) !== requestedId || !UUID.test(manifest.batchID || '') || !['shared', 'app-group'].includes(manifest.storageMode) || (manifest.chatName !== null && manifest.chatName !== undefined && (typeof manifest.chatName !== 'string' || manifest.chatName.length > 256)) || !Array.isArray(manifest.items) || manifest.items.length < 1 || manifest.items.length > 32 || !Array.isArray(manifest.records) || manifest.records.length > 100_000 || !Array.isArray(manifest.unparsedItemIDs)) throw new Error('微信交接版本或范围无效。');
  const ids = new Set(); let total = 0;
  for (const item of manifest.items) {
    if (!UUID.test(item?.id || '') || ids.has(item.id.toUpperCase()) || !SHA256.test(item.sha256 || '') || typeof item.displayName !== 'string' || item.displayName.length > 256 || !Number.isSafeInteger(item.byteCount) || item.byteCount < 0 || item.byteCount > MAX_ITEM) throw new Error('微信原档引用无效或文件过大。');
    safeRelative(item.relativePath); ids.add(item.id.toUpperCase()); total += item.byteCount;
  }
  if (total > MAX_ARCHIVE) throw new Error('微信归档超过单次导入上限，请分批分享。');
  for (const record of manifest.records) if (!UUID.test(record?.sourceItemID || '') || !ids.has(record.sourceItemID.toUpperCase()) || typeof record.sender !== 'string' || record.sender.length > 512 || typeof record.text !== 'string' || record.text.length > 100_000 || typeof record.date !== 'string' || !Number.isFinite(Date.parse(record.date))) throw new Error('微信记录格式无效。');
  if (manifest.unparsedItemIDs.some(id => !UUID.test(id) || !ids.has(id.toUpperCase()))) throw new Error('未解析文件引用无效。');
  return manifest;
}

export class WeChatImports {
  constructor(host, { bridgeRoot = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Turnsu/WeChatBridge') : null, groupRoot = join(homedir(), 'Library/Group Containers/group.local.turnsu.wechatbridge.shared') } = {}) {
    this.host = host; this.db = host.db; this.bridgeRoot = bridgeRoot; this.groupRoot = groupRoot;
    this.snapshotRoot = join(host.directory, 'wechat-imports');
    this.pending = new Map();
  }
  async listHandoffs() {
    if (!this.bridgeRoot) return { available: false, handoffs: [] };
    let entries;
    try { entries = await readdir(join(this.bridgeRoot, 'Handoffs'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { available: true, handoffs: [] }; throw error; }
    const handoffs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      const id = entry.name.slice(0, -5); if (!UUID.test(id)) continue;
      const info = await lstat(join(this.bridgeRoot, 'Handoffs', entry.name));
      if (info.isFile() && !info.isSymbolicLink()) handoffs.push({ id: id.toUpperCase(), modifiedAt: info.mtimeMs });
    }
    handoffs.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { available: true, handoffs: handoffs.slice(0, 100), truncated: handoffs.length > 100 };
  }
  async load(id) {
    id = checkId(id);
    if (!this.bridgeRoot) throw new Error('此系统没有微信桥原生分享入口，请使用文件导入。');
    const path = join(this.bridgeRoot, 'Handoffs', `${id}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST) throw new Error('微信交接文件不可用或过大。');
    const raw = await readFile(path);
    if (raw.length > MAX_MANIFEST) throw new Error('微信交接文件过大。');
    let manifest;
    try { manifest = validate(JSON.parse(raw.toString('utf8')), id); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('微信交接 JSON 无效。'); throw error; }
    const ready = manifest.storageMode === 'shared' ? join(this.bridgeRoot, 'Inbox/Ready') : join(this.groupRoot, 'Inbox/Ready');
    return { manifest, batch: join(ready, checkId(manifest.batchID)), raw };
  }
  async verifyFile(batch, item, destination = null) {
    const path = safeRelative(item.relativePath);
    const canonicalBatch = await realpath(batch);
    let target = batch;
    for (const part of path.split('/')) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new Error('微信原档包含链接，不能导入。');
    }
    const canonical = await realpath(target);
    if (!canonical.startsWith(canonicalBatch + sep)) throw new Error('微信原档路径越界。');
    const source = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output;
    try {
      const before = await source.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== item.byteCount) throw new Error('微信原档大小或类型已变化。');
      if (destination) { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); output = await open(destination, 'wx', 0o600); }
      const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        if (output) {
          let written = 0;
          while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
        }
        offset += bytesRead;
        if (offset > MAX_ITEM) throw new Error('微信原档超过单文件上限。');
      }
      const after = await source.stat(), current = await lstat(target);
      if (offset !== item.byteCount || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || hash.digest('hex') !== item.sha256.toLowerCase()) throw new Error('微信原档校验失败，请从桥重新分享。');
      if (output) await output.sync();
    } finally { await output?.close(); await source.close(); }
  }
  async verified(id, destination = null) {
    const data = await this.load(id);
    for (const item of data.manifest.items) await this.verifyFile(data.batch, item, destination ? join(destination, safeRelative(item.relativePath)) : null);
    return data;
  }
  async preview(id, { offset = 0 } = {}) {
    const { manifest } = await this.load(id);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('记录位置无效。');
    return { id: checkId(id), batchId: manifest.batchID, chatName: manifest.chatName || null, itemCount: manifest.items.length, recordCount: manifest.records.length, unparsedCount: manifest.unparsedItemIDs.length,
      items: manifest.items.map(item => ({ id: item.id, displayName: item.displayName, byteCount: item.byteCount, sha256: item.sha256, parsed: !manifest.unparsedItemIDs.includes(item.id) })),
      records: manifest.records.slice(offset, offset + PAGE).map((record, i) => ({ position: offset + i, sourceItemID: record.sourceItemID, sender: record.sender, date: record.date, text: record.text.slice(0, 600), truncated: record.text.length > 600 })), nextOffset: offset + PAGE < manifest.records.length ? offset + PAGE : null };
  }
  list(projectId, { before } = {}) {
    this.host.project(projectId);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('导入列表位置无效。');
    const rows = this.db.prepare(`SELECT rowid,* FROM wechat_imports WHERE project_id=?${before ? ' AND rowid<?' : ''} ORDER BY rowid DESC LIMIT 21`).all(projectId, ...(before ? [before] : []));
    return { imports: rows.slice(0, 20).map(summary), before: rows.length > 20 ? rows[19].rowid : null };
  }
  imported(id, projectId) {
    const row = this.db.prepare('SELECT * FROM wechat_imports WHERE id=? AND project_id=?').get(checkId(id), projectId);
    if (!row) throw new Error('找不到这个项目中的微信导入。');
    return row;
  }
  records(projectId, id, offset = 0, { full = false } = {}) {
    const row = this.imported(id, projectId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.record_count) throw new Error('记录位置无效。');
    const fields = full ? 'text' : 'substr(text,1,600) AS text,length(text)>600 AS truncated';
    const records = this.db.prepare(`SELECT position,source_item_id AS sourceItemID,sender,date,${fields} FROM wechat_records WHERE import_id=? AND position>=? ORDER BY position LIMIT 40`).all(row.id, offset);
    const items = full ? [] : this.db.prepare('SELECT id,display_name AS displayName,byte_count AS byteCount,sha256,parsed FROM wechat_items WHERE import_id=? ORDER BY rowid').all(row.id).map(item => ({ ...item, parsed: Boolean(item.parsed) }));
    return { ...summary(row), items, records, nextOffset: offset + PAGE < row.record_count ? offset + PAGE : null };
  }
  async import(projectId, id) {
    this.host.project(projectId); id = checkId(id);
    const pending = this.pending.get(id);
    if (pending) {
      const result = await pending;
      if (result.projectId !== projectId) throw new Error('这份交接已归入另一个项目，不能跨项目复用。');
      return result;
    }
    const operation = this.importOne(projectId, id);
    this.pending.set(id, operation);
    try { return await operation; }
    finally { this.pending.delete(id); }
  }
  async importOne(projectId, id) {
    const prior = this.db.prepare('SELECT * FROM wechat_imports WHERE id=?').get(id);
    if (prior) {
      if (prior.project_id !== projectId) throw new Error('这份交接已归入另一个项目，不能跨项目复用。');
      let info;
      try { info = await lstat(join(this.snapshotRoot, id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('已导入的原档快照不完整，请联系管理员恢复本机数据。');
      return summary(prior);
    }
    await mkdir(this.snapshotRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.snapshotRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.platform !== 'win32' && (rootInfo.mode & 0o077)) || (process.getuid && rootInfo.uid !== process.getuid())) throw new Error('微信导入数据目录权限不安全。');
    const final = join(this.snapshotRoot, id), staging = join(this.snapshotRoot, `.${id}.${randomUUID()}`);
    let data;
    try {
      // A terminated import may leave a private staging copy. The same handoff is serialized above.
      for (const entry of await readdir(this.snapshotRoot, { withFileTypes: true })) {
        if (entry.name.startsWith(`.${id}.`) && UUID.test(entry.name.slice(id.length + 2))) await rm(join(this.snapshotRoot, entry.name), { recursive: true, force: true });
      }
      let existing = false;
      try { const info = await lstat(final); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('导入快照目录不安全。'); existing = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        const binding = JSON.parse(await readFile(join(final, 'binding.json'), 'utf8'));
        if (binding.projectId !== projectId || binding.id !== id) throw new Error('导入快照属于另一个项目，不能跨项目复用。');
        const info = await lstat(join(final, 'manifest.json'));
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST) throw new Error('导入快照不可用或过大。');
        const raw = await readFile(join(final, 'manifest.json'));
        data = { manifest: validate(JSON.parse(raw.toString('utf8')), id) };
        for (const item of data.manifest.items) await this.verifyFile(final, item);
      } else {
        await mkdir(staging, { mode: 0o700 });
        data = await this.verified(id, staging);
        await durableWrite(join(staging, 'binding.json'), JSON.stringify({ projectId, id }));
        await durableWrite(join(staging, 'manifest.json'), data.raw);
        await rename(staging, final);
        // Windows does not support fsync on a directory handle; copied files are flushed above.
        if (process.platform !== 'win32') {
          const directory = await open(this.snapshotRoot, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      }
      const manifest = data.manifest, importedAt = Date.now();
      this.db.exec('BEGIN');
      try {
        this.db.prepare('INSERT INTO wechat_imports VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, checkId(manifest.batchID), manifest.chatName || null, manifest.items.length, manifest.records.length, manifest.unparsedItemIDs.length, importedAt);
        const addItem = this.db.prepare('INSERT INTO wechat_items VALUES(?,?,?,?,?,?,?)');
        for (const item of manifest.items) addItem.run(id, item.id, item.displayName, item.relativePath, item.byteCount, item.sha256, manifest.unparsedItemIDs.includes(item.id) ? 0 : 1);
        const add = this.db.prepare('INSERT INTO wechat_records VALUES(?,?,?,?,?,?)');
        for (const [position, record] of manifest.records.entries()) add.run(id, position, record.sourceItemID, record.sender, record.date, record.text);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.host.changed();
      return summary(this.imported(id, projectId));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  reference(projectId, selection) {
    const page = this.records(projectId, selection.importId, selection.offset, { full: true });
    if (page.records.length < selection.count) throw new Error('引用的微信记录范围已变化，请重新选择。');
    const text = page.records.slice(0, selection.count).map(r => `[${r.position + 1}] ${r.date} · ${r.sender}: ${r.text}`).join('\n');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > 64 * 1024) throw new Error('这一页记录超过引用上限，请缩小范围。');
    return { kind: 'wechat-import', importId: selection.importId, offset: selection.offset, count: selection.count, path: `微信导入/${page.chatName || page.id}/${selection.offset + 1}-${selection.offset + selection.count}`, text, contentHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  }
}
