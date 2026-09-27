import React, { useEffect, useRef, useState } from 'react';
const command = (method, args) => window.__TAURI__.core.invoke('local_command', { method, args });

export function WorkHandoffEditor({ projectId, workItemId, onSaved, onClose }) {
  const [record, setRecord] = useState(null), [people, setPeople] = useState([]), [recipientId, setRecipient] = useState(''), [nextAction, setAction] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const row = useRef(null), mounted = useRef(true), lock = useRef(false);
  const frozen = record?.status === 'pending' || record?.status === 'done';
  async function open(preserveInput = false) {
    const value = await command('work.handoff.open', { projectId, workItemId });
    row.current = value;
    if (mounted.current) { setRecord(value); setPeople(value.people); if (!preserveInput || ['pending', 'done'].includes(value.status)) { setRecipient(value.payload.recipientId); setAction(value.payload.nextAction); } setError(''); }
  }
  useEffect(() => { mounted.current = true; open().catch(e => { if (mounted.current) setError(String(e)); }); return () => { mounted.current = false; }; }, [projectId, workItemId]);
  async function act(submit) {
    if (lock.current || !row.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const value = frozen ? row.current : await command('work.handoff.save', { id: row.current.id, recipientId, nextAction });
      row.current = value; if (mounted.current) setRecord(value);
      if (!submit) { onClose(); return; }
      if (mounted.current) setRecord({ ...value, status: 'pending' });
      await command('work.handoff.submit', { id: value.id, expectedHash: value.hash, confirm: true });
      await onSaved(); onClose();
    } catch (e) {
      if (mounted.current) setError(String(e));
      try {
        const latest = await command('work.handoff.status', { id: row.current.id }); row.current = latest;
        if (mounted.current) { setRecord(latest); if (['pending', 'done'].includes(latest.status)) { setRecipient(latest.payload.recipientId); setAction(latest.payload.nextAction); } }
        if (latest.status === 'done') { await onSaved(); onClose(); }
      } catch {}
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <form className="workDecisionEditor" onSubmit={e => { e.preventDefault(); act(true); }}>
    <h3>请同事接着做</h3><p className="cloudNote">对方会在团队工作中看到安排，再自行选择 Agent 开始处理。不会自动启动对方的 Agent 或使用其额度。</p>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {record?.error && !error && <p role="status" className="inlineError">{record.error}</p>}
    <label>接手成员{frozen ? <p>{record.payload.recipientName}</p> : <select autoFocus value={recipientId} disabled={!record || busy} onChange={e => setRecipient(e.target.value)}><option value="">选择一位可参与的同事</option>{people.map(p => <option key={p.userId} value={p.userId}>{p.displayName}（{p.username}）</option>)}</select>}</label>
    {record && !people.length && !frozen && <p className="cloudNote">还没有其他可参与的成员。请先由负责人设置这项工作的成员权限。</p>}
    <label>希望对方接着完成什么<textarea value={nextAction} maxLength={2000} disabled={!record || busy || frozen} onChange={e => setAction(e.target.value)} placeholder="例如：根据已确认的分类整理反馈，并补充下一步建议。"/></label>
    <div className="cloudActions"><button type="button" disabled={busy} onClick={onClose}>取消</button>{!frozen && <button type="button" disabled={!record || busy} onClick={() => act(false)}>保存草稿</button>}<button type="button" disabled={busy || frozen} onClick={() => open(true).catch(e => setError(String(e)))}>读取最新版本</button><button type="submit" className="primary" disabled={!record || busy || !recipientId || !nextAction.trim() || record.status === 'rejected'}>{busy ? '正在核对…' : frozen ? '核对并重试' : '确认交接'}</button></div>
  </form>;
}
