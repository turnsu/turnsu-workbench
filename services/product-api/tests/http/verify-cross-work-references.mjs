import assert from 'node:assert/strict';

export async function verifyCrossWorkReferences({owner,member,memberUserId,pool}) {
  const call=(client,name,input={})=>client.session.product.call(name,input);
  const project=await owner.session.desktop.call('createProject',{idempotencyKey:'cross-work-project',data:{title:'Cross work references',objective:'Reuse shared results within their audience',members:[{userId:memberUserId}]}});
  const members=[{userId:memberUserId,access:'contribute',roles:['participant']}];
  const create=async(key,projectId=project.data.projectId)=>(await call(owner,'turnsu_create_work',{idempotencyKey:key,data:{projectId,title:key,objective:'Review exact shared sources',summary:'Shared team work',members}})).data.workItemId;
  const source=await create('cross-work-source'),target=await create('cross-work-target');
  const entry=await call(member,'turnsu_submit_update',{pathParams:{workItemId:source},idempotencyKey:'cross-work-source-entry',data:{content:'A fixed result from a different Work Item'}});
  const decision=await call(owner,'turnsu_record_decision',{pathParams:{workItemId:source},idempotencyKey:'cross-work-source-decision',data:{question:'Which evidence?',options:['Keep sources'],chosenOutcome:'Keep sources',rationale:'Allow checking the result'}});
  const reads=(client,targetId=target)=>[
    ()=>call(client,'turnsu_work_context',{pathParams:{workItemId:source},query:{targetWorkItemId:targetId}}),
    ()=>call(client,'turnsu_work_updates',{pathParams:{workItemId:source},query:{targetWorkItemId:targetId,limit:20,order:'desc'}}),
    ()=>call(client,'turnsu_work_entry',{pathParams:{workItemId:source,entryId:entry.data.entryId},query:{targetWorkItemId:targetId}}),
  ];
  const [context,updates,fixed]=await Promise.all(reads(member).map(read=>read()));
  assert.ok(context.data.decisions.some(value=>value.decisionId===decision.data.decisionId));
  assert.ok(updates.data.some(value=>value.entryId===entry.data.entryId));assert.deepEqual(fixed.data,entry.data);
  assert.deepEqual((await call(member,'turnsu_work_entry',{pathParams:{workItemId:source,entryId:entry.data.entryId}})).data,entry.data,'legacy read unchanged');
  const sharedInput={pathParams:{workItemId:target},idempotencyKey:'cross-work-derived-result',data:{content:'Derived from the chosen source',sourceWorkItemIds:[source]}};
  const shared=await call(member,'turnsu_submit_update',sharedInput);
  assert.deepEqual((await call(member,'turnsu_submit_update',sharedInput)).data,shared.data);
  const otherProject=await owner.session.desktop.call('createProject',{idempotencyKey:'cross-work-other-project',data:{title:'Other project',objective:'No cross project transfer',members:[{userId:memberUserId}]}});
  const other=await create('cross-work-other-target',otherProject.data.projectId);
  for(const read of reads(member,other))await assert.rejects(read,error=>error.code==='work_item_reference_project_mismatch'&&error.status===409);
  await assert.rejects(call(member,'turnsu_submit_update',{...sharedInput,pathParams:{workItemId:other},idempotencyKey:'cross-work-foreign-write'}),error=>error.code==='work_item_reference_project_mismatch');
  const revise=async(workItemId,next,key)=>{
    const before=await call(owner,'turnsu_work_context',{pathParams:{workItemId}});
    return call(owner,'turnsu_update_work',{pathParams:{workItemId},ifMatch:before.etag,idempotencyKey:key,data:{members:next}});
  };
  // The actor still sees both works, but the target's additional reader must not receive source data.
  await revise(source,[],'cross-work-narrow-source');
  for(const read of reads(owner))await assert.rejects(read,error=>error.code==='work_item_reference_audience_forbidden'&&error.status===403);
  for(const read of reads(member))await assert.rejects(read,error=>error.status===404);
  assert.equal((await call(member,'turnsu_work_context',{pathParams:{workItemId:target}})).data.workItem.workItemId,target);
  await assert.rejects(call(member,'turnsu_submit_update',sharedInput),error=>error.status===404,'old shared receipt cannot bypass source revocation');
  await assert.rejects(call(owner,'turnsu_submit_update',{...sharedInput,idempotencyKey:'cross-work-queued-wide'}),error=>error.code==='work_item_reference_audience_forbidden');
  await revise(target,[],'cross-work-narrow-target');
  await Promise.all(reads(owner).map(read=>read()));
  const narrow={...sharedInput,idempotencyKey:'cross-work-owner-derived'};
  await call(owner,'turnsu_submit_update',narrow);
  // A later target audience change invalidates both a queued mutation and a saved receipt.
  await revise(target,members,'cross-work-expand-target');
  await assert.rejects(call(owner,'turnsu_submit_update',narrow),error=>error.code==='work_item_reference_audience_forbidden');
  await assert.rejects(call(owner,'turnsu_submit_update',{...narrow,idempotencyKey:'cross-work-late-output'}),error=>error.code==='work_item_reference_audience_forbidden');
  await revise(source,members,'cross-work-source-reshare');
  await Promise.all(reads(member).map(read=>read()));
  assert.deepEqual((await call(member,'turnsu_submit_update',sharedInput)).data,shared.data);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_thread_entries WHERE work_item_id=$1 AND entry_kind='comment'",[target])).rows[0].n,2,'denied/retried writes never publish another result');
}
