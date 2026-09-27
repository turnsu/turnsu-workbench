import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { SkillTrialPanel } from './SkillTrialPanel.jsx';
const command = (method, args) => window.__TAURI__.core.invoke('local_command', { method, args });

export function MethodCaptureDialog({ session, message, onOpen, onClose }) {
  const dialog = useRef(null), lock = useRef(false), requestId = useRef(crypto.randomUUID());
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [adopted, setAdopted] = useState(false);
  const [cloud, setCloud] = useState(null), [name, setName] = useState('');
  async function act(fn) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(String(e)); } finally { lock.current = false; setBusy(false); }
  }
  function close() { if (!lock.current) { dialog.current.close(); onClose(); } }
  async function read() { const value = await command('capture.preview', { sessionId: session.id }); setDraft(value); setAdopted(value.installed); }
  async function readCloud() {
    const value = await command('capture.cloud', { sessionId: session.id });
    setCloud(value); setName(value.saved?.name || draft.description.slice(0, 200));
  }
  async function saveCloud() {
    try { await command('capture.saveCloud', { sessionId: session.id, expectedHash: cloud.saved?.hash || draft.hash, name: cloud.saved?.name || name }); }
    finally { const value = await command('capture.cloud', { sessionId: session.id }); setCloud(value); }
  }
  useEffect(() => { dialog.current.showModal(); if (!message) act(read); }, []);
  async function open(method, args) {
    const next = await command(method, { ...args, requestId: requestId.current });
    await onOpen(next); onClose();
  }
  return <dialog ref={dialog} className="cloudDialog methodCaptureDialog" aria-labelledby="capture-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="capture-heading">{message ? '把这次成果整理成技能' : '查看技能草稿'}</h2><button disabled={busy} onClick={close} aria-label="关闭技能整理"><X size={18}/></button></div>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {message ? <>
      <p>用当前 Agent 和模型打开独立任务，从这条答复提炼以后可复用的方法。可以像平时聊天一样调整。</p>
      <details><summary>将带入的成果参考</summary><pre className="captureContent">{message.text}</pre></details>
      <p className="cloudNote">只带入你选中的这条答复。先准备任务草稿，点击发送才会使用模型额度；整理任务保留在本机。采用前可查看完整文件，团队发布另行处理。</p>
      <div className="cloudActions"><button disabled={busy} className="primary" onClick={() => act(() => open('capture.create', { sessionId: session.id, messageId: message.id }))}>准备整理任务</button></div>
    </> : <>
      {draft && <><p>{draft.description}</p><pre className="captureContent" tabIndex={0} aria-label="完整技能文件">{draft.content}</pre></>}
      <p className="cloudNote">采用后加入当前项目的 {session.agent === 'claude' ? 'Claude Code' : session.agent === 'pi' ? 'Pi' : 'Codex'} 技能目录。请检查私人信息、具体步骤和适用条件。采用不代表通过试运行，也不会发布给团队。</p>
      {adopted && <p role="status">已加入本机技能，可以在新任务中使用。</p>}
      {draft && <section className="captureCloud">
        {!cloud ? <button disabled={busy} onClick={() => act(readCloud)}>保存云端私有草稿…</button> : <>
          <h3>云端私有草稿</h3>
          <p className="cloudNote">{cloud.saved?.origin || cloud.origin || '请先在团队连接中登录。'} · 仅保存已确认的技能文件，不包含原会话。保存草稿本身不会发布，也不会调用模型。</p>
          {cloud.saved && <details><summary>本次固定的上传内容</summary><pre className="captureContent">{cloud.saved.content}</pre></details>}
          <label className="loopInput">技能名称<input value={name} maxLength={200} disabled={busy || !!cloud.saved} onChange={e => setName(e.target.value)}/></label>
          {cloud.saved?.error && <p role="alert" className="inlineError">{cloud.saved.error}</p>}
          {cloud.saved?.saved && <><p role="status">已保存云端草稿。</p><SkillTrialPanel sessionId={session.id}/></>}
          <button disabled={busy || !cloud.origin || !name.trim()} onClick={() => act(saveCloud)}>{cloud.saved ? '核对原保存记录' : '确认保存私有草稿'}</button>
          {cloud.saved?.canRestart && <><p className="cloudNote">重新准备会释放本机的失败记录；已上传到云端的私有文件仍保留，不会发布。</p><button disabled={busy} onClick={() => act(async () => { await command('capture.resetCloud', { sessionId: session.id, expectedHash: cloud.saved.hash }); await read(); setCloud(null); })}>重新准备</button></>}
        </>}
      </section>}
      <div className="cloudActions"><button disabled={busy} onClick={() => act(read)}>重新读取</button><button disabled={busy} onClick={close}>回到会话调整</button>{adopted ? <button disabled={busy} className="primary" onClick={() => act(() => open('capture.use', { sessionId: session.id }))}>用这个技能开新任务</button> : <button className="primary" disabled={busy || !draft} onClick={() => act(async () => { await command('capture.adopt', { sessionId: session.id, expectedHash: draft.hash }); setAdopted(true); })}>采用到本机</button>}</div>
    </>}
  </dialog>;
}
