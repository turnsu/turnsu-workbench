import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { Pool } from 'pg';
import { DesktopCloud } from '../../../../../agent/code/local-agent-host/cloud.mjs';
import { ProductPostgresStore } from '../../src/store/postgres/index.mjs';
import { PostgresWorkbenchSessionStore } from '../../src/security/postgres-workbench-session-store.mjs';
import { AuthService } from '../../src/auth/auth-service.mjs';
import { createWorkbenchApplication } from '../../src/application/workbench-application.mjs';
import { createWorkbenchHttpHandler } from '../../src/http/workbench-http-handler.mjs';
import { PostgresAgentCommandAuthorizer, createPostgresIdempotentMutationPort } from '../../src/coordination/index.mjs';
import { PostgresTeamWorkLifecycle } from '../../src/work-items/postgres-team-work-lifecycle.mjs';
import { PostgresWorkItemPromotionLifecycle } from '../../src/work-items/postgres-work-item-promotion-lifecycle.mjs';

test('desktop browser authorization opens actual team projects, survives restart and rejects revoked access', { skip: process.env.WORKBENCH_POSTGRES_INTEGRATION !== '1' }, async t => {
  const connectionString = process.env.WORKBENCH_POSTGRES_URL;
  assert.match(new URL(connectionString).pathname, /_test$/);
  const pool = new Pool({ connectionString, max: 5 });
  const store = new ProductPostgresStore({ pool }); await store.runMigrations();
  const directory = await mkdtemp('/private/tmp/turnsu-desktop-cloud-');
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionStore = new PostgresWorkbenchSessionStore({ store });
  const auth = new AuthService({ store, persistence: store.createAuthPersistence(), workspaceId: 'desktop-cloud-workspace',
    workspaceName: 'Desktop cloud acceptance', bootstrapAdminToken: 'desktop-test-bootstrap', bcryptCost: 10,
    nativeClientSessions: store.createNativeClientSessionStore(), publicOrigin: origin });
  const authorizer = new PostgresAgentCommandAuthorizer({ store });
  const team = new PostgresTeamWorkLifecycle({ store, promotionLifecycle: new PostgresWorkItemPromotionLifecycle({ store, commandAuthorizer: authorizer,
    agentTurnRunner: { createSession() { throw new Error('No model execution in connection acceptance'); } } }) });
  const application = createWorkbenchApplication({ store, workspaceReadModel: store.createWorkspaceReadModel(), workspaceAuthorizer: store.createAuthPersistence(),
    idempotentMutationPort: createPostgresIdempotentMutationPort({ store }), workItemLifecycle: team });
  server.on('request', createWorkbenchHttpHandler({ application, authService: auth, sessionStore, origin, allowedHosts: ['127.0.0.1'] }));
  let cloud = new DesktopCloud({ directory });
  t.after(async () => { await cloud.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close(); await pool.end(); await rm(directory, { recursive: true, force: true }); });
  const post = async (path, data, extra = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...extra }, body: JSON.stringify({ schemaVersion: 'workbench-api-v1', data }) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return { response, body };
  };
  const registered = await post('/api/workbench/v1/auth/register', { username: 'desktopowner', password: 'desktop-test-password-123', bootstrapToken: 'desktop-test-bootstrap' }, { 'Idempotency-Key': 'desktop-owner-register' });
  const cookie = registered.response.headers.get('set-cookie').split(';')[0];
  const browser = await sessionStore.get(cookie.split('=')[1]);
  const browserHeaders = { Cookie: cookie, 'X-Workbench-CSRF': browser.csrfToken };
  const created = await post('/api/workbench/v1/projects', { title: '桌面共享项目', objective: '通过自己的 Agent 继续团队工作', members: [] }, { ...browserHeaders, 'Idempotency-Key': 'desktop-create-project' });
  const initial = await cloud.connect(origin); assert.equal(initial.status, 'connecting');
  assert.equal(JSON.stringify(initial).includes('accessToken'), false);
  const authorizationId = new URL(cloud.authorizationUrl).searchParams.get('authorizationId');
  const approved = await post('/api/workbench/v1/auth/native/approve', { authorizationId }, browserHeaders);
  assert.equal((await fetch(approved.body.data.redirectUrl)).status, 200);
  await cloud.login;
  assert.equal(cloud.snapshot().status, 'connected', JSON.stringify(cloud.snapshot()));
  assert.equal(cloud.snapshot().projects[0].title, '桌面共享项目');
  assert.equal((await cloud.project(created.body.data.projectId)).objective, '通过自己的 Agent 继续团队工作');
  assert.equal((await stat(cloud.path)).mode & 0o077, 0);
  const profile = JSON.parse(await readFile(cloud.path, 'utf8'));
  assert.equal(JSON.stringify(cloud.snapshot()).includes(profile.tokens.accessToken), false);
  await cloud.close(); cloud = new DesktopCloud({ directory }); await cloud.ready;
  assert.equal((await cloud.projects()).projects[0].projectId, created.body.data.projectId);
  const revoked = await post(`/api/workbench/v1/auth/native/sessions/${profile.tokens.clientSessionId}/revoke`, {}, browserHeaders);
  assert.equal(revoked.body.data.revoked, true);
  const inaccessible = await cloud.projects(); assert.equal(inaccessible.status, 'disconnected'); assert.deepEqual(inaccessible.projects, []);
  await assert.rejects(cloud.project(created.body.data.projectId));
  assert.equal((await cloud.connect(origin)).status, 'connecting', 'revoked credentials must not block a new authorization');
  await cloud.cancel(); assert.equal(cloud.snapshot().status, 'disconnected');
});
