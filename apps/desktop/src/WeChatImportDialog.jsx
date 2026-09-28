import React, { useEffect, useRef, useState } from 'react';
import { FileText, ChevronLeft, ChevronRight, X, LoaderCircle } from 'lucide-react';
import { command } from './desktop-bridge.mjs';

export function WeChatImportDialog({ projectId, team, selected, onReference, onClose }) {
  const dialog = useRef(null);
  const [handoffs, setHandoffs] = useState(null), [imports, setImports] = useState(null);
  const [importCursors, setImportCursors] = useState([]), [currentImportCursor, setCurrentImportCursor] = useState(null);
  const [current, setCurrent] = useState(null), [page, setPage] = useState(null), [count, setCount] = useState(40);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    dialog.current.showModal();
    let alive = true;
    Promise.all([command('wechat.handoffs'), command('wechat.imports', { projectId })]).then(([h, i]) => { if (alive) { setHandoffs(h); setImports(i); } }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [projectId]);
  async function openHandoff(id, offset = 0) {
    setBusy(true); setError('');
    try { const next = await command('wechat.preview', { id, offset }); setCurrent({ type: 'handoff', id, ...next }); setPage(next); setCount(Math.min(40, next.records.length)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function openImport(id, offset = 0) {
    setBusy(true); setError('');
    try { const next = await command('wechat.records', { projectId, id, offset }); setCurrent({ type: 'import', id, ...next }); setPage(next); setCount(Math.min(40, next.records.length)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function importHandoff() {
    setBusy(true); setError('');
    try {
      const value = await command('wechat.import', { projectId, id: current.id });
      setImports(await command('wechat.imports', { projectId }));
      setImportCursors([]); setCurrentImportCursor(null);
      await openImport(value.id);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function moveImports(before, previous) {
    setBusy(true); setError('');
    try {
      setImports(await command('wechat.imports', { projectId, ...(before ? { before } : {}) }));
      setImportCursors(previous ? importCursors.slice(0, -1) : [...importCursors, currentImportCursor]);
      setCurrentImportCursor(before || null);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const offset = page?.records[0]?.position || 0;
  const alreadySelected = selected.some(item => item?.kind === 'wechat-import' && item.importId === current?.id && item.offset === offset);
  return <dialog ref={dialog} className="cloudDialog wechatDialog" aria-labelledby="wechat-heading" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="cloudHeading"><h2 id="wechat-heading">微信资料</h2><button aria-label="关闭微信资料" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <p className="cloudNote">只读取你主动选择的微信桥交接。导入保存到此项目的本机私有资料；不会自动分析、上传或发送消息。</p>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {busy && <p role="status" className="wechatBusy"><LoaderCircle className="spin" size={15}/>正在校验与读取资料…</p>}
    {current ? <>
      <button className="wechatBack" disabled={busy} onClick={() => { setCurrent(null); setPage(null); }}><ChevronLeft size={15}/>返回资料列表</button>
      <h3>{current.chatName || '未命名聊天'}</h3>
      <p className="cloudNote">{current.recordCount} 条已解析记录 · {current.itemCount} 份原档 · {current.unparsedCount} 份未解析文件。昵称和时间来自原档，不代表已确认客户身份。</p>
      <details className="wechatEvidence"><summary>查看原档与解析覆盖</summary>{page?.items.map(item => <div key={item.id}><strong>{item.displayName}</strong><span>{item.parsed ? '已解析文字' : '未解析内容'} · {item.byteCount.toLocaleString()} 字节</span><code title="SHA-256">{item.sha256}</code></div>)}</details>
      {current.type === 'handoff' && <button className="primary" disabled={busy} onClick={importHandoff}>校验并导入此项目</button>}
      <div className="wechatRecords" aria-label="微信记录预览">{page?.records.map(record => <div key={record.position}><small>#{record.position + 1} · {record.date} · {record.sender}</small><p>{record.text}{record.truncated ? '…' : ''}</p></div>)}{page?.records.length === 0 && <p className="muted">这份交接没有可解析的文字记录；原档仍可导入保存。</p>}</div>
      <div className="wechatPage"><button disabled={busy || offset === 0} onClick={() => current.type === 'handoff' ? openHandoff(current.id, Math.max(0, offset - 40)) : openImport(current.id, Math.max(0, offset - 40))}><ChevronLeft size={14}/>上一页</button><span>{page?.records.length ? `第 ${offset + 1}–${offset + page.records.length} 条` : '无文字记录'}</span><button disabled={busy || page?.nextOffset === null} onClick={() => current.type === 'handoff' ? openHandoff(current.id, page.nextOffset) : openImport(current.id, page.nextOffset)}>下一页<ChevronRight size={14}/></button></div>
      {current.type === 'import' && <div className="wechatReference"><label>引用当前页前 <input type="number" min="1" max={page.records.length} value={count} onChange={e => setCount(Number(e.target.value))}/> 条</label><button disabled={busy || team || selected.length >= 4 || alreadySelected || !Number.isSafeInteger(count) || count < 1 || count > page.records.length} onClick={() => onReference({ kind: 'wechat-import', importId: current.id, offset, count })}><FileText size={15}/>{alreadySelected ? '已引用' : '引用到本机任务'}</button></div>}
      {team && current.type === 'import' && <p className="cloudNote">团队事项需要先明确共享范围；这份本机导入不会自动进入云端。</p>}
    </> : <div className="wechatLists">
      <section><h3>已导入此项目</h3>{imports?.imports.map(item => <button key={item.id} disabled={busy} onClick={() => openImport(item.id)}><FileText size={15}/><span>{item.chatName || item.id}<small>{item.recordCount} 条记录 · {new Date(item.importedAt).toLocaleString()}</small></span></button>)}{imports && !imports.imports.length && <p className="muted">还没有导入的资料。</p>}<div className="wechatPage"><button disabled={busy || !importCursors.length} onClick={() => moveImports(importCursors.at(-1), true)}>较新</button><button disabled={busy || !imports?.before} onClick={() => moveImports(imports.before, false)}>更早</button></div></section>
      <section><h3>微信桥交接</h3>{handoffs?.handoffs.map(item => <button key={item.id} disabled={busy} onClick={() => openHandoff(item.id)}><FileText size={15}/><span>{item.id}<small>{new Date(item.modifiedAt).toLocaleString()}</small></span></button>)}{handoffs && !handoffs.available && <p className="muted">此系统没有微信桥原生分享入口。可在 macOS 的微信桥主动分享；其他平台的文件导入仍需单独接入。</p>}{handoffs?.available && !handoffs.handoffs.length && <p className="muted">暂时没有交接。请先从微信桥主动分享记录。</p>}</section>
    </div>}
  </dialog>;
}
