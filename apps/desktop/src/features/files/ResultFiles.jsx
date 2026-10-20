import React from "react";
import { FileText, ArrowUpRight } from "lucide-react";
const basename = path => path.split(/[\\/]/).at(-1);

export function ResultTime({ result }) {
  if (!Number.isFinite(result.createdAt)) return null;
  return <time className="resultTime" dateTime={new Date(result.createdAt).toISOString()}>保存于 {new Date(result.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>;
}
export function ResultFile({ file, onOpen }) {
  const extension = basename(file.path).match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return <button className="resultFile" data-slot="attachment" onClick={() => onOpen(file)}>
    <span className="fileType"><FileText size={20}/><small>{extension ? extension.toUpperCase().slice(0, 5) : '文件'}</small></span>
    <span><strong>{basename(file.path)}</strong><small>{file.bytes < 1024 ? '不到 1 KB' : Math.ceil(file.bytes / 1024) + ' KB'} · 保存在项目中</small></span>
    <ArrowUpRight size={16}/>
  </button>;
}
