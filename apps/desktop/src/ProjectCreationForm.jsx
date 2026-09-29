import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
const command = (action, args) => invoke('local_command', { method: 'cloud.projectCreation.' + action, args });

export function ProjectCreationForm({ localProject, onCreated, onClose, onBusyChange }) {
  const [record, setRecord] = useState(null), [people, setPeople] = useState([]), [title, setTitle] = useState(''), [objective, setObjective] = useState(''), [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('');
  const row = useRef(null), mounted = useRef(true), lock = useRef(false);
  const frozen = record && record.status !== 'draft';
  async function open() {
    const value = await command('open', localProject ? { localProjectId: localProject.id } : {});
    if (!mounted.current) return;
    row.current = value; setRecord(value); setPeople(value.people); setTitle(value.data.title); setObjective(value.data.objective); setMembers(value.data.members.map(member => member.userId)); setError('');
  }
  useEffect(() => { mounted.current = true; open().catch(e => { if (mounted.current) setError(String(e)); }); return () => { mounted.current = false; }; }, [localProject?.id]);
  async function act(create) {
    if (lock.current || !row.current) return;
    lock.current = true; setBusy(true); setError(''); onBusyChange(true);
    try {
      const value = frozen ? row.current : await command('save', { id: row.current.id, title, objective, memberIds: members });
      row.current = value; if (mounted.current) setRecord(value);
      if (!create) { onClose(); return; }
      if (mounted.current) setRecord({ ...value, status: 'pending' });
      const created = await command('submit', { id: value.id, expectedHash: value.hash, confirm: true });
      row.current = created; if (mounted.current) setRecord(created);
      await onCreated(created.project);
    } catch (e) {
      if (mounted.current) setError(String(e));
      if (row.current) try { const latest = await command('status', { id: row.current.id }); row.current = latest; if (mounted.current) setRecord(latest); } catch {}
    } finally { lock.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  }
  const filtered = people.filter(person => `${person.displayName} ${person.username}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <form className="projectCreationForm" onSubmit={event => { event.preventDefault(); act(true); }}>
    <h3>创建团队项目</h3><p className="cloudNote">由团队管理员创建。只有你和选中的成员可以访问；创建完成后，再选择本机要共享的文件。</p>
    {(error || record?.error) && <p className="inlineError" role="alert">{error || record.error}</p>}
    {!record ? <><p>{error ? '原本机项目和草稿不受影响。' : '正在读取成员名单…'}</p>{error && <button type="button" onClick={() => open().catch(e => setError(String(e)))}>重试读取</button>}</> : <>
      <label>项目名称<input autoFocus value={title} maxLength={200} disabled={busy || frozen} onChange={event => setTitle(event.target.value)} required/></label>
      <label>要一起完成什么 <small>可选</small><input value={objective} maxLength={2000} disabled={busy || frozen} onChange={event => setObjective(event.target.value)} placeholder="例如：整理客户反馈，跟进改进结果"/></label>
      <fieldset className="projectMembers"><legend>参与成员</legend><p className="cloudNote">你是项目负责人。</p>
        {frozen ? <p>{record.selectedPeople.length ? record.selectedPeople.map(person => `${person.displayName}（${person.username}）`).join('、') : '本次仅你自己'}</p> : <>
          {people.length > 8 && <input aria-label="查找团队成员" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="按姓名查找"/>}
          <div className="projectMemberList">{filtered.map(person => <label key={person.userId}><input type="checkbox" disabled={busy || (members.length >= 63 && !members.includes(person.userId))} checked={members.includes(person.userId)} onChange={event => setMembers(ids => event.target.checked ? [...ids, person.userId] : ids.filter(id => id !== person.userId))}/><span>{person.displayName}<small>{person.username}</small></span></label>)}</div>
          {!filtered.length && <p className="cloudNote">{query ? '没有匹配的成员。' : '当前没有其他可选成员，可以先创建自己的项目。'}</p>}
        </>}
      </fieldset>
      {record.status === 'pending' && <p role="status" className="cloudNote">正在核对原创建请求。成员和内容已固定，重试不会再建一个项目。</p>}
    </>}
    <div className="cloudActions"><button type="button" disabled={busy} onClick={onClose}>返回</button>{record && !frozen && <button type="button" disabled={busy || !title.trim()} onClick={() => act(false)}>保存草稿</button>}{record?.status === 'rejected' ? <button type="button" disabled={busy} onClick={() => open().catch(e => setError(String(e)))}>修改草稿</button> : <button type="submit" className="primary" disabled={!record || busy || !title.trim()}>{busy ? '正在核对…' : frozen ? '核对原创建结果' : `创建项目 · ${members.length + 1} 人`}</button>}</div>
  </form>;
}
