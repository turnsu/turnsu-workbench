import assert from 'node:assert/strict';
import { verifyWorkItemResults } from './verify-work-item-results.mjs';
import { verifyProjectFileTombstones } from './verify-project-file-tombstones.mjs';
import { verifyDesktopProjectCreate } from './verify-desktop-project-create.mjs';
import { verifyProjectMemberManagement } from './verify-project-member-management.mjs';
import { verifyCrossWorkReferences } from './verify-cross-work-references.mjs';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { FilesystemObjectStore } from '../../src/storage/filesystem-object-store.mjs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { verifyTeamWork } from '../../../../packages/agent-host/test/verify-team-work.mjs';
import { verifyFileDeletions } from '../../../../packages/agent-host/test/verify-file-deletions.mjs';
import { verifySelectedShare } from '../../../../packages/agent-host/test/verify-selected-share.mjs';
import { verifyDesktopProjectCreationFlow } from '../../../../packages/agent-host/test/verify-desktop-project-creation-flow.mjs';
import { verifyDesktopProjectMembersFlow } from '../../../../packages/agent-host/test/verify-desktop-project-members-flow.mjs';
import { verifyCrossWorkDesktop } from '../../../../packages/agent-host/test/verify-cross-work-desktop.mjs';
import { SharedFiles } from '../../../../packages/agent-host/shared-files.mjs';
import { openStore } from '../../../../packages/agent-host/store.mjs';
import { DesktopCloud } from '../../../../packages/agent-host/cloud.mjs';
import { ProductPostgresStore } from '../../src/store/postgres/index.mjs';
import { PostgresWorkbenchSessionStore } from '../../src/security/postgres-workbench-session-store.mjs';
import { HmacIdentityTokenSigner } from '../../src/auth/hmac-identity-token-signer.mjs';
import { AuthService } from '../../src/auth/auth-service.mjs';
import { createWorkbenchApplication } from '../../src/application/workbench-application.mjs';
import { createWorkbenchHttpHandler } from '../../src/http/workbench-http-handler.mjs';
import { PostgresAgentCommandAuthorizer, createPostgresIdempotentMutationPort } from '../../src/coordination/index.mjs';
import { PostgresTeamWorkLifecycle } from '../../src/work-items/postgres-team-work-lifecycle.mjs';
import { PostgresWorkItemPromotionLifecycle } from '../../src/work-items/postgres-work-item-promotion-lifecycle.mjs';

test('two native members synchronize files, continue declared team work, and respect revoked access', { skip: process.env.WORKBENCH_POSTGRES_INTEGRATION !== '1', timeout: process.env.TURNSU_FILE_DESKTOP_UI_STATE ? 1250000 : 120000 }, async t => {
  const connectionString = process.env.WORKBENCH_POSTGRES_URL;
  assert.match(new URL(connectionString).pathname, /_test$/);
  const pool = new Pool({ connectionString, max: 5 });
  const store = new ProductPostgresStore({ pool }); await store.runMigrations();
  const directory = await mkdtemp('/private/tmp/turnsu-desktop-cloud-');
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionStore = new PostgresWorkbenchSessionStore({ store });
  const invitations = [];
  const auth = new AuthService({ store, persistence: store.createAuthPersistence(), workspaceId: 'desktop-cloud-workspace',
    workspaceName: 'Desktop cloud acceptance', bootstrapAdminToken: 'desktop-test-bootstrap', bcryptCost: 10,
    nativeClientSessions: store.createNativeClientSessionStore(), publicOrigin: origin,
    invitationTokenSigner: new HmacIdentityTokenSigner({ secret: '0123456789abcdef0123456789abcdef' }), invitationBaseUrl: 'https://workspace.example.test',
    invitationMailer: { async sendWorkspaceInvitation(message) { invitations.push(message); return { receiptId: 'file-test-delivery' }; } },
    oauthProviders: { google: {
      async authorizationUrl({ state }) { return `https://identity.example.test/authorize?state=${encodeURIComponent(state)}`; },
      async complete() { return { provider: 'google', providerSubject: 'file-member', verifiedEmail: 'member@example.test' }; },
    } },
  });
  const authorizer = new PostgresAgentCommandAuthorizer({ store });
  const objectStore = await new FilesystemObjectStore({ rootDir: join(directory, 'objects') }).initialize();
  const team = new PostgresTeamWorkLifecycle({ store, objectStore, promotionLifecycle: new PostgresWorkItemPromotionLifecycle({ store, commandAuthorizer: authorizer,
    agentTurnRunner: { createSession() { throw new Error('No model execution in connection acceptance'); } } }) });
  const application = createWorkbenchApplication({ store, workspaceReadModel: store.createWorkspaceReadModel(), workspaceAuthorizer: store.createAuthPersistence(),
    idempotentMutationPort: createPostgresIdempotentMutationPort({ store }), workItemLifecycle: team });
  server.on('request', createWorkbenchHttpHandler({ application, authService: auth, sessionStore, origin, allowedHosts: ['127.0.0.1'], internalErrorReporter: e => t.diagnostic(JSON.stringify(e)) }));
  let cloud = new DesktopCloud({ directory }); const clients = [cloud], synchronizers = [], nativeHosts = [];
  t.after(async () => { for (const host of nativeHosts) await host.close(); for (const s of synchronizers) { await s.sync.close(); s.store.close(); } await Promise.all(clients.map(c => c.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close(); await pool.end(); await rm(directory, { recursive: true, force: true }); });
  const post = async (path, data, extra = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...extra }, body: JSON.stringify({ schemaVersion: 'workbench-api-v1', data }) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return { response, body };
  };
  const registered = await post('/api/workbench/v1/auth/register', { username: 'desktopowner', password: 'desktop-test-password-123', bootstrapToken: 'desktop-test-bootstrap' }, { 'Idempotency-Key': 'desktop-owner-register' });
  const cookie = registered.response.headers.get('set-cookie').split(';')[0];
  const browser = await sessionStore.get(cookie.split('=')[1]);
  const browserHeaders = { Cookie: cookie, 'X-Workbench-CSRF': browser.csrfToken };
  await post('/api/workbench/v1/workspace/invitations', { email: 'member@example.test' }, { ...browserHeaders, 'Idempotency-Key': 'file-invite' });
  assert.equal((await auth.deliverInvitationOutbox({ limit: 1 })).delivered, 1);
  const token = new URLSearchParams(new URL(invitations[0].invitationUrl).hash.slice(1)).get('token');
  const oauth = await post('/api/workbench/v1/auth/oauth/google/start', { token });
  const state = new URL(oauth.body.data.authorizationUrl).searchParams.get('state');
  const login = await fetch(origin + `/api/workbench/v1/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=verified-provider-code`);
  const member = (await login.json()).data;
  const memberCookie = login.headers.get('set-cookie').split(';')[0];
  const memberSession = await sessionStore.get(memberCookie.split('=')[1]);
  const memberHeaders = { Cookie: memberCookie, 'X-Workbench-CSRF': memberSession.csrfToken };
  const created = await post('/api/workbench/v1/projects', { title: '共享文件验收', objective: '两位成员独立修改结果', members: [{ userId: member.user.userId }] }, { ...browserHeaders, 'Idempotency-Key': 'file-project-create' });
  const projectId = created.body.data.projectId;
  async function authorize(client, headers) {
    await client.connect(origin);
    const authorizationId = new URL(client.authorizationUrl).searchParams.get('authorizationId');
    const approved = await post('/api/workbench/v1/auth/native/approve', { authorizationId }, headers);
    assert.equal((await fetch(approved.body.data.redirectUrl)).status, 200); await client.login;
    assert.equal(client.snapshot().status, 'connected', JSON.stringify(client.snapshot()));
  }
  await authorize(cloud, browserHeaders);
  const otherDir = join(directory, 'member'); const { mkdir } = await import('node:fs/promises'); await mkdir(otherDir, { mode: 0o700 });
  const other = new DesktopCloud({ directory: otherDir }); clients.push(other); await authorize(other, memberHeaders);
  await verifyProjectFileTombstones({origin,pool,owner:cloud,member:other,ownerHeaders:browserHeaders,memberUserId:member.user.userId});
  const input = (text, baseRevisionId = null, path = 'results/feedback.md') => ({ path, baseRevisionId, mediaType: 'text/markdown', contentBase64: Buffer.from(text).toString('base64') });
  const commit = async (client, data, key) => (await client.session.product.call('turnsu_commit_project_file', { pathParams: { projectId }, data, idempotencyKey: key }, { signal: AbortSignal.timeout(15000) })).data;
  const read = async (client, revisionId) => (await client.session.product.call('turnsu_project_file', { pathParams: { projectId, revisionId } }, { signal: AbortSignal.timeout(15000) })).data;
  const list = async client => (await client.session.product.call('turnsu_project_files', { pathParams: { projectId } }, { signal: AbortSignal.timeout(15000) })).data;
  const initial = await commit(cloud, input('原始反馈'), 'initial-file');
  assert.equal(initial.revision.outcome, 'synced');
  assert.equal(Buffer.from((await read(other, initial.revision.revisionId)).contentBase64, 'base64').toString(), '原始反馈');
  const firstId = initial.revision.revisionId;
  const [left, right] = await Promise.all([commit(cloud, input('甲的整理', firstId), 'left-file'), commit(other, input('乙的整理', firstId), 'right-file')]);
  assert.deepEqual([left.revision.outcome, right.revision.outcome].sort(), ['conflict', 'synced']);
  const winner = left.revision.outcome === 'synced' ? left : right;
  const conflict = left.revision.outcome === 'conflict' ? left : right;
  const listed = await list(other); assert.equal(listed.length, 2);
  assert.equal(listed.find(f => f.outcome === 'synced').revisionId, winner.revision.revisionId);
  assert.equal(listed.find(f => f.outcome === 'conflict').headRevisionId, winner.revision.revisionId);
  assert.equal((await commit(other, input('乙的整理', firstId), 'right-file')).revision.revisionId, right.revision.revisionId);
  assert.equal((await list(cloud)).length, 2, 'retry must not create another conflict');
  assert.equal(Buffer.from((await read(cloud, left.revision.revisionId)).contentBase64, 'base64').toString(), '甲的整理');
  assert.equal(Buffer.from((await read(cloud, right.revision.revisionId)).contentBase64, 'base64').toString(), '乙的整理');
  const resolved = await commit(other, { ...input('合并后的结论', winner.revision.revisionId), resolvesRevisionIds: [conflict.revision.revisionId] }, 'resolved-file');
  assert.equal(resolved.revision.outcome, 'synced'); assert.equal((await list(cloud)).length, 1);
  assert.equal(Buffer.from((await read(other, firstId)).contentBase64, 'base64').toString(), '原始反馈', 'old versions remain readable');
  const binary = Buffer.from([0, 1, 255, 254, 127]);
  const binaryReceipt = await commit(cloud, { path: 'assets/result.bin', baseRevisionId: null, mediaType: 'application/octet-stream', contentBase64: binary.toString('base64') }, 'binary-file');
  assert.deepEqual(Buffer.from((await read(other, binaryReceipt.revision.revisionId)).contentBase64, 'base64'), binary);
  await assert.rejects(pool.query('UPDATE public.project_file_revisions SET path=$1 WHERE revision_id=$2', ['tampered.md', firstId]), /project_file_revision_immutable/);
  await assert.rejects(pool.query('UPDATE public.project_file_heads SET revision_id=$1 WHERE project_id=$2 AND path_key=$3', [firstId, projectId, 'results/feedback.md']), /project_file_head_base_conflict/);
  const privateProject = await post('/api/workbench/v1/projects', { title: '另一个项目', objective: '隔离成员权限', members: [] }, { ...browserHeaders, 'Idempotency-Key': 'file-private-project' });
  await assert.rejects(other.session.product.call('turnsu_project_files', { pathParams: { projectId: privateProject.body.data.projectId } }), e => e.status === 404);
  await assert.rejects(cloud.session.product.call('turnsu_commit_project_file', { pathParams: { projectId: privateProject.body.data.projectId }, data: input('wrong project', firstId), idempotencyKey: 'wrong-project-base' }), e => e.status === 400);
  for (const path of ['../secret', '.env', 'folder/../../secret', 'C:/secret', 'results/Feedback.md']) {
    await assert.rejects(commit(other, input('not allowed', null, path), 'invalid-' + Buffer.from(path).toString('hex')), e => e.status === 400 || e.status === 409);
  }
  await assert.rejects(commit(other, input('different retry', firstId), 'right-file'));
  // The same native HTTP contract now drives actual independent desktop folders and durable SQLite.
  async function desktop(name, client) {
    const path = join(directory, name), data = join(directory, name + '-state'); await mkdir(path); await mkdir(data, { mode: 0o700 });
    const localStore = openStore(data); localStore.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(name, path, name, Date.now());
    const sync = new SharedFiles({ db: localStore.db, cloud: client, project: () => ({ path }) });
    synchronizers.push({ sync, store: localStore }); await sync.attach(name, projectId);
    return { sync, path, id: name };
  }
  const desktopOwner = await desktop('owner-files', cloud), desktopMember = await desktop('member-files', other);
  for (const desktop of [desktopOwner, desktopMember]) {
    const state = await desktop.sync.sync(desktop.id); assert.equal(state.status, 'synced', JSON.stringify(state));
    assert.equal(await readFile(join(desktop.path, 'results/feedback.md'), 'utf8'), '合并后的结论');
    assert.deepEqual(await readFile(join(desktop.path, 'assets/result.bin')), binary);
  }
  await writeFile(join(desktopOwner.path, 'desktop.md'), '桌面共享初稿'); await desktopOwner.sync.sync(desktopOwner.id); await desktopMember.sync.sync(desktopMember.id);
  assert.equal(await readFile(join(desktopMember.path, 'desktop.md'), 'utf8'), '桌面共享初稿');
  await writeFile(join(desktopOwner.path, 'desktop.md'), '桌面甲的修改'); await writeFile(join(desktopMember.path, 'desktop.md'), '桌面乙的修改');
  await desktopOwner.sync.sync(desktopOwner.id);
  assert.equal((await desktopMember.sync.sync(desktopMember.id)).status, 'conflict');
  assert.equal(await readFile(join(desktopMember.path, 'desktop.md'), 'utf8'), '桌面乙的修改');
  await desktopMember.sync.resolve(desktopMember.id, 'desktop.md', 'local');
  assert.equal((await desktopOwner.sync.sync(desktopOwner.id)).status, 'synced');
  assert.equal(await readFile(join(desktopOwner.path, 'desktop.md'), 'utf8'), '桌面乙的修改');
  await verifyFileDeletions({owner:desktopOwner,member:desktopMember,cloud,other});
  await verifySelectedShare({directory,owner:cloud,member:other,projectId});
  await verifyDesktopProjectCreationFlow({directory,owner:cloud,member:other,memberUserId:member.user.userId,pool});
  await verifyProjectMemberManagement({owner:cloud,member:other,memberUserId:member.user.userId,pool});
  await verifyDesktopProjectMembersFlow({directory,owner:cloud,member:other,memberUserId:member.user.userId,pool});
  await verifyCrossWorkReferences({owner:cloud,member:other,memberUserId:member.user.userId,pool});
  await verifyCrossWorkDesktop({directory,owner:cloud,member:other,memberUserId:member.user.userId});
  const reviewedResult=await verifyWorkItemResults({origin,pool,nativeMember:other,ownerHeaders:browserHeaders,memberHeaders,projectId,memberUserId:member.user.userId,revisionId:resolved.revision.revisionId});
  await verifyTeamWork({ directory, projectId, owner: cloud, member: other, hosts: nativeHosts, post, browserHeaders, memberUserId: member.user.userId, origin });
  // Revocation uses the existing Product membership mutation, not direct ACL edits.
  const project = await fetch(origin + `/api/workbench/v1/projects/${projectId}`, { headers: { Cookie: cookie } });
  const revision = project.headers.get('etag');
  const changed = await fetch(origin + `/api/workbench/v1/projects/${projectId}/members`, { method: 'PUT', headers: { ...browserHeaders, 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'If-Match': revision, 'Idempotency-Key': 'remove-file-member' }, body: JSON.stringify({ schemaVersion: 'workbench-api-v1', data: { members: [] } }) });
  assert.equal(changed.status, 200, await changed.text());
  await writeFile(join(desktopMember.path, 'after-revocation.md'), '应保留在本机');
  assert.equal((await desktopMember.sync.sync(desktopMember.id)).status, 'access');
  assert.equal((await list(cloud)).some(f => f.path === 'after-revocation.md'), false);
  await assert.rejects(other.fileCall(await other.identity(),'turnsu_work_entry',{pathParams:reviewedResult.projectRevocationEntry}),e=>e.status===404);
  await assert.rejects(read(other, firstId), e => e.status === 404);
  await assert.rejects(commit(other, input('乙的整理', firstId), 'right-file'), e => e.status === 404);
  await assert.rejects(commit(other, input('revoked', resolved.revision.revisionId), 'revoked-file'), e => e.status === 404);
  assert.equal(Buffer.from((await read(cloud, resolved.revision.revisionId)).contentBase64, 'base64').toString(), '合并后的结论');
  // Optional real native-window acceptance. The desktop uses its normal host and Product API;
  // this fixture only supplies an isolated account/server and waits for the operator to finish.
  const uiState = process.env.TURNSU_FILE_DESKTOP_UI_STATE;
  if (uiState) process.stderr.write('Native window fixture preparing\n');
  if (uiState) {
    assert.match(uiState, /^\/private\/tmp\/turnsu-file-ui-[a-z0-9-]+$/);
    await mkdir(uiState, { mode: 0o700 });
    const uiCloud = new DesktopCloud({ directory: uiState });
    await authorize(uiCloud, browserHeaders); await uiCloud.close();
    process.stderr.write('Native window fixture authorized\n');
    await writeFile(join(uiState, 'ready.json'), JSON.stringify({ origin, projectId, title: '共享文件验收' }), { mode: 0o600 });
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      if (await stat(join(uiState, 'finished')).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  // Last: workspace revocation intentionally invalidates the creator authority epoch.
  const createDir = join(directory, 'project-creator'); await mkdir(createDir, { mode: 0o700 });
  const creator = new DesktopCloud({ directory: createDir }); clients.push(creator); await authorize(creator, browserHeaders);
  await verifyDesktopProjectCreate({ owner: creator, member: other, pool, ownerUserId: registered.body.data.user.userId, memberUserId: member.user.userId,
    reauthorize: async client => { await client.close(); await rm(client.path, { force: true }); client.session = null; await authorize(client, browserHeaders); } });

});
