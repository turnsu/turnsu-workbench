import { invoke } from "./desktop-bridge.mjs";
import React, { useState } from 'react';
const command = (method, args) => invoke('local_command', { method, args });
function orderedSteps(recipe) {
  const result = [], visited = new Set(); let node = recipe.graph.nodes.find(n => n.kind === 'Input');
  while (node && !visited.has(node.nodeId)) {
    result.push(node); visited.add(node.nodeId);
    const edges = recipe.graph.edges.filter(e => e.sourceNodeId === node.nodeId);
    if (edges.length > 1) return recipe.graph.nodes;
    node = recipe.graph.nodes.find(n => n.nodeId === edges[0]?.targetNodeId);
  }
  return result.length === recipe.graph.nodes.length ? result : recipe.graph.nodes;
}

export function NativeLoopPublishPanel({ sessionId, busy, act }) {
  const [view, setView] = useState(null), [version, setVersion] = useState('1.0.0'), [notes, setNotes] = useState(''), [confirm, setConfirm] = useState(false);
  async function read() { setView(await command('localLoopTrial.publication', { sessionId })); }
  if (!view) return <button disabled={busy} onClick={() => act(read)}>让同事也能使用这个流程…</button>;
  return <section className="captureCloud"><h3>发布给团队</h3>
    <p>同事会在团队方法中找到这份流程，用自己的 Codex、Claude Code 或 Pi 执行。下面的完整流程及固定技能版本对当前 workspace 成员可见；本次试做的资料摘要、结果和确认说明保持私有。</p>
    <p><strong>{view.recipe.name}</strong> · {view.recipe.definition.goal}</p>
    <ol>{orderedSteps(view.recipe).map(node => <li key={node.nodeId}>{node.title}{node.skillRef ? ` · 技能 v${node.skillRef.version}` : ''}</li>)}</ol>
    <details><summary>核对完整发布内容与团队范围</summary><p>{view.origin} · {view.workspaceId}</p><pre className="captureContent" tabIndex={0}>{JSON.stringify(view.recipe, null, 2)}</pre></details>
    <p className="cloudNote">当前支持顺序调用已发布技能的流程。包含分支、私有资料或专用云端依赖的流程需要先调整。发布本机方法不会开启云端自动运行。</p>
    {view.error && <p role="alert" className="inlineError">{view.error}</p>}
    {view.published || view.pending ? <><p role="status">{view.published ? `v${view.version} 已发布。同事可以在团队方法中使用。` : view.canChangeVersion ? `v${view.version} 已被占用，本次内容未发布。` : `v${view.version} 的发布内容已固定，请核对结果或上方提示。`}</p>{view.canChangeVersion ? <button disabled={busy} onClick={() => act(async () => { setView(await command('localLoopTrial.changeVersion', { sessionId, expectedVersion: view.version })); setConfirm(false); })}>改用其他版本</button> : <button disabled={busy} onClick={() => act(async () => { try { await command('localLoopTrial.publish', { sessionId, retry: true }); } finally { await read(); } })}>核对原发布</button>}</> : <>
      <label className="loopInput">版本<input value={version} maxLength={64} disabled={busy} onChange={e => setVersion(e.target.value)} placeholder="1.0.0"/></label>
      <details><summary>补充版本说明</summary><textarea aria-label="版本说明" value={notes} maxLength={4000} disabled={busy} onChange={e => setNotes(e.target.value)}/></details>
      <label className="captureChoice"><input type="checkbox" checked={confirm} disabled={busy} onChange={e => setConfirm(e.target.checked)}/>我已检查完整流程不含私人信息，同意将这个固定版本提供给当前团队。</label>
      <button className="primary" disabled={busy || !confirm || !view.canPrepare || !/^\d+\.\d+\.\d+$/.test(version)} onClick={() => act(async () => { try { await command('localLoopTrial.publish', { sessionId, version, releaseNotes: notes, confirm: true }); } finally { await read(); } })}>确认发布本机流程</button>
    </>}
  </section>;
}
