import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react';
const command = (method, args) => window.__TAURI__.core.invoke('local_command', { method, args });
export function TeamSkillsDialog({ project, agents, workSession, onOpen, onClose, inline = false, initialAgent, sourceDraft, onBeforeUse, onBusyChange }) {
  const dialog = useRef(null), mounted = useRef(true), intent = useRef(null);
  const [items, setItems] = useState(null), [page, setPage] = useState(null), [selected, setSelected] = useState(null);
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [kind, setKind] = useState('skill');
  const isLoop = kind === 'loop';
  const summary = item => isLoop ? item.loopSummary : item.skillSummary;
  const [scope, setScope] = useState(workSession ? 'team' : 'private');
  const [agent, setAgent] = useState(() => initialAgent || agents.find(a => a.installed)?.id || 'codex');
  function close() { if (busy) return; if (!inline) dialog.current.close(); onClose(); }
  async function read(cursor, assetKind = kind) {
    const result = await command(assetKind === 'loop' ? 'nativeLoops.list' : 'methods.list', cursor ? { cursor } : {});
    if (!mounted.current) return;
    setItems(old => cursor ? [...new Map([...(old || []), ...result.items].map(item => [item.releaseId, item])).values()] : result.items); setPage(result.page);
  }
  async function act(fn, lock = false) { setBusy(true); if (lock) onBusyChange?.(true); setError(''); try { await fn(); } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) { setBusy(false); if (lock) onBusyChange?.(false); } } }
  useEffect(() => { mounted.current = true; if (!inline) dialog.current.showModal(); act(() => read()); return () => { mounted.current = false; }; }, []);
  async function useSkill() {
    const workItemId = scope === 'team' ? workSession?.id : undefined;
    const args = { projectId: project.id, agent, releaseId: selected.releaseId, ...(workItemId ? { workItemId } : {}), ...(sourceDraft ? { sourceDraft } : {}) };
    const payload = JSON.stringify(args);
    if (intent.current?.payload !== payload) intent.current = { payload, id: crypto.randomUUID() };
    await onBeforeUse?.();
    const session = await command(isLoop ? 'nativeLoops.use' : 'methods.use', { ...args, requestId: intent.current.id });
    await onOpen(session); onClose();
  }
  const filtered = (items || []).filter(item => `${summary(item)?.name || ''} ${summary(item)?.description || summary(item)?.goal || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const Wrapper = inline ? 'section' : 'dialog';
  return <Wrapper ref={dialog} className={inline ? "inlineTeamMethods" : "cloudDialog teamSkillsDialog"} aria-labelledby="team-skills-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="team-skills-heading">{(selected && summary(selected)?.name) || '团队方法'}</h2>{!inline && <button disabled={busy} onClick={close} aria-label="关闭团队方法"><X size={18}/></button>}</div>
    {error && <p className="inlineError" role="alert">{error}</p>}
    {selected ? <>
      <button disabled={busy} onClick={() => setSelected(null)}><ChevronLeft size={14}/>返回方法</button>
      <p className="workStatus">团队发布 · v{selected.version || '已固定版本'}</p>
      <p className="skillDescription">{summary(selected)?.description || summary(selected)?.goal}</p>
      {isLoop && summary(selected)?.expectedResult && <p><strong>可以得到</strong><br/>{summary(selected).expectedResult}</p>}
      {!!summary(selected)?.inputs?.length && <p><strong>需要你提供</strong><br/>{summary(selected).inputs.join('、')}</p>}
      {!!summary(selected)?.outputs?.length && <p><strong>可以得到</strong><br/>{summary(selected).outputs.join('、')}</p>}
      {selected.releaseNotes && <details><summary>版本说明</summary><p className="skillDescription">{selected.releaseNotes}</p></details>}
      <label className="workAgent">使用你的 Agent<select aria-label="方法执行 Agent" value={agent} disabled={busy || Boolean(sourceDraft)} onChange={e => setAgent(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id} disabled={!a.installed}>{a.name}{a.installed ? '' : ' · 未安装'}</option>)}</select></label>
      <p className="cloudNote">将{isLoop ? "流程及固定技能" : "技能"}加入「{project.sharing?.title || project.name}」，再打开新任务。使用你自己的模型账户；已有同名技能和本地修改不会被覆盖。</p>
      {workSession && !sourceDraft && <fieldset className="methodScope"><legend>这次用于</legend><label><input type="radio" name="method-scope" value="team" checked={scope === 'team'} disabled={busy} onChange={() => setScope('team')}/>继续「{workSession.title}」</label><label><input type="radio" name="method-scope" value="private" checked={scope === 'private'} disabled={busy} onChange={() => setScope('private')}/>独立的本机任务</label></fieldset>}
      <p className="cloudNote">{sourceDraft && '已写的任务和引用会带入新任务，原草稿保留；原生会话历史不会复制。'}{scope === 'team' ? '带入当前团队目标、决定和进展；本次请求、所选方法版本和最终答复会自动共享给工作成员。' : '新任务的对话仅在本机保存。'}添加后描述任务并发送，才会调用模型。{project.sharing ? '项目中的普通文件仍按当前共享设置同步。' : ''}</p>
      <div className="cloudActions"><button className="primary" disabled={busy || !agents.find(a => a.id === agent)?.installed} onClick={() => act(useSkill, true)}>{busy ? '正在添加…' : scope === 'team' ? '添加并继续团队工作' : '添加并开始新任务'}</button></div>
    </> : <>
      <div className="cloudActions"><button aria-pressed={!isLoop} disabled={busy} onClick={() => act(async () => { setKind('skill'); setItems(null); setQuery(''); await read(undefined, 'skill'); })}>技能</button><button aria-pressed={isLoop} disabled={busy} onClick={() => act(async () => { setKind('loop'); setItems(null); setQuery(''); await read(undefined, 'loop'); })}>本机流程</button></div>
      <p className="cloudNote">把团队已发布的方法交给自己的 Agent。选择方法后，仍由你描述要完成的任务。</p>
      <div className="skillSearch"><Search size={16}/><input aria-label="搜索团队方法" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索方法"/><button disabled={busy} onClick={() => act(() => read())} aria-label="刷新团队方法"><RotateCcw size={15}/></button></div>
      <div className="cloudProjects">{filtered.map(item => <button key={item.releaseId} disabled={busy} onClick={() => setSelected(item)}><span><strong>{summary(item)?.name || '已发布方法'}</strong><small>{summary(item)?.description || summary(item)?.goal || item.releaseNotes}</small><small>v{item.version || '已固定版本'}</small></span><ChevronRight size={15}/></button>)}</div>
      {items === null ? <p className="cloudNote">{error ? '连接团队后可重试读取。' : '正在读取团队方法…'}</p> : !filtered.length ? <p className="cloudEmpty">{query ? '当前已加载的方法中没有匹配项。' : '团队还没有发布此类可在本机复用的方法。'}</p> : null}
      {page?.hasMore && <button disabled={busy} onClick={() => act(() => read(page.nextCursor))}>加载更多</button>}
    </>}
  </Wrapper>;
}
