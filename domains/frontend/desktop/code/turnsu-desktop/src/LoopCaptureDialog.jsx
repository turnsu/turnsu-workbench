import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
const command = (method, args) => window.__TAURI__.core.invoke('local_command', { method, args });
const kinds = { Input: '资料', Skill: '技能', Transform: '整理', Material: '参考资料', ReviewGate: '人工确认', Output: '结果' };
function checkIssue(warning) {
  const code = warning.code || '';
  if (/model_/.test(code)) return '这一步还没有可用的执行模型。请配置团队工作流模型后重新检查；本机 Agent 的登录不会自动成为云端模型配置。';
  if (/skill|adapter|pi_not_ready/.test(code)) return '需要的技能版本或执行环境尚不可用，请检查所选技能。';
  if (/resource/.test(code)) return '参考资料尚不可用，请核对资料及访问权限。';
  if (/review_gate/.test(code)) return '这一步会产生外部操作，需要加入人工确认。';
  return '流程的输入、输出或步骤连接需要调整。可将检查详情交给 Agent 修正后，再保存新版。';
}
function inputSource(source, document) {
  if (source.kind === 'runInput') return '运行时提供的“' + (document.inputForm.fields.find(f => f.fieldId === source.inputKey)?.label || '资料') + '”';
  if (source.kind === 'nodeOutput') { const node = document.graph.nodes.find(n => n.nodeId === source.nodeId); return node ? '“' + node.title + '”的' + (node.outputPorts.find(p => p.portId === source.portId)?.name || '输出') : '尚未找到的步骤，请回到会话修正'; }
  if (source.kind === 'resource') return '已选参考资料';
  return typeof source.value === 'string' ? source.value : JSON.stringify(source.value);
}


export function LoopCaptureDialog({ session, message, onOpen, onClose }) {
  const dialog = useRef(null), lock = useRef(false), request = useRef(crypto.randomUUID());
  const [draft, setDraft] = useState(null), [cloud, setCloud] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [teamSkills, setTeamSkills] = useState(false);
  async function act(fn) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { lock.current = false; setBusy(false); } }
  async function read() { setDraft(await command('loopCapture.preview', { sessionId: session.id })); }
  async function readCloud() { setCloud(await command('loopCapture.cloud', { sessionId: session.id })); }
  function close() { if (!lock.current) { dialog.current.close(); onClose(); } }
  useEffect(() => { dialog.current.showModal(); if (!message) act(read); }, []);
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const fixed = cloud?.saved, changed = fixed?.saved && draft && fixed.hash !== draft.hash;
  const document = reviewUpdate ? draft?.document : fixed?.document || draft?.document;
  return <dialog ref={dialog} className="cloudDialog methodCaptureDialog" aria-labelledby="loop-capture-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="cloudHeading"><h2 id="loop-capture-heading">{message ? '把这次成果整理成 Loop' : '检查可复用流程'}</h2><button disabled={busy} onClick={close} aria-label="关闭 Loop 整理"><X size={18}/></button></div>
    {error && <p role="alert" className="inlineError">{error}</p>}
    {message ? <>
      <p>用当前 Agent 和模型整理可重复的步骤、资料和检查方法。像平时聊天一样调整，完成后再检查流程。</p>
      <details><summary>将带入的成果参考</summary><pre className="captureContent">{message.text}</pre></details>
      <label className="captureChoice"><input type="checkbox" checked={teamSkills} onChange={e => { setTeamSkills(e.target.checked); request.current = crypto.randomUUID(); }} disabled={busy}/>参考团队可用技能（需要已连接团队）</label>
      <p className="cloudNote">只带入这条答复，以及你勾选的技能目录。先准备独立的本地任务，发送后才使用当前模型额度。保存云端草稿与团队发布分别确认。</p>
      <div className="cloudActions"><button className="primary" disabled={busy} onClick={() => act(async () => { const next = await command('loopCapture.create', { sessionId: session.id, messageId: message.id, requestId: request.current, includeTeamSkills: teamSkills }); await onOpen(next); onClose(); })}>准备整理任务</button></div>
    </> : <>
      {document && <>
        <h3>{document.name}</h3><p>{document.description}</p><p><strong>要完成：</strong>{document.definition.goal}</p><p><strong>得到：</strong>{document.definition.expectedResult}</p>
        <section className="loopCaptureSteps" aria-label="流程步骤">{document.graph.nodes.map(node => <article key={node.nodeId}><small>{kinds[node.kind]}</small><strong>{node.title}</strong><p>{node.description}</p><details><summary>查看这一步的输入和规则</summary>{node.inputPorts.map(port => <p key={port.portId}>需要：{port.name}{port.required ? '（必填）' : ''}</p>)}{node.outputPorts.map(port => <p key={port.portId}>生成：{port.name}</p>)}{node.reviewPolicy.mode === 'required' && <p>需要人工确认：{node.reviewPolicy.instructions}</p>}{node.configuration.instructions && <p>{node.configuration.instructions}</p>}{node.inputBindings.map((binding, i) => <p key={i}>{node.inputPorts.find(p => p.portId === binding.targetPort)?.name || '输入'}来自：{inputSource(binding.source, document)}</p>)}{node.skillRef && <p>使用固定技能版本 {node.skillRef.version}</p>}{node.configuration.mode === 'boundedAgent' && <p>由 Agent 完成这一步整理，运行时需要可用模型。</p>}{node.condition && <p>这一步有执行条件，请在完整流程文件中核对。</p>}<p>单次最长 {node.timeoutSeconds} 秒；最多尝试 {node.retryPolicy.maxAttempts} 次。</p></details></article>)}</section>
        <details><summary>步骤如何连接</summary>{document.graph.edges.map(edge => <p key={edge.edgeId}>{document.graph.nodes.find(n => n.nodeId === edge.sourceNodeId)?.title || '未找到步骤'} → {document.graph.nodes.find(n => n.nodeId === edge.targetNodeId)?.title || '未找到步骤'}</p>)}</details>
        {[["适用背景", [document.definition.context]], ["限制", document.definition.constraints], ["完成标准", document.definition.doneWhen], ["验证方法", document.definition.verify], ["停止条件", document.definition.stopRules]].map(([label, values]) => values.some(Boolean) && <details key={label}><summary>{label}</summary><ul>{values.filter(Boolean).map((value, i) => <li key={i}>{value}</li>)}</ul></details>)}
        <details><summary>完整流程文件</summary><pre className="captureContent" tabIndex={0}>{reviewUpdate ? draft.content : fixed?.content || draft.content}</pre></details>
      </>}
      {changed && <p role="status" className="cloudNote">{reviewUpdate ? '当前展示本机修改，确认保存后才更新云端。' : '当前展示上次确认的云端草稿。本机还有修改，尚未保存到云端。'}</p>}
      <p className="cloudNote">请检查私人信息、步骤和所需权限。草稿尚未执行或发布；检查通过也不代表实际结果已验收。</p>
      {draft && <section className="captureCloud"><h3>在本机试做</h3><p className="cloudNote">用当前 Agent 按流程处理一份实际资料。先准备独立会话，所需技能安装到当前项目，发送后才执行。结果由你核对，不需要配置云端模型。</p><button disabled={busy} onClick={() => act(async () => { const next = await command('localLoopTrial.create', { sessionId: session.id, expectedHash: reviewUpdate ? draft.hash : fixed?.hash || draft.hash, requestId: request.current }); await onOpen(next); onClose(); })}>准备本机试做</button></section>}
      {draft && <section className="captureCloud">{!cloud ? <button disabled={busy} onClick={() => act(readCloud)}>保存云端私有草稿…</button> : <>
        <h3>云端私有草稿</h3><p className="cloudNote">{cloud.origin} · 仅上传已查看的流程文件。</p>
        {fixed?.error && <p role="alert" className="inlineError">{fixed.error}</p>}
        {fixed?.saved ? <><p role="status">流程草稿已保存。</p>{changed && <button disabled={busy} onClick={() => setReviewUpdate(!reviewUpdate)}>{reviewUpdate ? '查看已保存版本' : '查看本机修改'}</button>}{reviewUpdate ? <button className="primary" disabled={busy} onClick={() => act(async () => { try { await command('loopCapture.save', { sessionId: session.id, expectedHash: draft.hash, confirm: true, update: true }); } finally { setReviewUpdate(false); await readCloud(); } })}>确认保存本机修改</button> : <><button disabled={busy} onClick={() => act(async () => { await command('loopCapture.check', { sessionId: session.id }); await readCloud(); })}>检查技能和资料是否齐全</button>{fixed.compilation && <p role="status">{fixed.compilation.status === 'ready' ? '检查通过，尚未试运行。' : '还不能运行，请检查下方缺项并回到会话调整。'}</p>}{fixed.compilation?.warnings?.map((w, i) => <p key={i} className="cloudNote">{checkIssue(w)}</p>)}{fixed.compilation?.warnings?.length > 0 && <details><summary>检查详情</summary><pre className="captureContent">{fixed.compilation.warnings.map(w => w.message).join('\n')}</pre></details>}</>}</> : <button className="primary" disabled={busy} onClick={() => act(async () => { try { await command('loopCapture.save', { sessionId: session.id, expectedHash: fixed?.hash || draft.hash, confirm: true }); } finally { await readCloud(); } })}>{fixed ? '核对原保存记录' : '确认保存私有 Loop'}</button>}
        {fixed?.canRestart && <><p className="cloudNote">已生成的云端私有草稿会保留。调整本机流程后，可重新准备保存。</p><button disabled={busy} onClick={() => act(async () => { await command('loopCapture.reset', { sessionId: session.id, expectedHash: fixed.hash }); setCloud(null); await read(); })}>重新准备</button></>}
      </>}</section>}
      <div className="cloudActions"><button disabled={busy} onClick={() => act(read)}>重新读取</button><button disabled={busy} onClick={close}>回到会话调整</button></div>
    </>}
  </dialog>;
}
