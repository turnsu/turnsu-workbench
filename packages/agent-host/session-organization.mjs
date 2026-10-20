const busy = new Set(['starting', 'running', 'waiting', 'stopping']);
export const organizationCommands = new Set(['project.rename', 'project.pin', 'session.pin', 'session.move', 'session.archive']);

function boolean(value) { if (typeof value !== 'boolean') throw new Error('请选择明确的操作。'); return value; }

// Changes only local organization. Execution keeps sessions.project_id and all
// native IDs, file receipts, permissions and draft bindings exactly as they were.
export function organize(host, method, args) {
  const db = host.db, now = Math.max(1, host.clock());
  if (method.startsWith('project.')) {
    const project = host.project(args.projectId);
    if (method === 'project.rename') {
      if (db.prepare('SELECT 1 FROM shared_projects WHERE project_id=?').get(project.id)) throw new Error('团队项目名称请在团队中管理。');
      if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) throw new Error('项目名称应为 1–80 个字符。');
      db.prepare('UPDATE projects SET name=? WHERE id=?').run(args.name.trim().replace(/\s+/g, ' '), project.id);
    } else {
      db.prepare('INSERT INTO project_organization VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET pinned_at=excluded.pinned_at').run(project.id, boolean(args.pinned) ? now : 0);
    }
    host.changed(); return host.project(project.id);
  }
  const session = host.session(args.sessionId);
  if (method === 'session.pin') {
    db.prepare('UPDATE sessions SET pinned_at=? WHERE id=?').run(boolean(args.pinned) ? now : 0, session.id);
  } else {
    if (host.operations.has(session.id) || busy.has(session.status)) throw new Error('请先结束当前任务，再移动或归档会话；等待回应的任务仍在进行中。');
    if (method === 'session.archive') {
      const archived = boolean(args.archived);
      db.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(archived ? session.archived_at || now : 0, session.id);
    } else {
      const target = host.project(args.projectId);
      if (db.prepare('SELECT 1 FROM shared_projects WHERE project_id IN (?,?,?) LIMIT 1').get(session.project_id, session.collection_project_id || session.project_id, target.id) || db.prepare('SELECT 1 FROM shared_work_sessions WHERE session_id=?').get(session.id)) throw new Error('团队会话不能跨项目整理，请在原团队项目中管理。');
      db.prepare('UPDATE sessions SET collection_project_id=? WHERE id=?').run(target.id === session.project_id ? null : target.id, session.id);
    }
  }
  host.changed(session.id); return host.readSession(session.id);
}
