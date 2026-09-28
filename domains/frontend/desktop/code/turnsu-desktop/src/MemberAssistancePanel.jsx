import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronLeft, Plus, RotateCcw } from 'lucide-react';
const command = (method, args) => invoke('local_command', { method, args });
const operationKinds = { createMemberAgentRequest: 'create', acceptMemberAgentRequest: 'accept', declineMemberAgentRequest: 'decline', cancelMemberAgentRequest: 'cancel' };
function stateLabel(item) {
  if (item.consent === 'revoked') return '已撤回';
  if (item.consent === 'declined') return '已婉拒';
  if (item.consent === 'pending') return Date.parse(item.expiresAt) <= Date.now() ? '已过期' : '等待答复';
  if (item.executionStatus === 'completed') return '结果已送达';
  if (['queued', 'running'].includes(item.executionStatus)) return '正在处理';
  if (item.executionStatus === 'partial') return '已中断，结果待核对';
  if (item.executionStatus === 'cancelled') return '已停止';
  return '未能完成';
}
const nameOf = item => item.skillSummary?.name || item.loopSummary?.name || '已发布方法';
function Text({ children }) { return <ReactMarkdown components={{ img: ({ alt }) => <span>[{alt || '图片'}]</span>, a: ({ children }) => <span>{children}</span> }}>{children}</ReactMarkdown>; }

export function MemberAssistancePanel({ projectId, workItem, viewerUserId, members, canContribute }) {
  const [data, setData] = useState(null), [selectedId, select] = useState(null), [creating, setCreating] = useState(false), [tab, setTab] = useState('received');
  const [methods, setMethods] = useState([]), [methodPage, setMethodPage] = useState(null), [method, setMethod] = useState(''), [person, setPerson] = useState(''), [content, setContent] = useState('');
  const [models, setModels] = useState(null), [model, setModel] = useState(''), [confirmed, confirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), lock = useRef(false), intent = useRef(null), reading = useRef(false), paged = useRef(false), interaction = useRef({});
  interaction.current = { creating, selectedId };
  const scope = { projectId, workItemId: workItem.workItemId };
  const selected = data?.items.find(item => item.requestId === selectedId);
  async function read(cursor) {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await command('assistance.list', { ...scope, ...(cursor ? { cursor } : {}) });
      paged.current = Boolean(cursor);
      if (alive.current) setData(old => cursor ? { ...result, items: [...new Map([...(old?.items || []), ...result.items].map(item => [item.requestId, item])).values()] } : result);
    } catch (e) { if (alive.current) { setError(String(e)); setData(null); select(null); } }
    finally { reading.current = false; }
  }
  useEffect(() => {
    alive.current = true; read();
    const timer = setInterval(() => { if (!lock.current && !document.hidden && !paged.current && !interaction.current.creating) read(); }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [projectId, workItem.workItemId]);
  useEffect(() => { setModels(null); setModel(''); confirm(false); }, [selectedId]);
  async function act(fn) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function catalog(cursor) {
    const result = await command('assistance.catalog', { ...scope, ...(cursor ? { cursor } : {}) });
    if (alive.current) { setMethods(old => cursor ? [...new Map([...old, ...result.items].map(item => [item.releaseId, item])).values()] : result.items); setMethodPage(result.page); }
  }
  async function submit(kind, values = {}, retryAction) {
    const args = { ...scope, kind, confirm: true, ...values };
    const signature = JSON.stringify(args);
    if (retryAction) Object.assign(args, { actionId: retryAction, retry: true });
    else {
      if (intent.current?.signature !== signature) intent.current = { signature, id: crypto.randomUUID() };
      args.actionId = intent.current.id;
    }
    try {
      await command('assistance.submit', args); intent.current = null;
      if (kind === 'create') { setCreating(false); setContent(''); setTab('sent'); }
      await read();
    } catch (e) { await read(); throw e; }
  }
  const people = members.filter(p => p.userId !== viewerUserId && ['owner', 'contribute'].includes(p.access));
  const mine = selected?.providerUserId === viewerUserId, peerName = id => members.find(p => p.userId === id)?.displayName || '团队成员';
  const pending = selected?.consent === 'pending' && Date.parse(selected.expiresAt) > Date.now();
  const local = data?.local.find(item => item.requestId === selectedId);
  const visible = data?.items.filter(item => tab === 'received' ? item.providerUserId === viewerUserId : item.requesterUserId === viewerUserId) || [];
  const frozenCreate = data?.actions.some(action => action.operation === 'createMemberAgentRequest');
  return <section className="memberAssistance" aria-labelledby="member-assistance-title">
    <div className="cloudListHeading"><h3 id="member-assistance-title">同事的 Agent 协助</h3><button disabled={busy} onClick={() => act(() => read())} aria-label="刷新协助请求"><RotateCcw size={14}/></button></div>
    {error && <p className="inlineError" role="alert">{error}</p>}
    {data?.actions.map(action => <div className="assistanceNotice" key={action.id}><p>{action.error || '上次提交尚未确认，原内容仍保留。'}</p><button disabled={busy} onClick={() => act(() => submit(operationKinds[action.operation], {}, action.id))}>核对原提交</button></div>)}
    {creating ? <form onSubmit={e => { e.preventDefault(); act(() => submit('create', { releaseId: method, assetKind: methods.find(item => item.releaseId === method)?.assetKind, providerUserId: person, content })); }}>
      <button type="button" disabled={busy} onClick={() => setCreating(false)}><ChevronLeft size={14}/>返回请求</button>
      <div className="assistanceChoices"><label>使用哪个方法<select autoFocus value={method} onChange={e => setMethod(e.target.value)} disabled={busy || frozenCreate}><option value="">选择已发布的方法</option>{methods.map(item => <option key={item.releaseId} value={item.releaseId}>{nameOf(item)} · v{item.version}</option>)}</select></label><label>请谁协助<select value={person} onChange={e => setPerson(e.target.value)} disabled={busy || frozenCreate}><option value="">选择同事</option>{people.map(p => <option key={p.userId} value={p.userId}>{p.displayName}</option>)}</select></label></div>
      {methodPage?.hasMore && <button type="button" disabled={busy} onClick={() => act(() => catalog(methodPage.nextCursor))}>加载更多方法</button>}
      <label>本次需要完成什么？<textarea value={content} onChange={e => setContent(e.target.value)} maxLength={64000} disabled={busy || frozenCreate} placeholder="说明希望得到的结果，并粘贴这次需要处理的资料。"/></label>
      <p className="cloudNote">对方接受后，才会使用自己的 Pi 模型处理这些文本。任务与结果仅向你和接收者开放；请求一天内有效。</p>
      <div className="cloudActions"><button type="submit" className="primary" disabled={busy || frozenCreate || !method || !person || !content.trim()}>{busy ? '正在提交…' : '发送协助请求'}</button></div>
    </form> : selected ? <>
      <button disabled={busy} onClick={() => select(null)}><ChevronLeft size={14}/>返回请求</button>
      <div className="assistanceTitle"><strong>{selected.methodName}</strong><span>v{selected.methodVersion} · {stateLabel(selected)}</span></div>
      <p className="cloudNote">{mine ? `来自 ${peerName(selected.requesterUserId)}` : `发给 ${peerName(selected.providerUserId)}`} · {new Date(selected.createdAt).toLocaleString()}</p>
      <p>{selected.goal}</p>
      {selected.inputs.map(input => <div className="assistanceInput" key={input.id}><strong>{input.title}</strong><pre tabIndex={0}>{input.text}</pre></div>)}
      {selected.output && <article className="assistanceResult"><h4>收到的结果</h4><Text>{selected.output}</Text><p className="cloudNote">请检查结果是否满足这项工作的要求。</p></article>}
      {mine && pending && <div className="assistanceAccept">
        <p>本次仅处理上面的文本，使用独立的 Pi 会话。不会读取本机项目文件或已有私人对话。</p>
        {models === null ? <button disabled={busy} onClick={() => act(async () => { const value = await command('assistance.models', {}); if (alive.current) setModels(value); })}>选择我的 Pi 模型</button> : models.length ? <label>使用我的模型<select value={model} disabled={busy} onChange={e => { setModel(e.target.value); confirm(false); }}><option value="">选择 Pi 中已配置的 API 模型</option>{models.map((item, i) => <option key={item.provider + '/' + item.modelId} value={String(i)}>{item.name} · {item.provider}</option>)}</select></label> : <p className="cloudNote">还没有可用的 Pi API 模型。请先在本机 Pi 配置 API 账户，再重新读取。个人订阅席位不用于此类协助执行。<button disabled={busy} onClick={() => setModels(null)}>重新读取</button></p>}
        <p className="cloudNote">费用使用你的模型账户；本次最多 {selected.limits.maxModelRequests} 次模型请求，{Math.ceil(selected.limits.timeoutMs / 60000)} 分钟后停止。实际费用以模型服务商账单为准。</p>
        <label className="assistanceConsent"><input type="checkbox" checked={confirmed} disabled={busy || model === ''} onChange={e => confirm(e.target.checked)}/>允许本次执行，并把结果发送给 {peerName(selected.requesterUserId)}</label>
        <div className="cloudActions"><button disabled={busy} onClick={() => act(() => submit('decline', { requestId: selected.requestId }))}>婉拒</button><button className="primary" disabled={busy || !confirmed || model === ''} onClick={() => act(() => submit('accept', { requestId: selected.requestId, requestDigest: selected.requestDigest, selectedModel: { provider: models[Number(model)].provider, modelId: models[Number(model)].modelId } }))}>{busy ? '正在确认…' : '接受并执行'}</button></div>
      </div>}
      {local && ['result_ready', 'not_started', 'interrupted', 'failed'].includes(local.state) && <div className="assistanceNotice"><p>{local.error || '本机保留了这次执行记录，可核对已有结果。'}</p><button disabled={busy || local.active} onClick={() => act(() => submit('accept', {}, local.actionId))}>核对原执行</button></div>}
      {['pending', 'accepted'].includes(selected.consent) && !['completed', 'failed', 'cancelled', 'partial', 'timeout', 'blocked'].includes(selected.executionStatus) && <button disabled={busy} onClick={() => act(() => submit('cancel', { requestId: selected.requestId }))}>{pending ? '撤回请求' : '停止执行'}</button>}
    </> : <>
      <div className="assistanceTabs"><button aria-pressed={tab === 'received'} onClick={() => setTab('received')}>收到的请求</button><button aria-pressed={tab === 'sent'} onClick={() => setTab('sent')}>我发出的</button>{canContribute && <button disabled={busy || !people.length} onClick={() => act(async () => { await catalog(); select(null); setCreating(true); })}><Plus size={14}/>请同事协助</button>}</div>
      {!data ? <p className="cloudNote">{error ? '恢复团队连接后可重试。' : '正在读取协助请求…'}</p> : !visible.length ? <p className="cloudNote">{tab === 'received' ? '暂时没有收到协助请求。' : '选择团队方法，请同事用自己的 Agent 协助这项工作。'}</p> : <div className="assistanceList">{visible.map(item => <button key={item.requestId} onClick={() => { select(item.requestId); setError(''); }}><span><strong>{item.methodName}</strong><small>{tab === 'received' ? peerName(item.requesterUserId) : peerName(item.providerUserId)} · {new Date(item.createdAt).toLocaleDateString()}</small></span><span>{stateLabel(item)}</span></button>)}</div>}
      {data?.nextCursor && <button disabled={busy} onClick={() => act(() => read(data.nextCursor))}>查看更早的请求</button>}
    </>}
  </section>;
}
