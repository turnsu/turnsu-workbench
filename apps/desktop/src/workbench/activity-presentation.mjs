// Presentation only: keep the original record, and never infer tool success.
export function describeActivity(message) {
  const text = String(message.text || '');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const first = lines[0] || '';
  const prose = /^[\u3400-\u9fff]/u.test(first);
  const file = message.kind === 'file';
  const title = file ? '文件变更' : prose ? first : message.kind === 'command' ? '运行命令' : '工具调用';
  const detail = file && lines.length > 1 ? `${first} 等 ${lines.length} 个文件` : prose && !file ? '' : first;
  return { title, detail, text, file, expandable: lines.length > 1 || first.length > 140 };
}

export function activityPhase(status, latest, messages = []) {
  if (messages.some(message => message.activity?.status === 'failed')) return 'failed';
  if (messages.some(message => message.activity?.status === 'interrupted')) return 'interrupted';
  if (!latest) return 'settled';
  if (messages.length && messages.every(message => ['completed', 'unknown'].includes(message.activity?.status))) return 'settled';
  return ['starting', 'running', 'waiting', 'stopping', 'failed', 'interrupted'].includes(status) ? status : 'settled';
}

export function toolState(message) {
  if (!message.activity) return { status: 'unknown', label: '未记录状态' };
  const status = message.activity.status;
  return { status, label: { pending: '等待执行', running: '执行中', waiting: '等待回应', completed: '调用完成', failed: '调用失败', interrupted: '已中断', unknown: '未收到完成回执' }[status] || '未记录状态' };
}

export function activitySummary(messages) {
  const first = describeActivity(messages[0]);
  const name = first.detail ? `${first.title} · ${first.detail}` : first.title;
  return messages.length > 1 ? `${name}等 ${messages.length} 项操作` : name;
}
