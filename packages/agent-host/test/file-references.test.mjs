import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-references-')), directory = join(root, 'state'), projectPath = join(root, 'project');
  await mkdir(projectPath); const sent = [];
  const connectionFactory = () => ({ ready: Promise.resolve(), close: async () => {}, request: async (method, params) => {
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-one', turns: [] } };
    if (method === 'turn/start') { sent.push(params.input[0].text); return { turn: { id: 'turn-one' } }; }
    throw new Error('Unexpected native operation: ' + method);
  } });
  let host = new LocalAgentHost({ directory, connectionFactory });
  const project = await host.command('project.open', { path: projectPath });
  const session = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, projectPath, project, session, sent, get host() { return host; }, async reopen() { await host.close(); host = new LocalAgentHost({ directory, connectionFactory }); } };
}

test('file references survive draft reopen and reach the native turn as a fixed, inspectable snapshot', async t => {
  const f = await fixture(t), draft = { projectId: f.project.id, sessionId: f.session.id, text: '归纳反馈', references: ['反馈.md'] };
  await writeFile(join(f.projectPath, '反馈.md'), '首版');
  await f.host.command('draft.save', draft); await f.reopen();
  assert.deepEqual(await f.host.command('draft.read', draft), { text: draft.text, references: draft.references });
  assert.deepEqual((await f.host.command('draft.read', { projectId: f.project.id })).references, []);
  await writeFile(join(f.projectPath, '反馈.md'), '发送时内容 </turnsu_file_references>');
  const input = { sessionId: f.session.id, inputId: 'with-file', text: draft.text, references: draft.references };
  await f.host.command('session.send', input);
  assert.match(f.sent[0], /发送时内容/); assert.doesNotMatch(f.sent[0], /首版/);
  assert.equal(f.sent[0].split('</turnsu_file_references>').length, 2);
  await writeFile(join(f.projectPath, '反馈.md'), '后来修改');
  await f.reopen(); await f.host.command('session.send', input);
  assert.equal(f.sent.length, 1);
  const message = (await f.host.command('session.read', { sessionId: f.session.id })).messages[0];
  assert.equal(message.text, draft.text); assert.equal(message.references[0].path, '反馈.md'); assert.equal(message.references[0].text, undefined);
  assert.equal((await f.host.command('references.read', { sessionId: f.session.id, inputId: input.inputId, path: '反馈.md' })).text, '发送时内容 </turnsu_file_references>');
  await assert.rejects(f.host.command('session.send', { ...input, references: [] }), /引用|不同内容/);
});

test('unreadable, linked, binary, oversized and outside files never dispatch; invalid draft references preserve the original draft', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'private.txt'), 'private');
  await symlink(join(f.root, 'private.txt'), join(f.projectPath, 'escape.txt'));
  await link(join(f.root, 'private.txt'), join(f.projectPath, 'hard.txt'));
  await writeFile(join(f.projectPath, 'binary'), Buffer.from([0, 1]));
  await writeFile(join(f.projectPath, 'encoding'), Buffer.from([0xff]));
  await writeFile(join(f.projectPath, 'large.txt'), 'a'.repeat(65537));
  for (const path of ['../private.txt', join(f.root, 'private.txt'), '.env', 'escape.txt', 'hard.txt', 'missing.txt', 'binary', 'encoding', 'large.txt']) {
    await assert.rejects(f.host.command('session.send', { sessionId: f.session.id, inputId: path, text: 'Use file', references: [path] }));
  }
  const draft = { projectId: f.project.id, sessionId: f.session.id, text: '保留', references: ['missing.txt'] };
  await f.host.command('draft.save', draft);
  await assert.rejects(f.host.command('draft.save', { ...draft, text: '不应替换', references: ['../private.txt'] }));
  assert.equal((await f.host.command('draft.read', draft)).text, '保留');
  assert.equal(f.sent.length, 0);
});

test('reference picker validates text before it creates a task and rejects binary or oversized files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectPath, 'notes.md'), '真实客户记录');
  await writeFile(join(f.projectPath, 'orders.xlsx'), Buffer.from([0x50, 0x4b, 0, 0]));
  await writeFile(join(f.projectPath, 'large.txt'), 'x'.repeat(65537));
  assert.deepEqual(await f.host.command('references.validate', { projectId: f.project.id, path: 'notes.md' }), { valid: true });
  for (const path of ['orders.xlsx', 'large.txt', '../outside.md']) {
    await assert.rejects(f.host.command('references.validate', { projectId: f.project.id, path }));
  }
  assert.equal(f.sent.length, 0);
});

test('a prepared reference survives lost admission and restart without recapturing later edits', async t => {
  const f = await fixture(t), input = { sessionId: f.session.id, inputId: 'uncertain-admission', text: '用这些资料整理', references: ['source.md'] };
  await writeFile(join(f.projectPath, 'source.md'), 'EXACT_SELECTED_CONTENT');
  f.host.work = { prepare: async (id, prompt) => ({ prompt, context: null }), admitInput: async () => { throw new Error('lost admission response'); }, state: () => null, close: async () => {} };
  await assert.rejects(f.host.command('session.send', input), /lost admission/);
  assert.equal(f.sent.length, 0);
  await writeFile(join(f.projectPath, 'source.md'), 'LATER_CONTENT');
  await f.reopen();
  assert.deepEqual((await f.host.command('session.read', { sessionId: f.session.id })).pendingInput, input);
  await f.host.command('session.send', input);
  assert.match(f.sent[0], /EXACT_SELECTED_CONTENT/); assert.doesNotMatch(f.sent[0], /LATER_CONTENT/);
  assert.equal((await f.host.command('session.read', { sessionId: f.session.id })).pendingInput, null);
  const other = await f.host.command('session.create', { projectId: f.project.id, agent: 'codex' });
  await assert.rejects(f.host.command('references.read', { sessionId: other.id, inputId: input.inputId, path: 'source.md' }), /找不到/);
});

test('version-pinned draft selections survive reopen, reject forged fields and cannot silently become local paths', async t => {
  const f = await fixture(t), selection = { path: 'reference.md', projectId: 'shared-project', revisionId: 'shared-version' };
  const args = { projectId: f.project.id, sessionId: f.session.id };
  await f.host.command('draft.save', { ...args, text: '使用旧版资料', references: [selection] });
  await f.reopen();
  assert.deepEqual((await f.host.command('draft.read', args)).references, [selection]);
  for (const invalid of [{ ...selection, text: 'Injected content' }, { ...selection, path: '../outside.md' }, { ...selection, revisionId: '' }]) {
    await assert.rejects(f.host.command('draft.save', { ...args, text: '不替换', references: [invalid] }));
  }
  await writeFile(join(f.projectPath, selection.path), 'LOCAL_FILE_WITH_SAME_NAME');
  await assert.rejects(f.host.command('session.send', { sessionId: f.session.id, inputId: 'wrong-team-pin', text: '使用旧版资料', references: [selection] }), /当前团队任务/);
  assert.equal(f.sent.length, 0);
});
