import assert from 'node:assert/strict';

export async function verifyProjectMemberManagement({ owner, member, memberUserId, pool }) {
  const product = (client, name, input = {}) => client.session.product.call(name, input);
  const created = await owner.session.desktop.call('createProject', { idempotencyKey: 'member-management-project', data: {
    title: 'Manage explicit project audience', objective: 'Revoke current access without deleting history', members: [{ userId: memberUserId }],
  } });
  const projectId = created.data.projectId;
  const revise = (client, members, ifMatch, idempotencyKey) => client.session.desktop.call('reviseProjectMembers', {
    pathParams: { projectId }, data: { members }, ifMatch, idempotencyKey,
  });
  await assert.rejects(revise(member, [], created.etag, 'member-cannot-manage'), error => error.status === 403);
  const work = await product(owner, 'turnsu_create_work', { idempotencyKey: 'member-management-work', data: {
    projectId, title: 'Existing team work', objective: 'Shared result', summary: 'Keep fixed source',
    members: [{ userId: memberUserId, access: 'contribute', roles: ['participant'] }],
  } });
  const workItemId = work.data.workItemId;
  const commentRequest = { pathParams: { workItemId }, idempotencyKey: 'member-management-comment', data: { content: 'A shared result retained after revocation' } };
  const entry = await product(member, 'turnsu_submit_update', commentRequest);
  const fileRequest = { pathParams: { projectId }, idempotencyKey: 'member-management-file', data: {
    path: 'result.txt', baseRevisionId: null, mediaType: 'text/plain', contentBase64: Buffer.from('Retained result').toString('base64'),
  } };
  const file = await product(member, 'turnsu_commit_project_file', fileRequest);
  assert.ok((await product(member, 'turnsu_work_updates', { pathParams: { workItemId } })).data.some(value => value.entryId === entry.data.entryId));
  const removed = await revise(owner, [], created.etag, 'member-management-remove');
  assert.deepEqual(removed.data.members, [{ userId: created.data.accountableOwnerUserId, role: 'owner' }]);
  assert.deepEqual((await revise(owner, [], created.etag, 'member-management-remove')).data, removed.data);
  await assert.rejects(revise(owner, [], removed.etag, 'member-management-remove'), error => error.status === 409);
  await assert.rejects(revise(owner, [{ userId: memberUserId }], created.etag, 'member-management-stale'), error => error.status === 412);
  await assert.rejects(revise(owner, [{ userId: 'unrelated-workspace-user' }], removed.etag, 'member-management-outsider'), error => [400,404].includes(error.status));
  // An old independent Work Item grant cannot bypass current Project membership.
  await assert.rejects(product(member, 'turnsu_work_updates', { pathParams: { workItemId } }), error => error.status === 404);
  await assert.rejects(product(member, 'turnsu_work_context', { pathParams: { workItemId } }), error => error.status === 404);
  await assert.rejects(product(member, 'turnsu_work_entry', { pathParams: { workItemId, entryId: entry.data.entryId } }), error => error.status === 404);
  await assert.rejects(product(member, 'turnsu_submit_update', commentRequest), error => error.status === 404);
  await assert.rejects(product(member, 'turnsu_project_file', { pathParams: { projectId, revisionId: file.data.revision.revisionId } }), error => error.status === 404);
  await assert.rejects(product(member, 'turnsu_commit_project_file', fileRequest), error => error.status === 404);
  assert.equal((await product(owner, 'turnsu_work_entry', { pathParams: { workItemId, entryId: entry.data.entryId } })).data.summary, entry.data.summary);
  assert.equal((await pool.query('SELECT status FROM work_item_access_grants WHERE work_item_id=$1 AND user_id=$2', [workItemId, memberUserId])).rows[0].status, 'active', 'historical Work grant is retained but cannot confer current Project access');
  const restored = await revise(owner, [{ userId: memberUserId }], removed.etag, 'member-management-add-back');
  assert.ok((await product(member, 'turnsu_work_updates', { pathParams: { workItemId } })).data.some(value => value.entryId === entry.data.entryId));
  assert.deepEqual((await revise(owner, [], created.etag, 'member-management-remove')).data, removed.data, 'old receipt does not execute removal again');
  assert.deepEqual((await product(member, 'turnsu_project', { pathParams: { projectId } })).data, restored.data);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_lifecycle_events WHERE project_id=$1 AND kind='project_members_revise'", [projectId])).rows[0].n, 2);
  await assert.rejects(product(owner, 'reviseProjectMembers', { pathParams: { projectId }, data: { members: [] }, ifMatch: restored.etag, idempotencyKey: 'agent-membership-denied' }), /native_product_tool_input_invalid/);
}
