import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Real desktop host -> native Product token -> HTTP -> PG/object store. No model inference.
export async function verifyCaptureUpload({ host, root, request, otherHeaders, pool, objectStore }) {
  const path = join(root, 'capture-upload-project'); await mkdir(path);
  const project = await host.command('project.open', { path });
  const source = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.db.prepare('INSERT INTO submissions VALUES(?,?,?,NULL,?)').run('capture-upload-source', source.id, 'PRIVATE ORIGINAL REQUEST', 'completed');
  host.message(source.id, 'capture-upload-answer', 'assistant', '按原始反馈保留证据。');
  const task = await host.command('capture.create', { sessionId: source.id, messageId: 'capture-upload-answer', requestId: 'capture-upload-one' });
  const folder = join(path, '.turnsu-method-drafts/capture-upload-one'); await mkdir(folder, { recursive: true });
  const content = '---\nname: method-capture-upload-one\ndescription: "按原始反馈保留证据"\n---\n逐条整理反馈，保留每项依据；不知道的内容标注未知。\n';
  await writeFile(join(folder, 'SKILL.md'), content);
  const preview = await host.command('capture.preview', { sessionId: task.id });
  const args = { sessionId: task.id, expectedHash: preview.hash, name: '桌面整理的反馈方法' };
  const originalCall = host.cloud.fileCall.bind(host.cloud); let lost = false;
  host.cloud.fileCall = async (...args) => {
    const value = await originalCall(...args);
    if (args[1] === 'turnsu_create_skill_draft' && !lost) { lost = true; throw new Error('accepted_response_lost'); }
    return value;
  };
  await assert.rejects(host.command('capture.saveCloud', args), /核对原记录/);
  assert.equal(lost, true);
  host.cloud.fileCall = originalCall;
  const result = await host.command('capture.saveCloud', args);
  assert.equal(result.saved, true);
  assert.equal(result.draft.name, args.name);
  const { skillId, skillDraftId } = result.draft;
  const rows = await pool.query('SELECT * FROM skill_assets WHERE skill_id=$1', [skillId]);
  assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].visibility, 'private'); assert.equal(rows.rows[0].lifecycle, 'draft');
  const details = await host.cloud.fileCall(await host.cloud.identity(), 'turnsu_skill_draft', { pathParams: { skillId, draftId: skillDraftId } });
  assert.equal(details.data.skillDraftId, skillDraftId);
  const snapshot = (await pool.query('SELECT definition FROM skill_drafts WHERE skill_draft_id=$1', [skillDraftId])).rows[0];
  assert.equal(snapshot.definition.files.length, 1);
  const object = await objectStore.read({ workspaceId: rows.rows[0].workspace_id, objectId: snapshot.definition.files[0].objectId });
  const packageFiles = JSON.parse(object.bytes.toString('utf8')).files;
  assert.equal(packageFiles.length, 1); assert.equal(packageFiles[0].path, 'SKILL.md');
  assert.equal(Buffer.from(packageFiles[0].content, 'base64').toString('utf8'), content, 'cloud stores exactly the reviewed file, without native history');
  const denied = await request(`/skills/${skillId}/drafts/${skillDraftId}`, { headers: otherHeaders });
  assert.equal(denied.status, 404, 'another team member cannot read this private capture');
  const releases = await pool.query('SELECT * FROM workspace_asset_releases WHERE skill_id=$1', [skillId]);
  assert.equal(releases.rows.length, 0, 'private transfer must not publish');
  assert.equal((await host.command('capture.saveCloud', args)).draft.skillDraftId, skillDraftId);
  return { skillId, skillDraftId, content, sessionId: task.id };
}

export async function verifyCaptureRelease({ host, capture, runner, workspaceId, pool, request, otherHeaders }) {
  const { sessionId, skillId } = capture;
  const original = host.cloud.fileCall.bind(host.cloud); let loseTest = true, losePublish = true;
  host.cloud.fileCall = async (...args) => {
    const result = await original(...args);
    if (args[1] === 'turnsu_test_skill' && loseTest) { loseTest = false; throw new Error('accepted_test_response_lost'); }
    if (args[1] === 'turnsu_publish_skill' && losePublish) { losePublish = false; throw new Error('accepted_publish_response_lost'); }
    return result;
  };
  try {
    const trialRequest = { sessionId, requestId: 'capture-trial-one', kind: 'test', sample: 'PRIVATE TRIAL INPUT: 帮团队按依据整理反馈。', purpose: '保留依据和未知信息。' };
    await assert.rejects(host.command('capture.releaseAction', trialRequest), /操作尚未确认/);
    await assert.rejects(host.command('capture.releaseAction', { ...trialRequest, requestId: 'duplicate-trial' }), /上次操作/);
    await host.command('capture.retryRelease', { requestId: trialRequest.requestId });
    let state = await host.command('capture.trials', { sessionId });
    assert.equal(state.trials.length, 1); assert.equal(state.trials[0].status, 'queued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM skill_test_runs WHERE skill_id=$1', [skillId])).rows[0].n, 1);
    const testRunId = state.trials[0].testRunId;
    await runner.schedule(testRunId, { workspaceId });
    state = await host.command('capture.trials', { sessionId });
    assert.equal(state.trials[0].status, 'passed');
    assert.equal(state.trials[0].outputPreview.result, 'Synthetic result');
    const publish = { sessionId, requestId: 'capture-publish-one', kind: 'publish', testRunId, reviewedOutputHash: state.trials[0].reviewedOutputHash, confirm: true };
    await assert.rejects(host.command('capture.releaseAction', { ...publish, reviewedOutputHash: 'wrong-output' }), /完整试运行结果/);
    await assert.rejects(host.command('capture.releaseAction', publish), /操作尚未确认/);
    await host.command('capture.retryRelease', { requestId: publish.requestId });
    state = await host.command('capture.trials', { sessionId });
    assert.equal(state.pending.length, 0); assert.equal(state.published.version.version, '1.0.0');
    const releases = await pool.query('SELECT release_id FROM workspace_asset_releases WHERE skill_id=$1', [skillId]);
    assert.equal(releases.rows.length, 1);
    const library = await request('/team-library', { headers: otherHeaders });
    assert.ok(library.body.data.some(item => item.releaseId === releases.rows[0].release_id));
    const downloaded = await request(`/team-library/${releases.rows[0].release_id}/native-skill-package`, { headers: otherHeaders });
    assert.equal(downloaded.status, 200, JSON.stringify(downloaded.body));
    const bytes = JSON.parse(Buffer.from(downloaded.body.data.packageContentBase64, 'base64').toString());
    assert.equal(bytes.files.length, 1); assert.equal(Buffer.from(bytes.files[0].content, 'base64').toString(), capture.content);
    assert.equal((await request(`/skills/${skillId}/tests/${testRunId}`, { headers: otherHeaders })).status, 404, 'publishing does not grant access to private trial input/output');
  } finally { host.cloud.fileCall = original; }
}
