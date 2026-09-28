import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

test('project Skill OS reads real local files and prepares one pinned native task without running a model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-project-skills-'));
  const projectPath = join(root, 'project');
  await mkdir(join(projectPath, '.agents', 'skills', 'weekly-report'), { recursive: true });
  const skillPath = join(projectPath, '.agents', 'skills', 'weekly-report', 'SKILL.md');
  await writeFile(skillPath, '---\nname: weekly-report\ndescription: "整理周报并核对来源"\n---\n核对真实结果。\n');
  let turns = 0, sentPrompt = '';
  const connectionFactory = ({ onEvent }) => ({
    ready: Promise.resolve(), closed: false,
    request: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'native-skill-thread', turns: [] } };
      if (method === 'turn/start') {
        turns++; sentPrompt = JSON.stringify(params);
        onEvent({ method: 'turn/started', params: { threadId: 'native-skill-thread', turn: { id: 'turn-1' } } });
        return { turn: { id: 'turn-1' } };
      }
      throw new Error('unexpected provider method: ' + method);
    },
    respond() {}, reject() {}, close: async () => {},
  });
  let host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path: projectPath });
  const catalog = await host.command('skills.list', { projectId: project.id });
  const item = catalog.items.find(value => value.path === '.agents/skills/weekly-report/SKILL.md');
  assert.equal(item.description, '整理周报并核对来源');
  assert.equal(item.source, 'project');
  assert.equal(turns, 0);
  const detail = await host.command('skills.read', { projectId: project.id, agent: 'codex', path: item.path, expectedHash: item.hash });
  assert.match(detail.content, /核对真实结果/);
  const args = { projectId: project.id, agent: 'codex', path: item.path, expectedHash: item.hash, requestId: 'selected-skill-1' };
  const session = await host.command('skills.use', args);
  assert.equal((await host.command('skills.use', args)).id, session.id);
  assert.equal(turns, 0);
  assert.match((await host.command('draft.read', { projectId: project.id, sessionId: session.id })).text, /已选项目技能/);
  await assert.rejects(host.command('skills.use', { ...args, agent: 'claude' }), /技能路径|不同技能/);
  await host.close();
  host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory });
  await host.command('session.send', { sessionId: session.id, inputId: 'skill-input-1', text: '整理这周的成果' });
  assert.equal(turns, 1);
  assert.match(sentPrompt, /weekly-report\/SKILL\.md/);
  assert.match(sentPrompt, /整理这周的成果/);
});

test('project Skill OS does not follow links or send a changed skill version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-project-skills-boundary-'));
  const projectPath = join(root, 'project'), outside = join(root, 'outside');
  await mkdir(join(projectPath, '.agents', 'skills', 'safe'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), 'private');
  await symlink(outside, join(projectPath, '.agents', 'skills', 'linked'));
  const file = join(projectPath, '.agents', 'skills', 'safe', 'SKILL.md');
  await writeFile(file, '---\nname: safe\ndescription: "原方法"\n---\n原步骤。');
  const host = new LocalAgentHost({ directory: join(root, 'state') });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path: projectPath });
  const catalog = await host.command('skills.list', { projectId: project.id });
  assert.equal(catalog.items.some(item => item.path?.includes('linked')), false);
  const item = catalog.items.find(value => value.path?.includes('/safe/'));
  const session = await host.command('skills.use', { projectId: project.id, agent: 'codex', path: item.path, expectedHash: item.hash, requestId: 'selected-skill-2' });
  await writeFile(file, '---\nname: safe\ndescription: "新方法"\n---\n新步骤。');
  await assert.rejects(host.command('session.send', { sessionId: session.id, inputId: 'skill-input-2', text: '使用原方法' }), /已修改/);
  assert.equal((await host.command('session.read', { sessionId: session.id })).messages.length, 0);
  await assert.rejects(host.command('skills.read', { projectId: project.id, agent: 'codex', path: '../outside/SKILL.md' }), /路径/);
});
