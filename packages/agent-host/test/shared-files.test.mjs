import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStore } from '../store.mjs';
import { SharedFiles } from '../shared-files.mjs';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';
import { Check } from '../../contracts/dist/index.js';

const hash = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
function product() {
  const identity = { origin: 'https://team.example.test', workspaceId: 'team', clientSessionId: 'login' };
  const versions = new Map(), heads = new Map(), receipts = new Map(), resolved = new Set(); let fault = '', afterRead;
  const cloud = { identity: async () => ({ ...identity }), async fileCall(binding, name, args) {
    assert.equal(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, args), true, 'must use the real canonical tool input');
    if (JSON.stringify(binding) !== JSON.stringify(identity)) throw new Error('sync_connection_changed');
    if (fault === 'offline') throw new Error('offline');
    if (fault === 'revoked') throw Object.assign(new Error('denied'), { status: 404 });
    if (name === 'turnsu_project') return { data: { title: '团队验收', status: 'active' } };
    if (name === 'turnsu_project_files') return { data: [...heads.values(), ...[...versions.values()].filter(v => v.outcome === 'conflict' && !resolved.has(v.revisionId))].map(v => ({ ...v, headRevisionId: heads.get(v.path)?.revisionId })), page: {} };
    if (name === 'turnsu_project_file') { const v = versions.get(args.pathParams.revisionId); await afterRead?.(); return { data: v }; }
    if (name === 'turnsu_commit_project_file') {
      if (receipts.has(args.idempotencyKey)) return receipts.get(args.idempotencyKey);
      const d = args.data, h = heads.get(d.path), revision = { ...d, projectId: 'remote', revisionId: randomUUID(), contentHash: hash(Buffer.from(d.contentBase64, 'base64')), byteLength: Buffer.from(d.contentBase64, 'base64').length, outcome: (h?.revisionId || null) === d.baseRevisionId ? 'synced' : 'conflict', createdAt: new Date().toISOString() };
      versions.set(revision.revisionId, revision);
      if (revision.outcome === 'synced') { heads.set(d.path, revision); for (const id of d.resolvesRevisionIds || []) resolved.add(id); }
      const result = { data: { revision, headRevisionId: heads.get(d.path).revisionId } }; receipts.set(args.idempotencyKey, result);
      if (fault === 'uncertain') { fault = 'offline'; throw new Error('response lost'); }
      return result;
    }
    throw new Error('unexpected operation');
  } };
  return { cloud, versions, heads, identity, fail: value => { fault = value; }, afterRead: fn => { afterRead = fn; } };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-file-sync-')), remote = product(), clients = [];
  async function client(name, { scope, setup, attach = true } = {}) {
    const path = join(directory, name), data = join(directory, name + '-private'); await mkdir(path); await mkdir(data, { mode: 0o700 });
    await setup?.(path);
    let store = openStore(data); store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(name, path, name, 1);
    const options = () => ({ db: store.db, cloud: remote.cloud, project: () => ({ path }) });
    let sync = new SharedFiles(options()); if (attach) await sync.attach(name, 'remote', scope);
    const result = { path, id: name, get sync() { return sync; }, get db() { return store.db; }, async restart() { await sync.close(); store.close(); store = openStore(data); sync = new SharedFiles(options()); }, async close() { await sync.close(); store.close(); } };
    clients.push(result); return result;
  }
  t.after(async () => { for (const c of clients) await c.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, remote, client, a: await client('a'), b: await client('b') };
}
test('unchanged shared files are not reread every cycle, while edits and a forced sweep still reach the team', async t => {
  const { a, remote } = await fixture(t);
  const original = a.sync.bytes.bind(a.sync); let reads = 0;
  a.sync.bytes = async (...args) => { reads++; return original(...args); };
  await writeFile(join(a.path, 'result.md'), 'first');
  await a.sync.sync(a.id);
  const afterFirst = reads;
  assert.ok(afterFirst >= 1);
  await a.sync.sync(a.id);
  assert.equal(reads, afterFirst);
  await writeFile(join(a.path, 'result.md'), 'second version');
  await a.sync.sync(a.id);
  assert.ok(reads > afterFirst);
  assert.equal(Buffer.from(remote.heads.get('result.md').contentBase64, 'base64').toString(), 'second version');
  const afterEdit = reads;
  a.sync.deepScanAt.set(a.id, 0);
  await a.sync.sync(a.id);
  assert.ok(reads > afterEdit);
  assert.equal(remote.versions.size, 2);
});
test('automatic project polling bounds concurrent file syncs and does not start a duplicate sweep', async () => {
  const ids = ['one', 'two', 'three', 'four', 'five']; let active = 0, peak = 0;
  const sync = new SharedFiles({ db: { prepare: () => ({ all: () => ids.map(project_id => ({ project_id })) }) } });
  const visited = [];
  sync.sync = async id => {
    active++; peak = Math.max(peak, active); visited.push(id);
    await new Promise(resolve => setTimeout(resolve, 8)); active--;
  };
  await Promise.all([sync.pollProjects(), sync.pollProjects()]);
  assert.deepEqual(visited.sort(), ids.slice().sort());
  assert.ok(peak <= 2);
  await sync.close();
});
test('two real local folders converge, conflicting edits remain available, and choosing a version converges both', async t => {
  const { a, b, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), '初稿'); assert.equal((await a.sync.sync(a.id)).status, 'synced');
  assert.equal((await b.sync.sync(b.id)).status, 'synced'); assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), '初稿');
  await writeFile(join(a.path, 'result.md'), '甲修改'); await writeFile(join(b.path, 'result.md'), '乙修改');
  await a.sync.sync(a.id); assert.equal((await b.sync.sync(b.id)).status, 'conflict');
  assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), '乙修改');
  assert.equal(remote.versions.size, 3); await b.sync.sync(b.id); assert.equal(remote.versions.size, 3);
  await b.sync.resolve(b.id, 'result.md', 'local'); await a.sync.sync(a.id);
  assert.equal(await readFile(join(a.path, 'result.md'), 'utf8'), '乙修改');
  assert.equal(a.sync.snapshot(a.id).conflicts.length, 0);
  const backups = await readdir(join(a.path, '.turnsu-local')); assert.equal(backups.length, 1);
  assert.equal(await readFile(join(a.path, '.turnsu-local', backups[0]), 'utf8'), '甲修改');
});
test('unknown HTTP commit survives restart with its exact receipt and does not publish twice', async t => {
  const { a, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), '持久化内容'); remote.fail('uncertain');
  assert.equal((await a.sync.sync(a.id)).status, 'offline'); assert.equal(a.sync.snapshot(a.id).pending, 1);
  await a.restart(); remote.fail(''); assert.equal((await a.sync.sync(a.id)).status, 'synced'); assert.equal(remote.versions.size, 1);
});
test('private files and links never leave the managed folder, and a replaced root or revoked login stops delivery', async t => {
  const { a, remote, directory } = await fixture(t);
  await writeFile(join(a.path, '.env'), 'secret'); await writeFile(join(directory, 'outside.txt'), 'private'); await symlink(join(directory, 'outside.txt'), join(a.path, 'link.txt'));
  assert.equal((await a.sync.sync(a.id)).status, 'attention'); assert.equal(remote.versions.size, 0);
  remote.fail('revoked'); await writeFile(join(a.path, 'new.md'), 'local'); assert.equal((await a.sync.sync(a.id)).status, 'access'); assert.equal(remote.versions.size, 0);
  remote.fail(''); remote.identity.clientSessionId = 'other-account'; assert.equal((await a.sync.sync(a.id)).status, 'access'); assert.equal(remote.versions.size, 0);
  remote.identity.clientSessionId = 'login'; await rename(a.path, a.path + '-moved'); await mkdir(a.path); await writeFile(join(a.path, 'oops.md'), 'not declared');
  assert.equal((await a.sync.sync(a.id)).status, 'offline'); assert.equal(remote.versions.size, 0);
});
test('a local edit arriving during download is preserved and becomes a conflict on retry', async t => {
  const { a, b, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'initial'); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await writeFile(join(a.path, 'result.md'), 'team'); await a.sync.sync(a.id);
  remote.afterRead(async () => { await writeFile(join(b.path, 'result.md'), 'late local edit'); remote.afterRead(null); });
  assert.equal((await b.sync.sync(b.id)).status, 'pending'); assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), 'late local edit');
  assert.equal((await b.sync.sync(b.id)).status, 'conflict');
});
test('local deletion converges without destroying history and can be restored by a teammate', async t => {
  const { a, b, remote } = await fixture(t);
  await mkdir(join(a.path, 'results')); await writeFile(join(a.path, 'results/file.md'), 'result'); await a.sync.sync(a.id);
  const original = remote.heads.get('results/file.md');
  b.sync.isBusy = () => true; assert.equal((await b.sync.sync(b.id)).status, 'working'); assert.equal((await readdir(b.path)).length, 0);
  b.sync.isBusy = () => false; await b.sync.sync(b.id); await rm(join(b.path, 'results'), { recursive: true });
  assert.equal((await b.sync.sync(b.id)).status, 'synced');
  assert.equal(remote.heads.get('results/file.md').deleted, true);
  await a.sync.sync(a.id); await assert.rejects(readFile(join(a.path, 'results/file.md')), { code: 'ENOENT' });
  assert.equal(Buffer.from(remote.versions.get(original.revisionId).contentBase64, 'base64').toString(), 'result');
  const backups = await readdir(join(a.path, '.turnsu-local'));
  assert.ok((await Promise.all(backups.map(path => readFile(join(a.path, '.turnsu-local', path), 'utf8')))).includes('result'));
  await b.sync.resolve(b.id, 'results/file.md', 'restore'); await a.sync.sync(a.id);
  assert.equal(await readFile(join(b.path, 'results/file.md'), 'utf8'), 'result');
  assert.equal(await readFile(join(a.path, 'results/file.md'), 'utf8'), 'result');
});

test('offline edits enter the durable outbox before reconnecting', async t => {
  const { a, remote } = await fixture(t);
  remote.fail('offline'); await writeFile(join(a.path, 'offline.md'), '断网保存');
  assert.equal((await a.sync.sync(a.id)).pending, 1); await a.restart(); remote.fail('');
  assert.equal((await a.sync.sync(a.id)).status, 'synced'); assert.equal(Buffer.from(remote.heads.get('offline.md').contentBase64, 'base64').toString(), '断网保存');
});

test('interrupted download staging recovers after reopening and retains the replaced file', async t => {
  const { a, b, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'old'); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await writeFile(join(a.path, 'result.md'), 'new'); await a.sync.sync(a.id);
  const revision = remote.heads.get('result.md'), job = { revision, data: revision.contentBase64, stage: randomUUID(), backup: randomUUID() + '--result.md' };
  b.db.prepare('INSERT INTO shared_incoming VALUES(?,?,?)').run(b.id, 'result.md', JSON.stringify(job));
  await writeFile(join(b.path, '.turnsu-local', job.stage), 'partial'); await b.restart();
  assert.equal((await b.sync.sync(b.id)).status, 'synced'); assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), 'new');
  assert.equal(await readFile(join(b.path, '.turnsu-local', job.backup), 'utf8'), 'old');
});


test('delete versus edit conflicts retain both choices, including a deleted local copy', async t => {
  const { a, b, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'original'); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await rm(join(a.path, 'result.md')); await a.sync.sync(a.id);
  await writeFile(join(b.path, 'result.md'), 'concurrent edit');
  assert.equal((await b.sync.sync(b.id)).status, 'conflict');
  assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), 'concurrent edit');
  assert.equal(remote.heads.get('result.md').deleted, true);
  await b.sync.resolve(b.id, 'result.md', 'local'); await a.sync.sync(a.id);
  assert.equal(await readFile(join(a.path, 'result.md'), 'utf8'), 'concurrent edit');
  await writeFile(join(b.path, 'result.md'), 'newer team edit'); await b.sync.sync(b.id);
  await rm(join(a.path, 'result.md')); assert.equal((await a.sync.sync(a.id)).status, 'conflict');
  assert.ok(a.sync.snapshot(a.id).conflicts.some(item => item.deleted));
  await a.sync.resolve(a.id, 'result.md', 'team'); await b.sync.sync(b.id);
  assert.equal(await readFile(join(a.path, 'result.md'), 'utf8'), 'newer team edit');
});

test('offline and uncertain deletion survives reopening without becoming an empty file or a duplicate version', async t => {
  const { a, b, remote } = await fixture(t);
  await writeFile(join(a.path, 'empty.txt'), ''); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await rm(join(a.path, 'empty.txt')); remote.fail('offline');
  assert.equal((await a.sync.sync(a.id)).pending, 1); await a.restart(); remote.fail('uncertain');
  assert.equal((await a.sync.sync(a.id)).pending, 1); const count = remote.versions.size;
  await a.restart(); remote.fail(''); await a.sync.sync(a.id); await b.sync.sync(b.id);
  assert.equal(remote.versions.size, count); assert.equal(remote.heads.get('empty.txt').deleted, true);
  await assert.rejects(readFile(join(b.path, 'empty.txt')), { code: 'ENOENT' });
  await writeFile(join(b.path, 'empty.txt'), ''); await b.sync.sync(b.id); await a.sync.sync(a.id);
  assert.notEqual(remote.heads.get('empty.txt').deleted, true); assert.equal((await readFile(join(a.path, 'empty.txt'))).length, 0);
});

test('a deletion interrupted after preserving the file resumes from its durable intent', async t => {
  const { a, b, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'preserved'); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await rm(join(a.path, 'result.md')); await a.sync.sync(a.id);
  const revision = remote.heads.get('result.md'), job = { revision, expectedHash: hash(Buffer.from('preserved')), backup: randomUUID() + '--result.md' };
  b.db.prepare('INSERT INTO shared_incoming VALUES(?,?,?)').run(b.id, 'result.md', JSON.stringify(job));
  await rename(join(b.path, 'result.md'), join(b.path, '.turnsu-local', job.backup)); await b.restart();
  assert.equal((await b.sync.sync(b.id)).status, 'synced');
  assert.equal(await readFile(join(b.path, '.turnsu-local', job.backup), 'utf8'), 'preserved');
  await assert.rejects(readFile(join(b.path, 'result.md')), { code: 'ENOENT' });
});

test('pre-upgrade missing files do not unexpectedly delete the team copy', async t => {
  const { a, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'old team content'); await a.sync.sync(a.id);
  a.db.prepare('UPDATE shared_files SET delete_ready=0 WHERE project_id=?').run(a.id);
  await rm(join(a.path, 'result.md')); await a.restart();
  const status = await a.sync.sync(a.id);
  assert.equal(status.status, 'attention'); assert.equal(status.issues[0].canDelete, true);
  assert.notEqual(remote.heads.get('result.md').deleted, true);
  await a.sync.resolve(a.id, 'result.md', 'delete'); assert.equal(remote.heads.get('result.md').deleted, true);
});

test('a local edit after deletion was prepared survives and conflicts on recovery', async t => {
  const { a, b } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'old'); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await rm(join(a.path, 'result.md')); await a.sync.sync(a.id);
  const apply = b.sync.applyDeletion.bind(b.sync); let first = true;
  b.sync.applyDeletion = async (...args) => { if (first) { first = false; await writeFile(join(b.path, 'result.md'), 'late edit'); } return apply(...args); };
  await b.sync.sync(b.id); assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), 'late edit');
  await b.restart(); assert.equal((await b.sync.sync(b.id)).status, 'conflict');
  assert.equal(await readFile(join(b.path, 'result.md'), 'utf8'), 'late edit');
});

test('choosing deletion after a conflict converges on the other device while preserving its edit', async t => {
  const { a, b } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'original'); await a.sync.sync(a.id); await b.sync.sync(b.id);
  await rm(join(a.path, 'result.md')); await a.sync.sync(a.id);
  await writeFile(join(b.path, 'result.md'), 'conflicting edit'); await b.sync.sync(b.id); await a.sync.sync(a.id);
  await a.sync.resolve(a.id, 'result.md', 'local');
  assert.equal((await b.sync.sync(b.id)).status, 'synced');
  await assert.rejects(readFile(join(b.path, 'result.md')), { code: 'ENOENT' });
  const copies = await readdir(join(b.path, '.turnsu-local'));
  assert.ok((await Promise.all(copies.map(name => readFile(join(b.path, '.turnsu-local', name), 'utf8')))).includes('conflicting edit'));
});

test('replaying a pre-upgrade upload cannot silently authorize propagation of an older local removal', async t => {
  const { a, remote } = await fixture(t);
  await writeFile(join(a.path, 'result.md'), 'original'); await a.sync.sync(a.id);
  remote.fail('offline'); await writeFile(join(a.path, 'result.md'), 'old pending upload'); await a.sync.sync(a.id);
  a.db.prepare('UPDATE shared_files SET delete_ready=0 WHERE project_id=?').run(a.id);
  a.db.prepare('UPDATE shared_outbox SET delete_ready=0 WHERE project_id=?').run(a.id);
  await rm(join(a.path, 'result.md')); await a.restart(); remote.fail('');
  const state = await a.sync.sync(a.id);
  assert.equal(state.status, 'attention'); assert.ok(state.issues.some(item => item.canDelete));
  assert.notEqual(remote.heads.get('result.md').deleted, true);
  assert.equal(Buffer.from(remote.heads.get('result.md').contentBase64, 'base64').toString(), 'old pending upload');
});

test('an existing project shares only chosen paths, preserves initial conflicts and keeps its scope after restart', async t => {
  const { a, b, client, remote } = await fixture(t);
  await mkdir(join(a.path, 'results')); await mkdir(join(a.path, 'private'));
  await writeFile(join(a.path, 'results/report.md'), 'team report');
  await writeFile(join(a.path, 'private/notes.md'), 'team file outside selected scope');
  await a.sync.sync(a.id);
  const scope = [{ path: 'results', kind: 'directory' }];
  const c = await client('existing', { scope, setup: async path => {
    await mkdir(join(path, 'results')); await mkdir(join(path, 'private'));
    await writeFile(join(path, 'results/report.md'), 'existing local report');
    await writeFile(join(path, 'private/notes.md'), 'private notes never shared');
    await writeFile(join(path, 'personal.md'), 'private root file');
  } });
  assert.deepEqual(c.sync.snapshot(c.id).scope, scope);
  const status = await c.sync.sync(c.id); assert.equal(status.status, 'conflict');
  assert.equal(await readFile(join(c.path, 'results/report.md'), 'utf8'), 'existing local report');
  assert.equal(await readFile(join(c.path, 'private/notes.md'), 'utf8'), 'private notes never shared');
  assert.ok(![...remote.versions.values()].some(v => Buffer.from(v.contentBase64, 'base64').toString().includes('private')));
  await c.sync.resolve(c.id, 'results/report.md', 'local'); await b.sync.sync(b.id);
  assert.equal(await readFile(join(b.path, 'results/report.md'), 'utf8'), 'existing local report');
  await c.restart(); remote.fail('offline');
  await writeFile(join(c.path, 'results/next.md'), 'new shared output'); await writeFile(join(c.path, 'private/new.md'), 'still private');
  await c.sync.sync(c.id); assert.equal(c.sync.snapshot(c.id).pending, 1);
  await c.restart(); remote.fail(''); await c.sync.sync(c.id); await b.sync.sync(b.id);
  assert.equal(await readFile(join(b.path, 'results/next.md'), 'utf8'), 'new shared output');
  assert.equal(remote.heads.has('private/new.md'), false); assert.equal(remote.heads.has('personal.md'), false);
  await assert.rejects(c.sync.bytes(c.sync.binding(c.id), 'private/notes.md'), /共享范围/);
});

test('selecting one nested file does not share its siblings and rejects hidden paths or symlink scopes', async t => {
  const { client, remote, directory } = await fixture(t);
  const c = await client('file-scope', { attach: false, setup: async path => {
    await mkdir(join(path, 'docs')); await writeFile(join(path, 'docs/result.md'), 'selected');
    await writeFile(join(path, 'docs/private.md'), 'private'); await writeFile(join(path, '.env'), 'secret');
    await symlink(directory, join(path, 'outside'));
  } });
  for (const scope of [[], [{ path: '.env', kind: 'file' }], [{ path: 'outside', kind: 'directory' }], [{ path: 'docs/result.md', kind: 'directory' }]]) {
    await assert.rejects(c.sync.attach(c.id, 'remote', scope)); assert.equal(c.sync.snapshot(c.id), null);
  }
  await c.sync.attach(c.id, 'remote', [{ path: 'docs/result.md', kind: 'file' }]);
  await c.sync.sync(c.id); assert.deepEqual([...remote.heads.keys()], ['docs/result.md']);
  assert.throws(() => c.sync.enqueue(c.sync.binding(c.id), 'docs/private.md', Buffer.from('private'), null), /共享范围/);
  await rm(join(c.path, 'docs/result.md')); await c.sync.sync(c.id); assert.equal(remote.heads.get('docs/result.md').deleted, true);
  assert.equal(remote.heads.has('docs/private.md'), false);
});
