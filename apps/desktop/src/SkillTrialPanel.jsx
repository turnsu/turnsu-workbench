import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
const command = (method, args) => invoke('local_command', { method, args });
const active = status => ['queued', 'running'].includes(status);
const labels = { queued: '等待执行', running: '正在试运行', passed: '执行完成，请检查结果', failed: '试运行失败', blocked: '暂时无法执行', cancelled: '已取消' };

export function SkillTrialPanel({ sessionId }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [sample, setSample] = useState(''), [purpose, setPurpose] = useState(''), [reviewed, setReviewed] = useState(false);
  const mounted = useRef(false), intent = useRef(null), lock = useRef(false);
  async function read() {
    const value = await command('capture.trials', { sessionId });
    if (mounted.current) { setState(value); setError(''); }
    return value;
  }
  useEffect(() => { mounted.current = true; read().catch(e => { if (mounted.current) setError(String(e)); }); return () => { mounted.current = false; }; }, [sessionId]);
  const trial = state?.trials[0], waiting = state?.pending.length > 0;
  useEffect(() => { setReviewed(false); }, [trial?.reviewedOutputHash]);
  useEffect(() => {
    if (!state?.trials.some(t => active(t.status))) return;
    const timer = setTimeout(() => read().catch(e => { if (mounted.current) setError(String(e)); }), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  async function act(fn) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    let failure;
    try { await fn(); intent.current = null; } catch (e) { failure = String(e); }
    try { const latest = await read(); if (!latest.pending.length) intent.current = null; } catch (e) { failure ||= String(e); }
    if (mounted.current) { if (failure) setError(failure); setBusy(false); }
    lock.current = false;
  }
  function submit(kind, data) {
    const payload = JSON.stringify({ kind, ...data });
    if (intent.current?.payload !== payload) intent.current = { payload, id: crypto.randomUUID() };
    return command('capture.releaseAction', { sessionId, requestId: intent.current.id, kind, ...data });
  }
  const output = trial?.outputPreview;
  return <section className="skillTrialPanel">
    <h3>{state?.published ? '已发布到团队' : '试运行并发布'}</h3>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {state?.published ? <p role="status">v{state.published.version.version} 已加入团队技能库。成员可以用自己的 Agent 安装这个版本；本次试运行资料和原生会话仍保持私有。</p> : <>
      <p className="cloudNote">提供一段实际资料，检查是否得到需要的结果。试运行使用你在团队设置中授权的执行环境、模型与额度；开始试运行不会发布。</p>
      {!!state?.error && <p className="inlineError">{state.error}</p>}
      {waiting ? state.pending.map(item => <div className="loopPending" key={item.id}><p>{({ test: '试运行提交', publish: '校验与发布', cancel: '取消试运行' })[item.kind]}尚未确认。将核对原操作。</p><button disabled={busy} onClick={() => act(() => command('capture.retryRelease', { requestId: item.id }))}>核对原操作</button></div>) : <>
        <label className="loopInput">用什么资料试一次<textarea value={sample} maxLength={20000} disabled={busy || active(trial?.status)} onChange={e => setSample(e.target.value)} placeholder="粘贴一段适合这个技能的真实资料"/></label>
        <label className="loopInput">怎样的结果算有用<textarea value={purpose} maxLength={2000} disabled={busy || active(trial?.status)} onChange={e => setPurpose(e.target.value)} placeholder="例如：每项建议都有原文依据，缺失信息标为未知"/></label>
        <button disabled={busy || !state || active(trial?.status) || !sample.trim() || !purpose.trim()} onClick={() => act(() => submit('test', { sample, purpose }))}>开始试运行</button>
      </>}
      {trial && <div className="trialResult"><h4>{labels[trial.status]}</h4>
        <details><summary>本次资料与预期</summary><p>{trial.testCase.purpose}</p><pre className="captureContent">{trial.testCase.input.request}</pre></details>
        {output !== null && output !== undefined && <pre className="captureContent" tabIndex={0} aria-label="完整试运行结果">{Object.keys(output).length === 1 && typeof output.result === 'string' ? output.result : JSON.stringify(output, null, 2)}</pre>}
        {trial.diagnostics.map((d, i) => <p className="inlineError" key={i}>{d.message}</p>)}
        {active(trial.status) && <button disabled={busy || waiting} onClick={() => act(() => submit('cancel', { testRunId: trial.testRunId }))}>取消试运行</button>}
        {trial.status === 'passed' && <>
          {!trial.currentDraft && <p className="inlineError">云端草稿已变化，请重新试运行。</p>}
          <label className="methodScope"><input type="checkbox" checked={reviewed} disabled={busy || !trial.currentDraft || waiting} onChange={e => setReviewed(e.target.checked)}/>我已检查结果符合预期，允许当前团队使用这个技能。</label>
          <p className="cloudNote">将校验并发布 v1.0.0。团队可看到技能文件与使用说明；不会共享本次试运行资料、模型凭证或原会话。</p>
          <button className="primary" disabled={busy || waiting || !!error || !reviewed || !trial.currentDraft} onClick={() => act(() => submit('publish', { testRunId: trial.testRunId, reviewedOutputHash: trial.reviewedOutputHash, confirm: true }))}>发布给当前团队</button>
        </>}
      </div>}
    </>}
    <button disabled={busy} onClick={() => act(async () => {})}>刷新运行状态</button>
  </section>;
}
