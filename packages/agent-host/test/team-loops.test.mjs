import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { openStore } from '../store.mjs';
import { TeamLoops } from '../team-loops.mjs';
import { Check } from '../../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../../agent-runtime/integrations/native/product-tools.mjs';

async function fixture(t) {
  const dir=await mkdtemp('/private/tmp/turnsu-team-loops-');let store,loops,actor='member',denied=false,ready=false,loseCopy=true,loseRun=true;
  const copies=new Map(),runs=new Map(),calls=[];
  const identity={origin:'https://example.test',workspaceId:'workspace',clientSessionId:'client'};
  const prepared={workflow:{workflowId:'workflow-one',name:'团队反馈',sourceRelease:{releaseId:'release-one'}},revision:{revisionId:'revision-one',resourceRefs:[],inputForm:{fields:[{fieldId:'goal',label:'目标',schema:{type:'string'},required:true}]}}};
  const work={context:async()=>{if(denied)throw Object.assign(new Error('forbidden'),{status:403});return{viewerUserId:actor,workItem:{title:'团队工作',status:'ready',members:[{userId:actor,accessGrant:{status:'active',access:'contribute'}}]}};}};
  const cloud={identity:async()=>identity,fileCall:async(binding,name,input)=>{
    assert.deepEqual(binding,identity);assert.ok(Check(NATIVE_PRODUCT_TOOLS.find(t=>t.name===name).inputSchema,input),name);calls.push(name);
    if(name==='turnsu_methods')return{data:[{releaseId:'release-one',assetKind:'loop'},{releaseId:'native-release',assetKind:'loop',executionMode:'native_agent'}],page:{hasMore:false}};
    if(name==='turnsu_prepare_loop'){if(!copies.has(input.idempotencyKey))copies.set(input.idempotencyKey,prepared);if(loseCopy){loseCopy=false;throw new Error('lost copy receipt');}return{data:copies.get(input.idempotencyKey)};}
    if(name==='turnsu_compile_loop')return{data:{status:ready?'ready':'blocked',warnings:[]}};
    if(name==='turnsu_run_loop'){if(!runs.has(input.idempotencyKey))runs.set(input.idempotencyKey,{runId:'run-one',workItemId:'work-one'});if(loseRun){loseRun=false;throw new Error('lost run receipt');}return{data:runs.get(input.idempotencyKey)};}
    if(name==='turnsu_work_results')return{data:[]};throw new Error(name);
  }};
  const open=()=>{store=openStore(dir);loops=new TeamLoops({db:store.db,cloud,work});};open();store.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project',dir,'Project',Date.now());
  t.after(async()=>{await loops.close();store.close();await rm(dir,{recursive:true,force:true});});
  return{get loops(){return loops;},copies,runs,calls,choose:{projectId:'project',workItemId:'work-one',releaseId:'release-one',requestId:'copy-one'},ready(){ready=true;},deny(){denied=true;},switchUser(){actor='other';},async reopen(){await loops.close();store.close();open();}};
}

test('workflow preparation and uncertain run recover after restart without duplicate execution',async t=>{
  const f=await fixture(t);assert.deepEqual((await f.loops.catalog('project','work-one')).items.map(i=>i.releaseId),['release-one']);await assert.rejects(f.loops.prepare(f.choose),/提交记录/);await f.reopen();
  const prepared=await f.loops.prepare(f.choose);assert.equal(f.copies.size,1);assert.equal(prepared.prepared.workflow.name,'团队反馈');
  f.loops.draft(prepared.id,{goal:'保留输入'});await f.reopen();assert.equal((await f.loops.state('project','work-one')).drafts[0].inputs.goal,'保留输入');
  const args={preparationId:prepared.id,inputs:{goal:'保留输入'},requestId:'run-request'};
  assert.equal((await f.loops.run(args)).blocked,true);assert.equal(f.runs.size,0);
  f.ready();await assert.rejects(f.loops.run(args),/提交记录/);assert.equal(f.runs.size,1);
  await assert.rejects(f.loops.run({...args,requestId:'another-run'}),/上次提交尚未确认/);
  await assert.rejects(f.loops.run({...args,inputs:{goal:'changed'}}),/同一运行请求/);
  const before=f.calls.filter(c=>c==='turnsu_run_loop').length;await f.reopen();assert.equal(f.calls.filter(c=>c==='turnsu_run_loop').length,before,'reopening never dispatches a model or workflow');
  assert.equal((await f.loops.retry('run-request')).runId,'run-one');assert.equal(f.runs.size,1);
  assert.equal((await f.loops.run(args)).runId,'run-one');assert.equal((await f.loops.state('project','work-one')).drafts.length,0);
});

test('old preparation cannot be used by another account or after losing Work Item access',async t=>{
  const f=await fixture(t);await assert.rejects(f.loops.prepare(f.choose));await f.loops.prepare(f.choose);f.switchUser();
  await assert.rejects(f.loops.run({preparationId:'copy-one',inputs:{goal:'not mine'},requestId:'other-request'}),/切回/);assert.equal(f.runs.size,0);
  f.deny();await assert.rejects(f.loops.state('project','work-one'),/访问/);
});

test('simultaneous reuse of a preparation key cannot select a different release',async t=>{
  const f=await fixture(t);const first=f.loops.prepare(f.choose);await assert.rejects(f.loops.prepare({...f.choose,releaseId:'different-release'}),/同一请求/);await assert.rejects(first);assert.equal(f.copies.size,1);
});
