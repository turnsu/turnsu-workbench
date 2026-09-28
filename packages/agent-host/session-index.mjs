const PAGE_SIZE = 40;
const columns = 'id,project_id,title,status,error,updated_at,agent,model,connection_id';
const encode = row => Buffer.from(JSON.stringify([row.updated_at, row.id])).toString('base64url');
function decode(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('会话列表位置无效，请回到最近会话。');
  try {
    const tuple = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 2 || !Number.isSafeInteger(tuple[0]) || typeof tuple[1] !== 'string' || tuple[1].length > 128) throw new Error();
    return tuple;
  } catch { throw new Error('会话列表位置无效，请回到最近会话。'); }
}

// Stable tuple cursors avoid retaining earlier pages or materializing the complete index.
export function sessionIndex(db, { projectId, search = '', before, after } = {}) {
  if (before && after) throw new Error('请选择一个会话列表方向。');
  if (typeof search !== 'string' || search.length > 200) throw new Error('搜索内容过长。');
  if (!projectId) return { sessions: [], sessionPage: { total: 0, older: null, newer: null } };
  const pattern = search.trim().replace(/[\\%_]/g, char => '\\' + char);
  const filter = `project_id=?${pattern ? " AND title LIKE ? ESCAPE '\\'" : ''}`;
  const params = pattern ? [projectId, '%' + pattern + '%'] : [projectId];
  const boundary = before || after ? decode(before || after) : null;
  const comparison = after ? '>' : '<', direction = after ? 'ASC' : 'DESC';
  const sessions = db.prepare(`SELECT ${columns} FROM sessions WHERE ${filter}${boundary ? ` AND (updated_at,id) ${comparison} (?,?)` : ''} ORDER BY updated_at ${direction},id ${direction} LIMIT ${PAGE_SIZE}`)
    .all(...params, ...(boundary || []));
  if (after) sessions.reverse();
  const exists = (row, operator) => row && db.prepare(`SELECT 1 FROM sessions WHERE ${filter} AND (updated_at,id) ${operator} (?,?) LIMIT 1`).get(...params, row.updated_at, row.id);
  const first = sessions[0], last = sessions.at(-1);
  return { sessions, sessionPage: {
    total: db.prepare(`SELECT count(*) AS count FROM sessions WHERE ${filter}`).get(...params).count,
    older: exists(last, '<') ? encode(last) : null,
    newer: exists(first, '>') ? encode(first) : null,
  } };
}
