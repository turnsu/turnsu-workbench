import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { NativeLoopPublishPanel } from './NativeLoopPublishPanel.jsx';
const command = (method, args) => invoke('local_command', { method, args });

export function LocalLoopTrialDialog({ session, onClose }) {
  const dialog = useRef(null), lock = useRef(false);
  const [review, setReview] = useState(null), [saved, setSaved] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [summary, setSummary] = useState(''), [note, setNote] = useState(''), [confirm, setConfirm] = useState(false);
  async function act(fn) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { lock.current = false; setBusy(false); } }
  async function read() { setSaved(await command('localLoopTrial.saved', { sessionId: session.id })); setReview(await command('localLoopTrial.review', { sessionId: session.id })); }
  function close() { if (!lock.current) { dialog.current.close(); onClose(); } }
  useEffect(() => { dialog.current.showModal(); act(read); }, []);
  return <dialog ref={dialog} className="cloudDialog methodCaptureDialog" aria-labelledby="local-trial-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="local-trial-heading">核对本机试做结果</h2><button aria-label="关闭试做结果" disabled={busy} onClick={close}><X size={18}/></button></div>
    <h3>{session.localLoopTrial.name}</h3>
    {review && <><p><strong>目标：</strong>{review.criteria.goal}</p><p><strong>预期结果：</strong>{review.criteria.expectedResult}</p>{[...review.criteria.doneWhen, ...review.criteria.verify].length > 0 && <details><summary>原流程的完成标准与检查方法</summary><ul>{[...review.criteria.doneWhen, ...review.criteria.verify].map((item, i) => <li key={i}>{item}</li>)}</ul></details>}</>}
    {error && <p role="alert" className="inlineError">{error}</p>}
    {(saved || review) && <><p>核对结果是否符合原流程的目标、步骤和完成标准。Agent 结束回答不代表结果正确。</p><pre className="captureContent" tabIndex={0} aria-label="本机试做完整结果">{saved?.output || review.output}</pre></>}
    {saved ? <>
      <p>资料摘要：{saved.inputSummary}</p><p>确认说明：{saved.reviewNote}</p>
      {saved.error && <p role="alert" className="inlineError">{saved.error}</p>}
      <p role="status">{saved.saved ? '本机试做确认已保存为云端私有记录。尚未发布给团队。' : '原确认内容已固定，等待核对保存结果。'}</p>
      <button disabled={busy} onClick={() => act(async () => setSaved(await command('localLoopTrial.record', { sessionId: session.id, retry: true })))}>核对原保存记录</button>
      {saved.saved && <NativeLoopPublishPanel sessionId={session.id} busy={busy} act={act}/>}
    </> : review && <>
      <label className="loopInput">可保存的资料摘要<textarea value={summary} maxLength={16000} disabled={busy} onChange={e => setSummary(e.target.value)} placeholder="简述这次使用的资料，去掉不需要保存的私人信息。"/></label>
      <label className="loopInput">确认说明<textarea value={note} maxLength={4000} disabled={busy} onChange={e => setNote(e.target.value)} placeholder="你核对了什么，结果是否符合预期？"/></label>
      <label className="captureChoice"><input type="checkbox" checked={confirm} disabled={busy} onChange={e => setConfirm(e.target.checked)}/>我已检查结果，同意将上方摘要、完整结果和确认说明保存到此流程的云端私有记录。</label>
      <p className="cloudNote">请先保存相同版本的流程。这里只记录你确认的本机试做，不上传完整会话，也不获得云端执行或团队发布资格。</p>
      <button className="primary" disabled={busy || !confirm || !summary.trim() || !note.trim()} onClick={() => act(async () => { try { await command('localLoopTrial.record', { sessionId: session.id, reviewedHash: review.reviewedHash, inputSummary: summary, reviewNote: note, confirm: true }); } finally { setSaved(await command('localLoopTrial.saved', { sessionId: session.id })); } })}>保存本机试做确认</button>
    </>}
    <div className="cloudActions"><button disabled={busy} onClick={close}>回到会话</button><button disabled={busy} onClick={() => act(read)}>刷新结果</button></div>
  </dialog>;
}
