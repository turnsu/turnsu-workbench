import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Check, Folder, FolderInput, Pencil, Pin, PinOff, Plus, Search, X } from 'lucide-react';

const projectName = project => project.sharing?.title || project.name;

export function SessionDateDivider({ session, previous }) {
  const group = item => item?.pinned_at ? 'pinned' : item ? new Date(item.updated_at).toDateString() : '';
  if (group(session) === group(previous)) return null;
  const today = new Date(), yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const date = new Date(session.updated_at);
  const label = session.pinned_at ? '置顶' : date.toDateString() === today.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return <div className="sessionDateDivider">{label}</div>;
}

export function SessionActions({ session, anchor, busy, onClose, onRename, onPin, onMove, onArchive }) {
  const menu = useRef(null);
  const running = ['starting', 'running', 'waiting', 'stopping'].includes(session.status);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect(), element = menu.current;
    element.style.left = Math.min(rect.right + 6, window.innerWidth - 232) + 'px';
    element.style.top = Math.max(12, Math.min(rect.top, window.innerHeight - element.offsetHeight - 12)) + 'px';
    element.querySelector('button:not(:disabled)')?.focus();
    const outside = event => { if (!element.contains(event.target) && !anchor.contains(event.target)) onClose({ restoreFocus: false }); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', onClose); };
  }, []);
  const act = action => { onClose(); action(); };
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Tab') { anchor.focus(); onClose({ restoreFocus: false }); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')], current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return createPortal(<div ref={menu} className="sessionActionsMenu" role="menu" aria-label="会话选项" onKeyDown={keydown}>
    <span className="menuTitle">{session.title}</span>
    <button role="menuitem" disabled={busy} onClick={() => act(onRename)}><Pencil size={15}/>重命名</button>
    <button role="menuitem" disabled={busy} onClick={() => act(onPin)}>{session.pinned_at ? <PinOff size={15}/> : <Pin size={15}/>} {session.pinned_at ? '取消置顶' : '置顶会话'}</button>
    <button role="menuitem" disabled={busy || running} onClick={() => act(onMove)}><FolderInput size={15}/>移到项目…</button>
    <button role="menuitem" disabled={busy || running} onClick={() => act(onArchive)}>{session.archived_at ? <ArchiveRestore size={15}/> : <Archive size={15}/>} {session.archived_at ? '恢复到最近会话' : '归档会话'}</button>
    {running && <small>结束当前任务后可移动或归档。</small>}
  </div>, document.body);
}

export function RenameSessionDialog({ value, busy, error, onChange, onSubmit, onClose }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); dialog.current.querySelector('input')?.select(); }, []);
  return <dialog ref={dialog} className="workspaceDialog renameSessionDialog" aria-labelledby="rename-session-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="workspaceDialogHeading"><h2 id="rename-session-title">重命名会话</h2><button aria-label="取消重命名" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <form className="projectNameForm" onSubmit={onSubmit}><label>会话名称<input autoFocus required aria-label="会话名称" maxLength={80} value={value} disabled={busy} onChange={e => onChange(e.target.value)}/></label>
      {error && <p role="alert" className="inlineError">{error}</p>}
      <div className="workspaceDialogFooter"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" aria-label="保存会话名称" disabled={busy || !value.trim()} type="submit">{busy ? '正在保存…' : '保存名称'}</button></div>
    </form>
  </dialog>;
}

export function ProjectsDialog({ projects, currentId, onClose, onOpen, onOpenFolder, onAction }) {
  const dialog = useRef(null);
  const [search, setSearch] = useState(''), [editing, setEditing] = useState(null), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current.showModal(); }, []);
  async function perform(method, args) {
    setBusy(true); setError('');
    try { await onAction(method, args); setEditing(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const items = projects.filter(p => (projectName(p) + ' ' + p.path).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <dialog ref={dialog} className="workspaceDialog" aria-labelledby="projects-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="workspaceDialogHeading"><div><h2 id="projects-title">我的项目</h2><p>按工作整理对话，文件保留在本机。</p></div><button aria-label="关闭项目管理" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <label className="managementSearch"><Search size={16}/><input autoFocus aria-label="搜索项目" placeholder="搜索名称或文件夹" value={search} onChange={e => setSearch(e.target.value)}/></label>
    {error && <p role="alert" className="inlineError">{error}</p>}
    <div className="managedProjectList">
      {items.map(p => <div className="managedProject" key={p.id}>
        {editing === p.id ? <form className="projectNameForm" onSubmit={e => { e.preventDefault(); perform('project.rename', { projectId: p.id, name }); }}><label>项目名称<input autoFocus aria-label="项目名称" maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)}/></label><small>只修改显示名称，磁盘文件夹不会改名。</small><div><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy || !name.trim()} type="submit">保存名称</button></div></form> : <>
          <button className="managedProjectOpen" disabled={busy} onClick={() => onOpen(p.id)}><Folder size={20}/><span><strong>{projectName(p)}{currentId === p.id && <small>当前</small>}</strong><span className="projectLocation" title={p.path}>{p.path}</span><small>{p.session_count || 0} 段会话{p.sharing ? ' · 团队项目' : ''}</small></span></button>
          <div className="projectActions"><button aria-label={(p.pinned_at ? '取消置顶项目：' : '置顶项目：') + projectName(p)} title={p.pinned_at ? '取消置顶' : '置顶项目'} aria-pressed={Boolean(p.pinned_at)} disabled={busy} onClick={() => perform('project.pin', { projectId: p.id, pinned: !p.pinned_at })}><Pin size={15}/></button><button aria-label={'重命名项目：' + projectName(p)} title={p.sharing ? '团队项目名称请在团队中管理' : '重命名'} disabled={busy || Boolean(p.sharing)} onClick={() => { setEditing(p.id); setName(p.name); }}><Pencil size={15}/></button></div>
        </>}
      </div>)}
      {!items.length && <p className="managementEmpty">{projects.length ? '没有找到匹配的项目。' : '还没有项目，从一个工作文件夹开始。'}</p>}
    </div>
    <div className="workspaceDialogFooter"><button className="primary" disabled={busy} onClick={onOpenFolder}><Plus size={16}/>打开工作文件夹</button><small>可在系统选择器中新建文件夹。</small></div>
  </dialog>;
}

export function MoveSessionDialog({ session, projects, onClose, onMove }) {
  const dialog = useRef(null), currentId = session.collection_project_id || session.project_id;
  const [search, setSearch] = useState(''), [targetId, setTargetId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = projects.find(p => p.id === session.project_id);
  const candidates = projects.filter(p => p.id !== currentId && !p.sharing && projectName(p).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  useEffect(() => { dialog.current.showModal(); }, []);
  async function move() {
    setBusy(true); setError('');
    try { await onMove(targetId); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  return <dialog ref={dialog} className="workspaceDialog moveSessionDialog" aria-labelledby="move-session-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="workspaceDialogHeading"><div><h2 id="move-session-title">移到项目</h2><p className="moveSessionTitle">{session.title}</p></div><button aria-label="取消移动会话" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <div className="moveExplanation"><Folder size={18}/><span>继续使用原工作文件夹<strong>{working?.name}</strong><small>{working?.path}</small></span></div>
    <p className="moveHint">只调整会话的归类。继续使用原来的文件、Agent 和草稿。</p>
    <label className="managementSearch"><Search size={16}/><input autoFocus aria-label="搜索目标项目" placeholder="选择放在哪个项目" value={search} onChange={e => setSearch(e.target.value)}/></label>
    <div className="moveTargets" role="radiogroup" aria-label="目标项目">{candidates.map(p => <label key={p.id} className={targetId === p.id ? 'selected' : ''}><input type="radio" name="move-project" value={p.id} checked={targetId === p.id} disabled={busy} onChange={() => setTargetId(p.id)}/><Folder size={17}/><span><strong>{projectName(p)}</strong><small>{p.path}</small></span>{targetId === p.id && <Check size={16}/>}</label>)}{!candidates.length && <p className="managementEmpty">没有可选的其他本地项目。可先在“我的项目”中打开工作文件夹。</p>}</div>
    {error && <p className="inlineError" role="alert">{error}</p>}
    <div className="workspaceDialogFooter"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !targetId} onClick={move}>{busy ? '正在移动…' : '移到所选项目'}</button></div>
  </dialog>;
}
