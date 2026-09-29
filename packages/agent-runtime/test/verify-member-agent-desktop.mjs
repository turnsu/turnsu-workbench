import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loginNativeProduct } from '../integrations/native/login.mjs';
import { createRestrictedPiExecution } from '../integrations/native/restricted-pi-execution.mjs';
import { DesktopCloud } from '../../agent-host/cloud.mjs';
import { openStore } from '../../agent-host/store.mjs';
import { BorrowedAgentExecution } from '../../agent-host/borrowed-agent-execution.mjs';
import { LocalAgentHost } from '../../agent-host/host.mjs';
import { BorrowedPiRuntime } from '../integrations/native/borrowed-pi-runtime.mjs';

// Called by the isolated Product PG/HTTP fixture. Uses the installed Pi SDK with its official
// controlled provider, not real inference. Real native PKCE/device/Broker/SQLite persistence.
export async function verifyMemberAgentDesktop({ baseUrl, authService, workspaceId, providerUserId, workItemId, method, root, createRequest, cancelRequest }) {
  const directory = join(root, 'borrowed-desktop-state'), cwd = join(root, 'borrowed-text-work'), agentDir = join(root, 'borrowed-text-agent');
  for (const path of [directory, cwd, agentDir]) await mkdir(path, { mode: 0o700 });
  await loginNativeProduct({ baseUrl, sessionPath: join(directory, 'cloud-session.json'), timeoutMs: 15000, async onAuthorization(url) {
    const approval = await authService.approveNativeAuthorization({ authorizationId: new URL(url).searchParams.get('authorizationId'), auth: { userId: providerUserId, activeWorkspaceId: workspaceId } });
    assert.equal((await fetch(approval.redirectUrl)).status, 200);
  } });
  const provider = 'turnsu-borrowing-test', modelId = 'controlled-pi', faux = createFauxCore({ provider, modelId,
    models: [{ id: modelId, name: 'Controlled Pi provider', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }], tokensPerSecond: 0 });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'borrowed-models'), refreshOnCreate: false });
  await runtime.setRuntimeApiKey(provider, 'synthetic-provider-key');
  runtime.registerProvider(provider, { api: provider, baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-provider-key', streamSimple: faux.streamSimple,
    models: [{ id: modelId, name: 'Controlled Pi provider', api: provider, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }] });
  let store = openStore(directory), cloud = new DesktopCloud({ directory }), execution, host, stateClosed = false;
  const calls = [], originalStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => { calls.push(JSON.parse(JSON.stringify(context))); return originalStream(model, context, options); };
  try {
    const identity = await cloud.identity();
    const device = await cloud.desktopCall(identity, 'registerDevice', { idempotencyKey: 'borrowed-desktop-device', data: {
      displayName: 'Borrowing acceptance desktop', platform: 'macos', architecture: 'arm64', appVersion: 'test', workerProtocolVersion: 'workbench-device-worker-v1', capabilityInventory: [] } });
    const limits = { timeoutMs: 30000, maxModelRequests: 3, maxOutputTokens: 512, maxOutputBytes: 2000 };
    const request = await createRequest({ providerUserId, method, goal: '归纳本次明确提供的团队反馈', inputs: [{ id: 'feedback', title: '共享反馈', text: '请让同事能接续工作，并查看已确认成果。' }], expiresAt: new Date(Date.now() + 120000).toISOString(), limits });
    const pathParams = { workItemId, requestId: request.requestId };
    const accepted = await cloud.desktopCall(identity, 'acceptMemberAgentRequest', { pathParams, idempotencyKey: 'borrowed-desktop-accept',
      data: { confirm: true, requestDigest: request.requestDigest, deviceId: device.data.deviceId, profile: 'pi-declared-text-v1', selectedModel: { provider, modelId }, limits } });
    assert.equal(calls.length, 0, 'consent and admission do not invoke a model');
    const createExecution = async ({ ticket, authorize, signal }) => {
      assert.equal(store.db.prepare('SELECT state FROM borrowed_agent_attempts WHERE invocation_id=?').get(ticket.invocationId).state, 'running');
      return createRestrictedPiExecution({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel(provider, modelId), attemptId: ticket.attemptId,
        instructions: ticket.instructions, inputs: ticket.inputs, expiresAt: Date.parse(ticket.expiresAt), ...ticket.limits, authorize, signal });
    };
    execution = new BorrowedAgentExecution({ db: store.db, cloud, createExecution });
    const output = '团队需求：接续同事工作，并查看已确认成果。';
    faux.setResponses([
      fauxAssistantMessage([{ type: 'toolCall', id: 'read', name: 'read_input', arguments: { id: 'feedback' } }], { stopReason: 'toolUse' }),
      fauxAssistantMessage([{ type: 'toolCall', id: 'result', name: 'write_result', arguments: { content: output } }], { stopReason: 'toolUse' }),
      fauxAssistantMessage([{ type: 'text', text: '已整理声明资料。' }], { stopReason: 'stop' }),
    ]);
    let lose = true; const sent = [], original = cloud.desktopCall.bind(cloud);
    cloud.desktopCall = async (...args) => {
      const response = await original(...args);
      if (args[1] === 'deliverMemberAgentOutput') { sent.push(structuredClone(args[2])); if (lose) { lose = false; throw new Error('committed response lost'); } }
      return response;
    };
    const pending = await execution.start({ identity, ticket: accepted.data });
    assert.equal(lose, false, JSON.stringify(pending)); assert.equal(pending.state, 'result_ready'); assert.equal(calls.length, 3);
    assert.doesNotMatch(JSON.stringify(sent), /synthetic-provider-key|borrowed-text-work|borrowed-text-agent|toolCall/);
    await execution.close(); await cloud.close(); store.close();
    store = openStore(directory); cloud = new DesktopCloud({ directory });
    execution = new BorrowedAgentExecution({ db: store.db, cloud, createExecution() { assert.fail('restart or retry must not rerun Pi'); } });
    const retryIdentity = await cloud.identity(), retryOriginal = cloud.desktopCall.bind(cloud);
    cloud.desktopCall = async (...args) => { if (args[1] === 'deliverMemberAgentOutput') sent.push(structuredClone(args[2])); return retryOriginal(...args); };
    const delivered = await execution.start({ identity: retryIdentity, ticket: accepted.data });
    assert.equal(delivered.state, 'delivered', JSON.stringify(delivered)); assert.deepEqual(sent[0], sent[1]); assert.equal(calls.length, 3);
    const shared = await cloud.desktopCall(retryIdentity, 'getMemberAgentRequest', { pathParams });
    assert.equal(shared.data.executionStatus, 'completed'); assert.equal(shared.data.output, output);
    assert.doesNotMatch(JSON.stringify(shared), /synthetic-provider-key|borrowed-text-work|borrowed-text-agent|toolCall/);
    assert.equal(typeof cancelRequest, 'function', 'the fixture must exercise real requester cancellation');
    const cancellable = await createRequest({ providerUserId, method, goal: 'Cancellation acceptance', inputs: [{ id: 'feedback', title: 'Feedback', text: 'This task will be cancelled.' }], expiresAt: new Date(Date.now() + 120000).toISOString(), limits }, 'borrow-local-sdk-cancel');
    const cancelPath = { workItemId, requestId: cancellable.requestId };
    const cancelTicket = (await cloud.desktopCall(retryIdentity, 'acceptMemberAgentRequest', { pathParams: cancelPath, idempotencyKey: 'borrowed-desktop-accept-cancel',
      data: { confirm: true, requestDigest: cancellable.requestDigest, deviceId: device.data.deviceId, profile: 'pi-declared-text-v1', selectedModel: { provider, modelId }, limits } })).data;
    await execution.close(); execution = new BorrowedAgentExecution({ db: store.db, cloud, createExecution });
    let entered, aborted = false; const streaming = new Promise(resolve => { entered = resolve; });
    faux.setResponses([async (_context, options) => {
      entered();
      await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
      aborted = true;
      return fauxAssistantMessage([{ type: 'text', text: 'Cancelled response must not be shared.' }], { stopReason: 'stop' });
    }]);
    const running = execution.start({ identity: retryIdentity, ticket: cancelTicket });
    await Promise.race([streaming, running.then(value => { assert.fail('execution stopped before model stream: ' + JSON.stringify(value)); })]);
    await cancelRequest(cancellable.requestId);
    const cancelled = await running;
    assert.equal(aborted, true, 'requester revocation propagates through Product check to the active SDK stream');
    assert.equal(cancelled.result, null); assert.equal(cancelled.state, 'failed'); assert.equal(calls.length, 4);
    const revoked = await cloud.desktopCall(retryIdentity, 'getMemberAgentRequest', { pathParams: cancelPath });
    assert.equal(revoked.data.consent, 'revoked'); assert.equal(revoked.data.output, null);
    await execution.start({ identity: retryIdentity, ticket: cancelTicket }); assert.equal(calls.length, 4, 'revocation and retry cannot re-enter inference');
    const work = await cloud.fileCall(retryIdentity, 'turnsu_work_context', { pathParams: { workItemId } });
    const remoteProjectId = work.data.workItem.projectId;
    await execution.close(); await cloud.close(); store.close(); stateClosed = true;
    const openHost = () => {
      const value = new LocalAgentHost({ directory });
      value.assistance().runtimeValue = new BorrowedPiRuntime({ directory, runtimeFactory: async () => runtime }); return value;
    };
    host = openHost();
    const projectPath = join(root, 'borrowed-provider-project'); await mkdir(projectPath);
    const project = await host.command('project.open', { path: projectPath });
    await host.command('sync.attach', { projectId: project.id, remoteId: remoteProjectId });
    const incoming = await createRequest({ providerUserId, method, goal: 'Desktop confirmation recovery', inputs: [{ id: 'feedback', title: 'Declared material', text: 'Desktop controls must recover original consent.' }], expiresAt: new Date(Date.now() + 120000).toISOString(), limits }, 'borrow-desktop-consent');
    const scope = { projectId: project.id, workItemId };
    const inbox = await host.command('assistance.list', scope);
    assert.ok(inbox.items.some(item => item.requestId === incoming.requestId));
    const choices = await host.command('assistance.models'); assert.ok(choices.some(item => item.provider === provider && item.modelId === modelId));
    const consent = { ...scope, actionId: 'desktop-provider-consent', kind: 'accept', confirm: true, requestId: incoming.requestId, requestDigest: incoming.requestDigest, selectedModel: { provider, modelId } };
    const sourceCloud = host.cloud, consentCall = sourceCloud.desktopCall.bind(sourceCloud); let loseConsent = true;
    sourceCloud.desktopCall = async (...args) => { const response = await consentCall(...args); if (args[1] === 'acceptMemberAgentRequest' && loseConsent) { loseConsent = false; throw new Error('accepted consent response lost'); } return response; };
    await assert.rejects(host.command('assistance.submit', consent), /尚未确认/); assert.equal(loseConsent, false); assert.equal(calls.length, 4, 'lost consent response cannot launch the local model');
    await host.close(); host = openHost();
    assert.ok((await host.command('assistance.list', scope)).actions.some(action => action.id === consent.actionId));
    faux.setResponses([
      fauxAssistantMessage([{ type: 'toolCall', id: 'read-ui', name: 'read_input', arguments: { id: 'feedback' } }], { stopReason: 'toolUse' }),
      fauxAssistantMessage([{ type: 'toolCall', id: 'write-ui', name: 'write_result', arguments: { content: 'Recovered desktop consent ran exactly once.' } }], { stopReason: 'toolUse' }),
      fauxAssistantMessage([{ type: 'text', text: 'Done.' }], { stopReason: 'stop' }),
    ]);
    await host.command('assistance.submit', { ...scope, actionId: consent.actionId, kind: 'accept', confirm: true, retry: true });
    await Promise.all([...host.assistance().running.values()]);
    const completed = (await host.command('assistance.list', scope)).items.find(item => item.requestId === incoming.requestId);
    assert.equal(completed.executionStatus, 'completed', JSON.stringify(completed)); assert.equal(completed.output, 'Recovered desktop consent ran exactly once.'); assert.equal(calls.length, 7);
    await host.command('assistance.submit', { ...scope, actionId: consent.actionId, kind: 'accept', confirm: true, retry: true });
    await Promise.all([...host.assistance().running.values()]); assert.equal(calls.length, 7);
    await host.close(); host = null;
    await verifyRequesterControls({ root, baseUrl, authService, workspaceId, requesterUserId: request.requesterUserId, providerUserId, remoteProjectId, workItemId, method });
  } finally { await host?.close(); if (!stateClosed) { await execution?.close(); await cloud.close(); store.close(); } runtime.unregisterProvider(provider); }
}

async function verifyRequesterControls({ root, baseUrl, authService, workspaceId, requesterUserId, providerUserId, remoteProjectId, workItemId, method }) {
  const directory = join(root, 'assistance-requester-state'), path = join(root, 'assistance-requester-project'); await mkdir(directory, { mode: 0o700 }); await mkdir(path);
  await loginNativeProduct({ baseUrl, sessionPath: join(directory, 'cloud-session.json'), timeoutMs: 15000, async onAuthorization(url) {
    const approval = await authService.approveNativeAuthorization({ authorizationId: new URL(url).searchParams.get('authorizationId'), auth: { userId: requesterUserId, activeWorkspaceId: workspaceId } }); await fetch(approval.redirectUrl);
  } });
  let host = new LocalAgentHost({ directory });
  try {
    const project = await host.command('project.open', { path }); await host.command('sync.attach', { projectId: project.id, remoteId: remoteProjectId });
    const scope = { projectId: project.id, workItemId }, content = '只处理此声明资料；核对原提交，不重复创建。';
    let actionId = 'desktop-requester-request';
    const call = host.cloud.desktopCall.bind(host.cloud); let lose = true;
    host.cloud.desktopCall = async (...args) => { const response = await call(...args); if (args[1] === 'createMemberAgentRequest' && lose) { lose = false; throw new Error('created response lost'); } return response; };
    const fileCall = host.cloud.fileCall.bind(host.cloud); let packageReads = 0, releaseReads;
    const together = new Promise(resolve => { releaseReads = resolve; });
    host.cloud.fileCall = async (...args) => {
      const result = await fileCall(...args);
      if (args[1] === 'turnsu_skill_package') { if (++packageReads === 2) releaseReads(); await together; }
      return result;
    };
    const submitted = await Promise.allSettled([actionId, 'concurrent-request'].map(id => host.command('assistance.submit', { ...scope, actionId: id, kind: 'create', confirm: true, providerUserId, releaseId: method.releaseId, assetKind: 'skill', content })));
    assert.ok(submitted.every(item => item.status === 'rejected'));
    assert.equal(submitted.filter(item => /尚未确认请求结果/.test(item.reason.message)).length, 1);
    assert.equal(submitted.filter(item => /先核对原提交/.test(item.reason.message)).length, 1);
    const pending = (await host.command('assistance.list', scope)).actions;
    assert.equal(pending.length, 1); actionId = pending[0].id;
    assert.equal(lose, false);
    await assert.rejects(host.command('assistance.submit', { ...scope, actionId: 'new-id', kind: 'create', confirm: true, providerUserId, releaseId: method.releaseId, assetKind: 'skill', content: 'must not replace unknown request' }), /先核对原提交/);
    await host.close(); host = new LocalAgentHost({ directory });
    const sent = await host.command('assistance.submit', { ...scope, actionId, kind: 'create', confirm: true, retry: true });
    const list = await host.command('assistance.list', scope), matching = list.items.filter(item => item.inputs.some(input => input.text === content));
    assert.equal(matching.length, 1); assert.equal(matching[0].requestId, sent.requestId); assert.equal(list.actions.length, 0);
    await host.command('assistance.submit', { ...scope, actionId: 'requester-withdraw', kind: 'cancel', confirm: true, requestId: sent.requestId });
    assert.equal((await host.command('assistance.list', scope)).items.find(item => item.requestId === sent.requestId).consent, 'revoked');
  } finally { await host.close(); }
}
