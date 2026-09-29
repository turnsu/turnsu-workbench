import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openStore } from '../store.mjs';
import { BorrowedAgentAttempts } from '../borrowed-agent-attempts.mjs';
import { BorrowedAgentExecution } from '../borrowed-agent-execution.mjs';

const identity = { origin: 'https://team.example.test', workspaceId: 'workspace', providerUserId: 'provider' };
const ticket = () => ({ workItemId: 'work', requestId: 'request', requestDigest: 'digest', commandId: 'command', invocationId: 'invocation', attemptId: 'attempt', fence: 1,
  profile: 'pi-declared-text-v1', providerUserId: 'provider', workspaceId: 'workspace', deviceId: 'device', expiresAt: new Date(Date.now() + 20000).toISOString(),
  selectedModel: { provider: 'controlled-provider', modelId: 'controlled-model' }, limits: { maxModelRequests: 3, maxOutputTokens: 512, maxOutputBytes: 2000, timeoutMs: 30000 },
  instructions: 'Summarize the declared feedback.', inputs: [{ id: 'feedback', title: 'Feedback', text: 'The team needs a shared result.' }] });
const result = t => ({ profile: t.profile, attemptId: t.attemptId, provider: t.selectedModel.provider, modelId: t.selectedModel.modelId, modelRequests: 2, output: 'Reviewed shared result.' });
const receipt = ({ ticket: t, deliveryId }) => ({ invocationId: t.invocationId, attemptId: t.attemptId, fence: t.fence, deliveryId, executionStatus: 'completed' });

async function fixture(t, createExecution) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-borrowed-attempt-')); let store, attempts, count = 0;
  const open = () => { store = openStore(join(root, 'state')); attempts = new BorrowedAgentAttempts({ db: store.db, createExecution: createExecution || (async ({ ticket: t }) => {
    assert.equal(store.db.prepare('SELECT state FROM borrowed_agent_attempts').get().state, 'running', 'fence is durable before the executor exists');
    return { async run() { count++; return { ...result(t), transcript: 'PRIVATE_CONTEXT_MUST_NOT_ENTER_OUTBOX' }; }, async dispose() {}, cancel() {} };
  }) }); };
  open(); t.after(async () => { await attempts.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, get attempts() { return attempts; }, get db() { return store.db; }, get count() { return count; }, async reopen() { await attempts.close(); store.close(); open(); } };
}

test('durable dispatch executes once; altered payload/attempt cannot reuse the invocation', async t => {
  const f = await fixture(t), approved = ticket(), original = structuredClone(approved);
  const first = f.attempts.execute({ identity, ticket: approved, authorize: async () => true });
  approved.instructions = 'MUTATED_AFTER_ACCEPT';
  const repeated = f.attempts.execute({ identity, ticket: original, authorize: async () => true });
  const views = await Promise.all([first, repeated]);
  assert.equal(f.count, 1); assert.equal(views[0].state, 'result_ready'); assert.deepEqual(views[0], views[1]);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM borrowed_agent_attempts').get()), /PRIVATE_CONTEXT|MUTATED_AFTER_ACCEPT/);
  assert.throws(() => f.attempts.execute({ identity, ticket: approved, authorize: async () => true }), /contract_changed/);
  assert.throws(() => f.attempts.execute({ identity, ticket: { ...original, attemptId: 'second-attempt', fence: 2 }, authorize: async () => true }), /contract_changed/);
  await f.reopen(); await f.attempts.execute({ identity, ticket: original, authorize: async () => true }); assert.equal(f.count, 1);
});

test('lost delivery acknowledgement retries exact result after restart, with no Agent call or identity crossover', async t => {
  const f = await fixture(t), approved = ticket(), sends = [];
  await f.attempts.execute({ identity, ticket: approved, authorize: async () => true });
  await f.attempts.deliver({ identity, invocationId: approved.invocationId, send: async payload => { sends.push(payload); throw new Error('accepted but response lost'); } });
  assert.equal(f.attempts.view(identity, approved.invocationId).state, 'result_ready');
  await f.reopen();
  assert.throws(() => f.attempts.deliver({ identity: { ...identity, providerUserId: 'teammate' }, invocationId: approved.invocationId, send() { throw new Error('must not send'); } }), /not_found/);
  assert.throws(() => f.attempts.view({ ...identity, workspaceId: 'other' }, approved.invocationId), /not_found/);
  const delivered = await f.attempts.deliver({ identity, invocationId: approved.invocationId, send: async payload => { sends.push(payload); return receipt(payload); } });
  assert.equal(delivered.state, 'delivered'); assert.deepEqual(sends[0], sends[1]); assert.equal(f.count, 1);
  await f.attempts.deliver({ identity, invocationId: approved.invocationId, send() { throw new Error('already delivered'); } }); assert.equal(sends.length, 2);
});

test('wrong fence receipt is unconfirmed and cannot replace the saved output', async t => {
  const f = await fixture(t), approved = ticket();
  await f.attempts.execute({ identity, ticket: approved, authorize: async () => true });
  const pending = await f.attempts.deliver({ identity, invocationId: approved.invocationId, send: async payload => { payload.result.output = 'TRANSPORT_MUTATION'; return { ...receipt(payload), fence: 2 }; } });
  assert.equal(pending.state, 'result_ready'); assert.equal(pending.errorCode, 'borrowed_execution_delivery_unconfirmed');
  assert.equal(pending.result.output, result(approved).output);
});

test('abrupt process death leaves an interrupted record and reopening never repeats inference', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-borrowed-crash-')), approved = ticket();
  const script = join(root, 'child.mjs'), storeUrl = new URL('../store.mjs', import.meta.url).href, attemptsUrl = new URL('../borrowed-agent-attempts.mjs', import.meta.url).href;
  await writeFile(script, `import {openStore} from ${JSON.stringify(storeUrl)};
import {BorrowedAgentAttempts} from ${JSON.stringify(attemptsUrl)};
const store = openStore(${JSON.stringify(join(root, 'state'))});
const attempts = new BorrowedAgentAttempts({db:store.db,createExecution:async()=>({run:async()=>{process.send('inference-entered');await new Promise(()=>{});},dispose:async()=>{},cancel(){}})});
await attempts.execute({identity:${JSON.stringify(identity)},ticket:${JSON.stringify(approved)},authorize:async()=>true});`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  child.kill('SIGKILL'); await once(child, 'exit');
  const store = openStore(join(root, 'state')), attempts = new BorrowedAgentAttempts({ db: store.db, createExecution() { throw new Error('must never re-execute'); } });
  try {
    assert.equal(attempts.view(identity, approved.invocationId).state, 'interrupted');
    assert.equal((await attempts.execute({ identity, ticket: approved, authorize: async () => true })).state, 'interrupted');
    assert.throws(() => attempts.execute({ identity, ticket: { ...approved, attemptId: 'replacement' }, authorize: async () => true }), /contract_changed/);
    const reported = await attempts.deliver({ identity, invocationId: approved.invocationId, async send(payload) {
      assert.equal(payload.outcome, 'interrupted'); assert.equal(payload.result, null);
      return { ...receipt(payload), executionStatus: 'effect_outcome_unknown' };
    } });
    assert.equal(reported.state, 'interrupted'); assert.equal(reported.receipt.executionStatus, 'effect_outcome_unknown');
  } finally { await attempts.close(); store.close(); }
});

test('revoked/stalled authorization never reaches executor and remains non-retryable', async t => {
  let created = 0; const f = await fixture(t, () => { created++; throw new Error('never called'); });
  const revoked = ticket(); const view = await f.attempts.execute({ identity, ticket: revoked, authorize: async () => false });
  assert.equal(view.state, 'failed'); assert.equal(created, 0);
  await f.attempts.execute({ identity, ticket: revoked, authorize: async () => true }); assert.equal(created, 0);
  const stalled = { ...ticket(), invocationId: 'stalled', attemptId: 'stalled', expiresAt: new Date(Date.now() + 100).toISOString() };
  assert.equal((await f.attempts.execute({ identity, ticket: stalled, authorize: () => new Promise(() => {}) })).state, 'failed'); assert.equal(created, 0);
});

test('cancel aborts an active executor and does not retain its late output or diagnostic secrets', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async ({ ticket: approved, signal }) => ({ async run() {
    entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return result(approved);
  }, cancel() {}, async dispose() {} }));
  const approved = ticket(), running = f.attempts.execute({ identity, ticket: approved, authorize: async () => true });
  await started; f.attempts.cancel(identity, approved.invocationId);
  const view = await running; assert.equal(view.state, 'failed'); assert.equal(view.result, null);
});

test('result UTF-8 bytes and exact selected model are checked before creating delivery payload', async t => {
  const f = await fixture(t, async ({ ticket: approved }) => ({ async run() { return { ...result(approved), output: '你好', ...(approved.invocationId === 'other-model' ? { modelId: 'not-selected' } : {}) }; }, async dispose() {}, cancel() {} }));
  const approved = ticket(); approved.limits.maxOutputBytes = 4;
  const view = await f.attempts.execute({ identity, ticket: approved, authorize: async () => true });
  assert.equal(view.state, 'failed'); assert.equal(view.errorCode, 'borrowed_execution_result_invalid'); assert.equal(view.result, null);
  const other = { ...ticket(), invocationId: 'other-model', attemptId: 'other-attempt' };
  assert.equal((await f.attempts.execute({ identity, ticket: other, authorize: async () => true })).errorCode, 'borrowed_execution_result_invalid');
});

test('desktop transport requires the unchanged ticket and a live lease, not merely active:true', async t => {
  const f = await fixture(t), connection = { origin: identity.origin, workspaceId: identity.workspaceId, clientSessionId: 'native-session' };
  let expected, grant, creates = 0; const sent = [];
  const cloud = { identity: async () => connection, viewer: async () => ({ userId: identity.providerUserId, workspaceId: identity.workspaceId }),
    async desktopCall(current, operation, payload) {
      assert.deepEqual(current, connection);
      if (operation === 'checkMemberAgentExecution') return { data: grant };
      assert.equal(operation, 'deliverMemberAgentOutput'); sent.push(payload);
      assert.equal(payload.data.outcome, 'failed'); assert.equal(payload.data.output, undefined);
      return { data: { invocationId: expected.invocationId, attemptId: expected.attemptId, fence: 1, deliveryId: payload.data.deliveryId, executionStatus: 'failed' } };
    } };
  const execution = new BorrowedAgentExecution({ db: f.db, cloud, createExecution() { creates++; throw new Error('unauthorized'); } });
  try {
    for (const variant of ['changed_ticket', 'expired_lease', 'wrong_fence']) {
      expected = { ...ticket(), invocationId: variant, attemptId: variant };
      grant = { active: true, ticket: structuredClone(expected), lease: { capabilityLeaseId: 'lease', fence: 1, expiresAt: expected.expiresAt } };
      if (variant === 'changed_ticket') grant.ticket.instructions = 'Unapproved method substitution';
      if (variant === 'expired_lease') grant.lease.expiresAt = new Date(Date.now() - 1).toISOString();
      if (variant === 'wrong_fence') grant.lease.fence = 2;
      assert.equal((await execution.start({ identity: connection, ticket: expected })).state, 'failed');
    }
    assert.equal(creates, 0); assert.equal(sent.length, 3);
    await assert.rejects(execution.start({ identity: { ...connection, clientSessionId: 'different' }, ticket: expected }), /connection_changed/);
    await assert.rejects(execution.start({ identity: connection, ticket: { ...expected, providerUserId: 'someone-else' } }), /wrong_provider/);
    assert.equal(creates, 0);
  } finally { await execution.close(); }
});
