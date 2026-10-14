import { ManagedAgentSetup } from './ManagedAgentSetup.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, Check, LoaderCircle } from 'lucide-react';
import { Button, Input } from './ScaffoldControls.jsx';
import { invoke } from './desktop-bridge.mjs';
import './capabilities.css';
const nativeIds = ['kimi', 'codex', 'opencode', 'omp', 'pi'];

export function AgentConnectionsDialog({ agents, onClose, onChanged, onTrial, onHosted }) {
  const dialog = useRef(null), alive = useRef(true);
  const [teamForm, setTeamForm] = useState(null);
  const [tab, setTab] = useState('native'), [state, setState] = useState(null), [form, setForm] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function read() { const value = await invoke('agent_connection_list'); if (alive.current) setState(value); }
  useEffect(() => { dialog.current.showModal(); read().catch(e => setError(e.message)); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!['waiting','exchanging'].includes(state?.oauth?.status)) return;
    const timer = setInterval(() => invoke('agent_connection_list').then(value => { if (alive.current) { setState(value); if(value.oauth?.status === 'connected') { setTeamForm(null); setNotice('Team 账号已核验，请在项目中试运行。'); onChanged(); } } }).catch(e => setError(e.message)), 2000);
    return () => clearInterval(timer);
  }, [state?.oauth?.status]);
  function close() { if (!busy) { setForm(null); dialog.current.close(); onClose(); } }
  async function act(name, work) { setBusy(name); setError(''); setNotice(''); try { await work(); } catch (e) { if (alive.current) setError(e.message); } finally { if (alive.current) setBusy(''); } }
  return <dialog ref={dialog} className="connectionDialog" aria-labelledby="agents-title" onCancel={e => { e.preventDefault(); close(); }}>
    <header className="connectionHeader"><div><h2 id="agents-title">连接 Agent</h2><p>使用客户自己的执行器与账号。模型网关在“模型连接”单独配置。</p></div><button disabled={Boolean(busy)} onClick={close} aria-label="关闭 Agent 配置"><X size={18}/></button></header>
    <nav className="agentSetupTabs" aria-label="Agent 类型">{[['native','本机 Agent'],['manus','Manus'],['workbuddy','WorkBuddy'],['muse','Muse']].map(([id,name]) => <button key={id} aria-pressed={tab === id} disabled={Boolean(busy)} onClick={() => { setTab(id); setForm(null); setTeamForm(null); setError(''); setNotice(''); }}>{name}</button>)}</nav>
    <div className="connectionBody">
      {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
      {tab === 'native' && <><p>① 检查本机安装　② 在原生 Agent 登录　③ 核对权限　④ 在项目中试运行</p>
        {nativeIds.map(id => agents.find(a => a.id === id)).filter(Boolean).map(agent => <section className="savedConnection" key={agent.id}><div><strong>{agent.name}</strong><span>{agent.installed ? '已找到执行器 · 登录与实际执行仍需试运行验证' : '尚未找到执行器，请按官方指引安装并登录'}</span></div><div className="connectionActions"><button disabled={Boolean(busy)} onClick={() => act('guide', () => invoke('open_agent_guide', { agent: agent.id }))}>官方配置<ExternalLink size={13}/></button><button disabled={!agent.installed || Boolean(busy) || !onTrial} onClick={() => onTrial(agent.id)}>试运行</button></div></section>)}
        <p className="connectionHelp">工作台工具按项目授权。原生 Agent 自带的 Shell、浏览器与扩展仍受它自己的权限控制。Claude Code 保留适配，本轮暂缓真实测试。</p><Button variant="outline" disabled={Boolean(busy)} onClick={() => act('check', onChanged)}>重新检查环境</Button></>}
      {tab === 'manus' && <><p>连接官方 API v2。密钥由系统凭据库保护；保存前会读取账号身份。普通 OAuth 应用只适用于同 Team 客户。</p>{state?.error && <p className="error">{state.error}</p>}
        {!state && <p role="status">读取系统凭据…</p>}
        {!form && state && <>{state.connections.filter(c => c.provider === 'manus').map(c => <section className="savedConnection" key={c.id}><div><strong>{c.name}</strong><span><Check size={13}/>{c.revoked ? "工作台凭据已撤销 · 原生服务密钥需在该服务自行吊销" : "账号已核验 · 真实任务待试运行"}</span></div><div className="connectionActions"><button disabled={Boolean(busy)} onClick={() => act('check', async () => { await invoke('agent_connection_check', { id: c.id }); setNotice('当前密钥仍可读取账号身份；这不代表任务执行已通过。'); })}>检查连接</button><button disabled={Boolean(busy)} onClick={() => c.mode === 'oauth_pkce' ? setTeamForm(c) : setForm({ ...c, apiKey: '', revoked: false })}>{c.mode === 'oauth_pkce' ? '重新授权' : '更新密钥'}</button><button disabled={Boolean(busy)} onClick={() => act('remove', async () => { const result=await invoke('agent_connection_remove', { id: c.id }); setState(result); if(result.revokeNotice)setNotice(result.revokeNotice); await onChanged(); })}>撤销凭据</button><button disabled={c.revoked || !onTrial || Boolean(busy)} onClick={() => onTrial('manus', c.id)}>试运行</button></div></section>)}<Button disabled={Boolean(busy) || Boolean(state.error)} onClick={() => setForm({ provider: 'manus', mode: 'api_key', name: '我的 Manus', apiKey: '' })}>添加 Manus 账号</Button> <Button variant="outline" disabled={Boolean(busy) || Boolean(state.error)} onClick={() => { setForm(null); setTeamForm({ name: '我的 Manus Team', clientId: '', redirectUri: 'http://127.0.0.1:43859/manus/callback' }); }}>连接同 Team 账号</Button></>}
        {form && <form className="connectionForm" onSubmit={event => { event.preventDefault(); act('save', async () => { setState(await invoke('agent_connection_save', form)); setForm(null); await onChanged(); setNotice('账号检查通过。下一步选择项目材料并试运行。'); }); }}>
          <label>连接名称<Input required maxLength={80} disabled={Boolean(busy)} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
          <label>Manus API Key<Input type="password" autoComplete="new-password" required={!form.id} disabled={Boolean(busy)} placeholder={form.id ? '留空保留原密钥' : '在 Manus 账号设置中创建'} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })}/></label>
          <div className="connectionFormActions"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => setForm(null)}>取消</Button><Button type="submit" disabled={Boolean(busy)}>{busy ? <><LoaderCircle size={15} className="spin"/>检查并保存…</> : '检查账号并保存'}</Button></div>
        </form>}
        {teamForm && <form className="connectionForm" onSubmit={event => { event.preventDefault(); act('authorize', async () => { const oauth=await invoke('manus_authorize', teamForm); setState(current => ({...current,oauth})); }); }}>
          <p>由客户的 Team 管理员创建标准 Open App，仅配置 create_task 权限。以下回调地址须与 Manus 登记值完全一致。个人账号请使用 API Key。</p>
          <label>连接名称<Input required maxLength={80} value={teamForm.name} onChange={e=>setTeamForm({...teamForm,name:e.target.value})}/></label>
          <label>Team 应用 Client ID<Input required maxLength={200} disabled={Boolean(teamForm.id)} value={teamForm.clientId} onChange={e=>setTeamForm({...teamForm,clientId:e.target.value})}/></label>
          <label>已登记的本机回调地址<Input required value={teamForm.redirectUri} onChange={e=>setTeamForm({...teamForm,redirectUri:e.target.value})}/></label>
          <div className="connectionFormActions"><Button type="button" variant="ghost" onClick={()=>setTeamForm(null)}>收起</Button><Button type="submit" disabled={Boolean(busy)||['waiting','exchanging'].includes(state?.oauth?.status)}>打开浏览器授权</Button></div>
        </form>}
        {['waiting','exchanging'].includes(state?.oauth?.status) && <p role="status">{state.oauth.status==='waiting'?'等待浏览器授权…':'正在检查账号并保存…'} <button onClick={()=>act('cancel',async()=>{const oauth=await invoke('manus_authorize_cancel');setState(current=>({...current,oauth}));})}>取消授权</button></p>}
        {state?.oauth?.error && <p role="alert" className="error">{state.oauth.error}</p>}
        <p className="connectionHelp">每次外发前明确选择材料。任务在 Manus 云端运行；其原有连接器权限由 Manus 管理。工作台不会上传整个本地项目。</p></>}
      {['workbuddy','muse'].includes(tab) && <><h3>{tab === 'workbuddy' ? '通过 Turnsu 授权 WorkBuddy' : '连接 Muse 任务收件箱'}</h3><p>{tab === 'workbuddy' ? '连接 Turnsu 接入服务后，在浏览器授权本地助理读取和调用权限。云端任务需要另外授权；手机号和积分不在默认权限中。' : '连接 Turnsu 接入服务后，把专属收件箱配置为 Muse 连接器。发送任务后显示“等待 Muse 接手”，首次接手由你在 Muse 确认。'}</p><p className="connectionHelp">{tab === 'workbuddy' ? '本地助理接口不能承诺独立项目会话、目录绑定或停止。' : 'Muse 可回传结果并提出本机操作请求；本机操作需要在工作台逐次授权。撤销交接不保证终止 Muse 已发起的外部动作。'}</p><ManagedAgentSetup provider={tab} onChanged={onChanged} onConnectService={() => onHosted(tab)} onTrial={onTrial}/><p><button onClick={() => act('guide', () => invoke('open_agent_guide', { agent: tab }))}>查看官方接入说明<ExternalLink size={13}/></button></p></>}
    </div><footer className="connectionFooter">连接账号、授予工具权限和验证任务成果是三个独立步骤。</footer>
  </dialog>;
}
