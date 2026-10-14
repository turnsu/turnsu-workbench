const PAGE_SIZE = 40;
const columns = 'id,project_id,collection_project_id,title,status,error,updated_at,agent,model,connection_id,pinned_at,archived_at';
const encode = row => Buffer.from(JSON.stringify([row.pinned_at, row.updated_at, row.id])).toString('base64url');
function decode(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('会话列表位置无效，请回到最近会话。');
  try {
    const tuple = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Array.isArray(tuple) && tuple.length === 2) tuple.unshift(0);
    if (!Array.isArray(tuple) || tuple.length !== 3 || !Number.isSafeInteger(tuple[0]) || !Number.isSafeInteger(tuple[1]) || typeof tuple[2] !== 'string' || tuple[2].length > 128) throw new Error();
    return tuple;
  } catch { throw new Error('会话列表位置无效，请回到最近会话。'); }
}

// Stable tuple cursors avoid retaining earlier pages or materializing the complete index.
export function sessionIndex(db, { projectId, search = '', before, after, archived = false, allProjects = false } = {}) {
  if (before && after) throw new Error('请选择一个会话列表方向。');
  if (typeof search !== 'string' || search.length > 200) throw new Error('搜索内容过长。');
  if (typeof archived !== 'boolean' || typeof allProjects !== 'boolean') throw new Error('会话筛选无效。');
  if (!projectId && !allProjects) return { sessions: [], sessionPage: { total: 0, older: null, newer: null } };
  const pattern = search.trim().replace(/[\\%_]/g, char => '\\' + char);
  const filter = `${allProjects ? '1=1' : 'COALESCE(collection_project_id,project_id)=?'} AND archived_at${archived ? '>0' : '=0'}${pattern ? " AND title LIKE ? ESCAPE '\\'" : ''}`;
  const params = [...(allProjects ? [] : [projectId]), ...(pattern ? ['%' + pattern + '%'] : [])];
  const boundary = before || after ? decode(before || after) : null;
  const comparison = after ? '>' : '<', direction = after ? 'ASC' : 'DESC';
  const sessions = db.prepare(`SELECT ${columns} FROM sessions WHERE ${filter}${boundary ? ` AND (pinned_at,updated_at,id) ${comparison} (?,?,?)` : ''} ORDER BY pinned_at ${direction},updated_at ${direction},id ${direction} LIMIT ${PAGE_SIZE}`)
    .all(...params, ...(boundary || []));
  if (after) sessions.reverse();
  const exists = (row, operator) => row && db.prepare(`SELECT 1 FROM sessions WHERE ${filter} AND (pinned_at,updated_at,id) ${operator} (?,?,?) LIMIT 1`).get(...params, row.pinned_at, row.updated_at, row.id);
  const first = sessions[0], last = sessions.at(-1);
  return { sessions, sessionPage: {
    total: db.prepare(`SELECT count(*) AS count FROM sessions WHERE ${filter}`).get(...params).count,
    older: exists(last, '<') ? encode(last) : null,
    newer: exists(first, '>') ? encode(first) : null,
  } };
}
