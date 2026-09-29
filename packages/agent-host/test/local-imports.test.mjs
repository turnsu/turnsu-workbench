import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

test('selected local files enter a project without overwriting the source or an earlier import', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-local-import-'));
  const projectPath = join(root, 'project'), sourcePath = join(root, 'source');
  await mkdir(projectPath); await mkdir(sourcePath);
  const source = join(sourcePath, 'report.txt');
  await writeFile(source, 'first version');
  const host = new LocalAgentHost({ directory: join(root, 'state') });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path: projectPath });
  const first = await host.command('files.import', { projectId: project.id, paths: [source] });
  assert.deepEqual(first.failed, []);
  assert.equal(first.imported[0].path, 'Imported/report.txt');
  await writeFile(source, 'second version');
  const second = await host.command('files.import', { projectId: project.id, paths: [source] });
  assert.equal(second.imported[0].path, 'Imported/report-2.txt');
  assert.equal(await readFile(join(projectPath, first.imported[0].path), 'utf8'), 'first version');
  assert.equal(await readFile(join(projectPath, second.imported[0].path), 'utf8'), 'second version');
  assert.equal(await readFile(source, 'utf8'), 'second version');
  assert.equal((await host.command('files.resolve', { projectId: project.id, path: second.imported[0].path })).path, join(project.path, second.imported[0].path));
  await assert.rejects(host.command('files.resolve', { projectId: project.id, path: '../source/report.txt' }), /当前项目/);
});

test('bad sources are reported per file and cannot import links or oversized files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-local-import-boundaries-'));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const good = join(root, 'good.txt'), linked = join(root, 'linked.txt');
  await writeFile(good, 'safe'); await symlink(good, linked);
  const tooLarge = join(root, 'too-large.txt');
  const largeFile = await open(tooLarge, 'w'); await largeFile.truncate(33 * 1024 * 1024); await largeFile.close();
  const host = new LocalAgentHost({ directory: join(root, 'state') });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path: projectPath });
  const result = await host.command('files.import', { projectId: project.id, paths: [linked, good, tooLarge, join(root, 'missing.txt')] });
  assert.equal(result.imported.length, 1);
  assert.equal(result.failed.length, 3);
  assert.match(result.failed[0].reason, /符号链接/);
  assert.match(result.failed[1].reason, /32 MiB/);
  assert.equal(await readFile(join(projectPath, 'Imported/good.txt'), 'utf8'), 'safe');
});

test('private import refuses a project already bound to team file sync', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-shared-import-boundary-'));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const source = join(root, 'private.txt'); await writeFile(source, 'private material');
  const host = new LocalAgentHost({ directory: join(root, 'state') });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path: projectPath });
  const info = await stat(projectPath);
  host.db.prepare('INSERT INTO shared_projects(project_id,remote_id,identity,title,device,inode) VALUES(?,?,?,?,?,?)').run(project.id, 'remote', 'member', 'Team project', info.dev, info.ino);
  await assert.rejects(host.command('files.import', { projectId: project.id, paths: [source] }), /团队共享项目/);
});
