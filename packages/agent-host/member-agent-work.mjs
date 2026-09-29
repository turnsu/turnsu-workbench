import { isDeepStrictEqual } from 'node:util';
import { BorrowedAgentExecution } from './borrowed-agent-execution.mjs';
const fail = message => { throw new Error(message); };
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const limits = { timeoutMs: 180000, maxModelRequests: 8, maxOutputTokens: 2048, maxOutputBytes: 16000 };
const kinds = { create: 'createMemberAgentRequest', accept: 'acceptMemberAgentRequest', decline: 'declineMemberAgentRequest', cancel: 'cancelMemberAgentRequest' };
function explain(error) {
  const code = error?.code || error?.message || '';
  if (/[\u4e00-\u9fff]/.test(code)) return code;
  if (/method_(unsupported|unavailable|changed)/.test(code)) return '这份方法暂不支持隔离文本执行。请重新选择已发布的文本方法，或交给自己的 Agent 处理。';
  if (/expired|registration_interrupted|execution_unavailable|execution_finished/.test(code)) return '本次执行已过期或中断，无法继续原执行。已有结果和记录会保留。';
  if ([401, 403, 404].includes(error?.status) || /connection_changed|wrong_provider|sync_login_required/.test(code)) return '请检查原团队账户和当前成员权限。原提交内容仍然保留。';
  return '尚未确认请求结果。原内容已保存，请核对原请求；不会重复执行 Agent。';
}

export class MemberAgentWork {
  constructor(host) { this.host = host; this.db = host.db; this.pending = new Map(); this.running = new Map(); }
  cloud() { return this.host.teamMethods().cloud; }
  async runtime() {
    if (!this.runtimeValue) {
      const { BorrowedPiRuntime } = await import('../agent-runtime/integrations/native/borrowed-pi-runtime.mjs');
      this.runtimeValue = new BorrowedPiRuntime({ directory: this.host.directory });
    }
    return this.runtimeValue;
  }
  executor() {
    this.execution ||= new BorrowedAgentExecution({ db: this.db, cloud: this.cloud(), createExecution: async args => (await this.runtime()).create(args) });
    return this.execution;
  }
  async bound(projectId, workItemId) {
    const context = await this.host.teamWork().context(projectId, workItemId), cloud = this.cloud(), identity = await cloud.identity();
    return { context, cloud, identity, actor: context.viewerUserId };
  }
  same(row, bound) {
    if (row.actor !== bound.actor || !isDeepStrictEqual(JSON.parse(row.identity), bound.identity)) fail('请切回提交此请求的团队账户和设备连接。');
  }
  async list({ projectId, workItemId, cursor }) {
    const bound = await this.bound(projectId, workItemId);
    const result = await bound.cloud.desktopCall(bound.identity, 'listMemberAgentRequests', { pathParams: { workItemId }, query: { limit: 25, ...(cursor ? { cursor } : {}) } });
    const actions = this.db.prepare("SELECT * FROM member_agent_actions WHERE project_id=? AND work_item_id=? AND actor=? ORDER BY created_at DESC").all(projectId, workItemId, bound.actor)
      .filter(row => isDeepStrictEqual(JSON.parse(row.identity), bound.identity));
    return { ...result.data, viewerUserId: bound.actor, actions: actions.filter(row => row.status === 'pending').map(row => ({ id: row.id, operation: row.operation, error: row.error })),
      local: actions.filter(row => row.operation === kinds.accept && row.receipt).map(row => {
        const ticket = JSON.parse(row.receipt); let state;
        try { state = this.executor().attempts.view({ origin: bound.identity.origin, workspaceId: bound.identity.workspaceId, providerUserId: bound.actor }, ticket.invocationId); } catch {}
        return { requestId: ticket.requestId, actionId: row.id, active: this.running.has(row.id), state: state?.state || 'not_started', error: row.error || (state?.errorCode ? '本机执行或结果交付尚未完成，请核对。' : '') };
      }) };
  }
  async models() {
    try { return await (await this.runtime()).models(); }
    catch { fail('暂时无法读取 Pi 的模型账户。请先在本机 Pi 配置可用的 API 模型，再重试。'); }
  }
  async catalog({ projectId, workItemId, cursor }) {
    const { cloud, identity } = await this.bound(projectId, workItemId);
    const response = await cloud.fileCall(identity, 'turnsu_methods', { query: { limit: 100, ...(cursor ? { cursor } : {}) } });
    return { items: response.data.filter(item => item.assetKind === 'skill' || item.executionMode === 'native_agent'), page: response.page };
  }
  submit(args) {
    if (!text(args.actionId, 100) || args.confirm !== true || !Object.hasOwn(kinds, args.kind)) return Promise.reject(new Error('请检查任务内容并明确确认本次操作。'));
    const serialized = JSON.stringify(args), current = this.pending.get(args.actionId);
    if (current) return current.serialized === serialized ? current.promise : Promise.reject(new Error('原操作尚未结束，请先核对。'));
    const promise = this.perform(args).finally(() => this.pending.delete(args.actionId)); this.pending.set(args.actionId, { serialized, promise }); return promise;
  }
  async perform(args) {
    const bound = await this.bound(args.projectId, args.workItemId);
    let row = this.db.prepare('SELECT * FROM member_agent_actions WHERE id=?').get(args.actionId);
    if (row) {
      this.same(row, bound);
      if (row.project_id !== args.projectId || row.work_item_id !== args.workItemId || row.operation !== kinds[args.kind]) fail('同一操作不能用于另一项工作。');
      if (!args.retry) fail('这次操作已有固定记录，请核对原请求。');
      if (row.status === 'rejected') fail(row.error);
    } else {
      if (args.retry) fail('找不到原操作，请重新打开团队工作。');
      const checkPending = () => {
        const unresolved = this.db.prepare("SELECT * FROM member_agent_actions WHERE project_id=? AND work_item_id=? AND actor=? AND operation=? AND status='pending'").all(args.projectId, args.workItemId, bound.actor, kinds[args.kind])
          .find(item => isDeepStrictEqual(JSON.parse(item.identity), bound.identity) && (args.kind === 'create' || JSON.parse(item.payload).pathParams.requestId === args.requestId));
        if (unresolved) fail('上次提交尚未确认，请先核对原提交，不要另建请求。');
      };
      checkPending();
      let data, pathParams = { workItemId: args.workItemId };
      if (args.kind === 'create') {
        if (!text(args.content, 64000) || !text(args.providerUserId, 128) || !text(args.releaseId, 128) || !['skill', 'loop'].includes(args.assetKind)) fail('请选择方法、协助成员，并写下本次任务及资料。');
        const pkg = (await bound.cloud.fileCall(bound.identity, args.assetKind === 'skill' ? 'turnsu_skill_package' : 'turnsu_native_loop_package', { pathParams: { releaseId: args.releaseId } })).data;
        data = { providerUserId: args.providerUserId, method: { releaseId: args.releaseId, versionId: pkg.versionId, contentHash: pkg.contentHash }, goal: bound.context.workItem.objective,
          inputs: [{ id: 'request', title: '本次任务与资料', text: args.content }], expiresAt: new Date(Date.now() + 86400000 - 1000).toISOString(), limits };
      } else {
        if (!text(args.requestId, 128)) fail('请先选择一条协助请求。');
        pathParams.requestId = args.requestId;
        const request = (await bound.cloud.desktopCall(bound.identity, 'getMemberAgentRequest', { pathParams })).data;
        if (args.kind === 'accept') {
          if (request.providerUserId !== bound.actor || request.consent !== 'pending' || args.requestDigest !== request.requestDigest) fail('请求已变化，请重新查看后决定是否接受。');
          if (!(await this.models()).some(model => isDeepStrictEqual({ provider: model.provider, modelId: model.modelId }, args.selectedModel))) fail('请选择 Pi 中当前可用的 API 模型。');
          const device = await bound.cloud.desktopCall(bound.identity, 'registerDevice', { idempotencyKey: 'desktop-assistance-device-' + bound.identity.clientSessionId,
            data: { displayName: 'Turnsu 桌面', platform: process.platform === 'win32' ? 'windows' : 'macos', architecture: process.arch === 'arm64' ? 'arm64' : 'x64', appVersion: '0.1.0', workerProtocolVersion: 'workbench-device-worker-v1', capabilityInventory: [] } });
          data = { confirm: true, requestDigest: request.requestDigest, deviceId: device.data.deviceId, profile: 'pi-declared-text-v1', selectedModel: args.selectedModel, limits: request.limits };
        } else data = {};
      }
      const payload = { pathParams, idempotencyKey: 'desktop-assistance-' + args.actionId, data };
      // Package/device reads above can interleave with a second desktop command. Recheck without
      // an await before persisting, so an unknown submission cannot acquire a second action ID.
      checkPending();
      this.db.prepare('INSERT INTO member_agent_actions(id,project_id,work_item_id,actor,identity,operation,payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(args.actionId, args.projectId, args.workItemId, bound.actor, JSON.stringify(bound.identity), kinds[args.kind], JSON.stringify(payload), Date.now());
      row = this.db.prepare('SELECT * FROM member_agent_actions WHERE id=?').get(args.actionId);
    }
    let receipt = row.receipt && JSON.parse(row.receipt);
    if (!receipt) {
      try {
        const response = await bound.cloud.desktopCall(bound.identity, row.operation, JSON.parse(row.payload)); receipt = response.data;
        this.db.prepare("UPDATE member_agent_actions SET receipt=?,status='confirmed',error='' WHERE id=?").run(JSON.stringify(receipt), row.id);
      } catch (error) {
        const rejected = !args.retry && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        this.db.prepare('UPDATE member_agent_actions SET status=?,error=? WHERE id=?').run(rejected ? 'rejected' : 'pending', explain(error), row.id); throw new Error(explain(error));
      }
    }
    if (args.kind === 'accept') this.start(row.id, bound.identity, receipt);
    if (args.kind === 'cancel' && receipt.invocationId) await this.executor().stopLocal({ identity: bound.identity, invocationId: receipt.invocationId }).catch(() => {});
    this.host.changed(); return { actionId: row.id, requestId: receipt.requestId };
  }
  start(id, identity, ticket) {
    if (this.running.has(id)) return;
    const promise = this.executor().start({ identity, ticket }).catch(error => {
      this.db.prepare('UPDATE member_agent_actions SET error=? WHERE id=?').run(explain(error), id);
    }).finally(() => { this.running.delete(id); this.host.changed(); });
    this.running.set(id, promise); this.host.changed();
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(item => item.promise)); await this.execution?.close(); await Promise.allSettled([...this.running.values()]); }
}
