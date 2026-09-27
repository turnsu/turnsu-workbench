import assert from 'node:assert/strict';

// Two real native identities and Product HTTP; deleted versions retain their original revision chain.
export async function verifyProjectFileTombstones({origin,pool,owner,member,ownerHeaders,memberUserId}) {
 const http=async(path,{method='GET',data,key,etag}={})=>{const response=await fetch(origin+'/api/workbench/v1'+path,{method,headers:{...ownerHeaders,Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),...(etag?{'If-Match':etag}:{})},...(data?{body:JSON.stringify({schemaVersion:'workbench-api-v1',data})}:{})});return {status:response.status,etag:response.headers.get('etag'),cache:response.headers.get('cache-control'),body:await response.json()};};
 const created=await http('/projects',{method:'POST',key:'tombstone-project',data:{title:'Recoverable deletion',objective:'Keep edits and deletions without data loss',members:[{userId:memberUserId}]}});assert.equal(created.status,201,JSON.stringify(created.body));
 const projectId=created.body.data.projectId;
 const call=(client,name,input)=>client.session.product.call(name,input);
 const commit=(client,data,key)=>call(client,'turnsu_commit_project_file',{pathParams:{projectId},data,idempotencyKey:key});
 const read=(client,revisionId)=>call(client,'turnsu_project_file',{pathParams:{projectId,revisionId}});
 const list=async(client)=>(await call(client,'turnsu_project_files',{pathParams:{projectId}})).data;
 const data=(text,baseRevisionId=null,extra={})=>({path:'notes.md',mediaType:'text/markdown',baseRevisionId,contentBase64:Buffer.from(text).toString('base64'),...extra});
 const initial=(await commit(owner,data('original'),'tombstone-initial')).data;
 assert.equal(initial.revision.deleted,false);
 // Existing pre-tombstone receipts did not carry deleted; upgrading must not invalidate their retry.
 await pool.query(`UPDATE product_idempotency_receipts SET response=response #- '{data,revision,deleted}'
   WHERE operation_scope=$1 AND idempotency_key='tombstone-initial'`,[`project-file-commit:${projectId}`]);
 assert.deepEqual((await commit(owner,data('original'),'tombstone-initial')).data,initial);
 const edit=(await commit(owner,data('concurrent edit',initial.revision.revisionId),'tombstone-edit')).data;
 const staleDeleteInput=data('',initial.revision.revisionId,{deleted:true});
 const stale=(await commit(member,staleDeleteInput,'tombstone-stale-delete')).data;
 assert.equal(stale.revision.deleted,true);assert.equal(stale.revision.outcome,'conflict');assert.equal(stale.headRevisionId,edit.revision.revisionId);
 assert.deepEqual((await commit(member,staleDeleteInput,'tombstone-stale-delete')).data,stale);
 let heads=await list(member);assert.equal(heads.length,2);assert.equal(heads.find(x=>x.revisionId===edit.revision.revisionId).deleted,false);assert.equal(heads.find(x=>x.revisionId===stale.revision.revisionId).deleted,true);
 assert.equal(Buffer.from((await read(member,edit.revision.revisionId)).data.contentBase64,'base64').toString(),'concurrent edit');
 const deleteInput=data('',edit.revision.revisionId,{deleted:true,resolvesRevisionIds:[stale.revision.revisionId]});
 const removed=(await commit(member,deleteInput,'tombstone-delete')).data;
 assert.equal(removed.revision.outcome,'synced');assert.equal(removed.revision.deleted,true);assert.equal(removed.revision.byteLength,0);
 assert.deepEqual((await commit(member,deleteInput,'tombstone-delete')).data,removed);
 heads=await list(owner);assert.equal(heads.length,1);assert.equal(heads[0].deleted,true);assert.equal(heads[0].headRevisionId,removed.revision.revisionId);
 const tombstone=await read(owner,removed.revision.revisionId);assert.equal(tombstone.data.deleted,true);assert.equal(tombstone.data.contentBase64,'');assert.equal(tombstone.data.byteLength,0);
 const tombstoneHttp=await http(`/projects/${projectId}/files/${removed.revision.revisionId}`);assert.equal(tombstoneHttp.status,200,JSON.stringify(tombstoneHttp.body));assert.equal(tombstoneHttp.cache,'no-store');
 assert.equal(Buffer.from((await read(member,initial.revision.revisionId)).data.contentBase64,'base64').toString(),'original');
 assert.equal((await read(member,initial.revision.revisionId)).data.deleted,false);
 // Editing the previously visible file after another member's deletion preserves the edit as a conflict.
 const staleEdit=(await commit(owner,data('edit after deletion',edit.revision.revisionId),'tombstone-stale-edit')).data;
 assert.equal(staleEdit.revision.deleted,false);assert.equal(staleEdit.revision.outcome,'conflict');assert.equal(staleEdit.headRevisionId,removed.revision.revisionId);
 const restored=(await commit(owner,data('restored contents',removed.revision.revisionId,{deleted:false,resolvesRevisionIds:[staleEdit.revision.revisionId]}),'tombstone-restore')).data;
 assert.equal(restored.revision.deleted,false);assert.equal(restored.revision.outcome,'synced');assert.equal((await list(member)).length,1);
 assert.equal(Buffer.from((await read(member,restored.revision.revisionId)).data.contentBase64,'base64').toString(),'restored contents');
 assert.equal((await read(member,removed.revision.revisionId)).data.deleted,true,'the former tombstone stays independently readable');
 await assert.rejects(commit(member,data('',null,{deleted:true}),'tombstone-no-base'),e=>e.status===400);
 await assert.rejects(commit(member,data('unexpected bytes',restored.revision.revisionId,{deleted:true}),'tombstone-with-bytes'),e=>e.status===400);
 await assert.rejects(commit(member,{...deleteInput,deleted:false},'tombstone-delete'),e=>e.status===409);
 const work=await http('/work-items',{method:'POST',key:'tombstone-work',data:{projectId,title:'Reference retained bytes',objective:'Never use deleted versions as declared input',summary:'Fixed revision reference'}});assert.equal(work.status,201,JSON.stringify(work.body));
 const entryPath=`/work-items/${work.body.data.workItemId}/thread-entries`;
 const badRef=await http(entryPath,{method:'POST',key:'tombstone-ref-denied',data:{content:'Deleted versions are not input files',fileRevisionIds:[removed.revision.revisionId]}});assert.equal(badRef.status,400,JSON.stringify(badRef.body));
 const historicalRef=await http(entryPath,{method:'POST',key:'tombstone-historical-ref',data:{content:'Original retained content',fileRevisionIds:[initial.revision.revisionId]}});assert.equal(historicalRef.status,201,JSON.stringify(historicalRef.body));
 assert.equal(historicalRef.body.data.fileReferences[0].revisionId,initial.revision.revisionId);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_file_revisions WHERE project_id=$1',[projectId])).rows[0].n,6,'retries and rejected deletes cannot create extra revisions');
 await assert.rejects(pool.query('UPDATE project_file_revisions SET deleted=false WHERE revision_id=$1',[removed.revision.revisionId]),/project_file_revision_immutable/);
 const beforeRevoke=await http(`/projects/${projectId}`);
 const revoked=await http(`/projects/${projectId}/members`,{method:'PUT',key:'tombstone-revoke',etag:beforeRevoke.etag,data:{members:[]}});assert.equal(revoked.status,200,JSON.stringify(revoked.body));
 await assert.rejects(commit(member,deleteInput,'tombstone-delete'),e=>e.status===404);
 await assert.rejects(read(member,initial.revision.revisionId),e=>e.status===404);
 await assert.rejects(read(member,removed.revision.revisionId),e=>e.status===404);
}
