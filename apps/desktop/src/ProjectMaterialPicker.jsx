import React, { useEffect, useState } from 'react';
import { Folder, ChevronLeft, X } from 'lucide-react';
import { command } from './desktop-bridge.mjs';

// Browse one folder at a time. Selecting material never grants tool or upload permission.
export function ProjectMaterialPicker({ projectId, paths, onChange, disabled=false, limit=10 }) {
  const [open,setOpen]=useState(false),[folder,setFolder]=useState(''),[listing,setListing]=useState(null),[error,setError]=useState(''),[filter,setFilter]=useState('');
  useEffect(()=>{if(!open)return;let live=true;setListing(null);setError('');command('files.list',{projectId,path:folder}).then(value=>{if(live)setListing(value);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[open,folder,projectId]);
  const supported=path=>/\.(xlsx|docx|pdf|txt|md|csv|png|jpe?g)$/i.test(path);
  function toggle(path){if(paths.includes(path))onChange(paths.filter(p=>p!==path));else if(paths.length<limit)onChange([...paths,path]);}
  return <div className="projectMaterialPicker"><div className="materialPickerHeader"><strong>选定项目材料 · {paths.length}/{limit}</strong><button type="button" disabled={disabled} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'收起文件列表':'选择文件'}</button></div>
    {paths.length>0&&<ul className="selectedMaterials">{paths.map(path=><li key={path}><span>{path}</span><button type="button" aria-label={`移除材料 ${path}`} disabled={disabled} onClick={()=>toggle(path)}><X size={13}/></button></li>)}</ul>}
    {open&&<div className="materialBrowser"><div className="materialPickerHeader"><button type="button" disabled={!folder} onClick={()=>{setFolder(folder.split('/').slice(0,-1).join('/'));setFilter('');}}><ChevronLeft size={14}/>上一级</button><span>{folder||'项目根目录'}</span></div><input aria-label="筛选当前目录文件" placeholder="筛选当前目录" value={filter} onChange={e=>setFilter(e.target.value)}/>{error&&<p role="alert">{error}</p>}{!listing&&!error&&<p role="status">读取文件列表…</p>}
      {listing&&<ul>{listing.entries.filter(file=>file.name.toLowerCase().includes(filter.toLowerCase())&&(file.directory||supported(file.path))).map(file=><li key={file.path}>{file.directory?<button type="button" onClick={()=>{setFolder(file.path);setFilter('');}}><Folder size={14}/>{file.name}</button>:<label><input type="checkbox" checked={paths.includes(file.path)} disabled={disabled||(!paths.includes(file.path)&&paths.length>=limit)} onChange={()=>toggle(file.path)}/>{file.name}</label>}</li>)}</ul>}{listing?.truncated&&<p>当前目录仅显示前 500 项。可先在项目文件夹整理材料到子目录。</p>}{listing?.entries.length===0&&<p>目录为空，可先通过项目面板导入文件。</p>}
    </div>}
  </div>;
}
