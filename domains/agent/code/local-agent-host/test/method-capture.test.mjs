import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

async function fixture(t, agent = 'codex') {
  const root = await mkdtemp('/private/tmp/turnsu-capture-'), projectPath = join(root, 'project');
  await mkdir(projectPath);
  const calls = [];
  let host;
  function open() {
    host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => ({
      ready: Promise.resolve(), closed: false, close: async () => {},
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'native-capture', turns: [] } };
        if (method === 'turn/start') return { turn: { id: 'capture-turn' } };
        throw new Error(method);
      },
    }) });
  }
  open();
  const project = await host.command('project.open', { path: projectPath });
  const source = await host.command('session.create', { projectId: project.id, agent });
  // Represents completed native work; the source contains private data outside the selected answer.
  host.db.prepare('INSERT INTO submissions VALUES(?,?,?,NULL,?)').run('source-input', source.id, 'PRIVATE_SOURCE_REQUEST', 'completed');
  host.db.prepare('UPDATE sessions SET model=? WHERE id=?').run('source-model', source.id);
  host.message(source.id, 'private-message', 'user', 'PRIVATE_HISTORY');
  host.message(source.id, 'tool-message', 'tool', 'PRIVATE_TOOL_LOG');
  host.message(source.id, 'answer', 'assistant', '整理每条反馈，保留依据与未知信息。');
  const args = { sessionId: source.id, messageId: 'answer', requestId: 'capture-one' };
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, root, projectPath, project, source, args, calls,
    async reopen() { await host.close(); open(); },
    async candidate(body = '读取反馈，逐条保留依据。缺失信息应标为未知。') {
      const path = join(projectPath, '.turnsu-method-drafts/capture-one'); await mkdir(path, { recursive: true });
      const content = `---\nname: method-capture-one\ndescription: "整理团队反馈"\n---\n${body}\n`;
      await writeFile(join(path, 'SKILL.md'), content); return content;
    },
  };
}

test('capture prepares a durable private task containing only the explicitly selected answer', async t => {
  const f = await fixture(t), created = await f.host.command('capture.create', f.args);
  assert.equal(created.agent, 'codex'); assert.equal(created.model, 'source-model');
  assert.equal(created.sharedWork, null); assert.equal(created.messages.length, 0); assert.equal(f.calls.length, 0);
  const draft = (await f.host.command('draft.read', { projectId: f.project.id, sessionId: created.id })).text;
  assert.match(draft, /我选中的成果/); assert.doesNotMatch(draft, /PRIVATE_|frontmatter|SKILL.md/);
  assert.equal((await readdir(f.projectPath)).length, 0, 'preparation does not create or install files');
  await f.reopen();
  assert.equal((await f.host.command('capture.create', f.args)).id, created.id);
  await assert.rejects(f.host.command('capture.create', { ...f.args, messageId: 'private-message' }), /不同答复/);
  assert.equal(f.calls.length, 0);
  await f.host.command('session.send', { sessionId: created.id, inputId: 'explicit-send', text: draft });
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(f.calls.find(call => call.method === 'turn/start').params.model, 'source-model');
  const wire = f.calls.find(call => call.method === 'turn/start').params.input[0].text;
  assert.match(wire, /整理每条反馈/); assert.doesNotMatch(wire, /PRIVATE_/);
  assert.equal((await f.host.command('session.read', { sessionId: created.id })).messages[0].text, draft);
});

for (const [agent, directory] of [['codex', '.agents'], ['claude', '.claude'], ['pi', '.pi']]) {
  test(`${agent}: adopts exact reviewed bytes and reopens one reusable local task`, async t => {
    const f = await fixture(t, agent), task = await f.host.command('capture.create', f.args);
    const content = await f.candidate();
    const preview = await f.host.command('capture.preview', { sessionId: task.id });
    assert.equal(preview.content, content); assert.equal(preview.installed, false);
    const adoption = { sessionId: task.id, expectedHash: preview.hash };
    await f.host.command('capture.adopt', adoption);
    const file = join(f.projectPath, directory, 'skills/method-capture-one/SKILL.md');
    assert.equal(await readFile(file, 'utf8'), content);
    await f.reopen(); await f.host.command('capture.adopt', adoption);
    const use = { sessionId: task.id, requestId: 'use-captured-method' };
    const next = await f.host.command('capture.use', use);
    assert.equal(next.agent, agent); assert.equal(next.model, 'source-model'); assert.equal(next.sharedWork, null);
    assert.match((await f.host.command('draft.read', { projectId: f.project.id, sessionId: next.id })).text, /本机技能/);
    await f.reopen(); assert.equal((await f.host.command('capture.use', use)).id, next.id);
    assert.equal(f.calls.length, 0, 'adoption and reuse preparation never execute a model');
    await writeFile(file, 'local changes');
    await assert.rejects(f.host.command('capture.adopt', adoption), /原文件已保留/);
    await assert.rejects(f.host.command('capture.use', use), /已经修改/);
    await assert.rejects(f.host.command('session.send', { sessionId: next.id, inputId: 'changed-method', text: '整理新的反馈' }), /已经修改/);
    assert.equal(f.calls.length, 0, 'a previously opened task also checks the method before dispatch');
    assert.equal(await readFile(file, 'utf8'), 'local changes');
  });
}

test('changed drafts, foreign skills and linked directories cannot be silently adopted', async t => {
  const f = await fixture(t), task = await f.host.command('capture.create', f.args);
  await assert.rejects(f.host.command('capture.preview', { sessionId: task.id }), /还没有写入/);
  await f.candidate(); const preview = await f.host.command('capture.preview', { sessionId: task.id });
  await f.candidate('Changed steps');
  await assert.rejects(f.host.command('capture.adopt', { sessionId: task.id, expectedHash: preview.hash }), /草稿已经变化/);
  const changed = await f.host.command('capture.preview', { sessionId: task.id });
  const target = join(f.projectPath, '.agents/skills/method-capture-one');
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'SKILL.md'), 'foreign skill');
  await assert.rejects(f.host.command('capture.adopt', { sessionId: task.id, expectedHash: changed.hash }), /同名技能/);
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'foreign skill');
  const path = join(f.projectPath, '.turnsu-method-drafts/capture-one/SKILL.md');
  await rm(path); await symlink(join(target, 'SKILL.md'), path);
  await assert.rejects(f.host.command('capture.preview', { sessionId: task.id }));
});

test('busy or failed work and tool messages do not become capture sources', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.command('capture.create', { ...f.args, messageId: 'tool-message' }), /无法直接整理/);
  f.host.updateSession(f.source.id, 'running');
  await assert.rejects(f.host.command('capture.create', f.args), /任务完成/);
  f.host.updateSession(f.source.id, 'idle');
  f.host.db.prepare("UPDATE submissions SET status='failed'").run();
  await assert.rejects(f.host.command('capture.create', f.args), /任务完成/);
});

test('adoption recovers after files were written but the local receipt could not be saved', async t => {
  const f = await fixture(t), task = await f.host.command('capture.create', f.args);
  const content = await f.candidate();
  const preview = await f.host.command('capture.preview', { sessionId: task.id });
  f.host.db.exec("CREATE TEMP TRIGGER lose_capture_receipt BEFORE UPDATE OF installed_path ON method_captures BEGIN SELECT RAISE(FAIL, 'local_receipt_lost'); END;");
  const adoption = { sessionId: task.id, expectedHash: preview.hash };
  await assert.rejects(f.host.command('capture.adopt', adoption), /local_receipt_lost/);
  const path = join(f.projectPath, '.agents/skills/method-capture-one/SKILL.md');
  assert.equal(await readFile(path, 'utf8'), content);
  await f.reopen();
  assert.equal((await f.host.command('capture.adopt', adoption)).installed, true);
  assert.equal(await readFile(path, 'utf8'), content);
  assert.deepEqual(await readdir(join(f.projectPath, '.agents/skills')), ['method-capture-one']);
  assert.equal((await f.host.command('session.read', { sessionId: task.id })).capture.installed, true);
});
