import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import { referenceKey } from './FileReferencePicker.jsx';
const command = (method, args) => invoke('local_command', { method, args });

export function WorkReferenceChoices({ sessionId, kind, selected, onSelect }) {
  const [data, setData] = useState(null), [query, setQuery] = useState(''), [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [sourceId, setSourceId] = useState(''), [sources, setSources] = useState(null), [sourceError, setSourceError] = useState(''), [sourceLoading, setSourceLoading] = useState(false);
  const generation = useRef(0), inFlight = useRef(false), sourceGeneration = useRef(0);
  async function loadSources(cursor) {
    const version = sourceGeneration.current; setSourceLoading(true); setSourceError('');
    try {
      const result = await command('references.sources', { sessionId, ...(cursor ? { cursor } : {}) });
      if (version === sourceGeneration.current) setSources(old => ({ ...result, items: cursor ? [...(old?.items || []), ...result.items].filter((item, i, all) => all.findIndex(other => other.workItemId === item.workItemId) === i) : result.items }));
    } catch (e) { if (version === sourceGeneration.current) setSourceError('暂时无法读取其他工作，当前工作仍可选择。'); }
    finally { if (version === sourceGeneration.current) setSourceLoading(false); }
  }
  async function load(cursor) {
    if (inFlight.current) return;
    const version = generation.current; inFlight.current = true; setLoading(true); setError('');
    try {
      const result = await command('references.list', { sessionId, ...(sourceId ? { sourceWorkItemId: sourceId } : {}), ...(cursor ? { cursor } : {}) });
      if (version !== generation.current) return;
      setData(old => ({ ...result, entries: cursor ? [...(old?.entries || []), ...result.entries].filter((item, i, all) => all.findIndex(other => referenceKey(other) === referenceKey(item)) === i) : result.entries }));
    } catch (e) { if (version === generation.current) setError(String(e)); }
    finally { if (version === generation.current) { inFlight.current = false; setLoading(false); } }
  }
  useEffect(() => { sourceGeneration.current++; setSources(null); loadSources(); return () => { sourceGeneration.current++; }; }, [sessionId]);
  useEffect(() => { generation.current++; inFlight.current = false; setData(null); setPreview(null); setQuery(''); load(); return () => { generation.current++; }; }, [sessionId, sourceId]);
  useEffect(() => { setPreview(null); setQuery(''); }, [kind]);
  const items = (kind === 'work-decision' ? data?.decisions : data?.entries) || [];
  const visible = items.filter(item => (item.label + item.text).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const has = item => selected.some(chosen => referenceKey(chosen) === referenceKey(item));
  function choose() {
    const { text, byteLength, ...value } = preview;
    onSelect(value);
  }
  return <section className="workReferenceChoices">
    <p className="cloudNote">可引用当前工作或同项目其他工作的资料。当前工作的所有成员都须有权查看来源；发送和共享时会再次核对。</p>
    <label className="referenceSource">来源工作<select value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">当前工作</option>{sources?.items.filter(item => item.workItemId !== sources.currentWorkItemId).map(item => <option key={item.workItemId} value={item.workItemId}>{item.title}</option>)}</select></label>
    {sourceLoading && <p className="cloudNote" role="status">正在读取项目中的工作…</p>}
    {sourceError && <p className="cloudNote">{sourceError} <button disabled={sourceLoading} onClick={() => loadSources(sources?.page?.nextCursor)}>重试读取工作</button></p>}
    {sources?.page?.nextCursor && <button disabled={sourceLoading} onClick={() => loadSources(sources.page.nextCursor)}>加载更多工作</button>}
    <input type="search" aria-label="筛选已加载的团队资料" placeholder="筛选已加载的资料…" value={query} onChange={e => setQuery(e.target.value)}/>
    {error && <p role="alert" className="inlineError">{error} <button disabled={loading} onClick={() => load(data?.page?.nextCursor)}>重试读取</button></p>}
    <div className="referenceFileList" aria-label="可选团队资料">
      {visible.map(item => <button key={referenceKey(item)} aria-pressed={preview && referenceKey(preview) === referenceKey(item)} onClick={() => setPreview(item)}><span>{item.label}</span>{has(item) && <small>已引用</small>}</button>)}
      {loading && <p role="status">正在读取团队资料…</p>}
      {data && !visible.length && !loading && <p className="muted">{query ? '已加载的资料中没有匹配项。' : kind === 'work-decision' ? '这项工作还没有已确认的决定。' : '这项工作还没有共享进展。'}</p>}
      {kind === 'work-entry' && data?.page?.hasMore && <button disabled={loading} onClick={() => load(data.page.nextCursor)}>加载更早的共享进展</button>}
    </div>
    {preview && <div className="workReferencePreview"><strong>{kind === 'work-decision' ? '已确认决定' : '共享内容'}</strong><pre tabIndex={0}>{preview.text}</pre><button className="primary" disabled={loading || Boolean(error) || selected.length >= 4 || has(preview)} onClick={choose}>{has(preview) ? '已引用' : '引用这份资料'}</button></div>}
  </section>;
}
