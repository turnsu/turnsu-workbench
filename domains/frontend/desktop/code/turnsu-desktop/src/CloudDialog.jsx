import React, { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, RotateCcw, ChevronRight, ChevronLeft, LoaderCircle } from 'lucide-react';
import { ShareScopePicker } from './ShareScopePicker.jsx';
import { ProjectMembersForm } from './ProjectMembersForm.jsx';
import { ProjectCreationForm } from './ProjectCreationForm.jsx';
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const command = (method, args = {}) => invoke('local_command', { method, args });

export function CloudDialog({ onClose, onJoin, localProject }) {
  const dialog = useRef(null), mounted = useRef(true);
  const [state, setState] = useState(null), [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [project, setProject] = useState(null);
  const [selectingScope, setSelectingScope] = useState(false);
  const [editingMembers, setEditingMembers] = useState(false);
  const [creating, setCreating] = useState(false), [creatingBusy, setCreatingBusy] = useState(false);
  function close() { if (creatingBusy) return; dialog.current.close(); onClose(); }
  async function read() { const value = await command('cloud.status'); if (mounted.current) { setState(value); if (value.origin) setOrigin(value.origin); } return value; }
  useEffect(() => {
    mounted.current = true; dialog.current.showModal(); let dispose;
    window.__TAURI__.event.listen('local-host-event', ({ payload }) => { if (payload.type === 'cloud-changed') read().catch(e => setError(String(e))); }).then(fn => { if (mounted.current) dispose = fn; else fn(); });
    read().then(value => { if (value.status === 'connected') return command('cloud.projects').then(value => { if (mounted.current) setState(value); }); }).catch(e => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; dispose?.(); };
  }, []);
  async function act(fn) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { if (mounted.current) setBusy(false); } }
  async function connect(event) {
    event.preventDefault();
    await act(async () => { const next = await command('cloud.connect', { origin: origin.trim() }); setState(next); if (next.status === 'connecting') await invoke('open_cloud_authorization'); });
  }
  const connected = ['connected', 'unavailable'].includes(state?.status);
  return <dialog ref={dialog} className="cloudDialog" aria-labelledby="cloud-heading" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="cloud-heading">{project || creating ? '团队项目' : '连接团队'}</h2><button disabled={creatingBusy} onClick={close} aria-label="关闭团队连接"><X size={18}/></button></div>
    {(error || state?.error) && <p className="inlineError" role="alert">{error || state.error}</p>}
    {!state ? <p className="muted"><LoaderCircle className="spin" size={15}/>正在读取连接…</p> : creating ? <ProjectCreationForm localProject={localProject} onBusyChange={setCreatingBusy} onClose={() => setCreating(false)} onCreated={value => { setCreating(false); setProject(value); setSelectingScope(Boolean(localProject && !localProject.sharing)); }}/> : project && editingMembers ? <ProjectMembersForm projectId={project.projectId} onBusyChange={setCreatingBusy} onClose={() => setEditingMembers(false)} onUpdated={async () => { setProject(await command('cloud.project', { projectId: project.projectId })); setEditingMembers(false); await command('cloud.projects'); }}/> : project ? <>
      <button disabled={busy} onClick={() => { setProject(null); setSelectingScope(false); }}><ChevronLeft size={14}/>返回项目</button>
      <h3>{project.title}</h3><p className="projectObjective">{project.objective}</p><p className="muted">{project.members.length} 位项目成员 · {project.status === 'archived' ? '已归档' : '进行中'}</p>
      <button disabled={busy} onClick={() => setEditingMembers(true)}>查看与管理成员</button>
      {selectingScope && localProject ? <ShareScopePicker project={localProject} busy={busy} onCancel={() => setSelectingScope(false)} onConfirm={scope => act(async () => { await command('sync.attach', { projectId: localProject.id, remoteId: project.projectId, scope }); await onJoin(localProject); close(); })}/> : <>
      {localProject && !localProject.sharing && <div className="cloudActions"><button className="primary" disabled={busy || project.status === 'archived'} onClick={() => setSelectingScope(true)}>选择「{localProject.name}」中的共享内容</button></div>}
      <p>选择一个空文件夹作为这个项目的共享工作区。团队文件会下载到这里；你或 Agent 保存的新文件会自动与项目成员共享。</p>
      <p className="cloudNote">私有对话、隐藏文件和符号链接不会上传。单个文件上限 8 MB；共享文件的后续删除也会同步，旧内容可恢复。</p>
      <div className="cloudActions"><button className="primary" disabled={busy || project.status === 'archived'} onClick={() => act(async () => { const local = await invoke('open_project'); if (!local) return; await command('sync.attach', { projectId: local.id, remoteId: project.projectId }); await onJoin(local); close(); })}>选择共享文件夹</button></div>
      </>}
    </> : connected ? <>
      <p className="cloudOrigin">{state.origin}</p>
      <div className="cloudListHeading"><strong>可访问的项目</strong><button disabled={busy} onClick={() => act(async () => setState(await command('cloud.projects')))}><RotateCcw size={14}/>刷新</button></div>
      <div className="cloudActions"><button disabled={busy} onClick={() => setCreating(true)}>新建团队项目</button></div>
      <div className="cloudProjects">{state.projects.map(p => <button key={p.projectId} disabled={busy} onClick={() => act(async () => setProject(await command('cloud.project', { projectId: p.projectId })))}><span><strong>{p.title}</strong><small>{p.members.length} 位成员</small></span><ChevronRight size={16}/></button>)}</div>
      {!state.projects.length && state.status === 'connected' && <p className="cloudEmpty">还没有可访问的团队项目。可以新建项目，或加入同事的项目后刷新。</p>}
      {state.nextCursor && <button disabled={busy} onClick={() => act(async () => setState(await command('cloud.projects', { cursor: state.nextCursor })))}>加载更多</button>}
      <p className="cloudNote">打开团队项目，选择共享文件夹后即可在本机与成员共同处理文件。已有私有项目不会自动上传。</p>
      <div className="cloudActions"><button disabled={busy} onClick={() => act(async () => setState(await command('cloud.disconnect')))}>断开此设备连接</button></div>
    </> : state.status === 'connecting' ? <>
      <p>在浏览器中登录团队账户，并确认连接这台电脑。</p><p className="cloudOrigin">{state.origin}</p>
      <div className="cloudActions"><button disabled={busy} onClick={() => act(async () => setState(await command('cloud.cancel')))}>取消连接</button><button className="primary" onClick={() => act(() => invoke('open_cloud_authorization'))}><ExternalLink size={15}/>重新打开授权页</button></div>
    </> : <form onSubmit={connect}>
      <p>连接你所在的团队，查看共享项目。</p>
      <label htmlFor="cloud-origin">团队地址</label><input id="cloud-origin" autoFocus type="url" required value={origin} onChange={e => setOrigin(e.target.value)} placeholder="https://团队的 Turnsu 地址"/>
      <p className="cloudNote">将打开浏览器完成登录。本地 Agent 的账户和私有会话不会上传。</p>
      <div className="cloudActions"><button type="submit" className="primary" disabled={busy || !origin.trim()}>{busy ? '正在连接…' : '在浏览器中连接'}<ExternalLink size={15}/></button></div>
    </form>}
  </dialog>;
}
