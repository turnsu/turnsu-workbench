import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {openStore} from '../store.mjs';
import {TeamLoops} from '../team-loops.mjs';
import {Check} from '../../contracts/dist/index.js';
import {NATIVE_PRODUCT_TOOLS} from '../../agent-runtime/integrations/native/product-tools.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(), 'turnsu-run-actions-'));let store,loops,actor='owner',denied=false,lose=true;
  const identity={origin:'https://example.test',workspaceId:'team'};
  const receipts=new Map(),calls=[];
  const run={runId:'run-one',requestedByUserId:'owner',status:'waiting_review'};
  const work={async context(){if(denied)throw Object.assign(new Error('revoked'),{status:403});return{viewerUserId:actor,workItem:{status:'ready',members:[]}};}};
  const cloud={identity:async()=>identity,async fileCall(_,name,input){
    assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t=>t.name===name).inputSchema,input),name);calls.push(name);
    if(name==='turnsu_work_results')return{data:[run]};
    if(name==='turnsu_run_details')return{data:{run:{...run,nodeRuns:[{nodeId:'review',nodeRunId:'attempt-two',status:'waiting_review'}]},readModel:{reviewPacket:{nodeId:'review',title:'复核',summary:'看结果',items:['结果'],canRequestChanges:true}}}};
    if(!receipts.has(input.idempotencyKey)){
      if(name==='turnsu_review_run'&&input.data.expectedNodeRunId!=='attempt-two')throw Object.assign(new Error('stale'),{code:'review_stale',status:409});
      receipts.set(input.idempotencyKey,{runId:run.runId});run.status=name==='turnsu_cancel_run'?'cancelled':'completed';
    }
    if(lose){lose=false;throw new Error('lost receipt');}return{data:receipts.get(input.idempotencyKey)};
  }};
  const open=()=>{store=openStore(dir);loops=new TeamLoops({db:store.db,cloud,work});};open();store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project',dir,'Project',Date.now());
  t.after(async()=>{await loops.close();store.close();await rm(dir,{recursive:true,force:true});});
  return{get loops(){return loops;},receipts,calls,scope:{projectId:'project',workItemId:'work',runId:'run-one'},deny(){denied=true;},switchUser(){actor='other';},async reopen(){await loops.close();store.close();open();}};
}
for(const kind of ['cancel','review'])test(`${kind}: lost receipt survives restart without a second decision`,async t=>{
  const f=await fixture(t);const data=kind==='cancel'?{}:{nodeId:'review',expectedNodeRunId:'attempt-two',decision:'approve',requestedChanges:[]};
  const args={...f.scope,requestId:'action',kind,data};
  await assert.rejects(f.loops.actions.submit(args),/尚未确认/);assert.equal(f.receipts.size,1);
  await assert.rejects(f.loops.actions.submit({...args,requestId:'other'}),/核对上次/);
  await assert.rejects(f.loops.actions.submit({...args,data:{...data,comment:'changed'}}));
  const count=f.calls.length;await f.reopen();assert.equal(f.calls.length,count);
  assert.equal((await f.loops.state('project','work')).actions.length,1);
  await f.loops.actions.retry('action');assert.equal(f.receipts.size,1);assert.equal((await f.loops.state('project','work')).actions.length,0);
  f.switchUser();await assert.rejects(f.loops.actions.retry('action'),/发起人/);
});
test('inspection is private to requester and stale review cannot advance execution',async t=>{
  const f=await fixture(t),review=await f.loops.actions.inspect(f.scope);assert.equal(review.review.expectedNodeRunId,'attempt-two');
  await assert.rejects(f.loops.actions.submit({...f.scope,requestId:'stale',kind:'review',data:{nodeId:'review',expectedNodeRunId:'attempt-one',decision:'approve',requestedChanges:[]}}),/复核已变化/);
  await assert.rejects(f.loops.actions.submit({...f.scope,requestId:'missing-attempt',kind:'review',data:{nodeId:'review',decision:'approve',requestedChanges:[]}}),/本轮复核/);
  assert.equal(f.receipts.size,0);assert.equal((await f.loops.state('project','work')).actions.length,0);
  f.switchUser();const count=f.calls.filter(n=>n==='turnsu_run_details').length;await assert.rejects(f.loops.actions.inspect(f.scope),/发起人/);assert.equal(f.calls.filter(n=>n==='turnsu_run_details').length,count);
  f.deny();await assert.rejects(f.loops.actions.retry('stale'),/访问/);
});
