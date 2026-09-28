import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Called inside the native PKCE/HTTP/PostgreSQL fixture, using its two independent local folders.
export async function verifyFileDeletions({ owner, member, cloud, other }) {
  const path = 'delete-acceptance.md', local = client => join(client.path, path);
  await writeFile(local(owner), '团队需要保留的原稿'); await owner.sync.sync(owner.id); await member.sync.sync(member.id);
  const original = owner.sync.file(owner.id, path).revision_id;
  await rm(local(owner)); await owner.sync.sync(owner.id); await member.sync.sync(member.id);
  const deleted = owner.sync.file(owner.id, path).revision_id;
  assert.ok(owner.sync.file(owner.id, path).deleted); assert.ok(member.sync.file(member.id, path).deleted);
  await assert.rejects(readFile(local(member)), { code: 'ENOENT' });
  const binding = owner.sync.binding(owner.id);
  assert.equal(Buffer.from((await owner.sync.call(binding, 'turnsu_project_file', { pathParams: { revisionId: original } })).data.contentBase64, 'base64').toString(), '团队需要保留的原稿');
  assert.equal((await owner.sync.call(binding, 'turnsu_project_file', { pathParams: { revisionId: deleted } })).data.deleted, true);
  await member.sync.resolve(member.id, path, 'restore', deleted); await owner.sync.sync(owner.id);
  assert.equal(await readFile(local(owner), 'utf8'), '团队需要保留的原稿');
  // A lost deletion acknowledgement is retried against the original baseline/key, not a new write.
  await rm(local(member)); const send = other.fileCall.bind(other); let lose = true, submissions = [];
  other.fileCall = async (...args) => {
    const result = await send(...args);
    if (args[1] === 'turnsu_commit_project_file' && args[2].data.deleted) {
      submissions.push(structuredClone(args[2]));
      if (lose) { lose = false; throw new Error('deletion committed but acknowledgement lost'); }
    }
    return result;
  };
  assert.equal((await member.sync.sync(member.id)).pending, 1);
  await member.sync.sync(member.id); other.fileCall = send;
  assert.deepEqual(submissions[0], submissions[1]);
  // Owner edits its original file before receiving the deletion. Both versions must remain.
  await writeFile(local(owner), '尚未收到删除时的新修改');
  const conflict = await owner.sync.sync(owner.id); assert.equal(conflict.status, 'conflict');
  assert.equal(await readFile(local(owner), 'utf8'), '尚未收到删除时的新修改');
  const entry = conflict.conflicts.find(item => item.path === path); assert.ok(entry.headDeleted);
  await assert.rejects(owner.sync.resolve(owner.id, path, 'team', original), /已变化/);
  await owner.sync.resolve(owner.id, path, 'local', entry.headRevisionId); await member.sync.sync(member.id);
  assert.equal(await readFile(local(member), 'utf8'), '尚未收到删除时的新修改');
  assert.equal(owner.sync.file(owner.id, path).deleted, 0);
  await rm(local(owner)); await owner.sync.sync(owner.id);
  await writeFile(local(member), '需要保留的冲突修改'); await member.sync.sync(member.id);
  const unresolved = await owner.sync.sync(owner.id);
  await owner.sync.resolve(owner.id, path, 'local', unresolved.conflicts.find(item => item.path === path).headRevisionId);
  assert.equal((await member.sync.sync(member.id)).status, 'synced');
  await assert.rejects(readFile(local(member)), { code: 'ENOENT' });
  // A deletion resolution may point to an earlier deletion; restore still locates real content.
  await owner.sync.resolve(owner.id, path, 'restore', owner.sync.file(owner.id, path).revision_id);
  await member.sync.sync(member.id);
  assert.equal(await readFile(local(member), 'utf8'), '尚未收到删除时的新修改');
}
