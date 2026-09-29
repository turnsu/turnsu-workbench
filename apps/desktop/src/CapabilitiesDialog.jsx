import React, { useEffect, useRef, useState } from 'react';
import { X, FileText, ShieldCheck } from 'lucide-react';
import { command, invoke } from './desktop-bridge.mjs';
import './capabilities.css';
import { ComputerSection } from './ComputerSection.jsx';
import { DocumentPreview } from './DocumentPreview.jsx';

const statuses = { not_installed: '尚未安装', installing: '正在准备环境', enabled: '已启用', disabled: '已停用', failed: '需要处理' };
export function CapabilitiesDialog({ project, onClose }) {
  const dialog = useRef(null), alive = useRef(true);
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [office, setOffice] = useState(false), [ocr, setOcr] = useState(false), [installConsent, setInstallConsent] = useState(false);
  const [reads, setReads] = useState(''), [output, setOutput] = useState('Outputs'), [hours, setHours] = useState(8), [consent, setConsent] = useState(false), [path, setPath] = useState(''), [result, setResult] = useState(null);
  async function read() { const next = await command('capabilities.list', { projectId: project?.id }); if (alive.current) setState(next); }
  useEffect(() => { alive.current = true; dialog.current.showModal(); read().catch(e => setError(e.message)); return () => { alive.current = false; }; }, []);
  useEffect(() => { if (state?.documents.status !== 'installing') return; const timer = setInterval(() => read().catch(e => setError(e.message)), 2000); return () => clearInterval(timer); }, [state?.documents.status]);
  async function act(fn) { if (busy) return; setBusy(true); setError(''); try { await fn(); await read(); } catch (e) { if (alive.current) setError(e.message); } finally { if (alive.current) setBusy(false); } }
  function close() { if (!busy) { dialog.current.close(); onClose(); } }
  return <dialog ref={dialog} className="capabilityDialog" aria-labelledby="capabilities-title" onCancel={e => { e.preventDefault(); close(); }}>
    <header><div><h2 id="capabilities-title">能力与权限</h2><p>安装工具不等于允许它读取项目或控制电脑。</p></div><button aria-label="关闭能力与权限" disabled={busy} onClick={close}><X size={18}/></button></header>
    <div className="capabilityBody">
      <ComputerSection project={project}/>
      {error && <p className="error" role="alert">{error}</p>}
      {state?.cleanupError && <div role="alert"><p className="error">{state.cleanupError}</p><button disabled={busy} onClick={()=>act(()=>command('capabilities.cleanup'))}>重试回收环境</button></div>}
      {!state ? <p role="status">正在读取能力…</p> : <>
        <section className="capabilityRow"><div className="capabilityHeading"><h3><FileText size={16}/> Excel · Word · PDF</h3><span>{statuses[state.documents.status]}</span></div>
          <p>在隔离环境中读取、生成与有限编辑。原文件不改动；成果另存为新文件。v{state.documents.version}</p>
          {!state.docker && <p className="error">未找到 Docker。请先配置本机容器运行环境；普通 Agent 任务仍可使用。</p>}
          {state.documents.error && <p className="error" role="alert">{state.documents.error}</p>}
          <details open={state.documents.status === 'not_installed' || state.documents.status === 'failed'}><summary>安装与可选组件</summary>
            <label className="capabilityCheck"><input type="checkbox" checked={office} disabled={busy} onChange={e => setOffice(e.target.checked)}/>文档转 PDF、Excel 公式重算（LibreOffice）</label>
            <label className="capabilityCheck"><input type="checkbox" checked={ocr} disabled={busy} onChange={e => setOcr(e.target.checked)}/>扫描 PDF 识别（中文与英文 OCR）</label>
            <label className="capabilityCheck"><input type="checkbox" checked={installConsent} onChange={e => setInstallConsent(e.target.checked)}/>允许下载并构建官方文件环境；更新后重新确认项目权限。</label>
            <button disabled={busy || !state.docker || !installConsent || state.documents.status === 'installing'} onClick={() => act(() => command('capabilities.install', { office, ocr, acknowledged: true }))}>安装所选组件</button>
          </details>
          {['enabled', 'disabled'].includes(state.documents.status) && <button disabled={busy} onClick={() => act(() => command('capabilities.enable', { enabled: state.documents.status !== 'enabled' }))}>{state.documents.status === 'enabled' ? '停用并撤销授权' : '启用'}</button>}
        </section>
        <section className="capabilityRow"><div className="capabilityHeading"><h3><ShieldCheck size={16}/> {project?.name || '项目授权'}</h3><span>{state.grant?.active ? '已授权隔离文件工具' : '尚未授权'}</span></div>
          {!project ? <p>打开一个项目后设置读取和输出范围。</p> : <>
            {state.grant?.active && <><p>读取：{state.grant.config.reads.join('、') || '不读取原文件'} · 输出：{state.grant.config.output}</p><p>到期：{new Date(state.grant.expires_at).toLocaleString()}</p><button disabled={busy} onClick={() => act(() => command('capabilities.revoke', { projectId: project.id }))}>立即撤销并停止文件工具</button></>}
            <form className="capabilityForm" onSubmit={e => { e.preventDefault(); act(async () => { await command('capabilities.grant', { projectId: project.id, reads: reads.split('\n').map(p => p.trim()).filter(Boolean), output, hours: Number(hours), acknowledged: consent }); setConsent(false); }); }}>
              <label>可读取的项目相对路径（每行一个；留空仅生成文件，. 授权整个项目）<textarea rows={2} value={reads} onChange={e => setReads(e.target.value)}/></label>
              <div className="capabilityColumns"><label>新成果目录<input required value={output} onChange={e => setOutput(e.target.value)}/></label><label>有效小时数<input type="number" min={1} max={720} required value={hours} onChange={e => setHours(e.target.value)}/></label></div>
              <label className="capabilityCheck"><input type="checkbox" checked={consent} required onChange={e => setConsent(e.target.checked)}/>允许当前项目的文件工具在以上范围工作。Agent 的其他原生工具仍使用其自身权限。</label>
              <button type="submit" disabled={busy || state.documents.status !== 'enabled' || Boolean(project.sharing)}>确认文件权限</button>
            </form>
            <button disabled={busy || Boolean(project.sharing)} onClick={() => act(() => command('capabilities.skill', { projectId: project.id }))}>安装文件处理 Skill 到项目</button><p className="capabilityNote">请在确认权限后新建 Agent 会话，保证原生执行器加载工具。解析得到的内容会进入所选 Agent 的模型上下文。</p>
          </>}
        </section>
        {project && state.grant?.active && <section className="capabilityRow"><h3>检查一个实际文件</h3><form className="capabilityForm" onSubmit={e => { e.preventDefault(); act(async () => setResult(await command('documents.call', { projectId: project.id, request: { operation: 'read', path } }))); }}><label>项目相对路径<input required placeholder="Imported/订单.xlsx" value={path} onChange={e => setPath(e.target.value)}/></label><button type="submit" disabled={busy}>{busy ? '正在读取…' : '读取并核对覆盖'}</button></form>{result && <details open><summary>读取结果与覆盖说明</summary><DocumentPreview value={result}/></details>}</section>}
        {state.receipts.length > 0 && <section className="capabilityRow"><h3>最近文件操作</h3>{state.receipts.map(r => <div className="scheduleRun" key={r.id}><span>{new Date(r.created_at).toLocaleString()} · {r.status === 'completed' ? '已完成' : r.status === 'running' ? '正在处理' : '需要检查'}</span>{r.result?.error && <p>{r.result.error}</p>}{r.result?.path && <button onClick={() => act(() => invoke('open_project_file', { projectId: project.id, path: r.result.path }))}>打开 {r.result.path}</button>}</div>)}</section>}
      </>}
    </div>
  </dialog>;
}
