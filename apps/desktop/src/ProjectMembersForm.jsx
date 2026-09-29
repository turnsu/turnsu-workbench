import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
const command = (action, args) => invoke('local_command', { method: 'cloud.projectMembers.' + action, args });

export function ProjectMembersForm({ projectId, onClose, onUpdated, onBusyChange }) {
  const [record, setRecord] = useState(null), [people, setPeople] = useState([]), [actor, setActor] = useState(''), [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('');
  const row = useRef(null), mounted = useRef(true), lock = useRef(false);
  async function open() {
    const value = await command('open', { projectId });
    if (!mounted.current) return;
    row.current = value; setRecord(value); setPeople(value.people); setActor(value.actor); setMembers(value.data.members.map(member => member.userId)); setError('');
  }
  useEffect(() => { mounted.current = true; open().catch(e => { if (mounted.current) setError(String(e)); }); return () => { mounted.current = false; }; }, [projectId]);
  const frozen = record?.status !== 'draft', owner = record?.project.accountableOwnerUserId, editable = actor === owner;
  const original = record?.project.members.filter(person => person.userId !== owner).map(person => person.userId) || [];
  const names = new Map([...people, ...(record?.selectedPeople || [])].map(person => [person.userId, person.displayName]));
  const added = members.filter(id => !original.includes(id)), removed = original.filter(id => !members.includes(id));
  const choices = [...people, ...(record?.selectedPeople || []).filter(person => !people.some(value => value.userId === person.userId))].filter(person => person.userId !== owner);
  const filtered = choices.filter(person => `${person.displayName} ${person.username}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  async function act(submit) {
    if (lock.current || !row.current) return;
    lock.current = true; setBusy(true); setError(''); onBusyChange(true);
    try {
      const value = frozen ? row.current : await command('save', { id: row.current.id, memberIds: members });
      row.current = value; if (mounted.current) setRecord(value);
      if (!submit) { onClose(); return; }
      if (mounted.current) setRecord({ ...value, status: 'pending' });
      const result = await command('submit', { id: value.id, expectedHash: value.hash, confirm: true });
      row.current = result; if (mounted.current) setRecord(result);
      await onUpdated();
    } catch (e) {
      if (mounted.current) setError(String(e));
      try { const latest = await command('status', { id: row.current.id }); row.current = latest; if (mounted.current) setRecord(latest); } catch {}
    } finally { lock.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  }
  return <form className="projectCreationForm" onSubmit={event => { event.preventDefault(); act(true); }}>
    <h3>项目成员</h3>
    {(error || record?.error) && <p className="inlineError" role="alert">{error || record.error}</p>}
    {!record ? <><p>{error ? '名单未能读取。' : '正在读取项目成员…'}</p>{error && <button type="button" onClick={() => open().catch(e => setError(String(e)))}>重试读取</button>}</> : <>
      <p className="cloudNote">负责人：{names.get(owner) || '项目负责人'}。{editable ? '勾选参与此项目的同事。' : '成员调整请联系项目负责人。'}</p>
      {editable ? <fieldset className="projectMembers"><legend>参与成员</legend>
        {choices.length > 8 && <input aria-label="查找项目成员" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="按姓名查找"/>}
        <div className="projectMemberList">{filtered.map(person => <label key={person.userId}><input type="checkbox" disabled={busy || frozen || (members.length >= 63 && !members.includes(person.userId))} checked={members.includes(person.userId)} onChange={event => setMembers(ids => event.target.checked ? [...ids, person.userId] : ids.filter(id => id !== person.userId))}/><span>{person.displayName}<small>{person.username || '请核对成员是否仍在团队中'}</small></span></label>)}</div>
        {!filtered.length && <p className="cloudNote">{query ? '没有匹配的成员。' : '当前没有其他可选成员。'}</p>}
      </fieldset> : <p>{record.project.members.filter(person => person.userId !== owner).map(person => names.get(person.userId) || '项目成员').join('、') || '目前仅项目负责人'}</p>}
      {editable && <>
        {!!added.length && <p>将添加：{added.map(id => names.get(id) || '团队成员').join('、')}</p>}
        {!!removed.length && <p>将移除：{removed.map(id => names.get(id) || '项目成员').join('、')}</p>}
        <p className="cloudNote">移除后停止该成员对项目的云端访问，并撤销相关 Agent 借用。已下载的资料和私人会话会保留；团队管理员的管理权限不由此名单撤销。</p>
        {record.status === 'pending' && <p role="status">正在核对原调整结果，名单已固定。重试不会重复调整成员。</p>}
      </>}
    </>}
    <div className="cloudActions"><button type="button" disabled={busy} onClick={onClose}>返回</button>{record && editable && <>{!frozen && <button type="button" disabled={busy} onClick={() => act(false)}>保存草稿</button>}{record.status === 'rejected' ? <button type="button" disabled={busy} onClick={() => open().catch(e => setError(String(e)))}>重新读取名单</button> : <button type="submit" className="primary" disabled={busy || (!frozen && !added.length && !removed.length)}>{busy ? '正在核对…' : frozen ? '核对原调整结果' : '确认调整成员'}</button>}</>}</div>
  </form>;
}
