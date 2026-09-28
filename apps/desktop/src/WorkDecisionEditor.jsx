import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
const command = (method, args) => invoke('local_command', { method, args });

export function WorkDecisionEditor({ projectId, workItemId, onSaved, onClose }) {
  const [record, setRecord] = useState(null), [payload, setPayload] = useState({ question: '', chosenOutcome: '', rationale: '' });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const row = useRef(null), current = useRef(payload), queue = useRef(Promise.resolve()), mounted = useRef(true), generation = useRef(0), lock = useRef(false);
  const frozen = record?.status === 'pending' || record?.status === 'done';
  useEffect(() => {
    mounted.current = true;
    command('work.decision.open', { projectId, workItemId }).then(value => { row.current = value; current.current = value.payload; if (mounted.current) { setRecord(value); setPayload(value.payload); } }).catch(e => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; };
  }, [projectId, workItemId]);
  function save(value) {
    const sequence = ++generation.current; setSaving(true);
    const next = queue.current.catch(() => {}).then(async () => {
      const result = await command('work.decision.save', { id: row.current.id, payload: value }); row.current = result;
      if (mounted.current && sequence === generation.current) { setRecord(result); setSaving(false); setError(''); }
      return result;
    });
    queue.current = next; next.catch(e => { if (mounted.current) { setError(String(e)); setSaving(false); } }); return next;
  }
  function change(key, value) { const next = { ...current.current, [key]: value }; current.current = next; setPayload(next); save(next); }
  async function submit(e) {
    e.preventDefault(); if (lock.current || !row.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await queue.current.catch(() => {});
      const value = frozen ? row.current : await save(current.current);
      if (mounted.current) setRecord({ ...value, status: 'pending' });
      await command('work.decision.submit', { id: value.id, expectedHash: value.hash, confirm: true });
      await onSaved(); onClose();
    } catch (e) {
      if (mounted.current) setError(String(e));
      try {
        const latest = await command('work.decision.status', { id: row.current.id }); row.current = latest;
        if (mounted.current) { setRecord(latest); if (['pending', 'done'].includes(latest.status)) { current.current = latest.payload; setPayload(latest.payload); } if (latest.status === 'done') { await onSaved(); onClose(); } }
      } catch {}
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <form className="workDecisionEditor" onSubmit={submit}>
    <h3>记录团队决定</h3><p className="cloudNote">由你作为工作负责人确认，对这项工作的成员可见。后续 Agent 会读取这条已确认结论。</p>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {record?.error && !error && <p role="status" className="inlineError">{record.error}</p>}
    <label>要决定的问题<input autoFocus value={payload.question} maxLength={1000} disabled={!record || busy || frozen} onChange={e => change('question', e.target.value)} placeholder="例如：这周先处理哪类反馈？"/></label>
    <label>已确认的结论<textarea value={payload.chosenOutcome} maxLength={1000} disabled={!record || busy || frozen} onChange={e => change('chosenOutcome', e.target.value)} placeholder="例如：先解决登录失败，再改善操作引导。"/></label>
    <details><summary>补充原因（可选）</summary><label>决定依据<textarea value={payload.rationale} maxLength={4000} disabled={!record || busy || frozen} onChange={e => change('rationale', e.target.value)}/></label></details>
    <div className="cloudActions"><small role="status">{saving ? '正在保存草稿…' : record && !frozen ? '草稿保存在本机' : ''}</small><button type="button" disabled={busy} onClick={onClose}>收起</button><button type="submit" className="primary" disabled={!record || busy || !payload.question.trim() || !payload.chosenOutcome.trim()}>{busy ? '正在核对…' : frozen ? '核对并重试' : '确认并记录'}</button></div>
  </form>;
}
