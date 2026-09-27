import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalAgentHost } from '../host.mjs';
import { Check } from '../../../../backend/code/workbench-contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-desktop-method-')), projectPath = join(root, 'project'); await mkdir(projectPath);
  const instructions = '---\nname: feedback\ndescription: Summarize team feedback\n---\nRead references/format.md before producing the result.\n';
  const bytes = Buffer.from(JSON.stringify({ format: 'workbench-skill-package-v1', files: [
    { path: 'SKILL.md', content: Buffer.from(instructions).toString('base64') },
    { path: 'references/format.md', content: Buffer.from('Preserve quotes and mark unknown facts.').toString('base64') },
  ] }));
  const bundle = { releaseId: 'release-one', versionId: 'version-one', version: '1.0.0', skillName: 'feedback', packageContentBase64: bytes.toString('base64'),
    packageObjectHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), packageHash: 'sha256:fixture', contentHash: 'sha256:definition', compatibility: null };
  const requests = [], identity = { origin: 'https://team.example.test', workspaceId: 'workspace-one', clientSessionId: 'native-one' };
  let denied = false, host;
  const connectionFactory = () => ({ ready: Promise.resolve(), closed: false, close: async () => {}, request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread', turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'native-turn' } };
    throw new Error(method);
  } });
  const cloud = () => ({ identity: async () => identity, close: async () => {}, fileCall: async (expected, name, input) => {
    assert.deepEqual(expected, identity); assert.equal(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, input), true);
    if (denied) throw Object.assign(new Error('forbidden'), { status: 403 });
    if (name === 'turnsu_methods') return { data: [{ releaseId: 'release-one', assetKind: 'skill', skillSummary: { name: '团队反馈' } }, { assetKind: 'loop' }], page: { hasMore: false } };
    if (name === 'turnsu_skill_package') return { data: bundle };
    throw new Error(name);
  } });
  function open() { host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory }); host.cloud = cloud(); }
  open(); const project = await host.command('project.open', { path: projectPath });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, project, bundle, requests, instructions, deny() { denied = true; },
    args: { projectId: project.id, agent: 'codex', releaseId: bundle.releaseId, requestId: 'user-choice-one' },
    async reopen() { await host.close(); open(); } };
}

test('choosing a published skill installs exact project files, opens one durable task, and does not run a model', async t => {
  const f = await fixture(t);
  assert.equal((await f.host.command('methods.list')).items.length, 1);
  const task = await f.host.command('methods.use', f.args);
  assert.equal(task.method.version, '1.0.0'); assert.equal(task.messages.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(await readFile(join(task.method.directory, 'SKILL.md'), 'utf8'), f.instructions);
  assert.equal(await readFile(join(task.method.directory, 'references/format.md'), 'utf8'), 'Preserve quotes and mark unknown facts.');
  await f.reopen();
  assert.equal((await f.host.command('methods.use', f.args)).id, task.id);
  await assert.rejects(f.host.command('methods.use', { ...f.args, agent: 'claude' }), /同一请求/);
  await f.host.command('session.send', { sessionId: task.id, inputId: 'user-input', text: '整理这周反馈' });
  const prompt = f.requests.find(r => r.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /整理这周反馈/); assert.ok(prompt.includes(join(task.method.directory, 'SKILL.md'))); assert.match(prompt, /1\.0\.0/);
  assert.equal((await f.host.command('session.read', { sessionId: task.id })).messages[0].text, '整理这周反馈');
});

test('local skill edits are preserved and prevent silently executing a changed pinned method', async t => {
  const f = await fixture(t), task = await f.host.command('methods.use', f.args);
  await writeFile(join(task.method.directory, 'SKILL.md'), 'my local edits');
  await assert.rejects(f.host.command('methods.use', { ...f.args, requestId: 'new-choice' }), /已保留原文件/);
  const input = { sessionId: task.id, inputId: 'input', text: 'Use it' };
  await assert.rejects(f.host.command('session.send', input), /技能文件已改变/);
  await assert.rejects(f.host.command('session.send', input), /技能文件已改变/);
  assert.equal(f.requests.length, 0); assert.equal(await readFile(join(task.method.directory, 'SKILL.md'), 'utf8'), 'my local edits');
});

test('revoked cloud access prevents new installation or replay from opening another task', async t => {
  const f = await fixture(t), task = await f.host.command('methods.use', f.args); f.deny();
  await assert.rejects(f.host.command('methods.use', f.args), /访问权限/);
  assert.equal((await f.host.command('workspace.read')).sessions.length, 1);
  assert.equal((await f.host.command('session.read', { sessionId: task.id })).method.releaseId, f.bundle.releaseId);
  f.host.cloud.identity = async () => { throw new Error('offline'); };
  await f.host.command('session.send', { sessionId: task.id, inputId: 'offline-local-use', text: 'Use the already installed local method' });
  assert.ok(f.requests.some(r => r.method === 'turn/start'), 'already downloaded private local work does not depend on cloud availability');
});

test('choosing a skill from the composer preserves the exact draft and references across reopen without copying private history', async t => {
  const f = await fixture(t), projectId = f.project.id;
  const source = await f.host.command('session.create', { projectId, agent: 'codex' });
  f.host.db.prepare('UPDATE sessions SET model=? WHERE id=?').run('chosen-model', source.id);
  await writeFile(join(f.project.path, 'feedback.md'), 'This week: export is slow.');
  f.host.message(source.id, 'private-history', 'assistant', 'Private previous discussion');
  const sourceDraft = { sessionId: source.id, text: '整理这份反馈', references: ['feedback.md'] };
  await f.host.command('draft.save', { projectId, ...sourceDraft });
  const args = { ...f.args, sourceDraft }, task = await f.host.command('methods.use', args);
  assert.deepEqual(await f.host.command('draft.read', { projectId, sessionId: task.id }), { text: sourceDraft.text, references: sourceDraft.references });
  assert.equal(task.messages.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(task.model, 'chosen-model');
  await f.reopen();
  assert.equal((await f.host.command('methods.use', args)).id, task.id);
  assert.deepEqual(await f.host.command('draft.read', { projectId, sessionId: source.id }), { text: sourceDraft.text, references: sourceDraft.references });
  await f.host.command('session.send', { sessionId: task.id, inputId: 'composer-method-input', text: sourceDraft.text, references: sourceDraft.references });
  const prompt = f.requests.find(r => r.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /This week: export is slow/); assert.match(prompt, /SKILL.md/); assert.doesNotMatch(prompt, /Private previous discussion/);
});

test('a stale composer selection cannot install a method or erase a newer local draft', async t => {
  const f = await fixture(t), sourceDraft = { text: '旧输入', references: [] };
  await f.host.command('draft.save', { projectId: f.project.id, text: '新输入', references: [] });
  await assert.rejects(f.host.command('methods.use', { ...f.args, sourceDraft }), /草稿已变化/);
  assert.equal(f.host.snapshot().sessions.length, 0);
  await assert.rejects(readFile(join(f.project.path, '.agents/skills/feedback/SKILL.md')), { code: 'ENOENT' });
});

test('composer method preparation cannot promote private text to team work or copy a different project draft', async t => {
  const f = await fixture(t), source = await f.host.command('session.create', { projectId: f.project.id, agent: 'codex' });
  const sourceDraft = { sessionId: source.id, text: '私人计划', references: [] };
  await f.host.command('draft.save', { projectId: f.project.id, ...sourceDraft });
  await assert.rejects(f.host.command('methods.use', { ...f.args, workItemId: 'team-work', sourceDraft }), /共享范围/);
  const otherPath = join(f.project.path, 'other'); await mkdir(otherPath);
  const other = await f.host.command('project.open', { path: otherPath });
  await assert.rejects(f.host.command('methods.use', { ...f.args, projectId: other.id, sourceDraft }), /不属于当前项目/);
  assert.equal(f.host.snapshot().sessions.length, 1); assert.equal(f.requests.length, 0);
});

test('an edit during package download survives and prevents opening a task with stale draft text', async t => {
  const f = await fixture(t), projectId = f.project.id, sourceDraft = { text: '下载前输入', references: [] };
  await f.host.command('draft.save', { projectId, ...sourceDraft });
  const original = f.host.cloud.fileCall;
  f.host.cloud.fileCall = async (...args) => {
    const result = await original(...args);
    await f.host.command('draft.save', { projectId, text: '下载时新输入', references: [] });
    return result;
  };
  await assert.rejects(f.host.command('methods.use', { ...f.args, sourceDraft }), /草稿已变化/);
  assert.equal(f.host.snapshot().sessions.length, 0);
  assert.equal((await f.host.command('draft.read', { projectId })).text, '下载时新输入');
});

test('switching team accounts cannot reuse the original member draft through method selection', async t => {
  const f = await fixture(t), source = await f.host.command('session.create', { projectId: f.project.id, agent: 'codex' });
  const sourceDraft = { sessionId: source.id, text: '原成员尚未提交的输入', references: [] };
  await f.host.command('draft.save', { projectId: f.project.id, ...sourceDraft });
  const identity = await f.host.cloud.identity();
  f.host.db.prepare('INSERT INTO shared_work_sessions(session_id,work_item_id,identity,context,actor_user_id) VALUES(?,?,?,?,?)').run(source.id, 'team-work', JSON.stringify(identity), '{}', 'original-member');
  f.host.teamWork = () => ({ context: async () => ({ viewerUserId: 'different-member', workItem: { title: '团队工作', members: [{ userId: 'different-member', accessGrant: { status: 'active', access: 'contribute' } }] } }) });
  await assert.rejects(f.host.command('methods.use', { ...f.args, workItemId: 'team-work', sourceDraft }), /原账户/);
  assert.equal(f.host.snapshot().sessions.length, 1); assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(join(f.project.path, '.agents/skills/feedback/SKILL.md')), { code: 'ENOENT' });
});
