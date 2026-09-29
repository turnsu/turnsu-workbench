import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, ExternalLink, LoaderCircle, Check } from 'lucide-react';
import { invoke } from './desktop-bridge.mjs';
import { Button, Input } from './ScaffoldControls.jsx';

const protocolLabels = { responses: 'Responses · Codex / Pi', messages: 'Messages · Claude Code / Pi', chat: 'Chat Completions · Pi' };
const blank = () => ({ name: 'Turnsu 网关', baseUrl: 'https://gateway.turnsu.org/v1', protocol: 'responses', apiKey: '' });

export function ModelConnectionsDialog({ onClose, onChanged }) {
  const dialog = useRef(null), alive = useRef(true);
  const [state, setState] = useState(null), [form, setForm] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [checks, setChecks] = useState({});
  async function read() { const next = await invoke('connection_list'); if (alive.current) setState(next); }
  useEffect(() => { alive.current = true; dialog.current.showModal(); read().catch(e => setError(String(e))); return () => { alive.current = false; }; }, []);
  function close() { if (busy) return; setForm(null); dialog.current.close(); onClose(); }
  async function act(key, action) {
    if (busy) return;
    setBusy(key); setError('');
    try { await action(); } catch (e) { if (alive.current) setError(String(e).replace(/^Error: /, '')); }
    finally { if (alive.current) setBusy(''); }
  }
  async function save(event) {
    event.preventDefault();
    await act('save', async () => { const next = await invoke('connection_save', form); setState(next); setForm(null); setChecks({}); await onChanged(); });
  }
  function change(key, value) { setForm(current => ({ ...current, [key]: value })); }
  return <dialog ref={dialog} className="connectionDialog" aria-labelledby="connection-title" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="connectionHeader"><div><h2 id="connection-title">模型连接</h2><p>为工作台接入公司网关或自己的模型服务。</p></div><button aria-label="关闭模型连接" disabled={Boolean(busy)} onClick={close}><X size={18}/></button></div>
    <div className="connectionBody">
      {!form && <div className="nativeConnection"><Check size={17}/><div><strong>跟随原生 Agent</strong><p>默认使用 Codex、Claude Code 或 Pi 的已有账号与配置。</p></div><span>默认</span></div>}
      {error && <p className="error" role="alert">{error}{!form && <button onClick={() => act('read', read)} disabled={Boolean(busy)}>重新读取</button>}</p>}
      {!state ? (!error && <p className="connectionStatus" role="status"><LoaderCircle className="spin" size={16}/>正在读取本机连接…</p>) : <>
        {state.error && <p className="error" role="alert">{state.error}</p>}
        {state.encryptionAvailable === false && <p className="error" role="alert">系统密钥保护不可用，请先解锁系统。原生 Agent 仍可使用。</p>}
        {!form && <><div className="connectionSectionHeading"><h3>已保存的连接</h3><Button variant="ghost" disabled={Boolean(busy) || state.encryptionAvailable === false || Boolean(state.error)} onClick={() => { setForm(blank()); setError(''); }}><Plus size={15}/>添加连接</Button></div>
        {!state.connections.length && !form && <div className="connectionEmpty"><strong>还没有添加模型连接</strong><p>添加后，在新任务中选择连接和模型。已有会话继续使用原配置。</p><Button variant="outline" disabled={state.encryptionAvailable === false || Boolean(state.error)} onClick={() => setForm(blank())}>接入 Turnsu 网关</Button></div>}
        {state.connections.map(connection => <section className="savedConnection" key={connection.id}>
          <div><strong>{connection.name}</strong><span>{protocolLabels[connection.protocol]}</span><code>{connection.baseUrl}</code></div>
          <div className="connectionActions"><button disabled={Boolean(busy)} onClick={() => act(connection.id, async () => { setChecks(current => ({ ...current, [connection.id]: null })); const result = await invoke('connection_check', { id: connection.id }); setChecks(current => ({ ...current, [connection.id]: result.models })); })}>{busy === connection.id ? '读取模型…' : '检查连接'}</button><button disabled={Boolean(busy)} onClick={() => { setForm({ ...connection, apiKey: '' }); setError(''); }}>编辑</button><button disabled={Boolean(busy)} onClick={() => act('remove', async () => { const next = await invoke('connection_remove', { id: connection.id }); setState(next); await onChanged(); })}>移除</button></div>
          {checks[connection.id] && <details className="connectionCheck"><summary>可读取 {checks[connection.id].length} 个模型 · 尚未验证推理</summary><p>{checks[connection.id].slice(0, 20).map(m => m.name).join('、')}{checks[connection.id].length > 20 ? '…' : ''}</p></details>}
        </section>)}
        </>}
      </>}
      {form && <form className="connectionForm" onSubmit={save}>
        <h3>{form.id ? '编辑模型连接' : '添加模型连接'}</h3>
        <label>连接名称<Input autoFocus required maxLength={60} disabled={Boolean(busy)} value={form.name} onChange={e => change('name', e.target.value)}/></label>
        <label>API 地址<Input required type="url" placeholder="https://gateway.turnsu.org/v1" disabled={Boolean(busy) || Boolean(form.id)} value={form.baseUrl} onChange={e => change('baseUrl', e.target.value)} spellCheck={false}/></label>
        <label>接口协议<select disabled={Boolean(busy) || Boolean(form.id)} value={form.protocol} onChange={e => change('protocol', e.target.value)}>{Object.entries(protocolLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>API Key<Input type="password" autoComplete="new-password" spellCheck={false} required={!form.id} disabled={Boolean(busy)} value={form.apiKey} placeholder={form.id ? '留空保留已保存的密钥' : '粘贴你的网关令牌'} onChange={e => change('apiKey', e.target.value)}/></label>
        <p className="connectionHelp">密钥受系统保护，仅保存在这台电脑。{form.id ? '修改地址或协议请添加新连接；更换密钥前请结束相关任务。' : '保存后可检查模型目录；真正发送任务时才调用所选模型。'}</p>
        <p className="connectionHelp">在 Pi 中使用时，兼容连接暂按 32K 上下文、4K 输出运行；实际费用以网关为准。</p>
        <div className="connectionFormActions"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => setForm(null)}>取消</Button><Button type="submit" disabled={Boolean(busy)}>{busy === 'save' ? '正在保存…' : '保存连接'}</Button></div>
      </form>}
    </div>
    <footer className="connectionFooter"><span>连接只在新任务中明确选用，不修改 Agent 全局设置。</span><button disabled={Boolean(busy)} onClick={() => act('gateway', () => invoke('open_gateway'))}>在网关管理令牌<ExternalLink size={13}/></button></footer>
  </dialog>;
}
