import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, open, mkdir, rename, link, realpath, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
const DEEP_SCAN_MS = 10 * 60 * 1000;
const MAX_CACHED_PROJECTS = 8;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 && path === path.normalize('NFC') && path.split('/').every(p => p && p.length <= 128 && !p.startsWith('.') && !/[\\\x00-\x1f\x7f:<>"|?*]/u.test(p) && !/[. ]$/u.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p));
}
async function exists(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function explain(error) {
  if (error.status === 401 || /sync_login_required|native_session_/.test(error.message)) return '请重新连接团队。待同步内容仍保留在本机。';
  if (error.message === 'sync_connection_changed') return '团队登录已更换。请在项目中确认后恢复同步。';
  if ([403, 404].includes(error.status)) return '当前账户已无法访问这个项目。同步已停止，本机文件仍保留。';
  if (error.message.startsWith('sync_')) return ({ sync_root_changed: '共享目录已移动或被替换，请恢复原目录后重试。', sync_unsafe_path: '文件路径包含符号链接或不支持的名称，未同步。', sync_file_too_large: '单个文件超过 8 MB，未同步。', sync_file_changing: '文件仍在写入，稍后重试。', sync_integrity: '下载内容校验失败，未改动本机文件。', sync_too_many_files: '共享目录超过 5000 个文件，请缩小共享范围。' })[error.message] || '同步暂未完成，请检查文件后重试。';
  return '暂时无法同步，连接恢复后会重试。待同步内容仍保留在本机。';
}

// Local delivery state only. Product owns membership, revisions and conflict decisions.
export class SharedFiles {
  constructor({ db, cloud, project, notify = () => {}, isBusy = () => false }) {
    Object.assign(this, { db, cloud, project, notify, isBusy }); this.running = new Map(); this.closed = false;
    // Metadata only. File bodies and Agent history must not accumulate in the Host.
    this.fingerprints = new Map(); this.deepScanAt = new Map(); this.polling = null;
  }
  binding(id) { const b = this.db.prepare('SELECT * FROM shared_projects WHERE project_id=?').get(id); if (!b) throw new Error('这个项目尚未加入团队共享。'); return b; }
  includes(b, path, ancestors = false) {
    const scope = b.scope ? JSON.parse(b.scope) : null;
    return !scope || scope.some(item => path === item.path || (item.kind === 'directory' && path.startsWith(item.path + '/')) || (ancestors && item.path.startsWith(path + '/')));
  }
  assertIncluded(b, path) { if (!this.includes(b, path)) throw new Error('这个文件不在已确认的共享范围内。'); }
  snapshot(id) {
    const b = this.db.prepare('SELECT * FROM shared_projects WHERE project_id=?').get(id); if (!b) return null;
    return { projectId: id, title: b.title, scope: b.scope ? JSON.parse(b.scope) : null, paused: Boolean(b.paused), status: b.status, error: b.error, conflicts: JSON.parse(b.conflicts), issues: JSON.parse(b.issues), syncedAt: b.synced_at,
      pending: this.db.prepare('SELECT count(*) AS n FROM shared_outbox WHERE project_id=?').get(id).n };
  }
  change(id, status, error = '') { this.db.prepare('UPDATE shared_projects SET status=?,error=? WHERE project_id=?').run(status, error, id); this.notify({ type: 'sync-changed', projectId: id }); }
  async attach(id, remoteId, scope) {
    if (this.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(id)) throw new Error('这个文件夹已经绑定了团队项目。');
    if (this.isBusy(id)) throw new Error('请等项目中的 Agent 完成本次工作，再选择共享范围。');
    if (scope !== undefined && (!Array.isArray(scope) || !scope.length || scope.length > 64 || scope.some(item => !item || !validPath(item.path) || !['file', 'directory'].includes(item.kind)) || new Set(scope.map(item => item.path.toLowerCase())).size !== scope.length)) throw new Error('请选择 1 至 64 个有效文件或目录作为共享范围。');
    const project = this.project(id), identity = await this.cloud.identity();
    const remote = await this.cloud.fileCall(identity, 'turnsu_project', { pathParams: { projectId: remoteId } });
    if (remote.data.status === 'archived') throw new Error('项目已归档，不能开始同步。');
    if (scope === undefined && (await readdir(project.path)).length) throw new Error('请选择一个空文件夹，或明确选择已有项目中的共享范围。');
    const root = await lstat(project.path);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('请选择一个实际文件夹。');
    const binding = { project_id: id, device: root.dev, inode: root.ino };
    await this.root(binding);
    for (const item of scope || []) {
      const info = await lstat(await this.target(binding, item.path));
      if (info.isSymbolicLink() || (item.kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw new Error('所选文件或目录已变化，请重新选择共享范围。');
    }
    if (JSON.stringify(await this.cloud.identity()) !== JSON.stringify(identity)) throw new Error('sync_connection_changed');
    this.db.prepare('INSERT INTO shared_projects(project_id,remote_id,identity,title,device,inode,scope) VALUES(?,?,?,?,?,?,?)').run(id, remoteId, JSON.stringify(identity), remote.data.title, root.dev, root.ino, scope === undefined ? null : JSON.stringify(scope.map(({ path, kind }) => ({ path, kind }))));
    this.change(id, 'pending'); return this.snapshot(id);
  }
  async root(b) {
    const path = this.project(b.project_id).path, info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== b.device || info.ino !== b.inode || await realpath(path) !== path) throw new Error('sync_root_changed');
    return path;
  }
  async target(b, path, create = false) {
    if (!validPath(path)) throw new Error('sync_unsafe_path');
    let parent = await this.root(b);
    for (const part of path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      if (create) await mkdir(parent).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('sync_unsafe_path');
    }
    return join(parent, path.split('/').at(-1));
  }
  async bytes(b, path) {
    this.assertIncluded(b, path);
    let target;
    try { target = await this.target(b, path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    let file;
    try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1) throw new Error('sync_unsafe_path');
      if (before.size > MAX_BYTES) throw new Error('sync_file_too_large');
      // Bounded even if another process grows the file after stat.
      const buffer = Buffer.alloc(before.size + 1); let used = 0;
      while (used < buffer.length) { const result = await file.read(buffer, used, buffer.length - used, null); if (!result.bytesRead) break; used += result.bytesRead; }
      const after = await file.stat();
      if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('sync_file_changing');
      return buffer.subarray(0, used);
    } finally { await file.close(); }
  }
  fingerprint(info) { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
  async localContent(b, path, previous, force = false) {
    let target;
    try { target = await this.target(b, path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    let cache = this.fingerprints.get(b.project_id);
    if (!cache && this.fingerprints.size < MAX_CACHED_PROJECTS) {
      cache = new Map(); this.fingerprints.set(b.project_id, cache);
    }
    let before;
    try { before = await lstat(target); } catch (e) { if (e.code === 'ENOENT') { cache?.delete(path); return null; } throw e; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) { cache?.delete(path); throw new Error('sync_unsafe_path'); }
    if (before.size > MAX_BYTES) { cache?.delete(path); throw new Error('sync_file_too_large'); }
    const fingerprint = this.fingerprint(before), saved = cache?.get(path);
    if (!force && previous && !previous.deleted && !previous.conflict_id && !previous.conflict_deleted &&
      saved?.fingerprint === fingerprint && saved.contentHash === previous.content_hash) return { contentHash: saved.contentHash, bytes: null };
    const bytes = await this.bytes(b, path);
    if (!bytes) { cache?.delete(path); return null; }
    let after;
    try { after = await lstat(target); } catch (e) { if (e.code === 'ENOENT') throw new Error('sync_file_changing'); throw e; }
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || this.fingerprint(after) !== fingerprint) {
      cache?.delete(path); throw new Error('sync_file_changing');
    }
    const contentHash = hash(bytes);
    cache?.set(path, { fingerprint, contentHash });
    return { contentHash, bytes };
  }
  pruneFingerprints(id, paths) {
    const cache = this.fingerprints.get(id); if (!cache) return;
    const present = new Set(paths);
    for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
  }
  async scan(b) {
    const paths = [], issues = [], seen = new Set(); let count = 0;
    const walk = async (folder = '') => {
      const directory = folder ? await this.target(b, folder + '/placeholder') : await this.root(b);
      for (const entry of await readdir(folder ? dirname(directory) : directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = folder ? folder + '/' + entry.name : entry.name;
        if (!this.includes(b, path, entry.isDirectory())) continue;
        if (++count > 5000) throw new Error('sync_too_many_files');
        if (!validPath(path) || entry.isSymbolicLink() || seen.has(path.toLowerCase())) { issues.push({ path, message: '名称不支持、大小写重复或为符号链接，未同步。' }); continue; }
        seen.add(path.toLowerCase());
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) paths.push(path);
        else issues.push({ path, message: '只同步普通文件。' });
      }
    };
    await walk(); return { paths, issues };
  }
  file(id, path) { return this.db.prepare('SELECT * FROM shared_files WHERE project_id=? AND path=?').get(id, path); }
  baseline(id, path, revision, contentHash, conflictId = null, conflictHash = null, deleted = false, conflictDeleted = false, deleteReady = true) {
    this.db.prepare('INSERT INTO shared_files(project_id,path,revision_id,content_hash,conflict_id,conflict_hash,deleted,conflict_deleted,delete_ready) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET revision_id=excluded.revision_id,content_hash=excluded.content_hash,conflict_id=excluded.conflict_id,conflict_hash=excluded.conflict_hash,deleted=excluded.deleted,conflict_deleted=excluded.conflict_deleted,delete_ready=excluded.delete_ready').run(id, path, revision, contentHash, conflictId, conflictHash, Number(deleted), Number(conflictDeleted), Number(deleteReady));
  }
  async call(b, name, data = {}) { if (this.closed) throw new Error('sync_closed'); return this.cloud.fileCall(JSON.parse(b.identity), name, { ...data, pathParams: { ...data.pathParams, projectId: b.remote_id } }); }
  enqueue(b, path, bytes, baseRevisionId, resolvesRevisionIds = [], deleted = false) {
    this.assertIncluded(b, path);
    this.db.prepare('INSERT INTO shared_outbox(project_id,path,input_id,data,delete_ready) VALUES(?,?,?,?,1)').run(b.project_id, path, randomUUID(), JSON.stringify({ path, baseRevisionId, mediaType: /\.md$/i.test(path) ? 'text/markdown' : 'application/octet-stream', contentBase64: bytes.toString('base64'), ...(deleted ? { deleted: true } : {}), ...(resolvesRevisionIds.length ? { resolvesRevisionIds } : {}) }));
  }
  async flush(b) {
    for (const item of this.db.prepare('SELECT * FROM shared_outbox WHERE project_id=? ORDER BY rowid').all(b.project_id)) {
      this.assertIncluded(b, item.path);
      const result = (await this.call(b, 'turnsu_commit_project_file', { data: JSON.parse(item.data), idempotencyKey: item.input_id })).data;
      const r = result.revision, previous = this.file(b.project_id, item.path);
      const deleteReady = Boolean(item.delete_ready || previous?.delete_ready);
      this.db.exec('BEGIN');
      try {
        if (r.outcome === 'synced') this.baseline(b.project_id, item.path, r.revisionId, r.contentHash, null, null, r.deleted, false, deleteReady);
        else this.baseline(b.project_id, item.path, previous?.revision_id || null, previous?.content_hash || null, r.revisionId, r.contentHash, Boolean(previous?.deleted), r.deleted, deleteReady);
        this.db.prepare('DELETE FROM shared_outbox WHERE project_id=? AND path=?').run(b.project_id, item.path); this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  async remote(b) {
    const files = []; let cursor;
    do { const result = await this.call(b, 'turnsu_project_files', { query: { limit: 100, ...(cursor ? { cursor } : {}) } }); files.push(...result.data); cursor = result.page?.nextCursor; if (files.length > 10000) throw new Error('sync_too_many_files'); } while (cursor);
    return files.filter(file => this.includes(b, file.path));
  }
  async download(b, revision) {
    this.assertIncluded(b, revision.path);
    const r = (await this.call(b, 'turnsu_project_file', { pathParams: { revisionId: revision.revisionId } })).data;
    const bytes = Buffer.from(r.contentBase64, 'base64');
    if (bytes.length > MAX_BYTES || bytes.length !== revision.byteLength || hash(bytes) !== revision.contentHash || r.path !== revision.path || Boolean(r.deleted) !== Boolean(revision.deleted)) throw new Error('sync_integrity');
    return bytes;
  }
  async privateArea(b) {
    const area = join(await this.root(b), '.turnsu-local'); await mkdir(area, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const info = await lstat(area); if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('sync_unsafe_path');
    return area;
  }
  async install(b, revision, bytes) {
    const job = { revision, data: bytes.toString('base64'), backup: randomUUID() + '--' + revision.path.split('/').at(-1), stage: randomUUID() };
    this.db.prepare('INSERT INTO shared_incoming VALUES(?,?,?)').run(b.project_id, revision.path, JSON.stringify(job));
    await this.applyIncoming(b, revision.path, job);
  }
  async applyIncoming(b, path, job) {
    this.assertIncluded(b, path);
    if (job.revision.deleted) return this.applyDeletion(b, path, job);
    // Durable intent precedes all filesystem mutations. Existing contents are moved, never destroyed.
    const area = await this.privateArea(b), destination = await this.target(b, path, true), staged = join(area, job.stage), backup = join(area, job.backup);
    const bytes = Buffer.from(job.data, 'base64');
    if (await exists(staged)) {
      const previousStage = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
      let matches;
      try { const info = await previousStage.stat(); matches = info.isFile() && info.size === bytes.length && hash(await previousStage.readFile()) === job.revision.contentHash; } finally { await previousStage.close(); }
      if (!matches) {
        // A killed writer may leave a partial stage; an editor may also have changed the linked
        // destination before receipt persistence. Preserve both, then retry from durable bytes.
        const destinationInfo = await exists(destination);
        if (destinationInfo?.ino === (await lstat(staged)).ino && destinationInfo.dev === (await lstat(staged)).dev) await unlink(staged);
        else await rename(staged, join(area, randomUUID() + '--interrupted-' + path.split('/').at(-1)));
      }
    }
    if (!await exists(staged)) {
      const file = await open(staged, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }
    const stage = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (hash(await stage.readFile()) !== job.revision.contentHash) throw new Error('sync_integrity'); } finally { await stage.close(); }
    const current = await this.bytes(b, path).catch(e => { if (e.message === 'sync_unsafe_path') return null; throw e; });
    const alreadyInstalled = current && hash(current) === job.revision.contentHash;
    const linkedAlready = await exists(destination) && (await lstat(destination)).ino === (await lstat(staged)).ino;
    if (!alreadyInstalled && !linkedAlready && !await exists(backup) && await exists(destination)) await rename(destination, backup);
    // link is atomic and exclusive: an editor creating a new file in the gap is never overwritten.
    await link(staged, destination).catch(e => { if (e.code !== 'EEXIST') throw e; });
    // Break our own hard link so future normal reads cannot be mistaken for external hard links.
    await unlink(staged);
    for (const folder of new Set([area, dirname(destination)])) { const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    this.db.exec('BEGIN');
    try {
      this.baseline(b.project_id, path, job.revision.revisionId, job.revision.contentHash);
      this.db.prepare('DELETE FROM shared_incoming WHERE project_id=? AND path=?').run(b.project_id, path); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async installDeletion(b, revision, expectedHash) {
    this.assertIncluded(b, revision.path);
    const job = { revision, expectedHash, backup: randomUUID() + '--' + revision.path.split('/').at(-1) };
    this.db.prepare('INSERT INTO shared_incoming VALUES(?,?,?)').run(b.project_id, revision.path, JSON.stringify(job));
    await this.applyDeletion(b, revision.path, job);
  }
  async applyDeletion(b, path, job) {
    this.assertIncluded(b, path);
    const area = await this.privateArea(b), backup = join(area, job.backup);
    let destination;
    try { destination = await this.target(b, path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!await exists(backup)) {
      const current = destination ? await this.bytes(b, path) : null;
      if (current && hash(current) !== job.expectedHash) {
        this.db.prepare('DELETE FROM shared_incoming WHERE project_id=? AND path=?').run(b.project_id, path);
        throw new Error('sync_file_changing');
      }
      if (current) await rename(destination, backup);
    }
    if (await exists(backup)) {
      const file = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
      let matches;
      try {
        const info = await file.stat();
        if (info.isFile() && info.size <= MAX_BYTES) {
          const buffer = Buffer.alloc(info.size + 1); let used = 0;
          while (used < buffer.length) { const read = await file.read(buffer, used, buffer.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
          matches = used === info.size && hash(buffer.subarray(0, used)) === job.expectedHash;
        } else matches = false;
      } finally { await file.close(); }
      if (!matches) {
        // An editor raced the move. Restore exclusively; if it already recreated the path, keep
        // both versions. The previous baseline remains so the edit can conflict with the deletion.
        destination ||= await this.target(b, path, true);
        let restored = false;
        await link(backup, destination).then(() => { restored = true; }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        if (restored) await unlink(backup);
        this.db.prepare('DELETE FROM shared_incoming WHERE project_id=? AND path=?').run(b.project_id, path);
        throw new Error('sync_file_changing');
      }
    }
    for (const folder of new Set([area, ...(destination ? [dirname(destination)] : [])])) { const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    this.db.exec('BEGIN');
    try {
      this.baseline(b.project_id, path, job.revision.revisionId, job.revision.contentHash, null, null, true);
      this.db.prepare('DELETE FROM shared_incoming WHERE project_id=? AND path=?').run(b.project_id, path); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async queueDeletions(b, present, issues = []) {
    for (const previous of this.db.prepare('SELECT * FROM shared_files WHERE project_id=? AND deleted=0 AND conflict_deleted=0').all(b.project_id)) {
      if (this.isBusy(b.project_id)) break;
      if (present.has(previous.path) || !previous.revision_id || this.db.prepare('SELECT 1 FROM shared_outbox WHERE project_id=? AND path=? UNION ALL SELECT 1 FROM shared_incoming WHERE project_id=? AND path=?').get(b.project_id, previous.path, b.project_id, previous.path)) continue;
      try {
        if (await this.bytes(b, previous.path)) continue;
        if (!previous.delete_ready) { issues.push({ path: previous.path, message: '本机此前已移除此文件。选择恢复，或将删除同步给团队。', recoverable: true, canDelete: true }); continue; }
        this.enqueue(b, previous.path, Buffer.alloc(0), previous.revision_id, previous.conflict_id ? [previous.conflict_id] : [], true);
      } catch (error) { issues.push({ path: previous.path, message: explain(error) }); }
    }
  }
  async sync(id) {
    if (this.closed) return;
    if (this.running.has(id)) return this.running.get(id);
    const operation = this.cycle(id).finally(() => this.running.delete(id)); this.running.set(id, operation); return operation;
  }
  async cycle(id) {
    const b = this.binding(id);
    if (b.paused) return this.snapshot(id);
    if (this.isBusy(id)) { this.change(id, 'working'); return this.snapshot(id); }
    this.change(id, 'syncing');
    try {
      await this.root(b);
      // Fresh Product membership check before reading local files or replaying uploads.
      await this.call(b, 'turnsu_project');
      for (const item of this.db.prepare('SELECT * FROM shared_incoming WHERE project_id=?').all(id)) await this.applyIncoming(b, item.path, JSON.parse(item.job));
      await this.flush(b);
      const { paths, issues } = await this.scan(b);
      this.pruneFingerprints(id, paths);
      const force = Date.now() - (this.deepScanAt.get(id) || 0) >= DEEP_SCAN_MS;
      let checkedAll = true;
      for (const path of paths) {
        if (this.isBusy(id)) { checkedAll = false; break; }
        try {
          const previous = this.file(id, path), local = await this.localContent(b, path, previous, force);
          if (!local) continue;
          if (previous) this.db.prepare('UPDATE shared_files SET delete_ready=1 WHERE project_id=? AND path=?').run(id, path);
          if (previous?.deleted || (local.contentHash !== previous?.content_hash && (previous?.conflict_deleted || local.contentHash !== previous?.conflict_hash))) this.enqueue(b, path, local.bytes, previous?.revision_id || null, previous?.conflict_id ? [previous.conflict_id] : []);
        } catch (error) { issues.push({ path, message: explain(error) }); }
      }
      await this.queueDeletions(b, new Set(paths), issues);
      if (checkedAll) this.deepScanAt.set(id, Date.now());
      await this.flush(b);
      const remote = await this.remote(b), conflicts = remote.filter(f => f.outcome === 'conflict').map(item => ({ ...item,
        headDeleted: Boolean(remote.find(head => head.outcome === 'synced' && head.path === item.path)?.deleted), localDeleted: !paths.includes(item.path) }));
      this.db.prepare('UPDATE shared_projects SET conflicts=? WHERE project_id=?').run(JSON.stringify(conflicts), id);
      const present = new Set(paths); let pendingLocalEdit = false;
      for (const head of remote.filter(f => f.outcome === 'synced')) {
        if (this.isBusy(id)) break;
        const previous = this.file(id, head.path);
        const conflictResolved = previous?.conflict_id && !conflicts.some(f => f.revisionId === previous.conflict_id);
        if (head.deleted) {
          if (previous?.revision_id === head.revisionId) continue;
          const bytes = await this.bytes(b, head.path);
          if (bytes && ((previous?.conflict_id && !conflictResolved) || (hash(bytes) !== previous?.content_hash && !(conflictResolved && hash(bytes) === previous?.conflict_hash)))) { pendingLocalEdit = true; continue; }
          await this.installDeletion(b, head, bytes ? hash(bytes) : null);
          continue;
        }
        if (previous && !previous.deleted && !present.has(head.path)) continue;
        if (previous?.revision_id === head.revisionId) continue;
        const bytes = await this.bytes(b, head.path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (bytes && hash(bytes) !== previous?.content_hash && !(conflictResolved && hash(bytes) === previous.conflict_hash)) { pendingLocalEdit = true; continue; }
        const incoming = await this.download(b, head);
        // Recheck after network latency; a new local edit will upload on the next cycle.
        const now = await this.bytes(b, head.path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (this.isBusy(id) || (now ? hash(now) : null) !== (bytes ? hash(bytes) : null)) { pendingLocalEdit = true; continue; }
        await this.install(b, head, incoming);
      }
      const deletedFiles = remote.filter(f => f.outcome === 'synced' && f.deleted);
      for (const head of deletedFiles) issues.push({ path: head.path, message: '团队已移除此文件，旧版本仍可恢复。', deleted: true, recoverable: true });
      for (const item of issues) if (item.recoverable) item.headRevisionId = remote.find(head => head.outcome === 'synced' && head.path === item.path)?.revisionId;
      this.db.prepare('UPDATE shared_projects SET issues=?,synced_at=? WHERE project_id=?').run(JSON.stringify(issues), Date.now(), id);
      this.change(id, this.isBusy(id) ? 'working' : conflicts.length ? 'conflict' : issues.some(item => !item.deleted) ? 'attention' : pendingLocalEdit ? 'pending' : 'synced');
    } catch (e) {
      const access = [401, 403, 404].includes(e.status) || /sync_connection_changed|sync_login_required|native_session_/.test(e.message);
      if (!access && !this.isBusy(id) && !this.closed) {
        // Capture offline edits durably without making a network call. A later flush rechecks
        // Product membership and retries exactly the original payload and idempotency key.
        try { const scanned = await this.scan(b); this.pruneFingerprints(id, scanned.paths);
          const force = Date.now() - (this.deepScanAt.get(id) || 0) >= DEEP_SCAN_MS;
          for (const path of scanned.paths) {
          if (this.db.prepare('SELECT 1 FROM shared_outbox WHERE project_id=? AND path=? UNION ALL SELECT 1 FROM shared_incoming WHERE project_id=? AND path=?').get(id, path, id, path)) continue;
          const previous = this.file(id, path), local = await this.localContent(b, path, previous, force);
          if (local && (previous?.deleted || (local.contentHash !== previous?.content_hash && (previous?.conflict_deleted || local.contentHash !== previous?.conflict_hash)))) this.enqueue(b, path, local.bytes, previous?.revision_id || null);
        } await this.queueDeletions(b, new Set(scanned.paths)); this.deepScanAt.set(id, Date.now()); } catch { /* A bad/moving file remains on disk; the original actionable error is retained. */ }
      }
      this.change(id, access ? 'access' : 'offline', explain(e));
    }
    return this.snapshot(id);
  }
  async pause(id) { this.db.prepare('UPDATE shared_projects SET paused=1 WHERE project_id=?').run(id); await this.running.get(id); this.change(id, 'paused'); return this.snapshot(id); }
  async resume(id) {
    await this.running.get(id); const b = this.binding(id), identity = await this.cloud.identity();
    // Resuming after a new login is explicit. Never send pending data to another origin/workspace.
    const old = JSON.parse(b.identity);
    if (old.origin !== identity.origin || old.workspaceId !== identity.workspaceId) throw new Error('请连接原来的团队后再恢复此项目。');
    await this.cloud.fileCall(identity, 'turnsu_project', { pathParams: { projectId: b.remote_id } });
    this.db.prepare('UPDATE shared_projects SET paused=0,identity=? WHERE project_id=?').run(JSON.stringify(identity), id);
    this.deepScanAt.delete(id);
    return this.sync(id);
  }
  async resolve(id, path, choice, expectedHeadRevisionId) {
    await this.pause(id);
    const operation = this.resolveVersion(id, path, choice, expectedHeadRevisionId).finally(() => this.running.delete(id));
    this.running.set(id, operation); await operation; return this.sync(id);
  }
  async previousContent(b, head) {
    let revision = head; const visited = new Set();
    while (revision.deleted) {
      if (!revision.baseRevisionId || visited.has(revision.baseRevisionId) || visited.size >= 64) throw new Error('未找到可恢复的文件内容，请联系项目成员确认历史版本。');
      visited.add(revision.baseRevisionId);
      const previous = (await this.call(b, 'turnsu_project_file', { pathParams: { revisionId: revision.baseRevisionId } })).data;
      if (previous.path !== head.path || previous.projectId !== b.remote_id || previous.revisionId !== revision.baseRevisionId) throw new Error('sync_integrity');
      revision = previous;
    }
    return { revision, bytes: await this.download(b, revision) };
  }
  async resolveVersion(id, path, choice, expectedHeadRevisionId) {
    if (this.isBusy(id)) throw new Error('请等待 Agent 完成本次执行后再处理版本。');
    if (!['local', 'team', 'restore', 'delete'].includes(choice)) throw new Error('请选择要保留的内容。');
    const b = this.binding(id), all = await this.remote(b), head = all.find(f => f.path === path && f.outcome === 'synced');
    if (!head) throw new Error('团队文件已变化，请刷新后重试。');
    if (expectedHeadRevisionId !== undefined && head.revisionId !== expectedHeadRevisionId) throw new Error('团队文件已变化，请刷新并核对新版本后再选择。');
    if (this.db.prepare('SELECT 1 FROM shared_outbox WHERE project_id=? AND path=?').get(id, path)) throw new Error('这个文件仍有待确认的提交，请先恢复同步。');
    const conflicts = all.filter(f => f.path === path && f.outcome === 'conflict').map(f => f.revisionId);
    if (conflicts.length > 16) throw new Error('这个文件有较多冲突，请先在团队中整理版本。');
    const local = await this.bytes(b, path);
    if (choice === 'restore') {
      if (local) throw new Error('本机文件已重新出现，未覆盖。');
      if (conflicts.length) throw new Error('请先查看并处理这个文件的不同版本，再恢复内容。');
      const restored = await this.previousContent(b, head);
      if (head.deleted) {
        this.enqueue(b, path, restored.bytes, head.revisionId); await this.flush(b);
        const current = this.file(id, path);
        if (current.conflict_id) throw new Error('团队文件已变化，恢复的内容已作为不同版本保留。请刷新后处理。');
        if (await this.bytes(b, path)) throw new Error('本机文件已重新出现，未覆盖。');
        await this.install(b, { ...restored.revision, revisionId: current.revision_id }, restored.bytes);
      } else await this.install(b, head, restored.bytes);
    } else {
      if (choice === 'delete' && local) throw new Error('本机文件已重新出现，请核对后再同步删除。');
      const deleted = choice === 'delete' || (choice === 'local' ? local === null : head.deleted);
      const bytes = deleted ? Buffer.alloc(0) : choice === 'local' ? local : await this.download(b, head);
      this.enqueue(b, path, bytes, head.revisionId, conflicts, deleted); await this.flush(b);
      const current = this.file(id, path);
      if (!current.conflict_id && choice === 'team') {
        if (deleted) await this.installDeletion(b, { ...head, revisionId: current.revision_id }, local ? hash(local) : null);
        else await this.install(b, { ...head, revisionId: current.revision_id, contentHash: current.content_hash }, bytes);
      }
    }
    this.db.prepare('UPDATE shared_projects SET paused=0 WHERE project_id=?').run(id);
  }
  async preview(id, path, revisionId) {
    const b = this.binding(id), files = await this.remote(b), revision = files.find(f => f.path === path && f.revisionId === revisionId);
    if (!revision) throw new Error('该版本已变化，请刷新后查看。');
    if (revision.deleted) return { text: '此版本记录了文件删除。此前内容仍保留在团队历史中，可以恢复。', deleted: true, truncated: false };
    const bytes = await this.download(b, revision); return { text: bytes.subarray(0, 100_000).toString('utf8'), truncated: bytes.length > 100_000 };
  }
  pollProjects() {
    if (this.closed) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const ids = this.db.prepare('SELECT project_id FROM shared_projects WHERE paused=0').all().map(row => row.project_id);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
        while (!this.closed && next < ids.length) {
          const id = ids[next++];
          try { await this.sync(id); } catch { /* The project keeps its own actionable sync state. */ }
        }
      }));
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  start() { if (this.timer) return; this.timer = setInterval(() => { this.pollProjects().catch(() => {}); }, 30000); this.timer.unref(); }
  async close() { clearInterval(this.timer); this.closed = true; await this.polling; await Promise.allSettled(this.running.values()); this.fingerprints.clear(); this.deepScanAt.clear(); }
}
