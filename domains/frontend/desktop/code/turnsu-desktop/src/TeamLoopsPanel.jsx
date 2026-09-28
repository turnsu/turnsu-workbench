import { invoke } from "./desktop-bridge.mjs";
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Play, RotateCcw, ChevronLeft } from 'lucide-react';
import { LoopRunActions } from './LoopRunActions.jsx';
const command=(method,args)=>invoke('local_command',{method,args});
const labels={queued:'排队中',running:'正在执行',completed:'结果待验收',failed:'执行失败',cancelled:'已取消',cancellation_requested:'正在取消',waiting_review:'等待复核',partial:'部分完成',effect_outcome_unknown:'需要核对外部结果',paused:'已暂停'};
function Answer({children}) { return <ReactMarkdown components={{img:({alt})=><span>[图片：{alt || '未加载'}]</span>,a:({children})=><span>{children}</span>}}>{children}</ReactMarkdown>; }
export function TeamLoopsPanel({projectId,workItem,canRun}) {
  const mounted=useRef(true), reading=useRef(false), operation=useRef(null), choice=useRef(null);
  const [state,setState]=useState(null),[catalog,setCatalog]=useState(null),[page,setPage]=useState(null),[choosing,setChoosing]=useState(false);
  const [prepared,setPrepared]=useState(null),[inputs,setInputs]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saveError,setSaveError]=useState('');
  const scope={projectId,workItemId:workItem.workItemId};
  async function read() {
    if(reading.current) return; reading.current=true;
    try { const next=await command('loops.state',scope); if(mounted.current) setState(next); }
    catch(e) { if(mounted.current) {setState(null);setError(String(e));} }
    finally {reading.current=false;}
  }
  useEffect(()=>{ mounted.current=true; read(); const timer=setInterval(read,5000); return()=>{mounted.current=false;clearInterval(timer);};},[projectId,workItem.workItemId]);
  async function act(fn) {setBusy(true);setError('');try {await fn();}catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy(false);}}
  async function list(cursor) {const result=await command('loops.catalog',{...scope,...(cursor?{cursor}:{})});setCatalog(old=>cursor?[...(old||[]),...result.items]:result.items);setPage(result.page);setChoosing(true);}
  async function select(releaseId,existingId) {
    if(existingId) choice.current={releaseId,id:existingId};
    if(choice.current?.releaseId!==releaseId) choice.current={releaseId,id:crypto.randomUUID()};
    const result=await command('loops.prepare',{...scope,releaseId,requestId:choice.current.id});
    setPrepared(result);setInputs(result.inputs || {});setChoosing(false);operation.current=null;await read();
  }
  function update(key,value) {const next={...inputs};if(value===undefined)delete next[key];else next[key]=value;setInputs(next);setSaveError('');command('loops.draft',{preparationId:prepared.id,inputs:next}).catch(()=>setSaveError('资料尚未保存到本机，请保留输入后重试。'));}
  async function submit() {
    const payload=JSON.stringify({preparationId:prepared.id,inputs});
    if(operation.current?.payload!==payload)operation.current={payload,id:crypto.randomUUID()};
    const result=await command('loops.run',{preparationId:prepared.id,inputs,requestId:operation.current.id});
    if(result.blocked)setError(result.message);else{setPrepared(null);operation.current=null;choice.current=null;}await read();
  }
  async function retry(requestId) {const result=await command('loops.retry',{requestId});if(result.blocked)setError(result.message);else setPrepared(null);await read();}
  const pending=state?.drafts.flatMap(d=>d.attempts.filter(a=>['submitting','unknown'].includes(a.status)).map(a=>({...a,preparationId:d.id})))||[];
  const canStart=canRun&&!['completed','cancelled'].includes(workItem.status);
  const uncertain=prepared&&pending.some(a=>a.preparationId===prepared.id);
  const lastIssue=prepared&&state?.drafts.find(d=>d.id===prepared.id)?.attempts.find(a=>a.status==='blocked')?.error;
  return <section className="teamLoops" aria-label="团队工作流与成果">
    <div className="cloudListHeading"><h3>工作流与成果</h3><button disabled={busy} onClick={()=>act(read)} aria-label="刷新工作流成果"><RotateCcw size={14}/></button></div>
    {(error||lastIssue)&&<p role="alert" className="inlineError">{error||lastIssue}</p>}
    {pending.map(a=><div className="loopPending" key={a.id}><div><span>上次提交尚未确认，核对前不会再次运行。</span><details><summary>查看上次提交的资料</summary>{Object.values(a.inputs).map((value,i)=><pre key={i}>{typeof value==='string'?value:JSON.stringify(value,null,2)}</pre>)}</details></div><button disabled={busy} onClick={()=>act(()=>retry(a.id))}>核对上次提交</button></div>)}
    {prepared?<form onSubmit={e=>{e.preventDefault();act(submit);}}>
      <button type="button" disabled={busy} onClick={()=>setPrepared(null)}><ChevronLeft size={14}/>返回成果</button>
      <h4>{prepared.prepared.workflow.name}</h4><p>{prepared.prepared.revision.definition?.expectedResult}</p>
      <p className="cloudNote">由团队服务运行，使用你的已授权执行配置。本次资料和最终结果对工作成员可见。</p>
      {prepared.prepared.revision.inputForm.fields.map(field=><LoopInput key={field.fieldId} field={field} value={inputs[field.fieldId]} disabled={busy||uncertain} onChange={value=>update(field.fieldId,value)}/>)}
      {saveError&&<p role="alert" className="inlineError">{saveError}</p>}
      <div className="cloudActions"><button className="primary" disabled={busy||uncertain||!canStart} type="submit">{busy?'正在提交…':'运行并共享结果'}</button></div>
    </form>:choosing?<div>
      <button disabled={busy} onClick={()=>setChoosing(false)}><ChevronLeft size={14}/>返回成果</button>
      <div className="cloudProjects">{catalog?.map(release=><button key={release.releaseId} disabled={busy||!canStart} onClick={()=>act(()=>select(release.releaseId))}><span><strong>{release.loopSummary?.goal || '团队工作流'}</strong><small>{release.loopSummary?.expectedResult || release.releaseNotes}</small><small>v{release.version}</small></span></button>)}</div>
      {catalog?.length===0&&<p className="cloudNote">还没有已发布的团队工作流。</p>}
      {page?.hasMore&&<button disabled={busy} onClick={()=>act(()=>list(page.nextCursor))}>加载更多</button>}
    </div>:<>
      {canStart&&<button className="newTeamWork" disabled={busy} onClick={()=>act(()=>list())}><Play size={14}/>使用团队工作流</button>}
      {state?.drafts.filter(d=>!pending.some(a=>a.preparationId===d.id)).map(d=><div className="loopDraft" key={d.id}><span>{d.prepared?.workflow.name || '尚未完成的工作流准备'}</span><button disabled={busy||!canStart} onClick={()=>act(()=>select(d.releaseId,d.id))}>继续准备</button></div>)}
      {state?.runs.map(run=><article className="loopOutcome" key={run.runId}><strong>{run.workflowName}</strong><span role="status">{labels[run.status] || '正在核对状态'}</span><small>{new Date(run.createdAt).toLocaleString()}</small>
        {run.finalAnswer&&<details><summary>查看成果</summary><Answer>{run.finalAnswer.content}</Answer><p className="cloudNote">请核对成果后再决定下一步；执行结束不会自动验收团队工作。</p></details>}
        {run.requestedByUserId===state.viewerUserId&&<LoopRunActions scope={scope} run={run} pending={state.actions?.find(action=>action.runId===run.runId)} onChange={read}/>}
        <details><summary>本次提交的资料</summary>{Object.values(run.inputs).map((value,i)=><pre key={i}>{typeof value==='string'?value:JSON.stringify(value,null,2)}</pre>)}</details>
      </article>)}
      {state&&!state.runs.length&&!state.drafts.length&&<p className="cloudNote">还没有工作流成果。可以使用团队已发布的方法处理这项工作。</p>}
    </>}
  </section>;
}
function LoopInput({field,value,onChange,disabled}) {
  const schema=field.schema||{},[fileName,setFileName]=useState(value?'已保存的资料':''),[error,setError]=useState('');
  const title=field.label+(field.required?'（必填）':'');
  if(schema.enum)return <label className="loopInput">{title}<select required={field.required} disabled={disabled} value={value===undefined?'':String(schema.enum.findIndex(v=>JSON.stringify(v)===JSON.stringify(value)))} onChange={e=>onChange(e.target.value===''?undefined:schema.enum[Number(e.target.value)])}><option value="">请选择</option>{schema.enum.map((v,i)=><option key={i} value={i}>{String(v)}</option>)}</select></label>;
  if(schema.type==='boolean')return <label className="loopInput">{title}<select required={field.required} disabled={disabled} value={value===undefined?'':String(value)} onChange={e=>onChange(e.target.value===''?undefined:e.target.value==='true')}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select></label>;
  if(['number','integer'].includes(schema.type))return <label className="loopInput">{title}<input type="number" required={field.required} disabled={disabled} value={value??''} min={schema.minimum} max={schema.maximum} step={schema.type==='integer'?1:'any'} onChange={e=>onChange(e.target.value===''?undefined:Number(e.target.value))}/></label>;
  if(['object','array'].includes(schema.type))return <label className="loopInput">{title}<input type="file" accept=".json,application/json" disabled={disabled} required={field.required&&value===undefined} onChange={async e=>{const input=e.currentTarget,file=input.files?.[0];if(!file)return;try{if(file.size>200000)throw new Error();const parsed=JSON.parse(await file.text());if((schema.type==='array'&&!Array.isArray(parsed))||(schema.type==='object'&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed))))throw new Error();onChange(parsed);setFileName(file.name);setError('');input.setCustomValidity('');}catch{const message='资料文件格式不符或过大，请选择符合此工作流要求的文件。';setError(message);input.setCustomValidity(message);}}}/><small>{fileName || field.description || '选择保存了所需结构化资料的文件。'}</small>{error&&<small role="alert">{error}</small>}</label>;
  return <label className="loopInput">{title}<textarea required={field.required} disabled={disabled} value={value??''} minLength={schema.minLength} maxLength={schema.maxLength} placeholder={field.description||'粘贴本次要处理的资料'} onChange={e=>onChange(e.target.value)}/></label>;
}
