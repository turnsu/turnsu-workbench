import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder, FileText, X } from 'lucide-react';
const command = (method, args) => invoke('local_command', { method, args });

export function ShareScopePicker({ project, busy, onConfirm, onCancel }) {
  const [folder, setFolder] = useState(''), [files, setFiles] = useState(null), [error, setError] = useState('');
  const [selected, setSelected] = useState([]);
  useEffect(() => {
    let current = true; setFiles(null); setError('');
    command('files.list', { projectId: project.id, path: folder }).then(value => { if (current) setFiles(value); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [project.id, folder]);
  function toggle(file) {
    setSelected(items => items.some(item => item.path === file.path) ? items.filter(item => item.path !== file.path) :
      [...items.filter(item => !item.path.startsWith(file.path + '/')), { path: file.path, kind: file.directory ? 'directory' : 'file' }]);
  }
  return <section className="shareScopePicker" aria-label="选择共享范围">
    <h3>从「{project.name}」选择要共享的内容</h3>
    <p className="cloudNote">只同步所选文件与目录。选中目录后，其中现有及以后新增的普通文件、修改和删除都会同步；未选目录与私人对话保留在本机。</p>
    <div className="referenceFolder"><button disabled={busy || !folder} aria-label="返回上级目录" onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}><ChevronLeft size={16}/></button><span>{folder || project.name}</span></div>
    {error && <p role="alert" className="inlineError">{error}</p>}
    <div className="shareScopeFiles">{!files && !error && <p>正在读取文件…</p>}{files?.entries.map(file => {
      const inherited = selected.some(item => item.kind === 'directory' && file.path.startsWith(item.path + '/'));
      const checked = inherited || selected.some(item => item.path === file.path);
      return <div className="shareScopeRow" key={file.path}><label><input type="checkbox" checked={checked} disabled={busy || inherited || (!checked && selected.length >= 64)} onChange={() => toggle(file)}/>{file.directory ? <Folder size={16}/> : <FileText size={16}/>}<span>{file.name}</span></label>{file.directory && <button disabled={busy} aria-label={`打开 ${file.name}`} onClick={() => setFolder(file.path)}><ChevronRight size={16}/></button>}</div>;
    })}{files && !files.entries.length && <p className="muted">这个目录没有可选择的文件。可返回上层选择目录，以共享之后的成果。</p>}</div>
    {files?.truncated && <p className="cloudNote">当前显示前 500 项；可进入目录缩小范围。</p>}
    {!!selected.length && <div className="shareScopeSelection" aria-label="即将共享的内容">{selected.map(item => <span key={item.path}>{item.path}{item.kind === 'directory' ? '/' : ''}<button disabled={busy} aria-label={`移除共享 ${item.path}`} onClick={() => setSelected(items => items.filter(value => value.path !== item.path))}><X size={13}/></button></span>)}</div>}
    <p className="cloudNote">同名文件有不同内容时会保留双方版本，等待你选择。隐藏文件和符号链接不会同步，单个文件上限 8 MB。</p>
    <div className="cloudActions"><button disabled={busy} onClick={onCancel}>返回</button><button className="primary" disabled={busy || !selected.length} onClick={() => onConfirm(selected)}>{busy ? '正在连接共享…' : `开始共享${selected.length ? ` ${selected.length} 项` : ''}`}</button></div>
  </section>;
}
