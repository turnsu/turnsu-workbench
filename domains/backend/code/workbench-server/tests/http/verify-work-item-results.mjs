import assert from 'node:assert/strict';
export async function verifyWorkItemResults({origin,pool,ownerHeaders,memberHeaders,projectId,memberUserId,revisionId,nativeMember}) {
 const call=async(path,{method='GET',data,headers=ownerHeaders,key,etag}={})=>{
   const response=await fetch(origin+'/api/workbench/v1'+path,{method,headers:{...headers,Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...(etag?{'If-Match':etag}:{})},...(data?{body:JSON.stringify({schemaVersion:'workbench-api-v1',data})}:{})});
   return {status:response.status,cacheControl:response.headers.get('cache-control'),etag:response.headers.get('etag'),body:await response.json()};
 };
 const create=async(key)=>{const value=await call('/work-items',{method:'POST',key,data:{projectId,title:'Review a fixed team result',objective:'Owner checks the actual shared result',summary:'Keep fixed content and feedback',members:[{userId:memberUserId,access:'contribute',roles:['participant']}]}});assert.equal(value.status,201,JSON.stringify(value.body));return value.body.data.workItemId;};
 const id=await create('result-work'),otherId=await create('result-other-work'),base=`/work-items/${id}`;
 const comment=async(workId,text,key,headers=memberHeaders)=>{const value=await call(`/work-items/${workId}/thread-entries`,{method:'POST',headers,key,data:{content:text,fileRevisionIds:[revisionId]}});assert.equal(value.status,201,JSON.stringify(value.body));return value.body.data;};
 const first=await comment(id,'固定成果第一版：保持已声明资料的引用。','result-entry-one');
 const foreign=await comment(otherId,'另一项工作的内容不能提交','result-foreign-entry');
 const ownOwner=await comment(id,'负责人的另一份内容','result-owner-entry',ownerHeaders);
 const entryPath=`${base}/thread-entries/${first.entryId}`;
 const entryRead=await call(entryPath,{headers:memberHeaders});assert.equal(entryRead.status,200,JSON.stringify(entryRead.body));assert.deepEqual(entryRead.body.data,first);assert.equal(entryRead.body.data.fileReferences.length,1);assert.equal(entryRead.body.data.contentHash,first.contentHash);assert.equal(entryRead.body.data.createdByUserId,memberUserId);assert.equal(entryRead.cacheControl,'no-store');
 const nativeRead=await nativeMember.fileCall(await nativeMember.identity(),'turnsu_work_entry',{pathParams:{workItemId:id,entryId:first.entryId}});assert.deepEqual(nativeRead.data,first);
 assert.equal((await call(`${base}/thread-entries/${foreign.entryId}`,{headers:memberHeaders})).status,404);
 assert.equal((await call(`${base}/thread-entries/absent-entry`,{headers:memberHeaders})).status,404);
 const decision=await call(`${base}/decisions`,{method:'POST',key:'entry-read-decision',data:{question:'接受哪种整理方式？',options:['保留证据'],chosenOutcome:'保留证据',rationale:'便于核对来源'}});assert.equal(decision.status,201,JSON.stringify(decision.body));
 const thread=await call(`${base}/thread-entries`,{headers:memberHeaders});const decisionEntry=thread.body.data.find(entry=>entry.decisionId===decision.body.data.decisionId);assert.ok(decisionEntry);
 assert.deepEqual((await call(`${base}/thread-entries/${decisionEntry.entryId}`,{headers:memberHeaders})).body.data,decisionEntry);
 const before=await call(base);assert.deepEqual(before.body.data.resultReview,{currentSubmission:null,history:[]});
 const submit=(entry,key,etag=before.etag,headers=memberHeaders)=>call(`${base}/results`,{method:'POST',key,etag,headers,data:{entryId:entry.entryId,contentHash:entry.contentHash,confirm:true}});
 assert.equal((await submit(foreign,'result-foreign')).status,409);
 assert.equal((await submit(ownOwner,'result-steal')).status,409);
 assert.equal((await submit({...first,contentHash:'sha256:'+'0'.repeat(64)},'result-wrong-hash')).status,409);
 const submitted=await submit(first,'result-submit');assert.equal(submitted.status,200,JSON.stringify(submitted.body));assert.equal(submitted.body.data.workItem.status,'waiting_review');
 const pending=submitted.body.data.resultReview.currentSubmission;
 assert.deepEqual(pending.entry,first);assert.equal(pending.status,'pending');assert.deepEqual((await submit(first,'result-submit')).body.data,submitted.body.data);
 assert.equal((await submit(first,'result-submit-new-key')).status,412);
 assert.equal((await submit(first,'result-submit',submitted.etag)).status,409,'a retry cannot replace the original If-Match');
 const patch=(data,key,etag=submitted.etag)=>call(base,{method:'PATCH',data,key,etag});
 assert.equal((await patch({status:'completed'},'result-bypass-complete')).status,409);
 assert.equal((await patch({status:'active'},'result-bypass-active')).status,409);
 const review=(submission,decision,feedback,key,etag,headers=ownerHeaders)=>call(`${base}/results/${submission.submissionId}/review`,{method:'POST',headers,key,etag,data:{entryId:submission.entry.entryId,contentHash:submission.entry.contentHash,decision,feedback,confirm:true}});
 assert.equal((await review(pending,'accept','','result-review-wrong-owner',submitted.etag,memberHeaders)).status,403);
 assert.equal((await review(pending,'request_changes','  ','result-empty-feedback',submitted.etag)).status,400);
 assert.equal((await review(pending,'accept','','result-stale-review',before.etag)).status,412);
 const changed=await review(pending,'request_changes','请补齐结论依据。','result-change',submitted.etag);assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.workItem.status,'active');assert.equal(changed.body.data.workItem.nextAction,'请补齐结论依据。');assert.equal(changed.body.data.resultReview.currentSubmission.review.feedback,'请补齐结论依据。');
 assert.equal((await patch({status:'completed'},'result-old-bypass',changed.etag)).status,409);
 const second=await comment(id,'固定成果第二版：已补齐依据。','result-entry-two');
 const resubmitted=await submit(second,'result-resubmit',changed.etag);assert.equal(resubmitted.status,200,JSON.stringify(resubmitted.body));
 const pending2=resubmitted.body.data.resultReview.currentSubmission;
 assert.equal((await review(pending,'accept','','result-old-submission',resubmitted.etag)).status,409);
 const accepted=await review(pending2,'accept','确认成果可用。','result-accept',resubmitted.etag);assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.data.workItem.status,'completed');assert.equal(accepted.body.data.resultReview.currentSubmission.status,'accepted');
 assert.deepEqual((await review(pending2,'accept','确认成果可用。','result-accept',resubmitted.etag)).body.data,accepted.body.data);
 assert.equal((await review(pending2,'accept','不同内容','result-accept',resubmitted.etag)).status,409);
 const memberRead=await call(base,{headers:memberHeaders});assert.equal(memberRead.body.data.resultReview.history.length,2);assert.deepEqual(memberRead.body.data.resultReview,accepted.body.data.resultReview);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_item_lifecycle_events WHERE work_item_id=$1 AND payload ? 'resultReview'",[id])).rows[0].n,4);
 // Object authorization is checked before returning a prior receipt, including completed results.
 const revoked=await patch({members:[]},'result-remove-member',accepted.etag);assert.equal(revoked.status,200,JSON.stringify(revoked.body));
 assert.equal((await call(base,{headers:memberHeaders})).status,404);
 assert.equal((await call(entryPath,{headers:memberHeaders})).status,404);
 await assert.rejects(nativeMember.fileCall(await nativeMember.identity(),'turnsu_work_entry',{pathParams:{workItemId:id,entryId:first.entryId}}),e=>e.status===404);
 assert.equal((await submit(second,'result-resubmit',changed.etag)).status,404);
 // Revocation while awaiting review prevents accepting the previous contributor's submission.
 const waitingId=await create('result-waiting-revoke'),waitingBase=`/work-items/${waitingId}`;
 const waitingEntry=await comment(waitingId,'提交后撤权的成果','result-waiting-entry');
 const waitingBefore=await call(waitingBase);
 const waiting=await call(`${waitingBase}/results`,{method:'POST',headers:memberHeaders,key:'result-waiting-submit',etag:waitingBefore.etag,data:{entryId:waitingEntry.entryId,contentHash:waitingEntry.contentHash,confirm:true}});assert.equal(waiting.status,200,JSON.stringify(waiting.body));
 const waitingRemoved=await call(waitingBase,{method:'PATCH',key:'result-waiting-remove',etag:waiting.etag,data:{members:[]}});assert.equal(waitingRemoved.status,200,JSON.stringify(waitingRemoved.body));
 assert.equal((await call(`${waitingBase}/results/${waiting.body.data.resultReview.currentSubmission.submissionId}/review`,{method:'POST',key:'result-revoked-review',etag:waitingRemoved.etag,data:{entryId:waitingEntry.entryId,contentHash:waitingEntry.contentHash,decision:'accept',feedback:'',confirm:true}})).status,404);
 assert.equal((await call(waitingBase)).body.data.workItem.status,'waiting_review');
 // Legacy works without result submissions preserve their existing manual status lifecycle.
 const legacyId=await create('result-legacy-work');let legacy=await call(`/work-items/${legacyId}`);
 for(const status of ['active','waiting_review','completed']) {legacy=await call(`/work-items/${legacyId}`,{method:'PATCH',key:'result-legacy-'+status,etag:legacy.etag,data:{status}});assert.equal(legacy.status,200,JSON.stringify(legacy.body));}
 return {workItemId:id,projectRevocationEntry:{workItemId:otherId,entryId:foreign.entryId}};
}
