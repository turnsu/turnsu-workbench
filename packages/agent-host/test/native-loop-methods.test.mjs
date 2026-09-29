import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalAgentHost } from '../host.mjs';
import { canonicalRequestHash } from '../../../services/product-api/src/store/serialization.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-native-loop-method-')), path = join(root, 'project'); await mkdir(path);
  const content = '---\nname: feedback\ndescription: Preserve feedback evidence\n---\nKeep original quotes.';
  const bytes = Buffer.from(JSON.stringify({ format: 'workbench-skill-package-v1', files: [{ path: 'SKILL.md', content: Buffer.from(content).toString('base64') }] }));
  const bundle = { releaseId: 'skill-release', versionId: 'skill-version', version: '1.0.0', skillName: 'feedback', packageContentBase64: bytes.toString('base64'), packageObjectHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), packageHash: 'sha256:fixture', contentHash: 'sha256:definition', compatibility: null };
  const pkg = { releaseId: 'loop-release', version: '1.0.0', executionMode: 'native_agent', executionSemantics: 'agent_guided_recipe', cloudReady: false,
    recipe: { name: '反馈流程', definition: { goal: '保留来源' } },
    skillPins: [{ releaseId: bundle.releaseId, skillVersionId: bundle.versionId, version: bundle.version, contentHash: bundle.contentHash, packageHash: bundle.packageHash, packageObjectHash: bundle.packageObjectHash }] };
  let host, deny = false; const calls = [];
  function open() {
    host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => ({ ready: Promise.resolve(), closed: false, close: async () => {}, async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'consumer-native', turns: [] } };
      if (method === 'turn/start') return { turn: { id: 'consumer-turn' } };
      throw new Error(method);
    } }) });
    host.cloud = { identity: async () => ({ origin: 'https://team.example.test', workspaceId: 'team' }), close: async () => {}, async fileCall(_identity, name) {
      if (deny) throw Object.assign(new Error('forbidden'), { status: 403 });
      if (name === 'turnsu_methods') return { data: [{ assetKind: 'loop', releaseId: pkg.releaseId, executionMode: 'native_agent' }, { assetKind: 'loop', executionMode: 'cloud' }], page: { hasMore: false } };
      if (name === 'turnsu_native_loop_package') return { data: { ...structuredClone(pkg), contentHash: canonicalRequestHash({ recipe: pkg.recipe, skillPins: pkg.skillPins }) } };
      if (name === 'turnsu_skill_package') return { data: structuredClone(bundle) };
      throw new Error(name);
    } };
  }
  open(); const project = await host.command('project.open', { path });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, calls, pkg, bundle, path, content, args: { projectId: project.id, releaseId: pkg.releaseId, requestId: 'choose-native-loop', agent: 'codex' }, deny() { deny = true; }, async reopen() { await host.close(); open(); } };
}

test('native team recipe installs exact Skills without inference, survives restart and works without Turnsu cloud', async t => {
  const f = await fixture(t); assert.equal((await f.host.command('nativeLoops.list')).items.length, 1);
  const task = await f.host.command('nativeLoops.use', f.args);
  assert.equal(task.nativeLoop.name, '反馈流程'); assert.equal(task.sharedWork, null); assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(f.path, '.agents/skills/feedback/SKILL.md'), 'utf8'), f.content);
  await f.reopen(); assert.equal((await f.host.command('nativeLoops.use', f.args)).id, task.id);
  f.pkg.recipe.name = 'UNREVIEWED_NEW_RECIPE'; f.deny();
  await assert.rejects(f.host.command('nativeLoops.use', { ...f.args, requestId: 'new-choice' }), /访问权限/);
  f.host.cloud.identity = async () => { throw new Error('offline'); };
  await f.host.command('session.send', { sessionId: task.id, inputId: 'local-use', text: '处理本周反馈' });
  const prompt = f.calls.find(c => c.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /SKILL.md/); assert.match(prompt, /反馈流程/); assert.doesNotMatch(prompt, /UNREVIEWED_NEW_RECIPE/);
  f.host.updateSession(task.id, 'idle');
  await writeFile(join(f.path, '.agents/skills/feedback/SKILL.md'), 'private local edits');
  const before = f.calls.length;
  await assert.rejects(f.host.command('session.send', { sessionId: task.id, inputId: 'edited', text: '再处理' }), /固定技能文件已改变/);
  assert.equal(f.calls.length, before); assert.equal(await readFile(join(f.path, '.agents/skills/feedback/SKILL.md'), 'utf8'), 'private local edits');
});

test('mismatched published package pin is rejected before project installation or task creation', async t => {
  const f = await fixture(t); f.pkg.skillPins[0].contentHash = 'sha256:other';
  await assert.rejects(f.host.command('nativeLoops.use', f.args), /未写入/);
  await assert.rejects(readFile(join(f.path, '.agents/skills/feedback/SKILL.md')), { code: 'ENOENT' });
  assert.equal(f.host.snapshot({ projectId: f.args.projectId }).sessions.length, 0); assert.equal(f.calls.length, 0);
});

test('choosing a Loop from a project composer carries its saved task and references instead of a placeholder', async t => {
  const f = await fixture(t), projectId = f.args.projectId;
  const sourceDraft = { text: '按流程整理真实反馈', references: ['feedback.md'] };
  await writeFile(join(f.path, 'feedback.md'), 'Keep customer quotes.');
  await f.host.command('draft.save', { projectId, ...sourceDraft });
  const args = { ...f.args, sourceDraft }, task = await f.host.command('nativeLoops.use', args);
  assert.deepEqual(await f.host.command('draft.read', { projectId, sessionId: task.id }), sourceDraft);
  assert.equal(f.calls.length, 0);
  await f.reopen(); assert.equal((await f.host.command('nativeLoops.use', args)).id, task.id);
  assert.deepEqual(await f.host.command('draft.read', { projectId }), sourceDraft);
  await f.host.command('session.send', { sessionId: task.id, inputId: 'loop-composer', ...sourceDraft });
  const prompt = f.calls.find(c => c.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /Keep customer quotes/); assert.match(prompt, /反馈流程/);
});
