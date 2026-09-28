import { invoke } from "./desktop-bridge.mjs";
import { WorkDecisionEditor } from "./WorkDecisionEditor.jsx";
import { WorkHandoffEditor } from "./WorkHandoffEditor.jsx";
import { TeamLoopsPanel } from "./TeamLoopsPanel.jsx";
import { MemberAssistancePanel } from './MemberAssistancePanel.jsx';
import { WorkResultPanel } from './WorkResultPanel.jsx';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Plus, ChevronLeft, ChevronRight, RotateCcw, Users } from 'lucide-react';
const command = (method, args) => invoke('local_command', { method, args });
const status = { draft: '草稿', ready: '待开始', active: '进行中', waiting_review: '待确认', completed: '已完成', blocked: '需要帮助', cancelled: '已取消' };
function Text({ children }) { return <ReactMarkdown components={{ img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>, a: ({ children }) => <span className="reference">{children}</span> }}>{children}</ReactMarkdown>; }
export function TeamWorkDialog({ project, agents, onOpen, onClose }) {
  const dialog = useRef(null), request = useRef(null), mounted = useRef(true);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [resultEntry, setResultEntry] = useState(null);
  const [handoffOpen, setHandoffOpen] = useState(false), [viewer, setViewer] = useState(null), [members, setMembers] = useState([]);
  const [items, setItems] = useState(null), [detail, setDetail] = useState(null), [creating, setCreating] = useState(false);
  const [description, setDescription] = useState(''), [agent, setAgent] = useState(() => agents.find(a => a.installed)?.id || 'codex'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const args = { projectId: project.id };
  function close() { dialog.current.close(); onClose(); }
  async function read() { const result = await command('work.list', args); if (mounted.current) { setItems(result.items); setViewer(result.viewerUserId); } }
  useEffect(() => { mounted.current = true; dialog.current.showModal(); read().catch(e => setError(String(e))); return () => { mounted.current = false; }; }, [project.id]);
  async function act(fn) { setBusy(true); setError(''); try { await fn(); } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) setBusy(false); } }
  async function openWork(workItemId, cursor) {
    if (detail?.workItem.workItemId !== workItemId) { setDecisionOpen(false); setHandoffOpen(false); setResultEntry(null); }
    const next = await command('work.read', { ...args, workItemId, ...(cursor ? { cursor } : {}) });
    setDetail(old => cursor && old?.workItem.workItemId === workItemId ? { ...next, entries: [...old.entries, ...next.entries] } : next);
  }
  useEffect(() => {
    let active = true; setMembers([]);
    if (detail) command('work.members', { ...args, workItemId: detail.workItem.workItemId }).then(value => { if (active) setMembers(value); }).catch(() => {});
    return () => { active = false; };
  }, [detail?.workItem.workItemId, detail?.etag]);
  async function continueWith(file) {
    await act(async () => {
      const references = [{ path: file.path, projectId: file.projectId, revisionId: file.revisionId }];
      const payload = JSON.stringify({ workItemId: detail.workItem.workItemId, agent, references });
      if (request.current?.payload !== payload) request.current = { id: crypto.randomUUID(), payload };
      const session = await command('work.continue', { ...args, workItemId: detail.workItem.workItemId, agent, references, requestId: request.current.id });
      await onOpen(session); close();
    });
  }
  const workEnded = detail && ['completed', 'cancelled'].includes(detail.workItem.status);
  const canContribute = !workEnded && (!detail || detail.workItem.members.some(m => m.userId === detail.viewerUserId && m.accessGrant.status === 'active' && ['owner', 'contribute'].includes(m.accessGrant.access)));
  const agentPicker = <label className="workAgent">用我的 Agent 处理<select aria-label="团队工作执行 Agent" value={agent} onChange={e => setAgent(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id} disabled={!a.installed}>{a.name}{a.installed ? '' : ' · 未安装'}</option>)}</select></label>;
  return <dialog ref={dialog} className="cloudDialog teamWorkDialog" aria-labelledby="team-work-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="team-work-heading">{detail?.workItem.title || (creating ? '新团队工作' : '团队工作')}</h2><button onClick={close} aria-label="关闭团队工作"><X size={18}/></button></div>
    {error && <p className="inlineError" role="alert">{error}</p>}
    {creating ? <form onSubmit={e => { e.preventDefault(); act(async () => { const payload = JSON.stringify({ description, agent }); if (request.current?.payload !== payload) request.current = { id: crypto.randomUUID(), payload }; const session = await command('work.start', { ...args, description, agent, requestId: request.current.id }); await onOpen(session); close(); }); }}>
      <button type="button" onClick={() => setCreating(false)}><ChevronLeft size={14}/>返回</button>
      <label htmlFor="team-work-description">想一起完成什么？</label><textarea id="team-work-description" autoFocus value={description} onChange={e => setDescription(e.target.value)} maxLength={100000} placeholder="例如：整理这周客户反馈，给出下一步行动。"/>
      {agentPicker}<p className="sharedScope"><Users size={15}/>项目成员可查看并参与；目标、本次请求和最终答复会自动共享。原有私有对话和工具日志不会上传。</p>
      <div className="cloudActions"><button className="primary" disabled={busy || !description.trim() || !agents.find(a => a.id === agent)?.installed} type="submit">{busy ? '正在创建…' : '创建并打开'}</button></div>
    </form> : detail ? <>
      <button onClick={() => { setDetail(null); read().catch(e => setError(String(e))); }}><ChevronLeft size={14}/>返回团队工作</button>
      <p className="workStatus">{status[detail.workItem.status]} · {detail.workItem.members.filter(m => m.accessGrant.status === 'active').length} 位成员</p>
      <div className="workObjective"><Text>{detail.workItem.objective}</Text></div>
      {detail.workItem.nextAction && <p>下一步：{detail.workItem.nextAction}</p>}
      {members.some(m => m.roles.includes('assignee')) && <p className="cloudNote">接手成员：{members.filter(m => m.roles.includes('assignee')).map(m => m.userId === detail.viewerUserId ? '我' : m.displayName).join('、')}</p>}
      {detail.viewerUserId === detail.workItem.accountableOwnerUserId && !['completed', 'cancelled'].includes(detail.workItem.status) && !handoffOpen && <button onClick={() => { setHandoffOpen(true); setDecisionOpen(false); }}><Users size={14}/>请同事接着做</button>}
      {handoffOpen && <WorkHandoffEditor key={detail.workItem.workItemId} projectId={project.id} workItemId={detail.workItem.workItemId} onClose={() => setHandoffOpen(false)} onSaved={() => openWork(detail.workItem.workItemId)}/>}
      {detail.viewerUserId === detail.workItem.accountableOwnerUserId && !decisionOpen && <button onClick={() => { setDecisionOpen(true); setHandoffOpen(false); }}><Plus size={14}/>记录决定</button>}
      {decisionOpen && <WorkDecisionEditor key={detail.workItem.workItemId} projectId={project.id} workItemId={detail.workItem.workItemId} onClose={() => setDecisionOpen(false)} onSaved={() => openWork(detail.workItem.workItemId)}/>}
      {detail.decisions.length > 0 && <section className="workDecisions"><h3>已记录的决定</h3>{detail.decisions.map(d => <div key={d.decisionId}><strong>{d.question}</strong><Text>{d.chosenOutcome}</Text></div>)}</section>}
      <WorkResultPanel key={'result-' + detail.workItem.workItemId + '-' + detail.viewerUserId} projectId={project.id} detail={detail} members={members} selectedEntry={resultEntry} onCancelSubmission={() => setResultEntry(null)} onChanged={() => openWork(detail.workItem.workItemId)} renderFiles={files => files.map(file => <SharedFileReference key={file.revisionId} file={file} projectId={project.id} workItemId={detail.workItem.workItemId} canUse={canContribute && Boolean(agents.find(a => a.id === agent)?.installed)} busy={busy} agentName={agents.find(a => a.id === agent)?.name || agent} onUse={() => continueWith(file)}/>)}/>
      <div className="workContinue">{agentPicker}<button className="primary" disabled={busy || !canContribute || !agents.find(a => a.id === agent)?.installed} onClick={() => act(async () => { const session = await command('work.continue', { ...args, workItemId: detail.workItem.workItemId, agent }); await onOpen(session); close(); })}>用我的 Agent 继续</button><p className="cloudNote">{workEnded ? '这项工作已结束，成果保留在上方。后续任务请新建团队工作。' : canContribute ? '带入目标、已记录的决定和最近 20 条更新。你的新请求与最终答复会自动共享。' : '你目前只能查看这项工作。请联系工作负责人开放参与权限。'}</p></div>
      <TeamLoopsPanel key={detail.workItem.workItemId} projectId={project.id} workItem={detail.workItem} canRun={canContribute}/>
      <MemberAssistancePanel key={'assistance-' + detail.workItem.workItemId} projectId={project.id} workItem={detail.workItem} viewerUserId={detail.viewerUserId} members={members} canContribute={canContribute}/>
      <div className="cloudListHeading"><strong>共享进展</strong><button disabled={busy} onClick={() => act(() => openWork(detail.workItem.workItemId))}><RotateCcw size={14}/>刷新</button></div>
      <div className="workUpdates">{detail.entries.map(entry => <article key={entry.entryId}><time>{new Date(entry.occurredAt).toLocaleString()}</time><Text>{entry.summary}</Text>{entry.fileReferences?.map(file => <SharedFileReference key={file.revisionId} file={file} projectId={project.id} workItemId={detail.workItem.workItemId} canUse={canContribute && Boolean(agents.find(a => a.id === agent)?.installed)} busy={busy} agentName={agents.find(a => a.id === agent)?.name || agent} onUse={() => continueWith(file)}/>) }{canContribute && entry.createdByUserId === detail.viewerUserId && entry.kind === 'comment' && !['completed', 'cancelled'].includes(detail.workItem.status) && <button disabled={busy} onClick={() => setResultEntry(entry)}>提交这份结果</button>}</article>)}</div>
      {detail.page?.hasMore && <button disabled={busy} onClick={() => act(() => openWork(detail.workItem.workItemId, detail.page.nextCursor))}>查看更早的更新</button>}
    </> : <>
      <div className="cloudListHeading"><span>{project.sharing.title}</span><button disabled={busy} onClick={() => act(read)} aria-label="刷新团队工作"><RotateCcw size={14}/></button></div>
      <button className="newTeamWork" onClick={() => setCreating(true)}><Plus size={16}/>新团队工作</button>
      <div className="cloudProjects">{items?.map(item => <button key={item.workItemId} disabled={busy} onClick={() => act(() => openWork(item.workItemId))}><span><strong>{item.title}</strong><small>{status[item.status]}{item.members.some(m => m.userId === viewer && m.accessGrant.status === 'active' && m.roles.includes('assignee')) ? ' · 安排给我' : ''}</small></span><ChevronRight size={15}/></button>)}</div>
      {items === null ? <p className="cloudNote">正在读取团队工作…</p> : !items.length ? <p className="cloudEmpty">还没有团队工作。写下一个目标，让成员和各自的 Agent 在这里接着做。</p> : <p className="cloudNote">选择一项工作，查看进展或交给自己的 Agent 继续。</p>}
    </>}
  </dialog>;
}

function SharedFileReference({ projectId, workItemId, file, canUse, busy: working, agentName, onUse }) {
  const [content, setContent] = useState(null), [error, setError] = useState('');
  const busy = useRef(false);
  async function read() {
    if (busy.current) return;
    busy.current = true; setError(''); setContent(null);
    try {
      const value = await command('work.file', { projectId, workItemId, revisionId: file.revisionId });
      if (value.path !== file.path || value.contentHash !== file.contentHash) throw new Error('文件引用已不匹配，请刷新团队工作。');
      setContent(value.text);
    } catch (e) { setError(String(e)); } finally { busy.current = false; }
  }
  return <details className="sentReference" onToggle={e => { if (e.currentTarget.open) read(); else setContent(null); }}><summary>{file.path}<small>当时使用的资料</small></summary>{error ? <p role="alert">{error}<button onClick={read}>重试读取</button></p> : <><pre tabIndex={0}>{content ?? '正在读取…'}</pre>{content !== null && <div className="referenceContinue"><button disabled={!canUse || working} onClick={onUse}>用 {agentName} 接着做</button><small>保留这个版本，先带入任务草稿</small></div>}</>}</details>;
}
