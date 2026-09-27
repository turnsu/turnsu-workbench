import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createRestrictedPiExecution } from '../integrations/native/restricted-pi-execution.mjs';
import { openStore } from '../../local-agent-host/store.mjs';
import { BorrowedAgentAttempts } from '../../local-agent-host/borrowed-agent-attempts.mjs';

const call = (name, args) => fauxAssistantMessage([{ type: 'toolCall', id: name + Math.random(), name, arguments: args }], { stopReason: 'toolUse' });
const done = () => fauxAssistantMessage([{ type: 'text', text: 'Ready for owner review.' }], { stopReason: 'stop' });
async function fixture(t) {
  const root = await mkdtemp('/private/tmp/turnsu-restricted-pi-'), cwd = join(root, 'work'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(cwd, 'AGENTS.md'), 'PRIVATE_PROJECT_CONTEXT_DO_NOT_SHARE');
  await writeFile(join(agentDir, 'AGENTS.md'), 'PRIVATE_GLOBAL_CONTEXT_DO_NOT_SHARE');
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ secret: 'PRIVATE_AUTH_DO_NOT_SHARE' }));
  const escape = join(root, 'escape.txt');
  await writeFile(join(agentDir, 'extensions', 'private.mjs'), `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(escape)}, 'PRIVATE_EXTENSION_LOADED');`);
  const provider = 'restricted-test-' + root.split('-').at(-1), modelId = 'faux';
  const faux = createFauxCore({ provider, modelId, models: [{ id: modelId, name: 'Controlled provider', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'models-store'), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey(provider, 'test-key');
  modelRuntime.registerProvider(provider, { api: provider, baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', streamSimple: faux.streamSimple,
    models: [{ id: modelId, name: 'Controlled provider', api: provider, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }] });
  const seen = [], original = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options) => { seen.push({ context: JSON.parse(JSON.stringify(context)), maxTokens: options.maxTokens }); return original(model, context, options); };
  const executions = [];
  t.after(async () => { for (const execution of executions) await execution.dispose(); modelRuntime.unregisterProvider(provider); await rm(root, { recursive: true, force: true }); });
  return { root, escape, seen, faux, async create(overrides = {}) {
    const execution = await createRestrictedPiExecution({ cwd, agentDir, modelRuntime, model: modelRuntime.getModel(provider, modelId), attemptId: 'approved-attempt',
      instructions: 'Classify declared feedback and preserve its source quote.', inputs: [{ id: 'feedback', title: 'Reviewed input', text: '需要让同事接续工作。' }],
      authorize: async () => true, expiresAt: Date.now() + 30000, maxModelRequests: 8, maxOutputTokens: 512, ...overrides });
    executions.push(execution); return execution;
  } };
}

test('actual Pi SDK confines hostile tool calls and excludes private discovery/context/auth', async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    call('bash', { command: `echo escape > ${f.escape}` }),
    call('read', { path: join(f.root, 'agent/auth.json') }),
    call('read_input', { id: '../agent/auth.json' }),
    call('read_input', { id: 'feedback' }),
    call('write_result', { content: '分类：团队协作。来源：“需要让同事接续工作。”' }), done(),
  ]);
  const execution = await f.create(); assert.equal(f.seen.length, 0, 'preparation does not invoke model');
  const result = await execution.run(); assert.match(result.output, /团队协作/); assert.equal(result.modelRequests, 6);
  await assert.rejects(readFile(f.escape), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(f.seen), /PRIVATE_PROJECT_CONTEXT|PRIVATE_GLOBAL_CONTEXT|PRIVATE_AUTH|PRIVATE_EXTENSION_LOADED/);
  for (const request of f.seen) { assert.deepEqual(request.context.tools.map(t => t.name).sort(), ['read_input', 'write_result']); assert.equal(request.maxTokens, 512); }
  const toolResults = f.seen.at(-1).context.messages.filter(m => m.role === 'toolResult');
  assert.equal(toolResults.filter(m => m.isError).length, 3);
  assert.ok(toolResults.some(m => JSON.stringify(m.content).includes('需要让同事接续工作')));
  await assert.rejects(execution.run(), /already_started/);
});

test('grant revocation between model turns and request limits prevent further model calls or result delivery', async t => {
  const f = await fixture(t); let active = true;
  f.faux.setResponses([() => { active = false; return call('write_result', { content: 'must not be accepted' }); }, done()]);
  const execution = await f.create({ authorize: async () => active });
  await assert.rejects(execution.run(), /revoked/); assert.equal(f.seen.length, 1);
  f.faux.setResponses([call('read_input', { id: 'feedback' }), done()]);
  const limited = await f.create({ maxModelRequests: 1 });
  await assert.rejects(limited.run(), /request_limit/); assert.equal(f.seen.length, 2);
});

test('running model is aborted on lease revocation and unavailable authorization never falls back', async t => {
  const f = await fixture(t); let active = true, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.faux.setResponses([async (_context, options) => { started(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); return done(); }]);
  const execution = await f.create({ authorize: async () => active });
  const rejected = assert.rejects(execution.run(), /revoked/); await entered; active = false;
  await rejected; assert.equal(f.seen.length, 1);
  const unavailable = await f.create({ authorize: async () => { throw new Error('offline'); } });
  await assert.rejects(unavailable.run(), /authorization_unavailable/); assert.equal(f.seen.length, 1);
});

test('expired or cancelled scopes make no model call and truncated completion cannot deliver a staged result', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.create({ signal: controller.signal }), /cancelled/);
  const stalled = await f.create({ expiresAt: Date.now() + 250, authorize: () => new Promise(() => {}) });
  await assert.rejects(stalled.run(), /expired/); assert.equal(f.seen.length, 0);
  f.faux.setResponses([call('write_result', { content: 'premature result' }), fauxAssistantMessage([{ type: 'text', text: 'truncated' }], { stopReason: 'length' })]);
  const truncated = await f.create(); await assert.rejects(truncated.run(), /result_incomplete/);
  await assert.rejects(truncated.run(), /already_started/);
});

test('real Pi SDK execution uses the durable local dispatch fence and result delivery survives restart without inference', async t => {
  const f = await fixture(t), identity = { origin: 'https://team.example.test', workspaceId: 'team', providerUserId: 'provider' };
  const provider = 'restricted-test-' + f.root.split('-').at(-1);
  const ticket = { workItemId: 'work', requestId: 'request', requestDigest: 'sha256:' + 'a'.repeat(64), commandId: 'command', invocationId: 'invocation', attemptId: 'approved-attempt', fence: 1,
    profile: 'pi-declared-text-v1', providerUserId: identity.providerUserId, workspaceId: identity.workspaceId, deviceId: 'device', expiresAt: new Date(Date.now() + 30000).toISOString(),
    selectedModel: { provider, modelId: 'faux' }, limits: { maxModelRequests: 3, maxOutputTokens: 512, maxOutputBytes: 2048, timeoutMs: 30000 },
    instructions: 'Classify the provided text.', inputs: [{ id: 'feedback', title: 'Feedback', text: '需要共享成果。' }] };
  let store = openStore(join(f.root, 'state'));
  let journal = new BorrowedAgentAttempts({ db: store.db, createExecution: async ({ ticket: frozen, signal, authorize }) => {
    assert.equal(store.db.prepare('SELECT state FROM borrowed_agent_attempts').get().state, 'running');
    return f.create({ attemptId: frozen.attemptId, instructions: frozen.instructions, inputs: frozen.inputs, expiresAt: Date.parse(frozen.expiresAt), signal, authorize, ...frozen.limits });
  } });
  try {
    f.faux.setResponses([call('read_input', { id: 'feedback' }), call('write_result', { content: '团队希望共享成果。' }), done()]);
    const view = await journal.execute({ identity, ticket, authorize: async () => true });
    assert.equal(view.state, 'result_ready'); assert.equal(f.seen.length, 3); assert.match(view.result.output, /共享成果/);
    let original;
    await journal.deliver({ identity, invocationId: ticket.invocationId, send: async payload => { original = structuredClone(payload); throw new Error('lost response'); } });
    await journal.close(); store.close();
    store = openStore(join(f.root, 'state'));
    journal = new BorrowedAgentAttempts({ db: store.db, createExecution() { throw new Error('inference cannot run again'); } });
    const delivered = await journal.deliver({ identity, invocationId: ticket.invocationId, send: async payload => {
      assert.deepEqual(payload, original);
      return { invocationId: ticket.invocationId, attemptId: ticket.attemptId, fence: 1, deliveryId: payload.deliveryId, executionStatus: 'completed' };
    } });
    assert.equal(delivered.state, 'delivered'); assert.equal(f.seen.length, 3);
  } finally { await journal.close(); store.close(); }
});

test('result byte limits reject multibyte text even when character count fits', async t => {
  const f = await fixture(t);
  f.faux.setResponses([call('write_result', { content: '你好' }), done()]);
  const execution = await f.create({ maxOutputBytes: 4 });
  await assert.rejects(execution.run(), /result_incomplete/);
  assert.ok(f.seen.at(-1).context.messages.some(m => m.role === 'toolResult' && m.isError));
});
