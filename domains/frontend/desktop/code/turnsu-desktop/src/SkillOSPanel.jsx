import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Layers3, RotateCcw, Search } from 'lucide-react';
import { Badge, Button, Input } from './ScaffoldControls.jsx';

const command = (method, args = {}) => invoke('local_command', { method, args });
const agentName = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi' };

export function SkillOSPanel({ project, agents, workSession, onOpen, onReturn }) {
  const [kind, setKind] = useState('skill'), [query, setQuery] = useState('');
  const [local, setLocal] = useState(null), [team, setTeam] = useState({ skill: null, loop: null });
  const [teamPage, setTeamPage] = useState({ skill: null, loop: null });
  const [teamError, setTeamError] = useState({}), [error, setError] = useState('');
  const [selected, setSelected] = useState(null), [detail, setDetail] = useState(null);
  const [agent, setAgent] = useState('codex'), [scope, setScope] = useState('private');
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const intent = useRef(null), detailVersion = useRef(0);

  useEffect(() => {
    if (!project) return;
    let current = true;
    setLocal(null); setTeam({ skill: null, loop: null }); setTeamPage({ skill: null, loop: null });
    setTeamError({}); setSelected(null); setDetail(null); setError(''); intent.current = null; detailVersion.current++;
    command('skills.list', { projectId: project.id })
      .then(value => { if (current) setLocal(value); })
      .catch(e => { if (current) { setLocal({ items: [], truncated: false }); setError(String(e)); } });
    for (const type of ['skill', 'loop']) {
      command(type === 'skill' ? 'methods.list' : 'nativeLoops.list')
        .then(value => { if (current) { setTeam(old => ({ ...old, [type]: value.items })); setTeamPage(old => ({ ...old, [type]: value.page })); } })
        .catch(e => { if (current) { setTeam(old => ({ ...old, [type]: [] })); setTeamError(old => ({ ...old, [type]: String(e) })); } });
    }
    return () => { current = false; };
  }, [project?.id, revision]);

  if (!project) return <section className="skillOSNoProject">
    <BookOpen size={28}/><h2>先打开一个项目</h2><p>Skill OS 会展示这个项目的本机技能和你能访问的团队固定版本。</p>
    <Button variant="primary" onClick={onReturn}>返回工作台</Button>
  </section>;

  const localItems = local?.items || [];
  const teamItems = (team[kind] || []).map(item => {
    const summary = kind === 'skill' ? item.skillSummary : item.loopSummary;
    return { id: `team:${kind}:${item.releaseId}`, kind, source: 'team', status: 'published',
      name: summary?.name || summary?.goal || '团队方法', description: summary?.description || summary?.goal || item.releaseNotes || '',
      releaseId: item.releaseId, version: item.version, summary, original: item };
  });
  const all = [...localItems.filter(item => item.kind === kind), ...teamItems];
  const filtered = all.filter(item => `${item.name} ${item.description} ${agentName[item.agent] || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  async function choose(item) {
    const version = ++detailVersion.current;
    setSelected(item); setDetail(null); setError(''); intent.current = null;
    setAgent(item.agent || agents.find(value => value.installed)?.id || 'codex');
    setScope(workSession ? 'team' : 'private');
    if (item.source !== 'project') return;
    try {
      const value = await command('skills.read', { projectId: project.id, agent: item.agent, path: item.path, expectedHash: item.hash });
      if (detailVersion.current === version) setDetail(value);
    } catch (e) { if (detailVersion.current === version) setError(String(e)); }
  }
  async function more() {
    const page = teamPage[kind];
    if (!page?.hasMore || busy) return;
    setBusy(true); setTeamError(old => ({ ...old, [kind]: '' }));
    try {
      const result = await command(kind === 'skill' ? 'methods.list' : 'nativeLoops.list', { cursor: page.nextCursor });
      setTeam(old => ({ ...old, [kind]: [...new Map([...(old[kind] || []), ...result.items].map(item => [item.releaseId, item])).values()] }));
      setTeamPage(old => ({ ...old, [kind]: result.page }));
    } catch (e) { setTeamError(old => ({ ...old, [kind]: String(e) })); }
    finally { setBusy(false); }
  }
  async function use() {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      const base = selected.source === 'project'
        ? { projectId: project.id, agent: selected.agent, path: selected.path, expectedHash: selected.hash }
        : { projectId: project.id, agent, releaseId: selected.releaseId, ...(scope === 'team' && workSession ? { workItemId: workSession.id } : {}) };
      const key = JSON.stringify(base);
      if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
      const method = selected.source === 'project' ? 'skills.use' : selected.kind === 'loop' ? 'nativeLoops.use' : 'methods.use';
      const session = await command(method, { ...base, requestId: intent.current.requestId });
      await onOpen(session);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const sourceLabel = item => item.source === 'draft' ? '本机草稿' : item.source === 'project' ? '项目技能' : '团队固定版本';
  const actionLabel = selected?.source === 'draft' ? '继续整理' : selected?.source === 'project' ? '在新任务中使用' : scope === 'team' ? '用于当前团队工作' : '用我的 Agent 开始';
  const canUse = selected?.source === 'project' ? !!detail : selected?.source === 'team' && !!agents.find(value => value.id === agent && value.installed);

  return <section className="skillOS">
    <div className="skillOSHeader"><div><span className="skillOSEyebrow">当前项目 · {project.sharing?.title || project.name}</span>
      <h1>Skill OS</h1><p>找到方法，带到真实任务中；只有发送任务才会调用 Agent。</p></div>
      <Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}><RotateCcw size={14}/>刷新目录</Button>
    </div>
    <div className="skillOSKinds" aria-label="方法类型">
      <Button variant={kind === 'skill' ? 'secondary' : 'ghost'} aria-pressed={kind === 'skill'} onClick={() => { setKind('skill'); setSelected(null); setError(''); }}><BookOpen size={15}/>技能</Button>
      <Button variant={kind === 'loop' ? 'secondary' : 'ghost'} aria-pressed={kind === 'loop'} onClick={() => { setKind('loop'); setSelected(null); setError(''); }}><Layers3 size={15}/>可复用流程</Button>
    </div>
    <div className="skillOSBody"><div className="skillOSList">
      <label className="skillOSSearch"><Search size={16}/><Input aria-label="搜索已加载的方法" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索已加载的方法"/></label>
      <p className="skillOSCaption">{kind === 'skill' ? '本机项目技能、成果草稿和团队版本' : '流程草稿与可在本机使用的团队版本'} · 搜索范围仅限已加载内容</p>
      {local === null ? <p className="skillOSMuted">正在读取本机方法…</p> : filtered.length ? <div className="skillOSRows">
        {filtered.map(item => <button key={item.id} className={selected?.id === item.id ? 'selected' : ''} onClick={() => choose(item)}>
          <span className="skillOSRowMain"><strong>{item.name}</strong><small>{item.description}</small></span>
          <span className="skillOSRowMeta"><Badge variant={item.source === 'team' ? 'accent' : 'secondary'}>{sourceLabel(item)}</Badge>
            {item.version && <small>v{item.version}</small>}{item.agent && <small>{agentName[item.agent] || item.agent}</small>}
            <ArrowRight size={14}/></span>
        </button>)}
      </div> : <div className="skillOSEmpty">{query ? '已加载的方法里没有匹配项。' : kind === 'skill' ? '这个项目还没有可用技能。完成一项任务后，可从答复整理为技能。' : '还没有流程。可以从一项完成的任务整理多步骤方法。'}</div>}
      {local?.truncated && <p className="skillOSMuted">本机目录较大，当前只显示每个 Agent 目录的前 100 项。</p>}
      {teamError[kind] && <p className="skillOSMuted">团队版本暂不可读取；本机方法仍可使用。<Button size="sm" onClick={() => setRevision(value => value + 1)}>重试连接</Button></p>}
      {teamPage[kind]?.hasMore && <Button variant="outline" size="sm" disabled={busy} onClick={more}>加载更多团队版本</Button>}
    </div>
    <div className="skillOSDetail">
      {!selected ? <div className="skillOSDetailEmpty"><BookOpen size={23}/><h2>选择一个方法</h2><p>先看用途、来源和执行位置，再决定是否带入新任务。Loop 的复杂依赖编辑在需要时进入原有编辑流程。</p></div> : <>
        <Button size="sm" onClick={() => { setSelected(null); setDetail(null); setError(''); }}><ArrowLeft size={14}/>返回列表</Button>
        <div className="skillOSDetailTitle"><Badge variant={selected.source === 'team' ? 'accent' : 'secondary'}>{sourceLabel(selected)}</Badge>
          <h2>{selected.name}</h2><p>{selected.description}</p></div>
        <dl className="skillOSFacts"><div><dt>执行位置</dt><dd>{selected.source === 'draft' ? '尚未执行' : selected.source === 'team' ? '你的本机 Agent · 团队固定版本' : `当前项目 · ${agentName[selected.agent]}`}</dd></div>
          {selected.version && <div><dt>版本</dt><dd>v{selected.version} · 团队发布</dd></div>}
          {selected.path && <div><dt>文件</dt><dd>{selected.path}</dd></div>}
        </dl>
        {selected.kind === 'loop' && selected.summary?.expectedResult && <p className="skillOSOutcome"><strong>预期结果</strong><br/>{selected.summary.expectedResult}</p>}
        {selected.summary?.inputs?.length > 0 && <p className="skillOSOutcome"><strong>需要提供</strong><br/>{selected.summary.inputs.join('、')}</p>}
        {detail?.content && <details className="skillOSContent"><summary>查看完整技能文件</summary><pre>{detail.content}</pre></details>}
        {selected.source === 'team' && <label className="skillOSAgent">使用我的 Agent
          <select value={agent} disabled={busy} onChange={e => setAgent(e.target.value)}>{agents.map(value => <option key={value.id} value={value.id} disabled={!value.installed}>{value.name}{value.installed ? '' : ' · 未安装'}</option>)}</select>
        </label>}
        {selected.source === 'team' && workSession && <fieldset className="skillOSScope"><legend>这次用于</legend>
          <label><input type="radio" name="skill-os-scope" checked={scope === 'team'} onChange={() => setScope('team')}/>当前团队工作</label>
          <label><input type="radio" name="skill-os-scope" checked={scope === 'private'} onChange={() => setScope('private')}/>独立本机任务</label>
        </fieldset>}
        {selected.source === 'team' && <p className="skillOSMuted">{scope === 'team' && workSession ? '新请求和最终答复会在当前团队工作范围内共享；原生历史仍留在本机。' : '新任务的对话留在本机；已发布方法的版本与依赖固定。'}</p>}
        {selected.source === 'draft' && <p className="skillOSMuted">返回原整理任务，检查草稿后再试做或采用。这里不会自动发布或运行。</p>}
        {error && <p className="inlineError" role="alert">{error}</p>}
        <Button variant="primary" disabled={busy || (selected.source !== 'draft' && !canUse)} onClick={() => selected.source === 'draft' ? onOpen({ project_id: project.id, id: selected.sessionId }) : use()}>{busy ? '正在准备…' : actionLabel}</Button>
        {selected.source !== 'draft' && <p className="skillOSMuted">准备方法不会调用模型；进入工作台确认目标并发送后才会执行。</p>}
      </>}
    </div></div>
  </section>;
}
