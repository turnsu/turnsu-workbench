import { referencePaths } from './file-references.mjs';

// A composer choice copies only the reviewed draft, never the source native history.
export function checkMethodDraft(db, { projectId, agent, workItemId, sourceDraft }) {
  if (sourceDraft === undefined) return null;
  if (!sourceDraft || typeof sourceDraft.text !== 'string' || sourceDraft.text.length > 100_000 ||
      (sourceDraft.sessionId != null && (typeof sourceDraft.sessionId !== 'string' || !sourceDraft.sessionId || sourceDraft.sessionId.length > 128))) throw new Error('请选择有效的任务草稿。');
  const id = sourceDraft.sessionId || '', refs = referencePaths(sourceDraft.references);
  const source = id ? db.prepare('SELECT * FROM sessions WHERE id=?').get(id) : null;
  if (id && (!source || source.project_id !== projectId || source.agent !== agent)) throw new Error('草稿不属于当前项目或 Agent，请重新选择。');
  if (source && ['starting', 'running', 'waiting', 'stopping'].includes(source.status)) throw new Error('请等当前任务结束再选择方法。');
  const shared = id ? db.prepare('SELECT work_item_id FROM shared_work_sessions WHERE session_id=?').get(id) : null;
  if ((shared?.work_item_id || null) !== (workItemId || null)) throw new Error('选择方法不能改变原草稿的共享范围，请回到原工作重试。');
  if (!workItemId && refs.some(ref => ref?.kind)) throw new Error('引用资料不属于当前团队工作。');
  const saved = id ? db.prepare('SELECT text FROM session_drafts WHERE session_id=?').get(id) : db.prepare('SELECT text FROM drafts WHERE project_id=?').get(projectId);
  const savedRefs = JSON.parse(db.prepare('SELECT paths FROM reference_drafts WHERE project_id=? AND session_id=?').get(projectId, id)?.paths || '[]');
  if ((saved?.text || '') !== sourceDraft.text || JSON.stringify(savedRefs) !== JSON.stringify(refs)) throw new Error('草稿已变化，请保留当前输入并重新选择方法。');
  return { text: sourceDraft.text, references: refs, model: source?.model || null };
}

// Called within the method/session transaction, after the last asynchronous preparation step.
export function copyMethodDraft(db, sessionId, input) {
  const draft = checkMethodDraft(db, input);
  if (!draft) return false;
  db.prepare('INSERT INTO session_drafts VALUES(?,?)').run(sessionId, draft.text);
  db.prepare('INSERT INTO reference_drafts VALUES(?,?,?)').run(input.projectId, sessionId, JSON.stringify(draft.references));
  if (draft.model) db.prepare('UPDATE sessions SET model=? WHERE id=?').run(draft.model, sessionId);
  return true;
}

export function checkMethodDraftIdentity(db, input, identity, viewerUserId) {
  if (!input.sourceDraft?.sessionId || !input.workItemId) return;
  const source = db.prepare('SELECT identity,actor_user_id FROM shared_work_sessions WHERE session_id=?').get(input.sourceDraft.sessionId);
  if (!source || source.identity !== JSON.stringify(identity) || source.actor_user_id !== viewerUserId) throw new Error('团队连接或成员已变化，请切回原账户后再使用这份草稿。');
}
