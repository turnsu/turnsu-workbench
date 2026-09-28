import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopCloud } from '../cloud.mjs';
import { lockNativeProfile } from '../../agent-runtime/integrations/native/session.mjs';

const origin = 'https://team.example.test';
test('cancelling desktop authorization closes the callback and never saves a credential or exposes PKCE', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-cloud-cancel-'));
  let callback, calls = 0;
  const cloud = new DesktopCloud({ directory, fetch: async (_url, options) => {
    calls++; callback = JSON.parse(options.body).data.redirectUri;
    return new Response(JSON.stringify({ schemaVersion: 'workbench-api-v1', requestId: 'desktop-auth-start', data: {
      authorizationId: 'auth-cancel', expiresAt: new Date(Date.now() + 60000).toISOString(), authorizationUrl: origin + '/native/authorize?authorizationId=auth-cancel',
    } }), { status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } });
  t.after(async () => { await cloud.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await cloud.connect(origin); assert.equal(state.status, 'connecting');
  assert.equal(JSON.stringify(state).includes('codeVerifier'), false);
  const bad = new URL(callback); bad.searchParams.set('authorization_id', 'wrong'); bad.searchParams.set('code', 'a'.repeat(43));
  assert.equal((await fetch(bad)).status, 400);
  await cloud.cancel(); assert.equal(cloud.snapshot().status, 'disconnected'); assert.equal(calls, 1);
  await assert.rejects(stat(cloud.path), { code: 'ENOENT' });
  await assert.rejects(fetch(callback));
});

test('desktop authorization rejects an approval URL on another origin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-cloud-origin-'));
  const cloud = new DesktopCloud({ directory, fetch: async () => new Response(JSON.stringify({ schemaVersion: 'workbench-api-v1', requestId: 'desktop-auth-start', data: {
    authorizationId: 'auth-origin', expiresAt: new Date(Date.now() + 60000).toISOString(), authorizationUrl: 'https://other.example.test/authorize',
  } }), { status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) });
  t.after(async () => { await cloud.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await cloud.connect(origin)).status, 'error'); assert.equal(cloud.authorizationUrl, null);
  await assert.rejects(stat(cloud.path), { code: 'ENOENT' });
});

test('exclusive desktop ownership can recover a dead credential lock but never takes a live owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-cloud-lock-')); const path = join(directory, 'profile');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path + '.lock', '2147483647:dead-test-owner', { mode: 0o600 });
  await assert.rejects(lockNativeProfile(path), /stale_lock/);
  const release = await lockNativeProfile(path, { recoverStaleLock: true });
  await assert.rejects(lockNativeProfile(path, { recoverStaleLock: true }), /in_use/);
  await release();
});

test('a project response arriving after disconnect cannot restore the old team connection', async t => {
  const { writeNativeProfile } = await import('../../agent-runtime/integrations/native/session.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-cloud-delayed-'));
  let deliver, entered; const started = new Promise(resolve => { entered = resolve; });
  const cloud = new DesktopCloud({ directory }); await cloud.ready;
  await writeNativeProfile(cloud.path, { baseUrl: origin, tokens: { accessToken: 'a'.repeat(43), refreshToken: 'b'.repeat(43),
    accessTokenExpiresAt: new Date(Date.now() + 60000).toISOString(), refreshTokenExpiresAt: new Date(Date.now() + 600000).toISOString(),
    clientSessionId: 'native-delayed', workspaceId: 'workspace-delayed' } }, { create: true });
  await cloud.close();
  const response = (data, page) => new Response(JSON.stringify({ schemaVersion: 'workbench-api-v1', requestId: 'delayed-response', data, ...(page ? { page } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const restored = new DesktopCloud({ directory, fetch: async url => {
    if (url.endsWith('/projects')) { entered(); return new Promise(resolve => { deliver = resolve; }); }
    return response({ revoked: true });
  } });
  t.after(async () => { await restored.close(); await rm(directory, { recursive: true, force: true }); });
  const pending = restored.projects(); await started; await restored.disconnect();
  deliver(response([], { hasMore: false, nextCursor: null }));
  assert.equal((await pending).status, 'disconnected'); assert.equal(restored.snapshot().status, 'disconnected');
});

test('an uncertain token rotation asks for new authorization instead of replaying the old credential', async t => {
  const { writeNativeProfile } = await import('../../agent-runtime/integrations/native/session.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'turnsu-cloud-rotation-'));
  await writeNativeProfile(join(directory, 'cloud-session.json'), { baseUrl: origin, refreshPending: true,
    tokens: { accessToken: 'a'.repeat(43), refreshToken: 'b'.repeat(43), accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 60000).toISOString(), clientSessionId: 'native-rotation', workspaceId: 'workspace-rotation' } }, { create: true });
  let calls = 0; const cloud = new DesktopCloud({ directory, fetch: async () => { calls++; throw new Error('must not replay'); } });
  t.after(async () => { await cloud.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await cloud.projects()).status, 'disconnected'); assert.equal(calls, 0);
  await assert.rejects(stat(cloud.path), { code: 'ENOENT' });
});
