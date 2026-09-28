import { invoke } from "./desktop-bridge.mjs";
import React, { useRef, useState } from 'react';
const command=(method,args)=>invoke('local_command',{method,args});
const actionLabel=data=>({approve:'通过复核',revise:'要求修改',reject:'不通过并结束'})[data?.decision];

export function LoopRunActions({scope,run,pending,onChange}) {
  const [review,setReview]=useState(null),[history,setHistory]=useState(null),[olderRounds,setOlderRounds]=useState(0);
  const [note,setNote]=useState(''),[confirmCancel,setConfirmCancel]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=useRef(null),lock=useRef(false);
  const active=['queued','running','waiting_review','paused'].includes(run.status);
  async function act(fn){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{try{await onChange();}catch(e){setError(String(e));}finally{lock.current=false;setBusy(false);}}}
  async function inspect({afterAction=false}={}){
    const value=await command('loops.inspect',{...scope,runId:run.runId});
    setReview(value.review);setHistory(value.rounds);setOlderRounds(value.olderRounds);setNote('');key.current=null;
    if(!afterAction&&run.status==='waiting_review'&&!value.review)setError('当前没有待复核内容，请查看最新运行状态。');
  }
  async function submit(kind,decision){
    const data=kind==='cancel'?{}:{nodeId:review.nodeId,expectedNodeRunId:review.expectedNodeRunId,decision,comment:decision==='revise'?'':note.trim(),requestedChanges:decision==='revise'?[note.trim()]:[]};
    const payload=JSON.stringify({kind,data});if(key.current?.payload!==payload)key.current={payload,id:crypto.randomUUID()};
    await command('loops.action',{...scope,runId:run.runId,requestId:key.current.id,kind,data});
    key.current=null;setReview(null);setConfirmCancel(false);setNote('');await inspect({afterAction:true});
  }
  return <div className="loopRunActions">
    {error&&<p role="alert" className="inlineError">{error}</p>}
    {pending?<div className="loopPending"><div><strong>{pending.kind==='cancel'?'取消运行':actionLabel(pending.data)}：结果尚未确认</strong><p>将核对原操作，不会提交新的决定。</p>{pending.data?.comment&&<p>{pending.data.comment}</p>}{pending.data?.requestedChanges?.map((change,index)=><p key={index}>{change}</p>)}</div><button disabled={busy} onClick={()=>act(async()=>{await command('loops.retryAction',{requestId:pending.id});setReview(null);setConfirmCancel(false);await inspect({afterAction:true});})}>核对上次操作</button></div>:<>
      <button disabled={busy} onClick={()=>act(inspect)}>{run.status==='waiting_review'?(review?'重新读取复核内容':'查看并复核'):'查看复核记录'}</button>
      {run.status==='waiting_review'&&review&&<div className="loopReview"><h4>{review.title}</h4><p>{review.summary}</p><ul>{review.items.map((item,index)=><li key={index}>{item}</li>)}</ul>
        <p className="cloudNote">{review.contentTruncated?'内容过长，当前未显示完整内容，无法直接批准。请要求缩小内容后重新复核。':'通过后会继续运行后续步骤；团队工作的最终验收仍由负责人决定。'}</p>
        <label className="loopInput">复核意见<textarea maxLength={1000} disabled={busy} value={note} onChange={e=>setNote(e.target.value)} placeholder={review.canRequestChanges?'说明哪里需要改，例如：补充每项建议的依据。':'可选，记录本次判断的理由。'}/></label>
        {review.canRequestChanges&&<p className="cloudNote">要求修改会按本次运行的配置和额度重做对应步骤，再交给你复核。</p>}
        <div className="cloudActions"><button disabled={busy} onClick={()=>act(()=>submit('review','reject'))}>不通过并结束</button>{review.canRequestChanges&&<button disabled={busy||!note.trim()} onClick={()=>act(()=>submit('review','revise'))}>修改后再复核</button>}<button className="primary" disabled={busy||review.contentTruncated} onClick={()=>act(()=>submit('review','approve'))}>通过并继续</button></div>
      </div>}
      {active&&run.status!=='waiting_review'&&(confirmCancel?<div className="loopPending"><p>取消后将停止后续步骤，已完成的外部操作不会撤销。</p><button disabled={busy} onClick={()=>setConfirmCancel(false)}>继续运行</button><button disabled={busy} onClick={()=>act(()=>submit('cancel'))}>确认取消</button></div>:<button disabled={busy} onClick={()=>setConfirmCancel(true)}>取消运行</button>)}
    </>}
    {history&&<div className="loopReviewHistory">
      {history.filter(round=>round.decision).map(round=><details key={round.reviewId}><summary>{round.packet.title} · 第 {round.attempt} 轮 · {actionLabel(round.decision)}</summary><small>{new Date(round.requestedAt).toLocaleString()}</small><ul>{round.packet.items.map((item,index)=><li key={index}>{item}</li>)}</ul>{round.packet.contentTruncated&&<p className="cloudNote">这轮内容超过显示上限。</p>}{round.decision.comment&&<p>意见：{round.decision.comment}</p>}{round.decision.requestedChanges.map((change,index)=><p key={index}>修改要求：{change}</p>)}</details>)}
      {!history.length&&<p className="cloudNote">这次运行还没有复核记录。</p>}
      {olderRounds>0&&<p className="cloudNote">当前显示最近 10 轮；更早的 {olderRounds} 轮记录已保留。</p>}
    </div>}
  </div>;
}
