import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 10;

function displayName(path) {
  const name = basename(path);
  if (!name || name.startsWith('.') || name.length > 200) throw new Error('文件名不可用于项目导入。');
  return name;
}

async function destination(directory, name) {
  for (let index = 1; index <= 100; index++) {
    const candidate = index === 1 ? name : `${name.replace(/(\.[^.]+)?$/, '')}-${index}${name.match(/\.[^.]+$/)?.[0] || ''}`;
    const path = join(directory, candidate);
    try { return { path, file: await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名文件过多，请先整理项目中的 Imported 文件夹。');
}

export async function importProjectFiles(host, projectId, selected) {
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > MAX_FILES || selected.some(path => typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))) throw new Error('每次请选择 1–10 个本机文件。');
  if (host.db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(projectId)) throw new Error('这是团队共享项目。请先在团队文件中核对共享范围，或打开本地项目再导入私有资料。');
  const root = await realpath(host.project(projectId).path);
  const directory = join(root, 'Imported');
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('项目中的 Imported 路径不是普通文件夹，无法安全导入。');
  const imported = [], failed = [];
  let total = 0;
  for (const path of selected) {
    let source, target;
    try {
      const name = displayName(path);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('不能导入符号链接。');
      source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await source.stat();
      if (!before.isFile() || before.size > MAX_FILE || total + before.size > MAX_TOTAL) throw new Error('单文件最多 32 MiB，本次合计最多 128 MiB。');
      if (await realpath(directory) !== directory) throw new Error('导入目录已变化，请重试。');
      target = await destination(directory, name);
      const buffer = Buffer.alloc(1024 * 1024);
      let copied = 0;
      while (copied < before.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - copied), copied);
        if (!bytesRead) throw new Error('源文件在导入时发生变化。');
        let written = 0;
        while (written < bytesRead) written += (await target.file.write(buffer, written, bytesRead - written)).bytesWritten;
        copied += bytesRead;
      }
      const after = await source.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('源文件在导入时发生变化。');
      await target.file.sync(); await target.file.close(); target.file = null;
      total += copied;
      imported.push({ path: `Imported/${basename(target.path)}`, byteLength: copied });
      host.notify({ type: 'project-files-changed', projectId });
    } catch (error) {
      if (target) { await target.file?.close().catch(() => {}); await unlink(target.path).catch(() => {}); }
      failed.push({ name: basename(path), reason: error.message || '导入失败。' });
    } finally { await source?.close().catch(() => {}); }
  }
  return { imported, failed };
}
