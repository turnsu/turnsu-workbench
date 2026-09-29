import { ProjectMaterialPicker } from './ProjectMaterialPicker.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Clock3 } from 'lucide-react';
import { command, invoke, listen } from './desktop-bridge.mjs';
import './capabilities.css';

const states = { starting: '准备执行', running: '正在执行', waiting: '等待批准', completed: '已完成', failed: '需要处理', uncertain: '需要核对结果', reviewed: '已人工核对', skipped: '已跳过错过的时间', skipped_busy: '已有任务未结束，本次跳过' };
export function SchedulesDialog({ project, agents, initial, onOpen, onClose }) {
  const dialog = useRef(null), alive = useRef(true);
  const [skills,setSkills]=useState([]);
  const [agentConnections, setAgentConnections] = useState([]), [review,setReview] = useState(null);
  const [items, setItems] = useState(null), [form, setForm] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [startup, setStartup] = useState(null);
  async function read() { const value = await command('schedules.list', { projectId: project?.id }); if (alive.current) setItems(value.items); }
  useEffect(() => {
    alive.current = true; dialog.current.showModal(); read().catch(e => setError(e.message));
    if(project)command('skills.list',{projectId:project.id}).then(value=>setSkills(value.items.filter(s=>s.source==='project'&&s.kind==='skill'))).catch(e=>setError(e.message));
    command('agents.connections').then(setAgentConnections).catch(e => setError(e.message));
    invoke('background_settings').then(setStartup).catch(e => setError(e.message));
    const subscription = listen(e => { if (e.payload?.type === 'schedule-changed') read().catch(e => setError(e.message)); });
    return () => { alive.current = false; subscription.then(off => off()); };
  }, []);
  async function act(fn) { if (busy) return; setBusy(true); setError(''); try { await fn(); await read(); } catch (e) { if (alive.current) setError(e.message); } finally { if (alive.current) setBusy(false); } }
  function close() { if (!busy) { dialog.current.close(); onClose(); } }
  function create() { setForm({ agentConnectionId: initial?.agentConnectionId || null, materials: initial?.materials || [], externalConsent: false, name: '', prompt: initial?.prompt || '', agent: initial?.agent || agents.find(a => a.installed)?.id || 'codex', model: initial?.model || null, connectionId: initial?.connectionId || null, references: initial?.references?.filter(p => typeof p === 'string') || [], kind: 'daily', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, time: '09:00', weekday: 1, minutes: 60, start: '', misfire: 'skip', acknowledge: false }); }
  function change(key, value) { setForm(f => ({ ...f, [key]: value })); }
  function save(e) {
    e.preventDefault(); const [hour, minute] = form.time.split(':').map(Number);
    act(async () => { await command('schedules.save', { ...form, projectId: project.id, timing: { kind: form.kind, timezone: form.timezone, hour, minute, weekday: Number(form.weekday), minutes: Number(form.minutes), startAt: form.start ? new Date(form.start).getTime() : Date.now() + 60_000 } }); setForm(null); });
  }
  return <dialog ref={dialog} className="capabilityDialog" aria-labelledby="schedules-title" onCancel={e => { e.preventDefault(); close(); }}>
    <header><div><h2 id="schedules-title">本机定时任务</h2><p>{project ? project.name : '所有项目'} · 电脑休眠或关机时不会执行</p></div><button aria-label="关闭定时任务" disabled={busy} onClick={close}><X size={18}/></button></header>
    <div className="capabilityBody">
      {error && <p role="alert" className="error">{error}</p>}
      {startup && <label className="capabilityCheck"><input type="checkbox" checked={startup.openAtLogin} disabled={busy || !startup.supported} onChange={e => act(async () => setStartup(await invoke('background_settings', { openAtLogin: e.target.checked })))}/>登录电脑后自动启动工作台{!startup.supported && '（当前系统不支持）'}</label>}
      <p className="capabilityNote">有启用的计划时，关闭窗口会保留托盘后台；从菜单选择“退出工作台”会停止调度。</p>
      {!form && !review && <><div className="capabilityHeading"><h3>计划</h3><button disabled={busy || !project || Boolean(project.sharing)} onClick={create}><Plus size={15}/>新建计划</button></div>
        {!project && <p>先打开本地项目，再添加计划。</p>}{project?.sharing && <p>定时任务目前只支持私有本地项目。</p>}
        {items === null ? <p role="status">正在读取计划…</p> : !items.length ? <div className="capabilityEmpty"><Clock3 size={24}/><strong>让重复工作按时开始</strong><p>固定任务、Agent 和材料，在这台电脑上运行。</p></div> : items.map(item => <section className="capabilityRow" key={item.id}>
          <div className="capabilityHeading"><strong>{item.name}</strong><span>{item.status === 'active' ? '已启用' : item.status === 'paused' ? '已暂停' : '计划已结束'}</span></div>
          <p>{agents.find(a => a.id === item.spec.agent)?.name || item.spec.agent} · {item.spec.timing.timezone}</p><p>{item.next_at ? `下次：${new Date(item.next_at).toLocaleString()}` : '没有下一次执行'}</p>
          <div className="capabilityActions"><button disabled={busy} onClick={() => act(() => command('schedules.pause', { id: item.id, paused: item.status === 'active' }))}>{item.status === 'active' ? '暂停' : '启用'}</button><button disabled={busy} onClick={() => act(async () => { const run = await command('schedules.run', { id: item.id, requestId: crypto.randomUUID() }); if (run.session_id) await onOpen({ project_id: item.project_id, id: run.session_id }); })}>立即运行</button><button disabled={busy} onClick={() => { const t = item.spec.timing; setForm({ ...item.spec, id: item.id, revision: item.revision, name: item.name, kind: t.kind, timezone: t.timezone, time: `${String(t.hour ?? 9).padStart(2, '0')}:${String(t.minute ?? 0).padStart(2, '0')}`, weekday: t.weekday ?? 1, minutes: t.minutes ?? 60, start: t.startAt ? new Date(t.startAt-new Date(t.startAt).getTimezoneOffset()*60_000).toISOString().slice(0,16) : '', acknowledge: false }); }}>编辑</button></div>
          {item.runs.length > 0 && <details><summary>最近执行 · {states[item.runs[0].status] || item.runs[0].status}</summary>{item.runs.map(run => <div className="scheduleRun" key={run.id}><span>{new Date(run.scheduled_at).toLocaleString()} · {states[run.status] || run.status}</span>{run.error && <p>{run.error}</p>}{run.session_id && <button onClick={() => onOpen({ project_id: item.project_id, id: run.session_id })}>查看会话和成果</button>}{run.status === 'waiting' && run.error && <button disabled={busy} onClick={() => act(async () => setReview(await command('schedules.review', {runId:run.id})))}>查看变化并批准本次执行</button>}{run.status === 'uncertain' && <button disabled={busy} onClick={() => act(() => command('schedules.resolve', { runId: run.id, acknowledged: true }))}>已核对，允许后续计划</button>}</div>)}</details>}
        </section>)}
      </>}
      {review && <section className="remoteReview"><h3>批准本次执行 · {review.name}</h3><p>{agents.find(a=>a.id===review.agent)?.name||review.agent} · {review.agentConnectionId ? agentConnections.find(c=>c.id===review.agentConnectionId)?.name||'原计划账号' : review.connectionId ? '原计划模型网关' : '原生账号'}{review.model ? ` · ${review.model}` : ''}</p><pre>{review.prompt}</pre><p>材料：{[...(review.references||[]),...(review.materials||[])].join('、')||'没有选定文件'}</p>{review.skill && <p>Skill：{review.skill.path}（固定原版本）</p>}<div className="capabilityColumns"><PermissionSummary title="计划原授权" permissions={review.previousPermissions}/><PermissionSummary title="本次将使用的授权" permissions={review.currentPermissions}/></div>{review.external && <p>本次提示词和选定材料会发送至原计划固定的外部 Agent 账号。</p>}<p>仅批准这一轮；后续计划仍按原授权检查。原生 Agent 自带的工具继续由其权限机制控制。</p><button disabled={busy} onClick={()=>setReview(null)}>返回</button><button className="primary" disabled={busy} onClick={()=>act(async()=>{await command('schedules.approve',{runId:review.runId,reviewHash:review.reviewHash,acknowledged:true});setReview(null);})}>确认上述范围，执行一次</button></section>}
      {form && <form className="capabilityForm" onSubmit={save}>
        <label>名称<input required maxLength={80} value={form.name} onChange={e => change('name', e.target.value)}/></label>
        <label>执行 Agent<select value={form.agent} onChange={e => { change('agent', e.target.value); change('connectionId', null); change('model', null); change('agentConnectionId', null); change('externalConsent', false); change('skill', null); }}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}{!a.installed ? ` · ${a.availabilityLabel||'未安装'}` : ''}</option>)}</select></label>
        <p className="capabilityNote">模型来源：{form.connectionId ? '固定当前已选网关连接' : '沿用此 Agent 的原生配置'}。修改计划不改变已开始的执行。</p>
        {['manus','workbuddy-local','workbuddy-cloud','muse'].includes(form.agent) && <><label>固定 Agent 连接<select required value={form.agentConnectionId || ''} onChange={e => change('agentConnectionId', e.target.value)}><option value="">选择已连接账号</option>{agentConnections.filter(c => !c.revoked && (c.provider === form.agent || c.agents?.includes(form.agent))).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><ProjectMaterialPicker projectId={project.id} paths={form.materials||[]} disabled={busy} onChange={paths=>change('materials',paths)}/><label className="capabilityCheck"><input type="checkbox" required checked={form.externalConsent || false} onChange={e => change('externalConsent', e.target.checked)}/>未来 30 天允许按此计划向这个账号发送提示词、引用和这些材料的当次版本；过期后等待重新批准。Muse 仍需用户接手。</label></>}
        {!['manus','workbuddy-local','workbuddy-cloud','muse'].includes(form.agent) && <label>固定项目 Skill（可选）<select value={form.skill?.path||''} onChange={e=>{const selected=skills.find(s=>s.agent===form.agent&&s.path===e.target.value);change('skill',selected?{path:selected.path,expectedHash:selected.hash}:null);}}><option value="">不附加 Skill</option>{skills.filter(s=>s.agent===form.agent).map(s=><option key={s.path} value={s.path}>{s.name}</option>)}</select></label>}
        {form.skill && <p>执行前会核对所选 Skill 版本。文件发生变化时暂停本轮，需重新选择版本并保存计划。</p>}
        <label>任务<textarea required rows={4} maxLength={80000} value={form.prompt} onChange={e => change('prompt', e.target.value)}/></label>
        {form.references.length > 0 && <p>每次从这些项目文件生成快照：{form.references.join('、')}</p>}
        <div className="capabilityColumns"><label>频率<select value={form.kind} onChange={e => change('kind', e.target.value)}><option value="once">一次</option><option value="interval">按间隔</option><option value="daily">每日</option><option value="weekly">每周</option></select></label><label>时区<input required value={form.timezone} onChange={e => change('timezone', e.target.value)}/></label></div>
        {['daily','weekly'].includes(form.kind) ? <label>当地时间<input type="time" required value={form.time} onChange={e => change('time', e.target.value)}/></label> : <label>开始时间（本机时区）<input type="datetime-local" required={form.kind === 'once'} value={form.start} onChange={e => change('start', e.target.value)}/></label>}
        {form.kind === 'weekly' && <label>星期<select value={form.weekday} onChange={e => change('weekday', e.target.value)}>{['日','一','二','三','四','五','六'].map((day, i) => <option key={i} value={i}>星期{day}</option>)}</select></label>}
        {form.kind === 'interval' && <label>间隔分钟<input type="number" min={1} max={525600} required value={form.minutes} onChange={e => change('minutes', e.target.value)}/></label>}
        <label>错过时<select value={form.misfire} onChange={e => change('misfire', e.target.value)}><option value="skip">跳过并留下记录</option><option value="latest">只补最近一次</option></select></label>
        <label className="capabilityCheck"><input type="checkbox" checked={form.acknowledge} required onChange={e => change('acknowledge', e.target.checked)}/>允许在本机后台按此计划执行；原生 Agent 继续使用自己的账号与权限，新增批准需要我回应。</label>
        <div className="capabilityActions"><button type="button" disabled={busy} onClick={() => setForm(null)}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存计划'}</button></div>
      </form>}
    </div>
  </dialog>;
}

function PermissionSummary({title,permissions}) {
  const docs=permissions?.documents,computer=permissions?.computer;
  return <div><strong>{title}</strong>{docs ? <p>文件读取：{docs.config.reads.join('、')}<br/>写入新文件：{docs.config.output}<br/>有效至 {new Date(docs.expiresAt).toLocaleString()}</p> : <p>文件工具：未授权</p>}{computer ? <p>电脑：{computer.manifest.resources.browser?.origins.join('、')||computer.manifest.resources.apps?.map(a=>a.bundle_id||a.executable).join('、')}<br/>有效至 {new Date(computer.expiresAt).toLocaleString()}</p> : <p>电脑操作：未授权</p>}</div>;
}
