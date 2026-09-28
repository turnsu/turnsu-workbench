import { createHash } from 'node:crypto';

export const isWorkReference = value => ['work-entry', 'work-decision'].includes(value?.kind);
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');

function snapshot(kind, source) {
  const decision = kind === 'work-decision';
  const text = decision
    ? `问题：${source.question}\n已确认决定：${source.chosenOutcome}\n理由：${source.rationale || '未填写'}\n记录时间：${source.createdAt}`
    : `${source.summary}\n\n共享时间：${source.occurredAt}${source.fileReferences?.length ? '\n所引用的文件版本（仅标识，不含文件内容）：\n' + JSON.stringify(source.fileReferences) : ''}`;
  const label = (decision ? source.question : source.summary).replace(/\s+/g, ' ').slice(0, 120);
  return { kind, workItemId: source.workItemId, objectId: decision ? source.decisionId : source.entryId,
    label, contentHash: digest(text), text, byteLength: Buffer.byteLength(text) };
}

// Reuses private input_references snapshots and Product reads; never creates a second team store.
export class WorkReferences {
  constructor(host) { this.host = host; }
  scope(session) {
    const work = this.host.teamWork(), link = work.link(session.id);
    if (!link?.work_item_id) throw new Error('请在团队任务中引用已共享的成果和决定。');
    return { work, link };
  }
  deny(sessionId, sourceId, error) {
    if (error?.code === 'product_client_transport_failed' || [502, 503, 504].includes(error?.status)) return;
    this.host.db.prepare('INSERT OR IGNORE INTO work_reference_denials VALUES(?,?)').run(sessionId, sourceId);
  }
  allow(sessionId, sourceId) { this.host.db.prepare('DELETE FROM work_reference_denials WHERE session_id=? AND source_work_id=?').run(sessionId, sourceId); }
  offlineAllowed(sessionId, sourceId) {
    if (this.host.db.prepare('SELECT 1 FROM work_reference_denials WHERE session_id=? AND source_work_id=?').get(sessionId, sourceId)) throw new Error('这份来源资料的权限已变化，请联网核对后继续；也可以新建任务。');
  }
  async target(session) {
    const { work, link } = this.scope(session);
    try { return (await work.call(link, 'turnsu_work_context', { pathParams: { workItemId: link.work_item_id } })).data; }
    catch (error) { work.failed(session.id, error); throw new Error('无法读取当前团队工作，请检查连接和成员权限后重试。'); }
  }
  async sources({ sessionId, cursor }) {
    const session = this.host.session(sessionId), { work, link } = this.scope(session), context = await this.target(session);
    const result = await work.call(link, 'turnsu_work_items', { query: { projectId: context.workItem.projectId, limit: 100, ...(cursor ? { cursor } : {}) } });
    return { currentWorkItemId: link.work_item_id, items: result.data.map(item => ({ workItemId: item.workItemId, title: item.title })), page: result.page };
  }
  async list({ sessionId, cursor, sourceWorkItemId }) {
    const session = this.host.session(sessionId), { work, link } = this.scope(session);
    const sourceId = sourceWorkItemId || link.work_item_id, cross = sourceId !== link.work_item_id;
    const target = await this.target(session);
    try {
      let context;
      if (cross) {
        const query = { targetWorkItemId: link.work_item_id };
        const [detail, updates] = await Promise.all([
          work.call(link, 'turnsu_work_context', { pathParams: { workItemId: sourceId }, query }),
          work.call(link, 'turnsu_work_updates', { pathParams: { workItemId: sourceId }, query: { ...query, order: 'desc', limit: 20, ...(cursor ? { cursor } : {}) } }),
        ]);
        if (detail.data.workItem.workItemId !== sourceId || detail.data.workItem.projectId !== target.workItem.projectId) throw new Error('source_mismatch');
        context = { ...detail.data, entries: updates.data, page: updates.page };
        this.allow(sessionId, sourceId);
      } else context = await work.context(session.project_id, link.work_item_id, cursor);
      return { entries: context.entries.map(source => snapshot('work-entry', source)),
        decisions: context.decisions.map(source => snapshot('work-decision', source)), page: context.page };
    } catch (error) {
      if (cross) this.deny(sessionId, sourceId, error); else work.failed(session.id, error);
      throw new Error(cross ? '这项工作的资料暂时不能引用。请检查连接，并确认当前工作的所有成员都有权查看来源资料。' : '无法读取团队资料，请检查连接和成员权限后重试。');
    }
  }
  async history(session, offline) {
    const { work, link } = this.scope(session), sources = new Set();
    for (const row of this.host.db.prepare('SELECT r.files FROM input_references r JOIN submissions s ON s.id=r.input_id WHERE r.session_id=?').iterate(session.id)) {
      for (const file of JSON.parse(row.files)) if (isWorkReference(file) && file.workItemId !== link.work_item_id) sources.add(file.workItemId);
    }
    for (const sourceId of sources) {
      if (offline) { this.offlineAllowed(session.id, sourceId); continue; }
      try {
        await work.call(link, 'turnsu_work_context', { pathParams: { workItemId: sourceId }, query: { targetWorkItemId: link.work_item_id } });
        this.allow(session.id, sourceId);
      } catch (error) {
        this.deny(session.id, sourceId, error);
        throw new Error('当前会话曾引用其他工作的资料，暂时无法核对其共享范围。请恢复连接或权限后继续，也可以新建任务。');
      }
    }
  }
  async resolve(session, chosen, offline = false) {
    const { work, link } = this.scope(session);
    const cross = chosen.workItemId !== link.work_item_id;
    const query = cross ? { targetWorkItemId: link.work_item_id } : undefined;
    let value;
    if (offline) {
      const context = await work.cached(session.id);
      if (cross) this.offlineAllowed(session.id, chosen.workItemId);
      const source = cross ? null : chosen.kind === 'work-decision'
        ? context.decisions.find(item => item.decisionId === chosen.objectId)
        : context.entries.find(item => item.entryId === chosen.objectId);
      if (source) value = snapshot(chosen.kind, source);
      if (!value) for (const row of this.host.db.prepare('SELECT files FROM input_references WHERE session_id=? ORDER BY rowid DESC').iterate(session.id)) {
        value = JSON.parse(row.files).find(item => item.kind === chosen.kind && item.workItemId === chosen.workItemId && item.objectId === chosen.objectId && item.contentHash === chosen.contentHash);
        if (value) break;
      }
      if (!value) throw new Error('这份团队资料尚未保存在本机会话中，请恢复连接后读取或移除引用。');
    } else {
      if (cross) await this.target(session);
      try {
        if (chosen.kind === 'work-entry') {
          const result = await work.call(link, 'turnsu_work_entry', { pathParams: { workItemId: chosen.workItemId, entryId: chosen.objectId }, ...(query ? { query } : {}) });
          value = snapshot(chosen.kind, result.data);
        } else {
          const context = (await work.call(link, 'turnsu_work_context', { pathParams: { workItemId: chosen.workItemId }, ...(query ? { query } : {}) })).data;
          const source = context.decisions.find(item => item.decisionId === chosen.objectId);
          if (source) value = snapshot(chosen.kind, source);
        }
        if (cross) this.allow(session.id, chosen.workItemId);
      } catch (error) {
        if (cross) this.deny(session.id, chosen.workItemId, error); else work.failed(session.id, error);
        throw new Error('无法引用这份团队资料，请检查连接，并核对来源和当前工作的成员范围。');
      }
    }
    if (!value || value.workItemId !== chosen.workItemId || value.objectId !== chosen.objectId || value.label !== chosen.label || value.contentHash !== chosen.contentHash || digest(value.text) !== chosen.contentHash) throw new Error('引用资料与所选版本不一致，请重新选择。');
    if (value.byteLength !== Buffer.byteLength(value.text) || value.byteLength > 64 * 1024) throw new Error('引用资料超过 64 KB 或不完整，请重新选择较短的内容。');
    return value;
  }
}
