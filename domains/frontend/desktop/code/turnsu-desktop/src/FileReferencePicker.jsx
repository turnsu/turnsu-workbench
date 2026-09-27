import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Folder, X } from 'lucide-react';
import { WorkReferenceChoices } from './WorkReferenceChoices.jsx';
import { TeamSkillsDialog } from './TeamSkillsDialog.jsx';
const command = (method, args) => window.__TAURI__.core.invoke('local_command', { method, args });

export const referenceLabel = selection => typeof selection === 'string' ? selection : selection.label || selection.path;
export const referenceKey = selection => typeof selection === 'string' ? selection : selection.kind ? `${selection.kind}:${selection.workItemId}:${selection.objectId}` : selection.revisionId ? `${selection.projectId}:${selection.revisionId}` : selection.path;

export function FileReferencePicker({ projectId, sessionId, team, selected, onSelect, onClose, methodContext }) {
  const dialog = useRef(null);
  const [tab, setTab] = useState('files'), [methodsBusy, setMethodsBusy] = useState(false);
  const [folder, setFolder] = useState(''), [query, setQuery] = useState(''), [files, setFiles] = useState(null), [error, setError] = useState('');
  useEffect(() => { dialog.current.showModal(); }, []);
  useEffect(() => {
    let current = true; setFiles(null); setError(''); setQuery('');
    command('files.list', { projectId, path: folder }).then(value => { if (current) setFiles(value); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [projectId, folder]);
  const entries = files?.entries.filter(file => file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  return <dialog ref={dialog} className="cloudDialog fileReferencePicker" aria-labelledby="reference-heading" onCancel={e => { e.preventDefault(); if (!methodsBusy) onClose(); }}>
    <div className="cloudHeading"><h2 id="reference-heading">引用资料</h2><button aria-label="关闭资料选择" disabled={methodsBusy} onClick={onClose}><X size={18}/></button></div>
    <div className="referenceTabs" aria-label="资料类别">{[['files','项目文件'], ...(team && sessionId ? [['work-entry','共享进展'],['work-decision','已确认决定']] : []), ...(methodContext ? [['methods','团队方法']] : [])].map(([id, label]) => <button key={id} disabled={methodsBusy} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === 'methods' ? <TeamSkillsDialog {...methodContext} inline onBusyChange={setMethodsBusy} onClose={onClose}/> : tab !== 'files' ? <WorkReferenceChoices key={sessionId} sessionId={sessionId} kind={tab} selected={selected} onSelect={onSelect}/> : <>
    <p className="cloudNote">选择文字资料，发送时读取内容。每次最多引用 4 份资料，每份 64 KB，合计 128 KB。</p>
    <div className="referenceFolder"><button disabled={!folder} aria-label="返回上一级文件夹" onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}><ChevronLeft size={16}/></button><span>{folder || '项目文件'}</span></div>
    <input autoFocus type="search" aria-label="筛选当前文件夹" placeholder="筛选当前文件夹…" value={query} onChange={e => setQuery(e.target.value)}/>
    {error && <p role="alert" className="inlineError">{error}</p>}
    <div className="referenceFileList" aria-label="可选文件">{!files && !error && <p>正在读取文件…</p>}{entries.map(file => <button key={file.path} disabled={!file.directory && (selected.includes(file.path) || selected.length >= 4)} onClick={() => file.directory ? setFolder(file.path) : onSelect(file.path)}>{file.directory ? <Folder size={16}/> : <FileText size={16}/>}<span>{file.name}</span>{file.directory ? <ChevronRight size={14}/> : selected.includes(file.path) ? <small>已引用</small> : null}</button>)}{files && !entries.length && <p className="muted">{query ? '当前文件夹没有匹配的文件。' : '这个文件夹还没有文件。'}</p>}</div>
    {files?.truncated && <p className="cloudNote">这里只显示前 500 项，可以进入子文件夹查找。</p>}</>}
  </dialog>;
}

export function SentFileReference({ sessionId, inputId, file }) {
  const [content, setContent] = useState(null), [error, setError] = useState('');
  const loading = useRef(false);
  async function read() {
    if (content !== null || loading.current) return;
    loading.current = true; setError('');
    try { const value = await command('references.read', { sessionId, inputId, ...(file.kind ? { kind: file.kind, objectId: file.objectId } : { path: file.path }) }); setContent(value.text); }
    catch (e) { setError(String(e)); } finally { loading.current = false; }
  }
  return <details className="sentReference" onToggle={e => { if (e.currentTarget.open) read(); }}><summary><FileText size={14}/>{referenceLabel(file)}<small>发送时内容</small></summary>{error ? <p role="alert">{error}<button onClick={read}>重试读取</button></p> : <pre tabIndex={0}>{content ?? '正在读取…'}</pre>}</details>;
}
