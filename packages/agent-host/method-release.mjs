import { createHash } from 'node:crypto';
const parse = JSON.parse;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = status => ['queued', 'running'].includes(status);
const fail = message => { throw new Error(message); };
const outputHash = trial => hash({ testRunId: trial.testRunId, output: trial.outputPreview, completedAt: trial.completedAt });
const valid = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const message = error => [401, 403, 404].includes(error.status) ? '当前账户无法处理这份技能，请检查团队登录和权限。'
  : error.status === 412 || /revision|etag|if_match|content_hash/.test(error.code || '') ? '云端草稿已经变化，请重新试运行并检查结果后再发布。'
  : '操作尚未确认，请核对原提交。不要重复发起试运行或发布。';

export class MethodRelease {
  constructor(publication) { this.publication = publication; this.db = publication.db; this.cloud = publication.cloud; this.pending = new Map(); }
  actions(sessionId) { return this.db.prepare('SELECT * FROM method_release_actions WHERE session_id=? ORDER BY rowid DESC').all(sessionId); }
  async context(sessionId) {
    const row = this.publication.saved(sessionId), created = row && parse(row.receipts).created?.data;
    if (!created) fail('请先将技能保存为云端私有草稿。');
    let identity, viewer;
    try { identity = await this.cloud.identity(); viewer = await this.cloud.viewer(); }
    catch { fail('请恢复团队连接后再查看试运行或发布。'); }
    const original = parse(row.identity);
    if (viewer.userId !== row.actor || original.origin !== identity.origin || original.workspaceId !== identity.workspaceId
      || JSON.stringify(await this.cloud.identity()) !== JSON.stringify(identity)) fail('请切回保存这份草稿的团队账户。');
    const pathParams = { skillId: created.skill.skillId, draftId: created.draft.skillDraftId };
    let draft;
    try { draft = await this.cloud.fileCall(identity, 'turnsu_skill_draft', { pathParams }); }
    catch { fail('暂时无法读取这份云端草稿，请检查连接与访问权限。'); }
    return { row, identity, pathParams, draft: draft.data, etag: draft.etag, originalRevision: created.draft.revision };
  }
  async trial(context, id) {
    try { return (await this.cloud.fileCall(context.identity, 'turnsu_skill_test', { pathParams: { skillId: context.pathParams.skillId, testRunId: id } })).data; }
    catch { fail('暂时无法读取试运行状态，请检查连接与权限后刷新。'); }
  }
  async state(sessionId) {
    const context = await this.context(sessionId), actions = this.actions(sessionId);
    const tests = actions.filter(a => a.kind === 'test' && parse(a.receipts).result).slice(0, 1);
    const trials = [];
    for (const action of tests) {
      const trial = await this.trial(context, parse(action.receipts).result.data.testRunId);
      trials.push({ ...trial, reviewedOutputHash: outputHash(trial), currentDraft: parse(action.payload).ifMatch === context.etag });
    }
    return { trials, published: actions.map(a => parse(a.receipts).published?.data).find(Boolean) || null,
      pending: actions.filter(a => a.status === 'pending').map(a => ({ id: a.id, kind: a.kind, error: a.error })),
      error: actions[0]?.status === 'rejected' ? actions[0].error : '' };
  }
  submit(args) {
    const { sessionId, requestId, kind } = args;
    if (!valid(sessionId, 128) || !valid(requestId, 128) || !['test', 'publish', 'cancel'].includes(kind)) fail('缺少本次技能操作信息。');
    const request = JSON.stringify(args), old = this.pending.get(sessionId);
    if (old) return old.request === request ? old.promise : Promise.reject(new Error('请等当前操作完成。'));
    const promise = this.execute(args, request).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, { request, promise }); return promise;
  }
  async execute(args, request) {
    const { sessionId, requestId, kind } = args, context = await this.context(sessionId);
    let action = this.db.prepare('SELECT * FROM method_release_actions WHERE id=?').get(requestId);
    const fresh = !action;
    if (action && action.request !== request) fail('同一提交不能改变内容。');
    if (action?.status === 'rejected') fail(action.error);
    if (!action) {
      if (this.actions(sessionId).some(a => a.status === 'pending')) fail('请先核对上次操作，避免重复执行。');
      const state = await this.state(sessionId);
      if (state.published) fail('这份技能已经发布。请创建新版本后再调整。');
      let data;
      if (kind === 'test') {
        if (context.draft.revision !== context.originalRevision) fail('云端草稿已修改，与本次预览不再一致。请先检查云端内容，或重新整理一份草稿。');
        if (!valid(args.sample, 20000) || !valid(args.purpose, 2000)) fail('请提供一段试运行资料和预期结果。');
        if (state.trials.some(t => active(t.status))) fail('上次试运行尚未结束，可以先查看结果或取消。');
        const required = context.draft.inputSchema?.required || [];
        if (required.some(name => name !== 'request')) fail('云端技能的输入要求已经改变，请先检查草稿。');
        data = { testCase: { name: '桌面试运行', purpose: args.purpose, input: { request: args.sample }, timeoutSeconds: 60 } };
      } else {
        const source = this.actions(sessionId).find(a => a.kind === 'test' && parse(a.receipts).result?.data.testRunId === args.testRunId);
        if (!source) fail('请选择这份草稿的试运行记录。');
        const trial = await this.trial(context, args.testRunId);
        if (kind === 'cancel') data = {};
        else {
          if (args.confirm !== true || trial.status !== 'passed' || args.reviewedOutputHash !== outputHash(trial)) fail('请查看完整试运行结果，确认符合预期后再发布。');
          if (parse(source.payload).ifMatch !== context.etag) fail('云端草稿已经变化，请重新试运行后再发布。');
          data = { version: '1.0.0', releaseNotes: '已由作者检查桌面试运行结果。' };
        }
      }
      if (!context.etag) fail('未能读取草稿版本，请重新连接后重试。');
      this.db.prepare("INSERT INTO method_release_actions(id,session_id,kind,request,payload,status) VALUES(?,?,?,?,?,'pending')")
        .run(requestId, sessionId, kind, request, JSON.stringify({ data, ifMatch: context.etag, testRunId: args.testRunId }));
      action = this.db.prepare('SELECT * FROM method_release_actions WHERE id=?').get(requestId);
    }
    const receipts = parse(action.receipts), payload = parse(action.payload);
    if (action.status === 'done') return receipts;
    const step = async (key, tool, input) => {
      if (!receipts[key]) {
        receipts[key] = await this.cloud.fileCall(context.identity, tool, { ...input, idempotencyKey: `desktop-release-${requestId}-${key}` });
        this.db.prepare("UPDATE method_release_actions SET receipts=?,error='' WHERE id=?").run(JSON.stringify(receipts), requestId);
      }
      return receipts[key].data;
    };
    try {
      if (kind === 'test') await step('result', 'turnsu_test_skill', { pathParams: context.pathParams, data: payload.data, ifMatch: payload.ifMatch });
      if (kind === 'cancel') await step('result', 'turnsu_cancel_skill_test', { pathParams: { skillId: context.pathParams.skillId, testRunId: payload.testRunId }, data: {} });
      if (kind === 'publish') {
        const validation = await step('validation', 'turnsu_validate_skill', { pathParams: context.pathParams, ifMatch: payload.ifMatch,
          data: { testRunIds: [payload.testRunId], permissionAcknowledged: true } });
        const current = (await this.cloud.fileCall(context.identity, 'turnsu_skill_validation', { pathParams: { skillId: context.pathParams.skillId, validationId: validation.validationId } })).data;
        if (active(current.status)) return { pending: true };
        if (current.status !== 'passed') {
          const error = '发布校验未通过，请检查技能和试运行结果。';
          this.db.prepare("UPDATE method_release_actions SET status='rejected',error=? WHERE id=?").run(error, requestId); fail(error);
        }
        await step('published', 'turnsu_publish_skill', { pathParams: { skillId: context.pathParams.skillId }, data: payload.data, ifMatch: payload.ifMatch });
      }
      this.db.prepare("UPDATE method_release_actions SET status='done',error='' WHERE id=?").run(requestId);
      return receipts;
    } catch (error) {
      const current = this.db.prepare('SELECT status,error FROM method_release_actions WHERE id=?').get(requestId);
      if (current.status === 'rejected') fail(current.error);
      // A replay may encounter changed state after an accepted request. Preserve uncertainty.
      const definitive = fresh && error.status >= 400 && error.status < 500;
      const text = definitive && ![401, 403, 404, 412].includes(error.status) ? '本次请求未被接受，请检查草稿和执行环境后重新提交。' : message(error);
      this.db.prepare('UPDATE method_release_actions SET status=?,error=? WHERE id=?').run(definitive ? 'rejected' : 'pending', text, requestId); fail(text);
    }
  }
  retry(id) {
    const row = this.db.prepare('SELECT request FROM method_release_actions WHERE id=?').get(id);
    if (!row) fail('找不到待核对的操作。');
    return this.submit(parse(row.request));
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(v => v.promise)); }
}
