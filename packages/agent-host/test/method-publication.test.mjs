import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { Check } from '../../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';

async function fixture(t, { inspection = 'passed', nameConflict = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-capture-cloud-')), path = join(root, 'project'); await mkdir(path);
  let host, actor = 'owner', denied = false, lose = true;
  const calls = [], receipts = new Map(), identity = { origin: 'https://team.example.test', workspaceId: 'workspace-one', clientSessionId: 'native-one' };
  const open = () => {
    host = new LocalAgentHost({ directory: join(root, 'state'), connectionFactory: () => { assert.fail('no model inference'); } });
    host.cloud = { identity: async () => identity, viewer: async () => ({ userId: actor, workspaceId: identity.workspaceId }), close: async () => {},
      async fileCall(expected, name, input) {
        assert.deepEqual(expected, identity); assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t => t.name === name).inputSchema, input), name);
        calls.push({ name, input });
        if (denied) throw Object.assign(new Error('denied'), { status: 403 });
        if (name === 'turnsu_skill_draft') return { data: { skillId: 'skill-one', skillDraftId: 'draft-one', name: '共享方法' } };
        const key = input.idempotencyKey;
        if (!receipts.has(key)) {
          if (nameConflict && name === 'turnsu_create_skill_draft') throw Object.assign(new Error('name conflict'), { status: 409, code: 'skill_name_unavailable' });
          receipts.set(key, name === 'turnsu_create_skill_upload' ? { uploadId: 'upload-one' }
            : name === 'turnsu_upload_skill_package' ? { uploadId: 'upload-one', inspection: { status: inspection, diagnostics: [] } }
            : name === 'turnsu_create_skill_draft' ? { skill: { skillId: 'skill-one' }, draft: { skillId: 'skill-one', skillDraftId: 'draft-one' } } : { uploadId: 'upload-one' });
        }
        if (name === 'turnsu_create_skill_draft' && lose) { lose = false; throw new Error('lost accepted receipt'); }
        return { data: receipts.get(key) };
      } };
  };
  open(); const project = await host.command('project.open', { path });
  const source = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.db.prepare('INSERT INTO submissions VALUES(?,?,?,NULL,?)').run('source', source.id, 'PRIVATE REQUEST', 'completed');
  host.message(source.id, 'answer', 'assistant', 'Selected result');
  const task = await host.command('capture.create', { sessionId: source.id, messageId: 'answer', requestId: 'cloud-capture' });
  const folder = join(path, '.turnsu-method-drafts/cloud-capture'); await mkdir(folder, { recursive: true });
  const content = '---\nname: method-cloud-capture\ndescription: "整理反馈"\n---\n依据原始资料整理反馈。';
  await writeFile(join(folder, 'SKILL.md'), content);
  const preview = await host.command('capture.preview', { sessionId: task.id });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, task, content, calls, receipts, args: { sessionId: task.id, expectedHash: preview.hash, name: '共享方法' },
    async reopen() { await host.close(); open(); }, switchActor() { actor = 'other'; }, restoreActor() { actor = 'owner'; }, deny() { denied = true; },
    async edit() { await writeFile(join(folder, 'SKILL.md'), content + '\nLocal change after submission'); } };
}

test('unknown cloud creation resumes exact uploaded bytes after restart without publishing or model execution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.command('capture.saveCloud', f.args), /核对原记录/);
  const before = f.calls.length; await f.reopen(); assert.equal(f.calls.length, before, 'reopening does not replay uploads');
  await f.edit();
  const state = await f.host.command('capture.cloud', { sessionId: f.task.id });
  assert.equal(state.saved.content, f.content); assert.equal(state.saved.saved, false);
  await assert.rejects(f.host.command('capture.resetCloud', { sessionId: f.task.id, expectedHash: f.args.expectedHash }), /尚未确认/);
  await assert.rejects(f.host.command('capture.saveCloud', { ...f.args, name: 'different' }), /需要核对/);
  f.switchActor(); await assert.rejects(f.host.command('capture.saveCloud', f.args), /最初保存/); f.restoreActor();
  const result = await f.host.command('capture.saveCloud', f.args);
  assert.equal(result.saved, true); assert.equal(result.draft.skillDraftId, 'draft-one'); assert.equal(f.receipts.size, 4);
  const uploads = f.calls.filter(c => c.name === 'turnsu_upload_skill_package');
  assert.equal(uploads.length, 1); assert.equal(uploads[0].input.data.files.length, 1);
  assert.equal(Buffer.from(uploads[0].input.data.files[0].contentBase64, 'base64').toString(), f.content);
  assert.doesNotMatch(JSON.stringify(uploads), /PRIVATE REQUEST/);
  f.deny(); await assert.rejects(f.host.command('capture.saveCloud', f.args), /检查权限/);
  assert.equal(f.receipts.size, 4);
});

for (const options of [{ inspection: 'needs_review' }, { nameConflict: true }]) test(`definitive package/name failure can be explicitly re-prepared: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(f.host.command('capture.saveCloud', f.args));
  const state = await f.host.command('capture.cloud', { sessionId: f.task.id });
  assert.equal(state.saved.canRestart, true); assert.equal(state.saved.saved, false);
  if (options.inspection) assert.equal(f.calls.some(c => c.name === 'turnsu_promote_skill_upload'), false, 'warnings cannot silently grant permission');
  const calls = f.calls.length;
  await f.host.command('capture.resetCloud', { sessionId: f.task.id, expectedHash: f.args.expectedHash });
  assert.equal(f.calls.length, calls, 'repreparation does not delete cloud files');
  assert.equal((await f.host.command('capture.cloud', { sessionId: f.task.id })).saved, null);
});
