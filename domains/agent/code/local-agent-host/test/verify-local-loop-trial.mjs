import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { loginNativeProduct } from '../../agent-runtime/integrations/native/login.mjs';

// Actual native-host/SQLite -> native bearer HTTP -> PostgreSQL. Model output is controlled.
export async function verifyLocalLoopTrial({ host, sourceSessionId, pool, nativeRequests, request, otherHeaders, root, authService, consumerUserId, workspaceId }) {
  const preview = await host.command('loopCapture.preview', { sessionId: sourceSessionId });
  const before = nativeRequests.length;
  const trial = await host.command('localLoopTrial.create', { sessionId: sourceSessionId, expectedHash: preview.hash, requestId: 'desktop-native-loop-feedback' });
  assert.equal(nativeRequests.length, before, 'preparing and installing fixed Skills does not start the native Agent');
  assert.equal(trial.sharedWork, null);
  const original = host.cloud.fileCall.bind(host.cloud);
  // The fully prepared task must execute through its own native protocol without Turnsu cloud.
  host.cloud.fileCall = async () => { assert.fail('a prepared private local trial must not require cloud connectivity'); };
  try {
    await host.command('session.send', { sessionId: trial.id, inputId: 'private-native-loop-input', text: 'PRIVATE_LOCAL_TRIAL_INPUT 用户说需要团队共享结果。请按已选流程处理。' });
  } finally { host.cloud.fileCall = original; }
  const wire = nativeRequests.at(-1).params.input[0].text;
  assert.match(wire, /SKILL.md/); assert.ok(wire.includes(preview.document.definition.goal));
  assert.doesNotMatch(wire, /PRIVATE_NATIVE_HISTORY|PRIVATE_SOURCE_INPUT/);
  const nativeId = host.session(trial.id).native_id;
  const turn = host.db.prepare('SELECT native_turn_id FROM submissions WHERE id=?').get('private-native-loop-input');
  const output = '步骤：分类并保留来源。\n结果：团队协作需求。依据：“需要团队共享结果”。\n检查：分类与原文一致，无未完成项。';
  host.onEvent({ method: 'item/completed', params: { threadId: nativeId, item: { id: 'trial-result', type: 'agentMessage', text: output } } });
  host.onEvent({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: turn.native_turn_id, status: 'completed' } } });
  const review = await host.command('localLoopTrial.review', { sessionId: trial.id });
  assert.equal(review.output, output);
  let lose = true;
  host.cloud.fileCall = async (...args) => { const response = await original(...args); if (args[1] === 'turnsu_record_local_loop_trial' && lose) { lose = false; throw new Error('accepted local-trial response lost'); } return response; };
  const count = nativeRequests.length;
  try {
    await assert.rejects(host.command('localLoopTrial.record', { sessionId: trial.id, reviewedHash: review.reviewedHash, inputSummary: '合成反馈：团队共享结果', reviewNote: '人工核对分类和原文一致', confirm: true }), /尚未确认/);
    assert.equal(lose, false, 'request must actually reach and commit in Product');
    host.message(trial.id, trial.id + ':trial-result', 'assistant', 'LATER_LOCAL_OUTPUT_NOT_SHARED');
    const saved = await host.command('localLoopTrial.record', { sessionId: trial.id, retry: true });
    assert.equal(saved.saved, true); assert.equal(saved.output, output);
    assert.equal(nativeRequests.length, count, 'saving or retrying evidence never runs Agent again');
    const delivery = host.db.prepare('SELECT * FROM local_loop_trial_deliveries WHERE trial_id=?').get(trial.localLoopTrial.id);
    const payload = JSON.parse(delivery.payload), receipt = JSON.parse(delivery.receipt).data;
    assert.equal(receipt.provenance, 'member_attested_local'); assert.equal(receipt.cloudReady, false);
    assert.equal(receipt.outputHash, 'sha256:' + createHash('sha256').update(output).digest('hex'));
    const rows = (await pool.query('SELECT * FROM local_loop_trial_receipts WHERE workflow_id=$1 AND local_trial_id=$2', [payload.pathParams.workflowId, trial.localLoopTrial.id])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].output, output);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_LOCAL_TRIAL_INPUT|PRIVATE_NATIVE_HISTORY|PRIVATE_SOURCE_INPUT|LATER_LOCAL_OUTPUT_NOT_SHARED/);
    assert.ok(!JSON.stringify(rows).includes(nativeId), 'cloud receipt excludes private native thread identifier');
    assert.equal((await request(`/workflows/${payload.pathParams.workflowId}/local-trials`, { method: 'POST', headers: { ...otherHeaders, 'Idempotency-Key': payload.idempotencyKey, 'If-Match': payload.ifMatch }, data: payload.data })).status, 404);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id=$1', [payload.pathParams.workflowId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM loop_versions WHERE workflow_id=$1', [payload.pathParams.workflowId])).rows[0].n, 0);
    await verifyNativePublication({ host, trial, receipt, original, nativeRequests, root, authService, consumerUserId, workspaceId, request, otherHeaders });
  } finally { host.cloud.fileCall = original; }
}

async function verifyNativePublication({ host, trial, receipt, original, nativeRequests, root, authService, consumerUserId, workspaceId, request, otherHeaders }) {
  const before = nativeRequests.length;
  let lose = true;
  host.cloud.fileCall = async (...args) => {
    const result = await original(...args);
    if (args[1] === 'turnsu_publish_native_loop' && lose) { lose = false; throw new Error('accepted publication response lost'); }
    return result;
  };
  assert.equal((await host.command('localLoopTrial.publication', { sessionId: trial.id })).canPrepare, true);
  await assert.rejects(host.command('localLoopTrial.publish', { sessionId: trial.id, version: '1.0.0', confirm: false }), /确认发布/);
  await assert.rejects(host.command('localLoopTrial.publish', { sessionId: trial.id, version: '1.0.0', releaseNotes: '用于本机反馈整理', confirm: true }), /尚未确认发布/);
  assert.equal(lose, false, 'native publication reached Product and committed');
  const published = await host.command('localLoopTrial.publish', { sessionId: trial.id, retry: true });
  assert.equal(published.published, true); assert.equal(nativeRequests.length, before);
  const row = host.db.prepare('SELECT receipt FROM local_loop_publications WHERE trial_id=?').get(trial.localLoopTrial.id);
  const release = JSON.parse(row.receipt).data.release;
  assert.equal(release.executionMode, 'native_agent');
  const directory = join(root, 'native-loop-consumer-state'), path = join(root, 'native-loop-consumer-project');
  await mkdir(directory, { mode: 0o700 }); await mkdir(path);
  await loginNativeProduct({ baseUrl: authService.publicOrigin, sessionPath: join(directory, 'cloud-session.json'), timeoutMs: 15_000,
    async onAuthorization(url) {
      const approval = await authService.approveNativeAuthorization({ authorizationId: new URL(url).searchParams.get('authorizationId'), auth: { userId: consumerUserId, activeWorkspaceId: workspaceId } });
      assert.equal((await fetch(approval.redirectUrl)).status, 200);
    } });
  let consumer, hooks; const starts = [];
  const open = () => new LocalAgentHost({ directory, claudeFactory: options => {
    hooks = options;
    return { ready: Promise.resolve(), closed: false, models: [], close: async () => {}, async send(inputId, prompt) {
      starts.push({ inputId, prompt }); options.onEvent({ type: 'user', uuid: inputId, session_id: options.sessionId });
    } };
  } });
  consumer = open();
  try {
    const project = await consumer.command('project.open', { path });
    const catalog = await consumer.command('nativeLoops.list'); assert.ok(catalog.items.some(item => item.releaseId === release.releaseId));
    const sourceDraft = { text: '这周的反馈：希望同事接续工作。请按流程整理并保留来源。', references: [] };
    await consumer.command('draft.save', { projectId: project.id, ...sourceDraft });
    const task = await consumer.command('nativeLoops.use', { projectId: project.id, agent: 'claude', releaseId: release.releaseId, requestId: 'reuse-native-loop', sourceDraft });
    assert.deepEqual(await consumer.command('draft.read', { projectId: project.id, sessionId: task.id }), sourceDraft);
    assert.equal(task.agent, 'claude'); assert.equal(task.sharedWork, null); assert.equal(starts.length, 0);
    const installed = consumer.db.prepare('SELECT package,dependencies FROM native_loop_sessions WHERE session_id=?').get(task.id);
    assert.doesNotMatch(installed.package, /PRIVATE_LOCAL_TRIAL_INPUT|PRIVATE_NATIVE_HISTORY|PRIVATE_SOURCE_INPUT|LATER_LOCAL_OUTPUT_NOT_SHARED|人工核对分类/);
    const dependencies = JSON.parse(installed.dependencies); assert.ok(dependencies.length > 0);
    assert.ok((await readFile(join(dependencies[0].receipt.directory, 'SKILL.md'), 'utf8')).length > 0);
    assert.ok(dependencies[0].receipt.directory.includes('/.claude/skills/'));
    assert.equal((await request(`/workflows/${receipt.workflowId}`, { headers: otherHeaders })).status, 404, 'published native method does not expose author draft');
    await consumer.close(); consumer = open();
    consumer.teamMethods().cloud.fileCall = async () => { assert.fail('already downloaded private task must work without Turnsu cloud'); };
    assert.deepEqual(await consumer.command('draft.read', { projectId: project.id, sessionId: task.id }), sourceDraft);
    await consumer.command('session.send', { sessionId: task.id, inputId: 'consumer-native-loop-input', ...sourceDraft });
    assert.equal(starts.length, 1); assert.match(starts[0].prompt, /SKILL.md/); assert.ok(starts[0].prompt.includes(task.nativeLoop.name));
    assert.doesNotMatch(starts[0].prompt, /PRIVATE_LOCAL_TRIAL_INPUT|PRIVATE_NATIVE_HISTORY|PRIVATE_SOURCE_INPUT|LATER_LOCAL_OUTPUT_NOT_SHARED|人工核对分类/);
    hooks.onEvent({ type: 'assistant', session_id: hooks.sessionId, message: { id: 'consumer-output', content: [{ type: 'text', text: '分类：团队接续。来源：“希望同事接续工作”。' }] } });
    hooks.onEvent({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', session_id: hooks.sessionId });
    assert.equal(consumer.readSession(task.id).status, 'idle');
    assert.match(consumer.readSession(task.id).messages.at(-1).text, /团队接续/);
  } finally { await consumer.close(); }
}
