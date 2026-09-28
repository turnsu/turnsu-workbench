import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Real publication, Product HTTP/PG and desktop host; only the host's model boundary is controlled.
export async function verifyTeamSkill({ host, root, request, ownerHeaders, memberUserId, releaseId, requests }) {
  const created = await request('/projects', { method: 'POST', headers: { ...ownerHeaders, 'Idempotency-Key': 'skill-team-project' },
    data: { title: '每周反馈', objective: '用团队技能完成反馈整理', members: [{ userId: memberUserId }] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const teamProjectId = created.body.data.projectId;
  const work = await request('/work-items', { method: 'POST', headers: { ...ownerHeaders, 'Idempotency-Key': 'skill-team-work' },
    data: { projectId: teamProjectId, title: '整理每周客户反馈', objective: '从反馈中找出下一步行动并保留原话', summary: '共同验收反馈结果', members: [{ userId: memberUserId, access: 'contribute', roles: ['participant'] }] } });
  assert.equal(work.status, 201, JSON.stringify(work.body));
  const workItemId = work.body.data.workItemId;
  const folder = join(root, 'team-skill-project'); await mkdir(folder);
  const project = await host.command('project.open', { path: folder });
  await host.command('sync.attach', { projectId: project.id, remoteId: teamProjectId });
  const privateTask = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  host.message(privateTask.id, 'private-skill-history', 'assistant', 'PRIVATE_SKILL_HISTORY_NOT_SHARED');
  const source = await host.command('work.continue', { projectId: project.id, workItemId, agent: 'codex', requestId: 'team-skill-composer' });
  await writeFile(join(folder, 'feedback.md'), '客户反馈：导出等待过久。');
  await host.command('sync.retry', { projectId: project.id });
  const sourceDraft = { sessionId: source.id, text: '请按所选方法整理当前共享反馈。', references: ['feedback.md'] };
  await host.command('draft.save', { projectId: project.id, ...sourceDraft });
  const choice = { projectId: project.id, agent: 'codex', releaseId, workItemId, requestId: 'team-skill-choice', sourceDraft };
  const before = requests.length;
  const task = await host.command('methods.use', choice);
  assert.equal(task.sharedWork.workItemId, workItemId);
  assert.equal(task.title, '整理每周客户反馈');
  assert.equal(requests.length, before, 'skill selection does not invoke a model');
  assert.deepEqual(await host.command('draft.read', { projectId: project.id, sessionId: task.id }), { text: sourceDraft.text, references: sourceDraft.references });
  assert.equal((await host.command('methods.use', choice)).id, task.id);
  await assert.rejects(host.command('methods.use', { ...choice, workItemId: undefined }), /同一请求/);
  await host.command('session.send', { sessionId: task.id, inputId: 'team-skill-request', text: sourceDraft.text, references: sourceDraft.references });
  const prompt = requests.filter(r => r.method === 'turn/start').at(-1).params.input[0].text;
  assert.match(prompt, /从反馈中找出下一步行动/);
  assert.match(prompt, /客户反馈：导出等待过久/);
  assert.ok(prompt.includes(join(task.method.directory, 'SKILL.md')));
  assert.ok(!prompt.includes('PRIVATE_SKILL_HISTORY_NOT_SHARED'));
  const active = await host.command('session.read', { sessionId: task.id });
  host.onEvent({ method: 'item/completed', params: { threadId: active.native_id, item: { id: 'skill-method-answer', type: 'agentMessage', text: '按团队技能整理完成：保留反馈原话，频次未知。' } } });
  host.onEvent({ method: 'turn/completed', params: { threadId: active.native_id, turn: { id: 'desktop-turn', status: 'completed' } } });
  await host.work.flush(task.id);
  const updates = await host.command('work.read', { projectId: project.id, workItemId });
  const text = updates.entries.map(e => e.summary).join('\n');
  assert.ok(text.includes(`使用团队技能「${task.method.skillName}」v${task.method.version}`));
  assert.match(text, /按团队技能整理完成/);
  assert.ok(!text.includes('PRIVATE_SKILL_HISTORY_NOT_SHARED'));
  assert.ok(!text.includes(root), 'local skill paths never enter the shared conversation');
  assert.equal(updates.entries.find(e => e.summary.includes('按团队技能整理完成')).createdByUserId, memberUserId);
  const current = await request(`/work-items/${workItemId}`, { headers: ownerHeaders });
  const downgraded = await request(`/work-items/${workItemId}`, { method: 'PATCH', headers: { ...ownerHeaders, 'Idempotency-Key': 'skill-work-readonly', 'If-Match': current.headers.get('etag') },
    data: { members: [{ userId: memberUserId, access: 'read', roles: ['watcher'] }] } });
  assert.equal(downgraded.status, 200, JSON.stringify(downgraded.body));
  await assert.rejects(host.command('methods.use', { ...choice, requestId: 'readonly-new-method' }), /只能查看/);
  const count = requests.length;
  await assert.rejects(host.command('session.send', { sessionId: task.id, inputId: 'readonly-follow-up', text: '不能继续执行' }), /无法访问/);
  assert.equal(requests.length, count);
  return { projectId: teamProjectId, workItemId };
}
