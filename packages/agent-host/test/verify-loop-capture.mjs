import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Real native bearer HTTP and PostgreSQL. Draft generation is supplied, not a model-quality claim.
export async function verifyLoopCapture({ host, root, document, pool, request, otherHeaders, nativeRequests }) {
  const path = join(root, 'loop-capture-project'); await mkdir(path);
  const project = await host.command('project.open', { path });
  const source = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.db.prepare('INSERT INTO submissions VALUES(?,?,?,NULL,?)').run('loop-capture-source', source.id, 'PRIVATE_SOURCE_INPUT', 'completed');
  host.message(source.id, 'loop-private', 'user', 'PRIVATE_NATIVE_HISTORY');
  host.message(source.id, 'loop-answer', 'assistant', '分类反馈，并保留来源。');
  const before = nativeRequests.length;
  const task = await host.command('loopCapture.create', { sessionId: source.id, messageId: 'loop-answer', requestId: 'captured-feedback-loop', includeTeamSkills: true });
  assert.equal(nativeRequests.length, before);
  const instruction = host.loopCapture.prepare(task.id, '整理已选成果');
  const selectedSkill = document.graph.nodes.find(node => node.kind === 'Skill');
  assert.ok(instruction.includes(JSON.stringify(selectedSkill.skillRef.skillId)), 'capture discovers the actual published team Skill, not the legacy catalog');
  assert.doesNotMatch(instruction, /PRIVATE_NATIVE_HISTORY|PRIVATE_SOURCE_INPUT/);
  const folder = join(path, '.turnsu-loop-drafts/captured-feedback-loop'); await mkdir(folder, { recursive: true });
  const content = JSON.stringify(document, null, 2); await writeFile(join(folder, 'LOOP.json'), content);
  const preview = await host.command('loopCapture.preview', { sessionId: task.id });
  const args = { sessionId: task.id, expectedHash: preview.hash, confirm: true };
  const original = host.cloud.fileCall.bind(host.cloud); let loseCreate = true, loseSave = true;
  host.cloud.fileCall = async (...input) => {
    const value = await original(...input);
    if (input[1] === 'turnsu_create_loop_draft' && loseCreate) { loseCreate = false; throw new Error('accepted creation response lost'); }
    if (input[1] === 'turnsu_save_loop_draft' && loseSave) { loseSave = false; throw new Error('accepted graph response lost'); }
    return value;
  };
  try {
    await assert.rejects(host.command('loopCapture.save', args), /尚未确认/);
    assert.equal(loseCreate, false);
    await writeFile(join(folder, 'LOOP.json'), JSON.stringify({ ...document, name: 'THIS_LOCAL_EDIT_MUST_NOT_REPLACE_REVIEWED_BYTES' }));
    await assert.rejects(host.command('loopCapture.save', args), /尚未确认/);
    assert.equal(loseSave, false);
    const saved = await host.command('loopCapture.save', args); assert.equal(saved.saved, true);
    const { workflow, revision } = saved.draft;
    assert.deepEqual(revision.graph, document.graph); assert.deepEqual(revision.definition, document.definition);
    assert.equal(saved.content, content); assert.equal(workflow.name, document.name);
    const stored = (await pool.query('SELECT visibility,owner_user_id FROM workflows WHERE workflow_id=$1', [workflow.workflowId])).rows[0];
    assert.equal(stored.visibility, 'private');
    const revisions = (await pool.query('SELECT graph,definition FROM workflow_revisions WHERE workflow_id=$1 ORDER BY revision_number', [workflow.workflowId])).rows;
    assert.equal(revisions.length, 2, 'one initial revision and one reviewed graph despite two lost responses');
    assert.deepEqual(revisions[1].graph, document.graph); assert.deepEqual(revisions[1].definition, document.definition);
    assert.equal((await request(`/workflows/${workflow.workflowId}`, { headers: otherHeaders })).status, 404, 'private Loop is not shared by capture');
    const checked = await host.command('loopCapture.check', { sessionId: task.id });
    assert.ok(['ready', 'blocked', 'invalid'].includes(checked.compilation.status));
    assert.equal(checked.compilation.workflowRevisionId, revision.revisionId);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id=$1', [workflow.workflowId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM loop_versions WHERE workflow_id=$1', [workflow.workflowId])).rows[0].n, 0);
    assert.equal(nativeRequests.length, before, 'saving and checking never executes the native Agent');
    assert.equal((await host.command('loopCapture.save', args)).draft.revision.revisionId, revision.revisionId);
    assert.doesNotMatch(JSON.stringify(revisions), /PRIVATE_NATIVE_HISTORY|PRIVATE_SOURCE_INPUT/);
    const updated = { ...document, definition: { ...document.definition, goal: '按主题整理每周反馈，保留每项结论的原文依据。' } };
    await writeFile(join(folder, 'LOOP.json'), JSON.stringify(updated, null, 2));
    const changed = await host.command('loopCapture.preview', { sessionId: task.id });
    const updateArgs = { sessionId: task.id, expectedHash: changed.hash, confirm: true, update: true };
    await assert.rejects(host.command('loopCapture.save', { ...updateArgs, update: false }), /原 Loop 提交/);
    loseSave = true;
    await assert.rejects(host.command('loopCapture.save', updateArgs), /尚未确认/);
    await writeFile(join(folder, 'LOOP.json'), JSON.stringify({ ...updated, definition: { ...updated.definition, expectedResult: '按主题分组的反馈，以及有原文依据的待办建议。' } }, null, 2));
    const updatedSave = await host.command('loopCapture.save', updateArgs);
    assert.equal(updatedSave.draft.workflow.workflowId, workflow.workflowId, 'editing updates the same private Loop');
    assert.notEqual(updatedSave.draft.revision.revisionId, revision.revisionId);
    assert.deepEqual(updatedSave.draft.revision.definition, updated.definition, 'uncertain update retains the reviewed definition despite another local edit');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workflow_revisions WHERE workflow_id=$1', [workflow.workflowId])).rows[0].n, 3, 'update creates one revision despite a lost response');
    assert.equal(nativeRequests.length, before);
    await writeFile(join(folder, 'LOOP.json'), JSON.stringify(updated, null, 2));
    return { sessionId: task.id };
  } finally { host.cloud.fileCall = original; }
}
