import { createHash, randomUUID } from 'node:crypto';

const PROFILE = 'pi-declared-text-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const hash = text => createHash('sha256').update(text).digest('hex');
const nonempty = (value, max = 256) => typeof value === 'string' && value.trim() && value.length <= max;
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) fail('borrowed_execution_contract_invalid');
}
function identityScope(identity) {
  keys(identity, ['origin', 'workspaceId', 'providerUserId']);
  let url; try { url = new URL(identity.origin); } catch { fail('borrowed_execution_identity_invalid'); }
  if (url.origin !== identity.origin || url.username || url.password || !nonempty(identity.workspaceId) || !nonempty(identity.providerUserId)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('borrowed_execution_identity_invalid');
  return hash(canonical(identity));
}
function freezeContract(identity, ticket) {
  const scope = identityScope(identity);
  keys(ticket, ['workItemId', 'requestId', 'requestDigest', 'commandId', 'invocationId', 'attemptId', 'fence', 'profile', 'providerUserId', 'workspaceId', 'deviceId', 'expiresAt', 'selectedModel', 'limits', 'instructions', 'inputs']);
  for (const key of ['workItemId', 'requestId', 'requestDigest', 'commandId', 'invocationId', 'attemptId', 'deviceId']) if (!nonempty(ticket[key])) fail('borrowed_execution_contract_invalid');
  keys(ticket.selectedModel, ['provider', 'modelId']);
  keys(ticket.limits, ['maxModelRequests', 'maxOutputTokens', 'maxOutputBytes', 'timeoutMs']);
  if (ticket.profile !== PROFILE || ticket.providerUserId !== identity.providerUserId || ticket.workspaceId !== identity.workspaceId
    || !Number.isSafeInteger(ticket.fence) || ticket.fence < 1
    || !nonempty(ticket.selectedModel.provider, 128) || !nonempty(ticket.selectedModel.modelId)
    || !nonempty(ticket.instructions, 64000) || !Array.isArray(ticket.inputs) || ticket.inputs.length > 20
    || typeof ticket.expiresAt !== 'string' || !Number.isFinite(Date.parse(ticket.expiresAt))) fail('borrowed_execution_contract_invalid');
  for (const [key, max] of Object.entries({ maxModelRequests: 8, maxOutputTokens: 4096, maxOutputBytes: 64000, timeoutMs: 300000 })) {
    if (!Number.isInteger(ticket.limits[key]) || ticket.limits[key] < 1 || ticket.limits[key] > max) fail('borrowed_execution_contract_invalid');
  }
  const ids = new Set();
  for (const input of ticket.inputs) {
    keys(input, ['id', 'title', 'text']);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id || '') || ids.has(input.id) || !nonempty(input.title, 200) || !nonempty(input.text, 64000)) fail('borrowed_execution_contract_invalid');
    ids.add(input.id);
  }
  if (JSON.stringify(ticket.inputs).length > 128000) fail('borrowed_execution_contract_invalid');
  const serialized = canonical(ticket);
  return { scope, ticket: JSON.parse(serialized), serialized, hash: hash(serialized) };
}
function resultPayload(ticket, result) {
  if (!result || result.profile !== PROFILE || result.attemptId !== ticket.attemptId || result.provider !== ticket.selectedModel.provider || result.modelId !== ticket.selectedModel.modelId
    || !Number.isInteger(result.modelRequests) || result.modelRequests < 1 || result.modelRequests > ticket.limits.maxModelRequests
    || !nonempty(result.output, ticket.limits.maxOutputBytes) || Buffer.byteLength(result.output, 'utf8') > ticket.limits.maxOutputBytes) fail('borrowed_execution_result_invalid');
  // Whitelist the declared result. Native transcripts, SDK events and provider diagnostics never enter the outbox.
  return { profile: PROFILE, attemptId: ticket.attemptId, provider: result.provider, modelId: result.modelId, modelRequests: result.modelRequests, output: result.output };
}
const safeCode = error => /^restricted_pi_[a-z_]+$/.test(error?.code || '') || ['borrowed_execution_result_invalid', 'borrowed_execution_cancelled'].includes(error?.code)
  ? error.code : 'borrowed_execution_failed';
function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { code: 'borrowed_execution_cancelled' }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'borrowed_execution_cancelled' }));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Durable local dispatch fence and result outbox; not a second cloud execution authority.
 * Only a trusted Product/device adapter may provide tickets or deliver results. This module does
 * not authenticate/accept requests, grant permission, publish results or auto-resume inference.
 */
export class BorrowedAgentAttempts {
  constructor({ db, createExecution }) { this.db = db; this.createExecution = createExecution; this.running = new Map(); this.deliveries = new Map(); this.closed = false; }
  row(identity, invocationId) { return this.db.prepare('SELECT * FROM borrowed_agent_attempts WHERE scope=? AND invocation_id=?').get(identityScope(identity), invocationId); }
  view(identity, invocationId) {
    const row = this.row(identity, invocationId);
    if (!row) fail('borrowed_execution_not_found');
    return { invocationId: row.invocation_id, attemptId: row.attempt_id, state: row.state, errorCode: row.error_code,
      result: row.result ? JSON.parse(row.result) : null, receipt: row.receipt ? JSON.parse(row.receipt) : null };
  }
  execute({ identity, ticket, authorize }) {
    if (this.closed) return Promise.reject(new Error('borrowed_execution_closed'));
    const frozen = freezeContract(identity, ticket), key = frozen.scope + ':' + ticket.invocationId;
    const existing = this.row(identity, ticket.invocationId);
    if (existing) {
      if (existing.contract_hash !== frozen.hash || existing.contract !== frozen.serialized) fail('borrowed_execution_contract_changed');
      return this.running.get(key)?.promise || Promise.resolve(this.view(identity, ticket.invocationId));
    }
    if (typeof authorize !== 'function' || typeof this.createExecution !== 'function') fail('borrowed_execution_adapter_required');
    const expiresAt = Date.parse(frozen.ticket.expiresAt);
    if (expiresAt <= Date.now() || expiresAt - Date.now() > frozen.ticket.limits.timeoutMs) fail('borrowed_execution_expired');
    // Synchronous durable commit precedes any factory/authorization/model work, including its first await.
    this.db.prepare("INSERT INTO borrowed_agent_attempts(scope,invocation_id,attempt_id,contract,contract_hash,delivery_id,state,updated_at) VALUES(?,?,?,?,?,?,'running',?)")
      .run(frozen.scope, ticket.invocationId, ticket.attemptId, frozen.serialized, frozen.hash, 'borrowed-result-' + randomUUID(), Date.now());
    const controller = new AbortController(), active = { controller, execution: null, promise: null };
    const deadline = setTimeout(() => { controller.abort(); active.execution?.cancel(); }, Math.max(1, expiresAt - Date.now()));
    active.promise = Promise.resolve().then(async () => {
      try {
        const allowed = await abortable(() => authorize({ ticket: structuredClone(frozen.ticket), signal: controller.signal }), controller.signal);
        if (allowed !== true || controller.signal.aborted) fail('borrowed_execution_cancelled');
        active.execution = await abortable(async () => {
          const execution = await this.createExecution({ ticket: structuredClone(frozen.ticket), signal: controller.signal,
            authorize: () => authorize({ ticket: structuredClone(frozen.ticket), signal: controller.signal }) });
          if (controller.signal.aborted) { execution.cancel(); await execution.dispose(); fail('borrowed_execution_cancelled'); }
          return execution;
        }, controller.signal);
        if (controller.signal.aborted) fail('borrowed_execution_cancelled');
        const result = await abortable(() => active.execution.run(), controller.signal);
        if (controller.signal.aborted) fail('borrowed_execution_cancelled');
        const payload = resultPayload(frozen.ticket, result);
        this.db.prepare("UPDATE borrowed_agent_attempts SET state='result_ready',result=?,error_code=NULL,updated_at=? WHERE scope=? AND invocation_id=? AND state='running'")
          .run(JSON.stringify(payload), Date.now(), frozen.scope, ticket.invocationId);
      } catch (error) {
        this.db.prepare("UPDATE borrowed_agent_attempts SET state='failed',error_code=?,updated_at=? WHERE scope=? AND invocation_id=? AND state='running'")
          .run(safeCode(error), Date.now(), frozen.scope, ticket.invocationId);
      } finally {
        clearTimeout(deadline);
        try { await active.execution?.dispose(); } catch {} this.running.delete(key);
      }
      return this.view(identity, ticket.invocationId);
    });
    this.running.set(key, active);
    return active.promise;
  }
  cancel(identity, invocationId) {
    const active = this.running.get(identityScope(identity) + ':' + invocationId);
    active?.controller.abort(); active?.execution?.cancel();
    return this.view(identity, invocationId);
  }
  deliver({ identity, invocationId, send }) {
    if (this.closed) return Promise.reject(new Error('borrowed_execution_closed'));
    const row = this.row(identity, invocationId);
    if (!row) fail('borrowed_execution_not_found');
    if (row.receipt) return Promise.resolve(this.view(identity, invocationId));
    if (!['result_ready', 'failed', 'interrupted'].includes(row.state) || (row.state === 'result_ready' && !row.result) || typeof send !== 'function') fail('borrowed_execution_result_not_ready');
    const key = row.scope + ':' + invocationId;
    if (this.deliveries.has(key)) return this.deliveries.get(key);
    const promise = Promise.resolve().then(async () => {
      try {
        // The transport reauthorizes the exact attempt/fence on each delivery. It must reject expired/revoked results.
        const outcome = row.state === 'result_ready' ? 'result' : row.state;
        const receipt = await send({ ticket: JSON.parse(row.contract), outcome, result: row.result ? JSON.parse(row.result) : null, deliveryId: row.delivery_id });
        const statuses = outcome === 'result' ? ['completed'] : ['failed', 'cancelled', 'partial', 'effect_outcome_unknown', 'timeout', 'permission_denied', 'sandbox_unavailable', 'remote_backend_unavailable'];
        if (!receipt || receipt.invocationId !== invocationId || receipt.attemptId !== row.attempt_id || receipt.fence !== JSON.parse(row.contract).fence
          || receipt.deliveryId !== row.delivery_id || !statuses.includes(receipt.executionStatus)) fail('borrowed_execution_receipt_invalid');
        const safeReceipt = { invocationId, attemptId: row.attempt_id, fence: receipt.fence, deliveryId: row.delivery_id, executionStatus: receipt.executionStatus };
        this.db.prepare('UPDATE borrowed_agent_attempts SET state=?,receipt=?,error_code=?,updated_at=? WHERE scope=? AND invocation_id=? AND state=?')
          .run(outcome === 'result' ? 'delivered' : row.state, JSON.stringify(safeReceipt), outcome === 'result' ? null : row.error_code, Date.now(), row.scope, invocationId, row.state);
      } catch {
        this.db.prepare("UPDATE borrowed_agent_attempts SET error_code='borrowed_execution_delivery_unconfirmed',updated_at=? WHERE scope=? AND invocation_id=? AND state=?")
          .run(Date.now(), row.scope, invocationId, row.state);
      } finally { this.deliveries.delete(key); }
      return this.view(identity, invocationId);
    });
    this.deliveries.set(key, promise); return promise;
  }
  async close() {
    this.closed = true;
    for (const active of this.running.values()) { active.controller.abort(); active.execution?.cancel(); }
    await Promise.allSettled([...this.running.values()].map(active => active.promise).concat([...this.deliveries.values()]));
  }
}
