import { randomUUID } from 'node:crypto';
import { MethodRelease } from './method-release.mjs';

const parse = JSON.parse;
const fail = message => { throw new Error(message); };
const errorText = error => error.code === 'skill_name_unavailable' ? '云端已有同名技能，可以重新准备并更改名称。'
  : [401, 403, 404].includes(error.status) || /sync_|native_session_/.test(error.message || '') ? '无法访问原团队账户，请重新连接并检查权限。本机草稿仍保留。'
  : '云端尚未确认保存完成。提交内容已保存在本机，重试会核对原记录。';

// Checkpointed transfer only. Product still owns draft, validation, publication and ACL state.
export class MethodPublication {
  constructor({ host, cloud }) { this.host = host; this.cloud = cloud; this.db = host.db; this.pending = new Map(); this.release = new MethodRelease(this); }
  saved(sessionId) { return this.db.prepare('SELECT * FROM method_publications WHERE session_id=?').get(sessionId); }
  view(row) {
    if (!row) return null;
    const payload = parse(row.payload), receipts = parse(row.receipts);
    return { name: payload.name, origin: parse(row.identity).origin, saved: !!receipts.created,
      error: row.error, draft: receipts.created?.data.draft || null, hash: payload.hash,
      content: Buffer.from(payload.contentBase64, 'base64').toString('utf8'), canRestart: receipts.blocked === true && !receipts.created };
  }
  reset({ sessionId, expectedHash }) {
    const row = this.saved(sessionId), view = this.view(row);
    if (this.pending.has(sessionId) || !view?.canRestart || view.hash !== expectedHash) fail('保存结果尚未确认，不能丢弃原提交；请先核对。');
    this.db.prepare('DELETE FROM method_publications WHERE session_id=?').run(sessionId);
    return { reset: true };
  }
  async state(sessionId) {
    this.host.session(sessionId);
    const saved = this.view(this.saved(sessionId));
    let current = null;
    try { current = await this.cloud.identity(); } catch {}
    return { saved, origin: current?.origin || null };
  }
  prepare({ sessionId, expectedHash, name }) {
    const fingerprint = JSON.stringify({ expectedHash, name });
    const active = this.pending.get(sessionId);
    if (active) return active.fingerprint === fingerprint ? active.promise : Promise.reject(new Error('请等原草稿保存完成，不能改变待确认的提交。'));
    const promise = this.transfer({ sessionId, expectedHash, name }).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, { fingerprint, promise }); return promise;
  }
  async transfer({ sessionId, expectedHash, name }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) fail('请填写 200 字以内的技能名称。');
    let row = this.saved(sessionId);
    const identity = await this.cloud.identity(), viewer = await this.cloud.viewer();
    if (JSON.stringify(await this.cloud.identity()) !== JSON.stringify(identity) || viewer.workspaceId !== identity.workspaceId) fail('团队连接已经变化，请重新确认保存位置。');
    if (row) {
      const original = parse(row.identity), payload = parse(row.payload);
      if (original.origin !== identity.origin || original.workspaceId !== identity.workspaceId || row.actor !== viewer.userId) fail('请切回最初保存草稿的团队账户，避免把同一内容交给其他团队。');
      if (payload.hash !== expectedHash || payload.name !== name.trim()) fail('有一份云端提交需要核对。请先使用原名称和内容恢复，不会自动上传改动。');
    } else {
      const draft = await this.host.capture.preview(sessionId);
      if (draft.hash !== expectedHash) fail('草稿已经变化，请重新查看后再保存到云端。');
      const payload = { name: name.trim(), description: draft.description, hash: draft.hash,
        contentBase64: Buffer.from(draft.content).toString('base64') };
      this.db.prepare('INSERT INTO method_publications(session_id,id,identity,actor,payload) VALUES(?,?,?,?,?)')
        .run(sessionId, randomUUID(), JSON.stringify(identity), viewer.userId, JSON.stringify(payload));
      row = this.saved(sessionId);
    }
    const receipts = parse(row.receipts), payload = parse(row.payload);
    const step = async (key, tool, input) => {
      if (!receipts[key]) {
        receipts[key] = await this.cloud.fileCall(identity, tool, { ...input, idempotencyKey: `desktop-skill-${row.id}-${key}` });
        this.db.prepare("UPDATE method_publications SET receipts=?,error='' WHERE session_id=?").run(JSON.stringify(receipts), sessionId);
      }
      return receipts[key].data;
    };
    try {
      const upload = await step('upload', 'turnsu_create_skill_upload', { data: { filename: 'captured-method.skill',
        sizeBytes: Buffer.byteLength(payload.contentBase64, 'base64'), mediaType: 'application/vnd.looloomi.skill-package+json', ingestMethod: 'files', assetKind: 'skill' } });
      const pathParams = { uploadId: upload.uploadId };
      const inspected = await step('inspection', 'turnsu_upload_skill_package', { pathParams,
        data: { files: [{ path: 'SKILL.md', contentBase64: payload.contentBase64 }] } });
      if (inspected.inspection?.status !== 'passed') {
        const issues = inspected.inspection?.diagnostics?.map(d => d.message).join('；');
        const message = `技能包尚未通过检查${issues ? '：' + issues : '，请检查草稿内容'}。没有发布，也没有执行。`;
        receipts.blocked = true;
        this.db.prepare('UPDATE method_publications SET receipts=?,error=? WHERE session_id=?').run(JSON.stringify(receipts), message, sessionId); fail(message);
      }
      await step('promoted', 'turnsu_promote_skill_upload', { pathParams, data: {} });
      const created = await step('created', 'turnsu_create_skill_draft', { data: { name: payload.name, description: payload.description, category: 'general', uploadId: upload.uploadId } });
      // Fresh read checks current authority even when all local receipts already exist.
      const current = await this.cloud.fileCall(identity, 'turnsu_skill_draft', { pathParams: { skillId: created.skill.skillId, draftId: created.draft.skillDraftId } });
      this.db.prepare("UPDATE method_publications SET error='' WHERE session_id=?").run(sessionId);
      return { ...this.view(this.saved(sessionId)), draft: current.data };
    } catch (error) {
      if (error.code === 'skill_name_unavailable' && !receipts.created) {
        receipts.blocked = true;
        this.db.prepare('UPDATE method_publications SET receipts=? WHERE session_id=?').run(JSON.stringify(receipts), sessionId);
      }
      const existing = this.saved(sessionId).error;
      const message = existing.startsWith('技能包尚未通过') ? existing : errorText(error);
      this.db.prepare('UPDATE method_publications SET error=? WHERE session_id=?').run(message, sessionId);
      fail(message);
    }
  }
  async close() { await this.release.close(); await Promise.allSettled([...this.pending.values()].map(v => v.promise)); }
}
