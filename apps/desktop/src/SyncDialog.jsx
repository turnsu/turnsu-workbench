import { invoke, listen } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import { X, RotateCcw, Pause, Play, FileText } from 'lucide-react';
const command = (method, args) => invoke('local_command', { method, args });
export const syncLabels = { pending: '等待同步', syncing: '正在同步', working: '完成本次工作后同步', synced: '文件已同步', conflict: '有不同版本待处理', attention: '有文件需要处理', offline: '等待连接恢复', access: '需要重新连接', paused: '同步已暂停' };

export function SyncDialog({ project, onClose }) {
  const dialog = useRef(null), mounted = useRef(true);
  const [state, setState] = useState(project.sharing), [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState(null);
  const args = { projectId: project.id };
  async function read() { const s = await command('sync.status', args); if (mounted.current) setState(s); }
  useEffect(() => {
    mounted.current = true; dialog.current.showModal(); let dispose;
    listen(({ payload }) => { if (payload.type === 'sync-changed' && payload.projectId === project.id) read().catch(e => setError(String(e))); }).then(fn => { if (mounted.current) dispose = fn; else fn(); });
    read().catch(e => setError(String(e)));
    return () => { mounted.current = false; dispose?.(); };
  }, [project.id]);
  async function act(method, extra = {}) { setBusy(true); setError(''); try { await command(method, { ...args, ...extra }); if (method === 'sync.resolve') setPreview(null); await read(); } catch (e) { setError(String(e)); } finally { if (mounted.current) setBusy(false); } }
  async function view(path, revisionId, label) {
    setBusy(true); setError('');
    try { const result = await command(revisionId ? 'sync.preview' : 'files.read', { ...args, path, ...(revisionId ? { revisionId } : {}) }); setPreview({ ...result, label, path }); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  function close() { dialog.current.close(); onClose(); }
  const conflicts = Object.groupBy(state?.conflicts || [], f => f.path);
  return <dialog ref={dialog} className="cloudDialog syncDialog" aria-labelledby="sync-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="sync-heading">{state?.title || '团队文件'}</h2><button onClick={close} aria-label="关闭文件同步"><X size={18}/></button></div>
    <p className="syncSummary" role="status">{syncLabels[state?.status] || '正在读取…'}{state?.pending > 0 ? ` · ${state.pending} 个文件待提交` : ''}</p>
    {(error || state?.error) && <p className="inlineError" role="alert">{error || state.error}</p>}
    <p className="cloudNote">{state?.scope ? '仅所选范围内的普通文件及后续删除会与项目成员同步，未选目录保持私有。' : '这个文件夹里的普通文件及后续删除会与项目成员同步。'}移除的文件可从历史版本恢复。私有对话、隐藏文件和符号链接不参与同步。单个文件上限 8 MB。</p>
    {state?.scope && <details><summary>查看共享范围</summary><ul>{state.scope.map(item => <li key={item.path}>{item.path}{item.kind === 'directory' ? '/' : ''}</li>)}</ul></details>}
    <p className="syncPath">{project.path}</p>
    <div className="syncToolbar"><button disabled={busy} onClick={() => act(state?.paused || state?.status === 'access' ? 'sync.resume' : 'sync.retry')}><RotateCcw size={14}/>{state?.status === 'access' ? '用当前登录恢复' : '立即同步'}</button><button disabled={busy} onClick={() => act(state?.paused ? 'sync.resume' : 'sync.pause')}>{state?.paused ? <Play size={14}/> : <Pause size={14}/>} {state?.paused ? '恢复自动同步' : '暂停同步'}</button></div>
    {Object.entries(conflicts).map(([path, versions]) => <section className="syncConflict" key={path}>
      <strong><FileText size={15}/>{path}</strong><p>{versions[0].headDeleted ? '团队已删除此文件，本机修改仍保留。' : versions[0].localDeleted ? '本机已删除此文件，团队有其他修改。' : '存在不同修改。'}查看后选择要作为团队最新版本的内容。</p>
      <div className="syncToolbar"><button disabled={busy || versions[0].localDeleted} onClick={() => view(path, null, '本机内容')}>{versions[0].localDeleted ? '本机已删除' : '查看本机内容'}</button><button disabled={busy} onClick={() => view(path, versions[0].headRevisionId, '团队最新版本')}>查看团队版本</button></div>
      {versions.map((v, i) => <button key={v.revisionId} className="syncVersion" disabled={busy} onClick={() => view(path, v.revisionId, `保留的${v.deleted ? '删除' : '修改'} ${i + 1}`)}>查看保留的{v.deleted ? '删除' : '修改'} {i + 1} · {new Date(v.createdAt).toLocaleString()}</button>)}
      <div className="cloudActions"><button disabled={busy} onClick={() => act('sync.resolve', { path, choice: 'team', expectedHeadRevisionId: versions[0].headRevisionId })}>{versions[0].headDeleted ? '采用团队删除' : '使用团队内容'}</button><button disabled={busy} onClick={() => act('sync.resolve', { path, choice: 'local', expectedHeadRevisionId: versions[0].headRevisionId })}>{versions[0].localDeleted ? '保留本机删除' : '使用本机内容'}</button></div>
    </section>)}
    {state?.issues?.filter(item => !item.deleted).map(item => <div className="syncIssue" key={item.path}><strong>{item.path}</strong><p>{item.message}</p>{item.recoverable && <button disabled={busy} onClick={() => act('sync.resolve', { path: item.path, choice: 'restore', expectedHeadRevisionId: item.headRevisionId })}>恢复团队文件</button>}{item.canDelete && <button disabled={busy} onClick={() => act('sync.resolve', { path: item.path, choice: 'delete', expectedHeadRevisionId: item.headRevisionId })}>同步删除到团队</button>}</div>)}
    {state?.issues?.some(item => item.deleted) && <details className="syncRecovery"><summary>恢复已移除的文件</summary>{state.issues.filter(item => item.deleted).map(item => <div className="syncIssue" key={item.path}><strong>{item.path}</strong><button disabled={busy} onClick={() => act('sync.resolve', { path: item.path, choice: 'restore', expectedHeadRevisionId: item.headRevisionId })}>恢复这个文件</button></div>)}</details>}
    {preview && <section className="syncPreview"><div className="cloudHeading"><strong>{preview.label}</strong><button onClick={() => setPreview(null)} aria-label="关闭版本预览"><X size={15}/></button></div><small>{preview.path}</small><pre>{preview.text}</pre>{preview.truncated && <p className="cloudNote">内容较长，仅显示开头部分。</p>}</section>}
    <details className="syncRecovery"><summary>找回被替换的本机文件</summary><p>下载团队新版本时，替换前的本机文件保留在此文件夹的 .turnsu-local 中。发生意外编辑时可从中找回，副本不会上传。</p></details>
  </dialog>;
}
