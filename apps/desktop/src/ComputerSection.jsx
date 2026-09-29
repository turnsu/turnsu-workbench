import React, { useEffect, useRef, useState } from 'react';
import { Monitor, Square } from 'lucide-react';
import { command, invoke, listen } from './desktop-bridge.mjs';
import { ProjectMaterialPicker } from './ProjectMaterialPicker.jsx';

export function ComputerSection({ project }) {
  const alive = useRef(true);
  const [state, setState] = useState(null), [history, setHistory] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [mode, setMode] = useState('isolated'), [target, setTarget] = useState('browser'), [origins, setOrigins] = useState(''), [apps, setApps] = useState(''), [files, setFiles] = useState(''), [minutes, setMinutes] = useState(30), [network, setNetwork] = useState(false), [consent, setConsent] = useState(false), [installConsent, setInstallConsent] = useState(false);
  async function read() { const next = await command('computer.status'); if (alive.current) setState(next); if (project) { const items = await command('computer.history', { projectId: project.id }); if (alive.current) setHistory(items); } }
  useEffect(() => { alive.current = true; read().catch(e => setError(e.message)); const sub = listen(e => { if (e.payload?.type === 'computer-changed') read().catch(e => setError(e.message)); }); return () => { alive.current = false; sub.then(off => off()); }; }, []);
  useEffect(() => { if (!state?.installing) return; const timer = setInterval(() => read().catch(e => setError(e.message)), 2000); return () => clearInterval(timer); }, [state?.installing]);
  async function act(fn) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn(); await read(); } catch (e) { if (alive.current) setError(e.message); } finally { if (alive.current) setBusy(false); } }
  const lines = text => text.split('\n').map(v => v.trim()).filter(Boolean);
  return <section className="capabilityRow"><div className="capabilityHeading"><h3><Monitor size={16}/>电脑操作</h3><span>{state?.grant ? '已授权 · ' + (state.grant.mode === 'local' ? '本机' : '隔离环境') : state?.installing ? '正在准备环境' : '未运行'}</span></div>
    {error && <p role="alert" className="error">{error}</p>}{state?.error && <p className="error">{state.error}</p>}{notice && <p role="status">{notice}</p>}
    {state?.cleanupPending && <p role="alert">操作通道已停用，运行环境仍需回收。<button disabled={busy} onClick={()=>act(()=>command('computer.stop'))}>重试停止与回收</button></p>}
    <p>默认使用独立电脑环境。一次只允许一个任务操作；空闲 5 分钟、锁屏或休眠后停止授权。</p>
    {state?.grant ? <div className="computerActive"><strong>{state.grant.mode === 'local' ? 'Agent 可以操作获准的本机软件' : 'Agent 可以操作隔离环境'}</strong><p>到期：{new Date(state.grant.expiresAt).toLocaleString()}</p><p>请新建 Agent 任务使用电脑工具。接管前先暂停；恢复时重新确认范围。</p><button className="danger" onClick={() => act(() => command('computer.stop'))}><Square size={14}/>暂停并撤销电脑操作</button></div> : <>
      <div className="capabilityForm"><label>操作模式<select value={mode} disabled={busy} onChange={e => { setMode(e.target.value); setTarget('browser'); setConsent(false); setInstallConsent(false); }}><option value="isolated">隔离环境（默认）</option><option value="local">本机环境（已登录的软件）</option></select></label></div>
      <details><summary>准备 {mode === 'isolated' ? '隔离电脑' : '本机 Driver'} · Cua {state?.version || ''}</summary><p>{mode === 'isolated' ? '需要 Docker。按需启动 Linux 图形环境，内存上限 1 GB、1 个 CPU，不挂载完整项目，不开放远程控制端口。' : '下载经摘要校验的 Driver，由工作台直接托管。macOS 还需在系统设置中给予工作台辅助功能与屏幕录制权限。'}</p><label className="capabilityCheck"><input type="checkbox" checked={installConsent} onChange={e => setInstallConsent(e.target.checked)}/>允许准备此模式的固定版本运行环境</label><button disabled={busy || !installConsent || state?.installing} onClick={() => act(() => invoke('computer_install', { mode, acknowledged: true }))}>{state?.installing ? '准备中…' : '准备环境'}</button></details>
      {!project ? <p>打开私有项目后设置电脑操作范围。</p> : <form className="capabilityForm" onSubmit={e => { e.preventDefault(); act(async () => { await command('computer.start', { projectId: project.id, mode, target, origins: lines(origins), apps: lines(apps), files: lines(files), minutes: Number(minutes), network, acknowledged: consent }); setConsent(false); }); }}>
        {mode === 'local' && <label>操作对象<select value={target} onChange={e => { setTarget(e.target.value); setConsent(false); }}><option value="browser">浏览器已登录站点</option><option value="app">本机应用</option></select></label>}
        {target === 'browser' && <label>允许操作的网站（每行一个 HTTPS 来源）<textarea required rows={2} placeholder="https://example.com" value={origins} onChange={e => {setOrigins(e.target.value);setConsent(false);}}/><small>包含启动所需的空白页；其他网站需重新授权。</small></label>}
        {mode === 'local' && <label>{target === 'browser' ? '选择要操作的浏览器' : '选择本机应用'}<textarea required rows={2} placeholder={state?.platform === 'darwin' ? '应用 Bundle ID' : '应用可执行文件完整路径'} value={apps} onChange={e => {setApps(e.target.value);setConsent(false);}}/><button type="button" disabled={busy} onClick={() => act(async () => {const selected = await invoke('computer_app_picker'); if(selected){setApps(lines(apps).concat(selected.identity).join('\n'));setConsent(false);}})}>从电脑中选择…</button></label>}

        <ProjectMaterialPicker projectId={project.id} paths={lines(files)} disabled={busy} onChange={paths=>{setFiles(paths.join('\n'));setConsent(false);}}/><p className="capabilityNote">材料生成独立副本；电脑工具输出先存放在本次任务中，停止后由你收取到项目。</p>
        <label>有效分钟<input type="number" required min={1} max={480} value={minutes} onChange={e => {setMinutes(e.target.value);setConsent(false);}}/></label>
        {mode === 'isolated' && <label className="capabilityCheck"><input type="checkbox" checked={network} onChange={e => {setNetwork(e.target.checked);setConsent(false);}}/>允许隔离环境出站联网（页面第三方资源也可联网）；网页操作仍限于所选来源</label>}
        <label className="capabilityCheck"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)}/>允许在上述范围读取画面与操作。画面可能进入所选 Agent 的模型上下文；此授权不约束该 Agent 自带的其他工具。</label>
        <button className="primary" type="submit" disabled={busy || Boolean(project.sharing) || state?.installing || state?.cleanupPending}>{busy ? '检查运行环境…' : '确认范围并启动'}</button>
      </form>}
    </>}
    {history.filter(r => ['revoked','expired'].includes(r.status)).map(r => <div key={r.id} className="scheduleRun"><span>已停止的电脑任务 · {r.id.slice(0, 8)}</span><button disabled={busy} onClick={() => act(async () => { const result = await command('computer.collect', { projectId: project.id, grantId: r.id }); setNotice(`已收取 ${result.files.length} 份成果${result.issues.length ? '；部分文件需手动检查：' + result.issues.join('、') : ''}`); })}>收取成果到项目</button></div>)}
  </section>;
}
