import assert from 'node:assert/strict';

export async function verifyDesktopProjectCreate({ owner, member, pool, ownerUserId, memberUserId, reauthorize }) {
  const identity = await owner.identity();
  const create = (client, data, idempotencyKey) => client.session.desktop.call('createProject', { data, idempotencyKey });
  const read = (client, projectId) => client.session.product.call('turnsu_project', { pathParams: { projectId } });
  const people = await owner.session.product.call('turnsu_work_people');
  assert.ok(people.data.some(person => person.userId === memberUserId));
  assert.ok(people.data.every(person => Object.keys(person).every(key => ['userId', 'displayName', 'username', 'role'].includes(key))));
  const input = { title: 'Desktop selected members', objective: 'Explicit shared audience', members: [{ userId: memberUserId }] };
  const key = 'desktop-project-explicit-members';
  const first = await create(owner, input, key);
  assert.equal(first.data.accountableOwnerUserId, ownerUserId);
  assert.deepEqual([...first.data.members].sort((a,b) => a.userId.localeCompare(b.userId)), [{ userId: ownerUserId, role: 'owner' }, { userId: memberUserId, role: 'member' }].sort((a,b) => a.userId.localeCompare(b.userId)));
  assert.ok(first.etag);
  assert.deepEqual((await read(member, first.data.projectId)).data, first.data);
  assert.deepEqual((await create(owner, input, key)).data, first.data);
  await assert.rejects(create(owner, { ...input, title: 'Changed retry' }, key), error => error.status === 409);
  const privateProject = await create(owner, { ...input, members: [] }, 'desktop-project-unselected-members');
  await assert.rejects(read(member, privateProject.data.projectId), error => error.status === 404);
  await assert.rejects(create(member, input, 'desktop-project-member-denied'), error => error.status === 403);
  await assert.rejects(create(owner, { ...input, members: [{ userId: 'foreign-workspace-user' }] }, 'desktop-project-foreign-member'), error => error.status === 404 || error.status === 400);
  await assert.rejects(owner.session.product.call('createProject', { data: input, idempotencyKey: 'agent-must-not-create' }), /native_product_tool_input_invalid/);
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM projects WHERE project_id=$1', [first.data.projectId])).rows[0].n;
  assert.equal(await count(), 1);

  // A current native identity and current workspace authority are required even for a saved receipt.
  const membershipRequest = { pathParams: { projectId: first.data.projectId }, data: { members: [{ userId: memberUserId }] }, ifMatch: first.etag, idempotencyKey: 'creator-membership-receipt' };
  const membershipReceipt = await owner.session.desktop.call('reviseProjectMembers', membershipRequest);
  await owner.session.revoke();
  await assert.rejects(create(owner, input, key), error => error.status === 401);
  await assert.rejects(owner.session.desktop.call('reviseProjectMembers', membershipRequest), error => error.status === 401);
  await reauthorize(owner);
  assert.deepEqual((await create(owner, input, key)).data, first.data);
  assert.deepEqual((await owner.session.desktop.call('reviseProjectMembers', membershipRequest)).data, membershipReceipt.data);
  await pool.query("UPDATE workspace_memberships SET role='member', revision=revision+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [identity.workspaceId, ownerUserId]);
  try { await assert.rejects(create(owner, input, key), error => error.status === 403); }
  finally { await pool.query("UPDATE workspace_memberships SET role='owner', revision=revision+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [identity.workspaceId, ownerUserId]); }
  await assert.rejects(create(owner, input, key), error => error.code === 'team_work_personal_authority_unavailable');
  await assert.rejects(owner.session.desktop.call('reviseProjectMembers', membershipRequest), error => error.code === 'team_work_personal_authority_unavailable');
  await pool.query("UPDATE workspace_memberships SET status='suspended', suspended_at=clock_timestamp(), revision=revision+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [identity.workspaceId, ownerUserId]);
  try { await assert.rejects(create(owner, input, key), error => error.status === 401 || error.status === 403); }
  finally { await pool.query("UPDATE workspace_memberships SET status='active', suspended_at=NULL, revision=revision+1, updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [identity.workspaceId, ownerUserId]); }
  assert.equal(await count(), 1);
}
