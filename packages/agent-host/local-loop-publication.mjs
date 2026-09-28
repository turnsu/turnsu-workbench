const fail = message => { throw new Error(message); };

export class LocalLoopPublication {
  constructor(host) { this.host = host; this.db = host.db; this.pending = new Map(); }
  view(sessionId) {
    const trial = this.host.localLoopTrials.row(sessionId), recipe = JSON.parse(trial.recipe).document;
    const row = this.db.prepare('SELECT * FROM local_loop_publications WHERE trial_id=?').get(trial.id);
    const delivery = this.db.prepare('SELECT * FROM local_loop_trial_deliveries WHERE trial_id=?').get(trial.id);
    const identity = row?.identity || delivery?.identity;
    return { recipe, origin: identity ? JSON.parse(identity).origin : null, workspaceId: identity ? JSON.parse(identity).workspaceId : null,
      canPrepare: !!delivery?.receipt, pending: !!row && !row.receipt, canChangeVersion: row?.status === 'version_rejected', published: !!row?.receipt, version: row ? JSON.parse(row.payload).data.version : null, error: row?.error || '' };
  }
  changeVersion({ sessionId, expectedVersion }) {
    if (this.pending.has(sessionId)) fail('请先等待发布核对结束。');
    const trial = this.host.localLoopTrials.row(sessionId), row = this.db.prepare('SELECT * FROM local_loop_publications WHERE trial_id=?').get(trial.id);
    if (!row || row.status !== 'version_rejected' || row.receipt || JSON.parse(row.payload).data.version !== expectedVersion) fail('只有已明确拒绝的重复版本才能重新选择；未知结果必须先核对原发布。');
    this.db.prepare('DELETE FROM local_loop_publications WHERE trial_id=?').run(trial.id);
    return this.view(sessionId);
  }
  publish(args) {
    const key = args.sessionId, request = JSON.stringify(args), current = this.pending.get(key);
    if (current) return current.request === request ? current.promise : Promise.reject(new Error('请先核对上次发布。'));
    const promise = this.deliver(args).finally(() => this.pending.delete(key)); this.pending.set(key, { request, promise }); return promise;
  }
  async deliver({ sessionId, version, releaseNotes = '', confirm, retry = false }) {
    const trial = this.host.localLoopTrials.row(sessionId);
    let row = this.db.prepare('SELECT * FROM local_loop_publications WHERE trial_id=?').get(trial.id);
    if (!row) {
      if (retry || confirm !== true || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || version.length > 64 || typeof releaseNotes !== 'string' || releaseNotes.length > 4000) fail('请查看完整流程、版本与团队范围，再确认发布。');
      const delivery = this.db.prepare('SELECT * FROM local_loop_trial_deliveries WHERE trial_id=?').get(trial.id);
      if (!delivery?.receipt) fail('请先保存人工核对过的本机试做确认。');
      const receipt = JSON.parse(delivery.receipt).data;
      const source = this.host.loopCapture.saved(trial.source_session_id), saved = this.host.loopCapture.view(source);
      if (!saved?.saved || saved.hash !== JSON.parse(trial.recipe).hash || saved.draft.revision.revisionId !== receipt.workflowRevisionId) fail('流程已有修改，需要用新版本重新试做和核对。');
      const { cloud, identity, viewer } = await this.host.loopCapture.bound(delivery);
      const current = await cloud.fileCall(identity, 'turnsu_loop_draft', { pathParams: { workflowId: receipt.workflowId } });
      if (current.data.currentRevisionId !== receipt.workflowRevisionId || !current.etag) fail('云端流程已变化，请先核对版本。');
      const payload = { pathParams: { workflowId: receipt.workflowId }, ifMatch: current.etag, idempotencyKey: 'desktop-native-loop-publish-' + trial.id,
        data: { trialId: receipt.trialId, workflowRevisionId: receipt.workflowRevisionId, revisionContentHash: receipt.revisionContentHash, version, releaseNotes, confirm: true } };
      this.db.prepare('INSERT INTO local_loop_publications(trial_id,actor,identity,payload) VALUES(?,?,?,?)').run(trial.id, viewer.userId, JSON.stringify(identity), JSON.stringify(payload));
      row = this.db.prepare('SELECT * FROM local_loop_publications WHERE trial_id=?').get(trial.id);
    } else if (!retry) fail('这次发布已有固定记录，请核对原发布。');
    const { cloud, identity } = await this.host.loopCapture.bound(row);
    try {
      const receipt = await cloud.fileCall(identity, 'turnsu_publish_native_loop', JSON.parse(row.payload));
      this.db.prepare("UPDATE local_loop_publications SET receipt=?,error='',status='published' WHERE trial_id=?").run(JSON.stringify(receipt), trial.id);
      return this.view(sessionId);
    } catch (e) {
      const versionRejected = e.code === 'native_loop_version_exists' && row.status !== 'uncertain';
      const error = versionRejected ? '这个版本已发布，请改用新版本号。原有发布不会被替换。' : [400, 409, 422].includes(e.status) ? '云端未接受发布。请核对流程为顺序的已发布技能、依赖可在本机使用，以及版本未被占用。确认内容仍保留。'
        : e.status === 412 ? '云端流程已变化，原发布不能覆盖新版本。请核对后重新试做。'
          : [401, 403, 404].includes(e.status) ? '无法访问原流程，请检查团队登录和权限。发布内容仍保留。'
            : '尚未确认发布结果，请核对原发布；不会重新执行 Agent。';
      const status = versionRejected ? 'version_rejected' : row.status === 'uncertain' || ![400, 401, 403, 404, 409, 412, 422].includes(e.status) ? 'uncertain' : 'pending';
      this.db.prepare('UPDATE local_loop_publications SET error=?,status=? WHERE trial_id=?').run(error, status, trial.id); fail(error);
    }
  }
  async close() { await Promise.allSettled([...this.pending.values()].map(v => v.promise)); }
}
