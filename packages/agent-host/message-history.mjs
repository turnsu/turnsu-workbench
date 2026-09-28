// Cursor reads keep native session history intact while bounding the desktop's visible window.
export function messageHistory(db, sessionId, { before, after } = {}) {
  if (before && after) throw new Error('请选择一个历史记录方向。');
  const cursor = before || after;
  let boundary = null;
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string' || !cursor || cursor.length > 512) throw new Error('历史记录位置无效，请回到最新消息。');
    boundary = db.prepare('SELECT rowid AS position,created_at FROM messages WHERE session_id=? AND id=?').get(sessionId, cursor);
    if (!boundary) throw new Error('找不到这段历史的位置，请回到最新消息。');
  }
  const direction = after ? 'ASC' : 'DESC', comparison = after ? '>' : '<';
  const rows = db.prepare(`SELECT rowid AS position,* FROM messages WHERE session_id=? ${boundary ? `AND (created_at,rowid) ${comparison} (?,?)` : ''} ORDER BY created_at ${direction},rowid ${direction} LIMIT 40`).iterate(...(boundary ? [sessionId, boundary.created_at, boundary.position] : [sessionId]));
  const selected = []; let size = 0;
  for (const row of rows) {
    if (selected.length && size + row.text.length > 256000) break;
    selected.push(row); size += row.text.length;
  }
  if (!after) selected.reverse();
  const first = selected[0], last = selected.at(-1);
  const exists = (row, operator) => row && db.prepare(`SELECT 1 FROM messages WHERE session_id=? AND (created_at,rowid) ${operator} (?,?) LIMIT 1`).get(sessionId, row.created_at, row.position);
  return {
    messages: selected.map(({ position, ...message }) => {
      const stored = db.prepare('SELECT files FROM input_references WHERE input_id=? AND session_id=?').get(message.id, sessionId);
      return { ...message, references: JSON.parse(stored?.files || '[]').map(({ text, ...file }) => file) };
    }),
    page: { older: exists(first, '<') ? first.id : null, newer: exists(last, '>') ? last.id : null },
  };
}
