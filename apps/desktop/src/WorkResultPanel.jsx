import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
const command = (method, args) => invoke('local_command', { method, args });
const labels = { pending: '等待负责人验收', accepted: '已验收完成', changes_requested: '需要修改' };
function ResultText({ children }) { return <ReactMarkdown components={{ img: ({ alt }) => <span>[{alt || '图片'}]</span>, a: ({ children }) => <span>{children}</span> }}>{children}</ReactMarkdown>; }

export function WorkResultPanel({ projectId, detail, members, selectedEntry, onCancelSubmission, onChanged, renderFiles }) {
  const [state, setState] = useState(null), [feedback, setFeedback] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true), lock = useRef(false), intent = useRef(null), panel = useRef(null);
  const scope = { projectId, workItemId: detail.workItem.workItemId };
  const review = detail.resultReview, current = review?.currentSubmission;
  const owner = detail.viewerUserId === detail.workItem.accountableOwnerUserId;
  const person = id => members.find(item => item.userId === id)?.displayName || (id === detail.viewerUserId ? '我' : '团队成员');
  async function read() {
    const value = await command('work.result.state', scope);
    if (mounted.current) setState(value); return value;
  }
  useEffect(() => {
    mounted.current = true; read().catch(e => { if (mounted.current) { setState(null); setError(String(e)); } });
    return () => { mounted.current = false; };
  }, [projectId, detail.workItem.workItemId, detail.etag]);
  useEffect(() => { setFeedback(''); }, [current?.submissionId]);
  useEffect(() => { if (selectedEntry) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [selectedEntry?.entryId]);
  async function act(kind, retry) {
    if (lock.current) return;
    if (kind === 'request_changes' && !retry && !feedback.trim()) { setError('请说明哪些地方需要修改，让同事知道下一步。'); return; }
    const entry = kind === 'submit' ? selectedEntry : current?.entry;
    const args = retry ? { ...scope, kind: retry.kind, actionId: retry.id, retry: true, confirm: true } : {
      ...scope, kind, entryId: entry?.entryId, contentHash: entry?.contentHash, etag: detail.etag, confirm: true,
      ...(kind === 'submit' ? {} : { submissionId: current?.submissionId, feedback }),
    };
    if (!retry) {
      const signature = JSON.stringify(args);
      if (intent.current?.signature !== signature) intent.current = { signature, id: crypto.randomUUID() };
      args.actionId = intent.current.id;
    }
    lock.current = true; setBusy(true); setError('');
    try {
      await command('work.result.submit', args); intent.current = null;
      await read(); await onChanged(); onCancelSubmission();
    } catch (e) {
      if (mounted.current) setError(String(e));
      try { const latest = await read(); if (!latest.actions.length) intent.current = null; } catch {}
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const frozen = busy || !state || state.actions.length > 0;
  function contents(entry) { return <><div className="workResultText"><ResultText>{entry.summary}</ResultText></div>{renderFiles(entry.fileReferences || [])}</>; }
  return <section ref={panel} className="workResultPanel" aria-label="工作成果与验收">
    <div className="cloudListHeading"><h3>工作成果</h3><button disabled={busy} onClick={async () => { try { setError(''); await onChanged(); await read(); } catch (e) { setError(String(e)); } }}>读取最新成果</button></div>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {state?.actions.map(action => <div className="assistanceNotice" key={action.id}><p>{action.error || '上次操作尚未确认，原内容已保留。'}</p>{action.data.feedback && <p className="workResultFeedback">{action.data.feedback}</p>}<button disabled={busy} onClick={() => act(action.kind, action)}>核对原提交</button></div>)}
    {selectedEntry ? <article className="workResultPreview">
      <h4>将这份内容交给负责人验收</h4><p className="cloudNote">提交的是这条已共享内容和其中固定的文件版本。负责人确认后，这项工作才算完成。</p>
      {contents(selectedEntry)}
      <div className="cloudActions"><button disabled={busy} onClick={onCancelSubmission}>取消</button><button className="primary" disabled={frozen} onClick={() => act('submit')}>{busy ? '正在提交…' : '提交给负责人'}</button></div>
    </article> : current ? <article className="workResultPreview">
      <div className="workResultHeading"><strong>{labels[current.status]}</strong><small>{person(current.submittedByUserId)} · {new Date(current.submittedAt).toLocaleString()}</small></div>
      {contents(current.entry)}
      {current.review && <div className="workResultFeedback"><strong>{person(current.review.reviewerUserId)} 的验收意见</strong><p>{current.review.feedback || '已确认这份成果满足要求。'}</p><small>{new Date(current.review.reviewedAt).toLocaleString()}</small></div>}
      {owner && current.status === 'pending' && <form onSubmit={e => { e.preventDefault(); act('accept'); }}>
        <label>验收说明<textarea value={feedback} maxLength={2000} disabled={frozen} onChange={e => setFeedback(e.target.value)} placeholder="确认完成时可补充说明；需要修改时，请写清楚要改什么。"/></label>
        <div className="cloudActions"><button type="button" disabled={frozen || !feedback.trim()} onClick={() => act('request_changes')}>需要修改</button><button className="primary" type="submit" disabled={frozen}>确认完成</button></div>
      </form>}
      {current.status === 'changes_requested' && <p className="cloudNote">修改完成后，从下方共享进展选择新的成果，再提交验收。</p>}
    </article> : <p className="cloudNote">还没有提交成果。工作完成后，从下方共享进展选择自己的结果，交给负责人验收。</p>}
    {(review?.history?.length || 0) > 1 && <details className="workResultHistory"><summary>之前的成果与验收记录</summary>{review.history.filter(item => item.submissionId !== current?.submissionId).map(item => <article key={item.submissionId}><strong>{labels[item.status]} · {person(item.submittedByUserId)}</strong><small>{new Date(item.submittedAt).toLocaleString()}</small><details><summary>查看这次提交的内容</summary>{contents(item.entry)}</details>{item.review && <p className="workResultFeedback">{person(item.review.reviewerUserId)}：{item.review.feedback || '已确认完成。'}</p>}</article>)}</details>}
  </section>;
}
