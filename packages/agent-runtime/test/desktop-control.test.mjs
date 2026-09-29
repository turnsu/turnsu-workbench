import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeProductSession, writeNativeProfile } from '../integrations/native/session.mjs';
import { NATIVE_PRODUCT_TOOLS } from '../integrations/native/product-tools.mjs';

const envelope = data => new Response(JSON.stringify({ schemaVersion: 'workbench-api-v1', requestId: 'test-request', data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
test('desktop consent uses the same rotating native credential but never becomes an Agent tool', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-desktop-control-')), path = join(root, 'session.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokens = { accessToken: 'a'.repeat(43), refreshToken: 'b'.repeat(43), accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(), refreshTokenExpiresAt: new Date(Date.now() + 60000).toISOString(), clientSessionId: 'native-test', workspaceId: 'workspace-test' };
  await writeNativeProfile(path, { baseUrl: 'http://127.0.0.1:8798', tokens }, { create: true });
  let refreshes = 0; const requests = [];
  const session = await openNativeProductSession(path, { desktopControl: true, fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.data?.refreshToken) { refreshes++; return envelope({ ...tokens, accessToken: 'c'.repeat(43), refreshToken: 'd'.repeat(43), accessTokenExpiresAt: new Date(Date.now() + 60000).toISOString() }); }
    requests.push({ url, authorization: options.headers.get('Authorization'), body }); throw new Error('controlled transport');
  } });
  try {
    const input = { pathParams: { workItemId: 'work', requestId: 'request' }, idempotencyKey: 'explicit-desktop-consent', data: {
      confirm: true, requestDigest: 'sha256:' + 'a'.repeat(64), deviceId: 'device', profile: 'pi-declared-text-v1', selectedModel: { provider: 'pi-test', modelId: 'model' },
      limits: { timeoutMs: 30000, maxModelRequests: 3, maxOutputTokens: 512, maxOutputBytes: 2000 } } };
    await assert.rejects(session.desktop.call('acceptMemberAgentRequest', input), { code: 'product_client_transport_failed' });
    await assert.rejects(session.product.call('turnsu_projects'), { code: 'product_client_transport_failed' });
    assert.equal(refreshes, 1); assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.authorization === 'Bearer ' + 'c'.repeat(43)));
    assert.deepEqual(requests[0].body.data, input.data);
    assert.ok(NATIVE_PRODUCT_TOOLS.every(tool => !['acceptMemberAgentRequest', 'checkMemberAgentExecution', 'deliverMemberAgentOutput', 'registerDevice'].includes(tool.operationId)));
    await assert.rejects(session.product.call('acceptMemberAgentRequest', input), /native_product_tool_input_invalid/);
    await assert.rejects(session.desktop.call('publishSkill', {}), /desktop_control_operation_invalid/);
    const sent = requests.length;
    await assert.rejects(session.desktop.call('acceptMemberAgentRequest', { ...input, data: { ...input.data, confirm: false } }));
    assert.equal(requests.length, sent, 'missing explicit consent is rejected before HTTP');
  } finally { await session.release(); }
  const ordinary = await openNativeProductSession(path);
  try { assert.equal(ordinary.desktop, undefined); } finally { await ordinary.release(); }
});
