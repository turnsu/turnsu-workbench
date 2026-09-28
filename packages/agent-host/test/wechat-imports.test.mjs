import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { referencePaths } from '../file-references.mjs';

const id = '8E7B49D7-8081-41E4-B537-6FA7FB0EF703';
const batchId = '5C784AFB-0BED-4F4D-AFA2-760E3A1D76BB';
const itemId = '889B3298-42D6-449A-8FCC-3780EE47DF9D';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('explicit WeChat handoff import preserves verified local evidence and never starts an Agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-wechat-import-'));
  const bridge = join(root, 'bridge'), archive = join(bridge, 'Inbox/Ready', batchId);
  const itemPath = 'items/chat.txt', reply = '收到' + 'x'.repeat(700);
  const bytes = Buffer.from(`甲: 你好\n乙: ${reply}\n`);
  await mkdir(join(bridge, 'Handoffs'), { recursive: true });
  await mkdir(join(archive, 'items'), { recursive: true });
  await writeFile(join(archive, itemPath), bytes);
  const manifest = { schemaVersion: 1, handoffID: id, batchID: batchId, requestedAt: '2026-09-28T04:00:00Z', action: 'analyze', selection: 'all', storageMode: 'shared', chatName: '售后群', items: [{ id: itemId, relativePath: itemPath, byteCount: bytes.length, sha256: sha(bytes), displayName: '聊天记录.txt' }], records: [{ sourceItemID: itemId, sender: '甲', date: '2026-09-28T04:00:00Z', text: '你好' }, { sourceItemID: itemId, sender: '乙', date: '2026-09-28T04:01:00Z', text: reply }], unparsedItemIDs: [] };
  await writeFile(join(bridge, 'Handoffs', id + '.json'), JSON.stringify(manifest));
  await mkdir(join(root, 'one')); await mkdir(join(root, 'two'));
  const host = new LocalAgentHost({ directory: join(root, 'state'), wechatRoot: bridge, connectionFactory: () => { throw new Error('import must not start an Agent'); } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const one = await host.command('project.open', { path: join(root, 'one') });
  const two = await host.command('project.open', { path: join(root, 'two') });
  assert.deepEqual((await host.command('wechat.handoffs')).handoffs.map(item => item.id), [id]);
  const preview = await host.command('wechat.preview', { id });
  assert.equal(preview.recordCount, 2); assert.equal(preview.records[0].text, '你好');
  assert.equal(preview.records[1].text.length, 600); assert.equal(preview.records[1].truncated, true);
  assert.equal(preview.items[0].sha256, sha(bytes));
  const [imported, concurrent] = await Promise.all([
    host.command('wechat.import', { projectId: one.id, id }),
    host.command('wechat.import', { projectId: one.id, id })
  ]);
  assert.deepEqual(concurrent, imported);
  assert.equal(imported.recordCount, 2);
  const page = await host.command('wechat.records', { projectId: one.id, id });
  assert.equal(page.records[1].text.length, 600);
  assert.equal(page.items[0].sha256, sha(bytes));
  assert.deepEqual(await host.command('wechat.import', { projectId: one.id, id }), imported);
  await assert.rejects(host.command('wechat.import', { projectId: two.id, id }), /另一个项目/);
  // Simulate termination after the verified snapshot is renamed but before SQLite commits.
  host.db.prepare('DELETE FROM wechat_records WHERE import_id=?').run(id);
  host.db.prepare('DELETE FROM wechat_items WHERE import_id=?').run(id);
  host.db.prepare('DELETE FROM wechat_imports WHERE id=?').run(id);
  await rm(bridge, { recursive: true, force: true });
  assert.equal((await host.command('wechat.import', { projectId: one.id, id })).recordCount, 2);
  assert.deepEqual((await readdir(join(root, 'state', 'wechat-imports'))).filter(name => name.startsWith('.')), []);
  const selection = { kind: 'wechat-import', importId: id, offset: 0, count: 2 };
  assert.deepEqual(referencePaths([selection]), [selection]);
  const session = await host.command('session.create', { projectId: one.id, agent: 'codex' });
  const references = await host.references.prepare(host.session(session.id), 'input-1', '请整理问题', [selection]);
  assert.match(references[0].text, /甲: 你好/);
  assert(references[0].text.includes(reply));
  assert.equal((await host.command('wechat.records', { projectId: one.id, id })).records.length, 2);
  assert.equal((await host.references.prepare(host.session(session.id), 'input-1', '请整理问题', [selection]))[0].text, references[0].text);
});

test('tampered handoff is rejected before any import record is written', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-wechat-tamper-'));
  const bridge = join(root, 'bridge'), archive = join(bridge, 'Inbox/Ready', batchId);
  await mkdir(join(bridge, 'Handoffs'), { recursive: true }); await mkdir(join(archive, 'items'), { recursive: true });
  const raw = Buffer.from('original'); await writeFile(join(archive, 'items/chat.txt'), raw);
  const manifest = { schemaVersion: 1, handoffID: id, batchID: batchId, action: 'analyze', selection: 'all', storageMode: 'shared', items: [{ id: itemId, relativePath: 'items/chat.txt', byteCount: raw.length, sha256: sha(raw), displayName: 'chat.txt' }], records: [], unparsedItemIDs: [] };
  await writeFile(join(bridge, 'Handoffs', id + '.json'), JSON.stringify(manifest));
  await mkdir(join(root, 'project'));
  const host = new LocalAgentHost({ directory: join(root, 'state'), wechatRoot: bridge });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path: join(root, 'project') });
  await writeFile(join(archive, 'items/chat.txt'), 'tampered');
  await assert.rejects(host.command('wechat.import', { projectId: project.id, id }), /校验失败/);
  assert.equal((await host.command('wechat.imports', { projectId: project.id })).imports.length, 0);
  manifest.items[0].relativePath = '../../other.txt';
  await writeFile(join(bridge, 'Handoffs', id + '.json'), JSON.stringify(manifest));
  await assert.rejects(host.command('wechat.preview', { id }), /路径无效/);
});
